import { Module } from '@nestjs/common';
import { BtcService } from './btc.service';

@Module({
  providers: [BtcService],
  exports: [BtcService],
})
export class BtcModule {}
