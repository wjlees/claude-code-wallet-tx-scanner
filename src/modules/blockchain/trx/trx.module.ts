import { Module } from '@nestjs/common';
import { TrxService } from './trx.service';

@Module({
  providers: [TrxService],
  exports: [TrxService],
})
export class TrxModule {}
