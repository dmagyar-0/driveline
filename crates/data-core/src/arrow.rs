//! Shared Arrow IPC emit helpers.
//!
//! Every reader produces the same wire format for the common scalar / vector /
//! enum cases, so the schema builders and the IPC serializer live here once
//! instead of being copy-pasted per reader. The byte layout these emit is a
//! cross-surface contract (the JS side and the Arrow contract tests pin it), so
//! changes here ripple to every format.

use std::sync::Arc;

use arrow_array::{
    FixedSizeListArray, Float64Array, Int32Array, RecordBatch, TimestampNanosecondArray,
};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};

use crate::reader::ArrowIpc;

/// Timestamp field shared by every signal schema: ns-resolution UTC, non-null.
fn ts_field() -> Field {
    Field::new(
        "ts",
        DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
        false,
    )
}

/// `{ ts: Timestamp(ns, UTC), value: Float64 }` — the scalar signal schema.
pub fn scalar_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        ts_field(),
        Field::new("value", DataType::Float64, false),
    ]))
}

/// `{ ts: Timestamp(ns, UTC), value: FixedSizeList<Float64, n> }` — the vector
/// signal schema (e.g. a Vector3 with `n == 3`).
pub fn vector_schema(n: usize) -> Arc<Schema> {
    let inner = Arc::new(Field::new("item", DataType::Float64, false));
    Arc::new(Schema::new(vec![
        ts_field(),
        Field::new("value", DataType::FixedSizeList(inner, n as i32), false),
    ]))
}

/// `{ ts: Timestamp(ns, UTC), code: Int32 }` — the enum signal schema.
pub fn enum_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        ts_field(),
        Field::new("code", DataType::Int32, false),
    ]))
}

/// Serialise a single `RecordBatch` to Arrow IPC (File format) bytes.
pub fn write_ipc(schema: Arc<Schema>, batch: RecordBatch) -> crate::Result<ArrowIpc> {
    let mut buf = Vec::new();
    {
        let mut w = FileWriter::try_new(&mut buf, &schema)?;
        w.write(&batch)?;
        w.finish()?;
    }
    Ok(buf)
}

/// Build a scalar Arrow IPC buffer from owned timestamp and value vectors.
/// Takes ownership so the vecs move straight into the Arrow arrays without an
/// extra copy at the call site.
pub fn build_scalar_ipc(timestamps: Vec<i64>, values: Vec<f64>) -> crate::Result<ArrowIpc> {
    let schema = scalar_schema();
    let ts = TimestampNanosecondArray::from(timestamps).with_timezone("UTC");
    let val = Float64Array::from(values);
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(val)])?;
    write_ipc(schema, batch)
}

/// Build a vector Arrow IPC buffer from owned timestamps and a pre-flattened
/// value buffer of length `timestamps.len() * n` (row-major: row i occupies
/// `[i*n .. (i+1)*n)`).
pub fn build_vector_ipc(
    timestamps: Vec<i64>,
    flat_values: Vec<f64>,
    n: usize,
) -> crate::Result<ArrowIpc> {
    let schema = vector_schema(n);
    let ts = TimestampNanosecondArray::from(timestamps).with_timezone("UTC");
    let child = Arc::new(Float64Array::from(flat_values));
    let inner_field = Arc::new(Field::new("item", DataType::Float64, false));
    let list = FixedSizeListArray::new(inner_field, n as i32, child, None);
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(list)])?;
    write_ipc(schema, batch)
}

/// Build an enum Arrow IPC buffer from owned timestamps and int32 codes.
pub fn build_enum_ipc(timestamps: Vec<i64>, codes: Vec<i32>) -> crate::Result<ArrowIpc> {
    let schema = enum_schema();
    let ts = TimestampNanosecondArray::from(timestamps).with_timezone("UTC");
    let code = Int32Array::from(codes);
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(code)])?;
    write_ipc(schema, batch)
}
