import { Module } from '@nestjs/common';
import { XlmService } from './xlm.service';

@Module({
  providers: [XlmService],
  exports: [XlmService],
})
export class XlmModule {}
