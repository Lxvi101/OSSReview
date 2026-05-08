import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type SetupStatusData, api } from '@/lib/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Trash2 } from 'lucide-react';
import { useState } from 'react';

export function SetupStatusPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<SetupStatusData>('/api/setup/status'),
    refetchInterval: 30_000,
  });

  const [olderThan, setOlderThan] = useState('30');
  const [pruneResult, setPruneResult] = useState<string | null>(null);

  const prune = useMutation({
    mutationFn: (days: number) =>
      api.post<{ ok: true; deleted: number; olderThanDays: number }>('/api/maintenance/prune', {
        olderThanDays: days,
      }),
    onSuccess: (r) => {
      setPruneResult(`Deleted ${r.deleted} run(s) older than ${r.olderThanDays} days.`);
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['reviews'] });
      qc.invalidateQueries({ queryKey: ['errors'] });
      setTimeout(() => setPruneResult(null), 8_000);
    },
    onError: (e: Error) => setPruneResult(`Error: ${e.message}`),
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          At-a-glance: is the bot ready to review pull requests? Each row is a thing the worker
          needs to function. Anything red is a blocker.
        </p>
      </div>

      {isError ? (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">
            Failed to load: {(error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        data.ok ? (
          <Card className="border-success bg-success-bg">
            <CardContent className="flex items-start gap-3 p-4 text-sm">
              <Check className="h-4 w-4 text-success" />
              <div>
                <strong>Everything is configured.</strong> Open a PR on a tracked repository to
                trigger your first review.
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-warning bg-warning-bg">
            <CardContent className="flex items-start gap-3 p-4 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <div>
                <strong>One or more components need attention.</strong> The worker will pick up
                automatically once everything is green — no restart required.
              </div>
            </CardContent>
          </Card>
        )
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border p-6">
          <CardTitle>Components</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : !data ? null : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Status</TableHead>
                  <TableHead>Component</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.checks.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell>
                      {c.status === 'ok' ? (
                        <Badge variant="success">ok</Badge>
                      ) : c.status === 'warn' ? (
                        <Badge variant="warning">warn</Badge>
                      ) : (
                        <Badge variant="destructive">fail</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{c.description}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.detail}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Maintenance</CardTitle>
          <p className="text-sm text-muted-foreground">
            Delete completed/failed/cancelled review runs older than N days. The transcript
            (review_events), inline comments, and the run row itself are removed. PR snapshots and
            audit log are kept.
          </p>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number.parseInt(olderThan, 10);
              if (Number.isFinite(n) && n >= 1) prune.mutate(n);
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <div>
              <Label htmlFor="olderThan">Older than (days)</Label>
              <Input
                id="olderThan"
                type="number"
                min={1}
                max={3650}
                value={olderThan}
                onChange={(e) => setOlderThan(e.target.value)}
                className="mt-1 w-32"
              />
            </div>
            <Button type="submit" variant="destructive" disabled={prune.isPending}>
              <Trash2 className="h-3.5 w-3.5" />
              {prune.isPending ? 'Pruning…' : 'Prune old runs'}
            </Button>
            {pruneResult ? (
              <span className="text-sm text-muted-foreground">{pruneResult}</span>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
