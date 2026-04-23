import * as vscode from 'vscode';
import { SidebarViewProvider } from './sidebarViewProvider';
import { StatusBarCharacter } from './statusBarCharacter';
import { PrDiffFetcher } from './prDiffFetcher';
import { CopilotReviewer, getPersonalityMessages } from './copilotReviewer';
import { CodeDecorator } from './codeDecorator';

/** Options for the reviewPR command */
export interface ReviewOptions {
    model?: string;
    personalityId?: string;
    baseBranch?: string;
    extraInstructions?: string;
    language?: string;
    prNumber?: number;
}

let decorator: CodeDecorator | undefined;
export let outputChannel: vscode.OutputChannel;

/** Cached debug flag – updated via onDidChangeConfiguration */
let isDebugEnabled = false;

/** Initialize debug flag from configuration */
function updateDebugFlag(): void {
    const config = vscode.workspace.getConfiguration('prReviewer');
    isDebugEnabled = config.get<boolean>('debugOutput', false);
}

/** Log to output channel only if debug is enabled */
export function debugLog(message: string): void {
    if (isDebugEnabled) {
        outputChannel.appendLine(message);
    }
}

/** Show output channel only if debug is enabled */
export function showDebugOutput(): void {
    if (isDebugEnabled) {
        outputChannel.show(true);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('PR Reviewer');
    context.subscriptions.push(outputChannel);

    // Initialize and subscribe to debug flag changes
    updateDebugFlag();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('prReviewer.debugOutput')) {
                updateDebugFlag();
            }
        })
    );
    
    decorator = new CodeDecorator(context);

    // Sidebar character view
    const sidebarProvider = new SidebarViewProvider(context.extensionUri, context);
    const sidebarReg = vscode.window.registerWebviewViewProvider(
        SidebarViewProvider.viewId,
        sidebarProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
    );

    // Status bar character (bottom-left)
    const statusBar = new StatusBarCharacter();

    // Handle messages from the sidebar webview (e.g. "Start Review" button)
    // The webview posts { type: 'startReview' } which triggers the command
    // This is handled inside SidebarViewProvider via onDidReceiveMessage

    const reviewCmd = vscode.commands.registerCommand('prReviewer.reviewPR', async (options?: ReviewOptions | string, personalityId?: string, baseBranch?: string, extraInstructions?: string) => {
        // Support both new options object API and legacy positional parameters
        let opts: ReviewOptions;
        if (typeof options === 'object' && options !== null) {
            opts = options;
        } else {
            // Legacy positional API (deprecated)
            if (options !== undefined || personalityId !== undefined || baseBranch !== undefined || extraInstructions !== undefined) {
                debugLog('[Deprecated] Using legacy positional API for reviewPR command. Use { model, personalityId, baseBranch, extraInstructions } object instead.');
            }
            opts = {
                model: typeof options === 'string' ? options : undefined,
                personalityId: typeof personalityId === 'string' ? personalityId : undefined,
                baseBranch: typeof baseBranch === 'string' ? baseBranch : undefined,
                extraInstructions: typeof extraInstructions === 'string' ? extraInstructions : undefined
            };
        }
        
        // Runtime validation for opts fields (commands can pass arbitrary args)
        const validatedOpts: ReviewOptions = {
            model: typeof opts.model === 'string' ? opts.model : undefined,
            personalityId: typeof opts.personalityId === 'string' ? opts.personalityId : undefined,
            baseBranch: typeof opts.baseBranch === 'string' ? opts.baseBranch : undefined,
            extraInstructions: typeof opts.extraInstructions === 'string' ? opts.extraInstructions : undefined,
            language: typeof opts.language === 'string' ? opts.language : undefined,
            prNumber: typeof opts.prNumber === 'number' && Number.isInteger(opts.prNumber) && opts.prNumber > 0 ? opts.prNumber : undefined
        };
        
        sidebarProvider.reveal();
        await runReview(context, decorator!, sidebarProvider, statusBar, validatedOpts);
    });

    const clearCmd = vscode.commands.registerCommand('prReviewer.clearDecorations', () => {
        decorator?.clearAll();
        vscode.window.showInformationMessage('PR Reviewer: All decorations cleared.');
    });

    const resetCmd = vscode.commands.registerCommand('prReviewer.resetPanel', () => {
        decorator?.clearAll();
        sidebarProvider.resetPanel();
    });

    const settingsCmd = vscode.commands.registerCommand('prReviewer.openSettings', () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'prReviewer');
    });

    // Sprite file browser commands
    const browseIdleSpriteCmd = vscode.commands.registerCommand('prReviewer.browseIdleSprite', async () => {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'PNG Images': ['png'] },
            title: 'Select Idle Sprite Sheet'
        });
        if (result && result[0]) {
            const config = vscode.workspace.getConfiguration('prReviewer');
            await config.update('customIdleSprite', result[0].fsPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Idle sprite set to: ${result[0].fsPath}`);
        }
    });

    const browseWorkSpriteCmd = vscode.commands.registerCommand('prReviewer.browseWorkSprite', async () => {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'PNG Images': ['png'] },
            title: 'Select Work Sprite Sheet'
        });
        if (result && result[0]) {
            const config = vscode.workspace.getConfiguration('prReviewer');
            await config.update('customWorkSprite', result[0].fsPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Work sprite set to: ${result[0].fsPath}`);
        }
    });

    const clearIdleSpriteCmd = vscode.commands.registerCommand('prReviewer.clearIdleSprite', async () => {
        const config = vscode.workspace.getConfiguration('prReviewer');
        await config.update('customIdleSprite', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Custom idle sprite cleared. Using default.');
    });

    const clearWorkSpriteCmd = vscode.commands.registerCommand('prReviewer.clearWorkSprite', async () => {
        const config = vscode.workspace.getConfiguration('prReviewer');
        await config.update('customWorkSprite', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Custom work sprite cleared. Using default.');
    });

    context.subscriptions.push(sidebarReg, statusBar, reviewCmd, clearCmd, resetCmd, settingsCmd, browseIdleSpriteCmd, browseWorkSpriteCmd, clearIdleSpriteCmd, clearWorkSpriteCmd, decorator);
}

export function deactivate(): void {
    decorator?.clearAll();
}

async function runReview(
    context: vscode.ExtensionContext,
    decorator: CodeDecorator,
    sidebar: SidebarViewProvider,
    statusBar: StatusBarCharacter,
    options: ReviewOptions = {}
): Promise<void> {
    const { model: modelOverride, personalityId: personalityIdOverride, baseBranch: baseBranchOverride, extraInstructions: extraInstructionsOverride, language: languageOverride, prNumber } = options;
    
    // Get personality-specific messages (with fallback for error handling)
    let messages: import('./copilotReviewer').PersonalityMessages | undefined;
    try {
        messages = getPersonalityMessages(personalityIdOverride || 'sarcastic');
    } catch (personalityError) {
        debugLog(`[Personality] Failed to load personality: ${personalityError}`);
        // Fall through - messages will be undefined and we'll use fallback strings
    }
    
    try {
        sidebar.setReviewingState(true);
        sidebar.clearLog();
        sidebar.appendLog('🚀 Review started');
        sidebar.showMessage(messages?.reviewStart ?? '🎬 Starting review…', 'thinking');
        statusBar.setState('thinking', 'Starting review…');

        // 1. Fetch the diff
        let diff: string;
        if (prNumber) {
            sidebar.showMessage(messages?.fetchingDiff ?? '📂 Fetching PR changes…', 'thinking');
            sidebar.appendLog(`📂 Fetching diff for PR #${prNumber}…`);
            statusBar.setState('thinking', `Fetching PR #${prNumber} diff…`);
            diff = await PrDiffFetcher.getPrDiff(prNumber);
        } else {
            const fetcher = new PrDiffFetcher(baseBranchOverride);
            sidebar.showMessage(messages?.fetchingDiff ?? '📂 Fetching changes…', 'thinking');
            sidebar.appendLog('📂 Fetching diff from git…');
            statusBar.setState('thinking', 'Fetching diff…');
            diff = await fetcher.getDiff();
        }

        if (!diff || diff.trim().length === 0) {
            sidebar.appendLog('⚠️  No diff found — nothing to review', true);
            sidebar.showMessage(messages?.noDiff ?? 'No changes found to review.', 'idle');
            statusBar.setState('done', 'Nothing to review');
            sidebar.setReviewingState(false);
            return;
        }

        const diffLines = diff.trim().split('\n').length;
        sidebar.appendLog(`✅ Diff fetched — ${diffLines} line${diffLines !== 1 ? 's' : ''} changed`);

        // 2. Fetch existing PR findings (reviews, checks, etc.)
        let existingFindings: import('./types').ReviewFinding[] = [];
        if (prNumber) {
            try {
                sidebar.appendLog('📝 Fetching existing PR findings...');
                existingFindings = await PrDiffFetcher.getPrFindings(prNumber);
                if (existingFindings.length > 0) {
                    sidebar.appendLog(`✅ Fetched ${existingFindings.length} existing finding${existingFindings.length !== 1 ? 's' : ''}`);
                }
            } catch (err) {
                debugLog(`[Review] Failed to fetch PR findings: ${err}`);
                // Continue without existing findings
                sidebar.appendLog(`⚠️  Could not fetch existing PR findings`, false);
            }
        }

        // 3. Send to Copilot
        sidebar.showMessage(messages?.reviewing ?? '🤔 Reviewing code…', 'thinking');
        sidebar.appendLog('🤖 Sending diff to Copilot for review…');
        statusBar.setState('thinking', `Reviewing ${diffLines} lines…`);
        const reviewer = new CopilotReviewer({ model: modelOverride, personalityId: personalityIdOverride, extraInstructions: extraInstructionsOverride, language: languageOverride });
        const copilotFindings = await reviewer.review(diff);

        // Merge findings: mark Copilot findings with source if not set
        const mergedFindings = [
            ...existingFindings,
            ...(copilotFindings || []).map(f => ({ ...f, source: f.source || 'copilot' }))
        ];

        if (!mergedFindings || mergedFindings.length === 0) {
            sidebar.appendLog('✅ Review complete — no findings');
            sidebar.showMessage(messages?.noFindings ?? 'No issues found!', 'idle');
            statusBar.setState('done', 'No issues found');
            sidebar.setReviewingState(false);
            return;
        }

        const errors   = mergedFindings.filter(f => f.severity === 'error').length;
        const warnings = mergedFindings.filter(f => f.severity === 'warning').length;
        const infos    = mergedFindings.filter(f => f.severity === 'info').length;
        const summary = `${mergedFindings.length} finding${mergedFindings.length !== 1 ? 's' : ''}: ` +
            `${errors} error${errors !== 1 ? 's' : ''}, ` +
            `${warnings} warning${warnings !== 1 ? 's' : ''}, ` +
            `${infos} note${infos !== 1 ? 's' : ''}`;
        sidebar.appendLog(`✅ Review complete — ${summary}`);

        // 4. Apply decorations (only for Copilot findings with file:line info)
        sidebar.appendLog('🎨 Applying inline decorations…');
        statusBar.setState('thinking', 'Applying decorations…');
        decorator.clearAll();
        const decorableFindingsForDecorator = copilotFindings ? copilotFindings.filter(f => f.line > 0) : [];
        await decorator.applyFindings(decorableFindingsForDecorator);
        sidebar.appendLog('✅ Decorations applied');

        // 5. Present findings in sidebar
        sidebar.showFindings(mergedFindings);
        statusBar.setState('done', summary);
        sidebar.setReviewingState(false);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sidebar.appendLog(`❌ Error: ${msg}`, true);
        const errorMessage = messages?.error?.replace('{error}', msg) ?? `An error occurred: ${msg}`;
        sidebar.showMessage(errorMessage, 'idle');
        statusBar.setState('error', `Error: ${msg}`);
        vscode.window.showErrorMessage(`PR Reviewer error: ${msg}`);
        sidebar.setReviewingState(false);
    }
}
