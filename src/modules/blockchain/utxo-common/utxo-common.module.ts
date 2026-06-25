import { Module } from '@nestjs/common';
import { UtxoCommonService } from './utxo-common.service';

/**
 * BTC/BCH 공용 UTXO 스캔 엔진을 제공한다.
 * btc/bch 모듈이 이 모듈을 import 하고 `UtxoCommonService` 를 주입받아 재사용한다.
 */
@Module({
  providers: [UtxoCommonService],
  exports: [UtxoCommonService],
})
export class UtxoCommonModule {}
