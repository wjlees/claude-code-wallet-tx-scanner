# MONOREPO-MAPPING — prototype ↔ 회사 monorepo 매핑

> **목적**: claude-code prototype 과 회사 monorepo(`gopax-backend-nest → apps/wallet-tx-scanner`)
> 사이를 옮길 때 **전체 diff 를 다시 읽지 않도록** 하는 공용 어휘(Rosetta stone).
> 두 쪽 AI 는 변경 diff 대신 **이 파일 + 해당 커밋의 "포팅 체크리스트"** 만 읽으면 된다.
> 새 개념이 생길 때만 갱신한다(거의 고정).

## 0. 원칙
- **계약(interface/type/시그니처/테이블 컬럼/파라미터 키)이 공용어다.** 양쪽이 같은 계약을 구현한다.
- prototype 은 외부 연동을 **stub** 로 두되 **시그니처는 monorepo 실물과 동일**하게 맞춘다 → 포팅 = stub 교체.
- 이름이 다를 수밖에 없는 부분만 아래 표에 "매핑/divergence" 로 적는다.

## 1. 개념 · 이름 매핑

| 개념 | prototype | monorepo | 비고 |
|------|-----------|----------|------|
| 노드 URL/파라미터 조회 | `parameter-store.ts` `getParameter`/`getNodeUrl` (async, `parameter.json`→env) | `ParamStore.getParametersByPath(assetName)` | 조회 async 동일. 키 이름만 정렬 |
| 1회 스캔 범위 | `<ASSET>_MAX_SCAN_RANGE` (parameter.json, 필수·없으면 throw) | `maxBlockScanSize` (ParamStore asset path) | **네이밍 합의 필요** |
| 자산 식별 | `constants.ts` `AssetId`(ETH=1…XPLA=11) | `@gopax/proto` `IsoAlpha3ToAssetId` | 값 정렬 필요 |
| 토큰타입 식별 | `constants.ts` `TokenTypeId`(ERC20=1…TRC20=4) | `@gopax/proto` `TokenTypeId` | 값 정렬 필요 |
| 토큰의 저장 assetId | `detected-tx.mapper.ts` `STUB_TOKEN_ASSET_ID`(1001+) | DB `token`(contract)→assetId | **stub. 실제는 DB 조회** |
| 스캔 대상 식별 | `scan.types.ts` `ScanTarget{assetId?,tokenTypeId?}` | (대응 개념) | 둘 다=통합 스캔 여지(SOL+SPL) |
| 지갑/주소 조회 | `wallet/` `WalletService.getScanAddresses(ScanTarget)` | `scan-target/` (hot=`asset.exchangeAddress`, cold=`gopax_cold_wallet.address`) | prototype 은 고정 stub |
| 지갑 타입 | `Wallet{assetIds[],addresses[]}` (HOT/COLD 구분 없음) | scan-target 엔티티들 | |
| tx 저장 | `TxRepository`→`DetectedTransactionsRepository.insertDetectedTransactions` (stub) | `DetectedTransactions.repository` 동일 메서드 | **InsertParams 시그니처 정렬됨** |
| 진행 지점 | `AssetRepository.getStartBlockNumber/updateStartBlockNumber` (stub) | `asset` 테이블 `start_block_number` | cursor→startBlockNumber |
| cursor(체인경계) | `ScanResult.nextCursor` (불투명: 블록번호/signature/ledger…) | 동일 | DB엔 start_block_number 로 저장 |
| 스캔 계약 | `AssetService`/`TokenService` (`getAssetId`/`getTokenTypeId`/`scanTransactions`) | (대응) | |
| 부팅 게이트 | 없음(항상 scan loop) | `TX_SCANNER_ENABLED` flag | prototype 은 항상 ON |

## 2. SDK / 노드 연동 (ESM·크래시 제약 — 양쪽 공통 결론)

| 체인 | 방식 | 이유(공통) |
|------|------|-----------|
| EVM | `web3` | |
| SOL/SPL | `@solana/web3.js` | |
| XLM | `@stellar/stellar-sdk` 12.x 고정 | 16.x = ESM `@noble/hashes@2` require 실패 |
| BTC/BCH | bitcoind JSON-RPC (fetch) | |
| TRX/TRC20 | `tronweb` | |
| XRP | rippled JSON-RPC (fetch) | `xrpl` 전버전 `@noble/hashes@2` ESM → 사용 불가 |
| XPLA | Cosmos LCD REST (fetch) | `@xpla/xpla.js` top-level import 부팅 크래시 → 금지. monorepo 는 REST/StargateClient |

## 3. 파일 매핑 (prototype → monorepo 시 대응 위치)

| prototype 파일 | monorepo 대응 | 포팅 시 |
|---------------|--------------|--------|
| `blockchain/constants.ts` (AssetId/TokenTypeId) | `@gopax/proto` enum | 값 정렬 |
| `blockchain/parameter-store.ts` | `ParamStore` 서비스 | 인터페이스만 맞추고 내부 교체 |
| `blockchain/*/*.service.ts` (체인 스캐너) | 동일 체인 서비스 | 스캔 로직 이식, 노드 핸들/range 는 monorepo 방식 |
| `tx-scanner/detected-transactions.repository.ts` | `DetectedTransactions.repository` | stub→실 repository |
| `tx-scanner/detected-tx.mapper.ts` | (매핑 로직 이식) | `resolveStoreAssetId` 는 DB token→asset 로 |
| `tx-scanner/asset.repository.ts` | `asset` 테이블 repository | stub→실 repository |
| `wallet/` | `scan-target/` | 주소 조회 로직 |

## 4. 포팅 체크리스트 (커밋마다 채워서 회사 AI 에게 전달 — diff 대신 이걸 읽힘)

```
### 포팅 체크리스트 — <커밋 해시/제목>
- 무엇: (한 줄)
- 바뀐 계약(있으면): <interface/시그니처/테이블컬럼/파라미터키>
- 파일 매핑: <prototype 파일> → <monorepo 파일>
- monorepo 측 해야 할 일:
  - [ ] stub → 실 구현 교체 지점: ...
  - [ ] 이름/값 정렬: ... (위 §1 표 참조)
- 결정/가정(확인 필요): ...
- prototype 에서 검증한 것: build/lint/부팅/live …
```

## 5. 현재 미해결 정렬 항목 (양쪽 합의 필요)
- `maxScanRange`(prototype) ↔ `maxBlockScanSize`(monorepo) 키 이름 통일
- `AssetId`/`TokenTypeId` 숫자값 ↔ `@gopax/proto` 실제 값 정렬
- 토큰 저장 assetId: prototype stub(1001+) ↔ monorepo DB token→asset
- 멱등 키 `(assetId, txId, from/toAddress)` 의 DB unique index 유무
