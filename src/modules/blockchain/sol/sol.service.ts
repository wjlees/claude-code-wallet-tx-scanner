import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getMaxDepositScanRange, getNodeUrlByPath } from '../parameter-store';

const SOL_PATH = 'sol';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface SolState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  connection?: Connection;
  /** page limit. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
}

/**
 * Solana 네이티브(SOL).
 *
 * 노드: @solana/web3.js Connection (SOLANA_RPC_URL). 노드 핸들은 onModuleInit 에서 초기화.
 * 스캔: 블록 순회가 아니라 **주소별 getSignaturesForAddress 페이징**.
 *   cursor=마지막으로 처리한 signature. {until: cursor} 로 그 이후 신규만 가져온다.
 *
 * NOTE: in/out 방향은 tx 를 parse 해야 정확히 안다(잔고 delta). 현재는 signature 수집까지.
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
    // 'finalized' = SOL 의 확정(reorg 안전) 지점 — EVM confirmations cap 에 대응.
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
        if (sig.err) continue; // 실패 tx 제외(status: err===null 만)
        // signature 만 수집. from/to·amount 는 getParsedTransaction 파싱 필요(TODO).
        txs.push({
          txHash: sig.signature,
          blockNumber: sig.slot,
          raw: sig,
        });
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
