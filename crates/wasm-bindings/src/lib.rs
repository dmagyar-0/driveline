//! Thin wasm-bindgen surface exposing `data-core` to the browser worker.
//!
//! M1 wiring (ping / Arrow IPC stub) stays for the Playwright smoke tests.
//! M2 T2.2 adds an MF4 surface: `open_mf4` parses a byte slice and returns
//! a handle into a thread-local slab, `mf4_*` accessors read from that
//! handle, `close_mf4` releases it. All heavy data (Arrow IPC, channel
//! list JSON) crosses the wasm-JS boundary as `Uint8Array` / `JsValue`.

use std::cell::RefCell;

use data_core::{
    BoxedRangeReader, ByteRangeReader, ChannelKind, DType, EncodedChunk, FetchOpts, McapReader,
    McapVideoCursor, MdfError, Mf4Reader, Mp4SidecarReader, Reader, TabularReader, TimeBasis,
    TimeRange,
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

/// Drop the reader at `handle` and free its memory (index, timelines, and any
/// cached channel values). No-op if the handle is already stale. The JS caller
/// is responsible for closing the backing OPFS sync access handle afterwards.
#[wasm_bindgen]
pub fn close_mf4(handle: u32) {
    READERS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(handle as usize) {
            slab.remove(handle as usize);
        }
    });
}

/// Drop the cached decoded values for one channel — call when a channel is
/// removed from all plots so its samples no longer occupy memory. Timestamps
/// and the index stay resident so the channel can be re-plotted cheaply.
#[wasm_bindgen]
pub fn mf4_release_channel(handle: u32, channel_id: &str) {
    READERS.with(|cell| {
        let slab = cell.borrow();
        if let Some(reader) = slab.get(handle as usize) {
            reader.release_channel(&channel_id.to_string());
        }
    });
}

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

#[derive(Serialize)]
struct Mf4Summary {
    start_ns: i64,
    end_ns: i64,
    channels: Vec<ChannelInfo>,
}

/// Return the reader's `SourceMeta` as a plain JS object: `{ start_ns,
/// end_ns, channels: [{ id, name, unit, group, sample_count, start_ns,
/// end_ns }] }`. JS callers parse this with standard property access; no
/// Arrow bytes here.
#[wasm_bindgen]
pub fn mf4_summary(handle: u32) -> Result<JsValue, JsError> {
    READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mf4 handle"))?;
        let meta = reader.meta();
        let summary = Mf4Summary {
            start_ns: meta.time_range.start_ns,
            end_ns: meta.time_range.end_ns,
            channels: meta
                .channels
                .iter()
                .map(|c| ChannelInfo {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    unit: c.unit.clone(),
                    group: reader.group_label(&c.id),
                    sample_count: c.sample_count,
                    start_ns: c.time_range.start_ns,
                    end_ns: c.time_range.end_ns,
                })
                .collect(),
        };
        summary
            .serialize(&bigint_serializer())
            .map_err(|e| JsError::new(&format!("serialise summary: {e}")))
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

/// Drop the mp4+sidecar reader at `handle`. No-op if the handle is stale.
#[wasm_bindgen]
pub fn close_mp4_sidecar(handle: u32) {
    MP4_READERS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(handle as usize) {
            slab.remove(handle as usize);
        }
    });
}

/// Return the reader's `SourceMeta` as a plain JS object. Video-only source;
/// channels have `kind = Video` implicitly — no `dtype` is emitted.
#[wasm_bindgen]
pub fn mp4_sidecar_summary(handle: u32) -> Result<JsValue, JsError> {
    MP4_READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mp4+sidecar handle"))?;
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
    })
}

/// MCAP channels carry heterogeneous kinds (scalar / vector / video / enum /
/// bytes), so — unlike the MF4 and MP4+sidecar summaries — every entry needs
/// an explicit `kind` tag plus an optional `dtype` string. Values are the
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

fn channel_kind_str(k: ChannelKind) -> &'static str {
    match k {
        ChannelKind::Scalar => "scalar",
        ChannelKind::Vector => "vector",
        ChannelKind::Video => "video",
        ChannelKind::Enum => "enum",
        ChannelKind::Bytes => "bytes",
    }
}

fn dtype_str(d: DType) -> &'static str {
    match d {
        DType::F32 => "f32",
        DType::F64 => "f64",
        DType::I32 => "i32",
        DType::I64 => "i64",
        DType::U32 => "u32",
        DType::U64 => "u64",
    }
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

/// Drop the mcap reader at `handle`. No-op if the handle is stale.
#[wasm_bindgen]
pub fn close_mcap(handle: u32) {
    MCAP_READERS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(handle as usize) {
            slab.remove(handle as usize);
        }
    });
}

/// Return the mcap reader's `SourceMeta` as a plain JS object. Channel
/// records carry an explicit `kind` (and optional `dtype`) so the JS store
/// can route scalar / vector / video channels appropriately.
#[wasm_bindgen]
pub fn mcap_summary(handle: u32) -> Result<JsValue, JsError> {
    MCAP_READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mcap handle"))?;
        let meta = reader.meta();
        let summary = McapSummary {
            start_ns: meta.time_range.start_ns,
            end_ns: meta.time_range.end_ns,
            channels: meta
                .channels
                .iter()
                .map(|c| McapChannelInfo {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    kind: channel_kind_str(c.kind),
                    dtype: c.dtype.map(dtype_str),
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
    })
}

#[wasm_bindgen]
pub fn mf4_fetch_range(
    handle: u32,
    channel_id: &str,
    start_ns: i64,
    end_ns: i64,
    include_prev: bool,
) -> Result<Uint8Array, JsError> {
    READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mf4 handle"))?;
        let bytes = reader
            .fetch_range(
                &channel_id.to_string(),
                TimeRange { start_ns, end_ns },
                FetchOpts { include_prev },
            )
            .map_err(|e| JsError::new(&format!("fetch_range failed: {e}")))?;
        let out = Uint8Array::new_with_length(bytes.len() as u32);
        out.copy_from(&bytes);
        Ok(out)
    })
}

#[wasm_bindgen]
pub fn mcap_fetch_range(
    handle: u32,
    channel_id: &str,
    start_ns: i64,
    end_ns: i64,
    include_prev: bool,
) -> Result<Uint8Array, JsError> {
    MCAP_READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mcap handle"))?;
        let bytes = reader
            .fetch_range(
                &channel_id.to_string(),
                TimeRange { start_ns, end_ns },
                FetchOpts { include_prev },
            )
            .map_err(|e| JsError::new(&format!("fetch_range failed: {e}")))?;
        let out = Uint8Array::new_with_length(bytes.len() as u32);
        out.copy_from(&bytes);
        Ok(out)
    })
}

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
            .open_video_cursor(&channel_id.to_string(), from_pts_ns)
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

    let out = Array::new();
    for chunk in chunks {
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("pts_ns"),
            &js_sys::BigInt::from(chunk.pts_ns).into(),
        )
        .map_err(|_| JsError::new("set pts_ns"))?;
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("is_keyframe"),
            &JsValue::from_bool(chunk.is_keyframe),
        )
        .map_err(|_| JsError::new("set is_keyframe"))?;
        let data = Uint8Array::new_with_length(chunk.data.len() as u32);
        data.copy_from(&chunk.data);
        js_sys::Reflect::set(&obj, &JsValue::from_str("data"), &data.into())
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

        // Use raw typed-array writes so we don't allocate an intermediate
        // `Vec` per array of length N (videos can have ~1e5 samples).
        let pts_arr = js_sys::BigInt64Array::new_with_length(n as u32);
        for (i, &v) in pts.iter().enumerate() {
            pts_arr.set_index(i as u32, v);
        }
        let off_arr = js_sys::BigUint64Array::new_with_length(n as u32);
        for (i, &v) in idx.offsets.iter().enumerate() {
            off_arr.set_index(i as u32, v);
        }
        let size_arr = js_sys::Uint32Array::new_with_length(n as u32);
        for (i, &v) in idx.sizes.iter().enumerate() {
            size_arr.set_index(i as u32, v);
        }
        let sync_arr = Uint8Array::new_with_length(n as u32);
        for (i, &b) in idx.is_sync.iter().enumerate() {
            sync_arr.set_index(i as u32, b as u8);
        }

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

/// Drop the tabular reader at `handle`. No-op if the handle is stale.
#[wasm_bindgen]
pub fn close_tabular(handle: u32) {
    TABULAR_READERS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(handle as usize) {
            slab.remove(handle as usize);
        }
    });
}

/// Return the tabular reader's `SourceMeta` as a plain JS object. Every
/// surfaced channel is a `Scalar` / `Float64` signal, so — like the MF4
/// summary — no per-channel `kind`/`dtype` tag is emitted; the shape is
/// `{ start_ns, end_ns, channels: [{ id, name, unit, sample_count, start_ns,
/// end_ns }] }`.
#[wasm_bindgen]
pub fn tabular_summary(handle: u32) -> Result<JsValue, JsError> {
    TABULAR_READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid tabular handle"))?;
        let meta = reader.meta();
        let summary = Mf4Summary {
            start_ns: meta.time_range.start_ns,
            end_ns: meta.time_range.end_ns,
            channels: meta
                .channels
                .iter()
                .map(|c| ChannelInfo {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    unit: c.unit.clone(),
                    group: None,
                    sample_count: c.sample_count,
                    start_ns: c.time_range.start_ns,
                    end_ns: c.time_range.end_ns,
                })
                .collect(),
        };
        summary
            .serialize(&bigint_serializer())
            .map_err(|e| JsError::new(&format!("serialise summary: {e}")))
    })
}

/// Arrow IPC bytes for `[start_ns, end_ns)` of the given tabular channel id
/// (the column name). `include_prev` controls the step-hold leading-sample
/// option documented in `docs/03-data-model.md` FetchOpts.
#[wasm_bindgen]
pub fn tabular_fetch_range(
    handle: u32,
    channel_id: &str,
    start_ns: i64,
    end_ns: i64,
    include_prev: bool,
) -> Result<Uint8Array, JsError> {
    TABULAR_READERS.with(|cell| {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid tabular handle"))?;
        let bytes = reader
            .fetch_range(
                &channel_id.to_string(),
                TimeRange { start_ns, end_ns },
                FetchOpts { include_prev },
            )
            .map_err(|e| JsError::new(&format!("fetch_range failed: {e}")))?;
        let out = Uint8Array::new_with_length(bytes.len() as u32);
        out.copy_from(&bytes);
        Ok(out)
    })
}
