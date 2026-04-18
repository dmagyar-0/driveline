//! Rust half of the Rust ↔ JS Arrow IPC contract test. Loads the committed
//! fixture file and asserts schema + values.

use arrow_array::{Array, Float64Array, TimestampNanosecondArray};
use arrow_ipc::reader::FileReader;
use arrow_schema::{DataType, TimeUnit};
use std::io::Cursor;

const FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/arrow_scalar.ipc");

#[test]
fn fixture_matches_scalar_contract() {
    let reader = FileReader::try_new(Cursor::new(FIXTURE), None).expect("valid ipc");
    let schema = reader.schema();

    assert_eq!(schema.fields().len(), 2);
    assert_eq!(schema.field(0).name(), "ts");
    assert_eq!(schema.field(1).name(), "value");

    match schema.field(0).data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
        other => panic!("unexpected ts dtype: {other:?}"),
    }
    assert_eq!(schema.field(1).data_type(), &DataType::Float64);

    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().expect("read batches");
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 3);

    let ts = batch
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .expect("ts array");
    assert_eq!(ts.value(0), 1_000_000_000);
    assert_eq!(ts.value(1), 1_010_000_000);
    assert_eq!(ts.value(2), 1_020_000_000);

    let value = batch
        .column(1)
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("value array");
    let sum: f64 = (0..value.len()).map(|i| value.value(i)).sum();
    assert!((sum - 6.0).abs() < 1e-9);
}

#[test]
fn fixture_equals_generator() {
    // Bit-identical to the in-repo generator guarantees JS reads the same
    // bytes as the wasm binding would produce at runtime.
    let expected = data_core::fixtures::arrow_scalar_ipc().expect("generate");
    assert_eq!(FIXTURE, expected.as_slice(), "committed fixture drifted from generator");
}
