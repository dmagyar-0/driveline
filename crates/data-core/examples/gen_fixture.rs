//! One-shot generator for the committed Arrow IPC contract fixtures.
//! Run with: `cargo run -p data-core --example gen_fixture`
//!
//! Writes `test-fixtures/arrow_scalar.ipc` and
//! `test-fixtures/arrow_bounding_box.ipc`. Pass a single path argument to
//! override the scalar fixture's destination (legacy behaviour).

use std::io::Write;

fn write_fixture(bytes: &[u8], path: &str) {
    let mut f = std::fs::File::create(path).expect("create");
    f.write_all(bytes).expect("write");
    eprintln!("wrote {} bytes to {path}", bytes.len());
}

fn main() {
    let scalar = data_core::fixtures::arrow_scalar_ipc().expect("generate scalar");
    let scalar_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "test-fixtures/arrow_scalar.ipc".to_string());
    write_fixture(&scalar, &scalar_path);

    let bbox = data_core::fixtures::arrow_bounding_box_ipc().expect("generate bounding_box");
    write_fixture(&bbox, "test-fixtures/arrow_bounding_box.ipc");
}
