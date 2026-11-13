// 编辑器高亮装饰：解释块 ↔ 代码行的双向联动。
// - hl：整段高亮（黄色），对应解释块的覆盖行；
// - pin：单行强高亮，对应点击行号徽章跳转定位的那一行。

import * as vscode from 'vscode';
import type { LineRange } from '../model/types';

export class HighlightManager {
  private hlType: vscode.TextEditorDecorationType;
  private pinType: vscode.TextEditorDecorationType;

  constructor() {
    this.hlType = vscode.window.createTextEditorDecorationType({
      backgroundColor: '#fef9c3',
      isWholeLine: true,
    });
    this.pinType = vscode.window.createTextEditorDecorationType({
      backgroundColor: '#fde047',
      border: '0 0 0 3px solid #0d9488',
      isWholeLine: true,
    });
  }

  /** 高亮若干行区间 */
  highlight(editor: vscode.TextEditor, ranges: LineRange[]): void {
    editor.setDecorations(this.hlType, this.toDecorationRanges(editor, ranges));
  }

  /** 点击解释块：把整块覆盖的所有行都强高亮（跨行块不再只亮第一行） */
  pin(editor: vscode.TextEditor, ranges: LineRange[]): void {
    editor.setDecorations(this.hlType, []);
    editor.setDecorations(this.pinType, this.toDecorationRanges(editor, ranges));
  }

  /** 清空全部高亮 */
  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.hlType, []);
    editor.setDecorations(this.pinType, []);
  }

  dispose(): void {
    this.hlType.dispose();
    this.pinType.dispose();
  }

  private toDecorationRanges(editor: vscode.TextEditor, ranges: LineRange[]): vscode.Range[] {
    const out: vscode.Range[] = [];
    const doc = editor.document;
    for (const r of ranges) {
      const start = Math.max(1, r.start);
      const end = Math.min(doc.lineCount, r.end);
      if (start > end || end < 1 || start > doc.lineCount) {
        continue;
      }
      out.push(new vscode.Range(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length));
    }
    return out;
  }
}
