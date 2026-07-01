/**
 * EVM JSON-RPC batch 호출 헬퍼.
 *
 * 여러 요청을 **한 HTTP 페이로드(JSON-RPC 2.0 배열)**로 묶어 왕복 횟수를 줄이고,
 * 큰 요청은 청크로 나눠 **Promise.all 로 병렬** 전송한다(왕복↓ + 동시성↑).
 * web3 인스턴스 대신 노드 URL 로 직접 fetch 한다(배치 지원이 provider 버전에 안 걸리게).
 */

/** 한 batch 페이로드에 담는 최대 요청 수(응답 크기·노드 제한 고려). */
const BATCH_CHUNK = 100;

export function numberToHex(n: number): string {
  return '0x' + n.toString(16);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * JSON-RPC batch 호출. 입력 순서와 **동일 순서**의 result 배열을 반환한다(실패 항목은 undefined).
 * 청크별로 병렬 전송하며, 각 청크 내부는 id 로 원위치 매핑.
 */
export async function jsonRpcBatch(
  url: string,
  calls: RpcCall[],
): Promise<any[]> {
  if (calls.length === 0) return [];

  const chunks = chunk(calls, BATCH_CHUNK);
  const perChunk = await Promise.all(
    chunks.map(async (group) => {
      const body = group.map((c, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: c.method,
        params: c.params,
      }));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`JSON-RPC batch HTTP ${res.status}`);
      }
      const json = (await res.json()) as { id: number; result?: any }[];
      const byId = new Map(json.map((j) => [j.id, j.result]));
      // 요청 순서대로 결과 정렬(응답은 순서 보장 안 됨).
      return group.map((_, i) => byId.get(i));
    }),
  );

  return perChunk.flat();
}
