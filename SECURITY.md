# Security policy

## Reporting a vulnerability

**Do not open a public issue.**

Please use one of the following private channels:

1. **GitHub Security Advisories** (preferred): use the *Report a vulnerability*
   button under the Security tab of this repository. This creates a private
   discussion only the maintainers can see.
2. **Email**: `security@example.com` (replace with your address before
   publishing). PGP key fingerprint listed at the bottom of this file.

Please include:

- A description of the issue
- The specific commit or release version
- A minimal reproduction (if possible)
- Whether you intend to disclose publicly, and if so, your timeline

## Response targets

- Acknowledgement within **3 business days**
- Initial assessment within **7 business days**
- Coordinated disclosure window of **90 days** by default; we will negotiate
  if more time is needed for users to upgrade

## Scope

In scope:

- Sandbox escape from the per-review Docker container
- Authentication bypass on the admin UI
- Secret leakage (logs, audit, error messages, UI rendering)
- Webhook signature bypass
- Prompt-injection chains that cause unintended actions on GitHub
- SQL injection, XSS, CSRF, path traversal, command injection

Out of scope:

- Denial-of-service against your own self-hosted instance
- Issues requiring physical access to the host machine
- Issues in third-party services (Anthropic, GitHub) — please report to them
- Vulnerabilities in dependencies are accepted via Dependabot/Renovate; only
  report directly if there is no public CVE yet

## Hardening defaults

The deployed configuration is hardened by default:

- Sandbox containers run with `--read-only`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, a custom seccomp profile, non-root user,
  pid/memory/cpu limits, and an egress-firewalled bridge network.
- The clone happens outside the sandbox; the GitHub installation token never
  enters it.
- Anthropic API key is mounted via tmpfs at `/etc/secrets/`, exported to the
  agent's process env by the entrypoint, then unlinked before exec.
- pino redacts known sensitive header/payload paths; a post-serialization
  regex pass strips known token shapes (`sk-ant-*`, `ghs_*`, `ghp_*`, JWTs).
- At-rest secrets in SQLite are encrypted with libsodium `secretbox` keyed
  from `SECRETS_KEY`.
- Webhook bodies are HMAC-verified with constant-time compare before any DB
  write happens.

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## PGP key

```
(replace with your public key fingerprint and ASCII-armored key here before
publishing — leaving as a placeholder so deployments can configure their own)
```
