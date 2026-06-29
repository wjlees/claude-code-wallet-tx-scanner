import { Inject, Injectable } from '@nestjs/common';
import { DetectedTx, ScanTarget } from '../blockchain/interfaces/scan.types';
import {
  DETECTED_TRANSACTIONS_REPOSITORY,
  DetectedTransactionsRepository,
} from './detected-transactions.repository';
import { mapDetectedTxToInsertParams } from './detected-tx.mapper';

/**
 * 스캔된 트랜잭션을 저장한다.
 *
 * `DetectedTx` 를 `mapDetectedTxToInsertParams` 로 INSERT 파라미터로 변환한 뒤
 * `DetectedTransactionsRepository`(현재 stub) 로 저장한다. 저장 기준은 숫자 id(ScanTarget).
 */
@Injectable()
export class TxRepository {
  constructor(
    @Inject(DETECTED_TRANSACTIONS_REPOSITORY)
    private readonly detected: DetectedTransactionsRepository,
  ) {}

  /** 한 스캔 대상(assetId/tokenTypeId)에서 감지된 tx 들을 일괄 저장 */
  async saveMany(target: ScanTarget, txs: DetectedTx[]): Promise<void> {
    for (const tx of txs) {
      const params = mapDetectedTxToInsertParams(target, tx);
      await this.detected.insertDetectedTransactions(params);
    }
  }
}
