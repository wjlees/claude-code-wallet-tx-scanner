import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BlockchainModule } from './modules/blockchain/blockchain.module';
import { TxScannerModule } from './modules/tx-scanner/tx-scanner.module';

@Module({
  imports: [
    ScheduleModule.forRoot(), // tx-scanner 워치독 @Cron 활성화
    BlockchainModule,
    TxScannerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
