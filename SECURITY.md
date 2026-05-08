# Security

## Reporting a vulnerability

Open a private security advisory on the GitHub repo, or email the
maintainer. Don't open a public issue.

## What this app trusts

- **The host running `docker compose`.** All credentials (GitHub App
  private key, webhook secret, session cookie key, the 32-byte
  `SECRETS_KEY` that decrypts at-rest secrets) live on this host.
- **The reviewer CLI's home directory.** Whoever can read
  `docker/data/.claude` or `docker/data/.codex` can use your Claude
  Code / Codex subscription. Treat them like any other credential.

## What we do to limit blast radius

- **HMAC verification on every webhook**, before any DB write.
  Bad-signature requests cost a hash and never persist.
- **Per-installation tokens** are short-lived and minted fresh per logical
  operation. Octokit caches them in-process only.
- **`.git/` is removed** from the cloned workspace before the reviewer
  runs. The reviewer cannot read `.git/config` and recover the token.
- **The reviewer has no write capability.** The Claude Code adapter
  registers only `Read`/`Glob`/`Grep`/`LS` plus the `submit_findings` tool;
  `Edit`/`Write`/`Bash`/`WebFetch`/`WebSearch` are explicitly disallowed.
- **Secrets at rest are encrypted** with libsodium `crypto_secretbox_easy`
  (XSalsa20-Poly1305). The DB itself is not encrypted; the high-value
  fields inside it (App private key, webhook secret) are.
- **Logs run through two redactors**: pino's structured `redact` for known
  paths, plus a second regex pass over the serialized line for token shapes
  that escape into prose (Anthropic keys, GitHub PATs, JWTs, the
  `SECRETS_KEY` shape).

## Supported versions

`main` only. There are no LTS branches; if you operate this, track `main`.
