import * as vscode from 'vscode';
import { ReviewFinding } from './types';
import { debugLog, showDebugOutput } from './extension';

const MAX_DIFF_CHARS = 30_000;

/**
 * Uses the VS Code Language Model API to send the diff to GitHub Copilot
 * and parse structured review findings from the response.
 */
export class CopilotReviewer {
    private readonly reviewerStyle: string;
    private readonly extraInstructions: string;
    private readonly modelId: string;

    constructor(modelOverride?: string, reviewerStyleOverride?: string, extraInstructionsOverride?: string) {
        this.reviewerStyle = reviewerStyleOverride || 'Ricky Gervais';
        this.extraInstructions = extraInstructionsOverride || '';
        // Default model: 'copilot-gpt-4o'. If this model family is unavailable
        // (e.g., Copilot API changes), review() will fall back to any available
        // Copilot model via selectChatModels({ vendor: 'copilot' }).
        this.modelId = modelOverride || 'copilot-gpt-4o';
    }

    async review(diff: string): Promise<ReviewFinding[]> {
        // Truncate very large diffs to stay within token limits
        const truncatedDiff = diff.length > MAX_DIFF_CHARS
            ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[… diff truncated to stay within limits …]'
            : diff;

        const systemPrompt = this.buildSystemPrompt();
        const userPrompt = this.buildUserPrompt(truncatedDiff);

        // Select the language model – prefer the configured model, fall back to any copilot model
        debugLog(`[Model Selection] Requested model family: ${this.modelId}`);
        let selectedModel = (await vscode.lm.selectChatModels({ family: this.modelId }))[0];
        if (!selectedModel) {
            debugLog('[Model Selection] Primary model not found, trying fallback...');
            const fallbackModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            debugLog(`[Model Selection] Available fallback models: ${fallbackModels.map(m => m.family).join(', ')}`);
            if (!fallbackModels || fallbackModels.length === 0) {
                throw new Error(
                    'No Copilot language model is available. ' +
                    'Make sure GitHub Copilot is installed and you are signed in.'
                );
            }
            selectedModel = fallbackModels[0];
        }
        debugLog(`[Model Selection] Using model: ${selectedModel.family} (${selectedModel.name})`);

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

        // Log raw response for debugging
        debugLog(`[Response] Raw length: ${raw.length} chars`);
        debugLog(`[Response] Content:\n${raw}`);
        debugLog('---');
        showDebugOutput(); // Show the output channel if debug enabled

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

        debugLog(`[Parsing] Cleaned length: ${cleaned.length}`);

        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
            debugLog(`[Parsing] JSON parsed OK, isArray: ${Array.isArray(parsed)}, length: ${Array.isArray(parsed) ? parsed.length : 'N/A'}`);
        } catch (e) {
            debugLog(`[Parsing] JSON parse failed: ${e}`);
            // Try to extract a JSON array from the middle of the response
            const match = cleaned.match(/\[[\s\S]*\]/);
            if (match) {
                debugLog('[Parsing] Found array pattern, re-parsing...');
                try {
                    parsed = JSON.parse(match[0]);
                    debugLog(`[Parsing] Re-parse OK, length: ${Array.isArray(parsed) ? parsed.length : 'not array'}`);
                } catch (e2) {
                    debugLog(`[Parsing] Re-parse failed: ${e2}`);
                    return this.fallbackParse(raw);
                }
            } else {
                debugLog('[Parsing] No array pattern, using fallback');
                return this.fallbackParse(raw);
            }
        }

        if (!Array.isArray(parsed)) {
            debugLog('[Parsing] Result not an array, returning empty');
            return [];
        }

        const findings = parsed
            .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
            .map(item => this.toFinding(item));
        
        debugLog(`[Parsing] Final findings: ${findings.length}`);
        return findings;
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
