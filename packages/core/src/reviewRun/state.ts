/**
 * `ReviewRun` state machine.
 *
 * One source of truth for legal transitions. Every state change goes through
 * `transition()`, which uses this table.
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
 * Allowed transitions. From each `from` state you may move only to one of
 * the listed `to` states. `failed` and `cancelled` are reachable from any
 * non-terminal state.
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
