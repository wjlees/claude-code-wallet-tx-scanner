/**
 * XRP Ledger (rippled) JSON-RPC 저수준 클라이언트 (내장 fetch).
 *
 * NOTE: 공식 SDK `xrpl` 은 `@noble/hashes@2`(ESM-only)를 강제해 CJS 빌드에서
 * ERR_REQUIRE_ESM 으로 깨진다(CLAUDE.md ESM 제약 참고). 그래서 SDK 대신
 * rippled JSON-RPC 를 직접 호출한다(UtxoRpcClient 와 동일한 fetch 패턴).
 */
export class XrpRpcClient {
  constructor(private readonly endpoint: string) {}

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params: [params] }),
    });
    if (!res.ok) {
      throw new Error(`rippled ${method} HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result: T & { error?: string } };
    if ((json.result as any)?.error) {
      throw new Error(
        `rippled ${method} error: ${JSON.stringify((json.result as any).error)}`,
      );
    }
    return json.result;
  }

  /**
   * 마지막 **validated** ledger index. (`ledger_current` 는 미검증 진행분이라 스캔 기준으로
   * 쓰면 안 됨 — validated 만 최종.)
   */
  async getValidatedLedgerIndex(): Promise<number> {
    const r = await this.rpc<{
      ledger_index?: number;
      ledger?: { ledger_index?: string | number };
    }>('ledger', { ledger_index: 'validated' });
    return Number(r.ledger_index ?? r.ledger?.ledger_index ?? 0);
  }

  /**
   * 특정 ledger 의 **전체 tx + metadata** (`transactions: true, expand: true` — 1콜).
   * 반환 엔트리: rippled api v1 은 tx 필드 톱레벨 + `metaData`, v2 는 `tx_json` + `meta`.
   */
  async getLedgerTxs(ledgerIndex: number): Promise<any[]> {
    const r = await this.rpc<{ ledger?: { transactions?: any[] } }>('ledger', {
      ledger_index: ledgerIndex,
      transactions: true,
      expand: true,
    });
    return r.ledger?.transactions ?? [];
  }

  async getBalance(account: string): Promise<string> {
    const r = await this.rpc<{ account_data?: { Balance?: string } }>(
      'account_info',
      { account, ledger_index: 'validated' },
    );
    return r.account_data?.Balance ?? '0';
  }
}
