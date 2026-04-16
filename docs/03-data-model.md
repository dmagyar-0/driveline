# 03 — Data Model

This document defines the vocabulary used everywhere else in the project.
All modules — MCAP adapter, MF4 adapter, video pipeline, panels, timeline —
agree on the types described here.

## The one clock

Every timestamp in Driveline is an `i64` representing **nanoseconds since
the Unix epoch (UTC)**.

- MCAP stores `log_time` and `publish_time` as `u64` nanoseconds since epoch.
  Direct cast to `i64` (values fit comfortably for centuries).
- MF4 stores a file `start_time` (absolute, ns since 1970-01-01 UTC) and
  per-sample offsets relative to a channel group's recording start. At
  ingest, the MF4 adapter computes `absolute_ns = start_time + relative_ns`
  per channel group. Downstream, consumers never see MF4-relative time.
- The mp4 sidecar timestamp file is parsed into a dense array of absolute
  `i64` ns values, one per frame. See `05-video-pipeline.md`.

Rationale: `i64` ns is MCAP's native unit, it survives arithmetic without
rounding drift through a 10-hour session, and it maps cleanly to Arrow's
`Timestamp(ns, UTC)` type.

We do **not** use `f64` seconds anywhere in data structures. UI affordances
(scrubber labels, tooltips) format to seconds for display only.

## Core types

These are the canonical shapes. Rust and TS mirror each other; Arrow schemas
derive from these. Signatures below are illustrative, not compiling code.

### `SourceId` / `SourceHandle`

A session has one or more **Sources** (one MCAP file, one MF4 file, one
mp4+timestamps pair). Each source gets a stable `SourceId` (string UUID)
assigned by the worker on open. The `SourceHandle` is the opaque handle the
main thread passes back into the worker for subsequent calls.

### `Channel`

A uniquely identified, typed, time-ordered stream of messages.

```
Channel {
  id:              ChannelId        // stable within a session
  source_id:       SourceId
  name:            string           // human label, e.g. "/imu/accel" or "AccelX"
  kind:            ChannelKind      // Scalar | Vector | Video | Enum | Bytes
  dtype:           DType | null     // for Scalar/Vector: f32/f64/i32/...
  unit:            string | null    // e.g. "m/s^2"
  sample_count:    u64
  time_range:      TimeRange        // first_ns, last_ns
  schema_ref:      SchemaRef | null // for future message decoding (MCAP)
}
```

`ChannelKind`:

- `Scalar` — one numeric value per sample (bulk of MF4 and most MCAP
  telemetry).
- `Vector` — fixed-width vector per sample (quaternion, accel xyz).
- `Video` — encoded frames (H.264 access units today).
- `Enum` — integer-coded state (gear, mode).
- `Bytes` — opaque payload (raw protobuf/CDR; MVP does not decode).

### `Message`

Driveline's internal message shape, used only when a panel needs individual
records (rare — most consumers go via `fetch_range` → Arrow batch).

```
Message {
  channel_id:  ChannelId
  log_time:    i64   // ns UTC
  payload:     Bytes // interpretation per channel.kind/dtype
}
```

### `TimeRange`

```
TimeRange { start_ns: i64, end_ns: i64 }  // inclusive start, exclusive end
```

### `SessionView`

What the main thread sees after opening one or more sources:

```
SessionView {
  sources:     SourceId[]
  channels:    Channel[]
  global_range: TimeRange   // union of all source ranges
}
```

## Wire format between worker and UI

### Signal data — Apache Arrow IPC

`fetch_range(channel_id, t0, t1, opts)` returns an Arrow IPC byte stream.
Schema per channel kind:

- **Scalar**
  - `ts`    : `Timestamp(ns, UTC)` non-null
  - `value` : one of `Float32 | Float64 | Int32 | Int64 | UInt32 | UInt64`
- **Vector**
  - `ts`    : `Timestamp(ns, UTC)` non-null
  - `value` : `FixedSizeList<Float32 or Float64, N>`
- **Enum**
  - `ts`    : `Timestamp(ns, UTC)` non-null
  - `code`  : `Int32`  (plus a channel-level `enum_dict: map<int,string>` in
    the `Channel.schema_ref`)
- **Bytes**
  - `ts`      : `Timestamp(ns, UTC)`
  - `payload` : `Binary`

Why Arrow:

- Zero-copy on the JS side via `apache-arrow` once the IPC bytes land as an
  `ArrayBuffer`.
- Columnar — perfect for plotting (bulk contiguous `ts` + `value` arrays
  feed uPlot directly).
- Typed, including proper timestamp semantics, so UI code does not shuffle
  units.

`opts` controls decimation and bounds:

```
FetchOpts {
  max_points:   u32 | null   // server-side LTTB/min-max if set
  include_prev: bool         // include one sample <= t0 for step-hold lines
}
```

### Video data — encoded chunks

Video is **not** Arrow. It is a stream of encoded access units.

```
EncodedChunk {
  pts_ns:     i64      // absolute ns UTC on the global clock
  dts_ns:     i64
  duration_ns: i64
  kind:       "key" | "delta"
  data:       ArrayBuffer   // one AU; transferred, not copied
}
```

See `05-video-pipeline.md` for how this is produced from MCAP-embedded
streams and from the mp4+timestamps sidecar.

## How MCAP maps into this model

MCAP is message-oriented: each message has `channel_id`, `log_time` (ns),
`publish_time` (ns), and `data` (bytes). Mapping:

- Each MCAP channel → one Driveline `Channel`. `ChannelKind` is inferred:
  - Messages encoded per an `ImageCompressed` / `CompressedVideo`-style
    schema → `Video`.
  - Messages whose schema describes a primitive scalar → `Scalar`.
  - Otherwise → `Bytes` (opaque; displayable later via a schema decoder).
- `log_time` is authoritative for ordering and for the timeline cursor.
- For video channels, the adapter scans headers to mark keyframes and
  builds a `(pts_ns → file_offset)` index for fast seek.

For MVP we assume H.264 in Annex-B or AVCC form with SPS/PPS either in the
first message or in the channel metadata; the MCAP adapter emits
`description` (codec extradata) for `VideoDecoder.configure()`.

## How MF4 maps into this model

MF4 groups channels into **channel groups** (CG). Each CG has its own
recording time base. Mapping:

- Each MF4 channel → one Driveline `Channel`. `source_id` identifies the
  file, and `Channel.name` includes the CG path so duplicates across CGs do
  not collide.
- `start_time + cg.record_time_offsets + channel_sample_offset` →
  absolute ns UTC for every sample.
- MF4 master time channels are consumed during translation and are not
  surfaced as selectable channels in the UI (they appear as the `ts` column
  of every sibling channel's Arrow batch).
- MVP supports numeric channels (`Scalar`) and fixed-size vector channels
  (`Vector`); string channels, VLSD, and complex nested records are
  post-MVP.

`mf4-rs` is consumed via `wasm-bindgen` wrappers in the `data-core` crate.
See `04-reader-abstraction.md` and `08-risks-and-open-questions.md` for the
WASM-port risk.

## How mp4 + sidecar maps into this model

The mp4+timestamps pair is a **video source**, not a signal source. On open:

1. Parse the mp4 container (moov atom) to enumerate tracks and collect the
   per-track sample table: sizes, offsets, flags (keyframe), decode order.
2. Read the companion `.timestamps` file — one absolute `i64` ns per frame
   in decode order (MVP format; explicit in `05-video-pipeline.md`).
3. Synthesize one Driveline `Channel` per video track with `kind = Video`.
4. `EncodedChunk.pts_ns` = sidecar timestamp for that frame; `dts_ns` =
   same (no B-frame reordering beyond what mp4 already records).

No signal channels are synthesized from an mp4 source.

## Identity and joins across sources

Driveline does not auto-merge channels from different sources. If an MCAP
and an MF4 both record `VehicleSpeed`, they appear as two distinct channels,
under their respective sources, on the same timeline. The user can plot
them on the same `PlotPanel` to visually compare.

Post-MVP: a "linked channels" notion where two Driveline channels can be
asserted to be the same physical signal for overlay/diff.

## Error and gap semantics

- Missing samples do not cause interpolation. Panels render literal data.
  `PlotPanel` draws step-hold between samples for `Scalar` channels by
  default; this is a rendering choice, not a data choice.
- Out-of-order messages in MCAP (by `log_time`) are tolerated by the
  indexer; the `Channel.time_range` is the `[min, max+1)` of observed
  `log_time`s.
- MF4 channel groups with invalid or zero time bases fail the file open
  with a clear error; we do not silently fall back to `publish_time`.
