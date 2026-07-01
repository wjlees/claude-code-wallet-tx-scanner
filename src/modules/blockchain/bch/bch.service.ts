import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
import {
  getConfirmationThreshold,
  getMaxDepositScanRange,
} from '../parameter-store';
import {
  UtxoAssetConfig,
  UtxoCommonService,
} from '../utxo-common/utxo-common.service';

/**
 * Bitcoin Cash (BCH). BTC 와 동일한 UTXO 모델 (Bitcoin Cash Node JSON-RPC).
 *
 * 공용 UTXO 엔진(UtxoCommonService)을 주입받아 자기 설정(path=bch)으로 위임한다.
 */
@Injectable()
export class BchService implements AssetService, OnModuleInit {
  private readonly cfg: UtxoAssetConfig = { symbol: 'bch', path: 'bch' };
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('BchService');
  /** 1회 스캔 블록 수. 노드+maxDepositScanRange 둘 다 있어야 스캔. 없으면 skip. */
  private maxDepositScanRange?: number;
  /** reorg 안전 마진(스캔 끝 = height-confirmationThreshold). 미설정 0. */
  private confirmationThreshold = 0;

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
    this.confirmationThreshold = await getConfirmationThreshold(this.cfg.path);
  }

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
    if (this.maxDepositScanRange === undefined) {
      return Promise.resolve({ txs: [], nextCursor: cursor });
    }
    return this.utxo.scanTransactions(
      this.cfg,
      addresses,
      cursor,
      this.maxDepositScanRange,
      this.confirmationThreshold,
    );
  }

  getBalance(address: string): Promise<string> {
    return this.utxo.getBalance(this.cfg, address);
  }

  getBlockHeight(): Promise<number> {
    return this.utxo.getBlockHeight(this.cfg);
  }
}
