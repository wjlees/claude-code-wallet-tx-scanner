# wallet-tx-scanner

지정된 지갑 주소(hotwallet / coldwallet)의 모든 온체인 트랜잭션을 감지하여 저장하는 NestJS 서비스.

> 📌 **이 문서는 살아있는 진행상황 문서입니다.** 대화 컨텍스트가 유실되어도 이어서 개발할 수 있도록, 작업이 진행될 때마다 함께 갱신합니다. 항상 지켜야 할 개발 규칙은 [`CLAUDE.md`](./CLAUDE.md)를 참고하세요.

---

## 현재 상태 (Progress)

| 영역 | 상태 | 비고 |
|------|------|------|
| NestJS 초기화 | ✅ 완료 | Nest 10.x |
| blockchain 모듈 | ✅ 완료 | AssetService / TokenService 인터페이스 + 체인별 구현 (껍데기). 자산 11 + 토큰 4 |
| wallet 모듈 (DB 껍데기) | ✅ 완료 | 고정 stub 주소 반환. DB 미연동 |
| tx-scanner 모듈 | ✅ 완료 | **자산별 독립 무한 루프 + cron 워치독**. scanTransactions 호출 → 저장(껍데기) |
| 자산별 scanTransactions | ✅ 완료 | EVM/BTC/TRX/TRC20/XPLA=블록범위, SOL/SPL=signature, XLM=Horizon, XRP=account_tx. cursor 기반 |
| 실제 노드 SDK 연동 | ✅ 완료 | EVM=web3, SOL/SPL=@solana/web3.js, XLM=@stellar/stellar-sdk, BTC/BCH·XRP·XPLA=JSON-RPC/REST(fetch), TRX/TRC20=tronweb. 노드 URL·scan range는 `parameter.json`(→env)에서 **async** 조회. 노드 URL 없으면 skip, scan range 는 필수(없으면 throw) |
| 스캔 진행 지점 영속화 | ✅ 완료(stub) | `WalletScannerAssetRepository` → `wallet_scanner_asset.start_block_number`(=과거 cursor). 현재 in-memory stub — **DB 로 교체 예정** |
| DB 연동 | ⬜ 미착수(의도) | wallet / tx(`detected_transactions`) / 진행지점(`asset`) 모두 stub, parameter 는 JSON — **회사 DB/ParamStore 로 교체 예정** |

> ⚠️ "껍데기(stub)" = 인터페이스/흐름만 구현하고 내부는 `console.log` + 고정값 반환. 실제 로직은 추후 구현.

---

## 아키텍처

```
src/
├── app.module.ts                    # 루트. BlockchainModule, TxScannerModule import
└── modules/
    ├── blockchain/                  # 체인 추상화 레이어 (외부에서 import 해서 사용)
    │   ├── blockchain.module.ts
    │   ├── blockchain.service.ts    # 숫자 id(AssetId/TokenTypeId)로 AssetService/TokenService 조회
    │   ├── constants.ts             # AssetId / TokenTypeId enum (전 체인 단일 소스)
    │   ├── parameter-store.ts       # getParametersByPath(path) — path별 {nodeUrl,maxDepositScanRange} 조회 (parameter.json, DB 교체 예정)
    │   ├── node-config.ts           # warnMissingNode (노드 미설정 1회 경고)
    │   ├── interfaces/
    │   │   ├── asset.interface.ts    # AssetService (네이티브 코인): scanTransactions + scanIntervalMs
    │   │   ├── token.interface.ts    # TokenService (토큰): scanTransactions + scanIntervalMs
    │   │   └── scan.types.ts         # DetectedTx, ScanResult(txs + nextCursor 불투명 커서)
    │   ├── ethereum-common/          # AssetService. EVM 멀티 네트워크, 네트워크당 인스턴스
    │   │   ├── ethereum-common.module.ts # 옵션4: 개별 provider + 배열 aggregate(ETHEREUM_COMMON_SERVICES)
    │   │   ├── ethereum-common.service.ts # assetId당 1인스턴스. scanTransactions=블록범위 2-phase(getBlock hydrated+매칭건 receipt status===1, value>0), confirmations cap, usingBatchRequest 로 batch/promise 선택
    │   │   └── ethereum-based-assets.ts  # EthereumBasedAssetType(+usingBatchRequest) + ethereumBasedAssets/Ids(konet/klay/cross/base) + path
    │   ├── sol/                      # AssetService. signature 페이징 스캔, 빠른 cadence(500ms)
    │   ├── xlm/                      # AssetService. Horizon /accounts + memoId, cursor=paging_token
    │   ├── utxo-common/              # BTC/BCH 공용 UTXO 엔진 (btc/bch가 import+주입)
    │   │   ├── utxo-common.module.ts # UtxoCommonService provider/export
    │   │   ├── utxo-common.service.ts # 무상태 엔진. UtxoAssetConfig(rpcEnvKey/batchSize) 받아 동작, 클라 lazy 캐싱
    │   │   └── utxo-rpc.client.ts     # 저수준 bitcoind JSON-RPC 클라이언트(fetch)
    │   ├── btc/                      # AssetService(얇음). UtxoCommonService 주입, BITCOIN_RPC_URL 위임
    │   ├── bch/                      # AssetService(얇음). UtxoCommonService 주입, BCH_RPC_URL 위임
    │   ├── trx/                      # AssetService. Tron(tronweb). 블록범위 TransferContract 매칭
    │   ├── xrp/                      # AssetService. rippled JSON-RPC(fetch). account_tx, cursor=ledger index
    │   │   ├── xrp.service.ts
    │   │   └── xrp-rpc.client.ts      # rippled JSON-RPC 클라이언트(fetch, xrpl SDK는 ESM 충돌로 미사용)
    │   ├── xpla/                     # AssetService. XPLA Cosmos LCD REST(fetch). 블록범위 transfer 이벤트
    │   │   ├── xpla.service.ts
    │   │   └── xpla-rest.client.ts    # Cosmos LCD REST 클라이언트(@xpla/xpla.js 는 부팅 크래시라 미사용)
    │   ├── ethereum-token-common/    # TokenService. tokenTypeId당 인스턴스, 기반 자산 노드 재사용
    │   │   ├── ethereum-token-common.module.ts # 옵션4 + EthereumCommonModule import + ETHEREUM_TOKEN_COMMON_SERVICES
    │   │   ├── ethereum-token-common.service.ts # tokenTypeId당 1인스턴스. scanTransactions(Transfer 로그). baseAssetId 매칭
    │   │   └── ethereum-based-tokens.ts  # TokenTypeId(ERC20/KIP7) + baseAssetId + tokenName, 기반 자산 설정 스프레드
    │   ├── spl/                      # TokenService. 토큰계정 signature 스캔(mintAddress), 빠른 cadence
    │   └── trc20/                    # TokenService. TrxModule import → TrxService(tronweb) 재사용. transfer 디코드
    ├── wallet/                      # 스캔 대상 지갑 제공 (DB 껍데기)
    │   ├── wallet.module.ts
    │   ├── wallet.service.ts         # getScanAddresses(ScanTarget)→assetIds 해석→주소. 현재 고정 stub
    │   └── wallet.types.ts           # Wallet { assetIds:number[], addresses:string[] }
    └── tx-scanner/                  # 핵심: 무한 루프 주체 + tx 감지 + 저장
        ├── tx-scanner.module.ts      # BlockchainModule + WalletModule import, repository provider(stub)들
        ├── tx-scanner.service.ts     # 코인=자산당 / 토큰=token_type당 ScanRunner 생성·구동 + setInterval 워치독 + saveDetected/saveDetectedTokens(contractAddress→asset_id 분류)
        ├── scan-runner.ts            # 대상 1개의 독립 무한 루프(cursor load/save/sleep/graceful stop, 토큰은 contractAddresses 목록 전달)
        ├── token.repository.ts       # main.token stub: token_type → [{assetId, contractAddress}] (토큰마다 자기 asset id)
        ├── wallet-scanner-asset.repository.ts # wallet_scanner_asset.start_block_number(진행 지점) 인터페이스 + in-memory stub
        └── detected-transactions.repository.ts # detected_transactions 저장 인터페이스 + stub(멱등 (asset_id,tx_id,tx_index) dedup 시연)
```

> 참고: 워치독은 `@Cron`(ScheduleModule) 대신 `TxScannerService` 의 `setInterval` 로 돈다(monorepo 는 scheduler_manager). 저장은 매퍼/TxRepository 없이 `saveDetected` 가 직접 한다(DetectedTx≈DB 컬럼).

### 데이터 흐름 (tx 스캔)

```
TxScannerService.onModuleInit()
  → BlockchainService.getAllAssetServices() / getAllTokenServices()  # 전 서비스 수집
  → 서비스마다 ScanRunner 1개 생성 후 start()   # 대상별 독립 무한 루프
       루프 시작: startBlockNumber = WalletScannerAssetRepository.getStartBlockNumber(assetId)  # resume
       각 루프 반복:
         → WalletService.getScanAddresses(target)            # target→assetIds→주소 (DB 껍데기)
         → service.scanTransactions(addresses, startBlockNumber) # from/to 파싱(in/out 의미부여 X), 반환=불투명 nextCursor
         → saveDetected(assetId, detectedTxs)                # DetectedTransactionsRepository 직접 저장 (매퍼 없음)
         → updateStartBlockNumber(assetId, nextCursor)       # wallet_scanner_asset.start_block_number 갱신(stub)
         → service.scanIntervalMs(=10s) 만큼 대기
  setInterval(60s) watchdog()  # 죽은/정체된 루프 점검·재시작 (스캔 안 함, @Cron 아님)
```

---

## 스캔 전략 (결정됨): 자산별 독립 무한 루프 + cron 워치독

**무한 루프의 주체는 tx-scanner**다. blockchain 서비스는 "스캔해서 tx 돌려주는" `scanTransactions(addresses, cursor)` 만 제공하고, 어떻게 스캔할지는 자산이 알아서 한다.

- **대상별 독립 루프**: 대상마다 `ScanRunner` 를 하나씩 돌린다(HOL blocking 방지). run 주기 `scanIntervalMs` 는 현재 전 자산 **10s** 통일.
- **워치독(안전망)**: 무한 루프가 죽으면 조용히 멈출 수 있어, `setInterval(60s)` 가 각 루프의 생존/정체를 점검해 재시작한다(스캔 안 함). **`@Cron` 아님** — monorepo 는 scheduler_manager 가 등록·호출.
- **진행지점 기반 증분**: 각 루프는 `wallet_scanner_asset.start_block_number`(불투명 값) 이후만 스캔. 재시작 후 이어서 진행(at-least-once).

#### 왜 이 조합인가 (대안 비교)
- **스케줄러 단독**: 구현 단순하지만 실시간성↓ → 탈락.
- **단일 무한 루프(전 자산 한 루프)**: 느린 체인이 빠른 체인을 막음(HOL blocking) → 탈락.
- **자산별 무한 루프 단독**: 좋지만 루프가 죽으면 복구 수단이 없음.
- **→ 채택: 대상별 무한 루프(평소) + 주기 워치독(복구).**

### 자산별 스캔 방식 요약 (run 주기 scanIntervalMs = 전부 10s)
| 자산 | scanTransactions 방식 | cursor 의미 |
|------|------|------|
| konet/klay/cross/base (EVM) | 블록 범위 순회, tx.from/to 매칭 | 블록번호 |
| kip7/konetToken/baseToken (EVM 토큰) | `eth_getLogs` Transfer 필터, 기반 자산 노드 재사용 | 블록번호 |
| BTC/BCH (UTXO) | 블록 범위 vout 수신 매칭(공용 UtxoCommonService) | 블록번호 |
| SOL | 주소별 `getSignaturesForAddress` 페이징(signature-only, from/to 미파싱) | signature |
| SPL | 토큰계정 signature 페이징(signature-only) | signature |
| XLM | Horizon `/accounts/{addr}/transactions` + memoId | paging_token |
| TRX | 블록 범위 TransferContract from/to 매칭(tronweb) | 블록번호 |
| TRC20 | 블록 범위 TriggerSmartContract transfer 디코드(trx 노드 재사용) | 블록번호 |
| XRP | 주소별 `account_tx` ledger 범위(rippled JSON-RPC) | ledger index |
| XPLA | 블록 범위 Cosmos `transfer` 이벤트 매칭(LCD REST) | 블록높이 |

> 노드 RPC 메서드 상세 근거는 [`docs/fetching-transactions-by-node.md`](./docs/fetching-transactions-by-node.md).

### 노드 연동(SDK) & 설정
각 자산은 실제 SDK 또는 노드 JSON-RPC 로 접속한다. **노드 URL·scan range 는 [`parameter-store.ts`](./src/modules/blockchain/parameter-store.ts) 의 async `getParametersByPath(path)`** 로 읽는다(monorepo ParamStore 동일 모델) — 소스는 루트 `parameter.json`(gitignore, 템플릿 [`parameter.example.json`](./parameter.example.json))의 **자산별 path 객체** `{ nodeUrl, maxDepositScanRange }`. path 는 monorepo path 와 일치(예: trx→`tron`, klaytn→`klay`). **노드 URL 또는 maxDepositScanRange 가 없으면 해당 자산 스캔 skip**(throw 안 함, 앱 부팅 계속). 추후 DB/원격 ParamStore 로 교체해도 호출부는 안 바뀐다.

| 자산 | SDK/연동 | 파라미터 키 (parameter.json / env) |
|------|-----|--------|
| EVM (konet/klay/cross/base) | `web3` | path: `konet`/`klay`/`cross`/`base` |
| EVM 토큰 (erc20/kip7) | (기반 자산 web3 재사용) | 기반 자산 env |
| SOL / SPL | `@solana/web3.js` | `SOLANA_RPC_URL` |
| XLM | `@stellar/stellar-sdk` (Horizon) | `STELLAR_HORIZON_URL` |
| BTC / BCH | bitcoind JSON-RPC (내장 fetch) | `BITCOIN_RPC_URL` / `BCH_RPC_URL` |
| TRX / TRC20 | `tronweb` (TRC20 은 TRX 노드 재사용) | `TRON_RPC_URL` |
| XRP | rippled JSON-RPC (내장 fetch) | `XRP_RPC_URL` |
| XPLA | Cosmos LCD REST (내장 fetch) | `XPLA_LCD_URL` |

> 노드 확인됨: ETH/POL/KLAY=publicnode·kaia, KONET=api.kon-wallet.com, SOL=publicnode, XLM=horizon.stellar.org, TRX=api.trongrid.io, XRP=s1.ripple.com:51234, XPLA=dimension-lcd.xpla.dev. **노드 없음(자체 노드 필요)**: BTC/BCH(bitcoind JSON-RPC).

⚠️ **의존성 제약(중요)**: NestJS 빌드가 CommonJS 라 ESM-only 최신 deps 와 충돌한다.
- `@stellar/stellar-sdk` 는 **12.x 로 고정**(16.x 는 ESM-only `@noble/hashes@2` 를 require 해서 CJS 에서 `ERR_REQUIRE_ESM`).
- `@solana/web3.js` 는 `rpc-websockets` 가 끌어오는 ESM `uuid@14` 때문에 깨져서, `package.json` `overrides` 로 `rpc-websockets` 의 `uuid` 를 `9.0.1` 로 고정.
- **XRP 공식 SDK `xrpl` 은 사용 불가**: v2~v5 모두 `@xrplf/isomorphic` → `@noble/hashes@2`(ESM-only) 를 강제해 `ERR_REQUIRE_ESM`. 그래서 SDK 대신 **rippled JSON-RPC(fetch)** 로 구현.
- **XPLA 공식 SDK `@xpla/xpla.js` 도 사용 불가**: top-level import 만으로 `@xpla/xpla.proto` v2 누락으로 **부팅 크래시**. 제거하고 **Cosmos LCD REST(fetch, `XplaRestClient`)** 로 구현(`query=tx.height%3D{h}`, SDK 0.50 형식). (`tronweb` 은 CJS 정상)

## ethereum-common = EVM 멀티 네트워크 (네트워크당 인스턴스 분리)

`ethereum-common` 은 단일 체인이 아니라 **EVM 계열 네트워크 묶음**(ETH, POLYGON, KLAY, KONET ...)을 공통 로직으로 처리한다.
- 네트워크별 차이는 [`ethereum-based-assets.ts`](./src/modules/blockchain/ethereum-common/ethereum-based-assets.ts) 의 `EthereumBasedAssetType`(`networkName`, `EIP1559`, `hardfork?`, `assetName`) + `ethereumBasedAssets` 레지스트리(키 = **`AssetId` 의 EVM 부분집합**, [`constants.ts`](./src/modules/blockchain/constants.ts))로 표현. `ethereumBasedAssetIds`(number[]) 로 전체 id 목록을 노출. (assetId 는 실제 DB asset id 와 일치시킬 예정)
- **네트워크마다 노드가 다르므로 service 인스턴스를 분리**한다. 각 네트워크 = `EthereumCommonService` 인스턴스 1개, 생성자에 `assetId` 주입. 노드 web3 는 `onModuleInit` 에서 초기화(런타임 상태는 `state` 에 그룹화).
- ⚠️ `EIP1559`/`hardfork`/`assetName` 값은 잠정값 — 네트워크별 확인 후 확정 필요(TODO).

### 등록 방식 = 옵션 4 (개별 provider + 배열 aggregate)
[`ethereum-common.module.ts`](./src/modules/blockchain/ethereum-common/ethereum-common.module.ts):
- assetId 당 `EthereumCommonService_${assetId}` 토큰으로 **개별 provider 등록**. 이 개별 토큰은 **네트워크당 인스턴스를 만들고 Nest lifecycle 에 태우기 위한 것**이다(향후 서비스에 lifecycle 훅이 생겨도 자동 관리됨) — 직접 inject 해서 쓰지 않으며 `exports` 에도 넣지 않는다.
- 같은 인스턴스들을 `ETHEREUM_COMMON_SERVICES`('EthereumCommonServices') 토큰의 **배열로 묶어 export**. 실제 사용처는 **배열만 주입받아 `find` 로 선택**한다:
  - 자산: `services.find((s) => s.getAssetId() === assetId)`
  - 토큰: `services.find((s) => s.getTokenTypeId() === tokenTypeId)`
- 자산/토큰이 늘어도 사용처는 무수정. (각 서비스는 `getAssetId()` / `getTokenTypeId()` 접근자를 노출)

### 각 인스턴스 = scanTransactions 제공 (루프는 tx-scanner가 소유)
[`ethereum-common.service.ts`](./src/modules/blockchain/ethereum-common/ethereum-common.service.ts): 각 인스턴스는 무한 루프를 갖지 않고, `scanTransactions(addresses, cursor)`(cursor=블록번호)로 **블록 범위를 훑어 대상 주소 tx 를 돌려준다.** 루프·커서 영속화·저장은 tx-scanner 담당.

`ethereum-token-common` 도 동일 구조(per-instance + 옵션4)지만 키 모델이 다르다:
- [`ethereum-based-tokens.ts`](./src/modules/blockchain/ethereum-token-common/ethereum-based-tokens.ts): 키 = **숫자 tokenTypeId**(`TokenTypeId` enum, e.g. ERC20/KIP7). 각 토큰 = `{ ...ethereumBasedAssets[baseAssetId], baseAssetId, tokenName }` — 즉 **기반 EVM 자산(baseAssetId)의 네트워크 설정을 스프레드**하고 `baseAssetId`/`tokenName`(paramStore 조회용)만 덧붙인다. `ethereumBasedTokenTypeIds`(number[]) 노출.
- 토큰 service 는 **기반 자산 노드를 재사용**한다: 생성자가 `ETHEREUM_COMMON_SERVICES` 배열을 주입받아 `baseAssetId` 로 자기 `EthereumCommonService` 를 찾는다. 그래서 [`ethereum-token-common.module.ts`](./src/modules/blockchain/ethereum-token-common/ethereum-token-common.module.ts) 는 `EthereumCommonModule` 을 import 한다.
- 추적할 **개별 토큰 컨트랙트 주소는 DB 에서** 가져온다(this 파일은 네트워크+토큰타입 레벨 설정만).

## blockchain 모듈 상세

- **AssetService** (`interfaces/asset.interface.ts`): 네이티브 코인용. `symbol`, `scanIntervalMs`, `scanTransactions(addresses, cursor)`, `getBalance`, `getBlockHeight`.
  - 구현: `ethereum-common`, `sol`, `xlm`, `btc`, `bch`, `trx`, `xrp`, `xpla`
- **TokenService** (`interfaces/token.interface.ts`): 토큰용. `symbol`, `scanIntervalMs`, `scanTransactions(addresses, cursor)`, `getTokenBalance`, `getTokenMetadata`.
  - 구현: `ethereum-token-common`, `spl`, `trc20`
- 계약(`getAssetId()`/`getTokenTypeId()` + symbol + scanIntervalMs + scanTransactions)은 위 두 인터페이스가 강제한다(별도 `Scannable` 추상화 없음). `ScanRunner` 는 `AssetService | TokenService` 합집합을 받는다.
- 식별은 **숫자 id**([`constants.ts`](./src/modules/blockchain/constants.ts) 의 `AssetId`/`TokenTypeId`)가 1차 키. symbol 은 로깅용 보조값(지갑/저장 조회도 id 기준).
- **BlockchainService**: 숫자 id 로 구현체를 조회하는 진입점.
  - `getAssetService(assetId)` / `getTokenService(tokenTypeId)` / `getAllAssetServices()` / `getAllTokenServices()`
  - `getSupportedAssetIds()` → `[1..11]` (KONET=1,KLAY=2,CROSS=3,BASE=4,SOL=5,XLM=6,BTC=7,BCH=8,TRX=9,XRP=10,XPLA=11) — monorepo tx-scanner 로스터 일치
  - `getSupportedTokenTypeIds()` → `[1..5]` (KIP7=1,KONETTOKEN=2,BASETOKEN=3,SPL=4,TRC20=5)
  - 각 서비스가 `getAssetId()`/`getTokenTypeId()` 로 자기 id 를 알려주므로 `Map<number, …>` 에 그 키로 등록한다(asset/token 은 별도 맵이라 id 가 겹쳐도 무방).

### 다른 모듈에서 사용하는 법

```ts
@Module({ imports: [BlockchainModule] })
export class SomeModule {}

@Injectable()
export class SomeService {
  constructor(private readonly blockchain: BlockchainService) {}

  async run() {
    const konet = this.blockchain.getAssetService(AssetId.KONET); // 숫자 id 로 조회
    const { txs, nextCursor } = await konet.scanTransactions(['0x...'], null);
  }
}
```

---

## 빌드 & 실행

```bash
npm run build       # 컴파일 (타입/DI 검증)
npm run start:dev   # watch 모드 실행 (http://localhost:3000)
```

### 동작 확인용 스니펫 (애플리케이션 컨텍스트로 scanAll 실행)

```bash
npm run build && node -e "
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { TxScannerService } = require('./dist/modules/tx-scanner/tx-scanner.service');
NestFactory.createApplicationContext(AppModule).then(async (app) => {
  await app.get(TxScannerService).scanAll();
  await app.close();
});
"
```

---

## 노드 기반 tx 조회 (체인별 조사 결과)

⚠️ **중요**: 모든 blockchain 모듈은 익스플로러가 아니라 **자체 노드**로 요청한다. 그런데 "주소→tx 목록" 능력이 체인마다 다르다 — 자세한 내용은 [`docs/fetching-transactions-by-node.md`](./docs/fetching-transactions-by-node.md).

| 체인 | 노드 조회 방법 | 커서 | 비고 |
|------|------|------|------|
| eth / polygon (EVM) | Erigon Otterscan `ots_searchTransactions*` 또는 `trace_filter` | blockNumber | 표준 RPC엔 주소 검색 없음. archive 권장 |
| eth-token (ERC20) | `eth_getLogs` Transfer 필터 | blockNumber | 네이티브 전송은 안 잡힘 |
| sol / spl | `getSignaturesForAddress` → `getTransaction` | signature | full 이력은 archive 노드 |
| xlm | Horizon `GET /accounts/{id}/transactions` | paging_token | core + 자체 Horizon 운영 |
| btc / bch | 블록 verbose(2) vout 수신 매칭(현재), 또는 watch-only `listsinceblock`/ElectrumX | blockNumber | 'out' 은 prevout 추적/ watch-only 필요(TODO) |
| trx / trc20 | 블록(`getBlock`) TransferContract / TriggerSmartContract 디코드 | blockNumber | TRC20 은 transfer(a9059cbb) 셀렉터 디코드 |
| xrp | `account_tx` (ledger 범위, forward) | ledger index | DestinationTag=memoId. s1.ripple.com 안정 |
| xpla | LCD `txInfosByHeight` + Cosmos `transfer` 이벤트 | blockHeight | tx.body.memo=memoId |

**설계 시사점**: ① 전부 커서 기반이므로 "전부 가져오기"가 아닌 **증분 스캔 + 커서 영속화**로 가야 함. ② 커서 타입이 체인마다 달라 opaque 문자열 커서 추상화 권장. ③ BTC/BCH는 주소 사전 등록(watch) 단계가 필요. ④ 인터페이스를 `getTransactions(address, { cursor, limit }) → { txs, nextCursor }` 형태로 확장 검토.

## 다음 작업 후보 (TODO)

- [ ] **DB 연동**: `WalletService.getScanAddresses` 가 실제 DB에서 주소를 조회. `DetectedTransactionsRepository`/`WalletScannerAssetRepository` stub 을 실제 DB 로 교체.
- [ ] **토큰 assetId / 멱등** (§5-6·§5-7): 토큰 detected.assetId 를 contractAddress→assetId 로, detected_transactions 멱등 unique index.
- [ ] **스캔 취소 가능화**: `scanTransactions` 에 AbortController/timeout 도입 → 워치독이 hung RPC 를 끊고 재시작 가능하게.
- [ ] **from/to 파싱 보강**: SOL/SPL signature-only → getParsedTransaction 으로 fromAddress/toAddress 채우기.
- [ ] **API/트리거**: 외부에서 스캔 상태 조회/수동 트리거할 컨트롤러.

---

## 변경 이력 (Changelog)

- **2026-06-22**: NestJS 초기화. blockchain 모듈(인터페이스 + 5개 asset / 2개 token 구현 껍데기). wallet 모듈(DB 껍데기). tx-scanner 모듈(scanAll/scanWallet + tx 저장 껍데기). 문서화 체계(README/CLAUDE.md) 수립.
- **2026-06-22**: 노드 기반 주소별 tx 조회 방법 체인별 조사 → [`docs/fetching-transactions-by-node.md`](./docs/fetching-transactions-by-node.md). 인터페이스 커서/증분 스캔 확장 필요성 도출.
- **2026-06-22**: 스캔 전략 결정(블록 무한 순차 스캔 + 블록 높이 커서 영속화). ethereum-common 을 EVM 멀티 네트워크로 정의 — `ethereum-based-assets.ts`(EthereumBasedAssetType, ethereumBasedAssets: ETH/POLYGON/KONET).
- **2026-06-22**: ethereum-token-common 도 EVM 멀티 네트워크로 정의 — `ethereum-based-tokens.ts`(EthereumBasedTokenType, ethereumBasedTokens: ETH/POLYGON/KONET, tokenStandard 'ERC20').
- **2026-06-23**: EVM 자산/토큰을 **네트워크당 인스턴스 분리**로 리팩터링. KLAY 추가. 옵션4 등록(개별 provider `*_${id}` + 배열 aggregate `ETHEREUM_COMMON_SERVICES`/`ETHEREUM_TOKEN_COMMON_SERVICES`). BlockchainService 를 배열 주입으로 변경.
- **2026-06-23**: 실제 데이터모델 반영 — asset 레지스트리를 **숫자 assetId**(`EthereumBasedAssetId`)로 전환. 토큰을 **`TokenTypeId` 키 + `baseAssetId` + `tokenName`** 모델로 재정리(기반 자산 설정 스프레드). 토큰 service 가 `ETHEREUM_COMMON_SERVICES` 배열을 주입받아 `baseAssetId` 로 **기반 EVM 자산 노드를 재사용**. 검증: erc20→assetId1(ethereum), kip7→assetId3(klaytn) 매칭 확인.
- **2026-06-23**: **스캔 아키텍처 확정 및 구현**. (1) blockchain 인터페이스에 `scanTransactions(addresses, cursor)` + `scanIntervalMs` 추가, 전 자산이 자산별 방식으로 구현(EVM/BTC 블록범위, SOL/SPL signature, XLM Horizon+memoId). EVM 의 in-service 루프 제거. (2) **무한 루프 주체를 tx-scanner 로 이전** — 자산별 `ScanRunner` 독립 루프 + `@Cron` 워치독(`@nestjs/schedule`). (3) `ScheduleModule.forRoot()` 추가. 부팅 검증: 11개 독립 루프(자산8+토큰3) 각자 cadence 로 스캔, 종료 시 전부 graceful stop.
- **2026-06-23**: **각 blockchain 모듈 실제 노드 SDK 연동**. EVM=web3, SOL/SPL=@solana/web3.js, XLM=@stellar/stellar-sdk(Horizon), BTC/BCH=bitcoind JSON-RPC(공용 `UtxoRpcScanner`). 노드 URL 은 env(`node-config.ts`), 미설정 시 skip. DB 는 의도적으로 stub 유지. ESM 충돌로 stellar-sdk 12 고정 + `rpc-websockets`/uuid override. live 공개 노드로 ETH(블록 25378446)/SOL(slot 428318509)/XLM(ledger 63157898) 동작 확인.
- **2026-06-25**: **리팩터링 + 신규 체인 4종**. (1) BTC/BCH 공용 로직을 `utxo-common` 모듈로 이동(`UtxoCommonService` 무상태 엔진 + `UtxoRpcClient`), btc/bch 는 주입받아 위임하는 얇은 서비스로. 루트의 `utxo-rpc.scanner.ts` 단발 파일 제거. (2) 중복 `ScannableService` 제거 → `ScanRunner` 가 `AssetService | TokenService` 사용(계약은 인터페이스가 강제). (3) 서비스별 `warnNoNode`/`warnIfNoNode` 보일러플레이트를 `node-config.ts` 공용 `warnMissingNode` 로 통합. (4) **신규 자산 trx/xrp/xpla + 토큰 trc20 추가** — TRX/TRC20=tronweb, XRP=rippled JSON-RPC(fetch, `xrpl` SDK 는 `@noble/hashes@2` ESM 충돌로 미사용), XPLA=@xpla/xpla.js(Cosmos LCD). (5) `dotenv` 도입(`.env` 로드) + 공개 노드 URL 채움. 검증: 자산11+토큰4 부팅·graceful stop, live 노드로 ETH/POL/KLAY/KONET/SOL/XLM/TRX/XRP/XPLA getBlockHeight, XRP account_tx 실제 tx 파싱 확인. BTC·BCH 만 공개 노드 없어 skip.
- **2026-06-25**: **지갑/저장도 숫자 id 기준으로 통일**. `ScanTarget` 을 `blockchain/interfaces/scan.types.ts` 공용 타입으로 이동(중복 제거). `WalletService.getScanAddresses(symbol)` → `getScanAddresses(target: ScanTarget)`: target → assetId 목록 해석(토큰이면 기반 assetId 들, 둘 다면 합집합) 후 주소 수집. `Wallet` 타입 재설계 — `{ assetIds:number[], addresses:string[] }`(symbol·`WalletType`(HOT/COLD)·단일 address·string id 제거). `TxRepository.saveMany(symbol,…)` → `saveMany(target,…)`. 검증: tokenTypeId 1/2/3/4 → assetIds [1]/[3]/[5]/[9]; EVM assetId 는 2개 주소, 비EVM 은 0개(이전 stub 주소 형식 에러 해소).
- **2026-06-25**: **cursor 영속화 + 파라미터 스토어**. (1) `CursorStore` 도입(`tx-scanner/cursor-store.ts`) — `JsonCursorStore` 가 `.data/cursors.json` 에 대상별 cursor 저장. `ScanRunner` 가 시작 시 `load`(resume), 사이클마다 `save`. key=`asset:<id>`/`token:<id>`. `CURSOR_STORE` 토큰 주입, DB 교체 대비 인터페이스 유지. 검증: 5초 스캔 후 cursors.json 기록 → 재시작 시 `resume from cursor=…` 확인. (2) 노드 URL 조회를 `parameter-store.ts`(async `getParameter`/`getNodeUrl`)로 이전 — 소스 `parameter.json`(gitignore)→env 폴백, `node-config.ts` 는 `warnMissingNode` 만 남김. 전 서비스 `resolveNodeUrl`/UtxoCommonService 가 await 조회. 검증: parameter.json 값이 env 보다 우선함 확인.
- **2026-06-29**: **진행 지점 영속화를 `asset` 테이블 모델로**. `CursorStore`/`JsonCursorStore`(`.data/cursors.json`) 제거 → `AssetRepository`(`asset.start_block_number`) + `StubAssetRepository`(in-memory, `ASSET_REPOSITORY` 토큰). `ScanRunner` 가 `getStartBlockNumber(assetId)`/`updateStartBlockNumber(assetId, …)` 로 load/save(행 키=`resolveStoreAssetId(target)`, 토큰=토큰 자체 assetId). 용어 `cursor`→**`startBlockNumber`**(저장 컬럼명 정렬; 체인 경계의 반환값은 여전히 불투명 `nextCursor`). `Asset` 스키마: id/iso_alpha3(symbol)/full_name(한글)/scale(≤8)/start_block_number/confirm_threshold. 검증: 부팅 시 get→null→scan→update(asset#1←25420998, 토큰 asset#1001 분리 저장) 확인. ⚠️ stub 은 in-memory 라 재시작 시 초기화(실제 DB 연결 시 영속).
- **2026-06-30**: **DetectedTx in/out 제거 + 매퍼/TxRepository 제거 + 워치독 setInterval + run 10s** (monorepo 정렬). (1) `DetectedTx` 를 `{fromAddress?, toAddress?, amount?, memoId?, blockNumber?}` 로(direction/address/counterparty 제거) — in/out 의미부여는 저장/조회 단계로. 전 스캐너가 from/to 단일 push(EVM/TRX/TRC20/XPLA 는 in/out 이중 push 제거, dedupe). SOL/SPL 은 signature-only 라 from/to 생략. (2) `detected-tx.mapper.ts`·`tx.repository.ts` 제거 → `TxScannerService.saveDetected` 가 `DetectedTransactionsRepository` 에 직접 저장(DetectedTx≈DB 컬럼). `resolveStoreAssetId` 는 tx-scanner 로 이동(stub; monorepo 는 assetRepository/tokenRepository). (3) 워치독 `@Cron`→`setInterval`, `ScheduleModule` 제거(monorepo=scheduler_manager). (4) run 주기 `scanIntervalMs` 전 자산 10s 통일. 검증: build/lint, 루프 interval=10000ms, saveDetected 출력 `{fromAddress,toAddress,txId,…}`.
- **2026-07-01**: **입금 감지 정확도 — status/value 필터 + confirmations cap + EVM batch** (scanBlocks 정합, §5-11). (1) **EVM 네이티브**: `getBlock(n,true)` hydrated 로 from/to·`value>0` 후보 거르고 **매칭 tx 만 `getTransactionReceipt` → `status===1`**(2-phase; revert 값이동 방지). (2) **EVM 토큰**: revert 로그는 `eth_getLogs` 에 안 나와 로그 존재=성공 → receipt 불필요, `data≠0` 필터만. (3) **confirmations cap**: `to=min(from+range-1, head-confirmations)` 로 최근 블록 제외(스냅샷 저장 X), `getConfirmations(path)`(미설정 0). (4) **성능**: `EthereumBasedAssetType.usingBatchRequest`(monorepo 동일)로 블록/receipt fetch 방식 선택 — true=JSON-RPC 배열 batch(청크 Promise.all), false=web3 개별 호출 Promise.all 병렬. 검증: konet 부팅 — `confirmations=12`→native `safeHead=head-12`, batch fetch 정상. **EVM 먼저 적용, 타 체인은 같은 원칙 확장 TODO.**
- **2026-07-01**: **detected_transactions 멱등 — 유니크 키 `(asset_id, tx_id, tx_index)`** (§7). 한 tx 가 from/to/amount 까지 같은 transfer 를 여러 건 담을 수 있어(EVM 배치, UTXO 다중 vout) **tx 내 위치 `tx_index`** 로 구분한다(없이 걸면 정상 건 누락). `DetectedTx.txIndex`/`InsertParams.txIndex` 추가, 스캐너가 채움(EVM=`log.logIndex`, UTXO=vout `n`, XPLA=이벤트 순번, 그 외 tx당 1건=0; SOL/SPL 은 파싱 전이라 0=signature 단위). `StubDetectedTransactionsRepository` 가 `(assetId,txId,txIndex)` Set 으로 재삽입 흡수(실 DB=UNIQUE + `ON CONFLICT DO NOTHING`). 검증: 같은 키 재삽입=skip, 같은 tx·다른 txIndex(동일 from/to/amount)=별도 저장. monorepo 는 컬럼+UNIQUE migration 필요(매핑 §5-7).
- **2026-06-30**: **토큰을 "자기 asset id" 모델로 스캔 (실제 DB 모델 반영)**. `wallet_scanner_asset` PK 는 `id`(코인=main.asset.id, 토큰=token 자체 asset_id, 한 id 공간 공유). 한 `TokenService`(=token_type)가 **여러 토큰**을 덮으므로, 새 `token.repository.ts`(main.token stub)에서 `token_type → [{assetId, contractAddress}]` 를 받아 **token_type 당 ScanRunner 1개**로 **한 루프**에 그 토큰들을 스캔한다. `TokenService.scanTransactions(..., contractAddresses[])` 로 그 컨트랙트들의 transfer 만 수집하고 각 tx 에 `contractAddress` 를 채운다(EVM=`address`+`log.address`, SPL=`mint`, TRC20=`contract_address`). 저장은 `saveDetectedTokens` 가 tx 의 `contractAddress→asset_id` 로 분류해 각 토큰 asset_id 로 insert; 진행지점은 그 타입의 토큰 행들을 **함께 같은 값**으로 갱신. `STUB_TOKEN_ASSET_ID`·`resolveStoreAssetId` 제거, `DetectedTx.contractAddress` 추가. 이로써 **KONET 토큰 진행지점이 KONET 코인 행을 덮어쓰던 충돌 해소**(매핑 §10). btc/bch `scanIntervalMs` 5000→10000(10s 통일 누락분). 검증: 부팅 시 `getTokensByType(tokenType#2)→2 token` → 러너 `token#2(2):konetToken` 1개가 `asset#1002`·`#1003` 진행지점을 같은 값으로 동시 갱신, build/prettier/eslint 통과.
- **2026-06-30**: **scan range 필드명 `maxScanRange` → `maxDepositScanRange`** (monorepo ParamStore 실제 키 정렬). prototype 이 `maxScanRange` 로 읽어 실제 ParamStore(`maxDepositScanRange`)와 키가 어긋나 전 자산이 range 미설정으로 skip 되던 문제 수정. `parameter.json`/`parameter.example.json` path 객체 키, `parameter-store.getMaxScanRange`→`getMaxDepositScanRange`, 전 서비스 state 필드/로그(`no maxDepositScanRange for "<path>" — scan skipped`) 일괄 변경. 검증: 부팅 시 konet/klay=1000·trx=20·sol=1000·xlm=200·xrp=200·xpla=10 으로 핸들 초기화(미설정만 skip), build/prettier/eslint 통과.
- **2026-06-30**: **maxScanRange 미설정 정책: throw → log+skip** (monorepo 정렬). `getMaxScanRange(path)` 가 미설정/0이하면 throw 대신 `undefined` 반환. 각 서비스 `onModuleInit` 은 노드 URL+maxScanRange 둘 다 있을 때만 핸들 초기화하고, 없으면 `no maxScanRange for "<path>" — scan skipped` 로그 후 skip(앱 부팅은 계속). 위임형(token/trc20/btc/bch)은 scanTransactions 에서도 maxScanRange undefined 면 skip. 검증: konet maxScanRange 제거 후 부팅 → 크래시 없이 konet 만 skip 확인.
- **2026-06-29**: **monorepo 동기화 — XPLA REST + detected_transactions + maxScanRange**. (1) **XPLA `@xpla/xpla.js` 제거** — top-level import 만으로 부팅 크래시(`@xpla/xpla.proto` v2 누락)라 `XplaRestClient`(Cosmos LCD REST, `query=tx.height%3D{h}`)로 교체. live 22 tx 파싱 확인. (2) **tx 저장 연동** — `DetectedTransactionsRepository` 인터페이스 + `StubDetectedTransactionsRepository`(`DETECTED_TRANSACTIONS_REPOSITORY` 토큰) + `mapDetectedTxToInsertParams(target, tx)` 매퍼 추가. `TxRepository` 가 매핑 후 저장. 토큰은 **자체 assetId**(stub 1001+, 실제 DB token→assetId). (3) **scan range ParamStore화(필수값)** — `getMaxScanRange(<ASSET>_MAX_SCAN_RANGE)` 로 전 체인 batch/limit 을 조회. **코드 default 없음 — 미설정 시 throw**(노드 있는 자산은 `onModuleInit` 에서 range 까지 조회해 state 저장, 누락 시 초기화 실패). parameter.json 에 `<ASSET>_MAX_SCAN_RANGE` 명시 필수(EVM/SOL=1000, XLM/XRP=200, BTC/BCH=50, TRX=20, XPLA=10). 검증: init 로그에 maxScanRange 표시, 키 누락 시 throw 확인. (4) ef1dd24(Buffer/Uint8Array, getTransaction)는 prototype 에 서명/전송 코드가 없어 해당 없음.
- **2026-06-29**: **monorepo 로스터·ParamStore·진행지점 테이블 정렬** (회사 AI 답변 Q1~Q4 반영). (1) **ParamStore path 모델** — `getParametersByPath(path)` + parameter.json 을 path별 `{nodeUrl,maxScanRange}` 객체로. `getNodeUrlByPath`/`getMaxScanRange(path)`. path 는 monorepo 와 일치(trx→`tron`, klaytn→`klay`, base(BASEETH)→`base`). (2) **진행지점 테이블** `asset` → **`wallet_scanner_asset`**(`WalletScannerAssetRepository`, main.asset 분리). (3) **자산 로스터 monorepo 일치** — EVM `konet/klay/cross/base` + 토큰 `kip7/konetToken/baseToken` (`ETH/POL/erc20` 제거, cross 는 EVM). `AssetId`/`TokenTypeId` 재정의. (4) 토큰 저장 assetId(contractAddress→assetId)는 양쪽 미정렬이라 stub(1001+) 유지(TODO). 검증: assetIds 1~11·tokenTypeIds 1~5, klay/konet web3 init + path별 maxScanRange, build/lint/부팅. 매핑: docs/MONOREPO-MAPPING.md §2·§5.
- **2026-06-25**: **식별자 숫자화 + 서비스 구조 통일**. (1) `constants.ts` 단일 소스(`AssetId` 1~11 / `TokenTypeId` 1~4) 도입 — EVM 전용 `EthereumBasedAssetId`/`TokenTypeId` 제거하고 전 체인을 한 enum 으로. `AssetService.getAssetId()` / `TokenService.getTokenTypeId()` 를 인터페이스 계약으로 추가. `BlockchainService` 를 **`Map<number,…>`(id 키)** 로 전환(`getAssetService(assetId)`/`getTokenService(tokenTypeId)`, `getSupportedAssetIds`/`getSupportedTokenTypeIds`). (2) **state+onModuleInit 패턴을 전 노드핸들 서비스로 확산**(sol/xlm/trx/xrp/xpla/spl: 핸들을 onModuleInit 에서 async URL 로 초기화, 런타임 상태는 `state` 에; ethereum-token-common 도 state 그룹화). (3) `ScanRunner` 의 `kind:'asset'|'token'` → **`ScanTarget {assetId?, tokenTypeId?}`**(둘 중 최소 1개 필수, 없으면 throw; 둘 다 = SOL+SPL 같은 통합 스캔 여지). 검증: 부팅 시 전 핸들 onModuleInit 초기화 + 러너 라벨 `asset#1:ETH`…`token#1:erc20`, id 조회/에러 경로 확인.
