import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BlockchainService } from '../blockchain/blockchain.service';
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
import {
  TOKEN_REPOSITORY,
  TokenRepository,
  TokenRow,
} from './token.repository';
import { ScanRunner } from './scan-runner';

/** 워치독 점검 주기(ms). */
const WATCHDOG_INTERVAL_MS = 60_000;

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
    @Inject(TOKEN_REPOSITORY)
    private readonly tokenRepository: TokenRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const assetServices = this.blockchain.getAllAssetServices();
    const tokenServices = this.blockchain.getAllTokenServices();

    // 코인(네이티브 자산): 자산당 러너 1개.
    for (const service of assetServices) {
      this.runners.push(this.createAssetRunner(service));
    }

    // 토큰: 한 토큰 서비스(=token_type)당 러너 1개. main.token 에서 그 타입의 토큰 목록
    // [(assetId, contractAddress)] 을 받아 **한 루프**로 스캔하고, 결과 tx 를 contractAddress
    // 로 분류해 각 토큰의 asset_id 로 저장한다. 진행지점은 그 토큰 행들이 함께 갱신된다.
    for (const service of tokenServices) {
      const tokens = await this.tokenRepository.getTokensByType(
        service.getTokenTypeId(),
      );
      if (tokens.length === 0) {
        continue; // 추적할 토큰이 없으면 러너를 만들지 않는다.
      }
      this.runners.push(this.createTokenRunner(service, tokens));
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

  /** 코인 러너: 자산 1개. 저장/진행지점 키 = 코인 assetId. */
  private createAssetRunner(service: AssetService): ScanRunner {
    const assetId = service.getAssetId();
    const target: ScanTarget = { assetId };
    return new ScanRunner(
      target,
      service,
      [], // 코인은 컨트랙트 목록 없음
      () => this.wallets.getScanAddresses(target),
      (txs) => this.saveDetected(assetId, txs),
      () => this.scannerAssetRepository.getStartBlockNumber(assetId),
      (sbn) => this.scannerAssetRepository.updateStartBlockNumber(assetId, sbn),
      this.logger,
    );
  }

  /**
   * 토큰 러너: token_type 1개(여러 토큰을 한 루프로). contractAddress→assetId 맵으로 분류 저장하고,
   * 진행지점은 이 타입의 토큰 행들을 **모두 같은 값으로** 갱신한다(같이 도므로).
   */
  private createTokenRunner(
    service: TokenService,
    tokens: TokenRow[],
  ): ScanRunner {
    const target: ScanTarget = { tokenTypeId: service.getTokenTypeId() };
    const contractAddresses = tokens.map((t) => t.contractAddress);
    const assetIdByContract = new Map(
      tokens.map((t) => [t.contractAddress, t.assetId]),
    );
    const assetIds = tokens.map((t) => t.assetId);
    return new ScanRunner(
      target,
      service,
      contractAddresses,
      () => this.wallets.getScanAddresses(target),
      (txs) => this.saveDetectedTokens(assetIdByContract, txs),
      // 같은 타입의 토큰 행은 값이 같으므로 대표(첫 토큰) 행에서 로드.
      () => this.scannerAssetRepository.getStartBlockNumber(assetIds[0]),
      // 이 타입의 모든 토큰 행을 같은 값으로 갱신.
      async (sbn) => {
        for (const id of assetIds) {
          await this.scannerAssetRepository.updateStartBlockNumber(id, sbn);
        }
      },
      this.logger,
    );
  }

  /** 코인 DetectedTx 저장(매퍼 없이 거의 1:1, amount 만 NOT NULL 기본값). */
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
        txIndex: tx.txIndex ?? 0,
        blockNumber: tx.blockNumber,
        amount: tx.amount ?? '0',
        note: tx.memoId,
        status: 0,
      });
    }
  }

  /**
   * 토큰 DetectedTx 저장: 각 tx 의 `contractAddress` 로 어느 토큰인지 분류해
   * 그 토큰의 asset_id 로 insert 한다(한 token_type 루프가 여러 토큰을 처리).
   */
  private async saveDetectedTokens(
    assetIdByContract: Map<string, number>,
    txs: DetectedTx[],
  ): Promise<void> {
    for (const tx of txs) {
      // 정확 매칭 우선, 실패 시 lowercase fallback(EVM 체크섬 대응; SPL/TRC20 base58 은 정확 매칭에서 끝남).
      const assetId = tx.contractAddress
        ? (assetIdByContract.get(tx.contractAddress) ??
          assetIdByContract.get(tx.contractAddress.toLowerCase()))
        : undefined;
      if (assetId === undefined) {
        continue; // 추적 대상 토큰이 아니면 skip
      }
      await this.detectedRepository.insertDetectedTransactions({
        assetId,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        txId: tx.txHash,
        txIndex: tx.txIndex ?? 0,
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
