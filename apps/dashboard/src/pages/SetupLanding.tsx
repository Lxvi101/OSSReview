import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { type SetupInfo, api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Github, XCircle } from 'lucide-react';
import { useState } from 'react';

export function SetupLandingPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupInfo>('/api/setup'),
  });
  const [name, setName] = useState('gcr-bot');

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
              <p className="col-span-full text-xs text-muted-foreground">
                The form below submits to GitHub. They'll redirect back to this server with the new
                App's credentials.
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
