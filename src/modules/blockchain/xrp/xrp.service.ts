import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getMaxDepositScanRange,
  getNodeUrlByPath,
  getRawDecimal,
} from '../parameter-store';
import { XrpRpcClient } from './xrp-rpc.client';

const XRP_PATH = 'xrp';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface XrpState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  client?: XrpRpcClient;
  /** account_tx page limit. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** 원본 최소단위 자릿수(drops=6). 사토시 환산용. */
  rawDecimal?: number;
}

/**
 * XRP Ledger (XRP). 네이티브 코인.
 *
 * 노드: rippled JSON-RPC (XRP_RPC_URL). 핸들은 onModuleInit 에서 초기화.
 * 스캔: **ledger 범위 스캔(§22)** — cursor=마지막 처리 ledger index(validated 기준).
 *   `ledger`(transactions+expand)로 그 ledger 의 전체 tx+meta 를 1콜에 받아 필터.
 *   ledger 주기 ~4s(사이클당 2~3개)라 부하 미미하고, 주소별 account_tx 방식의
 *   공유 커서 유실·limit 중간 잘림 문제가 구조적으로 없다.
 *   Payment 의 Account/Destination 으로 in/out, DestinationTag 를 memoId(입금 식별)로.
 * ⚠️ **amount 는 meta.delivered_amount** 가 정답 — partial payment(tfPartialPayment) tx 는
 *   tx.Amount(요청액)와 실제 전달액이 다르다(tx.Amount 로 크레딧하면 과다 지급 — 거래소
 *   고전 공격 벡터). delivered_amount 없고 partial 플래그도 없을 때만 tx.Amount 사용.
 */
@Injectable()
export class XrpService implements AssetService, OnModuleInit {
  readonly symbol = 'xrp';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('XrpService');
  private readonly state: XrpState = {};

  getAssetId(): number {
    return AssetId.XRP;
  }

  getRawDecimal(): number {
    return this.state.rawDecimal ?? 8;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxDepositScanRange(XRP_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${XRP_PATH}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    this.state.rawDecimal = await getRawDecimal(XRP_PATH);
    this.state.client = new XrpRpcClient(url);
    this.logger.log(
      `rippled client initialized (maxDepositScanRange=${range})`,
    );
  }

  /** 노드 URL 조회. ParamStore path 기준 async 조회(추후 DB/원격 설정 교체 가능). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrlByPath(XRP_PATH);
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XRP_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const head = await client.getValidatedLedgerIndex();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.state.maxDepositScanRange! - 1, head);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];
    for (let ledgerIndex = from; ledgerIndex <= to; ledgerIndex++) {
      const entries = await client.getLedgerTxs(ledgerIndex);
      for (const entry of entries) {
        // rippled api v1: tx 필드 톱레벨 + metaData / v2: tx_json + meta — 둘 다 지원.
        const tx = entry.tx_json ?? entry;
        const meta = entry.metaData ?? entry.meta ?? {};
        const txHash = entry.hash ?? tx.hash;
        if (!txHash) continue;
        // 실패 tx(tec 계열)도 validated ledger 에 실리고 fee 를 태운다.
        const status = meta.TransactionResult === 'tesSUCCESS' ? 1 : 0;
        const isFrom = !!tx.Account && watch.has(tx.Account);
        const amount = this.deliveredAmount(tx, meta);
        // txIndex = ledger 내 tx 위치(meta 제공) — 결정적 멱등 키.
        const txIndex = Number(meta.TransactionIndex ?? 0);

        if (isFrom) {
          // §14: 우리가 originate(모든 타입) — 실패/0금액도 fee 소모 기록(status·amount 반영).
          txs.push({
            txHash,
            fromAddress: tx.Account,
            toAddress: tx.Destination,
            amount: status === 1 && amount ? amount : '0',
            feeAmount: typeof tx.Fee === 'string' ? tx.Fee : undefined,
            status,
            memoId:
              tx.DestinationTag !== undefined
                ? String(tx.DestinationTag)
                : undefined,
            blockNumber: ledgerIndex,
            txIndex,
            raw: { hash: txHash },
          });
          continue;
        }
        // 수신: 성공한 Payment + 실제 전달액(delivered) 있는 것만.
        if (tx.TransactionType !== 'Payment' || status !== 1) continue;
        if (!amount || Number(amount) <= 0) continue;
        if (!tx.Destination || !watch.has(tx.Destination)) continue;
        txs.push({
          txHash,
          fromAddress: tx.Account,
          toAddress: tx.Destination,
          amount,
          memoId:
            tx.DestinationTag !== undefined
              ? String(tx.DestinationTag)
              : undefined,
          status,
          blockNumber: ledgerIndex,
          txIndex,
          raw: { hash: txHash },
        });
      }
    }

    this.logger.log(
      `scanned ledgers ${from}~${to} (XRP, validated) → ${txs.length} tx`,
    );
    return { txs, nextCursor: String(to) };
  }

  /**
   * 실제 전달된 native XRP(drops). **partial payment 방어** —
   * meta.delivered_amount(구버전 DeliveredAmount)가 있으면 그것만 신뢰(string=native).
   * object(IOU)면 대상 아님. delivered 정보가 아예 없으면 partial 플래그가 없는
   * 경우에 한해 tx.Amount 사용.
   */
  private deliveredAmount(tx: any, meta: any): string | undefined {
    const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
    if (delivered !== undefined) {
      return typeof delivered === 'string' ? delivered : undefined;
    }
    const TF_PARTIAL_PAYMENT = 0x00020000;
    if (
      typeof tx.Amount === 'string' &&
      ((tx.Flags ?? 0) & TF_PARTIAL_PAYMENT) === 0
    ) {
      return tx.Amount;
    }
    return undefined;
  }

  async getBalance(address: string): Promise<string> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XRP_PATH);
      return '0';
    }
    return client.getBalance(address);
  }

  async getBlockHeight(): Promise<number> {
    const { client } = this.state;
    if (!client) {
      warnMissingNode(this.logger, XRP_PATH);
      return 0;
    }
    return client.getValidatedLedgerIndex();
  }
}
