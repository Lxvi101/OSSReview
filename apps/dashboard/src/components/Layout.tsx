import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/useTheme';
import { type SetupStatusData, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  FolderGit2,
  GitPullRequest,
  Github,
  LayoutDashboard,
  Moon,
  Settings,
  Sun,
  Wrench,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

const NAV: ReadonlyArray<{
  section: string;
  items: ReadonlyArray<{
    to: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    end?: boolean;
  }>;
}> = [
  {
    section: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/repositories', label: 'Repositories', icon: FolderGit2 },
      { to: '/reviews', label: 'Reviews', icon: GitPullRequest },
      { to: '/errors', label: 'Errors', icon: AlertTriangle },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/audit', label: 'Audit log', icon: Activity },
      { to: '/setup/status', label: 'Setup & status', icon: Settings },
    ],
  },
];

export function Layout() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-x-auto px-6 py-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
        <Footer />
      </div>
    </div>
  );
}

function Sidebar() {
  // Drives the bottom-of-sidebar health indicator. Falls back to "unknown" if
  // the API can't be reached — better than hardcoding green.
  const status = useQuery({
    queryKey: ['setup-status-sidebar'],
    queryFn: () => api.get<SetupStatusData>('/api/setup/status'),
    refetchInterval: 30_000,
  });
  const dotClass = !status.data
    ? 'bg-muted-foreground'
    : status.data.ok
      ? 'bg-success'
      : 'bg-destructive';
  const label = !status.data
    ? status.isLoading
      ? 'Checking…'
      : 'Status unknown'
    : status.data.ok
      ? 'System healthy'
      : 'Needs attention';

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="px-4 pt-5 pb-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          App
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <GitPullRequest className="h-3.5 w-3.5" />
          </div>
          <div className="text-sm font-semibold">GitHub Code Reviewer</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pt-2 pb-4">
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.section}
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-card font-medium text-foreground border border-border'
                      : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                  )
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3 text-xs text-muted-foreground">
        <NavLink to="/setup/status" className="flex items-center gap-2 hover:text-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
          {label}
        </NavLink>
      </div>
    </aside>
  );
}

function Topbar() {
  const { theme, toggle } = useTheme();
  return (
    <header className="flex h-14 items-center justify-end border-b border-border bg-card px-6">
      <div className="flex items-center gap-1">
        <NavLink
          to="/setup/status"
          title="System status"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Wrench className="h-4 w-4" />
        </NavLink>
        <a
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub installations"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Github className="h-4 w-4" />
        </a>
        <Button variant="ghost" size="icon" onClick={toggle} title="Toggle theme" type="button">
          {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="flex justify-between border-t border-border px-6 py-3 text-xs text-muted-foreground">
      <span>GitHub Code Reviewer · Apache-2.0 · self-hosted</span>
      <span className="inline-flex items-center gap-1">
        v0.1
        <ArrowUpRight className="h-3 w-3" />
      </span>
    </footer>
  );
}
