import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { debugLog } from './extension';

/**
 * Fetches the current PR / branch diff relative to the specified base branch.
 * If the base branch is the same as the current branch, shows uncommitted changes.
 */
export class PrDiffFetcher {
    private readonly baseBranch: string;

    constructor(baseBranch?: string) {
        this.baseBranch = baseBranch || 'main';
    }

    async getDiff(): Promise<string> {
        const workspaceRoot = this.getWorkspaceRoot();

        if (!workspaceRoot) {
            throw new Error('No workspace folder is open. Please open a Git repository.');
        }

        // Get current branch
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe']
        }).toString().trim();

        debugLog(`[Diff] Workspace root: ${workspaceRoot}`);
        debugLog(`[Diff] Current branch: ${currentBranch}`);
        debugLog(`[Diff] Base branch: ${this.baseBranch}`);

        // If same branch, show uncommitted changes (staged + unstaged)
        if (currentBranch === this.baseBranch) {
            debugLog(`[Diff] Same branch - showing uncommitted changes`);
            const diffCmd = `git diff HEAD -- . ${PrDiffFetcher.DIFF_EXCLUDES}`;
            debugLog(`[Diff] Command: ${diffCmd}`);
            
            const diff = this.runGit(workspaceRoot, diffCmd);
            
            debugLog(`[Diff] Total length: ${diff.length} chars`);
            debugLog(`[Diff] Preview (first 500 chars):\n${diff.slice(0, 500)}`);
            debugLog('---');
            
            return diff;
        }

        // Different branch - show diff against base branch
        const diffCmd = this.buildDiffCommand(workspaceRoot);
        debugLog(`[Diff] Command: ${diffCmd}`);
        
        const diff = this.runGit(workspaceRoot, diffCmd);
        
        debugLog(`[Diff] Total length: ${diff.length} chars`);
        debugLog(`[Diff] Preview (first 500 chars):\n${diff.slice(0, 500)}`);
        debugLog('---');
        
        return diff;
    }

    private static readonly DIFF_EXCLUDES = '":(exclude)package-lock.json" ":(exclude)*.lock"';

    private buildDiffCommand(cwd: string): string {
        // Attempt to find the merge-base; if that fails, just diff the current branch vs base.
        try {
            const mergeBase = execSync(
                `git merge-base HEAD ${this.baseBranch}`,
                { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
            ).toString().trim();

            if (mergeBase) {
                debugLog(`[Diff] Merge-base found: ${mergeBase}`);
                return `git diff ${mergeBase} HEAD -- . ${PrDiffFetcher.DIFF_EXCLUDES}`;
            }
        } catch (e) {
            debugLog(`[Diff] Merge-base failed: ${e}`);
            // merge-base failed – fall through to simple diff
        }

        debugLog(`[Diff] Using fallback diff: ${this.baseBranch}...HEAD`);
        return `git diff ${this.baseBranch}...HEAD -- . ${PrDiffFetcher.DIFF_EXCLUDES}`;
    }

    private runGit(cwd: string, cmd: string): string {
        try {
            return execSync(cmd, {
                cwd,
                maxBuffer: 5 * 1024 * 1024,  // 5 MB
                stdio: ['pipe', 'pipe', 'pipe']
            }).toString();
        } catch (err) {
            debugLog(`[Diff] Primary command failed: ${err}`);
            // If the base branch doesn't exist locally, try a simple HEAD diff
            const fallbackCmd = `git diff HEAD~1 HEAD -- . ${PrDiffFetcher.DIFF_EXCLUDES}`;
            debugLog(`[Diff] Trying fallback: ${fallbackCmd}`);
            try {
                return execSync(fallbackCmd, {
                    cwd,
                    maxBuffer: 5 * 1024 * 1024,
                    stdio: ['pipe', 'pipe', 'pipe']
                }).toString();
            } catch (fallbackErr) {
                const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                throw new Error(`Could not retrieve git diff: ${msg}`);
            }
        }
    }

    private getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        // Prefer a folder that has a .git directory
        for (const folder of folders) {
            const path = folder.uri.fsPath;
            try {
                execSync('git rev-parse --git-dir', {
                    cwd: path,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                return path;
            } catch {
                // not a git repo
            }
        }
        return folders[0].uri.fsPath;
    }
}
