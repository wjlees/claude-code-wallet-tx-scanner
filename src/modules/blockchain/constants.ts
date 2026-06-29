/**
 * 자산/토큰 식별 번호 (단일 소스).
 *
 * 심볼 문자열 대신 **숫자 id** 로 서비스를 매핑한다.
 * NOTE: 값은 prototype 로컬값이며 **monorepo 와 같을 필요 없다** — 심볼(멤버 이름)이
 *   monorepo `@gopax/proto` 의 `IsoAlpha3ToAssetId`/`TokenTypeId` 와 같은 자산을 가리키면 된다.
 *   (예: prototype `AssetId.KONET` ↔ monorepo `IsoAlpha3ToAssetId.ISO_ALPHA3_KONET`)
 *   로스터는 monorepo tx-scanner(ScannableBlockchainService) 등록 자산과 일치시킨다.
 *   매핑 표: docs/MONOREPO-MAPPING.md §2.
 */
export enum AssetId {
  KONET = 1,
  KLAY = 2,
  CROSS = 3,
  BASE = 4, // iso=BASEETH, path=base
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
  KIP7 = 1,
  KONETTOKEN = 2,
  BASETOKEN = 3,
  SPL = 4,
  TRC20 = 5,
}
