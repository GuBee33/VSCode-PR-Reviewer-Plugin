import * as vscode from 'vscode';
import { ReviewFinding } from './types';

const MAX_DIFF_CHARS = 30_000;

/**
 * Uses the VS Code Language Model API to send the diff to GitHub Copilot
 * and parse structured review findings from the response.
 */
export class CopilotReviewer {
    private readonly reviewerStyle: string;
    private readonly extraInstructions: string;
    private readonly modelId: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('prReviewer');
        this.reviewerStyle = config.get<string>('reviewerStyle', 'Ricky Gervais');
        this.extraInstructions = config.get<string>('extraInstructions', '');
        this.modelId = config.get<string>('model', 'copilot-gpt-4o');
    }

    async review(diff: string): Promise<ReviewFinding[]> {
        // Truncate very large diffs to stay within token limits
        const truncatedDiff = diff.length > MAX_DIFF_CHARS
            ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[… diff truncated to stay within limits …]'
            : diff;

        const systemPrompt = this.buildSystemPrompt();
        const userPrompt = this.buildUserPrompt(truncatedDiff);

        // Select the language model – prefer the configured model, fall back to any copilot model
        let selectedModel = (await vscode.lm.selectChatModels({ family: this.modelId }))[0];
        if (!selectedModel) {
            const fallbackModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (!fallbackModels || fallbackModels.length === 0) {
                throw new Error(
                    'No Copilot language model is available. ' +
                    'Make sure GitHub Copilot is installed and you are signed in.'
                );
            }
            selectedModel = fallbackModels[0];
        }

        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt),
            vscode.LanguageModelChatMessage.User(userPrompt),
        ];

        const response = await selectedModel.sendRequest(
            messages,
            {},
            new vscode.CancellationTokenSource().token
        );

        let raw = '';
        for await (const chunk of response.text) {
            raw += chunk;
        }

        return this.parseFindings(raw);
    }

    private buildSystemPrompt(): string {
        const style = this.reviewerStyle;
        const extra = this.extraInstructions ? `\n\nAdditional instructions: ${this.extraInstructions}` : '';

        return `You are a code reviewer with the personality of ${style}. 
You look at code like it is an absolute piece of rubbish – because, let's be honest, it probably is. 
You are brutally honest, sarcastic, and condescending, but ultimately constructive and accurate.
You point out real code quality issues, bugs, security problems, and bad practices with biting commentary.
You DO NOT make up issues that are not in the code.${extra}

Respond ONLY with a valid JSON array of finding objects. Each object must have these exact keys:
- "file": string (relative path from repo root, e.g. "src/utils.ts")
- "line": number (1-based line number, or -1 if no specific line)
- "severity": "error" | "warning" | "info"
- "title": string (short title, max 80 chars)
- "message": string (detailed message in your ${style} style)
- "suggestion": string | null (a concrete fix suggestion, or null)

If there are no real issues, return an empty array [].
Do not wrap the JSON in markdown code fences or add any other text outside the JSON array.`;
    }

    private buildUserPrompt(diff: string): string {
        return `Review the following git diff and provide your findings:\n\n${diff}`;
    }

    private parseFindings(raw: string): ReviewFinding[] {
        // Strip potential markdown fences that the model may have added despite instructions
        let cleaned = raw.trim();
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            // Try to extract a JSON array from the middle of the response
            const match = cleaned.match(/\[[\s\S]*\]/);
            if (match) {
                try {
                    parsed = JSON.parse(match[0]);
                } catch {
                    return this.fallbackParse(raw);
                }
            } else {
                return this.fallbackParse(raw);
            }
        }

        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
            .map(item => this.toFinding(item));
    }

    private toFinding(item: Record<string, unknown>): ReviewFinding {
        const sev = String(item['severity'] ?? 'info');
        return {
            file: String(item['file'] ?? 'unknown'),
            line: typeof item['line'] === 'number' ? item['line'] : -1,
            severity: (sev === 'error' || sev === 'warning' || sev === 'info') ? sev : 'info',
            title: String(item['title'] ?? 'Finding'),
            message: String(item['message'] ?? ''),
            suggestion: item['suggestion'] ? String(item['suggestion']) : undefined,
        };
    }

    /**
     * Last-resort: if the model returned plain text instead of JSON,
     * wrap it as a single general finding.
     */
    private fallbackParse(raw: string): ReviewFinding[] {
        if (!raw.trim()) {
            return [];
        }
        return [{
            file: 'unknown',
            line: -1,
            severity: 'info',
            title: 'General Review',
            message: raw.trim(),
        }];
    }
}
