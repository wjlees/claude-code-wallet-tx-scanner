import { Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletModule } from '../wallet/wallet.module';
import {
  DETECTED_TRANSACTIONS_REPOSITORY,
  StubDetectedTransactionsRepository,
} from './detected-transactions.repository';
import {
  WALLET_SCANNER_ASSET_REPOSITORY,
  StubWalletScannerAssetRepository,
} from './wallet-scanner-asset.repository';
import { TxScannerService } from './tx-scanner.service';

@Module({
  imports: [BlockchainModule, WalletModule],
  providers: [
    TxScannerService,
    // 스캔 진행 지점(wallet_scanner_asset.start_block_number) 저장소(현재 in-memory stub).
    {
      provide: WALLET_SCANNER_ASSET_REPOSITORY,
      useClass: StubWalletScannerAssetRepository,
    },
    // 감지 tx 저장소(현재 콘솔 stub). 실제 DB 로 교체 시 이 provider 만 바꾼다.
    {
      provide: DETECTED_TRANSACTIONS_REPOSITORY,
      useClass: StubDetectedTransactionsRepository,
    },
  ],
  exports: [TxScannerService],
})
export class TxScannerModule {}
