// 解释分组：把逐行语义单元聚合成人更容易读的粒度。
// L1 = 一个函数 / 接口 / 类（讲它承担什么）；L2 = 一个代码块（函数体、分支、循环、模块级）。
// 分组完全由 AST 事实推导，模型只在分组结果上写文字。

import type { ExplainGroup, ExplainGroups, LineRange, SemanticUnit } from '../model/types';
import type { Lang } from '../i18n';

interface Labels {
  module: string;
  fnBody: string;
  classBody: string;
  branch: string;
  loop: string;
  block: string;
  anonymous: string;
  elseBranch: string;
  loopElse: string;
  imports: string;
  importsOnly: string;
  topLevel: string;
  topSetup: string;
  startup: string;
}

const LABELS: Record<Lang, Labels> = {
  zh: {
    module: '文件整体',
    fnBody: '函数体',
    classBody: '类体',
    branch: '分支',
    loop: '循环',
    block: '代码块',
    anonymous: '匿名函数',
    elseBranch: '否则',
    loopElse: '循环收尾',
    imports: '导入与说明',
    importsOnly: '导入',
    topLevel: '顶层代码',
    topSetup: '顶层设置',
    startup: '启动流程',
  },
  en: {
    module: 'Whole file',
    fnBody: 'Body',
    classBody: 'Class body',
    branch: 'Branch',
    loop: 'Loop',
    block: 'Block',
    anonymous: 'Anonymous function',
    elseBranch: 'Else',
    loopElse: 'Loop tail',
    imports: 'Imports & notes',
    importsOnly: 'Imports',
    topLevel: 'Top-level code',
    topSetup: 'Top-level setup',
    startup: 'Startup flow',
  },
};

/** 复合语句块名（解析器内部用中文名，这里按语言翻译） */
const BLOCK_TITLES: Record<string, [string, string]> = {
  异常处理: ['异常处理', 'Error handling'],
  异常分支: ['异常分支', 'Error branch'],
  正常收尾: ['正常收尾', 'Success path'],
  最终处理: ['最终处理', 'Finally'],
  上下文管理: ['上下文管理', 'Context block'],
  循环: ['循环', 'Loop'],
  模式匹配: ['模式匹配', 'Match'],
  分支: ['分支', 'Case'],
};

function blockTitleText(name: string | undefined, lang: Lang): string | undefined {
  if (!name) {
    return undefined;
  }
  const hit = BLOCK_TITLES[name];
  return hit ? (lang === 'en' ? hit[1] : hit[0]) : name;
}

const isScope = (u: SemanticUnit): boolean => u.facts.kind === 'function' || u.facts.kind === 'class';

/** 允许跨过的空行数：1 个空行仍算同一块，2 个以上拆开 */
const GAP_TOLERANCE = 2;

function clip(text: string, max = 32): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    // 与拆分阈值一致：一个空行也合并，保证每个分组只有一段连续行号
    if (last && r.start <= last.end + GAP_TOLERANCE) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export function buildExplainGroups(units: SemanticUnit[], lang: Lang = 'zh'): ExplainGroups {
  const labels = LABELS[lang] ?? LABELS.zh;
  const indexById = new Map<string, number>();
  units.forEach((u, i) => indexById.set(u.id, i));

  const parent = units.map((u) => {
    const id = u.containerId;
    return id && indexById.has(id) ? indexById.get(id)! : -1;
  });

  // 每个单元最近的函数/类作用域
  const nearestScope = units.map((u, i) => (isScope(u) ? i : parent[i]));

  // ---- L1：一个函数 / 类一组 ----
  const l1Members = new Map<number, number[]>();
  const moduleMembers: number[] = [];
  units.forEach((u, i) => {
    const scope = nearestScope[i];
    if (scope < 0) {
      moduleMembers.push(i);
      return;
    }
    const list = l1Members.get(scope) ?? [];
    list.push(i);
    l1Members.set(scope, list);
  });

  // 子树范围：嵌套函数也要算进外层函数，保证高亮范围完整
  const subtreeEnd = units.map((u) => u.lines[u.lines.length - 1]?.end ?? 0);
  units.forEach((u, i) => {
    let p = parent[i];
    while (p >= 0) {
      subtreeEnd[p] = Math.max(subtreeEnd[p], subtreeEnd[i]);
      p = parent[p];
    }
  });

  const l1: ExplainGroup[] = [];
  const unitL1: number[] = units.map(() => -1);

  const orderedScopes = [...l1Members.keys()].sort((a, b) => a - b);
  for (const scopeIdx of orderedScopes) {
    const scopeUnit = units[scopeIdx];
    const members = l1Members.get(scopeIdx) ?? [];
    const start = scopeUnit.lines[0]?.start ?? 1;
    const end = Math.max(subtreeEnd[scopeIdx], ...members.map((m) => units[m].lines.slice(-1)[0]?.end ?? 0));
    l1.push({
      id: `l1:${scopeUnit.id}`,
      title: scopeUnit.facts.kind === 'class'
        ? `class ${scopeUnit.facts.name ?? labels.anonymous}`
        : (scopeUnit.facts.name ?? labels.anonymous),
      lines: [{ start, end }],
      unitIndexes: [...new Set([scopeIdx, ...members])].sort((a, b) => a - b),
    });
  }

  // 模块级代码也必须覆盖：文件头的导入、文件尾的启动流程同样要有一条 L1，
  // 否则 L1 会只剩几个函数，读起来缺头少尾。
  for (const g of moduleGroups(moduleMembers, units, labels)) {
    l1.push(g);
  }

  l1.sort((a, b) => (a.lines[0]?.start ?? 0) - (b.lines[0]?.start ?? 0));
  l1.forEach((g, gi) => {
    for (const m of g.unitIndexes) {
      unitL1[m] = gi;
    }
  });

  // ---- L2：按代码块聚合，再按空行拆段 ----
  const byBlock = new Map<string, number[]>();
  units.forEach((u, i) => {
    const key = u.blockId ?? 'module';
    const list = byBlock.get(key) ?? [];
    list.push(i);
    byBlock.set(key, list);
  });

  const l2: ExplainGroup[] = [];
  const unitL2: number[] = units.map(() => -1);

  for (const [key, memberIdxs] of byBlock) {
    const baseKey = key.endsWith(':alt') ? key.slice(0, -4) : key;
    const owner = key === 'module' ? undefined : units[indexById.get(baseKey) ?? -1];

    const sorted = [...memberIdxs].sort((a, b) => (units[a].lines[0]?.start ?? 0) - (units[b].lines[0]?.start ?? 0));
    let current: number[] = [];
    let maxEnd = 0;
    const flush = (): void => {
      if (current.length === 0) {
        return;
      }
      const ranges = mergeRanges(current.flatMap((m) => {
        const u = units[m];
        // 块首单元只取首行：C/Java/TS 的函数单元覆盖整个函数体，
        // 若整段计入会把分支/循环块重复包进来
        return isScope(u) && key === u.id ? [u.lines[0]] : u.lines;
      }));
      const g: ExplainGroup = {
        id: `l2:${key}:${current[0]}`,
        title: blockTitle(key, owner, labels, ranges, current.map((m) => units[m]), lang),
        lines: ranges,
        unitIndexes: current,
      };
      const gi = l2.push(g) - 1;
      for (const m of current) {
        unitL2[m] = gi;
      }
      current = [];
    };

    for (const m of sorted) {
      const start = units[m].lines[0]?.start ?? 0;
      const end = units[m].lines.slice(-1)[0]?.end ?? 0;
      if (current.length > 0 && start > maxEnd + GAP_TOLERANCE) {
        flush();
      }
      current.push(m);
      maxEnd = Math.max(maxEnd, end);
    }
    flush();
  }

  l2.sort((a, b) => (a.lines[0]?.start ?? 0) - (b.lines[0]?.start ?? 0));
  unitL2.fill(-1);
  l2.forEach((g, gi) => {
    for (const m of g.unitIndexes) {
      unitL2[m] = gi;
    }
  });

  return { l1, l2, unitL1, unitL2 };
}

/** 模块级单元按连续行段聚成 L1 组，保证文件首尾也有 L1 条目 */
function moduleGroups(memberIdxs: number[], units: SemanticUnit[], labels: Labels): ExplainGroup[] {
  if (memberIdxs.length === 0) {
    return [];
  }
  const sorted = [...memberIdxs].sort(
    (a, b) => (units[a].lines[0]?.start ?? 0) - (units[b].lines[0]?.start ?? 0),
  );
  const out: ExplainGroup[] = [];
  let current: number[] = [];
  let maxEnd = 0;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const ranges = mergeRanges(current.flatMap((m) => units[m].lines));
    out.push({
      id: `l1:module:${current[0]}`,
      title: moduleTitle(current.map((m) => units[m]), labels),
      lines: [{ start: ranges[0].start, end: ranges[ranges.length - 1].end }],
      unitIndexes: current,
    });
    current = [];
  };

  for (const m of sorted) {
    const start = units[m].lines[0]?.start ?? 0;
    const end = units[m].lines.slice(-1)[0]?.end ?? 0;
    if (current.length > 0 && start > maxEnd + GAP_TOLERANCE) {
      flush();
    }
    current.push(m);
    maxEnd = Math.max(maxEnd, end);
  }
  flush();
  return out;
}

function moduleTitle(members: SemanticUnit[], labels: Labels): string {
  const isImport = (u: SemanticUnit): boolean => u.facts.kind === 'import' || u.facts.kind === 'import_from';
  const rest = members.filter((u) => !isImport(u) && u.facts.kind !== 'docstring');
  if (rest.length === 0) {
    const hasDoc = members.some((u) => u.facts.kind === 'docstring');
    return hasDoc ? labels.imports : labels.importsOnly;
  }
  // 入口守卫单独点名，避免又退回"顶层代码"这种笼统标题
  if (rest.some((u) => u.facts.kind === 'if' && (u.facts.condition ?? '').includes('__main__'))) {
    return labels.startup;
  }
  if (rest.some((u) => u.facts.kind === 'assignment')) {
    return labels.topSetup;
  }
  return labels.topLevel;
}

function blockTitle(
  key: string,
  owner: SemanticUnit | undefined,
  labels: Labels,
  ranges: LineRange[],
  members: SemanticUnit[],
  langHint: Lang,
): string {
  if (!owner) {
    return moduleTitle(members, labels);
  }
  const name = owner.facts.name ?? labels.anonymous;
  if (key.endsWith(':alt')) {
    return owner.facts.kind === 'if' ? labels.elseBranch : labels.loopElse;
  }
  switch (owner.facts.kind) {
    case 'function':
      return `${labels.fnBody} · ${clip(name)}`;
    case 'class':
      return `${labels.classBody} · ${clip(name)}`;
    case 'if':
      return `${labels.branch} · ${clip(owner.facts.condition ?? name)}`;
    case 'for':
      return `${labels.loop} · ${clip(owner.facts.condition ?? name)}`;
    case 'block': {
      const label = blockTitleText(owner.facts.name, langHint) ?? labels.block;
      // 异常分支 / 模式匹配分支：把条件带到标题里，避免多个同名片段
      if (owner.facts.name !== '异常分支' && owner.facts.name !== '分支') {
        return label;
      }
      const head = (owner.facts.signature ?? '').replace(/^(except|catch|case)\b\s*/i, '').replace(/^\(\s*|\s*\)$/g, '').replace(/:\s*$/, '').trim();
      return head ? `${label} · ${clip(head)}` : label;
    }
    default:
      return `${labels.block} · L${ranges[0]?.start ?? 1}`;
  }
}
