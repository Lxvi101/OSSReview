import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FatalError,
  type GithubAppClient,
  type GithubPrNumber,
  type IdempotencyKey,
  asGithubCommentId,
  asGithubPrNumber,
  asGithubRepoId,
  asIdempotencyKey,
  autoIdempotencyKey,
  checkCostCap,
  checkMentionCap,
  format,
  isResolved,
  mentionIdempotencyKey,
  selectDiffMode,
  shouldReview,
} from '@gcr/core';
import { type Logger, type Metrics, withContextAsync } from '@gcr/observability';
import type { Handler } from '@gcr/queue';
import type { Reviewer } from '@gcr/reviewer';
import type { Repositories } from '@gcr/storage';

/**
 * The review handler — the orchestration spine.
 *
 * One handler factory, two job names (auto vs mention), differentiated by
 * the `mention` flag. The flag changes idempotency-key construction and the
 * post-completion behaviour (a mention also reacts on the comment).
 */

export interface ReviewHandlerDeps {
  readonly repos: Repositories;
  readonly github: GithubAppClient;
  readonly reviewer: Reviewer;
  readonly metrics: Metrics;
  readonly logger: Logger;
  /** Marker embedded in the review body so we can find an existing review on resume. */
  readonly markerPrefix?: string;
  readonly mention?: boolean;
}

interface ReviewJobData {
  readonly deliveryId: string;
}

/**
 * Sentinel SHAs returned by `extractPrInfo` when the webhook payload is an
 * `issue_comment` (which does not carry head/base). The handler detects these
 * and fetches the PR via the GitHub API to fill them in.
 */
const MENTION_PLACEHOLDER_HEAD = 'MENTION_UNKNOWN_HEAD';
const MENTION_PLACEHOLDER_BASE = 'MENTION_UNKNOWN_BASE';

export function makeReviewPrHandler(deps: ReviewHandlerDeps): Handler<string, ReviewJobData> {
  const marker = deps.markerPrefix ?? '<!--gcr-review-marker:';

  return async ({ job, logger, signal }) => {
    const { deliveryId } = job.data;
    const delivery = await deps.repos.webhookDeliveries.byDeliveryId(deliveryId);
    if (!delivery) {
      throw new FatalError('review.unknown_delivery', `delivery ${deliveryId} not found`);
    }
    const payload = JSON.parse(delivery.payloadJson) as Record<string, unknown>;

    // ── 1. Resolve the PR + repo ──────────────────────────────────────────
    const prInfo = extractPrInfo(payload, deps.mention === true);
    if (!prInfo) {
      logger.warn({ deliveryId }, 'review.no_pr_info');
      return; // nothing to do
    }

    const repository = await deps.repos.repositories.byGithubId(asGithubRepoId(prInfo.githubRepoId));
    if (!repository) {
      throw new FatalError(
        'review.unknown_repo',
        `repo ${prInfo.owner}/${prInfo.repo} not tracked`,
      );
    }

    // Mention webhooks (issue_comment) don't carry head/base SHAs. Fetch the
    // PR snapshot to fill them in before we go any further. Doing it here
    // keeps everything downstream identical to the auto path.
    let prData = prInfo;
    if (prData.headSha === MENTION_PLACEHOLDER_HEAD || prData.baseSha === MENTION_PLACEHOLDER_BASE) {
      const tok = await deps.github.installationToken(repository.installationId);
      const snap = await deps.github.getPullRequest({
        token: tok,
        owner: repository.owner,
        repo: repository.name,
        prNumber: prData.prNumber,
      });
      prData = {
        ...prData,
        headSha: snap.headSha,
        baseSha: snap.baseSha,
        title: snap.title || prData.title,
        authorLogin: snap.authorLogin || prData.authorLogin,
        isDraft: snap.isDraft,
      };
    }

    const pr = await deps.repos.pullRequests.upsert({
      repositoryId: repository.id,
      githubPrNumber: prData.prNumber,
      headSha: prData.headSha,
      baseSha: prData.baseSha,
      authorLogin: prData.authorLogin,
      isDraft: prData.isDraft,
      title: prData.title,
    });

    // ── 2. Policy gate ────────────────────────────────────────────────────
    const trigger = deps.mention ? 'mention' : 'auto';
    const decision = shouldReview({
      repo: repository,
      pr: { isDraft: pr.isDraft, authorLogin: pr.authorLogin },
      trigger,
    });
    if (!decision.review) {
      await deps.repos.auditLog.record({
        actor: 'worker',
        kind: 'review.skipped',
        subjectType: 'pull_request',
        subjectId: String(pr.id),
        data: { reason: decision.reason },
      });
      logger.info({ reason: decision.reason }, 'review.skipped');
      return;
    }

    // ── 3. Per-PR mention rate cap ─────────────────────────────────────────
    if (deps.mention) {
      const existing = await deps.repos.reviewRuns.countMentionRunsForHead(
        pr.id,
        pr.headSha,
      );
      const cap = checkMentionCap({
        existingMentionRunsForHead: existing,
        ...(repository.settings.maxMentionsPerPr !== undefined
          ? { maxMentionsPerPr: repository.settings.maxMentionsPerPr }
          : {}),
      });
      if (!cap.allowed) {
        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'review.skipped',
          subjectType: 'pull_request',
          subjectId: String(pr.id),
          data: { reason: cap.reason ?? 'mention_cap_reached' },
        });
        logger.info({ reason: cap.reason }, 'review.skipped.mention_cap');
        return;
      }
    }

    // ── 4. Daily $-cap (mention runs are NOT exempt) ───────────────────────
    const dailyCapMicrosSetting = await deps.repos.settings.getPlain<number>(
      'cost.daily_cap_micros',
    );
    if (dailyCapMicrosSetting != null) {
      const sinceIso = startOfTodayUtc();
      const spent = await deps.repos.reviewRuns.sumCostMicrosSince(sinceIso);
      const cap = checkCostCap({
        spentTodayMicros: spent,
        dailyCapMicros: dailyCapMicrosSetting,
      });
      if (!cap.allowed) {
        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'cost.cap_reached',
          subjectType: 'pull_request',
          subjectId: String(pr.id),
          data: { spent, cap: dailyCapMicrosSetting },
        });
        logger.warn({ spent, cap: dailyCapMicrosSetting }, 'review.skipped.cost_cap');
        return;
      }
    }

    // ── 5. Idempotent run upsert ──────────────────────────────────────────
    const key: IdempotencyKey = deps.mention
      ? prInfo.commentId !== undefined
        ? mentionIdempotencyKey(asGithubCommentId(prInfo.commentId))
        : asIdempotencyKey(`mention:noid:${deliveryId}`)
      : autoIdempotencyKey(repository.id, pr.githubPrNumber, pr.headSha);

    const triggeredBy = deps.mention ? prInfo.commenterLogin ?? null : null;

    const { run } = await deps.repos.reviewRuns.upsertByIdempotency({
      pullRequestId: pr.id,
      idempotencyKey: key,
      trigger,
      triggeredBy,
      headSha: pr.headSha,
      reviewerName: deps.reviewer.name,
    });

    if (isResolved(run)) {
      logger.info({ run_id: run.id, state: run.state }, 'review.already_resolved');
      return;
    }

    // ── 4. React eyes if this came from a mention ─────────────────────────
    if (deps.mention && prInfo.commentId !== undefined) {
      const tok = await deps.github.installationToken(repository.installationId);
      await deps.github.reactToComment({
        token: tok,
        owner: repository.owner,
        repo: repository.name,
        commentId: asGithubCommentId(prInfo.commentId),
        content: 'eyes',
      });
    }

    // ── 5. Drive the state machine ────────────────────────────────────────
    return withContextAsync({ reviewRunId: run.id }, async () => {
      const start = Date.now();
      const token = await deps.github.installationToken(repository.installationId);
      const owner = repository.owner;
      const repo = repository.name;

      const tmp = await mkdtemp(join(tmpdir(), `gcr-clone-${run.id}-`));
      let lastState = run.state;

      try {
        const r1 = await deps.repos.reviewRuns.transition(run.id, lastState, {
          state: 'preparing',
          attemptsIncrement: true,
        });
        lastState = r1.state;

        const r2 = await deps.repos.reviewRuns.transition(run.id, lastState, { state: 'fetching' });
        lastState = r2.state;
        const { workspaceDir } = await deps.github.cloneHead({
          token,
          owner,
          repo,
          headSha: pr.headSha,
          targetDir: tmp,
        });
        const diff = await deps.github.fetchDiff({
          token,
          owner,
          repo,
          base: pr.baseSha,
          head: pr.headSha,
        });

        const r3 = await deps.repos.reviewRuns.transition(run.id, lastState, { state: 'reviewing' });
        lastState = r3.state;

        // Switch to summary mode when the diff is huge — caps cost on a PR
        // that touches a vendored library / lockfile / generated file.
        const diffMode = selectDiffMode(diff.length);
        const summaryAddendum =
          diffMode === 'summary'
            ? '\n\nThe diff is unusually large; produce a per-file summary rather than line-level findings.'
            : '';
        const promptAddendum = (repository.settings.promptAddendum ?? '') + summaryAddendum;

        const result = await deps.reviewer.review({
          workspaceDir,
          diff,
          pr: {
            owner,
            repo,
            number: pr.githubPrNumber as number,
            title: pr.title,
            description: (payload.pull_request as { body?: string } | undefined)?.body ?? '',
            authorLogin: pr.authorLogin,
            headSha: pr.headSha,
            baseSha: pr.baseSha,
          },
          settings: {
            ...(repository.settings.model !== undefined ? { model: repository.settings.model } : {}),
            ...(repository.settings.reviewerProvider !== undefined
              ? { reviewerProvider: repository.settings.reviewerProvider }
              : {}),
            ...(promptAddendum ? { promptAddendum } : {}),
          },
          signal,
        });

        const r4 = await deps.repos.reviewRuns.transition(run.id, lastState, {
          state: 'posting',
          model: result.meta.model ?? null,
          reviewerVersion: result.meta.reviewerVersion,
        });
        lastState = r4.state;

        const formatted = format(result.summary, result.findings, repository.settings);
        const summaryWithMarker = `${marker}${run.id}-->\n${formatted.summaryBody}`;

        const posted = await deps.github.postReview(
          {
            owner,
            repo,
            prNumber: pr.githubPrNumber,
            headSha: pr.headSha,
            summaryBody: summaryWithMarker,
            verdict: formatted.verdict,
            inlineComments: formatted.inlineComments,
          },
          token,
        );

        const nowIso = new Date().toISOString();
        await deps.repos.reviewRuns.saveComments(
          run.id,
          formatted.inlineComments.map((c, i) => ({
            filePath: c.path,
            lineStart: c.line,
            lineEnd: c.line,
            severity: result.findings[i]?.severity ?? 'suggestion',
            body: c.body,
            githubCommentId: posted.inlineCommentIds[i] ?? null,
            postedAt: nowIso,
          })),
        );

        await deps.repos.reviewRuns.transition(run.id, lastState, {
          state: 'completed',
          githubReviewId: posted.githubReviewId,
          durationMs: Date.now() - start,
          ...(result.meta.costUsdMicros !== undefined
            ? { costUsdMicros: result.meta.costUsdMicros }
            : {}),
        });

        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'review.posted',
          subjectType: 'review_run',
          subjectId: String(run.id),
          data: { findings: formatted.inlineComments.length },
        });

        deps.metrics.reviewRunsTotal.inc({ state: 'completed', trigger });
        deps.metrics.reviewRunDurationSeconds.observe(
          { state: 'completed' },
          (Date.now() - start) / 1000,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errClass = err instanceof Error ? err.constructor.name : 'unknown';
        // Best effort: try to land in `failed`. If the optimistic lock fights us
        // (some other worker already touched the row) we log and rethrow.
        const fresh = await deps.repos.reviewRuns.byId(run.id);
        const from = fresh?.state ?? lastState;
        await deps.repos.reviewRuns
          .transition(run.id, from, {
            state: 'failed',
            errorClass: errClass,
            errorMessage: message.slice(0, 8000),
            durationMs: Date.now() - start,
          })
          .catch((e: unknown) => logger.error({ err: e }, 'review.transition_to_failed_failed'));

        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'review.failed',
          subjectType: 'review_run',
          subjectId: String(run.id),
          data: { error: errClass, message: message.slice(0, 500) },
        });
        deps.metrics.reviewRunsTotal.inc({ state: 'failed', trigger });
        throw err;
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {/* swallow */});
      }
    });
  };
}

/** Midnight UTC of the current day, ISO-8601. */
function startOfTodayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

interface ExtractedPrInfo {
  readonly githubRepoId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: GithubPrNumber;
  readonly headSha: string;
  readonly baseSha: string;
  readonly authorLogin: string;
  readonly isDraft: boolean;
  readonly title: string;
  readonly commentId?: number;
  readonly commenterLogin?: string;
}

function extractPrInfo(
  payload: Record<string, unknown>,
  isMention: boolean,
): ExtractedPrInfo | null {
  const repoNode = payload.repository as
    | { id?: number; full_name?: string; owner?: { login?: string }; name?: string }
    | undefined;
  if (!repoNode?.id || !repoNode.owner?.login || !repoNode.name) return null;
  const owner = repoNode.owner.login;
  const repo = repoNode.name;
  const githubRepoId = repoNode.id;

  if (isMention) {
    const issue = payload.issue as
      | {
          number?: number;
          pull_request?: unknown;
          user?: { login?: string };
          body?: string;
          title?: string;
          draft?: boolean;
        }
      | undefined;
    const comment = payload.comment as
      | { id?: number; user?: { login?: string } }
      | undefined;
    if (!issue?.number || !issue.pull_request) return null;
    // The issue_comment payload doesn't carry head/base SHAs. Return sentinels;
    // the handler detects them and calls GithubAppClient.getPullRequest to fill in.
    return {
      githubRepoId,
      owner,
      repo,
      prNumber: asGithubPrNumber(issue.number),
      headSha: MENTION_PLACEHOLDER_HEAD,
      baseSha: MENTION_PLACEHOLDER_BASE,
      authorLogin: issue.user?.login ?? 'unknown',
      isDraft: !!issue.draft,
      title: issue.title ?? '',
      ...(comment?.id !== undefined ? { commentId: comment.id } : {}),
      ...(comment?.user?.login !== undefined ? { commenterLogin: comment.user.login } : {}),
    };
  }

  const pr = payload.pull_request as
    | {
        number?: number;
        head?: { sha?: string };
        base?: { sha?: string };
        user?: { login?: string };
        draft?: boolean;
        title?: string;
      }
    | undefined;
  if (!pr?.number || !pr.head?.sha || !pr.base?.sha) return null;
  return {
    githubRepoId,
    owner,
    repo,
    prNumber: asGithubPrNumber(pr.number),
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    authorLogin: pr.user?.login ?? 'unknown',
    isDraft: !!pr.draft,
    title: pr.title ?? '',
  };
}
