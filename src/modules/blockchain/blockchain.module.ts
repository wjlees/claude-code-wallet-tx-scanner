import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { EthereumCommonModule } from './ethereum-common/ethereum-common.module';
import { SolModule } from './sol/sol.module';
import { XlmModule } from './xlm/xlm.module';
import { BtcModule } from './btc/btc.module';
import { BchModule } from './bch/bch.module';
import { TrxModule } from './trx/trx.module';
import { XrpModule } from './xrp/xrp.module';
import { XplaModule } from './xpla/xpla.module';
import { SuiModule } from './sui/sui.module';
import { EthereumTokenCommonModule } from './ethereum-token-common/ethereum-token-common.module';
import { SplModule } from './spl/spl.module';
import { Trc20Module } from './trc20/trc20.module';

@Module({
  imports: [
    // AssetService 구현 모듈
    EthereumCommonModule,
    SolModule,
    XlmModule,
    BtcModule,
    BchModule,
    TrxModule,
    XrpModule,
    XplaModule,
    SuiModule,
    // TokenService 구현 모듈
    EthereumTokenCommonModule,
    SplModule,
    Trc20Module,
  ],
  providers: [BlockchainService],
  exports: [BlockchainService],
})
export class BlockchainModule {}
