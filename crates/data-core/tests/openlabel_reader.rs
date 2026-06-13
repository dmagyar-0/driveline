//! Conformance test: open the committed real-world OpenLABEL cuboid fixture
//! (adapted from the Vicomtech VCD reference `openlabel100_test_cuboids.json`)
//! through `OpenLabelReader` and assert it yields at least one bounding box.

use data_core::{ChannelKind, FetchOpts, OpenLabelReader, Reader, SourceKind, TimeRange};

use arrow_array::cast::AsArray;
use arrow_array::{Array, Float32Array, StringArray};
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

    // Both cars now parse: car1 via the 9-element `val` array (Euler), car2 via
    // the OpenLABEL convenience-field form (`val: null`, with sibling
    // `traslation`/`quaternion`/`size`). Before the convenience-field branch
    // car2 was silently skipped and this peaked at 1.
    assert_eq!(
        ch.sample_count, 2,
        "expected 2 boxes, got {}",
        ch.sample_count
    );

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

    let sizes = batch.column(2).as_list::<i32>().value(0);
    let sz = sizes.as_any().downcast_ref::<Float32Array>().unwrap();
    let rots = batch.column(3).as_list::<i32>().value(0);
    let q = rots.as_any().downcast_ref::<Float32Array>().unwrap();
    let labels = batch.column(4).as_list::<i32>().value(0);
    let lbl = labels.as_any().downcast_ref::<StringArray>().unwrap();
    assert_eq!(lbl.len(), 2);
    assert_eq!(lbl.value(0), "car");
    assert_eq!(lbl.value(1), "car");

    // Locate car2 (the convenience-field box) by its center [0, 10, -0.85] and
    // assert its decoded geometry: size full-extents [1.5, 4.5, 1.7] and the
    // scalar-FIRST identity quaternion [1,0,0,0] → scalar-LAST [0,0,0,1].
    let cvals = c.values();
    let car2 = (0..2)
        .find(|&i| {
            (cvals[i * 3] - 0.0).abs() < 1e-5
                && (cvals[i * 3 + 1] - 10.0).abs() < 1e-5
                && (cvals[i * 3 + 2] - (-0.85)).abs() < 1e-5
        })
        .expect("car2 (convenience-field cuboid) should be present");
    let svals = sz.values();
    assert_eq!(
        &svals[car2 * 3..car2 * 3 + 3],
        &[1.5, 4.5, 1.7],
        "car2 size full-extents"
    );
    let qvals = q.values();
    assert_eq!(
        &qvals[car2 * 4..car2 * 4 + 4],
        &[0.0, 0.0, 0.0, 1.0],
        "car2 identity quaternion (scalar-last)"
    );
}
