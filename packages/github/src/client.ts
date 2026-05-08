import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  FatalError,
  type GithubAppClient,
  type GithubCommentId,
  type GithubInstallationId,
  type GithubPrNumber,
  type InstallationToken,
  type PostReviewInput,
  type PostedReview,
  type PullRequestSnapshot,
  RetryableError,
  asGithubCommentId,
  asGithubReviewId,
} from '@gcr/core';
import type { Logger } from '@gcr/observability';
import { throttling } from '@octokit/plugin-throttling';
import { RequestError } from '@octokit/request-error';
import { Octokit } from '@octokit/rest';
import type { InstallationTokenCache } from './appAuth.js';

const execFileP = promisify(execFile);

const ThrottledOctokit = Octokit.plugin(throttling);

/**
 * GitHub adapter implementing the `GithubAppClient` port from `@gcr/core`.
 *
 *   - Cloning happens here, in the worker process. We rm `.git` afterwards
 *     so secret refspecs and oauth credentials never land on disk in the
 *     workspace handed to the reviewer.
 *   - Per-call Octokit, not a long-lived one. Installation tokens are
 *     short-lived; we mint one per logical operation.
 */
export class GithubClient implements GithubAppClient {
  constructor(
    private readonly tokens: InstallationTokenCache,
    private readonly logger: Logger,
  ) {}

  async installationToken(id: GithubInstallationId): Promise<InstallationToken> {
    return this.tokens.get(id);
  }

  async listInstallationRepositories(
    token: InstallationToken,
  ): Promise<ReadonlyArray<{ githubRepoId: number; owner: string; name: string }>> {
    const oc = this.octokit(token);
    try {
      // `paginate` walks all pages transparently. The endpoint returns
      // `{ total_count, repositories }`, so we ask for `.repositories`.
      const repos = await oc.paginate(oc.apps.listReposAccessibleToInstallation, {
        per_page: 100,
      });
      return repos.map((r) => ({
        githubRepoId: r.id,
        owner: r.owner.login,
        name: r.name,
      }));
    } catch (err) {
      throw this.translate(err, 'listInstallationRepositories');
    }
  }

  async getPullRequest(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    prNumber: GithubPrNumber;
  }): Promise<PullRequestSnapshot> {
    const oc = this.octokit(input.token);
    try {
      const res = await oc.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber as number,
      });
      const pr = res.data;
      return {
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        title: pr.title,
        body: pr.body ?? '',
        authorLogin: pr.user?.login ?? 'unknown',
        isDraft: !!pr.draft,
      };
    } catch (err) {
      throw this.translate(err, 'getPullRequest');
    }
  }

  async cloneHead(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    headSha: string;
    targetDir: string;
  }): Promise<{ workspaceDir: string }> {
    const { token, owner, repo, headSha, targetDir } = input;
    await mkdir(targetDir, { recursive: true });

    // Use x-access-token form per GitHub docs; the token is short-lived.
    const cloneUrl = `https://x-access-token:${token.token}@github.com/${owner}/${repo}.git`;

    try {
      // Shallow clone; we only need files at headSha.
      await git(['clone', '--depth=1', '--no-tags', '--filter=blob:none', cloneUrl, targetDir]);
      await git(['fetch', '--depth=1', 'origin', headSha], targetDir);
      await git(['checkout', '--detach', headSha], targetDir);
    } catch (err) {
      // git() throws an Error with `stdout` + `stderr` props when the child
      // exits non-zero (Node's child_process error shape). Surface stderr
      // verbatim so transient (network) vs. permanent (token / refspec) is
      // distinguishable from the persisted error_message column.
      const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
      const stderr = (e.stderr ?? '').toString().trim();
      const stdout = (e.stdout ?? '').toString().trim();
      const detail = [stderr, stdout, e.message].filter(Boolean).join(' | ').slice(0, 1500);
      // Redact the token in case git echoed the URL.
      const safe = detail.replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');
      throw new RetryableError(
        'github.clone_failed',
        `clone ${owner}/${repo}@${headSha} failed: ${safe || '(no stderr)'}`,
        { cause: err, delayMs: 10_000 },
      );
    } finally {
      // Strip credentials from any leftover config and remove .git so the
      // workspace handed to the reviewer cannot exfiltrate them via .git/config or hooks.
      try {
        await rm(`${targetDir}/.git`, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn({ err }, 'cleanup .git failed (continuing)');
      }
    }

    return { workspaceDir: targetDir };
  }

  async fetchDiff(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<string> {
    const oc = this.octokit(input.token);
    try {
      const result = await oc.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner: input.owner,
        repo: input.repo,
        basehead: `${input.base}...${input.head}`,
        mediaType: { format: 'diff' },
      });
      return result.data as unknown as string;
    } catch (err) {
      throw this.translate(err, 'compare');
    }
  }

  async postReview(input: PostReviewInput, token: InstallationToken): Promise<PostedReview> {
    const oc = this.octokit(token);
    try {
      const review = await oc.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber as number,
        commit_id: input.headSha,
        event: input.verdict,
        body: input.summaryBody,
        comments: input.inlineComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: 'RIGHT',
          body: c.body,
        })),
      });

      // Fetch the comments for the review to get IDs we can store.
      const commentList = await oc.pulls.listCommentsForReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber as number,
        review_id: review.data.id,
      });

      return {
        githubReviewId: asGithubReviewId(review.data.id),
        inlineCommentIds: commentList.data.map((c) => asGithubCommentId(c.id)),
      };
    } catch (err) {
      throw this.translate(err, 'createReview');
    }
  }

  async reactToComment(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    commentId: GithubCommentId;
    content: 'eyes' | '+1' | 'rocket' | 'confused';
  }): Promise<void> {
    const oc = this.octokit(input.token);
    try {
      await oc.reactions.createForIssueComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: input.commentId as number,
        content: input.content,
      });
    } catch (err) {
      // A failed reaction is annoying but never fatal — log and move on.
      this.logger.warn({ err }, 'reactToComment failed');
    }
  }

  private octokit(token: InstallationToken) {
    return new ThrottledOctokit({
      auth: token.token,
      throttle: {
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          this.logger.warn(
            { retryAfter, method: options.method, url: options.url, retryCount },
            'github.rate_limit',
          );
          return retryCount < 2;
        },
        onSecondaryRateLimit: (retryAfter, options) => {
          this.logger.warn(
            { retryAfter, method: options.method, url: options.url },
            'github.secondary_rate_limit',
          );
          return false;
        },
      },
    });
  }

  private translate(err: unknown, op: string): Error {
    if (err instanceof RequestError) {
      const status = err.status;
      const code = `github.${op}.${status}`;
      // 5xx and 408/429 are retryable; 4xx (other) is fatal.
      if (status >= 500 || status === 408 || status === 429) {
        return new RetryableError(code, `${op} failed (${status})`, { cause: err });
      }
      return new FatalError(code, `${op} failed (${status})`, err);
    }
    return new RetryableError(`github.${op}.unknown`, `${op} failed`, { cause: err });
  }
}

async function git(args: string[], cwd?: string): Promise<void> {
  await execFileP('git', args, {
    cwd,
    timeout: 5 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
