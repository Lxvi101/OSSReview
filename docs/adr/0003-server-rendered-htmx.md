# ADR 0003: Server-rendered HTML with Eta + HTMX + Alpine.js

- Status: Accepted
- Date: 2026-05-03

## Context

The UI is small: a setup wizard, a repo list, a review list, a review-detail
page that polls while in-flight, an audit log. One operator, no heavy
interactivity. Decision: how to render it.

The constraint that overrides everything else is **the UI must remain
operable in 2036**. SPA frameworks have a five-year half-life — Backbone,
Angular 1, React + Redux + Saga + Apollo, etc. — and migrating tens of
thousands of LOC across them is what eats engineering org-years at companies
that picked the new shiny in 2018.

## Decision

**Server-rendered HTML** via Eta templates, with **HTMX** for partial
updates and **Alpine.js** for the rare client-side interactive bit. CSS is
hand-rolled (small) for M1; **Tailwind via the CLI** is the M4 polish. **No
JS bundler**, **no SPA**.

## Alternatives considered

- **React + Next.js / Remix** — the ecosystem is excellent today. The HTML
  it produces today won't render in 2036 without a migration.
- **SvelteKit** — same critique, smaller community.
- **Vue / Nuxt** — same critique, has now had three incompatible major
  versions in five years.
- **Pure server-rendered HTML, no JS at all** — works, but the
  poll-while-in-progress experience on the review-detail page benefits
  meaningfully from HTMX's partial-swap. We accept one tiny script.
- **HTMX + Hyperscript** — Alpine.js's Vue-like API is more familiar to the
  next contributor than Hyperscript's idiosyncratic syntax.

## Consequences

- The UI ships as: `.eta` templates, one CSS file, two JS files (htmx + alpine,
  pinned).
- New pages are: write a template, register a route, return rendered HTML.
- We forgo the productivity boost of a typed router/component story for
  larger apps. Revisit when the UI grows past ~30 pages.
- We do not invest in Storybook / component libraries — we'd rather invest
  the same time in tests against the rendered HTML.

## Reversal cost

Medium-low. The HTML produced today will keep rendering. The day someone
wants a real SPA dashboard, they can build it against the existing JSON API
endpoints (not yet exposed but planned for M3) without touching the
server-rendered pages.
