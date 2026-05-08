/**
 * Pure guards on whether a review should run, and how.
 *
 * No cost / dollar logic — that's been removed. Just the per-PR mention
 * rate cap and diff-mode selection.
 */

export type DiffMode = 'full' | 'summary';

/**
 * Pick the diff mode based on size. Above the threshold the reviewer
 * switches to "summary mode" — a per-file summary instead of full agentic
 * read-the-whole-tree. Cuts cost dramatically on PRs that touch a vendored
 * library, lockfile, or generated file.
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
 * cost the operator unbounded reviewer-CLI usage.
 */
export function checkMentionCap(input: MentionCapInput): MentionCapDecision {
  const cap = input.maxMentionsPerPr ?? 3;
  if (input.existingMentionRunsForHead >= cap) {
    return { allowed: false, reason: `mention_cap_reached:${cap}` };
  }
  return { allowed: true };
}
