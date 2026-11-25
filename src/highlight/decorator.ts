// 编辑器高亮装饰：解释块 ↔ 代码行的双向联动。
// - hl：整段高亮（悬停解释块时的覆盖行）；
// - pin：强高亮（点击解释块 / 行号徽章跳转后的定位行）。
// 颜色跟随当前主题：深色主题用低透明度暖黄，避免整行亮黄刺眼；
// 也可以在 codeLadder.highlight.* 中自定义。

import * as vscode from 'vscode';
import type { LineRange } from '../model/types';

const SECTION = 'codeLadder.highlight';

interface Palette {
  hover: string;
  pin: string;
  pinBorder: string;
}

/** 深色主题：低透明度暖黄 + 青色左边线，既有存在感又不晃眼 */
const DARK_PALETTE: Palette = {
  hover: 'rgba(250, 204, 21, 0.12)',
  pin: 'rgba(250, 204, 21, 0.26)',
  pinBorder: 'rgba(45, 212, 191, 0.75)',
};

/** 浅色主题：保持原来的浅黄 / 亮黄 */
const LIGHT_PALETTE: Palette = {
  hover: '#fef9c3',
  pin: '#fde047',
  pinBorder: '#0d9488',
};

export class HighlightManager {
  private hlType!: vscode.TextEditorDecorationType;
  private pinType!: vscode.TextEditorDecorationType;
  /** 最近一次高亮所在的编辑器与区间：主题 / 颜色变化后据此恢复 */
  private lastEditor: vscode.TextEditor | undefined;
  private lastHover: LineRange[] = [];
  private lastPin: LineRange[] = [];

  constructor() {
    this.applyPalette();
  }

  /** 主题或高亮颜色设置变化：重建装饰类型并恢复当前高亮 */
  refresh(): void {
    this.disposeTypes();
    this.applyPalette();
    // 重建类型会丢掉已有装饰，按上一次的状态补回来；按 URI 找编辑器，避免对象已失效
    const uri = this.lastEditor?.document.uri.toString();
    const editor = uri ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri) : undefined;
    if (!editor) {
      return;
    }
    if (this.lastPin.length > 0) {
      editor.setDecorations(this.pinType, this.toDecorationRanges(editor, this.lastPin));
    }
    if (this.lastHover.length > 0) {
      editor.setDecorations(this.hlType, this.toDecorationRanges(editor, this.lastHover));
    }
  }

  /** 悬停高亮若干行区间（只动悬停层，不影响点击后的 pin 高亮） */
  highlight(editor: vscode.TextEditor, ranges: LineRange[]): void {
    this.lastEditor = editor;
    this.lastHover = ranges;
    this.lastPin = [];
    editor.setDecorations(this.hlType, this.toDecorationRanges(editor, ranges));
  }

  /** 悬停移出：只清悬停高亮，保留点击后 pin 的强高亮 */
  clearHover(editor: vscode.TextEditor): void {
    this.lastHover = [];
    editor.setDecorations(this.hlType, []);
  }

  /** 点击解释块：把整块覆盖的所有行都强高亮（跨行块不再只亮第一行） */
  pin(editor: vscode.TextEditor, ranges: LineRange[]): void {
    this.lastEditor = editor;
    this.lastHover = [];
    this.lastPin = ranges;
    editor.setDecorations(this.hlType, []);
    editor.setDecorations(this.pinType, this.toDecorationRanges(editor, ranges));
  }

  /** 清空全部高亮 */
  clear(editor: vscode.TextEditor): void {
    this.lastEditor = editor;
    this.lastHover = [];
    this.lastPin = [];
    editor.setDecorations(this.hlType, []);
    editor.setDecorations(this.pinType, []);
  }

  dispose(): void {
    this.disposeTypes();
  }

  private applyPalette(): void {
    const palette = resolvePalette();
    this.hlType = vscode.window.createTextEditorDecorationType({
      backgroundColor: palette.hover,
      isWholeLine: true,
    });
    this.pinType = vscode.window.createTextEditorDecorationType({
      backgroundColor: palette.pin,
      border: `0 0 0 3px solid ${palette.pinBorder}`,
      isWholeLine: true,
    });
  }

  private disposeTypes(): void {
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

/** 设置留空时跟随主题；自定义颜色只覆盖对应层，未覆盖的层仍用主题色 */
function resolvePalette(): Palette {
  const conf = vscode.workspace.getConfiguration(SECTION);
  const hover = readColor(conf, 'color');
  const pin = readColor(conf, 'pinColor');
  const base = isDarkTheme() ? DARK_PALETTE : LIGHT_PALETTE;
  return {
    hover: hover || base.hover,
    pin: pin || base.pin,
    pinBorder: pin || base.pinBorder,
  };
}

/** 只接受常见 CSS 颜色写法，避免手滑输入非法值后高亮整体失效 */
function readColor(conf: vscode.WorkspaceConfiguration, key: string): string {
  const raw = (conf.get<string>(key) ?? '').trim();
  if (!raw) {
    return '';
  }
  return /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([^)]*\)|[a-z]+)$/i.test(raw) ? raw : '';
}

function isDarkTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}
