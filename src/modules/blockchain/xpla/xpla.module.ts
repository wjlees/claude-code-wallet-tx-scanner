import { Module } from '@nestjs/common';
import { AssetRepositoryModule } from '../asset-repository.module';
import { XplaService } from './xpla.service';

@Module({
  imports: [AssetRepositoryModule],
  providers: [XplaService],
  exports: [XplaService],
})
export class XplaModule {}
