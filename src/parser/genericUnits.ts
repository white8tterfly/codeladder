// 非 Python 语言的通用 AST → 语义单元提取。
// 各语言的语法节点名不同，这里用「语法画像」描述节点集合，再用统一流程遍历，
// 保证行号、层级、注释归属完全来自 AST（确定性），不生成白话文案。

import type Parser from 'web-tree-sitter';
import type { LineRange, SemanticUnit, UnitFacts, UnitKind } from '../model/types';
import type { LanguageId } from '../lang/languages';
import { nodeEndLine, nodeStartLine, oneLine } from './tree';

type SN = Parser.SyntaxNode;

export interface SyntaxProfile {
  commentTypes: string[];
  strip: (text: string) => string;
  /** 透明包装节点：取出其中的声明继续处理（如 export / template） */
  unwrapNodes: string[];
  /** 透明作用域节点：只遍历其内部，不单独成块（如 namespace） */
  scopeNodes: string[];
  /** 只遍历内部、不建块的节点（如 Rust impl，方法本身仍会成块） */
  walkOnlyNodes: string[];
  /** 纯元信息节点：忽略（如 package） */
  skipNodes: string[];
  importNodes: string[];
  importFromNodes: string[];
  classNodes: string[];
  functionNodes: string[];
  methodNodes: string[];
  fieldNodes: string[];
  variableNodes: string[];
  ifNodes: string[];
  loopNodes: string[];
  returnNodes: string[];
  exprNodes: string[];
  assignmentNodes: string[];
  callNodes: string[];
  fileDoc: boolean;
}

const BLOCK_TYPES = new Set([
  'block',
  'statement_block',
  'class_body',
  'interface_body',
  'declaration_list',
  'compound_statement',
  'field_declaration_list',
  'enum_body',
  'switch_block',
  'program',
]);

const IDENTIFIER_TYPES = new Set([
  'identifier',
  'field_identifier',
  'property_identifier',
  'type_identifier',
  'constant_identifier',
  'simple_identifier',
  'shorthand_property_identifier_pattern',
]);

const TS_PROFILE: SyntaxProfile = {
  commentTypes: ['comment'],
  strip: stripJsComment,
  unwrapNodes: ['export_statement'],
  scopeNodes: [],
  walkOnlyNodes: [],
  skipNodes: [],
  importNodes: [],
  importFromNodes: ['import_statement'],
  classNodes: ['class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'abstract_class_declaration'],
  functionNodes: ['function_declaration', 'generator_function_declaration'],
  methodNodes: ['method_definition', 'abstract_method_signature', 'method_signature'],
  fieldNodes: ['public_field_definition', 'property_signature'],
  variableNodes: ['lexical_declaration', 'variable_declaration'],
  ifNodes: ['if_statement', 'switch_statement'],
  loopNodes: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
  returnNodes: ['return_statement'],
  exprNodes: ['expression_statement'],
  assignmentNodes: ['assignment_expression', 'augmented_assignment_expression'],
  callNodes: ['call_expression', 'new_expression'],
  fileDoc: true,
};

const C_PROFILE: SyntaxProfile = {
  commentTypes: ['comment'],
  strip: stripSlash,
  unwrapNodes: [],
  scopeNodes: [],
  walkOnlyNodes: [],
  skipNodes: ['preproc_def', 'preproc_function_def', 'preproc_call'],
  importNodes: ['preproc_include'],
  importFromNodes: [],
  classNodes: ['struct_specifier', 'union_specifier', 'enum_specifier', 'type_definition'],
  functionNodes: ['function_definition'],
  methodNodes: [],
  fieldNodes: ['field_declaration'],
  variableNodes: ['declaration'],
  ifNodes: ['if_statement', 'switch_statement'],
  loopNodes: ['for_statement', 'while_statement', 'do_statement'],
  returnNodes: ['return_statement'],
  exprNodes: ['expression_statement'],
  assignmentNodes: ['assignment_expression', 'update_expression'],
  callNodes: ['call_expression'],
  fileDoc: true,
};

const CPP_PROFILE: SyntaxProfile = {
  ...C_PROFILE,
  scopeNodes: ['namespace_definition'],
  walkOnlyNodes: [],
  classNodes: [...C_PROFILE.classNodes, 'class_specifier'],
  importNodes: ['preproc_include'],
  importFromNodes: ['using_declaration'],
  unwrapNodes: ['template_declaration'],
  skipNodes: ['preproc_def', 'preproc_function_def', 'preproc_call', 'access_specifier'],
  variableNodes: ['declaration', 'field_declaration'],
};

const JAVA_PROFILE: SyntaxProfile = {
  commentTypes: ['line_comment', 'block_comment'],
  strip: stripSlash,
  unwrapNodes: [],
  scopeNodes: [],
  walkOnlyNodes: [],
  skipNodes: ['package_declaration'],
  importNodes: [],
  importFromNodes: ['import_declaration'],
  classNodes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration'],
  functionNodes: [],
  methodNodes: ['method_declaration', 'constructor_declaration', 'compact_constructor_declaration'],
  fieldNodes: ['field_declaration'],
  variableNodes: ['local_variable_declaration'],
  ifNodes: ['if_statement', 'switch_expression', 'switch_statement'],
  loopNodes: ['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'],
  returnNodes: ['return_statement'],
  exprNodes: ['expression_statement'],
  assignmentNodes: ['assignment_expression'],
  callNodes: ['method_invocation', 'object_creation_expression'],
  fileDoc: true,
};

const RUST_PROFILE: SyntaxProfile = {
  commentTypes: ['line_comment', 'block_comment'],
  strip: stripSlash,
  unwrapNodes: [],
  scopeNodes: [],
  walkOnlyNodes: ['impl_item'],
  skipNodes: ['attribute_item', 'inner_attribute_item'],
  importNodes: [],
  importFromNodes: ['use_declaration', 'extern_crate_declaration'],
  classNodes: ['struct_item', 'enum_item', 'trait_item', 'impl_item', 'union_item', 'type_item'],
  functionNodes: ['function_item'],
  methodNodes: [],
  fieldNodes: ['field_declaration'],
  variableNodes: ['let_declaration', 'const_item', 'static_item'],
  ifNodes: ['if_expression', 'match_expression'],
  loopNodes: ['for_expression', 'while_expression', 'loop_expression'],
  returnNodes: ['return_expression'],
  exprNodes: ['expression_statement'],
  assignmentNodes: ['assignment_expression', 'compound_assignment_expr'],
  callNodes: ['call_expression', 'macro_invocation'],
  fileDoc: true,
};

const GO_PROFILE: SyntaxProfile = {
  commentTypes: ['comment'],
  strip: stripSlash,
  unwrapNodes: [],
  scopeNodes: [],
  walkOnlyNodes: [],
  skipNodes: ['package_clause'],
  importNodes: [],
  importFromNodes: ['import_declaration'],
  classNodes: ['type_declaration'],
  functionNodes: ['function_declaration'],
  methodNodes: ['method_declaration'],
  fieldNodes: ['field_declaration'],
  variableNodes: ['var_declaration', 'const_declaration', 'short_var_declaration'],
  ifNodes: ['if_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement'],
  loopNodes: ['for_statement'],
  returnNodes: ['return_statement'],
  exprNodes: ['expression_statement', 'defer_statement', 'go_statement'],
  assignmentNodes: ['assignment_statement'],
  callNodes: ['call_expression'],
  fileDoc: true,
};

export function syntaxProfile(lang: LanguageId): SyntaxProfile {
  switch (lang) {
    case 'typescript':
    case 'tsx':
      return TS_PROFILE;
    case 'c':
      return C_PROFILE;
    case 'cpp':
      return CPP_PROFILE;
    case 'java':
      return JAVA_PROFILE;
    case 'rust':
      return RUST_PROFILE;
    case 'go':
      return GO_PROFILE;
    default:
      return TS_PROFILE;
  }
}

function stripJsComment(text: string): string {
  return stripSlash(text);
}

function stripSlash(text: string): string {
  const t = text.trim();
  if (t.startsWith('//')) {
    return t.replace(/^\/\/[/!]?\s?/, '').trim();
  }
  if (t.startsWith('/*')) {
    return t
      .replace(/^\/\*+!?/, '')
      .replace(/\*+\/$/, '')
      .split('\n')
      .map((s) => s.replace(/^\s*\*\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (t.startsWith('#')) {
    return t.replace(/^#\s*/, '').trim();
  }
  return t;
}

/** 头部文本：截到首个 { 之前，去掉结尾的分号/冒号 */
export function headerText(node: SN): string {
  const raw = node.text;
  const brace = raw.indexOf('{');
  const head = brace > 0 ? raw.slice(0, brace) : raw.split('\n')[0];
  return head.replace(/\s+/g, ' ').replace(/[;:]\s*$/, '').trim().slice(0, 220);
}

/** 取第一个标识符（按层序，避免取到深层参数名） */
function firstIdentifier(node: SN): string {
  const queue: SN[] = [...node.namedChildren];
  while (queue.length > 0) {
    const current = queue.shift() as SN;
    if (IDENTIFIER_TYPES.has(current.type)) {
      return current.text;
    }
    queue.push(...current.namedChildren);
  }
  return '';
}

/** 节点名称：优先 name 字段，其次 declarator / pattern，最后首个标识符 */
export function nameOfNode(node: SN): string {
  const direct = node.childForFieldName('name');
  if (direct) {
    return oneLine(direct);
  }
  for (const f of ['declarator', 'pattern', 'type']) {
    const n = node.childForFieldName(f);
    if (n && IDENTIFIER_TYPES.has(n.type)) {
      return oneLine(n);
    }
  }
  const decl = node.childForFieldName('declarator') ?? node.childForFieldName('pattern');
  if (decl) {
    const id = firstIdentifier(decl);
    if (id) {
      return id;
    }
  }
  if (node.type === 'type_declaration') {
    const spec = node.namedChildren.find((c) => c.type === 'type_spec');
    if (spec) {
      return oneLine(spec.childForFieldName('name')) || firstIdentifier(spec);
    }
  }
  return firstIdentifier(node);
}

/** 类 / 结构体的继承信息（尽量从头部文本里取） */
export function classBaseOf(header: string): string {
  const ext = /\b(?:extends|implements)\s+([^{]+)/.exec(header);
  if (ext) {
    return ext[1].trim();
  }
  if (header.startsWith('impl ')) {
    const forPart = /^impl(?:<[^>]*>)?\s+(.+?)\s+for\s+.+$/.exec(header);
    return forPart ? forPart[1].trim() : '';
  }
  const colon = /\b(?:class|struct)\s+\w+\s*:\s*([^{]+)/.exec(header);
  if (colon) {
    return colon[1].trim();
  }
  const struct = /\bstruct\s+\w+\s*\{\s*([^{}]+)\s*\}/.exec(header);
  return struct ? struct[1].trim() : '';
}

/** 定义体节点 */
export function bodyNodeOf(node: SN): SN | null {
  for (const name of ['body', 'consequence']) {
    const b = node.childForFieldName(name);
    if (b) {
      return b;
    }
  }
  return node.namedChildren.find((c) => BLOCK_TYPES.has(c.type)) ?? null;
}

/** 顶层声明（供工程索引使用）：类 / 函数 / 方法 / 类型 */
export interface DeclaredSymbol {
  name: string;
  kind: 'class' | 'function';
  signature: string;
  node: SN;
}

export function collectDeclarations(root: SN, lang: LanguageId): DeclaredSymbol[] {
  const p = syntaxProfile(lang);
  const out: DeclaredSymbol[] = [];
  const seen = new Set<SN>();

  const visit = (node: SN, depth: number): void => {
    if (depth > 2) {
      return;
    }
    let target = node;
    if (p.unwrapNodes.includes(target.type)) {
      const inner = target.childForFieldName('declaration')
        ?? target.namedChildren.find((c) => !p.commentTypes.includes(c.type));
      if (!inner) {
        return;
      }
      target = inner;
    }
    if (p.skipNodes.includes(target.type) || p.scopeNodes.includes(target.type)) {
      return;
    }

    const isClass = p.classNodes.includes(target.type);
    const isFunction = p.functionNodes.includes(target.type) || p.methodNodes.includes(target.type);
    if (isClass || isFunction) {
      const name = nameOfNode(target);
      if (name && !seen.has(target)) {
        seen.add(target);
        out.push({
          name,
          kind: isClass ? 'class' : 'function',
          signature: headerText(target),
          node: target,
        });
      }
      if (isClass) {
        const body = bodyNodeOf(target);
        if (body) {
          for (const child of body.namedChildren) {
            if (!p.commentTypes.includes(child.type)) {
              visit(child, depth + 1);
            }
          }
        }
      }
    }
  };

  for (const child of root.namedChildren) {
    if (!p.commentTypes.includes(child.type)) {
      visit(child, 0);
    }
  }
  return out;
}

// ---------- 语义单元 ----------

/** 遍历上下文：记录当前所属的函数/类与代码块，供 L1/L2 聚合 */
interface WalkCtx {
  l1?: string;
  block: string;
}

const MODULE: WalkCtx = { block: 'module' };

export function deriveGenericUnits(root: SN, lang: LanguageId): SemanticUnit[] {
  const p = syntaxProfile(lang);
  const units: SemanticUnit[] = [];
  let counter = 0;
  const nextId = (): string => `u${counter++}`;

  const emit = (kind: UnitKind, facts: Omit<UnitFacts, 'kind'>, node: SN, endNode?: SN, leadLine?: number, ctx: WalkCtx = MODULE): SemanticUnit => {
    const lines: LineRange[] = [{
      start: leadLine !== undefined ? Math.min(nodeStartLine(node), leadLine) : nodeStartLine(node),
      end: nodeEndLine(endNode ?? node),
    }];
    const unit: SemanticUnit = {
      id: nextId(),
      lines,
      facts: { ...facts, kind },
      containerId: ctx.l1,
      blockId: ctx.block,
    };
    units.push(unit);
    return unit;
  };

  const isComment = (node: SN): boolean => p.commentTypes.includes(node.type);

  const withComment = (facts: Omit<UnitFacts, 'kind'>, commentText?: string): Omit<UnitFacts, 'kind'> =>
    commentText ? { ...facts, comment: commentText } : facts;

  // ---- 文件头部说明（连续注释） ----
  let start = 0;
  const header: SN[] = [];
  while (start < root.namedChildren.length) {
    const c = root.namedChildren[start];
    if (isComment(c)) {
      header.push(c);
      start++;
      continue;
    }
    break;
  }
  if (p.fileDoc && header.length > 0) {
    const text = p.strip(header.map((c) => c.text).join('\n'));
    const firstLine = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
    emit(
      'docstring',
      { nodeType: 'docstring', comment: firstLine || undefined, signature: firstLine ? firstLine.slice(0, 120) : '/* … */' },
      header[0],
      header[header.length - 1],
      undefined,
      MODULE,
    );
  }

  const walk = (children: SN[], insideClass: boolean, ctx: WalkCtx): void => {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (isComment(child)) {
        continue;
      }
      const prev = children[i - 1];
      let leadLine: number | undefined;
      let commentText: string | undefined;
      if (prev && isComment(prev)) {
        const prevPrev = children[i - 2];
        const isTrailing = !!prevPrev && !isComment(prevPrev) && nodeEndLine(prevPrev) === nodeEndLine(prev);
        if (!isTrailing && nodeEndLine(prev) + 1 === nodeStartLine(child)) {
          leadLine = nodeStartLine(prev);
          commentText = p.strip(prev.text);
        }
      }
      const next = children[i + 1];
      if (!commentText && next && isComment(next) && nodeStartLine(next) === nodeEndLine(child)) {
        commentText = p.strip(next.text);
      }
      emitNode(child, insideClass, ctx, leadLine, commentText);
    }
  };

  const walkBody = (node: SN, insideClass: boolean, ctx: WalkCtx): void => {
    const body = bodyNodeOf(node);
    if (body) {
      walk(body.namedChildren, insideClass, ctx);
    }
  };

  const emitNode = (node: SN, insideClass: boolean, ctx: WalkCtx, leadLine?: number, commentText?: string, outer?: SN): void => {
    const t = node.type;
    if (p.commentTypes.includes(t)) {
      return;
    }
    if (p.skipNodes.includes(t)) {
      return;
    }
    if (p.walkOnlyNodes.includes(t)) {
      walkBody(node, true, ctx);
      return;
    }
    if (p.unwrapNodes.includes(t)) {
      const inner = node.childForFieldName('declaration')
        ?? node.namedChildren.find((c) => !isComment(c) && !p.skipNodes.includes(c.type));
      if (inner) {
        emitNode(inner, insideClass, ctx, leadLine, commentText, outer ?? node);
        return;
      }
    }
    if (p.scopeNodes.includes(t)) {
      walkBody(node, insideClass, ctx);
      return;
    }

    const lineStartNode = outer ?? node;

    if (p.classNodes.includes(t)) {
      const name = nameOfNode(node);
      const header = headerText(node);
      const base = classBaseOf(header);
      const unit = emit('class', withComment({ nodeType: t, name, base: base || undefined, signature: header }, commentText), lineStartNode, node, leadLine, ctx);
      unit.blockId = unit.id;
      walkBody(node, true, { l1: unit.id, block: unit.id });
      return;
    }

    if (p.functionNodes.includes(t) || p.methodNodes.includes(t)) {
      const name = nameOfNode(node);
      const header = headerText(node);
      const unit = emit('function', withComment({ nodeType: t, name, signature: header }, commentText), lineStartNode, node, leadLine, ctx);
      unit.blockId = unit.id;
      walkBody(node, false, { l1: unit.id, block: unit.id });
      return;
    }

    if (p.fieldNodes.includes(t)) {
      const name = nameOfNode(node);
      const typeNode = node.childForFieldName('type');
      emit('field', withComment({
        nodeType: t,
        name,
        value: typeNode ? oneLine(typeNode).replace(/^:\s*/, '') : '',
        signature: headerText(node),
      }, commentText), lineStartNode, node, leadLine, ctx);
      return;
    }

    if (p.variableNodes.includes(t)) {
      emitVariables(node, t, ctx, leadLine, commentText);
      return;
    }

    if (p.ifNodes.includes(t)) {
      const condition = conditionOf(node, t);
      const unit = emit('if', withComment({ nodeType: t, condition, signature: headerText(node) }, commentText), lineStartNode, node, leadLine, ctx);
      unit.blockId = unit.id;
      const inner: WalkCtx = { l1: ctx.l1, block: unit.id };
      walkBody(node, false, inner);
      const alt = node.childForFieldName('alternative')
        ?? node.namedChildren.find((c) => c.type === 'else_clause');
      if (alt) {
        const altCtx: WalkCtx = { l1: ctx.l1, block: `${unit.id}:alt` };
        const altBody = bodyNodeOf(alt);
        if (altBody) {
          walk(altBody.namedChildren, false, altCtx);
        } else {
          walk(alt.namedChildren, false, altCtx);
        }
      }
      return;
    }

    if (p.loopNodes.includes(t)) {
      const condition = conditionOf(node, t);
      const unit = emit('for', withComment({ nodeType: t, condition, signature: headerText(node) }, commentText), lineStartNode, node, leadLine, ctx);
      unit.blockId = unit.id;
      walkBody(node, false, { l1: ctx.l1, block: unit.id });
      return;
    }

    if (p.returnNodes.includes(t)) {
      const returns = oneLine(node).replace(/^return\b\s*/, '').replace(/;$/, '');
      emit('return', withComment({ nodeType: t, returns, signature: oneLine(node) }, commentText), lineStartNode, node, leadLine, ctx);
      return;
    }

    if (p.importNodes.includes(t) || p.importFromNodes.includes(t)) {
      const kind: UnitKind = p.importNodes.includes(t) ? 'import' : 'import_from';
      const name = importNameOf(node, t);
      emit(kind, withComment({ nodeType: t, name, base: name, signature: oneLine(node) }, commentText), lineStartNode, node, leadLine, ctx);
      return;
    }

    if (p.exprNodes.includes(t)) {
      const inner = node.namedChildren[0];
      if (inner && (p.callNodes.includes(inner.type) || inner.type === 'macro_invocation')) {
        emit('call', withComment({
          nodeType: t,
          name: callNameOf(inner),
          callExpr: oneLine(node),
          signature: oneLine(node),
        }, commentText), node, node, leadLine, ctx);
        return;
      }
      if (inner && p.assignmentNodes.includes(inner.type)) {
        emitAssignment(inner, node, ctx, leadLine, commentText);
        return;
      }
      emit('statement', withComment({ nodeType: t, signature: oneLine(node) }, commentText), node, node, leadLine, ctx);
      return;
    }

    if (p.callNodes.includes(t)) {
      emit('call', withComment({
        nodeType: t,
        name: callNameOf(node),
        callExpr: oneLine(node),
        signature: oneLine(node),
      }, commentText), node, node, leadLine, ctx);
      return;
    }

    emit('statement', withComment({ nodeType: t, signature: oneLine(node) }, commentText), node, node, leadLine, ctx);
  };

  const emitAssignment = (assign: SN, stmtNode: SN, ctx: WalkCtx, leadLine?: number, commentText?: string): void => {
    const left = assign.childForFieldName('left') ?? assign.childForFieldName('pattern');
    const right = assign.childForFieldName('right') ?? assign.childForFieldName('value');
    emit('assignment', withComment({
      nodeType: assign.type,
      target: left ? oneLine(left) : '',
      value: right ? oneLine(right) : '',
      signature: oneLine(stmtNode),
    }, commentText), stmtNode, stmtNode, leadLine, ctx);
  };

  const emitVariables = (node: SN, t: string, ctx: WalkCtx, leadLine?: number, commentText?: string): void => {
    // 变量声明保留整行（含初始化表达式），不要被首个 '{' 截断
    const signature = oneLine(node).replace(/;$/, '');
    if (t === 'lexical_declaration' || t === 'variable_declaration') {
      const declarators = node.namedChildren.filter((c) => c.type === 'variable_declarator');
      if (declarators.length === 0) {
        emit('statement', withComment({ nodeType: t, signature }, commentText), node, node, leadLine, ctx);
        return;
      }
      for (const d of declarators) {
        const value = d.childForFieldName('value');
        emit('assignment', withComment({
          nodeType: t,
          target: oneLine(d.childForFieldName('name')),
          value: value ? oneLine(value) : '',
          signature,
        }, commentText), node, node, leadLine, ctx);
      }
      return;
    }
    if (t === 'let_declaration') {
      const value = node.childForFieldName('value');
      emit('assignment', withComment({
        nodeType: t,
        target: oneLine(node.childForFieldName('pattern')).replace(/^mut\s+/, ''),
        value: value ? oneLine(value) : '',
        signature,
      }, commentText), node, node, leadLine, ctx);
      return;
    }
    if (t === 'short_var_declaration') {
      emit('assignment', withComment({
        nodeType: t,
        target: oneLine(node.childForFieldName('left')),
        value: oneLine(node.childForFieldName('right')),
        signature,
      }, commentText), node, node, leadLine, ctx);
      return;
    }
    if (t === 'var_declaration' || t === 'const_declaration') {
      const spec = node.namedChildren.find((c) => c.type === 'var_spec' || c.type === 'const_spec');
      if (spec) {
        const name = spec.namedChildren.find((c) => c.type === 'identifier');
        const typeNode = spec.childForFieldName('type');
        const value = spec.childForFieldName('value');
        emit('assignment', withComment({
          nodeType: t,
          target: name ? oneLine(name) : nameOfNode(spec),
          value: value ? oneLine(value) : '',
          signature: headerText(spec) || signature,
        }, commentText), node, node, leadLine, ctx);
        return;
      }
    }
    // C / Java 等：'类型 名称 = 值' 文本解析
    const parsed = parseDeclarationText(signature);
    emit('assignment', withComment({
      nodeType: t,
      target: parsed.target,
      value: parsed.value,
      signature,
    }, commentText), node, node, leadLine, ctx);
  };

  for (const child of root.namedChildren.slice(start)) {
    if (!isComment(child)) {
      emitNode(child, false, MODULE);
    }
  }

  return units;
}

function parseDeclarationText(text: string): { target: string; value: string } {
  const flat = text.replace(/\s+/g, ' ').replace(/;$/, '').trim();
  const eq = flat.indexOf('=');
  const left = eq >= 0 ? flat.slice(0, eq) : flat;
  const value = eq >= 0 ? flat.slice(eq + 1).trim() : '';
  const ids = left.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const target = ids.length > 0 ? ids[ids.length - 1] : left.trim();
  return { target, value };
}

function conditionOf(node: SN, type: string): string {
  const c = node.childForFieldName('condition');
  if (c) {
    const text = oneLine(c);
    return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1) : text;
  }
  let head = headerText(node);
  head = head.replace(/^(?:else\s+)?(if|while|for|switch|match|select)\b/, '').trim();
  if (head.startsWith('(') && head.endsWith(')')) {
    head = head.slice(1, -1);
  }
  if (head === 'for' || head === 'while') {
    return '';
  }
  if (type === 'switch_statement' || type === 'expression_switch_statement' || type === 'match_expression') {
    return head || 'value';
  }
  return head;
}

function callNameOf(call: SN): string {
  const object = call.childForFieldName('object');
  const name = call.childForFieldName('name');
  if (name) {
    return `${object ? `${oneLine(object)}.` : ''}${oneLine(name)}`;
  }
  for (const f of ['function', 'macro', 'constructor', 'method']) {
    const target = call.childForFieldName(f);
    if (target) {
      return oneLine(target);
    }
  }
  const head = headerText(call);
  const paren = head.indexOf('(');
  return (paren > 0 ? head.slice(0, paren) : head).trim();
}

function importNameOf(node: SN, type: string): string {
  const source = node.childForFieldName('source') ?? node.childForFieldName('path');
  if (source) {
    return source.text.replace(/^[<"']+|[>"']+$/g, '');
  }
  const text = node.text.replace(/\s+/g, ' ').trim();
  if (type === 'preproc_include') {
    const m = /#include\s*[<"]([^>"]+)[>"]/.exec(text);
    return m ? m[1] : text;
  }
  if (type === 'import_declaration') {
    const quoted = node.text.match(/"([^"]+)"/g);
    if (quoted && quoted.length > 0) {
      return quoted.map((q) => q.slice(1, -1)).join(', ');
    }
    const m = /import\s+(?:static\s+)?([\w.*]+)/.exec(text);
    return m ? m[1] : text.replace(/^import\s+/, '').replace(/;$/, '');
  }
  if (type === 'use_declaration' || type === 'extern_crate_declaration') {
    return text.replace(/^(?:pub\s+)?(?:use|extern\s+crate)\s+/, '').replace(/;$/, '');
  }
  if (type === 'import_statement') {
    const m = /from\s+['"]([^'"]+)['"]/.exec(text);
    return m ? m[1] : text;
  }
  return text;
}
