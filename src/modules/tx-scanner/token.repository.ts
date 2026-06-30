import { Injectable, Logger } from '@nestjs/common';
import { TokenTypeId } from '../blockchain/constants';

/**
 * `main.token` 테이블 1행. 한 토큰(컨트랙트)을 나타낸다.
 *
 * 핵심: **토큰마다 자기 asset id(`assetId`)를 가진다**(코인과 한 id 공간 공유, 고유).
 *   한 `tokenTypeId`(예: erc20)에 여러 행이 있을 수 있고, 각 행이 서로 다른
 *   `assetId` + `contractAddress` 를 가진다. 토큰 서비스는 그 목록을 모두 감지한다.
 */
export interface TokenRow {
  /** 토큰 자체 asset id (= wallet_scanner_asset.id / detected_transactions.asset_id) */
  assetId: number;
  /** 토큰 타입 (어느 TokenService 가 처리하는지) */
  tokenTypeId: number;
  /** 토큰 컨트랙트/mint 주소 (transfer 필터 기준) */
  contractAddress: string;
  /** 로깅용 심볼 */
  symbol: string;
}

/**
 * 토큰 메타 저장소. monorepo: `main.token` 을 `token_type_id` 로 조회
 * (`SELECT asset_id, contract_address FROM token WHERE token_type_id = ?`).
 *
 * NOTE: prototype 은 stub. 실제 DB 로 교체 시 이 인터페이스만 유지하면 호출부는 안 바뀐다.
 */
export interface TokenRepository {
  /** 해당 token_type 에 속한 토큰 목록. tx-scanner 가 토큰마다 러너를 만든다. */
  getTokensByType(tokenTypeId: number): Promise<TokenRow[]>;
}

export const TOKEN_REPOSITORY = 'TokenRepository';

/**
 * in-memory stub (DB 미연결). 실제로는 `main.token` SELECT.
 *
 * 데모 포인트: **KONETTOKEN 이 토큰 2개**(asset 1002, 1003)를 가진다 — 하나의 토큰 서비스가
 *   여러 토큰을 contractAddress 로 구분해 각각 감지/진행지점 저장하는 구조를 보여준다.
 */
@Injectable()
export class StubTokenRepository implements TokenRepository {
  private readonly logger = new Logger('TokenRepository');

  // TODO(DB): main.token 으로 교체. assetId 는 코인(1~11)과 안 겹치게 1001+ stub.
  private readonly rows: TokenRow[] = [
    {
      assetId: 1001,
      tokenTypeId: TokenTypeId.KIP7,
      contractAddress: '0x1000000000000000000000000000000000000001',
      symbol: 'kip7-A',
    },
    {
      assetId: 1002,
      tokenTypeId: TokenTypeId.KONETTOKEN,
      contractAddress: '0x2000000000000000000000000000000000000002',
      symbol: 'konetToken-A',
    },
    {
      assetId: 1003,
      tokenTypeId: TokenTypeId.KONETTOKEN,
      contractAddress: '0x3000000000000000000000000000000000000003',
      symbol: 'konetToken-B',
    },
    {
      assetId: 1004,
      tokenTypeId: TokenTypeId.BASETOKEN,
      contractAddress: '0x4000000000000000000000000000000000000004',
      symbol: 'baseToken-A',
    },
    {
      assetId: 1005,
      tokenTypeId: TokenTypeId.SPL,
      contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'spl-A',
    },
    {
      assetId: 1006,
      tokenTypeId: TokenTypeId.TRC20,
      contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      symbol: 'trc20-A',
    },
  ];

  async getTokensByType(tokenTypeId: number): Promise<TokenRow[]> {
    const tokens = this.rows.filter((r) => r.tokenTypeId === tokenTypeId);
    this.logger.log(
      `getTokensByType(tokenType#${tokenTypeId}) → ${tokens.length} token(s) [${tokens
        .map((t) => `${t.symbol}#${t.assetId}`)
        .join(', ')}] (stub)`,
    );
    return tokens;
  }
}
