import { Module } from '@nestjs/common';
import { BchService } from './bch.service';

@Module({
  providers: [BchService],
  exports: [BchService],
})
export class BchModule {}
