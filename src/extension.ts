// 插件入口：把源码解析为语义单元，投影为四档白话解释，驱动双向高亮联动。
// 支持 Python / TypeScript / C / C++ / Java / Rust / Go。

import * as vscode from 'vscode';
import { ensureParser, parseSource } from './parser/tree';
import { deriveSemanticUnits } from './parser/semantic';
import { fromVscodeLanguageId } from './lang/languages';
import { applyLlmResult, buildProjection, unitsCoveringLine } from './projector/projector';
import type { ProjectionPayload } from './projector/projector';
import type { SemanticUnit } from './model/types';
import { HighlightManager } from './highlight/decorator';
import { ExplainPanel } from './ui/panel';
import { ProjectIndex } from './index/projectIndex';
import { buildFileContext } from './context/contextBuilder';
import { enrichWithLlm } from './llm/client';
import type { LlmOutcome, TokenUsage } from './llm/client';
import { AnalysisCache, groupTextKey, hashText, planAnalysis } from './llm/analysisCache';
import { buildExplainGroups } from './parser/groups';
import { getLang, uiText } from './i18n';
import type { Lang } from './i18n';

let panel: ExplainPanel | undefined;
let highlight: HighlightManager | undefined;
let currentUnits: SemanticUnit[] = [];
let currentDocUri: vscode.Uri | undefined;
let explainToken = 0;
/** 当前文件的累计 token 用量：自动重新解析只补变化分组，用量应叠加而不是归零 */
let sessionUsage: TokenUsage | null = null;
let sessionUsageDoc: string | undefined;
const projectIndex = new ProjectIndex();
/** 语义层结果缓存：未改动的单元不重复送给模型 */
const analysisCache = new AnalysisCache();
/** 缓存写入 workspaceState：重载窗口或升级扩展后仍然命中，不必整份重新解析 */
const ANALYSIS_CACHE_KEY = 'codeLadder.analysisCache';
let saveAnalysisCache = (): void => {};

/** 最近一次成功展示的面板内容：重载窗口后原样还原，不触发任何模型调用 */
const LAST_VIEW_KEY = 'codeLadder.lastView';

interface StoredView {
  uri: string;
  lang: Lang;
  /** 分析时的文件内容指纹；文件改过就不还原旧内容 */
  hash: string;
  line: number;
  payload: ProjectionPayload;
  usage: TokenUsage | null;
}

let saveLastView = (_view: StoredView): void => {};
/** 保存后自动重新解析的防抖计时器（一次保存可能连续触发多次事件） */
const AUTO_REFRESH_DELAY_MS = 400;
let autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  panel = new ExplainPanel(context.extensionUri);
  highlight = new HighlightManager();

  analysisCache.load(context.workspaceState.get(ANALYSIS_CACHE_KEY), modelFingerprint());
  saveAnalysisCache = (): void => {
    void context.workspaceState.update(ANALYSIS_CACHE_KEY, analysisCache.serialize(modelFingerprint()));
  };
  saveLastView = (view): void => {
    void context.workspaceState.update(LAST_VIEW_KEY, view);
  };

  // 窗口重载后 VS Code 会恢复此前打开的面板；这里直接把上次的分析结果灌回去，
  // 既不重新解析也不调用模型（文件内容改过则放弃还原，交由用户重新触发）。
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(ExplainPanel.viewType, {
    deserializeWebviewPanel: async (webviewPanel) => {
      const stored = context.workspaceState.get<StoredView>(LAST_VIEW_KEY);
      const currentPanel = panel;
      if (!stored || !currentPanel) {
        webviewPanel.dispose();
        return;
      }
      let doc: vscode.TextDocument | undefined;
      try {
        doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === stored.uri)
          ?? await vscode.workspace.openTextDocument(vscode.Uri.parse(stored.uri));
      } catch {
        doc = undefined;
      }
      if (!doc || hashText(doc.getText()) !== stored.hash) {
        webviewPanel.dispose();
        return;
      }
      currentDocUri = doc.uri;
      sessionUsage = stored.usage;
      sessionUsageDoc = stored.uri;
      currentPanel.adopt(webviewPanel);
      currentPanel.render(stored.payload, uiText(stored.lang));
      currentPanel.setUsage(stored.usage);
      // 重建行号到语义单元的映射，让光标联动继续可用；纯本地计算，不碰模型
      const languageId = fromVscodeLanguageId(doc.languageId);
      if (!languageId) {
        return;
      }
      try {
        await ensureParser(languageId);
        const parsed = parseSource(languageId, doc.getText());
        try {
          currentUnits = deriveSemanticUnits(parsed.root, languageId);
        } finally {
          parsed.tree.delete();
        }
        currentPanel.focusBlocks(unitsCoveringLine(currentUnits, stored.line));
      } catch {
        // 还原失败只影响光标联动，面板内容不受影响
      }
    },
  }));

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
          // 只清悬停高亮：跳转后面板会自动滚动，鼠标穿过其他块时不能把点击产生的 pin 高亮一起清掉
          highlight.clearHover(editor);
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
      case 'openSettings': {
        await openLlmSettings();
        break;
      }
      case 'retry': {
        await runExplain(visibleTargetEditor());
        break;
      }
      case 'reparse': {
        panel?.setBusy(true);
        try {
          await runExplain(visibleTargetEditor(), true);
        } finally {
          panel?.setBusy(false);
        }
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
    // 模型配置变化时清空语义层缓存，避免把旧模型结果当成新模型输出
    // 语言切换：面板已打开时立即用新语言重新生成
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeLadder.llm')) {
        analysisCache.clear();
        saveAnalysisCache();
      }
      if (e.affectsConfiguration('codeLadder.highlight')) {
        highlight?.refresh();
      }
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
    // 主题切换（浅色 ↔ 深色）后换成对应主题的高亮颜色
    vscode.window.onDidChangeActiveColorTheme(() => highlight?.refresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (fromVscodeLanguageId(doc.languageId)) {
        void projectIndex.update(doc.uri);
        scheduleAutoRefresh(doc);
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
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }
  highlight?.dispose();
}

/** 叠加两次用量；没有增量时保留原值，避免把已有数字刷成 0 */
function addUsage(base: TokenUsage | null, delta: TokenUsage | null | undefined): TokenUsage | null {
  if (!delta) {
    return base;
  }
  if (!base) {
    return { ...delta };
  }
  return {
    prompt: base.prompt + delta.prompt,
    completion: base.completion + delta.completion,
    total: base.total + delta.total,
    estimated: Boolean(base.estimated || delta.estimated),
  };
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

/** 手动「重新解析」时 force=true：跳过缓存，全部重新送给模型 */
async function runExplain(target?: vscode.TextEditor, force = false): Promise<void> {
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
    // 换文件才重置累计用量；同一文件的自动重新解析要叠加
    const docKey = editor.document.uri.toString();
    if (sessionUsageDoc !== docKey) {
      sessionUsage = null;
      sessionUsageDoc = docKey;
    }
    // 重新生成解释时清掉上一轮留下的 pin 高亮，避免旧行号继续高亮
    highlight?.clear(editor);
    const token = ++explainToken;

    if (currentUnits.length === 0) {
      vscode.window.showInformationMessage(ui.msgNoUnits);
      return;
    }

    // 先通读工程、建立上下文，再生成解释
    await ensureProjectIndex(ui.progressIndexing);
    const ctx = buildFileContext(projectIndex, editor.document, parsed.source, lang);
    const groups = buildExplainGroups(currentUnits, lang);
    const payload = buildProjection(currentUnits, parsed.source, { lang, hints: ctx.hints, groups });
    // 技术背景是确定性事实，先上屏；业务背景与 L1/L2 等模型归纳
    payload.context = {
      summary: '',
      bullets: [],
      sources: ctx.tech.sources,
      fidelity: 'ok',
      state: 'loading',
      tech: ctx.tech,
    };
    panel?.render(payload, ui);
    panel?.setUsage(sessionUsage);

    // 初始聚焦当前光标所在行对应的语义单元
    const line = editor.selection.active.line + 1;
    panel?.focusBlocks(unitsCoveringLine(currentUnits, line));

    // ---- 语义层（业务背景 / L1 / L2）：先查缓存，只对变化的分组调用模型 ----
    const sourceLines = parsed.source.split('\n');
    const l1Keys = groups.l1.map((g) => groupTextKey(sourceLines, g));
    const l2Keys = groups.l2.map((g) => groupTextKey(sourceLines, g));
    const cacheKey = `${editor.document.uri.toString()}|${lang}`;
    const cached = force ? undefined : analysisCache.get(cacheKey);
    const { reusedL1, reusedL2, targetsL1, targetsL2, summaryKey, needSummary } = planAnalysis(cached, l1Keys, l2Keys, ctx, currentUnits);
    const totalGroups = groups.l1.length + groups.l2.length;
    const changedGroups = targetsL1.length + targetsL2.length;

    // 文件内容与摘要指纹都没变：直接复用，不产生任何模型调用
    if (cached && changedGroups === 0 && !needSummary) {
      const l1: Record<number, string> = {};
      const l2: Record<number, string> = {};
      l1Keys.forEach((key, i) => {
        const text = reusedL1.get(key);
        if (text) {
          l1[i] = text;
        }
      });
      l2Keys.forEach((key, i) => {
        const text = reusedL2.get(key);
        if (text) {
          l2[i] = text;
        }
      });
      applyLlmResult(payload, { l1, l2 });
      payload.context = {
        summary: cached.summary,
        bullets: cached.bullets,
        sources: ctx.tech.sources,
        fidelity: 'ai',
        state: 'ready',
        tech: ctx.tech,
      };
      panel?.render(payload, ui);
      panel?.setUsage(sessionUsage);
      panel?.focusBlocks(unitsCoveringLine(currentUnits, line));
      saveLastView({ uri: docKey, lang, hash: hashText(parsed.source), line, payload, usage: sessionUsage });
      vscode.window.setStatusBarMessage(ui.statusLlmCached, 4000);
      return;
    }

    const statusText = changedGroups > 0 && changedGroups < totalGroups
      ? ui.statusLlmIncremental(changedGroups, totalGroups)
      : ui.statusLlm;
    const status = vscode.window.setStatusBarMessage(statusText);
    let outcome: LlmOutcome;
    const baseUsage = sessionUsage;
    let runUsage: TokenUsage | null = null;
    try {
      outcome = await enrichWithLlm(parsed.source, groups, ctx, lang, {
        l1Targets: targetsL1,
        l2Targets: targetsL2,
        needSummary,
        // 每批返回后刷新面板上的 token 用量，分析过程中就能看到消耗
        onUsage: (usage) => {
          runUsage = usage;
          if (token === explainToken) {
            panel?.setUsage(addUsage(baseUsage, usage));
          }
        },
      });
    } finally {
      status.dispose();
    }
    if (token !== explainToken) {
      return;
    }
    if (!outcome.ok) {
      payload.context = {
        ...payload.context,
        state: outcome.reason === 'no-model' ? 'no-model' : 'failed',
        error: outcome.detail,
      };
      panel?.render(payload, ui);
      sessionUsage = addUsage(baseUsage, runUsage);
      panel?.setUsage(sessionUsage);
      panel?.focusBlocks(unitsCoveringLine(currentUnits, line));
      const text = outcome.reason === 'no-model' ? ui.msgNoModel : ui.msgLlmFailed(outcome.detail ?? '');
      const action = await vscode.window.showWarningMessage(text, ui.btnConfigure, ui.btnRetry);
      if (action === ui.btnConfigure) {
        await openLlmSettings();
      } else if (action === ui.btnRetry) {
        await runExplain(editor);
      }
      return;
    }

    // 合并本次结果与未变化分组的缓存，只有模型产出过的文本才会进入面板
    const mergedL1: Record<number, string> = {};
    const mergedL2: Record<number, string> = {};
    const cachedL1 = new Map<string, string>();
    const cachedL2 = new Map<string, string>();
    l1Keys.forEach((key, i) => {
      const text = outcome.l1[i] ?? reusedL1.get(key);
      if (text) {
        mergedL1[i] = text;
        cachedL1.set(key, text);
      }
    });
    l2Keys.forEach((key, i) => {
      const text = outcome.l2[i] ?? reusedL2.get(key);
      if (text) {
        mergedL2[i] = text;
        cachedL2.set(key, text);
      }
    });
    const summary = needSummary ? outcome.summary : (cached?.summary ?? outcome.summary);
    const bullets = needSummary ? outcome.bullets : (cached?.bullets ?? outcome.bullets);

    applyLlmResult(payload, { l1: mergedL1, l2: mergedL2 });
    analysisCache.set(cacheKey, { summary, bullets, summaryKey, l1: cachedL1, l2: cachedL2 });
    saveAnalysisCache();
    payload.context = {
      summary,
      bullets,
      sources: ctx.tech.sources,
      fidelity: 'ai',
      state: 'ready',
      tech: ctx.tech,
    };
    panel?.render(payload, ui);
    sessionUsage = addUsage(baseUsage, outcome.usage ?? runUsage);
    panel?.setUsage(sessionUsage);
    panel?.focusBlocks(unitsCoveringLine(currentUnits, line));
    saveLastView({ uri: docKey, lang, hash: hashText(parsed.source), line, payload, usage: sessionUsage });

    // 超出字符预算的分组没有送给模型；下次运行会自动只补这些分组
    const covered = Object.keys(outcome.l1).length + Object.keys(outcome.l2).length;
    if (changedGroups > 0 && covered < changedGroups) {
      vscode.window.setStatusBarMessage(ui.statusLlmPartial(covered, changedGroups), 8000);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`${ui.errPrefix}${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 保存后自动重新解析：默认关闭；开启后只处理面板当前展示的文件，
 * 配置了通配符时还必须命中其中之一。未配置通配符则对所有受支持文件生效。
 */
function scheduleAutoRefresh(doc: vscode.TextDocument): void {
  if (!panel?.visible || doc.uri.toString() !== currentDocUri?.toString()) {
    return;
  }
  if (!autoRefreshEnabled(doc)) {
    return;
  }
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
  }
  autoRefreshTimer = setTimeout(() => {
    autoRefreshTimer = undefined;
    if (!panel?.visible || doc.uri.toString() !== currentDocUri?.toString()) {
      return;
    }
    const editor = visibleTargetEditor();
    if (editor) {
      void runExplain(editor);
    }
  }, AUTO_REFRESH_DELAY_MS);
}

function autoRefreshEnabled(doc: vscode.TextDocument): boolean {
  const conf = vscode.workspace.getConfiguration('codeLadder.autoRefresh');
  if (!conf.get<boolean>('enabled')) {
    return false;
  }
  const globs = (conf.get<string[]>('globs') ?? [])
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  if (globs.length === 0) {
    return true;
  }
  return vscode.languages.match(globs.map((pattern) => ({ scheme: 'file', pattern })), doc) > 0;
}

/** 当前模型配置指纹：端点 / 模型变了，持久化缓存整体作废 */
function modelFingerprint(): string {
  const read = (key: string): string => {
    const value = vscode.workspace.getConfiguration('codeLadder.llm').get<string>(key);
    if (value && value.trim()) {
      return value.trim();
    }
    return (vscode.workspace.getConfiguration('codeReadable.llm').get<string>(key) ?? '').trim();
  };
  const baseUrl = read('baseUrl');
  return baseUrl ? `${baseUrl}#${read('model')}` : 'ide';
}

/** 打开 CodeLadder 的模型设置页 */
async function openLlmSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'codeLadder.llm');
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
