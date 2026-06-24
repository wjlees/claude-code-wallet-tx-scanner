import { Injectable, Logger } from '@nestjs/common';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
import { getEnv } from '../node-config';
import { UtxoRpcScanner } from '../utxo-rpc.scanner';

/**
 * Bitcoin Cash (BCH). BTC 와 동일한 UTXO 모델 (Bitcoin Cash Node JSON-RPC).
 *
 * 노드: BCH_RPC_URL = http://user:pass@host:port. 스캔 방식은 BTC 와 동일.
 */
@Injectable()
export class BchService implements AssetService {
  readonly symbol = 'bch';
  readonly scanIntervalMs = 5000;
  private readonly batchSize = 50;
  private readonly logger = new Logger('BchService');
  private readonly scanner?: UtxoRpcScanner;
  private warnedNoNode = false;

  constructor() {
    const url = getEnv('BCH_RPC_URL');
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
    if (!this.scanner) this.warnNoNode();
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

  private warnNoNode(): void {
    if (!this.warnedNoNode) {
      this.logger.warn('no BCH_RPC_URL — scan skipped');
      this.warnedNoNode = true;
    }
  }
}
