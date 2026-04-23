import * as vscode from 'vscode';

export interface SidebarWebviewHtmlParams {
    webview: vscode.Webview;
    extensionUri: vscode.Uri;
    nonce: string;
    fontFamily: string;
    fontSize: number;
    dispSize: number;
    idleUri: string;
    idleCols: number;
    idleRows: number;
    workUri: string;
    workCols: number;
    workRows: number;
}

export function getSidebarWebviewHtml(params: SidebarWebviewHtmlParams): string {
    const {
        webview, extensionUri, nonce, fontFamily, fontSize,
        dispSize, idleUri, idleCols, idleRows, workUri, workCols, workRows,
    } = params;

    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.js'));

    const fontFamilyCss = fontFamily ? `'${fontFamily}', ` : '';
    const fontSizeCss = fontSize > 0 ? `${fontSize}px` : 'var(--vscode-font-size)';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src ${webview.cspSource} https: data:;
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Reviewer</title>
  <link rel="stylesheet" href="${cssUri}">
  <style>
    :root {
      --pr-reviewer-font-family: ${fontFamilyCss}var(--vscode-font-family);
      --pr-reviewer-font-size: ${fontSizeCss};
      --pr-disp-size: ${dispSize}px;
      --pr-idle-bg-image: url('${idleUri}');
      --pr-idle-bg-size: ${dispSize * idleCols}px ${dispSize * idleRows}px;
    }
  </style>
</head>
<body>

<div id="stage">
  <div id="sprite-wrap">
    <div id="sprite"></div>
  </div>
  <div id="bubble">Ready to eviscerate some code\u2026</div>
</div>

<div id="status-bar">
  <span id="status-icon">\u{1F4A4}</span>
  <span id="status-text">Idle \u2014 waiting for review</span>
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
      <label for="personality-select">Reviewer Personality</label>
      <select id="personality-select" class="model-dropdown">
        <option value="">Loading personalities...</option>
      </select>
    </div>
    <div class="input-row">
      <label for="language-select">Response Language</label>
      <select id="language-select" class="model-dropdown">
        <option value="">Loading languages...</option>
      </select>
    </div>
    <div class="input-row">
      <label for="extra-instructions">Extra Instructions</label>
      <textarea id="extra-instructions" class="extra-instructions" rows="2" placeholder="e.g. Focus on security issues only..."></textarea>
    </div>
    <div class="btn-row">
      <button class="review-btn" id="start-btn">Start Review</button>
      <button class="fetch-btn" id="fetch-btn">Fetch PR Findings</button>
    </div>
  </div>
</div>

<script nonce="${nonce}">
  window.__PR_REVIEWER_CONFIG = ${JSON.stringify({ dispSize, idleUri, idleCols, idleRows, workUri, workCols, workRows })};
</script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
