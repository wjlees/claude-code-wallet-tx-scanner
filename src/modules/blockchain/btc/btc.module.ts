import { Module } from '@nestjs/common';
import { UtxoCommonModule } from '../utxo-common/utxo-common.module';
import { BtcService } from './btc.service';

@Module({
  imports: [UtxoCommonModule],
  providers: [BtcService],
  exports: [BtcService],
})
export class BtcModule {}
