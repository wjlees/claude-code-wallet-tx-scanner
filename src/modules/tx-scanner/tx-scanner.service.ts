import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BlockchainService } from '../blockchain/blockchain.service';
import { AssetService } from '../blockchain/interfaces/asset.interface';
import { TokenService } from '../blockchain/interfaces/token.interface';
import { ScanTarget } from '../blockchain/interfaces/scan.types';
import { WalletService } from '../wallet/wallet.service';
import { CURSOR_STORE, CursorStore } from './cursor-store';
import { TxRepository } from './tx.repository';
import { ScanRunner } from './scan-runner';

/** ScanTarget → cursor 저장 키 (assetId/tokenTypeId 기반, 심볼과 무관하게 안정적). */
function cursorKey(target: ScanTarget): string {
  const parts: string[] = [];
  if (target.assetId !== undefined) parts.push(`asset:${target.assetId}`);
  if (target.tokenTypeId !== undefined) {
    parts.push(`token:${target.tokenTypeId}`);
  }
  return parts.join('+');
}

/**
 * 대상 주소(hot/cold)의 모든 in/out tx 를 감지하여 저장하는 스캐너.
 *
 * 루프 전략: **자산별 독립 무한 루프(평소) + cron 워치독(안전망)**.
 *  - 자산마다 노드·스캔 방식·속도가 달라서(SOL 빠름, BTC 느림), 자산별로 ScanRunner 를
 *    하나씩 돌린다. 느린 체인이 빠른 체인을 막지 않는다(head-of-line blocking 방지).
 *  - 무한 루프는 실시간성이 높지만 프로세스가 죽거나 루프가 멈추면 조용히 정지할 수 있다.
 *    그래서 cron 워치독이 주기적으로 각 루프의 생존/정체를 점검하고 필요 시 재시작한다.
 *    (워치독은 스캔 자체는 하지 않는다)
 *  - 각 루프는 cursor 를 `CursorStore`(JSON 파일 stub)에 영속화하므로 재시작/재가동 후
 *    마지막 지점부터 이어서 스캔한다(at-least-once).
 */
@Injectable()
export class TxScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TxScannerService.name);
  private runners: ScanRunner[] = [];

  constructor(
    private readonly blockchain: BlockchainService,
    private readonly wallets: WalletService,
    private readonly txRepository: TxRepository,
    @Inject(CURSOR_STORE) private readonly cursorStore: CursorStore,
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
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.runners.map((r) => r.stop()));
  }

  private createRunner(
    target: ScanTarget,
    service: AssetService | TokenService,
  ): ScanRunner {
    const key = cursorKey(target);
    return new ScanRunner(
      target,
      service,
      () => this.wallets.getScanAddresses(target),
      (txs) => this.txRepository.saveMany(target, txs),
      () => this.cursorStore.load(key),
      (cursor) => this.cursorStore.save(key, cursor),
      this.logger,
    );
  }

  /**
   * 워치독: 죽었거나 오래 정체된 루프를 감지해 재시작한다. (스캔은 하지 않음)
   * 무한 루프가 평소 동작을 담당하고, 이 cron 은 "멈췄을 때 대비" 안전망이다.
   */
  @Cron(CronExpression.EVERY_MINUTE)
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
        // 실제 구현에선 AbortController/timeout 으로 scanTransactions 를 취소 가능하게 만든다.
      }
    }
  }
}
