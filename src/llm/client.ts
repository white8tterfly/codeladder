// LLM 语义层：业务背景、L1 意图、L2 步骤都必须由模型归纳。
// 控制 token 消耗：
//   1. 只发送本次真正需要的分组代码（由上层按缓存算出 targets），未变化分组不重复发送；
//   2. 超长文件按字符预算拆成多批请求，逐批生成并合并，保证整份文件都被解释到；
//   3. 相同内容/相同目标的并发请求合并为一个，避免重复计费。
// 结构（行号、单元边界）始终来自 AST；模型返回值必须锚定到已有分组序号，否则丢弃。

import * as vscode from 'vscode';
import type { ExplainGroups, LineRange } from '../model/types';
import type { Lang } from '../i18n';
import type { FileContext } from '../context/contextBuilder';
import { hashText } from './analysisCache';

/** 一次运行累计的 token 用量（多批请求相加） */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  /** 端点没返回 usage（如 IDE 内置模型）时按字符估算 */
  estimated?: boolean;
}

export interface LlmSuccess {
  ok: true;
  /** 本次是否重新生成了业务背景；未请求时为空字符串 */
  summary: string;
  bullets: string[];
  l1: Record<number, string>;
  l2: Record<number, string>;
  usage?: TokenUsage;
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
  /** 每完成一批请求回调一次累计用量，便于界面实时显示消耗 */
  onUsage?: (usage: TokenUsage) => void;
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const TIMEOUT_MS = 60_000;
const DEFAULT_MAX_INPUT_CHARS = 24_000;
const PER_UNIT_CHARS = 1_600;
const PER_BLOCK_CHARS = 800;
/** 单次运行最多拆成多少批，防止超大文件一次打出过多请求 */
const MAX_BATCHES = 12;

/** 一批模型请求覆盖的分组序号 */
interface Batch {
  l1: number[];
  l2: number[];
}

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

/** IDE 注册多个模型时，按常见对话模型家族优先，避免随手取到不适合归纳的那个 */
const IDE_FAMILY_PREFERENCE = ['gpt-4', 'gpt-3', 'claude', 'gemini', 'qwen', 'deepseek', 'llama'];

/**
 * 取 IDE 已注册的对话模型（VS Code 1.90+ 的 vscode.lm）。
 * 只在用户没有显式配置 baseUrl / apiKey / model 时才会走到这里。
 */
async function pickIdeModel(): Promise<IdeChatModel | undefined> {
  const lm = (vscode as any).lm;
  if (!lm || typeof lm.selectChatModels !== 'function') {
    return undefined;
  }
  try {
    const models = await lm.selectChatModels({});
    if (!Array.isArray(models) || models.length === 0) {
      return undefined;
    }
    const hit = models.find((m: IdeChatModel) => {
      const key = `${m.family ?? ''} ${m.name ?? ''}`.toLowerCase();
      return IDE_FAMILY_PREFERENCE.some((family) => key.includes(family));
    });
    return (hit ?? models[0]) as IdeChatModel;
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
  const task = runRequest(
    source,
    groups,
    ctx,
    lang,
    l1Targets,
    l2Targets,
    needSummary,
    maxInputChars,
    options.onUsage,
  );
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
  onUsage?: (usage: TokenUsage) => void,
): Promise<LlmOutcome> {
  // 分组数超过一次请求的预算时拆成多批，保证文件从头到尾都被解释，
  // 而不是只解释排在前面的那一半。
  const planned = planBatches(source, groups, l1Targets, l2Targets, maxInputChars);
  if (planned.length === 0) {
    if (!needSummary) {
      return { ok: true, summary: '', bullets: [], l1: {}, l2: {} };
    }
    planned.push({ l1: [], l2: [] });
  }
  const batches = planned.slice(0, MAX_BATCHES);
  const system = lang === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;
  const merged: LlmSuccess = { ok: true, summary: '', bullets: [], l1: {}, l2: {} };

  for (let i = 0; i < batches.length; i++) {
    const wantSummary = needSummary && i === 0;
    const built = buildUserPrompt(source, groups, ctx, lang, batches[i], wantSummary);
    const outcome = await requestBatch(system, built, wantSummary);
    if (!outcome.ok) {
      // 第一批就失败：整次视为失败；后续批次失败：保留已经生成的部分
      if (i === 0) {
        return outcome;
      }
      break;
    }
    if (outcome.summary) {
      merged.summary = outcome.summary;
    }
    if (outcome.bullets.length > 0) {
      merged.bullets = outcome.bullets;
    }
    Object.assign(merged.l1, outcome.l1);
    Object.assign(merged.l2, outcome.l2);
    if (outcome.usage) {
      merged.usage = merged.usage
        ? {
            prompt: merged.usage.prompt + outcome.usage.prompt,
            completion: merged.usage.completion + outcome.usage.completion,
            total: merged.usage.total + outcome.usage.total,
            estimated: merged.usage.estimated || outcome.usage.estimated,
          }
        : { ...outcome.usage };
      onUsage?.(merged.usage);
    }
  }

  return merged;
}

/** 请求一批分组：显式配置的端点优先，没配置时才用 IDE 内置模型 */
async function requestBatch(
  system: string,
  built: { prompt: string; l1Allowed: Set<number>; l2Allowed: Set<number> },
  needSummary: boolean,
): Promise<LlmOutcome> {
  const config = readConfig();
  if (!config) {
    const ideModel = await pickIdeModel();
    if (!ideModel) {
      return { ok: false, reason: 'no-model' };
    }
    return requestViaIdeModel(ideModel, system, built.prompt, built.l1Allowed, built.l2Allowed, needSummary);
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
      // 带上实际使用的端点与模型，模型名不匹配这类 400 才定位得到
      return {
        ok: false,
        reason: 'failed',
        detail: `${config.model} @ ${config.baseUrl} · HTTP ${res.status}${body ? ` · ${body}` : ''}`,
      };
    }
    const data = JSON.parse(await res.text()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, reason: 'failed', detail: 'empty response' };
    }
    const parsed = parseResult(content, built.l1Allowed, built.l2Allowed, needSummary);
    if (!parsed) {
      return { ok: false, reason: 'failed', detail: 'unparsable response' };
    }
    parsed.usage = readUsage(data.usage) ?? estimateUsage(`${system}\n\n${built.prompt}`, content);
    return parsed;
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
    const parsed = parseResult(text, l1Allowed, l2Allowed, needSummary);
    if (!parsed) {
      return { ok: false, reason: 'failed', detail: 'unparsable response' };
    }
    // IDE 内置模型不返回 usage，按字符粗略估算，界面上以 ≈ 标注
    parsed.usage = estimateUsage(`${system}\n\n${prompt}`, text);
    return parsed;
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
  batch: Batch,
  needSummary: boolean,
): { prompt: string; l1Allowed: Set<number>; l2Allowed: Set<number> } {
  const l1Allowed = new Set(batch.l1);
  const l2Allowed = new Set(batch.l2);
  const sourceLines = source.split('\n');
  const snippet = [
    ...batch.l1.map((idx) => groupSnippet('L1', idx, groups.l1[idx].lines, sourceLines, PER_UNIT_CHARS)),
    ...batch.l2.map((idx) => groupSnippet('L2', idx, groups.l2[idx].lines, sourceLines, PER_BLOCK_CHARS)),
  ].join('\n');

  const outline = [
    buildGroupOutline('L1', groups.l1, batch.l1, '函数 / 接口 / 类', 'functions / interfaces / classes', lang),
    buildGroupOutline('L2', groups.l2, batch.l2, '代码块', 'code blocks', lang),
  ].join('\n\n');
  const requested = [
    `L1: ${batch.l1.join(', ') || '-'}`,
    `L2: ${batch.l2.join(', ') || '-'}`,
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
      snippet || '(no code needed)',
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
    snippet || '（无需代码）',
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

/** 分组总览：只发本批的序号/名称/行号，字符便宜，让模型知道这部分在全文件里的位置 */
function buildGroupOutline(
  tier: 'L1' | 'L2',
  groups: ExplainGroups['l1'],
  indexes: number[],
  zhLabel: string,
  enLabel: string,
  lang: Lang,
): string {
  const head = lang === 'en'
    ? `### ${tier} (${enLabel}) index<TAB>name<TAB>lines`
    : `### ${tier}（${zhLabel}）序号<TAB>名称<TAB>行号`;
  const rows = indexes
    .map((i) => {
      const g = groups[i];
      return g ? `${i}\t${clip(g.title, 60)}\t${lineLabel(g.lines)}` : '';
    })
    .filter((row) => row.length > 0);
  return `${head}\n${rows.length > 0 ? rows.join('\n') : '-'}`;
}

function lineLabel(lines: { start: number; end: number }[]): string {
  return lines.map((r) => (r.start === r.end ? `L${r.start}` : `L${r.start}-L${r.end}`)).join(',');
}

/** 单个分组的代码片段（含行号），超长时截断并标省略号 */
function groupSnippet(
  tier: 'L1' | 'L2',
  idx: number,
  ranges: LineRange[],
  sourceLines: string[],
  perGroupChars: number,
): string {
  const header = `### ${tier} #${idx} · ${lineLabel(ranges)}\n`;
  let body = '';
  for (const r of ranges) {
    for (let n = r.start; n <= r.end; n++) {
      const text = `${n}\t${sourceLines[n - 1] ?? ''}\n`;
      if (body.length + text.length > perGroupChars) {
        return `${header}${body}…\n`;
      }
      body += text;
    }
  }
  return header + body;
}

/**
 * 按字符预算把待生成分组拆成多批。
 * 每批装到装不下为止，保证排在文件后半段的分组也能轮到一次请求。
 */
function planBatches(
  source: string,
  groups: ExplainGroups,
  l1Targets: number[],
  l2Targets: number[],
  budget: number,
): Batch[] {
  const sourceLines = source.split('\n');
  const batches: Batch[] = [];
  let current: Batch = { l1: [], l2: [] };
  let used = 0;

  const push = (tier: 'L1' | 'L2', idx: number, ranges: LineRange[], perGroupChars: number): void => {
    const cost = groupSnippet(tier, idx, ranges, sourceLines, perGroupChars).length;
    if (used > 0 && used + cost > budget) {
      batches.push(current);
      current = { l1: [], l2: [] };
      used = 0;
    }
    used += cost;
    if (tier === 'L1') {
      current.l1.push(idx);
    } else {
      current.l2.push(idx);
    }
  };

  for (const idx of l1Targets) {
    const g = groups.l1[idx];
    if (g) {
      push('L1', idx, g.lines, PER_UNIT_CHARS);
    }
  }
  for (const idx of l2Targets) {
    const g = groups.l2[idx];
    if (g) {
      push('L2', idx, g.lines, PER_BLOCK_CHARS);
    }
  }
  if (current.l1.length > 0 || current.l2.length > 0) {
    batches.push(current);
  }
  return batches;
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

/** 端点返回的 usage；部分网关不给 total_tokens，用输入 + 输出补上 */
function readUsage(
  raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): TokenUsage | undefined {
  if (!raw) {
    return undefined;
  }
  const prompt = Number(raw.prompt_tokens) || 0;
  const completion = Number(raw.completion_tokens) || 0;
  const total = Number(raw.total_tokens) || prompt + completion;
  if (!total) {
    return undefined;
  }
  return { prompt, completion, total };
}

/** 粗略估算 token：中日韩字符约 1 字 1 token，其余约 4 字符 1 token */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 端点未返回 usage 时的兜底估算，estimated 标记让界面显示 ≈ */
function estimateUsage(prompt: string, completion: string): TokenUsage {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(completion);
  return {
    prompt: promptTokens,
    completion: completionTokens,
    total: promptTokens + completionTokens,
    estimated: true,
  };
}
