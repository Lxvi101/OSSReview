# Webhook fixtures

Real, anonymized GitHub webhook payloads for replay.

Each `<event>.<action>.json` is the body GitHub would POST to
`/webhooks/github`. The accompanying `<event>.<action>.headers.json`
contains:

```json
{
  "x-github-event": "pull_request",
  "x-github-delivery": "00000000-0000-4000-8000-000000000000",
  "x-hub-signature-256": "sha256=<computed-with-test-secret>",
  "content-type": "application/json"
}
```

Use the test helper `tests/integration/util/replay.ts` to POST one against
a running stack — it computes a fresh HMAC over the body using the
configured test secret so the signature is always valid.

## Adding a new fixture

1. Capture a real payload from the GitHub UI ("Recent Deliveries").
2. Anonymize: replace user logins, repository owners, IDs, emails with
   stable placeholders. Keep `installation.id` and `repository.id` as
   `12345` / `67890` consistently.
3. Save as `<event>.<action>.json`.
4. Re-run `pnpm test --filter integration` — the replay helper computes
   the matching signature; you don't need to update the headers file.
