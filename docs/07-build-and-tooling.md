# 07 — Build and Tooling

## Repository layout

```
driveline/
├── apps/
│   └── web/                   # Vite + React + TS app
│       ├── index.html
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── panels/
│           │   ├── VideoPanel.tsx
│           │   └── PlotPanel.tsx
│           ├── timeline/
│           │   └── Transport.tsx
│           ├── state/
│           │   └── store.ts
│           └── workers/
│               ├── dataCore.worker.ts
│               └── videoDecode.worker.ts
├── crates/
│   ├── data-core/             # Rust: Reader trait, MCAP, MF4 adapters
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── reader.rs
│   │       ├── mcap.rs
│   │       ├── mf4.rs
│   │       ├── mp4_sidecar.rs
│   │       └── index.rs
│   └── wasm-bindings/         # Rust: wasm-bindgen surface for the worker
│       ├── Cargo.toml
│       └── src/lib.rs
├── docs/                      # this directory
├── sample-data/               # gitignored; reference fixtures for tests
├── Cargo.toml                 # workspace root
├── package.json               # workspace root (pnpm or npm workspaces)
├── pnpm-workspace.yaml        # or equivalent npm workspaces config
├── .gitignore
└── README.md
```

Rationale:

- **`apps/` and `crates/` split** follows the convention used by Rerun and
  similar polyglot projects; new apps (e.g. a Tauri wrapper later) slot in
  under `apps/`.
- **Two Rust crates**, not one: `data-core` stays portable (plain Rust,
  testable natively with `cargo test`), and `wasm-bindings` carries all
  the `wasm-bindgen` / `js-sys` glue. Only `wasm-bindings` gets built for
  `wasm32-unknown-unknown`.

## JavaScript toolchain

- **pnpm** (preferred; workspaces are trivially supported) or npm
  workspaces. Pick pnpm unless the team has a constraint.
- **Vite 5** with `@vitejs/plugin-react`.
- **TypeScript 5.x** in strict mode.
- **ESLint** + **Prettier** with a small shared config under
  `apps/web/.eslintrc.cjs`.
- **vitest** for unit tests (same config as Vite; no Jest).
- **Playwright** for a minimal end-to-end check (load a fixture, scrub,
  assert canvas pixels at t=…).

## Rust toolchain

- **Rust stable**, pinned via `rust-toolchain.toml`.
- **`wasm-pack`** for building `wasm-bindings` to a web-target bundle.
  Alternatively: `wasm-bindgen-cli` directly, driven by a Vite plugin.
  Decision (default): `wasm-pack` for simplicity; revisit if build
  pipelines need to be faster.
- **`cargo nextest`** for unit tests (optional; faster).

## `mf4-rs` dependency

The user's `mf4-rs` is an existing Rust crate not on crates.io yet.
Options:

1. **Git dependency** in `crates/data-core/Cargo.toml`:
   ```toml
   mf4-rs = { git = "https://github.com/<user>/mf4-rs", rev = "<sha>" }
   ```
2. **Path dependency** during active development:
   ```toml
   mf4-rs = { path = "../../../mf4-rs" }
   ```

MVP uses a **pinned git rev** so the build is reproducible on CI. Path
deps are used locally during the WASM port spike (T0.1) and switched back
to git once the port lands.

`mf4-rs` currently has no WASM target (user statement). Task T0.1
(see `docs/10-task-breakdown.md`) is to make `cargo build --target
wasm32-unknown-unknown -p mf4-rs` succeed. The risks and fallbacks are in
`docs/08-risks-and-open-questions.md`.

## WASM build wiring

Two viable wirings:

- **Plugin-driven** (simplest): a Vite plugin such as `vite-plugin-wasm`
  + `vite-plugin-top-level-await`, plus a small `scripts/build-wasm.mjs`
  that shells out to `wasm-pack build crates/wasm-bindings
  --target web --out-dir ../../apps/web/src/wasm`.
- **Worker-native**: the worker entry file `import`s the generated
  `wasm_bindings.js` and awaits its init. Vite bundles workers as
  separate chunks natively (`new Worker(new URL('./dataCore.worker.ts',
  import.meta.url), { type: 'module' })`).

MVP uses the plugin-driven setup. The `pnpm dev` command runs a
`wasm-pack build` in watch mode (via `cargo-watch` or an npm script
using `nodemon`) and Vite picks up the regenerated JS.

## Dev workflow

Rough commands (for docs/README.md once set up):

```
pnpm install                  # installs JS deps + sets up workspaces
pnpm wasm:build               # one-shot wasm-pack build
pnpm wasm:watch               # rebuild wasm on Rust changes (T0 spike)
pnpm dev                      # Vite dev server for apps/web
pnpm test                     # vitest + cargo test
pnpm e2e                      # Playwright
pnpm build                    # production build: wasm + web bundle
```

Rust-only development:

```
cargo check --workspace
cargo test -p data-core
cargo build --target wasm32-unknown-unknown -p wasm-bindings
```

## Target browsers

- **Primary:** Chromium-based browsers (Chrome, Edge, Brave, Arc) on
  versions that ship stable WebCodecs (Chromium 94+; practically current
  evergreen).
- **Secondary (best-effort):** Firefox (WebCodecs shipped in FF 130+).
- **Out of scope for MVP:** Safari. We will not intentionally break
  Safari but will not test it either; behaviour is undefined.

The app detects WebCodecs support on load and, if missing, shows a
dedicated "browser not supported" screen rather than a half-working UI.

## Production build and deployment

- `pnpm build` outputs a static bundle to `apps/web/dist/`.
- The bundle is deployable to any static host (Netlify, Cloudflare Pages,
  S3+CloudFront, GitHub Pages).
- No runtime server. No backend envs.
- HTTPS is required in production because WebCodecs / OffscreenCanvas
  require a secure context.
- `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` headers must be set if we
  ever enable `SharedArrayBuffer` (useful for WASM threads; not required
  for MVP). Document in the hosting guide when the time comes.

## Size budget (informational)

Ballpark numbers to sanity-check the final bundle:

- React + dependencies: ~50 KB gzip.
- uPlot: ~30 KB gzip.
- FlexLayout: ~35 KB gzip.
- `apache-arrow` JS (trimmed to IPC reader): ~70 KB gzip.
- `wasm-bindings` WASM (with `mcap` + `mf4-rs` + `arrow2`): target
  **under 2 MB** gzip. Go over only with a reason.

Total first-load target: **under 2.5 MB gzip**. We measure on CI once we
have code; this is the line in the sand.

## CI (post-MVP, but planned now)

- GitHub Actions: one job running `pnpm install && pnpm build && pnpm
  test && cargo test --workspace && cargo build --target
  wasm32-unknown-unknown -p wasm-bindings`.
- A tiny fixture MCAP checked in under `sample-data/` (or fetched via
  `git-lfs` if size warrants) powers vitest + Playwright runs.

## Future: Tauri wrapper

Kept intentionally out of MVP. When it arrives:

- New crate `apps/desktop/` with a Tauri shell.
- Reuse `crates/data-core` directly (no WASM) — same `Reader` trait, no
  rewrite.
- Reuse `apps/web` UI as Tauri's webview content.
- Replace browser file APIs with Tauri's filesystem API for
  large-file streaming.
- Decide on native video decoder (ffmpeg via `rusty_ffmpeg` or
  `gstreamer-rs`) at that point; WebCodecs is not available in a Tauri
  webview today.

This keeps the option open without costing us anything in the MVP.
