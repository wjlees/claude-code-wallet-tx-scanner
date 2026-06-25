import { AssetId, TokenTypeId } from '../constants';
import {
  EthereumBasedAssetType,
  ethereumBasedAssets,
} from '../ethereum-common/ethereum-based-assets';

/**
 * ethereum-token-common 은 EVM 계열 네트워크 위의 토큰(ERC20/KIP7 등)을 공통 처리한다.
 *
 * 토큰은 기반 자산(baseAssetId)의 네트워크 설정을 그대로 물려받으므로
 * `...ethereumBasedAssets[baseAssetId]` 를 스프레드하고, 토큰 고유 정보만 덧붙인다.
 */
export interface EthereumBasedTokenType extends EthereumBasedAssetType {
  /** 이 토큰이 올라가 있는 EVM 자산 id (`AssetId`) */
  baseAssetId: number;
  /** 토큰 이름 (paramStore 조회 등에 사용) */
  tokenName: string;
}

/**
 * EVM 계열 토큰 레지스트리. (키 = `TokenTypeId` 의 EVM 부분집합)
 */
export const ethereumBasedTokens: Record<number, EthereumBasedTokenType> = {
  [TokenTypeId.ERC20]: {
    ...ethereumBasedAssets[AssetId.ETH],
    baseAssetId: AssetId.ETH,
    tokenName: 'erc20',
  },
  [TokenTypeId.KIP7]: {
    ...ethereumBasedAssets[AssetId.KLAY],
    baseAssetId: AssetId.KLAY,
    tokenName: 'kip7',
  },
};

/** 등록된 모든 토큰 타입 id 목록 */
export const ethereumBasedTokenTypeIds: number[] = Object.keys(
  ethereumBasedTokens,
).map((tokenTypeId) => Number(tokenTypeId));
