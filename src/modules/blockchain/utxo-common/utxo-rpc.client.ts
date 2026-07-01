import { BigNumber } from 'bignumber.js';
import { DetectedTx } from '../interfaces/scan.types';

/**
 * bitcoind 계열 노드(Bitcoin Core / Bitcoin Cash Node)용 저수준 JSON-RPC 클라이언트.
 *
 * 노드 1개(=URL 1개)에 대응한다. BTC/BCH 가 각자 자기 노드로 인스턴스를 만든다.
 * 노드 URL 은 `http://user:pass@host:port` 형태를 지원(자격증명은 Basic 헤더로 변환).
 *
 * Bitcoin Core 는 임의 주소 인덱스가 없으므로, 여기서는 블록을 verbose(2)로 받아
 * **vout 의 수신 주소**가 대상이면 'in' 으로 감지한다.
 * 'out'(우리 UTXO 소비)은 prevout 추적이 필요해 watch-only 지갑(listsinceblock)이 더 적합 → TODO.
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

  /** from..to 블록을 스캔해 vout 수신이 대상 주소인 tx 를 'in' 으로 반환 */
  async scanRange(
    from: number,
    to: number,
    addresses: string[],
  ): Promise<DetectedTx[]> {
    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let height = from; height <= to; height++) {
      const hash = await this.rpc<string>('getblockhash', [height]);
      const block = await this.rpc<any>('getblock', [hash, 2]); // verbose tx
      for (const tx of block.tx ?? []) {
        for (const vout of tx.vout ?? []) {
          const spk = vout.scriptPubKey ?? {};
          const outAddrs: string[] = spk.address
            ? [spk.address]
            : (spk.addresses ?? []);
          const hit = outAddrs.find((a) => watch.has(a));
          if (hit && Number(vout.value) > 0) {
            // vout.value 는 BTC 소수 → satoshi(10^8) 정수로 맞춰 raw 최소단위 통일(rawDecimal=8).
            // vout 수신자 = toAddress. 보낸 주소(fromAddress)는 prevout 추적 필요(TODO) → 생략.
            txs.push({
              txHash: tx.txid,
              toAddress: hit,
              amount: new BigNumber(vout.value).shiftedBy(8).toFixed(0),
              blockNumber: height,
              txIndex: vout.n, // vout 인덱스 = tx 내 위치(같은 주소 다중 vout 구분)
              raw: tx,
            });
          }
        }
        // TODO(RPC): fromAddress(보낸 주소) 는 vin.prevout 추적 또는 watch-only listsinceblock 사용.
      }
    }
    return txs;
  }
}
