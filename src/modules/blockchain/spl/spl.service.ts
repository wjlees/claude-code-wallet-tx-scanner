import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { TokenTypeId } from '../constants';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { TokenService } from '../interfaces/token.interface';
import { warnMissingNode } from '../node-config';
import { getMaxDepositScanRange, getNodeUrlByPath } from '../parameter-store';

const SOL_PATH = 'sol'; // SOL 노드 공유, scan range 도 sol path

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface SplState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  connection?: Connection;
  /** page limit. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
}

/**
 * Solana SPL 토큰.
 *
 * ⚠️ **기본 스캔 경로 아님(§22)**: SOL+SPL 은 tx-scanner 의 통합 러너(§22)가
 *   SolService 의 블록 스캔에서 SPL delta 까지 함께 수집한다(tx-scanner 가 이 서비스의
 *   개별 러너를 만들지 않음). 아래 scanTransactions 는 단독 운용 fallback 용으로만 유지.
 *
 * 노드: @solana/web3.js Connection (SOLANA_RPC_URL). 핸들은 onModuleInit 에서 초기화.
 * 스캔: 소유자 주소가 아니라 **토큰계정(ATA)** 단위로 일어난다.
 *   getParsedTokenAccountsByOwner 로 소유자의 토큰계정을 찾고,
 *   각 토큰계정에 getSignaturesForAddress 페이징. cursor=마지막 signature.
 *   signature 마다 getParsedTransaction 의 **pre/postTokenBalances(해당 mint) owner 별 delta** 로
 *   from(최대 감소)과 **수신자별(양수 delta) 행**을 만든다(한 tx 다중 수신 대응 §20).
 *   fee 는 SOL native 행 담당(§14 — 토큰 행엔 없음).
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
    const range = await getMaxDepositScanRange(SOL_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${SOL_PATH}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    // 'finalized' = 확정(reorg 안전) 지점 — EVM confirmationThreshold cap 에 대응.
    this.state.connection = new Connection(url, 'finalized');
    this.logger.log(`connection initialized (maxDepositScanRange=${range})`);
  }

  /** 노드 URL 조회. ParamStore path 기준 async 조회(SOL 노드 공유). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrlByPath(SOL_PATH);
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
    contractAddresses: string[],
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

    // 이 token_type 의 토큰들(mint 목록)을 한 번에. 각 tx 는 contractAddress=mint 로 분류 가능.
    for (const contractAddress of contractAddresses) {
      const mint = new PublicKey(contractAddress);
      for (const owner of addresses) {
        // 이 mint 의 토큰계정(ATA)만 조회 → 해당 토큰 transfer 만 본다.
        const { value: tokenAccounts } =
          await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
            mint,
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
            if (sig.err) continue; // 실패 tx 제외(토큰 안 움직임; fee 는 SOL native 행 담당 §14)
            // getParsedTransaction 의 pre/postTokenBalances(이 mint)로 owner 별 delta 를 계산해
            // from(감소)/to(증가)/amount 를 얻는다(SPL 도 tx 에 금액 필드가 없음).
            const parsed = await connection.getParsedTransaction(
              sig.signature,
              { maxSupportedTransactionVersion: 0 },
            );
            if (parsed?.meta?.err) continue;
            const deltaByOwner = new Map<string, bigint>();
            for (const tb of parsed?.meta?.postTokenBalances ?? []) {
              if (tb.mint !== contractAddress || !tb.owner) continue;
              // 같은 owner 의 토큰계정이 여럿일 수 있어 덮어쓰지 않고 합산
              deltaByOwner.set(
                tb.owner,
                (deltaByOwner.get(tb.owner) ?? 0n) +
                  BigInt(tb.uiTokenAmount.amount),
              );
            }
            for (const tb of parsed?.meta?.preTokenBalances ?? []) {
              if (tb.mint !== contractAddress || !tb.owner) continue;
              deltaByOwner.set(
                tb.owner,
                (deltaByOwner.get(tb.owner) ?? 0n) -
                  BigInt(tb.uiTokenAmount.amount),
              );
            }
            // 최대 감소=from, 양수 delta 전부=수신자(§20 — 한 tx 다중 수신 대응).
            let fromAddress: string | undefined;
            let minDelta = 0n;
            const recipients: { address: string; amount: bigint }[] = [];
            for (const [ownerAddr, d] of deltaByOwner) {
              if (d < minDelta) {
                minDelta = d;
                fromAddress = ownerAddr;
              }
              if (d > 0n) recipients.push({ address: ownerAddr, amount: d });
            }
            if (recipients.length === 0) continue; // 이 mint 의 이동 없음(0금액) → skip
            // txIndex 안정화: 수신자 순서를 주소 정렬로 고정(watch 구성과 무관)
            recipients.sort((a, b) => (a.address < b.address ? -1 : 1));
            // §14/§20: originate(from∈watch)면 전 수신자 행, 수신이면 watch 수신자만.
            const isFrom = !!fromAddress && watch.has(fromAddress);
            recipients.forEach((rc, txIndex) => {
              if (!isFrom && !watch.has(rc.address)) return;
              txs.push({
                txHash: sig.signature,
                fromAddress,
                toAddress: rc.address,
                contractAddress,
                amount: rc.amount.toString(),
                blockNumber: sig.slot,
                txIndex,
                raw: sig,
              });
            });
          }
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
