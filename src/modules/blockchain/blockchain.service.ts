import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AssetService } from './interfaces/asset.interface';
import { TokenService } from './interfaces/token.interface';
import { ETHEREUM_COMMON_SERVICES } from './ethereum-common/ethereum-common.module';
import { EthereumCommonService } from './ethereum-common/ethereum-common.service';
import { SolService } from './sol/sol.service';
import { XlmService } from './xlm/xlm.service';
import { BtcService } from './btc/btc.service';
import { BchService } from './bch/bch.service';
import { ETHEREUM_TOKEN_COMMON_SERVICES } from './ethereum-token-common/ethereum-token-common.module';
import { EthereumTokenCommonService } from './ethereum-token-common/ethereum-token-common.service';
import { SplService } from './spl/spl.service';

/**
 * 다른 모듈에서 import 하여 사용하는 블록체인 진입점.
 * 심볼로 적절한 AssetService / TokenService 구현체를 찾아 제공한다.
 *
 * EVM 계열은 네트워크(assetId) 당 인스턴스가 분리되어 있으므로 배열로 주입받아
 * 각각을 symbol(=assetId, e.g. 'ETH','POLYGON','KLAY','KONET') 로 등록한다.
 */
@Injectable()
export class BlockchainService {
  private readonly assetServices = new Map<string, AssetService>();
  private readonly tokenServices = new Map<string, TokenService>();

  constructor(
    @Inject(ETHEREUM_COMMON_SERVICES)
    ethereumServices: EthereumCommonService[],
    sol: SolService,
    xlm: XlmService,
    btc: BtcService,
    bch: BchService,
    @Inject(ETHEREUM_TOKEN_COMMON_SERVICES)
    ethereumTokenServices: EthereumTokenCommonService[],
    spl: SplService,
  ) {
    // AssetService 구현체 등록 (EVM 네트워크별 + 단일 체인)
    for (const service of [...ethereumServices, sol, xlm, btc, bch]) {
      this.assetServices.set(service.symbol, service);
    }

    // TokenService 구현체 등록 (token-* 접두로 구분)
    for (const service of [...ethereumTokenServices, spl]) {
      this.tokenServices.set(`${service.symbol}-token`, service);
    }
  }

  /** 심볼에 해당하는 네이티브 자산 서비스를 반환한다. */
  getAssetService(symbol: string): AssetService {
    const service = this.assetServices.get(symbol);
    if (!service) {
      throw new NotFoundException(`No AssetService registered for "${symbol}"`);
    }
    return service;
  }

  /** 심볼에 해당하는 토큰 서비스를 반환한다. */
  getTokenService(symbol: string): TokenService {
    const service = this.tokenServices.get(`${symbol}-token`);
    if (!service) {
      throw new NotFoundException(`No TokenService registered for "${symbol}"`);
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

  /** 등록된 자산 심볼 목록 */
  getSupportedAssets(): string[] {
    return [...this.assetServices.keys()];
  }

  /** 등록된 토큰 심볼 목록 */
  getSupportedTokens(): string[] {
    return [...this.tokenServices.keys()];
  }
}
