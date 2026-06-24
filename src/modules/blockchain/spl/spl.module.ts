import { Module } from '@nestjs/common';
import { SplService } from './spl.service';

@Module({
  providers: [SplService],
  exports: [SplService],
})
export class SplModule {}
