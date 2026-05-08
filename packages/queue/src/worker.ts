import { RetryableError } from '@gcr/core';
import { type Logger, withContextAsync } from '@gcr/observability';
import type { JobQueue } from './queue.js';
import type { Handler, Job } from './types.js';

export interface WorkerLoopOptions {
  /** Identifier persisted in `locked_by`. e.g. `worker-${hostname}-${pid}`. */
  readonly workerId: string;
  /** Time between empty-poll sleeps. */
  readonly idlePollMs?: number;
  /** Log per-job events. */
  readonly logger: Logger;
  /** Stale-lock threshold (default 15 min). */
  readonly staleLockMs?: number;
  /** Stop loop when this signal aborts. */
  readonly signal: AbortSignal;
  /** Optional metric hooks. */
  readonly onJobStarted?: (j: Job) => void;
  readonly onJobCompleted?: (j: Job, ms: number) => void;
  readonly onJobFailed?: (j: Job, ms: number, requeued: boolean, err: unknown) => void;
}

export interface WorkerLoopHandlers {
  readonly handlers: Readonly<Record<string, Handler>>;
}

/**
 * Run the worker loop until `signal` aborts.
 *
 * Each iteration:
 *   1. release stale locks once a minute (also at startup)
 *   2. pick one job
 *   3. run it within a propagated correlation context
 *   4. mark completed, retry, or terminal-fail
 *
 * Single-threaded per process. Concurrency = multiple worker processes,
 * coordinated through atomic pickOne.
 */
export async function runWorkerLoop(
  queue: JobQueue,
  cfg: WorkerLoopOptions,
  reg: WorkerLoopHandlers,
): Promise<void> {
  const idle = cfg.idlePollMs ?? 1000;
  const stale = cfg.staleLockMs ?? 15 * 60 * 1000;

  // Sweep stale locks at startup so a worker that just crashed reclaims its
  // own dropped jobs immediately, not after a 60s wait.
  try {
    const released = await queue.releaseStaleLocks(stale);
    if (released > 0) cfg.logger.warn({ released }, 'queue.stale_locks_released_at_startup');
  } catch (err) {
    cfg.logger.error({ err }, 'queue.stale_locks_sweep_failed');
  }
  let lastSweep = Date.now();

  while (!cfg.signal.aborted) {
    if (Date.now() - lastSweep > 60_000) {
      try {
        const released = await queue.releaseStaleLocks(stale);
        if (released > 0) cfg.logger.warn({ released }, 'queue.stale_locks_released');
      } catch (err) {
        cfg.logger.error({ err }, 'queue.stale_locks_sweep_failed');
      }
      lastSweep = Date.now();
    }

    const job = await queue.pickOne(cfg.workerId);
    if (!job) {
      await sleep(idle, cfg.signal);
      continue;
    }

    cfg.onJobStarted?.(job);
    cfg.logger.info({ job_id: job.id, job_name: job.name, attempts: job.attempts }, 'job.started');
    const t0 = Date.now();

    const handler = reg.handlers[job.name];
    if (!handler) {
      const msg = `no handler registered for ${job.name}`;
      await queue.markFailed(job.id, msg);
      cfg.logger.error({ job_id: job.id, job_name: job.name }, msg);
      cfg.onJobFailed?.(job, Date.now() - t0, false, new Error(msg));
      continue;
    }

    try {
      await withContextAsync({ jobId: job.id }, async () => {
        await handler({ job, logger: cfg.logger, signal: cfg.signal });
      });
      await queue.markCompleted(job.id);
      cfg.logger.info({ job_id: job.id, ms: Date.now() - t0 }, 'job.completed');
      cfg.onJobCompleted?.(job, Date.now() - t0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = err instanceof RetryableError;
      const ms = Date.now() - t0;

      if (isRetryable) {
        const { requeued } = await queue.markFailedOrRequeue(job.id, msg);
        cfg.logger[requeued ? 'warn' : 'error'](
          { job_id: job.id, ms, retryable: true, requeued },
          'job.retryable_failure',
        );
        cfg.onJobFailed?.(job, ms, requeued, err);
      } else {
        // Terminal: skip retries entirely.
        await queue.markFailed(job.id, msg);
        cfg.logger.error({ job_id: job.id, ms, err: msg }, 'job.terminal_failure');
        cfg.onJobFailed?.(job, ms, false, err);
      }
    }
  }
  cfg.logger.info({}, 'worker.loop_exited');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
