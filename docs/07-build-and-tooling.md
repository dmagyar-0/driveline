# 07 — Build and Tooling

The day-to-day build commands, toolchains, and test scripts are
described in [Chapter 11 of the Driveline book](./book/11-run-test-ship.md);
prefer that as the entry point. This document keeps only the
architectural decisions about the build — the "why this layout" notes
— plus the bits that look past the MVP.

## Repository layout

See [Chapter 3 of the book](./book/03-repo-tour.md) for the file-by-file
walk. The key structural decision is the split between `apps/` and
`crates/`:

- **`apps/` and `crates/` separation.** Follows the convention Rerun
  and similar polyglot projects use; a future Tauri wrapper would slot
  in as a second entry under `apps/`.
- **Two Rust crates, not one.** `data-core` stays portable — pure
  Rust, testable natively via `cargo test -p data-core`. All
  `wasm-bindgen` / `js-sys` glue lives in `wasm-bindings`. Only
  `wasm-bindings` is ever built for `wasm32-unknown-unknown`.

## Size budget

Informational; CI measures on every build:

- React + deps: ~50 KB gzip.
- uPlot: ~30 KB gzip.
- FlexLayout: ~35 KB gzip.
- `apache-arrow` JS (trimmed to the IPC reader): ~70 KB gzip.
- `wasm-bindings` WASM (with `mcap` + `mf4-rs`): target **under 2 MB
  gzip**.

Total first-load target: **under 2.5 MB gzip**. Anything that pushes
over is reviewed on the PR.

## Browser targets

- **Primary:** Chromium-based browsers (Chrome, Edge) on versions that
  ship stable WebCodecs.
- **Secondary (best-effort):** Firefox 130+.
- **Out of scope:** Safari. Behaviour is undefined; not tested.

The app detects WebCodecs on load and renders the
`unsupportedSplash.ts` screen when missing, rather than a
half-working UI.

## Production deployment

- `pnpm build` emits a static bundle under `apps/web/dist/`.
- No runtime server. No backend env.
- **HTTPS is required in production** because WebCodecs and
  OffscreenCanvas need a secure context.
- COOP/COEP headers (`same-origin` / `require-corp`) are **not**
  required today. They would be needed only if we ever enable
  `SharedArrayBuffer` for a threaded WASM build.

## Future: Tauri wrapper

Kept intentionally out of the MVP. When it arrives, the plan is:

- New crate under `apps/desktop/` with a Tauri shell.
- Reuse `crates/data-core` directly (no WASM) — same `Reader` trait,
  no rewrite.
- Reuse `apps/web` as Tauri's webview content.
- Replace browser file APIs with Tauri's filesystem API for
  large-file streaming.
- Decide on a native video decoder (`rusty_ffmpeg`, `gstreamer-rs`, or
  platform-specific) at that point — WebCodecs is not available in a
  Tauri webview today.

This is the reason `data-core` and `wasm-bindings` are separate crates:
the architectural seam exists, so adding the native path is a layering
swap, not a rewrite.
