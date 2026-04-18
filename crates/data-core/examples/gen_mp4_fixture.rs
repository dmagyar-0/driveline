//! One-shot generator for `test-fixtures/short.mp4` + `test-fixtures/short.mp4.ts.bin`.
//! Run with: `cargo run -p data-core --example gen_mp4_fixture`
//!
//! Produces the canonical mp4+sidecar pair consumed by
//! `crates/data-core/tests/mp4_reader.rs` and by the T2.4 e2e session-drop test.

use std::io::Write;

fn main() {
    let mp4_bytes = data_core::fixtures::short_mp4_bytes().expect("generate mp4");
    let sidecar_bytes = data_core::fixtures::short_sidecar_bytes();

    let mp4_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "test-fixtures/short.mp4".to_string());
    let sidecar_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "test-fixtures/short.mp4.ts.bin".to_string());

    std::fs::File::create(&mp4_path)
        .expect("create mp4")
        .write_all(&mp4_bytes)
        .expect("write mp4");
    eprintln!("wrote {} bytes to {mp4_path}", mp4_bytes.len());

    std::fs::File::create(&sidecar_path)
        .expect("create sidecar")
        .write_all(&sidecar_bytes)
        .expect("write sidecar");
    eprintln!("wrote {} bytes to {sidecar_path}", sidecar_bytes.len());
}
