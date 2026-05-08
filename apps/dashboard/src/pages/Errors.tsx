import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type RecentFailure, api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';

export function ErrorsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['errors'],
    queryFn: () => api.get<{ failures: ReadonlyArray<RecentFailure> }>('/api/errors'),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Errors</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every review run that ended in <code className="font-mono text-xs">failed</code> or{' '}
          <code className="font-mono text-xs">cancelled</code>. Last 100. Click a row for the full
          transcript and stack trace.
        </p>
      </div>

      {isError ? (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">
            Failed to load: {(error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center gap-2 border-b border-border p-6">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <CardTitle>Failures and cancellations</CardTitle>
          {data ? <Badge variant="muted">{data.failures.length}</Badge> : null}
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : !data || data.failures.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No failures recorded. Everything is healthy.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Repo / PR</TableHead>
                  <TableHead>Error class</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.failures.map((f) => (
                  <TableRow key={f.runId}>
                    <TableCell>
                      <Badge variant={f.state === 'cancelled' ? 'muted' : 'destructive'}>
                        {f.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {f.repoFullName}
                      {f.prNumber != null ? ` #${f.prNumber}` : ''}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {f.errorClass ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell
                      className="max-w-md truncate font-mono text-xs text-muted-foreground"
                      title={f.errorMessage ?? ''}
                    >
                      {f.errorMessage ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.attempts}</TableCell>
                    <TableCell className="text-muted-foreground" title={f.updatedAt}>
                      {ago(f.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        to={`/reviews/${f.runId}`}
                        className="text-sm text-info hover:underline"
                      >
                        Open →
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
