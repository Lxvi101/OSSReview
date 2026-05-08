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
import { type RepositoriesData, api } from '@/lib/api';
import { ago, trunc } from '@/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Github, RefreshCw, Settings } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

export function RepositoriesPage() {
  const [params, setParams] = useSearchParams();
  const showAll = params.get('show') === 'all';
  const qc = useQueryClient();
  const [justRefreshed, setJustRefreshed] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['repositories', showAll],
    queryFn: () => api.get<RepositoriesData>(`/api/repositories${showAll ? '?show=all' : ''}`),
  });

  const refresh = useMutation({
    mutationFn: () => api.post<{ ok: true; queued: number }>('/api/repositories/refresh'),
    onSuccess: () => {
      setJustRefreshed(true);
      qc.invalidateQueries({ queryKey: ['repositories'] });
      setTimeout(() => setJustRefreshed(false), 6_000);
    },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Repos this GitHub App is installed on. Reviews fire automatically on opened PRs.
        </p>
      </div>

      {justRefreshed ? (
        <Card className="border-success bg-success-bg">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <span className="text-success">✓</span>
            <div>
              <strong>Refresh queued.</strong> The worker is reconciling with GitHub right now —
              refresh in a few seconds; the activity table below will show what changed.
            </div>
          </CardContent>
        </Card>
      ) : null}

      {data && data.installations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Manage on GitHub</CardTitle>
            <p className="text-sm text-muted-foreground">
              Repository access is granted in the App's installation settings. Adds fire a webhook
              within ~1s. Removes don't always fire (notably from "All repositories" mode) — use{' '}
              <strong>Refresh from GitHub</strong> to reconcile.
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {data.installations.map((i) => (
              <a
                key={i.id}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                target="_blank"
                rel="noopener noreferrer"
                href={i.configureUrl}
              >
                <Settings className="h-3.5 w-3.5" />
                Configure {i.owner}
                <Badge variant="muted">{i.count}</Badge>
                <ArrowUpRight className="h-3 w-3" />
              </a>
            ))}
            {data.installNewUrl ? (
              <a
                className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                target="_blank"
                rel="noopener noreferrer"
                href={data.installNewUrl}
              >
                <Github className="h-3.5 w-3.5" />
                Install on a new account
                <ArrowUpRight className="h-3 w-3" />
              </a>
            ) : null}
            <Button
              variant="default"
              type="button"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                className={refresh.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
              />
              Refresh from GitHub
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between border-b border-border p-6">
          <div className="flex items-center gap-3">
            <CardTitle>Tracked repositories</CardTitle>
            <Badge variant="muted">{data?.enabledCount ?? 0} active</Badge>
            {data && data.disabledCount > 0 ? (
              <Badge variant="warning">{data.disabledCount} revoked</Badge>
            ) : null}
          </div>
          {data && data.disabledCount > 0 ? (
            <button
              type="button"
              className="text-sm text-info hover:underline"
              onClick={() => {
                const next = new URLSearchParams(params);
                if (showAll) next.delete('show');
                else next.set('show', 'all');
                setParams(next);
              }}
            >
              {showAll ? 'Hide revoked' : 'Show all'}
            </button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {isError ? (
            <div className="px-6 py-6 text-sm text-destructive">
              Failed to load: {(error as Error).message}
            </div>
          ) : isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : !data || data.repositories.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {showAll || data?.disabledCount === 0 ? (
                <>
                  <p>No repositories tracked yet.</p>
                  {data?.installNewUrl ? (
                    <a
                      className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={data.installNewUrl}
                    >
                      <Github className="h-3.5 w-3.5" />
                      Install on GitHub
                    </a>
                  ) : null}
                </>
              ) : (
                <p>
                  No active repositories.{' '}
                  <Link to="/repositories?show=all" className="text-info hover:underline">
                    Show {data?.disabledCount} revoked →
                  </Link>
                </p>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.repositories.map((r) => (
                  <TableRow key={r.id} className={r.enabled ? '' : 'opacity-60'}>
                    <TableCell>
                      <Link
                        to={`/repositories/${r.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {r.fullName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {r.enabled ? (
                        <Badge variant="success">active</Badge>
                      ) : (
                        <Badge variant="muted">revoked</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground" title={r.updatedAt}>
                      {ago(r.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        to={`/repositories/${r.id}`}
                        className="text-sm text-info hover:underline"
                      >
                        Settings →
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {data && data.recentEvents.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border p-6">
            <CardTitle>Recent install activity</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Last few install-related events processed by the worker. If you edited access on
              GitHub but don't see a fresh row here within a few seconds, GitHub didn't fire a
              webhook for that change — use Refresh to reconcile.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentEvents.map((e, i) => (
                  <TableRow key={`${e.at}-${i}`}>
                    <TableCell className="text-muted-foreground">{ago(e.at)}</TableCell>
                    <TableCell>
                      {e.kind === 'repo.added' ? (
                        <Badge variant="success">{e.kind}</Badge>
                      ) : e.kind === 'repo.removed' ? (
                        <Badge variant="warning">{e.kind}</Badge>
                      ) : (
                        <Badge variant="muted">{e.kind}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{e.subjectType}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {trunc(e.data, 80)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
