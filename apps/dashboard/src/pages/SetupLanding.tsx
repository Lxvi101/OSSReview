import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { type SetupInfo, api } from '@/lib/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Github, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';

export function SetupLandingPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupInfo>('/api/setup'),
  });
  const [name, setName] = useState('gcr-bot');
  const [ownerType, setOwnerType] = useState<'user' | 'organization'>('user');
  const [org, setOrg] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: () => api.del<{ ok: true; reposDisabled: number }>('/api/setup/github-app'),
    onSuccess: () => {
      setResetError(null);
      qc.invalidateQueries({ queryKey: ['setup'] });
      qc.invalidateQueries({ queryKey: ['setup-status'] });
      qc.invalidateQueries({ queryKey: ['repositories'] });
    },
    onError: (e: Error) => setResetError(e.message),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError || !data)
    return (
      <p className="text-sm text-destructive">
        Failed to load: {(error as Error | null)?.message ?? 'unknown error'}
      </p>
    );

  if (data.configured) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Setup</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The GitHub App is already configured.
          </p>
        </div>
        <Card>
          <CardContent className="space-y-3 p-6 text-sm">
            <p>
              App slug: <code className="font-mono">{data.slug}</code>
            </p>
            {data.installNewUrl ? (
              <a
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                target="_blank"
                rel="noopener noreferrer"
                href={data.installNewUrl}
              >
                <Github className="h-3.5 w-3.5" />
                Install on a new repository
                <ArrowUpRight className="h-3 w-3" />
              </a>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Danger zone</CardTitle>
            <p className="text-sm text-muted-foreground">
              Unlink the current GitHub App so you can register a different one. This clears the
              stored App ID, slug, client secret, webhook secret, and private key, then disables
              every tracked repository. Reviews, audit history, and repository settings are kept;
              installing a new App on the same repos will re-enable them.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              variant="destructive"
              disabled={reset.isPending}
              onClick={() => {
                const confirmed = window.confirm(
                  'Unlink the current GitHub App? All tracked repositories will be disabled until you install a new App.',
                );
                if (confirmed) reset.mutate();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {reset.isPending ? 'Resetting…' : 'Reset linked GitHub App'}
            </Button>
            {resetError ? <p className="text-sm text-destructive">{resetError}</p> : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Set up the GitHub App</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          This wizard will create a GitHub App with the right permissions and install it on the
          repositories you choose. The app will post reviews under its own identity — you don't need
          to share a personal access token.
        </p>
      </div>

      {!data.preflight.ok ? (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="space-y-3 p-6">
            <div className="flex items-start gap-3">
              <XCircle className="mt-0.5 h-5 w-5 text-destructive" />
              <h2 className="text-base font-semibold text-destructive">
                PUBLIC_URL is not acceptable to GitHub
              </h2>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">Currently:</dt>
                <dd>
                  <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">
                    {data.publicUrl}
                  </code>
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">Reason:</dt>
                <dd>{data.preflight.reason}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">What to do:</dt>
                <dd>{data.preflight.suggestion}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">
              Update <code className="font-mono text-xs">.env</code>, restart the stack, then
              refresh this page.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Create the App</CardTitle>
            <p className="text-sm text-muted-foreground">
              Webhook URL:{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {data.publicUrl}/webhooks/github
              </code>
            </p>
          </CardHeader>
          <CardContent>
            <form
              action="/setup/manifest"
              method="post"
              className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-[160px,1fr]"
            >
              <Label htmlFor="appname" className="pt-2">
                App name
              </Label>
              <Input
                id="appname"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="max-w-md"
              />
              <Label htmlFor="ownerType" className="pt-2">
                Create under
              </Label>
              <Select
                id="ownerType"
                name="ownerType"
                value={ownerType}
                onChange={(e) => setOwnerType(e.target.value as 'user' | 'organization')}
                className="max-w-md"
              >
                <option value="user">My GitHub account</option>
                <option value="organization">A GitHub organization</option>
              </Select>
              {ownerType === 'organization' ? (
                <>
                  <Label htmlFor="org" className="pt-2">
                    Organization
                  </Label>
                  <Input
                    id="org"
                    name="org"
                    value={org}
                    onChange={(e) => setOrg(e.target.value)}
                    required
                    placeholder="acme-inc"
                    pattern="[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
                    className="max-w-md"
                  />
                </>
              ) : null}
              <p className="col-span-full text-xs text-muted-foreground">
                The form below submits to GitHub. They'll redirect back to this server with the new
                App's credentials. Choose an organization here when the repositories are owned by
                that organization.
              </p>
              <div className="col-span-full flex justify-end border-t border-border pt-4">
                <Button type="submit">
                  <Github className="h-3.5 w-3.5" />
                  Create GitHub App
                  <ArrowUpRight className="h-3 w-3" />
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
