import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AssetService } from './interfaces/asset.interface';
import { TokenService } from './interfaces/token.interface';
import { ETHEREUM_COMMON_SERVICES } from './ethereum-common/ethereum-common.module';
import { EthereumCommonService } from './ethereum-common/ethereum-common.service';
import { SolService } from './sol/sol.service';
import { XlmService } from './xlm/xlm.service';
import { BtcService } from './btc/btc.service';
import { BchService } from './bch/bch.service';
import { TrxService } from './trx/trx.service';
import { XrpService } from './xrp/xrp.service';
import { XplaService } from './xpla/xpla.service';
import { SuiService } from './sui/sui.service';
import { ETHEREUM_TOKEN_COMMON_SERVICES } from './ethereum-token-common/ethereum-token-common.module';
import { EthereumTokenCommonService } from './ethereum-token-common/ethereum-token-common.service';
import { SplService } from './spl/spl.service';
import { Trc20Service } from './trc20/trc20.service';

/**
 * 다른 모듈에서 import 하여 사용하는 블록체인 진입점.
 * **숫자 id**(`AssetId` / `TokenTypeId`)로 적절한 AssetService / TokenService 를 찾아 제공한다.
 *
 * 각 서비스가 `getAssetId()` / `getTokenTypeId()` 로 자기 id 를 알려주므로,
 * EVM 네트워크별 인스턴스든 단일 체인이든 동일하게 id 로 등록·조회된다.
 */
@Injectable()
export class BlockchainService {
  private readonly assetServices = new Map<number, AssetService>();
  private readonly tokenServices = new Map<number, TokenService>();

  constructor(
    @Inject(ETHEREUM_COMMON_SERVICES)
    ethereumServices: EthereumCommonService[],
    sol: SolService,
    xlm: XlmService,
    btc: BtcService,
    bch: BchService,
    trx: TrxService,
    xrp: XrpService,
    xpla: XplaService,
    sui: SuiService,
    @Inject(ETHEREUM_TOKEN_COMMON_SERVICES)
    ethereumTokenServices: EthereumTokenCommonService[],
    spl: SplService,
    trc20: Trc20Service,
  ) {
    // AssetService 구현체 등록 (assetId 키)
    for (const service of [
      ...ethereumServices,
      sol,
      xlm,
      btc,
      bch,
      trx,
      xrp,
      xpla,
      sui,
    ]) {
      this.assetServices.set(service.getAssetId(), service);
    }

    // TokenService 구현체 등록 (tokenTypeId 키)
    for (const service of [...ethereumTokenServices, spl, trc20]) {
      this.tokenServices.set(service.getTokenTypeId(), service);
    }
  }

  /** assetId 에 해당하는 네이티브 자산 서비스를 반환한다. */
  getAssetService(assetId: number): AssetService {
    const service = this.assetServices.get(assetId);
    if (!service) {
      throw new NotFoundException(
        `No AssetService registered for assetId=${assetId}`,
      );
    }
    return service;
  }

  /** tokenTypeId 에 해당하는 토큰 서비스를 반환한다. */
  getTokenService(tokenTypeId: number): TokenService {
    const service = this.tokenServices.get(tokenTypeId);
    if (!service) {
      throw new NotFoundException(
        `No TokenService registered for tokenTypeId=${tokenTypeId}`,
      );
    }
    return service;
  }

  /** 등록된 모든 AssetService (tx-scanner 가 순회용으로 사용) */
  getAllAssetServices(): AssetService[] {
    return [...this.assetServices.values()];
  }

  /** 등록된 모든 TokenService */
  getAllTokenServices(): TokenService[] {
    return [...this.tokenServices.values()];
  }

  /** 등록된 자산 id 목록 */
  getSupportedAssetIds(): number[] {
    return [...this.assetServices.keys()];
  }

  /** 등록된 토큰 타입 id 목록 */
  getSupportedTokenTypeIds(): number[] {
    return [...this.tokenServices.keys()];
  }
}
