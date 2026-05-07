/**
 * Pure cost / abuse guards.
 *
 * The orchestration layer asks these functions before doing expensive work.
 * Keeping them pure means they're trivial to test and impossible to
 * accidentally couple to a specific storage backend.
 */

export type DiffMode = 'full' | 'summary';

/**
 * Pick the diff mode based on size. Above the threshold the reviewer
 * switches to "summary mode" — a per-file summary instead of full agentic
 * read-the-whole-tree. This cuts cost dramatically on PRs that touch a
 * large file (vendored libraries, lockfiles, generated code).
 */
export function selectDiffMode(diffBytes: number, thresholdBytes = 256 * 1024): DiffMode {
  return diffBytes > thresholdBytes ? 'summary' : 'full';
}

export interface MentionCapInput {
  /** How many mention-triggered reviews already exist for this PR's head SHA. */
  readonly existingMentionRunsForHead: number;
  /** Per-repo override; default 3. */
  readonly maxMentionsPerPr?: number;
}

export interface MentionCapDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Per-PR rate-cap on mention-triggered re-runs. A repeat-clicker shouldn't
 * cost the operator unbounded API budget.
 */
export function checkMentionCap(input: MentionCapInput): MentionCapDecision {
  const cap = input.maxMentionsPerPr ?? 3;
  if (input.existingMentionRunsForHead >= cap) {
    return { allowed: false, reason: `mention_cap_reached:${cap}` };
  }
  return { allowed: true };
}

export interface CostCapInput {
  /** Total spend today (UTC), in micro-USD. */
  readonly spentTodayMicros: number;
  /** Daily cap, in micro-USD. `null` means no cap. */
  readonly dailyCapMicros: number | null;
}

export interface CostCapDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  /** Fraction of the cap used [0, 1+]. UI can color a banner from this. */
  readonly utilization: number;
}

/**
 * Have we hit the daily $-cap? If so, refuse new runs (they'd just fail
 * downstream anyway and burn webhook attempts).
 *
 * Mention-triggered runs are NOT exempt — a malicious PR could spam mentions
 * to drain budget.
 */
export function checkCostCap(input: CostCapInput): CostCapDecision {
  if (input.dailyCapMicros === null) {
    return { allowed: true, utilization: 0 };
  }
  const utilization = input.spentTodayMicros / input.dailyCapMicros;
  if (input.spentTodayMicros >= input.dailyCapMicros) {
    return { allowed: false, reason: 'daily_cost_cap_reached', utilization };
  }
  return { allowed: true, utilization };
}
