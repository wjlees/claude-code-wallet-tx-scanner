import {
  EthereumBasedAssetId,
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
  /** 이 토큰이 올라가 있는 EVM 자산 id (ethereum-based-assets 의 assetId) */
  baseAssetId: number;
  /** 토큰 이름 (paramStore 조회 등에 사용) */
  tokenName: string;
}

/**
 * 토큰 타입 id (숫자).
 * NOTE: 값은 잠정값 — 실제로는 DB 의 tokenType id 와 일치시켜야 한다(TODO).
 */
export enum TokenTypeId {
  ERC20 = 1001,
  KIP7 = 1002,
}

/**
 * EVM 계열 토큰 레지스트리. (키 = 숫자 tokenTypeId)
 */
export const ethereumBasedTokens: Record<number, EthereumBasedTokenType> = {
  [TokenTypeId.ERC20]: {
    ...ethereumBasedAssets[EthereumBasedAssetId.ETH],
    baseAssetId: EthereumBasedAssetId.ETH,
    tokenName: 'erc20',
  },
  [TokenTypeId.KIP7]: {
    ...ethereumBasedAssets[EthereumBasedAssetId.KLAY],
    baseAssetId: EthereumBasedAssetId.KLAY,
    tokenName: 'kip7',
  },
};

/** 등록된 모든 토큰 타입 id 목록 */
export const ethereumBasedTokenTypeIds: number[] = Object.keys(
  ethereumBasedTokens,
).map((tokenTypeId) => Number(tokenTypeId));
