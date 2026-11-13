// 工程级索引：扫描工作区内受支持的源码文件，建立「模块 → 符号 / import / 反向引用」地图。
// 只做确定性提取（AST + 注释 + import），不生成任何白话文案。

import * as vscode from 'vscode';
import type Parser from 'web-tree-sitter';
import type { LanguageId } from '../lang/languages';
import { fromExtension, sourceGlob } from '../lang/languages';
import { ensureParser, nodeEndLine, nodeStartLine, parseSource } from '../parser/tree';
import { collectDeclarations, syntaxProfile } from '../parser/genericUnits';

type SN = Parser.SyntaxNode;

export interface SymbolInfo {
  name: string;
  kind: 'class' | 'function';
  signature: string;
  doc: string;
  file: string; // 相对工作区路径
  line: number; // 1-based
}

export interface ImportRef {
  module: string;
  names: string[];
  line: number;
}

export interface SourceFileInfo {
  uri: vscode.Uri;
  relPath: string;
  moduleName: string;
  lang: LanguageId;
  doc: string;
  symbols: SymbolInfo[];
  imports: ImportRef[];
}

const EXCLUDE = '**/{.venv,venv,env,.git,__pycache__,node_modules,site-packages,.next,coverage,build,dist,target,vendor,.tox,.mypy_cache,.pytest_cache,.gradle,out}/**';
const MAX_FILES = 2000;
const MAX_FILE_SIZE = 512 * 1024;

export class ProjectIndex {
  private files = new Map<string, SourceFileInfo>();
  private byModule = new Map<string, SourceFileInfo>();
  private importers = new Map<string, Set<string>>();
  private loaded = false;
  private building: Promise<void> | undefined;

  /** 首次调用时建立索引；之后复用内存结果 */
  public async ensure(force = false): Promise<void> {
    if (this.building) {
      return this.building;
    }
    if (this.loaded && !force) {
      return;
    }
    this.building = this.build()
      .catch(() => undefined)
      .finally(() => {
        this.building = undefined;
      });
    return this.building;
  }

  public async rebuild(): Promise<void> {
    this.loaded = false;
    await this.ensure(true);
  }

  /** 单文件保存后增量更新，避免整仓重建 */
  public async update(uri: vscode.Uri): Promise<void> {
    if (!this.loaded) {
      return;
    }
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const info = await this.readFile(uri);
    if (info) {
      this.files.set(rel, info);
    } else {
      this.files.delete(rel);
    }
    this.rebuildRelations();
  }

  public get size(): number {
    return this.files.size;
  }

  public getByUri(uri: vscode.Uri): SourceFileInfo | undefined {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    return this.files.get(rel);
  }

  public getModule(moduleName: string): SourceFileInfo | undefined {
    return this.byModule.get(moduleName.toLowerCase());
  }

  public resolveImport(from: SourceFileInfo, module: string): SourceFileInfo | undefined {
    const normalized = normalizeModule(from, module);
    if (!normalized) {
      return undefined;
    }
    const direct = this.byModule.get(normalized.toLowerCase());
    if (direct) {
      return direct;
    }
    return this.suffixResolve(normalized.toLowerCase());
  }

  public getImporters(relPath: string): SourceFileInfo[] {
    const set = this.importers.get(relPath);
    if (!set) {
      return [];
    }
    return Array.from(set)
      .map((p) => this.files.get(p))
      .filter((f): f is SourceFileInfo => !!f);
  }

  /** 某文件 import 了目标文件里的哪些名字 */
  public importedNames(importer: SourceFileInfo, targetRelPath: string): string[] {
    const names: string[] = [];
    for (const imp of importer.imports) {
      const target = this.resolveImport(importer, imp.module);
      if (target?.relPath === targetRelPath) {
        names.push(...imp.names);
      }
    }
    return names;
  }

  private async build(): Promise<void> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      this.loaded = true;
      return;
    }

    const found = await vscode.workspace.findFiles(sourceGlob(), EXCLUDE, MAX_FILES);
    const next = new Map<string, SourceFileInfo>();
    const concurrency = 16;
    for (let i = 0; i < found.length; i += concurrency) {
      const batch = found.slice(i, i + concurrency);
      const infos = await Promise.all(batch.map((uri) => this.readFile(uri)));
      for (const info of infos) {
        if (info) {
          next.set(info.relPath, info);
        }
      }
    }

    this.files = next;
    this.rebuildRelations();
    this.loaded = true;
  }

  private async readFile(uri: vscode.Uri): Promise<SourceFileInfo | undefined> {
    const relPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const dot = relPath.lastIndexOf('.');
    const lang = dot >= 0 ? fromExtension(relPath.slice(dot)) : undefined;
    if (!lang) {
      return undefined;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_SIZE) {
        return undefined;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      await ensureParser(lang);
      const parsed = parseSource(lang, text);
      try {
        return extractFile(uri, parsed.root, relPath, lang);
      } finally {
        parsed.tree.delete();
      }
    } catch {
      return undefined;
    }
  }

  private rebuildRelations(): void {
    this.byModule.clear();
    this.importers.clear();

    for (const file of this.files.values()) {
      this.addAlias(file.moduleName, file);
      this.addAlias(stripExtension(file.relPath), file);
      this.addAlias(file.relPath, file);
      const base = stripExtension(file.relPath.split('/').pop() ?? '');
      this.addAlias(base, file);
      this.addAlias(file.relPath.split('/').pop() ?? '', file);
      if (file.lang === 'go') {
        const dir = file.relPath.split('/').slice(0, -1).join('/');
        this.addAlias(dir, file);
      }
    }
    for (const file of this.files.values()) {
      for (const imp of file.imports) {
        const target = this.resolveImport(file, imp.module);
        if (!target || target.relPath === file.relPath) {
          continue;
        }
        let set = this.importers.get(target.relPath);
        if (!set) {
          set = new Set<string>();
          this.importers.set(target.relPath, set);
        }
        set.add(file.relPath);
      }
    }
  }

  private addAlias(key: string, file: SourceFileInfo): void {
    const k = key.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (k && !this.byModule.has(k)) {
      this.byModule.set(k, file);
    }
  }

  private suffixResolve(target: string): SourceFileInfo | undefined {
    if (!target) {
      return undefined;
    }
    let best: { score: number; file: SourceFileInfo } | undefined;
    for (const [key, file] of this.byModule) {
      if (key === target || key.endsWith(`/${target}`) || target.endsWith(`/${key}`)) {
        const score = key.length;
        if (!best || score > best.score) {
          best = { score, file };
        }
      }
    }
    return best?.file;
  }
}

function extractFile(
  uri: vscode.Uri,
  root: SN,
  relPath: string,
  lang: LanguageId,
): SourceFileInfo {
  const moduleName = moduleNameOf(relPath, lang, root);
  const profile = syntaxProfile(lang);
  const symbols: SymbolInfo[] = [];
  const imports: ImportRef[] = [];

  const doc = moduleDocOf(root, lang, profile);

  for (const decl of collectDeclarations(root, lang)) {
    const symbolDoc = symbolDocOf(decl.node, lang, profile);
    symbols.push({
      name: decl.name,
      kind: decl.kind,
      signature: decl.signature,
      doc: symbolDoc,
      file: relPath,
      line: nodeStartLine(decl.node),
    });
  }

  for (const child of root.namedChildren) {
    if (lang === 'python' && (child.type === 'import_statement' || child.type === 'import_from_statement')) {
      imports.push(...parsePythonImport(child.text, nodeStartLine(child)));
      continue;
    }
    if (lang !== 'python' && (profile.importNodes.includes(child.type) || profile.importFromNodes.includes(child.type))) {
      imports.push(...parseGenericImport(child, lang));
    }
  }

  return { uri, relPath, moduleName, lang, doc, symbols, imports };
}

function moduleDocOf(root: SN, lang: LanguageId, profile: ReturnType<typeof syntaxProfile>): string {
  if (lang === 'python') {
    const first = root.namedChildren.find((c) => c.type === 'expression_statement' && c.namedChild(0)?.type === 'string');
    if (first) {
      return firstLine(cleanPythonString(first.namedChild(0)!.text));
    }
  }
  for (const child of root.namedChildren) {
    if (profile.commentTypes.includes(child.type)) {
      return firstLine(profile.strip(child.text));
    }
    break;
  }
  return '';
}

function symbolDocOf(node: SN, lang: LanguageId, profile: ReturnType<typeof syntaxProfile>): string {
  if (lang === 'python') {
    const body = node.childForFieldName('body');
    const first = body?.namedChildren[0];
    if (first && first.type === 'expression_statement' && first.namedChild(0)?.type === 'string') {
      return firstLine(cleanPythonString(first.namedChild(0)!.text));
    }
  }
  let anchor = node;
  while (anchor.parent && profile.unwrapNodes.includes(anchor.parent.type)) {
    anchor = anchor.parent;
  }
  const parent = anchor.parent;
  if (!parent) {
    return '';
  }
  const siblings = parent.namedChildren;
  const idx = siblings.findIndex((c) => c.id === anchor.id);
  const prev = idx > 0 ? siblings[idx - 1] : undefined;
  if (prev && profile.commentTypes.includes(prev.type) && nodeEndLine(prev) + 1 >= nodeStartLine(anchor)) {
    return firstLine(profile.strip(prev.text));
  }
  return '';
}

function parsePythonImport(text: string, line: number): ImportRef[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.startsWith('import ')) {
    return flat
      .slice(7)
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
      .map((module) => ({ module, names: [], line }));
  }
  const m = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(flat);
  if (!m) {
    return [];
  }
  const names = m[2]
    .replace(/[()]/g, '')
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  return [{ module: m[1], names, line }];
}

function parseGenericImport(node: SN, lang: LanguageId): ImportRef[] {
  const line = nodeStartLine(node);
  const flat = node.text.replace(/\s+/g, ' ').trim();

  if (lang === 'go') {
    const specs = flat.match(/"([^"]+)"/g) ?? [];
    return specs.map((s) => ({ module: s.slice(1, -1), names: [], line }));
  }
  if (lang === 'typescript' || lang === 'tsx') {
    const m = /from\s+['"]([^'"]+)['"]/.exec(flat);
    if (m) {
      const names: string[] = [];
      const clause = /\{([^}]+)\}/.exec(flat);
      if (clause) {
        names.push(...clause[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
      }
      return [{ module: m[1], names, line }];
    }
    const req = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(flat);
    return req ? [{ module: req[1], names: [], line }] : [];
  }
  if (lang === 'java') {
    const m = /^import\s+(?:static\s+)?([\w.*]+)\s*;?/.exec(flat);
    return m ? [{ module: m[1], names: [], line }] : [];
  }
  if (lang === 'rust') {
    const m = /^(?:pub\s+)?(?:use|extern\s+crate)\s+([^;]+);?/.exec(flat);
    if (!m) {
      return [];
    }
    return [{ module: m[1].replace(/\s+/g, ''), names: [], line }];
  }
  // C / C++
  const m = /#include\s*[<"]([^>"]+)[>"]/.exec(flat);
  return m ? [{ module: m[1], names: [], line }] : [];
}

function moduleNameOf(relPath: string, lang: LanguageId, root?: SN): string {
  if (lang === 'python') {
    return relPath.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').filter(Boolean).join('.');
  }
  if (lang === 'java' && root) {
    const pkg = root.namedChildren.find((c) => c.type === 'package_declaration');
    const base = (relPath.split('/').pop() ?? '').replace(/\.java$/, '');
    if (pkg) {
      const m = /package\s+([\w.]+)/.exec(pkg.text);
      if (m) {
        return `${m[1]}.${base}`;
      }
    }
    return base;
  }
  return stripExtension(relPath);
}

function stripExtension(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot > 0 ? p.slice(0, dot) : p;
}

/** 把 import 字符串规范化为索引键（尽量贴近模块名 / 相对路径） */
function normalizeModule(from: SourceFileInfo, module: string): string {
  let m = module.trim().replace(/^['"]|['"]$/g, '').replace(/;$/, '');
  const lang = from.lang;

  if (lang === 'python') {
    return resolvePythonModule(from.moduleName, m);
  }
  if (lang === 'typescript' || lang === 'tsx') {
    m = m.replace(/\.(?:js|jsx|ts|tsx)$/, '');
    if (m.startsWith('.')) {
      const dir = from.relPath.split('/').slice(0, -1);
      const parts = m.split('/');
      for (const part of parts) {
        if (part === '..') {
          dir.pop();
        } else if (part !== '.' && part !== '') {
          dir.push(part);
        }
      }
      return stripExtension(dir.join('/').replace(/\/index$/, ''));
    }
    return stripExtension(m.replace(/^@\//, ''));
  }
  if (lang === 'rust') {
    m = m.replace(/\{.*$/, '').replace(/::$/, '');
    m = m.replace(/^crate::/, '');
    m = m.replace(/^self::/, '');
    if (m.startsWith('super::')) {
      let depth = 0;
      while (m.startsWith('super::')) {
        depth++;
        m = m.slice(7);
      }
      const dir = from.relPath.split('/').slice(0, -1);
      for (let i = 0; i < depth && dir.length > 0; i++) {
        dir.pop();
      }
      return stripExtension([...dir, ...m.split('::')].join('/'));
    }
    return m.split('::').join('/');
  }
  if (lang === 'java') {
    return m;
  }
  if (lang === 'go') {
    return m.replace(/^[^/]+\.[^/]+\//, '');
  }
  return m.replace(/\\/g, '/');
}

function resolvePythonModule(fromModule: string, module: string): string {
  if (!module.startsWith('.')) {
    return module;
  }
  const dots = /^\.+/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots);
  const parts = fromModule.split('.');
  const base = parts.slice(0, Math.max(0, parts.length - dots));
  return [...base, ...rest.split('.').filter(Boolean)].join('.');
}

function cleanPythonString(text: string): string {
  return text
    .replace(/^\s*[rRuUbBfF]{0,2}(?:"""|'''|"|')/, '')
    .replace(/(?:"""|'''|"|')\s*$/, '');
}

function firstLine(text: string): string {
  const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return line.replace(/:\s*$/, ':');
}
