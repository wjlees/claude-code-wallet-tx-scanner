import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getMaxScanRange, getParameter } from '../parameter-store';
import { XrpRpcClient } from './xrp-rpc.client';

const XRP_RPC_ENV = 'XRP_RPC_URL';
const XRP_SCAN_RANGE_KEY = 'XRP_MAX_SCAN_RANGE';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface XrpState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  client?: XrpRpcClient;
  /** account_tx page limit. onModuleInit 에서 ParamStore 로 조회(필수, 누락 시 throw). */
  maxScanRange?: number;
}

/**
 * XRP Ledger (XRP). 네이티브 코인.
 *
 * 노드: rippled JSON-RPC (XRP_RPC_URL). 핸들은 onModuleInit 에서 초기화.
 * 스캔: cursor=마지막 처리 ledger index. 주소별 account_tx 를 ledger 범위로 조회.
 *   Payment tx 의 Account/Destination 으로 in/out, DestinationTag 를 memoId(입금 식별)로.
 */
@Injectable()
export class XrpService implements AssetService, OnModuleInit {
  readonly symbol = 'xrp';
  readonly scanIntervalMs = 2000;
  private readonly logger = new Logger('XrpService');
  private readonly state: XrpState = {};

  getAssetId(): number {
    return AssetId.XRP;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    this.state.maxScanRange = await getMaxScanRange(XRP_SCAN_RANGE_KEY);
    this.state.client = new XrpRpcClient(url);
    this.logger.log(
      `rippled client initialized (maxScanRange=${this.state.maxScanRange})`,
    );
  }

  /** 노드 URL 조회. 현재는 환경변수지만 async 소스(DB/원격 설정)로 교체 가능. */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getParameter(XRP_RPC_ENV);
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XRP_RPC_ENV);
      return { txs: [], nextCursor: cursor };
    }

    const head = await client.getCurrentLedgerIndex();
    // cursor 없으면 현재 ledger 부터 추적 시작.
    const from = cursor === null ? head : Number(cursor) + 1;
    let maxLedger = cursor === null ? head : Number(cursor);

    const limit = this.state.maxScanRange!;
    const txs: DetectedTx[] = [];
    for (const address of addresses) {
      const entries = await client.accountTx(address, from, limit);
      for (const entry of entries) {
        const tx = entry.tx ?? entry.tx_json ?? {};
        const ledgerIndex: number =
          entry.tx?.ledger_index ?? entry.ledger_index ?? tx.ledger_index ?? 0;
        if (ledgerIndex > maxLedger) maxLedger = ledgerIndex;
        if (tx.TransactionType && tx.TransactionType !== 'Payment') continue;

        const direction: 'in' | 'out' = tx.Account === address ? 'out' : 'in';
        txs.push({
          txHash: entry.hash ?? tx.hash,
          direction,
          address,
          counterparty: direction === 'out' ? tx.Destination : tx.Account,
          amount: typeof tx.Amount === 'string' ? tx.Amount : undefined,
          memoId:
            tx.DestinationTag !== undefined
              ? String(tx.DestinationTag)
              : undefined,
          raw: entry,
        });
      }
    }

    this.logger.log(
      `scanned account_tx → ${txs.length} tx (ledger ≤ ${maxLedger})`,
    );
    return { txs, nextCursor: String(maxLedger) };
  }

  async getBalance(address: string): Promise<string> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XRP_RPC_ENV);
      return '0';
    }
    return client.getBalance(address);
  }

  async getBlockHeight(): Promise<number> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XRP_RPC_ENV);
      return 0;
    }
    return client.getCurrentLedgerIndex();
  }
}
