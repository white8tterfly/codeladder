// 当前文件的工程上下文：模块职责、依赖、使用方、符号提示。
// 输出两部分：给 LLM 的上下文事实 + 面板顶部的「业务背景」卡片。

import * as vscode from 'vscode';
import type { ContextSummary } from '../model/types';
import type { Lang } from '../i18n';
import type { SourceFileInfo, ProjectIndex } from '../index/projectIndex';
import type { LanguageId } from '../lang/languages';
import { displayName, fromVscodeLanguageId, isEntryFile } from '../lang/languages';

export interface FileContext {
  moduleName: string;
  relPath: string;
  entry: boolean;
  /** 当前源码语言（英文名，用于 LLM 提示） */
  languageName: string;
  /** 符号名 → 「文件:行号 · 说明」，用于把调用解释锚定到定义处 */
  hints: Record<string, string>;
  summary: ContextSummary;
}

export function buildFileContext(
  index: ProjectIndex,
  doc: vscode.TextDocument,
  source: string,
  lang: Lang,
): FileContext {
  const self = index.getByUri(doc.uri);
  const relPath = self?.relPath ?? vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
  const moduleName = self?.moduleName ?? '';
  const langId: LanguageId = self?.lang ?? fromVscodeLanguageId(doc.languageId) ?? 'python';
  const entry = isEntryFile(source, langId);

  const bullets: string[] = [];
  const sources = new Set<string>();
  const hints: Record<string, string> = {};

  // 本文件自己的符号
  for (const sym of self?.symbols ?? []) {
    hints[sym.name] = hintOf(sym.file, sym.line, sym.doc);
  }
  if (self?.doc) {
    bullets.push(pick(lang, `本文件职责：${clip(self.doc, 90)}`, `Role: ${clip(self.doc, 90)}`));
  }
  if (self && self.symbols.length > 0) {
    const list = self.symbols
      .slice(0, 5)
      .map((s) => `${s.name}（L${s.line}）`)
      .join(pick(lang, '、', ', '));
    bullets.push(pick(
      lang,
      `本文件定义：${list}${self.symbols.length > 5 ? ' 等' : ''}`,
      `Defines: ${list}${self.symbols.length > 5 ? ' and more' : ''}`,
    ));
  }

  // 依赖的本地模块及其符号
  const deps = new Map<string, SourceFileInfo>();
  if (self) {
    for (const imp of self.imports) {
      const target = index.resolveImport(self, imp.module);
      if (!target || target.relPath === relPath || deps.has(target.relPath)) {
        continue;
      }
      deps.set(target.relPath, target);
      sources.add(target.relPath);
      for (const sym of target.symbols) {
        if (!hints[sym.name]) {
          hints[sym.name] = hintOf(sym.file, sym.line, sym.doc);
        }
      }
    }
  }
  if (deps.size > 0) {
    const list = Array.from(deps.values())
      .slice(0, 4)
      .map((d) => `${d.relPath}${d.doc ? ` (${clip(d.doc, 28)})` : ''}`)
      .join(pick(lang, '；', '; '));
    bullets.push(pick(lang, `依赖本地模块：${list}`, `Local dependencies: ${list}`));
  }

  // 谁在使用本文件
  const importers = index.getImporters(relPath);
  if (importers.length > 0) {
    const list = importers
      .slice(0, 4)
      .map((f) => {
        const names = index.importedNames(f, relPath);
        return names.length > 0 ? `${f.relPath} (${names.join(', ')})` : f.relPath;
      })
      .join(pick(lang, '、', ', '));
    bullets.push(pick(lang, `被这些文件引用：${list}`, `Used by: ${list}`));
    importers.slice(0, 6).forEach((f) => sources.add(f.relPath));
  }

  if (entry) {
    bullets.push(pick(
      lang,
      '含程序入口（main）：直接运行时从这里启动。',
      'Has a program entry (main): execution starts here.',
    ));
  }

  const fallback = pick(
    lang,
    '无模块说明，按定义与引用关系推断',
    'no module docstring; inferred from definitions and references',
  );
  const summaryText = `${moduleName || relPath}: ${self?.doc ? clip(self.doc, 100) : fallback}`;
  return {
    moduleName,
    relPath,
    entry,
    languageName: displayName(langId),
    hints,
    summary: {
      summary: summaryText,
      bullets: bullets.slice(0, 6),
      sources: Array.from(sources).slice(0, 12),
      fidelity: 'ok',
    },
  };
}

function hintOf(file: string, line: number, doc: string): string {
  return `${file}:L${line}${doc ? ` · ${clip(doc, 40)}` : ''}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function pick(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en;
}
