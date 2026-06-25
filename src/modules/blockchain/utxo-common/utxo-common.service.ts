import { Injectable, Logger } from '@nestjs/common';
import { ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getParameter } from '../parameter-store';
import { UtxoRpcClient } from './utxo-rpc.client';

/** UTXO 자산 1개(BTC/BCH ...)의 설정. btc/bch 서비스가 자기 값으로 채워 넘긴다. */
export interface UtxoAssetConfig {
  /** 체인 심볼 (로그/식별용) */
  symbol: string;
  /** 노드 URL 을 담은 환경변수 키 (예: 'BITCOIN_RPC_URL') */
  rpcEnvKey: string;
  /** 한 번에 스캔할 블록 수 */
  batchSize: number;
}

/**
 * BTC/BCH 공용 UTXO 스캔 엔진 (bitcoind 계열 JSON-RPC).
 *
 * 자산별로 노드 URL 이 다르므로(BITCOIN_RPC_URL vs BCH_RPC_URL) **무상태 엔진**으로 두고,
 * 호출 시 자산 설정(UtxoAssetConfig)을 받아 동작한다. 노드 클라이언트는 env 키 기준으로
 * lazy 생성 후 캐싱한다. btc/bch 서비스가 이 엔진을 주입받아 자기 설정으로 위임 호출한다.
 */
@Injectable()
export class UtxoCommonService {
  private readonly logger = new Logger('UtxoCommonService');
  private readonly clients = new Map<string, UtxoRpcClient | undefined>();

  /** 파라미터 키 기준 클라이언트 lazy 생성/캐싱. 미설정이면 undefined(+1회 경고). */
  private async client(
    cfg: UtxoAssetConfig,
  ): Promise<UtxoRpcClient | undefined> {
    if (!this.clients.has(cfg.rpcEnvKey)) {
      const url = await getParameter(cfg.rpcEnvKey);
      this.clients.set(cfg.rpcEnvKey, url ? new UtxoRpcClient(url) : undefined);
    }
    const client = this.clients.get(cfg.rpcEnvKey);
    if (!client) {
      warnMissingNode(this.logger, cfg.rpcEnvKey);
    }
    return client;
  }

  /** cursor=마지막 스캔 블록 높이. 다음 블록부터 head 까지(batch 제한) vout 수신 매칭. */
  async scanTransactions(
    cfg: UtxoAssetConfig,
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const client = await this.client(cfg);
    if (!client) {
      return { txs: [], nextCursor: cursor };
    }
    const head = await client.getBlockCount();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + cfg.batchSize - 1, head);
    const txs = await client.scanRange(from, to, addresses);
    this.logger.log(
      `[${cfg.symbol}] scanned blocks ${from}~${to} (UTXO) → ${txs.length} tx`,
    );
    return { txs, nextCursor: String(to) };
  }

  async getBalance(cfg: UtxoAssetConfig, address: string): Promise<string> {
    // TODO(RPC): watch-only 지갑 잔고 또는 인덱서 사용. 현재는 노드 유무만 점검.
    if (!(await this.client(cfg))) return '0';
    this.logger.log(`[${cfg.symbol}] getBalance(${address})`);
    return '0';
  }

  async getBlockHeight(cfg: UtxoAssetConfig): Promise<number> {
    const client = await this.client(cfg);
    return client ? client.getBlockCount() : 0;
  }
}
