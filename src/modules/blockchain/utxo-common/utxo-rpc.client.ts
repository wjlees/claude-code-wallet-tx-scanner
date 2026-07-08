import { BigNumber } from 'bignumber.js';
import { DetectedTx } from '../interfaces/scan.types';

type BN = InstanceType<typeof BigNumber>;

/**
 * bitcoind 계열 노드(Bitcoin Core / Bitcoin Cash Node)용 저수준 JSON-RPC 클라이언트.
 *
 * 노드 1개(=URL 1개)에 대응한다. BTC/BCH 가 각자 자기 노드로 인스턴스를 만든다.
 * 노드 URL 은 `http://user:pass@host:port` 형태를 지원(자격증명은 Basic 헤더로 변환).
 *
 * 감지:
 *  - **수신(vout)**: vout 수신 주소가 대상이면 기록.
 *  - **출금·수수료(vin)**: vin 이 우리 주소의 UTXO 를 소비하면 우리가 낸 tx → fee=Σvin−Σvout 로
 *    native fee 행 기록(§14). vin 은 prevout 값·주소가 필요:
 *    · `prevoutInline`(getblock verbosity 3, Core 25+): 블록 응답의 `vin.prevout` 인라인(추가 콜 0).
 *    · 미지원: vin 마다 `getrawtransaction` 으로 prevout 조회(fallback; 저볼륨 체인용).
 *  NOTE: 대규모 체인에서 fallback 은 무거움 → 실제로는 `wallet_scanner_unspents` 테이블 권장(개선사항).
 *  NOTE: 우리에게 돌아오는 change vout 도 '수신'으로 잡힘(change 판별은 별도 검토).
 */
export class UtxoRpcClient {
  private readonly endpoint: string;
  private readonly authHeader?: string;

  constructor(rawUrl: string) {
    const u = new URL(rawUrl);
    if (u.username || u.password) {
      const token = Buffer.from(
        `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
      ).toString('base64');
      this.authHeader = `Basic ${token}`;
      u.username = '';
      u.password = '';
    }
    this.endpoint = u.toString();
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authHeader ? { authorization: this.authHeader } : {}),
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'scan', method, params }),
    });
    if (!res.ok) {
      throw new Error(`RPC ${method} HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result: T; error: unknown };
    if (json.error) {
      throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }

  async getBlockCount(): Promise<number> {
    return this.rpc<number>('getblockcount');
  }

  /** scriptPubKey 에서 주소 목록 추출(구/신 필드 모두 대응). */
  private outAddrs(spk: any): string[] {
    return spk?.address ? [spk.address] : (spk?.addresses ?? []);
  }

  /** BTC 소수 값 → satoshi(8자리) 정수 문자열. */
  private toSat(btc: BN | string | number): string {
    return new BigNumber(btc).shiftedBy(8).toFixed(0);
  }

  /** tx 의 vin prevout(주소·값·outpoint)을 해소. inline(v3) 이면 vin.prevout, 아니면 getrawtransaction. */
  private async resolveVins(
    tx: any,
    prevoutInline: boolean,
  ): Promise<
    { address?: string; value: number; txId: string; txIndex: number }[]
  > {
    const out: {
      address?: string;
      value: number;
      txId: string;
      txIndex: number;
    }[] = [];
    for (const vin of tx.vin ?? []) {
      if (vin.coinbase) continue; // 코인베이스는 prevout 없음
      const outpoint = { txId: vin.txid, txIndex: vin.vout };
      if (prevoutInline) {
        const p = vin.prevout;
        if (!p) continue;
        out.push({
          address: this.outAddrs(p.scriptPubKey)[0],
          value: Number(p.value),
          ...outpoint,
        });
      } else {
        const prev = await this.rpc<any>('getrawtransaction', [vin.txid, true]);
        const pv = prev?.vout?.[vin.vout];
        if (!pv) continue;
        out.push({
          address: this.outAddrs(pv.scriptPubKey)[0],
          value: Number(pv.value),
          ...outpoint,
        });
      }
    }
    return out;
  }

  /**
   * 백필용: 주소들의 **현재 살아있는 UTXO 전부**를 UTXO set 스캔으로 조회
   * (`scantxoutset`, Core 0.17+; txindex 불필요, 수십초~수분 소요 — 일회성 프로비저닝 용도).
   * 이미 잔고 있는 주소를 감시 목록에 추가할 때 unspents 테이블 초기 적재(§17)에 쓴다.
   * 노드 미지원 시 throw → 외부 인덱서(Electrum/Esplora) 등 대체 필요.
   */
  async scanTxOutset(addresses: string[]): Promise<
    {
      txId: string;
      txIndex: number;
      address: string;
      amountSat: string;
      height: number;
    }[]
  > {
    const result = await this.rpc<any>('scantxoutset', [
      'start',
      addresses.map((a) => `addr(${a})`),
    ]);
    return (result?.unspents ?? []).map((u: any) => ({
      txId: u.txid,
      txIndex: u.vout,
      // desc 에서 주소 복원이 번거로우므로 단일 주소 스캔이 아니면 scriptPubKey 매칭 필요 — 여기선 desc 기반 best-effort.
      address: String(u.desc ?? '').replace(/^addr\((.*)\)#.*$/, '$1'),
      amountSat: this.toSat(u.amount),
      height: Number(u.height ?? 0),
    }));
  }

  /** from..to 블록을 스캔: 수신(vout∈watch) + 출금/fee(vin∈watch, §14) 를 반환. */
  async scanRange(
    from: number,
    to: number,
    addresses: string[],
    prevoutInline: boolean,
  ): Promise<DetectedTx[]> {
    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let height = from; height <= to; height++) {
      const hash = await this.rpc<string>('getblockhash', [height]);
      // verbosity 3 = vin.prevout 인라인(Core 25+), 아니면 2.
      const block = await this.rpc<any>('getblock', [
        hash,
        prevoutInline ? 3 : 2,
      ]);
      for (const tx of block.tx ?? []) {
        const vins = await this.resolveVins(tx, prevoutInline);
        const isFrom = vins.some((v) => v.address && watch.has(v.address));

        // 수신: 대상 주소로 온 vout (change 포함 — 별도 검토). vout 인덱스로 tx_index.
        for (const vout of tx.vout ?? []) {
          const hit = this.outAddrs(vout.scriptPubKey).find((a) =>
            watch.has(a),
          );
          if (hit && Number(vout.value) > 0) {
            txs.push({
              txHash: tx.txid,
              toAddress: hit,
              amount: this.toSat(vout.value),
              blockNumber: height,
              txIndex: vout.n,
              status: 1, // 블록 포함 = 유효
              utxo: { created: true }, // 우리 UTXO 생성 → unspents INSERT(§17)
              raw: tx,
            });
          }
        }

        // 출금·수수료: 우리 UTXO 를 vin 으로 소비 → 우리가 fee 를 냄(§14 native fee 행).
        if (isFrom) {
          const inSum = vins.reduce(
            (s, v) => s.plus(v.value || 0),
            new BigNumber(0),
          );
          const outSum = (tx.vout ?? []).reduce(
            (s: BN, o: any) => s.plus(o.value || 0),
            new BigNumber(0),
          );
          const fee = inSum.minus(outSum); // BTC
          // 외부(비-watch) 로 나간 금액 = 실제 출금액.
          const sentOut = (tx.vout ?? [])
            .filter(
              (o: any) =>
                !this.outAddrs(o.scriptPubKey).some((a) => watch.has(a)),
            )
            .reduce((s: BN, o: any) => s.plus(o.value || 0), new BigNumber(0));
          const ourVins = vins.filter((v) => v.address && watch.has(v.address));
          txs.push({
            txHash: tx.txid,
            fromAddress: ourVins[0]?.address,
            amount: this.toSat(sentOut),
            // fee 는 모든 vin 이 해소돼 inSum≥outSum 일 때만(부분 해소 시 음수→생략).
            feeAmount: fee.gte(0) ? this.toSat(fee) : undefined,
            status: 1,
            blockNumber: height,
            // vout 인덱스(0..n-1)와 겹치지 않게 vout 개수를 fee 행 tx_index 로.
            txIndex: (tx.vout ?? []).length,
            // 이 tx 가 소비한 우리 outpoint 들 → unspents usable=0 처리(§17).
            utxo: {
              spentOutpoints: ourVins.map((v) => ({
                txId: v.txId,
                txIndex: v.txIndex,
              })),
            },
            raw: tx,
          });
        }
      }
    }
    return txs;
  }
}
