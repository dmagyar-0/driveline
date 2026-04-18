//! Thin wasm-bindgen surface exposing `data-core` to the browser worker.
//! M1 is scaffold-only; `ping` and `fetch_range_stub` land in T1.3 / T1.4.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn _scaffold() -> bool {
    true
}
