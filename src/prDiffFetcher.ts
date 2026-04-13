import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as https from 'https';
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
        return PrDiffFetcher.findWorkspaceRoot();
    }

    private static findWorkspaceRoot(): string | undefined {
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

    /**
     * Fetches the diff for a specific pull request using the GitHub REST API.
     * Uses VS Code's built-in GitHub authentication — no external CLI required.
     */
    static async getPrDiff(prNumber: number): Promise<string> {
        const workspaceRoot = PrDiffFetcher.findWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder is open. Please open a Git repository.');
        }

        const { owner, repo } = PrDiffFetcher.getOwnerAndRepo(workspaceRoot);
        const token = await PrDiffFetcher.getGitHubToken();

        debugLog(`[Diff] Fetching PR #${prNumber} diff via GitHub API (${owner}/${repo})`);

        const diff = await PrDiffFetcher.githubRequest<string>(
            `/repos/${owner}/${repo}/pulls/${prNumber}`,
            token,
            'application/vnd.github.v3.diff'
        );

        debugLog(`[Diff] PR #${prNumber} diff length: ${diff.length} chars`);
        return diff;
    }

    /**
     * Lists open pull requests using the GitHub REST API.
     * Uses VS Code's built-in GitHub authentication — no external CLI required.
     * Returns an empty array if authentication fails or repo is not on GitHub.
     */
    static async listOpenPRs(workspaceRoot: string): Promise<{
        prs: Array<{ number: number; title: string; headRefName: string; baseRefName: string }>;
        notAuthenticated?: boolean;
        error?: string;
    }> {
        try {
            const { owner, repo } = PrDiffFetcher.getOwnerAndRepo(workspaceRoot);

            // Use silent: true so we never prompt — just check for an existing session
            const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
            if (!session) {
                debugLog('[PRs] No GitHub session found (silent check)');
                return { prs: [], notAuthenticated: true };
            }

            const prs = await PrDiffFetcher.githubRequest<Array<{
                number: number;
                title: string;
                head: { ref: string };
                base: { ref: string };
            }>>(`/repos/${owner}/${repo}/pulls?state=open&per_page=20`, session.accessToken);

            return {
                prs: prs.map(pr => ({
                    number: pr.number,
                    title: pr.title,
                    headRefName: pr.head.ref,
                    baseRefName: pr.base.ref,
                }))
            };
        } catch (err) {
            debugLog(`[PRs] Failed to fetch pull requests: ${err}`);
            return { prs: [], error: String(err) };
        }
    }

    /** Get a GitHub token via VS Code's built-in authentication provider. */
    private static async getGitHubToken(createIfNone = true): Promise<string> {
        const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone });
        if (!session) {
            throw new Error('GitHub authentication is required. Please sign in to GitHub in VS Code.');
        }
        return session.accessToken;
    }

    /** Extract owner/repo from the git remote URL. */
    private static getOwnerAndRepo(cwd: string): { owner: string; repo: string } {
        try {
            const remoteUrl = execSync('git remote get-url origin', {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe']
            }).toString().trim();

            // Match HTTPS: https://github.com/owner/repo.git
            // Match SSH:   git@github.com:owner/repo.git
            const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
            if (!match) {
                throw new Error(`Could not parse GitHub owner/repo from remote URL: ${remoteUrl}`);
            }
            return { owner: match[1], repo: match[2] };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to determine GitHub repository: ${msg}`);
        }
    }

    /** Make an authenticated request to the GitHub REST API. */
    private static githubRequest<T>(path: string, token: string, accept = 'application/vnd.github.v3+json'): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: 'api.github.com',
                path,
                method: 'GET',
                headers: {
                    'User-Agent': 'VSCode-PR-Reviewer',
                    'Authorization': `token ${token}`,
                    'Accept': accept,
                },
            };

            const req = https.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        if (accept.includes('diff')) {
                            resolve(body as unknown as T);
                        } else {
                            try {
                                resolve(JSON.parse(body));
                            } catch {
                                reject(new Error(`Invalid JSON response from GitHub API: ${body.slice(0, 200)}`));
                            }
                        }
                    } else {
                        reject(new Error(`GitHub API returned ${res.statusCode}: ${body.slice(0, 300)}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`GitHub API request failed: ${err.message}`)));
            req.end();
        });
    }
}
