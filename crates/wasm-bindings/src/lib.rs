//! Thin wasm-bindgen surface exposing `data-core` to the browser worker.
//!
//! M1 wiring (ping / Arrow IPC stub) stays for the Playwright smoke tests.
//! M2 T2.2 adds an MF4 surface: `open_mf4` parses a byte slice and returns
//! a handle into a thread-local slab, `mf4_*` accessors read from that
//! handle, `close_mf4` releases it. All heavy data (Arrow IPC, channel
//! list JSON) crosses the wasm-JS boundary as `Uint8Array` / `JsValue`.

use std::cell::RefCell;

use data_core::{
    ChannelKind, DType, EncodedChunkIter, FetchOpts, McapReader, Mf4Reader, Mp4SidecarReader,
    Reader, TimeRange,
};
use js_sys::{Array, Uint8Array};
use serde::Serialize;
use slab::Slab;
use wasm_bindgen::prelude::*;

thread_local! {
    static READERS: RefCell<Slab<Mf4Reader>> = const { RefCell::new(Slab::new()) };
    static MP4_READERS: RefCell<Slab<Mp4SidecarReader>> = const { RefCell::new(Slab::new()) };
    static MCAP_READERS: RefCell<Slab<McapReader>> = const { RefCell::new(Slab::new()) };
    static VIDEO_STREAMS: RefCell<Slab<EncodedChunkIter>> = const { RefCell::new(Slab::new()) };
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

/// Parse an MF4 blob and register an `Mf4Reader` in the thread-local slab.
/// Returns the integer handle, used by all other `mf4_*` endpoints.
#[wasm_bindgen]
pub fn open_mf4(data: &[u8]) -> Result<u32, JsError> {
    let reader =
        Mf4Reader::open(data).map_err(|e| JsError::new(&format!("open mf4 failed: {e}")))?;
    let key = READERS.with(|cell| cell.borrow_mut().insert(reader));
    u32::try_from(key).map_err(|_| JsError::new("reader handle overflowed u32"))
}

/// Drop the reader at `handle` and free its memory. No-op if the handle
/// is already stale.
#[wasm_bindgen]
pub fn close_mf4(handle: u32) {
    READERS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(handle as usize) {
            slab.remove(handle as usize);
        }
    });
}

#[derive(Serialize)]
struct ChannelInfo {
    id: String,
    name: String,
    unit: Option<String>,
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
/// end_ns, channels: [{ id, name, unit, sample_count, start_ns, end_ns }] }`.
/// JS callers parse this with standard property access; no Arrow bytes here.
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
                    sample_count: c.sample_count,
                    start_ns: c.time_range.start_ns,
                    end_ns: c.time_range.end_ns,
                })
                .collect(),
        };
        summary.serialize(&bigint_serializer())
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
/// in the thread-local slab. The sidecar is a packed little-endian `i64` array
/// with one entry per mp4 video sample (see `docs/05-video-pipeline.md`);
/// length mismatch or an mp4 without exactly one video track fails the open
/// with a descriptive error.
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
        summary.serialize(&bigint_serializer())
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
        summary.serialize(&bigint_serializer())
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
pub fn mcap_video_open(
    handle: u32,
    channel_id: &str,
    from_pts_ns: i64,
) -> Result<u32, JsError> {
    let iter = MCAP_READERS.with(|cell| -> Result<EncodedChunkIter, JsError> {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mcap handle"))?;
        reader
            .video_stream(&channel_id.to_string(), from_pts_ns)
            .map_err(|e| JsError::new(&format!("video_stream failed: {e}")))
    })?;
    let key = VIDEO_STREAMS.with(|cell| cell.borrow_mut().insert(iter));
    u32::try_from(key).map_err(|_| JsError::new("stream handle overflowed u32"))
}

/// Pull up to `max_n` encoded access units from a video stream, returning a
/// JS array of `{ pts_ns: bigint, is_keyframe: boolean, data: Uint8Array }`.
/// An empty array signals end-of-stream; the caller should `mcap_video_close`
/// and stop polling. `max_n == 0` returns an empty array without advancing.
#[wasm_bindgen]
pub fn mcap_video_next_batch(stream_id: u32, max_n: u32) -> Result<Array, JsError> {
    VIDEO_STREAMS.with(|cell| {
        let mut slab = cell.borrow_mut();
        let iter = slab
            .get_mut(stream_id as usize)
            .ok_or_else(|| JsError::new("invalid video stream handle"))?;
        let out = Array::new();
        for _ in 0..max_n {
            let Some(chunk) = iter.next() else { break };
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
    })
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

/// Open an mp4+sidecar video stream. Symmetric with `mcap_video_open` but
/// resolves the handle against `MP4_READERS`. The resulting
/// `EncodedChunkIter` lives in the same `VIDEO_STREAMS` slab as MCAP
/// streams, so the pull/close bindings below are functionally identical to
/// the MCAP ones — we keep them separately named to mirror the `open_mcap`
/// / `open_mp4_sidecar` split on the JS side.
#[wasm_bindgen]
pub fn mp4_video_open(
    handle: u32,
    channel_id: &str,
    from_pts_ns: i64,
) -> Result<u32, JsError> {
    let iter = MP4_READERS.with(|cell| -> Result<EncodedChunkIter, JsError> {
        let slab = cell.borrow();
        let reader = slab
            .get(handle as usize)
            .ok_or_else(|| JsError::new("invalid mp4+sidecar handle"))?;
        reader
            .video_stream(&channel_id.to_string(), from_pts_ns)
            .map_err(|e| JsError::new(&format!("video_stream failed: {e}")))
    })?;
    let key = VIDEO_STREAMS.with(|cell| cell.borrow_mut().insert(iter));
    u32::try_from(key).map_err(|_| JsError::new("stream handle overflowed u32"))
}

/// Pull up to `max_n` access units from an mp4 video stream. Body is
/// identical to `mcap_video_next_batch`; the slab is shared.
#[wasm_bindgen]
pub fn mp4_video_next_batch(stream_id: u32, max_n: u32) -> Result<Array, JsError> {
    VIDEO_STREAMS.with(|cell| {
        let mut slab = cell.borrow_mut();
        let iter = slab
            .get_mut(stream_id as usize)
            .ok_or_else(|| JsError::new("invalid video stream handle"))?;
        let out = Array::new();
        for _ in 0..max_n {
            let Some(chunk) = iter.next() else { break };
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
    })
}

/// Drop the mp4 video stream iterator at `stream_id`. Shares the slab with
/// `mcap_video_close`.
#[wasm_bindgen]
pub fn mp4_video_close(stream_id: u32) {
    VIDEO_STREAMS.with(|cell| {
        let mut slab = cell.borrow_mut();
        if slab.contains(stream_id as usize) {
            drop(slab.remove(stream_id as usize));
        }
    });
}
