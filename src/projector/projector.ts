// 投影层：语义单元 → 四档投影块（L1-L4），并产出可序列化到 Webview 的载荷。

import type { ContextSummary, Fidelity, LineRange, SemanticUnit, TierId } from '../model/types';
import type { Lang } from '../i18n';
import { generateUnit } from './vernacular';

export interface Block {
  unitIndex: number;
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
  const sourceLines = source.split('\n');
  const tiers: Record<TierId, Block[]> = { L1: [], L2: [], L3: [], L4: [] };

  units.forEach((unit, unitIndex) => {
    const desc = generateUnit(unit.facts, { lang: options?.lang, hints: options?.hints });
    const base = { unitIndex, title: desc.title, lines: unit.lines };

    // L1：意图（⚠ AI 生成）
    tiers.L1.push({ ...base, fidelity: 'ai', mode: 'text', content: desc.l1 });
    // L2：步骤（✓ 确定性）
    tiers.L2.push({ ...base, fidelity: 'ok', mode: 'text', content: desc.l2 });
    // L3：逻辑 / 结构（✓ 确定性，等宽展示）
    tiers.L3.push({ ...base, fidelity: 'ok', mode: 'text', content: desc.l3 });
    // L4：真实代码（✓ 确定性）
    tiers.L4.push({ ...base, fidelity: 'ok', mode: 'code', content: snippetFor(unit.lines, sourceLines) });
  });

  return { tiers };
}

/** 把 LLM 返回的 L1/L2 覆盖进投影（行号与单元边界仍然来自 AST） */
export function applyLlmResult(
  payload: ProjectionPayload,
  result: { l1: Record<number, string>; l2: Record<number, string> },
): void {
  const tiers: Array<[TierId, Record<number, string>]> = [
    ['L1', result.l1],
    ['L2', result.l2],
  ];
  for (const [tier, texts] of tiers) {
    for (const block of payload.tiers[tier]) {
      const text = texts[block.unitIndex];
      if (text) {
        block.content = text;
        block.fidelity = 'ai';
      }
    }
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
