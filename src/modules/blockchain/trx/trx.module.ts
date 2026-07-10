import { Module } from '@nestjs/common';
import { AssetRepositoryModule } from '../asset-repository.module';
import { TrxService } from './trx.service';

@Module({
  imports: [AssetRepositoryModule],
  providers: [TrxService],
  exports: [TrxService],
})
export class TrxModule {}
