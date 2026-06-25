import { Module } from '@nestjs/common';
import { XplaService } from './xpla.service';

@Module({
  providers: [XplaService],
  exports: [XplaService],
})
export class XplaModule {}
