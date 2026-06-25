import { AssetId } from '../constants';

/**
 * ethereum-common 은 단일 체인이 아니라 "EVM 계열 네트워크들"을 공통 로직으로 처리한다.
 * (ethereum, polygon, klaytn, konet 등) — 네트워크별 차이는 아래 설정으로 표현한다.
 *
 * 레지스트리 키 = `AssetId`(constants.ts) 의 EVM 부분집합. 토큰(ethereum-based-tokens)이
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
 * EVM 계열 자산 레지스트리. (키 = `AssetId` 의 EVM 부분집합)
 * NOTE: EIP1559 / hardfork / assetName 값은 네트워크별로 확인 후 확정 필요(TODO).
 */
export const ethereumBasedAssets: Record<number, EthereumBasedAssetType> = {
  [AssetId.ETH]: {
    networkName: 'ethereum',
    EIP1559: true,
    hardfork: 'cancun',
    assetName: 'ETH',
  },
  [AssetId.POLYGON]: {
    networkName: 'polygon',
    EIP1559: true,
    hardfork: 'london',
    assetName: 'POL',
  },
  [AssetId.KLAY]: {
    networkName: 'klaytn',
    EIP1559: false,
    assetName: 'KLAY',
  },
  [AssetId.KONET]: {
    networkName: 'konet',
    EIP1559: false,
    assetName: 'KONET',
  },
};

/** 등록된 모든 EVM 자산 id 목록 (provider 생성 등에 사용) */
export const ethereumBasedAssetIds: number[] = Object.keys(
  ethereumBasedAssets,
).map((assetId) => Number(assetId));
