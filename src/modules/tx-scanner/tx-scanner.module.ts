import { Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletModule } from '../wallet/wallet.module';
import { CURSOR_STORE, JsonCursorStore } from './cursor-store';
import { TxScannerService } from './tx-scanner.service';
import { TxRepository } from './tx.repository';

@Module({
  imports: [BlockchainModule, WalletModule],
  providers: [
    TxScannerService,
    TxRepository,
    // cursor 영속화 저장소(현재 JSON 파일 stub). CURSOR_STORE 토큰으로 주입.
    { provide: CURSOR_STORE, useClass: JsonCursorStore },
  ],
  exports: [TxScannerService],
})
export class TxScannerModule {}
