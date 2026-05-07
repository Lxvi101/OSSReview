#!/usr/bin/env bash
#
# tunnel-ngrok.sh — bring up an ngrok tunnel for local debugging and wire
# the public URL into the running stack.
#
# Strategy (in order):
#   1. If an ngrok session is already running on this host (port 4040 reachable),
#      use that one. This is the path you'll hit when you run
#        ngrok http 3000 --domain=<your-reserved-domain>
#      yourself in another terminal.
#   2. Otherwise, fall back to the compose-managed `ngrok` service. Requires
#      NGROK_AUTHTOKEN in .env (and optionally NGROK_DOMAIN for a stable URL).
#
# In either case, the script:
#   - Reads the public URL from the local ngrok API at 127.0.0.1:4040
#   - Patches PUBLIC_URL in .env to that URL (backing up the old one)
#   - Restarts server + worker so they pick up the new env
#
# Usage:
#   ./scripts/tunnel-ngrok.sh                 # auto-detect or start
#   ./scripts/tunnel-ngrok.sh --down          # stop the compose tunnel
#                                             # (does nothing for a host ngrok)

set -euo pipefail

ENV_FILE=".env"
COMPOSE="docker compose -f docker/compose.yml"
NGROK_API="http://127.0.0.1:4040/api/tunnels"
ACTION="up"

for arg in "$@"; do
  case "$arg" in
    --down) ACTION="down" ;;
    -h|--help)
      sed -n '3,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)  printf "unknown flag: %s\n" "$arg" >&2; exit 64 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────

# Pull the first https public_url out of an /api/tunnels JSON body. Returns
# "" if not found. `|| true` guards against pipefail when grep finds nothing.
extract_public_url() {
  local body="$1"
  printf "%s" "$body" \
    | grep -oE '"public_url":"https://[^"]+"' 2>/dev/null \
    | head -1 \
    | sed 's/.*"public_url":"\([^"]*\)".*/\1/' \
    || true
}

# Read the URL from a running ngrok session (any source). Returns "" on miss.
read_existing_url() {
  local resp
  resp="$(curl -fsS "$NGROK_API" 2>/dev/null || true)"
  if [ -z "$resp" ]; then printf ""; return; fi
  extract_public_url "$resp"
}

# Patch PUBLIC_URL in .env (idempotent), back up the old one, restart server+worker.
update_env_and_restart() {
  local new_url="$1"

  local current
  current="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ "$current" = "$new_url" ]; then
    printf ".env already has PUBLIC_URL=%s — nothing to do.\n" "$new_url" >&2
    return 0
  fi

  local ts backup
  ts="$(date +%Y%m%d-%H%M%S)"
  backup=".env.bak.$ts"
  cp "$ENV_FILE" "$backup"
  printf "backed up .env → %s\n" "$backup" >&2

  local tmp
  tmp="$(mktemp)"
  awk -v url="$new_url" '
    /^PUBLIC_URL=/ { print "PUBLIC_URL=" url; next }
    { print }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf "updated .env: PUBLIC_URL=%s\n" "$new_url" >&2

  printf "restarting server + worker so they pick up the new PUBLIC_URL…\n" >&2
  $COMPOSE up -d --no-deps server worker
}

print_done() {
  local url="$1"
  cat >&2 <<EOF

  Tunnel is live: $url

  Webhook URL (give this to GitHub):
    $url/webhooks/github

  Setup wizard:
    $url/setup    (or http://localhost:3000/setup)

  ngrok inspector (every webhook delivery, with replay):
    http://localhost:4040

EOF
}

# ── --down: stop the compose tunnel and exit ────────────────────────────────
if [ "$ACTION" = "down" ]; then
  printf "stopping compose ngrok service (host ngrok is unaffected)…\n" >&2
  $COMPOSE --profile ngrok stop ngrok || true
  $COMPOSE --profile ngrok rm -f ngrok || true
  printf "done.\n" >&2
  exit 0
fi

# ── Sanity checks ────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  printf "no .env in cwd. Run \`pnpm init-env\` first.\n" >&2
  exit 1
fi

# ── Path 1: ngrok is already running (host or otherwise) ─────────────────────
EXISTING_URL="$(read_existing_url)"
if [ -n "$EXISTING_URL" ]; then
  printf "found existing ngrok session at %s — using it.\n" "$EXISTING_URL" >&2
  printf "(if you want to switch to the compose-managed tunnel, stop the host one first.)\n" >&2
  update_env_and_restart "$EXISTING_URL"
  print_done "$EXISTING_URL"
  exit 0
fi

# ── Path 2: spin up the compose-managed tunnel ───────────────────────────────
if ! grep -qE '^NGROK_AUTHTOKEN=.+' "$ENV_FILE"; then
  cat >&2 <<EOF

  No existing ngrok session found, and NGROK_AUTHTOKEN is not set in .env.

  Option A — point the script at your own ngrok (recommended if you have a
  reserved free-tier domain):

      ngrok http 3000 --domain=<your-reserved-domain>
      pnpm tunnel:ngrok    # picks up the host session automatically

  Option B — let compose run ngrok for you. Get a free auth token at
    https://dashboard.ngrok.com/get-started/your-authtoken
  then add this line to .env:
    NGROK_AUTHTOKEN=<your-token>
  (optional, for a stable URL across restarts)
    NGROK_DOMAIN=<your-reserved-domain>
  and re-run this script.

EOF
  exit 1
fi

# Parent stack must already be up — server has to be healthy before ngrok
# can target it.
if ! $COMPOSE ps server --format json 2>/dev/null | grep -q '"State":"running"'; then
  printf "server isn't running. Bringing the stack up first…\n" >&2
  $COMPOSE up -d --build
  printf "waiting for server to be healthy…\n" >&2
fi

printf "starting compose ngrok service…\n" >&2
$COMPOSE --profile ngrok up -d ngrok

# Poll the API. ngrok takes ~1–3 seconds to come up.
PUBLIC_URL=""
LAST_RESP=""
for _ in $(seq 1 30); do
  LAST_RESP="$(curl -fsS "$NGROK_API" 2>/dev/null || true)"
  if [ -n "$LAST_RESP" ]; then
    PUBLIC_URL="$(extract_public_url "$LAST_RESP")"
    if [ -n "$PUBLIC_URL" ]; then break; fi
  fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  printf "\n  Couldn't read a public URL from compose ngrok after 30s.\n\n" >&2
  printf "  Last response from %s:\n" "$NGROK_API" >&2
  printf "    %s\n\n" "${LAST_RESP:-<no response — port 4040 unreachable>}" >&2
  printf "  ngrok container logs (last 30 lines):\n" >&2
  $COMPOSE --profile ngrok logs --tail=30 ngrok 2>&1 | sed 's/^/    /' >&2 || true
  printf "\n  Most common causes:\n" >&2
  printf "    - NGROK_AUTHTOKEN is invalid or expired (regenerate at https://dashboard.ngrok.com)\n" >&2
  printf "    - free-tier session limit hit (one tunnel per account; close other ngrok sessions)\n" >&2
  printf "    - the token wasn't passed through (rebuild .env with %s)\n" "pnpm init-env -- --force" >&2
  printf "\n" >&2
  exit 1
fi

printf "compose ngrok is up at: %s\n" "$PUBLIC_URL" >&2
update_env_and_restart "$PUBLIC_URL"
print_done "$PUBLIC_URL"
