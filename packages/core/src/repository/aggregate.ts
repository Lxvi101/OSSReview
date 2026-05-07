import type { GithubInstallationId, GithubRepoId, RepositoryId } from '../ids.js';
import type { IsoTimestamp } from '../time.js';

/**
 * `Repository` aggregate — a tracked GitHub repo we may review.
 *
 * `settings` is plain JSON-shaped. Adapters serialize/deserialize, the domain
 * doesn't know about JSON.
 */
export interface Repository {
  readonly id: RepositoryId;
  readonly githubRepoId: GithubRepoId;
  readonly owner: string;
  readonly name: string;
  readonly installationId: GithubInstallationId;
  readonly enabled: boolean;
  readonly settings: RepositorySettings;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Per-repo overrides. The defaults live in @gcr/config. */
export interface RepositorySettings {
  /** Glob patterns of paths to ignore (e.g. ['vendor/**', '*.lock']). */
  readonly ignorePaths?: readonly string[];
  /** Lowest severity that should be posted as a comment. */
  readonly severityFloor?: 'blocker' | 'warning' | 'suggestion' | 'nit' | 'praise';
  /** Optional per-repo prompt addendum (appended to the system prompt). */
  readonly promptAddendum?: string;
  /** Override the default model for this repo. */
  readonly model?: string;
  /** Override the default local reviewer provider for this repo. */
  readonly reviewerProvider?: 'claude' | 'codex';
  /** Skip drafts. Default: true. */
  readonly skipDrafts?: boolean;
  /** Maximum mention-triggered re-runs per PR. Default: 3. */
  readonly maxMentionsPerPr?: number;
}

export function fullName(r: Pick<Repository, 'owner' | 'name'>): string {
  return `${r.owner}/${r.name}`;
}
