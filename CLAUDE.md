# Driveline

Browser-first multimodal log viewer for synchronised 4K video and high-rate
signal data. JS app talks to a Rust core compiled to WASM, runs entirely in
the browser (no server). See `@README.md` for the quickstart and `@docs/` for
the full design.

## Stack at a glance

- **Frontend** (`apps/web/`): React 19 + TypeScript + Vite 6, **Zustand** (one
  store, no providers), **FlexLayout** (dockable panels), **uPlot** (signals),
  Leaflet + react-leaflet (maps).
- **Core** (`crates/data-core/`): pure portable Rust. Readers (`McapReader`,
  `Mf4Reader`, `Mp4SidecarReader`), Arrow IPC producers. No browser deps —
  testable natively with `cargo test`.
- **WASM bridge** (`crates/wasm-bindings/`): `wasm-bindgen` shim targeting
  `wasm32-unknown-unknown`. Driven from the JS side via Comlink workers.
- **E2E** (`apps/e2e/`): Playwright, talks to the running dev server via
  `window.__driveline*` hooks.

## Commands (use these — don't guess)

| Task | Command |
| --- | --- |
| Install JS deps | `pnpm install` |
| Build WASM (release) | `pnpm wasm:build` |
| Build WASM (dev, fast) | `pnpm wasm:build:dev` |
| Dev server | `pnpm dev` (http://localhost:5173) |
| Production build | `pnpm build` |
| All tests | `pnpm test` |
| JS unit + Arrow contract | `pnpm test:web` |
| Rust unit + contract | `cargo test --workspace` (or `pnpm test:rust`) |
| Playwright e2e | `pnpm e2e` |
| Format | `pnpm fmt` (runs `cargo fmt --all` + web fmt) |
| Lint Rust | `cargo clippy --workspace --all-targets` |
| Regenerate fixtures | `make fixtures` |
| Verify fixtures fresh | `make fixtures-check` |
| Bootstrap test deps | `scripts/setup-test-env.sh` (idempotent) |

**IMPORTANT:** `pnpm dev` needs the WASM bundle present. On a fresh checkout
or after touching `crates/`, run `pnpm wasm:build` (or `:dev`) first. The
generated bundle in `apps/web/src/wasm/` **is checked into git** so editors,
CI, and tests work without `wasm-pack` — don't add it to `.gitignore`.

## Hard rules

- **Never use Tailwind, styled-components, or any CSS-in-JS.** This project is
  CSS Modules only.
- **Never `parseInt`/`Number(...)` a `BigInt` that holds a timestamp.** All
  time values are nanoseconds in `bigint`; convert to `Number` only at the
  rendering boundary (e.g. uPlot's x-axis).
- **Never add a React Context provider for global state.** There is one
  Zustand store at `apps/web/src/state/store.ts`. Subscribe with selectors.
- **Never block the cursor/video hot path.** Cursor updates coalesce to ≤1
  per `requestAnimationFrame`; video seeks debounce 50 ms. New work on this
  path needs a `perf.ts` mark and must stay within budget.
- **Never commit to `main` directly** — always branch and PR.
- **Never bypass git hooks** (`--no-verify`, `--no-gpg-sign`, etc.). If a hook
  fails, fix the cause.
- **Never `git add -A` or `git add .`** — stage explicit paths so generated
  artefacts and stray files stay out of commits.

## Code conventions

- **TypeScript**: strict mode, ES modules, no default exports for components.
  Workers go through Comlink (`workerClient.ts`); never `postMessage` by hand.
- **Rust**: stable toolchain (pinned in `rust-toolchain.toml`). `data-core`
  stays portable — no `wasm-bindgen`, no `web-sys`, no JS imports. Anything
  browser-facing lives in `wasm-bindings`.
- **Arrow IPC** is the wire format between Rust and JS. Schema changes must
  update the contract test on both sides (`pnpm test:web` and
  `cargo test --workspace`).
- **CSS**: one `.module.css` next to its component. No global styles outside
  `apps/web/src/index.css`.

## Architectural reminders

- The WASM build is **size-budgeted**: first-load total <2.5 MB gzip, WASM
  <2 MB gzip. Adding a Rust dep can blow this; check `apps/web/dist` after
  `pnpm build` before declaring done.
- The data pipeline is **lazy and ranged**: panels request channel ranges by
  `[startNs, endNs]` from `dataCore.worker.ts`. Don't materialise full
  channels in memory.
- `.mp4` + `.mp4.timestamps` sidecar files are paired on drop. If you touch
  ingestion, preserve that pairing.
- WebCodecs is **required** for video (Chrome/Edge 130+, Firefox 130+).
  Safari is unsupported by design; `unsupportedSplash.ts` handles detection.

## Working style

- **Convert vague asks into verifiable goals before coding.** "Add validation"
  → write tests for invalid inputs, then make them pass. "Fix the bug" → write
  a test that reproduces it, then make it pass. "Refactor X" → confirm the
  same tests pass before and after. Strong success criteria let you loop
  without checking back; weak ones ("make it work") force rework.

## Testing & verification

- For UI changes, **run `pnpm dev` and exercise the feature in the browser**
  before reporting done. Type-checks and unit tests don't catch interaction
  regressions.
- Playwright reads `window.__driveline*` dev hooks (defined in
  `apps/web/src/App.tsx`). When you add a new testable surface, expose it as
  a hook rather than scraping DOM.
- Prefer running a single test file over the full suite while iterating:
  `pnpm --filter web test path/to.test.ts` or
  `cargo test -p data-core <name>`.
- Fixtures in `test-fixtures/` are generated by `make fixtures`. Re-run if
  `sample-data/generate.py` changes; CI gates on `make fixtures-check`.

## What lives where

- `apps/web/src/state/` — Zustand store, selectors, and persistence shards.
- `apps/web/src/panels/` — Video, Plot, Map, Table, Enum, Scene panels.
- `apps/web/src/workers/` — Comlink-wrapped workers (`dataCore`, `videoDecode`).
- `apps/web/src/perf.ts` — perf mark/measure helpers and `__drivelinePerf`.
- `crates/data-core/src/readers/` — one module per format.
- `docs/06-ui-and-panels.md` — UI architecture, Zustand shape, FlexLayout.
- `docs/07-build-and-tooling.md` — build graph, size budget, browser targets.
- `docs/book/11-run-test-ship.md` — day-to-day workflow.

## When you're touching frontend code

The `frontend` skill auto-loads for any `.tsx`/`.ts`/`.css` change under
`apps/web/`. It has the deep playbook (panel patterns, store shape, web
worker rules, accessibility floor, Playwright hooks). Don't duplicate that
content here — defer to the skill.

## Git & PRs

- Branch from `main`. Feature branches use short kebab-case slugs.
- Conventional commits aren't enforced, but keep subject ≤72 chars and
  describe the **why**, not the diff.
- Don't open a PR unless explicitly asked.
