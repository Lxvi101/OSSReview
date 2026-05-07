import type { ReviewResult, Reviewer, ReviewerInput } from '../port.js';

/**
 * Deterministic fake reviewer for tests and local dev.
 *
 * Either:
 *   - Configure with a static `result` to return.
 *   - Or pass a `programmableResult(input)` function for input-dependent fakes.
 */
export class FakeReviewer implements Reviewer {
  readonly name = 'fake';
  readonly version = '1.0.0';

  constructor(private readonly cfg: { result?: ReviewResult; programmableResult?: (input: ReviewerInput) => ReviewResult } = {}) {}

  async review(input: ReviewerInput): Promise<ReviewResult> {
    if (input.signal.aborted) throw new Error('aborted');
    if (this.cfg.programmableResult) return this.cfg.programmableResult(input);
    if (this.cfg.result) return this.cfg.result;

    return {
      summary: { body: `Fake review of ${input.pr.owner}/${input.pr.repo}#${input.pr.number}`, verdict: 'comment' },
      findings: [],
      meta: { reviewerName: this.name, reviewerVersion: this.version, durationMs: 1 },
    };
  }
}
