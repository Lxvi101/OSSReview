import {
  type Clock,
  type GithubPrNumber,
  type PullRequest,
  type PullRequestId,
  type PullRequestRepo,
  type RepositoryId,
  asGithubPrNumber,
  asPullRequestId,
  asRepositoryId,
  parseIso,
} from '@gcr/core';
import type { Kysely } from 'kysely';
import type { DB } from '../schema.js';

export class PullRequestRepository implements PullRequestRepo {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
  ) {}

  async upsert(input: {
    repositoryId: RepositoryId;
    githubPrNumber: GithubPrNumber;
    headSha: string;
    baseSha: string;
    authorLogin: string;
    isDraft: boolean;
    title: string;
  }): Promise<PullRequest> {
    const now = this.clock.now();
    await this.db
      .insertInto('pull_requests')
      .values({
        repository_id: input.repositoryId as number,
        github_pr_number: input.githubPrNumber as number,
        head_sha: input.headSha,
        base_sha: input.baseSha,
        author_login: input.authorLogin,
        is_draft: input.isDraft ? 1 : 0,
        title: input.title,
        last_seen_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['repository_id', 'github_pr_number']).doUpdateSet({
          head_sha: input.headSha,
          base_sha: input.baseSha,
          author_login: input.authorLogin,
          is_draft: input.isDraft ? 1 : 0,
          title: input.title,
          last_seen_at: now,
        }),
      )
      .execute();

    const row = await this.db
      .selectFrom('pull_requests')
      .selectAll()
      .where('repository_id', '=', input.repositoryId as number)
      .where('github_pr_number', '=', input.githubPrNumber as number)
      .executeTakeFirstOrThrow();
    return this.toDomain(row);
  }

  async byId(id: PullRequestId): Promise<PullRequest | null> {
    const row = await this.db
      .selectFrom('pull_requests')
      .selectAll()
      .where('id', '=', id as number)
      .executeTakeFirst();
    return row ? this.toDomain(row) : null;
  }

  async byNumber(repositoryId: RepositoryId, n: GithubPrNumber): Promise<PullRequest | null> {
    const row = await this.db
      .selectFrom('pull_requests')
      .selectAll()
      .where('repository_id', '=', repositoryId as number)
      .where('github_pr_number', '=', n as number)
      .executeTakeFirst();
    return row ? this.toDomain(row) : null;
  }

  private toDomain(row: {
    id: number;
    repository_id: number;
    github_pr_number: number;
    head_sha: string;
    base_sha: string;
    author_login: string;
    is_draft: number;
    title: string;
    last_seen_at: string;
  }): PullRequest {
    return {
      id: asPullRequestId(row.id),
      repositoryId: asRepositoryId(row.repository_id),
      githubPrNumber: asGithubPrNumber(row.github_pr_number),
      headSha: row.head_sha,
      baseSha: row.base_sha,
      authorLogin: row.author_login,
      isDraft: row.is_draft === 1,
      title: row.title,
      lastSeenAt: parseIso(row.last_seen_at),
    };
  }
}
