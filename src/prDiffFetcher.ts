import * as vscode from 'vscode';
import { execSync } from 'child_process';

/**
 * Fetches the current PR / branch diff relative to the configured base branch.
 * Falls back to 'main' if no base branch is configured.
 */
export class PrDiffFetcher {
    private readonly baseBranch: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('prReviewer');
        this.baseBranch = config.get<string>('baseBranch', 'main');
    }

    async getDiff(): Promise<string> {
        const workspaceRoot = this.getWorkspaceRoot();

        if (!workspaceRoot) {
            throw new Error('No workspace folder is open. Please open a Git repository.');
        }

        // Try to get the diff against the base branch merge-base.
        // This mirrors what a GitHub PR diff shows.
        const diff = this.runGit(workspaceRoot, this.buildDiffCommand(workspaceRoot));
        return diff;
    }

    private buildDiffCommand(cwd: string): string {
        // Attempt to find the merge-base; if that fails, just diff the current branch vs base.
        try {
            const mergeBase = execSync(
                `git merge-base HEAD ${this.baseBranch}`,
                { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
            ).toString().trim();

            if (mergeBase) {
                return `git diff ${mergeBase} HEAD -- . ":(exclude)package-lock.json" ":(exclude)*.lock"`;
            }
        } catch {
            // merge-base failed – fall through to simple diff
        }

        return `git diff ${this.baseBranch}...HEAD -- . ":(exclude)package-lock.json" ":(exclude)*.lock"`;
    }

    private runGit(cwd: string, cmd: string): string {
        try {
            return execSync(cmd, {
                cwd,
                maxBuffer: 5 * 1024 * 1024,  // 5 MB
                stdio: ['pipe', 'pipe', 'pipe']
            }).toString();
        } catch (err) {
            // If the base branch doesn't exist locally, try a simple HEAD diff
            const fallbackCmd = 'git diff HEAD~1 HEAD -- . ":(exclude)package-lock.json" ":(exclude)*.lock"';
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
