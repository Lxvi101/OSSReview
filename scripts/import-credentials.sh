#!/usr/bin/env bash
#
# import-credentials.sh — copy your host's Claude Code + Codex CLI
# credentials into the worker's HOME (the bind-mounted ./docker/data dir),
# so you don't have to re-login inside the worker container.
#
# What it does, by platform:
#   - macOS: extracts the Claude Code OAuth blob from the Keychain
#     (service: "Claude Code-credentials") and writes it to
#     `./docker/data/.claude/.credentials.json` (the file path Claude
#     Code on Linux uses).
#   - Linux: copies `~/.claude/.credentials.json` if present.
#   - Both: copies `~/.codex/auth.json` and `~/.codex/config.toml` if
#     present.
#
# After running, restart the worker:
#   docker compose -f docker/compose.yml restart worker
#
# Note: the Keychain extraction may prompt you to grant access. Click
# "Always Allow" if you want this script to run unattended in the future.

set -euo pipefail

DATA_DIR="docker/data"
CLAUDE_DIR="$DATA_DIR/.claude"
CODEX_DIR="$DATA_DIR/.codex"

ok() { printf "  \033[32mok\033[0m   %s\n" "$1"; }
warn() { printf "  \033[33mskip\033[0m %s\n" "$1"; }
fail() { printf "  \033[31mfail\033[0m %s\n" "$1"; }

if [ ! -d "$DATA_DIR" ]; then
  printf "%s does not exist — run 'docker compose -f docker/compose.yml up -d' first.\n" "$DATA_DIR" >&2
  exit 1
fi

mkdir -p "$CLAUDE_DIR" "$CODEX_DIR"

printf "\nImporting credentials → %s\n\n" "$DATA_DIR"

# ── Claude ─────────────────────────────────────────────────────────────────
case "$(uname)" in
  Darwin)
    user="$(whoami)"
    # `security find-generic-password -w` writes ONLY the password to stdout
    # on success. We pipe directly to file mode 600 so the secret never
    # touches an unprotected location.
    if creds="$(security find-generic-password -s 'Claude Code-credentials' -a "$user" -w 2>/dev/null)"; then
      umask 077
      printf "%s" "$creds" > "$CLAUDE_DIR/.credentials.json"
      ok "Claude — extracted from macOS Keychain → $CLAUDE_DIR/.credentials.json"
    else
      warn "Claude — no Keychain entry for service 'Claude Code-credentials' account '$user'"
      warn "         (run \`claude login\` on the host, then re-run this script)"
    fi
    ;;
  Linux)
    if [ -f "$HOME/.claude/.credentials.json" ]; then
      cp "$HOME/.claude/.credentials.json" "$CLAUDE_DIR/.credentials.json"
      chmod 600 "$CLAUDE_DIR/.credentials.json"
      ok "Claude — copied $HOME/.claude/.credentials.json"
    else
      warn "Claude — $HOME/.claude/.credentials.json not found (run \`claude login\` on the host first)"
    fi
    ;;
  *)
    warn "Claude — unsupported host OS for credentials import: $(uname)"
    ;;
esac

# Copy non-secret claude state too (settings.json, etc.) so behavior matches
# the host. Skip the obviously-large stuff.
if [ -f "$HOME/.claude/settings.json" ]; then
  cp "$HOME/.claude/settings.json" "$CLAUDE_DIR/settings.json"
  ok "Claude — copied settings.json"
fi

# ── Codex ──────────────────────────────────────────────────────────────────
if [ -f "$HOME/.codex/auth.json" ]; then
  cp "$HOME/.codex/auth.json" "$CODEX_DIR/auth.json"
  chmod 600 "$CODEX_DIR/auth.json"
  ok "Codex  — copied $HOME/.codex/auth.json"
else
  warn "Codex  — $HOME/.codex/auth.json not found (run \`codex login\` on the host first)"
fi

if [ -f "$HOME/.codex/config.toml" ]; then
  cp "$HOME/.codex/config.toml" "$CODEX_DIR/config.toml"
  chmod 600 "$CODEX_DIR/config.toml"
  ok "Codex  — copied config.toml"
fi

cat <<EOF

Done. Restart the worker to pick up the credentials:

  docker compose -f docker/compose.yml restart worker

EOF
