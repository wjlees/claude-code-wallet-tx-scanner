/**
 * 스캔 대상 식별 (코인/토큰). 심볼 문자열이 아니라 **숫자 id** 가 기준이다.
 * `assetId`(코인) / `tokenTypeId`(토큰) 중 **최소 하나**는 있어야 한다.
 *
 * - **코인(네이티브 자산)**: `{ assetId }`. AssetService 선택·주소 조회·저장 키가 모두 이 id.
 * - **토큰**: `{ tokenTypeId }`. 한 TokenService(=token_type)가 **여러 토큰을 한 루프로** 스캔한다.
 *   어느 토큰(asset_id)인지는 스캔 결과 tx 의 `contractAddress` 로 분류한다(저장 단계).
 *   토큰 목록(asset_id+contractAddress)은 tx-scanner 가 `main.token` 에서 token_type 으로 조회.
 */
export interface ScanTarget {
  /** 코인(네이티브 자산) id. 코인일 때만. */
  assetId?: number;
  /** 토큰 타입 id. 토큰일 때만 (TokenService 선택 + 기반 체인 주소 조회). */
  tokenTypeId?: number;
}

/**
 * 스캔으로 감지된 트랜잭션 (자산 공통 표현).
 *
 * 블록에서 **있는 그대로 파싱한 값**만 담는다. in/out(방향) 같은 의미부여는 하지 않는다 —
 * from/to 만 기록하고, in/out 해석은 저장/조회 단계에서 지갑 주소와 대조해 판단한다.
 * 체인별로 from/to 를 모를 수 있다(예: SOL signature-only → 둘 다 생략).
 */
export interface DetectedTx {
  /** 트랜잭션 해시/식별자 (체인에서 유일) */
  txHash: string;
  /** 보낸 주소 (파싱 가능 시) */
  fromAddress?: string;
  /** 받는 주소 (파싱 가능 시) */
  toAddress?: string;
  /** 토큰 컨트랙트/mint 주소 (토큰 transfer 일 때). 저장 시 contractAddress→asset_id 분류에 사용. */
  contractAddress?: string;
  /**
   * tx 내 위치 인덱스 (멱등 유니크 키 `(asset_id, tx_id, tx_index)` 의 3번째).
   * 한 tx 가 동일한 transfer 를 여러 건 담을 수 있어(EVM 배치, UTXO 다중 vout) 이걸로 구분한다.
   * EVM=`log.logIndex`, UTXO=vout `n`, XPLA=이벤트 순번. 위치 개념이 없거나 tx당 1건이면 0.
   * (SOL/SPL 은 transfer 파싱 전이라 현재 미설정 → 저장 시 0 취급, signature 단위 dedup.)
   */
  txIndex?: number;
  /** 금액 (문자열, **원본 최소단위 raw**). 저장 단계에서 사토시로 환산(raw 는 raw_amount 로 보존). */
  amount?: string;
  /** 수수료 (문자열, **원본 최소단위 raw**, 있으면). EVM=gasUsed×effectiveGasPrice. 저장 시 사토시 환산. */
  feeAmount?: string;
  /** 입금 식별용 memoId/DestinationTag 등 */
  memoId?: string;
  /** 블록번호 / ledger index 등 (있으면) */
  blockNumber?: number;
  /** 체인에서 받아온 원본 */
  raw: unknown;
}

/**
 * 스캔 1회 결과.
 * cursor 는 **자산별 의미가 다른 불투명(opaque) 문자열**이다.
 * (EVM/BTC=블록번호, SOL/SPL=signature, XLM=paging_token 등)
 */
export interface ScanResult {
  txs: DetectedTx[];
  /** 다음 스캔의 시작점. null 이면 더 진행할 지점이 없음(최신까지 따라잡음). */
  nextCursor: string | null;
}
