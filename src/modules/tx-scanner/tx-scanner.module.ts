import { Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletModule } from '../wallet/wallet.module';
import { TxScannerService } from './tx-scanner.service';
import { TxRepository } from './tx.repository';

@Module({
  imports: [BlockchainModule, WalletModule],
  providers: [TxScannerService, TxRepository],
  exports: [TxScannerService],
})
export class TxScannerModule {}
