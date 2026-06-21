//! Integration test for `Ros1BagReader` against the committed ROS1 bag
//! fixture `test-fixtures/ros/turtle.bag` (real recorded turtlesim,
//! uncompressed).

use arrow_array::{Array, FixedSizeListArray, Float64Array, TimestampNanosecondArray};
use arrow_ipc::reader::FileReader;
use arrow_schema::{DataType, TimeUnit};
use data_core::{ChannelKind, FetchOpts, Reader, Ros1BagReader, SourceKind, TimeRange};
use std::io::Cursor;
use std::path::PathBuf;

fn fixture_bytes() -> Vec<u8> {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../test-fixtures/ros/turtle.bag");
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

fn open() -> Ros1BagReader {
    Ros1BagReader::open(&fixture_bytes()).expect("open turtle.bag")
}

fn parse_ipc(bytes: &[u8]) -> arrow_array::RecordBatch {
    let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(batches.len(), 1, "expected exactly one record batch");
    batches.into_iter().next().unwrap()
}

fn scalar_values(batch: &arrow_array::RecordBatch) -> Vec<f64> {
    let v = batch
        .column(1)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    (0..v.len()).map(|i| v.value(i)).collect()
}

fn scalar_ts(batch: &arrow_array::RecordBatch) -> Vec<i64> {
    let t = batch
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .unwrap();
    (0..t.len()).map(|i| t.value(i)).collect()
}

#[test]
fn opens_and_expands_expected_channels() {
    let r = open();
    assert_eq!(r.meta().kind, SourceKind::Ros1);

    let ids: Vec<&str> = r.meta().channels.iter().map(|c| c.id.as_str()).collect();
    assert!(
        ids.contains(&"/turtle1/pose.x"),
        "expected /turtle1/pose.x in {ids:?}"
    );
    assert!(
        ids.contains(&"/turtle1/pose.theta"),
        "expected /turtle1/pose.theta in {ids:?}"
    );
    // cmd_vel is geometry_msgs/Twist: linear/angular Vector3 expanded to both a
    // vector leaf and scalar components.
    assert!(
        ids.contains(&"/turtle1/cmd_vel.linear.x"),
        "expected /turtle1/cmd_vel.linear.x in {ids:?}"
    );

    // The overall time range must be a non-empty span.
    assert!(!r.meta().time_range.is_empty());
}

#[test]
fn fetch_pose_x_returns_scalar_batch_in_range() {
    let r = open();
    let ch = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == "/turtle1/pose.x")
        .expect("/turtle1/pose.x channel");
    assert_eq!(ch.kind, ChannelKind::Scalar);

    let ipc = r
        .fetch_range("/turtle1/pose.x", ch.time_range, FetchOpts::default())
        .expect("fetch pose.x");
    let batch = parse_ipc(&ipc);

    // Scalar schema: ts Timestamp(ns, UTC) + value Float64.
    assert_eq!(
        batch.schema().field(0).data_type(),
        &DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into()))
    );
    assert_eq!(batch.schema().field(1).data_type(), &DataType::Float64);

    let vals = scalar_values(&batch);
    assert!(!vals.is_empty(), "expected at least one pose.x sample");
    // turtlesim spawns at x ~5.5 and stays within the 0..11 window.
    for v in &vals {
        assert!(v.is_finite(), "value should be finite, got {v}");
        assert!((0.0..=11.0).contains(v), "turtle x out of range: {v}");
    }

    // Timestamps must be ascending.
    let ts = scalar_ts(&batch);
    assert!(ts.windows(2).all(|w| w[0] <= w[1]), "ts not sorted");
}

#[test]
fn fetch_range_is_half_open() {
    let r = open();
    let id = "/turtle1/pose.x".to_string();
    let full = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == id)
        .unwrap()
        .time_range;

    let all = parse_ipc(&r.fetch_range(&id, full, FetchOpts::default()).unwrap());
    let all_ts = scalar_ts(&all);
    assert!(all_ts.len() >= 2, "need several samples to test bounds");

    // [start, second_ts) must include exactly the first sample (half-open end).
    let range = TimeRange {
        start_ns: all_ts[0],
        end_ns: all_ts[1],
    };
    let got = parse_ipc(&r.fetch_range(&id, range, FetchOpts::default()).unwrap());
    assert_eq!(scalar_ts(&got), vec![all_ts[0]]);
}

#[test]
fn fetch_cmd_vel_linear_returns_vector_batch() {
    let r = open();
    let id = "/turtle1/cmd_vel.linear".to_string();
    let ch = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == id)
        .expect("/turtle1/cmd_vel.linear channel");
    assert_eq!(ch.kind, ChannelKind::Vector);

    let ipc = r
        .fetch_range(&id, r.meta().time_range, FetchOpts::default())
        .expect("fetch cmd_vel.linear");
    let batch = parse_ipc(&ipc);

    match batch.schema().field(1).data_type() {
        DataType::FixedSizeList(inner, n) => {
            assert_eq!(*n, 3, "Vector3 is width 3");
            assert_eq!(inner.data_type(), &DataType::Float64);
        }
        other => panic!("expected FixedSizeList, got {other:?}"),
    }

    let list = batch
        .column(1)
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
        .unwrap();
    assert!(list.len() > 0, "expected cmd_vel messages");
}

#[test]
fn unknown_channel_errors() {
    let r = open();
    let err = r
        .fetch_range("/nope/missing.x", r.meta().time_range, FetchOpts::default())
        .unwrap_err();
    assert!(matches!(err, data_core::Error::ChannelNotFound(_)));
}
