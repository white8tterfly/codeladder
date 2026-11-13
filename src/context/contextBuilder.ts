// 当前文件的工程上下文：模块职责、依赖、使用方、符号提示。
// 这里只产出「可核实的事实」：技术背景直接上屏，facts 作为模型提示的上下文。
// 业务背景属于语义层，必须由模型归纳，不在本地用模板猜测。

import * as vscode from 'vscode';
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
  /** 技术背景：页面直接展示的确定性事实 */
  tech: {
    bullets: string[];
    sources: string[];
  };
  /** 给模型的上下文事实（不含任何业务结论） */
  facts: string[];
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

  const techBullets: string[] = [];
  const sources = new Set<string>();
  const hints: Record<string, string> = {};
  const symbols = self?.symbols ?? [];

  // 本文件自己的符号
  for (const sym of symbols) {
    hints[sym.name] = hintOf(sym.file, sym.line, sym.doc);
  }

  // ---- 技术页：语言、路径、原始说明、符号、依赖、引用（全部为确定性事实） ----
  techBullets.push(pick(
    lang,
    `语言与文件：${displayName(langId)} · ${relPath}`,
    `Language & file: ${displayName(langId)} · ${relPath}`,
  ));
  if (self?.doc) {
    techBullets.push(pick(lang, `原始说明：${clip(self.doc, 120)}`, `Original note: ${clip(self.doc, 120)}`));
  }
  if (symbols.length > 0) {
    const list = symbols
      .slice(0, 5)
      .map((s) => `${s.name}（L${s.line}）`)
      .join(pick(lang, '、', ', '));
    techBullets.push(pick(
      lang,
      `本文件定义：${list}${symbols.length > 5 ? ' 等' : ''}`,
      `Defines: ${list}${symbols.length > 5 ? ' and more' : ''}`,
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
    techBullets.push(pick(lang, `依赖本地模块：${list}`, `Local dependencies: ${list}`));
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
    techBullets.push(pick(lang, `被这些文件引用：${list}`, `Used by: ${list}`));
    importers.slice(0, 6).forEach((f) => sources.add(f.relPath));
  }

  if (entry) {
    techBullets.push(pick(
      lang,
      '含程序入口（main）：直接运行时从这里启动。',
      'Has a program entry (main): execution starts here.',
    ));
  }

  const sourceList = Array.from(sources).slice(0, 12);
  const bullets = techBullets.slice(0, 8);
  return {
    moduleName,
    relPath,
    entry,
    languageName: displayName(langId),
    hints,
    tech: {
      bullets,
      sources: sourceList,
    },
    facts: bullets,
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
