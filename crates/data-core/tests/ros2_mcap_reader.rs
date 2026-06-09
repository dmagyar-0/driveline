//! Integration tests for ROS2 (CDR) decoding in `McapReader`.
//!
//! These exercise the committed fixtures under `test-fixtures/ros/`:
//! `synth_imu.mcap` (a synthetic `sensor_msgs/msg/Imu` @100Hz plus a
//! `std_msgs/msg/Float64` on `/temperature`) and `ros2_cdr_test.mcap` (an
//! upstream rosbag2 `test_msgs` bag whose definitions are embedded in the
//! schema records). The reader must expand each ROS2 topic into one Driveline
//! channel per numeric leaf and decode those leaves on `fetch_range`.

use std::io::Cursor;
use std::path::PathBuf;

use arrow_array::{Array, FixedSizeListArray, Float64Array, TimestampNanosecondArray};
use arrow_ipc::reader::FileReader;
use arrow_schema::{DataType, TimeUnit};
use data_core::types::{ChannelKind, FetchOpts, TimeRange};
use data_core::McapReader;

fn fixture(name: &str) -> Vec<u8> {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../test-fixtures/ros");
    p.push(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read fixture {}: {e}", p.display()))
}

fn parse_ipc(bytes: &[u8]) -> arrow_array::RecordBatch {
    let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(batches.len(), 1, "expected exactly one record batch");
    batches.into_iter().next().unwrap()
}

#[test]
fn synth_imu_surfaces_expanded_leaf_channels() {
    let bytes = fixture("synth_imu.mcap");
    let r = McapReader::open(&bytes).expect("open synth_imu.mcap");

    let names: Vec<&str> = r.meta().channels.iter().map(|c| c.id.as_str()).collect();

    // A handful of the expected per-leaf channels from sensor_msgs/msg/Imu and
    // the std_msgs/msg/Float64 on /temperature.
    for expected in [
        "/imu/data.angular_velocity.z",
        "/imu/data.linear_acceleration.x",
        "/imu/data.linear_acceleration.z",
        "/temperature.data",
    ] {
        assert!(
            names.contains(&expected),
            "expected expanded channel {expected:?}; got {names:?}"
        );
    }

    // The raw cdr topic must NOT also surface as a single Bytes channel.
    assert!(
        !names.contains(&"/imu/data"),
        "raw ROS2 topic should be replaced by its leaf channels, got {names:?}"
    );

    // Every expanded scalar leaf is a Float64 Scalar.
    let zaccel = r
        .meta()
        .channels
        .iter()
        .find(|c| c.id == "/imu/data.linear_acceleration.z")
        .expect("z-accel channel");
    assert_eq!(zaccel.kind, ChannelKind::Scalar);
}

#[test]
fn synth_imu_fetch_scalar_leaf_decodes_cdr() {
    let bytes = fixture("synth_imu.mcap");
    let r = McapReader::open(&bytes).expect("open");

    // linear_acceleration.z ~ 9.81 (gravity) across a 1s @100Hz capture.
    let id = "/imu/data.linear_acceleration.z".to_string();
    let ipc = r
        .fetch_range(&id, r.meta().time_range, FetchOpts::default())
        .expect("fetch z-accel");
    let batch = parse_ipc(&ipc);

    // ~100 samples (allow a little slack for capture length).
    assert!(
        (90..=110).contains(&batch.num_rows()),
        "expected ~100 samples, got {}",
        batch.num_rows()
    );

    // Schema is {ts: Timestamp(ns,UTC), value: Float64}.
    match batch.schema().field(0).data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
        other => panic!("unexpected ts dtype: {other:?}"),
    }
    assert_eq!(batch.schema().field(1).data_type(), &DataType::Float64);

    let vals = batch
        .column(1)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    for i in 0..vals.len() {
        let v = vals.value(i);
        assert!(v.is_finite(), "value {i} not finite");
        assert!(
            (8.0..=11.5).contains(&v),
            "linear_acceleration.z {v} not near gravity"
        );
    }
}

#[test]
fn synth_imu_fetch_temperature_scalar() {
    let bytes = fixture("synth_imu.mcap");
    let r = McapReader::open(&bytes).expect("open");

    let id = "/temperature.data".to_string();
    let ipc = r
        .fetch_range(&id, r.meta().time_range, FetchOpts::default())
        .expect("fetch temperature");
    let batch = parse_ipc(&ipc);
    assert!(batch.num_rows() > 0, "temperature has samples");

    let vals = batch
        .column(1)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    for i in 0..vals.len() {
        let v = vals.value(i);
        assert!(v.is_finite());
        assert!(
            (10.0..=30.0).contains(&v),
            "temperature {v} out of plausible range"
        );
    }
}

#[test]
fn synth_imu_fetch_vector_leaf_is_fixed_size_list() {
    let bytes = fixture("synth_imu.mcap");
    let r = McapReader::open(&bytes).expect("open");

    // angular_velocity (geometry_msgs/Vector3) flattens to a 3-wide vector leaf.
    let id = "/imu/data.angular_velocity".to_string();
    let present = r.meta().channels.iter().any(|c| c.id == id);
    assert!(present, "expected vector leaf {id}");

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
    assert!(batch.num_rows() > 0);

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
fn synth_imu_include_prev_adds_leading_sample() {
    let bytes = fixture("synth_imu.mcap");
    let r = McapReader::open(&bytes).expect("open");
    let id = "/imu/data.linear_acceleration.z".to_string();

    let full = r.meta().time_range;
    // A sub-window that starts after the first few samples.
    let mid = full.start_ns + (full.end_ns - full.start_ns) / 2;
    let range = TimeRange {
        start_ns: mid,
        end_ns: full.end_ns,
    };

    let plain = parse_ipc(
        &r.fetch_range(&id, range, FetchOpts::default())
            .expect("fetch plain"),
    );
    let with_prev = parse_ipc(
        &r.fetch_range(&id, range, FetchOpts { include_prev: true })
            .expect("fetch include_prev"),
    );
    assert_eq!(
        with_prev.num_rows(),
        plain.num_rows() + 1,
        "include_prev adds exactly one leading sample"
    );
    let ts_plain = plain
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .unwrap();
    let ts_prev = with_prev
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .unwrap();
    assert!(
        ts_prev.value(0) < ts_plain.value(0),
        "leading sample precedes the window start"
    );
}

#[test]
fn ros2_cdr_test_bag_opens_and_decodes() {
    let bytes = fixture("ros2_cdr_test.mcap");
    let r = McapReader::open(&bytes).expect("open ros2_cdr_test.mcap");

    // test_msgs/msg/BasicTypes has many primitive fields; at least some must
    // surface as expanded numeric leaf channels.
    let basic_leaves: Vec<&str> = r
        .meta()
        .channels
        .iter()
        .filter(|c| c.kind == ChannelKind::Scalar)
        .map(|c| c.id.as_str())
        .collect();
    assert!(
        !basic_leaves.is_empty(),
        "expected some scalar leaf channels from the test_msgs bag; got {:?}",
        r.meta()
            .channels
            .iter()
            .map(|c| c.id.clone())
            .collect::<Vec<_>>()
    );

    // The leading scalar fields of `test_msgs/msg/BasicTypes` on /test_topic
    // are addressable as expanded channels and decode to real samples.
    for id in [
        "/test_topic.int32_value",
        "/test_topic.float64_value",
        "/test_topic.bool_value",
    ] {
        assert!(
            basic_leaves.contains(&id),
            "expected scalar leaf {id}; got {basic_leaves:?}"
        );
        let ipc = r
            .fetch_range(&id.to_string(), r.meta().time_range, FetchOpts::default())
            .unwrap_or_else(|e| panic!("fetch {id}: {e:?}"));
        let batch = parse_ipc(&ipc);
        assert!(batch.num_rows() > 0, "fetch returned no rows for {id}");
        assert_eq!(batch.schema().field(1).data_type(), &DataType::Float64);
    }
}
