import { Injectable } from '@nestjs/common';
import { DetectedTx } from '../blockchain/interfaces/scan.types';

/**
 * 스캔된 트랜잭션을 저장한다.
 *
 * NOTE: 현재는 DB 연동 전 껍데기 구현이다. 실제 저장 대신 console.log 만 한다.
 * 실제 구현은 (symbol, txHash, address) 멱등 저장(이미 있으면 무시)으로 한다.
 */
@Injectable()
export class TxRepository {
  /** 한 자산(symbol)에서 감지된 tx 들을 일괄 저장 */
  async saveMany(symbol: string, txs: DetectedTx[]): Promise<void> {
    console.log(`[TxRepository] saveMany(${symbol}, ${txs.length} txs)`);
    for (const tx of txs) {
      // TODO(DB): UPSERT (symbol, txHash, address) 기준 멱등 저장.
      console.log(
        `[TxRepository] save ${symbol}:${tx.txHash} ${tx.direction} ${tx.address}`,
      );
    }
  }
}
