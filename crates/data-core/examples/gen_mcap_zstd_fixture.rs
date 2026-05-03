//! One-shot generator for `test-fixtures/short.zstd.mcap`.
//! Run with: `cargo run -p data-core --example gen_mcap_zstd_fixture`
//!
//! Mirrors `gen_mcap_fixture.rs`, but writes the same four-channel corpus
//! with zstd-compressed chunks. Used by the wasm pre-decompression path
//! and by the e2e visual-proof spec to confirm the reader handles
//! real-world (compressed) MCAP files end-to-end.

use std::io::Write;

fn main() {
    let bytes = data_core::fixtures::short_mcap_zstd_bytes().expect("generate zstd mcap");
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "test-fixtures/short.zstd.mcap".to_string());
    let mut f = std::fs::File::create(&path).expect("create");
    f.write_all(&bytes).expect("write");
    eprintln!("wrote {} bytes to {path}", bytes.len());
}
