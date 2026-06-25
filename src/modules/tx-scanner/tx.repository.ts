import { Injectable } from '@nestjs/common';
import { DetectedTx, ScanTarget } from '../blockchain/interfaces/scan.types';

/**
 * 스캔된 트랜잭션을 저장한다.
 *
 * NOTE: 현재는 DB 연동 전 껍데기 구현이다. 실제 저장 대신 console.log 만 한다.
 * 실제 구현은 (assetId/tokenTypeId, txHash, address) 멱등 저장(이미 있으면 무시)으로 한다.
 */
@Injectable()
export class TxRepository {
  /** 한 스캔 대상(assetId/tokenTypeId)에서 감지된 tx 들을 일괄 저장 */
  async saveMany(target: ScanTarget, txs: DetectedTx[]): Promise<void> {
    const tag = JSON.stringify(target);
    console.log(`[TxRepository] saveMany(${tag}, ${txs.length} txs)`);
    for (const tx of txs) {
      // TODO(DB): UPSERT (assetId/tokenTypeId, txHash, address) 기준 멱등 저장.
      console.log(
        `[TxRepository] save ${tag}:${tx.txHash} ${tx.direction} ${tx.address}`,
      );
    }
  }
}
