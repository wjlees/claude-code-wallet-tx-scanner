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

  /** 현재 검증 진행 중인 ledger index */
  async getCurrentLedgerIndex(): Promise<number> {
    const r = await this.rpc<{ ledger_current_index: number }>(
      'ledger_current',
      {},
    );
    return r.ledger_current_index;
  }

  /** 주소의 계정 tx 를 ledger 범위로 조회 (forward) */
  async accountTx(
    account: string,
    ledgerIndexMin: number,
    limit = 200,
  ): Promise<any[]> {
    const r = await this.rpc<{ transactions: any[] }>('account_tx', {
      account,
      ledger_index_min: ledgerIndexMin,
      ledger_index_max: -1,
      forward: true,
      limit,
    });
    return r.transactions ?? [];
  }

  async getBalance(account: string): Promise<string> {
    const r = await this.rpc<{ account_data?: { Balance?: string } }>(
      'account_info',
      { account, ledger_index: 'validated' },
    );
    return r.account_data?.Balance ?? '0';
  }
}
