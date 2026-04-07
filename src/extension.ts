import * as vscode from 'vscode';
import { ReviewerPanel } from './reviewerPanel';
import { PrDiffFetcher } from './prDiffFetcher';
import { CopilotReviewer } from './copilotReviewer';
import { CodeDecorator } from './codeDecorator';

let decorator: CodeDecorator | undefined;

export function activate(context: vscode.ExtensionContext): void {
    decorator = new CodeDecorator(context);

    const reviewCmd = vscode.commands.registerCommand('prReviewer.reviewPR', async () => {
        await runReview(context, decorator!);
    });

    const clearCmd = vscode.commands.registerCommand('prReviewer.clearDecorations', () => {
        decorator?.clearAll();
        vscode.window.showInformationMessage('PR Reviewer: All decorations cleared.');
    });

    context.subscriptions.push(reviewCmd, clearCmd, decorator);
}

export function deactivate(): void {
    decorator?.clearAll();
}

async function runReview(
    context: vscode.ExtensionContext,
    decorator: CodeDecorator
): Promise<void> {
    const panel = ReviewerPanel.createOrShow(context);

    try {
        panel.clearLog();
        panel.appendLog('🚀 Review started');
        panel.showMessage('🎬 Alright, let\'s see what catastrophe you\'ve cooked up this time…', 'thinking');

        // 1. Fetch the diff
        const fetcher = new PrDiffFetcher();
        panel.showMessage('📂 Fetching your so-called "changes"…', 'thinking');
        panel.appendLog('📂 Fetching diff from git…');
        const diff = await fetcher.getDiff();

        if (!diff || diff.trim().length === 0) {
            panel.appendLog('⚠️  No diff found — nothing to review', true);
            panel.showMessage(
                '…Nothing. You changed absolutely nothing. Brilliant. A masterpiece of inaction.',
                'idle'
            );
            return;
        }

        const diffLines = diff.trim().split('\n').length;
        panel.appendLog(`✅ Diff fetched — ${diffLines} line${diffLines !== 1 ? 's' : ''} changed`);

        // 2. Send to Copilot
        panel.showMessage('🤔 Reading this… utter disaster…', 'thinking');
        panel.appendLog('🤖 Sending diff to Copilot for review…');
        const reviewer = new CopilotReviewer();
        const findings = await reviewer.review(diff);

        if (!findings || findings.length === 0) {
            panel.appendLog('✅ Review complete — no findings');
            panel.showMessage(
                'Even I can\'t find anything wrong. Which either means you\'ve done well, or my standards have finally hit rock bottom.',
                'idle'
            );
            return;
        }

        const errors   = findings.filter(f => f.severity === 'error').length;
        const warnings = findings.filter(f => f.severity === 'warning').length;
        const infos    = findings.filter(f => f.severity === 'info').length;
        panel.appendLog(
            `✅ Review complete — ${findings.length} finding${findings.length !== 1 ? 's' : ''}: ` +
            `${errors} error${errors !== 1 ? 's' : ''}, ` +
            `${warnings} warning${warnings !== 1 ? 's' : ''}, ` +
            `${infos} note${infos !== 1 ? 's' : ''}`
        );

        // 3. Apply decorations
        panel.appendLog('🎨 Applying inline decorations…');
        decorator.clearAll();
        await decorator.applyFindings(findings);
        panel.appendLog('✅ Decorations applied');

        // 4. Present findings in panel
        panel.showFindings(findings);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.appendLog(`❌ Error: ${msg}`, true);
        panel.showMessage(`Oh brilliant. An error. "${msg}". Just what I needed.`, 'idle');
        vscode.window.showErrorMessage(`PR Reviewer error: ${msg}`);
    }
}
