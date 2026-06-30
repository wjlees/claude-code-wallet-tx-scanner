import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TronWeb } from 'tronweb';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getMaxScanRange, getNodeUrlByPath } from '../parameter-store';

const TRON_PATH = 'tron'; // path 는 tron (symbol 은 trx)

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface TrxState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  tronWeb?: TronWeb;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxScanRange?: number;
}

/**
 * Tron (TRX). 네이티브 코인.
 *
 * 노드: tronweb SDK (TRON_RPC_URL = fullHost). 핸들은 onModuleInit 에서 초기화.
 * 스캔: cursor=마지막 스캔 블록번호. EVM 과 유사하게 블록 범위를 훑어
 *       TransferContract 의 owner/to 가 대상 주소면 in/out 으로 수집한다.
 *
 * TRC20 토큰 서비스(trc20)는 같은 노드를 재사용하도록 getTronWeb() 를 노출한다.
 */
@Injectable()
export class TrxService implements AssetService, OnModuleInit {
  readonly symbol = 'trx';
  readonly scanIntervalMs = 3000;
  private readonly logger = new Logger('TrxService');
  private readonly state: TrxState = {};

  getAssetId(): number {
    return AssetId.TRX;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxScanRange(TRON_PATH);
    if (range === undefined) {
      this.logger.log(`no maxScanRange for "${TRON_PATH}" — scan skipped`);
      return;
    }
    this.state.maxScanRange = range;
    this.state.tronWeb = new TronWeb({ fullHost: url });
    this.logger.log(`tronWeb initialized (maxScanRange=${range})`);
  }

  /** 노드 URL 조회. ParamStore path(tron) 기준 async 조회. */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrlByPath(TRON_PATH);
  }

  /** 토큰 서비스(trc20)가 같은 노드를 재사용하도록 노출. */
  getTronWeb(): TronWeb | undefined {
    return this.state.tronWeb;
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { tronWeb } = this.state;
    if (!tronWeb) {
      warnMissingNode(this.logger, TRON_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const head = await this.getBlockHeight();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.state.maxScanRange! - 1, head);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const block = await tronWeb.trx.getBlock(n);
      for (const tx of (block as any).transactions ?? []) {
        const contract = tx.raw_data?.contract?.[0];
        if (!contract || contract.type !== 'TransferContract') continue;
        const v = contract.parameter?.value ?? {};
        const ownerAddr = v.owner_address
          ? tronWeb.address.fromHex(v.owner_address)
          : undefined;
        const toAddr = v.to_address
          ? tronWeb.address.fromHex(v.to_address)
          : undefined;
        if (toAddr && watch.has(toAddr)) {
          txs.push(this.toDetected(tx.txID, 'in', toAddr, ownerAddr, v.amount));
        }
        if (ownerAddr && watch.has(ownerAddr)) {
          txs.push(
            this.toDetected(tx.txID, 'out', ownerAddr, toAddr, v.amount),
          );
        }
      }
    }

    this.logger.log(`scanned blocks ${from}~${to} (TRX) → ${txs.length} tx`);
    return { txs, nextCursor: String(to) };
  }

  private toDetected(
    txID: string,
    direction: 'in' | 'out',
    address: string,
    counterparty?: string,
    amount?: number,
  ): DetectedTx {
    return {
      txHash: txID,
      direction,
      address,
      counterparty,
      amount: amount !== undefined ? String(amount) : undefined,
      raw: { txID },
    };
  }

  async getBalance(address: string): Promise<string> {
    const { tronWeb } = this.state;
    if (!tronWeb) {
      warnMissingNode(this.logger, TRON_PATH);
      return '0';
    }
    const sun = await tronWeb.trx.getBalance(address);
    return String(sun);
  }

  async getBlockHeight(): Promise<number> {
    const { tronWeb } = this.state;
    if (!tronWeb) {
      warnMissingNode(this.logger, TRON_PATH);
      return 0;
    }
    const block = await tronWeb.trx.getCurrentBlock();
    return Number((block as any).block_header?.raw_data?.number ?? 0);
  }
}
