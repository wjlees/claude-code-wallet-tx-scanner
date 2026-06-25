import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

/**
 * 스캔 진행 지점(cursor) 영속화 저장소.
 *
 * 각 ScanRunner 는 마지막으로 처리한 cursor(자산별 불투명 문자열)를 여기에 저장하고,
 * 재시작/워치독 재가동 시 다시 로드해 **그 지점부터 이어서** 스캔한다(at-least-once).
 *
 * NOTE: 현재는 JSON 파일 기반 stub(`.data/cursors.json`). 실제로는 회사 DB 로 교체된다 —
 *   이 인터페이스(load/save)만 유지하면 호출부(ScanRunner)는 안 바뀐다. TODO(DB).
 */
export interface CursorStore {
  /** key 의 마지막 cursor 를 읽는다. 없으면 null(처음부터). */
  load(key: string): Promise<string | null>;
  /** key 의 cursor 를 저장한다. */
  save(key: string, cursor: string | null): Promise<void>;
}

export const CURSOR_STORE = 'CursorStore';

/** JSON 파일 1개에 전체 cursor 맵을 저장하는 stub 구현. */
@Injectable()
export class JsonCursorStore implements CursorStore, OnModuleInit {
  private readonly logger = new Logger('JsonCursorStore');
  private readonly filePath = join(process.cwd(), '.data', 'cursors.json');
  private cache: Record<string, string | null> = {};
  /** 최초 1회만 파일을 읽도록 in-flight 프라미스를 메모이즈(동시 호출 레이스 방지). */
  private loadPromise?: Promise<void>;
  /** 파일 쓰기를 직렬화해 동시 저장 시 JSON 깨짐을 방지한다. */
  private writeChain: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    await this.ensureLoaded();
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as Record<string, string | null>;
      this.logger.log(
        `loaded ${Object.keys(this.cache).length} cursor(s) from ${this.filePath}`,
      );
    } catch {
      this.cache = {}; // 파일 없음(첫 실행) → 빈 맵
    }
  }

  async load(key: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.cache[key] ?? null;
  }

  async save(key: string, cursor: string | null): Promise<void> {
    await this.ensureLoaded();
    this.cache[key] = cursor;
    // 직렬화된 쓰기 큐에 flush 를 이어붙인다.
    this.writeChain = this.writeChain.then(() => this.flush());
    return this.writeChain;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.cache, null, 2));
  }
}
