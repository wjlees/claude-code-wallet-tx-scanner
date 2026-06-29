import { TokenTypeId } from '../blockchain/constants';
import { DetectedTx, ScanTarget } from '../blockchain/interfaces/scan.types';
import { InsertDetectedTransactionParams } from './detected-transactions.repository';

/**
 * 토큰 → **토큰 자체 assetId** stub 매핑.
 * NOTE: 실제로는 DB(token contract→assetId)에서 조회한다. 코인 assetId(1~11)와 겹치지 않게
 *   1001+ 를 쓴다. TODO(DB).
 */
const STUB_TOKEN_ASSET_ID: Record<number, number> = {
  [TokenTypeId.ERC20]: 1001,
  [TokenTypeId.KIP7]: 1002,
  [TokenTypeId.SPL]: 1003,
  [TokenTypeId.TRC20]: 1004,
};

/** ScanTarget → 저장/조회에 쓸 assetId (토큰이면 토큰 자체 assetId). detected_transactions·asset 공용. */
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
