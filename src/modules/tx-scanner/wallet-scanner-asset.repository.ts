import { Injectable, Logger } from '@nestjs/common';

/**
 * `wallet_scanner_asset` 테이블 1행 (스캔 진행 지점). main.asset(자산 메타) 과 **분리**.
 * monorepo: `wallet.wallet_scanner_asset` (WalletScannerAssetRepository).
 */
export interface WalletScannerAsset {
  /** assetId (FK → main.asset.id) */
  assetId: number;
  /** start_block_number — 다음 스캔 시작 지점(opaque). null 이면 처음부터(head). */
  startBlockNumber: string | null;
}

/**
 * 스캔 진행 지점 저장소. `wallet_scanner_asset.start_block_number` 를 읽고/갱신한다.
 *
 * NOTE: 실제 구현(`wallet_scanner_asset` 테이블)은 monorepo/DB 전용. prototype 은 stub.
 *   실제 DB 로 교체 시 이 인터페이스만 유지하면 호출부(ScanRunner)는 안 바뀐다.
 */
export interface WalletScannerAssetRepository {
  getStartBlockNumber(assetId: number): Promise<string | null>;
  updateStartBlockNumber(
    assetId: number,
    startBlockNumber: string | null,
  ): Promise<void>;
}

export const WALLET_SCANNER_ASSET_REPOSITORY = 'WalletScannerAssetRepository';

/** in-memory stub (DB 미연결). 실제로는 wallet_scanner_asset SELECT/UPDATE. */
@Injectable()
export class StubWalletScannerAssetRepository implements WalletScannerAssetRepository {
  private readonly logger = new Logger('WalletScannerAssetRepository');
  private readonly rows = new Map<number, WalletScannerAsset>();

  async getStartBlockNumber(assetId: number): Promise<string | null> {
    const sbn = this.rows.get(assetId)?.startBlockNumber ?? null;
    this.logger.log(`getStartBlockNumber(asset#${assetId}) → ${sbn}`);
    return sbn;
  }

  async updateStartBlockNumber(
    assetId: number,
    startBlockNumber: string | null,
  ): Promise<void> {
    // TODO(DB): UPSERT wallet_scanner_asset SET start_block_number = ? WHERE asset_id = ?
    this.rows.set(assetId, { assetId, startBlockNumber });
    this.logger.log(
      `updateStartBlockNumber(asset#${assetId}) ← ${startBlockNumber}`,
    );
  }
}
