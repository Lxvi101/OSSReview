-- 0002_review_events — append-only transcript per review run.
--
-- Each event is one observable step the worker took: a state transition,
-- a Claude assistant turn (text or thinking), a tool call (Read/Glob/Grep),
-- a tool result preview, or a terminal status. The UI uses these to render
-- a live timeline while the review is running, and to retrospect on
-- completed/failed runs.
--
-- Append-only: once written, never updated. `seq` is monotonic per
-- review_run_id (UNIQUE constraint). The UI polls with `where seq > ?`
-- to paginate forward.

CREATE TABLE review_events (
  id              INTEGER PRIMARY KEY,
  review_run_id   INTEGER NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind            TEXT    NOT NULL CHECK (kind IN (
    'phase',           -- state-machine transition: payload {state, reason?}
    'assistant_text',  -- Claude said something visible: payload {text}
    'assistant_thinking',  -- extended-thinking content: payload {thinking}
    'tool_use',        -- Claude called a tool: payload {name, input}
    'tool_result',     -- tool returned (preview): payload {tool_use_id, name, preview}
    'sdk_status',      -- SDK lifecycle: payload {message}
    'error'            -- something went wrong: payload {class, message}
  )),
  payload_json    TEXT    NOT NULL,
  UNIQUE (review_run_id, seq)
);

CREATE INDEX idx_review_events_run ON review_events(review_run_id, seq);
