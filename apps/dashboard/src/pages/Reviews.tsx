import { ReviewStateChip } from '@/components/StateChip';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type ReviewSummary, api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

const STATE_FILTERS = ['all', 'completed', 'failed', 'cancelled', 'queued', 'reviewing'] as const;

export function ReviewsPage() {
  const [params, setParams] = useSearchParams();
  const filter = params.get('state') ?? 'all';

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reviews', filter],
    queryFn: () =>
      api.get<{ reviews: ReadonlyArray<ReviewSummary> }>(
        filter === 'all' ? '/api/reviews' : `/api/reviews?state=${encodeURIComponent(filter)}`,
      ),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every review run the worker has executed. Click a row to see the live transcript and
          posted findings.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Filter:</span>
        {STATE_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              const next = new URLSearchParams(params);
              if (s === 'all') next.delete('state');
              else next.set('state', s);
              setParams(next);
            }}
            className={
              filter === s
                ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
            }
          >
            {s}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {isError ? (
          <CardContent className="py-6 text-sm text-destructive">
            Failed to load: {(error as Error).message}
          </CardContent>
        ) : isLoading ? (
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </CardContent>
        ) : !data || data.reviews.length === 0 ? (
          <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground">
            {filter === 'all'
              ? 'No reviews yet. Open a PR on a tracked repository to trigger your first one.'
              : `No reviews with state=${filter}.`}
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead>PR</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.reviews.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <ReviewStateChip state={r.state} />
                    </TableCell>
                    <TableCell className="font-medium">{r.repo}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.prNumber != null ? `#${r.prNumber}` : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.trigger}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{ago(r.createdAt)}</TableCell>
                    <TableCell>
                      {r.errorClass ? (
                        <Badge variant="destructive" className="font-mono text-[10px]">
                          {r.errorClass}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link to={`/reviews/${r.id}`} className="text-sm text-info hover:underline">
                        Details →
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
