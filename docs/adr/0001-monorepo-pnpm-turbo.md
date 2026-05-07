# ADR 0001: Monorepo with pnpm workspaces and Turborepo

- Status: Accepted
- Date: 2026-05-03

## Context

We have ~10 packages plus 2 apps that share types and want to ship together.
Three structural options:

1. Many repos with published packages.
2. One repo, no orchestrator, scripts.
3. One repo with a workspace-aware tool.

The first multiplies CI cost and version-skew bugs. The second underestimates
the second-by-second pain of remembering which package to rebuild before
running which test.

## Decision

A single repository using **pnpm workspaces** for installation and **Turborepo**
for task orchestration.

`packages/*` and `apps/*` are workspace packages. `pnpm` symlinks them into
each other's `node_modules`. Turborepo handles build/test caching with
`dependsOn: ["^build"]` so adapters can depend on `core` and the right thing
gets rebuilt automatically.

## Alternatives considered

- **npm workspaces** — adequate, but pnpm is faster, has stricter peer-dep
  resolution, and uses ~1/4 the disk. Lockfile churn under npm 7+ has bitten
  every Node project I've worked on.
- **Yarn (Berry, PnP)** — splits its own Node ecosystem. Many tools still
  trip over PnP resolution.
- **Bazel / Nx** — Bazel is the only one that produces truly hermetic builds,
  but the cost-of-entry curve is brutal for a project this size. Nx is
  reasonable but layers a config DSL we don't need.
- **Lerna** — feature-frozen as of late 2022.

## Consequences

- Cheap cross-package refactors. Adding a new field to a `core` type and
  using it in two adapters is one PR, one commit.
- New contributors need `corepack enable && pnpm install` — easy.
- We pin `packageManager` in the root `package.json` and check it in CI.
- Turborepo has a hosted remote-cache option we deliberately do **not** use —
  it would add a SaaS dep. Local cache only.

## Reversal cost

Low for tooling (swap pnpm → npm), medium for monorepo → polyrepo (CI rewrite,
publishing pipeline, cross-repo dep coordination).
