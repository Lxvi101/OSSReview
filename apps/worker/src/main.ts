/**
 * Worker composition root.
 *
 * Boot:
 *   env → logger
 *       → SQLite (open, run migrations)
 *       → Repositories
 *       → JobQueue
 *       → crash recovery: any non-terminal review_runs become 'failed'
 *       → wait for GitHub App credentials in the settings table
 *       → InstallationTokenCache + GithubClient
 *       → reviewer router
 *       → handlers, runWorkerLoop
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadBootEnv } from '@gcr/config';
import { SystemClock } from '@gcr/core';
import { GithubClient, InstallationTokenCache } from '@gcr/github';
import { type Logger, Metrics, buildLogger } from '@gcr/observability';
import { type Handler, JobQueue, runWorkerLoop } from '@gcr/queue';
import { ProviderRouterReviewer } from '@gcr/reviewer';
import { AcpReviewer, resolveAcpPreset } from '@gcr/reviewer/acp';
import { ClaudeReviewer } from '@gcr/reviewer/claude';
import { CodexReviewer } from '@gcr/reviewer/codex';
import {
  type Repositories,
  SecretBox,
  makeRepositories,
  openDatabase,
  runMigrations,
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

  seedReviewerCredentialsFromHost(logger);

  const handle = openDatabase({ path: env.DATABASE_PATH });
  // Idempotent: server may have already run migrations. Either process can
  // own them; whichever boots first applies them.
  runMigrations(handle, { logger });

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

  // Crash recovery: any review_run still in a non-terminal state on boot
  // belongs to a worker that died. Mark them failed with a clear cause; the
  // user can retry by mentioning the bot. We use the freshest state per row
  // so a cancel-request that landed first wins.
  const stuck = await repos.reviewRuns.findNonTerminal();
  for (const r of stuck) {
    try {
      await repos.reviewRuns.transition(r.id, r.state, {
        state: 'failed',
        errorClass: 'WorkerRestart',
        errorMessage: `worker restarted while in ${r.state}`,
      });
      logger.warn({ run_id: r.id, prev_state: r.state }, 'review.recovered_to_failed');
    } catch (err: unknown) {
      logger.warn({ run_id: r.id, err }, 'review.recover_failed');
    }
  }

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
    acp: new AcpReviewer({
      preset: resolveAcpPreset(env),
      ...(env.ACP_AGENT_HOME ? { homePath: env.ACP_AGENT_HOME } : {}),
      ...(env.ACP_MODEL ? { defaultModel: env.ACP_MODEL } : {}),
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
      logger.warn({}, 'worker.boot.waiting_for_credentials — finish /setup');
      warned = true;
    }
    await sleep(POLL_MS);
  }
  // Aborted: caller checks signal.aborted.
  return { appId: 0, privateKey: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Seed reviewer credentials from a host-mounted directory if present, so
// users on Dokploy (and similar push-button hosts) can avoid an interactive
// `claude auth login` inside the container. Only writes if the destination
// file doesn't already exist — once seeded, the worker owns refreshes and
// we never overwrite a fresher in-container token with a stale host one.
function seedReviewerCredentialsFromHost(logger: Logger): void {
  const home = process.env.HOME ?? '/var/lib/gcr';
  const claudeRoot = process.env.CLAUDE_CODE_HOME || home;
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');

  const targets: ReadonlyArray<{ provider: string; src: string; dst: string }> = [
    {
      provider: 'claude',
      src: join(process.env.HOST_CLAUDE_HOME ?? '/host-claude', '.credentials.json'),
      dst: join(claudeRoot, '.claude', '.credentials.json'),
    },
    {
      provider: 'codex',
      src: join(process.env.HOST_CODEX_HOME ?? '/host-codex', 'auth.json'),
      dst: join(codexHome, 'auth.json'),
    },
  ];

  for (const t of targets) {
    try {
      if (!existsSync(t.src)) continue;
      if (existsSync(t.dst)) {
        logger.info({ provider: t.provider }, 'worker.boot.credentials_already_present');
        continue;
      }
      mkdirSync(join(t.dst, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(t.src, t.dst);
      logger.info(
        { provider: t.provider, dst: t.dst },
        'worker.boot.credentials_seeded_from_host',
      );
    } catch (err: unknown) {
      logger.warn({ provider: t.provider, err }, 'worker.boot.credentials_seed_failed');
    }
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
