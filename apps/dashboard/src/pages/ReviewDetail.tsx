import { ReviewStateChip, SeverityChip } from '@/components/StateChip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useReviewStream } from '@/hooks/useReviewStream';
import { type ReviewDetail, type ReviewEvent, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ChevronDown, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

export function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const reviewId = id ? Number.parseInt(id, 10) : null;
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['review', reviewId],
    queryFn: () => api.get<ReviewDetail>(`/api/reviews/${reviewId}`),
    enabled: reviewId != null,
    refetchInterval: (q) => (q.state.data?.review.terminal ? false : 3_000),
  });

  const cancel = useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/api/reviews/${reviewId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review', reviewId] }),
  });

  if (reviewId === null) {
    return <p className="text-sm text-destructive">Invalid review id.</p>;
  }
  if (detail.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <p className="text-sm text-destructive">
        Failed to load: {(detail.error as Error | null)?.message ?? 'unknown error'}
      </p>
    );
  }

  const { review, findings } = detail.data;
  const cancelInflight = !review.terminal && !!review.cancelRequestedAt;
  const canCancel = !review.terminal && !cancelInflight;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Review #{review.id}</h1>
            <ReviewStateChip state={review.state} />
            {cancelInflight ? <Badge variant="warning">cancelling</Badge> : null}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              <strong className="text-foreground">{review.repo}</strong>
              {review.prNumber != null ? ` #${review.prNumber}` : ''}
            </span>
            <span>·</span>
            <span className="font-mono text-xs">trigger: {review.trigger}</span>
            <span>·</span>
            <span>attempts: {review.attempts}</span>
            {review.durationMs != null ? (
              <>
                <span>·</span>
                <span>{review.durationMs}ms</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCancel ? (
            <Button
              variant="destructive"
              size="sm"
              type="button"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              <XCircle className="h-4 w-4" />
              Cancel run
            </Button>
          ) : null}
          <Link to="/reviews">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
        </div>
      </div>

      {review.errorMessage ? (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
            <div className="min-w-0 flex-1">
              <strong>Run {review.state}.</strong>
              {review.errorClass ? (
                <Badge variant="destructive" className="ml-2 font-mono text-[10px]">
                  {review.errorClass}
                </Badge>
              ) : null}
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-foreground">
                {review.errorMessage}
              </pre>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <LiveTranscript reviewId={review.id} terminal={review.terminal} />

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between border-b border-border p-6">
          <CardTitle>Posted findings</CardTitle>
          <Badge variant="muted">{findings.length}</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {findings.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No findings posted for this run.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {findings.map((f, i) => (
                <li key={`${f.filePath}-${f.lineStart ?? 0}-${i}`} className="px-6 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <SeverityChip severity={f.severity} />
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {f.filePath}
                      {f.lineStart != null ? `:${f.lineStart}` : ''}
                    </code>
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-foreground">
                    {f.body}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LiveTranscript({
  reviewId,
  terminal,
}: {
  readonly reviewId: number;
  readonly terminal: boolean;
}) {
  const initialEvents = useQuery({
    queryKey: ['review-events-initial', reviewId],
    queryFn: () =>
      api.get<{ events: ReadonlyArray<ReviewEvent> }>(`/api/reviews/${reviewId}/events?limit=500`),
  });

  // Capture initialSince once: the lastSeq when the backfill resolves. The
  // SSE hook stores this in a ref and never reconnects on re-render.
  const initialSince = initialEvents.data?.events.length
    ? initialEvents.data.events[initialEvents.data.events.length - 1]?.seq
    : 0;

  const stream = useReviewStream(reviewId, {
    enabled: !terminal,
    initialSince,
  });

  const events = useMemo(() => {
    const map = new Map<number, ReviewEvent>();
    for (const e of initialEvents.data?.events ?? []) map.set(e.seq, e);
    for (const e of stream.events) map.set(e.seq, e);
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }, [initialEvents.data?.events, stream.events]);

  const isLive = !terminal && stream.state === 'open';
  const isConnecting = !terminal && stream.state === 'connecting';

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between border-b border-border p-6">
        <div>
          <CardTitle>Live transcript</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every step the worker took: state transitions, what the model said, what tools it
            called, what came back.
          </p>
        </div>
        {isLive ? (
          <Badge variant="info" className="gap-1.5">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-info" />
            Live
          </Badge>
        ) : isConnecting ? (
          <Badge variant="muted">Connecting…</Badge>
        ) : terminal ? (
          <Badge variant="muted">Frozen</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {initialEvents.isLoading ? (
          <div className="space-y-2 p-6">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ) : events.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            No transcript events recorded yet.
          </div>
        ) : (
          <TranscriptList events={events} />
        )}
      </CardContent>
    </Card>
  );
}

function TranscriptList({ events }: { readonly events: ReadonlyArray<ReviewEvent> }) {
  const containerRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <ol ref={containerRef} className="max-h-[600px] divide-y divide-border overflow-y-auto">
      {events.map((e) => (
        <TranscriptRow key={e.id} event={e} />
      ))}
    </ol>
  );
}

const KIND_BADGE: Record<string, React.ComponentProps<typeof Badge>['variant']> = {
  phase: 'info',
  assistant_text: 'warning',
  assistant_thinking: 'warning',
  tool_use: 'success',
  tool_result: 'muted',
  sdk_status: 'muted',
  error: 'destructive',
};

function TranscriptRow({ event }: { readonly event: ReviewEvent }) {
  const variant = KIND_BADGE[event.kind] ?? 'muted';
  const time = event.at.length >= 19 ? event.at.slice(11, 19) : event.at;
  return (
    <li className="grid grid-cols-[40px,56px,140px,1fr] items-start gap-3 px-3 py-2 text-sm hover:bg-muted/50">
      <span className="font-mono text-[11px] text-muted-foreground">#{event.seq}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{time}</span>
      <Badge variant={variant} className="h-fit justify-center font-mono text-[10px]">
        {event.kind}
      </Badge>
      <div className="min-w-0">
        <PayloadView event={event} />
      </div>
    </li>
  );
}

function PayloadView({ event }: { readonly event: ReviewEvent }) {
  const p = event.payload;
  switch (event.kind) {
    case 'phase':
      return (
        <span>
          → <strong>{String(p.state ?? '?')}</strong>
          {p.message ? <span className="text-muted-foreground"> — {String(p.message)}</span> : null}
          {p.findings != null ? (
            <span className="text-muted-foreground">
              {' '}
              — {String(p.findings)} finding(s), verdict={String(p.verdict)}
            </span>
          ) : null}
          {p.durationMs != null ? (
            <span className="text-muted-foreground"> — {String(p.durationMs)}ms</span>
          ) : null}
        </span>
      );
    case 'assistant_text':
      return (
        <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">
          {String(p.text ?? '')}
        </pre>
      );
    case 'assistant_thinking':
      return (
        <Collapsible
          label={`thinking (${String((p.thinking as string | undefined)?.length ?? 0)} chars)`}
        >
          <pre className="whitespace-pre-wrap font-mono text-xs">{String(p.thinking ?? '')}</pre>
        </Collapsible>
      );
    case 'tool_use':
      return (
        <span className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-success-bg px-1.5 py-0.5 font-mono text-xs text-success">
            {String(p.name ?? '?')}
          </code>
          <code className="break-all font-mono text-xs text-muted-foreground">{fmt(p.input)}</code>
        </span>
      );
    case 'tool_result':
      return (
        <Collapsible
          label={`${p.is_error ? 'error' : 'ok'} — ${String(
            (p.preview as string | undefined)?.length ?? 0,
          )} chars`}
        >
          <pre className="whitespace-pre-wrap font-mono text-xs">{String(p.preview ?? '')}</pre>
        </Collapsible>
      );
    case 'sdk_status':
      return <span className="font-mono text-xs text-muted-foreground">{fmt(p)}</span>;
    case 'error':
      return (
        <pre className="whitespace-pre-wrap rounded bg-destructive/10 p-2 font-mono text-xs text-destructive">
          {String(p.class ?? '')}: {String(p.message ?? '')}
        </pre>
      );
    default:
      return <code className="break-all font-mono text-xs text-muted-foreground">{fmt(p)}</code>;
  }
}

function Collapsible({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', open ? '' : '-rotate-90')} />
        {label}
      </button>
      {open ? (
        <div className="mt-1 max-h-72 overflow-auto rounded bg-muted p-2">{children}</div>
      ) : null}
    </div>
  );
}

function fmt(o: unknown): string {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}
