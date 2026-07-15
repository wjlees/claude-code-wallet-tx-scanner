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
  SUI = 12,
}

/** 토큰 타입 식별 번호 (assetId 와 별개 네임스페이스). */
export enum TokenTypeId {
  KIP7 = 1,
  KONETTOKEN = 2,
  BASETOKEN = 3,
  SPL = 4,
  TRC20 = 5,
}

/**
 * **통합 러너 쌍(§22)** — 감지 메커니즘이 같아 코인+토큰을 한 루프로 도는 조합.
 * SOL+SPL: 블록(getParsedBlock) 하나에 native delta(pre/postBalances)와 SPL delta
 * (pre/postTokenBalances)가 함께 있어 한 번 파싱으로 둘 다 얻는다(블록 이중 다운로드 방지).
 * tx-scanner 는 이 쌍의 개별 러너를 만들지 않고 both-set `ScanTarget` 러너 1개를 만든다.
 * (EVM 은 감지 RPC 가 달라 — native=블록/receipt, erc20=getLogs — 합칠 수 없음)
 */
export const UNIFIED_SCAN_PAIRS: {
  assetId: AssetId;
  tokenTypeId: TokenTypeId;
}[] = [{ assetId: AssetId.SOL, tokenTypeId: TokenTypeId.SPL }];
