import type { ReviewEvent } from '@/lib/api';
import { useEffect, useRef, useState } from 'react';

export type StreamState = 'connecting' | 'open' | 'terminal' | 'error' | 'closed';

interface Result {
  readonly events: ReadonlyArray<ReviewEvent>;
  readonly state: StreamState;
  readonly terminalState: string | null;
  readonly errorMessage: string | null;
}

/**
 * Live transcript stream for a review run.
 *
 *   - Connects to `/api/reviews/:id/events/stream` (SSE).
 *   - Appends each event to local state in arrival order.
 *   - Stops automatically when the server sends `event: terminal`.
 *
 * `initialSince` is captured into a ref on mount and changes do NOT cause
 * a reconnect — that would tear down and rebuild the EventSource on every
 * react-query refetch, which dumps the connection pool. The browser's
 * built-in EventSource auto-reconnect + Last-Event-ID header keep things
 * resumable across transient network blips.
 */
export function useReviewStream(
  reviewId: number | null,
  options: { enabled?: boolean; initialSince?: number } = {},
): Result {
  const { enabled = true, initialSince = 0 } = options;
  const [events, setEvents] = useState<ReadonlyArray<ReviewEvent>>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const [terminalState, setTerminalState] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const cursorRef = useRef<number>(initialSince);
  const initialSinceRef = useRef<number>(initialSince);

  // Keep initialSinceRef in sync with the latest prop without re-triggering
  // the connect effect — the cursor is only consulted when (re)opening.
  useEffect(() => {
    initialSinceRef.current = initialSince;
  }, [initialSince]);

  useEffect(() => {
    if (!enabled || reviewId == null) {
      setState('closed');
      return;
    }
    cursorRef.current = initialSinceRef.current;
    setEvents([]);
    setTerminalState(null);
    setErrorMessage(null);
    setState('connecting');

    const sinceParam = initialSinceRef.current;
    const url = `/api/reviews/${reviewId}/events/stream${
      sinceParam > 0 ? `?since=${sinceParam}` : ''
    }`;
    const es = new EventSource(url);

    es.onopen = () => setState('open');

    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as ReviewEvent;
        if (payload.seq <= cursorRef.current) return;
        cursorRef.current = payload.seq;
        setEvents((prev) => [...prev, payload]);
      } catch (err) {
        console.warn('SSE parse error', err);
      }
    };

    es.addEventListener('terminal', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { state: string };
        setTerminalState(data.state);
      } catch {
        // ignore
      }
      setState('terminal');
      es.close();
    });

    es.addEventListener('error', (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data) as { error?: string };
          if (parsed.error) setErrorMessage(parsed.error);
        } catch {
          // not JSON
        }
      }
      if (es.readyState === EventSource.CLOSED) {
        setState('error');
      }
    });

    return () => {
      es.close();
      setState('closed');
    };
  }, [reviewId, enabled]);

  return { events, state, terminalState, errorMessage };
}
