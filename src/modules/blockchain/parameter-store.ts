import 'dotenv/config';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * 파라미터 저장소 — 현재는 `parameter.json` 파일 기반 stub.
 *
 * monorepo `ParamStore` 와 동일하게 **자산별 path 아래 필드** 모델을 쓴다:
 *   `getParametersByPath(path)` → `{ nodeUrl?, maxScanRange?, ... }`.
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

/** 자산 path 의 파라미터 객체 (예: getParametersByPath('konet') → { nodeUrl, maxScanRange }). */
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
 * 1회 스캔 범위(블록수/page limit) = `getParametersByPath(path).maxScanRange`.
 * **필수값** — 미설정/0이하면 throw (기본값으로 조용히 진행하지 않는다).
 * 노드 핸들 초기화(onModuleInit) 시점에 함께 조회하므로 누락되면 그 자산은 초기화 실패.
 */
export async function getMaxScanRange(path: string): Promise<number> {
  const raw = (await getParametersByPath(path)).maxScanRange;
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `parameter.json path "${path}" 에 maxScanRange 가 없습니다(양수 필수).`,
    );
  }
  return n;
}
