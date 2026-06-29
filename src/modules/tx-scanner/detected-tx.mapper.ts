import { TokenTypeId } from '../blockchain/constants';
import { DetectedTx, ScanTarget } from '../blockchain/interfaces/scan.types';
import { InsertDetectedTransactionParams } from './detected-transactions.repository';

/**
 * 토큰 타입 → stub assetId (runner/cursor 키용, **토큰타입 단위** — 코인 assetId 와 안 겹치게 1001+).
 *
 * ⚠️ 목표(monorepo 의도): detected_transactions.asset_id 는 **토큰 자체 assetId**(예: USDC) 로,
 *   온체인 transfer 의 `contractAddress` 로 `main.token` 을 조회해 얻는다(per-tx).
 *   현재는 양쪽(prototype·monorepo) 모두 미정렬 — 토큰타입 단위 stub 으로 둔다. TODO(DB).
 */
const STUB_TOKEN_ASSET_ID: Record<number, number> = {
  [TokenTypeId.KIP7]: 1001,
  [TokenTypeId.KONETTOKEN]: 1002,
  [TokenTypeId.BASETOKEN]: 1003,
  [TokenTypeId.SPL]: 1004,
  [TokenTypeId.TRC20]: 1005,
};

/** ScanTarget → 저장/조회에 쓸 assetId (토큰이면 토큰타입 stub assetId). cursor 키·저장 공용. */
export function resolveStoreAssetId(target: ScanTarget): number {
  // 통합 대상(둘 다)은 아직 미사용 — 자산 우선, 없으면 토큰.
  if (target.assetId !== undefined) {
    return target.assetId;
  }
  if (target.tokenTypeId !== undefined) {
    return STUB_TOKEN_ASSET_ID[target.tokenTypeId] ?? target.tokenTypeId;
  }
  return 0;
}

/** tx.raw 에서 블록번호 추출(체인별 상이, 없으면 undefined). */
function extractBlockNumber(tx: DetectedTx): number | undefined {
  const raw = tx.raw as any;
  const bn = raw?.blockNumber ?? raw?.block_number ?? raw?.ledger_index;
  return bn !== undefined && bn !== null ? Number(bn) : undefined;
}

/**
 * `DetectedTx` + `ScanTarget` → `InsertDetectedTransactionParams`.
 *
 * 방향 기준 매핑: out 이면 from=내주소/to=상대, in 이면 from=상대/to=내주소.
 * (SOL/SPL 처럼 direction 미상이면 in 으로 취급 — 내주소가 to)
 * amount 없는 체인(signature-only 등)은 '0'(NOT NULL).
 */
export function mapDetectedTxToInsertParams(
  target: ScanTarget,
  tx: DetectedTx,
): InsertDetectedTransactionParams {
  const isOut = tx.direction === 'out';
  return {
    assetId: resolveStoreAssetId(target),
    fromAddress: isOut ? tx.address : tx.counterparty,
    toAddress: isOut ? tx.counterparty : tx.address,
    txId: tx.txHash,
    blockNumber: extractBlockNumber(tx),
    amount: tx.amount ?? '0',
    feeAmount: undefined, // TODO: 체인별 수수료 파싱
    note: tx.memoId,
    status: 0,
  };
}
