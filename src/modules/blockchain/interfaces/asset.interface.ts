import { ScanResult } from './scan.types';

/**
 * 네이티브 자산(코인) 단위 블록체인을 다루는 서비스 인터페이스.
 * ethereum-common, sol, xlm, btc, bch 등이 구현한다.
 *
 * 이 인터페이스의 목적: 자산별 특성(EVM=nonce/블록, BTC=UTXO, XLM=memoId, SOL=signature)을
 * 캡슐화하여, 사용처(tx-scanner 등)가 자산 차이를 몰라도 **일관된 형태로** 쓰게 한다.
 * "새 자산을 추가하려면 최소한 이건 구현하라"는 계약.
 */
export interface AssetService {
  /** 체인/네트워크를 식별하는 심볼 */
  readonly symbol: string;

  /**
   * 이 자산을 스캔할 권장 폴링 간격(ms).
   * 자산 특성에 따라 다르다(블록 시간, 실시간성 요구 등). SOL 은 짧게, BTC 는 길게.
   */
  readonly scanIntervalMs: number;

  /**
   * 대상 주소들의 신규 in/out 트랜잭션을 감지한다.
   * @param addresses 감시할 주소들 (hot/cold)
   * @param cursor    이전 스캔의 nextCursor (없으면 null → 시작점부터)
   * @returns 감지된 tx 목록 + 다음 커서. **스캔 방식은 자산이 알아서** 결정한다.
   */
  scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult>;

  /** 주소의 네이티브 자산 잔고를 조회한다. */
  getBalance(address: string): Promise<string>;

  /** 현재 블록 높이(또는 그에 준하는 진행 지점)를 조회한다. */
  getBlockHeight(): Promise<number>;
}
