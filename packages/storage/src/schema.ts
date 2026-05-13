import type { Generated } from 'kysely';

/**
 * Kysely DB types. Mirrors the SQL schema in migrations/sql/.
 *
 * SQLite column-type rules:
 *   - TEXT   → string
 *   - INTEGER (booleans) → 0|1 in SQL, mapped to/from boolean by repositories
 *   - INTEGER PK → number, generated
 *   - TEXT JSON columns → string in DB, parsed to objects in repositories
 *
 * This file MUST stay in sync with the migrations.
 */

export interface DB {
  repositories: RepositoriesTable;
  pull_requests: PullRequestsTable;
  review_runs: ReviewRunsTable;
  review_comments: ReviewCommentsTable;
  review_events: ReviewEventsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  audit_events: AuditEventsTable;
  settings: SettingsTable;
  migrations: MigrationsTable;
  jobs: JobsTable;
  // Better Auth tables. Better Auth owns reads/writes to these via its own
  // Kysely instance; we declare them here so cross-table queries (e.g.
  // "count users") share the typed connection.
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
}

export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number; // 0 | 1
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTable {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountTable {
  id: string;
  userId: string;
  accountId: string;
  providerId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  password: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewEventsTable {
  id: Generated<number>;
  review_run_id: number;
  seq: number;
  at: Generated<string>;
  kind:
    | 'phase'
    | 'assistant_text'
    | 'assistant_thinking'
    | 'tool_use'
    | 'tool_result'
    | 'sdk_status'
    | 'error';
  payload_json: string;
}

export interface RepositoriesTable {
  id: Generated<number>;
  github_repo_id: number;
  owner: string;
  name: string;
  installation_id: number;
  enabled: number; // 0 | 1
  settings_json: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface PullRequestsTable {
  id: Generated<number>;
  repository_id: number;
  github_pr_number: number;
  head_sha: string;
  base_sha: string;
  author_login: string;
  is_draft: number;
  title: string;
  last_seen_at: string;
}

export interface ReviewRunsTable {
  id: Generated<number>;
  pull_request_id: number;
  idempotency_key: string;
  trigger: 'auto' | 'mention' | 'manual';
  triggered_by: string | null;
  state:
    | 'queued'
    | 'preparing'
    | 'fetching'
    | 'reviewing'
    | 'posting'
    | 'completed'
    | 'failed'
    | 'cancelled';
  state_reason: string | null;
  attempts: number;
  head_sha: string;
  reviewer_name: string;
  reviewer_version: string | null;
  model: string | null;
  duration_ms: number | null;
  github_review_id: number | null;
  error_class: string | null;
  error_message: string | null;
  cancel_requested_at: string | null;
  created_at: Generated<string>;
  updated_at: string;
}

export interface ReviewCommentsTable {
  id: Generated<number>;
  review_run_id: number;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  severity: 'blocker' | 'warning' | 'suggestion' | 'nit' | 'praise';
  body: string;
  suggestion: string | null;
  github_comment_id: number | null;
  posted_at: string | null;
}

export interface WebhookDeliveriesTable {
  id: Generated<number>;
  delivery_id: string;
  event: string;
  action: string | null;
  signature_valid: number;
  payload_json: string;
  received_at: Generated<string>;
  processed_at: string | null;
  processing_outcome: string | null;
}

export interface AuditEventsTable {
  id: Generated<number>;
  at: Generated<string>;
  actor: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  data_json: string;
}

export interface SettingsTable {
  key: string;
  value_json: string;
  updated_at: Generated<string>;
}

export interface MigrationsTable {
  version: number;
  name: string;
  applied_at: string;
}

export interface JobsTable {
  id: Generated<number>;
  name: string;
  data_json: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  unique_key: string | null;
  attempts: number;
  max_attempts: number;
  priority: number;
  run_after: Generated<string>;
  locked_by: string | null;
  locked_at: string | null;
  enqueued_at: Generated<string>;
  completed_at: string | null;
  last_error: string | null;
}
