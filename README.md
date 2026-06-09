# driveline

Browser-first multimodal log viewer for synchronised 4K video and
high-rate signal data. See [`docs/`](./docs) for the full design.

## Prerequisites

- Rust (stable) with the `wasm32-unknown-unknown` target installed
- Node.js 22+ and pnpm 10+
- `wasm-pack` (`cargo install wasm-pack`)

## Quickstart

```sh
pnpm install
pnpm wasm:build         # REQUIRED before pnpm dev on a fresh checkout
pnpm dev                # http://localhost:5173
```

## Deploy

Driveline is a fully static, client-side SPA, so it deploys to any static
host. CI publishes it to **Cloudflare Pages** via
[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml): pushes to
`main` ship a production deploy; a manual **Run workflow** (workflow_dispatch)
from any branch ships a preview deploy.

One-time setup — add two repo secrets under **Settings → Secrets and
variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — a token with the **Cloudflare Pages: Edit**
  permission ([create one here](https://dash.cloudflare.com/profile/api-tokens)).
- `CLOUDFLARE_ACCOUNT_ID` — your account id (Cloudflare dashboard → any
  domain → right sidebar, or the URL after `dash.cloudflare.com/`).

The workflow creates the `driveline` Pages project automatically on first run.
No COOP/COEP headers are needed (see
[`docs/07-build-and-tooling.md`](./docs/07-build-and-tooling.md)); the only
production requirement is HTTPS, which Pages provides.

## Tests

To run the full test suite locally — including the Playwright e2e — first
make sure ffmpeg, the WASM bundle, the Python fixture toolchain, the
generated MCAP/MP4 fixtures, and Playwright's chromium are all in place.
[`scripts/setup-test-env.sh`](./scripts/setup-test-env.sh) installs every
prerequisite (idempotent, safe to re-run):

```sh
scripts/setup-test-env.sh
```

Then:

```sh
cargo test --workspace        # Rust unit + contract tests
pnpm --filter web test        # JS unit + Arrow contract test
pnpm --filter e2e test        # Playwright e2e (pings the workers)
```

## Layout

- `apps/web/` — Vite + React + TS app
- `apps/e2e/` — Playwright end-to-end tests
- `crates/data-core/` — portable Rust core: `Reader` trait, Arrow IPC producers
- `crates/wasm-bindings/` — `wasm-bindgen` shim that targets `wasm32-unknown-unknown`
- `test-fixtures/` — committed binary fixtures shared between Rust and JS
- `docs/` — design docs (vision, architecture, data model, tasks)

## License

Driveline is licensed under the [Mozilla Public License 2.0](./LICENSE)
(MPL-2.0). MPL-2.0 is a file-level weak copyleft: modifications to existing
MPL-covered files must be shared back under the same license, but the code
can be combined with proprietary modules — so the open core stays open while
leaving room to build on top of it.

Dependency licenses are enforced in CI. Every dependency must resolve to a
permissive or MPL-compatible license; anything else (GPL/AGPL, ethical-source,
or other non-OSI terms) fails the build:

- **Rust** — [`cargo deny check licenses`](./deny.toml)
  (`pnpm license:check:rust`)
- **JS** — [`scripts/check-js-licenses.mjs`](./scripts/check-js-licenses.mjs)
  (`pnpm license:check:js`)

If you add a dependency under a new license, add its SPDX id to the allow
list in **both** gates. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
per-file header convention.

