# CLAUDE.md — 이 프로젝트에서 항상 지킬 규칙

이 파일은 wallet-tx-scanner 작업 시 **매 세션 항상 따라야 하는 규칙**을 정의한다.
대화 컨텍스트가 유실되어도 여기 적힌 규칙은 계속 유효하다. 규칙이 바뀌면 이 파일을 갱신한다.

## 0. 문서 동기화 (최우선 규칙)
- 구조/모듈/흐름에 영향을 주는 변경을 하면 **반드시 같은 작업에서 [`README.md`](./README.md) 를 갱신**한다.
  - "현재 상태(Progress)" 표, 아키텍처 트리, "변경 이력(Changelog)" 를 최신으로 유지.
- 새 규칙·제약·결정사항이 생기면 이 `CLAUDE.md` 에 추가한다.
- 즉, **코드 변경과 문서 갱신은 한 묶음**이다. 코드만 바꾸고 문서를 두고 가지 않는다.
- **monorepo 연동**: 새 개념/이름/계약이 생기면 [`docs/MONOREPO-MAPPING.md`](./docs/MONOREPO-MAPPING.md) 의 매핑 표를 갱신하고, 커밋 본문에 그 파일의 **"포팅 체크리스트"** 템플릿을 채운다. 회사 쪽은 전체 diff 대신 이 매핑 + 체크리스트로 옮길 수 있어야 한다(토큰 절약).

## 1. 아키텍처 컨벤션
- 모든 기능은 `src/modules/<feature>/` 아래 NestJS 모듈로 둔다.
- 파일 명명: `<name>.module.ts`, `<name>.service.ts`, 인터페이스는 `*.interface.ts`, 타입은 `*.types.ts`, 저장소는 `*.repository.ts`.
- 모듈은 자기 provider 를 `exports` 해서 다른 모듈이 import 해 쓸 수 있게 한다.
- 체인 추상화는 `blockchain` 모듈을 통해서만 접근한다. 다른 모듈이 개별 체인 서비스(SolService 등)를 직접 import 하지 않는다 — `BlockchainService.getAssetService(symbol)` / `getTokenService(symbol)` 를 쓴다.

## 2. blockchain 모듈 규칙
- **`AssetService`(코인) / `TokenService`(토큰) 를 나누는 이유 = 전송 tx 감지 메커니즘이 다르기 때문**이다(나누는 축은 이것 하나뿐). 예: ETH 네이티브는 블록/트랜잭션·receipt 기반, erc20 토큰은 `eth_getLogs` 의 Transfer 이벤트 기반. 그래서 코인/토큰만 분리하고, **한 token_type(예: erc20) 내부에서는 더 쪼개지 않는다** — 같은 감지 방식이므로 한 루프가 그 타입의 컨트랙트 N개(N=0,1,여러개)를 한 번에 처리한다(EVM 은 `getLogs` 에 컨트랙트 배열을 넘겨 1회 호출로 커버; §3-1).
- 네이티브 코인 서비스는 `AssetService` 인터페이스를 구현한다. (ethereum-common, sol, xlm, btc, bch, trx, xrp, xpla, sui)
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
- blockchain 서비스는 코인 `scanTransactions(addresses, cursor)` / 토큰 `scanTransactions(addresses, cursor, contractAddresses[]) → { txs, nextCursor }` 만 제공한다. **어떻게 스캔할지는 자산이 결정**(EVM/BTC/TRX/TRC20/XPLA=블록범위, SOL/SPL=signature, XLM=Horizon+memoId, XRP=ledger account_tx, SUI=checkpoint 범위). cursor 는 자산별 불투명 문자열. 토큰은 `contractAddresses`(이 token_type 의 토큰들)로 그 컨트랙트들의 transfer 만 수집하고, **각 tx 에 `contractAddress` 를 채워** 어느 토큰인지 분류 가능하게 한다(EVM=`address` 필터+`log.address`, SPL=`mint`, TRC20=`contract_address`).
- tx-scanner 는 대상마다 `ScanRunner` 를 하나씩 돌린다(대상별 독립 루프). 현재 run 주기 `scanIntervalMs` 는 전 자산 10s. 죽은/정체 루프는 워치독이 점검·재시작한다(스캔 안 함). **워치독은 `@Cron` 이 아니라 `setInterval`** 로 주기 호출한다(monorepo 는 scheduler_manager 가 등록·호출 — §6). `ScheduleModule` 불필요.
- **토큰은 token_type 당 ScanRunner 1개 — 한 루프로 여러 토큰**: 한 `TokenService`(=token_type)가 **여러 토큰**을 덮는다(예: erc20 타입에 토큰 A·C). tx-scanner 는 `TokenRepository.getTokensByType(tokenTypeId)`(main.token stub)로 그 타입의 토큰 목록 `[{assetId, contractAddress}]` 을 받아 **token_type 당 러너 1개**를 만든다(코인은 자산당 1개). 러너는 한 번 스캔해 나온 tx 를 `contractAddress→asset_id` 로 분류해 각 토큰의 asset_id 로 저장하고, 진행지점은 그 타입의 토큰 행들을 **함께 같은 값으로** 갱신한다(같이 도므로). 토큰마다 쪼개지 않는다.
- `ScanRunner` 의 대상은 `ScanTarget { assetId?, tokenTypeId? }` — **코인은 `{assetId}`, 토큰은 `{tokenTypeId}`**. 둘 중 최소 하나 필수(없으면 생성자 throw). ScanRunner 는 추가로 `contractAddresses`(토큰의 컨트랙트 목록; 코인은 빈 배열)를 받아 토큰 스캔에 넘긴다. 주소 조회는 토큰이면 기반 체인 assetId 로 한다.
- **`ScanTarget` both-set(assetId+tokenTypeId 둘 다)은 "통합 러너" 예약**(현재 미구현, 루프는 항상 코인 또는 토큰 하나로만 라우팅). 취지: **감지 메커니즘이 같은** 코인+토큰을 한 루프로 묶어 루프 수를 줄이는 최적화. 대표 후보 **SOL+SPL** — 둘 다 signature 기반이고 한 `getParsedTransaction` 에 native delta(pre/postBalances)와 SPL delta(pre/postTokenBalances)가 함께 있어 한 번 파싱으로 분리 가능. 반면 **EVM 은 감지 RPC 가 달라(native=블록/receipt, erc20=getLogs) 합칠 수 없다**. 실제 통합은 (1) getParsedTransaction 파싱 선행, (2) SPL 입금은 ATA 서명이라 owner 서명만으론 누락 → ATA 열거 필요, (3) **monorepo 가 SOL/SPL 을 합쳐 도는지 확인 후 정합** 맞춰 결정(매핑 §5).
- tx 저장(`detected_transactions`)과 진행지점 영속화(`wallet_scanner_asset`)는 tx-scanner 책임. blockchain 모듈은 DB 에 의존하지 않는다(규칙 1 유지).
- **스캔 진행 지점 영속화(`startBlockNumber`)**: 과거 "cursor" 개념의 저장값. 저장 위치는 **`wallet_scanner_asset` 테이블**(PK `id` = 코인 main.asset.id / 토큰 자체 asset_id, 한 id 공간 공유; main.asset 메타와 분리). 코인 러너는 시작 시 `getStartBlockNumber(assetId)` 로 읽고 사이클마다 `updateStartBlockNumber(assetId, …)`. **토큰 러너(token_type)는 그 타입의 토큰 행들이 함께 도므로**, 대표(첫 토큰) 행에서 load 하고 save 때 **그 타입의 모든 토큰 행을 같은 값으로** update 한다(at-least-once). 토큰이 자기 id 를 갖기에 KONET 코인 행과 KONET 토큰 행이 분리된다(과거 충돌 — 매핑 §10). (대안: token_type_id 키의 `wallet_scanner_token` 테이블 — 지금은 불필요.) 체인 경계 반환값은 불투명 `cursor`(블록번호/signature/ledger). 현재 `StubWalletScannerAssetRepository`(in-memory) — `WALLET_SCANNER_ASSET_REPOSITORY` 토큰 주입, 실제 DB 교체 시 인터페이스 유지. **stub 은 in-memory 라 재시작 시 초기화.**
- **`DetectedTx` 는 in/out 의미부여를 하지 않는다**: 블록에서 파싱한 `fromAddress`/`toAddress`(+amount/memoId/blockNumber/status)만 담는다(direction/address/counterparty 없음). in/out 해석은 저장/조회 단계에서 지갑 주소와 대조해 한다. 체인별 from/to 를 모를 수 있다(SOL signature-only → 생략).
- **fee 모델 = "native 자산 별도 행"(§14)**: wallet-tx-scanner 는 입출금 **모두** 감지한다(입금 전용 아님). 수수료는 항상 native 코인으로 나가므로 **토큰 행엔 fee 를 넣지 않고**, 수수료는 **별도 native 코인 행**(amount=0, fee_amount=gas)으로 기록한다. 한 tx 가 여러 asset_id 행을 만들 수 있다(ERC20 전송 → 토큰 행 + native fee 행; 유니크 키 `(asset_id, tx_id, tx_index)` 로 공존). native 스캔은 **방향별**: `tx.from∈watch`(우리가 originate=fee 소모)면 value·status 무관 기록(실패 tx 도 `status=0` 로 — fee 소모됨), `to∈watch & from∉watch`(수신)이면 value>0 & 성공만. **`fee_amount` 는 fee-payer 가 우리(watch)일 때만** 채운다(우리가 낸 fee; EVM=tx.from/XRP=Account/XLM=source_account). amount 는 성공 시 value, 실패 시 0.
- **tx 저장**: 별도 매퍼·`TxRepository` 없이 `DetectedTx` 를 그대로 `DetectedTransactionsRepository.insertDetectedTransactions` 로 넣는다(DetectedTx≈DB 컬럼: `txHash→txId`, `amount ?? '0'`, `memoId→note`). 현재 `StubDetectedTransactionsRepository`(콘솔). 코인은 `saveDetected(assetId, txs)` 로 그 코인 assetId. **토큰은 `saveDetectedTokens(contractAddress→assetId 맵, txs)` 로 각 tx 의 `contractAddress` 로 어느 토큰인지 분류해 그 토큰의 asset_id 로 저장**(한 token_type 루프가 여러 토큰을 처리). **멱등 유니크 키 = `(asset_id, tx_id, tx_index)`** — `tx_index`(tx 내 위치: EVM=logIndex, UTXO=vout, 그 외 tx당 1건=0)를 반드시 포함한다(한 tx 가 from/to/amount 까지 같은 transfer 를 여러 건 담을 수 있어, tx_index 없이 걸면 정상 건을 중복으로 눌러 누락). prototype `StubDetectedTransactionsRepository` 는 `(assetId,txId,txIndex)` Set 으로 재삽입을 흡수(실 DB=UNIQUE + `ON CONFLICT DO NOTHING`). **잔고 delta 기반(SOL/SPL/SUI)은 수신자별 행 분리(§20)** — 한 tx 가 여러 수신자에게 보낼 수 있어(배치 출금) '최대 증가 1명=to' 는 누락을 만든다. delta 를 주소별로 계산해 **양수 delta 각각을 행으로**(originate=from/fee-payer∈watch 면 전 수신자, 수신이면 watch 수신자만) 기록하고, `tx_index = 전체 수신자(주소 정렬) 인덱스`(watch 구성과 무관해 재스캔 멱등). fee 는 첫 행에만(행 복수화로 중복 합산 방지), originate 인데 수신 행 0개(실패 tx=gas 만 소모)면 amount=0 단독 행(tx_index=0).
- **UTXO 원장(`wallet_scanner_unspents`, wallet DB — 매핑 §17)**: UTXO 는 노드 RPC 로 주소 잔고를 못 구하므로 감시 주소의 UTXO 를 테이블로 유지한다(잔고=`SUM(usable=1)`, vin O(1) 출금탐지, 출금 vin 조합 재료). **유지는 tx-scanner**(`maintainUnspents`): UTXO 스캐너가 `DetectedTx.utxo{created, spentOutpoints}` 로 알려주면 수신=INSERT(usable=1, `(asset_id,tx_id,tx_index)` 유니크 멱등)/소비=usable=0+spent_tx_id. blockchain 은 DB 안 봄(rule 1). **백필**(잔고 있는 주소 추가 시)은 `scantxoutset`(`UtxoCommonService.listLiveUtxos`) 일회 실행 — 블록 1~latest 재스캔 금지(비현실적).
- **scan range**: 1회 스캔 처리량은 `parameter-store` 의 `getMaxDepositScanRange(path)`(= `getParametersByPath(path).maxDepositScanRange`)로 조회. 필드명은 **`maxDepositScanRange`**(monorepo ParamStore 실제 키와 일치 — `maxScanRange` 아님). 코드 default 없음. **미설정/0이하면 `undefined` 반환 → 노드 미설정과 동일하게 log 후 skip(throw 안 함, 앱 부팅 계속)**. 각 서비스가 `onModuleInit` 에서 노드 URL+range 둘 다 있을 때만 핸들 초기화(둘 중 하나 없으면 그 자산 루프만 조용히 skip). 권장값: EVM/SOL=1000, XLM/XRP=200, BTC/BCH=50, TRX/TRC20=20, XPLA=10 (parameter.json path 별).
- **confirmations (reorg 안전 마진)**: `getConfirmations(path)`(미설정=0). 스캔 끝을 `head` 가 아니라 **`safeHead = head - confirmations`** 로 캡한다(`to = min(from+range-1, safeHead)`, `from > safeHead` 면 skip). 이러면 감지된 tx 는 항상 ≥confirmations 확정 → **confirmations 를 저장/추적할 필요 없음**(스냅샷 X). cursor=null 첫 사이클은 `from=safeHead` 로 시작. **블록높이 기반(EVM/UTXO/TRX/TRC20/XPLA)에 적용.** 즉시확정 체인은: XRP=validated·XLM=ledger close·XPLA=commit 이라 보통 0, **SOL/SPL 은 numeric cap 대신 commitment `finalized`** 로 대체.
- **입금 감지 정확도 필터는 blockchain 층에서**(파싱=실제 일어난 transfer): **성공 여부 필터**는 체인별 지표로 — EVM 네이티브=`getBlock(n,true)` 후보 필터 후 매칭 tx 만 `getTransactionReceipt`→`status===1`(2-phase, getTransaction 불필요; revert 값이동 방지), EVM 토큰=**revert 로그는 `eth_getLogs` 에 안 나옴(로그 존재=성공)** 이라 receipt 불필요, UTXO=블록 포함=유효(불필요), TRX/TRC20=`ret[0].contractRet==='SUCCESS'`(**TRC20 은 로그 아닌 call data 디코드라 필수**), XRP=`meta.TransactionResult==='tesSUCCESS'`, XLM=`successful===true`, SOL/SPL=`sig.err===null`, XPLA=`tx_response.code===0`. **0금액 필터**는 전 체인 공통(value/amount/data>0). EVM 성능: 블록/receipt 는 `usingBatchRequest` 로 JSON-RPC batch/Promise.all 선택. confirmations threshold·금액 scale·in/out 은 위층(tx-scanner) 몫(§5).

## 3-2. 노드 연동 규칙
- 노드 URL·파라미터는 **`parameter-store.ts` 의 async `getParametersByPath(path)`** 모델로 읽는다(monorepo ParamStore 동일). 헬퍼: `getNodeUrlByPath(path)`, `getMaxDepositScanRange(path)`, `getRawDecimal(path)`. 소스: 루트 `parameter.json`(자산별 path 객체 `{ nodeUrl, maxDepositScanRange, rawDecimal }`). **confirmationThreshold 는 ParamStore 에서 제거** — `main.asset.confirm_threshold`(AssetRepository, §19)로 이동. `parameter.json` gitignore(실값), `parameter.example.json` 템플릿. 노드 미설정이면 스캔 skip + `warnMissingNode`. **path 는 monorepo path 와 일치**(예: trx→`tron`, klaytn→`klay`, base(BASEETH)→`base`; 매핑 표 docs/MONOREPO-MAPPING.md §2). 추후 DB/원격 ParamStore 로 교체해도 호출부는 안 바뀐다.
- SDK: EVM=`web3`, SOL/SPL=`@solana/web3.js`, XLM=`@stellar/stellar-sdk`(Horizon), BTC/BCH=bitcoind JSON-RPC(fetch), **TRX/TRC20=`tronweb`, XPLA=Cosmos LCD REST(fetch, `XplaRestClient`), XRP=rippled JSON-RPC(fetch), SUI=`@mysten/sui/grpc`(gRPC 단독 — JSON-RPC 는 2026-07 종료, GraphQL 은 인덱서 스택이라 bare fullnode 에 없음)**. EVM 토큰은 기반 자산의 web3, trc20 은 trx 의 tronweb 을 재사용한다(새 connection 만들지 않음).
- **DB 는 stub 유지**(회사 DB 별도 연결). tx 저장(`detected_transactions`)·진행지점(`wallet_scanner_asset`)·파라미터(`parameter.json`) 모두 인터페이스 유지한 stub — 실제 DB/ParamStore 로 내부만 교체.
- ⚠️ **ESM/CJS 제약**: 빌드가 CommonJS 라 ESM-only deps 와 충돌한다. `@stellar/stellar-sdk` 는 **12.x 고정**(16.x = ESM `@noble/hashes@2` require 실패), `@solana/web3.js` 는 `overrides` 로 `rpc-websockets`→`uuid@9.0.1` 고정. **`xrpl`(XRP 공식 SDK)도 `@noble/hashes@2`(ESM) 를 강제해 모든 버전이 `ERR_REQUIRE_ESM` → SDK 대신 rippled JSON-RPC(fetch) 사용.** **`@xpla/xpla.js` 는 top-level import 만으로 부팅 크래시(`@xpla/xpla.proto` v2 누락) → 제거하고 Cosmos LCD REST(fetch, `XplaRestClient`) 사용.** `tronweb` 은 CJS 정상. **`@mysten/sui` 는 ESM 전용 + tsconfig 가 CJS/node10 이라 (1) `import()` 가 `require()` 로 변환됨 → `new Function("s","return import(s)")` 트릭으로 로드, (2) 타입 임포트는 prototype 에선 `import type … with { 'resolution-mode': 'import' }`(TS 5.3+)로 해결되나 **monorepo 환경에선 그마저 TS1479** → monorepo 는 타입 참조를 제거하고 dynamic import 함수의 반환 타입 추론(`Awaited<ReturnType<typeof createSuiGrpcClient>>`) 사용(동등·환경차, 매핑 §18).** 버전 올릴 때 `npm run build` + 부팅으로 `ERR_REQUIRE_ESM`/크래시 재발 여부 확인.

## 4. 검증 규칙
- 코드 변경 후에는 최소한 `npm run build` 로 타입/DI 구성을 검증한다.
- **포맷/린트 항상 검사**: 코드 변경 후 `npx prettier --check "src/**/*.ts"` 와 `npx eslint "src/**/*.ts"` 를 돌려 통과시킨다. ESLint 가 `plugin:prettier/recommended` 를 써서 **Prettier 위반이 곧 ESLint 에러(에디터 빨간 줄)** 이므로, 위반이 있으면 `npx prettier --write "src/**/*.ts"`(또는 `npm run format`)로 정리한 뒤 마무리한다. 새 파일을 만든 작업은 특히 빠뜨리지 말 것.
- DI 배선이 바뀌었으면 `NestFactory.createApplicationContext(AppModule)` 로 부팅까지 확인한다 (README 의 확인 스니펫 참고).
- "되는 것처럼" 말하지 않는다. 빌드/실행으로 확인한 사실만 보고한다.

## 5. 도메인 메모
- 스캔 대상 주소는 실제로는 DB 에서 조회한다. `Wallet` 은 `{ assetIds:number[], addresses:string[] }` — 식별은 **숫자 assetId**(symbol/HOT·COLD 구분 없음, 감지할 주소면 hot/cold/기타 무관). EVM 동일 주소가 여러 체인을 커버하므로 `assetIds` 는 배열.
- 주소/저장 조회 기준은 **`ScanTarget { assetId?, tokenTypeId? }`**(symbol 아님). `WalletService.getScanAddresses(target)` 는 target → assetId 목록으로 해석(토큰이면 기반 assetId 들 조회, 둘 다면 합집합) 후 주소를 모은다. 저장 assetId 는 `resolveStoreAssetId(target)`.
- tx-scanner 의 책임: 대상 주소의 **모든 in/out tx 를 감지하여 저장**. 자산(AssetService) + 토큰(TokenService) 모두 대상.
- 자산별 특성: EVM=nonce/계정·블록범위, BTC/BCH=UTXO, XLM=memoId 입금 식별, SOL/SPL=mintAddress·빠른 signature 스캔. 이 차이를 blockchain 서비스가 캡슐화한다.

## 6. 숫자/금액 계산 규칙
- **소수점·큰 수 계산은 `bignumber.js` 를 `BigNumber` 로 import 해서 쓴다.** "큰 수"가 모호하면 웬만하면 BigNumber 를 기본으로. `Number` 부동소수점 연산 금지(정밀도 손실). 특정 API 가 `BigInt`/특정 타입을 요구할 때만 그 지점에서 변환.
- **DB 저장 `amount`·`fee_amount` 는 사토시(satoshi, 8자리 정수) 단위로 통일**한다. `blockchain/crypto-util.ts`(공용 유틸)의 **`toSatoshi(raw, rawDecimal)`**(= `BigNumber(raw).shiftedBy(8-rawDecimal).floor`)로 환산(8자리 미만 버림). 원본은 **`raw_amount`·`raw_fee_amount`** 로 보존(환산 lossy). **환산은 tx-scanner(`toInsertParams`)에서** — blockchain 은 raw 최소단위 정수 반환(UTXO 는 satoshi 정수화). **amount rawDecimal**: 코인=ParamStore `rawDecimal`(`AssetService.getRawDecimal()`), 토큰=`main.token.token_decimal`(`TokenRow.rawDecimal`). **fee rawDecimal 은 항상 native(base) 자산 scale**(수수료는 base 코인 소모 — 코인=자기, 토큰=기반 코인). (매핑 §13, prototype 적용 완료.)
