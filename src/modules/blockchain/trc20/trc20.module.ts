import { Module } from '@nestjs/common';
import { AssetRepositoryModule } from '../asset-repository.module';
import { TrxModule } from '../trx/trx.module';
import { Trc20Service } from './trc20.service';

/** TRC20 은 기반 자산 TRX(TrxService)의 노드를 재사용하므로 TrxModule 을 import 한다. */
@Module({
  imports: [AssetRepositoryModule, TrxModule],
  providers: [Trc20Service],
  exports: [Trc20Service],
})
export class Trc20Module {}
