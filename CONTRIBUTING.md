# Contributing

## Setup

```bash
pnpm install
pnpm build
```

## Workflow

- Lint + format with Biome: `pnpm lint:fix`
- Typecheck: `pnpm typecheck`

## Repo layout

`apps/*` are composition roots. `packages/core` is pure (no I/O, no
network); `packages/storage`, `packages/github`, `packages/reviewer`,
`packages/queue` are the adapters. `packages/observability` and
`packages/config` are utilities anyone can import.

## Style

- TypeScript strict mode, `exactOptionalPropertyTypes`.
- No emoji in source. No multi-paragraph docstrings.
- Branded ID types in `core/src/ids.ts` — use them; don't pass raw `number`.
- New tables: add a numbered SQL migration in
  `packages/storage/src/migrations/sql/` and update `packages/storage/src/schema.ts`.
- New ports: define on `packages/core/src/ports/`, implement in the
  adapter package. Don't import the adapter from core.
