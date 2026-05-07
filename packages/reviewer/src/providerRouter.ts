import type { ReviewResult, Reviewer, ReviewerInput } from './port.js';

export type ReviewerProvider = 'claude' | 'codex';

export interface ProviderRouterReviewerOptions {
  readonly defaultProvider: ReviewerProvider;
  readonly claude: Reviewer;
  readonly codex: Reviewer;
}

export class ProviderRouterReviewer implements Reviewer {
  readonly name = 'provider-router';
  readonly version = '1.0.0';

  constructor(private readonly opts: ProviderRouterReviewerOptions) {}

  review(input: ReviewerInput): Promise<ReviewResult> {
    return this.select(input.settings.reviewerProvider).review(input);
  }

  private select(provider: ReviewerProvider | undefined): Reviewer {
    switch (provider ?? this.opts.defaultProvider) {
      case 'claude':
        return this.opts.claude;
      case 'codex':
        return this.opts.codex;
    }
  }
}
