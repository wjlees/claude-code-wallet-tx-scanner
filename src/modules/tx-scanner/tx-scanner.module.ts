import { Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletModule } from '../wallet/wallet.module';
import { ASSET_REPOSITORY, StubAssetRepository } from './asset.repository';
import {
  DETECTED_TRANSACTIONS_REPOSITORY,
  StubDetectedTransactionsRepository,
} from './detected-transactions.repository';
import { TxScannerService } from './tx-scanner.service';
import { TxRepository } from './tx.repository';

@Module({
  imports: [BlockchainModule, WalletModule],
  providers: [
    TxScannerService,
    TxRepository,
    // 스캔 진행 지점(asset.start_block_number) 저장소(현재 in-memory stub). 실제 DB 로 교체 시 교체.
    { provide: ASSET_REPOSITORY, useClass: StubAssetRepository },
    // 감지 tx 저장소(현재 콘솔 stub). 실제 DB 로 교체 시 이 provider 만 바꾼다.
    {
      provide: DETECTED_TRANSACTIONS_REPOSITORY,
      useClass: StubDetectedTransactionsRepository,
    },
  ],
  exports: [TxScannerService],
})
export class TxScannerModule {}
