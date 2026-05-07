# Static assets

Files committed here:

- `app.css` — hand-rolled, ~3kB, no preprocessor. Edit directly.

Files **not** committed (generated at build time):

- `htmx.min.js` — copied from `node_modules/htmx.org/dist/` by `scripts/copy-vendor.mjs` during `pnpm build`.
- `alpine.min.js` — copied from `node_modules/alpinejs/dist/cdn.min.js`.

Versions are pinned in `package.json` (`htmx.org` and `alpinejs`), so
`pnpm install` gives reproducible vendor builds.

For air-gapped environments or when you'd rather not install the npm
packages, run `pnpm fetch-vendor` at the repo root — it downloads the
same versions from unpkg with SRI verification.
