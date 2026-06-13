//! Conformance test: open the committed real-world OpenLABEL cuboid fixture
//! (adapted from the Vicomtech VCD reference `openlabel100_test_cuboids.json`)
//! through `OpenLabelReader` and assert it yields at least one bounding box.

use data_core::{ChannelKind, FetchOpts, OpenLabelReader, Reader, SourceKind, TimeRange};

use arrow_array::cast::AsArray;
use arrow_array::Float32Array;
use arrow_ipc::reader::FileReader;
use std::io::Cursor;

const FIXTURE: &[u8] = include_bytes!("../../../test-fixtures/openlabel_cuboids.json");

#[test]
fn opens_real_openlabel_cuboids_fixture() {
    let r = OpenLabelReader::open(FIXTURE).expect("parse openlabel fixture");

    assert_eq!(r.meta().kind, SourceKind::OpenLabel);
    assert_eq!(r.meta().channels.len(), 1);
    let ch = &r.meta().channels[0];
    assert_eq!(ch.kind, ChannelKind::BoundingBox);

    // Static form (no `frames`) → exactly one frame holding both cars.
    let times = r.frame_times();
    assert_eq!(times.len(), 1);

    // Peak boxes-per-frame ≥ 1 (the fixture has two cars: one 10-element
    // quaternion cuboid, one 9-element Euler cuboid).
    assert!(
        ch.sample_count >= 1,
        "expected ≥1 box, got {}",
        ch.sample_count
    );
    assert_eq!(ch.sample_count, 2);

    // Round-trip through fetch_range: the single frame yields 2 boxes.
    let t = times[0];
    let ipc = r
        .fetch_range(
            &ch.id,
            TimeRange {
                start_ns: t,
                end_ns: t + 1,
            },
            FetchOpts::default(),
        )
        .expect("fetch_range");
    let reader = FileReader::try_new(Cursor::new(ipc), None).unwrap();
    let batch = reader.into_iter().next().unwrap().unwrap();
    assert_eq!(batch.num_rows(), 1);

    let centers = batch.column(1).as_list::<i32>().value(0);
    let c = centers.as_any().downcast_ref::<Float32Array>().unwrap();
    // 2 boxes × 3 coords.
    assert_eq!(c.len(), 6);
    let labels = batch.column(4).as_list::<i32>().value(0);
    assert_eq!(labels.len(), 2);
}
