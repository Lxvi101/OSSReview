#!/usr/bin/env bash
#
# bootstrap.sh — one-command bring-up.
#
# Steps:
#   1. Generate .env if missing (interactive prompts).
#   2. docker compose up -d --build.
#   3. Wait for /health.
#   4. Print the next-step URL.
#
# Re-runnable: skips steps that are already done.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

G() { printf "\033[32m%s\033[0m" "$1"; }
Y() { printf "\033[33m%s\033[0m" "$1"; }
R() { printf "\033[31m%s\033[0m" "$1"; }
B() { printf "\033[1m%s\033[0m" "$1"; }

step() { printf "\n%s %s\n" "$(B "▸")" "$(B "$1")"; }

step "1/4: .env"
if [ -f .env ]; then
  printf "    %s .env exists; reusing.\n" "$(G ok)"
else
  bash scripts/init-env.sh
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
PUBLIC_URL="${PUBLIC_URL:-http://localhost:3000}"

step "2/4: docker compose up"
docker compose -f docker/compose.yml up -d --build

step "3/4: waiting for /health"
HEALTH_URL="http://localhost:${PORT:-3000}/health"
for i in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    printf "    %s server reachable at %s\n" "$(G ok)" "$HEALTH_URL"
    break
  fi
  printf "    %s waiting (%ds)…\r" "$(Y …)" "$i"
  sleep 1
done

if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  printf "\n    %s server didn't come up. Logs:\n" "$(R fail)"
  docker compose -f docker/compose.yml logs --tail=40 server worker
  exit 1
fi

step "4/4: next steps"
cat <<EOF

  $(G ✓) Stack is up.

  $(B "1.")  Authenticate the reviewer CLI (one-time):
       docker compose -f docker/compose.yml exec worker claude auth login

  $(B "2.")  Register the GitHub App:
       open ${PUBLIC_URL}/setup

  $(B "3.")  Verify everything:
       open ${PUBLIC_URL}/setup/status

  Operator CLI: $(B "node scripts/gcr.mjs --help")

EOF
