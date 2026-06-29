/**
 * XPLA Chain (Cosmos SDK) LCD REST 저수준 클라이언트 (내장 fetch).
 *
 * NOTE: 공식 SDK `@xpla/xpla.js` 는 **top-level import 만으로 부팅 크래시**를 일으킨다
 *   (pnpm 에서 `@xpla/xpla.proto` v2 누락 → import 시점 throw). 그래서 SDK 를 쓰지 않고
 *   Cosmos LCD REST 를 직접 호출한다(XrpRpcClient 와 동일한 fetch 패턴).
 */
export class XplaRestClient {
  private readonly baseUrl: string;

  constructor(rawUrl: string) {
    this.baseUrl = rawUrl.replace(/\/+$/, ''); // 끝 슬래시 제거
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`XPLA LCD ${path} HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** 최신 블록 높이 */
  async getLatestHeight(): Promise<number> {
    const r = await this.get<{ block?: { header?: { height?: string } } }>(
      '/cosmos/base/tendermint/v1beta1/blocks/latest',
    );
    return Number(r.block?.header?.height ?? 0);
  }

  /**
   * 특정 높이의 tx 응답 목록 (events + tx.body.memo 포함).
   * 최신 Cosmos SDK(0.50+)는 `query` 파라미터를 쓴다(`events=` 는 410/500). `=` 는 %3D 인코딩.
   */
  async getTxsByHeight(height: number): Promise<any[]> {
    const r = await this.get<{ tx_responses?: any[] }>(
      `/cosmos/tx/v1beta1/txs?query=tx.height%3D${height}&pagination.limit=100`,
    );
    return r.tx_responses ?? [];
  }

  /** 특정 denom 잔고 */
  async getBalance(address: string, denom: string): Promise<string> {
    const r = await this.get<{ balance?: { amount?: string } }>(
      `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${denom}`,
    );
    return r.balance?.amount ?? '0';
  }
}
