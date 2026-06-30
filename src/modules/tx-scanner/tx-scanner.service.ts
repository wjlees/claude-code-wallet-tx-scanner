import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BlockchainService } from '../blockchain/blockchain.service';
import { TokenTypeId } from '../blockchain/constants';
import { AssetService } from '../blockchain/interfaces/asset.interface';
import { TokenService } from '../blockchain/interfaces/token.interface';
import { DetectedTx, ScanTarget } from '../blockchain/interfaces/scan.types';
import { WalletService } from '../wallet/wallet.service';
import {
  DETECTED_TRANSACTIONS_REPOSITORY,
  DetectedTransactionsRepository,
} from './detected-transactions.repository';
import {
  WALLET_SCANNER_ASSET_REPOSITORY,
  WalletScannerAssetRepository,
} from './wallet-scanner-asset.repository';
import { ScanRunner } from './scan-runner';

/** 워치독 점검 주기(ms). */
const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * 토큰 타입 → 저장 assetId stub (코인 assetId 와 안 겹치게 1001+).
 *
 * ⚠️ prototype 전용 stub. **monorepo 는 assetRepository/tokenRepository 로 실제 assetId 를 조회**한다
 *   (자산=assetRepository, 토큰=tokenRepository 의 token contract→assetId). TODO(DB).
 */
const STUB_TOKEN_ASSET_ID: Record<number, number> = {
  [TokenTypeId.KIP7]: 1001,
  [TokenTypeId.KONETTOKEN]: 1002,
  [TokenTypeId.BASETOKEN]: 1003,
  [TokenTypeId.SPL]: 1004,
  [TokenTypeId.TRC20]: 1005,
};

/** ScanTarget → 저장/진행지점 행 키 assetId (토큰이면 토큰타입 stub assetId). */
function resolveStoreAssetId(target: ScanTarget): number {
  if (target.assetId !== undefined) {
    return target.assetId;
  }
  if (target.tokenTypeId !== undefined) {
    return STUB_TOKEN_ASSET_ID[target.tokenTypeId] ?? target.tokenTypeId;
  }
  return 0;
}

/**
 * 대상 주소의 모든 in/out tx 를 감지하여 저장하는 스캐너.
 *
 * 루프 전략: **대상별 독립 무한 루프(평소) + 워치독(안전망)**.
 *  - 대상마다 노드·스캔 방식·속도가 달라 대상별 ScanRunner 를 하나씩 돌린다(HOL blocking 방지).
 *  - 워치독은 죽은/정체 루프를 점검·재시작한다. **`@Cron` 을 쓰지 않고** `setInterval` 로
 *    주기 호출한다(monorepo 는 scheduler_manager 가 watchdog 를 등록·주기 호출 — 매핑 §6 참고).
 *  - 각 루프는 진행 지점을 `WalletScannerAssetRepository`(wallet_scanner_asset.start_block_number)에
 *    영속화하므로 재시작/재가동 후 마지막 지점부터 이어서 스캔한다(at-least-once).
 *  - 감지 tx 는 `DetectedTransactionsRepository`(detected_transactions)에 직접 저장한다
 *    (DetectedTx ≈ DB 컬럼이라 별도 매퍼 없이 그대로 매핑).
 */
@Injectable()
export class TxScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TxScannerService.name);
  private runners: ScanRunner[] = [];
  private watchdogTimer?: NodeJS.Timeout;

  constructor(
    private readonly blockchain: BlockchainService,
    private readonly wallets: WalletService,
    @Inject(DETECTED_TRANSACTIONS_REPOSITORY)
    private readonly detectedRepository: DetectedTransactionsRepository,
    @Inject(WALLET_SCANNER_ASSET_REPOSITORY)
    private readonly scannerAssetRepository: WalletScannerAssetRepository,
  ) {}

  onModuleInit(): void {
    const assetServices = this.blockchain.getAllAssetServices();
    const tokenServices = this.blockchain.getAllTokenServices();

    for (const service of assetServices) {
      this.runners.push(
        this.createRunner({ assetId: service.getAssetId() }, service),
      );
    }
    for (const service of tokenServices) {
      this.runners.push(
        this.createRunner({ tokenTypeId: service.getTokenTypeId() }, service),
      );
    }

    this.runners.forEach((r) => r.start());
    this.logger.log(`started ${this.runners.length} independent scan loop(s)`);

    // 워치독 주기 호출 (monorepo 에선 scheduler_manager 가 담당)
    this.watchdogTimer = setInterval(
      () => this.watchdog(),
      WATCHDOG_INTERVAL_MS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }
    await Promise.all(this.runners.map((r) => r.stop()));
  }

  private createRunner(
    target: ScanTarget,
    service: AssetService | TokenService,
  ): ScanRunner {
    // wallet_scanner_asset 행 키 / detected_transactions assetId = 저장 assetId
    const assetId = resolveStoreAssetId(target);
    return new ScanRunner(
      target,
      service,
      () => this.wallets.getScanAddresses(target),
      (txs) => this.saveDetected(assetId, txs),
      () => this.scannerAssetRepository.getStartBlockNumber(assetId),
      (sbn) => this.scannerAssetRepository.updateStartBlockNumber(assetId, sbn),
      this.logger,
    );
  }

  /** DetectedTx 를 detected_transactions 에 저장(매퍼 없이 거의 1:1, amount 만 NOT NULL 기본값). */
  private async saveDetected(
    assetId: number,
    txs: DetectedTx[],
  ): Promise<void> {
    for (const tx of txs) {
      await this.detectedRepository.insertDetectedTransactions({
        assetId,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        txId: tx.txHash,
        blockNumber: tx.blockNumber,
        amount: tx.amount ?? '0',
        note: tx.memoId,
        status: 0,
      });
    }
  }

  /**
   * 워치독: 죽었거나 오래 정체된 루프를 감지해 재시작한다. (스캔은 하지 않음)
   * `@Cron` 이 아니라 setInterval 로 주기 호출된다(monorepo 는 scheduler_manager).
   */
  watchdog(): void {
    for (const runner of this.runners) {
      if (!runner.isRunning()) {
        this.logger.warn(`[${runner.label}] not running → restart`);
        runner.start();
        continue;
      }
      // 기대 간격의 10배(최소 1분) 넘게 진행이 없으면 정체로 간주.
      const threshold = Math.max(runner.expectedIntervalMs * 10, 60_000);
      if (runner.msSinceActivity() > threshold) {
        this.logger.warn(
          `[${runner.label}] stalled for ${runner.msSinceActivity()}ms (no progress) — check node/RPC`,
        );
        // NOTE: 강제 재시작은 hung RPC await 를 끊지 못하므로 경고만 한다.
      }
    }
  }
}
