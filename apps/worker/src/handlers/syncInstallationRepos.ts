import { FatalError, asGithubInstallationId, asGithubRepoId } from '@gcr/core';
import type { Logger } from '@gcr/observability';
import type { Handler } from '@gcr/queue';
import type { Repositories } from '@gcr/storage';

/**
 * Handle the full installation / installation_repositories lifecycle.
 *
 * Events we react to:
 *   - installation.created                  → upsert payload.repositories
 *   - installation.deleted                  → disable ALL repos for this installation
 *   - installation.suspended                → disable ALL repos for this installation
 *   - installation.unsuspended              → re-enable ALL repos for this installation
 *   - installation_repositories.added       → upsert payload.repositories_added
 *   - installation_repositories.removed     → disable payload.repositories_removed
 *
 * "Disable" rather than "delete" is deliberate: the row carries history (review
 * runs, comments) that the UI still needs to render. A disabled repo simply
 * doesn't get reviewed. Re-adding it via GitHub flips it back to enabled.
 *
 * The payload is read from the persisted webhook delivery — the installation
 * token is not needed because the payload already contains the repo list.
 */

export interface SyncReposDeps {
  readonly repos: Repositories;
  readonly logger: Logger;
}

interface JobData {
  readonly deliveryId: string;
}

interface RepoRef {
  readonly id?: number;
  readonly name?: string;
  readonly full_name?: string;
}

interface InstallationPayload {
  readonly action?: string;
  readonly installation?: {
    readonly id?: number;
    readonly account?: { readonly login?: string };
  };
  readonly repositories?: ReadonlyArray<RepoRef>;
  readonly repositories_added?: ReadonlyArray<RepoRef>;
  readonly repositories_removed?: ReadonlyArray<RepoRef>;
}

export function makeSyncInstallationReposHandler(
  deps: SyncReposDeps,
): Handler<string, JobData> {
  return async ({ job, logger }) => {
    const delivery = await deps.repos.webhookDeliveries.byDeliveryId(job.data.deliveryId);
    if (!delivery) throw new FatalError('install_sync.unknown_delivery', job.data.deliveryId);
    const payload = JSON.parse(delivery.payloadJson) as InstallationPayload;
    const installationId = payload.installation?.id;
    if (!installationId) {
      logger.warn({ deliveryId: job.data.deliveryId }, 'install_sync.no_installation_id');
      return;
    }
    const ghInstallId = asGithubInstallationId(installationId);
    const action = payload.action ?? '';
    const event = delivery.event;

    // Whole-installation lifecycle: bulk enable/disable.
    if (event === 'installation') {
      if (action === 'deleted' || action === 'suspended') {
        const n = await deps.repos.repositories.setEnabledForInstallation(ghInstallId, false);
        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: action === 'deleted' ? 'repo.removed' : 'repo.removed',
          subjectType: 'installation',
          subjectId: String(installationId),
          data: { event: `installation.${action}`, disabled: n },
        });
        logger.info({ installationId, action, disabled: n }, 'install_sync.installation_disabled');
        return;
      }
      if (action === 'unsuspended') {
        const n = await deps.repos.repositories.setEnabledForInstallation(ghInstallId, true);
        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'repo.added',
          subjectType: 'installation',
          subjectId: String(installationId),
          data: { event: 'installation.unsuspended', enabled: n },
        });
        logger.info({ installationId, action, enabled: n }, 'install_sync.installation_enabled');
        return;
      }
      // installation.created (or any other action that carries a repo list)
      // falls through to the upsert path below using payload.repositories.
    }

    // Per-repo additions: installation.created carries `repositories`,
    // installation_repositories.added carries `repositories_added`.
    const toAdd = payload.repositories ?? payload.repositories_added ?? [];
    for (const repo of toAdd) {
      if (!repo.id || !repo.full_name) continue;
      const [owner, name] = repo.full_name.split('/');
      if (!owner || !name) continue;
      const upserted = await deps.repos.repositories.upsertFromInstallation({
        githubRepoId: asGithubRepoId(repo.id),
        owner,
        name,
        installationId: ghInstallId,
      });
      // upsertFromInstallation flips `enabled=1` for new rows but does NOT
      // re-enable existing ones. Force enable here — re-adding via GitHub
      // is an explicit "I want this on again" signal.
      await deps.repos.repositories.setEnabled(upserted.id, true);
      await deps.repos.auditLog.record({
        actor: 'worker',
        kind: 'repo.added',
        subjectType: 'repository',
        subjectId: String(upserted.id),
        data: { fullName: repo.full_name, installationId },
      });
      logger.info({ repo: repo.full_name }, 'install_sync.repo_upserted');
    }

    // Per-repo removals: installation_repositories.removed carries
    // `repositories_removed`. Disable rather than delete so historical review
    // runs / comments stay visible in the UI.
    const toRemove = payload.repositories_removed ?? [];
    for (const repo of toRemove) {
      if (!repo.id) continue;
      const existing = await deps.repos.repositories.byGithubId(asGithubRepoId(repo.id));
      if (!existing) {
        logger.warn(
          { repo: repo.full_name ?? repo.id },
          'install_sync.remove_unknown_repo — not in our DB',
        );
        continue;
      }
      await deps.repos.repositories.setEnabled(existing.id, false);
      await deps.repos.auditLog.record({
        actor: 'worker',
        kind: 'repo.removed',
        subjectType: 'repository',
        subjectId: String(existing.id),
        data: { fullName: repo.full_name, installationId },
      });
      logger.info({ repo: repo.full_name ?? repo.id }, 'install_sync.repo_disabled');
    }
  };
}
