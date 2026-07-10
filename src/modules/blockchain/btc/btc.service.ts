import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ASSET_REPOSITORY, AssetRepository } from '../asset.repository';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { ScanResult } from '../interfaces/scan.types';
import { getMaxDepositScanRange, getRawDecimal } from '../parameter-store';
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
  // Bitcoin Core 25+ 는 getblock verbosity 3(prevout 인라인) 지원 → true.
  private readonly cfg: UtxoAssetConfig = {
    symbol: 'btc',
    path: 'btc',
    prevoutInline: true,
  };
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('BtcService');
  /** 1회 스캔 블록 수. 노드+maxDepositScanRange 둘 다 있어야 스캔. 없으면 skip. */
  private maxDepositScanRange?: number;
  /** reorg 안전 마진(스캔 끝 = height-confirmationThreshold). 미설정 0. */
  private confirmationThreshold = 0;
  /** 원본 최소단위 자릿수(BTC=8, UTXO client 가 satoshi 정수로 반환). */
  private rawDecimal = 8;

  constructor(
    private readonly utxo: UtxoCommonService,
    @Inject(ASSET_REPOSITORY)
    private readonly assetRepository: AssetRepository,
  ) {}

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
    this.confirmationThreshold =
      await this.assetRepository.getConfirmThresholdById(this.getAssetId());
    this.rawDecimal = await getRawDecimal(this.cfg.path);
  }

  getAssetId(): number {
    return AssetId.BTC;
  }

  getRawDecimal(): number {
    return this.rawDecimal;
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
