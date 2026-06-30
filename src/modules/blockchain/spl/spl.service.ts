import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { TokenTypeId } from '../constants';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { TokenService } from '../interfaces/token.interface';
import { warnMissingNode } from '../node-config';
import { getMaxScanRange, getNodeUrlByPath } from '../parameter-store';

const SOL_PATH = 'sol'; // SOL 노드 공유, scan range 도 sol path

/** SPL Token Program */
const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface SplState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  connection?: Connection;
  /** page limit. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxScanRange?: number;
}

/**
 * Solana SPL 토큰.
 *
 * 노드: @solana/web3.js Connection (SOLANA_RPC_URL). 핸들은 onModuleInit 에서 초기화.
 * 스캔: 소유자 주소가 아니라 **토큰계정(ATA)** 단위로 일어난다.
 *   getParsedTokenAccountsByOwner 로 소유자의 토큰계정을 찾고,
 *   각 토큰계정에 getSignaturesForAddress 페이징. cursor=마지막 signature.
 */
@Injectable()
export class SplService implements TokenService, OnModuleInit {
  readonly symbol = 'spl';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('SplService');
  private readonly state: SplState = {};

  getTokenTypeId(): number {
    return TokenTypeId.SPL;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxScanRange(SOL_PATH);
    if (range === undefined) {
      this.logger.log(`no maxScanRange for "${SOL_PATH}" — scan skipped`);
      return;
    }
    this.state.maxScanRange = range;
    this.state.connection = new Connection(url, 'confirmed');
    this.logger.log(`connection initialized (maxScanRange=${range})`);
  }

  /** 노드 URL 조회. ParamStore path 기준 async 조회(SOL 노드 공유). */
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

    const limit = this.state.maxScanRange!;
    const txs: DetectedTx[] = [];
    let newest: string | null = cursor;

    for (const owner of addresses) {
      const { value: tokenAccounts } =
        await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
          programId: TOKEN_PROGRAM_ID,
        });

      for (const { pubkey } of tokenAccounts) {
        const sigs = await connection.getSignaturesForAddress(pubkey, {
          until: cursor ?? undefined,
          limit,
        });
        if (sigs.length > 0 && newest === cursor) {
          newest = sigs[0].signature;
        }
        for (const sig of sigs) {
          // signature 만 수집. from/to·amount·mint 는 getParsedTransaction 파싱 필요(TODO).
          txs.push({
            txHash: sig.signature,
            blockNumber: sig.slot,
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
}
