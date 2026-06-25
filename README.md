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
| 실제 노드 SDK 연동 | ✅ 완료 | EVM=web3, SOL/SPL=@solana/web3.js, XLM=@stellar/stellar-sdk, BTC/BCH·XRP=JSON-RPC(fetch), TRX/TRC20=tronweb, XPLA=@xpla/xpla.js. 노드 URL은 `parameter.json`(→env)에서 **async** 조회, 미설정 시 skip |
| cursor 영속화 | ✅ 완료(stub) | `CursorStore`(JSON 파일 `.data/cursors.json`) — 재시작 시 마지막 지점부터 resume. **DB 로 교체 예정** |
| DB 연동 | ⬜ 미착수(의도) | wallet/tx 저장은 stub. cursor·parameter 도 JSON/파일 stub — **회사 DB/ParamStore 로 교체 예정** |

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
    │   ├── parameter-store.ts       # 노드 URL 등 파라미터 async 조회 (parameter.json→env, DB 교체 예정)
    │   ├── node-config.ts           # warnMissingNode (노드 미설정 1회 경고)
    │   ├── interfaces/
    │   │   ├── asset.interface.ts    # AssetService (네이티브 코인): scanTransactions + scanIntervalMs
    │   │   ├── token.interface.ts    # TokenService (토큰): scanTransactions + scanIntervalMs
    │   │   └── scan.types.ts         # DetectedTx, ScanResult(txs + nextCursor 불투명 커서)
    │   ├── ethereum-common/          # AssetService. EVM 멀티 네트워크, 네트워크당 인스턴스
    │   │   ├── ethereum-common.module.ts # 옵션4: 개별 provider + 배열 aggregate(ETHEREUM_COMMON_SERVICES)
    │   │   ├── ethereum-common.service.ts # assetId당 1인스턴스. 런타임상태=state, web3는 onModuleInit(async URL)에서 초기화. scanTransactions(블록범위)
    │   │   └── ethereum-based-assets.ts  # EthereumBasedAssetType + ethereumBasedAssets/Ids(ETH/POLYGON/KLAY/KONET)
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
    │   ├── xpla/                     # AssetService. XPLA Cosmos(@xpla/xpla.js LCD). 블록범위 transfer 이벤트
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
        ├── tx-scanner.module.ts      # BlockchainModule + WalletModule import, CURSOR_STORE provider
        ├── tx-scanner.service.ts     # 대상별 ScanRunner 생성/구동 + @Cron 워치독 (cursorKey)
        ├── scan-runner.ts            # 대상 1개의 독립 무한 루프(cursor load/save/sleep/graceful stop)
        ├── cursor-store.ts           # cursor 영속화 (JsonCursorStore=.data/cursors.json, DB 교체 예정)
        └── tx.repository.ts          # tx 저장 (DB 껍데기, console.log)
```

> 참고: 루트 `AppModule` 은 워치독 `@Cron` 활성화를 위해 `ScheduleModule.forRoot()` 를 import 한다.

### 데이터 흐름 (tx 스캔)

```
TxScannerService.onModuleInit()
  → BlockchainService.getAllAssetServices() / getAllTokenServices()  # 전 서비스 수집
  → 서비스마다 ScanRunner 1개 생성 후 start()   # 대상별 독립 무한 루프
       루프 시작: cursor = CursorStore.load(key)            # 마지막 지점부터 resume
       각 루프 반복:
         → WalletService.getScanAddresses(target)            # target→assetIds→주소 (DB 껍데기)
         → service.scanTransactions(addresses, cursor)       # 자산별 방식으로 in/out 감지
         → TxRepository.saveMany(target, detectedTxs)        # 저장 (id 기준, DB 껍데기)
         → cursor = nextCursor; CursorStore.save(key, cursor) # 진행 지점 영속화(JSON stub)
         → service.scanIntervalMs 만큼 대기
  @Cron(EVERY_MINUTE) watchdog()  # 죽은/정체된 루프 점검·재시작 (스캔은 안 함)
```

---

## 스캔 전략 (결정됨): 자산별 독립 무한 루프 + cron 워치독

**무한 루프의 주체는 tx-scanner**다. blockchain 서비스는 "스캔해서 tx 돌려주는" `scanTransactions(addresses, cursor)` 만 제공하고, 어떻게 스캔할지는 자산이 알아서 한다.

- **자산별 독립 루프**: 자산마다 노드·스캔 방식·속도가 달라서([scanIntervalMs](#자산별-스캔-방식-요약)) 자산당 `ScanRunner` 를 하나씩 돌린다. 느린 체인(BTC)이 빠른 체인(SOL)을 막지 않는다(head-of-line blocking 방지).
- **cron 워치독(안전망)**: 무한 루프는 실시간성이 높지만 죽으면 조용히 멈출 수 있다. `@Cron(EVERY_MINUTE)` 가 각 루프의 생존/정체를 점검해 재시작한다(스캔 자체는 안 함).
- **커서 기반 증분**: 각 루프는 자산별 커서(불투명 문자열)를 들고 마지막 지점 이후만 스캔. DB 영속화하면 재시작 후 이어서 진행(at-least-once). 저장은 (symbol, txHash, address) 멱등.

#### 왜 이 조합인가 (대안 비교)
- **cron 단독**: 구현 단순하지만 실시간성↓(주기마다 몰아 처리), 자산별 cadence 조절 불가 → 탈락.
- **단일 무한 루프(전 자산 한 루프)**: 느린 체인이 빠른 체인을 막음(HOL blocking) → 탈락.
- **자산별 무한 루프 단독**: 좋지만 루프가 죽으면 복구 수단이 없음.
- **→ 채택: 자산별 무한 루프(평소) + cron 워치독(복구).** 실시간성·격리·복구를 모두 확보.

### 자산별 스캔 방식 요약
| 자산 | scanTransactions 방식 | cursor 의미 | scanIntervalMs |
|------|------|------|---|
| ETH/POL/KLAY/KONET (EVM) | 블록 범위 순회, tx.from/to 매칭 | 블록번호 | 2000 |
| erc20/kip7 (EVM 토큰) | `eth_getLogs` Transfer 필터, 기반 자산 노드 재사용 | 블록번호 | 2000 |
| BTC/BCH (UTXO) | 블록 범위 vout 수신 매칭(공용 UtxoCommonService) | 블록번호 | 5000 |
| SOL | 주소별 `getSignaturesForAddress` 페이징 | signature | 500 |
| SPL | 토큰계정(mintAddress) signature 페이징 | signature | 500 |
| XLM | Horizon `/accounts/{addr}/transactions` + memoId | paging_token | 1000 |
| TRX | 블록 범위 TransferContract owner/to 매칭(tronweb) | 블록번호 | 3000 |
| TRC20 | 블록 범위 TriggerSmartContract transfer 디코드(trx 노드 재사용) | 블록번호 | 3000 |
| XRP | 주소별 `account_tx` ledger 범위(rippled JSON-RPC) | ledger index | 2000 |
| XPLA | 블록 범위 Cosmos `transfer` 이벤트 매칭(@xpla/xpla.js) | 블록높이 | 3000 |

> 노드 RPC 메서드 상세 근거는 [`docs/fetching-transactions-by-node.md`](./docs/fetching-transactions-by-node.md).

### 노드 연동(SDK) & 설정
각 자산은 실제 SDK 또는 노드 JSON-RPC 로 접속한다. **노드 URL 은 [`parameter-store.ts`](./src/modules/blockchain/parameter-store.ts) 의 async `getParameter`/`getNodeUrl`** 로 읽는다 — 소스는 루트 [`parameter.json`](./parameter.example.json)(gitignore, 템플릿은 `parameter.example.json`), 없으면 `process.env`/`.env` 폴백. 미설정이면 해당 자산은 **스캔 skip**(노드 없이도 부팅/테스트 가능). 조회가 async 라서 추후 DB/원격 ParamStore 로 교체해도 호출부는 안 바뀐다.

| 자산 | SDK/연동 | 파라미터 키 (parameter.json / env) |
|------|-----|--------|
| EVM (ETH/POL/KLAY/KONET) | `web3` | `<NETWORK>_NODE_URL` (예: `ETHEREUM_NODE_URL`) |
| EVM 토큰 (erc20/kip7) | (기반 자산 web3 재사용) | 기반 자산 env |
| SOL / SPL | `@solana/web3.js` | `SOLANA_RPC_URL` |
| XLM | `@stellar/stellar-sdk` (Horizon) | `STELLAR_HORIZON_URL` |
| BTC / BCH | bitcoind JSON-RPC (내장 fetch) | `BITCOIN_RPC_URL` / `BCH_RPC_URL` |
| TRX / TRC20 | `tronweb` (TRC20 은 TRX 노드 재사용) | `TRON_RPC_URL` |
| XRP | rippled JSON-RPC (내장 fetch) | `XRP_RPC_URL` |
| XPLA | `@xpla/xpla.js` (Cosmos LCD) | `XPLA_LCD_URL` / `XPLA_CHAIN_ID` |

> 노드 확인됨: ETH/POL/KLAY=publicnode·kaia, KONET=api.kon-wallet.com, SOL=publicnode, XLM=horizon.stellar.org, TRX=api.trongrid.io, XRP=s1.ripple.com:51234, XPLA=dimension-lcd.xpla.dev. **노드 없음(자체 노드 필요)**: BTC/BCH(bitcoind JSON-RPC).

⚠️ **의존성 제약(중요)**: NestJS 빌드가 CommonJS 라 ESM-only 최신 deps 와 충돌한다.
- `@stellar/stellar-sdk` 는 **12.x 로 고정**(16.x 는 ESM-only `@noble/hashes@2` 를 require 해서 CJS 에서 `ERR_REQUIRE_ESM`).
- `@solana/web3.js` 는 `rpc-websockets` 가 끌어오는 ESM `uuid@14` 때문에 깨져서, `package.json` `overrides` 로 `rpc-websockets` 의 `uuid` 를 `9.0.1` 로 고정.
- **XRP 공식 SDK `xrpl` 은 사용 불가**: v2~v5 모두 `@xrplf/isomorphic` → `@noble/hashes@2`(ESM-only) 를 강제해 `ERR_REQUIRE_ESM`. 그래서 SDK 대신 **rippled JSON-RPC(fetch)** 로 구현. (`tronweb`, `@xpla/xpla.js` 는 CJS 정상)

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
  - `getSupportedAssetIds()` → `[1..11]` (ETH=1,POL=2,KLAY=3,KONET=4,SOL=5,XLM=6,BTC=7,BCH=8,TRX=9,XRP=10,XPLA=11)
  - `getSupportedTokenTypeIds()` → `[1,2,3,4]` (ERC20=1,KIP7=2,SPL=3,TRC20=4)
  - 각 서비스가 `getAssetId()`/`getTokenTypeId()` 로 자기 id 를 알려주므로 `Map<number, …>` 에 그 키로 등록한다(asset/token 은 별도 맵이라 id 가 겹쳐도 무방).

### 다른 모듈에서 사용하는 법

```ts
@Module({ imports: [BlockchainModule] })
export class SomeModule {}

@Injectable()
export class SomeService {
  constructor(private readonly blockchain: BlockchainService) {}

  async run() {
    const eth = this.blockchain.getAssetService(AssetId.ETH); // 숫자 id 로 조회
    const { txs, nextCursor } = await eth.scanTransactions(['0x...'], null);
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

- [ ] **DB 연동**: `WalletService.getScanAddresses` 가 실제 DB에서 hot/cold 주소를 조회하도록 교체. `TxRepository` 가 실제 tx 를 멱등 저장하도록 교체. **cursor 영속화**(자산별 마지막 스캔 지점 load/save) 추가.
- [ ] **체인 RPC 연동**: 각 `*Service.scanTransactions` 의 `console.log` 껍데기를 실제 노드 호출로 교체(EVM 블록범위/getLogs, SOL getSignaturesForAddress, XLM Horizon, BTC/BCH watch-only).
- [ ] **스캔 취소 가능화**: `scanTransactions` 에 AbortController/timeout 도입 → 워치독이 hung RPC 를 끊고 재시작 가능하게.
- [ ] **DetectedTx 매핑**: 각 자산이 실제 tx 를 `DetectedTx`(direction/counterparty/amount/memoId) 로 변환.
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
- **2026-06-25**: **식별자 숫자화 + 서비스 구조 통일**. (1) `constants.ts` 단일 소스(`AssetId` 1~11 / `TokenTypeId` 1~4) 도입 — EVM 전용 `EthereumBasedAssetId`/`TokenTypeId` 제거하고 전 체인을 한 enum 으로. `AssetService.getAssetId()` / `TokenService.getTokenTypeId()` 를 인터페이스 계약으로 추가. `BlockchainService` 를 **`Map<number,…>`(id 키)** 로 전환(`getAssetService(assetId)`/`getTokenService(tokenTypeId)`, `getSupportedAssetIds`/`getSupportedTokenTypeIds`). (2) **state+onModuleInit 패턴을 전 노드핸들 서비스로 확산**(sol/xlm/trx/xrp/xpla/spl: 핸들을 onModuleInit 에서 async URL 로 초기화, 런타임 상태는 `state` 에; ethereum-token-common 도 state 그룹화). (3) `ScanRunner` 의 `kind:'asset'|'token'` → **`ScanTarget {assetId?, tokenTypeId?}`**(둘 중 최소 1개 필수, 없으면 throw; 둘 다 = SOL+SPL 같은 통합 스캔 여지). 검증: 부팅 시 전 핸들 onModuleInit 초기화 + 러너 라벨 `asset#1:ETH`…`token#1:erc20`, id 조회/에러 경로 확인.
