/**
 * 자산/토큰 식별 번호 (단일 소스).
 *
 * 심볼 문자열('btc' 등) 대신 **숫자 id** 로 서비스를 매핑한다.
 * NOTE: 값은 실제로는 DB 의 assetId / tokenTypeId 와 일치시킨다(현재는 잠정값).
 *  - EVM 자산(ETH~KONET)은 기존 번호를 유지하고, 그 뒤로 이어서 부여한다.
 */
export enum AssetId {
  ETH = 1,
  POLYGON = 2,
  KLAY = 3,
  KONET = 4,
  SOL = 5,
  XLM = 6,
  BTC = 7,
  BCH = 8,
  TRX = 9,
  XRP = 10,
  XPLA = 11,
}

/** 토큰 타입 식별 번호 (assetId 와 별개 네임스페이스). */
export enum TokenTypeId {
  ERC20 = 1,
  KIP7 = 2,
  SPL = 3,
  TRC20 = 4,
}
