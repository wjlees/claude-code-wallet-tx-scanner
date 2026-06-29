import { AssetId } from '../constants';

/**
 * ethereum-common 은 단일 체인이 아니라 "EVM 계열 네트워크들"을 공통 로직으로 처리한다.
 * (ethereum, polygon, klaytn, konet 등) — 네트워크별 차이는 아래 설정으로 표현한다.
 *
 * 레지스트리 키 = `AssetId`(constants.ts) 의 EVM 부분집합. 토큰(ethereum-based-tokens)이
 * baseAssetId 로 이 값을 참조한다.
 */
export interface EthereumBasedAssetType {
  /** 네트워크 식별 이름 (로깅용) */
  networkName: string;
  /** ParamStore path (= monorepo getParametersByPath path). 노드URL·maxScanRange 조회 키. */
  path: string;
  /** EIP-1559(base fee) 지원 여부 */
  EIP1559: boolean;
  /** 적용 하드포크 (선택) */
  hardfork?: string;
  /** 자산(코인) 심볼 (서비스 symbol = monorepo 서비스 symbol) */
  assetName: string;
}

/**
 * EVM 계열 자산 레지스트리. (키 = `AssetId` 의 EVM 부분집합)
 * monorepo tx-scanner EVM 자산: konet / klay / cross / base(BASEETH).
 * NOTE: EIP1559 / hardfork 값은 네트워크별 확인 후 확정 필요(TODO).
 */
export const ethereumBasedAssets: Record<number, EthereumBasedAssetType> = {
  [AssetId.KONET]: {
    networkName: 'konet',
    path: 'konet',
    EIP1559: false,
    assetName: 'konet',
  },
  [AssetId.KLAY]: {
    networkName: 'klaytn',
    path: 'klay',
    EIP1559: false,
    assetName: 'klay',
  },
  [AssetId.CROSS]: {
    networkName: 'cross',
    path: 'cross',
    EIP1559: true,
    assetName: 'cross',
  },
  [AssetId.BASE]: {
    networkName: 'base',
    path: 'base',
    EIP1559: true,
    hardfork: 'cancun',
    assetName: 'base',
  },
};

/** 등록된 모든 EVM 자산 id 목록 (provider 생성 등에 사용) */
export const ethereumBasedAssetIds: number[] = Object.keys(
  ethereumBasedAssets,
).map((assetId) => Number(assetId));
