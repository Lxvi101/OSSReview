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
import { type AuditEvent, api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';

export function AuditPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ events: ReadonlyArray<AuditEvent> }>('/api/audit'),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Append-only log of every action the system took: webhooks received, reviews posted,
          settings changed.
        </p>
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
          </CardContent>
        ) : !data || data.events.length === 0 ? (
          <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground">
            No audit events yet.
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Subject</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.events.map((e, i) => (
                  <TableRow key={`${e.at}-${i}`}>
                    <TableCell className="text-muted-foreground" title={e.at}>
                      {ago(e.at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="muted">{e.actor}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.kind}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {e.subjectType}
                      {e.subjectId ? ` #${e.subjectId}` : ''}
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
