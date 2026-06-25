import { Module } from '@nestjs/common';
import { UtxoCommonModule } from '../utxo-common/utxo-common.module';
import { BchService } from './bch.service';

@Module({
  imports: [UtxoCommonModule],
  providers: [BchService],
  exports: [BchService],
})
export class BchModule {}
