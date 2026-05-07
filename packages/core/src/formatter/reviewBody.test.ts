import { describe, expect, it } from 'vitest';
import { type FormatFinding, format } from './reviewBody.js';

const summary = { body: 'Looks reasonable overall.', verdict: 'comment' as const };

const finding = (over: Partial<FormatFinding> = {}): FormatFinding => ({
  filePath: 'src/foo.ts',
  lineStart: 10,
  lineEnd: 10,
  severity: 'warning',
  body: 'Consider null-checking this.',
  ...over,
});

describe('format', () => {
  it('drops findings below the severity floor and reports the count', () => {
    const result = format(
      summary,
      [
        finding({ severity: 'blocker' }),
        finding({ severity: 'warning' }),
        finding({ severity: 'nit' }),
        finding({ severity: 'praise' }),
      ],
      { severityFloor: 'warning' },
    );
    expect(result.inlineComments).toHaveLength(2);
    expect(result.droppedCount).toBe(2);
  });

  it('translates verdict to GitHub event', () => {
    expect(format({ ...summary, verdict: 'approve' }, [], {}).verdict).toBe('APPROVE');
    expect(format({ ...summary, verdict: 'request_changes' }, [], {}).verdict).toBe('REQUEST_CHANGES');
    expect(format({ ...summary, verdict: 'comment' }, [], {}).verdict).toBe('COMMENT');
  });

  it('uses lineEnd when present, falls back to lineStart', () => {
    const result = format(
      summary,
      [
        finding({ lineStart: 1, lineEnd: 5 }),
        // explicitly drop lineEnd via spread so the fallback path is exercised
        { ...finding(), lineStart: 7, lineEnd: undefined },
      ],
      {},
    );
    expect(result.inlineComments[0]?.line).toBe(5);
    expect(result.inlineComments[1]?.line).toBe(7);
  });

  it('embeds GitHub suggestion block when suggestion is present', () => {
    const result = format(
      summary,
      [finding({ suggestion: 'const x = 1;' })],
      {},
    );
    expect(result.inlineComments[0]?.body).toContain('```suggestion');
    expect(result.inlineComments[0]?.body).toContain('const x = 1;');
  });

  it('orders summary breakdown by severity descending', () => {
    const result = format(
      summary,
      [
        finding({ severity: 'nit' }),
        finding({ severity: 'blocker' }),
        finding({ severity: 'warning' }),
      ],
      { severityFloor: 'praise' },
    );
    const blockerIdx = result.summaryBody.indexOf('blocker');
    const warningIdx = result.summaryBody.indexOf('warning');
    const nitIdx = result.summaryBody.indexOf('nit');
    expect(blockerIdx).toBeGreaterThanOrEqual(0);
    expect(blockerIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(nitIdx);
  });

  it('emits a no-findings summary when nothing made it past the floor', () => {
    const result = format(summary, [finding({ severity: 'praise' })], { severityFloor: 'warning' });
    expect(result.summaryBody).toContain('_No findings._');
    expect(result.inlineComments).toHaveLength(0);
  });
});
