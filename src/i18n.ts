// 运行时双语支持：设置项 codeLadder.language = auto | zh | en。
// auto 时跟随 IDE 显示语言（zh* → 中文，其余 → 英文）。

import * as vscode from 'vscode';

export type Lang = 'zh' | 'en';

export function getLang(): Lang {
  const raw = vscode.workspace.getConfiguration('codeLadder').get<string>('language') ?? 'auto';
  if (raw === 'zh' || raw === 'en') {
    return raw;
  }
  return (vscode.env.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export interface TierText {
  name: string;
  desc: string;
}

export interface UiText {
  locale: string;
  windowTitle: string;
  sub: string;
  legendOk: string;
  legendAi: string;
  hint: string;
  contextTitle: string;
  contextBasis: string;
  ctxToggle: string;
  fidOk: string;
  fidAi: string;
  empty: string;
  tiers: Record<'L1' | 'L2' | 'L3' | 'L4', TierText>;
  progressIndexing: string;
  progressRebuild: string;
  statusLlm: string;
  msgIndexed: (count: number) => string;
  msgUnsupported: string;
  msgNoEditor: string;
  msgNoUnits: string;
  msgConfigHint: string;
  errPrefix: string;
}

const ZH: UiText = {
  locale: 'zh-CN',
  windowTitle: 'CodeLadder · 四档代码学习',
  sub: '四档投影 L1–L4 · 逐级从白话读懂代码',
  legendOk: '✓ 确定性（AST 推导）',
  legendAi: '⚠ AI 生成（语义归纳）',
  hint: 'L1→L4 颜色由浅到深（越深越接近真实代码） · 点击解释块跳转并高亮整块 · 点行号徽章定位单行',
  contextTitle: '业务背景',
  contextBasis: '依据：',
  ctxToggle: '点击收起 / 展开业务背景',
  fidOk: '✓ 确定性',
  fidAi: '⚠ AI 生成',
  empty: '在受支持的文件里运行「CodeLadder：生成四档解释」',
  tiers: {
    L1: { name: '意图', desc: '纯白话 · 零术语' },
    L2: { name: '步骤', desc: '业务词汇 · 分步' },
    L3: { name: '逻辑', desc: '结构化 · 控制流' },
    L4: { name: '代码', desc: '真实实现' },
  },
  progressIndexing: 'CodeLadder：正在通读工程代码…',
  progressRebuild: 'CodeLadder：重建工程索引…',
  statusLlm: 'CodeLadder：LLM 正在结合工程上下文归纳…',
  msgIndexed: (count) => `CodeLadder：已索引 ${count} 个源码文件。`,
  msgUnsupported: 'CodeLadder 已支持 Python、TypeScript、C、C++、Java、Rust、Go 文件。',
  msgNoEditor: 'CodeLadder：请先打开一个受支持的源码文件。',
  msgNoUnits: 'CodeLadder：未能从该文件解析出可解释的代码块。',
  msgConfigHint: 'CodeLadder：在设置 codeLadder.language 中切换中英文（auto 跟随 IDE 语言）。',
  errPrefix: 'CodeLadder 解析失败：',
};

const EN: UiText = {
  locale: 'en',
  windowTitle: 'CodeLadder · Four-tier code reading',
  sub: 'Four tiers L1–L4 · climb from plain language to code',
  legendOk: '✓ Deterministic (from AST)',
  legendAi: '⚠ AI-generated (semantic)',
  hint: 'L1→L4 colors get darker as you approach real code · Click a block to jump and highlight it · Click a line badge to jump to that line',
  contextTitle: 'Project context',
  contextBasis: 'Based on: ',
  ctxToggle: 'Click to collapse or expand the project context',
  fidOk: '✓ Deterministic',
  fidAi: '⚠ AI-generated',
  empty: 'Open a supported file and run "CodeLadder: Generate Four Tiers"',
  tiers: {
    L1: { name: 'Intent', desc: 'Plain words · no jargon' },
    L2: { name: 'Steps', desc: 'Business terms · step by step' },
    L3: { name: 'Logic', desc: 'Structure · control flow' },
    L4: { name: 'Code', desc: 'Actual implementation' },
  },
  progressIndexing: 'CodeLadder: reading the project…',
  progressRebuild: 'CodeLadder: rebuilding project index…',
  statusLlm: 'CodeLadder: LLM is summarizing with project context…',
  msgIndexed: (count) => `CodeLadder: indexed ${count} source files.`,
  msgUnsupported: 'CodeLadder supports Python, TypeScript, C, C++, Java, Rust and Go files.',
  msgNoEditor: 'CodeLadder: open a supported source file first.',
  msgNoUnits: 'CodeLadder: no explainable code units found in this file.',
  msgConfigHint: 'CodeLadder: switch language with the codeLadder.language setting (auto follows the IDE language).',
  errPrefix: 'CodeLadder failed to parse: ',
};

export function uiText(lang: Lang): UiText {
  return lang === 'zh' ? ZH : EN;
}
