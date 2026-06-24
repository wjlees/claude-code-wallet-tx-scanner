import { Injectable, Logger } from '@nestjs/common';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
import { getEnv } from '../node-config';
import { UtxoRpcScanner } from '../utxo-rpc.scanner';

/**
 * Bitcoin (BTC). UTXO 모델.
 *
 * 노드: bitcoind JSON-RPC (BITCOIN_RPC_URL = http://user:pass@host:8332).
 * 스캔: cursor=블록 높이. cursor 다음 블록부터 head 까지 vout 수신 매칭(UtxoRpcScanner).
 */
@Injectable()
export class BtcService implements AssetService {
  readonly symbol = 'btc';
  readonly scanIntervalMs = 5000;
  private readonly batchSize = 50;
  private readonly logger = new Logger('BtcService');
  private readonly scanner?: UtxoRpcScanner;
  private warnedNoNode = false;

  constructor() {
    const url = getEnv('BITCOIN_RPC_URL');
    if (url) {
      this.scanner = new UtxoRpcScanner(url, this.logger);
    }
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    if (!this.scanner) {
      this.warnNoNode();
      return { txs: [], nextCursor: cursor };
    }
    const head = await this.scanner.getBlockCount();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.batchSize - 1, head);
    const txs = await this.scanner.scanRange(from, to, addresses);
    this.logger.log(`scanned blocks ${from}~${to} (UTXO) → ${txs.length} tx`);
    return { txs, nextCursor: String(to) };
  }

  async getBalance(address: string): Promise<string> {
    this.warnIfNoNode();
    // TODO(RPC): watch-only 지갑 잔고 또는 인덱서 사용.
    this.logger.log(`getBalance(${address})`);
    return '0';
  }

  async getBlockHeight(): Promise<number> {
    if (!this.scanner) {
      this.warnNoNode();
      return 0;
    }
    return this.scanner.getBlockCount();
  }

  private warnIfNoNode(): void {
    if (!this.scanner) this.warnNoNode();
  }

  private warnNoNode(): void {
    if (!this.warnedNoNode) {
      this.logger.warn('no BITCOIN_RPC_URL — scan skipped');
      this.warnedNoNode = true;
    }
  }
}
