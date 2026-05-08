/**
 * Formatter: turn a `ReviewResult` into the markdown bodies that get posted to
 * GitHub.
 *
 * Pure: takes data, returns data. Any HTML escaping or markdown sanitization
 * happens here so adapters don't reinvent it.
 *
 * The shape of `ReviewFinding` is intentionally duplicated here from
 * @gcr/reviewer to keep `core` from importing the reviewer package — the
 * boundary plugin enforces this. The two definitions must be kept in
 * structural sync; a `tests/integration/finding-shape-parity.test.ts` test
 * asserts that.
 */

import type { RepositorySettings } from '../repository/aggregate.js';

export type Severity = 'blocker' | 'warning' | 'suggestion' | 'nit' | 'praise';

export interface FormatFinding {
  readonly filePath: string;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
  readonly severity: Severity;
  readonly body: string;
  readonly suggestion?: string | undefined;
  readonly category?: string | undefined;
}

export interface FormatSummary {
  readonly body: string;
  readonly verdict: 'approve' | 'request_changes' | 'comment';
}

export interface FormattedReview {
  readonly summaryBody: string;
  readonly verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  readonly inlineComments: ReadonlyArray<{
    readonly path: string;
    readonly line: number;
    readonly body: string;
  }>;
  /** Findings dropped because they were below the configured severity floor. */
  readonly droppedCount: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 4,
  warning: 3,
  suggestion: 2,
  nit: 1,
  praise: 0,
};

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: '**Blocker**',
  warning: '**Warning**',
  suggestion: '_Suggestion_',
  nit: '_Nit_',
  praise: '_Praise_',
};

const VERDICT_TO_GH: Record<FormatSummary['verdict'], FormattedReview['verdict']> = {
  approve: 'APPROVE',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

export function format(
  summary: FormatSummary,
  findings: readonly FormatFinding[],
  settings: Pick<RepositorySettings, 'severityFloor'>,
): FormattedReview {
  const floor = settings.severityFloor ?? 'suggestion';
  const floorRank = SEVERITY_RANK[floor];
  const kept: FormatFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] >= floorRank) kept.push(f);
    else dropped++;
  }

  const inline = kept
    .filter((f) => f.lineStart != null)
    .map((f) => ({
      path: f.filePath,
      line: f.lineEnd ?? f.lineStart!,
      body: formatInlineBody(f),
    }));

  return {
    summaryBody: formatSummaryBody(summary, kept, dropped),
    verdict: VERDICT_TO_GH[summary.verdict],
    inlineComments: inline,
    droppedCount: dropped,
  };
}

function formatInlineBody(f: FormatFinding): string {
  const tag = SEVERITY_LABEL[f.severity];
  const cat = f.category ? ` _(${f.category})_` : '';
  const head = `${tag}${cat}\n\n${f.body.trim()}`;
  if (!f.suggestion) return head;
  // GitHub renders ```suggestion blocks as one-click commit-able patches.
  return `${head}\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, '')}\n\`\`\``;
}

function formatSummaryBody(
  summary: FormatSummary,
  findings: readonly FormatFinding[],
  dropped: number,
): string {
  const counts = countBySeverity(findings);
  const breakdown =
    counts.length === 0
      ? '_No findings._'
      : counts.map(([sev, n]) => `- **${sev}**: ${n}`).join('\n');
  const droppedLine =
    dropped > 0 ? `\n\n_${dropped} finding(s) below the severity floor were not posted._` : '';
  return [
    '### GitHub Code Reviewer',
    '',
    summary.body.trim(),
    '',
    '#### Findings',
    breakdown,
    droppedLine,
    '',
    '<sub>This review was generated automatically. Mention me on the PR to request a re-run.</sub>',
  ]
    .filter(Boolean)
    .join('\n');
}

function countBySeverity(findings: readonly FormatFinding[]): Array<[Severity, number]> {
  const counts = new Map<Severity, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  // Stable order: highest severity first.
  return [...counts.entries()].sort(([a], [b]) => SEVERITY_RANK[b] - SEVERITY_RANK[a]);
}
