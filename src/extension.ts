// 插件入口：把源码解析为语义单元，投影为四档白话解释，驱动双向高亮联动。
// 支持 Python / TypeScript / C / C++ / Java / Rust / Go。

import * as vscode from 'vscode';
import { ensureParser, parseSource } from './parser/tree';
import { deriveSemanticUnits } from './parser/semantic';
import { fromVscodeLanguageId } from './lang/languages';
import { applyLlmResult, buildProjection, unitsCoveringLine } from './projector/projector';
import type { SemanticUnit } from './model/types';
import { HighlightManager } from './highlight/decorator';
import { ExplainPanel } from './ui/panel';
import { ProjectIndex } from './index/projectIndex';
import { buildFileContext } from './context/contextBuilder';
import { enrichWithLlm, hasLlmSource } from './llm/client';
import { getLang, uiText } from './i18n';

let panel: ExplainPanel | undefined;
let highlight: HighlightManager | undefined;
let currentUnits: SemanticUnit[] = [];
let currentDocUri: vscode.Uri | undefined;
let explainToken = 0;
const projectIndex = new ProjectIndex();

export function activate(context: vscode.ExtensionContext): void {
  panel = new ExplainPanel(context.extensionUri);
  highlight = new HighlightManager();

  // 注意：focus 落在 Webview 面板上时，window.activeTextEditor 会变成 undefined，
  // 因此不能依赖 activeTextEditor，必须按被解释文件的 URI 去找对应编辑器。
  panel.setMessageHandler(async (msg) => {
    if (!highlight) {
      return;
    }
    switch (msg.type) {
      case 'focus': {
        const editor = visibleTargetEditor();
        if (editor) {
          highlight.highlight(editor, msg.ranges ?? []);
        }
        break;
      }
      case 'unfocus': {
        const editor = visibleTargetEditor();
        if (editor) {
          highlight.clear(editor);
        }
        break;
      }
      case 'jump': {
        const editor = await revealTargetEditor();
        if (!editor) {
          return;
        }
        const line = Math.max(1, Math.min(msg.line ?? 1, editor.document.lineCount));
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        highlight.pin(editor, msg.ranges ?? []);
        break;
      }
      default:
        break;
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReadable.explain', () => runExplain()),
    vscode.commands.registerCommand('codeReadable.refresh', () => runExplain()),
    vscode.commands.registerCommand('codeReadable.rebuildIndex', async () => {
      const ui = uiText(getLang());
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: ui.progressRebuild },
        () => projectIndex.rebuild(),
      );
      vscode.window.showInformationMessage(ui.msgIndexed(projectIndex.size));
    }),
    // 语言切换：面板已打开时立即用新语言重新生成
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('codeLadder.language')) {
        return;
      }
      panel?.setUi(uiText(getLang()));
      if (!panel?.visible) {
        return;
      }
      const editor = visibleTargetEditor();
      if (editor) {
        void runExplain(editor);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (fromVscodeLanguageId(doc.languageId)) {
        void projectIndex.update(doc.uri);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.uri.toString() === currentDocUri?.toString() && panel?.visible) {
        const line = e.selections[0]?.active.line ?? -1;
        panel.focusBlocks(unitsCoveringLine(currentUnits, line + 1));
      }
    }),
  );
}

export function deactivate(): void {
  highlight?.dispose();
}

/** 按 URI 找当前被解释文件的可见编辑器（不打开新编辑器） */
function visibleTargetEditor(): vscode.TextEditor | undefined {
  const target = currentDocUri?.toString();
  if (!target) {
    return undefined;
  }
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.toString() === target) {
    return active;
  }
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target);
}

/** 跳转用：可见则直接返回；文件已被关闭时重新打开 */
async function revealTargetEditor(): Promise<vscode.TextEditor | undefined> {
  const visible = visibleTargetEditor();
  if (visible) {
    return visible;
  }
  if (!currentDocUri) {
    return undefined;
  }
  const doc = await vscode.workspace.openTextDocument(currentDocUri);
  return vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
}

async function runExplain(target?: vscode.TextEditor): Promise<void> {
  const lang = getLang();
  const ui = uiText(lang);
  const editor = target ?? vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(ui.msgNoEditor);
    return;
  }
  const languageId = fromVscodeLanguageId(editor.document.languageId);
  if (!languageId) {
    vscode.window.showWarningMessage(ui.msgUnsupported);
    return;
  }

  try {
    await ensureParser(languageId);
    const parsed = parseSource(languageId, editor.document.getText());
    try {
      currentUnits = deriveSemanticUnits(parsed.root, languageId);
    } finally {
      parsed.tree.delete();
    }
    currentDocUri = editor.document.uri;
    const token = ++explainToken;

    if (currentUnits.length === 0) {
      vscode.window.showInformationMessage(ui.msgNoUnits);
      return;
    }

    // 先通读工程、建立上下文，再生成解释
    await ensureProjectIndex(ui.progressIndexing);
    const ctx = buildFileContext(projectIndex, editor.document, parsed.source, lang);
    const payload = buildProjection(currentUnits, parsed.source, { lang, hints: ctx.hints });
    payload.context = ctx.summary;
    panel?.render(payload, ui);

    // 初始聚焦当前光标所在行对应的语义单元
    const line = editor.selection.active.line + 1;
    panel?.focusBlocks(unitsCoveringLine(currentUnits, line));

    // 有归纳来源（IDE 内置模型或自配端点）时，再用工程上下文做一次语义归纳；失败则保留确定性结果
    if (await hasLlmSource()) {
      const status = vscode.window.setStatusBarMessage(ui.statusLlm);
      try {
        const result = await enrichWithLlm(parsed.source, currentUnits, ctx, lang);
        if (!result || token !== explainToken) {
          return;
        }
        applyLlmResult(payload, result);
        payload.context = {
          ...ctx.summary,
          summary: result.summary ?? ctx.summary.summary,
          bullets: result.bullets && result.bullets.length > 0 ? result.bullets : ctx.summary.bullets,
          fidelity: 'ai',
        };
        panel?.render(payload, ui);
        panel?.focusBlocks(unitsCoveringLine(currentUnits, line));
      } finally {
        status.dispose();
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(`${ui.errPrefix}${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 首次运行时建立工程索引；已建立则直接复用 */
async function ensureProjectIndex(title: string): Promise<void> {
  if (projectIndex.size > 0) {
    await projectIndex.ensure();
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () => projectIndex.ensure(),
  );
}
