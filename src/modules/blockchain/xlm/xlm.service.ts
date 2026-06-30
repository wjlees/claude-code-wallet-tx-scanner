import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getMaxScanRange, getNodeUrlByPath } from '../parameter-store';

const XLM_PATH = 'xlm';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface XlmState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  server?: Horizon.Server;
  /** page limit. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxScanRange?: number;
}

/**
 * Stellar (XLM).
 *
 * 노드: Horizon (STELLAR_HORIZON_URL). 핸들은 onModuleInit 에서 초기화.
 *   단일 입금 주소 + **memoId** 로 입금 주체 식별.
 * 스캔: Horizon `/accounts/{addr}/transactions` 를 paging_token(cursor) 기준으로 페이징.
 *   tx.memo 를 memoId 로, source_account 로 in/out 판별.
 */
@Injectable()
export class XlmService implements AssetService, OnModuleInit {
  readonly symbol = 'xlm';
  readonly scanIntervalMs = 1000;
  private readonly logger = new Logger('XlmService');
  private readonly state: XlmState = {};

  getAssetId(): number {
    return AssetId.XLM;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxScanRange(XLM_PATH);
    if (range === undefined) {
      this.logger.log(`no maxScanRange for "${XLM_PATH}" — scan skipped`);
      return;
    }
    this.state.maxScanRange = range;
    this.state.server = new Horizon.Server(url);
    this.logger.log(`Horizon server initialized (maxScanRange=${range})`);
  }

  /** 노드 URL 조회. ParamStore path 기준 async 조회(추후 DB/원격 설정 교체 가능). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrlByPath(XLM_PATH);
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { server } = this.state;
    if (!server) {
      warnMissingNode(this.logger, XLM_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const limit = this.state.maxScanRange!;
    const txs: DetectedTx[] = [];
    let nextCursor: string | null = cursor;

    for (const address of addresses) {
      const page = await server
        .transactions()
        .forAccount(address)
        .cursor(cursor ?? '')
        .order('asc')
        .limit(limit)
        .call();

      for (const record of page.records) {
        nextCursor = record.paging_token;
        txs.push({
          txHash: record.hash,
          direction: record.source_account === address ? 'out' : 'in',
          address,
          counterparty:
            record.source_account === address
              ? undefined
              : record.source_account,
          memoId: (record as any).memo,
          raw: record,
        });
      }
    }

    this.logger.log(`scanned Horizon tx → ${txs.length} tx`);
    return { txs, nextCursor };
  }

  async getBalance(address: string): Promise<string> {
    const { server } = this.state;
    if (!server) {
      warnMissingNode(this.logger, XLM_PATH);
      return '0';
    }
    const account = await server.loadAccount(address);
    const native = account.balances.find((b: any) => b.asset_type === 'native');
    return native ? (native as any).balance : '0';
  }

  async getBlockHeight(): Promise<number> {
    const { server } = this.state;
    if (!server) {
      warnMissingNode(this.logger, XLM_PATH);
      return 0;
    }
    const latest = await server.ledgers().order('desc').limit(1).call();
    return latest.records[0]?.sequence ?? 0;
  }
}
