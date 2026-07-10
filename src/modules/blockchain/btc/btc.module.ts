import { Module } from '@nestjs/common';
import { AssetRepositoryModule } from '../asset-repository.module';
import { UtxoCommonModule } from '../utxo-common/utxo-common.module';
import { BtcService } from './btc.service';

@Module({
  imports: [AssetRepositoryModule, UtxoCommonModule],
  providers: [BtcService],
  exports: [BtcService],
})
export class BtcModule {}
