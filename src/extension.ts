import * as vscode from 'vscode';
import { SidebarViewProvider } from './sidebarViewProvider';
import { StatusBarCharacter } from './statusBarCharacter';
import { PrDiffFetcher } from './prDiffFetcher';
import { CopilotReviewer } from './copilotReviewer';
import { CodeDecorator } from './codeDecorator';

let decorator: CodeDecorator | undefined;

export function activate(context: vscode.ExtensionContext): void {
    decorator = new CodeDecorator(context);

    // Sidebar character view
    const sidebarProvider = new SidebarViewProvider(context.extensionUri);
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

    const reviewCmd = vscode.commands.registerCommand('prReviewer.reviewPR', async () => {
        sidebarProvider.reveal();
        await runReview(context, decorator!, sidebarProvider, statusBar);
    });

    const clearCmd = vscode.commands.registerCommand('prReviewer.clearDecorations', () => {
        decorator?.clearAll();
        vscode.window.showInformationMessage('PR Reviewer: All decorations cleared.');
    });

    const settingsCmd = vscode.commands.registerCommand('prReviewer.openSettings', () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'prReviewer');
    });

    context.subscriptions.push(sidebarReg, statusBar, reviewCmd, clearCmd, settingsCmd, decorator);
}

export function deactivate(): void {
    decorator?.clearAll();
}

async function runReview(
    context: vscode.ExtensionContext,
    decorator: CodeDecorator,
    sidebar: SidebarViewProvider,
    statusBar: StatusBarCharacter
): Promise<void> {
    try {
        sidebar.clearLog();
        sidebar.appendLog('🚀 Review started');
        sidebar.showMessage('🎬 Alright, let\'s see what catastrophe you\'ve cooked up this time…', 'thinking');
        statusBar.setState('thinking', 'Starting review…');

        // 1. Fetch the diff
        const fetcher = new PrDiffFetcher();
        sidebar.showMessage('📂 Fetching your so-called "changes"…', 'thinking');
        sidebar.appendLog('📂 Fetching diff from git…');
        statusBar.setState('thinking', 'Fetching diff…');
        const diff = await fetcher.getDiff();

        if (!diff || diff.trim().length === 0) {
            sidebar.appendLog('⚠️  No diff found — nothing to review', true);
            sidebar.showMessage(
                '…Nothing. You changed absolutely nothing. Brilliant. A masterpiece of inaction.',
                'idle'
            );
            statusBar.setState('done', 'Nothing to review');
            return;
        }

        const diffLines = diff.trim().split('\n').length;
        sidebar.appendLog(`✅ Diff fetched — ${diffLines} line${diffLines !== 1 ? 's' : ''} changed`);

        // 2. Send to Copilot
        sidebar.showMessage('🤔 Reading this… utter disaster…', 'thinking');
        sidebar.appendLog('🤖 Sending diff to Copilot for review…');
        statusBar.setState('thinking', `Reviewing ${diffLines} lines…`);
        const reviewer = new CopilotReviewer();
        const findings = await reviewer.review(diff);

        if (!findings || findings.length === 0) {
            sidebar.appendLog('✅ Review complete — no findings');
            sidebar.showMessage(
                'Even I can\'t find anything wrong. Which either means you\'ve done well, or my standards have finally hit rock bottom.',
                'idle'
            );
            statusBar.setState('done', 'No issues found');
            return;
        }

        const errors   = findings.filter(f => f.severity === 'error').length;
        const warnings = findings.filter(f => f.severity === 'warning').length;
        const infos    = findings.filter(f => f.severity === 'info').length;
        const summary = `${findings.length} finding${findings.length !== 1 ? 's' : ''}: ` +
            `${errors} error${errors !== 1 ? 's' : ''}, ` +
            `${warnings} warning${warnings !== 1 ? 's' : ''}, ` +
            `${infos} note${infos !== 1 ? 's' : ''}`;
        sidebar.appendLog(`✅ Review complete — ${summary}`);

        // 3. Apply decorations
        sidebar.appendLog('🎨 Applying inline decorations…');
        statusBar.setState('thinking', 'Applying decorations…');
        decorator.clearAll();
        await decorator.applyFindings(findings);
        sidebar.appendLog('✅ Decorations applied');

        // 4. Present findings in sidebar
        sidebar.showFindings(findings);
        statusBar.setState('done', summary);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sidebar.appendLog(`❌ Error: ${msg}`, true);
        sidebar.showMessage(`Oh brilliant. An error. "${msg}". Just what I needed.`, 'idle');
        statusBar.setState('error', `Error: ${msg}`);
        vscode.window.showErrorMessage(`PR Reviewer error: ${msg}`);
    }
}
