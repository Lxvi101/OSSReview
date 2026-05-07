import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FatalError, RetryableError } from '@gcr/core';
import type { Logger } from '@gcr/observability';
import { redactTokens } from '@gcr/observability';
import Docker from 'dockerode';
import type { ReviewResult, Reviewer, ReviewerInput } from '../port.js';
import { SandboxOutputSchema, type SandboxRequest } from './protocol.js';

/**
 * Per-review Docker sandbox runner.
 *
 * Lifecycle:
 *   1. Worker prepares a workspace directory on the host (clone done outside).
 *   2. Worker calls `runner.review(input)` which:
 *      a. mounts workspace read-only at /workspace
 *      b. mounts a tiny tmpfs for /tmp and the secret
 *      c. drops caps, applies seccomp, restricts network to the egress bridge
 *      d. starts the container with the JSON request piped to stdin
 *      e. captures stdout (the response) and stderr (logs)
 *      f. enforces a wall-clock timeout
 *   3. Always cleans up via `removeContainer` (also handled by the reaper).
 *
 * The runner implements `Reviewer`, so the worker treats it identically to
 * any other reviewer.
 */
export interface SandboxRunnerConfig {
  readonly image: string; // digest-pinned in production
  readonly dockerHost: string; // unix:///var/run/docker.sock
  /** Anthropic API key. Mounted via tmpfs file at /etc/secrets/anthropic inside. */
  readonly anthropicApiKey: string;
  /** Network name with egress firewall to api.anthropic.com only. */
  readonly networkName: string;
  /** Hard wall clock limit. */
  readonly timeoutMs: number;
  /** Memory cap (bytes). */
  readonly memoryBytes: number;
  /** CPU quota (1.0 = one core). */
  readonly cpus: number;
  /** Process limit (PIDs). */
  readonly pidsLimit: number;
  /** uid:gid the container's process runs as. */
  readonly runAs: { uid: number; gid: number };
  /** Path to seccomp profile JSON on the host. */
  readonly seccompProfilePath?: string;
}

export class SandboxRunner implements Reviewer {
  readonly name = 'claude-code-sandbox';
  readonly version = '1.0.0';

  private readonly docker: Docker;

  constructor(
    private readonly cfg: SandboxRunnerConfig,
    private readonly logger: Logger,
  ) {
    // dockerode parses unix:// URLs via socketPath; we extract that.
    const socketPath = cfg.dockerHost.startsWith('unix://')
      ? cfg.dockerHost.slice('unix://'.length)
      : undefined;
    this.docker = socketPath ? new Docker({ socketPath }) : new Docker({ host: cfg.dockerHost });
  }

  async review(input: ReviewerInput): Promise<ReviewResult> {
    const runId = `gcr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const start = Date.now();

    // Stage the API key into a host tmpfs file the entrypoint will mount.
    // We use a per-run path to avoid cross-run leakage if the host is shared.
    const secretHostPath = join(tmpdir(), `${runId}.anthropic`);
    await writeFile(secretHostPath, this.cfg.anthropicApiKey, { mode: 0o400 });

    const request: SandboxRequest = {
      pr: input.pr,
      diff: input.diff,
      settings: input.settings,
      workspaceDir: '/workspace',
    };

    const hostConfig: Docker.ContainerCreateOptions['HostConfig'] = {
      AutoRemove: false, // we remove explicitly so we can capture logs first
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [
        'no-new-privileges',
        ...(this.cfg.seccompProfilePath ? [`seccomp=${this.cfg.seccompProfilePath}`] : []),
      ],
      PidsLimit: this.cfg.pidsLimit,
      Memory: this.cfg.memoryBytes,
      MemorySwap: this.cfg.memoryBytes,
      NanoCpus: Math.floor(this.cfg.cpus * 1e9),
      NetworkMode: this.cfg.networkName,
      Mounts: [
        {
          Type: 'bind',
          Source: input.workspaceDir,
          Target: '/workspace',
          ReadOnly: true,
        },
        {
          Type: 'bind',
          Source: secretHostPath,
          Target: '/etc/secrets/anthropic',
          ReadOnly: true,
        },
      ],
      Tmpfs: {
        '/tmp': 'size=64m,mode=1777',
        '/run': 'size=8m,mode=1777',
      },
    };

    const container = await this.docker.createContainer({
      Image: this.cfg.image,
      Labels: { 'gcr.run-id': runId },
      Env: [], // never put the API key in env; entrypoint reads from /etc/secrets/anthropic
      User: `${this.cfg.runAs.uid}:${this.cfg.runAs.gid}`,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: hostConfig,
      StopTimeout: 5,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    try {
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });

      // Multiplexed stream demuxer: dockerode provides modem.demuxStream.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const stdoutPipe = new (await import('node:stream')).PassThrough();
      const stderrPipe = new (await import('node:stream')).PassThrough();
      stdoutPipe.on('data', (b: Buffer) => stdoutChunks.push(b));
      stderrPipe.on('data', (b: Buffer) => stderrChunks.push(b));
      this.docker.modem.demuxStream(stream, stdoutPipe, stderrPipe);

      // Send the request, then close stdin.
      stream.write(`${JSON.stringify(request)}\n`);
      stream.end();

      await container.start();

      // Race wait vs timeout vs caller abort.
      const waitPromise = container.wait();
      const timeoutPromise = new Promise<{ TimedOut: true }>((resolve) =>
        setTimeout(() => resolve({ TimedOut: true }), Math.min(this.cfg.timeoutMs, input.settings.walClockMs ?? this.cfg.timeoutMs)),
      );
      const abortPromise = new Promise<{ Aborted: true }>((_, reject) => {
        if (input.signal.aborted) reject(new Error('aborted'));
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

      const winner = await Promise.race([waitPromise, timeoutPromise, abortPromise]);
      if ('TimedOut' in winner) {
        timedOut = true;
        try { await container.stop({ t: 5 }); } catch {/* already gone */}
      }

      stdout = redactTokens(Buffer.concat(stdoutChunks).toString('utf8'));
      stderr = redactTokens(Buffer.concat(stderrChunks).toString('utf8'));

      if (timedOut) {
        throw new RetryableError(
          'sandbox.timeout',
          `sandbox exceeded wall-clock ${this.cfg.timeoutMs}ms`,
          { delayMs: 30_000 },
        );
      }

      const parsed = SandboxOutputSchema.safeParse(JSON.parse(stdout || '{}'));
      if (!parsed.success) {
        throw new FatalError(
          'sandbox.bad_output',
          `sandbox output failed schema: ${parsed.error.message}; stderr=${stderr.slice(0, 500)}`,
        );
      }
      if (!parsed.data.ok) {
        throw new RetryableError(
          `sandbox.${parsed.data.error.code}`,
          parsed.data.error.message,
        );
      }

      const r = parsed.data.result;
      const out: Mutable<ReviewResult> = {
        summary: r.summary,
        findings: r.findings.map((f) => ({
          filePath: f.filePath,
          severity: f.severity,
          body: f.body,
          ...(f.lineStart !== undefined ? { lineStart: f.lineStart } : {}),
          ...(f.lineEnd !== undefined ? { lineEnd: f.lineEnd } : {}),
          ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
          ...(f.category !== undefined ? { category: f.category } : {}),
        })),
        meta: {
          reviewerName: r.meta.reviewerName,
          reviewerVersion: r.meta.reviewerVersion,
          durationMs: Date.now() - start,
          ...(r.meta.model !== undefined ? { model: r.meta.model } : {}),
          ...(r.meta.inputTokens !== undefined ? { inputTokens: r.meta.inputTokens } : {}),
          ...(r.meta.outputTokens !== undefined ? { outputTokens: r.meta.outputTokens } : {}),
          ...(r.meta.cachedInputTokens !== undefined ? { cachedInputTokens: r.meta.cachedInputTokens } : {}),
          ...(r.meta.costUsdMicros !== undefined ? { costUsdMicros: r.meta.costUsdMicros } : {}),
        },
      };
      return out;
    } finally {
      try {
        await container.remove({ force: true });
      } catch (err) {
        this.logger.warn({ err, runId }, 'sandbox.remove_failed');
      }
      // Best-effort secret unlink.
      try {
        await (await import('node:fs/promises')).unlink(secretHostPath);
      } catch (err) {
        this.logger.warn({ err, runId }, 'sandbox.secret_unlink_failed');
      }
    }
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
