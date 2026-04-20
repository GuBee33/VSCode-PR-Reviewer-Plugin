import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import { ReviewFinding } from './types';
import { debugLog } from './extension';
import { getReviewerPersonalities, SUPPORTED_LANGUAGES } from './copilotReviewer';
import { PrDiffFetcher } from './prDiffFetcher';

type CharacterState = 'idle' | 'thinking' | 'talking' | 'laughing';

/**
 * Sidebar WebviewViewProvider – renders the animated character,
 * a speech bubble, progress log, and review findings inside the Activity Bar panel.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'prReviewer.characterView';

    private view?: vscode.WebviewView;
    private pendingMessages: Array<Record<string, unknown>> = [];
    private configWatcher?: vscode.Disposable;
    private isHtmlReady = false;
    private readonly context: vscode.ExtensionContext;

    constructor(private readonly extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.context = context;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        this.isHtmlReady = false;

        // Dispose previous config watcher if re-resolving
        this.configWatcher?.dispose();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: this.buildLocalResourceRoots(),
        };

        // Build HTML async to support async sprite validation
        void this.buildHtml(webviewView.webview).then(html => {
            webviewView.webview.html = html;
            this.isHtmlReady = true;
            // Flush any messages that arrived before the view was ready
            for (const msg of this.pendingMessages) {
                void webviewView.webview.postMessage(msg);
            }
            this.pendingMessages = [];
        }).catch(err => {
            debugLog(`[Panel] Failed to build HTML: ${err}`);
            webviewView.webview.html = '<html><body>Error loading panel.</body></html>';
            this.isHtmlReady = true;
        });

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'navigate') {
                this.navigateToFile(msg.file, msg.line);
            } else if (msg.type === 'startReview') {
                void vscode.commands.executeCommand('prReviewer.reviewPR', {
                    model: typeof msg.model === 'string' ? msg.model : undefined,
                    personalityId: typeof msg.personalityId === 'string' ? msg.personalityId : undefined,
                    baseBranch: typeof msg.baseBranch === 'string' ? msg.baseBranch : undefined,
                    extraInstructions: typeof msg.extraInstructions === 'string' ? msg.extraInstructions : undefined,
                    language: typeof msg.language === 'string' ? msg.language : undefined,
                    prNumber: typeof msg.prNumber === 'number' ? msg.prNumber : undefined,
                });
            } else if (msg.type === 'requestModels') {
                this.sendAvailableModels();
            } else if (msg.type === 'requestBranches') {
                this.sendAvailableBranches();
            } else if (msg.type === 'requestPRs') {
                void this.sendAvailablePRs().catch(err => debugLog(`[PRs] sendAvailablePRs failed: ${err}`));
            } else if (msg.type === 'requestPersonalities') {
                this.sendAvailablePersonalities();
            } else if (msg.type === 'requestLanguages') {
                this.sendAvailableLanguages();
            } else if (msg.type === 'saveSettings') {
                this.saveSettings(msg.settings);
            } else if (msg.type === 'loadSettings') {
                this.sendSavedSettings();
            } else if (msg.type === 'fixWithCopilot') {
                this.fixWithCopilot(msg.finding);
            } else if (msg.type === 'fixAllWithCopilot') {
                this.fixAllWithCopilot(msg.findings);
            }
        });

        // Watch for config changes that require webview reload
        this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('prReviewer.customIdleSprite') || 
                e.affectsConfiguration('prReviewer.customWorkSprite') ||
                e.affectsConfiguration('prReviewer.idleSpriteRows') ||
                e.affectsConfiguration('prReviewer.idleSpriteCols') ||
                e.affectsConfiguration('prReviewer.workSpriteRows') ||
                e.affectsConfiguration('prReviewer.workSpriteCols') ||
                e.affectsConfiguration('prReviewer.fontSize') ||
                e.affectsConfiguration('prReviewer.fontFamily')) {
                debugLog('[Webview] Configuration changed, reloading webview...');
                // Update localResourceRoots (needed for custom sprites)
                this.updateWebviewOptions(webviewView);
                // Rebuild HTML with new sprite
                this.isHtmlReady = false;
                void this.buildHtml(webviewView.webview).then(html => {
                    webviewView.webview.html = html;
                    this.isHtmlReady = true;
                }).catch(err => {
                    debugLog(`[Panel] Failed to rebuild HTML: ${err}`);
                    this.isHtmlReady = true;
                });
            }
        });
        
        // Clean up on dispose
        webviewView.onDidDispose(() => {
            this.view = undefined;
            this.configWatcher?.dispose();
            this.configWatcher = undefined;
        });
    }

    /** Build localResourceRoots including custom sprite directories */
    private buildLocalResourceRoots(): vscode.Uri[] {
        const roots: vscode.Uri[] = [
            vscode.Uri.file(path.join(this.extensionUri.fsPath, 'media')),
        ];

        const config = vscode.workspace.getConfiguration('prReviewer');
        const customIdle = config.get<string>('customIdleSprite', '');
        const customWork = config.get<string>('customWorkSprite', '');
        
        if (customIdle) {
            const idleDir = path.dirname(customIdle);
            roots.push(vscode.Uri.file(idleDir));
            debugLog(`[Webview] Added localResourceRoot: ${idleDir}`);
        }
        if (customWork) {
            const workDir = path.dirname(customWork);
            if (workDir !== path.dirname(customIdle)) {
                roots.push(vscode.Uri.file(workDir));
                debugLog(`[Webview] Added localResourceRoot: ${workDir}`);
            }
        }

        return roots;
    }

    /** Update webview options with current sprite directories */
    private updateWebviewOptions(webviewView: vscode.WebviewView): void {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: this.buildLocalResourceRoots(),
        };
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

    /** Reset the panel to initial state. */
    resetPanel(): void {
        if (!this.view) {
            debugLog('[Panel] resetPanel called but webview not resolved - attempting reveal');
            this.reveal();
            // Queue the reset message so it's flushed when the view resolves
            this.pendingMessages.push({ type: 'reset' });
            return;
        }
        this.postMessage({ type: 'reset' });
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

    /** Save form settings to globalState */
    private saveSettings(settings: { baseBranch?: string; model?: string; personalityId?: string; extraInstructions?: string; language?: string }): void {
        const savedKeys: string[] = [];
        const maxLength = 1000; // Reasonable limit for settings values

        if (settings.baseBranch !== undefined && typeof settings.baseBranch === 'string' && settings.baseBranch.length <= maxLength) {
            this.context.globalState.update('prReviewer.baseBranch', settings.baseBranch)
                .then(undefined, err => debugLog(`[Settings] Failed to save baseBranch: ${err}`));
            savedKeys.push('baseBranch');
        }
        if (settings.model !== undefined && typeof settings.model === 'string' && settings.model.length <= maxLength) {
            this.context.globalState.update('prReviewer.model', settings.model)
                .then(undefined, err => debugLog(`[Settings] Failed to save model: ${err}`));
            savedKeys.push('model');
        }
        if (settings.personalityId !== undefined && typeof settings.personalityId === 'string' && settings.personalityId.length <= maxLength) {
            this.context.globalState.update('prReviewer.personalityId', settings.personalityId)
                .then(undefined, err => debugLog(`[Settings] Failed to save personalityId: ${err}`));
            savedKeys.push('personalityId');
        }
        if (settings.extraInstructions !== undefined && typeof settings.extraInstructions === 'string' && settings.extraInstructions.length <= maxLength) {
            this.context.globalState.update('prReviewer.extraInstructions', settings.extraInstructions)
                .then(undefined, err => debugLog(`[Settings] Failed to save extraInstructions: ${err}`));
            savedKeys.push('extraInstructions');
        }
        if (settings.language !== undefined && typeof settings.language === 'string' && settings.language.length <= maxLength) {
            this.context.globalState.update('prReviewer.language', settings.language)
                .then(undefined, err => debugLog(`[Settings] Failed to save language: ${err}`));
            savedKeys.push('language');
        }
        debugLog(`[Settings] Saved keys: ${savedKeys.join(', ')}`);
    }

    /** Send available reviewer personalities to the webview */
    private sendAvailablePersonalities(): void {
        const personalities = getReviewerPersonalities();
        this.postMessage({ type: 'personalities', personalities });
    }

    /** Send supported response languages to the webview */
    private sendAvailableLanguages(): void {
        this.postMessage({ type: 'languages', languages: SUPPORTED_LANGUAGES });
    }

    /** Send saved settings to webview */
    private sendSavedSettings(): void {
        const settings = {
            baseBranch: this.context.globalState.get<string>('prReviewer.baseBranch', ''),
            model: this.context.globalState.get<string>('prReviewer.model', ''),
            personalityId: this.context.globalState.get<string>('prReviewer.personalityId', 'sarcastic'),
            extraInstructions: this.context.globalState.get<string>('prReviewer.extraInstructions', ''),
            language: this.context.globalState.get<string>('prReviewer.language', 'English')
        };
        debugLog(`[Settings] Loading: baseBranch=${settings.baseBranch ? '[set]' : '[empty]'}, model=${settings.model || '[default]'}, personalityId=${settings.personalityId ? '[set]' : '[default]'}, language=${settings.language ? '[set]' : '[default]'}`);
        this.postMessage({ type: 'savedSettings', settings });
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

    /** Send open pull requests to the webview (uses GitHub REST API). */
    private async sendAvailablePRs(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            this.postMessage({ type: 'pullRequests', pullRequests: [], notAuthenticated: false });
            return;
        }
        const result = await PrDiffFetcher.listOpenPRs(workspaceRoot);
        this.postMessage({ type: 'pullRequests', pullRequests: result.prs, notAuthenticated: result.notAuthenticated || false, host: result.host || 'github.com' });
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
        if (this.view && this.isHtmlReady) {
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

    /** Fix a single finding using GitHub Copilot Chat */
    private async fixWithCopilot(finding: unknown): Promise<void> {
        // Validate finding object from untrusted webview
        const validated = this.validateFinding(finding);
        if (!validated) {
            debugLog('[Fix] Invalid finding data received from webview');
            return;
        }

        debugLog(`[Fix] Fixing finding: ${validated.title} in ${validated.file}:${validated.line}`);
        
        // Build the fix prompt
        const prompt = this.buildFixPrompt(validated);

        try {
            // Open Copilot Chat panel and send the request
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prompt,
                isPartialQuery: false  // This triggers auto-send
            });
            debugLog(`[Fix] Sent fix request to Copilot Chat for ${validated.file}:${validated.line}`);
        } catch (err) {
            debugLog(`[Fix] Error: ${err}`);
            vscode.window.showErrorMessage(`Failed to fix: ${err}`);
        }
    }

    /** Fix all findings using GitHub Copilot Chat */
    private async fixAllWithCopilot(findings: unknown): Promise<void> {
        // Validate findings array from untrusted webview
        if (!Array.isArray(findings)) {
            debugLog('[Fix All] Invalid findings data received from webview');
            return;
        }

        const validatedFindings: ReviewFinding[] = [];
        for (const f of findings) {
            const validated = this.validateFinding(f);
            if (validated) {
                validatedFindings.push(validated);
            }
        }

        if (validatedFindings.length === 0) {
            debugLog('[Fix All] No valid findings to fix');
            return;
        }

        debugLog(`[Fix All] Fixing ${validatedFindings.length} findings`);
        
        // Group findings by file for efficiency
        const findingsByFile = new Map<string, ReviewFinding[]>();
        for (const finding of validatedFindings) {
            const existing = findingsByFile.get(finding.file) || [];
            existing.push(finding);
            findingsByFile.set(finding.file, existing);
        }

        // Build a comprehensive fix prompt
        let prompt = 'Fix the following code review issues:\n\n';
        
        for (const [file, fileFindings] of findingsByFile) {
            prompt += `## ${file}\n`;
            for (const f of fileFindings) {
                prompt += `- **Line ${f.line}** (${f.severity}): ${f.title}\n`;
                prompt += `  ${f.message}\n`;
                if (f.suggestion) {
                    prompt += `  Suggestion: ${f.suggestion}\n`;
                }
                prompt += '\n';
            }
        }

        try {
            // Open Copilot Chat panel and send the request
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prompt,
                isPartialQuery: false  // This triggers auto-send
            });
            debugLog(`[Fix All] Sent fix request to Copilot Chat for ${validatedFindings.length} findings`);
        } catch (err) {
            debugLog(`[Fix All] Error: ${err}`);
            vscode.window.showErrorMessage(`Failed to open fix session: ${err}`);
        }
    }

    /** Validate and sanitize a finding object from untrusted webview */
    private validateFinding(finding: unknown): ReviewFinding | null {
        if (!finding || typeof finding !== 'object') {
            return null;
        }

        const f = finding as Record<string, unknown>;
        const maxStringLength = 2000;
        const maxPathLength = 500;

        // Validate required fields
        if (typeof f.file !== 'string' || f.file.length === 0 || f.file.length > maxPathLength) {
            return null;
        }
        if (typeof f.line !== 'number' || !Number.isInteger(f.line) || f.line < -1 || f.line > 1000000) {
            return null;
        }
        if (typeof f.severity !== 'string' || !['error', 'warning', 'info'].includes(f.severity)) {
            return null;
        }
        if (typeof f.title !== 'string' || f.title.length === 0 || f.title.length > maxStringLength) {
            return null;
        }
        if (typeof f.message !== 'string' || f.message.length > maxStringLength) {
            return null;
        }

        // Validate optional fields
        if (f.suggestion !== undefined && (typeof f.suggestion !== 'string' || f.suggestion.length > maxStringLength)) {
            return null;
        }

        return {
            file: f.file,
            line: f.line,
            severity: f.severity as 'error' | 'warning' | 'info',
            title: f.title,
            message: f.message,
            suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined
        };
    }

    /** Build a prompt for fixing a single finding */
    private buildFixPrompt(finding: ReviewFinding): string {
        let prompt = `Fix this ${finding.severity} in ${finding.file} at line ${finding.line}:\n\n`;
        prompt += `**${finding.title}**\n`;
        prompt += `${finding.message}`;
        if (finding.suggestion) {
            prompt += `\n\nSuggested fix: ${finding.suggestion}`;
        }
        return prompt;
    }

    private getSpriteUri(webview: vscode.Webview, filename: string): vscode.Uri {
        const builtIn = vscode.Uri.file(
            path.join(this.extensionUri.fsPath, 'media', filename)
        );
        return webview.asWebviewUri(builtIn);
    }

    private async getCustomSpriteUri(webview: vscode.Webview, absolutePath: string): Promise<vscode.Uri | null> {
        if (!absolutePath) {
            return null;
        }

        // Validate path: must be a PNG file
        if (!absolutePath.toLowerCase().endsWith('.png')) {
            debugLog(`[Sprite] Invalid sprite path (not a .png file): ${absolutePath}`);
            return null;
        }

        // Validate against path traversal: resolved path must not escape the workspace
        const resolved = path.resolve(absolutePath);
        const normalizedResolved = path.normalize(resolved);
        
        // On Windows, paths can have different casing or slash directions but still be valid
        // Check that normalization produces a consistent result and path is absolute
        if (!path.isAbsolute(absolutePath)) {
            debugLog(`[Sprite] Rejected sprite path (not absolute): ${absolutePath}`);
            return null;
        }
        
        // Validate against workspace folder to prevent arbitrary file access
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot && !normalizedResolved.startsWith(path.normalize(workspaceRoot))) {
            debugLog(`[Sprite] Rejected sprite path (outside workspace): ${absolutePath}`);
            return null;
        }

        // Async file existence check
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
        } catch {
            debugLog(`[Sprite] Custom sprite file not found: ${absolutePath}`);
            return null;
        }

        try {
            const fileUri = vscode.Uri.file(absolutePath);
            return webview.asWebviewUri(fileUri);
        } catch (e) {
            debugLog(`[Sprite] Failed to load custom sprite: ${absolutePath}: ${e}`);
            return null;
        }
    }

    private async buildHtml(webview: vscode.Webview): Promise<string> {
        // Check for custom sprites and their configurations
        const config = vscode.workspace.getConfiguration('prReviewer');
        const customIdle = config.get<string>('customIdleSprite', '');
        const customWork = config.get<string>('customWorkSprite', '');
        const idleRows = config.get<number>('idleSpriteRows', 5);
        const idleCols = config.get<number>('idleSpriteCols', 5);
        const workRows = config.get<number>('workSpriteRows', 5);
        const workCols = config.get<number>('workSpriteCols', 5);
        
        const idleUri = (await this.getCustomSpriteUri(webview, customIdle)) 
            || this.getSpriteUri(webview, 'GuBee-idle.png');
        const workUri = (await this.getCustomSpriteUri(webview, customWork)) 
            || this.getSpriteUri(webview, 'GuBee-walk.png');
        const nonce   = getNonce();

        // Font settings with validation
        const rawFontSize = config.get<number>('fontSize', 0);
        // Use 0 as sentinel for "use VS Code default"; otherwise clamp to valid range
        const fontSize = rawFontSize > 0 
            ? Math.max(8, Math.min(32, Number.isFinite(rawFontSize) ? rawFontSize : 0))
            : 0;
        
        const rawFontFamily = config.get<string>('fontFamily', '');
        // Validate font family: allow alphanumeric, spaces, hyphens, commas, dots, underscores, and quotes
        const fontFamilyPattern = /^[a-zA-Z0-9\s\-,._'"]+$/;
        let fontFamily = '';
        if (typeof rawFontFamily === 'string' && rawFontFamily.trim()) {
            if (fontFamilyPattern.test(rawFontFamily)) {
                // Escape for CSS: replace backslashes and quotes safely
                fontFamily = rawFontFamily.trim()
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/"/g, '\\"');
            } else {
                // Invalid characters detected - warn user
                void vscode.window.showWarningMessage(
                    `PR Reviewer: Font family "${rawFontFamily.slice(0, 50)}" contains invalid characters and will be ignored.`
                );
                debugLog(`[Font] Invalid font family rejected: ${rawFontFamily}`);
            }
        }

        // Display size for the sprite viewport (will be scaled based on actual sprite)
        const dispSize = 128;

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

  :root {
    --pr-reviewer-font-family: ${fontFamily ? `'${fontFamily}', ` : ''}var(--vscode-font-family);
    --pr-reviewer-font-size: ${fontSize > 0 ? `${fontSize}px` : 'var(--vscode-font-size)'};
  }

  body {
    background: var(--vscode-sideBar-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--pr-reviewer-font-family);
    font-size: var(--pr-reviewer-font-size);
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
    width: ${dispSize}px;
    height: ${dispSize}px;
    overflow: hidden;
    flex-shrink: 0;
  }

  #sprite {
    width: ${dispSize}px;
    height: ${dispSize}px;
    background-image: url('${idleUri}');
    background-size: ${dispSize * idleCols}px ${dispSize * idleRows}px;
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
  .fix-btn {
    display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; padding: 3px 8px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 3px; cursor: pointer; font-size: 0.75em;
  }
  .fix-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .fix-btn.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .fix-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .fix-all-btn {
    display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 4px 10px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; cursor: pointer; font-size: 0.8em; vertical-align: middle;
  }
  .fix-all-btn:hover { background: var(--vscode-button-hoverBackground); }
  .findings-header-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .findings-header-row .findings-header { margin-bottom: 0; }
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
  .extra-instructions {
    width: 100%; padding: 6px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 4px;
    font-size: 0.85em; font-family: inherit; resize: vertical;
  }
  .extra-instructions:focus { outline: 1px solid var(--vscode-focusBorder); }
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
  const personalitySelect = document.getElementById('personality-select');
  const branchSelect = document.getElementById('branch-select');
  const extraInstructionsInput = document.getElementById('extra-instructions');
  const languageSelect = document.getElementById('language-select');

  // Supported response languages are provided by the backend via requestLanguages/languages.

  // Sprite animation config
  const DISP_SIZE = ${dispSize};
  const IDLE_CONFIG = { url: '${idleUri}', cols: ${idleCols}, rows: ${idleRows} };
  const WORK_CONFIG = { url: '${workUri}', cols: ${workCols}, rows: ${workRows} };

  let currentFrame = 0;
  let animTimer = null;
  let currentConfig = IDLE_CONFIG;
  let isReviewing = false;

  function startAnimation(config, fps) {
    const total = config.cols * config.rows;
    if (currentConfig.url !== config.url) {
      currentConfig = config;
      sprite.style.backgroundImage = "url('" + config.url + "')";
      sprite.style.backgroundSize = (DISP_SIZE * config.cols) + 'px ' + (DISP_SIZE * config.rows) + 'px';
    }
    if (animTimer) clearInterval(animTimer);
    currentFrame = 0;
    animTimer = setInterval(function() {
      const col = currentFrame % config.cols;
      const row = Math.floor(currentFrame / config.cols);
      sprite.style.backgroundPosition = (-col * DISP_SIZE) + 'px ' + (-row * DISP_SIZE) + 'px';
      currentFrame = (currentFrame + 1) % total;
    }, 1000 / fps);
  }

  // Start in idle
  startAnimation(IDLE_CONFIG, 6);

  let talkTimer = null;

  // Personalities and messages storage
  let allPersonalities = [];
  let currentMessages = null;

  // Updates bubble to show current personality's idle message
  function updateIdleBubble() {
    if (currentMessages && !isReviewing) {
      bubble.textContent = currentMessages.idle;
    }
  }

  // Saved settings (will be populated after load)
  let savedSettings = { baseBranch: '', model: '', personalityId: 'sarcastic', extraInstructions: '', language: 'English' };
  let modelsLoaded = false;
  let branchesLoaded = false;
  let personalitiesLoaded = false;
  let languagesLoaded = false;
  let settingsLoaded = false;

  function applySavedSettings() {
    if (!settingsLoaded) return;
    const curBranchSelect = document.getElementById('branch-select');
    const curModelSelect = document.getElementById('model-select');
    const curPersonalitySelect = document.getElementById('personality-select');
    const curExtraInstructionsInput = document.getElementById('extra-instructions');
    const curLanguageSelect = document.getElementById('language-select');
    if (branchesLoaded && savedSettings.baseBranch && curBranchSelect) {
      for (let i = 0; i < curBranchSelect.options.length; i++) {
        if (curBranchSelect.options[i].value === savedSettings.baseBranch) {
          curBranchSelect.selectedIndex = i;
          break;
        }
      }
    }
    if (modelsLoaded && savedSettings.model && curModelSelect) {
      for (let i = 0; i < curModelSelect.options.length; i++) {
        if (curModelSelect.options[i].value === savedSettings.model) {
          curModelSelect.selectedIndex = i;
          break;
        }
      }
    }
    if (personalitiesLoaded && savedSettings.personalityId && curPersonalitySelect) {
      for (let i = 0; i < curPersonalitySelect.options.length; i++) {
        if (curPersonalitySelect.options[i].value === savedSettings.personalityId) {
          curPersonalitySelect.selectedIndex = i;
          // Update current messages based on selected personality
          const selectedPersonality = allPersonalities.find(function(p) { return p.id === savedSettings.personalityId; });
          if (selectedPersonality && selectedPersonality.messages) {
            currentMessages = selectedPersonality.messages;
            updateIdleBubble();
          }
          break;
        }
      }
    }
    if (savedSettings.extraInstructions && curExtraInstructionsInput) {
      curExtraInstructionsInput.value = savedSettings.extraInstructions;
    }
    if (savedSettings.language && curLanguageSelect && languagesLoaded) {
      curLanguageSelect.value = savedSettings.language;
    }
  }

  // Reusable function to attach persistence handlers to form elements
  function attachPersistenceHandlers(branchEl, modelEl, personalityEl, extraInstructionsEl, languageEl) {
    if (branchEl) {
      branchEl.addEventListener('change', function() {
        vscode.postMessage({ type: 'saveSettings', settings: { baseBranch: branchEl.value } });
      });
    }
    if (modelEl) {
      modelEl.addEventListener('change', function() {
        vscode.postMessage({ type: 'saveSettings', settings: { model: modelEl.value } });
      });
    }
    if (personalityEl) {
      personalityEl.addEventListener('change', function() {
        vscode.postMessage({ type: 'saveSettings', settings: { personalityId: personalityEl.value } });
        // Update current messages based on selected personality
        const selectedPersonality = allPersonalities.find(function(p) { return p.id === personalityEl.value; });
        if (selectedPersonality && selectedPersonality.messages) {
          currentMessages = selectedPersonality.messages;
          updateIdleBubble();
        }
      });
    }
    if (extraInstructionsEl) {
      extraInstructionsEl.addEventListener('change', function() {
        vscode.postMessage({ type: 'saveSettings', settings: { extraInstructions: extraInstructionsEl.value } });
      });
    }
    if (languageEl) {
      languageEl.addEventListener('change', function() {
        vscode.postMessage({ type: 'saveSettings', settings: { language: languageEl.value } });
      });
    }
  }

  // Request available models, branches, PRs, personalities, languages and saved settings on load
  vscode.postMessage({ type: 'requestModels' });
  vscode.postMessage({ type: 'requestBranches' });
  vscode.postMessage({ type: 'requestPRs' });
  vscode.postMessage({ type: 'requestPersonalities' });
  vscode.postMessage({ type: 'requestLanguages' });
  vscode.postMessage({ type: 'loadSettings' });

  // Save settings when values change (using reusable function)
  attachPersistenceHandlers(branchSelect, modelSelect, personalitySelect, extraInstructionsInput, languageSelect);

  if (startBtn) {
    startBtn.addEventListener('click', function() {
      const selectedModel = modelSelect ? modelSelect.value : '';
      const personalityId = personalitySelect ? personalitySelect.value : 'sarcastic';
      const baseBranchValue = branchSelect ? branchSelect.value : '';
      const extraInstructions = extraInstructionsInput ? extraInstructionsInput.value : '';
      const language = languageSelect ? languageSelect.value : 'English';
      var prNumber = undefined;
      var baseBranch = baseBranchValue;
      if (baseBranchValue.indexOf('pr:') === 0) {
        prNumber = parseInt(baseBranchValue.substring(3), 10);
        baseBranch = '';
      }
      vscode.postMessage({ type: 'startReview', model: selectedModel, personalityId: personalityId, baseBranch: baseBranch, extraInstructions: extraInstructions, language: language, prNumber: prNumber });
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
      startAnimation(WORK_CONFIG, state === 'laughing' ? 16 : 10);
    } else if (!isReviewing) {
      startAnimation(IDLE_CONFIG, 6);
    }
    // Only reset to idle after timeout if not reviewing
    if (!isReviewing) {
      talkTimer = setTimeout(function() {
        if (!isReviewing) {
          startAnimation(IDLE_CONFIG, 6);
        }
      }, 8000);
    }
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
    while (logEl.children.length > 100) logEl.removeChild(logEl.firstChild);
  }

  function clearLog() { logEl.innerHTML = ''; }

  // Shared form HTML template to avoid duplication
  function getFormHtml() {
    return '<div class="empty-state">' +
      '<div class="input-row">' +
        '<label for="branch-select">Compare Against</label>' +
        '<select id="branch-select" class="model-dropdown">' +
          '<option value="">Loading branches...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="model-select">Model</label>' +
        '<select id="model-select" class="model-dropdown">' +
          '<option value="">Loading models...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="personality-select">Reviewer Personality</label>' +
        '<select id="personality-select" class="model-dropdown">' +
          '<option value="">Loading personalities...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="language-select">Response Language</label>' +
        '<select id="language-select" class="model-dropdown">' +
          '<option value="">Loading languages...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="extra-instructions">Extra Instructions</label>' +
        '<textarea id="extra-instructions" class="extra-instructions" rows="3" placeholder="e.g. Focus on security issues, ignore style..."></textarea>' +
      '</div>' +
      '<button class="review-btn" id="start-btn">Start Review</button>' +
    '</div>';
  }

  // Binds event handlers to form elements after DOM insertion
  function bindFormHandlers() {
    const newStartBtn = document.getElementById('start-btn');
    const newModelSelect = document.getElementById('model-select');
    const newPersonalitySelect = document.getElementById('personality-select');
    const newBranchSelect = document.getElementById('branch-select');
    const newExtraInstructionsInput = document.getElementById('extra-instructions');
    const newLanguageSelect = document.getElementById('language-select');
    if (newStartBtn) {
      newStartBtn.addEventListener('click', function() {
        const selectedModel = newModelSelect ? newModelSelect.value : '';
        const personalityId = newPersonalitySelect ? newPersonalitySelect.value : 'sarcastic';
        const baseBranchValue = newBranchSelect ? newBranchSelect.value : '';
        const extraInstructions = newExtraInstructionsInput ? newExtraInstructionsInput.value : '';
        const language = newLanguageSelect ? newLanguageSelect.value : 'English';
        var prNumber = undefined;
        var baseBranch = baseBranchValue;
        if (baseBranchValue.indexOf('pr:') === 0) {
          prNumber = parseInt(baseBranchValue.substring(3), 10);
          baseBranch = '';
        }
        vscode.postMessage({ type: 'startReview', model: selectedModel, personalityId: personalityId, baseBranch: baseBranch, extraInstructions: extraInstructions, language: language, prNumber: prNumber });
      });
    }
    attachPersistenceHandlers(newBranchSelect, newModelSelect, newPersonalitySelect, newExtraInstructionsInput, newLanguageSelect);
  }

  function resetToInitialState() {
    // Reset reviewing state
    isReviewing = false;
    // Clear log
    logEl.innerHTML = '';
    // Reset status
    setStatus('💤', 'Idle — waiting for review');
    // Reset bubble (will be updated when personalities load)
    bubble.textContent = currentMessages ? currentMessages.idle : 'Ready to eviscerate some code…';
    // Reset animation
    startAnimation(IDLE_CONFIG, 6);
    // Restore initial empty state with form using shared template
    container.innerHTML = getFormHtml();
    // Bind event handlers
    bindFormHandlers();
    // Reset loaded flags and request fresh data
    modelsLoaded = false;
    branchesLoaded = false;
    personalitiesLoaded = false;
    languagesLoaded = false;
    settingsLoaded = false;
    vscode.postMessage({ type: 'requestModels' });
    vscode.postMessage({ type: 'requestBranches' });
    vscode.postMessage({ type: 'requestPRs' });
    vscode.postMessage({ type: 'requestPersonalities' });
    vscode.postMessage({ type: 'requestLanguages' });
    vscode.postMessage({ type: 'loadSettings' });
  }

  function renderFindings(findings) {
    if (!findings || findings.length === 0) {
      const noIssuesMsg = currentMessages ? currentMessages.quips.noIssues : 'No findings. Either your code is decent, or I\\'ve gone blind.';
      container.innerHTML = '<div class="empty-state">' + escHtml(noIssuesMsg) + '</div>';
      showBubble(noIssuesMsg, 'idle');
      setStatus('✅', 'Review complete — no issues');
      return;
    }

    // Store findings for fix-all functionality
    window.currentFindings = findings;

    const errors   = findings.filter(function(f) { return f.severity === 'error'; }).length;
    const warnings = findings.filter(function(f) { return f.severity === 'warning'; }).length;
    const infos    = findings.filter(function(f) { return f.severity === 'info'; }).length;

    const summaryLine = 'Found ' + findings.length + ' issue' + (findings.length !== 1 ? 's' : '') + ': ' +
      errors + ' error' + (errors !== 1 ? 's' : '') + ', ' +
      warnings + ' warning' + (warnings !== 1 ? 's' : '') + ', ' +
      infos + ' note' + (infos !== 1 ? 's' : '') + '.';

    const quip = pickQuip(errors, warnings, findings.length);
    showBubble(quip, errors > 0 ? 'laughing' : 'talking');
    setStatus(errors > 0 ? '🔴' : warnings > 0 ? '🟡' : '🔵', summaryLine);

    let html = '<div class="findings-header-row">' +
      '<div class="findings-header">' + escHtml(summaryLine) + '</div>' +
      '<button class="fix-all-btn" id="fix-all-btn">✨ Fix All with Copilot</button>' +
    '</div>';
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      const icon = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
      const loc = f.line > 0 ? f.file + ':' + f.line : f.file;
      html +=
        '<div class="finding ' + escHtml(f.severity) + '" data-file="' + escHtml(f.file) + '" data-line="' + f.line + '" data-finding-index="' + i + '">' +
          '<div class="finding-header">' + icon + ' <span class="badge ' + escHtml(f.severity) + '">' + escHtml(f.severity) + '</span> ' + escHtml(f.title) + '</div>' +
          '<div class="finding-location">' + escHtml(loc) + '</div>' +
          '<div class="finding-message">' + escHtml(f.message) + '</div>' +
          (f.suggestion ? '<div class="finding-suggestion">💡 ' + escHtml(f.suggestion) + '</div>' : '') +
          '<button class="fix-btn">✨ Fix with Copilot</button>' +
        '</div>';
    }
    container.innerHTML = html;

    // Navigate to file on finding click (but not on button click)
    container.querySelectorAll('.finding').forEach(function(el) {
      el.addEventListener('click', function(e) {
        if (e.target.classList.contains('fix-btn')) return;
        vscode.postMessage({ type: 'navigate', file: el.dataset.file, line: parseInt(el.dataset.line, 10) });
      });
    });

    // Fix individual finding - look up by index instead of parsing JSON from data attribute
    container.querySelectorAll('.fix-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const findingEl = btn.closest('.finding');
        const index = parseInt(findingEl.dataset.findingIndex, 10);
        const finding = window.currentFindings[index];
        if (finding) {
          vscode.postMessage({ type: 'fixWithCopilot', finding: finding });
        }
      });
    });

    // Fix all findings
    const fixAllBtn = document.getElementById('fix-all-btn');
    if (fixAllBtn) {
      fixAllBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'fixAllWithCopilot', findings: window.currentFindings });
      });
    }
  }

  function pickQuip(errors, warnings, total) {
    const q = currentMessages ? currentMessages.quips : null;
    if (errors > 5)  return q ? q.manyErrors : "Oh my god. This isn't code, it's a hate crime against computers.";
    if (errors > 2)  return q ? q.someErrors : "I've seen better code written by a drunk toddler.";
    if (errors > 0)  return q ? q.fewErrors : "There are errors in here. Real ones. Not just the ones in your life choices.";
    if (warnings > 3) return q ? q.manyWarnings : "No disasters, but the warnings tell a story. A sad one.";
    if (warnings > 0) return q ? q.someWarnings : "Could be worse. Could be better. Mostly just… there.";
    if (total === 0)  return q ? q.noIssues : "I can't find anything. Either it's fine or you've broken my scanner.";
    return q ? q.default : "A few things to note. Do take it personally.";
  }

  function escHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  window.addEventListener('message', function(event) {
    const msg = event.data;
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
        startAnimation(WORK_CONFIG, 10);
        break;
      case 'reviewingState':
        isReviewing = msg.isReviewing;
        const curStartBtn = document.getElementById('start-btn');
        const curModelSelect = document.getElementById('model-select');
        const curPersonalitySelect = document.getElementById('personality-select');
        const curBranchSelect = document.getElementById('branch-select');
        const curExtraInstructionsInput = document.getElementById('extra-instructions');
        if (curStartBtn) {
          curStartBtn.style.display = msg.isReviewing ? 'none' : 'inline-block';
        }
        if (curModelSelect) {
          curModelSelect.disabled = msg.isReviewing;
        }
        if (curPersonalitySelect) {
          curPersonalitySelect.disabled = msg.isReviewing;
        }
        if (curBranchSelect) {
          curBranchSelect.disabled = msg.isReviewing;
        }
        if (curExtraInstructionsInput) {
          curExtraInstructionsInput.disabled = msg.isReviewing;
        }
        const curLanguageSelect = document.getElementById('language-select');
        if (curLanguageSelect) {
          curLanguageSelect.disabled = msg.isReviewing;
        }
        // Start work animation when reviewing starts, go to idle when done
        if (msg.isReviewing) {
          startAnimation(WORK_CONFIG, 10);
        } else {
          startAnimation(IDLE_CONFIG, 6);
        }
        break;
      case 'models': {
        const modelSelect = document.getElementById('model-select');
        if (modelSelect) {
          modelSelect.innerHTML = '';
          const models = msg.models || [];
          if (models.length === 0) {
            const opt = document.createElement('option');
            opt.value = 'copilot-gpt-4o';
            opt.textContent = 'copilot-gpt-4o (default)';
            modelSelect.appendChild(opt);
          } else {
            for (let i = 0; i < models.length; i++) {
              const opt = document.createElement('option');
              opt.value = models[i];
              opt.textContent = models[i];
              if (models[i] === msg.currentModel) {
                opt.selected = true;
              }
              modelSelect.appendChild(opt);
            }
          }
          modelsLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'branches': {
        const branchSelect = document.getElementById('branch-select');
        if (branchSelect) {
          branchSelect.innerHTML = '';
          const branches = msg.branches || [];
          const currentBranch = msg.currentBranch || '';
          // Add current branch option first (for uncommitted changes)
          const currentOpt = document.createElement('option');
          currentOpt.value = currentBranch;
          currentOpt.textContent = currentBranch + ' (uncommitted changes)';
          branchSelect.appendChild(currentOpt);
          // Add other branches
          for (let i = 0; i < branches.length; i++) {
            if (branches[i] !== currentBranch) {
              const opt = document.createElement('option');
              opt.value = branches[i];
              opt.textContent = branches[i];
              branchSelect.appendChild(opt);
            }
          }
          branchesLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'pullRequests': {
        const branchSelect = document.getElementById('branch-select');
        // Remove any existing PR optgroup or auth warning before re-adding
        var existingPrGroup = branchSelect ? branchSelect.querySelector('optgroup[data-pr-group]') : null;
        if (existingPrGroup) existingPrGroup.remove();
        var existingAuthWarn = document.getElementById('gh-auth-warning');
        if (existingAuthWarn) existingAuthWarn.remove();

        if (msg.notAuthenticated) {
          // Show a warning message with instructions to sign in
          var branchRow = branchSelect ? branchSelect.closest('.input-row') : null;
          if (branchRow) {
            var warn = document.createElement('div');
            warn.id = 'gh-auth-warning';
            warn.style.cssText = 'font-size:0.75em; color:var(--vscode-editorWarning-foreground,#cca700); margin-top:4px; line-height:1.4;';
            var isGHE = msg.host && msg.host !== 'github.com';
            if (isGHE) {
              warn.innerHTML = '⚠️ To list open PRs, sign in to GitHub Enterprise: open the Command Palette (<b>Cmd+Shift+P</b>) and run <b>"GitHub Enterprise: Sign In"</b>, or add a PAT for <b>' + msg.host + '</b> in Settings.';
            } else {
              warn.innerHTML = '⚠️ To list open PRs, sign in to GitHub: open the Command Palette (<b>Cmd+Shift+P</b>) and run <b>"GitHub: Sign In"</b>.';
            }
            branchRow.appendChild(warn);
          }
        } else if (branchSelect && msg.pullRequests && msg.pullRequests.length > 0) {
          var prGroup = document.createElement('optgroup');
          prGroup.label = 'Open Pull Requests';
          prGroup.setAttribute('data-pr-group', 'true');
          for (var i = 0; i < msg.pullRequests.length; i++) {
            var pr = msg.pullRequests[i];
            var opt = document.createElement('option');
            opt.value = 'pr:' + pr.number;
            opt.textContent = 'PR #' + pr.number + ': ' + pr.title + ' (' + pr.headRefName + ' \u2192 ' + pr.baseRefName + ')';
            prGroup.appendChild(opt);
          }
          branchSelect.insertBefore(prGroup, branchSelect.firstChild);
        }
        break;
      }
      case 'personalities': {
        const personalitySelect = document.getElementById('personality-select');
        if (personalitySelect) {
          personalitySelect.innerHTML = '';
          const personalities = msg.personalities || [];
          allPersonalities = personalities;
          for (let i = 0; i < personalities.length; i++) {
            const opt = document.createElement('option');
            opt.value = personalities[i].id;
            opt.textContent = personalities[i].name;
            opt.title = personalities[i].description;
            personalitySelect.appendChild(opt);
          }
          // Set default messages from first personality (sarcastic)
          if (personalities.length > 0 && personalities[0].messages) {
            currentMessages = personalities[0].messages;
            updateIdleBubble();
          }
          personalitiesLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'languages': {
        const langSelect = document.getElementById('language-select');
        if (langSelect) {
          langSelect.innerHTML = '';
          const languages = msg.languages || [];
          for (let i = 0; i < languages.length; i++) {
            const opt = document.createElement('option');
            opt.value = languages[i];
            opt.textContent = languages[i];
            langSelect.appendChild(opt);
          }
          // Default to English if no saved setting yet
          langSelect.value = savedSettings.language || 'English';
          languagesLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'savedSettings':
        if (msg.settings) {
          savedSettings = msg.settings;
          settingsLoaded = true;
          applySavedSettings();
        }
        break;
      case 'reset':
        resetToInitialState();
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
