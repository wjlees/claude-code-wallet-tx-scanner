import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getMaxScanRange, getNodeUrlByPath } from '../parameter-store';
import { XplaRestClient } from './xpla-rest.client';

const XPLA_PATH = 'xpla';
/** XPLA 네이티브 denom */
const XPLA_DENOM = 'axpla';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface XplaState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  client?: XplaRestClient;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxScanRange?: number;
}

/**
 * XPLA Chain (XPLA). Cosmos SDK 기반 독립 체인.
 *
 * 노드: Cosmos LCD REST (XPLA_LCD_URL). 핸들은 onModuleInit 에서 초기화.
 *   ⚠️ `@xpla/xpla.js` 는 top-level import 만으로 부팅 크래시(@xpla/xpla.proto v2 누락)라
 *      SDK 대신 REST(fetch)로 구현한다(XplaRestClient).
 * 스캔: cursor=마지막 스캔 블록 높이. 블록별 tx 를 받아 Cosmos `transfer` 이벤트의
 *       recipient/sender 가 대상 주소면 in/out 으로 수집. memo 는 입금 식별용(memoId).
 */
@Injectable()
export class XplaService implements AssetService, OnModuleInit {
  readonly symbol = 'xpla';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('XplaService');
  private readonly state: XplaState = {};

  getAssetId(): number {
    return AssetId.XPLA;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxScanRange(XPLA_PATH);
    if (range === undefined) {
      this.logger.log(`no maxScanRange for "${XPLA_PATH}" — scan skipped`);
      return;
    }
    this.state.maxScanRange = range;
    this.state.client = new XplaRestClient(url);
    this.logger.log(`LCD REST client initialized (maxScanRange=${range})`);
  }

  /** 노드 URL 조회. ParamStore path 기준 async 조회(추후 DB/원격 설정 교체 가능). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrlByPath(XPLA_PATH);
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XPLA_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const head = await client.getLatestHeight();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.state.maxScanRange! - 1, head);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const txResponses = await client.getTxsByHeight(n);
      for (const txr of txResponses) {
        const memo = txr.tx?.body?.memo || undefined;
        const recipients = this.eventValues(txr, 'transfer', 'recipient');
        const senders = this.eventValues(txr, 'transfer', 'sender');
        const amounts = this.eventValues(txr, 'transfer', 'amount');
        for (let i = 0; i < recipients.length; i++) {
          const recipient = recipients[i];
          const sender = senders[i];
          if (watch.has(recipient) || (sender && watch.has(sender))) {
            txs.push({
              txHash: txr.txhash,
              fromAddress: sender,
              toAddress: recipient,
              amount: amounts[i],
              memoId: memo,
              blockNumber: n,
              raw: { txhash: txr.txhash },
            });
          }
        }
      }
    }

    this.logger.log(`scanned blocks ${from}~${to} (XPLA) → ${txs.length} tx`);
    return { txs, nextCursor: String(to) };
  }

  /**
   * tx 응답에서 특정 이벤트(type)의 attribute(key) 값들을 순서대로 모은다.
   * Cosmos SDK 버전에 따라 events 가 `logs[].events` 또는 top-level `events` 에 있다.
   */
  private eventValues(txr: any, type: string, key: string): string[] {
    const out: string[] = [];
    const collect = (events: any[] | undefined) => {
      for (const ev of events ?? []) {
        if (ev.type !== type) continue;
        for (const attr of ev.attributes ?? []) {
          if (attr.key === key) out.push(attr.value);
        }
      }
    };
    if (txr.logs?.length) {
      for (const log of txr.logs) collect(log.events);
    } else {
      collect(txr.events); // sdk 0.50+: tx_response.events
    }
    return out;
  }

  async getBalance(address: string): Promise<string> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XPLA_PATH);
      return '0';
    }
    return client.getBalance(address, XPLA_DENOM);
  }

  async getBlockHeight(): Promise<number> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XPLA_PATH);
      return 0;
    }
    return client.getLatestHeight();
  }
}
