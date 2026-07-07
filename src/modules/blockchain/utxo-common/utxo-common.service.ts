import { Injectable, Logger } from '@nestjs/common';
import { ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getNodeUrlByPath } from '../parameter-store';
import { UtxoRpcClient } from './utxo-rpc.client';

/** UTXO 자산 1개(BTC/BCH ...)의 설정. btc/bch 서비스가 자기 값으로 채워 넘긴다. */
export interface UtxoAssetConfig {
  /** 체인 심볼 (로그/식별용) */
  symbol: string;
  /** ParamStore path (노드URL·maxDepositScanRange 조회, 예: 'btc' / 'bch') */
  path: string;
  /**
   * 노드가 `getblock` verbosity 3(vin prevout 인라인)을 지원하는지.
   * true=한 번의 블록 조회로 vin 값·주소까지(추가 콜 0). false=vin 마다 getrawtransaction(fallback).
   * (Bitcoin Core 25+ = true. BCH/XEC 등 미지원 노드 = false. EVM usingBatchRequest 와 같은 개념.)
   */
  prevoutInline: boolean;
}

/**
 * BTC/BCH 공용 UTXO 스캔 엔진 (bitcoind 계열 JSON-RPC).
 *
 * 자산별로 노드 URL 이 다르므로 **무상태 엔진**으로 두고, 호출 시 자산 설정(UtxoAssetConfig)을
 * 받아 동작한다. 노드 클라이언트는 path 기준으로 lazy 생성 후 캐싱한다.
 * btc/bch 서비스가 이 엔진을 주입받아 자기 설정으로 위임 호출한다.
 */
@Injectable()
export class UtxoCommonService {
  private readonly logger = new Logger('UtxoCommonService');
  private readonly clients = new Map<string, UtxoRpcClient | undefined>();

  /** path 기준 클라이언트 lazy 생성/캐싱. 미설정이면 undefined(+1회 경고). */
  private async client(
    cfg: UtxoAssetConfig,
  ): Promise<UtxoRpcClient | undefined> {
    if (!this.clients.has(cfg.path)) {
      const url = await getNodeUrlByPath(cfg.path);
      this.clients.set(cfg.path, url ? new UtxoRpcClient(url) : undefined);
    }
    const client = this.clients.get(cfg.path);
    if (!client) {
      warnMissingNode(this.logger, cfg.path);
    }
    return client;
  }

  /** 노드가 설정돼 있는지(btc/bch onModuleInit 에서 range 조회 여부 판단용). */
  async hasNode(cfg: UtxoAssetConfig): Promise<boolean> {
    return (await this.client(cfg)) !== undefined;
  }

  /**
   * cursor=마지막 스캔 블록 높이. 다음 블록부터 head 까지(maxDepositScanRange 제한) vout 수신 매칭.
   * maxDepositScanRange 는 btc/bch 가 onModuleInit 에서 조회해 넘긴다.
   */
  async scanTransactions(
    cfg: UtxoAssetConfig,
    addresses: string[],
    cursor: string | null,
    maxDepositScanRange: number,
    confirmationThreshold = 0,
  ): Promise<ScanResult> {
    const client = await this.client(cfg);
    if (!client) {
      return { txs: [], nextCursor: cursor };
    }
    const head = await client.getBlockCount();
    // confirmationThreshold 만큼 뒤처진 높이까지만(reorg 제외). UTXO 는 블록 포함=유효라 status 필터 불필요.
    const safeHead = Math.max(head - confirmationThreshold, 0);
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) {
      return { txs: [], nextCursor: String(safeHead) };
    }
    const to = Math.min(from + maxDepositScanRange - 1, safeHead);
    const txs = await client.scanRange(from, to, addresses, cfg.prevoutInline);
    this.logger.log(
      `[${cfg.symbol}] scanned blocks ${from}~${to} (UTXO, safeHead=${safeHead}) → ${txs.length} tx`,
    );
    return { txs, nextCursor: String(to) };
  }

  async getBalance(cfg: UtxoAssetConfig, address: string): Promise<string> {
    // NOTE: UTXO 잔고는 노드 RPC 로 어려움(주소 인덱스 없음) → **unspents 테이블(§17) SUM(usable=1)**
    //   이 정답(tx-scanner 측 UnspentsRepository.sumUsable). blockchain 층에선 미제공(rule 1).
    if (!(await this.client(cfg))) return '0';
    this.logger.log(
      `[${cfg.symbol}] getBalance(${address}) — unspents 테이블에서 조회할 것(§17)`,
    );
    return '0';
  }

  /**
   * 백필: 주소들의 살아있는 UTXO 전부를 UTXO set 스캔(`scantxoutset`)으로 조회.
   * 이미 잔고 있는 주소를 감시 목록에 추가할 때 unspents 초기 적재용(일회성 프로비저닝, §17).
   * 노드 미지원 시 throw — 인덱서 등 대체 필요.
   */
  async listLiveUtxos(cfg: UtxoAssetConfig, addresses: string[]) {
    const client = await this.client(cfg);
    if (!client) return [];
    return client.scanTxOutset(addresses);
  }

  async getBlockHeight(cfg: UtxoAssetConfig): Promise<number> {
    const client = await this.client(cfg);
    return client ? client.getBlockCount() : 0;
  }
}
