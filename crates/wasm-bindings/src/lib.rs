//! Thin wasm-bindgen surface exposing `data-core` to the browser worker.
//!
//! M1 exposes:
//! - `ping()` → "pong" (worker-plumbing smoke test)
//! - `fetch_range_stub()` → Arrow IPC bytes matching `test-fixtures/arrow_scalar.ipc`
//!
//! Real MCAP / MF4 entry points land in M2.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

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
