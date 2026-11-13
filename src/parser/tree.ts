// tree-sitter（WASM）解析封装：按语言加载对应语法，源码 → 语法树。
// 架构要点：结构（控制流/步骤）由 AST 确定性推导，LLM 只做白话翻译并锚定节点。

import * as fs from 'fs';
import * as path from 'path';
import Parser = require('web-tree-sitter');
import type { LanguageId } from '../lang/languages';
import { descriptor } from '../lang/languages';

let initialized = false;
const languages = new Map<LanguageId, Parser.Language>();
const parsers = new Map<LanguageId, Parser>();

/** 在打包前后都能找到 tree-sitter-wasms 的 wasm 文件 */
function resolveWasm(name: string): string {
  const fileName = `tree-sitter-${name}.wasm`;
  const candidates: string[] = [];
  try {
    candidates.push(path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out', fileName));
  } catch {
    /* 忽略 */
  }
  candidates.push(path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out', fileName));
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`缺少 tree-sitter 语法文件：${fileName}`);
  }
  return found;
}

/** 初始化 WASM 运行时并加载指定语言语法（幂等） */
export async function ensureParser(id: LanguageId): Promise<void> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  if (languages.has(id)) {
    return;
  }
  const wasmPath = resolveWasm(descriptor(id).wasm);
  languages.set(id, await Parser.Language.load(wasmPath));
}

export interface Parsed {
  tree: Parser.Tree;
  root: Parser.SyntaxNode;
  source: string;
}

/** 解析源码（每种语言复用同一个 Parser 实例；调用方用完需 tree.delete()） */
export function parseSource(id: LanguageId, source: string): Parsed {
  const language = languages.get(id);
  if (!language) {
    throw new Error(`tree-sitter 语法尚未初始化（${id}），请先调用 ensureParser()`);
  }
  let parser = parsers.get(id);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(id, parser);
  }
  const tree = parser.parse(source);
  return { tree, root: tree.rootNode, source };
}

/** 0-based → 1-based 行号（含两端） */
export function nodeStartLine(node: Parser.SyntaxNode): number {
  return node.startPosition.row + 1;
}

export function nodeEndLine(node: Parser.SyntaxNode): number {
  const ep = node.endPosition;
  // tree-sitter 的 endPosition 是“越过末字符”的位置
  return ep.column === 0 ? ep.row : ep.row + 1;
}

/** 取节点的第 N 个命名字段（如 name / body / condition） */
export function field(node: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  return node.childForFieldName(name);
}

/** 规范化一个节点的文本为单行 */
export function oneLine(node: Parser.SyntaxNode | null): string {
  if (!node) {
    return '';
  }
  return node.text.replace(/\s+/g, ' ').trim();
}

/** 去掉 # 注释前缀 */
export function stripHashComment(text: string): string {
  return text.replace(/^#\s*/, '').trim();
}

/** 去掉 // 与 / * * / 注释前缀与每行星号 */
export function stripSlashComment(text: string): string {
  const t = text.trim();
  if (t.startsWith('//')) {
    return t.replace(/^\/+\s?/, '').trim();
  }
  if (t.startsWith('/*')) {
    return t
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .split('\n')
      .map((s) => s.replace(/^\s*\*\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return t;
}
