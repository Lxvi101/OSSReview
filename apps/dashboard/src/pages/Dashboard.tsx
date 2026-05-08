import { ReviewStateChip } from '@/components/StateChip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { type DashboardData, api } from '@/lib/api';
import { ago, trunc } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, GitPullRequest } from 'lucide-react';
import { Link } from 'react-router-dom';

export function DashboardPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
    refetchInterval: 5_000,
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Overview of recent reviews, queue health, and any failures.
          </p>
        </div>
        <Link to="/repositories">
          <Button variant="secondary">Manage repositories</Button>
        </Link>
      </div>

      {isError ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            Failed to load: {(error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <StatCard
          title="Reviews"
          subtitle="PRs reviewed in the last day."
          icon={<GitPullRequest className="h-4 w-4" />}
          loading={isLoading}
          rows={
            data
              ? [
                  ['Total', String(data.recentReviews.length)],
                  [
                    'Completed',
                    String(data.recentReviews.filter((r) => r.state === 'completed').length),
                  ],
                  ['Failed', String(data.recentReviews.filter((r) => r.state === 'failed').length)],
                ]
              : null
          }
          cta={{ label: 'View all reviews', to: '/reviews' }}
        />
        <StatCard
          title="Queue"
          subtitle="Background jobs across all worker processes."
          icon={<Activity className="h-4 w-4" />}
          loading={isLoading}
          rows={
            data
              ? [
                  ['In flight', String(data.queue.inFlight)],
                  ['Waiting', String(data.queue.queued)],
                  [
                    'Dead-lettered',
                    data.queue.dlq > 0 ? (
                      <Badge variant="destructive">{data.queue.dlq}</Badge>
                    ) : (
                      '0'
                    ),
                  ],
                ]
              : null
          }
          cta={{ label: 'Inspect audit log', to: '/audit', variant: 'secondary' }}
        />
      </section>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between border-b border-border p-6">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-warning" />
            <div>
              <CardTitle>Recent failures</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Reviews that ended in <code className="font-mono text-[10px]">failed</code> or{' '}
                <code className="font-mono text-[10px]">cancelled</code>.
              </p>
            </div>
          </div>
          <Link to="/errors" className="text-sm text-info hover:underline">
            All failures →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : !data || data.recentFailures.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">
              No recent failures. Nice.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Repo / PR</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentFailures.map((f) => (
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
                    <TableCell
                      className="font-mono text-xs text-muted-foreground"
                      title={f.errorMessage ?? ''}
                    >
                      <span className="text-foreground">{f.errorClass ?? '—'}</span>
                      {f.errorMessage ? <span> · {trunc(f.errorMessage, 80)}</span> : null}
                    </TableCell>
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

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between border-b border-border p-6">
          <div>
            <CardTitle>Recent reviews</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Latest 10 review runs across all repositories.
            </p>
          </div>
          <Link to="/reviews" className="text-sm text-info hover:underline">
            View all →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : !data || data.recentReviews.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No reviews yet. Open a PR on a tracked repo to trigger your first one.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead>PR</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentReviews.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <ReviewStateChip state={r.state} />
                    </TableCell>
                    <TableCell className="font-medium">{r.repo}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.prNumber != null ? `#${r.prNumber}` : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{ago(r.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Link to={`/reviews/${r.id}`} className="text-sm text-info hover:underline">
                        Details →
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

interface StatCardProps {
  readonly title: string;
  readonly subtitle: string;
  readonly icon: React.ReactNode;
  readonly loading: boolean;
  readonly rows: ReadonlyArray<readonly [string, React.ReactNode]> | null;
  readonly cta: { label: string; to: string; variant?: 'default' | 'secondary' };
}

function StatCard({ title, subtitle, icon, loading, rows, cta }: StatCardProps) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>{title}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <p className="mb-4 text-xs text-muted-foreground">{subtitle}</p>
        <dl className="flex-1">
          {loading || !rows
            ? [0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-baseline justify-between border-b border-border py-2 last:border-b-0"
                >
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-12" />
                </div>
              ))
            : rows.map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between border-b border-border py-2 text-sm last:border-b-0"
                >
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
        </dl>
        <Link to={cta.to} className="mt-4">
          <Button variant={cta.variant ?? 'default'} className="w-full">
            {cta.label}
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
