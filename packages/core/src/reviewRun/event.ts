import type { ReviewRunId } from '../ids.js';
import type { IsoTimestamp } from '../time.js';

/**
 * A single observable step inside a `ReviewRun` — what the worker did, what
 * Claude said, what tools it called. Append-only timeline used by the live
 * view at `/reviews/:id` and by retrospective inspection of past runs.
 *
 * Why a separate stream from the run aggregate:
 *   - Linear writes scale better than re-serializing a growing array.
 *   - The state machine and the model transcript have different lifecycles
 *     (a `failed` run can still produce events; a successful run produces
 *      tens to hundreds).
 *   - Polling forward with `seq > N` is the natural "give me what's new"
 *     query for an HTMX-ish UI.
 */
export type ReviewEventKind =
  | 'phase'
  | 'assistant_text'
  | 'assistant_thinking'
  | 'tool_use'
  | 'tool_result'
  | 'sdk_status'
  | 'error';

export interface ReviewEvent {
  readonly id: number;
  readonly reviewRunId: ReviewRunId;
  readonly seq: number;
  readonly at: IsoTimestamp;
  readonly kind: ReviewEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** What an emitter passes when recording a new event. */
export interface NewReviewEvent {
  readonly kind: ReviewEventKind;
  readonly payload: Record<string, unknown>;
}

/**
 * The function shape a Reviewer can invoke during a review to record a
 * step. Synchronous return; the recorder fans out to storage and any
 * connected UI subscribers without blocking the model.
 */
export type ReviewEventRecorder = (event: NewReviewEvent) => void;
