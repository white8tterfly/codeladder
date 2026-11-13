// Python AST → 语义单元（确定性逻辑模型）。
// 只从语法树结构推导「有哪些语义单元、每块对应哪些行、各自是什么结构」，
// 不生成任何白话文案 —— 白话文案由 vernacular.ts 负责，且必须锚定回这些单元。

import { field, nodeEndLine, nodeStartLine, oneLine, stripHashComment } from './tree';
import type Parser from 'web-tree-sitter';
import type { LineRange, SemanticUnit, UnitFacts, UnitKind } from '../model/types';

type SN = Parser.SyntaxNode;

export function derivePythonUnits(root: SN): SemanticUnit[] {
  const units: SemanticUnit[] = [];
  let counter = 0;
  const nextId = (): string => `u${counter++}`;

  function rangeOf(startNode: SN, endNode?: SN): LineRange {
    return { start: nodeStartLine(startNode), end: nodeEndLine(endNode ?? startNode) };
  }

  function emit(kind: UnitKind, facts: Omit<UnitFacts, 'kind'>, node: SN, endNode?: SN, leadLine?: number): void {
    const r = rangeOf(node, endNode);
    const lines: LineRange[] = [{ start: leadLine !== undefined ? Math.min(r.start, leadLine) : r.start, end: r.end }];
    units.push({ id: nextId(), lines, facts: { ...facts, kind } });
  }

  // 处理单个语句节点
  function emitStatement(node: SN, leadLine?: number, commentText?: string): void {
    const t = node.type;
    const withComment = (f: Omit<UnitFacts, 'kind'>): Omit<UnitFacts, 'kind'> => (commentText ? { ...f, comment: commentText } : f);

    // 装饰器包裹的定义 → 解包
    if (t === 'decorated_definition') {
      const def = field(node, 'definition');
      if (def) { emitStatement(def, leadLine, commentText); }
      return;
    }

    // 表达式语句：区分赋值 / 调用 / 文档字符串 / 其它
    if (t === 'expression_statement') {
      const inner = node.namedChild(0);
      if (inner) {
        if (inner.type === 'assignment') {
          emitAssignment(inner, node, leadLine, commentText);
          return;
        }
        if (inner.type === 'call') {
          const fn = field(inner, 'function');
          emit('call', withComment({
            nodeType: t,
            name: fn ? oneLine(fn) : '',
            callExpr: oneLine(inner),
            signature: oneLine(inner),
          }), node, node, leadLine);
          return;
        }
        if (inner.type === 'string') {
          // 模块 docstring 已在外层特殊处理；函数体内的 docstring 跳过（降噪）
          return;
        }
      }
      emit('statement', withComment({ nodeType: t, signature: oneLine(node) }), node, node, leadLine);
      return;
    }

    if (t === 'import_statement') {
      const n = field(node, 'name');
      emit('import', withComment({ nodeType: t, name: oneLine(n), base: oneLine(n), signature: oneLine(node) }), node, node, leadLine);
      return;
    }

    if (t === 'import_from_statement') {
      const mod = field(node, 'module_name');
      emit('import_from', withComment({ nodeType: t, base: oneLine(mod), name: oneLine(mod), signature: oneLine(node) }), node, node, leadLine);
      return;
    }

    if (t === 'class_definition') {
      const nameNode = field(node, 'name');
      const name = oneLine(nameNode);
      const sup = field(node, 'superclasses');
      const base = sup ? sup.namedChildren.map((c) => oneLine(c)).join(', ') : '';
      const sig = `class ${name}${base ? `(${base})` : ''}`;
      emit('class', withComment({ nodeType: t, name, base, signature: sig }), node, sup ?? nameNode ?? node, leadLine);
      walkBody(node);
      return;
    }

    if (t === 'function_definition') {
      const nameNode = field(node, 'name');
      const name = oneLine(nameNode);
      const params = oneLine(field(node, 'parameters'));
      const ret = oneLine(field(node, 'return_type'));
      const sig = `def ${name}${params}${ret ? ` -> ${ret}` : ''}`;
      const headerEnd = field(node, 'return_type') ?? field(node, 'parameters') ?? nameNode;
      emit('function', withComment({ nodeType: t, name, signature: sig }), node, headerEnd ?? node, leadLine);
      walkBody(node);
      return;
    }

    if (t === 'if_statement') {
      const cond = oneLine(field(node, 'condition'));
      const headerEnd = field(node, 'condition');
      emit('if', withComment({ nodeType: t, condition: cond, signature: `if ${cond}:` }), node, headerEnd ?? node, leadLine);
      walkBody(node);
      walkAlt(field(node, 'alternative'));
      return;
    }

    if (t === 'for_statement') {
      const left = oneLine(field(node, 'left'));
      const right = oneLine(field(node, 'right'));
      const sig = `for ${left} in ${right}:`;
      const headerEnd = field(node, 'right') ?? field(node, 'left');
      emit('for', withComment({ nodeType: t, condition: `${left} in ${right}`, signature: sig }), node, headerEnd ?? node, leadLine);
      walkBody(node);
      return;
    }

    if (t === 'return_statement') {
      const ret = node.namedChild(0);
      emit('return', withComment({ nodeType: t, returns: oneLine(ret), signature: oneLine(node) }), node, node, leadLine);
      return;
    }

    // 兜底：其它语句
    emit('statement', withComment({ nodeType: t, signature: oneLine(node) }), node, node, leadLine);
  }

  function emitAssignment(assign: SN, stmtNode: SN, leadLine?: number, commentText?: string): void {
    const withComment = (f: Omit<UnitFacts, 'kind'>): Omit<UnitFacts, 'kind'> => (commentText ? { ...f, comment: commentText } : f);
    const left = field(assign, 'left');
    const right = field(assign, 'right');
    const typeNode = field(assign, 'type');
    if (typeNode && !right) {
      // 带类型标注、无值：字段（TypedDict 等）
      emit('field', withComment({
        nodeType: 'assignment',
        name: oneLine(left),
        value: oneLine(typeNode),
        signature: `${oneLine(left)}: ${oneLine(typeNode)}`,
      }), stmtNode, stmtNode, leadLine);
      return;
    }
    emit('assignment', withComment({
      nodeType: 'assignment',
      target: oneLine(left),
      value: oneLine(right),
      signature: oneLine(stmtNode),
    }), stmtNode, stmtNode, leadLine);
  }

  // 遍历一个块内的语句（含「定义体内部注释」对齐到首个语句）
  function walk(children: SN[]): void {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'comment') {
        continue; // 注释在遇到下一个语句时作为 leadLine 处理
      }
      const prev = children[i - 1];
      let leadLine: number | undefined;
      let commentText: string | undefined;
      if (prev && prev.type === 'comment') {
        // 区分「前导注释」（独占一行、紧贴本语句上方）与「上一语句的尾注释」（与上一语句同行）
        const prevPrev = children[i - 2];
        const isTrailingOfPrev = !!prevPrev && prevPrev.type !== 'comment' && nodeEndLine(prevPrev) === nodeEndLine(prev);
        if (!isTrailingOfPrev && nodeEndLine(prev) + 1 === nodeStartLine(child)) {
          leadLine = nodeStartLine(prev);
          commentText = stripHashComment(prev.text);
        }
      }
      // 同行的尾注释（如字段后的说明）
      const next = children[i + 1];
      if (!commentText && next && next.type === 'comment' && nodeStartLine(next) === nodeEndLine(child)) {
        commentText = stripHashComment(next.text);
      }
      emitStatement(child, leadLine, commentText);
    }
  }

  // 函数 / 类 / 条件 / 循环的「体」：体内部直接挂在定义节点下的注释，视为体首语句的前导注释
  function walkBody(defNode: SN): void {
    const body = field(defNode, 'body') ?? field(defNode, 'consequence');
    const interiorComments: SN[] = defNode.namedChildren.filter((c) => c.type === 'comment');
    const bodyChildren: SN[] = body ? body.namedChildren : [];
    walk([...interiorComments, ...bodyChildren]);
  }

  function walkAlt(alt: SN | null): void {
    if (!alt) { return; }
    if (alt.type === 'block') {
      walk(alt.namedChildren);
      return;
    }
    if (alt.type === 'if_statement') {
      // elif 链
      emitStatement(alt);
      return;
    }
    walk(alt.namedChildren);
  }

  // ---- 顶层：模块头部（编码声明 + docstring）单独成块 ----
  const moduleChildren = root.namedChildren;
  let idx = 0;
  const headerNodes: SN[] = [];
  while (idx < moduleChildren.length) {
    const c = moduleChildren[idx];
    if (c.type === 'comment') { headerNodes.push(c); idx++; continue; }
    if (c.type === 'expression_statement' && c.namedChild(0)?.type === 'string') {
      headerNodes.push(c); idx++; break;
    }
    break;
  }
  if (headerNodes.length > 0) {
    const first = headerNodes[0];
    const last = headerNodes[headerNodes.length - 1];
    const strNode = headerNodes.find((c) => c.type === 'expression_statement');
    const raw = strNode ? strNode.text : '';
    const summary = raw
      .replace(/^\s*[rRuUbBfF]?("""|''')/, '')
      .replace(/("""|''')\s*$/, '')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
    emit('docstring', { nodeType: 'docstring', comment: summary || undefined, signature: '"""…"""' }, first, last);
  }

  // 剩余顶层语句
  walk(moduleChildren.slice(idx));

  return units;
}
