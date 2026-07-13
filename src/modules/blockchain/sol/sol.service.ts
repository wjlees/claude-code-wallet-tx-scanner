import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getMaxDepositScanRange,
  getNodeUrlByPath,
  getRawDecimal,
} from '../parameter-store';

const SOL_PATH = 'sol';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface SolState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  connection?: Connection;
  /** page limit. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** 원본 최소단위 자릿수(lamports=9). 사토시 환산용. */
  rawDecimal?: number;
}

/**
 * Solana 네이티브(SOL).
 *
 * 노드: @solana/web3.js Connection (SOLANA_RPC_URL). 노드 핸들은 onModuleInit 에서 초기화.
 * 스캔: 블록 순회가 아니라 **주소별 getSignaturesForAddress 페이징**.
 *   cursor=마지막으로 처리한 signature. {until: cursor} 로 그 이후 신규만 가져온다.
 *   signature 마다 getParsedTransaction 으로 fee/status + **pre/postBalances delta** 를 파싱해
 *   from(최대 감소)과 **수신자별(양수 delta) 행**을 만든다(SOL 은 tx 에 금액 필드가 없음;
 *   한 tx 다중 수신 대응 §20).
 */
@Injectable()
export class SolService implements AssetService, OnModuleInit {
  readonly symbol = 'sol';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('SolService');
  private readonly state: SolState = {};

  getAssetId(): number {
    return AssetId.SOL;
  }

  getRawDecimal(): number {
    return this.state.rawDecimal ?? 8;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxDepositScanRange(SOL_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${SOL_PATH}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    this.state.rawDecimal = await getRawDecimal(SOL_PATH);
    // 'finalized' = SOL 의 확정(reorg 안전) 지점 — EVM confirmationThreshold cap 에 대응.
    this.state.connection = new Connection(url, 'finalized');
    this.logger.log(`connection initialized (maxDepositScanRange=${range})`);
  }

  /** 노드 URL 조회. ParamStore path 기준 async 조회(추후 DB/원격 설정 교체 가능). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrlByPath(SOL_PATH);
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { connection } = this.state;
    if (!connection) {
      warnMissingNode(this.logger, SOL_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const limit = this.state.maxDepositScanRange!;
    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];
    let newest: string | null = cursor;

    for (const address of addresses) {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(address),
        { until: cursor ?? undefined, limit },
      );
      // 결과는 최신순. 첫 호출의 가장 최신 signature 를 다음 커서로.
      if (sigs.length > 0 && newest === cursor) {
        newest = sigs[0].signature;
      }
      for (const sig of sigs) {
        // getParsedTransaction 으로 fee/status/feePayer + 잔고 delta 조회(추가 호출).
        const parsed = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        const keys = (parsed?.transaction?.message?.accountKeys ?? []).map(
          (k: any) => k.pubkey?.toString(),
        );
        const isFeePayer = !!keys[0] && watch.has(keys[0]); // accountKeys[0]=fee payer
        const status = sig.err || parsed?.meta?.err ? 0 : 1;
        if (!isFeePayer && status !== 1) continue; // 실패 & 우리가 낸 fee 아님 → skip

        // native 이동은 pre/postBalances 의 계정별 lamports delta 로 계산(SOL 은 금액 필드가 없음).
        // fee-payer 의 delta 에는 fee 가 섞여 있어 분리. 최대 감소=from,
        // **양수 delta 전부=수신자**(§20 — '최대 증가 1명=to' 는 배치 전송에서 누락 유발).
        const fee = parsed?.meta?.fee != null ? BigInt(parsed.meta.fee) : 0n;
        let fromAddress: string | undefined;
        const recipients: { address: string; amount: bigint }[] = [];
        const pre = parsed?.meta?.preBalances;
        const post = parsed?.meta?.postBalances;
        if (status === 1 && pre && post) {
          let minDelta = 0n;
          keys.forEach((k: string | undefined, i: number) => {
            if (!k || pre[i] == null || post[i] == null) return;
            let d = BigInt(post[i]) - BigInt(pre[i]);
            if (i === 0) d += fee; // fee-payer delta 에서 fee 제외(순수 이동분만)
            if (d < minDelta) {
              minDelta = d;
              fromAddress = k;
            }
            if (d > 0n) recipients.push({ address: k, amount: d });
          });
          // txIndex 안정화: 수신자 순서를 주소 정렬로 고정(watch 구성과 무관)
          recipients.sort((a, b) => (a.address < b.address ? -1 : 1));
        }
        // §14/§20: originate(fee-payer 또는 from∈watch)면 전 수신자 행, 수신이면 watch 수신자만.
        const isFrom = isFeePayer || (!!fromAddress && watch.has(fromAddress));
        const feeAmount =
          isFeePayer && parsed?.meta?.fee != null
            ? String(parsed.meta.fee)
            : undefined;
        let emitted = 0;
        recipients.forEach((rc, txIndex) => {
          if (!isFrom && !watch.has(rc.address)) return;
          txs.push({
            txHash: sig.signature,
            fromAddress,
            toAddress: rc.address,
            amount: rc.amount.toString(),
            feeAmount: emitted === 0 ? feeAmount : undefined, // fee 중복 합산 방지
            status,
            blockNumber: sig.slot,
            txIndex,
            raw: sig,
          });
          emitted++;
        });
        // 우리가 originate 했는데 수신 행이 없으면(실패 tx 등) fee 기록용 단독 행(amount=0).
        if (isFrom && emitted === 0) {
          txs.push({
            txHash: sig.signature,
            fromAddress: fromAddress ?? keys[0],
            amount: '0',
            feeAmount,
            status,
            blockNumber: sig.slot,
            txIndex: 0,
            raw: sig,
          });
        }
      }
    }

    this.logger.log(`scanned signatures → ${txs.length} sig(s)`);
    return { txs, nextCursor: newest };
  }

  async getBalance(address: string): Promise<string> {
    const { connection } = this.state;
    if (!connection) {
      warnMissingNode(this.logger, SOL_PATH);
      return '0';
    }
    const lamports = await connection.getBalance(new PublicKey(address));
    return String(lamports);
  }

  async getBlockHeight(): Promise<number> {
    const { connection } = this.state;
    if (!connection) {
      warnMissingNode(this.logger, SOL_PATH);
      return 0;
    }
    return connection.getSlot();
  }
}
