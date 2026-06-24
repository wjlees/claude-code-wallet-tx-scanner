/**
 * 노드 접속 URL/자격증명은 환경변수에서 읽는다.
 * 설정이 없으면 undefined → 해당 자산은 스캔을 skip 한다(노드 없이도 부팅/테스트 가능).
 *
 * 예시 env:
 *   ETHEREUM_NODE_URL=https://...   POLYGON_NODE_URL=...   KLAYTN_NODE_URL=...   KONET_NODE_URL=...
 *   SOLANA_RPC_URL=https://...      STELLAR_HORIZON_URL=https://horizon.stellar.org
 *   BITCOIN_RPC_URL=http://user:pass@host:8332   BCH_RPC_URL=http://user:pass@host:8332
 */
export function getEnv(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

/** EVM 네트워크 노드 URL (networkName 기준, 예: 'ethereum' → ETHEREUM_NODE_URL) */
export function getEvmNodeUrl(networkName: string): string | undefined {
  return getEnv(`${networkName.toUpperCase()}_NODE_URL`);
}
