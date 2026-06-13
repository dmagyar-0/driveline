//! Rust half of the Rust ↔ JS Arrow IPC contract test. Loads the committed
//! fixture file and asserts schema + values.

use arrow_array::cast::AsArray;
use arrow_array::{
    Array, Float32Array, Float64Array, Int32Array, StringArray, TimestampNanosecondArray,
};
use arrow_ipc::reader::FileReader;
use arrow_schema::{DataType, Field, TimeUnit};
use std::io::Cursor;

const FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/arrow_scalar.ipc");
const BBOX_FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/arrow_bounding_box.ipc");
const CALIB_FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/arrow_calibration.ipc");
const TRAJ_FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/arrow_trajectory.ipc");

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
    assert_eq!(
        FIXTURE,
        expected.as_slice(),
        "committed fixture drifted from generator"
    );
}

/// The bounding-box (OpenLABEL cuboid) Arrow IPC schema the 3D scene panel
/// consumes: one row per frame, five non-nullable columns. Phase 2 (frontend)
/// is coded against these exact field names and types.
#[test]
fn fixture_matches_bounding_box_contract() {
    let reader = FileReader::try_new(Cursor::new(BBOX_FIXTURE), None).expect("valid ipc");
    let schema = reader.schema();

    assert_eq!(schema.fields().len(), 5);
    assert_eq!(schema.field(0).name(), "ts");
    assert_eq!(schema.field(1).name(), "centers");
    assert_eq!(schema.field(2).name(), "sizes");
    assert_eq!(schema.field(3).name(), "rotations");
    assert_eq!(schema.field(4).name(), "labels");

    // All five fields are non-nullable.
    for i in 0..5 {
        assert!(!schema.field(i).is_nullable(), "field {i} must be non-null");
    }

    match schema.field(0).data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
        other => panic!("unexpected ts dtype: {other:?}"),
    }
    let list_f32 = DataType::List(std::sync::Arc::new(Field::new(
        "item",
        DataType::Float32,
        true,
    )));
    let list_utf8 = DataType::List(std::sync::Arc::new(Field::new(
        "item",
        DataType::Utf8,
        true,
    )));
    assert_eq!(schema.field(1).data_type(), &list_f32);
    assert_eq!(schema.field(2).data_type(), &list_f32);
    assert_eq!(schema.field(3).data_type(), &list_f32);
    assert_eq!(schema.field(4).data_type(), &list_utf8);

    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().expect("read batches");
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);

    let ts = batch
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .expect("ts array");
    assert_eq!(ts.value(0), 1_500_000_000);

    // Two boxes: centers length 6, sizes 6, rotations 8, labels 2.
    let centers = batch.column(1).as_list::<i32>().value(0);
    let c = centers.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(c.values(), &[12.0, 0.0, 0.75, 20.0, 3.0, 0.85]);

    let sizes = batch.column(2).as_list::<i32>().value(0);
    let s = sizes.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(s.values(), &[4.5, 1.8, 1.5, 4.5, 1.7, 1.5]);

    let rotations = batch.column(3).as_list::<i32>().value(0);
    let q = rotations.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(q.values(), &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

    let labels = batch.column(4).as_list::<i32>().value(0);
    let l = labels.as_any().downcast_ref::<StringArray>().unwrap();
    assert_eq!(l.len(), 2);
    assert_eq!(l.value(0), "car");
    assert_eq!(l.value(1), "car");
}

#[test]
fn bounding_box_fixture_equals_generator() {
    let expected = data_core::fixtures::arrow_bounding_box_ipc().expect("generate");
    assert_eq!(
        BBOX_FIXTURE,
        expected.as_slice(),
        "committed bounding-box fixture drifted from generator"
    );
}

/// The camera-calibration Arrow IPC schema the overlay pipeline consumes: one
/// row per camera, eight non-nullable columns (incl. `model` + `forward_poly`
/// for the f-theta fisheye model). The frontend (`calibrationFromArrow.ts`) is
/// coded against these exact field names and types — see
/// `docs/13-camera-lidar-calibration.md`.
#[test]
fn fixture_matches_calibration_contract() {
    let reader = FileReader::try_new(Cursor::new(CALIB_FIXTURE), None).expect("valid ipc");
    let schema = reader.schema();

    assert_eq!(schema.fields().len(), 8);
    assert_eq!(schema.field(0).name(), "name");
    assert_eq!(schema.field(1).name(), "model");
    assert_eq!(schema.field(2).name(), "intrinsics");
    assert_eq!(schema.field(3).name(), "resolution");
    assert_eq!(schema.field(4).name(), "distortion");
    assert_eq!(schema.field(5).name(), "forward_poly");
    assert_eq!(schema.field(6).name(), "translation");
    assert_eq!(schema.field(7).name(), "quaternion");

    // All eight fields are non-nullable.
    for i in 0..8 {
        assert!(!schema.field(i).is_nullable(), "field {i} must be non-null");
    }

    let list_f32 = DataType::List(std::sync::Arc::new(Field::new(
        "item",
        DataType::Float32,
        true,
    )));
    let list_i32 = DataType::List(std::sync::Arc::new(Field::new(
        "item",
        DataType::Int32,
        true,
    )));
    assert_eq!(schema.field(0).data_type(), &DataType::Utf8); // name
    assert_eq!(schema.field(1).data_type(), &DataType::Utf8); // model
    assert_eq!(schema.field(2).data_type(), &list_f32); // intrinsics
    assert_eq!(schema.field(3).data_type(), &list_i32); // resolution
    assert_eq!(schema.field(4).data_type(), &list_f32); // distortion
    assert_eq!(schema.field(5).data_type(), &list_f32); // forward_poly
    assert_eq!(schema.field(6).data_type(), &list_f32); // translation
    assert_eq!(schema.field(7).data_type(), &list_f32); // quaternion

    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().expect("read batches");
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);

    let name = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .expect("name array");
    assert_eq!(name.value(0), "CAM_FRONT");

    let model = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .expect("model array");
    assert_eq!(model.value(0), "pinhole");

    let intrinsics = batch.column(2).as_list::<i32>().value(0);
    let intr = intrinsics.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(intr.values(), &[1266.4, 1266.4, 816.3, 491.5]);

    let resolution = batch.column(3).as_list::<i32>().value(0);
    let res = resolution.as_any().downcast_ref::<Int32Array>().unwrap();
    assert_eq!(res.values(), &[1600, 900]);

    let distortion = batch.column(4).as_list::<i32>().value(0);
    let dist = distortion.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(dist.values(), &[0.0, 0.0, 0.0, 0.0, 0.0]);

    // Pinhole camera → empty forward_poly.
    let forward_poly = batch.column(5).as_list::<i32>().value(0);
    let fwd = forward_poly
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    assert_eq!(fwd.len(), 0);

    let translation = batch.column(6).as_list::<i32>().value(0);
    let trans = translation.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(trans.values(), &[0.0, 0.0, 0.0]);

    let quaternion = batch.column(7).as_list::<i32>().value(0);
    let quat = quaternion.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(quat.values(), &[-0.5, 0.5, -0.5, 0.5]);
}

#[test]
fn calibration_fixture_equals_generator() {
    let expected = data_core::fixtures::arrow_calibration_ipc().expect("generate");
    assert_eq!(
        CALIB_FIXTURE,
        expected.as_slice(),
        "committed calibration fixture drifted from generator"
    );
}

/// The trajectory Arrow IPC schema the 3D scene panel consumes: one row per
/// frame, four non-nullable columns. The frontend is coded against these exact
/// field names and types.
#[test]
fn fixture_matches_trajectory_contract() {
    let reader = FileReader::try_new(Cursor::new(TRAJ_FIXTURE), None).expect("valid ipc");
    let schema = reader.schema();

    assert_eq!(schema.fields().len(), 4);
    assert_eq!(schema.field(0).name(), "ts");
    assert_eq!(schema.field(1).name(), "points");
    assert_eq!(schema.field(2).name(), "path_lengths");
    assert_eq!(schema.field(3).name(), "confidences");

    // All four fields are non-nullable.
    for i in 0..4 {
        assert!(!schema.field(i).is_nullable(), "field {i} must be non-null");
    }

    match schema.field(0).data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
        other => panic!("unexpected ts dtype: {other:?}"),
    }
    let list_f32 = DataType::List(std::sync::Arc::new(Field::new(
        "item",
        DataType::Float32,
        true,
    )));
    let list_i32 = DataType::List(std::sync::Arc::new(Field::new(
        "item",
        DataType::Int32,
        true,
    )));
    assert_eq!(schema.field(1).data_type(), &list_f32);
    assert_eq!(schema.field(2).data_type(), &list_i32);
    assert_eq!(schema.field(3).data_type(), &list_f32);

    let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().expect("read batches");
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);

    let ts = batch
        .column(0)
        .as_any()
        .downcast_ref::<TimestampNanosecondArray>()
        .expect("ts array");
    assert_eq!(ts.value(0), 1_500_000_000);

    // Two paths: lengths [3, 2] → 5 points → 15 flat f32.
    let points = batch.column(1).as_list::<i32>().value(0);
    let p = points.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(p.len(), 15);
    assert_eq!(&p.values()[0..3], &[0.0, 0.0, 0.0]);

    let lengths = batch.column(2).as_list::<i32>().value(0);
    let l = lengths.as_any().downcast_ref::<Int32Array>().unwrap();
    assert_eq!(l.values(), &[3, 2]);

    let conf = batch.column(3).as_list::<i32>().value(0);
    let c = conf.as_any().downcast_ref::<Float32Array>().unwrap();
    assert_eq!(c.values(), &[0.9, 0.1]);
}

#[test]
fn trajectory_fixture_equals_generator() {
    let expected = data_core::fixtures::arrow_trajectory_ipc().expect("generate");
    assert_eq!(
        TRAJ_FIXTURE,
        expected.as_slice(),
        "committed trajectory fixture drifted from generator"
    );
}
