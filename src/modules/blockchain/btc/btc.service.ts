import { Injectable } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
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
export class BtcService implements AssetService {
  private readonly cfg: UtxoAssetConfig = {
    symbol: 'btc',
    rpcEnvKey: 'BITCOIN_RPC_URL',
    batchSize: 50,
  };
  readonly scanIntervalMs = 5000;

  constructor(private readonly utxo: UtxoCommonService) {}

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
    return this.utxo.scanTransactions(this.cfg, addresses, cursor);
  }

  getBalance(address: string): Promise<string> {
    return this.utxo.getBalance(this.cfg, address);
  }

  getBlockHeight(): Promise<number> {
    return this.utxo.getBlockHeight(this.cfg);
  }
}
