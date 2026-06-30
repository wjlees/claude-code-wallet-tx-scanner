import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BlockchainModule } from './modules/blockchain/blockchain.module';
import { TxScannerModule } from './modules/tx-scanner/tx-scanner.module';

@Module({
  imports: [
    // 워치독은 @Cron(ScheduleModule) 대신 TxScannerService 의 setInterval 로 돈다.
    BlockchainModule,
    TxScannerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
