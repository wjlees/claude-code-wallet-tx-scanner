import { Logger } from '@nestjs/common';
import { DetectedTx } from './interfaces/scan.types';

/**
 * BTC/BCH 공용 UTXO 노드 스캐너 (bitcoind 계열 JSON-RPC).
 *
 * Bitcoin Core 는 임의 주소 인덱스가 없으므로, 여기서는 블록을 verbose(2)로 받아
 * **vout 의 수신 주소**가 대상이면 'in' 으로 감지한다.
 * 'out'(우리 UTXO 소비)은 prevout 추적이 필요해 watch-only 지갑(listsinceblock)이 더 적합 → TODO.
 *
 * 노드 URL 은 `http://user:pass@host:port` 형태를 지원(자격증명은 Basic 헤더로 변환).
 */
export class UtxoRpcScanner {
  private readonly endpoint: string;
  private readonly authHeader?: string;

  constructor(
    rawUrl: string,
    private readonly logger: Logger,
  ) {
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
          if (hit) {
            txs.push({
              txHash: tx.txid,
              direction: 'in',
              address: hit,
              amount: vout.value !== undefined ? String(vout.value) : undefined,
              raw: tx,
            });
          }
        }
        // TODO(RPC): 'out' 감지는 vin.prevout 추적 또는 watch-only listsinceblock 사용.
      }
    }
    return txs;
  }
}
