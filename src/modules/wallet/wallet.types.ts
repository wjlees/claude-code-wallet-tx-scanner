/** 지갑 종류 */
export enum WalletType {
  HOT = 'hot',
  COLD = 'cold',
}

/** 스캔 대상 지갑. 실제로는 DB에서 가져온다. */
export interface Wallet {
  id: string;
  /** 온체인 주소 */
  address: string;
  /** 자산 심볼 (BlockchainService 의 AssetService 심볼과 매핑) */
  symbol: string;
  type: WalletType;
}
