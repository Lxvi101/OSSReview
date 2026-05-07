import {
  type GithubAppClient,
  asGithubInstallationId,
  asGithubRepoId,
} from '@gcr/core';
import type { Logger } from '@gcr/observability';
import type { Handler } from '@gcr/queue';
import type { Repositories } from '@gcr/storage';

/**
 * Reconcile our `repositories` table with the truth from GitHub for a single
 * installation. Used by the user-triggered "Refresh from GitHub" button.
 *
 * Why this exists: GitHub's `installation_repositories` webhook sometimes
 * doesn't fire for revokes — particularly when the installation is in "All
 * repositories" mode and the user removes a repo from the App's reach via
 * settings, or when GitHub silently drops a delivery. The webhook flow is
 * "best effort"; this handler is the authoritative ground-truth sync.
 *
 * Algorithm:
 *   1. Mint an installation token, list every repo it can access.
 *   2. Diff against our DB rows for that installation.
 *   3. Repos in GitHub's list:    upsert + ensure enabled=1
 *   4. Repos in DB but NOT in GitHub's list:    set enabled=0
 *
 * Idempotent. Safe to run repeatedly. Cheap (one paginated API call).
 */

export interface ReconcileDeps {
  readonly repos: Repositories;
  readonly github: GithubAppClient;
  readonly logger: Logger;
}

interface JobData {
  readonly installationId: number;
}

export function makeReconcileInstallationReposHandler(
  deps: ReconcileDeps,
): Handler<string, JobData> {
  return async ({ job, logger }) => {
    const ghInstallId = asGithubInstallationId(job.data.installationId);
    const token = await deps.github.installationToken(ghInstallId);
    const liveRepos = await deps.github.listInstallationRepositories(token);
    const liveByGithubId = new Map(liveRepos.map((r) => [r.githubRepoId, r]));

    // Existing rows we know about for this installation.
    const dbRepos = await deps.repos.repositories.list({ installationId: ghInstallId });
    const dbByGithubId = new Map(dbRepos.map((r) => [r.githubRepoId as number, r]));

    let added = 0;
    let reEnabled = 0;
    let disabled = 0;
    let unchanged = 0;

    // Pass 1: walk GitHub's list. Upsert + force enabled.
    for (const repo of liveRepos) {
      const existing = dbByGithubId.get(repo.githubRepoId);
      const upserted = await deps.repos.repositories.upsertFromInstallation({
        githubRepoId: asGithubRepoId(repo.githubRepoId),
        owner: repo.owner,
        name: repo.name,
        installationId: ghInstallId,
      });
      if (!existing) {
        added++;
        await deps.repos.repositories.setEnabled(upserted.id, true);
        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'repo.added',
          subjectType: 'repository',
          subjectId: String(upserted.id),
          data: { fullName: `${repo.owner}/${repo.name}`, via: 'reconcile' },
        });
      } else if (!existing.enabled) {
        reEnabled++;
        await deps.repos.repositories.setEnabled(upserted.id, true);
        await deps.repos.auditLog.record({
          actor: 'worker',
          kind: 'repo.added',
          subjectType: 'repository',
          subjectId: String(upserted.id),
          data: { fullName: `${repo.owner}/${repo.name}`, via: 'reconcile_re_enable' },
        });
      } else {
        unchanged++;
      }
    }

    // Pass 2: anything we have that GitHub doesn't list anymore — disable it.
    for (const dbRepo of dbRepos) {
      if (liveByGithubId.has(dbRepo.githubRepoId as number)) continue;
      if (!dbRepo.enabled) continue; // already disabled
      disabled++;
      await deps.repos.repositories.setEnabled(dbRepo.id, false);
      await deps.repos.auditLog.record({
        actor: 'worker',
        kind: 'repo.removed',
        subjectType: 'repository',
        subjectId: String(dbRepo.id),
        data: { fullName: `${dbRepo.owner}/${dbRepo.name}`, via: 'reconcile' },
      });
    }

    logger.info(
      { installationId: job.data.installationId, added, reEnabled, disabled, unchanged },
      'reconcile.complete',
    );
  };
}
