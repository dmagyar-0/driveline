//! Thin wasm-bindgen surface exposing `data-core` to the browser worker.
//!
//! M1 exposes:
//! - `ping()` → "pong" (worker-plumbing smoke test)
//!
//! Real MCAP / MF4 entry points land in M2.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn ping() -> String {
    "pong".to_string()
}
