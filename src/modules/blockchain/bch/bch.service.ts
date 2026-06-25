import { Injectable } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
import {
  UtxoAssetConfig,
  UtxoCommonService,
} from '../utxo-common/utxo-common.service';

/**
 * Bitcoin Cash (BCH). BTC 와 동일한 UTXO 모델 (Bitcoin Cash Node JSON-RPC).
 *
 * 공용 UTXO 엔진(UtxoCommonService)을 주입받아 자기 설정(BCH_RPC_URL)으로 위임한다.
 */
@Injectable()
export class BchService implements AssetService {
  private readonly cfg: UtxoAssetConfig = {
    symbol: 'bch',
    rpcEnvKey: 'BCH_RPC_URL',
    batchSize: 50,
  };
  readonly scanIntervalMs = 5000;

  constructor(private readonly utxo: UtxoCommonService) {}

  getAssetId(): number {
    return AssetId.BCH;
  }

  get symbol(): string {
    return this.cfg.symbol;
  }

  scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    return this.utxo.scanTransactions(this.cfg, addresses, cursor);
  }

  getBalance(address: string): Promise<string> {
    return this.utxo.getBalance(this.cfg, address);
  }

  getBlockHeight(): Promise<number> {
    return this.utxo.getBlockHeight(this.cfg);
  }
}
