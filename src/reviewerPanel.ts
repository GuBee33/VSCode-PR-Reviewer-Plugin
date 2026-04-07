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

    /** Append a timestamped entry to the progress log in the panel. */
    appendLog(text: string, isError = false): void {
        this.postMessage({ type: 'log', text, isError });
    }

    /** Clear all entries from the progress log. */
    clearLog(): void {
        this.postMessage({ type: 'clearLog' });
    }

    private getSpriteUri(): vscode.Uri {
        const config = vscode.workspace.getConfiguration('prReviewer');
        const custom = config.get<string>('spritesheetPath', '');

        if (custom && fs.existsSync(custom)) {
            return this.panel.webview.asWebviewUri(vscode.Uri.file(custom));
        }

        // Use bundled GuBee sprite sheet
        const builtIn = vscode.Uri.file(
            path.join(this.extensionUri.fsPath, 'media', 'GuBee_SpriteSheet.png')
        );
        return this.panel.webview.asWebviewUri(builtIn);
    }

    private buildHtml(): string {
        const config = vscode.workspace.getConfiguration('prReviewer');
        const frameW    = config.get<number>('spriteFrameWidth',  128);
        const frameH    = config.get<number>('spriteFrameHeight', 192);
        const frameCount = config.get<number>('spriteFrameCount', 4);
        const rowCount  = config.get<number>('spriteRowCount',    4);
        const spriteUri = this.getSpriteUri();
        const nonce     = getNonce();

        // Full sprite-sheet display dimensions
        const sheetW = frameW * frameCount;
        const sheetH = frameH * rowCount;

        // Y offsets (px) for each animation row, clamped to available rows
        const rowToYOffset = (r: number) => -Math.min(r, rowCount - 1) * frameH;
        const yIdle     = 0;
        const yThinking = rowToYOffset(1);
        const yTalking  = rowToYOffset(2);
        const yLaughing = rowToYOffset(3);

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
    width: ${frameW}px;
    height: ${frameH}px;
    overflow: hidden;
    flex-shrink: 0;
  }

  /* The sprite element is the same size as one frame.
     background-size stretches the full sheet; background-position
     selects the current frame. */
  #sprite {
    width: ${frameW}px;
    height: ${frameH}px;
    background-image: url('${spriteUri}');
    background-size: ${sheetW}px ${sheetH}px;
    background-repeat: no-repeat;
    background-position: 0px 0px;
    animation: none;
  }

  /* Per-state keyframes: X sweeps through all columns, Y pins the row. */
  @keyframes sprite-idle {
    from { background-position: 0px ${yIdle}px; }
    to   { background-position: -${sheetW}px ${yIdle}px; }
  }
  @keyframes sprite-thinking {
    from { background-position: 0px ${yThinking}px; }
    to   { background-position: -${sheetW}px ${yThinking}px; }
  }
  @keyframes sprite-talking {
    from { background-position: 0px ${yTalking}px; }
    to   { background-position: -${sheetW}px ${yTalking}px; }
  }
  @keyframes sprite-laughing {
    from { background-position: 0px ${yLaughing}px; }
    to   { background-position: -${sheetW}px ${yLaughing}px; }
  }

  #sprite.idle     { animation: sprite-idle     1.2s steps(${frameCount}) infinite; }
  #sprite.thinking { animation: sprite-thinking 0.8s steps(${frameCount}) infinite; }
  #sprite.talking  { animation: sprite-talking  0.5s steps(${frameCount}) infinite; }
  #sprite.laughing { animation: sprite-laughing 0.3s steps(${frameCount}) infinite; }

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

  /* ── Progress Log ── */
  #log-section {
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
    max-height: 110px;
    display: flex;
    flex-direction: column;
  }

  #log-header {
    font-size: 0.72em;
    font-weight: bold;
    padding: 4px 12px 2px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  #log {
    overflow-y: auto;
    padding: 0 12px 6px;
    flex: 1;
  }

  .log-line {
    font-size: 0.78em;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    padding: 1px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .log-line.error {
    color: var(--vscode-editorError-foreground, #f44336);
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
<div id="log-section">
  <div id="log-header">Progress Log</div>
  <div id="log"></div>
</div>
<div id="findings-container">
  <div class="empty-state">Hit <strong>PR Reviewer: Review Current PR / Branch Diff</strong> to get started.</div>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const sprite = document.getElementById('sprite');
  const bubble = document.getElementById('bubble');
  const container = document.getElementById('findings-container');
  const logEl = document.getElementById('log');

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

  function appendLog(text, isError) {
    const line = document.createElement('div');
    line.className = isError ? 'log-line error' : 'log-line';
    const now = new Date();
    const ts = String(now.getHours()).padStart(2, '0') + ':' +
               String(now.getMinutes()).padStart(2, '0') + ':' +
               String(now.getSeconds()).padStart(2, '0');
    line.textContent = '[' + ts + '] ' + text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    // Keep at most 100 lines
    while (logEl.children.length > 100) {
      logEl.removeChild(logEl.firstChild);
    }
  }

  function clearLog() {
    logEl.innerHTML = '';
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
      case 'log':
        appendLog(msg.text, msg.isError);
        break;
      case 'clearLog':
        clearLog();
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
