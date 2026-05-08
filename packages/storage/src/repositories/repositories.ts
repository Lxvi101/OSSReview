import {
  type Clock,
  type GithubInstallationId,
  type GithubRepoId,
  type Repository,
  type RepositoryId,
  type RepositoryRepo,
  type RepositorySettings,
  asGithubInstallationId,
  asGithubRepoId,
  asRepositoryId,
} from '@gcr/core';
import { parseIso } from '@gcr/core';
import type { Kysely, Selectable } from 'kysely';
import type { DB, RepositoriesTable } from '../schema.js';

type RepositoryRow = Selectable<RepositoriesTable>;

export class RepositoryRepository implements RepositoryRepo {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
  ) {}

  async upsertFromInstallation(input: {
    githubRepoId: GithubRepoId;
    owner: string;
    name: string;
    installationId: GithubInstallationId;
  }): Promise<Repository> {
    const now = this.clock.now();
    // Upsert by github_repo_id. Settings are not touched on existing rows.
    await this.db
      .insertInto('repositories')
      .values({
        github_repo_id: input.githubRepoId,
        owner: input.owner,
        name: input.name,
        installation_id: input.installationId,
        enabled: 1,
        settings_json: '{}',
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('github_repo_id').doUpdateSet({
          owner: input.owner,
          name: input.name,
          installation_id: input.installationId,
          updated_at: now,
        }),
      )
      .execute();

    const row = await this.db
      .selectFrom('repositories')
      .selectAll()
      .where('github_repo_id', '=', input.githubRepoId as number)
      .executeTakeFirstOrThrow();
    return this.toDomain(row);
  }

  async byId(id: RepositoryId): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .selectAll()
      .where('id', '=', id as number)
      .executeTakeFirst();
    return row ? this.toDomain(row) : null;
  }

  async byGithubId(id: GithubRepoId): Promise<Repository | null> {
    const row = await this.db
      .selectFrom('repositories')
      .selectAll()
      .where('github_repo_id', '=', id as number)
      .executeTakeFirst();
    return row ? this.toDomain(row) : null;
  }

  async list(
    opts: { enabled?: boolean; installationId?: GithubInstallationId } = {},
  ): Promise<Repository[]> {
    let q = this.db.selectFrom('repositories').selectAll().orderBy('owner').orderBy('name');
    if (opts.enabled !== undefined) {
      q = q.where('enabled', '=', opts.enabled ? 1 : 0);
    }
    if (opts.installationId !== undefined) {
      q = q.where('installation_id', '=', opts.installationId as number);
    }
    const rows = await q.execute();
    return rows.map((r) => this.toDomain(r));
  }

  async setEnabled(id: RepositoryId, enabled: boolean): Promise<void> {
    await this.db
      .updateTable('repositories')
      .set({ enabled: enabled ? 1 : 0, updated_at: this.clock.now() })
      .where('id', '=', id as number)
      .execute();
  }

  async setEnabledForInstallation(
    installationId: GithubInstallationId,
    enabled: boolean,
  ): Promise<number> {
    const result = await this.db
      .updateTable('repositories')
      .set({ enabled: enabled ? 1 : 0, updated_at: this.clock.now() })
      .where('installation_id', '=', installationId as number)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  async updateSettings(id: RepositoryId, patch: Partial<RepositorySettings>): Promise<void> {
    const current = await this.byId(id);
    if (!current) throw new Error(`repository ${id} not found`);
    const merged = { ...current.settings, ...patch };
    await this.db
      .updateTable('repositories')
      .set({ settings_json: JSON.stringify(merged), updated_at: this.clock.now() })
      .where('id', '=', id as number)
      .execute();
  }

  async replaceSettings(id: RepositoryId, next: RepositorySettings): Promise<void> {
    await this.db
      .updateTable('repositories')
      .set({ settings_json: JSON.stringify(next), updated_at: this.clock.now() })
      .where('id', '=', id as number)
      .execute();
  }

  private toDomain(row: RepositoryRow): Repository {
    return {
      id: asRepositoryId(row.id),
      githubRepoId: asGithubRepoId(row.github_repo_id),
      owner: row.owner,
      name: row.name,
      installationId: asGithubInstallationId(row.installation_id),
      enabled: row.enabled === 1,
      settings: JSON.parse(row.settings_json) as RepositorySettings,
      createdAt: parseIso(row.created_at),
      updatedAt: parseIso(row.updated_at),
    };
  }
}
