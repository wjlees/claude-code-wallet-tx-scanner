import { Module } from '@nestjs/common';
import { ASSET_REPOSITORY, StubAssetRepository } from './asset.repository';

/**
 * main.asset 메타 읽기(AssetRepository, §19) provider.
 * confirm_threshold 를 쓰는 체인 모듈들이 import 한다.
 * (monorepo: 각 모듈에 TypeOrmModule.forFeature([Asset]) + AssetRepository provider)
 */
@Module({
  providers: [{ provide: ASSET_REPOSITORY, useClass: StubAssetRepository }],
  exports: [ASSET_REPOSITORY],
})
export class AssetRepositoryModule {}
