import { Injectable, Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { getEnv } from '../node-config';

/**
 * Stellar (XLM).
 *
 * 노드: Horizon (STELLAR_HORIZON_URL). 단일 입금 주소 + **memoId** 로 입금 주체 식별.
 * 스캔: Horizon `/accounts/{addr}/transactions` 를 paging_token(cursor) 기준으로 페이징.
 *   tx.memo 를 memoId 로, source_account 로 in/out 판별.
 */
@Injectable()
export class XlmService implements AssetService {
  readonly symbol = 'xlm';
  readonly scanIntervalMs = 1000;
  private readonly logger = new Logger('XlmService');
  private readonly server?: Horizon.Server;
  private warnedNoNode = false;

  constructor() {
    const url = getEnv('STELLAR_HORIZON_URL');
    if (url) {
      this.server = new Horizon.Server(url);
    }
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    if (!this.server) {
      this.warnNoNode();
      return { txs: [], nextCursor: cursor };
    }

    const txs: DetectedTx[] = [];
    let nextCursor: string | null = cursor;

    for (const address of addresses) {
      const page = await this.server
        .transactions()
        .forAccount(address)
        .cursor(cursor ?? '')
        .order('asc')
        .limit(200)
        .call();

      for (const record of page.records) {
        nextCursor = record.paging_token;
        txs.push({
          txHash: record.hash,
          direction: record.source_account === address ? 'out' : 'in',
          address,
          counterparty:
            record.source_account === address ? undefined : record.source_account,
          memoId: (record as any).memo,
          raw: record,
        });
      }
    }

    this.logger.log(`scanned Horizon tx → ${txs.length} tx`);
    return { txs, nextCursor };
  }

  async getBalance(address: string): Promise<string> {
    if (!this.server) {
      this.warnNoNode();
      return '0';
    }
    const account = await this.server.loadAccount(address);
    const native = account.balances.find((b: any) => b.asset_type === 'native');
    return native ? (native as any).balance : '0';
  }

  async getBlockHeight(): Promise<number> {
    if (!this.server) {
      this.warnNoNode();
      return 0;
    }
    const latest = await this.server.ledgers().order('desc').limit(1).call();
    return latest.records[0]?.sequence ?? 0;
  }

  private warnNoNode(): void {
    if (!this.warnedNoNode) {
      this.logger.warn('no STELLAR_HORIZON_URL — scan skipped');
      this.warnedNoNode = true;
    }
  }
}
