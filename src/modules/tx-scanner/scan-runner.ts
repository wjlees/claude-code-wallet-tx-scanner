import { Logger } from '@nestjs/common';
import { AssetService } from '../blockchain/interfaces/asset.interface';
import { TokenService } from '../blockchain/interfaces/token.interface';
import { DetectedTx, ScanTarget } from '../blockchain/interfaces/scan.types';

/**
 * 한 자산(또는 토큰)에 대한 **독립 무한 스캔 루프**.
 *
 * tx-scanner 가 대상별로 1개씩 생성/구동한다. 각 루프는 자기 cursor 를 들고
 * scanTransactions → 저장 → cursor 갱신 → 대상별 간격만큼 대기 를 반복한다.
 * 대상마다 따로 돌기 때문에 느린 체인(BTC)이 빠른 체인(SOL)을 막지 않는다.
 */
export class ScanRunner {
  private running = false;
  private loopPromise?: Promise<void>;
  private sleepTimer?: NodeJS.Timeout;
  private wake?: () => void;

  /** cursor: 자산별 불투명 스캔 지점. 시작 시 store 에서 load, 사이클마다 save. */
  private cursor: string | null = null;
  /** 마지막으로 한 사이클을 정상 완료한 시각 (워치독용) */
  private lastActivityAt = Date.now();

  constructor(
    private readonly target: ScanTarget,
    // 스캔에 필요한 계약(symbol/scanIntervalMs/scanTransactions)은 AssetService/TokenService
    // 인터페이스가 이미 강제한다. 별도 Scannable 추상화 없이 둘의 합집합을 받는다.
    private readonly service: AssetService | TokenService,
    private readonly getAddresses: () => Promise<string[]>,
    // 저장 대상 식별(assetId/tokenTypeId)은 tx-scanner 가 콜백에 바인딩한다.
    private readonly save: (txs: DetectedTx[]) => Promise<void>,
    // cursor 영속화 콜백(저장소는 tx-scanner 가 주입). 시작 시 load, 사이클마다 save.
    private readonly loadCursor: () => Promise<string | null>,
    private readonly saveCursor: (cursor: string | null) => Promise<void>,
    private readonly logger: Logger,
  ) {
    if (target.assetId === undefined && target.tokenTypeId === undefined) {
      throw new Error(
        'ScanRunner requires at least one of assetId / tokenTypeId',
      );
    }
  }

  get label(): string {
    const parts: string[] = [];
    if (this.target.assetId !== undefined) {
      parts.push(`asset#${this.target.assetId}`);
    }
    if (this.target.tokenTypeId !== undefined) {
      parts.push(`token#${this.target.tokenTypeId}`);
    }
    return `${parts.join('+')}:${this.service.symbol}`;
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
    this.logger.log(
      `[${this.label}] loop start (interval=${this.expectedIntervalMs}ms)`,
    );
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
    // 시작 시 저장된 cursor 를 로드해 마지막 지점부터 이어서 스캔한다.
    this.cursor = await this.loadCursor();
    if (this.cursor !== null) {
      this.logger.log(`[${this.label}] resume from cursor=${this.cursor}`);
    }

    while (this.running) {
      try {
        const addresses = await this.getAddresses();
        const { txs, nextCursor } = await this.service.scanTransactions(
          addresses,
          this.cursor,
        );
        if (txs.length > 0) {
          await this.save(txs);
        }
        if (nextCursor !== this.cursor) {
          this.cursor = nextCursor;
          await this.saveCursor(this.cursor); // 진행 지점 영속화
        }
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
