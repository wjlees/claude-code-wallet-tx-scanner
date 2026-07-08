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
| 1회 스캔 범위 | `getMaxDepositScanRange(path)` → 미설정이면 **undefined → log 후 skip** | `getParametersByPath(path).maxDepositScanRange` → 미설정이면 **log 후 return(skip)** | ✅ 일치(양쪽 `maxDepositScanRange` 로 통일 — 과거 양쪽 `maxScanRange` 로 읽던 키 불일치 버그 수정 완료, §5-9). (legacy `maxBlockScanSize` 는 별개 상수) |
| 자산 식별 | `constants.AssetId.X` (값 임의) | `@gopax/proto` `IsoAlpha3ToAssetId.ISO_ALPHA3_X` | 심볼 정합만(값 무관) |
| 토큰타입 식별 | `constants.TokenTypeId.X` (값 임의) | `@gopax/proto` `TokenTypeId` (KIP7=11,KONETTOKEN=20,BASETOKEN=21,SPL=9,TRC20=17) | 심볼 정합만 |
| 저장 assetId 해석 | 코인=`assetId`. 토큰=token_type 루프가 tx 의 `contractAddress→asset_id`(main.token) 로 분류해 각 토큰 asset_id 로 저장(`saveDetectedTokens`). 토큰 목록은 `TokenRepository`(main.token stub)에서 `token_type → [{assetId, contractAddress}]` | `assetRepository`/`tokenRepository`(main.token) 로 `token_type_id → (asset_id, contractAddress)` 조회 후 tx 의 contractAddress 로 분류 | ✅ 모델 일치(토큰이 자기 asset id, per-tx contractAddress 분류). prototype 은 토큰 목록 stub, monorepo 는 실제 main.token. §5-6/§5-10 참조 |
| DetectedTx | `{ txHash, fromAddress?, toAddress?, contractAddress?, txIndex?, amount?(raw), feeAmount?(raw), memoId?, blockNumber?, raw }` — **in/out 의미부여 안 함**. blockchain 은 **raw 최소단위** 반환 | 동일 컨셉 | ✅ 일치. 사토시 환산은 저장 단계 |
| tx 저장 | `saveDetected`/`saveDetectedTokens` → `toInsertParams`(raw→**사토시** 환산, `raw_amount` 보존) → `insertDetectedTransactions`(stub) | 동명 repository (`main.detected_transactions`) | ✅ InsertParams(…/`amount`=사토시/`rawAmount`/`feeAmount`=사토시) 정렬. §5-13 |
| 멱등 | 유니크 키 `(asset_id, tx_id, tx_index)`. stub 은 Set dedup | UNIQUE `(asset_id, tx_id, tx_index)` + TypeORM `.orIgnore()`(MySQL) | ✅ 양쪽 완료(§5-7). 중복 무시 표기만 엔진차(아래 주의) |
| 스캔 대상(러너) 빌드 | `TxScannerService.onModuleInit` 의 `createAssetRunner`/`createTokenRunner`(인라인). 토큰은 `TokenRepository.getTokensByType` 로 펼침 | **`ScanTargetService`** (`buildTokenScanRunnerConfig`/`getTokenScanTargets` — token_type→main.token 펼침), `TxScannerService` 는 결과로 러너만 생성 | ✅ §6+§10 양쪽 적용 완료(구조는 prototype 인라인 ↔ monorepo 별도 클래스 — 책임 동일) |
| 워치독 | `TxScannerService.watchdog()` — **`@Cron` 아님**, `setInterval` 로 주기 호출 | `scheduler_manager` 가 watchdog 등록·주기 호출(@Cron 아님) | ✅ 둘 다 @Cron 미사용 |
| 진행 지점 | `WalletScannerAssetRepository` = `wallet_scanner_asset.start_block_number`(stub) | `wallet.wallet_scanner_asset.start_block_number` (`WalletScannerAssetRepository`), `main.asset` 과 분리 | ✅ 일치. **PK = `id` 단독**(코인=main.asset.id / 토큰=token 자체 asset_id, 한 id 공간·중복 없음), 현재 `start_block_number` 만(컬럼 필요 시 추가) |
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
3. **진행 지점 테이블** — `wallet_scanner_asset.start_block_number`(`WalletScannerAssetRepository`, main.asset 분리). **PK=`id` 단독**(코인=main.asset.id / 토큰=token 자체 asset_id, 한 id 공간 공유).
4. **자산 로스터** — EVM konet/klay/cross/base + 토큰 kip7/konetToken/baseToken + sol/spl/xlm/btc/bch/trx/trc20/xpla. (ETH/POL/erc20 제거. **xrp 예외 — 아래 주의 참조**)
5. **스캔 계약/진입점** — 스캔 계약을 `AssetService`/`TokenService` 에 통합(별도 `Scannable*`/가드 제거), `BlockchainService` 단일 진입점. legacy 출금 전용 모듈 정리.
8. **DetectedTx in/out 제거** — `DetectedTx` 가 `fromAddress`/`toAddress` 만(direction/address/counterparty 제거). 매퍼·`TxRepository` 제거하고 `saveDetected` 가 직접 저장(DetectedTx≈DB 컬럼). 워치독 `@Cron`→`setInterval`(monorepo=scheduler_manager). run 주기 10s 통일.
9. **scan range 필드명** — ParamStore 저장 키는 `maxDepositScanRange` 인데 양쪽 코드가 `maxScanRange` 로 읽어 항상 미설정 취급(동작 안 함)이던 버그. **양쪽 수정 완료**(prototype 2026-06-30 커밋, monorepo `getParametersByPath(path).maxDepositScanRange` 로 변경). 정책 그대로(미설정이면 throw 안 하고 log 후 skip).
6·10. **토큰 자체 asset id 모델 (✅ 양쪽 완료)** — **토큰은 자기 asset id 를 갖는다**(코인과 한 id 공간 공유, `wallet_scanner_asset.id` 단일 PK). 한 `TokenService`(=token_type)가 여러 토큰을 덮으므로 `main.token` 에서 `token_type_id → [(asset_id, contractAddress)]` 를 받아 **token_type 당 한 루프**로 스캔하고, tx 를 `contractAddress→asset_id` 로 분류해 각 토큰 asset_id 로 저장(§6), 진행지점은 그 타입의 토큰 행들을 **함께 같은 값**으로 갱신(§10). KONET 코인과 KONET 토큰이 다른 id 라 충돌 없음. (a)/(b) 갈림 → **(a)=토큰 자체 asset_id 로 확정**(token_type 컬럼 불필요).
   - prototype: `TokenRepository`(stub) + token_type 당 `ScanRunner` 1개 + `TokenService.scanTransactions(.., contractAddresses[])` + `saveDetectedTokens`(분류 저장) + 진행지점 다중행 동시 갱신. `STUB_TOKEN_ASSET_ID`·`resolveStoreAssetId` 제거, `DetectedTx.contractAddress` 추가.
   - monorepo: `ScanTargetService.buildTokenScanRunnerConfig`/`getTokenScanTargets`(token_type→main.token 펼침), `TxScannerService`(코인/토큰 러너 분리 + `saveDetectedTokens` per-tx 분류 + 진행지점 다중행), `TokenService.scanTransactions(.., contractAddresses[])`, `DetectedTx.contractAddress`. `resolveStoreAssetId` 제거.
   - **부수 정렬(monorepo 버그 수정)**: monorepo 가 토큰 시 지갑 주소를 token asset_id 로 찾던 것을 **기반 체인 `baseAssetId`** 로 조회하도록 수정(prototype 과 동일 — 주소는 기반 체인, 저장·진행지점 키만 토큰 asset_id). ✅ 이제 일치.
   - **EVM 주소 정규화**: contract 주소 비교는 lowercase 로(EVM 체크섬 대응). prototype=EVM `toDetected` 에서 `log.address` lowercase(SPL/TRC20 base58 은 case-sensitive라 건드리지 않음). monorepo=맵 키·tx.contractAddress lowercase + `saveDetectedTokens` lowercase fallback. ✅ 동등.

7. **detected_transactions 멱등 (✅ 양쪽 완료)** — 유니크 키 **`(asset_id, tx_id, tx_index)`**. `tx_index` = tx 내 위치(한 tx 가 동일 transfer 를 여러 건 담을 수 있어 — EVM 배치, UTXO 다중 vout — from/to/amount 가 같아도 구분). ⚠️ tx_index 없이 걸면 정상 2건을 눌러 누락 → 반드시 포함.
   - `tx_index` 출처: EVM=`log.logIndex`(⚠️ `transactionIndex` 아님; 블록 단위지만 tx 내 유일 → 충분), UTXO=vout `n`(fee 행=vout 개수), XPLA=이벤트 순번, 그 외(코인·tx당 1건)=0. **SOL/SPL=0 확정**(잔고 delta 는 tx 단위 합산이라 tx당 1행 — §16). XLM 은 op 파싱 전이라 0.
   - prototype: `DetectedTx.txIndex`/`InsertParams.txIndex` + 스캐너 채움 + stub repo `(assetId,txId,txIndex)` Set dedup.
   - monorepo: `tx_index` 컬럼 + UNIQUE `(asset_id, tx_id, tx_index)` migration + 스캐너 채움 + insert 중복 무시. **DB=MySQL 이라 PostgreSQL `ON CONFLICT DO NOTHING` 대신 TypeORM `.orIgnore()` 사용(동작 동일)**.

11. **입금 감지 semantic — `scanTransactions`** (양쪽 동기화 대상). ⚠️ **`scanBlocks` 는 별개 레거시**(기존 입금 로직 복사본)로 **건드리지 않는다** — status/value/confirmations 패턴의 **참고용**일 뿐. 우리가 만드는 건 `scanTransactions`. 합의된 semantic(= prototype `scanTransactions` 에 적용한 것):
   - **정확도 필터 = blockchain 층**: EVM 네이티브 = `getBlock(n,true)`(hydrated)로 후보(from/to 매칭 + `value>0`) 거른 뒤 **매칭 tx 만 `getTransactionReceipt` → `status===1`** (2-phase, `getTransaction` 불필요; revert 시 값 안 움직여 status 필수). EVM 토큰 = **revert tx 로그는 `eth_getLogs` 에 안 나옴(로그 존재=성공)** → receipt 불필요, `data≠0`(0금액) 필터만.
   - **confirmationThreshold = endBlock 캡**: `to=min(from+range-1, head-confirmationThreshold)`(스냅샷 저장 X). ParamStore 키 **`confirmationThreshold`**(미설정 0). prototype=`getConfirmationThreshold(path)` 헬퍼, monorepo=`parseInt(params.confirmationThreshold,10)` 인라인(같은 키).
   - **tx_index = `log.logIndex`(결정적)**. ⚠️ 주의: scanBlocks(레거시)의 0-based 카운터(`buildUpAddressToTransactions`)는 `Promise.all` 공유 카운터라 멀티토큰 tx 에서 값이 흔들림 → **scanTransactions 로 그 패턴을 복사하지 말 것**, logIndex 사용.
   - **금액 = raw 최소단위(blockchain), scale 은 tx-scanner**. **from/to**(in/out 의미부여 X, §8).
   - **반환 = flat `DetectedTx[]`**(prototype). monorepo `scanTransactions` 도 flat. (scanBlocks 의 grouped `{[assetId]:{[toAddress]:[]}}` 는 별개.)
   - **성능**: **`usingBatchRequest` 플래그로 batch/promise 선택**. prototype=`EthereumBasedAssetType.usingBatchRequest` → `EthereumCommonService.getBlocks`/`getReceipts`(true=JSON-RPC 배열 batch 청크 병렬, false=web3 개별 Promise.all). (scanBlocks 의 `blockRangeToScanedTxsByBatch/ByPromise` 와 같은 개념 — scanTransactions 에도 동일 적용.)
   - **✅ 양쪽 완료**(prototype+monorepo 2026-07-01, EVM native+token). monorepo 발산: range path=base asset path(klay 등)에서 읽고 confirmationThreshold=token path(kip7 등) — prototype 은 둘 다 token path. (기능 동일, path 소스만 차이.)

12. **입금 감지 semantic 비-EVM 확장 (§11 을 나머지 체인 `scanTransactions` 로) (✅ 양쪽 완료)**. 체인별 성공 지표·확정 방식:
    - confirmations cap(블록높이 기반): BTC/BCH `to=height-confirmations`, TRX/TRC20/XPLA `to=head-confirmations`. 즉시확정(XRP validated / XLM ledger close)은 캡 없음(보통 0). SOL/SPL 은 numeric cap 대신 commitment **`finalized`**.
    - status(성공) 필터(체인별): UTXO=불필요(블록 포함=유효), TRX/TRC20=`ret[0].contractRet==='SUCCESS'`(TRC20 은 call data 디코드라 실패 호출도 잡혀 **필수**), XRP=`meta.TransactionResult==='tesSUCCESS'`, XLM=`successful===true`, XPLA=`tx_response.code===0`, SOL/SPL=`sig.err===null`.
    - value>0: 전 체인 공통(UTXO vout.value, TRX/TRC20 amount, XRP Amount(string drops), XPLA amount). SOL/SPL 은 transfer 파싱 후(현재 signature-only).
    - **✅ 양쪽 완료**(prototype+monorepo 2026-07-01, 전 비-EVM). monorepo 발산: TRC20 은 range=tron path·confirmationThreshold=trc20 path. UTXO 금액은 bitcoind `vout.value`(BTC 소수 문자열) 그대로 — satoshi 환산 아직(§13).

13. **amount·fee 사토시 통일 + raw_amount/raw_fee_amount (✅ 양쪽 완료)**. **DB `amount`·`fee_amount` = 사토시(8자리 정수)**: `toSatoshi(raw, rawDecimal)` = `BigNumber(raw).shiftedBy(8-rawDecimal).floor`(버림). 원본은 **`raw_amount`·`raw_fee_amount` 컬럼**에 보존(환산 lossy).
    - **amount rawDecimal**: 코인=ParamStore `rawDecimal`(EVM 18/BTC·BCH 8/SOL 9/XLM 7/XRP·TRX·XPLA 6, `AssetService.getRawDecimal()`), 토큰=`main.token.token_decimal`(`TokenRow.rawDecimal`).
    - **fee rawDecimal = 항상 native(base) 자산 scale**(수수료는 base 코인으로 소모). 코인=자기 rawDecimal, **토큰=기반 체인 코인 rawDecimal**. 환산은 tx-scanner `toInsertParams(assetId, rawDecimal, tx, feeRawDecimal)`.
    - blockchain 은 **raw 최소단위 정수** 반환(UTXO=`vout.value` BTC소수→satoshi 정수). 공용 유틸은 `blockchain/crypto-util.ts`(`toSatoshi`, `SATOSHI_DECIMALS`).
    - fee 파싱은 §14(모델)·§15(UTXO)에서 전 체인 완료.
    - **prototype 완료**(2026-07-01): `crypto-util.ts`, ParamStore `getRawDecimal`, `AssetService.getRawDecimal()`, `TokenRow.rawDecimal`, `DetectedTx.feeAmount`, `InsertParams.{rawAmount, feeAmount, rawFeeAmount}`. `bignumber.js` 의존성.
    - **monorepo 완료**(2026-07-07): migration `raw_amount`/`raw_fee_amount`=**VARCHAR(78)**, 기존 `amount`/`fee_amount`=**DECIMAL(65,0) 유지**(사토시 문자열 저장 충분). `crypto-util.ts`(toSatoshi·parseRawDecimal·SATOSHI_DECIMALS) + `AssetService.getRawDecimal()` + `toInsertParams` 환산. atlas migration 2건 — **루트 h1 은 `atlas migrate hash` 로 갱신 권장**.

14. **fee 모델 = "native 자산 별도 행" (✅ 양쪽 완료)**. 수수료는 항상 native 코인이라 **토큰 행엔 fee 안 넣고, 별도 native(코인) 행**(amount=0, fee_amount=gas)으로 기록. 한 tx_id 가 여러 asset_id 행(예: ERC20 전송 → AAA 행(토큰금액,fee null) + ETH 행(amount 0, fee gas)). 유니크 키 `(asset_id, tx_id, tx_index)` 로 공존.
    - **native 스캔 방향별 필터**: `tx.from∈watch`(우리가 originate=fee 소모)면 **value·status 무관 기록**(fee 행; amount=성공 시 value, 실패 시 0), `to∈watch & from∉watch`(수신)이면 value>0 & status===1 만.
    - **실패 tx**: from∈watch 면 `status=0` 로 기록(fee 소모). 실패 token tx 는 로그 없어 getLogs 엔 안 잡히지만 native 스캔의 from∈watch 로 fee 행 생성. `DetectedTx.status`(1/0) 추가, `InsertParams.status`=체인 성공여부.
    - **fee_amount 는 fee-payer∈watch 일 때만**(우리가 낸 것). EVM=tx.from, XRP=tx.Account, XLM=source_account, XPLA=sender(근사).
    - 장점: fee 가 native 행이라 base-coin decimal 배선 불필요. 토큰 fee 별도 처리 불요.
    - **prototype 완료**(2026-07-01): ethereum-common(방향별 필터+status+fee 조건부), XRP/XLM/XPLA fee 조건부. `DetectedTx.status`.
    - **monorepo 완료**(2026-07-07): EVM 방향별+receipt status/fee, TRX(TransferContract 외 originate 도 fee 행, getTransactionInfo — isFrom 일 때만 추가 RPC), SOL(parsed meta.fee, fee-payer=accountKeys[0]), XRP/XLM/XPLA fee-payer∈watch 조건부. 토큰 행 fee 미부착. **XLM 은 Horizon tx 레벨 fee_charged(operation 별 fee-payer 구분 미구현 — 양쪽 동일 best-effort).**
    - **모호점(재검토)**: 양쪽 감시지갑끼리 오가는 tx 의 fee 귀속(fee-payer=from 잠정). **대안(보류)**: 한 tx 1행(`amountFrom/amountTo/rawFrom/rawTo`)? 실패 건 때문에 애매 → **2행이 제일 깔끔**으로 결정(목표=최대한 다 감지·기록, 실패/포워딩 tx 도 기록).
- **fee_amount 나머지 체인**: **TRX 완료**(getTransactionInfo, TriggerSmartContract originate 도 native fee 행). **SOL 완료**(getParsedTransaction meta.fee/err, fee-payer=accountKeys[0]; SPL 전송 fee 도 SOL native 행). **UTXO 는 아래 15**.
15. **UTXO fee + 출금(vin) 감지 (✅ 양쪽 완료, verbosity 3 방식)**. UTXO fee = Σvin − Σvout. vin prevout(값·주소)는 **`getblock` verbosity 3(Core 25+, `vin.prevout` 인라인)** 로 추가 콜 없이 획득 → vin∈watch 면 출금(우리가 fee 냄) → native fee 행(§14). 미지원 노드는 **vin 마다 `getrawtransaction`** fallback. 설정 플래그 `UtxoAssetConfig.prevoutInline`(btc=true, bch=false — EVM usingBatchRequest 개념). fee 행 tx_index=vout 개수(vout 인덱스와 비충돌).
    - **prototype 완료**(2026-07-02): utxo-rpc.client 수신(vout)+출금/fee(vin) + verbosity 3/fallback 분기. rule 1 순수(노드 RPC 만).
    - **monorepo 완료**(2026-07-07): prevoutInline(btc=true, bch=false) + verbosity 3/fallback + 수신·출금/fee 행 + satoshi 정수화 동일 적용. (대규모(BTC) 캐치업은 §17 테이블 O(1) 탐지로 대체 가능 — 선택 최적화로 남김.)
    - **개선사항 — `wallet_scanner_unspents` 테이블**: vin (txid:n) 이 우리 것인지 DB O(1) 조회(네트워크 콜↓, 캐치업 폭발 방지) + vin 값도 보관해 fee 계산. **유지**: 입금 감지 시 unspent 추가, 출금 감지 시 spent 표시(스캐너가 forward 유지). **백필**: 새로 생성한 주소는 잔고 0에서 시작이라 불필요하나, **이미 잔고 있는 주소를 추가하면 기존 UTXO 일회성 스캐닝/import 필요**(별도 프로비저닝 엔드포인트).
16. **SOL/SPL from/to·amount 파싱 (✅ 양쪽 완료)**. SOL/SPL 은 tx 에 금액 필드가 없어 **getParsedTransaction 의 잔고 delta** 로 계산: SOL=`pre/postBalances` 계정별 lamports delta(fee-payer(accountKeys[0]) delta 는 fee 를 빼고 순수 이동분만), SPL=`pre/postTokenBalances`(해당 mint) **owner 별** delta. **최대 감소=from, 최대 증가=to/amount**(단순 전송 기준 휴리스틱). SPL 0금액(이 mint 이동 없음) skip.
    - **tx_index=0 유지 확정**: delta 는 tx 단위 합산이라 tx당 1행 — 과거 "파싱 시 instruction 인덱스로 교체" 계획은 폐기(멱등 키 충돌 없음).
    - 검증: 실 메인넷 3 tx 에서 from/to/amount(lamports)/fee 정확 파싱 확인.
    - **monorepo 완료**(2026-07-07): SOL pre/postBalances delta+fee 분리, SPL mint 필터 owner delta, tx_index=0.
17. **UTXO 원장 테이블 `wallet_scanner_unspents`(wallet DB) (✅ 양쪽 완료 — 백필 엔드포인트만 잔여)**. 감시 주소들의 모든 UTXO 를 wallet DB 에 원장으로 유지. ⚠️ 테이블명 최종 **`wallet_scanner_unspents`** — main DB 의 `crypto_address_unspents`(출금 레거시, outputIndex 등)와 **별개 테이블로 분리 유지**(monorepo 의 기존 `CryptoAddressUnspents` 엔티티는 그대로 둠). 용도: (1) **UTXO 잔고** = `SUM(amount) WHERE usable=1`(노드 RPC 로는 불가 — 주소 인덱스 없음), (2) **vin O(1) 출금 탐지**(대규모 체인에서 prevout 해소 대체 최적화), (3) 출금 시스템 vin 조합 재료.
    - **DDL(MySQL)**:
      ```sql
      CREATE TABLE wallet_scanner_unspents (
        id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        asset_id           INT NOT NULL,                -- wallet_scanner_asset.id (BTC/BCH …)
        address            VARCHAR(128) NOT NULL,       -- UTXO 소유(수신) 주소
        tx_id              VARCHAR(64) NOT NULL,        -- UTXO 생성 tx
        tx_index           INT NOT NULL,                -- vout n (detected_transactions.tx_index 와 동일 어휘)
        amount             BIGINT UNSIGNED NOT NULL,    -- 사토시(8자리 정수)
        usable             TINYINT(1) NOT NULL DEFAULT 1, -- 1=사용가능, 0=소비/예약
        block_number       BIGINT NULL,                 -- 생성 블록 높이
        spent_tx_id        VARCHAR(64) NULL,            -- 소비 tx (usable=0 시)
        spent_block_number BIGINT NULL,
        created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_unspent (asset_id, tx_id, tx_index),
        KEY ix_addr_usable (asset_id, address, usable)
      );
      ```
    - **유지(스캐너 forward)**: 수신 감지(vout∈watch) → INSERT usable=1(유니크로 재스캔 멱등). 소비 감지(vin=우리 outpoint) → usable=0 + spent_tx_id/spent_block_number(미존재 outpoint 는 무시 — 백필 전 과거분). ⚠️ usable 은 출금 시스템이 tx 조합 시 **예약(0)** 용도로도 쓸 수 있음 — 스캐너의 확정 소비 마킹과 의미 구분 필요하면 컬럼 분리(status enum) 검토.
    - **백필(이미 잔고 있는 주소 추가 시)**: **`scantxoutset "start" ["addr(...)"]`**(Core 0.17+)로 현재 살아있는 UTXO 전부 일회 조회(UTXO set 만 스캔 — txindex 불필요, 수십초~수분) → INSERT. 노드 미지원 시 외부 인덱서(Electrum/Esplora) 사용. **블록 1~latest 재스캔은 비현실적(BTC 80만+ 블록) — 만들지 말 것.** 새로 생성한 주소는 잔고 0에서 시작이라 백필 불필요. 일회성 프로비저닝 엔드포인트로(스캐너 루프와 분리).
    - **prototype 완료**(2026-07-02): `UnspentsRepository`(stub, insert/markSpent/sumUsable) + `DetectedTx.utxo{created, spentOutpoints}`(UTXO 스캐너가 채움) + tx-scanner `maintainUnspents`(수신=INSERT, 소비=markSpent) + 백필용 `UtxoRpcClient.scanTxOutset`/`UtxoCommonService.listLiveUtxos`. UTXO getBalance 는 테이블 SUM 이 정답(blockchain 층 미제공 — rule 1).
    - **monorepo 완료**(2026-07-07): migration `20260707120001_add-wallet-scanner-unspents.sql` + 엔티티 `WalletScannerUnspents` + `WalletScannerUnspentsRepository`(walletScannerUnspents.repository.ts, insertUnspent/markSpent/sumUsable) + `TxScannerService.maintainUnspents`. amount=BIGINT UNSIGNED(DDL 대로).
    - **usable 의미(확정)**: 현재 = **스캐너 확정 소비만**(1=미소비, 0=vin 소비 확인+spent_tx_id). 출금 시스템의 예약(soft lock)이 필요해지면 usable 혼용 대신 **status enum(available/reserved/spent) 분리 권장** — 출금 모듈 연동 시 결정(보류 항목).
    - **잔여(monorepo)**: scantxoutset 백필 **HTTP 프로비저닝 엔드포인트**(listLiveUtxos+INSERT 준비됨, 엔드포인트만 별도 작업).

**주의/약속:**
- **wallet-tx-scanner = 트랜잭션 스캐너(입출금 모두)**: "입금 감지"라는 표현이 문서 곳곳에 있으나, 실제로는 **감시 주소의 in/out tx 를 모두** 감지한다(출금=우리가 보낸 것 포함). fee_amount·실패tx 처리는 이 관점(§14) 기준.
- **`scanBlocks` vs `scanTransactions`(monorepo)**: 둘 다 존재. **`scanBlocks`=기존 입금 로직 복사본(레거시, 우리 sync 대상 아님)**, **`scanTransactions`=wallet tx scanning(prototype↔monorepo 동기화 대상)**. 이 문서의 정합/TODO 는 전부 `scanTransactions` 기준. scanBlocks 는 semantic 참고용으로만 인용.
- **DB 엔진 차이(monorepo=MySQL)**: 이 문서의 SQL 표기는 PostgreSQL 편의상 `ON CONFLICT DO NOTHING` 로 적지만, **monorepo 는 MySQL** 이라 실제로는 TypeORM `.orIgnore()`(= `INSERT IGNORE`)로 읽는다(동작 동일). unique index/DDL 문법도 MySQL 기준으로 옮길 것.
- **SOL/SPL 통합 러너(예약, ✅ 양쪽 분리 일치)**: EVM 은 감지 RPC 가 달라(native=블록/receipt, erc20=getLogs) 코인/토큰 분리가 필연이지만, **SOL/SPL 은 감지 방식이 같다**(signature→`getParsedTransaction`, 한 tx 에 native+SPL delta 동시)서 한 루프로 합칠 여지가 있다(`ScanTarget` both-set 예약). **현재 양쪽 다 SOL/SPL 분리 운영(monorepo 확인 완료)** — 통합은 미적용 상태로 둔다. 추후 합칠 경우 선행: (1) getParsedTransaction 파싱, (2) SPL 입금=ATA 서명이라 owner 서명만으론 누락(ATA 열거 필요). 합칠 땐 양쪽 같이.
- **DB 트랜잭션 래핑(monorepo 전용)**: monorepo 는 `saveDetected`/`updateStartBlockNumber` 의 DB 쓰기를 `@InjectTransactionRunner(DATASOURCE_WALLET_SHORT_IDLE)` 의 `walletTransactionRunner.runInTransaction(...)` 으로 감싼다. prototype 은 stub repository(실 DB 없음)라 트랜잭션 래핑 없음 — **의도된 발산**(prototype 에 옮기지 않음).
- **xrp**: prototype 로스터엔 있으나 monorepo `BlockchainService` **미등록**(추후 추가 예정) — 현재 유일한 로스터 차이.
- **nodeUrl**: prototype `nodeUrl` ≡ monorepo path 객체의 자산별 URL 필드(`host`/`gethUrl` 등) — 같은 의미(node RPC 주소)로 취급(§1).
- **숫자값**: `AssetId`/`TokenTypeId` 값은 prototype 로컬값(monorepo 와 달라도 됨). 심볼만 `@gopax/proto` 와 일치(§2).
