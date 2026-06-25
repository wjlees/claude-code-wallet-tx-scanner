/**
 * 스캔 대상 지갑 묶음. 실제로는 DB에서 가져온다.
 *
 * 식별은 **숫자 assetId**(symbol 아님). 하나의 주소 묶음이 여러 자산을 커버할 수 있어
 * `assetIds` 는 배열이다(예: EVM 동일 주소가 ETH/POLYGON/KLAY/KONET 공통).
 * hot/cold 구분 없이 감지할 주소를 `addresses` 로 모은다.
 */
export interface Wallet {
  /** 이 주소들이 속한 자산 id 목록 (`AssetId`) */
  assetIds: number[];
  /** 감지할 온체인 주소들 (hot/cold/기타 무관) */
  addresses: string[];
}
