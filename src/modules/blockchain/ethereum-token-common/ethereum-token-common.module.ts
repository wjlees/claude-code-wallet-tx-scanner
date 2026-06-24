import { Module, Provider } from '@nestjs/common';
import {
  ETHEREUM_COMMON_SERVICES,
  EthereumCommonModule,
} from '../ethereum-common/ethereum-common.module';
import { EthereumCommonService } from '../ethereum-common/ethereum-common.service';
import { ethereumBasedTokenTypeIds } from './ethereum-based-tokens';
import { EthereumTokenCommonService } from './ethereum-token-common.service';

/** 모든 EVM 토큰 서비스를 배열로 받는 주입 토큰 */
export const ETHEREUM_TOKEN_COMMON_SERVICES = 'EthereumTokenCommonServices';

/** tokenTypeId 별 개별 서비스 토큰 (`EthereumTokenCommonService_1001` 등) */
export const ethereumTokenCommonServiceToken = (tokenTypeId: number) =>
  `EthereumTokenCommonService_${tokenTypeId}`;

const ethereumTokenCommonServiceTokens = ethereumBasedTokenTypeIds.map(
  ethereumTokenCommonServiceToken,
);

// tokenTypeId 당 1개씩 개별 provider 로 등록. 기반 EVM 자산 서비스 배열을 주입받아 재사용.
const ethereumTokenCommonProviders: Provider[] = ethereumBasedTokenTypeIds.map(
  (tokenTypeId) => ({
    provide: ethereumTokenCommonServiceToken(tokenTypeId),
    useFactory: (ethereumCommonServices: EthereumCommonService[]) =>
      new EthereumTokenCommonService(tokenTypeId, ethereumCommonServices),
    inject: [ETHEREUM_COMMON_SERVICES],
    // NOTE: 실제 구현에선 ParamStore / TokenRepository / MetadataRepository 등도 inject.
  }),
);

@Module({
  imports: [EthereumCommonModule],
  providers: [
    ...ethereumTokenCommonProviders,
    {
      provide: ETHEREUM_TOKEN_COMMON_SERVICES,
      useFactory: (...services: EthereumTokenCommonService[]) => services,
      inject: ethereumTokenCommonServiceTokens,
    },
  ],
  exports: [ETHEREUM_TOKEN_COMMON_SERVICES],
})
export class EthereumTokenCommonModule {}
