//! One-shot generator for `test-fixtures/short.mf4`.
//! Run with: `cargo run -p data-core --example gen_mf4_fixture`
//!
//! Produces the canonical MF4 fixture consumed by
//! `crates/data-core/tests/mf4_reader.rs` and by the Playwright e2e
//! smoke test.

use std::io::Write;

fn main() {
    let bytes = data_core::fixtures::short_mf4_bytes().expect("generate mf4");
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "test-fixtures/short.mf4".to_string());
    let mut f = std::fs::File::create(&path).expect("create");
    f.write_all(&bytes).expect("write");
    eprintln!("wrote {} bytes to {path}", bytes.len());
}
