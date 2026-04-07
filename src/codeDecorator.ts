import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewFinding } from './types';

/**
 * Manages VS Code editor decorations that highlight lines mentioned in findings.
 */
export class CodeDecorator implements vscode.Disposable {
    private readonly errorType: vscode.TextEditorDecorationType;
    private readonly warningType: vscode.TextEditorDecorationType;
    private readonly infoType: vscode.TextEditorDecorationType;
    private readonly activeDecorations = new Map<string, ReviewFinding[]>();

    constructor(_context: vscode.ExtensionContext) {
        this.errorType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.15)',
            border: '1px solid rgba(255, 80, 80, 0.6)',
            borderRadius: '2px',
            gutterIconPath: new vscode.ThemeIcon('error').id as unknown as vscode.Uri,
            overviewRulerColor: 'rgba(255, 80, 80, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            after: {
                contentText: ' 🔴',
                color: 'rgba(255, 80, 80, 0.9)',
            },
        });

        this.warningType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 200, 0, 0.12)',
            border: '1px solid rgba(255, 180, 0, 0.5)',
            borderRadius: '2px',
            overviewRulerColor: 'rgba(255, 200, 0, 0.7)',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            after: {
                contentText: ' 🟡',
                color: 'rgba(255, 180, 0, 0.9)',
            },
        });

        this.infoType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 150, 255, 0.08)',
            border: '1px solid rgba(0, 150, 255, 0.3)',
            borderRadius: '2px',
            overviewRulerColor: 'rgba(0, 150, 255, 0.5)',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            after: {
                contentText: ' 🔵',
                color: 'rgba(0, 150, 255, 0.9)',
            },
        });
    }

    async applyFindings(findings: ReviewFinding[]): Promise<void> {
        // Group findings by file
        const byFile = new Map<string, ReviewFinding[]>();
        for (const f of findings) {
            if (f.line <= 0) {
                continue;
            }
            const arr = byFile.get(f.file) ?? [];
            arr.push(f);
            byFile.set(f.file, arr);
        }

        const root = this.getWorkspaceRoot();

        for (const [file, filefindings] of byFile) {
            const fileUri = root
                ? vscode.Uri.file(path.join(root, file))
                : vscode.Uri.file(file);

            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });

                this.applyToEditor(editor, filefindings);
                this.activeDecorations.set(fileUri.fsPath, filefindings);
            } catch {
                // file might not exist locally; skip decoration silently
            }
        }
    }

    private applyToEditor(editor: vscode.TextEditor, findings: ReviewFinding[]): void {
        const errors: vscode.DecorationOptions[] = [];
        const warnings: vscode.DecorationOptions[] = [];
        const infos: vscode.DecorationOptions[] = [];

        for (const f of findings) {
            const lineIndex = f.line - 1;
            if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
                continue;
            }

            const line = editor.document.lineAt(lineIndex);
            const range = new vscode.Range(
                new vscode.Position(lineIndex, 0),
                new vscode.Position(lineIndex, line.text.length)
            );

            const hoverMessage = new vscode.MarkdownString(
                `**${this.severityIcon(f.severity)} ${escapeMarkdown(f.title)}**\n\n` +
                `${escapeMarkdown(f.message)}` +
                (f.suggestion ? `\n\n💡 **Suggestion:** ${escapeMarkdown(f.suggestion)}` : '')
            );
            hoverMessage.isTrusted = true;

            const decoration: vscode.DecorationOptions = { range, hoverMessage };

            switch (f.severity) {
                case 'error': errors.push(decoration); break;
                case 'warning': warnings.push(decoration); break;
                default: infos.push(decoration);
            }
        }

        editor.setDecorations(this.errorType, errors);
        editor.setDecorations(this.warningType, warnings);
        editor.setDecorations(this.infoType, infos);
    }

    clearAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.errorType, []);
            editor.setDecorations(this.warningType, []);
            editor.setDecorations(this.infoType, []);
        }
        this.activeDecorations.clear();
    }

    dispose(): void {
        this.clearAll();
        this.errorType.dispose();
        this.warningType.dispose();
        this.infoType.dispose();
    }

    private severityIcon(sev: ReviewFinding['severity']): string {
        switch (sev) {
            case 'error': return '🔴';
            case 'warning': return '🟡';
            default: return '🔵';
        }
    }

    private getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        return folders?.[0]?.uri.fsPath;
    }
}

function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}
