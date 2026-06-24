import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { EthereumCommonModule } from './ethereum-common/ethereum-common.module';
import { SolModule } from './sol/sol.module';
import { XlmModule } from './xlm/xlm.module';
import { BtcModule } from './btc/btc.module';
import { BchModule } from './bch/bch.module';
import { EthereumTokenCommonModule } from './ethereum-token-common/ethereum-token-common.module';
import { SplModule } from './spl/spl.module';

@Module({
  imports: [
    // AssetService 구현 모듈
    EthereumCommonModule,
    SolModule,
    XlmModule,
    BtcModule,
    BchModule,
    // TokenService 구현 모듈
    EthereumTokenCommonModule,
    SplModule,
  ],
  providers: [BlockchainService],
  exports: [BlockchainService],
})
export class BlockchainModule {}
