import { BigNumber } from 'bignumber.js';

/** DB 저장 금액 단위: 사토시(8자리 정수). */
export const SATOSHI_DECIMALS = 8;

/**
 * 체인 원본 최소단위 금액(raw, `rawDecimal` 자리)을 **사토시(8자리 정수)**로 환산한다.
 * 8자리 미만은 **버림(floor)**. 큰 수 정밀도 위해 `BigNumber` 사용(§CLAUDE.md 6).
 *
 * 예: wei(rawDecimal=18) → `raw / 10^10`, XRP drops(6) → `raw * 10^2`, satoshi(8) → 그대로.
 * (모든 체인은 blockchain 층에서 raw 를 **정수 최소단위**로 맞춰 반환한다. UTXO 도 satoshi 정수.)
 */
export function toSatoshi(raw: string, rawDecimal: number): string {
  return new BigNumber(raw)
    .shiftedBy(SATOSHI_DECIMALS - rawDecimal)
    .integerValue(BigNumber.ROUND_DOWN)
    .toFixed(0);
}
