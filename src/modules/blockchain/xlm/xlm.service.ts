import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { BigNumber } from 'bignumber.js';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getMaxDepositScanRange,
  getNodeUrlByPath,
  getRawDecimal,
} from '../parameter-store';

const XLM_PATH = 'xlm';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface XlmState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  server?: Horizon.Server;
  /** page limit. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** 원본 최소단위 자릿수(stroops=7). 사토시 환산용. */
  rawDecimal?: number;
}

/**
 * Stellar (XLM).
 *
 * 노드: Horizon (STELLAR_HORIZON_URL). 핸들은 onModuleInit 에서 초기화.
 *   단일 입금 주소 + **memoId** 로 입금 주체 식별.
 * 스캔: **ledger 범위 스캔(§22)** — cursor=마지막 처리 ledger sequence.
 *   ledger 마다 `/ledgers/{seq}/payments`(operation 레벨 — **금액·from·to 포함**)와
 *   `/ledgers/{seq}/transactions`(fee_charged·memo)를 조회해 병합한다.
 *   과거 주소별 paging_token 방식의 공유 커서 유실·계정 히스토리 처음부터 스캔 문제가
 *   구조적으로 없고, tx 레벨엔 없던 **amount 가 payment op 에서 나온다**.
 *   ledger 주기 ~5-6s(사이클당 ~2개)라 부하 미미. Horizon 은 기본으로 성공 tx 의
 *   op 만 반환(include_failed=false) → 수신 status 필터 내장.
 * 금액 단위: Horizon 은 XLM 소수 문자열("12.5000000") — **stroops(×10^7) 정수로 변환**해
 *   raw 로 반환(rawDecimal=7 과 정합).
 */
@Injectable()
export class XlmService implements AssetService, OnModuleInit {
  readonly symbol = 'xlm';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('XlmService');
  private readonly state: XlmState = {};

  getAssetId(): number {
    return AssetId.XLM;
  }

  getRawDecimal(): number {
    return this.state.rawDecimal ?? 8;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxDepositScanRange(XLM_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${XLM_PATH}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    this.state.rawDecimal = await getRawDecimal(XLM_PATH);
    this.state.server = new Horizon.Server(url);
    this.logger.log(
      `Horizon server initialized (maxDepositScanRange=${range})`,
    );
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

    // head = 최신 ledger sequence. (ledger close=최종이라 confirmationThreshold 불필요)
    const head = await this.getBlockHeight();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.state.maxDepositScanRange! - 1, head);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let seq = from; seq <= to; seq++) {
      // 1) tx 레벨 정보(fee_charged/memo) — hash 로 매핑.
      const txInfo = new Map<string, { fee?: string; memo?: string }>();
      for await (const rec of this.pages(
        server.transactions().forLedger(seq),
      )) {
        txInfo.set(rec.hash, {
          fee: rec.fee_charged != null ? String(rec.fee_charged) : undefined,
          memo: rec.memo,
        });
      }
      // 2) payment operation 들 — 금액/from/to. tx 내 op 순번을 txIndex 로(결정적).
      const opIndexByTx = new Map<string, number>();
      const feeEmittedFor = new Set<string>();
      for await (const rec of this.pages(server.payments().forLedger(seq))) {
        const parsed = this.parsePaymentOp(rec);
        if (!parsed) continue;
        const txHash: string = rec.transaction_hash;
        const txIndex = opIndexByTx.get(txHash) ?? 0;
        opIndexByTx.set(txHash, txIndex + 1);

        const isFrom = watch.has(parsed.from);
        const isTo = watch.has(parsed.to);
        if (!isFrom && !isTo) continue;
        const info = txInfo.get(txHash);
        // §14: fee 는 fee-payer(source)∈watch 일 때만 + 한 tx 다중 op 시 첫 행에만(중복 방지).
        let feeAmount: string | undefined;
        if (isFrom && !feeEmittedFor.has(txHash)) {
          feeAmount = info?.fee;
          feeEmittedFor.add(txHash);
        }
        txs.push({
          txHash,
          fromAddress: parsed.from,
          toAddress: parsed.to,
          // Horizon 금액은 XLM 소수 문자열 → stroops(raw, 10^7) 정수로.
          amount: new BigNumber(parsed.amountXlm).shiftedBy(7).toFixed(0),
          feeAmount,
          memoId: info?.memo,
          status: 1, // Horizon 기본: 성공 tx 의 op 만 반환
          blockNumber: seq,
          txIndex,
          raw: { id: rec.id, type: rec.type },
        });
      }
    }

    this.logger.log(
      `scanned ledgers ${from}~${to} (XLM payments) → ${txs.length} tx`,
    );
    return { txs, nextCursor: String(to) };
  }

  /** Horizon CallBuilder 페이지 순회(한 ledger 에 op 가 page limit 를 넘을 때 대비). */
  private async *pages(builder: {
    limit: (n: number) => any;
  }): AsyncGenerator<any> {
    let page = await builder.limit(200).call();
    while (true) {
      for (const rec of page.records) yield rec;
      if (page.records.length < 200) return;
      page = await page.next();
    }
  }

  /**
   * payment 계열 op 에서 native XLM 이동(from/to/amount) 추출.
   * - `payment`/`path_payment_*`: asset_type==='native' 만 (from/to/amount).
   * - `create_account`: funder→account, starting_balance.
   * - `account_merge` 는 op 에 금액이 없어(effects 필요) 미지원 — TODO(개선 후보).
   */
  private parsePaymentOp(
    rec: any,
  ): { from: string; to: string; amountXlm: string } | null {
    if (rec.type === 'create_account' && rec.funder && rec.account) {
      return {
        from: rec.funder,
        to: rec.account,
        amountXlm: rec.starting_balance,
      };
    }
    if (rec.asset_type === 'native' && rec.from && rec.to && rec.amount) {
      return { from: rec.from, to: rec.to, amountXlm: rec.amount };
    }
    return null;
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
