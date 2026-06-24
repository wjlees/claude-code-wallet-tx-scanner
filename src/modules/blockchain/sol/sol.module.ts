import { Module } from '@nestjs/common';
import { SolService } from './sol.service';

@Module({
  providers: [SolService],
  exports: [SolService],
})
export class SolModule {}
