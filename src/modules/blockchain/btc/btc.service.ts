import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
import { getMaxDepositScanRange } from '../parameter-store';
import {
  UtxoAssetConfig,
  UtxoCommonService,
} from '../utxo-common/utxo-common.service';

/**
 * Bitcoin (BTC). UTXO 모델.
 *
 * 공용 UTXO 엔진(UtxoCommonService)을 주입받아 자기 설정(path=btc)으로 위임한다.
 * 스캔 방식 자체는 utxo-common 에 있다(cursor=블록 높이, vout 수신 매칭).
 */
@Injectable()
export class BtcService implements AssetService, OnModuleInit {
  private readonly cfg: UtxoAssetConfig = { symbol: 'btc', path: 'btc' };
  readonly scanIntervalMs = 5000;
  private readonly logger = new Logger('BtcService');
  /** 1회 스캔 블록 수. 노드+maxDepositScanRange 둘 다 있어야 스캔. 없으면 skip. */
  private maxDepositScanRange?: number;

  constructor(private readonly utxo: UtxoCommonService) {}

  /** 노드가 있을 때 scan range 조회. 없으면 log+skip(throw 안 함). */
  async onModuleInit(): Promise<void> {
    if (!(await this.utxo.hasNode(this.cfg))) {
      return;
    }
    const range = await getMaxDepositScanRange(this.cfg.path);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${this.cfg.path}" — scan skipped`,
      );
      return;
    }
    this.maxDepositScanRange = range;
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
    if (this.maxDepositScanRange === undefined) {
      return Promise.resolve({ txs: [], nextCursor: cursor });
    }
    return this.utxo.scanTransactions(
      this.cfg,
      addresses,
      cursor,
      this.maxDepositScanRange,
    );
  }

  getBalance(address: string): Promise<string> {
    return this.utxo.getBalance(this.cfg, address);
  }

  getBlockHeight(): Promise<number> {
    return this.utxo.getBlockHeight(this.cfg);
  }
}
