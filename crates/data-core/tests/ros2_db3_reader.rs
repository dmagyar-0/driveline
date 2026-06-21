//! Integration tests for `Ros2Db3Reader` against a committed subsample of rows
//! extracted from the rosbag2 SQLite bag `test-fixtures/ros/synth_imu.db3`
//! (`sensor_msgs/msg/Imu` @100Hz on `/imu/data` plus `std_msgs/msg/Float64` on
//! `/temperature`).
//!
//! Rust cannot read SQLite, so the rows are pre-extracted by
//! `test-fixtures/ros/extract_db3_rows.py` into
//! `test-fixtures/ros/synth_imu_rows.json` (committed). This test decodes that
//! JSON, reconstructs the `open_rows` arguments (base64 blobs -> `blob_data` +
//! cumulative `blob_offsets`), opens the reader, and asserts the channel shapes
//! and decoded values match the bundled-typestore CDR decode.

use std::io::Cursor;

use arrow_array::{Array, FixedSizeListArray, Float64Array, TimestampNanosecondArray};
use arrow_ipc::reader::FileReader;
use arrow_schema::{DataType, TimeUnit};
use base64::Engine;
use data_core::types::{ChannelKind, FetchOpts, SourceKind, TimeRange};
use data_core::{Reader, Ros2Db3Reader};
use serde::Deserialize;

/// The committed JSON snapshot of extracted rows.
const ROWS_JSON: &str = include_str!("../../../test-fixtures/ros/synth_imu_rows.json");

#[derive(Deserialize)]
struct RowsFixture {
    /// `[topic_name, type_name]` per topic, indexed 0..T.
    topics: Vec<(String, String)>,
    /// `[topic_idx, ts_ns, blob_base64]` per message, time-sorted.
    rows: Vec<(u32, i64, String)>,
}

/// Reconstructed `open_rows` arguments from the JSON fixture.
struct Args {
    topics: Vec<(String, String)>,
    msg_topic_idx: Vec<u32>,
    msg_ts_ns: Vec<i64>,
    blob_data: Vec<u8>,
    blob_offsets: Vec<u32>,
}

fn load_args() -> Args {
    let fx: RowsFixture = serde_json::from_str(ROWS_JSON).expect("parse rows json");
    let engine = base64::engine::general_purpose::STANDARD;

    let mut msg_topic_idx = Vec::with_capacity(fx.rows.len());
    let mut msg_ts_ns = Vec::with_capacity(fx.rows.len());
    let mut blob_data: Vec<u8> = Vec::new();
    let mut blob_offsets: Vec<u32> = Vec::with_capacity(fx.rows.len() + 1);
    blob_offsets.push(0);

    for (tidx, ts, b64) in &fx.rows {
        let blob = engine.decode(b64).expect("decode base64 blob");
        blob_data.extend_from_slice(&blob);
        blob_offsets.push(blob_data.len() as u32);
        msg_topic_idx.push(*tidx);
        msg_ts_ns.push(*ts);
    }

    Args {
        topics: fx.topics,
        msg_topic_idx,
        msg_ts_ns,
        blob_data,
        blob_offsets,
    }
}

fn open() -> Ros2Db3Reader {
    let a = load_args();
    Ros2Db3Reader::open_rows(
        &a.topics,
        &a.msg_topic_idx,
        &a.msg_ts_ns,
        &a.blob_data,
        &a.blob_offsets,
        &[],
    )
    .expect("open_rows")
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
    // Reuses SourceKind::Mcap (db3 is an MCAP-like CDR source); see module docs.
    assert_eq!(r.meta().kind, SourceKind::Mcap);

    let ids: Vec<&str> = r.meta().channels.iter().map(|c| c.id.as_str()).collect();
    for expected in [
        "/imu/data.linear_acceleration.z",
        "/imu/data.angular_velocity",
        "/imu/data.angular_velocity.z",
        "/temperature.data",
    ] {
        assert!(
            ids.contains(&expected),
            "expected expanded channel {expected:?}; got {ids:?}"
        );
    }

    // angular_velocity is a geometry_msgs/Vector3 -> 3-wide Vector leaf.
    let angvel = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == "/imu/data.angular_velocity")
        .expect("angular_velocity channel");
    assert_eq!(angvel.kind, ChannelKind::Vector);

    let zaccel = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == "/imu/data.linear_acceleration.z")
        .expect("z-accel channel");
    assert_eq!(zaccel.kind, ChannelKind::Scalar);

    assert!(!r.meta().time_range.is_empty());
}

#[test]
fn fetch_linear_accel_z_decodes_near_gravity() {
    let r = open();
    let id = "/imu/data.linear_acceleration.z".to_string();
    let ipc = r
        .fetch_range(&id, r.meta().time_range, FetchOpts::default())
        .expect("fetch z-accel");
    let batch = parse_ipc(&ipc);

    // We subsampled 100 IMU msgs at stride 5 -> 20 samples.
    assert_eq!(batch.num_rows(), 20, "expected 20 subsampled IMU samples");

    match batch.schema().field(0).data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
        other => panic!("unexpected ts dtype: {other:?}"),
    }
    assert_eq!(batch.schema().field(1).data_type(), &DataType::Float64);

    for v in scalar_values(&batch) {
        assert!(v.is_finite(), "z-accel not finite");
        assert!(
            (8.0..=11.5).contains(&v),
            "linear_acceleration.z {v} not near gravity"
        );
    }

    // Timestamps ascending.
    let ts = scalar_ts(&batch);
    assert!(ts.windows(2).all(|w| w[0] <= w[1]), "ts not sorted");
}

#[test]
fn fetch_temperature_in_sane_range() {
    let r = open();
    let id = "/temperature.data".to_string();
    let ipc = r
        .fetch_range(&id, r.meta().time_range, FetchOpts::default())
        .expect("fetch temperature");
    let batch = parse_ipc(&ipc);

    // /temperature kept at stride 1 -> all 10 messages.
    assert_eq!(batch.num_rows(), 10, "expected 10 temperature samples");
    for v in scalar_values(&batch) {
        assert!(v.is_finite());
        assert!(
            (10.0..=30.0).contains(&v),
            "temperature {v} out of plausible range"
        );
    }
}

#[test]
fn fetch_angular_velocity_is_fixed_size_list() {
    let r = open();
    let id = "/imu/data.angular_velocity".to_string();
    let ipc = r
        .fetch_range(&id, r.meta().time_range, FetchOpts::default())
        .expect("fetch angular_velocity vector");
    let batch = parse_ipc(&ipc);

    match batch.schema().field(1).data_type() {
        DataType::FixedSizeList(inner, n) => {
            assert_eq!(*n, 3, "Vector3 is 3-wide");
            assert_eq!(inner.data_type(), &DataType::Float64);
        }
        other => panic!("expected FixedSizeList, got {other:?}"),
    }
    assert_eq!(batch.num_rows(), 20, "20 subsampled IMU samples");

    let list = batch
        .column(1)
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
        .unwrap();
    let inner = list
        .values()
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    for i in 0..inner.len() {
        assert!(inner.value(i).is_finite());
    }
}

#[test]
fn fetch_range_is_half_open() {
    let r = open();
    let id = "/imu/data.linear_acceleration.z".to_string();
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
fn include_prev_adds_leading_sample() {
    let r = open();
    let id = "/imu/data.linear_acceleration.z".to_string();
    let full = r.meta().time_range;
    let mid = full.start_ns + (full.end_ns - full.start_ns) / 2;
    let range = TimeRange {
        start_ns: mid,
        end_ns: full.end_ns,
    };

    let plain = parse_ipc(&r.fetch_range(&id, range, FetchOpts::default()).unwrap());
    let with_prev = parse_ipc(
        &r.fetch_range(&id, range, FetchOpts { include_prev: true })
            .unwrap(),
    );
    assert_eq!(
        with_prev.num_rows(),
        plain.num_rows() + 1,
        "include_prev adds exactly one leading sample"
    );
    let ts_plain = scalar_ts(&plain);
    let ts_prev = scalar_ts(&with_prev);
    assert!(
        ts_prev[0] < ts_plain[0],
        "leading sample precedes window start"
    );
}

#[test]
fn unknown_channel_errors() {
    let r = open();
    let err = r
        .fetch_range("/nope/missing.x", r.meta().time_range, FetchOpts::default())
        .unwrap_err();
    assert!(matches!(err, data_core::Error::ChannelNotFound(_)));
}

/// Read the `.db3` fixture path under `test-fixtures/ros/`.
fn read_db3(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../../test-fixtures/ros/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// End-to-end: open the real synth_imu.db3 bytes via the in-crate SQLite
/// reader (no JSON subsample) and assert the expanded channels + decoded
/// values, with the FULL message counts.
#[test]
fn open_real_db3_expands_channels_and_decodes() {
    let bytes = read_db3("synth_imu.db3");
    let r = Ros2Db3Reader::open(&bytes).expect("open synth_imu.db3");
    assert_eq!(r.meta().kind, SourceKind::Mcap);

    let ids: Vec<&str> = r.meta().channels.iter().map(|c| c.id.as_str()).collect();
    for expected in [
        "/imu/data.linear_acceleration.z",
        "/imu/data.angular_velocity",
        "/temperature.data",
    ] {
        assert!(ids.contains(&expected), "missing {expected:?}; got {ids:?}");
    }

    // angular_velocity is a geometry_msgs/Vector3 -> 3-wide Vector.
    let angvel = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == "/imu/data.angular_velocity")
        .expect("angular_velocity");
    assert_eq!(angvel.kind, ChannelKind::Vector);

    // FULL counts (not the 30-row JSON subsample): /imu/data has 100 msgs,
    // /temperature has 10.
    let z = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == "/imu/data.linear_acceleration.z")
        .unwrap();
    assert_eq!(z.sample_count, 100, "all 100 IMU messages");

    // Decode linear_acceleration.z ~ gravity, full count.
    let zbatch = parse_ipc(
        &r.fetch_range(
            "/imu/data.linear_acceleration.z",
            r.meta().time_range,
            FetchOpts::default(),
        )
        .unwrap(),
    );
    assert_eq!(zbatch.num_rows(), 100, "decoded all 100 IMU samples");
    for v in scalar_values(&zbatch) {
        assert!(
            v.is_finite() && (8.0..=11.5).contains(&v),
            "z accel {v} not near gravity"
        );
    }
    let ts = scalar_ts(&zbatch);
    assert!(ts.windows(2).all(|w| w[0] <= w[1]), "ts ascending");

    // Temperature in a sane range, full count.
    let tbatch = parse_ipc(
        &r.fetch_range(
            "/temperature.data",
            r.meta().time_range,
            FetchOpts::default(),
        )
        .unwrap(),
    );
    assert_eq!(tbatch.num_rows(), 10, "all 10 temperature samples");
    for v in scalar_values(&tbatch) {
        assert!(
            v.is_finite() && (10.0..=30.0).contains(&v),
            "temperature {v} out of range"
        );
    }
}

/// Half-open bounds + include_prev behave on the real-bag reader.
#[test]
fn open_real_db3_bounds_and_include_prev() {
    let bytes = read_db3("synth_imu.db3");
    let r = Ros2Db3Reader::open(&bytes).expect("open synth_imu.db3");
    let id = "/imu/data.linear_acceleration.z".to_string();

    let full = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == id)
        .unwrap()
        .time_range;
    let all = parse_ipc(&r.fetch_range(&id, full, FetchOpts::default()).unwrap());
    let all_ts = scalar_ts(&all);
    assert!(all_ts.len() >= 3);

    // Half-open end: [start, second_ts) yields exactly the first sample.
    let range = TimeRange {
        start_ns: all_ts[0],
        end_ns: all_ts[1],
    };
    let got = parse_ipc(&r.fetch_range(&id, range, FetchOpts::default()).unwrap());
    assert_eq!(scalar_ts(&got), vec![all_ts[0]]);

    // include_prev adds exactly one leading sample.
    let mid = TimeRange {
        start_ns: all_ts[all_ts.len() / 2],
        end_ns: full.end_ns,
    };
    let plain = parse_ipc(&r.fetch_range(&id, mid, FetchOpts::default()).unwrap());
    let with_prev = parse_ipc(
        &r.fetch_range(&id, mid, FetchOpts { include_prev: true })
            .unwrap(),
    );
    assert_eq!(with_prev.num_rows(), plain.num_rows() + 1);
}

/// The upstream `test_msgs` bag opens; its `test_msgs/*` types are not in the
/// bundled typestore but their definitions are embedded in
/// `message_definitions`, so channels surface from the real `.db3` bytes.
#[test]
fn open_real_cdr_test_db3() {
    let bytes = read_db3("ros2_cdr_test.db3");
    let r = Ros2Db3Reader::open(&bytes).expect("open ros2_cdr_test.db3");
    assert_eq!(r.meta().kind, SourceKind::Mcap);
    // BasicTypes / Arrays expand into numeric leaves on /test_topic and
    // /array_topic; at least some channels must surface.
    assert!(!r.meta().channels.is_empty(), "expected expanded channels");
    let ids: Vec<&str> = r.meta().channels.iter().map(|c| c.id.as_str()).collect();
    assert!(
        ids.iter().any(|id| id.starts_with("/test_topic.")),
        "expected /test_topic channels; got {ids:?}"
    );
}

#[test]
fn embedded_def_resolves_topic_typestore_does_not_know() {
    // A fabricated topic whose type is not in the bundled typestore, but whose
    // definition is supplied via embedded_defs. Build a tiny CDR payload for a
    // single float64 field (little-endian encapsulation header + 8-byte f64).
    let topics = vec![("/custom".to_string(), "my_pkg/msg/Reading".to_string())];
    let def = "float64 value\n";

    // CDR: 4-byte encapsulation header {0x00, 0x01 (CDR_LE), 0x00, 0x00}, then
    // the body. float64 is 8-aligned from body start (offset 0) -> no padding.
    let mut blob = vec![0x00, 0x01, 0x00, 0x00];
    blob.extend_from_slice(&42.5f64.to_le_bytes());

    let blob_offsets = vec![0u32, blob.len() as u32];
    let r = Ros2Db3Reader::open_rows(
        &topics,
        &[0],
        &[1_000],
        &blob,
        &blob_offsets,
        &[("my_pkg/msg/Reading".to_string(), def.to_string())],
    )
    .expect("open_rows with embedded def");

    let ids: Vec<&str> = r.meta().channels.iter().map(|c| c.id.as_str()).collect();
    assert!(
        ids.contains(&"/custom.value"),
        "embedded-def leaf missing: {ids:?}"
    );

    let batch = parse_ipc(
        &r.fetch_range("/custom.value", r.meta().time_range, FetchOpts::default())
            .unwrap(),
    );
    let vals = scalar_values(&batch);
    assert_eq!(vals, vec![42.5]);
}
