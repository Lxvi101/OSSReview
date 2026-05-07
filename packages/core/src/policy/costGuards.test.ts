import { describe, expect, it } from 'vitest';
import { checkCostCap, checkMentionCap, selectDiffMode } from './costGuards.js';

describe('selectDiffMode', () => {
  it('returns full below threshold', () => {
    expect(selectDiffMode(100_000)).toBe('full');
  });
  it('returns summary above threshold', () => {
    expect(selectDiffMode(300_000)).toBe('summary');
  });
  it('honors a custom threshold', () => {
    expect(selectDiffMode(1024, 512)).toBe('summary');
    expect(selectDiffMode(256, 512)).toBe('full');
  });
});

describe('checkMentionCap', () => {
  it('allows below the cap', () => {
    expect(checkMentionCap({ existingMentionRunsForHead: 2 })).toEqual({ allowed: true });
  });
  it('blocks at the cap', () => {
    const d = checkMentionCap({ existingMentionRunsForHead: 3 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('mention_cap_reached:3');
  });
  it('honors a per-repo override', () => {
    expect(checkMentionCap({ existingMentionRunsForHead: 2, maxMentionsPerPr: 1 }).allowed).toBe(false);
    expect(checkMentionCap({ existingMentionRunsForHead: 2, maxMentionsPerPr: 5 }).allowed).toBe(true);
  });
});

describe('checkCostCap', () => {
  it('always allows when cap is null', () => {
    expect(checkCostCap({ spentTodayMicros: 999_999_999, dailyCapMicros: null })).toEqual({
      allowed: true,
      utilization: 0,
    });
  });
  it('blocks at the cap', () => {
    const d = checkCostCap({ spentTodayMicros: 1_000_000, dailyCapMicros: 1_000_000 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('daily_cost_cap_reached');
    expect(d.utilization).toBe(1);
  });
  it('reports utilization for the UI', () => {
    expect(checkCostCap({ spentTodayMicros: 250_000, dailyCapMicros: 1_000_000 }).utilization).toBe(0.25);
  });
});
