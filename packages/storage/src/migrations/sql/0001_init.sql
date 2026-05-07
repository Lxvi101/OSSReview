-- 0001_init — initial schema.
--
-- Once shipped, this file is immutable. New columns or tables go in a new
-- migration. Existing columns are not renamed; they are deprecated and a new
-- column is added. (See ADR 0002.)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ── Tracked GitHub repositories ─────────────────────────────────────────────
CREATE TABLE repositories (
  id              INTEGER PRIMARY KEY,
  github_repo_id  INTEGER NOT NULL UNIQUE,
  owner           TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  installation_id INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  settings_json   TEXT    NOT NULL DEFAULT '{}',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_repositories_installation ON repositories(installation_id);

-- ── PRs we've observed (snapshot at last-seen-time) ─────────────────────────
CREATE TABLE pull_requests (
  id               INTEGER PRIMARY KEY,
  repository_id    INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  github_pr_number INTEGER NOT NULL,
  head_sha         TEXT    NOT NULL,
  base_sha         TEXT    NOT NULL,
  author_login     TEXT    NOT NULL,
  is_draft         INTEGER NOT NULL,
  title            TEXT    NOT NULL,
  last_seen_at     TEXT    NOT NULL,
  UNIQUE (repository_id, github_pr_number)
);

-- ── ReviewRun aggregate ─────────────────────────────────────────────────────
CREATE TABLE review_runs (
  id               INTEGER PRIMARY KEY,
  pull_request_id  INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  trigger          TEXT    NOT NULL CHECK (trigger IN ('auto','mention','manual')),
  triggered_by     TEXT,
  state            TEXT    NOT NULL CHECK (state IN
                       ('queued','preparing','fetching','reviewing','posting','completed','failed','cancelled')),
  state_reason     TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  head_sha         TEXT    NOT NULL,
  reviewer_name    TEXT    NOT NULL,
  reviewer_version TEXT,
  model            TEXT,
  cost_usd_micros  INTEGER,                       -- micro-USD; integer math, no floats for money
  duration_ms      INTEGER,
  github_review_id INTEGER,
  error_class      TEXT,
  error_message    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_review_runs_pr ON review_runs(pull_request_id, created_at DESC);
CREATE INDEX idx_review_runs_state ON review_runs(state, created_at DESC);

-- ── Posted line comments (one row per finding) ──────────────────────────────
CREATE TABLE review_comments (
  id                INTEGER PRIMARY KEY,
  review_run_id     INTEGER NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  file_path         TEXT NOT NULL,
  line_start        INTEGER,
  line_end          INTEGER,
  severity          TEXT NOT NULL CHECK (severity IN ('blocker','warning','suggestion','nit','praise')),
  body              TEXT NOT NULL,
  suggestion        TEXT,
  github_comment_id INTEGER,
  posted_at         TEXT
);
CREATE INDEX idx_review_comments_run ON review_comments(review_run_id);

-- ── Webhook deliveries — payload is evidence; never mutated ─────────────────
CREATE TABLE webhook_deliveries (
  id                  INTEGER PRIMARY KEY,
  delivery_id         TEXT    NOT NULL UNIQUE,    -- X-GitHub-Delivery
  event               TEXT    NOT NULL,
  action              TEXT,
  signature_valid     INTEGER NOT NULL,
  payload_json        TEXT    NOT NULL,
  received_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at        TEXT,
  processing_outcome  TEXT
);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at DESC);

-- ── Audit log ──────────────────────────────────────────────────────────────
CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  data_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_events_at ON audit_events(at DESC);

-- ── Runtime settings (encrypted secrets stored as {v,nonce,ct} JSON) ────────
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Migrations ledger ──────────────────────────────────────────────────────
CREATE TABLE migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- ── Job queue (owned by @gcr/queue but lives in the same DB) ────────────────
CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  data_json     TEXT    NOT NULL,
  state         TEXT    NOT NULL CHECK (state IN ('queued','running','completed','failed')),
  unique_key    TEXT    UNIQUE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  priority      INTEGER NOT NULL DEFAULT 0,
  run_after     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  locked_by     TEXT,
  locked_at     TEXT,
  enqueued_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  TEXT,
  last_error    TEXT
);
CREATE INDEX idx_jobs_pickup ON jobs(state, run_after, priority DESC, id);
CREATE INDEX idx_jobs_unique ON jobs(unique_key) WHERE unique_key IS NOT NULL;
