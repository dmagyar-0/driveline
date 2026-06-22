//! `MapGeometryReader`: ingests road-network geometry (a "map") and surfaces
//! one [`ChannelKind::MapGeometry`] channel — a single static frame holding a
//! set of typed polylines (lane boundaries, road edges, centerlines,
//! crosswalks, stop lines, …) for the 3D scene panel to render as lines.
//!
//! Two input formats, auto-detected by the first non-whitespace byte:
//! - `{` → the simple **`drivelineMap`** JSON format (the "easy" format).
//! - `<` → an **OpenDRIVE** (`.xodr`) XML road network (a parsed subset).
//!
//! Anything else fails the open with [`crate::Error::MapGeometryParse`].
//!
//! This mirrors the OpenLABEL/trajectory readers aggressively: a single static
//! frame at `t = 0`, lenient parsing (skip malformed features/roads rather than
//! failing the file), an Arrow `RecordBatch` of `List<Float32>`/`List<Int32>`/
//! `List<Utf8>` columns, plus a `frame_times()` accessor that always returns
//! `&[0]`.
//!
//! ## Fetch schema (what `fetch_range` returns)
//!
//! One row per frame in the window (here always ≤ 1 row):
//!
//! | column         | Arrow type          | meaning                                    |
//! | -------------- | ------------------- | ------------------------------------------ |
//! | `ts`           | `Timestamp(ns,UTC)` | frame timestamp (always 0)                 |
//! | `points`       | `List<Float32>`     | flat `[x,y,z, …]` of all polylines         |
//! | `path_lengths` | `List<Int32>`       | point count per polyline (splits `points`) |
//! | `types`        | `List<Utf8>`        | feature type per polyline (one per path)   |
//!
//! The decoder splits `points` into individual polylines using `path_lengths`,
//! one `types` entry per polyline. Coordinates are metres in the z-up scene
//! frame (x-forward/east, y-left/north) and pass through unchanged.

use std::sync::Arc;

use arrow_array::builder::{Float32Builder, Int32Builder, ListBuilder, StringBuilder};
use arrow_array::{RecordBatch, TimestampNanosecondArray};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use serde_json::Value;

use crate::reader::{ArrowIpc, Reader};
use crate::types::{Channel, ChannelId, ChannelKind, FetchOpts, SourceKind, SourceMeta, TimeRange};

/// Per-frame display duration (ns) for a single-frame source. ~33.3 ms ≈ 30 Hz.
/// A map is static, so this only sets the (cosmetic) covering time range width.
const DEFAULT_FRAME_PERIOD_NS: i64 = 33_333_333;

/// Target spacing (metres) when sampling an OpenDRIVE reference-line geometry
/// into a polyline. The contract asks for ~1.0 m spacing, ≥ 2 points/geometry.
const SAMPLE_STEP_M: f64 = 1.0;

/// Integration step (metres) for the clothoid/spiral numeric integration. A
/// finer step than the output spacing keeps the heading/position drift small.
const SPIRAL_INTEGRATION_STEP_M: f64 = 0.5;

/// One polyline (a "feature"): its flat xyz coordinates and a type string.
struct Feature {
    /// `[x, y, z, x, y, z, …]`, length `3 * point_count`.
    points: Vec<f32>,
    /// One of the contract's lowercase feature-type strings.
    feature_type: String,
}

impl Feature {
    fn point_count(&self) -> i32 {
        (self.points.len() / 3) as i32
    }
}

/// The single static frame: every polyline concatenated, ready for `fetch_range`
/// to append directly.
struct Frame {
    /// Every feature's xyz concatenated (length `3 * sum(path_lengths)`).
    points: Vec<f32>,
    /// One point-count per feature (splits `points`).
    path_lengths: Vec<i32>,
    /// One type string per feature.
    types: Vec<String>,
}

impl Frame {
    fn from_features(features: Vec<Feature>) -> Self {
        let mut points = Vec::new();
        let mut path_lengths = Vec::new();
        let mut types = Vec::new();
        for f in features {
            // A feature with < 2 points isn't a polyline; skip it.
            if f.point_count() < 2 {
                continue;
            }
            path_lengths.push(f.point_count());
            types.push(f.feature_type);
            points.extend_from_slice(&f.points);
        }
        Frame {
            points,
            path_lengths,
            types,
        }
    }

    fn feature_count(&self) -> usize {
        self.path_lengths.len()
    }
}

pub struct MapGeometryReader {
    meta: SourceMeta,
    channel_id: ChannelId,
    frame: Frame,
    /// Always `[0]` — a map is a single static frame. Mirrors
    /// `OpenLabelReader::frame_times` (static form).
    frame_ts: Vec<i64>,
}

impl MapGeometryReader {
    /// Ascending frame timestamps (ns) — always `&[0]` for a static map. The 3D
    /// panel binary-searches this to map the cursor to a frame index (here there
    /// is only ever frame 0). Mirrors `OpenLabelReader::frame_times`.
    pub fn frame_times(&self) -> &[i64] {
        &self.frame_ts
    }

    /// Parse map-geometry bytes into a reader. Auto-detects the format by the
    /// first non-whitespace byte: `{` → simple JSON, `<` → OpenDRIVE XML.
    fn parse(bytes: &[u8]) -> crate::Result<Self> {
        let first = bytes.iter().copied().find(|b| !b.is_ascii_whitespace());
        match first {
            Some(b'{') => Self::parse_json(bytes),
            Some(b'<') => Self::parse_opendrive(bytes),
            Some(c) => Err(crate::Error::MapGeometryParse(format!(
                "unrecognised map geometry format (first byte {:?}); expected `{{` (JSON) or `<` (OpenDRIVE)",
                c as char
            ))),
            None => Err(crate::Error::MapGeometryParse(
                "empty map geometry input".into(),
            )),
        }
    }

    /// Parse the simple `drivelineMap` JSON format. Leniently traverses
    /// `serde_json::Value`; malformed features (no/short polyline) are skipped.
    fn parse_json(bytes: &[u8]) -> crate::Result<Self> {
        let root: Value = serde_json::from_slice(bytes)
            .map_err(|e| crate::Error::MapGeometryParse(e.to_string()))?;
        let map = root.get("drivelineMap").ok_or_else(|| {
            crate::Error::MapGeometryParse("missing `drivelineMap` root key".into())
        })?;

        // Channel name: drivelineMap.name, else "map".
        let name = map
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "map".to_string());

        let mut features: Vec<Feature> = Vec::new();
        if let Some(arr) = map.get("features").and_then(Value::as_array) {
            for feat in arr {
                if let Some(f) = parse_json_feature(feat) {
                    features.push(f);
                }
            }
        }

        Ok(Self::from_features(features, name))
    }

    /// Parse an OpenDRIVE (`.xodr`) road network into reference-line and
    /// best-effort lane-border polylines. Per-road parse trouble falls back to
    /// the centerline only; nothing fails the whole file.
    fn parse_opendrive(bytes: &[u8]) -> crate::Result<Self> {
        let text = std::str::from_utf8(bytes)
            .map_err(|e| crate::Error::MapGeometryParse(format!("OpenDRIVE not UTF-8: {e}")))?;
        let doc = roxmltree::Document::parse(text)
            .map_err(|e| crate::Error::MapGeometryParse(format!("OpenDRIVE XML parse: {e}")))?;
        let root = doc.root_element();
        if root.tag_name().name() != "OpenDRIVE" {
            return Err(crate::Error::MapGeometryParse(format!(
                "root element is <{}>, expected <OpenDRIVE>",
                root.tag_name().name()
            )));
        }

        // Channel name: <OpenDRIVE><header name="…">, else "road_network".
        let name = root
            .children()
            .find(|c| c.has_tag_name("header"))
            .and_then(|h| h.attribute("name"))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "road_network".to_string());

        let mut features: Vec<Feature> = Vec::new();
        for road in root.children().filter(|c| c.has_tag_name("road")) {
            sample_road(&road, &mut features);
        }

        Ok(Self::from_features(features, name))
    }

    /// Build a reader from decoded features, computing the channel meta and a
    /// (cosmetic) covering time range. `name` becomes both channel id and
    /// display name. Mirrors `OpenLabelReader::from_frames` (static form).
    fn from_features(features: Vec<Feature>, name: String) -> Self {
        let frame = Frame::from_features(features);

        // Single static frame at t = 0; give it a nominal one-frame width.
        let time_range = TimeRange {
            start_ns: 0,
            end_ns: DEFAULT_FRAME_PERIOD_NS,
        };

        // "sample_count" is the number of polylines (features), so the UI can
        // show how dense the road network is.
        let channel = Channel {
            id: name.clone(),
            source_id: String::new(),
            name: name.clone(),
            kind: ChannelKind::MapGeometry,
            dtype: None,
            unit: None,
            sample_count: frame.feature_count() as u64,
            time_range,
        };

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::MapGeometry,
            time_range,
            channels: vec![channel],
        };

        MapGeometryReader {
            meta,
            channel_id: name,
            frame,
            frame_ts: vec![0],
        }
    }

    /// Open from an owned buffer (preferred at the wasm boundary).
    pub fn open_owned(bytes: Vec<u8>) -> crate::Result<Self> {
        Self::parse(&bytes)
    }

    /// Arrow schema `fetch_range` emits. `points` is `List<Float32>`,
    /// `path_lengths` is `List<Int32>`, `types` is `List<Utf8>` — one list per
    /// frame row.
    fn fetch_schema() -> Arc<Schema> {
        let points_item = Arc::new(Field::new("item", DataType::Float32, true));
        let lengths_item = Arc::new(Field::new("item", DataType::Int32, true));
        let types_item = Arc::new(Field::new("item", DataType::Utf8, true));
        Arc::new(Schema::new(vec![
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
                false,
            ),
            Field::new("points", DataType::List(points_item), false),
            Field::new("path_lengths", DataType::List(lengths_item), false),
            Field::new("types", DataType::List(types_item), false),
        ]))
    }
}

impl Reader for MapGeometryReader {
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

        // Single frame at t = 0. With `include_prev` semantics identical to
        // OpenLABEL: the frame is emitted if it overlaps [start, end), or if it
        // is the "previous" frame just before the window. partition_point over
        // the one-element `[0]` table keeps the logic in lock-step.
        let ts = &self.frame_ts;
        let (lo, hi) =
            crate::time::range_window(ts, range.start_ns, range.end_ns, opts.include_prev);
        // Contiguous because `include_prev` (when active) folds the frame
        // immediately before the window into `lo`: optional prev + body.
        let idxs: Vec<usize> = (lo..hi).collect();

        let schema = Self::fetch_schema();

        let total_points: usize = idxs.len() * self.frame.points.len();
        let total_features: usize = idxs.len() * self.frame.feature_count();

        let mut ts_vals: Vec<i64> = Vec::with_capacity(idxs.len());
        let mut points_b =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_points), idxs.len());
        let mut lengths_b =
            ListBuilder::with_capacity(Int32Builder::with_capacity(total_features), idxs.len());
        let mut types_b = ListBuilder::with_capacity(StringBuilder::new(), idxs.len());

        for &i in &idxs {
            // Only frame 0 exists; `i` is always 0 here but we keep the loop for
            // parity with the other static readers.
            debug_assert_eq!(i, 0);
            ts_vals.push(self.frame_ts[i]);
            points_b.values().append_slice(&self.frame.points);
            points_b.append(true);
            lengths_b.values().append_slice(&self.frame.path_lengths);
            lengths_b.append(true);
            for t in &self.frame.types {
                types_b.values().append_value(t);
            }
            types_b.append(true);
        }

        let ts_array = TimestampNanosecondArray::from(ts_vals).with_timezone("UTC");
        let points_array = points_b.finish();
        let lengths_array = lengths_b.finish();
        let types_array = types_b.finish();

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(ts_array),
                Arc::new(points_array),
                Arc::new(lengths_array),
                Arc::new(types_array),
            ],
        )?;

        crate::arrow::write_ipc(schema, batch)
    }
}

// ---------------------------------------------------------------------------
// Simple `drivelineMap` JSON parsing
// ---------------------------------------------------------------------------

/// Canonicalise a feature-type string to one of the contract's lowercase
/// values, mapping anything unknown to `"other"`.
fn normalise_type(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some("lane_boundary") => "lane_boundary",
        Some("road_edge") => "road_edge",
        Some("centerline") => "centerline",
        Some("crosswalk") => "crosswalk",
        Some("stop_line") => "stop_line",
        Some("driving") => "driving",
        _ => "other",
    }
    .to_string()
}

/// Parse one `drivelineMap` feature object: `{ type?, polyline: [[x,y(,z)], …] }`.
/// Needs ≥ 2 valid points, else returns `None` (skip the feature).
fn parse_json_feature(feat: &Value) -> Option<Feature> {
    let polyline = feat.get("polyline").and_then(Value::as_array)?;
    let mut points: Vec<f32> = Vec::with_capacity(polyline.len() * 3);
    for pt in polyline {
        if let Some([x, y, z]) = read_point(pt) {
            points.push(x);
            points.push(y);
            points.push(z);
        }
    }
    if points.len() < 6 {
        return None; // fewer than 2 points
    }
    let feature_type = normalise_type(feat.get("type").and_then(Value::as_str));
    Some(Feature {
        points,
        feature_type,
    })
}

/// Read a single point: a JSON array `[x, y, z]` (or `[x, y]` → z = 0) of
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

// ---------------------------------------------------------------------------
// OpenDRIVE reference-line + lane-border sampling
// ---------------------------------------------------------------------------

/// A sampled reference-line point: planar pose `(x, y, heading)` at arc-length
/// `s`. Lane borders are offset perpendicular to `heading` from these.
#[derive(Clone, Copy)]
struct RefPoint {
    s: f64,
    x: f64,
    y: f64,
    hdg: f64,
}

/// Parse `attr` on `node` as `f64`, defaulting to `default` when absent or
/// unparseable.
fn attr_f64(node: &roxmltree::Node, attr: &str, default: f64) -> f64 {
    node.attribute(attr)
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(default)
}

/// Sample one `<road>`: emit its reference line as a `"centerline"` feature and,
/// best-effort, lane-border polylines from the first `<laneSection>`. Any
/// per-road parse trouble degrades to centerline-only — never fails the file.
fn sample_road(road: &roxmltree::Node, out: &mut Vec<Feature>) {
    let plan_view = match road.children().find(|c| c.has_tag_name("planView")) {
        Some(p) => p,
        None => return,
    };

    // Sample the reference line geometry-by-geometry into a dense polyline,
    // carrying arc-length `s` so the elevation profile and lane offsets can be
    // evaluated per point.
    let mut refline: Vec<RefPoint> = Vec::new();
    for geom in plan_view.children().filter(|c| c.has_tag_name("geometry")) {
        sample_geometry(&geom, &mut refline);
    }
    if refline.len() < 2 {
        return;
    }

    // Elevation profile (optional) → z per arc-length.
    let elevations = parse_elevation_profile(road);

    // Reference line → "centerline" feature (with elevation applied).
    let mut center_pts: Vec<f32> = Vec::with_capacity(refline.len() * 3);
    for p in &refline {
        center_pts.push(p.x as f32);
        center_pts.push(p.y as f32);
        center_pts.push(eval_elevation(&elevations, p.s) as f32);
    }
    out.push(Feature {
        points: center_pts,
        feature_type: "centerline".to_string(),
    });

    // Lane borders — best-effort; any panic-free failure just skips them.
    sample_lane_borders(road, &refline, &elevations, out);
}

/// Sample one `<geometry s x y hdg length>` (with one child shape) into
/// `refline`, appending ≥ 2 points at ~`SAMPLE_STEP_M` spacing. Unknown or
/// malformed shapes fall back to a straight line so the reference line stays
/// continuous.
fn sample_geometry(geom: &roxmltree::Node, refline: &mut Vec<RefPoint>) {
    let s0 = attr_f64(geom, "s", 0.0);
    let x0 = attr_f64(geom, "x", 0.0);
    let y0 = attr_f64(geom, "y", 0.0);
    let hdg0 = attr_f64(geom, "hdg", 0.0);
    let length = attr_f64(geom, "length", 0.0);
    if !(length.is_finite() && length > 0.0) {
        return;
    }

    // Number of sample intervals (≥ 1 → ≥ 2 points).
    let n = ((length / SAMPLE_STEP_M).ceil() as usize).max(1);

    let shape = geom
        .children()
        .find(|c| c.is_element() && c.tag_name().name() != "userData");

    // Avoid duplicating the start point already appended by a previous geometry.
    let skip_first = matches!(refline.last(), Some(last) if (last.s - s0).abs() < 1e-6);

    let pts: Vec<RefPoint> = match shape.as_ref().map(|s| s.tag_name().name()) {
        Some("line") | None => sample_line(s0, x0, y0, hdg0, length, n),
        Some("arc") => {
            let k = attr_f64(shape.as_ref().unwrap(), "curvature", 0.0);
            sample_arc(s0, x0, y0, hdg0, length, k, n)
        }
        Some("spiral") => {
            let s = shape.as_ref().unwrap();
            let k0 = attr_f64(s, "curvStart", 0.0);
            let k1 = attr_f64(s, "curvEnd", 0.0);
            sample_spiral(s0, x0, y0, hdg0, length, k0, k1)
        }
        Some("poly3") => {
            let s = shape.as_ref().unwrap();
            let a = attr_f64(s, "a", 0.0);
            let b = attr_f64(s, "b", 0.0);
            let c = attr_f64(s, "c", 0.0);
            let d = attr_f64(s, "d", 0.0);
            sample_poly3(s0, x0, y0, hdg0, length, a, b, c, d, n)
        }
        Some("paramPoly3") => {
            let s = shape.as_ref().unwrap();
            let coeffs = [
                attr_f64(s, "aU", 0.0),
                attr_f64(s, "bU", 1.0),
                attr_f64(s, "cU", 0.0),
                attr_f64(s, "dU", 0.0),
                attr_f64(s, "aV", 0.0),
                attr_f64(s, "bV", 0.0),
                attr_f64(s, "cV", 0.0),
                attr_f64(s, "dV", 0.0),
            ];
            let normalized = s.attribute("pRange").map(str::trim) != Some("arcLength");
            sample_param_poly3(s0, x0, y0, hdg0, length, &coeffs, normalized, n)
        }
        // Unknown shape (e.g. an extension) → straight fallback.
        Some(_) => sample_line(s0, x0, y0, hdg0, length, n),
    };

    for (i, p) in pts.into_iter().enumerate() {
        if skip_first && i == 0 {
            continue;
        }
        refline.push(p);
    }
}

/// Straight line from `(x0, y0, hdg)`.
fn sample_line(s0: f64, x0: f64, y0: f64, hdg: f64, length: f64, n: usize) -> Vec<RefPoint> {
    let (sin_h, cos_h) = hdg.sin_cos();
    (0..=n)
        .map(|i| {
            let s = length * (i as f64) / (n as f64);
            RefPoint {
                s: s0 + s,
                x: x0 + cos_h * s,
                y: y0 + sin_h * s,
                hdg,
            }
        })
        .collect()
}

/// Constant-curvature arc from `(x0, y0, hdg)`, curvature `k` (1/m; sign gives
/// turn direction). `k == 0` degrades to a straight line.
fn sample_arc(s0: f64, x0: f64, y0: f64, hdg: f64, length: f64, k: f64, n: usize) -> Vec<RefPoint> {
    if k.abs() < 1e-12 {
        return sample_line(s0, x0, y0, hdg, length, n);
    }
    let r = 1.0 / k;
    // Centre of the circle: perpendicular-left of the start heading by r.
    let cx = x0 - r * hdg.sin();
    let cy = y0 + r * hdg.cos();
    (0..=n)
        .map(|i| {
            let s = length * (i as f64) / (n as f64);
            let theta = hdg + k * s;
            RefPoint {
                s: s0 + s,
                x: cx + r * theta.sin(),
                y: cy - r * theta.cos(),
                hdg: theta,
            }
        })
        .collect()
}

/// Clothoid (Euler spiral): curvature varies linearly from `k0` to `k1` over the
/// geometry. Integrate heading `θ(s) = hdg + k0*s + (k1-k0)/(2L)*s²` and position
/// by cumulative trapezoidal steps. Numeric integration (no exact Fresnel).
fn sample_spiral(
    s0: f64,
    x0: f64,
    y0: f64,
    hdg: f64,
    length: f64,
    k0: f64,
    k1: f64,
) -> Vec<RefPoint> {
    // Fine integration grid, then resampled to the output spacing.
    let steps = ((length / SPIRAL_INTEGRATION_STEP_M).ceil() as usize).max(1);
    let dk = (k1 - k0) / length;

    // Build the fine path (cumulative x, y, hdg) at each integration node.
    let mut nodes: Vec<RefPoint> = Vec::with_capacity(steps + 1);
    let mut x = x0;
    let mut y = y0;
    nodes.push(RefPoint { s: s0, x, y, hdg });
    let ds = length / steps as f64;
    let theta_at = |s: f64| hdg + k0 * s + 0.5 * dk * s * s;
    let mut s_local = 0.0;
    for _ in 0..steps {
        let t0 = theta_at(s_local);
        let t1 = theta_at(s_local + ds);
        // Trapezoidal step on the unit tangent.
        x += ds * 0.5 * (t0.cos() + t1.cos());
        y += ds * 0.5 * (t0.sin() + t1.sin());
        s_local += ds;
        nodes.push(RefPoint {
            s: s0 + s_local,
            x,
            y,
            hdg: t1,
        });
    }

    // Resample the fine path to ~SAMPLE_STEP_M spacing for the output polyline.
    let out_n = ((length / SAMPLE_STEP_M).ceil() as usize).max(1);
    (0..=out_n)
        .map(|i| {
            let s_target = length * (i as f64) / (out_n as f64);
            ref_at_arclen(&nodes, s0 + s_target)
        })
        .collect()
}

/// Cubic-polynomial geometry: in the local frame (u along `hdg`, v normal-left),
/// `v = a + b*u + c*u² + d*u³`, with `u` running along the chord such that arc
/// length ≈ `length`. We approximate by stepping `u` uniformly over the
/// geometry length (the standard small-curvature assumption).
#[allow(clippy::too_many_arguments)]
fn sample_poly3(
    s0: f64,
    x0: f64,
    y0: f64,
    hdg: f64,
    length: f64,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    n: usize,
) -> Vec<RefPoint> {
    let (sin_h, cos_h) = hdg.sin_cos();
    let mut out: Vec<RefPoint> = Vec::with_capacity(n + 1);
    let mut prev: Option<(f64, f64)> = None;
    for i in 0..=n {
        let u = length * (i as f64) / (n as f64);
        let v = a + b * u + c * u * u + d * u * u * u;
        let x = x0 + cos_h * u - sin_h * v;
        let y = y0 + sin_h * u + cos_h * v;
        // Local heading from finite difference for a smooth tangent.
        let local_hdg = match prev {
            Some((px, py)) => (y - py).atan2(x - px),
            None => hdg,
        };
        out.push(RefPoint {
            s: s0 + u,
            x,
            y,
            hdg: local_hdg,
        });
        prev = Some((x, y));
    }
    // First point's heading: borrow the second's (finite diff has no prior).
    if out.len() >= 2 {
        out[0].hdg = out[1].hdg;
    }
    out
}

/// Parametric cubic geometry: `u(p) = aU + bU*p + cU*p² + dU*p³`, likewise `v(p)`,
/// in the local (u along `hdg`, v normal-left) frame. `p` ranges over `[0, 1]`
/// when `normalized`, else `[0, length]`.
#[allow(clippy::too_many_arguments)]
fn sample_param_poly3(
    s0: f64,
    x0: f64,
    y0: f64,
    hdg: f64,
    length: f64,
    coeffs: &[f64; 8],
    normalized: bool,
    n: usize,
) -> Vec<RefPoint> {
    let (sin_h, cos_h) = hdg.sin_cos();
    let [au, bu, cu, du, av, bv, cv, dv] = *coeffs;
    let p_max = if normalized { 1.0 } else { length };
    let mut out: Vec<RefPoint> = Vec::with_capacity(n + 1);
    let mut prev: Option<(f64, f64)> = None;
    for i in 0..=n {
        let p = p_max * (i as f64) / (n as f64);
        let u = au + bu * p + cu * p * p + du * p * p * p;
        let v = av + bv * p + cv * p * p + dv * p * p * p;
        let x = x0 + cos_h * u - sin_h * v;
        let y = y0 + sin_h * u + cos_h * v;
        let local_hdg = match prev {
            Some((px, py)) => (y - py).atan2(x - px),
            None => hdg,
        };
        out.push(RefPoint {
            s: s0 + length * (i as f64) / (n as f64),
            x,
            y,
            hdg: local_hdg,
        });
        prev = Some((x, y));
    }
    if out.len() >= 2 {
        out[0].hdg = out[1].hdg;
    }
    out
}

/// Linearly interpolate the reference path `nodes` (ascending in `s`) to the
/// pose at absolute arc-length `s_abs`.
fn ref_at_arclen(nodes: &[RefPoint], s_abs: f64) -> RefPoint {
    if nodes.is_empty() {
        return RefPoint {
            s: s_abs,
            x: 0.0,
            y: 0.0,
            hdg: 0.0,
        };
    }
    if s_abs <= nodes[0].s {
        return nodes[0];
    }
    if s_abs >= nodes[nodes.len() - 1].s {
        return nodes[nodes.len() - 1];
    }
    let idx = nodes.partition_point(|p| p.s < s_abs).max(1);
    let a = nodes[idx - 1];
    let b = nodes[idx];
    let span = b.s - a.s;
    let t = if span > 1e-12 {
        (s_abs - a.s) / span
    } else {
        0.0
    };
    RefPoint {
        s: s_abs,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        hdg: a.hdg + (b.hdg - a.hdg) * t,
    }
}

// ---------------------------------------------------------------------------
// OpenDRIVE elevation + lanes
// ---------------------------------------------------------------------------

/// One `<elevation s a b c d>` polynomial: `z(s) = a + b*ds + c*ds² + d*ds³`,
/// `ds = s - s_start`, valid until the next entry.
struct ElevSegment {
    s: f64,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
}

/// Parse a road's `<elevationProfile>` into ascending segments (empty → flat).
fn parse_elevation_profile(road: &roxmltree::Node) -> Vec<ElevSegment> {
    let mut segs: Vec<ElevSegment> = Vec::new();
    if let Some(profile) = road.children().find(|c| c.has_tag_name("elevationProfile")) {
        for e in profile.children().filter(|c| c.has_tag_name("elevation")) {
            segs.push(ElevSegment {
                s: attr_f64(&e, "s", 0.0),
                a: attr_f64(&e, "a", 0.0),
                b: attr_f64(&e, "b", 0.0),
                c: attr_f64(&e, "c", 0.0),
                d: attr_f64(&e, "d", 0.0),
            });
        }
    }
    segs.sort_by(|x, y| x.s.partial_cmp(&y.s).unwrap_or(std::cmp::Ordering::Equal));
    segs
}

/// Evaluate the elevation profile at arc-length `s` (0.0 when no profile).
fn eval_elevation(segs: &[ElevSegment], s: f64) -> f64 {
    if segs.is_empty() {
        return 0.0;
    }
    // The active segment is the last whose `s` ≤ query.
    let idx = segs.partition_point(|seg| seg.s <= s);
    let seg = if idx == 0 { &segs[0] } else { &segs[idx - 1] };
    let ds = s - seg.s;
    seg.a + seg.b * ds + seg.c * ds * ds + seg.d * ds * ds * ds
}

/// Best-effort lane borders from a road's first `<laneSection>`. For each lane in
/// `<left>`/`<right>`, the cumulative signed offset (sum of lane widths from the
/// centre outward) is applied perpendicular to the reference heading: +normal
/// (left of travel) for left lanes, −normal for right lanes. The outermost
/// border on each side is typed `"road_edge"`, inner borders `"lane_boundary"`.
/// `"driving"`-type lanes still emit borders; lane *type* doesn't change the
/// border classification here. Skips silently on any structural surprise.
fn sample_lane_borders(
    road: &roxmltree::Node,
    refline: &[RefPoint],
    elevations: &[ElevSegment],
    out: &mut Vec<Feature>,
) {
    let lanes = match road.children().find(|c| c.has_tag_name("lanes")) {
        Some(l) => l,
        None => return,
    };
    let section = match lanes.children().find(|c| c.has_tag_name("laneSection")) {
        Some(s) => s,
        None => return,
    };

    for (side, sign) in [("left", 1.0_f64), ("right", -1.0_f64)] {
        let side_node = match section.children().find(|c| c.has_tag_name(side)) {
            Some(s) => s,
            None => continue,
        };

        // Collect lanes with their |laneId| so we can order them centre-outward.
        let mut side_lanes: Vec<(i64, roxmltree::Node)> = side_node
            .children()
            .filter(|c| c.has_tag_name("lane"))
            .map(|lane| {
                let id = lane
                    .attribute("id")
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .unwrap_or(0);
                (id.abs(), lane)
            })
            .collect();
        side_lanes.sort_by_key(|(id, _)| *id);

        // Accumulate signed offset outward, emitting a border at each lane's
        // outer edge.
        let mut cumulative = 0.0_f64;
        let last = side_lanes.len().saturating_sub(1);
        for (i, (_, lane)) in side_lanes.iter().enumerate() {
            let width = lane
                .children()
                .find(|c| c.has_tag_name("width"))
                .map(|w| attr_f64(&w, "a", 0.0))
                .unwrap_or(0.0);
            cumulative += width;
            let feature_type = if i == last {
                "road_edge"
            } else {
                "lane_boundary"
            };
            let offset = sign * cumulative;
            let mut pts: Vec<f32> = Vec::with_capacity(refline.len() * 3);
            for p in refline {
                // Normal-left of heading is (-sin, +cos); a positive `offset`
                // moves left of travel.
                let nx = -p.hdg.sin();
                let ny = p.hdg.cos();
                pts.push((p.x + nx * offset) as f32);
                pts.push((p.y + ny * offset) as f32);
                pts.push(eval_elevation(elevations, p.s) as f32);
            }
            out.push(Feature {
                points: pts,
                feature_type: feature_type.to_string(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::cast::AsArray;
    use arrow_array::{Array, Float32Array, Int32Array, StringArray};
    use arrow_ipc::reader::FileReader;
    use std::io::Cursor;

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1);
        batches.into_iter().next().unwrap()
    }

    fn fetch_frame0(r: &MapGeometryReader) -> RecordBatch {
        let ch = r.meta().channels[0].id.clone();
        let ipc = r
            .fetch_range(
                &ch,
                TimeRange {
                    start_ns: 0,
                    end_ns: 1,
                },
                FetchOpts::default(),
            )
            .unwrap();
        parse_ipc(&ipc)
    }

    const SIMPLE_JSON: &str = r#"
    { "drivelineMap": {
        "version": 1,
        "name": "intersection",
        "features": [
          { "id": "b0", "type": "lane_boundary", "polyline": [[0,0,0],[1,0,0],[2,0,0]] },
          { "type": "road_edge", "polyline": [[0,2],[5,2]] },
          { "type": "weird", "polyline": [[0,0],[1,1]] },
          { "type": "crosswalk", "polyline": [[0,0]] }
        ] } }
    "#;

    #[test]
    fn json_happy_path_meta_and_frame_times() {
        let r = MapGeometryReader::open(SIMPLE_JSON.as_bytes()).unwrap();
        assert_eq!(r.meta().kind, SourceKind::MapGeometry);
        assert_eq!(r.meta().channels.len(), 1);
        let ch = &r.meta().channels[0];
        assert_eq!(ch.name, "intersection");
        assert_eq!(ch.kind, ChannelKind::MapGeometry);
        // 3 valid features (the 1-point crosswalk is skipped).
        assert_eq!(ch.sample_count, 3);
        assert_eq!(r.frame_times(), &[0]);
    }

    #[test]
    fn json_roundtrip_points_lengths_types() {
        let r = MapGeometryReader::open(SIMPLE_JSON.as_bytes()).unwrap();
        let batch = fetch_frame0(&r);
        assert_eq!(batch.num_rows(), 1);

        let ts = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        assert_eq!(ts.value(0), 0);

        let points = batch.column(1).as_list::<i32>().value(0);
        let p = points.as_any().downcast_ref::<Float32Array>().unwrap();
        // feature0: 3 pts; feature1: 2 pts (2D → z=0); feature2: 2 pts.
        assert_eq!(
            p.values(),
            &[
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, // boundary
                0.0, 2.0, 0.0, 5.0, 2.0, 0.0, // road_edge
                0.0, 0.0, 0.0, 1.0, 1.0, 0.0, // weird → other
            ]
        );

        let lengths = batch.column(2).as_list::<i32>().value(0);
        let l = lengths.as_any().downcast_ref::<Int32Array>().unwrap();
        assert_eq!(l.values(), &[3, 2, 2]);

        let types = batch.column(3).as_list::<i32>().value(0);
        let t = types.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(t.value(0), "lane_boundary");
        assert_eq!(t.value(1), "road_edge");
        // Unknown type string maps to "other".
        assert_eq!(t.value(2), "other");
    }

    #[test]
    fn json_default_name_and_default_type() {
        let json = r#"{ "drivelineMap": { "features": [
          { "polyline": [[0,0],[1,1]] }
        ] } }"#;
        let r = MapGeometryReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.meta().channels[0].name, "map");
        let batch = fetch_frame0(&r);
        let types = batch.column(3).as_list::<i32>().value(0);
        let t = types.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(t.value(0), "other");
    }

    #[test]
    fn json_missing_root_key_errors() {
        let res = MapGeometryReader::open(br#"{ "nope": {} }"#);
        assert!(matches!(res, Err(crate::Error::MapGeometryParse(_))));
    }

    #[test]
    fn unrecognised_format_errors() {
        let res = MapGeometryReader::open(b"   not xml or json");
        assert!(matches!(res, Err(crate::Error::MapGeometryParse(_))));
        let empty = MapGeometryReader::open(b"   \n  ");
        assert!(matches!(empty, Err(crate::Error::MapGeometryParse(_))));
    }

    const OPENDRIVE_LINE_ARC: &str = r#"<?xml version="1.0"?>
    <OpenDRIVE>
      <header name="tiny_map"/>
      <road name="r1" length="20.0" id="1">
        <planView>
          <geometry s="0.0" x="0.0" y="0.0" hdg="0.0" length="10.0">
            <line/>
          </geometry>
          <geometry s="10.0" x="10.0" y="0.0" hdg="0.0" length="10.0">
            <arc curvature="0.1"/>
          </geometry>
        </planView>
        <lanes>
          <laneSection s="0.0">
            <left>
              <lane id="1" type="driving"><width sOffset="0" a="3.5" b="0" c="0" d="0"/></lane>
            </left>
            <right>
              <lane id="-1" type="driving"><width sOffset="0" a="3.5" b="0" c="0" d="0"/></lane>
            </right>
          </laneSection>
        </lanes>
      </road>
    </OpenDRIVE>"#;

    #[test]
    fn opendrive_line_and_arc_meta() {
        let r = MapGeometryReader::open(OPENDRIVE_LINE_ARC.as_bytes()).unwrap();
        assert_eq!(r.meta().kind, SourceKind::MapGeometry);
        let ch = &r.meta().channels[0];
        assert_eq!(ch.name, "tiny_map");
        assert_eq!(ch.kind, ChannelKind::MapGeometry);
        assert_eq!(r.frame_times(), &[0]);
        // 1 centerline + 1 left border + 1 right border.
        assert_eq!(ch.sample_count, 3);
    }

    #[test]
    fn opendrive_centerline_geometry() {
        let r = MapGeometryReader::open(OPENDRIVE_LINE_ARC.as_bytes()).unwrap();
        let batch = fetch_frame0(&r);

        let lengths = batch.column(2).as_list::<i32>().value(0);
        let l = lengths.as_any().downcast_ref::<Int32Array>().unwrap();
        let types = batch.column(3).as_list::<i32>().value(0);
        let t = types.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(t.value(0), "centerline");
        // road_edge for the single-lane outer border on each side.
        assert_eq!(t.value(1), "road_edge");
        assert_eq!(t.value(2), "road_edge");

        // The centerline starts at the origin and bends along the arc.
        let points = batch.column(1).as_list::<i32>().value(0);
        let p = points.as_any().downcast_ref::<Float32Array>().unwrap();
        let center_n = l.value(0) as usize;
        // First centerline point is at the road origin.
        assert!((p.value(0)).abs() < 1e-4);
        assert!((p.value(1)).abs() < 1e-4);
        // 20 m of road at ~1 m spacing → at least 20 points.
        assert!(center_n >= 20, "center_n = {center_n}");

        // The straight segment runs east (y ≈ 0) up to x ≈ 10; the arc (k>0,
        // turns left) lifts y positive after that.
        let mid_y = p.value(3 * (center_n - 1) + 1);
        assert!(
            mid_y > 0.5,
            "end y after left arc should be positive: {mid_y}"
        );
    }

    #[test]
    fn opendrive_lane_borders_offset() {
        let r = MapGeometryReader::open(OPENDRIVE_LINE_ARC.as_bytes()).unwrap();
        let batch = fetch_frame0(&r);
        let points = batch.column(1).as_list::<i32>().value(0);
        let p = points.as_any().downcast_ref::<Float32Array>().unwrap();
        let lengths = batch.column(2).as_list::<i32>().value(0);
        let l = lengths.as_any().downcast_ref::<Int32Array>().unwrap();

        // Offset to the start of the left border (feature index 1).
        let center_n = l.value(0) as usize;
        let left_start = center_n * 3;
        // Left border first point: offset +3.5 normal-left of east heading → y≈+3.5.
        let left_y0 = p.value(left_start + 1);
        assert!((left_y0 - 3.5).abs() < 1e-3, "left border y0 = {left_y0}");

        // Right border (feature index 2): y ≈ -3.5 at the start.
        let left_n = l.value(1) as usize;
        let right_start = (center_n + left_n) * 3;
        let right_y0 = p.value(right_start + 1);
        assert!(
            (right_y0 + 3.5).abs() < 1e-3,
            "right border y0 = {right_y0}"
        );
    }

    #[test]
    fn opendrive_default_name_when_no_header() {
        let xml = r#"<OpenDRIVE>
          <road length="5" id="1"><planView>
            <geometry s="0" x="0" y="0" hdg="0" length="5"><line/></geometry>
          </planView></road>
        </OpenDRIVE>"#;
        let r = MapGeometryReader::open(xml.as_bytes()).unwrap();
        assert_eq!(r.meta().channels[0].name, "road_network");
    }

    #[test]
    fn opendrive_bad_road_skipped_not_failed() {
        // One road with no planView (skipped) and one valid road → file opens,
        // only the valid road's features survive.
        let xml = r#"<OpenDRIVE>
          <road id="bad"></road>
          <road id="ok" length="5"><planView>
            <geometry s="0" x="0" y="0" hdg="0" length="5"><line/></geometry>
          </planView></road>
        </OpenDRIVE>"#;
        let r = MapGeometryReader::open(xml.as_bytes()).unwrap();
        // Just the one centerline (no lanes on the valid road).
        assert_eq!(r.meta().channels[0].sample_count, 1);
    }

    #[test]
    fn opendrive_spiral_is_continuous() {
        // A spiral from straight (k=0) into a curve (k=0.05) should produce a
        // smooth, finite polyline that starts at the origin.
        let xml = r#"<OpenDRIVE>
          <road id="1" length="30"><planView>
            <geometry s="0" x="0" y="0" hdg="0" length="30">
              <spiral curvStart="0.0" curvEnd="0.05"/>
            </geometry>
          </planView></road>
        </OpenDRIVE>"#;
        let r = MapGeometryReader::open(xml.as_bytes()).unwrap();
        let batch = fetch_frame0(&r);
        let points = batch.column(1).as_list::<i32>().value(0);
        let p = points.as_any().downcast_ref::<Float32Array>().unwrap();
        // All finite, start at origin.
        assert!((p.value(0)).abs() < 1e-4);
        assert!((p.value(1)).abs() < 1e-4);
        for i in 0..p.len() {
            assert!(p.value(i).is_finite());
        }
    }

    #[test]
    fn unknown_channel_errors() {
        let r = MapGeometryReader::open(SIMPLE_JSON.as_bytes()).unwrap();
        let err = r
            .fetch_range("nope", r.meta().time_range, FetchOpts::default())
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn open_owned_matches_open() {
        let r = MapGeometryReader::open_owned(SIMPLE_JSON.as_bytes().to_vec()).unwrap();
        assert_eq!(r.meta().channels[0].sample_count, 3);
    }
}
