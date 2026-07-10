import { Module, Provider } from '@nestjs/common';
import { AssetRepositoryModule } from '../asset-repository.module';
import { ASSET_REPOSITORY, AssetRepository } from '../asset.repository';
import { ethereumBasedAssetIds } from './ethereum-based-assets';
import { EthereumCommonService } from './ethereum-common.service';

/** 모든 EVM 자산 서비스를 배열로 받는 주입 토큰 */
export const ETHEREUM_COMMON_SERVICES = 'EthereumCommonServices';

/** assetId 별 개별 서비스 토큰 (`EthereumCommonService_1` 등) */
export const ethereumCommonServiceToken = (assetId: number) =>
  `EthereumCommonService_${assetId}`;

const ethereumCommonServiceTokens = ethereumBasedAssetIds.map(
  ethereumCommonServiceToken,
);

// assetId 당 1개씩 개별 provider 로 등록 → Nest 가 각 인스턴스의 lifecycle 을 자동 관리.
const ethereumCommonProviders: Provider[] = ethereumBasedAssetIds.map(
  (assetId) => ({
    provide: ethereumCommonServiceToken(assetId),
    useFactory: (assetRepository: AssetRepository) =>
      new EthereumCommonService(assetId, assetRepository),
    inject: [ASSET_REPOSITORY],
  }),
);

@Module({
  imports: [AssetRepositoryModule],
  providers: [
    ...ethereumCommonProviders,
    // 위 개별 인스턴스들을 배열로 묶어 노출 (사용처는 이것만 주입).
    {
      provide: ETHEREUM_COMMON_SERVICES,
      useFactory: (...services: EthereumCommonService[]) => services,
      inject: ethereumCommonServiceTokens,
    },
  ],
  exports: [ETHEREUM_COMMON_SERVICES],
})
export class EthereumCommonModule {}
