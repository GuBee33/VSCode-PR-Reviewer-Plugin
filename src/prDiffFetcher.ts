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

        const { owner, repo, host } = PrDiffFetcher.getOwnerAndRepo(workspaceRoot);
        const auth = await PrDiffFetcher.getGitHubAuth(host);

        debugLog(`[Diff] Fetching PR #${prNumber} diff via GitHub API (${host}/${owner}/${repo})`);

        const diff = await PrDiffFetcher.githubRequest<string>(
            `/repos/${owner}/${repo}/pulls/${prNumber}`,
            auth.token,
            host,
            'application/vnd.github.v3.diff',
            auth.apiBaseUrl
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
        host?: string;
        error?: string;
    }> {
        try {
            const { owner, repo, host } = PrDiffFetcher.getOwnerAndRepo(workspaceRoot);

            // First check for a PAT in settings
            const settingsConfig = PrDiffFetcher.getGitHubConfigFromSettings(host);
            
            let token: string | undefined;
            let apiBaseUrl: string | undefined;
            
            if (settingsConfig) {
                debugLog(`[PRs] Using PAT from settings for host: ${host}`);
                token = settingsConfig.token;
                apiBaseUrl = settingsConfig.apiBaseUrl;
            } else if (host === 'github.com') {
                // Use silent: true so we never prompt — just check for an existing session
                const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
                if (!session) {
                    debugLog('[PRs] No GitHub session found (silent check)');
                    return { prs: [], notAuthenticated: true, host };
                }
                token = session.accessToken;
            } else {
                // Try GitHub Enterprise authentication provider
                // The 'github-enterprise' provider may have sessions for GHE instances
                const gheSession = await vscode.authentication.getSession('github-enterprise', ['repo'], { silent: true });
                if (gheSession) {
                    debugLog(`[PRs] Using GitHub Enterprise session for host: ${host}`);
                    token = gheSession.accessToken;
                } else {
                    debugLog(`[PRs] No PAT or GHE session found for host: ${host}`);
                    return { prs: [], notAuthenticated: true, host };
                }
            }

            const prs = await PrDiffFetcher.githubRequest<Array<{
                number: number;
                title: string;
                head: { ref: string };
                base: { ref: string };
            }>>(`/repos/${owner}/${repo}/pulls?state=open&per_page=20`, token, host, 'application/vnd.github.v3+json', apiBaseUrl);

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

    /**
     * Get GitHub config (token + optional API base URL) from settings for a given host.
     * Returns undefined if no PAT is configured for this host.
     */
    private static getGitHubConfigFromSettings(host: string): { token: string; apiBaseUrl?: string } | undefined {
        const config = vscode.workspace.getConfiguration('prReviewer');
        const patMap = config.get<Record<string, string | { pat: string; apiBaseUrl?: string }>>('githubPATs', {});
        
        const entry = patMap[host];
        if (!entry) {
            return undefined;
        }
        
        if (typeof entry === 'string') {
            return { token: entry };
        }
        
        return { token: entry.pat, apiBaseUrl: entry.apiBaseUrl };
    }

    /**
     * Get a GitHub token and optional API base URL.
     * First checks settings for a PAT, then falls back to VS Code's built-in authentication.
     * @param host The GitHub host (e.g., 'github.com' or 'github.mycompany.com')
     * @param createIfNone Whether to prompt for authentication if no session exists
     */
    private static async getGitHubAuth(host: string = 'github.com', createIfNone = true): Promise<{ token: string; apiBaseUrl?: string }> {
        // First, check if there's a PAT configured for this host
        const settingsConfig = PrDiffFetcher.getGitHubConfigFromSettings(host);
        if (settingsConfig) {
            debugLog(`[Auth] Using PAT from settings for host: ${host}${settingsConfig.apiBaseUrl ? ` (custom API: ${settingsConfig.apiBaseUrl})` : ''}`);
            return settingsConfig;
        }
        
        // Fall back to VS Code's built-in GitHub authentication
        if (host === 'github.com') {
            debugLog(`[Auth] Using VS Code built-in GitHub authentication for: ${host}`);
            const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone });
            if (!session) {
                throw new Error('GitHub authentication is required. Please sign in to GitHub in VS Code.');
            }
            return { token: session.accessToken };
        }
        
        // Try GitHub Enterprise authentication provider
        debugLog(`[Auth] Trying GitHub Enterprise authentication for: ${host}`);
        const gheSession = await vscode.authentication.getSession('github-enterprise', ['repo'], { createIfNone });
        if (gheSession) {
            debugLog(`[Auth] Using GitHub Enterprise session for host: ${host}`);
            return { token: gheSession.accessToken };
        }
        
        throw new Error(
            `No authentication found for GitHub Enterprise host '${host}'. ` +
            `Either sign in via 'GitHub Enterprise: Sign In' command, or ` +
            `add a PAT in Settings > PR Reviewer > GitHub PATs. ` +
            `Required permissions: 'repo' scope for private repos, or 'public_repo' for public repos only.`
        );
    }

    /**
     * Get a GitHub token - first checks settings for a PAT, then falls back to VS Code's built-in authentication.
     * @param host The GitHub host (e.g., 'github.com' or 'github.mycompany.com')
     * @param createIfNone Whether to prompt for authentication if no session exists
     * @deprecated Use getGitHubAuth instead to also get the optional apiBaseUrl
     */
    private static async getGitHubToken(host: string = 'github.com', createIfNone = true): Promise<string> {
        const auth = await PrDiffFetcher.getGitHubAuth(host, createIfNone);
        return auth.token;
    }

    /** Extract owner/repo and host from the git remote URL. */
    private static getOwnerAndRepo(cwd: string): { owner: string; repo: string; host: string } {
        try {
            const remoteUrl = execSync('git remote get-url origin', {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe']
            }).toString().trim();

            // Match HTTPS: https://github.com/owner/repo.git or https://github.mycompany.com/owner/repo.git
            // Match SSH:   git@github.com:owner/repo.git or git@github.mycompany.com:owner/repo.git
            const httpsMatch = remoteUrl.match(/https:\/\/([^/]+)\/([^/]+)\/([^/.]+)/);
            const sshMatch = remoteUrl.match(/git@([^:]+):([^/]+)\/([^/.]+)/);
            
            const match = httpsMatch || sshMatch;
            if (!match) {
                throw new Error(`Could not parse GitHub owner/repo from remote URL: ${remoteUrl}`);
            }
            return { host: match[1], owner: match[2], repo: match[3] };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to determine GitHub repository: ${msg}`);
        }
    }

    /**
     * Make an authenticated request to the GitHub REST API.
     * @param path The API path (e.g., '/repos/owner/repo/pulls')
     * @param token The authentication token
     * @param host The GitHub host (e.g., 'github.com' or 'github.mycompany.com')
     * @param accept The Accept header value
     * @param apiBaseUrl Optional custom API base URL (overrides default host-based URL)
     */
    private static githubRequest<T>(path: string, token: string, host: string = 'github.com', accept = 'application/vnd.github.v3+json', apiBaseUrl?: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let apiHost: string;
            let apiPath: string;
            
            if (apiBaseUrl) {
                // Parse custom API base URL
                const url = new URL(apiBaseUrl);
                apiHost = url.hostname;
                // Combine the base path from URL with the API path
                const basePath = url.pathname.replace(/\/$/, ''); // Remove trailing slash
                apiPath = basePath + path;
            } else {
                // Default: github.com uses api.github.com; GitHub Enterprise uses host/api/v3
                apiHost = host === 'github.com' ? 'api.github.com' : host;
                apiPath = host === 'github.com' ? path : `/api/v3${path}`;
            }
            
            debugLog(`[API] Request to: ${apiHost}${apiPath}`);
            
            const options: https.RequestOptions = {
                hostname: apiHost,
                path: apiPath,
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

    private static githubGraphQLRequest<T>(query: string, variables: Record<string, unknown>, token: string, host: string = 'github.com', apiBaseUrl?: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let apiHost: string;
            let apiPath: string;

            if (apiBaseUrl) {
                const url = new URL(apiBaseUrl);
                apiHost = url.hostname;
                apiPath = url.pathname.replace(/\/$/, '') + '/graphql';
            } else {
                apiHost = host === 'github.com' ? 'api.github.com' : host;
                apiPath = host === 'github.com' ? '/graphql' : '/api/graphql';
            }

            const body = JSON.stringify({ query, variables });

            const options: https.RequestOptions = {
                hostname: apiHost,
                path: apiPath,
                method: 'POST',
                headers: {
                    'User-Agent': 'VSCode-PR-Reviewer',
                    'Authorization': `bearer ${token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf-8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(raw);
                            if (parsed.errors && parsed.errors.length > 0) {
                                reject(new Error(`GitHub GraphQL error: ${parsed.errors[0].message}`));
                            } else {
                                resolve(parsed.data as T);
                            }
                        } catch {
                            reject(new Error(`Invalid JSON from GitHub GraphQL: ${raw.slice(0, 200)}`));
                        }
                    } else {
                        reject(new Error(`GitHub GraphQL returned ${res.statusCode}: ${raw.slice(0, 300)}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`GitHub GraphQL request failed: ${err.message}`)));
            req.write(body);
            req.end();
        });
    }

    /**
     * Fetches the set of review comment database IDs that belong to resolved threads.
     */
    private static async getResolvedCommentIds(prNumber: number, auth: { token: string; apiBaseUrl?: string }, host: string, owner: string, repo: string): Promise<Set<number>> {
        const resolvedIds = new Set<number>();
        let hasNextPage = true;
        let cursor: string | null = null;

        const query = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $pr) {
                    reviewThreads(first: 100, after: $after) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            isResolved
                            comments(first: 1) {
                                nodes { databaseId }
                            }
                        }
                    }
                }
            }
        }`;

        type ReviewThreadsResponse = {
            repository: {
                pullRequest: {
                    reviewThreads: {
                        pageInfo: { hasNextPage: boolean; endCursor: string | null };
                        nodes: Array<{
                            isResolved: boolean;
                            comments: { nodes: Array<{ databaseId: number }> };
                        }>;
                    };
                };
            };
        };

        while (hasNextPage) {
            const data: ReviewThreadsResponse = await PrDiffFetcher.githubGraphQLRequest<ReviewThreadsResponse>(query, { owner, repo, pr: prNumber, after: cursor }, auth.token, host, auth.apiBaseUrl);

            const threads = data.repository.pullRequest.reviewThreads;
            for (const thread of threads.nodes) {
                if (thread.isResolved && thread.comments.nodes.length > 0) {
                    resolvedIds.add(thread.comments.nodes[0].databaseId);
                }
            }
            hasNextPage = threads.pageInfo.hasNextPage;
            cursor = threads.pageInfo.endCursor;
        }

        return resolvedIds;
    }

    /**
     * Fetches findings from a PR via reviews and check runs.
     * Includes PR reviews and CI/CD check annotations.
     */
    static async getPrFindings(prNumber: number): Promise<import('./types').ReviewFinding[]> {
        const workspaceRoot = PrDiffFetcher.findWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder is open. Please open a Git repository.');
        }

        const { owner, repo, host } = PrDiffFetcher.getOwnerAndRepo(workspaceRoot);
        const auth = await PrDiffFetcher.getGitHubAuth(host, false);

        debugLog(`[Findings] Fetching PR #${prNumber} findings from GitHub (${host}/${owner}/${repo})`);

        const findings: import('./types').ReviewFinding[] = [];

        try {
            // Fetch resolved thread IDs via GraphQL so we can skip them
            let resolvedCommentIds = new Set<number>();
            try {
                resolvedCommentIds = await PrDiffFetcher.getResolvedCommentIds(prNumber, auth, host, owner, repo);
                debugLog(`[Findings] Found ${resolvedCommentIds.size} resolved review thread(s)`);
            } catch (gqlErr) {
                debugLog(`[Findings] Could not fetch resolved threads (GraphQL): ${gqlErr}`);
                // Continue without filtering — show all comments
            }

            // Fetch inline review comments (with file and line info)
            debugLog(`[Findings] Fetching inline review comments for PR #${prNumber}`);
            const reviewComments = await PrDiffFetcher.githubRequest<Array<{
                id: number;
                user: { login: string };
                body: string;
                path: string;
                line: number;
                original_line?: number;
                in_reply_to_id?: number;
                state?: string;
            }>>(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`, auth.token, host, 'application/vnd.github.v3+json', auth.apiBaseUrl);

            for (const comment of reviewComments) {
                if (comment.body && comment.body.trim()) {
                    // Only include top-level comments (not replies) that are not resolved
                    if (!comment.in_reply_to_id && !resolvedCommentIds.has(comment.id)) {
                        const inlineCommentFinding: import('./types').ReviewFinding = {
                            file: comment.path,
                            line: comment.line,
                            severity: 'info',
                            title: `${comment.user.login}: Review Comment`,
                            message: comment.body,
                            source: 'github-review'
                        };
                        findings.push(inlineCommentFinding);
                    }
                }
            }

            // Fetch general PR reviews (body-only reviews without inline comments)
            debugLog(`[Findings] Fetching general PR reviews for PR #${prNumber}`);
            const reviews = await PrDiffFetcher.githubRequest<Array<{
                id: number;
                user: { login: string };
                body: string;
                state: string;
                submitted_at: string;
            }>>(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, auth.token, host, 'application/vnd.github.v3+json', auth.apiBaseUrl);

            for (const review of reviews) {
                if (review.body && review.body.trim()) {
                    // Only include reviews with general comments (not just approvals/dismissals)
                    const reviewFinding: import('./types').ReviewFinding = {
                        file: 'PR Review',
                        line: -1,
                        severity: review.state === 'APPROVED' ? 'info' : review.state === 'CHANGES_REQUESTED' ? 'error' : 'warning',
                        title: `${review.user.login}: ${review.state === 'CHANGES_REQUESTED' ? 'Changes Requested' : review.state === 'APPROVED' ? 'Approved' : 'Review'}`,
                        message: review.body,
                        source: 'github-review'
                    };
                    findings.push(reviewFinding);
                }
            }

            // Fetch check runs
            debugLog(`[Findings] Fetching PR check runs for PR #${prNumber}`);
            const checkRuns = await PrDiffFetcher.githubRequest<{
                check_runs: Array<{
                    id: number;
                    name: string;
                    conclusion: string | null;
                    output?: { title: string; summary: string };
                }>;
            }>(`/repos/${owner}/${repo}/commits/${await PrDiffFetcher.getPrHeadSha(prNumber, auth, host, owner, repo)}/check-runs`, auth.token, host, 'application/vnd.github.v3+json', auth.apiBaseUrl);

            for (const checkRun of checkRuns.check_runs) {
                if (checkRun.conclusion && checkRun.conclusion !== 'success' && checkRun.conclusion !== 'skipped') {
                    const checkFinding: import('./types').ReviewFinding = {
                        file: 'CI/CD Checks',
                        line: -1,
                        severity: checkRun.conclusion === 'failure' ? 'error' : 'warning',
                        title: `Check: ${checkRun.name}`,
                        message: checkRun.output?.summary || `Check concluded with: ${checkRun.conclusion}`,
                        source: 'github-check'
                    };
                    findings.push(checkFinding);
                }
            }

            debugLog(`[Findings] Fetched ${findings.length} findings from PR #${prNumber}`);
        } catch (err) {
            debugLog(`[Findings] Failed to fetch PR findings: ${err}`);
            // Return empty array on error - this is optional, so don't break the review
        }

        return findings;
    }

    /**
     * Gets the HEAD SHA of a PR for fetching check runs.
     */
    private static async getPrHeadSha(prNumber: number, auth: { token: string; apiBaseUrl?: string }, host: string, owner: string, repo: string): Promise<string> {
        const pr = await PrDiffFetcher.githubRequest<{
            head: { sha: string };
        }>(`/repos/${owner}/${repo}/pulls/${prNumber}`, auth.token, host, 'application/vnd.github.v3+json', auth.apiBaseUrl);
        return pr.head.sha;
    }
}
