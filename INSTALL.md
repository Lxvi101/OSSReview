# Install

End-to-end, ~15 minutes.

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- Node.js 20+ and pnpm 9+ (for the bootstrap script)
- Git
- ~2 GB free RAM, ~5 GB free disk
- A public URL GitHub can reach. Easiest options:
  - **smee.io** — free, zero-setup webhook proxy. Visit
    <https://smee.io/new>, copy the URL.
  - **A real domain** with TLS (Caddy / Cloudflare Tunnel / nginx).
- A GitHub account that can install Apps on a repo.

You also need a **Claude Code or Codex CLI login** on the worker. The
default is Claude Code; the App image installs both binaries.

## 1. Clone and bootstrap

```bash
git clone <REPO_URL> github-code-reviewer
cd github-code-reviewer
pnpm install
pnpm bootstrap
```

`bootstrap` runs `init-env` (interactive: prompts for `PUBLIC_URL`),
generates `SECRETS_KEY` and `SESSION_SECRET`, writes `.env` mode 600, then
`docker compose up -d --build` and waits for `/health`.

Re-runnable: skips steps that are already done.

## 2. Authenticate the reviewer CLI

```bash
docker compose -f docker/compose.yml exec worker claude auth login
```

Or for Codex:

```bash
docker compose -f docker/compose.yml exec worker codex login
```

Auth files persist on the bind-mounted `docker/data` volume.

If you'd rather not log in inside the container, you can copy your host's
existing CLI auth into the volume:

```bash
pnpm import-credentials
```

(macOS extracts the Claude Code Keychain entry; Linux copies
`~/.claude/.credentials.json` and `~/.codex/auth.json`.)

## 3. Register the GitHub App

Open the URL `bootstrap` printed (default `http://localhost:3000/setup`).

1. Type a unique-on-GitHub bot name (e.g. `gcr-bot-yourhandle`).
2. Click **Create GitHub App**. You'll bounce to GitHub, confirm, and come
   back. The server exchanges the manifest code for the App credentials and
   persists them encrypted.
3. On the install screen, pick a **test repo** (don't pick "All
   repositories" yet).
4. You're back on `/repositories`.

## 4. Verify

```bash
pnpm smoke
```

All green = ready. Open a PR on the test repo, watch the worker logs:

```bash
docker compose -f docker/compose.yml logs -f worker
```

Within a few seconds you should see `webhook.received`, then phase
transitions `preparing → fetching → reviewing → posting → completed`, then
the review appears on the PR.

Mention `@gcr-bot-yourhandle please re-review` to trigger a fresh review.

## Troubleshooting

The dashboard's **/errors** page shows every failed or cancelled run with
the error class and message. Click a run to see the full transcript.

If the system isn't responding to `/health` at all:

```bash
# Last 200 lines from server + worker
docker compose -f docker/compose.yml logs --tail=200 server worker

# Inspect the queue and review runs without going through the UI
node scripts/gcr.mjs jobs
node scripts/gcr.mjs runs --state failed
```

Common first-run problems:

- **Webhook never arrives.** Check the GitHub App's settings →
  Advanced → Recent Deliveries. Most often: `PUBLIC_URL` doesn't match
  what GitHub thinks. Edit `.env`, restart compose.
- **Review queued but never runs.** Worker logs say
  `worker.boot.waiting_for_credentials`. Finish `/setup`. If logs say
  `claude` or `codex` isn't found, install the CLI inside the container or
  set the binary path in `.env`.
- **Reviewer says it isn't authenticated.** Re-run
  `docker compose ... exec worker claude auth login`.

## Production notes

- **TLS in front.** Compose binds to `127.0.0.1:3000`. Put Caddy, nginx, or
  Cloudflare Tunnel in front. Set `PUBLIC_URL=https://your-domain` in
  `.env` and restart.
- **Backups.** SQLite at `docker/data/data.sqlite`. `cp` it after stopping
  compose, or use `sqlite3 .backup`. There's no built-in replication —
  either run a periodic backup script or accept the loss window.
- **Pruning.** Old review runs accumulate. Visit `/setup/status` →
  Maintenance, or run `node scripts/gcr.mjs prune --days 30` on a cron.
