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

Or, with `REVIEWER_PROVIDER=acp` and `ACP_AGENT=github-copilot`, log in to
the Copilot CLI (it speaks the Agent Client Protocol via `copilot --acp`):

```bash
docker compose -f docker/compose.yml exec worker copilot   # then: /login
```

Any other ACP agent works too — set `ACP_AGENT=custom` with
`ACP_AGENT_COMMAND` / `ACP_AGENT_ARGS`. Verify any agent end-to-end before
relying on it: `pnpm acp:selftest --agent "copilot --acp"`.

Auth files persist on the bind-mounted `docker/data` volume.

If you'd rather not log in inside the container, you can copy your host's
existing CLI auth into the volume:

```bash
pnpm import-credentials
```

Or call the script directly (no pnpm needed):

```bash
bash scripts/import-credentials.sh
docker compose -f docker/compose.yml restart worker
```

(macOS extracts the Claude Code Keychain entry; Linux copies
`~/.claude/.credentials.json` and `~/.codex/auth.json`.) The credentials
land in `docker/data/.claude/.credentials.json`, which the worker reads
via its bind-mounted `HOME`. This is host-local — on a remote server
without your host's Claude login, use the `exec worker claude auth login`
path instead.

## 3. Register the GitHub App

Open the URL `bootstrap` printed (default `http://localhost:3000/setup`).

1. Type a unique-on-GitHub bot name (e.g. `gcr-bot-yourhandle`).
   If the repositories are owned by an organization, choose **A GitHub
   organization** and enter the org slug so GitHub creates the App under that
   org instead of your personal account.
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

## Bootstrap with just docker compose (no pnpm)

If the host doesn't have pnpm/Node — typical for a remote server — skip
`pnpm bootstrap` and drive compose directly:

```bash
git clone <REPO_URL> github-code-reviewer
cd github-code-reviewer

# .env from the example, then fill in the two required secrets.
cp .env.example .env
chmod 600 .env
printf 'SECRETS_KEY=%s\n'    "$(openssl rand -hex 32)"    >> .env
printf 'SESSION_SECRET=%s\n' "$(openssl rand -base64 48)" >> .env
# Edit PUBLIC_URL in .env to the URL GitHub will hit.

docker compose -f docker/compose.yml up -d --build

# Wait for /health, then authenticate the reviewer CLI in the worker.
curl -fsS http://localhost:3000/health
docker compose -f docker/compose.yml exec worker claude auth login
```

That's the whole bootstrap. Open `${PUBLIC_URL}/setup` and finish the
GitHub App wizard as in step 3 above.

## Deploying to Dokploy

Dokploy can run this repo as a Docker Compose service. The image builds
in-place from `docker/Dockerfile.app`; nothing extra needs to be pushed
to a registry.

### 1. Create the application

In Dokploy → **New** → **Compose**:

- **Source**: Git, your fork's repo URL, branch `main`.
- **Compose file**: `docker/compose.dokploy.yml` (this variant bind-mounts
  the host's `claude` / `codex` credentials into the worker — see step 5).
- **Build context**: leave as repo root (the compose file already sets
  `context: ..`).

### 2. Environment variables

Dokploy writes the variables you configure into a `.env` at the repo
root, which the compose file picks up via `env_file: ../.env`. Paste
these and fill in the values:

```
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://reviewer.your-domain.example
DATABASE_PATH=/var/lib/gcr/data.sqlite
SECRETS_KEY=<openssl rand -hex 32>
SESSION_SECRET=<openssl rand -base64 48>
REVIEWER_PROVIDER=claude
REVIEWER_TIMEOUT_MS=1200000
CLAUDE_CODE_BINARY=claude
CLAUDE_CODE_MODEL=claude-sonnet-4-5
LOG_LEVEL=info
TRUSTED_PROXY_IPS=loopback
```

Generate the two secrets once on any machine with openssl:

```bash
openssl rand -hex 32        # SECRETS_KEY
openssl rand -base64 48     # SESSION_SECRET
```

Treat them like passwords — `SECRETS_KEY` decrypts everything in the
SQLite store. Rotating it orphans every saved credential.

### 3. Storage

The compose file bind-mounts `./data:/var/lib/gcr` (resolved relative to
`docker/compose.yml`, i.e. `docker/data`). Dokploy keeps the project
working directory between deploys, so SQLite and the reviewer auth
files persist by default. If you want a named volume managed by Dokploy
instead, change the worker + server `volumes:` to:

```yaml
volumes:
  - gcr_data:/var/lib/gcr
```

and add a top-level `volumes: { gcr_data: {} }`.

### 4. Routing

The compose file binds `127.0.0.1:3000` on the host. In Dokploy, attach
a domain to the `server` service on port `3000` and let Traefik (Dokploy's
proxy) terminate TLS. Set `PUBLIC_URL` to the resulting HTTPS URL so
GitHub webhooks reach the right place.

If Traefik runs on the same host, also set `TRUSTED_PROXY_IPS` to the
Docker bridge subnet (e.g. `172.16.0.0/12`) so the server trusts
`X-Forwarded-For` from the proxy.

### 5. Auto-import reviewer credentials from the host

If you've already run `claude login` (and/or `codex login`) on the
Dokploy host itself, the worker picks those credentials up on first
boot automatically — no shell session into the container required.

`docker/compose.dokploy.yml` declares two read-only bind mounts on the
worker service:

```yaml
- ${HOST_CLAUDE_PATH:-/root/.claude}:/host-claude:ro
- ${HOST_CODEX_PATH:-/root/.codex}:/host-codex:ro
```

The defaults match Dokploy's typical root install. If your host stores
the CLI credentials under a different user, set `HOST_CLAUDE_PATH` /
`HOST_CODEX_PATH` in Dokploy's env (e.g. `/home/dokploy/.claude`).

On boot the worker copies `.credentials.json` / `auth.json` from those
mounts into its own `HOME` on the persistent volume — but only if the
destination file is missing. After the first successful copy the worker
owns the file and refreshes tokens in-place, so the host's credentials
never get overwritten. Watch the logs for
`worker.boot.credentials_seeded_from_host` to confirm.

### 6. Deploy

Click **Deploy**. Once the `server` healthcheck is green, visit
`${PUBLIC_URL}/setup` and finish the GitHub App wizard.

If you skipped step 5 (or the seed didn't find a source file), you'll
need to log in inside the container instead:

```bash
docker compose -f docker/compose.yml exec worker claude auth login
```

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
