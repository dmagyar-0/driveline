# Chapter 11 — Run, Test, Ship

The first ten chapters covered *what* Driveline is and *how it's
wired*. This last chapter covers *how you work on it*: the tools you
run, the tests at each layer, and what falls out of a production
build.

## Prerequisites

Three toolchains, all pinned:

- **Rust** — pinned by `rust-toolchain.toml` at the repo root. Running
  any `cargo` command with `rustup` installed will auto-download the
  matching `rustc`.
- **Node.js** — recent LTS (20+).
- **pnpm** — pinned in `package.json` under `packageManager`.
- **`wasm-pack`** — command-line wrapper around `wasm-bindgen`. Install
  once: `curl https://rustwasm.github.io/wasm-pack/installer/init.sh | sh`.

## The scripts, end to end

The root `package.json` is short enough to reprint in full:

```json
{
  "scripts": {
    "wasm:build":     "wasm-pack build crates/wasm-bindings --target web --out-dir ../../apps/web/src/wasm --out-name wasm_bindings",
    "wasm:build:dev": "wasm-pack build crates/wasm-bindings --target web --out-dir ../../apps/web/src/wasm --out-name wasm_bindings --dev",
    "dev":            "pnpm --filter web dev",
    "build":          "pnpm wasm:build && pnpm --filter web build",
    "test":           "pnpm --filter web test --run && cargo test --workspace",
    "test:web":       "pnpm --filter web test --run",
    "test:rust":      "cargo test --workspace",
    "e2e":            "pnpm --filter e2e test",
    "fmt":            "cargo fmt --all && pnpm --filter web fmt"
  }
}
```

### First-time setup

```bash
pnpm install         # JS deps for all workspaces
pnpm wasm:build      # build wasm once so apps/web can import it
pnpm dev             # start Vite on http://localhost:5173
```

Drop any file from `sample-data/` (once generated; see below) onto the
browser window and Driveline opens it.

### The build graph

```
     ┌──────────────────┐
     │ crates/data-core │  (Rust lib, no browser deps)
     └────────┬─────────┘
              │ cargo
     ┌────────▼─────────┐
     │ crates/wasm-     │  (wasm-bindgen shim)
     │ bindings         │
     └────────┬─────────┘
              │ wasm-pack
     ┌────────▼─────────────────────┐
     │ apps/web/src/wasm/...        │  (generated — do not edit)
     └────────┬─────────────────────┘
              │ vite build
     ┌────────▼─────────┐
     │ apps/web/dist/   │  (static site, ready to serve)
     └──────────────────┘
```

`pnpm build` runs the two right-hand steps in order. The wasm
generated files live at `apps/web/src/wasm/` and are gitignored;
run `pnpm wasm:build` (or `:dev`) on a fresh checkout and after any
`crates/` change before starting the dev server or running tests.

### Dev vs release wasm

`wasm:build:dev` emits debug symbols and no optimisation: fast to
compile, useful for iterating on Rust changes. `wasm:build` applies
the release profile set at the Cargo workspace root:

```toml
[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
```

`opt-level = "s"` optimises for *size* (over speed). LTO (link-time
optimisation) and single-codegen-unit both make the final wasm blob
smaller at the cost of longer build time — a reasonable trade for
something shipped to browsers. The result is a few hundred kilobytes
gzipped.

### Vite, briefly

`apps/web/vite.config.ts` is the build configuration. Notable bits:

- **`vite-plugin-wasm` + `vite-plugin-top-level-await`** — together
  these let a `.wasm` module sit beside TypeScript and be imported
  like any other module, including inside web workers.
- **`worker: { format: "es", plugins: ... }`** — workers get the same
  wasm plugin configuration, which matters because the dataCore worker
  is the one that actually loads wasm.
- **Sample-data dev middleware** — a small custom middleware serves
  `sample-data/*` under the dev server so Playwright can `fetch()` the
  corpus instead of shipping it through Chrome DevTools Protocol
  serialisation. This exists purely for test throughput.

## The tests, tier by tier

Driveline has three test tiers, each running in a different place.

### Rust unit/integration tests

```bash
cargo test --workspace
# or
pnpm test:rust
```

Runs every `#[test]` in `crates/data-core` and `crates/wasm-bindings`.
These are pure Rust tests — no browser, no wasm toolchain. A full run
on a developer laptop is a few seconds.

The heavy hitters are in `crates/data-core/src/mcap.rs`,
`crates/data-core/src/mf4.rs`, and `crates/data-core/src/mp4_sidecar.rs`
— each Reader has tests that open a known fixture, assert on channel
metadata, and round-trip a known slice of samples.

### TypeScript unit tests (vitest)

```bash
pnpm test:web
```

Vitest runs under `environment: "node"` — no jsdom, no React
components mounted. Tests live next to the code they cover
(`foo.ts` ↔ `foo.test.ts`).

Test files of note:

- `apps/web/src/tests/arrow.contract.test.ts` — the Rust↔JS Arrow
  round-trip described in Chapter 8. If the two Arrow versions ever
  drift, this fails first.
- `apps/web/src/state/store.test.ts` — clamp invariants, auto-pause,
  merge-source math from Chapter 6.
- `apps/web/src/timeline/playback.test.ts` — the deterministic
  anchor-and-tick tests enabled by the injectable `deps` (Chapter 10).

### Playwright end-to-end tests

```bash
pnpm e2e
```

Spec files in `apps/e2e/tests/` drive a real headless Chromium. Each
spec navigates to a running dev server, drops a fixture file, and
makes assertions about the real rendered page — including pixel
comparisons for decoded video frames.

These are the slowest tests (single-digit minutes) and the highest-
fidelity: they exercise the full stack from file drop through WASM
through worker RPC through WebCodecs to pixels. They also rely on the
sample corpus being present.

### Everything together

```bash
pnpm test        # runs `test:web` then `test:rust`
pnpm e2e         # runs the Playwright suite separately
```

CI runs both. A clean run of `pnpm test && pnpm e2e` is the closest
thing to a release gate.

## The sample corpus

Playwright can't run without fixture files. They're generated by a
Python script:

```bash
python3 sample-data/generate.py
```

That produces MCAP (plain and zstd-compressed) / MF4 / MP4+sidecar
fixtures covering a 10-second 4K clip plus synthetic telemetry
channels. The outputs are gitignored (they're large), but the script
writes alongside them `EXPECTED_HASHES.txt` of expected SHA-256 hashes
that the test setup verifies to catch accidental regeneration drift.

## Format check

```bash
pnpm fmt
```

Runs `cargo fmt --all` and the JS formatter (Prettier via
`apps/web/package.json`). The CI job runs the same check in `--check`
mode and fails on diffs.

## What ships

The output of `pnpm build` is a static site under `apps/web/dist/`:

```
dist/
├── index.html
├── assets/
│   ├── main-<hash>.js            # React bundle
│   ├── dataCore-<hash>.js        # dataCore worker bundle
│   ├── videoDecode-<hash>.js     # videoDecode worker bundle
│   └── wasm_bindings_bg-<hash>.wasm
└── ...
```

That's the entire deployment. No server, no database, no API. Point
any static host — S3, Cloudflare Pages, `nginx` with a folder — at
`dist/` and Driveline loads.

The cross-origin isolation headers (needed for `SharedArrayBuffer`,
which Driveline does *not* use in the MVP but a future threaded-wasm
build might) are not required for this shipping model. A plain static
host is enough.

## The loop, day to day

A typical edit cycle:

- **Touched a .rs file in `data-core`?** `pnpm test:rust` and move on.
- **Touched `wasm-bindings/src/lib.rs`?** `pnpm wasm:build:dev`; Vite
  picks up the regenerated wasm module without a full restart.
- **Touched a .ts/.tsx file?** `pnpm dev` has hot module reload; saved
  changes show up without reload unless you touched a worker file, in
  which case reload the tab.
- **Changed the wire format?** Run `pnpm test:web` (the Arrow contract
  test) *and* `pnpm test:rust`; they guard the same boundary from
  opposite sides.
- **Ready to ship?** `pnpm test && pnpm e2e && pnpm build`.

## End of the book

You now know the shape of every piece:

- **data-core** (Rust) — portable readers for MCAP, MF4, MP4+sidecar.
- **wasm-bindings** (Rust) — slab-and-handle bridge that surfaces a
  flat function API to JS.
- **Two workers** (TypeScript) — dataCore hosts wasm; videoDecode
  owns a `VideoDecoder`.
- **Zustand store** (TypeScript) — the one place session/transport/
  layout state lives.
- **React panels** (TSX) — subscribe to exactly the slice they need,
  re-render when that slice changes.
- **Arrow IPC** for signal columns; **`EncodedChunk` Annex-B** for
  video.
- **`cursorNs`** as the universal synchronisation primitive, written
  through `setCursor` (user scrubs) or `advanceCursor` (rAF playback
  loop; does not bump `seekEpoch`).
- **Vite + wasm-pack + pnpm + cargo** for build; **vitest + Playwright
  + cargo test** for test; a static `dist/` for ship.

If the design docs in `docs/` were the spec and source files are the
implementation, this book is the guided tour. Flip back to whichever
chapter you need whenever a file in the repo doesn't quite make sense
on its own.
