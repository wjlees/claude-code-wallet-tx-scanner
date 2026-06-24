import { Injectable, Logger } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { TokenService } from '../interfaces/token.interface';
import { getEnv } from '../node-config';

/** SPL Token Program */
const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/**
 * Solana SPL 토큰.
 *
 * 노드: @solana/web3.js Connection (SOLANA_RPC_URL).
 * 스캔: 소유자 주소가 아니라 **토큰계정(ATA)** 단위로 일어난다.
 *   getParsedTokenAccountsByOwner 로 소유자의 토큰계정을 찾고,
 *   각 토큰계정에 getSignaturesForAddress 페이징. cursor=마지막 signature.
 */
@Injectable()
export class SplService implements TokenService {
  readonly symbol = 'spl';
  readonly scanIntervalMs = 500;
  private readonly logger = new Logger('SplService');
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

    for (const owner of addresses) {
      const { value: tokenAccounts } =
        await this.connection.getParsedTokenAccountsByOwner(
          new PublicKey(owner),
          { programId: TOKEN_PROGRAM_ID },
        );

      for (const { pubkey } of tokenAccounts) {
        const sigs = await this.connection.getSignaturesForAddress(pubkey, {
          until: cursor ?? undefined,
          limit: 1000,
        });
        if (sigs.length > 0 && newest === cursor) {
          newest = sigs[0].signature;
        }
        for (const sig of sigs) {
          txs.push({
            txHash: sig.signature,
            address: owner,
            counterparty: pubkey.toBase58(),
            // TODO(RPC): getParsedTransaction 으로 in/out·amount·mint 판별.
            raw: sig,
          });
        }
      }
    }

    this.logger.log(`scanned token-account signatures → ${txs.length} sig(s)`);
    return { txs, nextCursor: newest };
  }

  async getTokenBalance(
    address: string,
    tokenAddress: string,
  ): Promise<string> {
    this.logger.log(`getTokenBalance(${address}, ${tokenAddress})`);
    // TODO(RPC): getParsedTokenAccountsByOwner 에서 mint=tokenAddress 잔고 합산.
    return '0';
  }

  async getTokenMetadata(tokenAddress: string): Promise<unknown> {
    this.logger.log(`getTokenMetadata(${tokenAddress})`);
    return null;
  }

  private warnNoNode(): void {
    if (!this.warnedNoNode) {
      this.logger.warn('no SOLANA_RPC_URL — SPL scan skipped');
      this.warnedNoNode = true;
    }
  }
}
