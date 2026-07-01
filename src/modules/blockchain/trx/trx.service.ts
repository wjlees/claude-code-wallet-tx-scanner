import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TronWeb } from 'tronweb';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getConfirmationThreshold,
  getMaxDepositScanRange,
  getNodeUrlByPath,
  getRawDecimal,
} from '../parameter-store';

const TRON_PATH = 'tron'; // path 는 tron (symbol 은 trx)

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface TrxState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  tronWeb?: TronWeb;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** reorg 안전 마진(스캔 끝 = head-confirmationThreshold). 미설정 0. */
  confirmationThreshold?: number;
  /** 원본 최소단위 자릿수(sun=6). 사토시 환산용. */
  rawDecimal?: number;
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
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('TrxService');
  private readonly state: TrxState = {};

  getAssetId(): number {
    return AssetId.TRX;
  }

  getRawDecimal(): number {
    return this.state.rawDecimal ?? 8;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxDepositScanRange(TRON_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${TRON_PATH}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    this.state.confirmationThreshold =
      await getConfirmationThreshold(TRON_PATH);
    this.state.rawDecimal = await getRawDecimal(TRON_PATH);
    this.state.tronWeb = new TronWeb({ fullHost: url });
    this.logger.log(`tronWeb initialized (maxDepositScanRange=${range})`);
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
    // confirmationThreshold 만큼 뒤처진 지점까지만(reorg 제외).
    const safeHead = Math.max(
      head - (this.state.confirmationThreshold ?? 0),
      0,
    );
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) {
      return { txs: [], nextCursor: String(safeHead) };
    }
    const to = Math.min(from + this.state.maxDepositScanRange! - 1, safeHead);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const block = await tronWeb.trx.getBlock(n);
      for (const tx of (block as any).transactions ?? []) {
        const contract = tx.raw_data?.contract?.[0];
        if (!contract) continue;
        const v = contract.parameter?.value ?? {};
        const status = tx.ret?.[0]?.contractRet === 'SUCCESS' ? 1 : 0;
        const owner = v.owner_address
          ? tronWeb.address.fromHex(v.owner_address)
          : undefined;
        // native TRX 값 이동은 TransferContract 만. 그 외(TriggerSmartContract=TRC20 등)는 native amount=0.
        const isNative = contract.type === 'TransferContract';
        const toAddress =
          isNative && v.to_address
            ? tronWeb.address.fromHex(v.to_address)
            : undefined;
        const value = isNative ? BigInt(v.amount ?? 0) : 0n;

        const isFrom = !!owner && watch.has(owner);
        const isTo = !!toAddress && watch.has(toAddress);
        if (!isFrom && !isTo) continue;
        if (!isFrom && !(value > 0n)) continue; // 수신인데 native 0금액 → skip
        if (!isFrom && status !== 1) continue; // 실패 수신 무의미

        // §14: 우리가 originate 한 tx(owner∈watch)면 성공/실패·contract type 무관 native fee 행.
        //   TRC20 전송(TriggerSmartContract)도 여기서 native TRX fee 행이 된다(토큰 행은 trc20 이 별도).
        //   fee 는 getTransactionInfo 로 조회(추가 호출, sun). 우리가 낸 것만.
        let feeAmount: string | undefined;
        if (isFrom) {
          const info: any = await tronWeb.trx.getTransactionInfo(tx.txID);
          feeAmount = info?.fee != null ? String(info.fee) : undefined;
        }
        txs.push({
          txHash: tx.txID,
          fromAddress: owner,
          toAddress,
          amount: (status === 1 ? value : 0n).toString(),
          feeAmount,
          status,
          blockNumber: n,
          raw: { txID: tx.txID },
        });
      }
    }

    this.logger.log(`scanned blocks ${from}~${to} (TRX) → ${txs.length} tx`);
    return { txs, nextCursor: String(to) };
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
