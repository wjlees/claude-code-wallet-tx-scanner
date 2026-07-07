import { Injectable, Logger } from '@nestjs/common';
import { BigNumber } from 'bignumber.js';

/**
 * `crypto_address_unspents`(wallet DB) 테이블 1행 — 감시 주소들의 UTXO 원장(§17).
 *
 * 스캐너가 forward 로 유지한다: 수신(vout∈watch) 감지 → INSERT(usable=1),
 * 소비(vin=우리 outpoint) 감지 → usable=0 + spent_tx_id. 이 테이블로
 * (1) UTXO 잔고 = SUM(amount) WHERE usable=1, (2) vin O(1) 출금 탐지(대규모 체인 최적화),
 * (3) 출금 시스템의 vin 조합 재료 제공이 가능하다.
 *
 * 이미 잔고 있는 주소를 추가할 땐 `scantxoutset` 백필로 초기 적재(일회성 프로비저닝).
 */
export interface UnspentRow {
  /** 자산 id (wallet_scanner_asset.id 공간 — BTC/BCH …) */
  assetId: number;
  /** UTXO 소유(수신) 주소 */
  address: string;
  /** UTXO 를 만든 tx */
  txId: string;
  /** vout 인덱스 */
  txIndex: number;
  /** 금액 — 사토시(8자리 정수) 문자열 */
  amount: string;
  /** 1=사용가능, 0=소비됨(또는 출금 조합에 예약됨) */
  usable: number;
  /** 생성 블록 높이 */
  blockNumber?: number;
  /** 소비한 tx (usable=0 시) */
  spentTxId?: string;
  /** 소비 블록 높이 */
  spentBlockNumber?: number;
}

/**
 * unspents 저장소. 실제 구현(wallet DB `crypto_address_unspents`)은 monorepo 전용 — prototype 은 stub.
 * INSERT 는 `(asset_id, tx_id, tx_index)` 유니크로 멱등(재스캔 흡수).
 */
export interface UnspentsRepository {
  /** 수신 감지 시 UTXO 추가(중복이면 무시 — ON CONFLICT DO NOTHING/orIgnore). */
  insertUnspent(row: Omit<UnspentRow, 'usable'>): Promise<void>;
  /** 소비 감지 시 해당 outpoint 들 usable=0 (+spent 정보). 없는 outpoint 는 무시. */
  markSpent(
    assetId: number,
    outpoints: { txId: string; txIndex: number }[],
    spentTxId: string,
    spentBlockNumber?: number,
  ): Promise<void>;
  /** UTXO 잔고 = SUM(amount) WHERE usable=1 (address 생략 시 자산 전체). 사토시 문자열. */
  sumUsable(assetId: number, address?: string): Promise<string>;
}

export const UNSPENTS_REPOSITORY = 'UnspentsRepository';

/** in-memory stub (DB 미연결). 실제로는 crypto_address_unspents INSERT/UPDATE/SUM. */
@Injectable()
export class StubUnspentsRepository implements UnspentsRepository {
  private readonly logger = new Logger('UnspentsRepository');
  private readonly rows = new Map<string, UnspentRow>();

  private key(assetId: number, txId: string, txIndex: number): string {
    return `${assetId}:${txId}:${txIndex}`;
  }

  async insertUnspent(row: Omit<UnspentRow, 'usable'>): Promise<void> {
    const key = this.key(row.assetId, row.txId, row.txIndex);
    if (this.rows.has(key)) return; // 멱등(재스캔 흡수)
    this.rows.set(key, { ...row, usable: 1 });
    this.logger.log(
      `insert unspent ${key} addr=${row.address} amount=${row.amount}`,
    );
  }

  async markSpent(
    assetId: number,
    outpoints: { txId: string; txIndex: number }[],
    spentTxId: string,
    spentBlockNumber?: number,
  ): Promise<void> {
    for (const op of outpoints) {
      const row = this.rows.get(this.key(assetId, op.txId, op.txIndex));
      if (!row) continue; // 우리 UTXO 아님(백필 전 과거분일 수도) → 무시
      row.usable = 0;
      row.spentTxId = spentTxId;
      row.spentBlockNumber = spentBlockNumber;
      this.logger.log(
        `mark spent ${this.key(assetId, op.txId, op.txIndex)} by ${spentTxId}`,
      );
    }
  }

  async sumUsable(assetId: number, address?: string): Promise<string> {
    let sum = new BigNumber(0);
    for (const row of this.rows.values()) {
      if (row.assetId !== assetId || row.usable !== 1) continue;
      if (address && row.address !== address) continue;
      sum = sum.plus(row.amount);
    }
    return sum.toFixed(0);
  }
}
