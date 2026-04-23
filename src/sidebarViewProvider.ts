import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import { ReviewFinding } from './types';
import { debugLog } from './extension';
import { getReviewerPersonalities, SUPPORTED_LANGUAGES } from './copilotReviewer';
import { PrDiffFetcher } from './prDiffFetcher';
import { getSidebarWebviewHtml } from './webview/sidebarWebviewHtml';

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
            } else if (msg.type === 'fetchPrFindings') {
                if (typeof msg.prNumber === 'number' && msg.prNumber > 0) {
                    void vscode.commands.executeCommand('prReviewer.fetchPrFindings', msg.prNumber);
                }
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
        const nonce = getNonce();

        const rawFontSize = config.get<number>('fontSize', 0);
        const fontSize = rawFontSize > 0
            ? Math.max(8, Math.min(32, Number.isFinite(rawFontSize) ? rawFontSize : 0))
            : 0;

        const rawFontFamily = config.get<string>('fontFamily', '');
        const fontFamilyPattern = /^[a-zA-Z0-9\s\-,._'"]+$/;
        let fontFamily = '';
        if (typeof rawFontFamily === 'string' && rawFontFamily.trim()) {
            if (fontFamilyPattern.test(rawFontFamily)) {
                fontFamily = rawFontFamily.trim()
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/"/g, '\\"');
            } else {
                void vscode.window.showWarningMessage(
                    `PR Reviewer: Font family "${rawFontFamily.slice(0, 50)}" contains invalid characters and will be ignored.`
                );
                debugLog(`[Font] Invalid font family rejected: ${rawFontFamily}`);
            }
        }

        const dispSize = 128;

        return getSidebarWebviewHtml({
            webview,
            extensionUri: this.extensionUri,
            nonce,
            fontFamily,
            fontSize,
            dispSize,
            idleUri: idleUri.toString(),
            idleCols,
            idleRows,
            workUri: workUri.toString(),
            workCols,
            workRows,
        });
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
