import { ScanResult } from './scan.types';

/**
 * 특정 체인 위에서 발행되는 토큰을 다루는 서비스 인터페이스.
 * ethereum-token-common, spl 등이 구현한다.
 */
export interface TokenService {
  /** 토큰 타입 식별 번호 (`TokenTypeId`). 서비스 매핑·식별의 1차 키. */
  getTokenTypeId(): number;

  /** 토큰이 속한 체인/토큰 식별 심볼 (로깅용 보조값) */
  readonly symbol: string;

  /** 이 토큰을 스캔할 권장 폴링 간격(ms). */
  readonly scanIntervalMs: number;

  /**
   * 대상 주소들의 신규 in/out 토큰 트랜잭션을 감지한다.
   * (EVM 토큰 = Transfer 이벤트 로그, SPL = 토큰계정 signature 등 — 자산이 알아서)
   *
   * 하나의 TokenService(=token_type)가 **여러 토큰을 한 번에** 스캔한다. `contractAddresses`
   * 로 이 token_type 에 속한 토큰 컨트랙트 목록을 받아 그 컨트랙트들의 transfer 만 수집하고,
   * **각 tx 에 `contractAddress` 를 채워** 어느 토큰인지 분류 가능하게 한다(저장 단계에서 asset_id 매핑).
   */
  scanTransactions(
    addresses: string[],
    cursor: string | null,
    contractAddresses: string[],
  ): Promise<ScanResult>;

  /** 주소의 특정 토큰 잔고를 조회한다. */
  getTokenBalance(address: string, tokenAddress: string): Promise<string>;

  /** 토큰의 메타데이터(이름, 심볼, decimals 등)를 조회한다. */
  getTokenMetadata(tokenAddress: string): Promise<unknown>;
}
