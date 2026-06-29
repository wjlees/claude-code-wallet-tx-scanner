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
| 파라미터 조회 | `parameter-store.getParameter`/`getNodeUrl` (flat 키) | `paramStoreService.getParametersByPath(path)` (path별 객체) | ⚠️ **모델 다름 — §3 정렬 필요** |
| 1회 스캔 범위 | `getMaxScanRange(<ASSET>_MAX_SCAN_RANGE)` (flat, 필수·throw) | `getParametersByPath(path).maxScanRange` → `parseInt`, undefined면 throw | ⚠️ **`maxScanRange` 로 통일 + path별로 변경 필요**. (legacy `scanBlocks` 의 `maxBlockScanSize` 는 코드 상수, tx-scanner 와 비공유) |
| 자산 식별 | `constants.AssetId.X` (값 임의) | `@gopax/proto` `IsoAlpha3ToAssetId.ISO_ALPHA3_X` | 심볼 정합만(값 무관) |
| 토큰타입 식별 | `constants.TokenTypeId.X` (값 임의) | `@gopax/proto` `TokenTypeId` (KIP7=11,KONETTOKEN=20,BASETOKEN=21,SPL=9,TRC20=17) | 심볼 정합만 |
| 토큰 저장 assetId | `detected-tx.mapper` `STUB_TOKEN_ASSET_ID`(1001+, tokenTypeId 기준) | **토큰 자체 assetId**(`main.asset` 행). `main.token(token_type_id, token_contract_address)` 로 contractAddress→assetId 해석 | ⚠️ **양쪽 다 미정렬**: monorepo mapper 도 현재 기반 체인 assetId 넣음. 목표=토큰 자체 assetId |
| tx 저장 | `TxRepository`→`DetectedTransactionsRepository.insertDetectedTransactions`(stub) | 동명 repository (`main.detected_transactions`) | InsertParams 시그니처 정렬됨 |
| 진행 지점 | `AssetRepository` = **`asset.start_block_number`**(stub) | **`wallet.wallet_scanner_asset.start_block_number`** (`WalletScannerAssetRepository`), `main.asset` 과 분리 | ⚠️ **테이블 다름 — 정렬 필요** |
| cursor(체인경계) | `ScanResult.nextCursor` (불투명) | 동일 | DB엔 start_block_number 로 저장 |
| 스캔 계약 | `AssetService`/`TokenService` | `ScannableBlockchainService` 등록 자산 | |
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
| xrp | ISO_ALPHA3_XRP | `xrp` |
| xpla | ISO_ALPHA3_XPLA | `xpla` |

**token**
| symbol | TokenTypeId | path | 기반 |
|---|---|---|---|
| kip7 | KIP7(11) | `kip7` | KLAY |
| konetToken | KONETTOKEN(20) | `konetToken` | KONET |
| baseToken | BASETOKEN(21) | `baseToken` | BASEETH |
| spl | SPL(9) | `sol`(공유) | SOL |
| trc20 | TRC20(17) | `trc20` | TRX |

## 3. ⚠️ 자산 로스터 불일치 (중요)
- **prototype 에만 있음**: `ETH`(ethereum), `POL`(polygon), `erc20` → monorepo tx-scanner(`ScannableBlockchainService`)에 **미등록**(wallet fork 에만 존재).
- **monorepo tx-scanner 에만 있음**: `cross`, `base`(BASEETH), `konetToken`, `baseToken`.
- Polygon: monorepo 는 `ISO_ALPHA3_MATIC`(path `polygon`), **`POL` 전용 enum 없음**.
- 즉 prototype 의 자산 set 은 "예시"이고 monorepo 실제 set 과 다르다. 포팅 시 **로스터를 monorepo 기준으로 맞출지** 결정 필요.

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

## 5. 미해결 정렬 항목 (양쪽 합의/작업 필요)
1. **ParamStore 모델**: prototype flat 키 → monorepo `getParametersByPath(path)` 로 정렬. node URL·`maxScanRange` 를 path별 객체로.
2. **scan range 필드명**: `maxScanRange` 로 통일(완료된 용어). prototype 키 구조만 path별로 변경.
3. **진행 지점 테이블**: prototype `asset.start_block_number` ↔ monorepo `wallet_scanner_asset.start_block_number`(별도 테이블). → prototype 을 `wallet_scanner_asset` 로 맞출지 결정.
4. **토큰 저장 assetId**: 목표=토큰 자체 assetId(`main.asset`), `main.token` 의 contractAddress→assetId 로 해석. **양쪽 mapper 모두 현재 기반 체인 assetId 넣음(미정렬)** → 같이 정렬.
5. **detected_transactions 멱등**: 양쪽 **미구현**. unique index 후보 `(asset_id, tx_id, from_address, to_address)` (또는 `(asset_id, tx_id, to_address)`). migration+app 합의 후 구현.
6. **자산 로스터**(§3): prototype(ETH/POL/erc20) ↔ monorepo(cross/base/konetToken/baseToken). 맞출지 결정.
