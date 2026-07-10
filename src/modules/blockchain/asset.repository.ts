import { Injectable, Logger } from '@nestjs/common';
import { AssetId } from './constants';

/**
 * `main.asset` 자산 메타 읽기 저장소 — 현재는 **confirm_threshold** 조회용(§19).
 *
 * confirmationThreshold 는 ParamStore 가 아니라 **main.asset.confirm_threshold** 에서 읽는다
 * (monorepo: TypeORM `AssetRepository.getConfirmThresholdById(assetId)`; deposit 은
 * `getByIds` 응답의 confirmThreshold 사용). prototype 은 stub.
 *
 * NOTE: rule 1(blockchain 은 DB 미의존)의 예외 — tx 저장/진행지점 영속화는 여전히 tx-scanner
 *   책임이지만, **자산 메타 read 는 blockchain 서비스가 이 port 로 조회**한다(init 시 1회 로드).
 */
export interface AssetRepository {
  /** main.asset.confirm_threshold. 행/값 없으면 0(캡 없음). */
  getConfirmThresholdById(assetId: number): Promise<number>;
}

export const ASSET_REPOSITORY = 'AssetRepository';

/** in-memory stub (DB 미연결). 실제로는 main.asset SELECT confirm_threshold. */
@Injectable()
export class StubAssetRepository implements AssetRepository {
  private readonly logger = new Logger('AssetRepository');

  // TODO(DB): main.asset 로 교체. 값은 과거 ParamStore 권장값을 stub 기본으로.
  private readonly confirmThresholds: Record<number, number> = {
    [AssetId.KONET]: 12,
    [AssetId.KLAY]: 12,
    [AssetId.CROSS]: 12,
    [AssetId.BASE]: 12,
    [AssetId.SOL]: 32, // 참고용 — SOL/SPL 은 numeric cap 대신 finalized commitment(§12)
    [AssetId.XLM]: 1,
    [AssetId.BTC]: 3,
    [AssetId.BCH]: 6,
    [AssetId.TRX]: 20,
    [AssetId.XRP]: 0,
    [AssetId.XPLA]: 1,
    [AssetId.SUI]: 0, // checkpoint 최종
  };

  async getConfirmThresholdById(assetId: number): Promise<number> {
    const v = this.confirmThresholds[assetId] ?? 0;
    this.logger.log(`getConfirmThresholdById(asset#${assetId}) → ${v} (stub)`);
    return v;
  }
}
