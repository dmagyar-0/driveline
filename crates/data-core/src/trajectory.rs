//! `TrajectoryReader`: ingests a Driveline **trajectory** JSON file of
//! per-frame predicted ego future trajectories (Alpamayo-style) and surfaces
//! one [`ChannelKind::Trajectory`] channel — a per-frame set of one-or-more
//! candidate waypoint polylines (each with a confidence) for the 3D scene
//! panel.
//!
//! This is a dedicated format, NOT bolted onto OpenLABEL, but it mirrors the
//! OpenLABEL reader's shape aggressively: per-frame storage, lenient
//! `serde_json::Value` traversal, a per-frame Arrow RecordBatch with
//! `List<Float32>`/`List<Int32>` columns, plus a `frame_times` accessor the 3D
//! panel binary-searches to map the cursor to a frame index.
//!
//! ## Source structure (what `open` expects)
//!
//! Root key `trajectory`:
//! ```json
//! { "trajectory": {
//!     "frame_id": "ego",
//!     "frames": [
//!       { "timestamp": <ns>,
//!         "paths": [
//!           { "confidence": 0.92, "points": [[x,y,z], [x,y,z], ...] },
//!           { "confidence": 0.05, "points": [[x,y], ...] }
//!         ] }
//!     ] } }
//! ```
//!
//! Parsing is lenient: a frame that omits `confidence` defaults to `1.0`; a 2D
//! point `[x, y]` is accepted with `z = 0`; a numeric `timestamp` above
//! [`NS_MAGNITUDE_GUARD`] is taken as nanoseconds, otherwise as seconds.
//! Points are metres in the vehicle z-up frame (same frame as boxes/lidar), and
//! pass through unchanged.
//!
//! ## Fetch schema (what `fetch_range` returns)
//!
//! One row per frame in the window:
//!
//! | column         | Arrow type         | meaning                              |
//! | -------------- | ------------------ | ------------------------------------ |
//! | `ts`           | `Timestamp(ns,UTC)`| frame timestamp                      |
//! | `points`       | `List<Float32>`    | all paths concatenated, flat xyz     |
//! | `path_lengths` | `List<Int32>`      | number of POINTS per candidate path  |
//! | `confidences`  | `List<Float32>`    | one per candidate path               |
//!
//! The decoder splits `points` into individual paths using `path_lengths`.

use std::sync::Arc;

use arrow_array::builder::{Float32Builder, Int32Builder, ListBuilder};
use arrow_array::{RecordBatch, TimestampNanosecondArray};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use serde_json::Value;

use crate::reader::{ArrowIpc, Reader};
use crate::types::{Channel, ChannelId, ChannelKind, FetchOpts, SourceKind, SourceMeta, TimeRange};

/// Default per-frame display duration (ns) when a source has a single frame (or
/// we otherwise can't infer the cadence). ~33.3 ms ≈ 30 Hz.
const DEFAULT_FRAME_PERIOD_NS: i64 = 33_333_333;

/// Synthesised inter-frame step (ns) when a frame has no timestamp — 30 Hz.
const SYNTH_FRAME_STEP_NS: i64 = 33_333_333;

/// Above this magnitude a numeric `timestamp` is assumed to be already in
/// nanoseconds rather than seconds (1e15 ns ≈ 1970-01-12, while real
/// epoch-seconds are ~1.7e9 — well below this guard).
const NS_MAGNITUDE_GUARD: f64 = 1e15;

/// One decoded frame: its timestamp plus the per-path geometry, flattened so
/// `fetch_range` can append slices directly. `points` holds every candidate
/// path's xyz concatenated (length `3 * sum(path_lengths)`), `path_lengths`
/// has one entry (a point count) per candidate path, and `confidences` has one
/// entry per candidate path.
struct Frame {
    ts_ns: i64,
    points: Vec<f32>,
    path_lengths: Vec<i32>,
    confidences: Vec<f32>,
}

impl Frame {
    fn path_count(&self) -> usize {
        self.confidences.len()
    }
}

pub struct TrajectoryReader {
    meta: SourceMeta,
    channel_id: ChannelId,
    frames: Vec<Frame>,
    /// Parallel to `frames`, ascending — the scene panel pulls this to map a
    /// cursor time to a frame index without a wasm round-trip per tick.
    frame_ts: Vec<i64>,
}

impl TrajectoryReader {
    /// Ascending frame timestamps (ns), one per frame. The 3D panel binary
    /// searches this locally to decide which frame is active at the cursor.
    /// Mirrors `OpenLabelReader::frame_times`.
    pub fn frame_times(&self) -> &[i64] {
        &self.frame_ts
    }

    /// Parse trajectory JSON bytes into a reader. Leniently traverses
    /// `serde_json::Value`; malformed individual paths/points are skipped
    /// rather than failing the whole file.
    fn parse(bytes: &[u8]) -> crate::Result<Self> {
        let root: Value = serde_json::from_slice(bytes)
            .map_err(|e| crate::Error::TrajectoryParse(e.to_string()))?;
        let tr = root
            .get("trajectory")
            .ok_or_else(|| crate::Error::TrajectoryParse("missing `trajectory` root key".into()))?;

        // Channel name: trajectory.frame_id, else trajectory.name, else "trajectory".
        let name = tr
            .get("frame_id")
            .and_then(Value::as_str)
            .or_else(|| tr.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| "trajectory".to_string());

        let mut frames: Vec<Frame> = Vec::new();

        if let Some(frame_arr) = tr.get("frames").and_then(Value::as_array) {
            for (frame_no, frame_val) in frame_arr.iter().enumerate() {
                let ts_ns = frame_timestamp_ns(frame_val, frame_no as i64);
                let mut frame = Frame {
                    ts_ns,
                    points: Vec::new(),
                    path_lengths: Vec::new(),
                    confidences: Vec::new(),
                };
                if let Some(paths) = frame_val.get("paths").and_then(Value::as_array) {
                    for path in paths {
                        collect_path(path, &mut frame);
                    }
                }
                frames.push(frame);
            }
        }

        Ok(Self::from_frames(frames, name))
    }

    /// Build a reader from decoded frames, computing the channel meta and the
    /// covering time range. Frames are sorted ascending; `name` becomes both
    /// the channel id and display name. Mirrors `OpenLabelReader::from_frames`.
    fn from_frames(mut frames: Vec<Frame>, name: String) -> Self {
        frames.sort_by_key(|f| f.ts_ns);
        let frame_ts: Vec<i64> = frames.iter().map(|f| f.ts_ns).collect();

        let period = infer_period_ns(&frame_ts);
        let time_range = match (frame_ts.first(), frame_ts.last()) {
            (Some(&a), Some(&b)) => TimeRange {
                start_ns: a,
                end_ns: b.saturating_add(period),
            },
            _ => TimeRange::empty(),
        };

        // "sample_count" is the peak paths-per-frame, so the UI can show how
        // many candidate trajectories the model emits. Frame count is the
        // channel's frame count, surfaced via `frame_times`.
        let max_paths = frames.iter().map(Frame::path_count).max().unwrap_or(0) as u64;
        let channel = Channel {
            id: name.clone(),
            source_id: String::new(),
            name: name.clone(),
            kind: ChannelKind::Trajectory,
            dtype: None,
            unit: None,
            sample_count: max_paths,
            time_range,
        };

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::Trajectory,
            time_range,
            channels: vec![channel],
        };

        TrajectoryReader {
            meta,
            channel_id: name,
            frames,
            frame_ts,
        }
    }

    /// Open from an owned buffer (preferred at the wasm boundary).
    pub fn open_owned(bytes: Vec<u8>) -> crate::Result<Self> {
        Self::parse(&bytes)
    }

    /// Arrow schema `fetch_range` emits. `points`/`confidences` are
    /// `List<Float32>`, `path_lengths` is `List<Int32>` — one list per frame
    /// row.
    fn fetch_schema() -> Arc<Schema> {
        let points_item = Arc::new(Field::new("item", DataType::Float32, true));
        let lengths_item = Arc::new(Field::new("item", DataType::Int32, true));
        let conf_item = Arc::new(Field::new("item", DataType::Float32, true));
        Arc::new(Schema::new(vec![
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
                false,
            ),
            Field::new("points", DataType::List(points_item), false),
            Field::new("path_lengths", DataType::List(lengths_item), false),
            Field::new("confidences", DataType::List(conf_item), false),
        ]))
    }
}

impl Reader for TrajectoryReader {
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        Self::parse(bytes)
    }

    fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    fn fetch_range(
        &self,
        channel_id: &str,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        if channel_id != self.channel_id {
            return Err(crate::Error::ChannelNotFound(channel_id.to_string()));
        }

        // Frames overlapping [start, end). With `include_prev` we also emit the
        // frame just before the window — that's how the panel asks for "the
        // frame active at the cursor" (a zero/one-width window + prev). Mirrors
        // the OpenLABEL reader.
        let ts = &self.frame_ts;
        let start_idx = ts.partition_point(|&t| t < range.start_ns);
        let end_idx = ts.partition_point(|&t| t < range.end_ns).max(start_idx);
        let prev_idx = if opts.include_prev && start_idx > 0 {
            Some(start_idx - 1)
        } else {
            None
        };

        let mut idxs: Vec<usize> = Vec::new();
        if let Some(p) = prev_idx {
            idxs.push(p);
        }
        idxs.extend(start_idx..end_idx);

        let schema = Self::fetch_schema();

        let total_points: usize = idxs.iter().map(|&i| self.frames[i].points.len()).sum();
        let total_paths: usize = idxs.iter().map(|&i| self.frames[i].path_count()).sum();

        let mut ts_vals: Vec<i64> = Vec::with_capacity(idxs.len());
        let mut points_b =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_points), idxs.len());
        let mut lengths_b =
            ListBuilder::with_capacity(Int32Builder::with_capacity(total_paths), idxs.len());
        let mut conf_b =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_paths), idxs.len());

        for &i in &idxs {
            let frame = &self.frames[i];
            ts_vals.push(frame.ts_ns);
            points_b.values().append_slice(&frame.points);
            points_b.append(true);
            lengths_b.values().append_slice(&frame.path_lengths);
            lengths_b.append(true);
            conf_b.values().append_slice(&frame.confidences);
            conf_b.append(true);
        }

        let ts_array = TimestampNanosecondArray::from(ts_vals).with_timezone("UTC");
        let points_array = points_b.finish();
        let lengths_array = lengths_b.finish();
        let conf_array = conf_b.finish();

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(ts_array),
                Arc::new(points_array),
                Arc::new(lengths_array),
                Arc::new(conf_array),
            ],
        )?;

        crate::arrow::write_ipc(schema, batch)
    }
}

/// Pull one candidate path's `points` (an array of `[x,y,z]` or `[x,y]`) and
/// its `confidence` (default `1.0`) out of a path object and append them to
/// `frame`. A path with zero valid points is skipped entirely (no length /
/// confidence entry) rather than failing the file.
fn collect_path(path: &Value, frame: &mut Frame) {
    let points = match path.get("points").and_then(Value::as_array) {
        Some(p) => p,
        None => return,
    };

    let mut n: i32 = 0;
    for pt in points {
        if let Some([x, y, z]) = read_point(pt) {
            frame.points.push(x);
            frame.points.push(y);
            frame.points.push(z);
            n += 1;
        }
    }
    if n == 0 {
        return;
    }

    let confidence = path
        .get("confidence")
        .and_then(Value::as_f64)
        .map(|c| c as f32)
        .unwrap_or(1.0);

    frame.path_lengths.push(n);
    frame.confidences.push(confidence);
}

/// Read a single waypoint: a JSON array `[x, y, z]` (or `[x, y]` → z = 0) of
/// numbers. Returns `None` (skip the point) for any other shape.
fn read_point(v: &Value) -> Option<[f32; 3]> {
    let arr = v.as_array()?;
    let nums: Vec<f64> = arr.iter().filter_map(Value::as_f64).collect();
    match nums.len() {
        2 => Some([nums[0] as f32, nums[1] as f32, 0.0]),
        3 => Some([nums[0] as f32, nums[1] as f32, nums[2] as f32]),
        _ => None,
    }
}

/// Resolve a frame's timestamp (ns). Reads `timestamp` (polymorphic string |
/// number); falls back to a synthesised value from the frame index when
/// absent/unparseable. Mirrors `openlabel::frame_timestamp_ns`.
fn frame_timestamp_ns(frame_val: &Value, frame_no: i64) -> i64 {
    let synth = frame_no.saturating_mul(SYNTH_FRAME_STEP_NS);
    match frame_val.get("timestamp") {
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.abs() > NS_MAGNITUDE_GUARD {
                // Already nanoseconds.
                f.round() as i64
            } else {
                // Seconds → ns.
                (f * 1e9).round() as i64
            }
        }
        Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(synth),
        _ => synth,
    }
}

/// Infer the per-frame display duration from the median inter-frame gap; falls
/// back to [`DEFAULT_FRAME_PERIOD_NS`] for fewer than two frames. Mirrors the
/// OpenLABEL reader's `infer_period_ns`.
fn infer_period_ns(frame_ts: &[i64]) -> i64 {
    if frame_ts.len() < 2 {
        return DEFAULT_FRAME_PERIOD_NS;
    }
    let mut gaps: Vec<i64> = frame_ts
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|&g| g > 0)
        .collect();
    if gaps.is_empty() {
        return DEFAULT_FRAME_PERIOD_NS;
    }
    gaps.sort_unstable();
    gaps[gaps.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::cast::AsArray;
    use arrow_array::{Array, Float32Array, Int32Array};
    use arrow_ipc::reader::FileReader;
    use std::io::Cursor;

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1);
        batches.into_iter().next().unwrap()
    }

    /// A small two-frame file. Frame 0 (numeric ns ts) has two paths: a
    /// 3-point primary (confidence 0.9) and a 2-point alternate (confidence
    /// 0.1, given as a 2D point exercising the z=0 fallback). Frame 1 (seconds
    /// ts) has one path with default confidence (no `confidence` field).
    const SAMPLE: &str = r#"
    { "trajectory": {
      "frame_id": "ego",
      "frames": [
        {
          "timestamp": 1700000000000000000,
          "paths": [
            { "confidence": 0.9, "points": [[0,0,0],[1,0,0.1],[2,0.5,0.2]] },
            { "confidence": 0.1, "points": [[0,0],[1,1]] }
          ]
        },
        {
          "timestamp": 1.5,
          "paths": [
            { "points": [[0,0,0],[3,0,0]] }
          ]
        }
      ]
    } }
    "#;

    #[test]
    fn parses_meta_and_frames() {
        let r = TrajectoryReader::open(SAMPLE.as_bytes()).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Trajectory);
        assert_eq!(r.meta().channels.len(), 1);
        let ch = &r.meta().channels[0];
        assert_eq!(ch.name, "ego");
        assert_eq!(ch.kind, ChannelKind::Trajectory);
        assert_eq!(ch.sample_count, 2); // peak paths-per-frame

        // Frame ordering: 1.5 s → 1_500_000_000 ns sorts before the 1.7e18 ns
        // frame.
        let times = r.frame_times();
        assert_eq!(times.len(), 2);
        assert_eq!(times[0], 1_500_000_000);
        assert_eq!(times[1], 1_700_000_000_000_000_000);
    }

    #[test]
    fn fetch_splits_variable_length_paths() {
        let r = TrajectoryReader::open(SAMPLE.as_bytes()).unwrap();
        // The 1.7e18-ns frame holds the two-path geometry.
        let t = r.frame_times()[1];
        let ipc = r
            .fetch_range(
                "ego",
                TimeRange {
                    start_ns: t,
                    end_ns: t + 1,
                },
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 1);

        let ts = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        assert_eq!(ts.value(0), 1_700_000_000_000_000_000);

        // points: path0 (3 pts) then path1 (2 pts, 2D → z=0), all xyz flat.
        let points = batch.column(1).as_list::<i32>().value(0);
        let p = points.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(
            p.values(),
            &[0.0, 0.0, 0.0, 1.0, 0.0, 0.1, 2.0, 0.5, 0.2, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0]
        );

        // path_lengths: 3 points, then 2 points → splits `points`.
        let lengths = batch.column(2).as_list::<i32>().value(0);
        let l = lengths.as_any().downcast_ref::<Int32Array>().unwrap();
        assert_eq!(l.values(), &[3, 2]);

        // confidences: 0.9, 0.1.
        let conf = batch.column(3).as_list::<i32>().value(0);
        let c = conf.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(c.values(), &[0.9, 0.1]);
    }

    #[test]
    fn missing_confidence_defaults_to_one() {
        let r = TrajectoryReader::open(SAMPLE.as_bytes()).unwrap();
        // Frame 0 (1.5 s) holds the single-path frame with no `confidence`.
        let t = r.frame_times()[0];
        let ipc = r
            .fetch_range(
                "ego",
                TimeRange {
                    start_ns: t,
                    end_ns: t + 1,
                },
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);

        let conf = batch.column(3).as_list::<i32>().value(0);
        let c = conf.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(c.values(), &[1.0]);

        let lengths = batch.column(2).as_list::<i32>().value(0);
        let l = lengths.as_any().downcast_ref::<Int32Array>().unwrap();
        assert_eq!(l.values(), &[2]);
    }

    #[test]
    fn empty_path_is_skipped() {
        // A path with no valid points contributes no length/confidence entry.
        let json = r#"
        { "trajectory": { "frames": [
          { "timestamp": 0, "paths": [
            { "confidence": 0.5, "points": [] },
            { "confidence": 0.9, "points": [[0,0,0],[1,1,1]] }
          ] }
        ] } }
        "#;
        let r = TrajectoryReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.meta().channels[0].sample_count, 1); // only the valid path
        let t = r.frame_times()[0];
        let ipc = r
            .fetch_range(
                "trajectory",
                TimeRange {
                    start_ns: t,
                    end_ns: t + 1,
                },
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        let conf = batch.column(3).as_list::<i32>().value(0);
        let c = conf.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(c.values(), &[0.9]);
    }

    #[test]
    fn synth_timestamp_when_absent() {
        // A frame with no `timestamp` gets a synthesised 30 Hz step.
        let json = r#"
        { "trajectory": { "frames": [
          { "paths": [{ "points": [[0,0,0],[1,0,0]] }] },
          { "paths": [{ "points": [[0,0,0],[1,0,0]] }] }
        ] } }
        "#;
        let r = TrajectoryReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.frame_times(), &[0, SYNTH_FRAME_STEP_NS]);
    }

    #[test]
    fn unknown_channel_errors() {
        let r = TrajectoryReader::open(SAMPLE.as_bytes()).unwrap();
        let err = r
            .fetch_range("nope", r.meta().time_range, FetchOpts::default())
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn missing_root_key_errors() {
        let res = TrajectoryReader::open(br#"{ "nope": {} }"#);
        assert!(matches!(res, Err(crate::Error::TrajectoryParse(_))));
    }
}
