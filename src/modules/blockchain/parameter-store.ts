import 'dotenv/config';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * 파라미터(노드 URL 등) 저장소 — 현재는 `parameter.json` 파일 기반 stub.
 *
 * NOTE: 실제로는 DB/원격 설정(ParamStore)으로 교체된다. 그래서 조회는 **async** 다 —
 *   호출부(서비스의 `resolveNodeUrl` 등)는 항상 `await` 한다. 교체 시 이 파일 내부만 바꾸면 된다.
 * 우선순위: `parameter.json` → 환경변수(process.env / .env). 미설정이면 undefined.
 */
const PARAMETER_FILE = join(process.cwd(), 'parameter.json');

let cache: Record<string, string> | undefined;

async function loadParameters(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const raw = await readFile(PARAMETER_FILE, 'utf8');
    cache = JSON.parse(raw) as Record<string, string>;
  } catch {
    // 파일이 없거나 파싱 실패 → env 폴백만 사용.
    cache = {};
  }
  return cache;
}

/** 파라미터 1개 조회 (parameter.json → env). TODO(DB): 실제 ParamStore 로 교체. */
export async function getParameter(key: string): Promise<string | undefined> {
  const params = await loadParameters();
  const v = params[key] ?? process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

/** EVM 네트워크 노드 URL (networkName → `<NETWORK>_NODE_URL`, 예: 'ethereum' → ETHEREUM_NODE_URL). */
export async function getNodeUrl(
  networkName: string,
): Promise<string | undefined> {
  return getParameter(`${networkName.toUpperCase()}_NODE_URL`);
}

/**
 * 1회 스캔 범위(블록 수 / page limit). ParamStore 의 `*_MAX_SCAN_RANGE` 에서 async 조회한다.
 * **필수값** — 미설정/비정상(0 이하·NaN)이면 throw 한다(기본값으로 조용히 진행하지 않는다).
 *   노드 핸들 초기화(onModuleInit) 시점에 함께 조회하므로, 누락되면 그 자산은 초기화에 실패한다.
 * cursor 는 "마지막 처리 지점"(절대값)으로 유지하고, 한 번에 처리할 크기만 이 값으로 조절한다.
 */
export async function getMaxScanRange(paramKey: string): Promise<number> {
  const raw = await getParameter(paramKey);
  const n = raw !== undefined ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${paramKey} not configured in parameter.json (positive number required)`,
    );
  }
  return n;
}
