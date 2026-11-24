// 语义层缓存：按「分组内容」寻址，避免同一段代码被反复送给模型。
// - 分组的 key 只取决于该组覆盖的源码文本，行号整体平移不会导致重算
// - 业务背景另用指纹判断：模块说明、依赖、分组骨架变化才重写

import { createHash } from 'crypto';
import type { ExplainGroup, SemanticUnit } from '../model/types';
import type { FileContext } from '../context/contextBuilder';

export interface CachedAnalysis {
  summary: string;
  bullets: string[];
  summaryKey: string;
  /** 分组 key → L1 文本 */
  l1: Map<string, string>;
  /** 分组 key → L2 文本 */
  l2: Map<string, string>;
}

export interface AnalysisPlan {
  reusedL1: Map<string, string>;
  reusedL2: Map<string, string>;
  targetsL1: number[];
  targetsL2: number[];
  summaryKey: string;
  needSummary: boolean;
}

const MAX_FILES = 12;
/** 持久化结构版本：分组规则变化时递增，旧数据直接丢弃 */
const STORAGE_VERSION = 2;

interface StoredFile {
  summary: string;
  bullets: string[];
  summaryKey: string;
  l1: Array<[string, string]>;
  l2: Array<[string, string]>;
}

export interface StoredAnalysisCache {
  version: number;
  modelKey: string;
  files: Array<[string, StoredFile]>;
}

export class AnalysisCache {
  private files = new Map<string, CachedAnalysis>();

  get(key: string): CachedAnalysis | undefined {
    const hit = this.files.get(key);
    if (hit) {
      // LRU：命中即移到队尾
      this.files.delete(key);
      this.files.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: CachedAnalysis): void {
    this.files.delete(key);
    this.files.set(key, value);
    while (this.files.size > MAX_FILES) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.files.delete(oldest);
    }
  }

  clear(): void {
    this.files.clear();
  }

  /** 删除单个文件的缓存（手动重新解析时用） */
  delete(key: string): void {
    this.files.delete(key);
  }

  /** 导出成纯 JSON，可写入 workspaceState 跨窗口重载 / 扩展升级保留 */
  serialize(modelKey: string): StoredAnalysisCache {
    return {
      version: STORAGE_VERSION,
      modelKey,
      files: [...this.files].map(([key, v]): [string, StoredFile] => [key, {
        summary: v.summary,
        bullets: v.bullets,
        summaryKey: v.summaryKey,
        l1: [...v.l1],
        l2: [...v.l2],
      }]),
    };
  }

  /** 从 workspaceState 恢复；结构版本或模型配置不一致时整体丢弃，避免旧模型输出被当成新结果 */
  load(raw: unknown, modelKey: string): void {
    const data = raw as StoredAnalysisCache | undefined;
    if (!data || data.version !== STORAGE_VERSION || data.modelKey !== modelKey || !Array.isArray(data.files)) {
      return;
    }
    this.files.clear();
    for (const entry of data.files) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        continue;
      }
      const [key, value] = entry as [string, StoredFile];
      if (typeof key !== 'string' || !key || !value) {
        continue;
      }
      this.files.set(key, {
        summary: typeof value.summary === 'string' ? value.summary : '',
        bullets: Array.isArray(value.bullets) ? value.bullets.filter((b): b is string => typeof b === 'string') : [],
        summaryKey: typeof value.summaryKey === 'string' ? value.summaryKey : '',
        l1: toTextMap(value.l1),
        l2: toTextMap(value.l2),
      });
    }
  }
}

function toTextMap(pairs: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(pairs)) {
    return map;
  }
  for (const pair of pairs) {
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      map.set(pair[0], pair[1]);
    }
  }
  return map;
}

export function planAnalysis(
  cached: CachedAnalysis | undefined,
  l1Keys: string[],
  l2Keys: string[],
  ctx: FileContext,
  units: SemanticUnit[],
): AnalysisPlan {
  const reusedL1 = new Map<string, string>();
  const reusedL2 = new Map<string, string>();
  const targetsL1: number[] = [];
  const targetsL2: number[] = [];

  l1Keys.forEach((key, i) => {
    const prev = cached?.l1.get(key);
    if (prev) {
      reusedL1.set(key, prev);
    } else {
      targetsL1.push(i);
    }
  });
  l2Keys.forEach((key, i) => {
    const prev = cached?.l2.get(key);
    if (prev) {
      reusedL2.set(key, prev);
    } else {
      targetsL2.push(i);
    }
  });

  const summaryKey = summaryFingerprint(ctx, units);
  const total = l1Keys.length + l2Keys.length;
  const changed = targetsL1.length + targetsL2.length;
  const needSummary = !cached || cached.summaryKey !== summaryKey || changed * 2 >= total;

  return { reusedL1, reusedL2, targetsL1, targetsL2, summaryKey, needSummary };
}

/** 分组内容指纹：只取源码文本，行号变化不影响命中 */
export function groupTextKey(sourceLines: string[], group: ExplainGroup): string {
  const code = group.lines
    .map((r) => sourceLines.slice(r.start - 1, r.end).join('\n'))
    .join('\n');
  return hashText(`${group.id.split(':')[0]}\u0000${code}`);
}

export function summaryFingerprint(ctx: FileContext, units: SemanticUnit[]): string {
  return hashText([
    ctx.relPath,
    ctx.moduleName,
    ctx.entry ? 'entry' : 'module',
    ...ctx.facts,
    ...units.map((u) => `${u.facts.kind}:${u.facts.name ?? ''}`),
  ].join('\n'));
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
