import { Injectable, Logger } from '@nestjs/common';

/** scale 최대 자릿수 — 더 크더라도 8 로 고정. */
export const MAX_SCALE = 8;

/**
 * `asset` 테이블 1행. (id = assetId)
 * start_block_number 가 스캔 진행 지점(= 과거의 cursor)이다.
 */
export interface Asset {
  /** assetId (PK) */
  id: number;
  /** iso_alpha3 (= symbol) */
  isoAlpha3: string;
  /** full_name (한국어 이름) */
  fullName: string;
  /** scale (소수점 자릿수, 최대 8) */
  scale: number;
  /** start_block_number — 다음 스캔 시작 지점(opaque). null 이면 처음부터(head). */
  startBlockNumber: string | null;
  /** confirm_threshold — 컨펌 인정 블록 수 */
  confirmThreshold: number;
}

/**
 * asset 영속화 저장소. 스캔 진행 지점(start_block_number)을 읽고/갱신한다.
 *
 * NOTE: 실제 구현(`asset` 테이블)은 monorepo/DB 전용. prototype 은 인터페이스 + stub 만 둔다.
 *   실제 DB 로 교체 시 이 인터페이스만 유지하면 호출부(ScanRunner)는 안 바뀐다.
 */
export interface AssetRepository {
  /** assetId 의 start_block_number 를 읽는다(없으면 null → 처음부터). */
  getStartBlockNumber(assetId: number): Promise<string | null>;
  /** assetId 의 start_block_number 를 갱신한다(스캔 1사이클 후). */
  updateStartBlockNumber(
    assetId: number,
    startBlockNumber: string | null,
  ): Promise<void>;
}

export const ASSET_REPOSITORY = 'AssetRepository';

/** scale 을 0~8 로 정규화(8 초과는 8). */
export function normalizeScale(scale: number): number {
  return Math.min(Math.max(0, Math.trunc(scale)), MAX_SCALE);
}

/** in-memory stub (DB 미연결). 실제로는 asset 테이블 SELECT/UPDATE. */
@Injectable()
export class StubAssetRepository implements AssetRepository {
  private readonly logger = new Logger('AssetRepository');

  // TODO(DB): 실제 asset 테이블. 현재는 in-memory stub (예시 시드 일부 + 나머지는 lazy upsert).
  private readonly rows = new Map<number, Asset>([
    [1, this.row(1, 'ETH', '이더리움', 8, 12)],
    [7, this.row(7, 'BTC', '비트코인', 8, 3)],
    [10, this.row(10, 'XRP', '리플', 6, 4)],
  ]);

  private row(
    id: number,
    isoAlpha3: string,
    fullName: string,
    scale: number,
    confirmThreshold: number,
  ): Asset {
    return {
      id,
      isoAlpha3,
      fullName,
      scale: normalizeScale(scale),
      startBlockNumber: null,
      confirmThreshold,
    };
  }

  async getStartBlockNumber(assetId: number): Promise<string | null> {
    const sbn = this.rows.get(assetId)?.startBlockNumber ?? null;
    this.logger.log(`getStartBlockNumber(asset#${assetId}) → ${sbn}`);
    return sbn;
  }

  async updateStartBlockNumber(
    assetId: number,
    startBlockNumber: string | null,
  ): Promise<void> {
    // TODO(DB): UPDATE asset SET start_block_number = ? WHERE id = ?
    const existing = this.rows.get(assetId);
    if (existing) {
      existing.startBlockNumber = startBlockNumber;
    } else {
      this.rows.set(assetId, {
        id: assetId,
        isoAlpha3: '',
        fullName: '',
        scale: MAX_SCALE,
        startBlockNumber,
        confirmThreshold: 0,
      });
    }
    this.logger.log(
      `updateStartBlockNumber(asset#${assetId}) ← ${startBlockNumber}`,
    );
  }
}
