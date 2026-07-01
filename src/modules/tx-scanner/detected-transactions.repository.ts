import { Injectable, Logger } from '@nestjs/common';

/**
 * `detected_transactions` 테이블 INSERT 파라미터.
 * (monorepo `DetectedTransactionsRepository.insertDetectedTransactions` 시그니처와 정렬)
 */
export interface InsertDetectedTransactionParams {
  /** required — 자산 식별 (자산=코인 assetId, 토큰=토큰 자체 assetId) */
  assetId: number;
  fromAddress?: string;
  toAddress?: string;
  txId?: string;
  /** tx 내 위치 인덱스 (멱등 유니크 키 `(assetId, txId, txIndex)` 의 3번째). 기본 0. */
  txIndex?: number;
  blockNumber?: number;
  /** required (decimal 문자열, 최소단위) */
  amount: string;
  feeAmount?: string;
  /** memoId 등 */
  note?: string;
  /** default 0 */
  status?: number;
}

/**
 * 감지된 tx 영속화 저장소.
 *
 * NOTE: 실제 구현(`detected_transactions` 테이블)은 monorepo 전용이다. prototype 은
 *   인터페이스 + stub 만 둔다. 실제 DB 로 교체 시 이 인터페이스만 유지하면 호출부 무변경.
 */
export interface DetectedTransactionsRepository {
  insertDetectedTransactions(
    params: InsertDetectedTransactionParams,
  ): Promise<number>;
}

export const DETECTED_TRANSACTIONS_REPOSITORY =
  'DetectedTransactionsRepository';

/** JSON/콘솔 stub 구현 (DB 미연결). */
@Injectable()
export class StubDetectedTransactionsRepository implements DetectedTransactionsRepository {
  private readonly logger = new Logger('DetectedTransactionsRepository');
  private seq = 0;
  /** 멱등 시연용: 이미 본 (assetId, txId, txIndex) 키. 실 DB 에선 unique index 가 담당. */
  private readonly seen = new Set<string>();

  async insertDetectedTransactions(
    params: InsertDetectedTransactionParams,
  ): Promise<number> {
    // 멱등 유니크 키 = (assetId, txId, txIndex). 실 DB:
    //   UNIQUE (asset_id, tx_id, tx_index) + INSERT ... ON CONFLICT DO NOTHING.
    // stub 은 Set 으로 재삽입(재스캔·cursor 겹침)을 흡수해 중복 저장을 막는다.
    const key = `${params.assetId}:${params.txId}:${params.txIndex ?? 0}`;
    if (this.seen.has(key)) {
      this.logger.log(`skip duplicate ${key} (ON CONFLICT DO NOTHING)`);
      return 0;
    }
    this.seen.add(key);
    const id = ++this.seq;
    this.logger.log(`insert #${id} ${JSON.stringify(params)}`);
    return id;
  }
}
