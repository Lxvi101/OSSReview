import type { Logger } from '@gcr/observability';
import Docker from 'dockerode';

/**
 * Container reaper.
 *
 * Two callers:
 *   - At worker startup: kill any container labeled `gcr.run-id=...` left
 *     behind by a previous crashed process.
 *   - Periodically: kill any such container older than `maxAgeMs` (default 1h).
 *
 * The cap on container lifetime defends against runaway agents that somehow
 * survive the runner's wall-clock cap (for instance, after `docker daemon`
 * itself was restarted).
 */
export class SandboxReaper {
  private readonly docker: Docker;

  constructor(
    cfg: { dockerHost: string },
    private readonly logger: Logger,
  ) {
    const socketPath = cfg.dockerHost.startsWith('unix://')
      ? cfg.dockerHost.slice('unix://'.length)
      : undefined;
    this.docker = socketPath ? new Docker({ socketPath }) : new Docker({ host: cfg.dockerHost });
  }

  async sweep(opts: { maxAgeMs?: number } = {}): Promise<{ killed: number }> {
    const maxAge = opts.maxAgeMs ?? 60 * 60 * 1000;
    const cutoffSec = Math.floor((Date.now() - maxAge) / 1000);
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['gcr.run-id'] },
    });
    let killed = 0;
    for (const c of containers) {
      // c.Created is unix seconds.
      if (c.Created > cutoffSec) continue;
      try {
        const handle = this.docker.getContainer(c.Id);
        await handle.remove({ force: true });
        killed++;
        this.logger.warn({ id: c.Id, image: c.Image }, 'sandbox.reaper.killed_stale');
      } catch (err) {
        this.logger.warn({ err, id: c.Id }, 'sandbox.reaper.kill_failed');
      }
    }
    return { killed };
  }
}
