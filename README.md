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

## Tests

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
