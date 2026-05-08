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
 * The review handler. One factory, two job names (auto vs mention).
 *
 * The `mention` flag changes idempotency-key construction (per-comment vs
 * per-SHA) and adds an "eyes" reaction on the triggering comment.
 */

export interface ReviewHandlerDeps {
  readonly repos: Repositories;
  readonly github: GithubAppClient;
  readonly reviewer: Reviewer;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly mention?: boolean;
}

interface ReviewJobData {
  readonly deliveryId: string;
}

/**
 * Sentinel SHAs returned by `extractPrInfo` for `issue_comment` payloads
 * (which lack head/base). The handler detects them and fills via the API.
 */
const MENTION_PLACEHOLDER_HEAD = 'MENTION_UNKNOWN_HEAD';
const MENTION_PLACEHOLDER_BASE = 'MENTION_UNKNOWN_BASE';

export function makeReviewPrHandler(deps: ReviewHandlerDeps): Handler<string, ReviewJobData> {
  return async ({ job, logger, signal }) => {
    const { deliveryId } = job.data;
    const delivery = await deps.repos.webhookDeliveries.byDeliveryId(deliveryId);
    if (!delivery) {
      throw new FatalError('review.unknown_delivery', `delivery ${deliveryId} not found`);
    }
    const payload = JSON.parse(delivery.payloadJson) as Record<string, unknown>;

    const prInfo = extractPrInfo(payload, deps.mention === true);
    if (!prInfo) {
      logger.warn({ deliveryId }, 'review.no_pr_info');
      return;
    }

    const repository = await deps.repos.repositories.byGithubId(
      asGithubRepoId(prInfo.githubRepoId),
    );
    if (!repository) {
      throw new FatalError(
        'review.unknown_repo',
        `repo ${prInfo.owner}/${prInfo.repo} not tracked`,
      );
    }

    let prData = prInfo;
    if (
      prData.headSha === MENTION_PLACEHOLDER_HEAD ||
      prData.baseSha === MENTION_PLACEHOLDER_BASE
    ) {
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

    if (deps.mention) {
      const existing = await deps.repos.reviewRuns.countMentionRunsForHead(pr.id, pr.headSha);
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

    const key: IdempotencyKey = deps.mention
      ? prInfo.commentId !== undefined
        ? mentionIdempotencyKey(asGithubCommentId(prInfo.commentId))
        : asIdempotencyKey(`mention:noid:${deliveryId}`)
      : autoIdempotencyKey(repository.id, pr.githubPrNumber, pr.headSha);

    const triggeredBy = deps.mention ? (prInfo.commenterLogin ?? null) : null;

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

    return withContextAsync({ reviewRunId: run.id }, async () => {
      const start = Date.now();
      const token = await deps.github.installationToken(repository.installationId);
      const owner = repository.owner;
      const repo = repository.name;
      const runId = run.id;

      // Wire cancel signal: if the user clicks Cancel in the UI, the API
      // sets cancel_requested_at; the worker polls every 2s and aborts.
      const cancelController = new AbortController();
      const combined = mergeAbort([signal, cancelController.signal]);
      const cancelPoll = setInterval(() => {
        void deps.repos.reviewRuns.byId(runId).then((r) => {
          if (r?.cancelRequestedAt && !cancelController.signal.aborted) {
            cancelController.abort();
          }
        });
      }, 2000);

      const emit = (
        kind:
          | 'phase'
          | 'assistant_text'
          | 'assistant_thinking'
          | 'tool_use'
          | 'tool_result'
          | 'sdk_status'
          | 'error',
        payload: Record<string, unknown>,
      ): void => {
        void deps.repos.reviewEvents
          .append({ reviewRunId: runId, kind, payload })
          .catch((err: unknown) => logger.warn({ err, kind }, 'review_event.append_failed'));
      };

      const tmp = await mkdtemp(join(tmpdir(), `gcr-clone-${runId}-`));
      let lastState = run.state;

      const wasCancelled = (): boolean => cancelController.signal.aborted;

      const transitionTo = async (
        next: 'preparing' | 'fetching' | 'reviewing' | 'posting' | 'completed' | 'cancelled',
        patch: Parameters<typeof deps.repos.reviewRuns.transition>[2] = { state: next },
      ): Promise<void> => {
        const result = await deps.repos.reviewRuns.transition(runId, lastState, {
          ...patch,
          state: next,
        });
        lastState = result.state;
      };

      const finishAsCancelled = async (reason: string): Promise<void> => {
        emit('phase', { state: 'cancelled', reason });
        try {
          await transitionTo('cancelled', { state: 'cancelled', stateReason: reason });
        } catch (e: unknown) {
          logger.error({ err: e }, 'review.transition_to_cancelled_failed');
        }
        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'review.cancelled',
          subjectType: 'review_run',
          subjectId: String(runId),
          data: { reason },
        });
        deps.metrics.reviewRunsTotal.inc({ state: 'cancelled', trigger });
      };

      try {
        await transitionTo('preparing', { state: 'preparing', attemptsIncrement: true });
        emit('phase', { state: 'preparing' });

        if (wasCancelled()) {
          await finishAsCancelled('cancel_requested');
          return;
        }

        await transitionTo('fetching');
        emit('phase', {
          state: 'fetching',
          message: `cloning ${owner}/${repo}@${pr.headSha.slice(0, 7)}`,
        });
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
        emit('phase', { state: 'fetching', message: `diff: ${diff.length} bytes` });

        if (wasCancelled()) {
          await finishAsCancelled('cancel_requested');
          return;
        }

        await transitionTo('reviewing');
        emit('phase', { state: 'reviewing' });

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
            ...(repository.settings.model !== undefined
              ? { model: repository.settings.model }
              : {}),
            ...(repository.settings.reviewerProvider !== undefined
              ? { reviewerProvider: repository.settings.reviewerProvider }
              : {}),
            ...(promptAddendum ? { promptAddendum } : {}),
          },
          onEvent: (e) => emit(e.kind, e.payload),
          signal: combined,
        });

        if (wasCancelled()) {
          await finishAsCancelled('cancel_requested');
          return;
        }

        await transitionTo('posting', {
          state: 'posting',
          model: result.meta.model ?? null,
          reviewerVersion: result.meta.reviewerVersion,
        });
        emit('phase', {
          state: 'posting',
          findings: result.findings.length,
          verdict: result.summary.verdict,
        });

        const formatted = format(result.summary, result.findings, repository.settings);

        const posted = await deps.github.postReview(
          {
            owner,
            repo,
            prNumber: pr.githubPrNumber,
            headSha: pr.headSha,
            summaryBody: formatted.summaryBody,
            verdict: formatted.verdict,
            inlineComments: formatted.inlineComments,
          },
          token,
        );

        const nowIso = new Date().toISOString();
        await deps.repos.reviewRuns.saveComments(
          runId,
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

        await transitionTo('completed', {
          state: 'completed',
          githubReviewId: posted.githubReviewId,
          durationMs: Date.now() - start,
        });
        emit('phase', { state: 'completed', durationMs: Date.now() - start });

        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'review.posted',
          subjectType: 'review_run',
          subjectId: String(runId),
          data: { findings: formatted.inlineComments.length },
        });

        deps.metrics.reviewRunsTotal.inc({ state: 'completed', trigger });
        deps.metrics.reviewRunDurationSeconds.observe(
          { state: 'completed' },
          (Date.now() - start) / 1000,
        );
      } catch (err) {
        if (wasCancelled()) {
          await finishAsCancelled('cancel_requested');
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const errClass = err instanceof Error ? err.constructor.name : 'unknown';
        emit('error', { class: errClass, message: message.slice(0, 4000) });
        emit('phase', { state: 'failed', error: errClass });

        // Use the freshest state in case some other writer (e.g. cancel)
        // already touched the row.
        const fresh = await deps.repos.reviewRuns.byId(runId);
        const from = fresh?.state ?? lastState;
        await deps.repos.reviewRuns
          .transition(runId, from, {
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
          subjectId: String(runId),
          data: { error: errClass, message: message.slice(0, 500) },
        });
        deps.metrics.reviewRunsTotal.inc({ state: 'failed', trigger });
        throw err;
      } finally {
        clearInterval(cancelPoll);
        await rm(tmp, { recursive: true, force: true }).catch(() => {
          /* swallow */
        });
      }
    });
  };
}

function mergeAbort(signals: ReadonlyArray<AbortSignal>): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort();
      return c.signal;
    }
    s.addEventListener('abort', () => c.abort(), { once: true });
  }
  return c.signal;
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
    const comment = payload.comment as { id?: number; user?: { login?: string } } | undefined;
    if (!issue?.number || !issue.pull_request) return null;
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
