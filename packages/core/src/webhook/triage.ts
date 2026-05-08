/**
 * Webhook triage — pure decision: given a parsed webhook envelope, what kind
 * of work (if any) should we enqueue?
 *
 * The HTTP layer in apps/server uses this to decide what jobs to insert in
 * the same SQLite transaction as the WebhookDelivery row.
 */

export type TriageDecision =
  | { kind: 'enqueue_review'; reason: 'pull_request_event' }
  | { kind: 'enqueue_mention_review'; reason: 'issue_comment_mention' }
  | { kind: 'install_repos'; reason: 'installation_event' }
  | { kind: 'ignore'; reason: string };

interface TriageInput {
  readonly event: string;
  readonly action: string | null | undefined;
  /**
   * The raw payload — parsed but typed loosely on purpose; we only read the
   * shallow shape here so that GitHub schema drift in deep fields does not
   * break triage.
   */
  readonly payload: Record<string, unknown>;
  /** Bot's GitHub login (without leading `@`), for mention detection. */
  readonly botLogin: string;
}

export function triage(input: TriageInput): TriageDecision {
  const { event, action, payload, botLogin } = input;

  if (event === 'ping') return { kind: 'ignore', reason: 'ping' };

  if (event === 'pull_request') {
    if (
      action === 'opened' ||
      action === 'reopened' ||
      action === 'synchronize' ||
      action === 'ready_for_review'
    ) {
      const pr = payload.pull_request as { draft?: boolean } | undefined;
      if (pr?.draft && action !== 'ready_for_review') {
        return { kind: 'ignore', reason: 'draft_pr' };
      }
      return { kind: 'enqueue_review', reason: 'pull_request_event' };
    }
    return { kind: 'ignore', reason: `pull_request:${action ?? 'no_action'}` };
  }

  if (event === 'issue_comment' && action === 'created') {
    const issue = payload.issue as { pull_request?: unknown } | undefined;
    if (!issue?.pull_request) {
      return { kind: 'ignore', reason: 'issue_comment_on_issue_not_pr' };
    }
    const comment = payload.comment as { body?: string; user?: { login?: string } } | undefined;
    const body = comment?.body ?? '';
    if (!mentionsBot(body, botLogin)) return { kind: 'ignore', reason: 'no_mention' };
    if (comment?.user?.login === botLogin) return { kind: 'ignore', reason: 'self_mention' };
    return { kind: 'enqueue_mention_review', reason: 'issue_comment_mention' };
  }

  if (event === 'installation' || event === 'installation_repositories') {
    return { kind: 'install_repos', reason: 'installation_event' };
  }

  return { kind: 'ignore', reason: `event:${event}` };
}

/**
 * True if `body` mentions the bot. Matches `@<login>` as a whole word
 * (case-insensitive on the login, since GitHub logins are case-insensitive).
 *
 * GitHub bot users have logins like `gcr-bot-demo[bot]` in API responses,
 * but the `@`-mention syntax is just `@gcr-bot-demo` (no `[bot]` suffix).
 * Strip the suffix so callers can pass the raw login from the App settings
 * and we still match what the user actually typed.
 */
export function mentionsBot(body: string, botLogin: string): boolean {
  if (!body || !botLogin) return false;
  const handle = botLogin.endsWith('[bot]') ? botLogin.slice(0, -'[bot]'.length) : botLogin;
  if (!handle) return false;
  // `\b` won't fire after `@` in JS regex (\b is between \w and non-\w);
  // build the boundary explicitly.
  const re = new RegExp(`(?:^|[^a-z0-9_])@${escapeRegExp(handle)}(?![a-z0-9_-])`, 'i');
  return re.test(body);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
