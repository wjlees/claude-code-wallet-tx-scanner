import { Injectable, OnModuleInit } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
import { getMaxScanRange } from '../parameter-store';
import {
  UtxoAssetConfig,
  UtxoCommonService,
} from '../utxo-common/utxo-common.service';

/**
 * Bitcoin (BTC). UTXO 모델.
 *
 * 공용 UTXO 엔진(UtxoCommonService)을 주입받아 자기 설정(BITCOIN_RPC_URL)으로 위임한다.
 * 스캔 방식 자체는 utxo-common 에 있다(cursor=블록 높이, vout 수신 매칭).
 */
@Injectable()
export class BtcService implements AssetService, OnModuleInit {
  private readonly cfg: UtxoAssetConfig = {
    symbol: 'btc',
    path: 'btc',
  };
  readonly scanIntervalMs = 5000;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회(필수, 누락 시 throw). */
  private maxScanRange?: number;

  constructor(private readonly utxo: UtxoCommonService) {}

  /** 노드가 설정돼 있으면 scan range 를 ParamStore 로 조회(필수, 누락 시 throw). */
  async onModuleInit(): Promise<void> {
    if (await this.utxo.hasNode(this.cfg)) {
      this.maxScanRange = await getMaxScanRange(this.cfg.path);
    }
  }

  getAssetId(): number {
    return AssetId.BTC;
  }

  get symbol(): string {
    return this.cfg.symbol;
  }

  scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    return this.utxo.scanTransactions(
      this.cfg,
      addresses,
      cursor,
      this.maxScanRange!,
    );
  }

  getBalance(address: string): Promise<string> {
    return this.utxo.getBalance(this.cfg, address);
  }

  getBlockHeight(): Promise<number> {
    return this.utxo.getBlockHeight(this.cfg);
  }
}
