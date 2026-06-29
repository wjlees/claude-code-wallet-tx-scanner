import { Logger } from '@nestjs/common';

/**
 * 노드 미설정 경고를 (키별) **1회만** 남기는 공용 헬퍼.
 *
 * 노드 URL 등 파라미터 조회는 `parameter-store.ts` 의 async `getParametersByPath`/`getNodeUrlByPath` 를 쓴다.
 * 미설정이면 해당 자산은 스캔 skip + 이 경고(키별 1회). 자산 식별은 logger 컨텍스트로 충분하다.
 */
const warnedKeys = new Set<string>();
export function warnMissingNode(logger: Logger, paramKey: string): void {
  if (warnedKeys.has(paramKey)) return;
  warnedKeys.add(paramKey);
  logger.warn(`no ${paramKey} configured — scan skipped`);
}
