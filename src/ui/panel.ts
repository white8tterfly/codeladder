// 解释面板（Webview）：四档切换 + 保真度标识 + 行号徽章 + 双向联动。

import * as vscode from 'vscode';
import type { ProjectionPayload } from '../projector/projector';
import type { TokenUsage } from '../llm/client';
import { uiText } from '../i18n';
import type { UiText } from '../i18n';

export class ExplainPanel {
  public static readonly viewType = 'codeReadable.explain';

  private panel: vscode.WebviewPanel | undefined;
  private handler: ((msg: any) => void) | undefined;
  private ui: UiText = uiText('zh');
  /** Webview 脚本就绪前先排队，避免重载还原时首条 render 消息被丢弃 */
  private ready = false;
  private pending: unknown[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  public setMessageHandler(cb: (msg: any) => void): void {
    this.handler = cb;
  }

  /** 语言切换：已打开的面板热更新文案 */
  public setUi(ui: UiText): void {
    this.ui = ui;
    if (this.panel) {
      this.panel.title = ui.windowTitle;
      this.post({ type: 'ui', ui });
    }
  }

  public show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.attach(vscode.window.createWebviewPanel(
      ExplainPanel.viewType,
      this.ui.windowTitle,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    ));
  }

  /** 窗口重载后接管 VS Code 恢复出来的面板，内容由扩展重新灌入 */
  public adopt(webviewPanel: vscode.WebviewPanel): void {
    const prev = this.panel;
    this.panel = undefined;
    prev?.dispose();
    this.attach(webviewPanel);
  }

  private attach(webviewPanel: vscode.WebviewPanel): void {
    this.panel = webviewPanel;
    this.ready = false;
    this.pending = [];
    webviewPanel.title = this.ui.windowTitle;
    webviewPanel.webview.html = this.getHtml();
    webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'ready') {
        this.ready = true;
        const queued = this.pending;
        this.pending = [];
        queued.forEach((m) => void webviewPanel.webview.postMessage(m));
        return;
      }
      this.handler?.(msg);
    });
    webviewPanel.onDidDispose(() => {
      if (this.panel === webviewPanel) {
        this.panel = undefined;
        this.ready = false;
        this.pending = [];
      }
    }, null, []);
  }

  private post(msg: unknown): void {
    if (!this.panel) {
      return;
    }
    if (!this.ready) {
      this.pending.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  /** 渲染投影结果 */
  public render(payload: ProjectionPayload, ui?: UiText): void {
    if (ui) {
      this.setUi(ui);
    }
    this.show();
    this.post({ type: 'render', payload });
  }

  /** 高亮指定语义单元（代码行光标移动时） */
  public focusBlocks(indexes: number[]): void {
    this.post({ type: 'focusBlocks', indexes });
  }

  /** 更新本次分析的 token 用量；传 null 隐藏 */
  public setUsage(usage: TokenUsage | null): void {
    this.post({ type: 'usage', usage });
  }

  /** 手动重新解析进行中：按钮禁用并转圈 */
  public setBusy(on: boolean): void {
    this.post({ type: 'busy', on });
  }

  public get visible(): boolean {
    return this.panel !== undefined;
  }

  private getHtml(): string {
    const css = CSS;
    const js = JS.replace('__UI__', JSON.stringify(this.ui));
    return `<!DOCTYPE html>
<html lang="${this.ui.locale}" data-theme="light" data-tier="L1">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>CodeLadder</title>
<style>${css}</style>
</head>
<body>
<header>
  <div class="brand">
    <svg class="mark" viewBox="0 0 28 28" aria-hidden="true">
      <rect x=".75" y=".75" width="26.5" height="26.5" rx="8" fill="none" stroke="currentColor" stroke-opacity=".22"/>
      <path d="M9.5 5.5v17M18.5 5.5v17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-opacity=".45"/>
      <path d="M9.5 9h9M9.5 13.4h9M9.5 17.8h9M9.5 22.2h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>
    <div class="brand-text">
      <h1>CodeLadder</h1>
      <p class="sub" id="sub">${this.ui.sub}</p>
    </div>
  </div>
  <div class="legend">
    <span class="item"><span class="dot ok"></span><span id="legend-ok">${this.ui.legendOk}</span></span>
    <span class="item"><span class="dot ai"></span><span id="legend-ai">${this.ui.legendAi}</span></span>
  </div>
  <span class="usage" id="usage" style="display:none"></span>
  <button class="reparse" id="reparse" type="button" title="${this.ui.btnReparseTip}">
    <span class="reparse-icon" aria-hidden="true">↻</span><span class="reparse-label" id="reparse-label">${this.ui.btnReparse}</span>
  </button>
</header>
<section class="ctx" id="ctx" style="display:none"></section>
<div class="tierbar" id="tierbar" role="tablist"></div>
<div class="hint" id="hint">${this.ui.hint}</div>
<main>
  <div class="blocks" id="blocks"></div>
</main>
<script>${js}</script>
</body>
</html>`;
  }
}

const CSS = `
/* ---- 设计令牌：默认浅色，跟随 VS Code 主题切换 ---- */
:root{
  --bg:#f4f7fa;--surface:#ffffff;--surface-2:#f7fafc;--surface-3:#e9eff6;
  --line:#e3e9f1;--line-strong:#cbd6e2;
  --ink:#101b2b;--ink-2:#3a4c62;--ink-3:#55677c;
  --brand:#0f766e;--focus:#0d9488;
  --ok:#147a42;--ok-bg:#e6f6ec;--ai:#9a5a06;--ai-bg:#fdf3e2;
  --tok-key:#6d28d9;--tok-str:#a05a12;--tok-com:#69788b;
  --shadow-1:0 1px 2px rgba(16,38,58,.05);
  --shadow-2:0 10px 26px -14px rgba(16,38,58,.35);
  --tier:#0d9488;--tier-soft:#e8f7f4;--tier-ink:#0f6b63;--tier-line:#b9e6de;
  --mono:ui-monospace,'Cascadia Mono','Cascadia Code','SF Mono',Consolas,'Liberation Mono',monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Noto Sans SC','Hiragino Sans GB','Microsoft YaHei UI','Microsoft YaHei',sans-serif;
  --reading:'霞鹜文楷 屏幕阅读版','LXGW WenKai Screen','霞鹜文楷','LXGW WenKai',var(--sans);
}
:root[data-theme="dark"]{
  --bg:#0a111c;--surface:#0f1826;--surface-2:#131f30;--surface-3:#1b2a3d;
  --line:#1e2c3f;--line-strong:#2f4258;
  --ink:#edf3fa;--ink-2:#b6c4d6;--ink-3:#96a8bc;
  --brand:#5eead4;--focus:#5eead4;
  --ok:#5ed69a;--ok-bg:rgba(52,211,153,.14);--ai:#f0b95e;--ai-bg:rgba(245,158,11,.16);
  --tok-key:#c4b5fd;--tok-str:#fbbf24;--tok-com:#7d8ea4;
  --shadow-1:0 1px 2px rgba(0,0,0,.35);
  --shadow-2:0 16px 34px -20px rgba(0,0,0,.9);
  --tier:#2dd4bf;--tier-soft:rgba(45,212,191,.10);--tier-ink:#5eead4;--tier-line:rgba(45,212,191,.35);
}
:root[data-tier="L1"]{--tier:#14b8a6;--tier-soft:#e7f8f4;--tier-ink:#0f6f66;--tier-line:#b6e8df}
:root[data-tier="L2"]{--tier:#0d9488;--tier-soft:#ddf3ee;--tier-ink:#0c635c;--tier-line:#a0e1d7}
:root[data-tier="L3"]{--tier:#0f766e;--tier-soft:#d1eee8;--tier-ink:#0b564f;--tier-line:#89d7ca}
:root[data-tier="L4"]{--tier:#115e59;--tier-soft:#c5eae3;--tier-ink:#0a4641;--tier-line:#74ccbf}
:root[data-theme="dark"][data-tier="L1"]{--tier:#14b8a6;--tier-soft:rgba(20,184,166,.07);--tier-ink:#5eead4;--tier-line:rgba(94,234,212,.28)}
:root[data-theme="dark"][data-tier="L2"]{--tier:#2dd4bf;--tier-soft:rgba(45,212,191,.10);--tier-ink:#7de9d8;--tier-line:rgba(125,233,216,.3)}
:root[data-theme="dark"][data-tier="L3"]{--tier:#5eead4;--tier-soft:rgba(94,234,212,.13);--tier-ink:#99f6e4;--tier-line:rgba(153,246,228,.32)}
:root[data-theme="dark"][data-tier="L4"]{--tier:#99f6e4;--tier-soft:rgba(153,246,228,.16);--tier-ink:#ccfbf1;--tier-line:rgba(204,251,241,.35)}

*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;position:relative;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.7;letter-spacing:0;font-kerning:normal;-webkit-font-smoothing:antialiased}
/* 极淡的蓝图网格 + 顶部光晕，让面板有"技术图纸"的质感 */
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(900px 260px at 18% -140px,rgba(13,148,136,.10),transparent 70%),
    linear-gradient(var(--line) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,var(--line) 1px,transparent 1px) 0 0/44px 100%;
  opacity:.5;mask-image:linear-gradient(180deg,rgba(0,0,0,.55),transparent 320px)}
:root[data-theme="dark"] body::before{opacity:.35}

*:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:8px}

header{position:relative;z-index:1;flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:14px 20px 12px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,var(--surface),transparent)}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.mark{width:26px;height:26px;flex:0 0 auto;color:var(--brand)}
.brand-text{display:flex;flex-direction:column;min-width:0}
.brand h1{margin:0;font-size:15px;font-weight:700;letter-spacing:0;line-height:1.35}
.brand .sub{margin:2px 0 0;font-size:11.5px;line-height:1.45;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.legend{display:flex;gap:6px;margin-left:auto;align-items:center;flex:0 0 auto}
.legend .item{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ink-2);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:3px 9px 3px 7px}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.dot.ok{background:var(--ok);box-shadow:0 0 0 3px var(--ok-bg)}
.dot.ai{background:var(--ai);box-shadow:0 0 0 3px var(--ai-bg)}
.usage{display:inline-flex;align-items:center;flex:0 0 auto;white-space:nowrap;font:600 11px var(--mono);font-variant-numeric:tabular-nums;color:var(--tier-ink);background:var(--tier-soft);border:1px solid var(--tier-line);border-radius:999px;padding:3px 9px}
.reparse{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;white-space:nowrap;font:600 12px/1 var(--sans);color:var(--ink);background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;padding:5px 10px;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .15s ease}
.reparse:hover{background:var(--surface-2);transform:translateY(-1px)}
.reparse:active{transform:none}
.reparse:disabled{opacity:.55;cursor:progress;transform:none}
.reparse-icon{font-size:12px;line-height:1;display:inline-block}
.reparse.busy .reparse-icon{animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---- 业务背景卡 ---- */
.ctx{position:relative;z-index:1;flex:0 0 auto;margin:12px 20px 0;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-1);overflow:hidden}
.ctx::before{content:'';position:absolute;top:0;bottom:0;left:0;width:3px;background:linear-gradient(180deg,var(--tier),var(--tier-line))}
.ctx-head{display:flex;align-items:center;gap:8px;padding:11px 14px 10px 15px;cursor:pointer;user-select:none;transition:background .15s ease}
.ctx-head:hover{background:var(--surface-2)}
.ctx.collapsed .ctx-head{padding-bottom:11px}
.ctx-caret{width:13px;height:13px;flex:0 0 auto;color:var(--ink-3);transition:transform .18s ease}
.ctx.collapsed .ctx-caret{transform:rotate(-90deg)}
.ctx-title{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.ctx-body{padding:0 15px 13px 36px}
.ctx.collapsed .ctx-body{display:none}
.ctx-summary{margin:0 0 8px;font-family:var(--reading);font-size:15.5px;font-weight:400;letter-spacing:0;line-height:1.8;color:var(--ink);max-width:72ch}
.ctx-bullets{margin:0;padding-left:17px;font-family:var(--reading);font-size:14px;line-height:1.8;color:var(--ink-2)}
.ctx-bullets li{margin:4px 0}
.ctx-bullets li::marker{color:var(--tier)}
.ctx-sources{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:9px;font-size:11px;color:var(--ink-3)}
.ctx-src{font-family:var(--mono);background:var(--surface-2);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.ctx-tabs{display:flex;gap:4px;min-width:0}
.ctx-tab{font:600 11px/1 var(--mono);letter-spacing:.04em;padding:5px 9px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--ink-3);cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}
.ctx-tab:hover{background:var(--surface-2);color:var(--ink-2)}
.ctx-tab.active{background:var(--tier-soft);border-color:var(--tier);color:var(--ink)}
.ctx-head .fid{margin-left:auto}

/* ---- 四档阶梯 ---- */
.tierbar{position:relative;z-index:1;flex:0 0 auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;padding:12px 20px 0}
.tier-tab{position:relative;display:flex;flex-direction:column;gap:1px;padding:9px 11px 9px;font-family:inherit;color:var(--ink);text-align:left;cursor:pointer;background:var(--surface);border:1px solid var(--line);border-radius:11px;box-shadow:var(--shadow-1);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}
.tier-tab::after{content:'';position:absolute;left:11px;right:11px;top:-1px;height:2px;border-radius:2px;background:var(--tab);opacity:.18;transition:opacity .16s ease}
.tier-tab:hover{transform:translateY(-1px);border-color:var(--line-strong)}
.tier-tab.active{border-color:var(--tab);box-shadow:inset 0 0 0 1px var(--tab),var(--shadow-1)}
.tier-tab.active::after{opacity:1}
.tier-key{font:600 11px var(--mono);letter-spacing:.12em;color:var(--ink-3);transition:color .16s ease}
.tier-tab.active .tier-key{color:var(--tab)}
.tier-name{font-size:13.5px;font-weight:700;letter-spacing:0;line-height:1.4}
.tier-desc{font-size:11px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tier-meter{display:flex;gap:3px;margin-top:6px}
.tier-meter i{height:3px;flex:1;border-radius:2px;background:var(--surface-3)}
.tier-meter i.on{background:var(--tab);opacity:.85}
.tier-tab[data-tier="L1"]{--tab:#0d9488}
.tier-tab[data-tier="L2"]{--tab:#0f766e}
.tier-tab[data-tier="L3"]{--tab:#115e59}
.tier-tab[data-tier="L4"]{--tab:#134e4a}
:root[data-theme="dark"] .tier-tab[data-tier="L1"]{--tab:#5eead4}
:root[data-theme="dark"] .tier-tab[data-tier="L2"]{--tab:#7de9d8}
:root[data-theme="dark"] .tier-tab[data-tier="L3"]{--tab:#99f6e4}
:root[data-theme="dark"] .tier-tab[data-tier="L4"]{--tab:#ccfbf1}

.hint{position:relative;z-index:1;flex:0 0 auto;padding:9px 20px 11px;font-size:12px;line-height:1.6;color:var(--ink-3)}

main{position:relative;z-index:1;flex:1 1 auto;overflow:auto;min-height:0;scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}
.blocks{max-width:940px;margin:0 auto;padding:0 20px 30px;display:flex;flex-direction:column;gap:10px}

/* ---- 语义块 ---- */
.block{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr);gap:2px;padding:11px 14px 11px 4px;background:var(--surface);border:1px solid var(--line);border-radius:12px;cursor:pointer;box-shadow:var(--shadow-1);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;animation:rise .3s cubic-bezier(.22,.68,.32,1) both;animation-delay:calc(var(--i,0) * 16ms)}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.block::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:2px;border-radius:0 2px 2px 0;background:var(--tier);opacity:.45;transition:opacity .16s ease,width .16s ease}
.block:hover{transform:translateY(-1px);border-color:var(--line-strong);box-shadow:var(--shadow-2)}
.block:hover::before{opacity:.8}
.block.active{border-color:var(--tier);background:linear-gradient(100deg,var(--tier-soft),var(--surface) 62%);box-shadow:inset 0 0 0 1px var(--tier),var(--shadow-2)}
.block.active::before{opacity:1;width:3px}
.block-gutter{display:flex;justify-content:center;padding-top:2px}
.block-index{font:600 11px var(--mono);letter-spacing:.04em;color:var(--ink-3);font-variant-numeric:tabular-nums}
.block-main{min-width:0}
.block-head{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}
.block-title{flex:1 1 auto;font-size:14.5px;font-weight:700;letter-spacing:0;line-height:1.5}
.fid{flex:0 0 auto;font-size:10.5px;font-weight:700;letter-spacing:.03em;padding:2px 7px;border-radius:999px;white-space:nowrap}
.fid-ok{color:var(--ok);background:var(--ok-bg)}
.fid-inferred,.fid-ai{color:var(--ai);background:var(--ai-bg)}
.block-meta{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}
.line-badge{font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums;color:var(--tier-ink);background:var(--tier-soft);border:1px solid transparent;border-radius:6px;padding:1px 6px;cursor:pointer;transition:border-color .12s ease,background .12s ease}
.line-badge:hover{border-color:var(--tier);background:var(--surface)}
.block-text{margin:0;font-family:var(--reading);font-size:15px;line-height:1.8;color:var(--ink-2);max-width:70ch}
.block-text.mono{font-family:var(--mono);font-size:13px;line-height:1.75;color:var(--ink)}
.snippet{margin:0;font-family:var(--mono);font-size:12.5px;line-height:1.75;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;white-space:pre;overflow-x:auto;color:var(--ink)}
.tok-c{color:var(--tok-com);font-style:italic}
.tok-s{color:var(--tok-str)}
.tok-k{color:var(--tok-key);font-weight:600}

.empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:56px 24px;text-align:center;color:var(--ink-3);font-size:13.5px;line-height:1.7}
.empty-art{width:52px;height:52px;color:var(--tier);opacity:.55}

/* ---- 语义层未就绪：业务背景 / L1 / L2 必须由模型生成 ---- */
.gate{display:flex;flex-direction:column;align-items:center;gap:10px;padding:46px 26px;text-align:center;background:var(--surface);border:1px dashed var(--line-strong);border-radius:12px;box-shadow:var(--shadow-1)}
.gate-icon{width:38px;height:38px;color:var(--ai);opacity:.85}
.gate-title{font-size:15px;font-weight:700;letter-spacing:0;line-height:1.4}
.gate-body{max-width:540px;margin:0;font-family:var(--reading);font-size:14px;line-height:1.8;color:var(--ink-2)}
.gate-err{max-width:100%;font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--ai);background:var(--ai-bg);border-radius:6px;padding:4px 9px;overflow-wrap:anywhere}
.gate-actions{display:flex;gap:8px;margin-top:2px}
.gate-dots{display:inline-flex;gap:4px;margin-bottom:2px}
.gate-dots i{width:5px;height:5px;border-radius:50%;background:var(--tier);animation:gatePulse 1.1s ease-in-out infinite}
.gate-dots i:nth-child(2){animation-delay:.16s}
.gate-dots i:nth-child(3){animation-delay:.32s}
@keyframes gatePulse{0%,80%,100%{opacity:.22;transform:scale(.8)}40%{opacity:1;transform:none}}
.btn{font:600 13px/1 var(--sans);padding:8px 14px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);cursor:pointer;transition:border-color .15s ease,background .15s ease,transform .15s ease}
.btn:hover{border-color:var(--tier);transform:translateY(-1px)}
.btn.primary{background:var(--tier);border-color:var(--tier);color:#062320}
.ctx-cta-row{display:flex;gap:8px;margin-top:9px}

@media (max-width:620px){
  header{padding:12px 14px 10px}
  .brand .sub{display:none}
  .legend .item span:not(.dot){display:none}
  .ctx{margin:10px 14px 0}
  .tierbar{grid-template-columns:repeat(2,minmax(0,1fr));padding:10px 14px 0}
  .reparse-label{display:none}
  .hint{padding:8px 14px 10px}
  .blocks{padding:0 14px 24px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
}
`;

const JS = `
(function(){
  var vscode = acquireVsCodeApi();
  var UI = __UI__;
  var TIER_ORDER = ['L1','L2','L3','L4'];
  var payload = null;
  var currentTier = 'L1';
  var pinnedIdx = -1;
  var ctxCollapsed = false;
  var ctxPage = 'business';

  // VS Code 会在 body 上挂主题类；镜像到 html 上，样式再用 data-theme 切换令牌
  function syncTheme(){
    var cls = document.body.className || '';
    var light = /vscode-(light|high-contrast-light)/.test(cls);
    var dark = !light && /vscode-(dark|high-contrast)/.test(cls);
    if(!light && !dark && window.matchMedia){
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  syncTheme();
  if(window.MutationObserver){
    new MutationObserver(syncTheme).observe(document.body, {attributes:true, attributeFilter:['class']});
  }

  function tierMeta(t){
    var x = UI.tiers[t];
    return { label: t, name: x.name, desc: x.desc };
  }

  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function hl(s){
    var e = esc(s);
    var re = /("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(#[^\\n]*)|(\\b(?:def|class|return|if|elif|else|for|while|import|from|as|in|not|and|or|True|False|None|lambda|with|try|except|raise|pass|break|continue|yield|global|nonlocal|assert|del|is|print|str|list|dict|Annotated|Literal|TypedDict|operator|StateGraph|InMemorySaver|END|START)\\b)/g;
    return e.replace(re, function(m, str, com, kw){
      if(str) return '<span class="tok-s">' + str + '</span>';
      if(com) return '<span class="tok-c">' + com + '</span>';
      return '<span class="tok-k">' + m + '</span>';
    });
  }

  function badgeLabel(r){
    return (r.start === r.end) ? ('L' + r.start) : ('L' + r.start + '-' + r.end);
  }

  // fidelity: ok = 代码直译；inferred = 模板/注释推断；ai = 模型改写
  function fidBadge(f){
    if(f === 'ai'){ return '<span class="fid fid-ai">' + UI.fidAi + '</span>'; }
    if(f === 'inferred'){ return '<span class="fid fid-inferred">' + UI.fidInferred + '</span>'; }
    return '<span class="fid fid-ok">' + UI.fidOk + '</span>';
  }

  // 语义层状态：业务背景 / L1 / L2 必须由模型生成，未就绪时不展示模板内容
  function semState(){
    return (payload && payload.context && payload.context.state) || 'loading';
  }

  function gateHtml(){
    var s = semState();
    var loading = s === 'loading';
    var failed = s === 'failed';
    var title = loading ? UI.llmLoadingTitle : (failed ? UI.llmFailedTitle : UI.llmNoModelTitle);
    var body = loading ? UI.llmLoadingBody : (failed ? UI.llmFailedBody : UI.llmNoModelBody);
    var err = (failed && payload.context.error)
      ? '<div class="gate-err">' + esc(payload.context.error) + '</div>'
      : '';
    var dots = loading ? '<div class="gate-dots" aria-hidden="true"><i></i><i></i><i></i></div>' : '';
    var actions = loading ? '' :
      '<div class="gate-actions">' +
        '<button type="button" class="btn primary gate-act" data-act="openSettings">' + esc(UI.btnConfigure) + '</button>' +
        '<button type="button" class="btn gate-act" data-act="retry">' + esc(UI.btnRetry) + '</button>' +
      '</div>';
    return '<div class="gate" role="status">' + dots +
      '<svg class="gate-icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 3 3 20h18L12 3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M12 9v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        '<circle cx="12" cy="17" r="1" fill="currentColor"/>' +
      '</svg>' +
      '<div class="gate-title">' + esc(title) + '</div>' +
      '<p class="gate-body">' + esc(body) + '</p>' + err + actions +
    '</div>';
  }

  function applyTier(t){
    document.documentElement.setAttribute('data-tier', t);
    var tabs = document.querySelectorAll('.tier-tab');
    for(var i=0;i<tabs.length;i++){
      var on = tabs[i].getAttribute('data-tier') === t;
      tabs[i].classList.toggle('active', on);
      tabs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function renderTierbar(){
    var el = document.getElementById('tierbar');
    var html = '';
    for(var i=0;i<TIER_ORDER.length;i++){
      var t = TIER_ORDER[i]; var m = tierMeta(t);
      var meter = '';
      for(var k=0;k<TIER_ORDER.length;k++){
        meter += '<i' + (k<=i ? ' class="on"' : '') + '></i>';
      }
      html += '<button class="tier-tab' + (t===currentTier ? ' active' : '') + '" data-tier="' + t + '" role="tab" aria-pressed="' + (t===currentTier) + '">' +
        '<span class="tier-key">' + m.label + '</span>' +
        '<span class="tier-name">' + m.name + '</span>' +
        '<span class="tier-desc">' + m.desc + '</span>' +
        '<span class="tier-meter" aria-hidden="true">' + meter + '</span></button>';
    }
    el.innerHTML = html;
  }

  function renderContext(ctx){
    var el = document.getElementById('ctx');
    if(!ctx){ el.style.display = 'none'; return; }
    var state = ctx.state || 'ready';
    var ready = state === 'ready';
    var fid = ready
      ? fidBadge(ctx.fidelity)
      : (state === 'loading' ? '' : '<span class="fid fid-ai">' + esc(state === 'no-model' ? UI.fidNoModel : UI.fidFailed) + '</span>');
    var tech = ctx.tech || { bullets: [], sources: [] };
    var isTech = ctxPage === 'tech';
    var body;
    if(isTech){
      var techBullets = (tech.bullets || []).map(function(b){ return '<li>' + esc(b) + '</li>'; }).join('');
      var sources = (tech.sources || []).map(function(s){ return '<span class="ctx-src">' + esc(s) + '</span>'; }).join('');
      body = (techBullets ? '<ul class="ctx-bullets">' + techBullets + '</ul>' : '') +
        (sources ? '<div class="ctx-sources">' + UI.contextBasis + sources + '</div>' : '');
    } else if(ready){
      var bullets = (ctx.bullets || []).map(function(b){ return '<li>' + esc(b) + '</li>'; }).join('');
      body = '<p class="ctx-summary">' + esc(ctx.summary) + '</p>' +
        (bullets ? '<ul class="ctx-bullets">' + bullets + '</ul>' : '');
    } else {
      var msg = state === 'failed' ? UI.llmFailedBody : (state === 'loading' ? UI.llmLoadingBody : UI.llmNoModelBody);
      var err = (state === 'failed' && ctx.error) ? '<div class="gate-err">' + esc(ctx.error) + '</div>' : '';
      var actions = state === 'loading' ? '' :
        '<div class="ctx-cta-row">' +
          '<button type="button" class="btn primary ctx-act" data-act="openSettings">' + esc(UI.btnConfigure) + '</button>' +
          '<button type="button" class="btn ctx-act" data-act="retry">' + esc(UI.btnRetry) + '</button>' +
        '</div>';
      body = '<p class="ctx-summary">' + esc(msg) + '</p>' + err + actions;
    }
    el.innerHTML = '<div class="ctx-head" id="ctx-head" role="button" tabindex="0" aria-expanded="' + (!ctxCollapsed) + '" title="' + esc(UI.ctxToggle) + '">' +
        '<svg class="ctx-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<div class="ctx-tabs">' +
          '<button type="button" class="ctx-tab' + (isTech ? '' : ' active') + '" data-page="business">' + esc(UI.contextTitle) + '</button>' +
          '<button type="button" class="ctx-tab' + (isTech ? ' active' : '') + '" data-page="tech">' + esc(UI.techTitle) + '</button>' +
        '</div>' + fid + '</div>' +
      '<div class="ctx-body">' + body + '</div>';
    el.onclick = function(ev){
      var act = ev.target && ev.target.closest ? ev.target.closest('.ctx-act') : null;
      if(act){
        vscode.postMessage({ type: act.getAttribute('data-act') });
        ev.stopPropagation();
      }
    };
    el.classList.toggle('collapsed', ctxCollapsed);
    var head = document.getElementById('ctx-head');
    if(head){
      var toggle = function(){
        ctxCollapsed = !ctxCollapsed;
        el.classList.toggle('collapsed', ctxCollapsed);
        head.setAttribute('aria-expanded', String(!ctxCollapsed));
      };
      head.addEventListener('click', function(ev){
        var tab = ev.target && ev.target.closest ? ev.target.closest('.ctx-tab') : null;
        if(tab){
          ctxPage = tab.getAttribute('data-page');
          renderContext(ctx);
          return;
        }
        toggle();
      });
      head.addEventListener('keydown', function(ev){
        var onTab = ev.target && ev.target.closest && ev.target.closest('.ctx-tab');
        if(!onTab && (ev.key === 'Enter' || ev.key === ' ')){ ev.preventDefault(); toggle(); }
      });
    }
    el.style.display = 'block';
  }

  function renderBlocks(){
    var el = document.getElementById('blocks');
    // 业务背景 / L1 / L2 必须由模型生成：未就绪时整档阻断，不展示模板内容
    if((currentTier === 'L1' || currentTier === 'L2') && semState() !== 'ready'){
      el.innerHTML = gateHtml();
      return;
    }
    var blocks = payload ? payload.tiers[currentTier] : [];
    // L1/L2 在 ready 态下只展示模型产出的块，模型未覆盖的单元不拿模板顶替
    if(currentTier === 'L1' || currentTier === 'L2'){
      blocks = blocks.filter(function(b){ return b.fidelity === 'ai'; });
    }
    if(!blocks.length){
      el.innerHTML = '<div class="empty">' +
        '<svg class="empty-art" viewBox="0 0 64 64" aria-hidden="true">' +
          '<path d="M20 8v48M44 8v48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".45"/>' +
          '<path d="M20 17h24M20 28h24M20 39h24M20 50h24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
        '</svg>' +
        '<p>' + UI.empty + '</p></div>';
      return;
    }
    var html = '';
    for(var i=0;i<blocks.length;i++){
      var b = blocks[i];
      var badges = '';
      for(var j=0;j<b.lines.length;j++){
        var r = b.lines[j];
        badges += '<button class="line-badge" data-start="' + r.start + '" data-end="' + r.end + '">' + badgeLabel(r) + '</button>';
      }
      var fid = fidBadge(b.fidelity);
      var body;
      if(b.mode === 'code'){
        body = '<pre class="snippet">' + hl(b.content) + '</pre>';
      } else {
        var mono = (currentTier === 'L3') ? ' mono' : '';
        body = '<p class="block-text' + mono + '">' + esc(b.content) + '</p>';
      }
      var order = (i + 1 < 10 ? '0' : '') + (i + 1);
      html += '<div class="block" data-idx="' + i + '" data-units="' + ((b.focusUnits && b.focusUnits.length ? b.focusUnits : [b.unitIndex]).join(',')) + '" style="--i:' + Math.min(i, 12) + '" role="button" tabindex="0">' +
        '<div class="block-gutter"><span class="block-index">' + order + '</span></div>' +
        '<div class="block-main">' +
          '<div class="block-head"><span class="block-title">' + esc(b.title) + '</span>' + fid + '</div>' +
          '<div class="block-meta">' + badges + '</div>' + body +
        '</div></div>';
    }
    el.innerHTML = html;
  }

  function tierOf(){
    return currentTier;
  }

  function focusBlocks(indexes){
    var active = {};
    for(var i=0;i<indexes.length;i++) active[indexes[i]] = true;
    var all = document.querySelectorAll('.block');
    for(var j=0;j<all.length;j++){
      var units = (all[j].getAttribute('data-units') || '').split(',').map(function(v){ return parseInt(v, 10); });
      var hit = false;
      for(var k=0;k<units.length;k++){ if(active[units[k]]){ hit = true; break; } }
      if(hit) all[j].classList.add('active'); else all[j].classList.remove('active');
    }
    if(indexes.length){
      var target = null;
      for(var m=0;m<all.length;m++){
        var u2 = (all[m].getAttribute('data-units') || '').split(',').map(function(v){ return parseInt(v, 10); });
        for(var n=0;n<u2.length;n++){ if(u2[n] === indexes[0]){ target = all[m]; break; } }
        if(target) break;
      }
      if(target) target.scrollIntoView({behavior:'smooth', block:'center'});
    }
  }

  document.getElementById('tierbar').addEventListener('click', function(e){
    var tab = e.target.closest('.tier-tab');
    if(!tab) return;
    currentTier = tab.getAttribute('data-tier');
    applyTier(currentTier);
    renderBlocks();
  });

  // 点行号徽章跳该行；点块本体跳到该块首行，并高亮整块
  function activateBlock(block, badge){
    var idx = parseInt(block.getAttribute('data-idx'), 10);
    var blocks = (payload && payload.tiers[currentTier]) || [];
    var b = blocks[idx];
    if(b){
      var lineRange = badge
        ? { start: parseInt(badge.getAttribute('data-start'), 10), end: parseInt(badge.getAttribute('data-end'), 10) }
        : (b.lines[0] || { start: 1, end: 1 });
      pinnedIdx = idx;
      vscode.postMessage({
        type:'jump',
        ranges: badge ? [lineRange] : b.lines,
        line: lineRange.start
      });
      return;
    }
  }

  document.getElementById('blocks').addEventListener('click', function(e){
    var act = e.target.closest('.gate-act');
    if(act){
      vscode.postMessage({ type: act.getAttribute('data-act') });
      return;
    }
    var badge = e.target.closest('.line-badge');
    var block = e.target.closest('.block');
    if(!block) return;
    activateBlock(block, badge);
  });

  document.getElementById('blocks').addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.key !== ' ') return;
    var block = e.target.closest('.block');
    if(!block || e.target.closest('.line-badge')) return;
    e.preventDefault();
    activateBlock(block, null);
  });

  document.getElementById('blocks').addEventListener('mouseover', function(e){
    var block = e.target.closest('.block');
    if(!block) return;
    var idx = parseInt(block.getAttribute('data-idx'), 10);
    if(idx !== pinnedIdx) pinnedIdx = -1;
    var blocks = (payload && payload.tiers[currentTier]) || [];
    var b = blocks[idx];
    if(b){ vscode.postMessage({ type:'focus', ranges: b.lines }); }
  });

  document.getElementById('blocks').addEventListener('mouseout', function(e){
    var block = e.target.closest('.block');
    if(!block) return;
    if(pinnedIdx !== -1) return;
    vscode.postMessage({ type:'unfocus' });
  });

  var reparseBtn = document.getElementById('reparse');
  if(reparseBtn){
    reparseBtn.addEventListener('click', function(){
      if(reparseBtn.disabled) return;
      setBusy(true);
      vscode.postMessage({ type:'reparse' });
    });
  }

  window.addEventListener('message', function(ev){
    var msg = ev.data;
    if(!msg) return;
    if(msg.type === 'render'){
      payload = msg.payload;
      pinnedIdx = -1;
      renderContext(payload.context);
      applyTier(currentTier);
      renderTierbar();
      renderBlocks();
      var firstTab = document.querySelector('.tier-tab[data-tier="' + currentTier + '"]');
      if(firstTab) firstTab.classList.add('active');
    } else if(msg.type === 'ui'){
      applyUi(msg.ui);
    } else if(msg.type === 'usage'){
      setUsage(msg.usage);
    } else if(msg.type === 'busy'){
      setBusy(msg.on);
    } else if(msg.type === 'focusBlocks'){
      focusBlocks(msg.indexes);
    }
  });

  // 本次分析的 token 用量：加载中随批次数递增，完成后保留最终值
  function setUsage(usage){
    var el = document.getElementById('usage');
    if(!el) return;
    if(!usage){
      el.style.display = 'none';
      el.textContent = '';
      el.title = '';
      return;
    }
    el.textContent = (usage.estimated ? '≈' : '') + usage.total.toLocaleString() + ' ' + UI.tokenUnit;
    var tip = usage.total
      ? [UI.tokenTip, UI.tokenInput + ' ' + usage.prompt.toLocaleString(), UI.tokenOutput + ' ' + usage.completion.toLocaleString()]
      : [UI.tokenCached];
    if(usage.estimated) tip.push(UI.tokenEstimated);
    el.title = tip.join(' · ');
    el.style.display = 'inline-flex';
  }

  // 手动重新解析进行中：禁用按钮并让图标转起来
  function setBusy(on){
    var btn = document.getElementById('reparse');
    if(!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle('busy', !!on);
  }

  function applyUi(ui){
    UI = ui;
    document.documentElement.lang = ui.locale;
    var sub = document.getElementById('sub'); if(sub) sub.textContent = ui.sub;
    var ok = document.getElementById('legend-ok'); if(ok) ok.textContent = ui.legendOk;
    var ai = document.getElementById('legend-ai'); if(ai) ai.textContent = ui.legendAi;
    var hint = document.getElementById('hint'); if(hint) hint.textContent = ui.hint;
    var rl = document.getElementById('reparse-label'); if(rl) rl.textContent = ui.btnReparse;
    var rb = document.getElementById('reparse'); if(rb) rb.title = ui.btnReparseTip;
    applyTier(currentTier);
    renderTierbar();
    renderBlocks();
    renderContext(payload && payload.context);
    var tab = document.querySelector('.tier-tab[data-tier="' + currentTier + '"]');
    if(tab) tab.classList.add('active');
  }

  applyTier(currentTier);
  renderTierbar();
  renderBlocks();
  var firstTab = document.querySelector('.tier-tab[data-tier="' + currentTier + '"]');
  if(firstTab) firstTab.classList.add('active');

  // 通知扩展端脚本已就绪，可以开始灌入 render / usage 等消息
  vscode.postMessage({ type: 'ready' });
})();
`;
