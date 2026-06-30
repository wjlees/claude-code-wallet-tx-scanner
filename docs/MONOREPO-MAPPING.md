# MONOREPO-MAPPING — prototype ↔ 회사 monorepo 매핑

> **목적**: claude-code prototype 과 회사 monorepo(`gopax-backend-nest → apps/wallet-tx-scanner`)
> 사이를 옮길 때 **전체 diff 를 다시 읽지 않도록** 하는 공용 어휘(Rosetta stone).
> 두 쪽 AI 는 변경 diff 대신 **이 파일 + 해당 커밋의 "포팅 체크리스트"** 만 읽으면 된다.

## 0. 원칙
- **계약(interface/type/시그니처/테이블 컬럼/파라미터 키)이 공용어다.** 양쪽이 같은 계약을 구현한다.
- prototype 은 외부 연동을 **stub** 로 두되 **시그니처는 monorepo 실물과 동일**하게 맞춘다 → 포팅 = stub 교체.
- 식별자 숫자값은 양쪽이 **달라도 된다.** 심볼(`AssetId.ETH` ↔ `IsoAlpha3ToAssetId.ISO_ALPHA3_ETH`)이 같은 자산을 가리키면 됨.

## 1. 개념 · 이름 매핑

| 개념 | prototype | monorepo | 상태/비고 |
|------|-----------|----------|----------|
| 파라미터 조회 | `parameter-store.getParametersByPath(path)` (path별 객체) | `paramStoreService.getParametersByPath(path)` | ✅ 모델 일치 |
| 노드 URL 필드 | `getNodeUrlByPath(path)` → path 객체의 **`nodeUrl`** | path 객체의 자산별 필드(**`host`/`gethUrl` 등 자산마다 다름**) | ✅ **약속**: 의미는 동일(node RPC 주소). prototype 은 `nodeUrl` 로 통일, monorepo 는 자산별 필드 — 같은 것으로 취급 |
| 1회 스캔 범위 | `getMaxDepositScanRange(path)` → 미설정이면 **undefined → log 후 skip** | ParamStore 저장 키는 **`maxDepositScanRange`** 인데 코드는 **`maxScanRange`** 로 읽고 있었음(키 불일치 → 항상 미설정 취급, 동작 안 함) | ⚠️ **양쪽 동일 버그였음 → 양쪽 모두 `maxDepositScanRange` 로 통일 수정.** monorepo 도 코드의 `maxScanRange` 읽기를 `maxDepositScanRange` 로 변경 필요. (정책은 일치: 미설정이면 throw 안 하고 log 후 skip.) (legacy `maxBlockScanSize` 는 별개 상수) |
| 자산 식별 | `constants.AssetId.X` (값 임의) | `@gopax/proto` `IsoAlpha3ToAssetId.ISO_ALPHA3_X` | 심볼 정합만(값 무관) |
| 토큰타입 식별 | `constants.TokenTypeId.X` (값 임의) | `@gopax/proto` `TokenTypeId` (KIP7=11,KONETTOKEN=20,BASETOKEN=21,SPL=9,TRC20=17) | 심볼 정합만 |
| 저장 assetId 해석 | `tx-scanner.service` `resolveStoreAssetId(target)` **stub**(토큰=1001+) | `assetRepository`/`tokenRepository` 로 실제 assetId 조회 | ⚠️ prototype 은 stub, monorepo 는 repo 조회. 토큰 자체 assetId 목표는 §5-6(양쪽 미정렬) |
| DetectedTx | `{ txHash, fromAddress?, toAddress?, amount?, memoId?, blockNumber?, raw }` — **in/out 의미부여 안 함**(from/to 만) | 동일 컨셉 | ✅ 일치. in/out 해석은 저장/조회 단계 |
| tx 저장 | `TxScannerService.saveDetected` → `DetectedTransactionsRepository.insertDetectedTransactions`(stub). **매퍼/TxRepository 없음**(DetectedTx≈DB 컬럼이라 직접 매핑) | 동명 repository (`main.detected_transactions`) | ✅ InsertParams(fromAddress/toAddress/txId/amount/note…) 정렬 |
| 워치독 | `TxScannerService.watchdog()` — **`@Cron` 아님**, `setInterval` 로 주기 호출 | `scheduler_manager` 가 watchdog 등록·주기 호출(@Cron 아님) | ✅ 둘 다 @Cron 미사용 |
| 진행 지점 | `WalletScannerAssetRepository` = `wallet_scanner_asset.start_block_number`(stub) | `wallet.wallet_scanner_asset.start_block_number` (`WalletScannerAssetRepository`), `main.asset` 과 분리 | ✅ 일치. **키 = `asset_id` 단독**(중복 없음), 현재 `start_block_number` 만(컬럼 필요 시 추가) |
| cursor(체인경계) | `ScanResult.nextCursor` (불투명) | 동일 | DB엔 start_block_number 로 저장 |
| 스캔 계약 | `AssetService`/`TokenService` (스캔 계약 직접 포함) | `AssetService`/`TokenService` + `BlockchainService` (Scannable 제거 완료) | ✅ **일치**. monorepo 인터페이스는 출금/입금(scanBlocks 등) 메서드까지 포함해 prototype 보다 넓음(상위집합) |
| 진입점 | `BlockchainService` | `BlockchainService` (`ScannableBlockchainService` 삭제됨) | ✅ 일치 |
| 부팅 게이트 | 없음(항상 ON) | `TX_SCANNER_ENABLED` flag | |

## 2. ParamStore path · 심볼 · TokenTypeId (monorepo tx-scanner 실제 대상)

**native**
| 서비스 symbol | IsoAlpha3 | ParamStore path |
|---|---|---|
| konet | ISO_ALPHA3_KONET | `konet` |
| klay | ISO_ALPHA3_KLAY | `klay` (KAIA rename 전) |
| cross | ISO_ALPHA3_CROSS | `cross` |
| base | ISO_ALPHA3_BASEETH | `base` (iso=BASEETH) |
| sol | ISO_ALPHA3_SOL | `sol` |
| xlm | ISO_ALPHA3_XLM | `xlm` |
| btc | ISO_ALPHA3_BTC | `btc` |
| bch | ISO_ALPHA3_BCH | `bch` |
| trx | ISO_ALPHA3_TRX | `tron` (path≠symbol) |
| xrp | ISO_ALPHA3_XRP | `xrp` — ⚠️ monorepo 스캐너 **미등록**(추후 추가), prototype 만 스캔 |
| xpla | ISO_ALPHA3_XPLA | `xpla` |

**token**
| symbol | TokenTypeId | path | 기반 |
|---|---|---|---|
| kip7 | KIP7(11) | `kip7` | KLAY |
| konetToken | KONETTOKEN(20) | `konetToken` | KONET |
| baseToken | BASETOKEN(21) | `baseToken` | BASEETH |
| spl | SPL(9) | `sol`(공유) | SOL |
| trc20 | TRC20(17) | `trc20` | TRX |

## 3. 자산 로스터 ✅ (2026-06-29 일치)
prototype 로스터를 monorepo tx-scanner 기준으로 맞춤: native `konet/klay/cross/base/sol/xlm/btc/bch/trx/xpla` + token `kip7/konetToken/baseToken/spl/trc20`. (이전 `ETH/POL/erc20` 제거, `cross` 는 EVM 으로 ethereum-common 에 추가.)
- ⚠️ **`xrp`: prototype 로스터엔 있으나 monorepo 스캐너/`BlockchainService` 미등록(추후 별도 추가 예정)** — 현재 유일한 로스터 차이.
- 참고: monorepo wallet fork 에는 ETH/MATIC/WEMIX/FLR/ARBITRUM 등이 더 있으나 tx-scanner 미등록 → 로스터 제외. legacy 출금 전용 모듈(eth/pol/wemix/...)은 ethereum-common/token-common 으로 정리됨.

## 4. 포팅 체크리스트 (커밋마다 — diff 대신 이걸 읽힘)
```
### 포팅 체크리스트 — <커밋>
- 무엇: (한 줄)
- 바뀐 계약: <interface/시그니처/테이블컬럼/파라미터키>
- 파일 매핑: <prototype> → <monorepo>
- monorepo 측 할 일: [ ] stub→실구현 [ ] 이름/값 정렬(§1·§2)
- 결정/가정(확인 필요): ...
- prototype 검증: build/lint/부팅/live …
```

## 5. 정렬 상태

**✅ 완료 (양쪽 일치, monorepo 확인됨):**
1. **ParamStore 모델** — `getParametersByPath(path)` + path별 `{ nodeUrl, maxDepositScanRange }`. 헬퍼 `getNodeUrlByPath`/`getMaxDepositScanRange(path)`.
3. **진행 지점 테이블** — `wallet_scanner_asset.start_block_number`(`WalletScannerAssetRepository`, main.asset 분리). 키=`asset_id` 단독.
4. **자산 로스터** — EVM konet/klay/cross/base + 토큰 kip7/konetToken/baseToken + sol/spl/xlm/btc/bch/trx/trc20/xpla. (ETH/POL/erc20 제거. **xrp 예외 — 아래 주의 참조**)
5. **스캔 계약/진입점** — 스캔 계약을 `AssetService`/`TokenService` 에 통합(별도 `Scannable*`/가드 제거), `BlockchainService` 단일 진입점. legacy 출금 전용 모듈 정리.
8. **DetectedTx in/out 제거** — `DetectedTx` 가 `fromAddress`/`toAddress` 만(direction/address/counterparty 제거). 매퍼·`TxRepository` 제거하고 `saveDetected` 가 직접 저장(DetectedTx≈DB 컬럼). 워치독 `@Cron`→`setInterval`(monorepo=scheduler_manager). run 주기 10s 통일.

**⏳ 아직 양쪽 미정렬 (다음 sync 작업):**
6. **토큰 detected_transactions.assetId** — 목표=토큰 자체 assetId(`main.token` 의 contractAddress→assetId per-tx). 현재 양쪽 모두 토큰타입 단위(기반 체인 id / stub). prototype `resolveStoreAssetId` 는 stub 1001+ (monorepo 는 assetRepository/tokenRepository 로 조회 예정). TRC20 등은 `raw.contract` 에 contractAddress 보관 중.
7. **detected_transactions 멱등** — 양쪽 미구현. unique index 후보 `(asset_id, tx_id, from_address, to_address)`. migration+app 합의 후.
9. **scan range 필드명** — ParamStore 저장 키는 `maxDepositScanRange` 인데 **양쪽 코드가 `maxScanRange` 로 읽고 있어** 항상 미설정 취급(동작 안 함)이던 버그. **prototype 은 수정 완료**(2026-06-30, 커밋). **monorepo 는 코드의 `maxScanRange` 읽기를 `maxDepositScanRange` 로 변경 필요** — `getParametersByPath(path).maxDepositScanRange` 로 접근하도록 호출부 수정(정책은 그대로: 미설정이면 throw 안 하고 log 후 skip).

**주의/약속:**
- **xrp**: prototype 로스터엔 있으나 monorepo `BlockchainService` **미등록**(추후 추가 예정) — 현재 유일한 로스터 차이.
- **nodeUrl**: prototype `nodeUrl` ≡ monorepo path 객체의 자산별 URL 필드(`host`/`gethUrl` 등) — 같은 의미(node RPC 주소)로 취급(§1).
- **숫자값**: `AssetId`/`TokenTypeId` 값은 prototype 로컬값(monorepo 와 달라도 됨). 심볼만 `@gopax/proto` 와 일치(§2).
