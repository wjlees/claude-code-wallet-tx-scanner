import 'dotenv/config';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * 파라미터 저장소 — 현재는 `parameter.json` 파일 기반 stub.
 *
 * monorepo `ParamStore` 와 동일하게 **자산별 path 아래 필드** 모델을 쓴다:
 *   `getParametersByPath(path)` → `{ nodeUrl?, maxDepositScanRange?, ... }`.
 * NOTE: 실제로는 DB/원격 ParamStore 로 교체된다. 조회는 **async** — 호출부는 항상 await.
 * 우선순위: `parameter.json` → 환경변수(JSON 문자열로 동일 path 키). 미설정 path 는 빈 객체.
 */
const PARAMETER_FILE = join(process.cwd(), 'parameter.json');

type PathParams = Record<string, string>;
let cache: Record<string, PathParams> | undefined;

async function loadParameters(): Promise<Record<string, PathParams>> {
  if (cache) return cache;
  try {
    const raw = await readFile(PARAMETER_FILE, 'utf8');
    cache = JSON.parse(raw) as Record<string, PathParams>;
  } catch {
    cache = {};
  }
  return cache;
}

/** 자산 path 의 파라미터 객체 (예: getParametersByPath('konet') → { nodeUrl, maxDepositScanRange }). */
export async function getParametersByPath(path: string): Promise<PathParams> {
  const all = await loadParameters();
  return all[path] ?? {};
}

/** path 의 노드 URL. 미설정이면 undefined → 해당 자산 스캔 skip. */
export async function getNodeUrlByPath(
  path: string,
): Promise<string | undefined> {
  const v = (await getParametersByPath(path)).nodeUrl;
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * 1회 스캔 범위(블록수/page limit) = `getParametersByPath(path).maxDepositScanRange`.
 * 미설정/0이하면 **undefined** 반환(throw 안 함). 호출부(onModuleInit)는 undefined 면
 * 노드 미설정과 동일하게 **log 후 skip** — 앱 부팅은 계속, 해당 자산 루프만 조용히 skip.
 */
export async function getMaxDepositScanRange(
  path: string,
): Promise<number | undefined> {
  const raw = (await getParametersByPath(path)).maxDepositScanRange;
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
