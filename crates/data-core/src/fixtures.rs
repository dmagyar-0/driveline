//! Canonical contract-test fixtures. The Arrow IPC bytes produced here are
//! bit-identical to `test-fixtures/arrow_scalar.ipc` and are consumed by both
//! the Rust contract test (`tests/arrow_contract.rs`) and the JS vitest suite
//! that loads the committed file with `apache-arrow`.
//!
//! Using a shared generator prevents Rust ↔ JS schema drift.

use arrow_array::{Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use std::sync::Arc;

/// Schema: `{ ts: Timestamp(ns, UTC), value: Float64 }` — 3 rows.
/// See `docs/03-data-model.md` for the Scalar channel wire format.
pub fn arrow_scalar_ipc() -> crate::Result<Vec<u8>> {
    let schema = Arc::new(Schema::new(vec![
        Field::new(
            "ts",
            DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
            false,
        ),
        Field::new("value", DataType::Float64, false),
    ]));

    let ts =
        TimestampNanosecondArray::from(vec![1_000_000_000, 1_010_000_000, 1_020_000_000])
            .with_timezone("UTC");
    let value = Float64Array::from(vec![1.0, 2.0, 3.0]);

    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(value)])?;

    let mut buf = Vec::new();
    {
        let mut w = FileWriter::try_new(&mut buf, &schema)?;
        w.write(&batch)?;
        w.finish()?;
    }
    Ok(buf)
}
