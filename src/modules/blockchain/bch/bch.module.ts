import { Module } from '@nestjs/common';
import { AssetRepositoryModule } from '../asset-repository.module';
import { UtxoCommonModule } from '../utxo-common/utxo-common.module';
import { BchService } from './bch.service';

@Module({
  imports: [AssetRepositoryModule, UtxoCommonModule],
  providers: [BchService],
  exports: [BchService],
})
export class BchModule {}
