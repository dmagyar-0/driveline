//! Integration test for `McapReader` against the committed MCAP fixture.
//!
//! Unlike `mf4_reader.rs`, this does NOT assert bit-identity between the
//! committed file and the live generator output. The `mcap` crate's summary
//! section iterates internal `HashMap`s when writing repeated channel /
//! schema records, so two runs of `short_mcap_bytes()` produce the same
//! logical content but different byte order within the summary. The
//! structural assertions below cover the contract we care about; the
//! committed fixture exists so downstream consumers (the JS Arrow contract
//! test in T1.4, the e2e harness in T2.4) can point at a real file.

use arrow_array::{Array, Float64Array, TimestampNanosecondArray};
use arrow_ipc::reader::FileReader;
use arrow_schema::{DataType, TimeUnit};
use data_core::{ChannelKind, DType, FetchOpts, McapReader, Reader, SourceKind};
use std::io::Cursor;

const FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/short.mcap");

#[test]
fn generator_round_trips_through_reader() {
    // Byte-equality between runs is not guaranteed (see module comment),
    // but the structure the reader extracts is.
    let bytes = data_core::fixtures::short_mcap_bytes().expect("generate mcap");
    let live = McapReader::open(&bytes).expect("open live");
    let committed = McapReader::open(FIXTURE).expect("open committed");
    assert_eq!(live.meta().channels.len(), committed.meta().channels.len());
    assert_eq!(live.meta().time_range, committed.meta().time_range);
}

#[test]
fn opens_and_describes_fixture() {
    let r = McapReader::open(FIXTURE).expect("open short.mcap");
    assert_eq!(r.meta().kind, SourceKind::Mcap);
    assert_eq!(r.meta().channels.len(), 4);

    let speed = r
        .meta()
        .channels
        .iter()
        .find(|c| c.name == "/vehicle/speed")
        .expect("speed channel surfaced");
    assert_eq!(speed.kind, ChannelKind::Scalar);
    assert_eq!(speed.dtype, Some(DType::F64));
    assert_eq!(speed.sample_count, 10);

    // /vehicle/speed spans 90 ms → end_ns is half-open (+1 on last).
    let span = speed.time_range.end_ns - speed.time_range.start_ns;
    assert_eq!(span, 90_000_000 + 1);
}

#[test]
fn fetch_range_produces_contract_scalar_ipc() {
    let r = McapReader::open(FIXTURE).expect("open short.mcap");
    let ipc = r
        .fetch_range(
            &"/vehicle/speed".to_string(),
            r.meta().time_range,
            FetchOpts::default(),
        )
        .expect("fetch_range");

    let reader = FileReader::try_new(Cursor::new(ipc.as_slice()), None).expect("valid ipc");
    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().expect("read batches");
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 10);

    // Schema must match the Scalar contract from `docs/03-data-model.md:104-108`.
    match batch.schema().field(0).data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
        other => panic!("unexpected ts dtype: {other:?}"),
    }
    assert_eq!(batch.schema().field(1).data_type(), &DataType::Float64);

    let value = batch
        .column(1)
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("value array");
    // Values are `i` for `i in 0..10` → sum == 45.
    let sum: f64 = (0..value.len()).map(|i| value.value(i)).sum();
    assert!((sum - 45.0).abs() < 1e-9);

    let ts = batch
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .expect("ts array");
    for i in 1..ts.len() {
        assert_eq!(ts.value(i) - ts.value(i - 1), 10_000_000);
    }
}
