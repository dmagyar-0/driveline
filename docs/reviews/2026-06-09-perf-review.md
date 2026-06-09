# Performance review — 2026-06-09

Whole-tool latency/efficiency audit covering five subsystems: frontend
hot paths, the worker/Comlink layer, the Rust readers, the JS↔WASM
boundary, and startup/bundle/ingest. This file records what shipped in
the `perf-quick-wins` PR and, more importantly, the **remaining
backlog** — findings that were verified against the source but deferred
because they need real design work rather than mechanical fixes.

## Shipped (perf-quick-wins)

- **data-core**: ROS2-expanded channels cache parsed values per
  (segment, channel); CDR skips fixed-width primitive arrays
  arithmetically; MCAP scalar fetch drops a redundant sort and two
  column copies; tabular got footer-only Parquet inspect, column
  projection, single-pass typed CSV parse, and a sorted fast path;
  pointcloud uses bulk appends with pre-sized buffers.
- **wasm-bindings**: per-element `set_index` loops → bulk `copy_from`
  (mp4 index, tabular time column, lidar spin times); interned
  per-chunk key strings.
- **build**: `overflow-checks` scoped to first-party crates,
  `opt-level=3` for decompression deps, `panic="abort"`, Vite target
  es2022.
- **web hot path**: PlotPanel seriesStats computed once per data change
  (was: full min/max/mean scan of every bound channel per cursor *and*
  hover tick); EnumPanel cursor lookup binary-searched; Transport
  memoised; URL-hash writes suppressed during playback; perf-mark
  retention bounded; mergeSeries exact-size allocation.
- **workers**: `Comlink.transfer` on all bulk returns; MCAP video
  chunks flow dataCore→videoDecode over a direct MessageChannel (main
  thread out of the decode loop); mp4 index + `isConfigSupported`
  cached per seek; stream double-close removed.
- **ingest**: dropped files reach the worker as `File` handles (1 copy
  instead of 3); pending tabular imports hold the `File`, not bytes;
  mp4 summary+index round-trips parallelised; in-flight dedup for
  identical concurrent `fetchChannelRange` calls.

## Remaining backlog (ordered by expected impact)

### 1. `max_points` decimation + windowed fetch — HIGH (flagship)

Every signal panel fetches `[globalRange.startNs, globalRange.endNs]`
at full sample rate per bound channel (`PlotPanel.tsx` fetch effect;
`FetchOpts` in `wasm-bindings/src/lib.rs` has no point cap; the
"T4.3 min-max decimation path" comment in `mf4.rs` was never built).
A 1 kHz channel over an hour is ~3.6 M rows ≈ 58 MB of IPC encoded,
copied, and parsed per channel per panel. Payload should scale with
pixels, not samples.

Plan: add `max_points` (min/max-per-bucket) to `fetch_range` in
`data-core` + the wasm boundary, update the Arrow contract tests on
both sides, have PlotPanel request ~2× canvas width and refetch on
x-zoom. Design questions that made this unsuitable for an autopilot
pass: value-at-cursor and transforms (derivatives) need full-res or
raw-window data, zoom currently rescales without refetching (UX
change), and decimated series must not contaminate `rawTsNs` binary
searches. A `(channelId, range, transform)`-keyed decoded-series cache
belongs in the same change.

### 2. MF4 open decodes everything twice; fetch materialises full channels — HIGH

`mf4.rs` open probes each channel group via `mdf.signal(...)`, which
(verified in the pinned mf4-rs fork) decodes both the probe channel's
values and the master — each streaming all the group's data blocks —
then discards the values. `fetch_range` →
`channel_values` decodes the whole channel regardless of the requested
window, and each additional channel of a group re-streams all of the
group's blocks. Fix lives mostly in the mf4-rs fork: a
timestamps-only read for open, and a record-range read (`partition_point`
on the prebuilt timeline × fixed `record_size`) for fetch; share one
block pass across channels of a group.

### 3. Lazy lidar spin decode — HIGH (memory)

`pointcloud.rs` decodes and pins **all** spins at open: an Alpamayo
clip is ~199 spins × ~3 MB ≈ 600 MB resident in wasm memory, while the
Scene panel only ever fetches one spin at a time. Keep the parquet
bytes + a per-row-group index (row ranges + `t_ns`), decode the
requested spin's row group on demand behind a 2–4 entry LRU, and use a
`ProjectionMask` for the three needed columns.

### 4. Arrow decode on the main thread / BigInt→Number loop — MEDIUM

`seriesFromArrow.ts` parses IPC and converts `Number(rawTs[i])/1e9`
per element on the main thread per panel (50–200 ms blocks for
million-row channels); the timestamp-offset path (`offsetShift.ts`)
does a full decode→re-encode→decode round trip. Either emit an extra
Float64 seconds column from Rust, or decode in the dataCore worker and
transfer ready typed arrays; apply offsets to the typed array instead
of re-encoding IPC. Decimation (#1) shrinks this too but doesn't
remove the per-element BigInt cost.

### 5. Video: decoder reuse + batched mp4 sample RPC — MEDIUM

Each seek still creates a fresh `VideoDecoder` (config now cached, the
instantiation is not), and the mp4 lazy stream issues one main-thread
RPC **per sample** during refill (~6+ sequential hops per 4-sample
batch in `videoDecodeOps.ts` `next()`). Reuse the decoder via
`reset()`+`configure()` across seeks, and add a batched
`mp4Samples(handle, startIdx, count)` relay method (transfer the
buffers; fold `setActive`/`clearPending` into the same call). Budget
context: seek P50 < 120 ms.

### 6. MCAP video: decoded access-unit LRU — MEDIUM

`mcap.rs` `open_video_cursor` re-decodes every video message in a
segment per seek (JSON parse + base64, or CDR extract); the chunk
cache only saves the read+zstd. A small LRU of decoded
`Vec<EncodedChunk>` keyed by (segment, mcap_id) — or cached
`(pts, keyframe, offset)` tables — removes the per-seek re-decode.

### 7. Startup: code splitting + WASM preload — MEDIUM (cold start)

No dynamic `import()`/`React.lazy` anywhere: Leaflet, FlexLayout,
apache-arrow, and uPlot all sit in the single ~1.2 MB entry chunk
(`panelFactory.tsx` statically imports all panels). The WASM fetch is
discovered four serial hops deep (HTML → entry JS → React mount →
worker spawn → wasm fetch) with no preload hints. Lazy-load panels at
the FlexLayout factory boundary (Map/Scene first — Leaflet and the
WebGL renderer are pure leaves), move Arrow decode worker-side (see
#4) to drop apache-arrow from the entry, and emit
`modulepreload`/`preload as="fetch"` hints for the worker + wasm
assets from the build. Budget is comfortable (~1.3 MB gz total of
2.5 MB); this is about time-to-interactive, not the budget.

### 8. Multi-file drop: parallel open + progressive commit — MEDIUM

`openFiles` awaits each file sequentially and commits once at the end;
N MCAP drops serialise N full OPFS copies and nothing renders until
the last finishes. Verified blocker: `uniqueSourceId` dedupes basenames
by scanning the accumulating `newSources`, so naive `Promise.allSettled`
races duplicate suffixes. Needs ID assignment decoupled from open
order, then per-file `commitOpenedSources` (it already merges
incrementally).

### 9. `JsRangeReader` double allocation per lazy block read — MEDIUM

`wasm-bindings/src/lib.rs` `read_range`: JS allocates a buffer, OPFS
reads into it, wasm copies it again into a `Vec` (`arr.to_vec()`).
Inverting buffer ownership (Rust-owned `Vec`, JS writes into a
`Uint8Array::view_mut_raw` window) halves lazy-read traffic — biggest
on first-plot of large MF4 channels. Deferred for the `unsafe`
view-invalidation care it needs (no wasm allocation may happen while
the view lives).

### 10. URL sources: readahead block cache — LOW-MEDIUM

`urlReadRange` in `dataCore.worker.ts` issues one blocking sync XHR per
data block, serialising the whole worker behind network latency (video
pulls queue behind plot fetches). A 1–4 MB aligned block LRU in front
of `readRange` collapses adjacent reads. (The sync constraint itself
is inherent to the in-wasm sync decoder.)

### 11. `fetchChannelRange` result cache — LOW-MEDIUM

In-flight dedup shipped; an actual result cache (so a settings-only
plot rebuild doesn't re-hit the worker) still needs invalidation
tied to source close and per-source time-offset changes
(`shiftRangeArrowTs` bakes the offset into the returned bytes).

### 12. Smaller Rust items — LOW

- `pcd.rs`: boxed-closure dynamic dispatch per element (~4 virtual
  calls/point) and a full payload copy; monomorphise the inner loops
  and borrow the payload.
- `ParsedValue::Vector(Vec<f64>)` heap-allocates per vector sample in
  the MCAP value cache; an inline `[f64; 3]`/SmallVec ends the churn.
- MCAP value cache is entry-capped (256), not byte-capped; dense
  chunks can hold tens of MB.
- Arrow schemas rebuilt per request (`OnceLock<Arc<Schema>>` removes
  a few allocs); `select_segments` could `partition_point` instead of
  linear-scanning; unchunked-MCAP open scan could seed the chunk
  cache; foxglove JSON decode could use typed `Deserialize` structs
  instead of `serde_json::Value`.
- `McapReader::open` (in-memory fallback path) `to_vec`s bytes wasm
  already copied — 2× file size transient for the HTTP-fetch path.
- `ruzstd` 0.7 → 0.8.x bump-and-measure (upstream decoder perf work).

### 13. Smaller web items — LOW

- VideoPanel HUD/stats strings still rebuild per rAF (writes are now
  guarded); throttle composition to ~4 Hz.
- pointCloudRenderer re-queries uniform locations and allocates fresh
  matrices per render (≤10 Hz, minor); cache at link time.

## Pre-existing issues found during verification (not perf)

- `multiMf4Plot.spec.ts:170` fails on `main`: the
  `[data-testid^="chip-"]` locator matches both `chip-<id>` and
  `chip-value-<id>`, so 2 bound channels count as 4.
- `panelDrawer.spec.ts:175` fails on `main`: it assumes
  `listChannels()[0]` is a scalar, but short.mcap's first channel is
  now `/camera/front` (video), so the plot remove-row never exists.
  Both block the `perf` Playwright project in a full run (it depends
  on the `chromium` project); run budgets standalone with
  `--project=perf --no-deps` until fixed.
- `cargo test` on Windows: `sidecar_generator_is_deterministic` fails
  on CRLF-checked-out fixtures (generator emits LF).
