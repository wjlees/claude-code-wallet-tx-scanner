import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ASSET_REPOSITORY, AssetRepository } from '../asset.repository';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getMaxDepositScanRange,
  getNodeUrlByPath,
  getRawDecimal,
} from '../parameter-store';
import { XplaRestClient } from './xpla-rest.client';

const XPLA_PATH = 'xpla';
/** XPLA 네이티브 denom */
const XPLA_DENOM = 'axpla';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface XplaState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  client?: XplaRestClient;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** reorg 안전 마진(스캔 끝 = head-confirmationThreshold). commit 최종이라 보통 0. */
  confirmationThreshold?: number;
  /** 원본 최소단위 자릿수(axpla=**18** — atto). 사토시 환산용. */
  rawDecimal?: number;
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

  constructor(
    @Inject(ASSET_REPOSITORY)
    private readonly assetRepository: AssetRepository,
  ) {}

  getAssetId(): number {
    return AssetId.XPLA;
  }

  getRawDecimal(): number {
    return this.state.rawDecimal ?? 8;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxDepositScanRange(XPLA_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${XPLA_PATH}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    this.state.confirmationThreshold =
      await this.assetRepository.getConfirmThresholdById(this.getAssetId());
    this.state.rawDecimal = await getRawDecimal(XPLA_PATH);
    this.state.client = new XplaRestClient(url);
    this.logger.log(
      `LCD REST client initialized (maxDepositScanRange=${range})`,
    );
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
    // confirmationThreshold 만큼 뒤처진 높이까지만(commit 최종이라 보통 0=무캡).
    const safeHead = Math.max(
      head - (this.state.confirmationThreshold ?? 0),
      0,
    );
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) {
      return { txs: [], nextCursor: String(safeHead) };
    }
    const to = Math.min(from + this.state.maxDepositScanRange! - 1, safeHead);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const txResponses = await client.getTxsByHeight(n);
      for (const txr of txResponses) {
        // status: 성공 tx 만(Cosmos tx_response.code===0).
        if (txr.code && Number(txr.code) !== 0) continue;
        const memo = txr.tx?.body?.memo || undefined;
        // 수수료: auth_info.fee.amount 의 axpla(native). rawDecimal 은 XPLA(18) 로 tx-scanner 가 환산.
        const feeAmount = this.feeOf(txr);
        const recipients = this.eventValues(txr, 'transfer', 'recipient');
        const senders = this.eventValues(txr, 'transfer', 'sender');
        const amounts = this.eventValues(txr, 'transfer', 'amount');
        for (let i = 0; i < recipients.length; i++) {
          const recipient = recipients[i];
          const sender = senders[i];
          // ⚠️ 이벤트 amount 는 "1234axpla"(수량+denom, 콤마로 다중 코인 가능) 형태.
          // native(axpla) 수량만 추출 — 다른 denom(IBC/CW20 등)을 XPLA 입금으로 오인 금지.
          const amount = this.nativeAmountOf(amounts[i]);
          if (!amount || BigInt(amount) <= 0n) continue; // native 아님/0금액 제외
          if (watch.has(recipient) || (sender && watch.has(sender))) {
            txs.push({
              txHash: txr.txhash,
              fromAddress: sender,
              toAddress: recipient,
              amount,
              // fee-payer=보낸쪽(sender)이 우리일 때만 기록(§14). (tx 단위 수수료, native axpla)
              feeAmount: sender && watch.has(sender) ? feeAmount : undefined,
              memoId: memo,
              blockNumber: n,
              txIndex: i, // tx 내 transfer 이벤트 순번
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
   * transfer 이벤트의 amount 문자열("1234axpla" 또는 "1uatom,2axpla")에서
   * native(axpla) 수량만 추출한다. native 가 없으면 undefined.
   */
  private nativeAmountOf(coins?: string): string | undefined {
    if (!coins) return undefined;
    for (const part of coins.split(',')) {
      const m = /^(\d+)axpla$/.exec(part.trim());
      if (m) return m[1];
    }
    return undefined;
  }

  /** tx 의 수수료(native axpla, raw)를 auth_info.fee.amount 에서 뽑는다. 없으면 undefined. */
  private feeOf(txr: any): string | undefined {
    const coins = txr.tx?.auth_info?.fee?.amount ?? [];
    const native = coins.find((c: any) => c.denom === XPLA_DENOM);
    return native?.amount;
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
