/**
 * Composition root for the worker process.
 *
 * Boot lifecycle:
 *   env → logger
 *       → SQLite (open + verify migrations are current)
 *       → Repositories
 *       → JobQueue
 *       → wait for GitHub App credentials in the settings table (poll;
 *         never crash — the operator may not have completed `/setup` yet)
 *       → InstallationTokenCache + GithubClient
 *       → local subscription-backed reviewer provider router
 *       → handlers, runWorkerLoop
 *
 * Why the worker waits instead of crashing: with `docker compose up` the
 * worker and server start at the same time, but the operator hasn't run
 * the setup wizard yet. We don't want a crash-loop until they do.
 */

import { hostname } from 'node:os';
import { loadBootEnv } from '@gcr/config';
import { SystemClock } from '@gcr/core';
import { GithubClient, InstallationTokenCache } from '@gcr/github';
import { type Logger, Metrics, buildLogger } from '@gcr/observability';
import { type Handler, JobQueue, runWorkerLoop } from '@gcr/queue';
import { ProviderRouterReviewer } from '@gcr/reviewer';
import { ClaudeReviewer } from '@gcr/reviewer/claude';
import { CodexReviewer } from '@gcr/reviewer/codex';
import {
  type Repositories,
  SecretBox,
  currentVersion,
  makeRepositories,
  openDatabase,
} from '@gcr/storage';
import { makeReconcileInstallationReposHandler } from './handlers/reconcileInstallationRepos.js';
import { makeReviewPrHandler } from './handlers/reviewPr.js';
import { makeSyncInstallationReposHandler } from './handlers/syncInstallationRepos.js';

interface ResolvedSecrets {
  readonly appId: number;
  readonly privateKey: string;
}

async function main(): Promise<void> {
  const env = loadBootEnv();
  const logger = buildLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
  logger.info({ node: process.version, pid: process.pid }, 'worker.boot');

  const handle = openDatabase({ path: env.DATABASE_PATH });
  if (currentVersion(handle) === 0) {
    // The server runs migrations at boot — wait it out instead of crashing.
    await waitForMigrations(handle, logger);
  }

  const clock = new SystemClock();
  const secretBox = new SecretBox(env.SECRETS_KEY);
  const repos = makeRepositories(handle.kysely, { clock, secretBox });
  const queue = new JobQueue(handle.kysely, clock);
  const metrics = new Metrics();

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'worker.shutdown');
    controller.abort();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Wait until the operator has finished `/setup` (provides GitHub creds).
  // Reviewer credentials come from the local Claude/Codex CLI homes.
  const secrets = await waitForCredentials(repos, logger, controller.signal);
  if (controller.signal.aborted) {
    await handle.destroy();
    return;
  }

  const tokenCache = new InstallationTokenCache({
    appId: secrets.appId,
    privateKey: secrets.privateKey,
  });
  const github = new GithubClient(tokenCache, logger);

  const reviewer = new ProviderRouterReviewer({
    defaultProvider: env.REVIEWER_PROVIDER,
    claude: new ClaudeReviewer({
      binaryPath: env.CLAUDE_CODE_BINARY,
      homePath: env.CLAUDE_CODE_HOME,
      defaultModel: env.CLAUDE_CODE_MODEL,
    }),
    codex: new CodexReviewer({
      binaryPath: env.CODEX_BINARY,
      homePath: env.CODEX_HOME,
      defaultModel: env.CODEX_MODEL,
      timeoutMs: env.REVIEWER_TIMEOUT_MS,
    }),
  });

  const handlers: Record<string, Handler> = {
    review_pr: makeReviewPrHandler({ repos, github, reviewer, metrics, logger }) as Handler,
    review_pr_mention: makeReviewPrHandler({
      repos,
      github,
      reviewer,
      metrics,
      logger,
      mention: true,
    }) as Handler,
    sync_installation_repos: makeSyncInstallationReposHandler({ repos, logger }) as Handler,
    reconcile_installation_repos: makeReconcileInstallationReposHandler({
      repos,
      github,
      logger,
    }) as Handler,
  };

  await runWorkerLoop(
    queue,
    {
      workerId: `worker-${hostname()}-${process.pid}`,
      logger,
      signal: controller.signal,
      onJobStarted: (j) => metrics.jobsInFlight.inc({ name: j.name }),
      onJobCompleted: (j) => metrics.jobsInFlight.dec({ name: j.name }),
      onJobFailed: (j, _ms, requeued) => {
        metrics.jobsInFlight.dec({ name: j.name });
        if (!requeued) metrics.jobsDlq.inc({ name: j.name });
      },
    },
    { handlers },
  );

  await handle.destroy();
  process.exit(0);
}

const POLL_MS = 5_000;

async function waitForMigrations(
  handle: ReturnType<typeof openDatabase>,
  logger: Logger,
): Promise<void> {
  let warned = false;
  while (currentVersion(handle) === 0) {
    if (!warned) {
      logger.info({}, 'worker.boot.waiting_for_migrations');
      warned = true;
    }
    await sleep(POLL_MS);
  }
}

async function waitForCredentials(
  repos: Repositories,
  logger: Logger,
  signal: AbortSignal,
): Promise<ResolvedSecrets> {
  let warned = false;
  while (!signal.aborted) {
    const appId = await repos.settings.getPlain<number>('github.app.id');
    const privateKey = await repos.settings.getSecret('github.app.private_key');

    if (appId && privateKey) {
      logger.info({}, 'worker.boot.credentials_resolved');
      return { appId, privateKey };
    }

    if (!warned) {
      logger.warn(
        {
          have_github_app: !!(appId && privateKey),
        },
        'worker.boot.waiting_for_credentials — finish /setup',
      );
      warned = true;
    }
    await sleep(POLL_MS);
  }
  // Aborted: return a placeholder; caller checks `signal.aborted`.
  return { appId: 0, privateKey: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
