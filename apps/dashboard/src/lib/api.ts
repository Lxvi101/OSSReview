/**
 * Tiny fetch wrapper. The server speaks JSON for /api/*, returns
 * structured errors as `{ error: '...' }` with non-2xx status.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : null,
    ...init,
  });
  if (
    res.status === 401 &&
    typeof window !== 'undefined' &&
    window.location.pathname !== '/login'
  ) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
    throw new ApiError(401, 'redirecting to login');
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON body
    }
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
        ? parsed.error
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export type ReviewState =
  | 'queued'
  | 'preparing'
  | 'fetching'
  | 'reviewing'
  | 'posting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type Severity = 'blocker' | 'warning' | 'suggestion' | 'nit' | 'praise';

export interface ReviewSummary {
  readonly id: number;
  readonly state: ReviewState;
  readonly trigger: string;
  readonly repo: string;
  readonly prNumber: number | null;
  readonly createdAt: string;
  readonly errorClass: string | null;
}

export interface RecentFailure {
  readonly runId: number;
  readonly repoFullName: string;
  readonly prNumber: number | null;
  readonly state: 'failed' | 'cancelled';
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DashboardData {
  readonly recentReviews: Array<{
    id: number;
    state: ReviewState;
    repo: string;
    prNumber: number | null;
    createdAt: string;
  }>;
  readonly queue: { inFlight: number; queued: number; dlq: number };
  readonly recentFailures: ReadonlyArray<RecentFailure>;
}

export interface ReviewDetail {
  readonly review: {
    id: number;
    state: ReviewState;
    terminal: boolean;
    repo: string;
    prNumber: number | null;
    trigger: string;
    attempts: number;
    durationMs: number | null;
    errorClass: string | null;
    errorMessage: string | null;
    cancelRequestedAt: string | null;
    createdAt: string;
  };
  readonly findings: ReadonlyArray<{
    severity: Severity;
    filePath: string;
    lineStart: number | null;
    body: string;
  }>;
}

export interface ReviewEvent {
  readonly id: number;
  readonly reviewRunId: number;
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

export interface RepositorySummary {
  readonly id: number;
  readonly fullName: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface RepositoriesData {
  readonly repositories: ReadonlyArray<RepositorySummary>;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly installations: ReadonlyArray<{
    id: number;
    owner: string;
    count: number;
    configureUrl: string;
  }>;
  readonly appSlug: string | null;
  readonly installNewUrl: string | null;
  readonly recentEvents: ReadonlyArray<{
    at: string;
    kind: string;
    subjectType: string | null;
    data: string;
  }>;
}

export interface RepositoryDetail {
  readonly repo: {
    id: number;
    fullName: string;
    owner: string;
    name: string;
    installationId: number;
    githubUrl: string;
    configureInstallUrl: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  };
  readonly settings: {
    severityFloor: Severity | null;
    promptAddendum: string | null;
    model: string | null;
    reviewerProvider: 'claude' | 'codex' | 'acp' | null;
    ignorePaths: ReadonlyArray<string>;
    skipDrafts: boolean;
    maxMentionsPerPr: number | null;
  };
  readonly recentReviews: ReadonlyArray<{
    id: number;
    state: ReviewState;
    prNumber: number;
    createdAt: string;
  }>;
}

export interface AuditEvent {
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
}

export interface SetupInfo {
  readonly suggestedName: string;
  readonly publicUrl: string;
  readonly preflight: { ok: boolean; reason?: string; suggestion?: string };
  readonly configured: boolean;
  readonly slug: string | null;
  readonly installNewUrl: string | null;
}

export interface StatusCheck {
  readonly name: string;
  readonly description: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

export interface SetupStatusData {
  readonly ok: boolean;
  readonly checks: ReadonlyArray<StatusCheck>;
}
