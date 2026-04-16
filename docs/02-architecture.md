# 02 — Architecture

## High-level shape

Driveline is a browser-only application with three logical layers running in
a single tab:

```
 Browser tab
 ┌─────────────────────────────────────────────────────────────────┐
 │  Main thread — React + TS (Vite)                                │
 │    • FlexLayout docking panels                                  │
 │    • Timeline / transport / scrubber                            │
 │    • VideoPanel (renders VideoFrame to canvas)                  │
 │    • PlotPanel (uPlot on canvas)                                │
 │    • Zustand store: selection, cursor, transport state          │
 └──────────────┬──────────────────────────────────────────────────┘
                │ Comlink-wrapped postMessage
                │  (typed async API, Transferables for bulk data)
                │
 ┌──────────────▼──────────────────────────────────────────────────┐
 │  Web Worker "data-core" — Rust compiled to WASM                 │
 │    • Reader trait                                               │
 │        ├─ McapReader (mcap crate)                               │
 │        └─ Mf4Reader  (mf4-rs, ported to wasm32)                 │
 │    • Time index (ns-UTC → chunk offsets)                        │
 │    • Channel registry (id → schema, units, source)              │
 │    • fetch_range(channel_id, t0, t1) → Arrow IPC bytes          │
 │    • video_index(channel_id) → keyframe table                   │
 └──────────────┬──────────────────────────────────────────────────┘
                │ Encoded access units (H.264 NAL) + PTS
                │  (ArrayBuffer transfer; no copy)
                │
 ┌──────────────▼──────────────────────────────────────────────────┐
 │  Web Worker "video-decode" — TS                                 │
 │    • WebCodecs VideoDecoder                                     │
 │    • Seek strategy: flush + re-feed from prev keyframe          │
 │    • Emits VideoFrame → OffscreenCanvas or transfers to main    │
 └─────────────────────────────────────────────────────────────────┘
```

Each layer is a single-responsibility unit. The main thread never parses
files, never touches a decoder API, and never blocks on I/O. The workers
never touch the DOM.

## Why browser-only with Rust-in-WASM

Alternatives considered and rejected:

| Option | Why rejected |
|---|---|
| Electron + Node for the core | Heavier install, platform-specific packaging, duplicate decode paths (Node vs browser). Provides no capability we need that WebCodecs does not. |
| Tauri with Rust backend | Best native perf, but contradicts the "web browser only" target the user chose for the MVP. Kept as a post-MVP wrapper option. |
| Pure TypeScript reader + JS decoder | Re-implementing MCAP chunk indexing in TS is feasible, but there is already an existing `mf4-rs` Rust crate the user wants to reuse. Duplicating it in TS defeats the point. |
| Server-rendered (axum + SSR) | Adds hosting, upload, and privacy concerns. Log files can be GB-scale and often sensitive. |

The chosen shape gives us:

- A single static build artifact (HTML + JS + WASM).
- Reuse of `mf4-rs` with no code fork.
- Hardware-accelerated 4K decode via `VideoDecoder` in Chromium.
- Zero server infrastructure.

The honest tradeoffs:

- **File size ceiling** is dictated by browser memory and the `File` API.
  Streaming reads via `Blob.slice()` + `ReadableStream` keep memory bounded
  but very large MCAPs (tens of GB) will want a desktop wrapper eventually.
- **WebCodecs portability** — Firefox support is still behind Chromium. We
  explicitly target Chromium for the MVP (see `08-risks-and-open-questions.md`).
- **WASM ↔ JS boundary** has a per-call cost. We mitigate with Arrow IPC
  batches so the boundary is crossed at channel-chunk granularity, not
  per-sample.

## Component responsibilities

### Main thread (React)

- Lifecycle: mount panels, tear them down, persist layout.
- Input: file drop, keyboard shortcuts, scrubber drag, channel selection.
- Transport state: `{ playing, speed, cursor_ns, range_ns }` — single source
  of truth in the Zustand store.
- Rendering: delegates to each panel. Panels subscribe to the cursor and to
  their own data stream from the worker.

It never calls `VideoDecoder`, never reads bytes, never parses a header.

### Web Worker "data-core" (Rust/WASM)

- Owns the open file handle(s) as `Blob` references passed in from the main
  thread.
- Parses headers, builds the time index and channel registry on open.
- Exposes an async, typed API to the main thread via Comlink:
  - `open_file(blob, kind) → SourceHandle`
  - `list_channels(source) → Channel[]`
  - `time_range(source) → { start_ns, end_ns }`
  - `fetch_range(channel_id, t0, t1, opts) → ArrowIpcBytes`
  - `video_stream(channel_id) → ReadableStream<EncodedChunk>`
- Serves signal data as Apache Arrow IPC record batches. Serves video data
  as a stream of encoded access units with PTS and keyframe flags.

### Web Worker "video-decode" (TS)

- A thin shim around `VideoDecoder`.
- Receives encoded access units + timing from data-core (main thread brokers
  the connection with `MessageChannel`).
- Implements seek: on `seek(t)`, flush the decoder, ask data-core for the
  nearest preceding keyframe, feed forward until PTS ≥ t.
- Emits `VideoFrame` objects, transferred to the `VideoPanel` for blit.

## Data flow — opening a session

1. User drops `drive.mcap` + `drive.mf4`.
2. Main thread calls `dataCore.open_file(mcap_blob, "mcap")` and
   `dataCore.open_file(mf4_blob, "mf4")` concurrently.
3. Worker returns `SourceHandle`s; main thread queries `list_channels` and
   `time_range` for each.
4. Zustand store merges into a unified session: one global `range_ns`, one
   flat list of channels tagged by source.
5. UI renders the channel tree and timeline.

## Data flow — scrubbing

1. User drags the scrubber. The store's `cursor_ns` updates at every rAF.
2. `PlotPanel` subscribes to cursor changes; it already has the visible
   window's Arrow batch cached, so it just redraws the cursor line.
3. `VideoPanel` debounces the cursor (~50 ms) and issues `seek(cursor_ns)`
   to the video-decode worker, which produces the matching frame.

## Data flow — playback

1. User hits play. Main thread starts a rAF loop that advances `cursor_ns`
   by `(dt * speed)`.
2. Data-core pre-fetches the next chunk per visible channel so PlotPanel
   never stalls.
3. Video-decode worker decodes ahead of the cursor by N frames (bounded
   queue) and delivers `VideoFrame`s at their PTS; `VideoPanel` blits the
   one whose PTS is ≤ cursor and > last-blit.

## Rejected alternatives (summary table)

| Decision | Rejected option | Primary reason |
|---|---|---|
| Rust in a Web Worker | All-TS core | Reuse `mf4-rs`; avoid re-implementing MF4 in TS. |
| Two separate workers | Monolithic worker | Decoupling decoder perf from parsing keeps tail latencies predictable. |
| Comlink RPC | Hand-rolled `postMessage` protocol | Typed, async, ergonomic; overhead is negligible next to Arrow batch sizes. |
| Arrow IPC as wire format | JSON / plain typed arrays | Columnar, zero-copy on the JS side, clean ints/floats/timestamps. |
| WebCodecs | `HTMLVideoElement` + MSE | Frame-accurate PTS, hardware decode, no MSE seeking gymnastics. |
| uPlot for signals | Plotly / recharts / custom WGPU | Proven 1M+ points @ 60 fps on 2D canvas; tiny API surface. |
| FlexLayout for docking | react-grid-layout, custom | Dockable + serialisable; battle-tested on this exact UX. |

See `08-risks-and-open-questions.md` for what could invalidate any of these.
