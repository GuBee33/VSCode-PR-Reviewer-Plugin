import * as vscode from 'vscode';
import { ReviewFinding } from './types';
import { debugLog, showDebugOutput } from './extension';
import personalitiesData from './reviewerPersonalities.json';

export interface PersonalityQuips {
    manyErrors: string;
    someErrors: string;
    fewErrors: string;
    manyWarnings: string;
    someWarnings: string;
    noIssues: string;
    default: string;
}

export interface PersonalityMessages {
    idle: string;
    reviewStart: string;
    fetchingDiff: string;
    noDiff: string;
    reviewing: string;
    noFindings: string;
    error: string;
    quips: PersonalityQuips;
}

export interface ReviewerPersonality {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    messages: PersonalityMessages;
}

/** Get all available reviewer personalities */
export function getReviewerPersonalities(): ReviewerPersonality[] {
    const personalities = personalitiesData.personalities as ReviewerPersonality[];
    if (personalities.length === 0) {
        throw new Error('No reviewer personalities found in configuration');
    }
    return personalities;
}

/** Get a personality by ID, or the first one if not found */
export function getPersonalityById(id: string): ReviewerPersonality {
    const personalities = getReviewerPersonalities();
    const personality = personalities.find(p => p.id === id);
    if (!personality) {
        debugLog(`[Personality] Unknown personality ID '${id}', falling back to '${personalities[0].id}'`);
    }
    return personality || personalities[0];
}

/** Get messages for a personality by ID */
export function getPersonalityMessages(id: string): PersonalityMessages {
    return getPersonalityById(id).messages;
}

const MAX_DIFF_CHARS = 30_000;

/**
 * Uses the VS Code Language Model API to send the diff to GitHub Copilot
 * and parse structured review findings from the response.
 */
export class CopilotReviewer {
    private readonly personalityId: string;
    private readonly extraInstructions: string;
    private readonly modelId: string;

    constructor(modelOverride?: string, personalityIdOverride?: string, extraInstructionsOverride?: string) {
        this.personalityId = personalityIdOverride || 'sarcastic';
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

        debugLog(`[Request] Sending to model ${selectedModel.family}...`);
        debugLog(`[Request] System prompt length: ${systemPrompt.length}, User prompt length: ${userPrompt.length}`);

        let response;
        const cts = new vscode.CancellationTokenSource();
        try {
            response = await selectedModel.sendRequest(
                messages,
                {},
                cts.token
            );
        } catch (sendError) {
            debugLog(`[Request] sendRequest failed: ${sendError}`);
            throw new Error(`Failed to send request to Copilot: ${sendError}`);
        } finally {
            cts.dispose();
        }

        let raw = '';
        let chunkCount = 0;
        let streamErrorOccurred = false;
        try {
            for await (const chunk of response.text) {
                raw += chunk;
                chunkCount++;
            }
        } catch (streamError) {
            debugLog(`[Response] Stream error after ${chunkCount} chunks (${raw.length} chars): ${streamError}`);
            streamErrorOccurred = true;
            // If we have partial content, try to use it but flag as incomplete
            if (raw.length === 0) {
                throw new Error(`Copilot response stream failed: ${streamError}`);
            }
            debugLog('[Response] WARNING: Using partial response due to stream error - results may be incomplete');
        }

        // Log raw response for debugging
        debugLog(`[Response] Received ${chunkCount} chunks, total ${raw.length} chars`);
        if (raw.length === 0) {
            debugLog('[Response] WARNING: Empty response from model');
            debugLog('[Response] This may indicate:');
            debugLog('  - Copilot authorization issue (try signing out and back in)');
            debugLog('  - Model quota/rate limit reached');
            debugLog('  - Network connectivity issue');
            debugLog('  - Remote session authentication problem');
        } else {
            debugLog(`[Response] Content:\n${raw}`);
        }
        debugLog('---');
        showDebugOutput(); // Show the output channel if debug enabled

        const findings = this.parseFindings(raw);
        
        // Prepend a warning if results may be incomplete due to stream error
        if (streamErrorOccurred && findings.length > 0) {
            findings.unshift({
                file: 'system',
                line: -1,
                severity: 'warning',
                title: 'Partial Results Warning',
                message: 'The response stream was interrupted. These results may be incomplete.',
                suggestion: 'Try running the review again if you suspect missing findings.'
            });
        }
        
        return findings;
    }

    private buildSystemPrompt(): string {
        const personality = getPersonalityById(this.personalityId);
        const extra = this.extraInstructions ? `\n\nAdditional instructions: ${this.extraInstructions}` : '';

        return `${personality.systemPrompt}${extra}

Respond ONLY with a valid JSON array of finding objects. Each object must have these exact keys:
- "file": string (relative path from repo root, e.g. "src/utils.ts")
- "line": number (1-based line number, or -1 if no specific line)
- "severity": "error" | "warning" | "info"
- "title": string (short title, max 80 chars)
- "message": string (detailed message in your ${personality.name} style)
- "suggestion": string | null (a concrete fix suggestion, or null)

If there are no real issues, return an empty array [].
Do not wrap the JSON in markdown code fences or add any other text outside the JSON array.`;
    }

    private buildUserPrompt(diff: string): string {
        return `Review the following git diff and provide your findings:\n\n${diff}`;
    }

    private parseFindings(raw: string): ReviewFinding[] {
        // Handle empty response - this usually indicates an auth or connectivity issue
        if (!raw || raw.trim().length === 0) {
            debugLog('[Parsing] Empty response received');
            return [{
                file: 'system',
                line: -1,
                severity: 'error',
                title: 'Empty Response from Copilot',
                message: 'The Copilot model returned an empty response. This typically indicates:\n' +
                    '• Copilot authorization issue - try signing out and back in via the Copilot extension\n' +
                    '• Model quota or rate limit reached\n' +
                    '• Network connectivity problem\n' +
                    '• Remote session authentication issue (for remote/WSL/Container scenarios)',
                suggestion: 'Try: Command Palette → "GitHub Copilot: Sign Out" then sign back in'
            }];
        }

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
