# 노드 기반으로 특정 주소의 트랜잭션 가져오기 (체인별 정리)

> 전제: 익스플로러(Etherscan 등) API 가 아니라 **자체 노드**(eth/polygon/btc/xlm/sol 노드 등)에 직접 요청한다.
> 대상 자산: `eth`(ethereum-common), `polygon`(추가 예정, EVM), `sol`, `xlm`, `btc`, `bch` + 토큰 `eth-token`(ERC20), `sol-token`(SPL).

## ⚠️ 핵심 결론

"특정 주소의 모든 tx" 를 노드에서 가져오는 능력은 체인마다 다르다:

| 체인 | 표준 노드에 "주소→tx" 메서드 존재? | 노드로 가져오는 실질적 방법 | 페이징 커서 | 선행 조건 |
|------|:---:|------|------|------|
| EVM (eth, polygon) | ❌ 없음 | Erigon **Otterscan `ots_*`** 또는 **`trace_filter`**, 최후엔 블록 풀스캔 | blockNumber | archive 노드 권장 |
| ERC20 (eth-token) | ❌ (logs로) | **`eth_getLogs`** Transfer 이벤트 필터 | blockNumber | - |
| Solana (sol) | ✅ 있음 | **`getSignaturesForAddress`** → `getTransaction` | signature | full 히스토리는 archive 노드 |
| SPL (sol-token) | ✅ 있음 | 토큰계정에 `getSignaturesForAddress` (계정은 `getTokenAccountsByOwner`) | signature | archive 노드 |
| Stellar (xlm) | ✅ 있음(Horizon) | **Horizon `GET /accounts/{id}/transactions`** | paging_token | stellar-core + Horizon 운영 |
| Bitcoin (btc) | ❌ 없음 | **watch-only 디스크립터 지갑** import 후 `listtransactions`/`listsinceblock`, 또는 Electrum계열 인덱서 | block(`listsinceblock`) | 주소 import + rescan |
| Bitcoin Cash (bch) | ❌ 없음 | btc 와 동일 (BCH Node + Fulcrum/ElectrumX) | block | 주소 import + rescan |

→ **공통점**: 전부 커서 기반 페이징이며, "한 방에 다 가져오기"가 아니라 **증분 스캔(마지막 지점 이후)** 으로 설계해야 한다.
→ **BTC/BCH는 stateful**: 주소를 노드(지갑)에 먼저 등록하고 과거분은 rescan 해야 한다. hot/cold 주소는 미리 알고 있으므로 이 방식이 적합하다.

---

## EVM — eth, polygon (ethereum-common)

표준 JSON-RPC(geth/erigon/reth)에는 "주소의 모든 tx" 메서드가 **없다.** `eth_getTransactionByHash`, `eth_getBlockByNumber` 만으로는 주소 검색이 불가.

노드로 하는 방법 (택1, archive 노드 전제):

1. **Otterscan API (Erigon)** — 권장
   - `ots_searchTransactionsBefore(address, blockNumber, pageSize)` / `ots_searchTransactionsAfter(...)`
   - 주소의 inbound(to)/outbound(from) + **internal**(컨트랙트 콜 스택에서의 ETH 이동)까지 반환. 페이징됨.
   - 요구사항: Erigon archive + `--http.api=...,ots` 활성화. (reth 도 ots_ 지원 추가 중)
2. **trace_filter** (Erigon/Nethermind 의 trace 네임스페이스)
   - `fromAddress`/`toAddress` + 블록 범위로 필터. internal tx/value 이동 포함. archive 부하 큼.
3. **블록 풀스캔** (최후 수단)
   - `eth_getBlockByNumber(n, true)` 로 블록의 full tx 순회하며 from/to 매칭. 네이티브 전송은 잡지만 O(체인 길이). 커서 = 블록 높이.

증분: 마지막 처리 blockNumber 를 커서로 저장. polygon 도 동일(EVM).

## ERC20 토큰 (ethereum-token-common)

- **`eth_getLogs`** 로 `Transfer(address indexed from, address indexed to, uint256)` 이벤트 필터.
  - `topics[0]` = Transfer 시그니처 해시, `topics[1]`/`topics[2]` 에 대상 주소(32바이트 패딩)를 넣어 from/to 매칭.
  - `address` 파라미터로 특정 토큰 컨트랙트만, 또는 비워서 전체.
- ⚠️ 네이티브 ETH 전송은 로그를 안 남기므로 getLogs 로는 안 잡힌다(그건 AssetService 쪽 담당).

---

## Solana — sol (+ SPL)

표준 RPC 에 주소 검색 메서드가 **있다.**

1. `getSignaturesForAddress(address, { before, until, limit })` — limit 최대 1000.
   - 페이징: 결과의 마지막 signature 를 다음 호출 `before` 로 넘겨 1000 미만이 올 때까지 반복(과거 방향).
   - 증분: 마지막으로 처리한 signature 를 `until` 로 주면 그 이후 신규만.
2. 각 signature 에 대해 `getTransaction(signature, { maxSupportedTransactionVersion: 0 })` 로 상세.
- **SPL**: 대상 토큰 계정 주소에 동일하게 `getSignaturesForAddress`. 소유자의 토큰계정 목록은 `getTokenAccountsByOwner`.
- ⚠️ 일반 RPC 노드는 오래된 히스토리를 가지치기(prune)함 → 전체 이력은 **archive 노드** 필요. 커서 = signature.

---

## Stellar — xlm

stellar-core 자체는 REST 질의를 안 한다. 질의는 **Horizon**(core 위의 API 서버)로 한다. 즉 XLM "노드 인프라" = stellar-core + 자체 Horizon.

- `GET /accounts/{address}/transactions?cursor={paging_token}&limit=200&order=asc`
- payment 단위는 `/accounts/{id}/payments`, operation 단위는 `/accounts/{id}/operations`.
- 커서 기반 페이징(`paging_token`), `order=asc`+커서로 증분. SSE 스트리밍(`cursor=now`)으로 실시간 수신도 가능.

---

## Bitcoin / Bitcoin Cash — btc, bch (UTXO)

Bitcoin Core 는 임의 주소에 대한 **주소 인덱스가 없다.** `txindex=1` 은 해시로 tx 조회만 가능하게 할 뿐 주소 검색은 안 된다.

노드로 하는 방법:

1. **watch-only 디스크립터 지갑** — 주소를 미리 아는 경우(=우리 hot/cold) 권장
   - `importdescriptors` 로 주소/디스크립터(또는 xpub) 등록 (Core ≥ 0.21).
   - 과거 이력은 `rescanblockchain` 으로 스캔(시간 소요).
   - 조회: `listtransactions "*" <count>` (라벨 필터 해제), 증분은 `listsinceblock <blockhash>` (커서 = 응답의 `lastblock`).
2. **외부 인덱서** (임의 주소 전체 이력이 필요할 때 표준)
   - Electrum 계열 서버(**ElectrumX / Fulcrum**)가 `blockchain.scripthash.get_history` 제공. 또는 Esplora/electrs.
   - 노드 위에 얹는 인덱서 레이어(코어 RPC 아님).
- BCH 도 동일 모델: Bitcoin Cash Node + Fulcrum/ElectrumX.

---

## 인터페이스에 주는 시사점 (설계 메모)

현재 `AssetService.getTransactions(address)` 는 추상화로는 OK 지만, 위 현실을 반영하려면:

1. **커서/페이징 1급 지원**: `getTransactions(address, { cursor, limit })` → `{ txs, nextCursor }`.
   커서 타입이 체인마다 다름(EVM=blockNumber, Solana=signature, XLM=paging_token, BTC=blockhash) → 불투명(opaque) 문자열 커서로 추상화 권장.
2. **BTC/BCH 의 stateful 특성**: 스캔 전에 "주소 등록(register/watch)" 단계가 필요할 수 있음 → 인터페이스에 `registerAddress(address)` 같은 선택적 훅 고려.
3. **archive 노드 의존성**: 전체 이력 vs 최근만 — 운영상 archive 노드 필요 여부를 체인별로 문서화.
4. tx-scanner 는 "전부 가져오기"가 아니라 **마지막 커서 이후 증분 스캔 + 커서 영속화**로 구현해야 함.
