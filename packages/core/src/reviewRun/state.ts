/**
 * `ReviewRun` state machine.
 *
 * The heart of durability. Every transition is checked at runtime; illegal
 * transitions throw `IllegalStateTransitionError`. The transition table is
 * the single source of truth — all higher-level orchestration must go
 * through `transition()`.
 *
 * Why a table rather than a chain of `if`s: it makes the legal universe of
 * states something a 2030 reader can hold in their head in one minute.
 */

import { IllegalStateTransitionError } from '../errors.js';

export const REVIEW_RUN_STATES = [
  'queued',
  'preparing',
  'fetching',
  'reviewing',
  'posting',
  'completed',
  'failed',
  'cancelled',
] as const;

export type ReviewRunState = (typeof REVIEW_RUN_STATES)[number];

/**
 * Allowed transitions. Read top-to-bottom: from each `from` state you may
 * move only to one of the listed `to` states.
 *
 * `failed` and `cancelled` are reachable from any non-terminal state.
 */
const ALLOWED: Readonly<Record<ReviewRunState, readonly ReviewRunState[]>> = {
  queued: ['preparing', 'failed', 'cancelled'],
  preparing: ['fetching', 'failed', 'cancelled'],
  fetching: ['reviewing', 'failed', 'cancelled'],
  reviewing: ['posting', 'failed', 'cancelled'],
  posting: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ReviewRunState, to: ReviewRunState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: ReviewRunState, to: ReviewRunState): void {
  if (!canTransition(from, to)) {
    throw new IllegalStateTransitionError(from, to);
  }
}

export function isTerminal(s: ReviewRunState): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled';
}

/**
 * Resume rules — used by the worker on startup to decide what to do with a
 * run found in a non-terminal state. See §4c of the design doc.
 */
export type ResumeAction =
  | { kind: 'restart'; from: ReviewRunState }
  | { kind: 'verify_then_resume' } // for `posting` — query GitHub first
  | { kind: 'noop' };

export function resumeAction(state: ReviewRunState): ResumeAction {
  switch (state) {
    case 'queued':
    case 'preparing':
    case 'fetching':
      return { kind: 'restart', from: 'preparing' };
    case 'reviewing':
      // LLM call is non-idempotent and partial progress isn't recoverable.
      return { kind: 'restart', from: 'fetching' };
    case 'posting':
      return { kind: 'verify_then_resume' };
    case 'completed':
    case 'failed':
    case 'cancelled':
      return { kind: 'noop' };
  }
}
