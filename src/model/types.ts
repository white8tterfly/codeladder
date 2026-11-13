// 核心数据模型：语义单元（确定性逻辑模型）与四档投影

export type TierId = 'L1' | 'L2' | 'L3' | 'L4';
// ok = 确定性（AST 直接推导）
// inferred = 语义推断（模板/注释归纳，未调用模型）
// ai = 模型归纳（LLM 改写过的内容）
export type Fidelity = 'ok' | 'inferred' | 'ai';

/** 1-based 行号区间，含两端 */
export interface LineRange {
  start: number;
  end: number;
}

/** 语义单元种类（由 AST 确定性推导） */
export type UnitKind =
  | 'docstring'      // 模块文件说明
  | 'import'         // import 语句
  | 'import_from'    // from ... import ...
  | 'class'          // 类声明
  | 'field'          // 带类型标注的字段（TypedDict 等）
  | 'function'       // 函数声明
  | 'assignment'     // 变量赋值
  | 'if'             // 条件分支头部
  | 'for'            // 循环头部
  | 'return'         // 返回语句
  | 'call'           // 函数/方法调用语句
  | 'block'          // 复合语句头部（try / with / while / match）
  | 'comment'        // 独立注释块
  | 'statement';     // 其它语句

/** 从 AST 确定性提取的事实，供四档投影白话化使用 */
export interface UnitFacts {
  nodeType: string;      // tree-sitter 原始节点类型
  kind: UnitKind;
  name?: string;         // 标识符名（函数/类/字段/变量名）
  signature?: string;    // L3 用的结构签名
  condition?: string;    // if / for 条件
  target?: string;       // 赋值目标
  value?: string;        // 赋值/返回值
  returns?: string;      // return 表达式
  callExpr?: string;     // 调用表达式
  base?: string;         // 类基类 / import 源
  comment?: string;      // 相邻注释（去 # 后）
}

/** 一个语义单元：同源的四档投影共享同一份行号与结构 */
export interface SemanticUnit {
  id: string;
  lines: LineRange[];
  facts: UnitFacts;
  /** 所属函数/类单元的 id；模块级代码为空 */
  containerId?: string;
  /** 所属代码块单元（函数体 / 分支 / 循环 / 类体）的 id；模块级为 'module' */
  blockId?: string;
}

/**
 * 解释分组：L1/L2 不再逐行，而是按语义单位聚合。
 * L1 = 一个函数 / 接口 / 类；L2 = 一个代码块（函数体、分支、循环、模块级）。
 */
export interface ExplainGroup {
  id: string;
  title: string;
  lines: LineRange[];
  unitIndexes: number[];
}

export interface ExplainGroups {
  l1: ExplainGroup[];
  l2: ExplainGroup[];
  /** 单元下标 → 所属分组下标（-1 表示不参与） */
  unitL1: number[];
  unitL2: number[];
}

/** 某档位中的一个解释块 */
export interface ProjectionBlock {
  unitId: string;
  title: string;
  lines: LineRange[];
  fidelity: Fidelity;
  kind: UnitKind;
  html: string; // L1-L3 为白话文本；L4 为代码片段
}

/** 四档投影结果 */
export interface Projection {
  tiers: Record<TierId, ProjectionBlock[]>;
  units: SemanticUnit[];
}

/**
 * 语义层（业务背景 / L1 意图 / L2 步骤）的生成状态。
 * 这些内容只能由模型产出：没有模型就不展示，不再用确定性模板冒充业务理解。
 */
export type SemanticState = 'loading' | 'ready' | 'no-model' | 'failed';

/** 面板顶部的业务背景摘要（只来自 LLM 归纳） */
export interface ContextSummary {
  summary: string;        // 一句话业务定位（纯自然语言，不出现技术栈）
  bullets: string[];      // 业务层面的关键角色
  sources: string[];      // 依据的工程文件
  fidelity: Fidelity;     // ai = LLM 归纳
  state: SemanticState;   // 语义层当前是否可用
  error?: string;         // state = failed 时的失败详情
  /** 技术背景：单独一页展示，包含语言、路径、符号、依赖与引用关系 */
  tech?: {
    bullets: string[];
    sources: string[];
  };
}
