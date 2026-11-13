// 支持的语言清单：VS Code 语言 ID / 文件扩展名 / tree-sitter 语法映射。
// 这里保持纯数据 + 纯函数，不依赖 vscode，便于索引层与自测复用。

export type LanguageId = 'python' | 'typescript' | 'tsx' | 'c' | 'cpp' | 'java' | 'rust' | 'go';

export interface LangDescriptor {
  id: LanguageId;
  /** tree-sitter-wasms 中的语法名（tree-sitter-<wasm>.wasm） */
  wasm: string;
  /** 英文展示名 */
  name: string;
  /** VS Code 的 languageId */
  vscodeIds: string[];
  /** 工程索引使用的扩展名（小写，带点） */
  extensions: string[];
}

export const LANGUAGE_LIST: LangDescriptor[] = [
  { id: 'python', wasm: 'python', name: 'Python', vscodeIds: ['python'], extensions: ['.py'] },
  { id: 'typescript', wasm: 'typescript', name: 'TypeScript', vscodeIds: ['typescript'], extensions: ['.ts'] },
  { id: 'tsx', wasm: 'tsx', name: 'TypeScript', vscodeIds: ['typescriptreact'], extensions: ['.tsx'] },
  { id: 'c', wasm: 'c', name: 'C', vscodeIds: ['c'], extensions: ['.c', '.h'] },
  { id: 'cpp', wasm: 'cpp', name: 'C++', vscodeIds: ['cpp'], extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'] },
  { id: 'java', wasm: 'java', name: 'Java', vscodeIds: ['java'], extensions: ['.java'] },
  { id: 'rust', wasm: 'rust', name: 'Rust', vscodeIds: ['rust'], extensions: ['.rs'] },
  { id: 'go', wasm: 'go', name: 'Go', vscodeIds: ['go'], extensions: ['.go'] },
];

const BY_ID = new Map<LanguageId, LangDescriptor>(LANGUAGE_LIST.map((d) => [d.id, d]));
const BY_VSCODE_ID = new Map<string, LanguageId>();
const BY_EXTENSION = new Map<string, LanguageId>();

for (const d of LANGUAGE_LIST) {
  for (const v of d.vscodeIds) {
    BY_VSCODE_ID.set(v, d.id);
  }
  for (const ext of d.extensions) {
    if (!BY_EXTENSION.has(ext)) {
      BY_EXTENSION.set(ext, d.id);
    }
  }
}

export function descriptor(id: LanguageId): LangDescriptor {
  const d = BY_ID.get(id);
  if (!d) {
    throw new Error(`未知语言：${id}`);
  }
  return d;
}

/** 编辑器 languageId → 内部语言；不支持返回 undefined */
export function fromVscodeLanguageId(languageId: string): LanguageId | undefined {
  return BY_VSCODE_ID.get(languageId.toLowerCase());
}

/** 文件扩展名（含点）→ 内部语言 */
export function fromExtension(ext: string): LanguageId | undefined {
  return BY_EXTENSION.get(ext.toLowerCase());
}

export function displayName(id: LanguageId): string {
  return descriptor(id).name;
}

/** 工程索引的文件匹配 glob */
export function sourceGlob(): string {
  const exts = Array.from(BY_EXTENSION.keys())
    .map((e) => e.slice(1))
    .filter((e) => e !== 'h');
  // .h 同时可能属于 C/C++，单独保留一份即可
  if (!exts.includes('h')) {
    exts.push('h');
  }
  return `**/*.{${exts.join(',')}}`;
}

/** 是否是该语言的「入口文件」 */
export function isEntryFile(source: string, id: LanguageId): boolean {
  switch (id) {
    case 'python':
      return /__name__\s*==\s*['"]__main__['"]/.test(source);
    case 'go':
      return /^\s*package\s+main\b/m.test(source) && /\bfunc\s+main\s*\(/.test(source);
    case 'rust':
      return /\bfn\s+main\s*\(/.test(source);
    case 'c':
    case 'cpp':
      return /\b(?:int|void)\s+main\s*\(/.test(source);
    case 'java':
      return /public\s+static\s+void\s+main\s*\(/.test(source);
    case 'typescript':
    case 'tsx':
      return /require\.main\s*===\s*module|import\.meta\.url/.test(source);
    default:
      return false;
  }
}
