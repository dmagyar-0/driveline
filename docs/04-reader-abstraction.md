# 04 — Reader Abstraction

The `Reader` trait is the single seam between Driveline's core and the file
formats it supports. Everything downstream — panels, timeline, transport,
store — deals with `Channel`s, `TimeRange`s, and Arrow batches, never with
MCAP records or MF4 records directly.

Signatures below are **design sketches**, not compiling code.

## Trait surface (Rust)

```rust
// crates/data-core/src/reader.rs

pub struct SourceMeta {
    pub id: SourceId,
    pub kind: SourceKind,        // Mcap | Mf4 | Mp4Sidecar
    pub time_range: TimeRange,
    pub channels: Vec<Channel>,  // see docs/03-data-model.md
}

pub struct FetchOpts {
    pub include_prev: bool,
}

pub trait Reader: Send {
    /// Open the source, parse headers, build indices.
    /// Blocks the worker until metadata is available.
    fn open(input: BlobHandle) -> Result<Self> where Self: Sized;

    fn meta(&self) -> &SourceMeta;

    /// Return an Arrow IPC byte stream for the given channel and range.
    /// Panics if channel_id is not owned by this reader.
    fn fetch_range(
        &self,
        channel_id: ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> Result<ArrowIpc>;

    /// For Video channels only: produce an iterator of encoded access units.
    /// `from_pts_ns` is snapped to the preceding keyframe.
    fn video_stream(
        &self,
        channel_id: ChannelId,
        from_pts_ns: i64,
    ) -> Result<Box<dyn Iterator<Item = EncodedChunk> + Send>>;
}
```

Notes:

- `BlobHandle` is a worker-side wrapper around the JS `Blob` / `File`
  passed from the main thread. It exposes byte-range reads as an async API
  under the hood; within a synchronous-looking Rust call we use `block_on`
  inside the worker, which is safe because the worker is not the main
  thread.
- `fetch_range` returns the Arrow IPC bytes ready to `postMessage` across
  the worker boundary. The caller is responsible for transfer.
- `video_stream` returns an iterator, not a `Stream`, to keep the FFI
  surface small. Back-pressure is handled by the caller pulling at the
  pace the decoder accepts.

## Concrete readers

### `McapReader`

Built on the [`mcap`](https://crates.io/crates/mcap) crate.

- `open`: read the summary section (MCAP index), build:
  - channel table → `Channel`s with inferred `kind`/`dtype` from schema.
  - per-video-channel keyframe table: `Vec<(pts_ns, file_offset, size)>`.
- `fetch_range`:
  - Use the MCAP chunk index to locate chunks overlapping `[t0, t1)`.
  - Decode messages of the target channel; build Arrow columns according
    to the channel's `kind`/`dtype`.
- `video_stream`:
  - Binary search the keyframe table for `pts ≤ from_pts_ns`.
  - Iterate messages from there, emitting `EncodedChunk`s.
  - First chunk carries `description` (SPS/PPS) on the first call after
    open; `VideoDecoder.configure()` consumes it.

Schema inference heuristics (MVP):

- `schema.encoding == "protobuf"` and `schema.name` contains `"Image"` /
  `"CompressedVideo"` / `"H264"` → `Video`.
- Well-known Foxglove schemas (`foxglove.CompressedVideo`, `sensor_msgs/Image`
  compressed) short-circuit to `Video`.
- All other schemas default to `Bytes`; user can still see them in the
  channel list but the MVP PlotPanel will not plot them.

### `Mf4Reader`

Built on the user's `mf4-rs` crate, wrapped for WASM.

- `open`: walk the file blocks, enumerate channel groups, compute absolute
  time bases (`start_time + cg_offset`), build per-CG sample tables.
- `fetch_range`:
  - For each channel in the target CG, bytes are typically stride-packed
    with a master time channel alongside.
  - Read sample windows via `mf4-rs` by sample-index range translated from
    `(t0, t1)` on the CG's monotonic time axis.
  - Translate to absolute ns UTC, build Arrow columns.
- `video_stream`: **unsupported**. MF4 files carry signals, not video.
  Attempting to call this on an MF4 channel returns `Err(UnsupportedKind)`.

Risks and open questions are in `08-risks-and-open-questions.md` — chiefly
the WASM port of `mf4-rs` itself (Task T0.1).

### `Mp4SidecarReader`

Built on an mp4 parsing crate (`mp4` or a minimal in-crate parser).

- `open` takes two inputs: the mp4 blob and the `.mp4.timestamps` sidecar
  blob.
- Parse the mp4 `moov` atom, build per-sample tables (`stsz`/`stco`/`stts`/
  `stss`).
- Parse sidecar: **UTF-8 text, no header**, one line per sample of the form
  `<frame_index>\t<timestamp_ns>\n`, in decode order. Line count must match
  the track's sample count and the `frame_index` column must equal the
  0-based row index; mismatch fails the open.
- `meta.channels` contains one `Video` channel per mp4 track.
- `fetch_range`: unsupported.
- `video_stream`: yields `EncodedChunk { pts_ns = sidecar[i], data = sample_i }`.

## Why a trait

- **Uniform UI.** Panels hold `ChannelId`s, not reader references. Mixing
  MCAP, MF4, and mp4 sources in one session is free.
- **Parallel ingest.** Opening two files fires two readers on two futures
  in the worker; they don't know about each other.
- **Future sources.** A `WebSocketReader` for Foxglove-protocol live
  streams, a `ParquetReader` for cold storage, or a `RosbagReader` can be
  added without touching any panel or state code.

## Worker-facing API

The trait is Rust-internal. The worker publishes a flat C-ABI-ish API over
`wasm-bindgen` for Comlink to consume:

```
open_file(blob, kind: "mcap"|"mf4"|"mp4+ts", sidecar?: Blob) -> SourceId
close_source(source_id)
list_channels(source_id) -> Channel[]
time_range(source_id) -> TimeRange
fetch_range(channel_id, t0_ns, t1_ns, opts) -> ArrayBuffer  // Arrow IPC
video_open(channel_id, from_pts_ns) -> StreamId
video_next(stream_id) -> EncodedChunk | null
video_close(stream_id)
```

The trait exists on the Rust side of this shim. The JS side never sees
`Reader`.

## Extension points for later

- **Live source.** Same trait; `open` becomes `connect`. `fetch_range` over
  a live source returns the tail of the in-memory ring buffer.
- **Annotations / event markers.** Add a parallel `events()` method or
  treat them as a special `Enum` channel.
- **Schema-aware decoding.** Introduce a `SchemaDecoder` trait and an
  adapter that converts `Bytes` channels into `Scalar` / `Vector` /
  `Struct` channels lazily.
- **Write-back.** Not in the MVP scope, but `Reader` could grow a sibling
  `Writer` trait for exporting clipped ranges.
