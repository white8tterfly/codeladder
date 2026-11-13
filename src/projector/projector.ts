// 投影层：语义单元 → 四档投影块（L1-L4），并产出可序列化到 Webview 的载荷。
// L1 按函数/接口聚合，L2 按代码块聚合；L3/L4 保持逐单元，行号全部来自 AST。

import type { ContextSummary, ExplainGroups, Fidelity, LineRange, SemanticUnit, TierId } from '../model/types';
import type { Lang } from '../i18n';
import { generateUnit } from './vernacular';
import { buildExplainGroups } from '../parser/groups';

export interface Block {
  unitIndex: number;
  /** 该块覆盖的语义单元下标（L1/L2 是分组内的全部单元） */
  focusUnits: number[];
  title: string;
  lines: LineRange[];
  fidelity: Fidelity;
  mode: 'text' | 'code';
  content: string;
}

export interface ProjectionPayload {
  tiers: Record<TierId, Block[]>;
  context?: ContextSummary;
}

export interface ProjectionOptions {
  /** 输出语言 */
  lang?: Lang;
  /** 符号名 → 「文件:行号 · 说明」，把跨文件调用锚定到定义处 */
  hints?: Record<string, string>;
  /** 已算好的解释分组，避免重复推导 */
  groups?: ExplainGroups;
}

const TIER_ORDER: TierId[] = ['L1', 'L2', 'L3', 'L4'];

/** 从多个行区间拼接代码片段（区间之间用省略号分隔） */
function snippetFor(lines: LineRange[], sourceLines: string[]): string {
  const parts: string[] = [];
  lines.forEach((r, i) => {
    if (i > 0) {
      parts.push('···');
    }
    for (let n = r.start; n <= r.end; n++) {
      parts.push(sourceLines[n - 1] ?? '');
    }
  });
  return parts.join('\n');
}

export function buildProjection(
  units: SemanticUnit[],
  source: string,
  options?: ProjectionOptions,
): ProjectionPayload {
  const lang: Lang = options?.lang ?? 'zh';
  const sourceLines = source.split('\n');
  const groups = options?.groups ?? buildExplainGroups(units, lang);
  const tiers: Record<TierId, Block[]> = { L1: [], L2: [], L3: [], L4: [] };

  // L1：一个函数 / 接口 / 类一条，内容只来自模型
  for (const g of groups.l1) {
    tiers.L1.push({
      unitIndex: g.unitIndexes[0] ?? -1,
      focusUnits: g.unitIndexes,
      title: g.title,
      lines: g.lines,
      fidelity: 'inferred',
      mode: 'text',
      content: '',
    });
  }

  // L2：一个代码块一条，内容只来自模型
  for (const g of groups.l2) {
    tiers.L2.push({
      unitIndex: g.unitIndexes[0] ?? -1,
      focusUnits: g.unitIndexes,
      title: g.title,
      lines: g.lines,
      fidelity: 'inferred',
      mode: 'text',
      content: '',
    });
  }

  // L3 / L4：逐单元，确定性
  units.forEach((unit, unitIndex) => {
    const lineCount = unit.lines.reduce((n, r) => n + (r.end - r.start + 1), 0);
    const desc = generateUnit(unit.facts, { lang, hints: options?.hints, lineCount });
    const base = { unitIndex, focusUnits: [unitIndex], title: desc.title, lines: unit.lines };

    // L3：逻辑 / 结构（✓ 确定性，等宽展示）
    tiers.L3.push({ ...base, fidelity: 'ok', mode: 'text', content: desc.l3 });
    // L4：真实代码（✓ 确定性）
    tiers.L4.push({ ...base, fidelity: 'ok', mode: 'code', content: snippetFor(unit.lines, sourceLines) });
  });

  return { tiers };
}

/**
 * 把 LLM 返回的 L1/L2 覆盖进投影。
 * 下标是分组下标（与 payload.tiers.L1/L2 的数组位置一致）。
 */
export function applyLlmResult(
  payload: ProjectionPayload,
  result: { l1: Record<number, string>; l2: Record<number, string> },
): void {
  const tiers: Array<[TierId, Record<number, string>]> = [
    ['L1', result.l1],
    ['L2', result.l2],
  ];
  for (const [tier, texts] of tiers) {
    payload.tiers[tier].forEach((block, i) => {
      const text = texts[i];
      if (text) {
        block.content = text;
        block.fidelity = 'ai';
      }
    });
  }
}

/** 找到覆盖某行（1-based）的语义单元下标 */
export function unitsCoveringLine(units: SemanticUnit[], line: number): number[] {
  const result: number[] = [];
  units.forEach((u, i) => {
    const hit = u.lines.some((r) => line >= r.start && line <= r.end);
    if (hit) {
      result.push(i);
    }
  });
  return result;
}

export { TIER_ORDER };
