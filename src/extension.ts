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
        panel.showMessage('🎬 Alright, let\'s see what catastrophe you\'ve cooked up this time…', 'thinking');

        // 1. Fetch the diff
        const fetcher = new PrDiffFetcher();
        panel.showMessage('📂 Fetching your so-called "changes"…', 'thinking');
        const diff = await fetcher.getDiff();

        if (!diff || diff.trim().length === 0) {
            panel.showMessage(
                '…Nothing. You changed absolutely nothing. Brilliant. A masterpiece of inaction.',
                'idle'
            );
            return;
        }

        // 2. Send to Copilot
        panel.showMessage('🤔 Reading this… utter disaster…', 'thinking');
        const reviewer = new CopilotReviewer();
        const findings = await reviewer.review(diff);

        if (!findings || findings.length === 0) {
            panel.showMessage(
                'Even I can\'t find anything wrong. Which either means you\'ve done well, or my standards have finally hit rock bottom.',
                'idle'
            );
            return;
        }

        // 3. Apply decorations
        decorator.clearAll();
        await decorator.applyFindings(findings);

        // 4. Present findings in panel
        panel.showFindings(findings);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.showMessage(`Oh brilliant. An error. "${msg}". Just what I needed.`, 'idle');
        vscode.window.showErrorMessage(`PR Reviewer error: ${msg}`);
    }
}
