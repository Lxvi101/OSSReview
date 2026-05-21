/**
 * The Reviewer port.
 *
 * This is the contract that keeps the code-review engine swappable. Anything
 * that obeys `Reviewer` can be slotted in: Claude Code, Codex, a fully local
 * model, a Semgrep wrapper, a no-op for tests.
 *
 * Crucially, a `Reviewer` is given:
 *   - A workspace directory (read-only)
 *   - A unified diff
 *   - PR metadata
 *
 * It is NOT given:
 *   - A GitHub token
 *   - Git metadata or App credentials after the worker strips `.git`
 *
 * Posting findings back to GitHub is the *core's* responsibility. A
 * compromised prompt cannot leak credentials it never had.
 */

export type Severity = 'blocker' | 'warning' | 'suggestion' | 'nit' | 'praise';

export interface ReviewFinding {
  /** Repo-relative POSIX path. */
  readonly filePath: string;
  /** 1-indexed start line in the head SHA. */
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly severity: Severity;
  /** Markdown body. The formatter wraps it. */
  readonly body: string;
  /**
   * GitHub `suggestion` block contents (no triple-backtick fence). When set,
   * the formatter wraps it in ```suggestion … ``` so it appears as a
   * one-click commit.
   */
  readonly suggestion?: string;
  readonly category?: 'security' | 'performance' | 'style' | 'correctness' | 'docs' | string;
}

export interface ReviewSummary {
  readonly body: string;
  readonly verdict: 'approve' | 'request_changes' | 'comment';
}

export interface ReviewResultMeta {
  readonly reviewerName: string;
  readonly reviewerVersion: string;
  readonly model?: string;
  readonly durationMs: number;
}

export interface ReviewResult {
  readonly summary: ReviewSummary;
  readonly findings: readonly ReviewFinding[];
  readonly meta: ReviewResultMeta;
}

/**
 * Live event the reviewer emits while running, for the transcript view at
 * `/reviews/:id`. The reviewer doesn't know who's listening; the worker
 * passes a recorder that writes to storage, the UI polls.
 */
export type ReviewerEventKind =
  | 'assistant_text'
  | 'assistant_thinking'
  | 'tool_use'
  | 'tool_result'
  | 'sdk_status'
  | 'error';

export interface ReviewerEvent {
  readonly kind: ReviewerEventKind;
  readonly payload: Record<string, unknown>;
}

export type ReviewerEventRecorder = (event: ReviewerEvent) => void;

export interface ReviewerInput {
  /** Absolute path to the prepared workspace. */
  readonly workspaceDir: string;
  /** Unified diff: base...head. */
  readonly diff: string;
  /**
   * Optional recorder for live-view events (Claude turns, tool uses, etc.).
   * Reviewers should call this synchronously on every interesting step;
   * the recorder fans out to storage without blocking the model.
   */
  readonly onEvent?: ReviewerEventRecorder;
  /** PR metadata (used by the prompt; never used to post back). */
  readonly pr: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly description: string;
    readonly authorLogin: string;
    readonly headSha: string;
    readonly baseSha: string;
  };
  /**
   * Per-repo settings that influence the prompt or guard rails (model
   * override, prompt addendum, severity floor, etc.).
   */
  readonly settings: {
    readonly model?: string;
    readonly reviewerProvider?: 'claude' | 'codex' | 'acp';
    readonly promptAddendum?: string;
    readonly maxTurns?: number;
    readonly maxOutputTokens?: number;
    readonly walClockMs?: number;
  };
  readonly signal: AbortSignal;
}

export interface Reviewer {
  /** Stable identifier (persisted in `review_runs.reviewer_name`). */
  readonly name: string;
  /** Versioned identifier (persisted in `review_runs.reviewer_version`). */
  readonly version: string;
  review(input: ReviewerInput): Promise<ReviewResult>;
}
