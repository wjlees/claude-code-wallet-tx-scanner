import { Module } from '@nestjs/common';
import { AssetRepositoryModule } from '../asset-repository.module';
import { SuiService } from './sui.service';

@Module({
  imports: [AssetRepositoryModule],
  providers: [SuiService],
  exports: [SuiService],
})
export class SuiModule {}
