/**
 * ethereum-common 은 단일 체인이 아니라 "EVM 계열 네트워크들"을 공통 로직으로 처리한다.
 * (ethereum, polygon, klaytn, konet 등) — 네트워크별 차이는 아래 설정으로 표현한다.
 *
 * assetId 는 숫자(실제로는 DB 의 asset id)이며, 토큰(ethereum-based-tokens)이
 * baseAssetId 로 이 값을 참조한다.
 */
export interface EthereumBasedAssetType {
  /** 네트워크 식별 이름 (e.g. 'ethereum', 'polygon', 'klaytn', 'konet') */
  networkName: string;
  /** EIP-1559(base fee) 지원 여부 */
  EIP1559: boolean;
  /** 적용 하드포크 (선택) */
  hardfork?: string;
  /** 자산(코인) 이름 */
  assetName: string;
}

/**
 * EVM 계열 자산 id (숫자).
 * NOTE: 값은 잠정값 — 실제로는 DB 의 asset id 와 일치시켜야 한다(TODO).
 */
export enum EthereumBasedAssetId {
  ETH = 1,
  POLYGON = 2,
  KLAY = 3,
  KONET = 4,
}

/**
 * EVM 계열 자산 레지스트리. (키 = 숫자 assetId)
 * NOTE: EIP1559 / hardfork / assetName 값은 네트워크별로 확인 후 확정 필요(TODO).
 */
export const ethereumBasedAssets: Record<number, EthereumBasedAssetType> = {
  [EthereumBasedAssetId.ETH]: {
    networkName: 'ethereum',
    EIP1559: true,
    hardfork: 'cancun',
    assetName: 'ETH',
  },
  [EthereumBasedAssetId.POLYGON]: {
    networkName: 'polygon',
    EIP1559: true,
    hardfork: 'london',
    assetName: 'POL',
  },
  [EthereumBasedAssetId.KLAY]: {
    networkName: 'klaytn',
    EIP1559: false,
    assetName: 'KLAY',
  },
  [EthereumBasedAssetId.KONET]: {
    networkName: 'konet',
    EIP1559: false,
    assetName: 'KONET',
  },
};

/** 등록된 모든 EVM 자산 id 목록 (provider 생성 등에 사용) */
export const ethereumBasedAssetIds: number[] = Object.keys(
  ethereumBasedAssets,
).map((assetId) => Number(assetId));
