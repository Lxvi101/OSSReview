import { FatalError } from '@gcr/core';
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
    const chosen = provider ?? this.opts.defaultProvider;
    switch (chosen) {
      case 'claude':
        return this.opts.claude;
      case 'codex':
        return this.opts.codex;
      default: {
        const _exhaustive: never = chosen;
        throw new FatalError(
          'reviewer.unknown_provider',
          `unknown reviewer provider: ${String(_exhaustive)}`,
        );
      }
    }
  }
}
