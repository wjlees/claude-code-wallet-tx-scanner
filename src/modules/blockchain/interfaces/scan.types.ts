/**
 * 스캔 대상 식별 (자산/토큰). 심볼 문자열이 아니라 **숫자 id** 가 기준이다.
 * assetId / tokenTypeId 중 **최소 하나**는 있어야 한다.
 * - assetId 만: 네이티브 자산 스캔
 * - tokenTypeId 만: 토큰 스캔
 * - 둘 다: 한 번의 스캔으로 자산+토큰을 함께 감지하는 통합 대상(예: SOL ownerAddress +
 *   SPL ATA 를 동시에). 현재는 단일 식별만 사용하고, 통합은 추후 지원 여지를 위해 열어둠.
 */
export interface ScanTarget {
  assetId?: number;
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
  /** 금액 (문자열, 최소단위) */
  amount?: string;
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
