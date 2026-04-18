//! One-shot generator for `test-fixtures/short.mcap`.
//! Run with: `cargo run -p data-core --example gen_mcap_fixture`
//!
//! Produces the canonical MCAP fixture consumed by
//! `crates/data-core/tests/mcap_reader.rs` and by the unit tests in
//! `crates/data-core/src/mcap.rs`.

use std::io::Write;

fn main() {
    let bytes = data_core::fixtures::short_mcap_bytes().expect("generate mcap");
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "test-fixtures/short.mcap".to_string());
    let mut f = std::fs::File::create(&path).expect("create");
    f.write_all(&bytes).expect("write");
    eprintln!("wrote {} bytes to {path}", bytes.len());
}
