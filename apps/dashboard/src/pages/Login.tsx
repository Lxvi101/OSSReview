import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

interface CanSignupResponse {
  readonly allowed: boolean;
}

export function LoginPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['can-signup'],
    queryFn: async (): Promise<CanSignupResponse> => {
      const res = await fetch('/api/auth/can-signup');
      return res.json() as Promise<CanSignupResponse>;
    },
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading || !data) return <Skeleton className="mx-auto mt-24 h-64 w-full max-w-md" />;

  const isSignup = data.allowed;
  const heading = isSignup ? 'Create the admin account' : 'Sign in';
  const subheading = isSignup
    ? 'Choose the email and password you want to use to administer this instance. Only the first signup is accepted.'
    : 'Sign in with the account you created on first boot.';
  const path = isSignup ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email';

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = isSignup ? { email, password, name } : { email, password };
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `${res.status} ${res.statusText}`;
        try {
          const parsed = JSON.parse(text) as { message?: string; error?: string };
          msg = parsed.message ?? parsed.error ?? msg;
        } catch {
          // non-JSON body, keep default
        }
        setError(msg);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      window.location.href = next?.startsWith('/') ? next : '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{heading}</CardTitle>
          <p className="text-sm text-muted-foreground">{subheading}</p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            {isSignup ? (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={isSignup ? 12 : undefined}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
              />
              {isSignup ? (
                <p className="text-xs text-muted-foreground">Minimum 12 characters.</p>
              ) : null}
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Working…' : isSignup ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
