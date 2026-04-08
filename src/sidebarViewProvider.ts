import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import { ReviewFinding } from './types';

type CharacterState = 'idle' | 'thinking' | 'talking' | 'laughing';

/**
 * Sidebar WebviewViewProvider – renders the animated character,
 * a speech bubble, progress log, and review findings inside the Activity Bar panel.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'prReviewer.characterView';

    private view?: vscode.WebviewView;
    private pendingMessages: Array<Record<string, unknown>> = [];

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(this.extensionUri.fsPath, 'media')),
            ],
        };

        webviewView.webview.html = this.buildHtml(webviewView.webview);

        // Flush any messages that arrived before the view was ready
        for (const msg of this.pendingMessages) {
            void webviewView.webview.postMessage(msg);
        }
        this.pendingMessages = [];

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'navigate') {
                this.navigateToFile(msg.file, msg.line);
            } else if (msg.type === 'startReview') {
                void vscode.commands.executeCommand('prReviewer.reviewPR', msg.model, msg.reviewerStyle, msg.baseBranch);
            } else if (msg.type === 'requestModels') {
                this.sendAvailableModels();
            } else if (msg.type === 'requestBranches') {
                this.sendAvailableBranches();
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
        });
    }

    // ── Public API used by the review flow ──────────────────────────

    showMessage(text: string, state: CharacterState = 'talking'): void {
        this.postMessage({ type: 'message', text, state });
    }

    showFindings(findings: ReviewFinding[]): void {
        this.postMessage({ type: 'findings', findings });
    }

    appendLog(text: string, isError = false): void {
        this.postMessage({ type: 'log', text, isError });
    }

    clearLog(): void {
        this.postMessage({ type: 'clearLog' });
    }

    /** Hide or show the Start Review button based on review state. */
    setReviewingState(isReviewing: boolean): void {
        this.postMessage({ type: 'reviewingState', isReviewing });
    }

    /** Send available language models to the webview. */
    private async sendAvailableModels(): Promise<void> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            const modelIds = models.map(m => m.family);
            // Remove duplicates
            const uniqueModels = [...new Set(modelIds)];
            // Default to first available model or copilot-gpt-4o
            const currentModel = uniqueModels[0] || 'copilot-gpt-4o';
            this.postMessage({ type: 'models', models: uniqueModels, currentModel });
        } catch {
            this.postMessage({ type: 'models', models: [], currentModel: 'copilot-gpt-4o' });
        }
    }

    /** Send available git branches to the webview. */
    private sendAvailableBranches(): void {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                this.postMessage({ type: 'branches', branches: [], currentBranch: '' });
                return;
            }

            // Get current branch
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe']
            }).toString().trim();

            // Get all local branches
            const branchOutput = execSync('git branch --format="%(refname:short)"', {
                cwd: workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe']
            }).toString().trim();
            
            const branches = branchOutput.split('\n').filter(b => b.length > 0);

            this.postMessage({ type: 'branches', branches, currentBranch });
        } catch {
            this.postMessage({ type: 'branches', branches: [], currentBranch: '' });
        }
    }

    /** Make the sidebar visible. */
    reveal(): void {
        if (this.view) {
            this.view.show?.(true);
        } else {
            // Focus the view which will trigger resolveWebviewView
            void vscode.commands.executeCommand('prReviewer.characterView.focus');
        }
    }

    // ── Internals ───────────────────────────────────────────────────

    private postMessage(msg: Record<string, unknown>): void {
        if (this.view) {
            void this.view.webview.postMessage(msg);
        } else {
            this.pendingMessages.push(msg);
        }
    }

    private navigateToFile(file: string, line: number): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const fileUri = root
            ? vscode.Uri.file(path.join(root, file))
            : vscode.Uri.file(file);

        vscode.workspace.openTextDocument(fileUri).then((doc) => {
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(pos, pos),
                preserveFocus: false,
            });
        });
    }

    private getSpriteUri(webview: vscode.Webview, filename: string): vscode.Uri {
        const builtIn = vscode.Uri.file(
            path.join(this.extensionUri.fsPath, 'media', filename)
        );
        return webview.asWebviewUri(builtIn);
    }

    private buildHtml(webview: vscode.Webview): string {
        const cols = 5;
        const rows = 5;
        const totalFrames = cols * rows;   // 25
        const frameW = 256;               // 1280 / 5
        const frameH = 256;               // 1280 / 5
        const idleUri = this.getSpriteUri(webview, 'GuBee-idle.png');
        const walkUri = this.getSpriteUri(webview, 'GuBee-walk.png');
        const nonce   = getNonce();

        // Scale down for narrow sidebar
        const scale   = 0.5;
        const dispW   = Math.round(frameW * scale);
        const dispH   = Math.round(frameH * scale);

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               img-src ${webview.cspSource} https: data:;
               style-src 'unsafe-inline';
               script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Reviewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--vscode-sideBar-background);
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
    flex-direction: column;
    align-items: center;
    padding: 12px 8px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  #sprite-wrap {
    width: ${dispW}px;
    height: ${dispH}px;
    overflow: hidden;
    flex-shrink: 0;
  }

  #sprite {
    width: ${dispW}px;
    height: ${dispH}px;
    background-image: url('${idleUri}');
    background-size: ${dispW * cols}px ${dispH * rows}px;
    background-repeat: no-repeat;
    background-position: 0px 0px;
  }

  /* Speech bubble */
  #bubble {
    margin-top: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 10px;
    padding: 8px 10px;
    max-width: 100%;
    line-height: 1.4;
    font-style: italic;
    font-size: 0.85em;
    text-align: center;
  }

  /* ── Status Bar ── */
  #status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 0.8em;
    flex-shrink: 0;
  }
  #status-icon { font-size: 1.1em; }
  #status-text {
    color: var(--vscode-descriptionForeground);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Progress Log ── */
  #log-section {
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    max-height: 100px;
    display: flex;
    flex-direction: column;
  }
  #log-header {
    font-size: 0.7em;
    font-weight: bold;
    padding: 4px 10px 2px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }
  #log {
    overflow-y: auto;
    padding: 0 10px 4px;
    flex: 1;
  }
  .log-line {
    font-size: 0.72em;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    padding: 1px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .log-line.error { color: var(--vscode-editorError-foreground, #f44336); }

  /* ── Findings ── */
  #findings-container { flex: 1; overflow-y: auto; padding: 8px 10px; }
  .findings-header { font-size: 0.9em; font-weight: bold; margin-bottom: 8px; color: var(--vscode-editorInfo-foreground); }
  .finding {
    margin-bottom: 8px; border-left: 3px solid #555; padding: 6px 8px;
    border-radius: 0 4px 4px 0; background: var(--vscode-list-hoverBackground);
    cursor: pointer; transition: background 0.15s; font-size: 0.85em;
  }
  .finding:hover { background: var(--vscode-list-activeSelectionBackground); }
  .finding.error   { border-left-color: #ff5555; }
  .finding.warning { border-left-color: #ffcc00; }
  .finding.info    { border-left-color: #3399ff; }
  .finding-header { display: flex; align-items: center; gap: 4px; font-weight: bold; margin-bottom: 2px; flex-wrap: wrap; }
  .finding-location { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .finding-message { line-height: 1.4; font-size: 0.9em; }
  .finding-suggestion { margin-top: 4px; font-size: 0.85em; color: var(--vscode-textLink-foreground); font-style: italic; }
  .badge { display: inline-block; font-size: 0.65em; padding: 1px 4px; border-radius: 8px; font-weight: bold; text-transform: uppercase; }
  .badge.error   { background: rgba(255,85,85,0.2);  color: #ff5555; }
  .badge.warning { background: rgba(255,204,0,0.2);  color: #ccaa00; }
  .badge.info    { background: rgba(51,153,255,0.2); color: #3399ff; }
  .empty-state { text-align: center; padding: 20px 10px; color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.85em; }
  .review-btn {
    display: inline-block; margin-top: 10px; padding: 6px 14px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em;
  }
  .review-btn:hover { background: var(--vscode-button-hoverBackground); }
  .model-row { margin-bottom: 10px; }
  .model-dropdown {
    width: 100%; padding: 6px 8px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 4px;
    font-size: 0.85em; cursor: pointer;
  }
  .model-dropdown:focus { outline: 1px solid var(--vscode-focusBorder); }
  .input-row { margin-bottom: 10px; }
  .input-row label { display: block; font-size: 0.75em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; text-align: left; }
  .reviewer-input {
    width: 100%; padding: 6px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 4px;
    font-size: 0.85em;
  }
  .reviewer-input:focus { outline: 1px solid var(--vscode-focusBorder); }
</style>
</head>
<body>

<div id="stage">
  <div id="sprite-wrap">
    <div id="sprite"></div>
  </div>
  <div id="bubble">Ready to eviscerate some code…</div>
</div>

<div id="status-bar">
  <span id="status-icon">💤</span>
  <span id="status-text">Idle — waiting for review</span>
</div>

<div id="log-section">
  <div id="log-header">Progress</div>
  <div id="log"></div>
</div>

<div id="findings-container">
  <div class="empty-state">
    <div class="input-row">
      <label for="branch-select">Compare Against</label>
      <select id="branch-select" class="model-dropdown">
        <option value="">Loading branches...</option>
      </select>
    </div>
    <div class="input-row">
      <label for="model-select">Model</label>
      <select id="model-select" class="model-dropdown">
        <option value="">Loading models...</option>
      </select>
    </div>
    <div class="input-row">
      <label for="reviewer-input">Reviewer Style</label>
      <input type="text" id="reviewer-input" class="reviewer-input" value="Ricky Gervais" placeholder="e.g. Gordon Ramsay, a disappointed professor...">
    </div>
    <button class="review-btn" id="start-btn">Start Review</button>
  </div>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const sprite = document.getElementById('sprite');
  const bubble = document.getElementById('bubble');
  const container = document.getElementById('findings-container');
  const logEl = document.getElementById('log');
  const statusIcon = document.getElementById('status-icon');
  const statusText = document.getElementById('status-text');
  const startBtn = document.getElementById('start-btn');
  const modelSelect = document.getElementById('model-select');
  const reviewerInput = document.getElementById('reviewer-input');
  const branchSelect = document.getElementById('branch-select');

  // Sprite animation config
  const IDLE_URL = '${idleUri}';
  const WALK_URL = '${walkUri}';
  const COLS = ${cols};
  const ROWS = ${rows};
  const TOTAL = ${totalFrames};
  const FRAME_W = ${dispW};
  const FRAME_H = ${dispH};

  let currentFrame = 0;
  let animTimer = null;
  let currentSheet = IDLE_URL;

  function startAnimation(sheetUrl, fps) {
    if (currentSheet !== sheetUrl) {
      currentSheet = sheetUrl;
      sprite.style.backgroundImage = "url('" + sheetUrl + "')";
    }
    if (animTimer) clearInterval(animTimer);
    currentFrame = 0;
    animTimer = setInterval(function() {
      var col = currentFrame % COLS;
      var row = Math.floor(currentFrame / COLS);
      sprite.style.backgroundPosition = (-col * FRAME_W) + 'px ' + (-row * FRAME_H) + 'px';
      currentFrame = (currentFrame + 1) % TOTAL;
    }, 1000 / fps);
  }

  // Start in idle
  startAnimation(IDLE_URL, 6);

  let talkTimer = null;

  // Request available models and branches on load
  vscode.postMessage({ type: 'requestModels' });
  vscode.postMessage({ type: 'requestBranches' });

  if (startBtn) {
    startBtn.addEventListener('click', function() {
      var selectedModel = modelSelect ? modelSelect.value : '';
      var reviewerStyle = reviewerInput ? reviewerInput.value : 'Ricky Gervais';
      var baseBranch = branchSelect ? branchSelect.value : '';
      vscode.postMessage({ type: 'startReview', model: selectedModel, reviewerStyle: reviewerStyle, baseBranch: baseBranch });
    });
  }

  function setStatus(icon, text) {
    statusIcon.textContent = icon;
    statusText.textContent = text;
  }

  function showBubble(text, state) {
    clearTimeout(talkTimer);
    bubble.textContent = text;
    if (state === 'thinking' || state === 'talking' || state === 'laughing') {
      startAnimation(WALK_URL, state === 'laughing' ? 16 : 10);
    } else {
      startAnimation(IDLE_URL, 6);
    }
    talkTimer = setTimeout(function() {
      startAnimation(IDLE_URL, 6);
    }, 8000);
  }

  function appendLog(text, isError) {
    var line = document.createElement('div');
    line.className = isError ? 'log-line error' : 'log-line';
    var now = new Date();
    var ts = String(now.getHours()).padStart(2, '0') + ':' +
             String(now.getMinutes()).padStart(2, '0') + ':' +
             String(now.getSeconds()).padStart(2, '0');
    line.textContent = '[' + ts + '] ' + text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 100) logEl.removeChild(logEl.firstChild);
  }

  function clearLog() { logEl.innerHTML = ''; }

  function renderFindings(findings) {
    if (!findings || findings.length === 0) {
      container.innerHTML = '<div class="empty-state">No findings. Either your code is decent, or I\\'ve gone blind.</div>';
      showBubble('Right, not as bad as I thought. Damning with faint praise, that.', 'idle');
      setStatus('✅', 'Review complete — no issues');
      return;
    }

    var errors   = findings.filter(function(f) { return f.severity === 'error'; }).length;
    var warnings = findings.filter(function(f) { return f.severity === 'warning'; }).length;
    var infos    = findings.filter(function(f) { return f.severity === 'info'; }).length;

    var summaryLine = 'Found ' + findings.length + ' issue' + (findings.length !== 1 ? 's' : '') + ': ' +
      errors + ' error' + (errors !== 1 ? 's' : '') + ', ' +
      warnings + ' warning' + (warnings !== 1 ? 's' : '') + ', ' +
      infos + ' note' + (infos !== 1 ? 's' : '') + '.';

    var quip = pickQuip(errors, warnings, findings.length);
    showBubble(quip, errors > 0 ? 'laughing' : 'talking');
    setStatus(errors > 0 ? '🔴' : warnings > 0 ? '🟡' : '🔵', summaryLine);

    var html = '<div class="findings-header">' + escHtml(summaryLine) + '</div>';
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      var icon = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
      var loc = f.line > 0 ? f.file + ':' + f.line : f.file;
      html +=
        '<div class="finding ' + escHtml(f.severity) + '" data-file="' + escHtml(f.file) + '" data-line="' + f.line + '">' +
          '<div class="finding-header">' + icon + ' <span class="badge ' + escHtml(f.severity) + '">' + escHtml(f.severity) + '</span> ' + escHtml(f.title) + '</div>' +
          '<div class="finding-location">' + escHtml(loc) + '</div>' +
          '<div class="finding-message">' + escHtml(f.message) + '</div>' +
          (f.suggestion ? '<div class="finding-suggestion">💡 ' + escHtml(f.suggestion) + '</div>' : '') +
        '</div>';
    }
    container.innerHTML = html;
    container.querySelectorAll('.finding').forEach(function(el) {
      el.addEventListener('click', function() {
        vscode.postMessage({ type: 'navigate', file: el.dataset.file, line: parseInt(el.dataset.line, 10) });
      });
    });
  }

  function pickQuip(errors, warnings, total) {
    if (errors > 5)  return "Oh my god. This isn't code, it's a hate crime against computers.";
    if (errors > 2)  return "I've seen better code written by a drunk toddler.";
    if (errors > 0)  return "There are errors in here. Real ones. Not just the ones in your life choices.";
    if (warnings > 3) return "No disasters, but the warnings tell a story. A sad one.";
    if (warnings > 0) return "Could be worse. Could be better. Mostly just… there.";
    if (total === 0)  return "I can't find anything. Either it's fine or you've broken my scanner.";
    return "A few things to note. Do take it personally.";
  }

  function escHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg) return;
    switch (msg.type) {
      case 'message':
        showBubble(msg.text, msg.state || 'talking');
        if (msg.state === 'thinking') setStatus('🔄', msg.text.replace(/[🚀📂🤔🤖🎨]/g, '').trim());
        break;
      case 'findings':
        renderFindings(msg.findings);
        break;
      case 'log':
        appendLog(msg.text, msg.isError);
        if (msg.isError) setStatus('❌', msg.text.replace(/[❌]/g, '').trim());
        break;
      case 'clearLog':
        clearLog();
        setStatus('🚀', 'Review in progress…');
        startAnimation(WALK_URL, 10);
        break;
      case 'reviewingState':
        if (startBtn) {
          startBtn.style.display = msg.isReviewing ? 'none' : 'inline-block';
        }
        if (modelSelect) {
          modelSelect.disabled = msg.isReviewing;
        }
        if (reviewerInput) {
          reviewerInput.disabled = msg.isReviewing;
        }
        if (branchSelect) {
          branchSelect.disabled = msg.isReviewing;
        }
        break;
      case 'models':
        if (modelSelect) {
          modelSelect.innerHTML = '';
          var models = msg.models || [];
          if (models.length === 0) {
            var opt = document.createElement('option');
            opt.value = 'copilot-gpt-4o';
            opt.textContent = 'copilot-gpt-4o (default)';
            modelSelect.appendChild(opt);
          } else {
            for (var i = 0; i < models.length; i++) {
              var opt = document.createElement('option');
              opt.value = models[i];
              opt.textContent = models[i];
              if (models[i] === msg.currentModel) {
                opt.selected = true;
              }
              modelSelect.appendChild(opt);
            }
          }
        }
        break;
      case 'branches':
        if (branchSelect) {
          branchSelect.innerHTML = '';
          var branches = msg.branches || [];
          var currentBranch = msg.currentBranch || '';
          // Add current branch option first (for uncommitted changes)
          var currentOpt = document.createElement('option');
          currentOpt.value = currentBranch;
          currentOpt.textContent = currentBranch + ' (uncommitted changes)';
          branchSelect.appendChild(currentOpt);
          // Add other branches
          for (var i = 0; i < branches.length; i++) {
            if (branches[i] !== currentBranch) {
              var opt = document.createElement('option');
              opt.value = branches[i];
              opt.textContent = branches[i];
              branchSelect.appendChild(opt);
            }
          }
        }
        break;
    }
  });
})();
</script>
</body>
</html>`;
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
