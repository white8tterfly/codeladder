// LLM 语义层：业务背景、L1 意图、L2 步骤都必须由模型归纳。
// 控制 token 消耗：
//   1. 只发送本次真正需要的单元代码（由上层按缓存算出 targets），未变化单元不重复发送；
//   2. 代码按字符预算截断，超出的单元留给下一次运行继续补齐；
//   3. 相同内容/相同目标的并发请求合并为一个，避免重复计费。
// 结构（行号、单元边界）始终来自 AST；模型返回值必须锚定到已有 unit index，否则丢弃。

import * as vscode from 'vscode';
import type { ExplainGroups } from '../model/types';
import type { Lang } from '../i18n';
import type { FileContext } from '../context/contextBuilder';
import { hashText } from './analysisCache';

export interface LlmSuccess {
  ok: true;
  /** 本次是否重新生成了业务背景；未请求时为空字符串 */
  summary: string;
  bullets: string[];
  l1: Record<number, string>;
  l2: Record<number, string>;
}

export interface LlmFailure {
  ok: false;
  reason: 'no-model' | 'failed';
  /** 失败详情（HTTP 状态、解析失败等），直接展示给用户 */
  detail?: string;
}

export type LlmOutcome = LlmSuccess | LlmFailure;

export interface EnrichOptions {
  /** 本次需要生成的 L1 分组序号（函数/接口/类）；缺省为全部 */
  l1Targets?: number[];
  /** 本次需要生成的 L2 分组序号（代码块）；缺省为全部 */
  l2Targets?: number[];
  /** 是否重新生成业务背景；缺省为是 */
  needSummary?: boolean;
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const TIMEOUT_MS = 60_000;
const DEFAULT_MAX_INPUT_CHARS = 24_000;
const MAX_OUTLINE_CHARS = 6_000;
const PER_UNIT_CHARS = 1_600;
const PER_BLOCK_CHARS = 800;

/** IDE 内置模型（Language Model API）的最小结构，运行时探测，避免绑定高版本 types */
interface IdeChatModel {
  name?: string;
  vendor?: string;
  family?: string;
  sendRequest(
    messages: unknown[],
    options?: unknown,
    token?: unknown,
  ): Promise<{ text: AsyncIterable<string> }>;
}

/** 同一请求在途时复用 Promise，防止连点/语言切换造成重复计费 */
const inflight = new Map<string, Promise<LlmOutcome>>();

/**
 * 取 IDE 已注册的对话模型（VS Code 1.90+ 的 vscode.lm）。
 * Trae / VS Code 自身不注册提供者时返回 undefined，由调用方回退到 HTTP 配置。
 */
async function pickIdeModel(): Promise<IdeChatModel | undefined> {
  const lm = (vscode as any).lm;
  if (!lm || typeof lm.selectChatModels !== 'function') {
    return undefined;
  }
  try {
    const models = await lm.selectChatModels({});
    return Array.isArray(models) && models.length > 0 ? (models[0] as IdeChatModel) : undefined;
  } catch {
    return undefined;
  }
}

function readConfig(): LlmConfig | undefined {
  const conf = vscode.workspace.getConfiguration('codeLadder.llm');
  const legacy = vscode.workspace.getConfiguration('codeReadable.llm');
  const read = (key: string): string => {
    const value = conf.get<string>(key);
    if (value && value.trim()) {
      return value.trim();
    }
    return (legacy.get<string>(key) ?? '').trim();
  };
  const baseUrl = read('baseUrl');
  const apiKey = read('apiKey');
  const model = read('model');
  if (!baseUrl || !apiKey || !model) {
    return undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

function readMaxInputChars(): number {
  const conf = vscode.workspace.getConfiguration('codeLadder.llm');
  const value = conf.get<number>('maxInputChars');
  return typeof value === 'number' && value >= 2000 ? Math.floor(value) : DEFAULT_MAX_INPUT_CHARS;
}

export function enrichWithLlm(
  source: string,
  groups: ExplainGroups,
  ctx: FileContext,
  lang: Lang,
  options: EnrichOptions = {},
): Promise<LlmOutcome> {
  const l1Targets = options.l1Targets ?? groups.l1.map((_, i) => i);
  const l2Targets = options.l2Targets ?? groups.l2.map((_, i) => i);
  const needSummary = options.needSummary ?? true;
  const maxInputChars = readMaxInputChars();
  const key = hashText([
    lang,
    needSummary ? '1' : '0',
    String(maxInputChars),
    l1Targets.join(','),
    l2Targets.join(','),
    source,
  ].join('\u0000'));

  const running = inflight.get(key);
  if (running) {
    return running;
  }
  const task = runRequest(source, groups, ctx, lang, l1Targets, l2Targets, needSummary, maxInputChars);
  inflight.set(key, task);
  void task.then(
    () => inflight.delete(key),
    () => inflight.delete(key),
  );
  return task;
}

async function runRequest(
  source: string,
  groups: ExplainGroups,
  ctx: FileContext,
  lang: Lang,
  l1Targets: number[],
  l2Targets: number[],
  needSummary: boolean,
  maxInputChars: number,
): Promise<LlmOutcome> {
  const system = lang === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;
  const built = buildUserPrompt(source, groups, ctx, lang, l1Targets, l2Targets, needSummary, maxInputChars);
  if (!built) {
    return { ok: false, reason: 'failed', detail: 'input too large' };
  }

  // 1) 优先用 IDE 内置模型（无需 API Key）
  const ideModel = await pickIdeModel();
  let ideFailure: LlmFailure | undefined;
  if (ideModel) {
    const viaIde = await requestViaIdeModel(ideModel, system, built.prompt, built.l1Allowed, built.l2Allowed, needSummary);
    if (viaIde.ok) {
      return viaIde;
    }
    ideFailure = viaIde;
  }

  // 2) 回退到自配的 OpenAI 兼容端点；两者都不可用时给出明确原因
  const config = readConfig();
  if (!config) {
    if (ideFailure) {
      return ideFailure;
    }
    return { ok: false, reason: 'no-model' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: built.prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let body = '';
      try {
        body = clip(await res.text(), 160);
      } catch {
        // 忽略读取失败，保留状态码即可
      }
      return { ok: false, reason: 'failed', detail: `HTTP ${res.status}${body ? ` · ${body}` : ''}` };
    }
    const data = JSON.parse(await res.text()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, reason: 'failed', detail: 'empty response' };
    }
    return parseResult(content, built.l1Allowed, built.l2Allowed, needSummary)
      ?? { ok: false, reason: 'failed', detail: 'unparsable response' };
  } catch (err) {
    const detail = err instanceof Error
      ? (err.name === 'AbortError' ? 'request timeout' : err.message)
      : String(err);
    return { ok: false, reason: 'failed', detail };
  } finally {
    clearTimeout(timer);
  }
}

/** 通过 IDE 内置模型请求一次归纳；不可用时返回失败原因 */
async function requestViaIdeModel(
  model: IdeChatModel,
  system: string,
  prompt: string,
  l1Allowed: Set<number>,
  l2Allowed: Set<number>,
  needSummary: boolean,
): Promise<LlmOutcome> {
  const messageApi = (vscode as any).LanguageModelChatMessage;
  if (!messageApi || typeof messageApi.User !== 'function') {
    return { ok: false, reason: 'failed', detail: 'IDE model API unavailable' };
  }
  try {
    const response = await model.sendRequest([messageApi.User(`${system}\n\n${prompt}`)], {});
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return parseResult(text, l1Allowed, l2Allowed, needSummary)
      ?? { ok: false, reason: 'failed', detail: 'unparsable response' };
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

const SYSTEM_PROMPT_ZH = [
  '你是资深软件工程师，帮非开发者读懂工程代码。',
  '业务背景、每一步的意图与步骤都必须由你归纳；只能依据给定的代码与工程上下文，不许编造不存在的业务、数据或调用。',
  '只处理用户列出的解释分组序号，不要补充未列出的分组。',
  '输出必须是 JSON 对象，不要 Markdown、不要代码围栏、不要解释文字。',
].join('\n');

const SYSTEM_PROMPT_EN = [
  'You are a senior software engineer helping non-developers understand production code.',
  'You must infer the business context, the intent and the steps yourself. Use only the given code and project context. Never invent business rules, data, or calls.',
  'Only handle the explanation group indexes listed by the user. Do not add unlisted groups.',
  'Return a single JSON object. No Markdown, no code fences, no extra prose.',
].join('\n');

function buildUserPrompt(
  source: string,
  groups: ExplainGroups,
  ctx: FileContext,
  lang: Lang,
  l1Targets: number[],
  l2Targets: number[],
  needSummary: boolean,
  maxInputChars: number,
): { prompt: string; l1Allowed: Set<number>; l2Allowed: Set<number> } | undefined {
  const selected = selectGroupsWithinBudget(source, groups, l1Targets, l2Targets, maxInputChars);
  const l1Allowed = new Set(selected.l1Included);
  const l2Allowed = new Set(selected.l2Included);
  if (!needSummary && l1Allowed.size === 0 && l2Allowed.size === 0) {
    return undefined;
  }

  const outline = [
    buildGroupOutline('L1', groups.l1, '函数 / 接口 / 类', 'functions / interfaces / classes', lang),
    buildGroupOutline('L2', groups.l2, '代码块', 'code blocks', lang),
  ].join('\n\n');
  const requested = [
    `L1: ${selected.l1Included.join(', ') || '-'}`,
    `L2: ${selected.l2Included.join(', ') || '-'}`,
  ].join('\n');

  if (lang === 'en') {
    const lines = [
      '## Project facts',
      `File: ${ctx.relPath} (${ctx.languageName}, module ${ctx.moduleName || 'unknown'})`,
      ...ctx.facts.map((f) => `- ${f}`),
      '',
      '## Explanation groups',
      outline,
      '',
      '## Indexes to write now',
      requested,
      '',
      '## Code for these groups only (line<TAB>content)',
      selected.snippet || '(no code needed)',
      '',
      '## Task',
    ];
    if (needSummary) {
      lines.push(
        '1. summary: one English sentence describing what this file does in the product (<= 20 words, no jargon). Infer it yourself; do not restate the file layout.',
        '2. bullets: 2-3 short English bullets about the business role only; no languages, frameworks, file names, or technical dependencies.',
      );
    } else {
      lines.push('1. Do NOT return a summary or bullets: the business context is already cached.');
    }
    lines.push(
      `${needSummary ? 3 : 2}. l1: one entry per listed L1 index — what this function, interface or class does in the product (<= 20 words, plain language, no jargon).`,
      `${needSummary ? 4 : 3}. l2: one entry per listed L2 index — what that code block does (<= 25 words). Do not describe it line by line.`,
      `${needSummary ? 5 : 4}. Never narrate individual lines; only use the listed indexes and never change line numbers.`,
      '',
      needSummary
        ? 'Output: {"summary":"...","bullets":["..."],"l1":[{"index":0,"text":"..."}],"l2":[{"index":0,"text":"..."}]}'
        : 'Output: {"l1":[{"index":0,"text":"..."}],"l2":[{"index":0,"text":"..."}]}',
    );
    return { prompt: lines.join('\n'), l1Allowed, l2Allowed };
  }

  const lines = [
    '## 工程事实',
    `文件：${ctx.relPath}（${ctx.languageName}，模块 ${ctx.moduleName || '未知'}）`,
    ...ctx.facts.map((f) => `- ${f}`),
    '',
    '## 解释分组',
    outline,
    '',
    '## 本次需要生成的序号',
    requested,
    '',
    '## 仅这些分组的代码（行号<TAB>内容）',
    selected.snippet || '（无需代码）',
    '',
    '## 任务',
  ];
  if (needSummary) {
    lines.push(
      '1. summary：用一句中文说清这个文件在业务里做什么（≤40字，避免术语）。必须由你根据代码推断，不能只是复述文件结构。',
      '2. bullets：2-3 条要点，只讲业务上它承担什么、影响谁；不许出现语言、框架、文件名或技术依赖。',
    );
  } else {
    lines.push('1. 不要返回 summary / bullets：业务背景已缓存。');
  }
  lines.push(
    `${needSummary ? 3 : 2}. l1：为上面列出的每个 L1 序号写一条，说清这个函数 / 接口 / 类在业务里承担什么（≤30字，纯白话，不要逐行描述）。`,
    `${needSummary ? 4 : 3}. l2：为每个 L2 序号写一条，概括这一整块代码做了什么（≤40字），不要拆成逐行步骤。`,
    `${needSummary ? 5 : 4}. 只能使用上面列出的序号；不要新增或改写行号。代码里的注释只作参考，不要直接照抄。`,
    '',
    needSummary
      ? '输出格式：{"summary":"...","bullets":["..."],"l1":[{"index":0,"text":"..."}],"l2":[{"index":0,"text":"..."}]}'
      : '输出格式：{"l1":[{"index":0,"text":"..."}],"l2":[{"index":0,"text":"..."}]}',
  );
  return { prompt: lines.join('\n'), l1Allowed, l2Allowed };
}

/** 分组总览：只发序号/名称/行号，字符便宜，让模型知道文件全貌 */
function buildGroupOutline(
  tier: 'L1' | 'L2',
  groups: ExplainGroups['l1'],
  zhLabel: string,
  enLabel: string,
  lang: Lang,
): string {
  const head = lang === 'en'
    ? `### ${tier} (${enLabel}) index<TAB>name<TAB>lines`
    : `### ${tier}（${zhLabel}）序号<TAB>名称<TAB>行号`;
  const rows: string[] = [];
  let used = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const row = `${i}\t${clip(g.title, 60)}\t${lineLabel(g.lines)}`;
    if (used + row.length > MAX_OUTLINE_CHARS / 2) {
      rows.push(`…（其余 ${groups.length - i} 个分组省略）`);
      break;
    }
    rows.push(row);
    used += row.length + 1;
  }
  return `${head}\n${rows.join('\n')}`;
}

function lineLabel(lines: { start: number; end: number }[]): string {
  return lines.map((r) => (r.start === r.end ? `L${r.start}` : `L${r.start}-L${r.end}`)).join(',');
}

/** 只挑本次需要的分组代码，并受总字符预算约束；放不下的留给下一次运行 */
function selectGroupsWithinBudget(
  source: string,
  groups: ExplainGroups,
  l1Targets: number[],
  l2Targets: number[],
  budget: number,
): { snippet: string; l1Included: number[]; l2Included: number[] } {
  const sourceLines = source.split('\n');
  const blocks: string[] = [];
  const l1Included: number[] = [];
  const l2Included: number[] = [];
  let used = 0;

  const add = (tier: 'L1' | 'L2', idx: number, ranges: { start: number; end: number }[], perGroupChars: number): void => {
    const header = `### ${tier} #${idx} · ${lineLabel(ranges)}\n`;
    let body = '';
    for (const r of ranges) {
      for (let n = r.start; n <= r.end; n++) {
        const text = `${n}\t${sourceLines[n - 1] ?? ''}\n`;
        if (body.length + text.length > perGroupChars) {
          body += '…\n';
          break;
        }
        body += text;
      }
      if (body.endsWith('…\n')) {
        break;
      }
    }
    if (used + header.length + body.length > budget) {
      return;
    }
    used += header.length + body.length;
    blocks.push(header + body);
    if (tier === 'L1') {
      l1Included.push(idx);
    } else {
      l2Included.push(idx);
    }
  };

  for (const idx of l1Targets) {
    const g = groups.l1[idx];
    if (g) {
      add('L1', idx, g.lines, PER_UNIT_CHARS);
    }
  }
  for (const idx of l2Targets) {
    const g = groups.l2[idx];
    if (g) {
      add('L2', idx, g.lines, PER_BLOCK_CHARS);
    }
  }

  return { snippet: blocks.join('\n'), l1Included, l2Included };
}

function parseResult(
  content: string,
  l1Allowed: Set<number>,
  l2Allowed: Set<number>,
  needSummary: boolean,
): LlmSuccess | undefined {
  // 推理型模型可能把思考结束标记写进正文，夹在 JSON 中间会直接导致解析失败
  const cleaned = content.replace(/<[^<>]*end[^<>]*thinking[^<>]*>/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  let obj: { summary?: unknown; bullets?: unknown; l1?: unknown; l2?: unknown };
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  // 业务背景是语义层的必需产物：本次要求生成却没有，就视为失败，而不是退回模板
  if (needSummary && !summary) {
    return undefined;
  }

  const result: LlmSuccess = {
    ok: true,
    summary: summary ? clip(summary, 120) : '',
    bullets: [],
    l1: {},
    l2: {},
  };
  if (Array.isArray(obj.bullets)) {
    result.bullets = obj.bullets
      .filter((b): b is string => typeof b === 'string' && !!b.trim())
      .slice(0, 5)
      .map((b) => clip(b.trim(), 140));
  }

  const collect = (raw: unknown, allowed: Set<number>, max: number): Record<number, string> => {
    const out: Record<number, string> = {};
    if (!Array.isArray(raw)) {
      return out;
    }
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const entry = item as { index?: unknown; text?: unknown };
      const idx = Number(entry.index);
      if (!Number.isInteger(idx) || !allowed.has(idx)) {
        continue;
      }
      if (typeof entry.text === 'string' && entry.text.trim()) {
        out[idx] = clip(entry.text.trim(), max);
      }
    }
    return out;
  };
  result.l1 = collect(obj.l1, l1Allowed, 160);
  result.l2 = collect(obj.l2, l2Allowed, 200);

  // 有目标分组时至少要有文本；只重写摘要（没有目标）时允许只有 summary
  const hasText = Object.keys(result.l1).length > 0 || Object.keys(result.l2).length > 0;
  if (!hasText && (l1Allowed.size > 0 || l2Allowed.size > 0)) {
    return undefined;
  }
  return result;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
