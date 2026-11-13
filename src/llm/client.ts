// LLM 语义外壳：把「项目上下文 + 代码 + AST 语义单元」交给模型，只让它产出 L1/L2 白话。
// 结构（行号、单元边界）始终来自 AST；模型返回值必须锚定到已有 unit index，否则丢弃。

import * as vscode from 'vscode';
import type { SemanticUnit } from '../model/types';
import type { Lang } from '../i18n';
import type { FileContext } from '../context/contextBuilder';

export interface LlmResult {
  summary?: string;
  bullets?: string[];
  l1: Record<number, string>;
  l2: Record<number, string>;
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const TIMEOUT_MS = 60_000;

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

/** 是否存在可用的语义归纳来源：IDE 内置模型优先，其次自配的 OpenAI 兼容端点 */
export async function hasLlmSource(): Promise<boolean> {
  if (readConfig()) {
    return true;
  }
  return (await pickIdeModel()) !== undefined;
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

export async function enrichWithLlm(
  source: string,
  units: SemanticUnit[],
  ctx: FileContext,
  lang: Lang,
): Promise<LlmResult | undefined> {
  const system = lang === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;
  const prompt = buildUserPrompt(source, units, ctx, lang);

  // 1) 优先用 IDE 内置模型（无需 API Key）
  const viaIde = await requestViaIdeModel(system, prompt, units.length);
  if (viaIde) {
    return viaIde;
  }

  // 2) 回退到自配的 OpenAI 兼容端点
  const config = readConfig();
  if (!config) {
    return undefined;
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
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return undefined;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return undefined;
    }
    return parseResult(content, units.length);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 通过 IDE 内置模型请求一次归纳；模型不可用或返回不可解析时返回 undefined */
async function requestViaIdeModel(
  system: string,
  prompt: string,
  unitCount: number,
): Promise<LlmResult | undefined> {
  const model = await pickIdeModel();
  if (!model) {
    return undefined;
  }
  const messageApi = (vscode as any).LanguageModelChatMessage;
  if (!messageApi || typeof messageApi.User !== 'function') {
    return undefined;
  }
  try {
    const response = await model.sendRequest([messageApi.User(`${system}\n\n${prompt}`)], {});
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return parseResult(text, unitCount);
  } catch {
    return undefined;
  }
}

const SYSTEM_PROMPT_ZH = [
  '你是资深软件工程师，帮非开发者读懂工程代码。',
  '只能依据给定的代码与工程上下文，不许编造不存在的业务、数据或调用。',
  '输出必须是 JSON 对象，不要 Markdown、不要代码围栏、不要解释文字。',
].join('\n');

const SYSTEM_PROMPT_EN = [
  'You are a senior software engineer helping non-developers understand production code.',
  'Use only the given code and project context. Never invent business rules, data, or calls.',
  'Return a single JSON object. No Markdown, no code fences, no extra prose.',
].join('\n');

function buildUserPrompt(
  source: string,
  units: SemanticUnit[],
  ctx: FileContext,
  lang: Lang,
): string {
  const code = numberedSnippet(source, units);
  const unitList = units
    .map((u, i) => {
      const lines = u.lines.map((r) => (r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`)).join(',');
      const codeText = u.facts.signature ?? u.facts.condition ?? u.facts.name ?? '';
      return `${i}\t${u.facts.kind}\t${lines}\t${clip(codeText, 90)}`;
    })
    .join('\n');

  if (lang === 'en') {
    return [
      '## Project context',
      `File: ${ctx.relPath} (${ctx.languageName}, module ${ctx.moduleName || 'unknown'})`,
      ctx.summary.summary,
      ...ctx.summary.bullets.map((b) => `- ${b}`),
      '',
      '## Code (line<TAB>content)',
      code,
      '',
      '## Semantic units (index<TAB>kind<TAB>lines<TAB>structure)',
      unitList,
      '',
      '## Task',
      '1. summary: one English sentence describing what this file does in the product (<= 20 words, no jargon).',
      '2. bullets: 2-4 short English bullets about its role and upstream/downstream dependencies.',
      '3. items: for every semantic unit, write l1 and l2 in English. l1 = plain-language intent (<= 20 words). l2 = concrete step (<= 30 words, business terms allowed).',
      '4. Only use the indexes above; never change line numbers.',
      '',
      'Output: {"summary":"...","bullets":["..."],"items":[{"index":0,"l1":"...","l2":"..."}]}',
    ].join('\n');
  }

  return [
    '## 工程上下文',
    `文件：${ctx.relPath}（${ctx.languageName}，模块 ${ctx.moduleName || '未知'}）`,
    ctx.summary.summary,
    ...ctx.summary.bullets.map((b) => `- ${b}`),
    '',
    '## 代码（行号<TAB>内容）',
    code,
    '',
    '## 语义单元（序号<TAB>类型<TAB>行号<TAB>结构）',
    unitList,
    '',
    '## 任务',
    '1. summary：用一句中文说清这个文件在业务里做什么（≤40字，避免术语）。',
    '2. bullets：2-4 条要点，说明它在工程中的角色、上下游依赖。',
    '3. items：为每个语义单元生成 l1、l2。l1 是纯白话意图（≤40字），l2 是具体步骤（≤60字，可含业务词汇）。',
    '4. 只能使用上面出现的序号；不要新增或改写行号。',
    '',
    '输出格式：{"summary":"...","bullets":["..."],"items":[{"index":0,"l1":"...","l2":"..."}]}',
  ].join('\n');
}

function numberedSnippet(source: string, units: SemanticUnit[], maxLines = 800): string {
  const lines = source.split('\n');
  const keep = new Set<number>();
  for (const unit of units) {
    for (const r of unit.lines) {
      for (let n = r.start; n <= r.end; n++) {
        keep.add(n);
      }
    }
  }
  return Array.from(keep)
    .sort((a, b) => a - b)
    .slice(0, maxLines)
    .map((n) => `${n}\t${lines[n - 1] ?? ''}`)
    .join('\n');
}

function parseResult(content: string, unitCount: number): LlmResult | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  let obj: { summary?: unknown; bullets?: unknown; items?: unknown };
  try {
    obj = JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }

  const result: LlmResult = { l1: {}, l2: {} };
  if (typeof obj.summary === 'string' && obj.summary.trim()) {
    result.summary = clip(obj.summary.trim(), 120);
  }
  if (Array.isArray(obj.bullets)) {
    result.bullets = obj.bullets
      .filter((b): b is string => typeof b === 'string' && !!b.trim())
      .slice(0, 5)
      .map((b) => clip(b.trim(), 140));
  }
  if (Array.isArray(obj.items)) {
    for (const raw of obj.items) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const item = raw as { index?: unknown; l1?: unknown; l2?: unknown };
      const idx = Number(item.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= unitCount) {
        continue;
      }
      if (typeof item.l1 === 'string' && item.l1.trim()) {
        result.l1[idx] = clip(item.l1.trim(), 160);
      }
      if (typeof item.l2 === 'string' && item.l2.trim()) {
        result.l2[idx] = clip(item.l2.trim(), 200);
      }
    }
  }

  if (!result.summary && Object.keys(result.l1).length === 0) {
    return undefined;
  }
  return result;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
