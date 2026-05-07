import { describe, expect, it } from 'vitest';
import { IllegalStateTransitionError } from '../errors.js';
import {
  REVIEW_RUN_STATES,
  type ReviewRunState,
  assertTransition,
  canTransition,
  isTerminal,
  resumeAction,
} from './state.js';

describe('ReviewRun state machine', () => {
  it('allows the happy path', () => {
    const path: ReviewRunState[] = [
      'queued',
      'preparing',
      'fetching',
      'reviewing',
      'posting',
      'completed',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      if (from === undefined || to === undefined) throw new Error('unreachable');
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('forbids skipping states', () => {
    expect(canTransition('queued', 'reviewing')).toBe(false);
    expect(canTransition('preparing', 'completed')).toBe(false);
  });

  it('forbids leaving a terminal state', () => {
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
  });

  it('allows fail/cancel from any non-terminal state', () => {
    const nonTerminal: ReviewRunState[] = ['queued', 'preparing', 'fetching', 'reviewing', 'posting'];
    for (const s of nonTerminal) {
      expect(canTransition(s, 'failed')).toBe(true);
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });

  it('throws IllegalStateTransitionError on an illegal move', () => {
    expect(() => assertTransition('queued', 'completed')).toThrow(IllegalStateTransitionError);
  });

  it('isTerminal is correct for all states', () => {
    for (const s of REVIEW_RUN_STATES) {
      expect(isTerminal(s)).toBe(s === 'completed' || s === 'failed' || s === 'cancelled');
    }
  });

  describe('resumeAction', () => {
    it('restarts from preparing for early states', () => {
      for (const s of ['queued', 'preparing', 'fetching'] as const) {
        expect(resumeAction(s)).toEqual({ kind: 'restart', from: 'preparing' });
      }
    });

    it('restarts from fetching when reviewing was interrupted', () => {
      expect(resumeAction('reviewing')).toEqual({ kind: 'restart', from: 'fetching' });
    });

    it('verifies then resumes when posting was interrupted', () => {
      expect(resumeAction('posting')).toEqual({ kind: 'verify_then_resume' });
    });

    it('is a noop for terminal states', () => {
      expect(resumeAction('completed')).toEqual({ kind: 'noop' });
      expect(resumeAction('failed')).toEqual({ kind: 'noop' });
      expect(resumeAction('cancelled')).toEqual({ kind: 'noop' });
    });
  });
});
