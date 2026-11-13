// 白话翻译层：把语义单元的「确定性事实」投影为四档白话内容（中英双语）。
//
// 架构定位（对应 PRD 3.2）：
// - L3 的结构（控制流/签名）完全来自 AST 事实，100% 确定性；
// - L2 由 AST 结构 + 命名推导，是确定性的白话化；
// - L1 是意图归纳：只用模板说白话，不出现缩写与术语，标记为「⚠ 推断」。
//   代码注释只作为参考（例如交给模型改写时），不直接照抄进 L1。
//
// 语言由调用方传入（Lang），模板本身不读配置，保证纯函数、可测试。

import type { UnitFacts, UnitKind } from '../model/types';
import type { Lang } from '../i18n';

export interface UnitDescription {
  title: string;
  l1: string;
  l2: string;
  l3: string;
}

export interface DescriptionOptions {
  lang?: Lang;
  hints?: Record<string, string>;
}

function pick(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en;
}

/** 截断过长文本，避免白话层出现大段代码 */
function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 只取表达式的「主体名」：a.b(...) → a.b；字面量或复杂表达式返回空 */
function simpleRef(expr: string | undefined): string {
  if (!expr) {
    return '';
  }
  const m = /^([A-Za-z_][\w.]*)\s*(\(|$)/.exec(expr.trim());
  return m ? m[1] : '';
}

const intentTemplate: Record<UnitKind, (f: UnitFacts, l: Lang) => string> = {
  docstring: (_f, l) => pick(
    l,
    '文件开头的说明，讲它是做什么的。',
    'An opening note saying what the file does.',
  ),
  import: (f, l) => pick(
    l,
    `拿来一个叫 ${f.name || '??'} 的工具，后面要用。`,
    `Brings in a tool called ${f.name || '??'} for later use.`,
  ),
  import_from: (f, l) => pick(
    l,
    `从 ${f.base || '??'} 里拿几样要用的工具。`,
    `Takes a few helpers from ${f.base || '??'}.`,
  ),
  class: (f, l) => pick(
    l,
    `定义一个叫 ${f.name || '??'} 的资料袋，里面装几样信息。`,
    `Defines a container called ${f.name || '??'} that holds a few pieces of information.`,
  ),
  field: (f, l) => pick(
    l,
    `资料袋里的一格：${f.name || '??'}。`,
    `One slot in the container: ${f.name || '??'}.`,
  ),
  function: (f, l) => pick(
    l,
    `定义一步操作：${f.name || '??'}。`,
    `Defines one step: ${f.name || '??'}.`,
  ),
  assignment: (f, l) => pick(
    l,
    `把算出来的结果存进 ${f.target || '一个地方'}。`,
    `Stores the computed result in ${f.target || 'a place'}.`,
  ),
  if: (f, l) => {
    const cond = simpleRef(f.condition);
    return pick(
      l,
      cond ? `看看「${cond}」成不成立，成立才做下面的事。` : '看看条件成不成立，成立才做下面的事。',
      cond ? `Checks "${cond}"; the block below runs only if it holds.` : 'Checks a condition; the block below runs only if it holds.',
    );
  },
  for: (f, l) => {
    const list = simpleRef(f.condition);
    return pick(
      l,
      list ? `把「${list}」里的东西一件一件处理。` : '把清单里的东西一件一件处理。',
      list ? `Handles each item of "${list}" one by one.` : 'Handles each item of a list one by one.',
    );
  },
  return: (f, l) => {
    const ref = simpleRef(f.returns);
    return pick(
      l,
      ref ? `把 ${ref} 交出去。` : '把结果交出去。',
      ref ? `Hands back ${ref}.` : 'Hands back the result.',
    );
  },
  call: (f, l) => describeCall(f, l).l1,
  comment: (_f, l) => pick(l, '一段写给人看的说明。', 'A note written for people.'),
  statement: (_f, l) => pick(l, '做一步操作。', 'Does one step.'),
};

const stepTemplate: Record<UnitKind, (f: UnitFacts, l: Lang) => string> = {
  docstring: (_f, l) => pick(l, '文件说明：用途与运行方式。', 'File note: purpose and how to run.'),
  import: (f, l) => pick(l, `把 ${f.name || '??'} 拿进来用。`, `Takes in ${f.name || '??'}.`),
  import_from: (f, l) => pick(l, `从 ${f.base || '??'} 里拿要用的名字。`, `Takes the needed names from ${f.base || '??'}.`),
  class: (f, l) => pick(
    l,
    `定义 ${f.name || '??'}${f.base ? `，沿用 ${f.base}` : ''}。`,
    `Defines ${f.name || '??'}${f.base ? `, reusing ${f.base}` : ''}.`,
  ),
  field: (f, l) => pick(
    l,
    `定义 ${f.name || '??'}，存 ${short(f.value || '??', 40)}。`,
    `Defines ${f.name || '??'} holding ${short(f.value || '??', 40)}.`,
  ),
  function: (f, l) => pick(l, `定义 ${f.name || '??'}。`, `Defines ${f.name || '??'}.`),
  assignment: (f, l) => pick(
    l,
    f.value ? `把 ${short(f.value, 50)} 存进 ${f.target || '??'}。` : `把结果存进 ${f.target || '??'}。`,
    f.value ? `Stores ${short(f.value, 50)} in ${f.target || '??'}.` : `Stores the result in ${f.target || '??'}.`,
  ),
  if: (f, l) => pick(
    l,
    `看「${short(f.condition || '条件', 50)}」，走对应的一边。`,
    `Checks "${short(f.condition || 'a condition', 50)}" and takes the matching side.`,
  ),
  for: (f, l) => pick(
    l,
    `把「${short(f.condition || '一堆东西', 50)}」逐项过一遍。`,
    `Goes through "${short(f.condition || 'a collection', 50)}" item by item.`,
  ),
  return: (f, l) => pick(
    l,
    f.returns ? `交出「${short(f.returns, 50)}」。` : '交出结果。',
    f.returns ? `Hands back "${short(f.returns, 50)}".` : 'Hands back the result.',
  ),
  call: (f, l) => describeCall(f, l).l2,
  comment: (f, l) => f.comment || pick(l, '注释。', 'A comment.'),
  statement: (f, l) => pick(
    l,
    `执行${f.signature ? `：${short(f.signature, 60)}` : '一步'}。`,
    `Runs ${f.signature ? `: ${short(f.signature, 60)}` : 'one step'}.`,
  ),
};

interface CallDescription {
  title: string;
  l1: string;
  l2: string;
}

/** 去掉字符串字面量的引号与前缀（f/r/b/u） */
function unquote(text: string | undefined): string {
  if (!text) {
    return '';
  }
  const t = text.trim();
  const m = /^[rRbBuUfF]{0,2}(["'])([\s\S]*)\1$/.exec(t);
  return m ? m[2] : t;
}

/** 拆分调用参数（忽略括号/引号内部的逗号） */
function splitArgs(argText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let buf = '';
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i];
    if (quote) {
      buf += ch;
      if (ch === quote && argText[i - 1] !== '\\') {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      buf += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      buf += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) {
    out.push(buf.trim());
  }
  return out;
}

function callArgs(expr: string): string[] {
  // 从最外层调用的右括号向前匹配，避免链式调用（如 a.b().c()）取到内层参数
  const close = expr.lastIndexOf(')');
  if (close < 0) {
    return [];
  }
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = expr[i];
    if (ch === ')') {
      depth += 1;
    } else if (ch === '(') {
      depth -= 1;
      if (depth === 0) {
        return splitArgs(expr.slice(i + 1, close));
      }
    }
  }
  return [];
}

/** print 的语义：按参数区分提示语 / 分隔线 / 运行结果 */
function describePrint(args: string[], l: Lang): CallDescription {
  if (args.length === 0) {
    return {
      title: pick(l, '打印空行', 'Print a blank line'),
      l1: pick(l, '在屏幕上留一个空行。', 'Leaves a blank line on the screen.'),
      l2: pick(l, '输出空行。', 'Outputs a blank line.'),
    };
  }
  if (args.length > 1) {
    const list = args.map((a) => unquote(a)).join(pick(l, '、', ', '));
    return {
      title: pick(l, '打印多项内容', 'Print several values'),
      l1: pick(
        l,
        `在屏幕上打印 ${args.length} 样东西：${short(list, 40)}。`,
        `Prints ${args.length} things on the screen: ${short(list, 40)}.`,
      ),
      l2: pick(l, `输出 ${short(args.join(', '), 60)}。`, `Outputs ${short(args.join(', '), 60)}.`),
    };
  }
  const arg = args[0];
  const trimmed = arg.trim();
  const literal = unquote(arg);
  const quoted = /^[rRbBuUfF]{0,2}["']/.test(trimmed) && literal !== trimmed;
  if (quoted) {
    if (/^[fF]/.test(trimmed)) {
      return {
        title: pick(l, '打印拼装文本', 'Print a formatted string'),
        l1: pick(
          l,
          '在屏幕上打印一句把值拼进去的话。',
          'Prints a sentence with values filled in.',
        ),
        l2: pick(l, `输出拼装文本 ${short(trimmed, 60)}。`, `Outputs the formatted string ${short(trimmed, 60)}.`),
      };
    }
    return {
      title: pick(l, '打印提示文字', 'Print a message'),
      l1: pick(l, `在屏幕上打一句提示：「${literal}」。`, `Prints a message on the screen: "${literal}".`),
      l2: pick(l, `输出提示「${literal}」。`, `Outputs the message "${literal}".`),
    };
  }
  const repeated = /^(["'])([\s\S]*)\1\s*\*\s*(\d+)$/.exec(trimmed);
  if (repeated) {
    return {
      title: pick(l, '打印分隔线', 'Print a divider'),
      l1: pick(
        l,
        `在屏幕上打一条分隔线：把「${repeated[2]}」重复 ${repeated[3]} 次。`,
        `Prints a divider: "${repeated[2]}" repeated ${repeated[3]} times.`,
      ),
      l2: pick(
        l,
        `输出「${repeated[2]}」重复 ${repeated[3]} 次的分隔线。`,
        `Outputs "${repeated[2]}" repeated ${repeated[3]} times.`,
      ),
    };
  }
  if (/^[A-Za-z_][\w.]*\s*\(/.test(trimmed)) {
    return {
      title: pick(l, '打印运行结果', 'Print a result'),
      l1: pick(
        l,
        `先把 ${simpleRef(trimmed) || '这段'} 跑一遍，再把结果打到屏幕上。`,
        `Runs ${simpleRef(trimmed) || 'this'} first, then prints the result.`,
      ),
      l2: pick(l, `输出 ${short(trimmed, 60)} 的返回值。`, `Outputs the return value of ${short(trimmed, 60)}.`),
    };
  }
  return {
    title: pick(l, '打印变量值', 'Print a value'),
    l1: pick(l, `把 ${short(trimmed, 30)} 现在的值打到屏幕上。`, `Prints the current value of ${short(trimmed, 30)}.`),
    l2: pick(l, `输出 ${short(trimmed, 40)}。`, `Outputs ${short(trimmed, 40)}.`),
  };
}

/** 调用语句的语义：识别常见方法（print / 图构建 / 执行 / 历史） */
function describeCall(f: UnitFacts, l: Lang, hints?: Record<string, string>): CallDescription {
  const expr = f.callExpr ?? '';
  const args = callArgs(expr);
  const name = f.name ?? '';
  const method = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  // 各语言常见的「打印 / 输出」调用，统一按 print 语义解释
  if (
    name === 'print'
    || /^(?:console\.(?:log|info|warn|error)|System\.out\.print(?:ln|f)?|fmt\.Print(?:ln|f)?|println!?|print!?|printf|puts|cout)$/i.test(name)
  ) {
    return describePrint(args, l);
  }
  const a0 = unquote(args[0]);
  const a1 = unquote(args[1]);
  switch (method) {
    case 'add_node':
      return {
        title: pick(l, `加入环节 ${a0}`, `Add step ${a0}`),
        l1: pick(
          l,
          `在流程图里加一个叫 ${a0} 的环节。`,
          `Adds a step called ${a0} to the flow.`,
        ),
        l2: pick(l, `把 ${a0} 加进流程图。`, `Adds ${a0} to the graph.`),
      };
    case 'add_edge':
      return {
        title: pick(l, `连线 ${a0} → ${a1}`, `Connect ${a0} → ${a1}`),
        l1: pick(
          l,
          `在流程图里连一条线：${a0} 走完就轮到 ${a1}。`,
          `Connects the flow: once ${a0} finishes, ${a1} goes next.`,
        ),
        l2: pick(l, `连一条线 ${a0} → ${a1}。`, `Adds the link ${a0} → ${a1}.`),
      };
    case 'add_conditional_edges':
      return {
        title: pick(l, `按 ${args[1] || '条件'} 分流`, `Route via ${args[1] || 'a rule'}`),
        l1: pick(
          l,
          `在 ${a0} 后面设一个路口，由 ${args[1] || '一个判断'} 决定下一步走哪边。`,
          `Puts a fork after ${a0}; ${args[1] || 'a rule'} picks the next step.`,
        ),
        l2: pick(
          l,
          `给 ${a0} 加岔路，用 ${args[1] || '判断'} 决定走向。`,
          `Adds branches after ${a0}, picked by ${args[1] || 'a rule'}.`,
        ),
      };
    case 'compile':
      return {
        title: pick(l, '把流程图变成程序', 'Turn the flow into a program'),
        l1: pick(
          l,
          `把流程图变成一个能直接跑的程序${expr.includes('checkpointer') ? '，并把每一轮的进度存下来' : ''}。`,
          `Turns the flow into a runnable program${expr.includes('checkpointer') ? ' and saves progress for every turn' : ''}.`,
        ),
        l2: pick(
          l,
          `把流程图变成可运行的程序${expr.includes('checkpointer') ? '（带存档）' : ''}。`,
          `Builds a runnable program from the flow${expr.includes('checkpointer') ? ' with saving' : ''}.`,
        ),
      };
    case 'invoke':
      return {
        title: pick(l, '执行一轮', 'Run one turn'),
        l1: pick(
          l,
          '把这次输入交给流程跑一轮，拿回这一轮的结果。',
          "Runs the flow once with this input and returns this turn's result.",
        ),
        l2: pick(
          l,
          `调用 ${name}，输入 ${args[0] || '参数'}${args[1] ? `，附带 ${args[1]}` : ''}。`,
          `Calls ${name} with input ${args[0] || 'the arguments'}${args[1] ? ` and ${args[1]}` : ''}.`,
        ),
      };
    case 'get_state_history':
      return {
        title: pick(l, '读取历史存档', 'Read history'),
        l1: pick(
          l,
          '把这条线里存过的历史记录全取出来，新的在前。',
          'Reads all saved history of this line, newest first.',
        ),
        l2: pick(l, `调用 ${name} 取历史记录列表。`, `Calls ${name} to get the history list.`),
      };
    default:
      return callFallback(f, args, l, hints);
  }
}

/** 未知调用：若工程索引里能找到符号定义，就把「定义位置 + 用途」写进解释 */
function callFallback(
  f: UnitFacts,
  args: string[],
  l: Lang,
  hints?: Record<string, string>,
): CallDescription {
  const name = f.name ?? '';
  const method = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const hint = hints?.[name] ?? hints?.[method];
  const paramText = args.length
    ? pick(l, `，这次用到 ${args.join(', ')}`, ` using ${args.join(', ')}`)
    : '';
  return {
    title: name ? pick(l, `调用 ${name}`, `Call ${name}`) : pick(l, '执行语句', 'Statement'),
    l1: hint
      ? pick(l, `用一下 ${name}（${hint}）${paramText}。`, `Uses ${name} (${hint})${paramText}.`)
      : pick(
        l,
        `${name ? `用一下 ${name}` : '做一步操作'}${paramText}。`,
        `${name ? `Uses ${name}` : 'Performs an action'}${paramText}.`,
      ),
    l2: pick(
      l,
      `调用 ${name || '函数'}${f.callExpr ? `：${f.callExpr}` : ''}。`,
      `Calls ${name || 'a function'}${f.callExpr ? `: ${f.callExpr}` : ''}.`,
    ),
  };
}

export function generateUnit(facts: UnitFacts, options?: DescriptionOptions): UnitDescription {
  const f = facts;
  const lang: Lang = options?.lang ?? 'zh';
  const hints = options?.hints;
  const call = f.kind === 'call' ? describeCall(f, lang, hints) : undefined;
  const title = call ? call.title : titleFor(f, lang);
  // L1 只用模板说白话；注释仅作参考，不直接照抄
  const l1 = call ? call.l1 : intentTemplate[f.kind](f, lang);
  const l2 = call ? call.l2 : stepTemplate[f.kind](f, lang);
  const l3 = f.signature ? f.signature : f.condition ?? f.name ?? '';
  return { title, l1, l2, l3 };
}

function titleFor(f: UnitFacts, l: Lang): string {
  switch (f.kind) {
    case 'docstring': return pick(l, '文件说明', 'About this file');
    case 'import': return pick(l, `导入 ${f.name || ''}`, `Import ${f.name || ''}`);
    case 'import_from': return pick(l, `从 ${f.base || ''} 导入`, `Import from ${f.base || ''}`);
    case 'class': return pick(l, `定义 ${f.name || ''}`, `Define ${f.name || ''}`);
    case 'field': return pick(l, `${f.name || ''} 字段`, `${f.name || ''} field`);
    case 'function': return pick(l, `定义 ${f.name || ''}`, `Define ${f.name || ''}`);
    case 'assignment': return pick(l, `设置 ${f.target || ''}`, `Set ${f.target || ''}`);
    case 'if': return pick(l, '条件分支', 'Condition');
    case 'for': return pick(l, '循环', 'Loop');
    case 'return': return pick(l, '返回', 'Return');
    case 'call': return f.name ? pick(l, `调用 ${f.name}`, `Call ${f.name}`) : pick(l, '执行语句', 'Statement');
    case 'comment': return pick(l, '说明', 'Note');
    case 'statement': return pick(l, '语句', 'Statement');
    default: return pick(l, '语句', 'Statement');
  }
}
