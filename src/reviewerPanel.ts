import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReviewFinding } from './types';

type CharacterState = 'idle' | 'thinking' | 'talking' | 'laughing';

/**
 * Manages the WebView panel that shows the animated cartoon reviewer character
 * and presents review findings.
 */
export class ReviewerPanel implements vscode.Disposable {
    public static readonly viewType = 'prReviewer.panel';
    private static instance: ReviewerPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext): ReviewerPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (ReviewerPanel.instance) {
            ReviewerPanel.instance.panel.reveal(column);
            return ReviewerPanel.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            ReviewerPanel.viewType,
            '🎬 PR Reviewer',
            column,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(context.extensionPath, 'media')),
                ],
                retainContextWhenHidden: true,
            }
        );

        ReviewerPanel.instance = new ReviewerPanel(panel, context.extensionUri);
        return ReviewerPanel.instance;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.html = this.buildHtml();
    }

    /** Show a simple status message with a character state. */
    showMessage(text: string, state: CharacterState = 'talking'): void {
        this.postMessage({ type: 'message', text, state });
    }

    /** Show the full list of findings. */
    showFindings(findings: ReviewFinding[]): void {
        this.postMessage({ type: 'findings', findings });
    }

    private postMessage(msg: Record<string, unknown>): void {
        void this.panel.webview.postMessage(msg);
    }

    private getSpriteUri(): vscode.Uri {
        const config = vscode.workspace.getConfiguration('prReviewer');
        const custom = config.get<string>('spritesheetPath', '');

        if (custom && fs.existsSync(custom)) {
            return this.panel.webview.asWebviewUri(vscode.Uri.file(custom));
        }

        // Use bundled placeholder
        const builtIn = vscode.Uri.file(
            path.join(this.extensionUri.fsPath, 'media', 'sprite.png')
        );
        return this.panel.webview.asWebviewUri(builtIn);
    }

    private buildHtml(): string {
        const config = vscode.workspace.getConfiguration('prReviewer');
        const frameW = config.get<number>('spriteFrameWidth', 64);
        const frameH = config.get<number>('spriteFrameHeight', 64);
        const frameCount = config.get<number>('spriteFrameCount', 8);
        const spriteUri = this.getSpriteUri();
        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               img-src ${this.panel.webview.cspSource} https: data:;
               style-src 'unsafe-inline';
               script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Reviewer</title>
<style>
  :root {
    --frame-w: ${frameW}px;
    --frame-h: ${frameH}px;
    --frame-count: ${frameCount};
    --sprite-total-w: ${frameW * frameCount}px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Character Stage ── */
  #stage {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    padding: 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
  }

  #sprite-wrap {
    width: var(--frame-w);
    height: var(--frame-h);
    overflow: hidden;
    flex-shrink: 0;
    image-rendering: pixelated;
  }

  #sprite {
    width: var(--sprite-total-w);
    height: var(--frame-h);
    background-image: url('${spriteUri}');
    background-size: cover;
    background-repeat: no-repeat;
    animation: none;
  }

  /* Animation keyframes for walking through frames */
  @keyframes sprite-idle    { to { background-position-x: calc(-1 * var(--sprite-total-w)); } }
  @keyframes sprite-thinking{ to { background-position-x: calc(-1 * var(--sprite-total-w)); } }
  @keyframes sprite-talking { to { background-position-x: calc(-1 * var(--sprite-total-w)); } }
  @keyframes sprite-laughing{ to { background-position-x: calc(-1 * var(--sprite-total-w)); } }

  #sprite.idle     { animation: sprite-idle     1.2s steps(var(--frame-count)) infinite; }
  #sprite.thinking { animation: sprite-thinking 0.8s steps(var(--frame-count)) infinite; }
  #sprite.talking  { animation: sprite-talking  0.5s steps(var(--frame-count)) infinite; }
  #sprite.laughing { animation: sprite-laughing 0.3s steps(var(--frame-count)) infinite; }

  /* Speech bubble */
  #bubble {
    position: relative;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 12px;
    padding: 10px 14px;
    max-width: 400px;
    line-height: 1.5;
    font-style: italic;
    flex: 1;
  }
  #bubble::before {
    content: '';
    position: absolute;
    left: -10px;
    bottom: 14px;
    border: 5px solid transparent;
    border-right-color: var(--vscode-input-border, #555);
  }
  #bubble::after {
    content: '';
    position: absolute;
    left: -8px;
    bottom: 15px;
    border: 4px solid transparent;
    border-right-color: var(--vscode-input-background);
  }

  /* ── Findings List ── */
  #findings-container {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .findings-header {
    font-size: 1.1em;
    font-weight: bold;
    margin-bottom: 10px;
    color: var(--vscode-editorInfo-foreground);
  }

  .finding {
    margin-bottom: 12px;
    border-left: 3px solid #555;
    padding: 8px 12px;
    border-radius: 0 6px 6px 0;
    background: var(--vscode-list-hoverBackground);
    cursor: pointer;
    transition: background 0.15s;
  }
  .finding:hover { background: var(--vscode-list-activeSelectionBackground); }

  .finding.error   { border-left-color: #ff5555; }
  .finding.warning { border-left-color: #ffcc00; }
  .finding.info    { border-left-color: #3399ff; }

  .finding-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: bold;
    margin-bottom: 4px;
  }

  .finding-location {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }

  .finding-message { line-height: 1.5; }

  .finding-suggestion {
    margin-top: 6px;
    font-size: 0.9em;
    color: var(--vscode-textLink-foreground);
    font-style: italic;
  }

  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .badge {
    display: inline-block;
    font-size: 0.7em;
    padding: 1px 5px;
    border-radius: 10px;
    font-weight: bold;
    text-transform: uppercase;
    vertical-align: middle;
  }
  .badge.error   { background: rgba(255,85,85,0.2);  color: #ff5555; }
  .badge.warning { background: rgba(255,204,0,0.2);  color: #ccaa00; }
  .badge.info    { background: rgba(51,153,255,0.2); color: #3399ff; }

  .loading-dots::after {
    content: '';
    animation: dots 1.2s steps(3, end) infinite;
  }
  @keyframes dots {
    0%   { content: '.'; }
    33%  { content: '..'; }
    66%  { content: '...'; }
    100% { content: ''; }
  }
</style>
</head>
<body>

<!-- Character Stage -->
<div id="stage">
  <div id="sprite-wrap">
    <div id="sprite" class="idle"></div>
  </div>
  <div id="bubble">Ready to eviscerate some code<span class="loading-dots"></span></div>
</div>

<!-- Findings -->
<div id="findings-container">
  <div class="empty-state">Hit <strong>PR Reviewer: Review Current PR / Branch Diff</strong> to get started.</div>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const sprite = document.getElementById('sprite');
  const bubble = document.getElementById('bubble');
  const container = document.getElementById('findings-container');

  let talkTimer = null;

  function setState(state) {
    sprite.className = state;
  }

  function showBubble(text, state) {
    clearTimeout(talkTimer);
    setState(state || 'talking');
    bubble.textContent = text;
    // Return to idle after 6 seconds of no new message
    talkTimer = setTimeout(() => setState('idle'), 6000);
  }

  function renderFindings(findings) {
    if (!findings || findings.length === 0) {
      container.innerHTML = '<div class="empty-state">No findings. Either your code is decent, or I\'ve gone blind.</div>';
      showBubble('Right, I\'ve looked through it. Not as bad as I thought. Damning with faint praise, that.', 'idle');
      return;
    }

    const errors   = findings.filter(f => f.severity === 'error').length;
    const warnings = findings.filter(f => f.severity === 'warning').length;
    const infos    = findings.filter(f => f.severity === 'info').length;

    const summaryLine = \`Found \${findings.length} issue\${findings.length !== 1 ? 's' : ''}: \` +
      \`\${errors} error\${errors !== 1 ? 's' : ''}, \` +
      \`\${warnings} warning\${warnings !== 1 ? 's' : ''}, \` +
      \`\${infos} note\${infos !== 1 ? 's' : ''}.\`;

    const quip = pickQuip(errors, warnings, findings.length);
    showBubble(quip, errors > 0 ? 'laughing' : 'talking');

    let html = \`<div class="findings-header">\${summaryLine}</div>\`;

    for (const f of findings) {
      const icon = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
      const loc = f.line > 0 ? \`\${f.file}:\${f.line}\` : f.file;
      html += \`
<div class="finding \${escHtml(f.severity)}" data-file="\${escHtml(f.file)}" data-line="\${f.line}">
  <div class="finding-header">
    \${icon} <span class="badge \${escHtml(f.severity)}">\${escHtml(f.severity)}</span>
    \${escHtml(f.title)}
  </div>
  <div class="finding-location">\${escHtml(loc)}</div>
  <div class="finding-message">\${escHtml(f.message)}</div>
  \${f.suggestion ? \`<div class="finding-suggestion">💡 \${escHtml(f.suggestion)}</div>\` : ''}
</div>\`;
    }

    container.innerHTML = html;

    // Click to navigate to file/line
    container.querySelectorAll('.finding').forEach(el => {
      el.addEventListener('click', () => {
        const file = el.dataset.file;
        const line = parseInt(el.dataset.line, 10);
        vscode.postMessage({ type: 'navigate', file, line });
      });
    });
  }

  function pickQuip(errors, warnings, total) {
    if (errors > 5)  return "Oh my god. This isn't code, it's a hate crime against computers.";
    if (errors > 2)  return "I've seen better code written by a drunk toddler. And that's the truth.";
    if (errors > 0)  return "There are errors in here. Real ones. Not just the ones in your life choices.";
    if (warnings > 3) return "No outright disasters, but the warnings… the warnings tell a story. A sad one.";
    if (warnings > 0) return "Could be worse. Could be better. Mostly just… there.";
    if (total === 0)  return "I can't find anything. Either it's fine, or you've broken my scanner too.";
    return "A few things to note. Don't take it personally. Actually, do take it personally.";
  }

  function escHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.type) {
      case 'message':
        showBubble(msg.text, msg.state || 'talking');
        break;
      case 'findings':
        renderFindings(msg.findings);
        break;
    }
  });
})();
</script>
</body>
</html>`;
    }

    dispose(): void {
        ReviewerPanel.instance = undefined;
        this.panel.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
