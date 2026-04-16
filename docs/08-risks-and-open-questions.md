# 08 — Risks and Open Questions

Risks are ordered by probability × impact. Each has a mitigation and, where
relevant, a fallback that keeps the MVP deliverable without rewriting the
world.

---

## R1. `mf4-rs` does not build for `wasm32-unknown-unknown`

**Probability:** high (user stated the crate has no WASM target today).
**Impact:** critical — without it, the MF4 path has no reader.

**Common causes we expect:**

- Use of `std::fs` or `memmap2` for file I/O. Both are unavailable on
  `wasm32-unknown-unknown`. Fix: abstract over a trait
  (`BlobReader: Read + Seek`) and provide a blob-backed implementation
  that reads via `Blob.slice()` from JS.
- Native zstd/zlib bindings (C deps). Fix: swap to pure-Rust alternatives
  (`ruzstd`, `flate2` with `rust_backend` feature).
- Threading (`std::thread`, `rayon`). Fix: gate behind a `cfg` so the
  WASM build stays single-threaded; revisit if `wasm32-wasi-threads`
  becomes ubiquitous.
- `u128`/`i128` through the FFI boundary. Fix: avoid at the boundary; use
  two `u64`s or hex strings.

**Mitigation plan:** T0.1 is a time-boxed spike (1–2 days). If we burn
through the box:

**Fallbacks (ranked):**

1. **Patch set carried in-tree.** Fork `mf4-rs`, apply the minimum diff
   to compile for WASM, pin to that fork. Acceptable if the diff is
   small and upstreamable.
2. **JS-side MF4 reader.** Write a minimal MF4 reader in TypeScript
   covering the subset we need for MVP (fixed-point integer, float32/64
   channels; no VLSD, no complex records). Significant re-work but
   contained.
3. **Optional server mode.** Add a tiny Rust HTTP service that reads MF4
   server-side and streams Arrow over fetch(). Contradicts
   "browser-only" and is only considered as a last resort.

---

## R2. WebCodecs support gaps outside Chromium

**Probability:** medium.
**Impact:** medium — scope, not show-stopper.

Chrome and Edge: stable. Firefox: shipped in FF 130+ but historically
jittery on older builds. Safari: partial.

**Mitigation:** feature-detect on boot. If `VideoDecoder` or
`isConfigSupported` is missing or returns `false` for our codec string,
show a dedicated unsupported-browser splash. Keep the rest of the app
working (user can still inspect signals) — do not hard-crash the tab.

**Open question:** do we invest in an H.264 software fallback (e.g.
`libav.js`) for unsupported browsers? MVP answer: **no**. 4K software
decode in a browser main thread is a non-starter; we would ship a worse
experience and hide the real limitation.

---

## R3. Browser memory ceiling for large logs

**Probability:** medium.
**Impact:** medium — scopes the sizes we can support, not whether the
app works.

A Chrome tab has a soft limit around 4 GB on 64-bit desktop, hard limit
somewhere above that. MCAP files can easily exceed this.

**Mitigation:**

- Stream: never hold the whole file in JS memory. The `data-core` reader
  slices the `Blob` on demand via `Blob.slice(start, end).arrayBuffer()`.
- Index-first: on open, we build the time index and channel registry,
  then release the initial read buffers.
- Per-channel chunk cache (LRU) bounded in bytes, default 256 MB.
- Use OPFS (Origin Private File System) as a spillover cache for hot
  chunks. Post-MVP if time permits.

**Open question:** how do we behave when a user drops a 10 GB MCAP?
MVP answer: **open it**. Indexing may take 5–10 s. Panels will be
responsive because queries are range-scoped. This is probably fine; we
will measure and document once we have a big sample.

---

## R4. MCAP `log_time` semantics vary between producers

**Probability:** medium.
**Impact:** medium — silent wrong sync is the worst UX failure.

Different recorders stamp `log_time` at different moments: capture time,
queue-insert time, publish time. For video, this can differ from
signal channels by tens of ms.

**Mitigation:**

- Document the assumption that `log_time` = capture-instant for MVP
  sample data.
- Provide a **per-source time offset** UI affordance post-MVP: "nudge
  MF4 source by +X ms" with a visible indicator. Not in MVP to avoid
  scope creep, but the store already has room for it.

**Open question:** do we warn when the video channel's first and last
`log_time`s versus the mp4 container's implied duration differ by more
than a threshold? MVP answer: **yes, as a one-shot dev-console warning**.

---

## R5. Keyframe sparsity makes scrubbing laggy

**Probability:** medium on real recordings (many producers emit 1
keyframe every 2–5 s to save bandwidth).
**Impact:** UX — not correctness.

**Mitigation:**

- No action in the viewer itself; it will not transcode.
- Document recommended recording settings: keyframe every 1 s for
  smooth scrub, every 0.5 s for very smooth.
- Post-MVP: a "pre-decoded poster grid" — during open, decode one frame
  per second and keep as thumbnails for instant scrub preview.

---

## R6. `mf4-rs` API shape may not fit the `Reader` trait cleanly

**Probability:** low.
**Impact:** low to medium — may need adapter layer.

The trait (see `04-reader-abstraction.md`) assumes we can query by
`(channel_id, time_range)` and stream samples efficiently. If `mf4-rs`
only exposes a linear iterator, we either:

- layer a seek-then-scan helper in `Mf4Reader` (fine for scalar
  channels where reads are stride-predictable), or
- build a per-channel offset index at `open` time and translate `ns`
  → sample index via binary search on the master time channel.

**Open question:** what are `mf4-rs`'s actual APIs? Unknown at this
planning stage. Integration doc (a follow-up to `04-reader-abstraction.md`)
will pin this down once the library is inspected.

---

## R7. Worker ↔ main thread copy costs at high data rates

**Probability:** low for MVP data sizes.
**Impact:** low.

Arrow IPC crosses the worker boundary once per fetch, and we use
Transferable `ArrayBuffer`. Expected per-tick cost is negligible.

**Mitigation:** measure; if the boundary becomes a bottleneck, consider
`SharedArrayBuffer` behind COOP/COEP headers.

---

## R8. UI complexity creep

**Probability:** medium.
**Impact:** timeline.

It is easy to let a visualization tool grow settings, toggles, inspectors.

**Mitigation:** the MVP scope in `01-vision-and-scope.md` is an explicit
hard-line. Any feature not listed there is a post-MVP issue even if
implementation is trivial. Periodic scope audits during M3–M6.

---

## Open questions to answer before M1

1. **`mf4-rs` dependency source.** Git URL + rev? (`docs/07-build-and-tooling.md`
   documents the mechanics; the URL is TBD.)
2. **Sample corpus authorship.** Do we have or can we produce a 4K/30fps
   MCAP that matches `09-verification-plan.md`? If not, generate one
   synthetically (ffmpeg + a signal-generator script). Deferring a
   decision means deferring the spike gate.
3. **Hosting target.** Not strictly needed for MVP, but knowing in advance
   helps (Cloudflare Pages vs GitHub Pages vs internal).
4. **Tauri timing.** Keep out of MVP; when do we plan the follow-up?

## Open questions that are fine to defer

- Schema decoding for MCAP message payloads (protobuf, ROS `msg`, CDR).
  Not needed for MVP; architecture accommodates via a future
  `SchemaDecoder` trait.
- Live streaming (Foxglove WebSocket protocol).
- Annotations / labels.
- H.265 / AV1.
- Multi-user / sharing links.
- Mobile / tablet support.

Each of these is explicitly out of scope; revisit after MVP ships.
