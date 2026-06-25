# CLAUDE.md — 이 프로젝트에서 항상 지킬 규칙

이 파일은 wallet-tx-scanner 작업 시 **매 세션 항상 따라야 하는 규칙**을 정의한다.
대화 컨텍스트가 유실되어도 여기 적힌 규칙은 계속 유효하다. 규칙이 바뀌면 이 파일을 갱신한다.

## 0. 문서 동기화 (최우선 규칙)
- 구조/모듈/흐름에 영향을 주는 변경을 하면 **반드시 같은 작업에서 [`README.md`](./README.md) 를 갱신**한다.
  - "현재 상태(Progress)" 표, 아키텍처 트리, "변경 이력(Changelog)" 를 최신으로 유지.
- 새 규칙·제약·결정사항이 생기면 이 `CLAUDE.md` 에 추가한다.
- 즉, **코드 변경과 문서 갱신은 한 묶음**이다. 코드만 바꾸고 문서를 두고 가지 않는다.

## 1. 아키텍처 컨벤션
- 모든 기능은 `src/modules/<feature>/` 아래 NestJS 모듈로 둔다.
- 파일 명명: `<name>.module.ts`, `<name>.service.ts`, 인터페이스는 `*.interface.ts`, 타입은 `*.types.ts`, 저장소는 `*.repository.ts`.
- 모듈은 자기 provider 를 `exports` 해서 다른 모듈이 import 해 쓸 수 있게 한다.
- 체인 추상화는 `blockchain` 모듈을 통해서만 접근한다. 다른 모듈이 개별 체인 서비스(SolService 등)를 직접 import 하지 않는다 — `BlockchainService.getAssetService(symbol)` / `getTokenService(symbol)` 를 쓴다.

## 2. blockchain 모듈 규칙
- 네이티브 코인 서비스는 `AssetService` 인터페이스를 구현한다. (ethereum-common, sol, xlm, btc, bch, trx, xrp, xpla)
- 토큰 서비스는 `TokenService` 인터페이스를 구현한다. (ethereum-token-common, spl, trc20)
- **스캔 계약은 `AssetService`/`TokenService` 인터페이스가 강제한다**: `getAssetId()`/`getTokenTypeId()`(숫자 id) + symbol + scanIntervalMs + scanTransactions. 별도 `Scannable` 추상화를 두지 않는다 — 여기 자산은 모두 스캔 대상이므로 인터페이스 자체가 계약이다. `ScanRunner` 는 `AssetService | TokenService` 합집합을 받는다.
- **식별은 숫자 id 가 1차 키**다. `blockchain/constants.ts` 의 `AssetId`(자산)/`TokenTypeId`(토큰) **단일 enum** 이 전 체인을 커버한다(심볼 문자열 매핑 금지). 각 서비스는 `getAssetId()`/`getTokenTypeId()` 로 자기 id 를 노출하고, `BlockchainService` 는 그 값을 키로 `Map<number, …>` 에 등록·조회한다(`getAssetService(assetId)` / `getTokenService(tokenTypeId)`). symbol 은 로깅용 보조값(지갑/저장 조회도 id 기준). NOTE: id 값은 실제 DB 의 assetId/tokenTypeId 와 일치시킬 예정.
- 노드 미설정 경고는 서비스마다 따로 만들지 말고 **`node-config.ts` 의 `warnMissingNode(logger, envKey)` 공용 헬퍼**를 쓴다(envKey 별 1회 경고). 과거의 서비스별 `warnNoNode`/`warnIfNoNode` + `warnedNoNode` 플래그 보일러플레이트는 제거됨.
- 새 체인/토큰 추가 시:
  1. `src/modules/blockchain/<chain>/` 에 `<chain>.module.ts` + `<chain>.service.ts` 생성 (해당 인터페이스 implements).
  2. `constants.ts` 의 `AssetId`/`TokenTypeId` 에 항목 추가 + 서비스에 `getAssetId()`/`getTokenTypeId()` 구현.
  3. `BlockchainModule` 의 `imports` 에 모듈 추가하고 `BlockchainService` 생성자에 주입(맵 등록은 `getAssetId()`/`getTokenTypeId()` 키로 자동).
  4. README 아키텍처 트리와 supported 목록 갱신.

## 2-1. EVM 멀티 네트워크 규칙 (ethereum-common / ethereum-token-common)
- EVM 계열은 네트워크마다 노드가 다르므로 **네트워크(assetId)당 service 인스턴스를 분리**한다. (단일 인스턴스에 레지스트리 통째로 넣지 않는다)
- 등록은 **옵션 4**: id 당 `*_${id}` 토큰으로 개별 provider 등록 + 같은 인스턴스들을 배열 토큰(`ETHEREUM_COMMON_SERVICES` / `ETHEREUM_TOKEN_COMMON_SERVICES`)으로 묶어 export.
  - 개별 토큰의 **목적은 Nest lifecycle 자동 관리뿐**이다. 직접 inject 금지, `exports` 에도 넣지 않는다.
  - 사용처는 **배열만 주입**받아 `find` 로 고른다: `find((s) => s.getAssetId() === assetId)` / `find((s) => s.getTokenTypeId() === tokenTypeId)`. 그래서 각 서비스는 `getAssetId()`/`getTokenTypeId()` 접근자를 노출한다.
- 각 인스턴스는 루프를 갖지 않는다(무한 루프 주체는 tx-scanner — 규칙 3-1). 대신 **노드 핸들(web3 등)은 `onModuleInit` 에서 초기화**한다 — 생성자 금지. 옵션4 의 개별 provider 가 이 lifecycle 자동 호출용이다(수동 호출 금지, Nest 가 관리).
- 식별자는 **숫자 id**(`constants.ts` 의 `AssetId`/`TokenTypeId`)다. EVM 레지스트리(`ethereumBasedAssets`/`ethereumBasedTokens`)의 키도 이 id 의 EVM 부분집합(`AssetId.ETH` 등)을 쓴다 — EVM 전용 enum 을 따로 두지 않는다.
- 토큰은 기반 자산 위에 있다: `ethereumBasedTokens[tokenTypeId] = { ...ethereumBasedAssets[baseAssetId], baseAssetId, tokenName }`. 토큰 service 는 새 노드를 만들지 말고 **`ETHEREUM_COMMON_SERVICES` 배열을 주입받아 `baseAssetId` 로 기반 `EthereumCommonService` 를 찾아 재사용**한다. (token 모듈은 `EthereumCommonModule` 을 import)
- 새 EVM 자산 추가 = `AssetId` 에 항목 + `ethereumBasedAssets` 한 줄. 새 토큰 추가 = `TokenTypeId` 에 항목 + `ethereumBasedTokens` 한 줄. provider/사용처는 자동 확장된다.

## 2-2. 공용 엔진 모듈 규칙 (utxo-common / trx 재사용)
- **공통 스캔 로직은 자산별 파일에 흩지 말고 `*-common` 모듈로 모은다.** blockchain 루트에 `utxo-rpc.scanner.ts` 같은 단발 파일을 두지 않는다(혼란). 루트에는 `blockchain.*.ts` + `node-config.ts` + `interfaces/` 정도만.
- **UTXO(btc/bch)**: 공용 엔진 `UtxoCommonService`(무상태) + 저수준 `UtxoRpcClient`(bitcoind JSON-RPC, fetch) 를 `utxo-common/` 에 둔다. 자산별 노드 URL 이 다르므로 엔진은 호출 시 `UtxoAssetConfig{ symbol, rpcEnvKey, batchSize }` 를 받아 동작(클라이언트는 envKey 별 lazy 캐싱). `btc`/`bch` 모듈은 `UtxoCommonModule` 을 import 하고 `UtxoCommonService` 를 **주입받아** 자기 config 로 위임만 한다(서비스는 얇은 껍데기).
- **토큰의 기반 자산 재사용**: trc20 은 새 노드를 만들지 말고 `TrxModule` 을 import 해 `TrxService` 를 주입받아 그 tronweb 을 재사용한다(EVM 토큰이 `EthereumCommonService` 재사용하는 것과 동일 원칙).
- 새 공용 계열 추가 시 이 패턴(공용 엔진 모듈 + 얇은 자산 서비스, 또는 기반 자산 주입)을 따른다.

## 2-3. 자산 서비스 구조 규칙 (state + onModuleInit)
흩뿌려진 `this.XX` 필드를 줄이고 노드 초기화를 일관되게 한다. (기준 예: `ethereum-common.service.ts`)
- **런타임 상태는 `private readonly state` 한곳에 모은다.** 네트워크 설정·노드 핸들(web3/connection/client) 등 "도는 동안 필요한 값"은 `state` 에 둔다. 상태 타입은 `interface <Name>State` 로 명시.
- **`logger` 는 state 밖에 따로** 둔다(로깅은 상태가 아니라 횡단 관심사). `scanIntervalMs`(인터페이스 계약)·`batchSize`(상수)·식별자(assetId 등)도 state 밖 필드로 둔다.
- **노드 핸들은 `onModuleInit` 에서 비동기 초기화**한다(생성자에서 만들지 않는다). 생성자는 동기 작업(설정 로드, logger 구성)만.
- **노드 URL 조회는 `async`** 다: `private async resolveNodeUrl(): Promise<string|undefined>` → `parameter-store.ts` 의 `getParameter`/`getNodeUrl`(현재 `parameter.json` → env 폴백, 추후 DB/원격 설정으로 교체). 호출부는 항상 `await`. 미설정이면 핸들 undefined → 스캔 skip(+`warnMissingNode`).
- 새/기존 자산 서비스는 이 구조를 따른다. **적용 완료**: ethereum-common, sol, xlm, trx, xrp, xpla, spl(노드 핸들 보유), ethereum-token-common(state 그룹화). btc/bch/trc20 은 자체 핸들이 없어(공용 엔진/기반 자산 재사용) state·onModuleInit 불필요 — `getAssetId()`/`getTokenTypeId()` 만 노출.

## 3. 껍데기(stub) 규칙
- DB·외부 RPC 등 아직 연동 안 한 부분은 **껍데기로 두되, 흐름은 실제처럼 연결**한다.
- 껍데기 메서드는 호출 사실을 알 수 있도록 `console.log` (또는 Nest `Logger`) 를 남기고, 고정값/빈 배열을 반환한다.
- 껍데기에는 `NOTE:` 주석과 `TODO(DB):` / `TODO(RPC):` 같은 마커를 달아 나중에 교체 지점을 찾기 쉽게 한다.
- 껍데기 → 실제 구현 교체 시 **외부 인터페이스(시그니처)는 유지**해 호출부가 안 바뀌게 한다.

## 3-1. 스캔 책임 경계 규칙
- **무한 루프의 주체는 tx-scanner** 다. blockchain 서비스는 루프를 갖지 않는다(과거 EVM 서비스의 in-service 루프는 제거됨).
- blockchain 서비스는 `scanTransactions(addresses, cursor) → { txs, nextCursor }` 만 제공한다. **어떻게 스캔할지는 자산이 결정**(EVM/BTC/TRX/TRC20/XPLA=블록범위, SOL/SPL=signature, XLM=Horizon+memoId, XRP=ledger account_tx). cursor 는 자산별 불투명 문자열.
- tx-scanner 는 대상마다 `ScanRunner` 를 하나씩 돌린다(대상별 독립 루프, `scanIntervalMs` 로 cadence 분리). 죽은/정체 루프는 `@Cron` 워치독이 점검·재시작한다(워치독은 스캔 안 함). `@Cron` 은 `ScheduleModule.forRoot()`(AppModule) 필요.
- `ScanRunner` 의 대상은 `ScanTarget { assetId?, tokenTypeId? }` — **둘 중 최소 하나 필수**(둘 다 없으면 생성자에서 throw). 보통 자산은 `{assetId}`, 토큰은 `{tokenTypeId}` 로 1개씩 돈다. **둘 다 지정 = 한 스캔으로 자산+토큰 동시 감지(통합 러너)** 여지를 위한 것(예: SOL ownerAddress + SPL ATA 를 한 번에). 현재는 단일 식별만 사용.
- 저장(`TxRepository`)과 cursor 영속화는 tx-scanner 책임. blockchain 모듈은 DB 에 의존하지 않는다(규칙 1 유지).
- **cursor 영속화**: `ScanRunner` 는 시작 시 `CursorStore.load(key)` 로 마지막 지점을 읽고, 사이클마다 `save(key, cursor)` 한다(재시작/워치독 재가동 시 이어서 스캔, at-least-once). key 는 `ScanTarget` 기반(`asset:<id>`/`token:<id>`). 현재 구현은 `JsonCursorStore`(`.data/cursors.json`) stub — `CURSOR_STORE` 토큰으로 주입하며, 실제 DB 로 교체 시 `CursorStore` 인터페이스만 유지하면 된다.

## 3-2. 노드 연동 규칙
- 노드 접속 URL/자격증명은 **`parameter-store.ts` 의 async `getParameter`/`getNodeUrl`** 로 읽는다(현재 소스: 루트 `parameter.json` → 없으면 `process.env`/`.env` 폴백). `parameter.json` 은 gitignore(실값), `parameter.example.json` 은 템플릿. 설정이 없으면 해당 자산은 **스캔 skip + warn**(`warnMissingNode`). 추후 DB/원격 ParamStore 로 교체해도 호출부(서비스의 `resolveNodeUrl`)는 안 바뀐다(async 유지). 새 자산도 이 패턴을 따른다.
- SDK: EVM=`web3`, SOL/SPL=`@solana/web3.js`, XLM=`@stellar/stellar-sdk`(Horizon), BTC/BCH=bitcoind JSON-RPC(fetch), **TRX/TRC20=`tronweb`, XPLA=`@xpla/xpla.js`(Cosmos LCD), XRP=rippled JSON-RPC(fetch)**. EVM 토큰은 기반 자산의 web3, trc20 은 trx 의 tronweb 을 재사용한다(새 connection 만들지 않음).
- **DB 는 stub 유지**(회사 DB 별도 연결). tx 저장(`TxRepository`)·cursor 영속화(`JsonCursorStore`=`.data/cursors.json`)·파라미터(`parameter.json`) 모두 인터페이스 유지한 stub — 실제 DB/ParamStore 로 내부만 교체.
- ⚠️ **ESM/CJS 제약**: 빌드가 CommonJS 라 ESM-only deps 와 충돌한다. `@stellar/stellar-sdk` 는 **12.x 고정**(16.x = ESM `@noble/hashes@2` require 실패), `@solana/web3.js` 는 `overrides` 로 `rpc-websockets`→`uuid@9.0.1` 고정. **`xrpl`(XRP 공식 SDK)도 `@noble/hashes@2`(ESM) 를 강제해 모든 버전이 `ERR_REQUIRE_ESM` → SDK 대신 rippled JSON-RPC(fetch) 사용.** `tronweb`/`@xpla/xpla.js` 는 CJS 정상. 버전 올릴 때 `npm run build` + 부팅으로 `ERR_REQUIRE_ESM` 재발 여부 확인.

## 4. 검증 규칙
- 코드 변경 후에는 최소한 `npm run build` 로 타입/DI 구성을 검증한다.
- **포맷/린트 항상 검사**: 코드 변경 후 `npx prettier --check "src/**/*.ts"` 와 `npx eslint "src/**/*.ts"` 를 돌려 통과시킨다. ESLint 가 `plugin:prettier/recommended` 를 써서 **Prettier 위반이 곧 ESLint 에러(에디터 빨간 줄)** 이므로, 위반이 있으면 `npx prettier --write "src/**/*.ts"`(또는 `npm run format`)로 정리한 뒤 마무리한다. 새 파일을 만든 작업은 특히 빠뜨리지 말 것.
- DI 배선이 바뀌었으면 `NestFactory.createApplicationContext(AppModule)` 로 부팅까지 확인한다 (README 의 확인 스니펫 참고).
- "되는 것처럼" 말하지 않는다. 빌드/실행으로 확인한 사실만 보고한다.

## 5. 도메인 메모
- 스캔 대상 주소는 실제로는 DB 에서 조회한다. `Wallet` 은 `{ assetIds:number[], addresses:string[] }` — 식별은 **숫자 assetId**(symbol/HOT·COLD 구분 없음, 감지할 주소면 hot/cold/기타 무관). EVM 동일 주소가 여러 체인을 커버하므로 `assetIds` 는 배열.
- 주소/저장 조회 기준은 **`ScanTarget { assetId?, tokenTypeId? }`**(symbol 아님). `WalletService.getScanAddresses(target)` 는 target → assetId 목록으로 해석(토큰이면 기반 assetId 들 조회, 둘 다면 합집합) 후 주소를 모은다. `TxRepository.saveMany(target, txs)` 도 동일 기준.
- tx-scanner 의 책임: 대상 주소의 **모든 in/out tx 를 감지하여 저장**. 자산(AssetService) + 토큰(TokenService) 모두 대상.
- 자산별 특성: EVM=nonce/계정·블록범위, BTC/BCH=UTXO, XLM=memoId 입금 식별, SOL/SPL=mintAddress·빠른 signature 스캔. 이 차이를 blockchain 서비스가 캡슐화한다.
