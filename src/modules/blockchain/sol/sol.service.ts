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
/** getParsedBlock 동시 요청 상한(청크 내 병렬, 청크 간 순차) — 노드 과부하 완화. */
const BLOCK_CHUNK = 25;

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface SolState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  connection?: Connection;
  /** 1회 스캔 슬롯 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** 원본 최소단위 자릿수(lamports=9). 사토시 환산용. */
  rawDecimal?: number;
}

/**
 * Solana 네이티브(SOL) + **SPL 통합 블록 스캔**(§22).
 *
 * 노드: @solana/web3.js Connection (SOLANA_RPC_URL). 노드 핸들은 onModuleInit 에서 초기화.
 * 스캔: **슬롯(블록) 범위 스캔** — cursor=마지막 처리 slot. `getBlocks(from,to)` 로 존재하는
 *   슬롯을 얻고 `getParsedBlock` 을 청크 병렬로 조회. 주소별 signature 조회가 아니므로
 *   **RPC 수가 감시 주소 수와 무관**하고(O(슬롯)), 커서도 slot 하나면 된다(주소별 커서 불필요).
 *   commitment 'finalized' = reorg 안전(confirmationThreshold cap 대응).
 * 통합 러너: 블록의 각 tx 에 native(pre/postBalances)와 SPL(pre/postTokenBalances) delta 가
 *   함께 있어 **한 번 파싱으로 SOL 행 + SPL 토큰 행을 동시 생성**한다. tx-scanner 가
 *   통합 러너(SOL+SPL — 구성은 tx-scanner 내부 상수) 1개만 만들고 contractAddresses(mint 목록)를 넘긴다.
 * 금액: 주소별 잔고 delta — 최대 감소=from, 양수 delta 각각=수신자 행(§20).
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

  /**
   * 슬롯 범위 스캔. `contractAddresses`(SPL mint 목록)가 있으면 같은 파싱에서
   * SPL 토큰 행(contractAddress=mint)도 함께 만든다(통합 러너 — tx-scanner 가 저장 시 분류).
   */
  async scanTransactions(
    addresses: string[],
    cursor: string | null,
    contractAddresses: string[] = [],
  ): Promise<ScanResult> {
    const { connection, maxDepositScanRange } = this.state;
    if (!connection || maxDepositScanRange === undefined) {
      warnMissingNode(this.logger, SOL_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const head = await connection.getSlot(); // commitment=finalized(연결 기본값)
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + maxDepositScanRange - 1, head);

    // finalized 범위의 "존재하는" 슬롯만(skipped slot 제외).
    const slots = await connection.getBlocks(from, to);
    const watch = new Set(addresses);
    const mints = new Set(contractAddresses);
    const txs: DetectedTx[] = [];

    for (let i = 0; i < slots.length; i += BLOCK_CHUNK) {
      const chunk = slots.slice(i, i + BLOCK_CHUNK);
      const blocks = await Promise.all(
        chunk.map((slot) =>
          connection.getParsedBlock(slot, {
            maxSupportedTransactionVersion: 0,
            transactionDetails: 'full',
            rewards: false,
          }),
        ),
      );
      // 실패는 throw → 러너가 사이클 재시도(커서 미전진, 멱등 저장이라 안전).
      blocks.forEach((block, j) => {
        const slot = chunk[j];
        for (const btx of block?.transactions ?? []) {
          this.collectTxRows(btx, slot, watch, mints, txs);
        }
      });
    }

    this.logger.log(
      `scanned slots ${from}~${to} (SOL+SPL, blocks=${slots.length}) → ${txs.length} row(s)`,
    );
    return { txs, nextCursor: String(to) };
  }

  /**
   * 블록 내 tx 1건에서 native(SOL) 행 + SPL 토큰 행(§20 수신자별 행 분리)을 수집한다.
   * 파싱 규칙은 기존 signature 방식과 동일 — 입력이 block tx 로 바뀌었을 뿐.
   */
  private collectTxRows(
    btx: any,
    slot: number,
    watch: Set<string>,
    mints: Set<string>,
    out: DetectedTx[],
  ): void {
    const meta = btx.meta;
    if (!meta) return;
    const txHash: string = btx.transaction?.signatures?.[0] ?? '';
    if (!txHash) return;
    const keys: (string | undefined)[] = (
      btx.transaction?.message?.accountKeys ?? []
    ).map((k: any) => k.pubkey?.toString());
    const isFeePayer = !!keys[0] && watch.has(keys[0]); // accountKeys[0]=fee payer
    const status = meta.err ? 0 : 1;
    if (!isFeePayer && status !== 1) return; // 실패 & 우리가 낸 fee 아님 → skip

    // ---- native SOL: pre/postBalances 계정별 delta (fee-payer delta 는 fee 분리) ----
    const fee = meta.fee != null ? BigInt(meta.fee) : 0n;
    let fromAddress: string | undefined;
    const recipients: { address: string; amount: bigint }[] = [];
    const pre = meta.preBalances;
    const post = meta.postBalances;
    if (status === 1 && pre && post) {
      let minDelta = 0n;
      keys.forEach((k, i) => {
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
      isFeePayer && meta.fee != null ? String(meta.fee) : undefined;
    let emitted = 0;
    recipients.forEach((rc, txIndex) => {
      if (!isFrom && !watch.has(rc.address)) return;
      out.push({
        txHash,
        fromAddress,
        toAddress: rc.address,
        amount: rc.amount.toString(),
        feeAmount: emitted === 0 ? feeAmount : undefined, // fee 중복 합산 방지
        status,
        blockNumber: slot,
        txIndex,
        raw: { signature: txHash, slot },
      });
      emitted++;
    });
    // 우리가 originate 했는데 수신 행이 없으면(실패 tx 등) fee 기록용 단독 행(amount=0).
    if (isFrom && emitted === 0) {
      out.push({
        txHash,
        fromAddress: fromAddress ?? keys[0],
        amount: '0',
        feeAmount,
        status,
        blockNumber: slot,
        txIndex: 0,
        raw: { signature: txHash, slot },
      });
    }

    // ---- SPL 토큰: pre/postTokenBalances 의 mint별 owner delta (§20 동일, fee 없음 §14) ----
    if (status !== 1 || mints.size === 0) return;
    // mint → owner → delta (같은 owner 토큰계정 복수 대비 합산)
    const deltaByMint = new Map<string, Map<string, bigint>>();
    for (const tb of meta.postTokenBalances ?? []) {
      if (!tb.owner || !mints.has(tb.mint)) continue;
      const m = deltaByMint.get(tb.mint) ?? new Map<string, bigint>();
      m.set(
        tb.owner,
        (m.get(tb.owner) ?? 0n) + BigInt(tb.uiTokenAmount.amount),
      );
      deltaByMint.set(tb.mint, m);
    }
    for (const tb of meta.preTokenBalances ?? []) {
      if (!tb.owner || !mints.has(tb.mint)) continue;
      const m = deltaByMint.get(tb.mint) ?? new Map<string, bigint>();
      m.set(
        tb.owner,
        (m.get(tb.owner) ?? 0n) - BigInt(tb.uiTokenAmount.amount),
      );
      deltaByMint.set(tb.mint, m);
    }
    for (const [mint, deltaByOwner] of deltaByMint) {
      let tokenFrom: string | undefined;
      let minDelta = 0n;
      const tokenRecipients: { address: string; amount: bigint }[] = [];
      for (const [ownerAddr, d] of deltaByOwner) {
        if (d < minDelta) {
          minDelta = d;
          tokenFrom = ownerAddr;
        }
        if (d > 0n) tokenRecipients.push({ address: ownerAddr, amount: d });
      }
      if (tokenRecipients.length === 0) continue; // 이 mint 이동 없음
      tokenRecipients.sort((a, b) => (a.address < b.address ? -1 : 1));
      const isTokenFrom = isFeePayer || (!!tokenFrom && watch.has(tokenFrom));
      tokenRecipients.forEach((rc, txIndex) => {
        if (!isTokenFrom && !watch.has(rc.address)) return;
        out.push({
          txHash,
          fromAddress: tokenFrom,
          toAddress: rc.address,
          contractAddress: mint,
          amount: rc.amount.toString(),
          blockNumber: slot,
          txIndex,
          raw: { signature: txHash, slot },
        });
      });
    }
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
