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

  async insertDetectedTransactions(
    params: InsertDetectedTransactionParams,
  ): Promise<number> {
    // TODO(DB): INSERT INTO detected_transactions ...
    //   멱등: (assetId, txId, fromAddress/toAddress) unique 또는 insert 전 exists 체크.
    const id = ++this.seq;
    this.logger.log(`insert #${id} ${JSON.stringify(params)}`);
    return id;
  }
}
