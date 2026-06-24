import { Logger } from '@nestjs/common';
import { DetectedTx, ScanResult } from '../blockchain/interfaces/scan.types';

/** 스캔 가능한 서비스의 최소 형태 (AssetService / TokenService 모두 만족) */
export interface ScannableService {
  readonly symbol: string;
  readonly scanIntervalMs: number;
  scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult>;
}

/**
 * 한 자산(또는 토큰)에 대한 **독립 무한 스캔 루프**.
 *
 * tx-scanner 가 자산별로 1개씩 생성/구동한다. 각 루프는 자기 cursor 를 들고
 * scanTransactions → 저장 → cursor 갱신 → 자산별 간격만큼 대기 를 반복한다.
 * 자산마다 따로 돌기 때문에 느린 체인(BTC)이 빠른 체인(SOL)을 막지 않는다.
 */
export class ScanRunner {
  private running = false;
  private loopPromise?: Promise<void>;
  private sleepTimer?: NodeJS.Timeout;
  private wake?: () => void;

  /** cursor: 자산별 불투명 스캔 지점. NOTE: 실제로는 DB 에서 load/persist. */
  private cursor: string | null = null;
  /** 마지막으로 한 사이클을 정상 완료한 시각 (워치독용) */
  private lastActivityAt = Date.now();

  constructor(
    private readonly kind: 'asset' | 'token',
    private readonly service: ScannableService,
    private readonly getAddresses: () => Promise<string[]>,
    private readonly save: (symbol: string, txs: DetectedTx[]) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  get label(): string {
    return `${this.kind}:${this.service.symbol}`;
  }

  isRunning(): boolean {
    return this.running;
  }

  msSinceActivity(): number {
    return Date.now() - this.lastActivityAt;
  }

  get expectedIntervalMs(): number {
    return this.service.scanIntervalMs;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastActivityAt = Date.now();
    this.logger.log(`[${this.label}] loop start (interval=${this.expectedIntervalMs}ms)`);
    this.loopPromise = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
    }
    this.wake?.(); // 대기 중이면 즉시 깨워서 graceful 하게 종료
    await this.loopPromise;
    this.logger.log(`[${this.label}] loop stopped`);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const addresses = await this.getAddresses();
        const { txs, nextCursor } = await this.service.scanTransactions(
          addresses,
          this.cursor,
        );
        if (txs.length > 0) {
          await this.save(this.service.symbol, txs);
        }
        this.cursor = nextCursor; // TODO(DB): cursor 영속화
        this.lastActivityAt = Date.now();
      } catch (err) {
        this.logger.error(
          `[${this.label}] scan error: ${(err as Error).message}`,
        );
      }
      await this.sleep(this.service.scanIntervalMs);
    }
  }

  /** 중단 가능한 sleep (stop 시 즉시 깨움) */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.sleepTimer = setTimeout(resolve, ms);
    });
  }
}
