# ADR 0006: Reviewer is a port; Claude Code is the first adapter

- Status: Accepted
- Date: 2026-05-03

## Context

The product is "self-hosted CodeRabbit-like bot". The interesting feature
is "uses Claude Code". But the *durable* product surface is "PR review bot
that posts findings". Today the reviewer is Claude. Tomorrow it might be:

- A different Anthropic model.
- A wrapper around Semgrep / CodeQL / a custom linter.
- A local-only model for shops that can't ship code to a third party.
- A composition: Claude for prose, Semgrep for security.

If we wire Claude into the orchestration spine, we'll regret it the first
time someone asks for any of the above.

## Decision

A small, stable `Reviewer` interface in `packages/reviewer/src/port.ts`.
Implementations include `ClaudeReviewer` (Claude Code SDK), `CodexReviewer`
(Codex CLI), `ProviderRouterReviewer` (runtime selection), `FakeReviewer`
(tests), and the legacy `SandboxRunner`.

The reviewer is given a workspace directory, a diff, and PR metadata. It
returns a `ReviewResult` (summary + findings + meta). It is **not** given
a GitHub token. It cannot post to GitHub. The `apps/worker` orchestration
takes the result and posts it. A compromised reviewer cannot leak credentials
it never had.

## Alternatives considered

- **Couple to the Claude SDK directly.** Faster initial implementation,
  irreversible architectural commitment.
- **Plugin system / hot-loadable reviewers.** Premature; we have one reviewer.
  When we have three, the API will tell us what shape the plugin system
  should be. Building it now means guessing.
- **Reviewer-posts-back model.** Some bots let the reviewer call GitHub
  directly. We rejected this because it conflates the security-sensitive
  GitHub credential with the (less trusted) review process.

## Consequences

- Tests substitute `FakeReviewer` to assert end-to-end orchestration without
  spending API budget.
- Local provider runners and the legacy sandbox are `Reviewer`s themselves —
  they implement the same interface and are selected at composition time.
- New reviewer types are: implement the interface, add to the composition root.

## Reversal cost

High to undo (would re-couple the spine to a specific reviewer). Low to add
new reviewers under it.
