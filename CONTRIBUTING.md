# Contributing

Thanks for considering a contribution. The bar for changes here is high — this
project is meant to be operable a decade from now without surprise — and we
want to be transparent about what that means in practice.

## Ground rules

1. **Keep packages within their boundaries.** The table in
   [`docs/architecture.md`](docs/architecture.md#package-boundaries) is
   enforced by ESLint in CI. If you find yourself wanting to break a rule,
   that's a discussion to have in an issue first.
2. **Adapters are interchangeable, domain logic is not.** Anything that touches
   the outside world (GitHub, Claude, Docker, SQLite, HTTP) lives in an
   adapter package behind a port defined in `@gcr/core`.
3. **Prefer boring.** "Recommended in 2026 by an active influencer" is not a
   reason to add a dependency. "Used by half the Node ecosystem since 2017"
   is.
4. **Every consequential decision gets an ADR.** New library, new architectural
   pattern, new external service: write the ADR before the PR is mergeable.

## Development setup

```bash
# Node 20 LTS (.nvmrc)
nvm use

# Install with pnpm (required — see ADR 0001)
corepack enable
pnpm install

# Verify
pnpm typecheck
pnpm test
pnpm lint
pnpm boundaries        # architectural boundary check
```

To run the stack locally see [`README.md`](README.md#quickstart-local).

## Commit style

Conventional Commits, enforced by `commitlint` via `lefthook`:

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`,
`build`, `ci`. Scope is the package or app name (e.g. `core`, `server`,
`reviewer/sandbox`). Subject is lowercase imperative ("add", not "added").

Examples:

```
feat(reviewer): add per-PR cost cap with daily rollup
fix(queue): release stale lock when worker dies mid-job
docs(adr): record decision to encrypt at-rest secrets with libsodium
```

## Pull request checklist

- [ ] All checks pass (`pnpm typecheck && pnpm test && pnpm lint && pnpm boundaries`)
- [ ] New behavior has a test (unit if pure, integration if it crosses a port)
- [ ] If the public surface of `@gcr/core` changed, types and JSDoc updated
- [ ] If a webhook payload shape is consumed, a real fixture is added under
      `tests/fixtures/webhooks/`
- [ ] If an external dependency was added, an ADR explains why and what was
      considered
- [ ] If a migration was added, it's numbered, forward-only, and runs in a
      single transaction
- [ ] CHANGELOG entry under `## [Unreleased]`

## Filing an ADR

ADRs (Architecture Decision Records) live in [`docs/adr/`](docs/adr/),
numbered and immutable once accepted. To add one:

1. Copy [`docs/adr/template.md`](docs/adr/template.md) to
   `docs/adr/NNNN-short-slug.md` where `NNNN` is the next number.
2. Fill it in. Describe the context, the decision, the alternatives that were
   rejected and *why*, and the consequences.
3. Open a PR labeled `adr`. The PR description should be the conversation; the
   merged ADR is the record.

If a future ADR supersedes an earlier one, do not edit the old one — add a
"Superseded by ADR-NNNN" line at the top.

## Reporting bugs

For security issues, follow [`SECURITY.md`](SECURITY.md) — do **not** open a
public issue. For everything else, open a GitHub issue with:

- What you expected
- What happened
- Steps to reproduce
- Output of `gcr version` (or git SHA + Node version)
- Relevant log lines (with secrets redacted)

## Code of conduct

By participating you agree to abide by the
[Contributor Covenant](CODE_OF_CONDUCT.md).
