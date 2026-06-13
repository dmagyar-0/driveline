//! Conformance tests: open the committed map-geometry fixtures — the simple
//! `drivelineMap` JSON (`map_simple.json`) and the OpenDRIVE `.xodr`
//! (`map_opendrive.xodr`, `map_example_intersection.xodr`) — through
//! `MapGeometryReader` and assert each yields at least one typed polyline that
//! round-trips through `fetch_range`.

use data_core::{ChannelKind, FetchOpts, MapGeometryReader, Reader, SourceKind, TimeRange};

use arrow_array::cast::AsArray;
use arrow_array::{Array, Float32Array, Int32Array, StringArray};
use arrow_ipc::reader::FileReader;
use std::io::Cursor;

const SIMPLE: &[u8] = include_bytes!("../../../test-fixtures/map_simple.json");
const OPENDRIVE: &[u8] = include_bytes!("../../../test-fixtures/map_opendrive.xodr");
const INTERSECTION: &[u8] = include_bytes!("../../../test-fixtures/map_example_intersection.xodr");

/// Decode the single static frame and return `(point_count, feature_types)`.
fn frame_summary(r: &MapGeometryReader) -> (usize, Vec<String>) {
    let ch = &r.meta().channels[0];
    let t = r.frame_times()[0];
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

    let points = batch.column(1).as_list::<i32>().value(0);
    let p = points.as_any().downcast_ref::<Float32Array>().unwrap();
    for i in 0..p.len() {
        assert!(p.value(i).is_finite(), "non-finite coord at {i}");
    }

    let lengths = batch.column(2).as_list::<i32>().value(0);
    let l = lengths.as_any().downcast_ref::<Int32Array>().unwrap();
    // path_lengths must sum to the number of (x,y,z) triples in `points`.
    let sum: i64 = l.values().iter().map(|&v| v as i64).sum();
    assert_eq!(sum * 3, p.len() as i64, "path_lengths must split points");

    let types = batch.column(3).as_list::<i32>().value(0);
    let t = types.as_any().downcast_ref::<StringArray>().unwrap();
    assert_eq!(t.len(), l.len(), "one type per polyline");
    let feature_types: Vec<String> = (0..t.len()).map(|i| t.value(i).to_string()).collect();
    (p.len() / 3, feature_types)
}

#[test]
fn opens_simple_drivelinemap_fixture() {
    let r = MapGeometryReader::open(SIMPLE).expect("parse drivelineMap fixture");
    assert_eq!(r.meta().kind, SourceKind::MapGeometry);
    assert_eq!(r.meta().channels.len(), 1);
    let ch = &r.meta().channels[0];
    assert_eq!(ch.kind, ChannelKind::MapGeometry);
    assert_eq!(r.frame_times(), &[0]);
    assert!(ch.sample_count >= 3, "expected ≥3 polylines");

    let (pts, types) = frame_summary(&r);
    assert!(pts >= 6);
    // The fixture exercises several typed features.
    assert!(types.iter().any(|t| t == "lane_boundary"));
    assert!(types.iter().any(|t| t == "road_edge"));
    assert!(types.iter().any(|t| t == "centerline"));
}

#[test]
fn opens_opendrive_fixture() {
    let r = MapGeometryReader::open(OPENDRIVE).expect("parse OpenDRIVE fixture");
    assert_eq!(r.meta().kind, SourceKind::MapGeometry);
    let ch = &r.meta().channels[0];
    assert_eq!(ch.kind, ChannelKind::MapGeometry);
    assert_eq!(r.frame_times(), &[0]);
    // One centerline + ≥1 lane border each side.
    assert!(ch.sample_count >= 3, "got {}", ch.sample_count);

    let (_pts, types) = frame_summary(&r);
    assert!(types.iter().any(|t| t == "centerline"));
    assert!(types.iter().any(|t| t == "road_edge"));
}

#[test]
fn opens_intersection_example_fixture() {
    let r = MapGeometryReader::open(INTERSECTION).expect("parse intersection example");
    let ch = &r.meta().channels[0];
    assert_eq!(ch.kind, ChannelKind::MapGeometry);
    // A multi-road network → many polylines.
    assert!(
        ch.sample_count >= 4,
        "expected a rich road network, got {}",
        ch.sample_count
    );
    let (pts, _types) = frame_summary(&r);
    assert!(pts > 20, "expected a dense network, got {pts} points");
}
