-- 0003 — drop cost tracking; add cancellation request flag.
--
-- Cost was never wired into a UI and the daily-cap path is unused, so the
-- column goes. A `cancel_requested_at` flag lets the API tell the worker to
-- stop a run early; the worker checks it on every state transition and
-- aborts the SDK signal.

ALTER TABLE review_runs DROP COLUMN cost_usd_micros;

ALTER TABLE review_runs ADD COLUMN cancel_requested_at TEXT;
