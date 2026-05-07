# Install guide

End-to-end walkthrough for getting this running on a server, wired up to a
real GitHub App, posting reviews to a real repo. ~20 minutes if nothing
goes wrong.

## What you need before you start

1. **A Linux server with Docker.** Any of these works:
   - A VPS (DigitalOcean, Hetzner, Linode, Fly.io, AWS EC2 — $5–10/mo is plenty)
   - A box on your home network (a NUC, a Mac, a Raspberry Pi 4 or newer)
   - A cloud VM you already have

   Requirements: Docker Engine 24+ and Docker Compose v2. `git`. ~2 GB free
   RAM. ~5 GB free disk. Linux is best (the seccomp profile uses Linux
   syscall names); macOS works for testing.

2. **A way for GitHub to reach the server.** Pick one:
   - **Easiest for first test (no setup, no domain):** [smee.io](https://smee.io)
     — a public webhook proxy. Free. Perfect for verifying the bot works.
   - **Real production:** a domain name pointed at the server, port 443
     open, a TLS cert (Caddy or Cloudflare Tunnel get you HTTPS in two
     minutes — see "Production" at the bottom).

3. **A reviewer CLI subscription login for the worker.** The compose image
   includes both `claude` and `codex`. After the stack is up, run
   `docker compose -f docker/compose.yml exec worker claude auth login` for
   the default Claude Code provider. To use Codex instead, set
   `REVIEWER_PROVIDER=codex` and run `docker compose -f docker/compose.yml exec worker codex login`.

4. **A GitHub account that can install Apps** on a repo (your own personal
   account or an org you're an admin of). Pick a **test repo** — preferably
   not a production codebase for the first install.

## Step 1: Get the code onto the server

```bash
# SSH into the server first, then:
git clone <REPO_URL> github-code-reviewer
cd github-code-reviewer
```

(For now this is your local checkout. When you publish it, replace `<REPO_URL>`
with the public clone URL.)

## Step 2: Pick a webhook URL

### Option A — ngrok (cleanest local-dev experience)

ngrok exposes your `localhost:3000` as a public HTTPS URL with a built-in
request inspector at <http://localhost:4040> (every webhook delivery is
shown, with one-click replay). The free tier is enough.

`pnpm tunnel:ngrok` works two ways — it auto-detects which:

**A1. You run ngrok yourself on the host** (recommended if you have a
reserved free-tier domain — your URL stays stable across restarts):

```bash
# In one terminal, leave this running:
ngrok http 3000 --domain=<your-reserved-domain>.ngrok-free.app

# In another terminal:
docker compose -f docker/compose.yml up -d --build
pnpm tunnel:ngrok    # detects the host ngrok, patches PUBLIC_URL, restarts
```

**A2. Compose runs ngrok for you** (no host ngrok install):

```bash
# Get a free auth token at:
#   https://dashboard.ngrok.com/get-started/your-authtoken
# Add it to .env (pnpm init-env will prompt; or edit by hand):
#   NGROK_AUTHTOKEN=...your-token...
# Optional but strongly recommended (stable URL across restarts):
#   NGROK_DOMAIN=<your-reserved-domain>.ngrok-free.app
docker compose -f docker/compose.yml up -d --build
pnpm tunnel:ngrok
# When you're done:
pnpm tunnel:ngrok -- --down
```

The ngrok inspector at <http://localhost:4040> is gold — it shows every
webhook GitHub delivers, with the full payload, signature, and a "Replay"
button so you can re-trigger a delivery without opening another PR.

### Option B — smee.io (no install, but no inspector)

```bash
# In a *separate* terminal on the server, run smee:
docker run --rm -d --name smee --network host node:20-bookworm-slim \
  npx --yes smee-client \
    --url https://smee.io/CHANNEL_ID \
    --target http://localhost:3000/webhooks/github
```

First, visit <https://smee.io/new> in a browser, copy the channel URL
(looks like `https://smee.io/abc123xyz`), and paste it as `CHANNEL_ID`
above.

Set `PUBLIC_URL=https://smee.io/abc123xyz` in your `.env` (next step).

### Option C — your own HTTPS

If your server has a public domain (e.g. `gcr.example.com`) with TLS
already, set `PUBLIC_URL=https://gcr.example.com`. You'll terminate TLS
in front of the app — see the production section.

## Step 3: Generate `.env`

```bash
pnpm init-env
```

This prompts for `PUBLIC_URL` (the URL from step 2). It generates a fresh
`SECRETS_KEY` and `SESSION_SECRET` and writes `.env` mode 600.

For fully scripted installs (CI, Ansible, etc.):

```bash
pnpm init-env -- --non-interactive \
  --public-url=https://smee.io/abc123 \
  --reviewer-provider=claude
```

Re-running refuses to clobber an existing `.env` — pass `--force` to back up
the previous one to `.env.bak.<timestamp>` and write a fresh file.

## Step 4: Bring the stack up

```bash
docker compose -f docker/compose.yml up -d --build
docker compose -f docker/compose.yml logs -f server worker
```

Watch the logs. You should see:

```
{"level":"info", ..., "msg":"server.boot"}
{"level":"info", ..., "msg":"server.listening", "port":3000}
{"level":"warn", ..., "msg":"worker.boot.waiting_for_credentials …"}
```

The `waiting_for_credentials` message is **normal** — the worker is
correctly waiting for you to finish setup. Leave the logs streaming in
that terminal.

## Step 5: Run the GitHub App setup wizard

In a browser, open `http://<server-ip>:3000/setup` (or, if you SSH-tunneled,
`http://localhost:3000/setup`).

1. Type a name for your bot (suggested: `gcr-bot-<your-handle>`). The
   name must be unique across all of GitHub.
2. Click **Create GitHub App**. The page auto-submits to GitHub.
3. GitHub asks you to confirm. Click **Create GitHub App** again.
4. GitHub redirects back to your server with a `code`. The server
   exchanges it for the App credentials and persists them encrypted.
5. You land on the **install** page. Click **Install on GitHub**.
6. On GitHub's install screen, pick the test repo (don't pick "All
   repositories" yet — start small).
7. After clicking Install, you're back on `/repositories`. The repo
   should appear within a few seconds.

## Step 6: Authenticate the reviewer CLI

For the default Claude Code provider:

```bash
docker compose -f docker/compose.yml exec worker claude auth login
```

For Codex:

```bash
docker compose -f docker/compose.yml exec worker codex login
```

The login files persist under `docker/data` because the worker container uses
`/var/lib/gcr` as its home.

## Step 7: Smoke check

```bash
docker compose -f docker/compose.yml exec server pnpm smoke
```

Expected output, all green:

```
Smoke check: http://localhost:3000

  ok  /health
  ok  /ready

Configuration:
  ok   GitHub App           App #12345 (gcr-bot-yourname)
  ok   Tracked repositories 1 tracked.
  ok   Claude Code CLI      claude version ...
  warn Codex CLI            Optional provider not found.
  ok   Public URL           https://smee.io/abc123xyz

All systems go.
```

If any row is red or yellow, the message tells you what's missing.

## Step 8: Test it with a real PR

In your test repo, open a small PR. A README change is fine. Watch the
worker logs:

```bash
docker compose -f docker/compose.yml logs -f worker
```

What you should see:

1. Within a few seconds: a `webhook.received` audit entry, a `job.started`
   log line.
2. The state machine moves through `preparing → fetching → reviewing → posting → completed`.
3. The PR gets a review posted under the bot's identity, including any
   inline findings.

Then comment `@gcr-bot-yourname please re-review` on the PR. Within a few
seconds the bot reacts with 👀, then posts a fresh review.

## What to do if something goes wrong

**First, tell me:**

```bash
docker compose -f docker/compose.yml exec server pnpm smoke

# The last 200 lines of worker output:
docker compose -f docker/compose.yml logs --tail=200 worker

# What's in the queue:
docker compose -f docker/compose.yml exec server \
  sqlite3 /var/lib/gcr/data.sqlite \
  "SELECT id, name, state, attempts, last_error FROM jobs ORDER BY id DESC LIMIT 10"

# What review runs look like:
docker compose -f docker/compose.yml exec server \
  sqlite3 /var/lib/gcr/data.sqlite \
  "SELECT id, state, error_class, error_message FROM review_runs ORDER BY id DESC LIMIT 10"
```

Paste the output. The combination of those four tells me exactly where
in the lifecycle the failure was.

**Common first-run problems**, with what to try first — see
[`docs/operations.md`](docs/operations.md#common-failures-and-what-they-mean)
for the full list:

- **Webhook delivery never arrives.** Check smee logs (`docker logs smee`).
  GitHub will also show recent deliveries under the App's settings →
  Advanced → Recent Deliveries.
- **Review queued but never runs.** Worker logs will say
  `worker.boot.waiting_for_credentials` — finish setup. If they mention
  `claude` or `codex` not being found, install the CLI or set the matching
  binary path in `.env`.
- **Reviewer says it is not authenticated.** Run `claude auth login` or
  `codex login` as the same user that runs the worker, or set
  `CLAUDE_CODE_HOME` / `CODEX_HOME` to the already-authenticated home. With
  compose, the default homes are under `docker/data`.

## Production extras (after the first review works)

You probably don't need these for the first test. When you graduate from
"does it work" to "I trust it":

1. **TLS in front of the server.** Either a Caddy reverse proxy
   (one-line config), Cloudflare Tunnel (free, no port-forward), or your
   existing nginx. The server expects `PUBLIC_URL=https://...` in `.env`.

2. **Decide where reviewer auth lives.** With compose, auth lives on the
   mounted `docker/data` volume after you run `claude auth login` or
   `codex login` inside the worker container. If you run the worker directly
   on the VPS host instead, run it as the same Unix user that owns those CLI
   auth files, or explicitly set `CLAUDE_CODE_HOME` / `CODEX_HOME` to homes
   that the worker can read.

3. **Pin the legacy sandbox image by digest** if you re-enable the old
   Docker/API-key sandbox path. After the first build, get the
   digest with:
   ```bash
   docker inspect --format='{{.Id}}' gcr-sandbox:local
   ```
   Push it to your registry and set `SANDBOX_IMAGE=<registry>/gcr-sandbox@sha256:...`
   in `.env`. Compose's `sandbox-builder` step is fine for dev; production
   should use a pinned image you trust.

4. **Add an S3 replica to Litestream** (`docker/litestream.yml`). The
   default config replicates to `./backups` on the same disk — survives
   accidental DB corruption but not host loss.

5. **Restrict the UI to localhost.** Compose already binds the server to
   `127.0.0.1:3000`. If your reverse proxy can require basic auth in front
   of `/`, `/repositories`, `/settings`, etc. (everything except
   `/webhooks/github`), that's the simplest auth story until proper
   admin login lands.

## Sanity-check questions before you start

If any of these don't have an obvious answer, tell me and I'll adjust:

- What kind of server is it? (cloud VPS / home machine / Pi / Mac)
- Linux distro? (Ubuntu, Debian, NixOS, Arch …)
- Will GitHub be able to reach it directly, or do you need smee.io?
- Are you OK starting with smee.io for the first test, or do you want to
  set up TLS now?
- Test repo: public or private? (Both work; the App is repo-scoped either
  way.)
