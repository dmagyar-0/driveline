//! Thin wasm-bindgen surface exposing `data-core` to the browser worker.
//!
//! M1 wiring (ping / Arrow IPC stub) stays for the Playwright smoke tests.
//! M2 T2.2 adds an MF4 surface: `open_mf4` parses a byte slice and returns
//! a handle into a thread-local slab, `mf4_*` accessors read from that
//! handle, `close_mf4` releases it. All heavy data (Arrow IPC, channel
//! list JSON) crosses the wasm-JS boundary as `Uint8Array` / `JsValue`.

use std::cell::RefCell;

use data_core::{
    BoxedRangeReader, ByteRangeReader, CalibrationReader, DType, EncodedChunk, FetchOpts,
    MapGeometryReader, McapReader, McapVideoCursor, MdfError, Mf4Reader, Mp4SidecarReader,
    OpenLabelReader, PointCloudReader, Reader, RecipeReader, Ros1BagReader, Ros2Db3Reader,
    SourceMeta, TabularReader, TimeBasis, TimeRange, TrajectoryReader,
};
use js_sys::{Array, Uint8Array};
use serde::Serialize;
use slab::Slab;
use wasm_bindgen::prelude::*;

/// A `ByteRangeReader` whose reads are serviced by a synchronous JS callback.
///
/// The browser worker backs this with an OPFS `FileSystemSyncAccessHandle`
/// (the only browser primitive offering synchronous ranged file reads), so
/// `Mf4Reader` can decode a channel's data blocks on demand without ever
/// copying the whole multi-gigabyte file into wasm linear memory. The callback
/// signature is `(offset: number, length: number) => Uint8Array`.
struct JsRangeReader {
    read_fn: js_sys::Function,
}

impl ByteRangeReader for JsRangeReader {
    type Error = MdfError;

    fn read_range(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, MdfError> {
        let res = self
            .read_fn
            .call2(
                &JsValue::NULL,
                &JsValue::from_f64(offset as f64),
                &JsValue::from_f64(length as f64),
            )
            .map_err(|e| {
                MdfError::BlockSerializationError(format!("mf4 read_range js error: {e:?}"))
            })?;
        let arr = res.dyn_into::<Uint8Array>().map_err(|_| {
            MdfError::BlockSerializationError(
                "mf4 read_range callback did not return a Uint8Array".to_string(),
            )
        })?;
        let bytes = arr.to_vec();
        if bytes.len() as u64 != length {
            return Err(MdfError::BlockSerializationError(format!(
                "mf4 read_range short read at offset {offset}: wanted {length}, got {}",
                bytes.len()
            )));
        }
        Ok(bytes)
    }
}

thread_local! {
    static READERS: RefCell<Slab<Mf4Reader>> = const { RefCell::new(Slab::new()) };
    static MP4_READERS: RefCell<Slab<Mp4SidecarReader>> = const { RefCell::new(Slab::new()) };
    static MCAP_READERS: RefCell<Slab<McapReader>> = const { RefCell::new(Slab::new()) };
    static VIDEO_STREAMS: RefCell<Slab<McapVideoStream>> = const { RefCell::new(Slab::new()) };
    static TABULAR_READERS: RefCell<Slab<TabularReader>> = const { RefCell::new(Slab::new()) };
    static LIDAR_READERS: RefCell<Slab<PointCloudReader>> = const { RefCell::new(Slab::new()) };
    static OPENLABEL_READERS: RefCell<Slab<OpenLabelReader>> = const { RefCell::new(Slab::new()) };
    static CALIBRATION_READERS: RefCell<Slab<CalibrationReader>> = const { RefCell::new(Slab::new()) };
    static TRAJECTORY_READERS: RefCell<Slab<TrajectoryReader>> = const { RefCell::new(Slab::new()) };
    static MAP_GEOMETRY_READERS: RefCell<Slab<MapGeometryReader>> = const { RefCell::new(Slab::new()) };
    static ROS1_BAG_READERS: RefCell<Slab<Ros1BagReader>> = const { RefCell::new(Slab::new()) };
    static ROS2_DB3_READERS: RefCell<Slab<Ros2Db3Reader>> = const { RefCell::new(Slab::new()) };
    static RECIPE_READERS: RefCell<Slab<RecipeReader>> = const { RefCell::new(Slab::new()) };
}

/// A live MCAP video stream: a lazy cursor plus the handle of the `McapReader`
/// that backs its on-demand chunk reads. The reader stays in `MCAP_READERS`
/// for the source's lifetime, so the cursor never holds the byte source
/// itself — each `mcap_video_next_batch` re-borrows the reader to pull more.
struct McapVideoStream {
    reader: u32,
    cursor: McapVideoCursor,
}

/// i64 ns UTC timestamps frequently exceed `Number.MAX_SAFE_INTEGER`
/// (9.007e15) — e.g. 2024-01-01 lands at ~1.704e18. The default serializer
/// bails with "can't be represented as a JavaScript number" on those, so
/// every summary emits 64-bit numbers as `BigInt`. The TS worker normalises
/// through `BigInt()` regardless, so either shape is consumer-safe.
fn bigint_serializer() -> serde_wasm_bindgen::Serializer {
    serde_wasm_bindgen::Serializer::new().serialize_large_number_types_as_bigints(true)
}

// ---------------------------------------------------------------------------
// Shared summary shapes + endpoint helpers
//
// Every `*_summary` / `*_fetch_range` / `close_*` / `*_times` endpoint used to
// be a hand-written copy of the same thread-local-borrow + slab-get +
// serialise/transfer dance. These structs, helper fns, and declarative macros
// collapse that into one definition each; the macros expand to the exact same
// `#[wasm_bindgen]` functions (names and JS signatures unchanged).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ChannelInfo {
    id: String,
    name: String,
    unit: Option<String>,
    /// Channel-group label this channel belongs to, so the UI can nest
    /// MF4 channels under their group. `None` only if the id is unknown.
    group: Option<String>,
    sample_count: u64,
    start_ns: i64,
    end_ns: i64,
}

/// Summary shape for sources whose channels are all the same implicit kind
/// (MF4 / tabular / lidar / openlabel / calibration / trajectory / recipe):
/// no per-channel `kind`/`dtype` tag, just id/name/unit/group/count/range. The
/// JS store hardcodes the kind for these sources.
#[derive(Serialize)]
struct ScalarSummary {
    start_ns: i64,
    end_ns: i64,
    channels: Vec<ChannelInfo>,
}

/// MCAP channels carry heterogeneous kinds (scalar / vector / video / enum /
/// bytes), so — unlike the `ScalarSummary` sources — every entry needs an
/// explicit `kind` tag plus an optional `dtype` string. Values are the
/// lowercased `ChannelKind` / `DType` enum variants, matching
/// `docs/03-data-model.md`.
#[derive(Serialize)]
struct McapChannelInfo {
    id: String,
    name: String,
    kind: &'static str,
    dtype: Option<&'static str>,
    unit: Option<String>,
    sample_count: u64,
    start_ns: i64,
    end_ns: i64,
}

#[derive(Serialize)]
struct McapSummary {
    start_ns: i64,
    end_ns: i64,
    channels: Vec<McapChannelInfo>,
}

/// Build a kind-tagged summary (`McapSummary`) JS object from a `SourceMeta`.
/// Used by sources with heterogeneous channel kinds (mcap / ros / map). The
/// kind/dtype strings come from `data-core` so the wasm and CLI surfaces can't
/// drift.
fn mcap_summary_value(meta: &SourceMeta) -> Result<JsValue, JsError> {
    let summary = McapSummary {
        start_ns: meta.time_range.start_ns,
        end_ns: meta.time_range.end_ns,
        channels: meta
            .channels
            .iter()
            .map(|c| McapChannelInfo {
                id: c.id.clone(),
                name: c.name.clone(),
                kind: c.kind.as_str(),
                dtype: c.dtype.map(DType::as_str),
                unit: c.unit.clone(),
                sample_count: c.sample_count,
                start_ns: c.time_range.start_ns,
                end_ns: c.time_range.end_ns,
            })
            .collect(),
    };
    summary
        .serialize(&bigint_serializer())
        .map_err(|e| JsError::new(&format!("serialise summary: {e}")))
}

/// Build an untagged summary (`ScalarSummary`) JS object from a `SourceMeta`,
/// resolving each channel's `group` label via `group_fn` (always `None` except
/// for MF4). Used by sources whose channels are all the same implicit kind.
fn scalar_summary_value(
    meta: &SourceMeta,
    group_fn: impl Fn(&str) -> Option<String>,
) -> Result<JsValue, JsError> {
    let summary = ScalarSummary {
        start_ns: meta.time_range.start_ns,
        end_ns: meta.time_range.end_ns,
        channels: meta
            .channels
            .iter()
            .map(|c| ChannelInfo {
                id: c.id.clone(),
                name: c.name.clone(),
                unit: c.unit.clone(),
                group: group_fn(&c.id),
                sample_count: c.sample_count,
                start_ns: c.time_range.start_ns,
                end_ns: c.time_range.end_ns,
            })
            .collect(),
    };
    summary
        .serialize(&bigint_serializer())
        .map_err(|e| JsError::new(&format!("serialise summary: {e}")))
}

/// Copy Arrow IPC bytes into a freshly-allocated `Uint8Array` for transfer to
/// JS — the tail of every `*_fetch_range` endpoint.
fn ipc_to_uint8(bytes: &[u8]) -> Uint8Array {
    let out = Uint8Array::new_with_length(bytes.len() as u32);
    out.copy_from(bytes);
    out
}

/// Borrow the reader at `handle` from a thread-local slab and run the body over
/// it, returning the supplied `not_found` error if the handle is stale. Hides
/// the `RefCell` borrow + slab `get` + `ok_or_else` boilerplate every endpoint
/// repeated.
macro_rules! with_reader {
    ($slab:ident, $handle:expr, $not_found:expr, |$reader:ident| $body:expr) => {
        $slab.with(|cell| {
            let slab = cell.borrow();
            let $reader = slab
                .get($handle as usize)
                .ok_or_else(|| JsError::new($not_found))?;
            $body
        })
    };
}

/// Define a `close_*` endpoint that drops the reader at `handle` from `$slab`.
/// Leading `#[doc]`/attributes (`$(#[$attr])*`) pass through to the generated fn.
macro_rules! close_endpoint {
    ($(#[$attr:meta])* $name:ident, $slab:ident) => {
        $(#[$attr])*
        #[wasm_bindgen]
        pub fn $name(handle: u32) {
            $slab.with(|cell| {
                let mut slab = cell.borrow_mut();
                if slab.contains(handle as usize) {
                    slab.remove(handle as usize);
                }
            });
        }
    };
}

/// Define a `*_fetch_range` endpoint over `$slab` with the standard
/// `(handle, channel_id, start_ns, end_ns, include_prev)` signature.
macro_rules! fetch_range_endpoint {
    ($(#[$attr:meta])* $name:ident, $slab:ident, $not_found:expr) => {
        $(#[$attr])*
        #[wasm_bindgen]
        pub fn $name(
            handle: u32,
            channel_id: &str,
            start_ns: i64,
            end_ns: i64,
            include_prev: bool,
        ) -> Result<Uint8Array, JsError> {
            with_reader!($slab, handle, $not_found, |reader| {
                let bytes = reader
                    .fetch_range(
                        channel_id,
                        TimeRange { start_ns, end_ns },
                        FetchOpts { include_prev },
                    )
                    .map_err(|e| JsError::new(&format!("fetch_range failed: {e}")))?;
                Ok(ipc_to_uint8(&bytes))
            })
        }
    };
}

/// Define a `*_summary` endpoint over `$slab` that emits a `ScalarSummary`
/// (untagged, `group` always `None`).
macro_rules! scalar_summary_endpoint {
    ($(#[$attr:meta])* $name:ident, $slab:ident, $not_found:expr) => {
        $(#[$attr])*
        #[wasm_bindgen]
        pub fn $name(handle: u32) -> Result<JsValue, JsError> {
            with_reader!($slab, handle, $not_found, |reader| {
                scalar_summary_value(reader.meta(), |_| None)
            })
        }
    };
}

/// Define a `*_summary` endpoint over `$slab` that emits a kind-tagged
/// `McapSummary`.
macro_rules! mcap_summary_endpoint {
    ($(#[$attr:meta])* $name:ident, $slab:ident, $not_found:expr) => {
        $(#[$attr])*
        #[wasm_bindgen]
        pub fn $name(handle: u32) -> Result<JsValue, JsError> {
            with_reader!($slab, handle, $not_found, |reader| {
                mcap_summary_value(reader.meta())
            })
        }
    };
}

/// Define a `*_frame_times` / `*_spin_times` endpoint returning a
/// `BigInt64Array` produced by `$method` on the reader.
macro_rules! times_endpoint {
    ($(#[$attr:meta])* $name:ident, $slab:ident, $not_found:expr, $method:ident) => {
        $(#[$attr])*
        #[wasm_bindgen]
        pub fn $name(handle: u32) -> Result<js_sys::BigInt64Array, JsError> {
            with_reader!($slab, handle, $not_found, |reader| {
                let ts = reader.$method();
                let arr = js_sys::BigInt64Array::new_with_length(ts.len() as u32);
                arr.copy_from(ts);
                Ok(arr)
            })
        }
    };
}

#[wasm_bindgen]
pub fn ping() -> String {
    "pong".to_string()
}

#[wasm_bindgen]
pub fn fetch_range_stub() -> Result<Uint8Array, JsError> {
    let bytes = data_core::fixtures::arrow_scalar_ipc()
        .map_err(|e| JsError::new(&format!("fixture generation failed: {e}")))?;
    let out = Uint8Array::new_with_length(bytes.len() as u32);
    out.copy_from(&bytes);
    Ok(out)
}

/// Open an MF4 source that is read lazily through `read_range`, and register
/// the resulting `Mf4Reader` in the thread-local slab. Returns the integer
/// handle used by all other `mf4_*` endpoints.
///
/// `read_range` is a synchronous JS callback `(offset, length) => Uint8Array`
/// (worker-side, backed by an OPFS sync access handle). `file_size` is the
/// total byte length of the source, used by the index for range arithmetic.
/// The whole file is never copied into wasm memory: only metadata blocks and
/// the per-group time channels are read at open, and value channels stream on
/// demand in `mf4_fetch_range`.
#[wasm_bindgen]
pub fn open_mf4_ranged(read_fn: js_sys::Function, file_size: f64) -> Result<u32, JsError> {
    if !(file_size.is_finite() && file_size >= 0.0) {
        return Err(JsError::new("open mf4 failed: invalid file_size"));
    }
    let reader = Mf4Reader::open_ranged(
        BoxedRangeReader::new(JsRangeReader { read_fn }),
        file_size as u64,
    )
    .map_err(|e| JsError::new(&format!("open mf4 failed: {e}")))?;
    let key = READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the reader at `handle` and free its memory (index, timelines, and any
    /// cached channel values). No-op if the handle is already stale. The JS caller
    /// is responsible for closing the backing OPFS sync access handle afterwards.
    close_mf4, READERS
);

/// Drop the cached decoded values for one channel — call when a channel is
/// removed from all plots so its samples no longer occupy memory. Timestamps
/// and the index stay resident so the channel can be re-plotted cheaply.
#[wasm_bindgen]
pub fn mf4_release_channel(handle: u32, channel_id: &str) {
    READERS.with(|cell| {
        let slab = cell.borrow();
        if let Some(reader) = slab.get(handle as usize) {
            reader.release_channel(channel_id);
        }
    });
}

/// Return the reader's `SourceMeta` as a plain JS object: `{ start_ns,
/// end_ns, channels: [{ id, name, unit, group, sample_count, start_ns,
/// end_ns }] }`. JS callers parse this with standard property access; no
/// Arrow bytes here.
#[wasm_bindgen]
pub fn mf4_summary(handle: u32) -> Result<JsValue, JsError> {
    with_reader!(READERS, handle, "invalid mf4 handle", |reader| {
        scalar_summary_value(reader.meta(), |id| reader.group_label(id))
    })
}

/// Arrow IPC bytes for `[start_ns, end_ns)` of the given channel id.
/// `include_prev` controls the step-hold leading-sample option documented
/// in `docs/03-data-model.md` FetchOpts.
#[derive(Serialize)]
struct Mp4VideoChannelInfo {
    id: String,
    name: String,
    sample_count: u64,
    start_ns: i64,
    end_ns: i64,
}

#[derive(Serialize)]
struct Mp4SidecarSummary {
    start_ns: i64,
    end_ns: i64,
    channels: Vec<Mp4VideoChannelInfo>,
}

/// Parse an mp4 + sidecar pair and register the resulting `Mp4SidecarReader`
/// in the thread-local slab. The sidecar is a UTF-8 text file with no header,
/// one `<frame_index>\t<ts_ns>\n` line per mp4 video sample (see
/// `docs/05-video-pipeline.md`); length mismatch, a malformed line, or an
/// mp4 without exactly one video track fails the open with a descriptive
/// error.
#[wasm_bindgen]
pub fn open_mp4_sidecar(mp4_bytes: &[u8], sidecar_bytes: &[u8]) -> Result<u32, JsError> {
    let reader = Mp4SidecarReader::open_pair(mp4_bytes, sidecar_bytes)
        .map_err(|e| JsError::new(&format!("open mp4+sidecar failed: {e}")))?;
    let key = MP4_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the mp4+sidecar reader at `handle`. No-op if the handle is stale.
    close_mp4_sidecar, MP4_READERS
);

/// Return the reader's `SourceMeta` as a plain JS object. Video-only source;
/// channels have `kind = Video` implicitly — no `dtype` is emitted.
#[wasm_bindgen]
pub fn mp4_sidecar_summary(handle: u32) -> Result<JsValue, JsError> {
    with_reader!(
        MP4_READERS,
        handle,
        "invalid mp4+sidecar handle",
        |reader| {
            let meta = reader.meta();
            let summary = Mp4SidecarSummary {
                start_ns: meta.time_range.start_ns,
                end_ns: meta.time_range.end_ns,
                channels: meta
                    .channels
                    .iter()
                    .map(|c| Mp4VideoChannelInfo {
                        id: c.id.clone(),
                        name: c.name.clone(),
                        sample_count: c.sample_count,
                        start_ns: c.time_range.start_ns,
                        end_ns: c.time_range.end_ns,
                    })
                    .collect(),
            };
            summary
                .serialize(&bigint_serializer())
                .map_err(|e| JsError::new(&format!("serialise summary: {e}")))
        }
    )
}

/// Parse an MCAP blob and register a `McapReader` in the thread-local slab.
/// Inserts into the slab only after the parse succeeds, so a failed open never
/// leaks a handle.
#[wasm_bindgen]
pub fn open_mcap(data: &[u8]) -> Result<u32, JsError> {
    let reader =
        McapReader::open(data).map_err(|e| JsError::new(&format!("open mcap failed: {e}")))?;
    let key = MCAP_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

/// Open an MCAP source read lazily through `read_range`, registering the
/// resulting `McapReader` in the thread-local slab. Returns the integer handle
/// used by all other `mcap_*` endpoints.
///
/// `read_range` is a synchronous JS callback `(offset, length) => Uint8Array`
/// (worker-side, backed by an OPFS sync access handle or an HTTP-range XHR).
/// `file_size` is the total byte length of the source. The whole file is never
/// copied into wasm memory: only the summary section is read at open; channel
/// samples and video chunks stream on demand.
#[wasm_bindgen]
pub fn open_mcap_ranged(read_fn: js_sys::Function, file_size: f64) -> Result<u32, JsError> {
    if !(file_size.is_finite() && file_size >= 0.0) {
        return Err(JsError::new("open mcap failed: invalid file_size"));
    }
    let reader = McapReader::open_ranged(
        BoxedRangeReader::new(JsRangeReader { read_fn }),
        file_size as u64,
    )
    .map_err(|e| JsError::new(&format!("open mcap failed: {e}")))?;
    let key = MCAP_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the mcap reader at `handle`. No-op if the handle is stale.
    close_mcap, MCAP_READERS
);

mcap_summary_endpoint!(
    /// Return the mcap reader's `SourceMeta` as a plain JS object. Channel
    /// records carry an explicit `kind` (and optional `dtype`) so the JS store
    /// can route scalar / vector / video channels appropriately.
    mcap_summary, MCAP_READERS, "invalid mcap handle"
);

fetch_range_endpoint!(mf4_fetch_range, READERS, "invalid mf4 handle");

fetch_range_endpoint!(mcap_fetch_range, MCAP_READERS, "invalid mcap handle");

/// Parse a ROS 1 bag (rosbag v2.0) blob and register a `Ros1BagReader` in the
/// thread-local slab. Like `open_lidar`, the whole file is decoded in memory
/// (no ranged/OPFS path), so the JS caller can drop its copy of `data` once
/// this returns. Returns the integer handle the other `ros1_bag_*` endpoints
/// take.
#[wasm_bindgen]
pub fn open_ros1_bag(data: &[u8]) -> Result<u32, JsError> {
    let reader = Ros1BagReader::open(data)
        .map_err(|e| JsError::new(&format!("open ros1 bag failed: {e}")))?;
    let key = ROS1_BAG_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the ROS 1 bag reader at `handle`. No-op if the handle is stale.
    close_ros1_bag, ROS1_BAG_READERS
);

mcap_summary_endpoint!(
    /// Return the ROS 1 bag reader's `SourceMeta` as a plain JS object. ROS 1 bag
    /// channels carry the same `kind` / optional `dtype` shape as mcap channels, so
    /// this reuses `McapSummary` / `McapChannelInfo`.
    ros1_bag_summary, ROS1_BAG_READERS, "invalid ros1 bag handle"
);

fetch_range_endpoint!(
    ros1_bag_fetch_range,
    ROS1_BAG_READERS,
    "invalid ros1 bag handle"
);

/// Parse a ROS 2 rosbag2 SQLite (`.db3`) blob and register a `Ros2Db3Reader`
/// in the thread-local slab. Like `open_ros1_bag`, the whole file is decoded in
/// memory (no ranged/OPFS path), so the JS caller can drop its copy of `data`
/// once this returns. Returns the integer handle the other `ros2_db3_*`
/// endpoints take.
#[wasm_bindgen]
pub fn open_ros2_db3(data: &[u8]) -> Result<u32, JsError> {
    let reader = Ros2Db3Reader::open(data)
        .map_err(|e| JsError::new(&format!("open ros2 db3 failed: {e}")))?;
    let key = ROS2_DB3_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the ROS 2 db3 reader at `handle`. No-op if the handle is stale.
    close_ros2_db3, ROS2_DB3_READERS
);

mcap_summary_endpoint!(
    /// Return the ROS 2 db3 reader's `SourceMeta` as a plain JS object. ROS 2 db3
    /// channels carry the same `kind` / optional `dtype` shape as mcap channels, so
    /// this reuses `McapSummary` / `McapChannelInfo`.
    ros2_db3_summary, ROS2_DB3_READERS, "invalid ros2 db3 handle"
);

fetch_range_endpoint!(
    ros2_db3_fetch_range,
    ROS2_DB3_READERS,
    "invalid ros2 db3 handle"
);

/// Open an MCAP video stream, snapping to the keyframe at or before
/// `from_pts_ns`. Returns a handle into `VIDEO_STREAMS`; callers must
/// balance every successful open with `mcap_video_close`.
#[wasm_bindgen]
pub fn mcap_video_open(handle: u32, channel_id: &str, from_pts_ns: i64) -> Result<u32, JsError> {
    let cursor = MCAP_READERS.with(|cell| -> Result<McapVideoCursor, JsError> {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mcap handle"))?;
        reader
            .open_video_cursor(channel_id, from_pts_ns)
            .map_err(|e| JsError::new(&format!("video_stream failed: {e}")))
    })?;
    let key = VIDEO_STREAMS.with(|cell| {
        cell.borrow_mut().insert(McapVideoStream {
            reader: handle,
            cursor,
        })
    });
    u32::try_from(key).map_err(|_| JsError::new("stream handle overflowed u32"))
}

/// Pull up to `max_n` encoded access units from a video stream, returning a
/// JS array of `{ pts_ns: bigint, is_keyframe: boolean, data: Uint8Array }`.
/// An empty array signals end-of-stream; the caller should `mcap_video_close`
/// and stop polling. `max_n == 0` returns an empty array without advancing.
#[wasm_bindgen]
pub fn mcap_video_next_batch(stream_id: u32, max_n: u32) -> Result<Array, JsError> {
    // Pull on demand: re-borrow the backing reader so the cursor advances by
    // reading just the next chunk(s) rather than materialising the stream.
    let chunks = VIDEO_STREAMS.with(|sc| -> Result<Vec<EncodedChunk>, JsError> {
        let mut streams = sc.borrow_mut();
        let stream = streams
            .get_mut(stream_id as usize)
            .ok_or_else(|| JsError::new("invalid video stream handle"))?;
        MCAP_READERS.with(|rc| {
            let readers = rc.borrow();
            let reader = readers
                .get(stream.reader as usize)
                .ok_or_else(|| JsError::new("video stream's mcap reader was closed"))?;
            reader
                .video_pull(&mut stream.cursor, max_n as usize)
                .map_err(|e| JsError::new(&format!("video_pull failed: {e}")))
        })
    })?;

    // Intern the property-name strings once before the loop so each iteration
    // reuses the same JS string value instead of allocating a fresh one per
    // chunk boundary call.
    let key_pts_ns = JsValue::from_str(wasm_bindgen::intern("pts_ns"));
    let key_is_keyframe = JsValue::from_str(wasm_bindgen::intern("is_keyframe"));
    let key_data = JsValue::from_str(wasm_bindgen::intern("data"));

    let out = Array::new();
    for chunk in chunks {
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &key_pts_ns,
            &js_sys::BigInt::from(chunk.pts_ns).into(),
        )
        .map_err(|_| JsError::new("set pts_ns"))?;
        js_sys::Reflect::set(
            &obj,
            &key_is_keyframe,
            &JsValue::from_bool(chunk.is_keyframe),
        )
        .map_err(|_| JsError::new("set is_keyframe"))?;
        let data = Uint8Array::new_with_length(chunk.data.len() as u32);
        data.copy_from(&chunk.data);
        js_sys::Reflect::set(&obj, &key_data, &data.into())
            .map_err(|_| JsError::new("set data"))?;
        out.push(&obj);
    }
    Ok(out)
}

/// Drop the iterator at `stream_id`. No-op on stale handles.
#[wasm_bindgen]
pub fn mcap_video_close(stream_id: u32) {
    VIDEO_STREAMS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(stream_id as usize) {
            drop(slab.remove(stream_id as usize));
        }
    });
}

/// Return the per-sample table for an mp4+sidecar source as a plain JS
/// object. Lazy-load path: JS holds these arrays plus a reference to the
/// original `File` blob and fetches sample bytes on demand via `slice()`.
/// `pts_ns` is a `BigInt64Array`; `offsets` a `BigUint64Array`; `sizes` a
/// `Uint32Array`; `is_sync` a `Uint8Array` (0/1). `sps`/`pps` are the raw
/// NAL bytes (no start-code prefix) the JS layer prepends to the first
/// emitted Annex-B chunk per session.
#[wasm_bindgen]
pub fn mp4_sidecar_index(handle: u32) -> Result<JsValue, JsError> {
    MP4_READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mp4+sidecar handle"))?;
        let idx = reader.sample_index();
        let pts = reader.pts_ns();
        let n = idx.offsets.len();
        if idx.sizes.len() != n || idx.is_sync.len() != n || pts.len() != n {
            return Err(JsError::new("mp4 index arrays out of sync"));
        }

        // Use bulk typed-array copies so the entire slice crosses the wasm–JS
        // boundary in one memcpy rather than N individual boundary calls (each
        // of which allocates a JS BigInt for the 64-bit arrays).  For ~1e5
        // samples this is 10–100× faster than set_index loops.
        let pts_arr = js_sys::BigInt64Array::new_with_length(n as u32);
        pts_arr.copy_from(pts);
        let off_arr = js_sys::BigUint64Array::new_with_length(n as u32);
        off_arr.copy_from(&idx.offsets);
        let size_arr = js_sys::Uint32Array::new_with_length(n as u32);
        size_arr.copy_from(&idx.sizes);
        // is_sync is Vec<bool>; collect into a Vec<u8> (one alloc of N bytes)
        // before the single bulk copy — far cheaper than N set_index calls.
        let sync_bytes: Vec<u8> = idx.is_sync.iter().map(|&b| b as u8).collect();
        let sync_arr = Uint8Array::new_with_length(n as u32);
        sync_arr.copy_from(&sync_bytes);

        let sps_arr = Uint8Array::new_with_length(reader.sps().len() as u32);
        sps_arr.copy_from(reader.sps());
        let pps_arr = Uint8Array::new_with_length(reader.pps().len() as u32);
        pps_arr.copy_from(reader.pps());

        let channel_id = reader
            .meta()
            .channels
            .first()
            .map(|c| c.id.clone())
            .unwrap_or_default();

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("channel_id"),
            &JsValue::from_str(&channel_id),
        )
        .map_err(|_| JsError::new("set channel_id"))?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("pts_ns"), &pts_arr.into())
            .map_err(|_| JsError::new("set pts_ns"))?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("offsets"), &off_arr.into())
            .map_err(|_| JsError::new("set offsets"))?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("sizes"), &size_arr.into())
            .map_err(|_| JsError::new("set sizes"))?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("is_sync"), &sync_arr.into())
            .map_err(|_| JsError::new("set is_sync"))?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("sps"), &sps_arr.into())
            .map_err(|_| JsError::new("set sps"))?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("pps"), &pps_arr.into())
            .map_err(|_| JsError::new("set pps"))?;
        Ok(JsValue::from(obj))
    })
}

// ---------------------------------------------------------------------------
// Tabular (CSV / Parquet)
// ---------------------------------------------------------------------------

/// Inspect a CSV or Parquet blob without retaining it: returns a
/// `TabularSchema` JSON object `{ columns: [{ name, dtype, is_numeric }],
/// suggested: TimeBasis }`. `TimeBasis` serialises as `{ time_column, unit,
/// mode, epoch_offset_ns }` where `unit` is one of `"Nanos" | "Micros" |
/// "Millis" | "Seconds"`, `mode` is `"Absolute" | "Relative"`, and
/// `epoch_offset_ns` is a BigInt. `format` is `"csv"` or `"parquet"`.
#[wasm_bindgen]
pub fn tabular_inspect(bytes: &[u8], format: &str) -> Result<JsValue, JsError> {
    let fmt = data_core::tabular::format_from_str(format)
        .map_err(|e| JsError::new(&format!("tabular_inspect failed: {e}")))?;
    let schema = data_core::tabular::inspect(bytes, fmt)
        .map_err(|e| JsError::new(&format!("tabular_inspect failed: {e}")))?;
    schema
        .serialize(&bigint_serializer())
        .map_err(|e| JsError::new(&format!("serialise tabular schema: {e}")))
}

/// Open a CSV or Parquet blob with an explicit `TimeBasis` (JSON, the same
/// shape `tabular_inspect` emits under `suggested`) and register the resulting
/// `TabularReader` in the thread-local slab. Returns the integer handle used by
/// the other `tabular_*` endpoints. `format` is `"csv"` or `"parquet"`.
#[wasm_bindgen]
pub fn open_tabular(bytes: &[u8], format: &str, basis_json: &str) -> Result<u32, JsError> {
    let fmt = data_core::tabular::format_from_str(format)
        .map_err(|e| JsError::new(&format!("open tabular failed: {e}")))?;
    let basis: TimeBasis = serde_json::from_str(basis_json)
        .map_err(|e| JsError::new(&format!("open tabular failed: invalid basis JSON: {e}")))?;
    let reader = TabularReader::open_with_basis(bytes, fmt, basis)
        .map_err(|e| JsError::new(&format!("open tabular failed: {e}")))?;
    let key = TABULAR_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the tabular reader at `handle`. No-op if the handle is stale.
    close_tabular, TABULAR_READERS
);

scalar_summary_endpoint!(
    /// Return the tabular reader's `SourceMeta` as a plain JS object. Every
    /// surfaced channel is a `Scalar` / `Float64` signal, so — like the MF4
    /// summary — no per-channel `kind`/`dtype` tag is emitted; the shape is
    /// `{ start_ns, end_ns, channels: [{ id, name, unit, sample_count, start_ns,
    /// end_ns }] }`.
    tabular_summary, TABULAR_READERS, "invalid tabular handle"
);

fetch_range_endpoint!(
    /// Arrow IPC bytes for `[start_ns, end_ns)` of the given tabular channel id
    /// (the column name). `include_prev` controls the step-hold leading-sample
    /// option documented in `docs/03-data-model.md` FetchOpts.
    tabular_fetch_range, TABULAR_READERS, "invalid tabular handle"
);

/// The converted time column (ns-UTC, ascending) of a tabular source, as a
/// `BigInt64Array`. Used to derive per-frame video timestamps from a
/// camera-frames table (row i -> sample i) without a `.mp4.timestamps` sidecar.
#[wasm_bindgen]
pub fn tabular_time_column_ns(handle: u32) -> Result<js_sys::BigInt64Array, JsError> {
    TABULAR_READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid tabular handle"))?;
        let ts = reader.time_ns();
        let arr = js_sys::BigInt64Array::new_with_length(ts.len() as u32);
        arr.copy_from(ts);
        Ok(arr)
    })
}

// ---------------------------------------------------------------------------
// LiDAR / point cloud (Driveline point-cloud Parquet)
// ---------------------------------------------------------------------------

/// Open a Driveline point-cloud Parquet (one row per LiDAR spin) and register
/// the resulting `PointCloudReader` in the thread-local slab. Returns the
/// integer handle the other `lidar_*` endpoints take. The decoded per-spin
/// point buffers stay resident for the source's lifetime (freed by
/// `close_lidar`); the JS caller can drop its copy of `bytes` once this
/// returns.
///
/// Takes the buffer **by value**: `open_owned` wraps the wasm-side copy
/// without duplicating it, and the decode streams small row batches — so a
/// full-density clip (~52M points / hundreds of MB) peaks around `file +
/// spins`, not the 2×+ that used to trap the wasm heap.
#[wasm_bindgen]
pub fn open_lidar(bytes: Vec<u8>) -> Result<u32, JsError> {
    let reader = PointCloudReader::open_owned(bytes)
        .map_err(|e| JsError::new(&format!("open lidar failed: {e}")))?;
    let key = LIDAR_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

/// Open a **PCD** (Point Cloud Data) file — the PCL/ROS LiDAR interchange
/// format — and register the resulting `PointCloudReader` in the same slab as
/// `open_lidar`. A PCD holds a single cloud, so the source surfaces one
/// point-cloud channel with one spin (at `t = 0`); every other `lidar_*`
/// endpoint then works unchanged. Supports `ascii`, `binary`, and
/// `binary_compressed` payloads — see `data-core`'s `pcd` module.
#[wasm_bindgen]
pub fn open_lidar_pcd(bytes: &[u8]) -> Result<u32, JsError> {
    let reader = PointCloudReader::open_pcd(bytes)
        .map_err(|e| JsError::new(&format!("open pcd failed: {e}")))?;
    let key = LIDAR_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

/// Open a **raw NVIDIA Alpamayo LiDAR** Parquet (Draco-compressed spins,
/// `spin_start_timestamp` + `draco_encoded_pointcloud`) and register the
/// resulting `PointCloudReader` in the same slab as `open_lidar`, so every other
/// `lidar_*` endpoint then works unchanged — no pre-conversion step.
///
/// `data-core` deliberately ships no Draco decoder (the codec is a large C++
/// library that would blow the WASM size budget), so the per-spin blob decode is
/// delegated to `decode`, a JS callback backed by Google's reference Draco
/// decoder compiled to WASM and loaded **lazily** only when a raw clip is
/// dropped. The callback is `(blob: Uint8Array) => { positions: Float32Array,
/// intensities: Uint8Array }` — flattened xyz (len `3N`, metres) and per-point
/// intensity (len `N`, `0..=255`). It is invoked once per spin, synchronously,
/// from inside the parquet stream (so the JS Draco module must already be
/// initialised before this is called).
///
/// `sensor` names the channel (defaults to `lidar_top_360fov`). Takes the
/// parquet bytes **by value** so the wasm-side copy isn't duplicated.
#[wasm_bindgen]
pub fn open_alpamayo_lidar(
    bytes: Vec<u8>,
    decode: &js_sys::Function,
    sensor: Option<String>,
) -> Result<u32, JsError> {
    let reader = PointCloudReader::open_alpamayo_parquet(bytes, sensor, |blob| {
        // Copy the blob into a fresh Uint8Array (not a `view`): calling into JS
        // may grow wasm memory and invalidate a borrowed view.
        let arg = Uint8Array::new_with_length(blob.len() as u32);
        arg.copy_from(blob);
        let ret = decode
            .call1(&JsValue::NULL, &arg)
            .map_err(|e| format!("js error: {e:?}"))?;
        let positions = js_sys::Reflect::get(&ret, &JsValue::from_str("positions"))
            .ok()
            .and_then(|v| v.dyn_into::<js_sys::Float32Array>().ok())
            .ok_or_else(|| "decode result missing Float32Array `positions`".to_string())?
            .to_vec();
        let intensities = js_sys::Reflect::get(&ret, &JsValue::from_str("intensities"))
            .ok()
            .and_then(|v| v.dyn_into::<Uint8Array>().ok())
            .ok_or_else(|| "decode result missing Uint8Array `intensities`".to_string())?
            .to_vec();
        Ok((positions, intensities))
    })
    .map_err(|e| JsError::new(&format!("open alpamayo lidar failed: {e}")))?;
    let key = LIDAR_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the lidar reader at `handle`. No-op if the handle is stale.
    close_lidar, LIDAR_READERS
);

scalar_summary_endpoint!(
    /// Return the lidar reader's `SourceMeta` as a plain JS object. A point-cloud
    /// source surfaces exactly one channel; like the MF4 summary the kind is
    /// implicit (the JS store hardcodes `point_cloud`), so the shape reuses the
    /// MF4 summary layout (`group` always null, `sample_count` = peak points/spin).
    lidar_summary, LIDAR_READERS, "invalid lidar handle"
);

fetch_range_endpoint!(
    /// Arrow IPC bytes for the spins overlapping `[start_ns, end_ns)` of the given
    /// point-cloud channel. The 3D scene panel passes a zero/one-width window plus
    /// `include_prev` to fetch exactly the spin active at the cursor. The emitted
    /// schema is `{ ts: Timestamp(ns), positions: List<Float32>, intensities:
    /// List<Float32> }` (one row per spin) — see `pointcloud.rs`.
    lidar_fetch_range, LIDAR_READERS, "invalid lidar handle"
);

times_endpoint!(
    /// Ascending spin start timestamps (ns) of a point-cloud source, as a
    /// `BigInt64Array` — one entry per frame. The scene panel binary-searches this
    /// locally to map the cursor to a spin index, so it only refetches point data
    /// when the active spin changes (not once per cursor tick).
    lidar_spin_times,
    LIDAR_READERS,
    "invalid lidar handle",
    spin_times
);

// ---------------------------------------------------------------------------
// OpenLABEL (ASAM OpenLABEL JSON — 3D cuboid bounding boxes)
// ---------------------------------------------------------------------------

/// Open an ASAM OpenLABEL JSON file of 3D cuboid annotations and register the
/// resulting `OpenLabelReader` in the thread-local slab. Returns the integer
/// handle the other `openlabel_*` endpoints take. The source surfaces one
/// `bounding_box` channel (one frame's worth of oriented boxes per sample).
///
/// Takes the buffer **by value**: `open_owned` parses it directly without a
/// second copy.
#[wasm_bindgen]
pub fn open_openlabel(bytes: Vec<u8>) -> Result<u32, JsError> {
    let reader = OpenLabelReader::open_owned(bytes)
        .map_err(|e| JsError::new(&format!("open openlabel failed: {e}")))?;
    let key = OPENLABEL_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the openlabel reader at `handle`. No-op if the handle is stale.
    close_openlabel, OPENLABEL_READERS
);

scalar_summary_endpoint!(
    /// Return the openlabel reader's `SourceMeta` as a plain JS object. An
    /// OpenLABEL source surfaces exactly one `bounding_box` channel; the shape
    /// reuses the MF4/lidar summary layout (`group` always null, `sample_count` =
    /// peak boxes-per-frame). 64-bit numbers serialise as `BigInt`.
    openlabel_summary,
    OPENLABEL_READERS,
    "invalid openlabel handle"
);

fetch_range_endpoint!(
    /// Arrow IPC bytes for the frames overlapping `[start_ns, end_ns)` of the given
    /// bounding-box channel. The 3D scene panel passes a zero/one-width window plus
    /// `include_prev` to fetch exactly the frame active at the cursor. The emitted
    /// schema is `{ ts: Timestamp(ns), centers: List<Float32>, sizes:
    /// List<Float32>, rotations: List<Float32>, labels: List<Utf8> }` (one row per
    /// frame) — see `openlabel.rs`.
    openlabel_fetch_range,
    OPENLABEL_READERS,
    "invalid openlabel handle"
);

times_endpoint!(
    /// Ascending frame timestamps (ns) of an OpenLABEL source, as a
    /// `BigInt64Array` — one entry per frame. The scene panel binary-searches this
    /// locally to map the cursor to a frame index, so it only refetches box data
    /// when the active frame changes (not once per cursor tick).
    openlabel_frame_times,
    OPENLABEL_READERS,
    "invalid openlabel handle",
    frame_times
);

// ---------------------------------------------------------------------------
// Calibration (driveline.calibration/v1 — camera ↔ LiDAR calibration)
// ---------------------------------------------------------------------------

/// Open a `driveline.calibration/v1` JSON file (camera calibrations) and
/// register the resulting `CalibrationReader` in the thread-local slab. Returns
/// the integer handle the other `calibration_*` endpoints take. The source
/// surfaces one `camera_calibration` channel carrying every camera (one row per
/// camera on fetch).
///
/// `open_owned` validates the `"schema": "driveline.calibration/v1"` marker, so
/// a non-calibration `.json` is rejected here rather than mis-decoded. Takes the
/// buffer **by value** to parse it without a second copy.
#[wasm_bindgen]
pub fn open_calibration(bytes: Vec<u8>) -> Result<u32, JsError> {
    let reader = CalibrationReader::open_owned(bytes)
        .map_err(|e| JsError::new(&format!("open calibration failed: {e}")))?;
    let key = CALIBRATION_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the calibration reader at `handle`. No-op if the handle is stale.
    close_calibration, CALIBRATION_READERS
);

scalar_summary_endpoint!(
    /// Return the calibration reader's `SourceMeta` as a plain JS object. A
    /// calibration source surfaces exactly one `camera_calibration` channel; the
    /// shape reuses the MF4/lidar summary layout (`group` always null,
    /// `sample_count` = camera count). 64-bit numbers serialise as `BigInt`.
    calibration_summary,
    CALIBRATION_READERS,
    "invalid calibration handle"
);

/// Arrow IPC bytes for the calibration channel. Calibration is **config, not a
/// time series**: there is no range — every camera is always returned, one row
/// each. The emitted schema is `{ name: Utf8, intrinsics: List<Float32>,
/// resolution: List<Int32>, distortion: List<Float32>, translation:
/// List<Float32>, quaternion: List<Float32> }` (one row per camera) — see
/// `calibration.rs` and `docs/13-camera-lidar-calibration.md`.
#[wasm_bindgen]
pub fn calibration_fetch_range(handle: u32, channel_id: &str) -> Result<Uint8Array, JsError> {
    with_reader!(
        CALIBRATION_READERS,
        handle,
        "invalid calibration handle",
        |reader| {
            let bytes = reader
                .fetch_range(channel_id, TimeRange::empty(), FetchOpts::default())
                .map_err(|e| JsError::new(&format!("fetch_range failed: {e}")))?;
            Ok(ipc_to_uint8(&bytes))
        }
    )
}

// ---------------------------------------------------------------------------
// Trajectory (predicted ego future trajectories — Alpamayo-style polylines)
// ---------------------------------------------------------------------------

/// Open a Driveline `*.trajectory.json` file of per-frame predicted ego future
/// trajectories and register the resulting `TrajectoryReader` in the
/// thread-local slab. Returns the integer handle the other `trajectory_*`
/// endpoints take. The source surfaces one `trajectory` channel (one frame's
/// worth of candidate waypoint polylines per sample).
///
/// Takes the buffer **by value**: `open_owned` parses it directly without a
/// second copy.
#[wasm_bindgen]
pub fn open_trajectory(bytes: Vec<u8>) -> Result<u32, JsError> {
    let reader = TrajectoryReader::open_owned(bytes)
        .map_err(|e| JsError::new(&format!("open trajectory failed: {e}")))?;
    let key = TRAJECTORY_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the trajectory reader at `handle`. No-op if the handle is stale.
    close_trajectory, TRAJECTORY_READERS
);

scalar_summary_endpoint!(
    /// Return the trajectory reader's `SourceMeta` as a plain JS object. A
    /// trajectory source surfaces exactly one `trajectory` channel; the shape
    /// reuses the MF4/lidar summary layout (`group` always null, `sample_count` =
    /// peak paths-per-frame). 64-bit numbers serialise as `BigInt`.
    trajectory_summary,
    TRAJECTORY_READERS,
    "invalid trajectory handle"
);

fetch_range_endpoint!(
    /// Arrow IPC bytes for the frames overlapping `[start_ns, end_ns)` of the given
    /// trajectory channel. The 3D scene panel passes a zero/one-width window plus
    /// `include_prev` to fetch exactly the frame active at the cursor. The emitted
    /// schema is `{ ts: Timestamp(ns), points: List<Float32>, path_lengths:
    /// List<Int32>, confidences: List<Float32> }` (one row per frame) — see
    /// `trajectory.rs`.
    trajectory_fetch_range,
    TRAJECTORY_READERS,
    "invalid trajectory handle"
);

times_endpoint!(
    /// Ascending frame timestamps (ns) of a trajectory source, as a
    /// `BigInt64Array` — one entry per frame. The scene panel binary-searches this
    /// locally to map the cursor to a frame index, so it only refetches trajectory
    /// data when the active frame changes (not once per cursor tick).
    trajectory_frame_times,
    TRAJECTORY_READERS,
    "invalid trajectory handle",
    frame_times
);

// ---------------------------------------------------------------------------
// Map geometry (road network — OpenDRIVE .xodr or simple `drivelineMap` JSON)
// ---------------------------------------------------------------------------

/// Open a road-network "map" (OpenDRIVE `.xodr` XML or the simple `drivelineMap`
/// JSON format — auto-detected by the first non-whitespace byte) and register
/// the resulting `MapGeometryReader` in the thread-local slab. Returns the
/// integer handle the other `map_geometry_*` endpoints take. The source surfaces
/// one `map_geometry` channel: a single static frame of typed polylines.
///
/// Takes the buffer **by value**: `open_owned` parses it directly without a
/// second copy.
#[wasm_bindgen]
pub fn open_map_geometry(bytes: Vec<u8>) -> Result<u32, JsError> {
    let reader = MapGeometryReader::open_owned(bytes)
        .map_err(|e| JsError::new(&format!("open map geometry failed: {e}")))?;
    let key = MAP_GEOMETRY_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the map-geometry reader at `handle`. No-op if the handle is stale.
    close_map_geometry, MAP_GEOMETRY_READERS
);

mcap_summary_endpoint!(
    /// Return the map-geometry reader's `SourceMeta` as a plain JS object. A map
    /// source surfaces exactly one `map_geometry` channel; the shape reuses the
    /// MF4/lidar summary layout (`group` always null, `sample_count` = polyline
    /// count). Channels carry an explicit `kind` (`"map_geometry"`) so the JS
    /// normaliser routes them to the scene panel. 64-bit numbers serialise as
    /// `BigInt`.
    map_geometry_summary,
    MAP_GEOMETRY_READERS,
    "invalid map geometry handle"
);

fetch_range_endpoint!(
    /// Arrow IPC bytes for the frames overlapping `[start_ns, end_ns)` of the given
    /// map-geometry channel. A map is a single static frame at `t = 0`; the scene
    /// panel passes a zero/one-width window plus `include_prev` to fetch it. The
    /// emitted schema is `{ ts: Timestamp(ns), points: List<Float32>, path_lengths:
    /// List<Int32>, types: List<Utf8> }` (one row per frame) — see
    /// `map_geometry.rs`.
    map_geometry_fetch_range,
    MAP_GEOMETRY_READERS,
    "invalid map geometry handle"
);

times_endpoint!(
    /// Ascending frame timestamps (ns) of a map-geometry source, as a
    /// `BigInt64Array` — always a single entry `[0]` (a map is static). The scene
    /// panel reads frame 0 to fetch the road network once. Mirrors
    /// `openlabel_frame_times`.
    map_geometry_frame_times,
    MAP_GEOMETRY_READERS,
    "invalid map geometry handle",
    frame_times
);

// ---------------------------------------------------------------------------
// Recipe (Format Agent — declarative decode of an unknown format)
// ---------------------------------------------------------------------------

/// Dry-run a candidate recipe against (a bounded prefix of) `bytes` and return a
/// `DryRunReport` JSON object without retaining the source. This is the Format
/// Agent's `validate_recipe` feedback signal (`docs/12-format-agent.md` §4.4):
/// it decodes at most `budget` records, never panics, and never allocates past
/// the budget. `budget` of 0 is treated as "no records".
#[wasm_bindgen]
pub fn recipe_dry_run(bytes: &[u8], recipe_json: &str, budget: u32) -> Result<JsValue, JsError> {
    let report = RecipeReader::dry_run(bytes, recipe_json, budget)
        .map_err(|e| JsError::new(&format!("recipe dry run failed: {e}")))?;
    report
        .serialize(&bigint_serializer())
        .map_err(|e| JsError::new(&format!("serialise dry-run report: {e}")))
}

/// Open `bytes` with the given Ingest Recipe (JSON) and register the resulting
/// `RecipeReader` in the thread-local slab. Returns the integer handle the other
/// `recipe_*` endpoints take. Every channel surfaces as a `Scalar` / `Float64`
/// series, so the JS store treats a recipe source exactly like a tabular one.
#[wasm_bindgen]
pub fn open_recipe(bytes: &[u8], recipe_json: &str) -> Result<u32, JsError> {
    let reader = RecipeReader::open(bytes, recipe_json)
        .map_err(|e| JsError::new(&format!("open recipe failed: {e}")))?;
    let key = RECIPE_READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

close_endpoint!(
    /// Drop the recipe reader at `handle`. No-op if the handle is stale.
    close_recipe, RECIPE_READERS
);

scalar_summary_endpoint!(
    /// Return the recipe reader's `SourceMeta` as a plain JS object — the same shape
    /// `tabular_summary` emits (`{ start_ns, end_ns, channels: [{ id, name, unit,
    /// group, sample_count, start_ns, end_ns }] }`), since every recipe channel is a
    /// scalar f64 signal.
    recipe_summary, RECIPE_READERS, "invalid recipe handle"
);

fetch_range_endpoint!(
    /// Arrow IPC bytes for `[start_ns, end_ns)` of the given recipe channel id.
    /// `include_prev` controls the step-hold leading-sample option documented in
    /// `docs/03-data-model.md` FetchOpts.
    recipe_fetch_range, RECIPE_READERS, "invalid recipe handle"
);
