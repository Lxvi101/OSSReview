import { Badge } from '@/components/ui/badge';
import type { ReviewState, Severity } from '@/lib/api';

const REVIEW_VARIANT: Record<ReviewState, React.ComponentProps<typeof Badge>['variant']> = {
  queued: 'info',
  preparing: 'info',
  fetching: 'info',
  reviewing: 'info',
  posting: 'info',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'muted',
};

export function ReviewStateChip({ state }: { state: ReviewState }) {
  return <Badge variant={REVIEW_VARIANT[state] ?? 'muted'}>{state}</Badge>;
}

const SEVERITY_VARIANT: Record<Severity, React.ComponentProps<typeof Badge>['variant']> = {
  blocker: 'destructive',
  warning: 'warning',
  suggestion: 'info',
  praise: 'success',
  nit: 'muted',
};

export function SeverityChip({ severity }: { severity: Severity }) {
  return <Badge variant={SEVERITY_VARIANT[severity] ?? 'muted'}>{severity}</Badge>;
}
