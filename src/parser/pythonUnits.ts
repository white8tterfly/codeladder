// Python AST → 语义单元（确定性逻辑模型）。
// 只从语法树结构推导「有哪些语义单元、每块对应哪些行、各自是什么结构」，
// 不生成任何白话文案 —— 白话文案由 vernacular.ts 负责，且必须锚定回这些单元。

import { field, nodeEndLine, nodeStartLine, oneLine, stripHashComment } from './tree';
import type Parser from 'web-tree-sitter';
import type { LineRange, SemanticUnit, UnitFacts, UnitKind } from '../model/types';

type SN = Parser.SyntaxNode;

/** 遍历上下文：记录当前所属的函数/类与代码块，供 L1/L2 聚合 */
interface WalkCtx {
  l1?: string;
  block: string;
}

const MODULE: WalkCtx = { block: 'module' };

export function derivePythonUnits(root: SN): SemanticUnit[] {
  const units: SemanticUnit[] = [];
  let counter = 0;
  const nextId = (): string => `u${counter++}`;

  function rangeOf(startNode: SN, endNode?: SN): LineRange {
    return { start: nodeStartLine(startNode), end: nodeEndLine(endNode ?? startNode) };
  }

  function emit(kind: UnitKind, facts: Omit<UnitFacts, 'kind'>, node: SN, endNode?: SN, leadLine?: number, ctx: WalkCtx = MODULE): SemanticUnit {
    const r = rangeOf(node, endNode);
    const lines: LineRange[] = [{ start: leadLine !== undefined ? Math.min(r.start, leadLine) : r.start, end: r.end }];
    const unit: SemanticUnit = {
      id: nextId(),
      lines,
      facts: { ...facts, kind },
      containerId: ctx.l1,
      blockId: ctx.block,
    };
    units.push(unit);
    return unit;
  }

  // 复合语句的语句头：只占首行，体内语句交给 walk 拆分，
  // 避免整段（如 26 行的 try 块）被当成一条「语句」塞进 L3/L4
  function emitHeader(kind: UnitKind, facts: Omit<UnitFacts, 'kind'>, node: SN, ctx: WalkCtx, leadLine?: number): SemanticUnit {
    const line = nodeStartLine(node);
    const unit: SemanticUnit = {
      id: nextId(),
      lines: [{ start: leadLine !== undefined ? Math.min(line, leadLine) : line, end: line }],
      facts: { ...facts, kind },
      containerId: ctx.l1,
      blockId: ctx.block,
    };
    units.push(unit);
    return unit;
  }

  // 处理单个语句节点
  function emitStatement(node: SN, ctx: WalkCtx, leadLine?: number, commentText?: string): void {
    const t = node.type;
    const withComment = (f: Omit<UnitFacts, 'kind'>): Omit<UnitFacts, 'kind'> => (commentText ? { ...f, comment: commentText } : f);

    // 装饰器包裹的定义 → 解包
    if (t === 'decorated_definition') {
      const def = field(node, 'definition');
      if (def) { emitStatement(def, ctx, leadLine, commentText); }
      return;
    }

    // 表达式语句：区分赋值 / 调用 / 文档字符串 / 其它
    if (t === 'expression_statement') {
      const inner = node.namedChild(0);
      if (inner) {
        if (inner.type === 'assignment' || inner.type === 'augmented_assignment') {
          emitAssignment(inner, node, ctx, leadLine, commentText);
          return;
        }
        if (inner.type === 'call') {
          const fn = field(inner, 'function');
          emit('call', withComment({
            nodeType: t,
            name: fn ? oneLine(fn) : '',
            callExpr: oneLine(inner),
            signature: oneLine(inner),
          }), node, node, leadLine, ctx);
          return;
        }
        if (inner.type === 'string') {
          // 模块 docstring 已在外层特殊处理；函数体内的 docstring 跳过（降噪）
          return;
        }
      }
      emit('statement', withComment({ nodeType: t, signature: oneLine(node) }), node, node, leadLine, ctx);
      return;
    }

    if (t === 'import_statement') {
      const n = field(node, 'name');
      emit('import', withComment({ nodeType: t, name: oneLine(n), base: oneLine(n), signature: oneLine(node) }), node, node, leadLine, ctx);
      return;
    }

    if (t === 'import_from_statement') {
      const mod = field(node, 'module_name');
      emit('import_from', withComment({ nodeType: t, base: oneLine(mod), name: oneLine(mod), signature: oneLine(node) }), node, node, leadLine, ctx);
      return;
    }

    if (t === 'class_definition') {
      const nameNode = field(node, 'name');
      const name = oneLine(nameNode);
      const sup = field(node, 'superclasses');
      const base = sup ? sup.namedChildren.map((c) => oneLine(c)).join(', ') : '';
      const sig = `class ${name}${base ? `(${base})` : ''}`;
      const unit = emit('class', withComment({ nodeType: t, name, base, signature: sig }), node, sup ?? nameNode ?? node, leadLine, ctx);
      unit.blockId = unit.id;
      const inner: WalkCtx = { l1: unit.id, block: unit.id };
      walkBody(node, inner);
      return;
    }

    if (t === 'function_definition') {
      const nameNode = field(node, 'name');
      const name = oneLine(nameNode);
      const params = oneLine(field(node, 'parameters'));
      const ret = oneLine(field(node, 'return_type'));
      const sig = `def ${name}${params}${ret ? ` -> ${ret}` : ''}`;
      const headerEnd = field(node, 'return_type') ?? field(node, 'parameters') ?? nameNode;
      const unit = emit('function', withComment({ nodeType: t, name, signature: sig }), node, headerEnd ?? node, leadLine, ctx);
      unit.blockId = unit.id;
      const inner: WalkCtx = { l1: unit.id, block: unit.id };
      walkBody(node, inner);
      return;
    }

    if (t === 'if_statement') {
      const cond = oneLine(field(node, 'condition'));
      const headerEnd = field(node, 'condition');
      const unit = emit('if', withComment({ nodeType: t, condition: cond, signature: `if ${cond}:` }), node, headerEnd ?? node, leadLine, ctx);
      unit.blockId = unit.id;
      const inner: WalkCtx = { l1: ctx.l1, block: unit.id };
      walkBody(node, inner);
      walkAlt(field(node, 'alternative'), { l1: ctx.l1, block: `${unit.id}:alt` }, '否则');
      return;
    }

    if (t === 'for_statement') {
      const left = oneLine(field(node, 'left'));
      const right = oneLine(field(node, 'right'));
      const sig = `for ${left} in ${right}:`;
      const headerEnd = field(node, 'right') ?? field(node, 'left');
      const unit = emit('for', withComment({ nodeType: t, condition: `${left} in ${right}`, signature: sig }), node, headerEnd ?? node, leadLine, ctx);
      unit.blockId = unit.id;
      const inner: WalkCtx = { l1: ctx.l1, block: unit.id };
      walkBody(node, inner);
      walkAlt(field(node, 'alternative'), { l1: ctx.l1, block: `${unit.id}:alt` }, '循环收尾');
      return;
    }

    // 复合语句（try / with / while / match）：头部单独成块，体内继续拆分
    if (t === 'try_statement' || t === 'with_statement' || t === 'while_statement' || t === 'match_statement') {
      const label = t === 'try_statement' ? '异常处理'
        : t === 'with_statement' ? '上下文管理'
        : t === 'while_statement' ? '循环'
        : '模式匹配';
      const head = node.text.split('\n')[0].trim();
      const unit = emitHeader('block', withComment({ nodeType: t, name: label, signature: head }), node, ctx, leadLine);
      unit.blockId = unit.id;
      const inner: WalkCtx = { l1: ctx.l1, block: unit.id };

      if (t === 'try_statement') {
        walkBody(node, inner);
        // except / else / finally 各自成块，语句头同样只占一行
        const clauses = node.namedChildren.filter(
          (c) => c.type === 'except_clause' || c.type === 'else_clause' || c.type === 'finally_clause',
        );
        for (const clause of clauses) {
          const name = clause.type === 'except_clause' ? '异常分支'
            : clause.type === 'else_clause' ? '正常收尾'
            : '最终处理';
          const headLine = clause.text.split('\n')[0].trim();
          const cu = emitHeader('block', { nodeType: clause.type, name, signature: headLine }, clause, inner);
          cu.blockId = cu.id;
          walkBody(clause, { l1: ctx.l1, block: cu.id });
        }
      } else if (t === 'match_statement') {
        const body = field(node, 'body');
        for (const clause of (body?.namedChildren ?? [])) {
          if (clause.type !== 'case_clause') {
            continue;
          }
          const cu = emitHeader('block', { nodeType: clause.type, name: '分支', signature: clause.text.split('\n')[0].trim() }, clause, inner);
          cu.blockId = cu.id;
          walkBody(clause, { l1: ctx.l1, block: cu.id });
        }
      } else {
        walkBody(node, inner);
        walkAlt(field(node, 'alternative'), { l1: ctx.l1, block: `${unit.id}:alt` }, '循环收尾');
      }
      return;
    }

    if (t === 'return_statement') {
      const ret = node.namedChild(0);
      emit('return', withComment({ nodeType: t, returns: oneLine(ret), signature: oneLine(node) }), node, node, leadLine, ctx);
      return;
    }

    // 兜底：其它语句
    emit('statement', withComment({ nodeType: t, signature: oneLine(node) }), node, node, leadLine, ctx);
  }

  function emitAssignment(assign: SN, stmtNode: SN, ctx: WalkCtx, leadLine?: number, commentText?: string): void {
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
      }), stmtNode, stmtNode, leadLine, ctx);
      return;
    }
    emit('assignment', withComment({
      nodeType: 'assignment',
      target: oneLine(left),
      value: oneLine(right),
      signature: oneLine(stmtNode),
    }), stmtNode, stmtNode, leadLine, ctx);
  }

  // 遍历一个块内的语句（含「定义体内部注释」对齐到首个语句）
  function walk(children: SN[], ctx: WalkCtx): void {
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
      emitStatement(child, ctx, leadLine, commentText);
    }
  }

  // 函数 / 类 / 条件 / 循环的「体」：体内部直接挂在定义节点下的注释，视为体首语句的前导注释
  function walkBody(defNode: SN, ctx: WalkCtx): void {
    // except / finally 子句在语法树里没有 body 字段，函数体是无字段的 block 子节点
    const body = field(defNode, 'body')
      ?? field(defNode, 'consequence')
      ?? defNode.namedChildren.find((c) => c.type === 'block');
    const interiorComments: SN[] = defNode.namedChildren.filter((c) => c.type === 'comment');
    const bodyChildren: SN[] = body ? body.namedChildren : [];
    walk([...interiorComments, ...bodyChildren], ctx);
  }

  function walkAlt(alt: SN | null, ctx: WalkCtx, label: string): void {
    if (!alt) { return; }
    // elif 链：当作独立分支处理
    if (alt.type === 'if_statement') {
      emitStatement(alt, ctx);
      return;
    }
    // else 头部单独成块，体内继续拆分，避免整段 else 变成一条「语句」
    if (alt.type === 'else_clause') {
      const unit = emitHeader('block', { nodeType: alt.type, name: label, signature: alt.text.split('\n')[0].trim() }, alt, ctx);
      unit.blockId = unit.id;
      walkBody(alt, { l1: ctx.l1, block: unit.id });
      return;
    }
    walk(alt.namedChildren, ctx);
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
    emit('docstring', { nodeType: 'docstring', comment: summary || undefined, signature: '"""…"""' }, first, last, undefined, MODULE);
  }

  // 剩余顶层语句
  walk(moduleChildren.slice(idx), MODULE);

  return units;
}
