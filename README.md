# wallet-tx-scanner

지정된 지갑 주소(hotwallet / coldwallet)의 모든 온체인 트랜잭션을 감지하여 저장하는 NestJS 서비스.

> 📌 **이 문서는 살아있는 진행상황 문서입니다.** 대화 컨텍스트가 유실되어도 이어서 개발할 수 있도록, 작업이 진행될 때마다 함께 갱신합니다. 항상 지켜야 할 개발 규칙은 [`CLAUDE.md`](./CLAUDE.md)를 참고하세요.

---

## 현재 상태 (Progress)

| 영역 | 상태 | 비고 |
|------|------|------|
| NestJS 초기화 | ✅ 완료 | Nest 10.x |
| blockchain 모듈 | ✅ 완료 | AssetService / TokenService 인터페이스 + 체인별 구현 (껍데기) |
| wallet 모듈 (DB 껍데기) | ✅ 완료 | 고정 stub 주소 반환. DB 미연동 |
| tx-scanner 모듈 | ✅ 완료 | **자산별 독립 무한 루프 + cron 워치독**. scanTransactions 호출 → 저장(껍데기) |
| 자산별 scanTransactions | ✅ 완료 | EVM/BTC=블록범위, SOL/SPL=signature, XLM=Horizon. cursor 기반 |
| 실제 노드 SDK 연동 | ✅ 완료 | EVM=web3, SOL/SPL=@solana/web3.js, XLM=@stellar/stellar-sdk, BTC/BCH=bitcoind JSON-RPC. 노드 URL은 env, 미설정 시 skip. (live 노드로 ETH/SOL/XLM 동작 확인) |
| DB 연동 | ⬜ 미착수(의도) | wallet/tx 저장, cursor 영속화 모두 stub — **회사 DB 별도 연결 예정** |

> ⚠️ "껍데기(stub)" = 인터페이스/흐름만 구현하고 내부는 `console.log` + 고정값 반환. 실제 로직은 추후 구현.

---

## 아키텍처

```
src/
├── app.module.ts                    # 루트. BlockchainModule, TxScannerModule import
└── modules/
    ├── blockchain/                  # 체인 추상화 레이어 (외부에서 import 해서 사용)
    │   ├── blockchain.module.ts
    │   ├── blockchain.service.ts    # symbol 으로 AssetService/TokenService 조회
    │   ├── node-config.ts           # env 에서 노드 URL 읽기 (getEvmNodeUrl 등)
    │   ├── utxo-rpc.scanner.ts       # BTC/BCH 공용 bitcoind JSON-RPC 스캐너
    │   ├── interfaces/
    │   │   ├── asset.interface.ts    # AssetService (네이티브 코인): scanTransactions + scanIntervalMs
    │   │   ├── token.interface.ts    # TokenService (토큰): scanTransactions + scanIntervalMs
    │   │   └── scan.types.ts         # DetectedTx, ScanResult(txs + nextCursor 불투명 커서)
    │   ├── ethereum-common/          # AssetService. EVM 멀티 네트워크, 네트워크당 인스턴스
    │   │   ├── ethereum-common.module.ts # 옵션4: 개별 provider + 배열 aggregate(ETHEREUM_COMMON_SERVICES)
    │   │   ├── ethereum-common.service.ts # assetId당 1인스턴스. scanTransactions(블록범위). 루프는 없음(tx-scanner가 주체)
    │   │   └── ethereum-based-assets.ts  # EthereumBasedAssetType + ethereumBasedAssets/Ids(ETH/POLYGON/KLAY/KONET)
    │   ├── sol/                      # AssetService. signature 페이징 스캔, 빠른 cadence(500ms)
    │   ├── xlm/                      # AssetService. Horizon /accounts + memoId, cursor=paging_token
    │   ├── btc/                      # AssetService. UTXO 블록범위 스캔(느린 cadence)
    │   ├── bch/                      # AssetService. UTXO (btc와 동일 패턴)
    │   ├── ethereum-token-common/    # TokenService. tokenTypeId당 인스턴스, 기반 자산 노드 재사용
    │   │   ├── ethereum-token-common.module.ts # 옵션4 + EthereumCommonModule import + ETHEREUM_TOKEN_COMMON_SERVICES
    │   │   ├── ethereum-token-common.service.ts # tokenTypeId당 1인스턴스. scanTransactions(Transfer 로그). baseAssetId 매칭
    │   │   └── ethereum-based-tokens.ts  # TokenTypeId(ERC20/KIP7) + baseAssetId + tokenName, 기반 자산 설정 스프레드
    │   └── spl/                      # TokenService. 토큰계정 signature 스캔(mintAddress), 빠른 cadence
    ├── wallet/                      # 스캔 대상 지갑 제공 (DB 껍데기)
    │   ├── wallet.module.ts
    │   ├── wallet.service.ts         # getWallets() / getScanAddresses(symbol) — 현재 고정 stub
    │   └── wallet.types.ts           # Wallet, WalletType(HOT/COLD)
    └── tx-scanner/                  # 핵심: 무한 루프 주체 + tx 감지 + 저장
        ├── tx-scanner.module.ts      # BlockchainModule + WalletModule import
        ├── tx-scanner.service.ts     # 자산별 ScanRunner 생성/구동 + @Cron 워치독
        ├── scan-runner.ts            # 자산 1개의 독립 무한 루프(cursor/sleep/graceful stop)
        └── tx.repository.ts          # tx 저장 (DB 껍데기, console.log)
```

> 참고: 루트 `AppModule` 은 워치독 `@Cron` 활성화를 위해 `ScheduleModule.forRoot()` 를 import 한다.

### 데이터 흐름 (tx 스캔)

```
TxScannerService.onModuleInit()
  → BlockchainService.getAllAssetServices() / getAllTokenServices()  # 전 서비스 수집
  → 서비스마다 ScanRunner 1개 생성 후 start()   # 자산별 독립 무한 루프
       각 루프 반복:
         → WalletService.getScanAddresses(symbol)            # 대상 주소 (DB 껍데기)
         → service.scanTransactions(addresses, cursor)       # 자산별 방식으로 in/out 감지
         → TxRepository.saveMany(symbol, detectedTxs)        # 저장 (DB 껍데기)
         → cursor = nextCursor                               # 커서 갱신 (영속화 예정)
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
| BTC/BCH (UTXO) | 블록 범위 vin/vout 매칭(watch-only) | 블록번호 | 5000 |
| SOL | 주소별 `getSignaturesForAddress` 페이징 | signature | 500 |
| SPL | 토큰계정(mintAddress) signature 페이징 | signature | 500 |
| XLM | Horizon `/accounts/{addr}/transactions` + memoId | paging_token | 1000 |

> 노드 RPC 메서드 상세 근거는 [`docs/fetching-transactions-by-node.md`](./docs/fetching-transactions-by-node.md).

### 노드 연동(SDK) & 설정
각 자산은 실제 SDK로 노드에 접속한다. **노드 URL 은 환경변수**에서 읽고, 없으면 해당 자산은 **스캔 skip**(노드 없이도 부팅/테스트 가능). [`.env.example`](./.env.example) 참고.

| 자산 | SDK | env 키 |
|------|-----|--------|
| EVM (ETH/POL/KLAY/KONET) | `web3` | `<NETWORK>_NODE_URL` (예: `ETHEREUM_NODE_URL`) |
| EVM 토큰 (erc20/kip7) | (기반 자산 web3 재사용) | 기반 자산 env |
| SOL / SPL | `@solana/web3.js` | `SOLANA_RPC_URL` |
| XLM | `@stellar/stellar-sdk` (Horizon) | `STELLAR_HORIZON_URL` |
| BTC / BCH | bitcoind JSON-RPC (내장 fetch) | `BITCOIN_RPC_URL` / `BCH_RPC_URL` |

⚠️ **의존성 제약(중요)**: NestJS 빌드가 CommonJS 라 ESM-only 최신 deps 와 충돌한다.
- `@stellar/stellar-sdk` 는 **12.x 로 고정**(16.x 는 ESM-only `@noble/hashes@2` 를 require 해서 CJS 에서 `ERR_REQUIRE_ESM`).
- `@solana/web3.js` 는 `rpc-websockets` 가 끌어오는 ESM `uuid@14` 때문에 깨져서, `package.json` `overrides` 로 `rpc-websockets` 의 `uuid` 를 `9.0.1` 로 고정.

## ethereum-common = EVM 멀티 네트워크 (네트워크당 인스턴스 분리)

`ethereum-common` 은 단일 체인이 아니라 **EVM 계열 네트워크 묶음**(ETH, POLYGON, KLAY, KONET ...)을 공통 로직으로 처리한다.
- 네트워크별 차이는 [`ethereum-based-assets.ts`](./src/modules/blockchain/ethereum-common/ethereum-based-assets.ts) 의 `EthereumBasedAssetType`(`networkName`, `EIP1559`, `hardfork?`, `assetName`) + `ethereumBasedAssets` 레지스트리(키 = **숫자 assetId**, `EthereumBasedAssetId` enum)로 표현. `ethereumBasedAssetIds`(number[]) 로 전체 id 목록을 노출. (assetId 는 실제 DB asset id 와 일치시킬 예정)
- **네트워크마다 노드가 다르므로 service 인스턴스를 분리**한다. 각 네트워크 = `EthereumCommonService` 인스턴스 1개, 생성자에 `assetId` 주입.
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
  - 구현: `ethereum-common`, `sol`, `xlm`, `btc`, `bch`
- **TokenService** (`interfaces/token.interface.ts`): 토큰용. `symbol`, `scanIntervalMs`, `scanTransactions(addresses, cursor)`, `getTokenBalance`, `getTokenMetadata`.
  - 구현: `ethereum-token-common`, `spl`
- **BlockchainService**: 심볼로 구현체를 조회하는 진입점.
  - `getAssetService(symbol)` / `getTokenService(symbol)` / `getAllAssetServices()` / `getAllTokenServices()`
  - `getSupportedAssets()` → `['ETH','POL','KLAY','KONET','sol','xlm','btc','bch']` (EVM 은 assetName, 그 외는 체인 심볼)
  - `getSupportedTokens()` → `['erc20-token','kip7-token','spl-token']`
  - EVM 자산/토큰은 `ETHEREUM_COMMON_SERVICES` / `ETHEREUM_TOKEN_COMMON_SERVICES` 배열로 주입받아 각 인스턴스를 symbol(자산=assetName, 토큰=tokenName)로 등록한다.
  - ⚠️ asset/token 이 심볼을 공유하므로, token 조회 키는 내부적으로 `${symbol}-token` 으로 구분한다.

### 다른 모듈에서 사용하는 법

```ts
@Module({ imports: [BlockchainModule] })
export class SomeModule {}

@Injectable()
export class SomeService {
  constructor(private readonly blockchain: BlockchainService) {}

  async run() {
    const eth = this.blockchain.getAssetService('eth');
    await eth.getTransactions('0x...');
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
| btc / bch | watch-only 디스크립터 지갑 import 후 `listtransactions`/`listsinceblock`, 또는 ElectrumX/Fulcrum | blockhash | 주소 사전 등록 + rescan 필요 (stateful) |

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
