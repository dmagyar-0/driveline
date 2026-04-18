//! One-shot generator for `test-fixtures/arrow_scalar.ipc`.
//! Run with: `cargo run -p data-core --example gen_fixture`

use std::io::Write;

fn main() {
    let bytes = data_core::fixtures::arrow_scalar_ipc().expect("generate");
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "test-fixtures/arrow_scalar.ipc".to_string());
    let mut f = std::fs::File::create(&path).expect("create");
    f.write_all(&bytes).expect("write");
    eprintln!("wrote {} bytes to {path}", bytes.len());
}
