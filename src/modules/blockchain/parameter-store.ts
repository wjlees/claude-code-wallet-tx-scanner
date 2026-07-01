import 'dotenv/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { SATOSHI_DECIMALS } from './amount';

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

/**
 * 스캔 안전 마진(confirmationThreshold). 스캔 끝을 `head - confirmationThreshold` 로 캡해
 * reorg 로 뒤집힐 수 있는 최근 블록을 감지에서 제외한다(감지 tx 는 항상 ≥confirmationThreshold 확정).
 * 미설정이면 **0**(캡 없음). monorepo 의 `confirmationThreshold` 와 같은 개념.
 */
export async function getConfirmationThreshold(path: string): Promise<number> {
  const raw = (await getParametersByPath(path)).confirmationThreshold;
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 체인 원본 최소단위의 자릿수(rawDecimal). 금액을 사토시(8자리)로 환산할 때 쓴다.
 * 코인은 체인 상수(EVM=18, BTC/BCH=8, SOL=9, XLM=7, XRP/TRX/XPLA=6). 미설정이면 8(=satoshi, 무변환).
 * (토큰은 이 값 대신 `main.token.token_decimal` 을 쓴다.)
 */
export async function getRawDecimal(path: string): Promise<number> {
  const raw = (await getParametersByPath(path)).rawDecimal;
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : SATOSHI_DECIMALS;
}
