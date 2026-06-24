import { Injectable, Logger } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { getEnv } from '../node-config';

/**
 * Solana 네이티브(SOL).
 *
 * 노드: @solana/web3.js Connection (SOLANA_RPC_URL). 빠른 스캔 요구 → 짧은 간격.
 * 스캔: 블록 순회가 아니라 **주소별 getSignaturesForAddress 페이징**.
 *   cursor=마지막으로 처리한 signature. {until: cursor} 로 그 이후 신규만 가져온다.
 *
 * NOTE: in/out 방향은 tx 를 parse 해야 정확히 안다(잔고 delta). 현재는 signature 수집까지.
 */
@Injectable()
export class SolService implements AssetService {
  readonly symbol = 'sol';
  readonly scanIntervalMs = 500;
  private readonly logger = new Logger('SolService');
  private readonly connection?: Connection;
  private warnedNoNode = false;

  constructor() {
    const url = getEnv('SOLANA_RPC_URL');
    if (url) {
      this.connection = new Connection(url, 'confirmed');
    }
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    if (!this.connection) {
      this.warnNoNode();
      return { txs: [], nextCursor: cursor };
    }

    const txs: DetectedTx[] = [];
    let newest: string | null = cursor;

    for (const address of addresses) {
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(address),
        { until: cursor ?? undefined, limit: 1000 },
      );
      // 결과는 최신순. 첫 호출의 가장 최신 signature 를 다음 커서로.
      if (sigs.length > 0 && newest === cursor) {
        newest = sigs[0].signature;
      }
      for (const sig of sigs) {
        txs.push({
          txHash: sig.signature,
          address,
          // TODO(RPC): getParsedTransaction 으로 in/out·amount·counterparty 판별.
          raw: sig,
        });
      }
    }

    this.logger.log(`scanned signatures → ${txs.length} sig(s)`);
    return { txs, nextCursor: newest };
  }

  async getBalance(address: string): Promise<string> {
    if (!this.connection) {
      this.warnNoNode();
      return '0';
    }
    const lamports = await this.connection.getBalance(new PublicKey(address));
    return String(lamports);
  }

  async getBlockHeight(): Promise<number> {
    if (!this.connection) {
      this.warnNoNode();
      return 0;
    }
    return this.connection.getSlot();
  }

  private warnNoNode(): void {
    if (!this.warnedNoNode) {
      this.logger.warn('no SOLANA_RPC_URL — scan skipped');
      this.warnedNoNode = true;
    }
  }
}
