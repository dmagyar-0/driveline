//! Thin wasm-bindgen surface exposing `data-core` to the browser worker.
//!
//! M1 wiring (ping / Arrow IPC stub) stays for the Playwright smoke tests.
//! M2 T2.2 adds an MF4 surface: `open_mf4` parses a byte slice and returns
//! a handle into a thread-local slab, `mf4_*` accessors read from that
//! handle, `close_mf4` releases it. All heavy data (Arrow IPC, channel
//! list JSON) crosses the wasm-JS boundary as `Uint8Array` / `JsValue`.

use std::cell::RefCell;

use data_core::{FetchOpts, Mf4Reader, Reader, TimeRange};
use js_sys::Uint8Array;
use serde::Serialize;
use slab::Slab;
use wasm_bindgen::prelude::*;

thread_local! {
    static READERS: RefCell<Slab<Mf4Reader>> = const { RefCell::new(Slab::new()) };
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
        serde_wasm_bindgen::to_value(&summary)
            .map_err(|e| JsError::new(&format!("serialise summary: {e}")))
    })
}

/// Arrow IPC bytes for `[start_ns, end_ns)` of the given channel id.
/// `include_prev` controls the step-hold leading-sample option documented
/// in `docs/03-data-model.md` FetchOpts.
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
                FetchOpts {
                    max_points: None,
                    include_prev,
                },
            )
            .map_err(|e| JsError::new(&format!("fetch_range failed: {e}")))?;
        let out = Uint8Array::new_with_length(bytes.len() as u32);
        out.copy_from(&bytes);
        Ok(out)
    })
}
