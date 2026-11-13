// AST → 语义单元：按语言分发到对应的确定性提取器。

import type Parser from 'web-tree-sitter';
import type { SemanticUnit } from '../model/types';
import type { LanguageId } from '../lang/languages';
import { derivePythonUnits } from './pythonUnits';
import { deriveGenericUnits } from './genericUnits';

export function deriveSemanticUnits(root: Parser.SyntaxNode, language: LanguageId): SemanticUnit[] {
  return language === 'python' ? derivePythonUnits(root) : deriveGenericUnits(root, language);
}
