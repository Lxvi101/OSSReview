# Operations runbook

Where to look and what to type.

## First-time setup checklist

A working install needs ten minutes of attention, in this order. Anything
that's not green at step 4 is a "this won't review PRs" problem.

```bash
# ── 1. Fill the bootstrap env ───────────────────────────────────────────────
cp .env.example .env
echo "SECRETS_KEY=$(openssl rand -hex 32)"        >> .env   # 32-byte hex
echo "SESSION_SECRET=$(openssl rand -base64 48)"  >> .env
# Set PUBLIC_URL to the URL GitHub will hit. For dev, a smee.io URL works.
# With compose, run reviewer login inside the worker after it starts:
#   docker compose -f docker/compose.yml exec worker claude auth login
#   docker compose -f docker/compose.yml exec worker codex login

# ── 2. Bring the stack up ───────────────────────────────────────────────────
docker compose -f docker/compose.yml up -d --build
docker compose -f docker/compose.yml logs -f server worker

# ── 3. Run the GitHub App setup wizard ──────────────────────────────────────
# Open http://localhost:3000/setup, follow the manifest flow.
# After GitHub redirects back, install the App on a repository.

# ── 4. Smoke check — every row should be `ok` ───────────────────────────────
pnpm smoke
# (or: open http://localhost:3000/setup/status in a browser)

# ── 5. Trigger your first review ────────────────────────────────────────────
# Open a PR in the installed repo. Within ~5 s the bot should react with
# "eyes". Within a minute or two a review appears authored by the App.
```

The worker boots in a "wait for credentials" mode by default — it polls the
settings table every 5 s and starts processing automatically once GitHub App
credentials are present. Reviewer auth comes from the local `claude` or `codex`
CLI home used by the worker process; in compose this is persisted in
`docker/data`.

## Local development with smee.io

GitHub needs a public URL to deliver webhooks to. For local dev:

```bash
# In a terminal:
pnpm dlx smee-client --url https://smee.io/<your-channel> \
                     --target http://localhost:3000/webhooks/github
```

Set `PUBLIC_URL=https://smee.io/<your-channel>` in `.env` before running the
setup wizard so the manifest registers the smee URL as the webhook
destination.

## "I'm worried something is wrong" — three commands

```bash
# 1. Process up + deps reachable + config complete
pnpm smoke

# 2. What's in the queue?
sqlite3 data/gcr.sqlite "SELECT state, COUNT(*) FROM jobs GROUP BY state"

# 3. What did the worker say recently?
docker compose -f docker/compose.yml logs --tail=200 worker
```

## SQLite cheatsheet

```bash
# Recent webhook deliveries
sqlite3 data/gcr.sqlite "SELECT received_at, event, action, processing_outcome FROM webhook_deliveries ORDER BY id DESC LIMIT 20"

# Reviews stuck in a non-terminal state
sqlite3 data/gcr.sqlite "SELECT id, state, attempts, error_message FROM review_runs WHERE state NOT IN ('completed','failed','cancelled') ORDER BY id DESC"

# DLQ jobs
sqlite3 data/gcr.sqlite "SELECT id, name, attempts, last_error FROM jobs WHERE state='failed' ORDER BY id DESC LIMIT 20"

# Today's spend (USD)
sqlite3 data/gcr.sqlite "SELECT printf('$%.4f', SUM(cost_usd_micros)/1000000.0) FROM review_runs WHERE updated_at >= date('now') AND state='completed'"
```

## Manual requeue

```bash
sqlite3 data/gcr.sqlite "UPDATE jobs SET state='queued', run_after=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=<JOB_ID>"
```

The worker picks it up within ~1 s.

## Drain workers (graceful)

```bash
docker compose -f docker/compose.yml stop worker
# Honors SIGTERM, finishes the in-flight job (up to stop_grace_period: 60s),
# then exits. Restart with `up -d` when you're ready.
```

## Restore from Litestream

The litestream sidecar continuously replicates the WAL to `./backups`
(local) or wherever else you've configured (`docker/litestream.yml`).

```bash
docker compose -f docker/compose.yml stop server worker
docker compose -f docker/compose.yml run --rm litestream \
  restore -if-replica-exists -o /data/gcr.sqlite file:///backups/gcr
docker compose -f docker/compose.yml up -d
```

## Rotate the at-rest secrets key

```bash
NEW_KEY=$(openssl rand -hex 32)
# Re-encrypt every settings row with the new key. (CLI lands in M3.)
docker compose -f docker/compose.yml exec server pnpm gcr secrets rotate --new-key=$NEW_KEY
# Update SECRETS_KEY in .env to the new value, then restart.
```

## Logs

JSON to stdout. Fields you'll grep most often:

- `delivery_id` — every line for a single GitHub webhook
- `review_run_id` — every line for a single review
- `job_id` — every line for a single job
- `repo` — `owner/name`

```bash
docker compose -f docker/compose.yml logs server worker | jq 'select(.review_run_id == 42)'
```

## Alerts (when Prometheus is wired)

Metrics that should page someone:

- `gcr_webhook_invalid_signature_total` rising — possible attack or misconfig
- `gcr_jobs_dlq{name="review_pr"}` > 0 — failed reviews need investigation
- `gcr_review_run_duration_seconds_bucket{le="600"}` ratio < 0.95 — reviews
  are slow, maybe reviewer CLI latency or a large PR
- `gcr_github_rate_limit_remaining` < 100 — about to hit a rate limit
- `gcr_sandbox_active` > 8 — runaway legacy sandbox count, if enabled

## Common failures (and what they mean)

### `pnpm smoke` says "GitHub App: fail"

You haven't completed `/setup`. Open the URL printed in the smoke output
and follow the wizard.

### `pnpm smoke` says "Claude Code CLI: fail" or "Codex CLI: fail"

Install the missing CLI or set `CLAUDE_CODE_BINARY` / `CODEX_BINARY` in `.env`.
The compose image includes both CLIs by default. Then log in inside the worker
container:

```bash
docker compose -f docker/compose.yml exec worker claude auth login
docker compose -f docker/compose.yml exec worker codex login
```

### Webhook returns 503 "github app not yet configured"

The webhook secret isn't in the settings table. Run `/setup` first.

### Reviews are queued but never processed

Check `docker compose logs worker`. Most likely:
- `worker.boot.waiting_for_credentials` — finish `/setup`.
- `Command not found: claude` or `Command not found: codex` — the worker cannot
  see the configured reviewer binary.
- An authentication error from Claude or Codex — log in with the same HOME used
  by the worker, or set `CLAUDE_CODE_HOME` / `CODEX_HOME`. With compose, rerun
  the relevant `docker compose exec worker ... login` command.

### `repo X not tracked` in the worker logs

The webhook is for a repo not in our `repositories` table. Either the App
isn't installed on it, or the `installation_repositories.added` webhook
never reached us. Check `/audit` for `webhook.received` events with
`event=installation*`.

### Legacy sandbox containers can't reach `api.anthropic.com`

The egress firewall (`docker/network/README.md`) is misconfigured, or you
applied the iptables rules but anthropic's IPs have rotated. Re-run the IP
discovery + iptables steps in the network README.

### "ENOENT: docker.sock" in worker logs

This only applies to the legacy Docker sandbox reviewer. The default host-local
reviewer path does not require Docker socket access.
