import { ReviewStateChip } from '@/components/StateChip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { type RepositoryDetail, type Severity, api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, Github, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

const SEVERITIES: ReadonlyArray<Severity> = ['blocker', 'warning', 'suggestion', 'nit', 'praise'];

export function RepoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const repoId = id ? Number.parseInt(id, 10) : null;
  const qc = useQueryClient();
  const [savedFlash, setSavedFlash] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['repository', repoId],
    queryFn: () => api.get<RepositoryDetail>(`/api/repositories/${repoId}`),
    enabled: repoId != null,
  });

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<{ ok: true }>(`/api/repositories/${repoId}/enabled`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repository', repoId] });
      qc.invalidateQueries({ queryKey: ['repositories'] });
      flash();
    },
  });

  const saveSettings = useMutation({
    mutationFn: (body: unknown) =>
      api.put<{ ok: true }>(`/api/repositories/${repoId}/settings`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repository', repoId] });
      flash();
    },
  });

  function flash(): void {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 3_000);
  }

  if (repoId === null) return <p className="text-sm text-destructive">Invalid repository id.</p>;
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p className="text-sm text-destructive">
        Failed to load: {(error as Error | null)?.message ?? 'unknown error'}
      </p>
    );
  }

  const { repo, settings, recentReviews } = data;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{repo.fullName}</h1>
            {repo.enabled ? (
              <Badge variant="success">active</Badge>
            ) : (
              <Badge variant="muted">disabled</Badge>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <a
              href={repo.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-info hover:underline"
            >
              <Github className="h-3 w-3" />
              On GitHub
              <ArrowUpRight className="h-2.5 w-2.5" />
            </a>
            <span>·</span>
            <a
              href={repo.configureInstallUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-info hover:underline"
            >
              <Settings className="h-3 w-3" />
              Configure installation
              <ArrowUpRight className="h-2.5 w-2.5" />
            </a>
            <span>·</span>
            <span>installation #{repo.installationId}</span>
            <span>·</span>
            <span>tracked since {ago(repo.createdAt)}</span>
          </p>
        </div>
        <Link to="/repositories">
          <Button variant="ghost" size="sm">
            ← Back to repositories
          </Button>
        </Link>
      </div>

      {savedFlash ? (
        <Card className="border-success bg-success-bg">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <Check className="h-4 w-4 text-success" />
            <strong>Saved.</strong>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Pause / resume reviews</CardTitle>
          <p className="text-sm text-muted-foreground">
            Local toggle — doesn't change what GitHub grants. Useful for pausing a noisy WIP repo
            without revoking the App.
          </p>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Switch
            id="enabled"
            checked={repo.enabled}
            onCheckedChange={(v) => setEnabled.mutate(v)}
            disabled={setEnabled.isPending}
          />
          <Label htmlFor="enabled">Enabled</Label>
        </CardContent>
      </Card>

      <SettingsForm
        initial={settings}
        saving={saveSettings.isPending}
        onSubmit={(body) => saveSettings.mutate(body)}
      />

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border p-6">
          <CardTitle>Recent reviews</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentReviews.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No reviews yet. Open a PR and one will appear within a minute.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>PR</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentReviews.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <ReviewStateChip state={r.state} />
                    </TableCell>
                    <TableCell>#{r.prNumber}</TableCell>
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

interface SettingsFormProps {
  readonly initial: RepositoryDetail['settings'];
  readonly saving: boolean;
  readonly onSubmit: (body: unknown) => void;
}

function SettingsForm({ initial, saving, onSubmit }: SettingsFormProps) {
  const [severityFloor, setSeverityFloor] = useState<string>(initial.severityFloor ?? '');
  const [provider, setProvider] = useState<string>(initial.reviewerProvider ?? '');
  const [model, setModel] = useState<string>(initial.model ?? '');
  const [ignorePaths, setIgnorePaths] = useState<string>(initial.ignorePaths.join('\n'));
  const [promptAddendum, setPromptAddendum] = useState<string>(initial.promptAddendum ?? '');
  const [maxMentions, setMaxMentions] = useState<string>(
    initial.maxMentionsPerPr != null ? String(initial.maxMentionsPerPr) : '',
  );
  const [skipDrafts, setSkipDrafts] = useState<boolean>(initial.skipDrafts);

  // Reset form when the underlying data changes (e.g. after invalidation).
  useEffect(() => {
    setSeverityFloor(initial.severityFloor ?? '');
    setProvider(initial.reviewerProvider ?? '');
    setModel(initial.model ?? '');
    setIgnorePaths(initial.ignorePaths.join('\n'));
    setPromptAddendum(initial.promptAddendum ?? '');
    setMaxMentions(initial.maxMentionsPerPr != null ? String(initial.maxMentionsPerPr) : '');
    setSkipDrafts(initial.skipDrafts);
  }, [initial]);

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const ignoreList = ignorePaths
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    onSubmit({
      severityFloor: severityFloor || null,
      reviewerProvider: provider || null,
      model: model.trim() || null,
      ignorePaths: ignoreList,
      promptAddendum: promptAddendum.trim() || null,
      maxMentionsPerPr: maxMentions ? Number.parseInt(maxMentions, 10) : null,
      skipDrafts,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review settings</CardTitle>
        <p className="text-sm text-muted-foreground">
          Per-repo overrides on top of the global defaults. Empty = fall back to default.
        </p>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-[200px,1fr]"
        >
          <Label htmlFor="severityFloor" className="pt-2">
            Minimum severity
          </Label>
          <Select
            id="severityFloor"
            value={severityFloor}
            onChange={(e) => setSeverityFloor(e.target.value)}
            className="max-w-md"
          >
            <option value="">Default (suggestion)</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>

          <Label htmlFor="provider" className="pt-2">
            Reviewer provider
          </Label>
          <Select
            id="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="max-w-md"
          >
            <option value="">Default</option>
            <option value="claude">Claude Code CLI</option>
            <option value="codex">Codex CLI</option>
          </Select>

          <Label htmlFor="model" className="pt-2">
            Model override
          </Label>
          <Input
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. claude-sonnet-4-5 (blank for default)"
            className="max-w-md"
          />

          <div className="pt-2">
            <Label htmlFor="ignorePaths" className="font-medium">
              Ignore paths
            </Label>
            <p className="text-xs text-muted-foreground">one glob per line</p>
          </div>
          <Textarea
            id="ignorePaths"
            value={ignorePaths}
            onChange={(e) => setIgnorePaths(e.target.value)}
            rows={4}
            placeholder={'vendor/**\n*.lock\ndist/**'}
            className="max-w-md font-mono"
          />

          <div className="pt-2">
            <Label htmlFor="promptAddendum" className="font-medium">
              Prompt addendum
            </Label>
            <p className="text-xs text-muted-foreground">
              appended to the system prompt for this repo only
            </p>
          </div>
          <Textarea
            id="promptAddendum"
            value={promptAddendum}
            onChange={(e) => setPromptAddendum(e.target.value)}
            rows={5}
            placeholder="e.g. This is a Next.js project — prefer server components."
            className="max-w-md"
          />

          <Label htmlFor="maxMentions" className="pt-2">
            Max mention re-runs / PR
          </Label>
          <Input
            id="maxMentions"
            type="number"
            min={0}
            max={100}
            value={maxMentions}
            onChange={(e) => setMaxMentions(e.target.value)}
            placeholder="3"
            className="w-32"
          />

          <Label htmlFor="skipDrafts" className="pt-2">
            Drafts
          </Label>
          <div className="flex items-center gap-2 pt-2">
            <Switch id="skipDrafts" checked={skipDrafts} onCheckedChange={setSkipDrafts} />
            <span className="text-sm">Skip auto-review on drafts (mentions still trigger)</span>
          </div>

          <div className="col-span-full flex justify-end border-t border-border pt-4">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
