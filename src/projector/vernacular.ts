// 白话翻译层：把语义单元的「确定性事实」投影为四档白话内容（中英双语）。
//
// 架构定位（对应 PRD 3.2）：
// - L3 的结构（控制流/签名）完全来自 AST 事实，100% 确定性；
// - L2 由 AST 结构 + 命名推导，是确定性的白话化；
// - L1 是意图归纳：优先复用代码内注释，否则用模板兜底，标记为「⚠ AI 生成」。
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

const intentTemplate: Record<UnitKind, (f: UnitFacts, l: Lang) => string> = {
  docstring: (_f, l) => pick(
    l,
    '开头是这份文件的"说明书"，讲清楚它是干嘛的、怎么运行。',
    'This opening note explains what the file is for and how to run it.',
  ),
  import: (f, l) => pick(
    l,
    `引入一个叫 ${f.name || '??'} 的工具包，后面要借用它。`,
    `Brings in the ${f.name || '??'} package for later use.`,
  ),
  import_from: (f, l) => pick(
    l,
    `从 ${f.base || '??'} 里引入几个需要用到的工具。`,
    `Imports a few helpers from ${f.base || '??'}.`,
  ),
  class: (f, l) => pick(
    l,
    `声明一个叫 ${f.name || '??'} 的结构（"资料袋"），规定里面放哪些字段。`,
    `Declares a structure called ${f.name || '??'} and the fields it holds.`,
  ),
  field: (f, l) => pick(
    l,
    `结构里的一个格子：${f.name || '??'}。`,
    `One field inside the structure: ${f.name || '??'}.`,
  ),
  function: (f, l) => pick(
    l,
    `定义一步"工序"：${f.name || '??'}。`,
    `Defines a reusable step: ${f.name || '??'}.`,
  ),
  assignment: (f, l) => pick(
    l,
    `把某个结果算出来，存进 ${f.target || '一个变量'}。`,
    `Computes a result and stores it in ${f.target || 'a variable'}.`,
  ),
  if: (f, l) => pick(
    l,
    `判断「${f.condition || '条件'}」，成立才执行下面这段。`,
    `Checks "${f.condition || 'a condition'}" and runs the block below only when true.`,
  ),
  for: (f, l) => pick(
    l,
    `依次处理「${f.condition || '集合'}」里的每一项。`,
    `Handles each item of "${f.condition || 'a collection'}" one by one.`,
  ),
  return: (f, l) => pick(
    l,
    f.returns ? `把 ${f.returns} 作为结果返回。` : '把结果交出来。',
    f.returns ? `Returns ${f.returns} as the result.` : 'Returns the result.',
  ),
  call: (f, l) => describeCall(f, l).l1,
  comment: (_f, l) => pick(l, '一段说明文字。', 'A note for human readers.'),
  statement: (_f, l) => pick(l, '执行一段代码。', 'Runs a statement.'),
};

const stepTemplate: Record<UnitKind, (f: UnitFacts, l: Lang) => string> = {
  docstring: (_f, l) => pick(l, '模块说明：说明文件用途与运行方式。', 'Module docstring: purpose and how to run.'),
  import: (f, l) => pick(l, `导入 ${f.name || '??'} 模块。`, `Imports the ${f.name || '??'} module.`),
  import_from: (f, l) => pick(l, `从 ${f.base || '??'} 导入所需名称。`, `Imports names from ${f.base || '??'}.`),
  class: (f, l) => pick(
    l,
    `定义类 ${f.name || '??'}${f.base ? `（继承 ${f.base}）` : ''}。`,
    `Defines class ${f.name || '??'}${f.base ? ` (extends ${f.base})` : ''}.`,
  ),
  field: (f, l) => pick(
    l,
    `定义字段 ${f.name || '??'}，类型 ${f.value || '??'}。`,
    `Declares field ${f.name || '??'} of type ${f.value || '??'}.`,
  ),
  function: (f, l) => pick(l, `定义函数 ${f.name || '??'}。`, `Defines function ${f.name || '??'}.`),
  assignment: (f, l) => pick(
    l,
    `给变量 ${f.target || '??'} 赋值${f.value ? `为 ${f.value}` : ''}。`,
    `Assigns ${f.value || 'a value'} to ${f.target || 'a variable'}.`,
  ),
  if: (f, l) => pick(
    l,
    `判断「${f.condition || '条件'}」，进入对应分支。`,
    `Checks "${f.condition || 'a condition'}" and takes the matching branch.`,
  ),
  for: (f, l) => pick(
    l,
    `遍历「${f.condition || '集合'}」，逐项处理。`,
    `Iterates over "${f.condition || 'a collection'}" and processes each item.`,
  ),
  return: (f, l) => pick(
    l,
    `返回${f.returns ? `「${f.returns}」` : '结果'}。`,
    `Returns ${f.returns ? `"${f.returns}"` : 'a result'}.`,
  ),
  call: (f, l) => describeCall(f, l).l2,
  comment: (f, l) => f.comment || pick(l, '注释说明。', 'A comment.'),
  statement: (f, l) => pick(
    l,
    `执行语句${f.signature ? `：${f.signature}` : ''}。`,
    `Runs a statement${f.signature ? `: ${f.signature}` : ''}.`,
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
      l1: pick(l, '在终端输出一个空行。', 'Prints an empty line to the terminal.'),
      l2: pick(l, '输出空行。', 'Outputs an empty line.'),
    };
  }
  if (args.length > 1) {
    const list = args.map((a) => unquote(a)).join(pick(l, '、', ', '));
    return {
      title: pick(l, '打印多项内容', 'Print several values'),
      l1: pick(
        l,
        `在终端把 ${args.length} 项内容连起来打印：${list}。`,
        `Prints ${args.length} values joined together: ${list}.`,
      ),
      l2: pick(l, `输出 ${args.join(', ')}。`, `Outputs ${args.join(', ')}.`),
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
          `在终端打印一段把变量拼进去的文字：${trimmed}。`,
          `Prints a string with variables interpolated: ${trimmed}.`,
        ),
        l2: pick(l, `输出拼装文本 ${trimmed}。`, `Outputs the formatted string ${trimmed}.`),
      };
    }
    return {
      title: pick(l, '打印提示文字', 'Print a message'),
      l1: pick(l, `在终端打印一句提示：「${literal}」。`, `Prints a message to the terminal: "${literal}".`),
      l2: pick(l, `输出提示「${literal}」。`, `Outputs the message "${literal}".`),
    };
  }
  const repeated = /^(["'])([\s\S]*)\1\s*\*\s*(\d+)$/.exec(trimmed);
  if (repeated) {
    return {
      title: pick(l, '打印分隔线', 'Print a divider'),
      l1: pick(
        l,
        `在终端打印一条分隔线：把「${repeated[2]}」重复 ${repeated[3]} 次。`,
        `Prints a divider made of "${repeated[2]}" repeated ${repeated[3]} times.`,
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
        `先把 ${trimmed} 跑一遍，再把它的结果打印到终端。`,
        `Runs ${trimmed} first, then prints its result.`,
      ),
      l2: pick(l, `输出 ${trimmed} 的返回值。`, `Outputs the return value of ${trimmed}.`),
    };
  }
  return {
    title: pick(l, '打印变量值', 'Print a value'),
    l1: pick(l, `把 ${trimmed} 当前的值打印到终端。`, `Prints the current value of ${trimmed}.`),
    l2: pick(l, `输出 ${trimmed}。`, `Outputs ${trimmed}.`),
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
        title: pick(l, `注册节点 ${a0}`, `Register node ${a0}`),
        l1: pick(
          l,
          `在流程图上登记一个叫 ${a0} 的处理节点。`,
          `Registers ${a0} as a processing node on the graph.`,
        ),
        l2: pick(l, `把 ${a0} 注册为图上的节点。`, `Adds ${a0} as a graph node.`),
      };
    case 'add_edge':
      return {
        title: pick(l, `连线 ${a0} → ${a1}`, `Connect ${a0} → ${a1}`),
        l1: pick(
          l,
          `在流程图上画一条线：${a0} 走完就接到 ${a1}。`,
          `Draws an edge: once ${a0} finishes, the flow goes to ${a1}.`,
        ),
        l2: pick(l, `添加连线 ${a0} → ${a1}。`, `Adds the edge ${a0} → ${a1}.`),
      };
    case 'add_conditional_edges':
      return {
        title: pick(l, `按 ${args[1] || '条件'} 分流`, `Route via ${args[1] || 'a router'}`),
        l1: pick(
          l,
          `给 ${a0} 挂一个分岔路口，由 ${args[1] || '一个判断函数'} 决定下一站走哪个节点。`,
          `Adds a fork after ${a0}; ${args[1] || 'a router'} decides which node comes next.`,
        ),
        l2: pick(
          l,
          `为 ${a0} 添加条件分支，用 ${args[1] || '判断函数'} 决定走向。`,
          `Adds conditional branches from ${a0}, routed by ${args[1] || 'a router'}.`,
        ),
      };
    case 'compile':
      return {
        title: pick(l, '编译流程图', 'Compile the graph'),
        l1: pick(
          l,
          `把流程图编译成可以直接运行的程序${expr.includes('checkpointer') ? '，并挂上存档能力（能记住每一轮状态）' : ''}。`,
          `Compiles the graph into a runnable program${expr.includes('checkpointer') ? ', with checkpointing so every turn is saved' : ''}.`,
        ),
        l2: pick(
          l,
          `编译流程图${expr.includes('checkpointer') ? '（带 checkpointer）' : ''}。`,
          `Compiles the graph${expr.includes('checkpointer') ? ' with a checkpointer' : ''}.`,
        ),
      };
    case 'invoke':
      return {
        title: pick(l, '执行一轮', 'Run one turn'),
        l1: pick(
          l,
          `带着输入 ${args[0] || '参数'} 把流程跑一轮，返回这一轮的结果。`,
          `Runs the flow once with input ${args[0] || 'the arguments'} and returns this turn's result.`,
        ),
        l2: pick(
          l,
          `调用 ${name}，输入 ${args[0] || '参数'}${args[1] ? `，配置 ${args[1]}` : ''}。`,
          `Calls ${name} with input ${args[0] || 'the arguments'}${args[1] ? ` and config ${args[1]}` : ''}.`,
        ),
      };
    case 'get_state_history':
      return {
        title: pick(l, '读取历史存档', 'Read history'),
        l1: pick(
          l,
          '取出这条对话链保存过的全部历史状态（新的在前）。',
          'Reads every saved state of this conversation chain (newest first).',
        ),
        l2: pick(l, `调用 ${name} 取出历史状态列表。`, `Calls ${name} to get the list of past states.`),
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
    ? pick(l, `，参数是 ${args.join(', ')}`, ` with arguments ${args.join(', ')}`)
    : '';
  return {
    title: name ? pick(l, `调用 ${name}`, `Call ${name}`) : pick(l, '执行语句', 'Statement'),
    l1: hint
      ? pick(l, `调用 ${name}（${hint}）${paramText}。`, `Calls ${name} (${hint})${paramText}.`)
      : pick(
        l,
        `${name ? `调用 ${name}` : '执行一段操作'}${paramText}。`,
        `${name ? `Calls ${name}` : 'Performs an operation'}${paramText}.`,
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
  const l1 = f.comment ? f.comment : call ? call.l1 : intentTemplate[f.kind](f, lang);
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
