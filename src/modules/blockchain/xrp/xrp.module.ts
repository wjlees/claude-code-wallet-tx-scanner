import { Module } from '@nestjs/common';
import { XrpService } from './xrp.service';

@Module({
  providers: [XrpService],
  exports: [XrpService],
})
export class XrpModule {}
