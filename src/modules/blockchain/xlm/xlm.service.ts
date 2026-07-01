import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
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
 * 스캔: Horizon `/accounts/{addr}/transactions` 를 paging_token(cursor) 기준으로 페이징.
 *   tx.memo 를 memoId 로, source_account 로 in/out 판별.
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

    const limit = this.state.maxDepositScanRange!;
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
        // status: 성공 tx 만. (Stellar ledger close=최종이라 confirmationThreshold 불필요)
        if ((record as any).successful === false) continue;
        // tx 레벨엔 source_account(from)만 명확. destination 은 operation 파싱 필요(TODO).
        // 스캔 대상 계정이 sender 가 아니면 수신자(to)로 본다(best-effort).
        const fromAddress = record.source_account;
        txs.push({
          txHash: record.hash,
          fromAddress,
          toAddress: fromAddress === address ? undefined : address,
          // 수수료: fee_charged(stroops, native XLM). rawDecimal 은 XLM(7) 로 tx-scanner 가 환산.
          feeAmount: (record as any).fee_charged,
          memoId: (record as any).memo,
          blockNumber: (record as any).ledger,
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
