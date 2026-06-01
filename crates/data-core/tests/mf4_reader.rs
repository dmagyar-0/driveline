//! Integration test for `Mf4Reader` against the committed MF4 fixture.
//! Mirrors the pattern in `arrow_contract.rs`: the bytes on disk must be
//! bit-identical to what the generator produces at runtime, which guards
//! against silent fixture drift.

use arrow_array::{Array, Float64Array, TimestampNanosecondArray};
use arrow_ipc::reader::FileReader;
use arrow_schema::{DataType, TimeUnit};
use data_core::{ChannelKind, DType, FetchOpts, Mf4Reader, SourceKind, TimeRange};
use std::io::Cursor;

const FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/short.mf4");

#[test]
fn fixture_matches_generator() {
    let expected = data_core::fixtures::short_mf4_bytes().expect("generate mf4");
    assert_eq!(
        FIXTURE,
        expected.as_slice(),
        "committed test-fixtures/short.mf4 drifted from data_core::fixtures::short_mf4_bytes()"
    );
}

#[test]
fn opens_and_describes_fixture() {
    let r = Mf4Reader::open_slice(FIXTURE).expect("open short.mf4");
    assert_eq!(r.meta().kind, SourceKind::Mf4);

    // The fixture publishes one non-master channel (`speed`); the master
    // `Time` channel is consumed by the reader and not surfaced.
    assert_eq!(r.meta().channels.len(), 1);
    let ch = &r.meta().channels[0];
    assert_eq!(ch.name, "speed");
    assert_eq!(ch.kind, ChannelKind::Scalar);
    assert_eq!(ch.dtype, Some(DType::F64));
    assert_eq!(ch.sample_count, 10);

    // 100 Hz over 10 samples → span of 90 ms, end_ns is half-open.
    let span = r.meta().time_range.end_ns - r.meta().time_range.start_ns;
    assert_eq!(span, 90_000_000 + 1);
}

#[test]
fn fetch_range_produces_contract_scalar_ipc() {
    let r = Mf4Reader::open_slice(FIXTURE).expect("open short.mf4");
    let ch_id = r.meta().channels[0].id.clone();

    let ipc = r
        .fetch_range(&ch_id, r.meta().time_range, FetchOpts::default())
        .expect("fetch_range");

    let reader = FileReader::try_new(Cursor::new(ipc.as_slice()), None).expect("valid ipc");
    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().expect("read batches");
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 10);

    // Schema must match the Scalar contract from `docs/03-data-model.md`:
    // `{ ts: Timestamp(ns, UTC), value: Float64 }`.
    match batch.schema().field(0).data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
        other => panic!("unexpected ts dtype: {other:?}"),
    }
    assert_eq!(batch.schema().field(1).data_type(), &DataType::Float64);

    // Values are `i * 2` for `i in 0..10` → sum == 90.
    let value = batch
        .column(1)
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("value array");
    let sum: f64 = (0..value.len()).map(|i| value.value(i)).sum();
    assert!((sum - 90.0).abs() < 1e-9);

    // Timestamps strictly increasing, step = 10 ms.
    let ts = batch
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .expect("ts array");
    for i in 1..ts.len() {
        assert_eq!(ts.value(i) - ts.value(i - 1), 10_000_000);
    }
}

#[test]
fn fetch_range_bounds_are_half_open() {
    let r = Mf4Reader::open_slice(FIXTURE).expect("open short.mf4");
    let ch_id = r.meta().channels[0].id.clone();
    let base = r.meta().time_range.start_ns;

    // `[base+20ms, base+50ms)` must expose samples at 20, 30, 40 ms — three rows.
    let range = TimeRange {
        start_ns: base + 20_000_000,
        end_ns: base + 50_000_000,
    };
    let ipc = r
        .fetch_range(&ch_id, range, FetchOpts::default())
        .expect("fetch_range");
    let reader = FileReader::try_new(Cursor::new(ipc.as_slice()), None).expect("valid ipc");
    let batch = reader.into_iter().next().expect("one batch").expect("ok");
    assert_eq!(batch.num_rows(), 3);
}
