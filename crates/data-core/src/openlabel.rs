//! `OpenLabelReader`: ingests an **ASAM OpenLABEL** JSON file of 3D cuboid
//! annotations and surfaces one [`ChannelKind::BoundingBox`] channel — a
//! per-frame set of oriented bounding boxes (cuboids) for the 3D scene panel.
//!
//! OpenLABEL is sprawling; this reader parses leniently with
//! `serde_json::Value` traversal and only pulls out what it needs: the object
//! class strings (labels) and the per-frame cuboid geometry. See the parsing
//! spec in `docs/` and the inline notes below.
//!
//! ## Source structure (what `open` expects)
//!
//! Root key `openlabel`. Geometry can be in EITHER:
//! - **sequence form**: `openlabel.frames[<frameNo>].objects[<uid>]
//!   .object_data.cuboid` (array of cuboids), with timestamp at
//!   `openlabel.frames[<frameNo>].frame_properties.timestamp`, OR
//! - **static form**: `openlabel.objects[<uid>].object_data.cuboid` (no
//!   `frames`) → treated as a single frame at `t = 0`.
//!
//! Each cuboid's `val` array is either length 10 (quaternion, scalar-last) or
//! length 9 (Euler XYZ radians). The class/label of a box is
//! `openlabel.objects[<uid>].type` (falling back to `name`, then `"object"`).
//!
//! ## Fetch schema (what `fetch_range` returns)
//!
//! One row per frame in the window:
//!
//! | column      | Arrow type        | meaning                              |
//! | ----------- | ----------------- | ------------------------------------ |
//! | `ts`        | `Timestamp(ns,UTC)`| frame timestamp                     |
//! | `centers`   | `List<Float32>`   | flattened xyz, length `3*N` (metres) |
//! | `sizes`     | `List<Float32>`   | flattened full extents, length `3*N` |
//! | `rotations` | `List<Float32>`   | flattened quaternion, length `4*N`   |
//! | `labels`    | `List<Utf8>`      | object class strings, length `N`     |
//!
//! Coordinates pass through UNCHANGED: OpenLABEL cuboids are assumed to be in
//! the ISO-8855 vehicle frame (x-forward, y-left, z-up), which is exactly the
//! z-up frame the renderer wants.

use std::sync::Arc;

use arrow_array::builder::{Float32Builder, ListBuilder, StringBuilder};
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

/// Above this magnitude a numeric `frame_properties.timestamp` is assumed to be
/// already in nanoseconds rather than seconds (1e15 ns ≈ 1970-01-12, while real
/// epoch-seconds are ~1.7e9 — well below this guard).
const NS_MAGNITUDE_GUARD: f64 = 1e15;

/// One decoded frame: its timestamp plus the per-box geometry, flattened so
/// `fetch_range` can append slices directly. `centers`/`sizes` have length
/// `3 * box_count`, `rotations` has length `4 * box_count`, `labels` has length
/// `box_count`.
struct Frame {
    ts_ns: i64,
    centers: Vec<f32>,
    sizes: Vec<f32>,
    rotations: Vec<f32>,
    labels: Vec<String>,
}

impl Frame {
    fn box_count(&self) -> usize {
        self.labels.len()
    }
}

pub struct OpenLabelReader {
    meta: SourceMeta,
    channel_id: ChannelId,
    frames: Vec<Frame>,
    /// Parallel to `frames`, ascending — the scene panel pulls this to map a
    /// cursor time to a frame index without a wasm round-trip per tick.
    frame_ts: Vec<i64>,
}

impl OpenLabelReader {
    /// Ascending frame timestamps (ns), one per frame. The 3D panel binary
    /// searches this locally to decide which frame is active at the cursor.
    /// Mirrors `PointCloudReader::spin_times`.
    pub fn frame_times(&self) -> &[i64] {
        &self.frame_ts
    }

    /// Parse OpenLABEL JSON bytes into a reader. Leniently traverses
    /// `serde_json::Value`; malformed individual cuboids are skipped rather
    /// than failing the whole file.
    fn parse(bytes: &[u8]) -> crate::Result<Self> {
        let root: Value = serde_json::from_slice(bytes)
            .map_err(|e| crate::Error::OpenLabelParse(e.to_string()))?;
        let ol = root
            .get("openlabel")
            .ok_or_else(|| crate::Error::OpenLabelParse("missing `openlabel` root key".into()))?;

        // Channel name: openlabel.metadata.name, else "objects".
        let name = ol
            .get("metadata")
            .and_then(|m| m.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "objects".to_string());

        // Top-level objects map: uid -> class label (type, then name, then
        // "object").
        let objects = ol.get("objects");
        let label_for = |uid: &str| -> String {
            objects
                .and_then(|o| o.get(uid))
                .map(|obj| {
                    obj.get("type")
                        .and_then(Value::as_str)
                        .or_else(|| obj.get("name").and_then(Value::as_str))
                        .unwrap_or("object")
                        .to_string()
                })
                .unwrap_or_else(|| "object".to_string())
        };

        let mut frames: Vec<Frame> = Vec::new();

        match ol.get("frames").and_then(Value::as_object) {
            // Sequence form: one frame per `openlabel.frames[<frameNo>]`.
            Some(frames_map) => {
                // Frame keys are numeric strings; sort by numeric order so the
                // timeline is monotonic regardless of JSON object ordering.
                let mut keys: Vec<(i64, &String)> = frames_map
                    .keys()
                    .map(|k| (k.parse::<i64>().unwrap_or(i64::MAX), k))
                    .collect();
                keys.sort_by_key(|(n, _)| *n);

                for (frame_no, key) in keys {
                    let frame_val = &frames_map[key];
                    let ts_ns = frame_timestamp_ns(frame_val, frame_no);
                    let mut frame = Frame {
                        ts_ns,
                        centers: Vec::new(),
                        sizes: Vec::new(),
                        rotations: Vec::new(),
                        labels: Vec::new(),
                    };
                    if let Some(objs) = frame_val.get("objects").and_then(Value::as_object) {
                        for (uid, obj) in objs {
                            let label = label_for(uid);
                            collect_cuboids(obj, &label, &mut frame);
                        }
                    }
                    frames.push(frame);
                }
            }
            // Static form: cuboids live directly under each top-level object.
            None => {
                let mut frame = Frame {
                    ts_ns: 0,
                    centers: Vec::new(),
                    sizes: Vec::new(),
                    rotations: Vec::new(),
                    labels: Vec::new(),
                };
                if let Some(objs) = objects.and_then(Value::as_object) {
                    for (uid, obj) in objs {
                        let label = label_for(uid);
                        collect_cuboids(obj, &label, &mut frame);
                    }
                }
                frames.push(frame);
            }
        }

        Ok(Self::from_frames(frames, name))
    }

    /// Build a reader from decoded frames, computing the channel meta and the
    /// covering time range. Frames are sorted ascending; `name` becomes both
    /// the channel id and display name. Mirrors `PointCloudReader::from_spins`.
    fn from_frames(mut frames: Vec<Frame>, name: String) -> Self {
        frames.sort_by_key(|f| f.ts_ns);
        let frame_ts: Vec<i64> = frames.iter().map(|f| f.ts_ns).collect();

        let period = crate::time::infer_period_ns(&frame_ts, DEFAULT_FRAME_PERIOD_NS);
        let time_range = match (frame_ts.first(), frame_ts.last()) {
            (Some(&a), Some(&b)) => TimeRange {
                start_ns: a,
                end_ns: b.saturating_add(period),
            },
            _ => TimeRange::empty(),
        };

        // "sample_count" is the peak boxes-per-frame, so the UI can show how
        // dense the annotations are. Frame count is the channel's frame count,
        // surfaced via `frame_times`.
        let max_boxes = frames.iter().map(Frame::box_count).max().unwrap_or(0) as u64;
        let channel = Channel {
            id: name.clone(),
            source_id: String::new(),
            name: name.clone(),
            kind: ChannelKind::BoundingBox,
            dtype: None,
            unit: None,
            sample_count: max_boxes,
            time_range,
        };

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::OpenLabel,
            time_range,
            channels: vec![channel],
        };

        OpenLabelReader {
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

    /// Arrow schema `fetch_range` emits. All four geometry columns are
    /// variable-length lists (one list per frame row); labels are `List<Utf8>`.
    fn fetch_schema() -> Arc<Schema> {
        let centers_item = Arc::new(Field::new("item", DataType::Float32, true));
        let sizes_item = Arc::new(Field::new("item", DataType::Float32, true));
        let rotations_item = Arc::new(Field::new("item", DataType::Float32, true));
        let labels_item = Arc::new(Field::new("item", DataType::Utf8, true));
        Arc::new(Schema::new(vec![
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
                false,
            ),
            Field::new("centers", DataType::List(centers_item), false),
            Field::new("sizes", DataType::List(sizes_item), false),
            Field::new("rotations", DataType::List(rotations_item), false),
            Field::new("labels", DataType::List(labels_item), false),
        ]))
    }
}

impl Reader for OpenLabelReader {
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
        // the point-cloud reader.
        let ts = &self.frame_ts;
        let (lo, hi) =
            crate::time::range_window(ts, range.start_ns, range.end_ns, opts.include_prev);
        // Contiguous because `include_prev` (when active) folds the sample
        // immediately before the window into `lo`: optional prev + body.
        let idxs: Vec<usize> = (lo..hi).collect();

        let schema = Self::fetch_schema();

        let total_boxes: usize = idxs.iter().map(|&i| self.frames[i].box_count()).sum();

        let mut ts_vals: Vec<i64> = Vec::with_capacity(idxs.len());
        let mut centers_b =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_boxes * 3), idxs.len());
        let mut sizes_b =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_boxes * 3), idxs.len());
        let mut rotations_b =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_boxes * 4), idxs.len());
        let mut labels_b = ListBuilder::with_capacity(StringBuilder::new(), idxs.len());

        for &i in &idxs {
            let frame = &self.frames[i];
            ts_vals.push(frame.ts_ns);
            centers_b.values().append_slice(&frame.centers);
            centers_b.append(true);
            sizes_b.values().append_slice(&frame.sizes);
            sizes_b.append(true);
            rotations_b.values().append_slice(&frame.rotations);
            rotations_b.append(true);
            for label in &frame.labels {
                labels_b.values().append_value(label);
            }
            labels_b.append(true);
        }

        let ts_array = TimestampNanosecondArray::from(ts_vals).with_timezone("UTC");
        let centers_array = centers_b.finish();
        let sizes_array = sizes_b.finish();
        let rotations_array = rotations_b.finish();
        let labels_array = labels_b.finish();

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(ts_array),
                Arc::new(centers_array),
                Arc::new(sizes_array),
                Arc::new(rotations_array),
                Arc::new(labels_array),
            ],
        )?;

        crate::arrow::write_ipc(schema, batch)
    }
}

/// Pull every cuboid out of `obj.object_data.cuboid` (an array) and append its
/// center/size/rotation/label to `frame`. Skips cuboids whose `val` is not 9 or
/// 10 elements rather than failing the file.
fn collect_cuboids(obj: &Value, label: &str, frame: &mut Frame) {
    let cuboids = match obj
        .get("object_data")
        .and_then(|d| d.get("cuboid"))
        .and_then(Value::as_array)
    {
        Some(c) => c,
        None => return,
    };

    for cuboid in cuboids {
        let parsed = match cuboid.get("val").and_then(Value::as_array) {
            // `val`-array form (the canonical OpenLABEL encoding).
            Some(val) => parse_cuboid_val(val),
            // `val` absent or `null` → OpenLABEL convenience-field form, where
            // geometry lives in sibling fields on the cuboid object.
            None => parse_cuboid_convenience(cuboid),
        };
        let (center, quat, size) = match parsed {
            Some(t) => t,
            None => continue,
        };

        frame.centers.extend_from_slice(&center);
        frame.sizes.extend_from_slice(&size);
        frame.rotations.extend_from_slice(&quat);
        frame.labels.push(label.to_string());
    }
}

/// Parse a cuboid's `val` array into `(center, quat_scalar_last, size)`. The
/// array is either length 10 (quaternion, scalar-last) or length 9 (Euler XYZ
/// radians); any other length (or non-numeric entries) → `None` (skip).
fn parse_cuboid_val(val: &[Value]) -> Option<([f32; 3], [f32; 4], [f32; 3])> {
    let nums: Vec<f64> = val.iter().filter_map(Value::as_f64).collect();
    // Guard: if any element wasn't numeric the lengths won't line up below
    // and the cuboid is skipped — exactly the "any other length → skip"
    // behaviour we want.
    match nums.len() {
        10 => {
            // [x, y, z, qx, qy, qz, qw, sx, sy, sz]
            let center = [nums[0] as f32, nums[1] as f32, nums[2] as f32];
            let quat = [
                nums[3] as f32,
                nums[4] as f32,
                nums[5] as f32,
                nums[6] as f32,
            ];
            let size = [nums[7] as f32, nums[8] as f32, nums[9] as f32];
            Some((center, quat, size))
        }
        9 => {
            // [x, y, z, rx, ry, rz, sx, sy, sz] — Euler XYZ radians.
            let center = [nums[0] as f32, nums[1] as f32, nums[2] as f32];
            let quat = euler_xyz_to_quat(nums[3], nums[4], nums[5]);
            let size = [nums[6] as f32, nums[7] as f32, nums[8] as f32];
            Some((center, quat, size))
        }
        _ => None,
    }
}

/// Parse a cuboid in OpenLABEL's **convenience-field form** (`val` absent or
/// `null`), where geometry lives in sibling fields on the cuboid object. Used
/// by externally authored files such as the Vicomtech VCD cuboid fixture.
///
/// Field precedence:
/// - center: `"translation"` OR the VCD misspelling `"traslation"` → `[x,y,z]`
///   metres. **Required** — no translation → `None` (skip).
/// - size: `"size"` → `[sx, sy, sz]` full extents, metres. **Required**.
/// - rotation, in priority order:
///   1. `"quaternion"` as **scalar-FIRST** `[qw, qx, qy, qz]` (note: the
///      `val`-array quaternion is scalar-LAST `[qx,qy,qz,qw]`); converted to
///      scalar-last here.
///   2. else `"euler"` / `"rotation"` as `[rx, ry, rz]` radians XYZ.
///   3. else identity `[0, 0, 0, 1]`.
fn parse_cuboid_convenience(cuboid: &Value) -> Option<([f32; 3], [f32; 4], [f32; 3])> {
    let center = read_vec3(
        cuboid
            .get("translation")
            .or_else(|| cuboid.get("traslation"))?,
    )?;
    let size = read_vec3(cuboid.get("size")?)?;

    let quat = if let Some(q) = cuboid.get("quaternion").and_then(Value::as_array) {
        let n: Vec<f64> = q.iter().filter_map(Value::as_f64).collect();
        if n.len() != 4 {
            return None;
        }
        // Scalar-first [qw, qx, qy, qz] → scalar-last [qx, qy, qz, qw].
        [n[1] as f32, n[2] as f32, n[3] as f32, n[0] as f32]
    } else if let Some(e) = cuboid
        .get("euler")
        .or_else(|| cuboid.get("rotation"))
        .and_then(Value::as_array)
    {
        let n: Vec<f64> = e.iter().filter_map(Value::as_f64).collect();
        if n.len() != 3 {
            return None;
        }
        euler_xyz_to_quat(n[0], n[1], n[2])
    } else {
        // No rotation field → identity.
        [0.0, 0.0, 0.0, 1.0]
    };

    Some((center, quat, size))
}

/// Read a JSON array of exactly three numbers into `[f32; 3]`, else `None`.
fn read_vec3(v: &Value) -> Option<[f32; 3]> {
    let arr = v.as_array()?;
    let n: Vec<f64> = arr.iter().filter_map(Value::as_f64).collect();
    if n.len() != 3 {
        return None;
    }
    Some([n[0] as f32, n[1] as f32, n[2] as f32])
}

/// Resolve a frame's timestamp (ns). Reads
/// `frame_properties.timestamp` (polymorphic string | number); falls back to a
/// synthesised value from the numeric frame number when absent/unparseable.
fn frame_timestamp_ns(frame_val: &Value, frame_no: i64) -> i64 {
    let synth = frame_no.saturating_mul(SYNTH_FRAME_STEP_NS);
    let ts = frame_val
        .get("frame_properties")
        .and_then(|p| p.get("timestamp"));
    match ts {
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
        Some(Value::String(s)) => parse_iso8601_ns(s).unwrap_or(synth),
        _ => synth,
    }
}

/// Parse a loose ISO-8601 datetime ("YYYY-MM-DD HH:MM:SS" or with 'T', optional
/// fractional seconds, optional trailing 'Z') to ns since the Unix epoch (UTC).
/// Returns `None` if the shape doesn't match — the caller then falls back to a
/// synthesised timestamp. Kept dependency-free (no `chrono`) to stay within the
/// wasm size budget.
fn parse_iso8601_ns(s: &str) -> Option<i64> {
    let s = s.trim();
    let s = s.strip_suffix('Z').unwrap_or(s);
    // Split date and time on either 'T' or a space.
    let (date, time) = s
        .split_once('T')
        .or_else(|| s.split_once(' '))
        .unwrap_or((s, "00:00:00"));

    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    if d.next().is_some() {
        return None;
    }

    // Time, with optional fractional seconds.
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next().unwrap_or("0").parse().ok()?;
    let second: i64 = t.next().unwrap_or("0").parse().ok()?;
    if t.next().is_some() {
        return None;
    }
    // Fractional seconds → ns (pad/truncate to 9 digits).
    let frac_ns: i64 = if frac.is_empty() {
        0
    } else {
        let mut digits: String = frac.chars().take(9).collect();
        while digits.len() < 9 {
            digits.push('0');
        }
        digits.parse().ok()?
    };

    let days = days_from_civil(year, month, day);
    let secs = days
        .checked_mul(86_400)?
        .checked_add(hour * 3600 + minute * 60 + second)?;
    secs.checked_mul(1_000_000_000)?.checked_add(frac_ns)
}

/// Days from 1970-01-01 to the given civil date (proleptic Gregorian). Howard
/// Hinnant's `days_from_civil` algorithm — exact, branch-light, no leap tables.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Convert an intrinsic Euler XYZ rotation (radians) to a scalar-last
/// quaternion `(qx, qy, qz, qw)`. The composed rotation is X then Y then Z
/// (intrinsic), i.e. `q = qz * qy * qx`. Computed in f64, emitted as f32.
fn euler_xyz_to_quat(rx: f64, ry: f64, rz: f64) -> [f32; 4] {
    let (sx, cx) = (rx * 0.5).sin_cos();
    let (sy, cy) = (ry * 0.5).sin_cos();
    let (sz, cz) = (rz * 0.5).sin_cos();

    // q = qz * qy * qx, with each qa scalar-last.
    let qx = cz * cy * sx - sz * sy * cx;
    let qy = cz * sy * cx + sz * cy * sx;
    let qz = sz * cy * cx - cz * sy * sx;
    let qw = cz * cy * cx + sz * sy * sx;

    [qx as f32, qy as f32, qz as f32, qw as f32]
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::cast::AsArray;
    use arrow_array::{Array, Float32Array, StringArray};
    use arrow_ipc::reader::FileReader;
    use std::io::Cursor;

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1);
        batches.into_iter().next().unwrap()
    }

    /// A small sequence-form file with two frames: frame 0 (numeric ts, one
    /// quaternion cuboid) and frame 1 (string ts, one Euler cuboid).
    const SAMPLE: &str = r#"
    { "openlabel": {
      "metadata": { "name": "boxes" },
      "objects": {
        "0": { "name": "car1", "type": "car" },
        "1": { "name": "ped1", "type": "pedestrian" }
      },
      "frames": {
        "0": {
          "frame_properties": { "timestamp": 1.5 },
          "objects": {
            "0": { "object_data": { "cuboid": [
              { "name": "shape", "val": [12.0, 0.0, 0.75, 0.0, 0.0, 0.0, 1.0, 4.5, 1.8, 1.5] }
            ] } }
          }
        },
        "1": {
          "frame_properties": { "timestamp": "2024-01-01 00:00:00" },
          "objects": {
            "1": { "object_data": { "cuboid": [
              { "name": "shape", "val": [1.0, 2.0, 3.0, 0.0, 0.0, 1.5707963267948966, 0.5, 0.6, 1.7] }
            ] } }
          }
        }
      }
    } }
    "#;

    #[test]
    fn euler_identity_is_unit_quat() {
        let q = euler_xyz_to_quat(0.0, 0.0, 0.0);
        assert!((q[0]).abs() < 1e-6);
        assert!((q[1]).abs() < 1e-6);
        assert!((q[2]).abs() < 1e-6);
        assert!((q[3] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn euler_yaw_90_about_z() {
        let q = euler_xyz_to_quat(0.0, 0.0, std::f64::consts::FRAC_PI_2);
        let s = (std::f64::consts::FRAC_PI_4).sin() as f32;
        let c = (std::f64::consts::FRAC_PI_4).cos() as f32;
        assert!((q[0]).abs() < 1e-6);
        assert!((q[1]).abs() < 1e-6);
        assert!((q[2] - s).abs() < 1e-6);
        assert!((q[3] - c).abs() < 1e-6);
    }

    #[test]
    fn parses_meta_and_frames() {
        let r = OpenLabelReader::open(SAMPLE.as_bytes()).unwrap();
        assert_eq!(r.meta().kind, SourceKind::OpenLabel);
        assert_eq!(r.meta().channels.len(), 1);
        let ch = &r.meta().channels[0];
        assert_eq!(ch.name, "boxes");
        assert_eq!(ch.kind, ChannelKind::BoundingBox);
        assert_eq!(ch.sample_count, 1); // peak boxes-per-frame

        // Frame 0: 1.5 s → 1_500_000_000 ns. Frame 1: 2024-01-01 UTC.
        let times = r.frame_times();
        assert_eq!(times.len(), 2);
        assert_eq!(times[0], 1_500_000_000);
        assert_eq!(times[1], 1_704_067_200_000_000_000);
    }

    #[test]
    fn fetch_quaternion_cuboid_roundtrips() {
        let r = OpenLabelReader::open(SAMPLE.as_bytes()).unwrap();
        // Fetch frame 0 with a zero-width window + include_prev.
        let range = TimeRange {
            start_ns: 1_500_000_001,
            end_ns: 1_500_000_001,
        };
        let ipc = r
            .fetch_range("boxes", range, FetchOpts { include_prev: true })
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 1);

        let ts = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        assert_eq!(ts.value(0), 1_500_000_000);

        let centers = batch.column(1).as_list::<i32>().value(0);
        let c = centers.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(c.values(), &[12.0, 0.0, 0.75]);

        let sizes = batch.column(2).as_list::<i32>().value(0);
        let s = sizes.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(s.values(), &[4.5, 1.8, 1.5]);

        let rots = batch.column(3).as_list::<i32>().value(0);
        let q = rots.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(q.values(), &[0.0, 0.0, 0.0, 1.0]);

        let labels = batch.column(4).as_list::<i32>().value(0);
        let l = labels.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(l.value(0), "car");
    }

    #[test]
    fn fetch_euler_cuboid_converts_to_quat() {
        let r = OpenLabelReader::open(SAMPLE.as_bytes()).unwrap();
        // Frame 1 (string timestamp) holds the 9-element Euler cuboid.
        let t = r.frame_times()[1];
        let ipc = r
            .fetch_range(
                "boxes",
                TimeRange {
                    start_ns: t,
                    end_ns: t + 1,
                },
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 1);

        let centers = batch.column(1).as_list::<i32>().value(0);
        let c = centers.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(c.values(), &[1.0, 2.0, 3.0]);

        // Euler (0,0,π/2) → quat (0,0,sin45,cos45).
        let rots = batch.column(3).as_list::<i32>().value(0);
        let q = rots.as_any().downcast_ref::<Float32Array>().unwrap();
        let s = (std::f64::consts::FRAC_PI_4).sin() as f32;
        let cc = (std::f64::consts::FRAC_PI_4).cos() as f32;
        assert!((q.value(0)).abs() < 1e-6);
        assert!((q.value(1)).abs() < 1e-6);
        assert!((q.value(2) - s).abs() < 1e-6);
        assert!((q.value(3) - cc).abs() < 1e-6);

        let labels = batch.column(4).as_list::<i32>().value(0);
        let l = labels.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(l.value(0), "pedestrian");
    }

    #[test]
    fn static_form_single_frame() {
        // No `frames` key → cuboids under top-level objects, single frame at 0.
        let json = r#"
        { "openlabel": {
          "objects": {
            "0": { "type": "car", "object_data": { "cuboid": [
              { "val": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 4.0, 2.0, 1.5] }
            ] } }
          }
        } }
        "#;
        let r = OpenLabelReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.frame_times(), &[0]);
        assert_eq!(r.meta().channels[0].sample_count, 1);
        assert_eq!(r.meta().channels[0].name, "objects");
    }

    #[test]
    fn parses_convenience_field_cuboid() {
        // `val: null` with sibling translation/quaternion/size fields — the
        // OpenLABEL convenience form (Vicomtech VCD writes `traslation`). The
        // quaternion is scalar-FIRST [qw,qx,qy,qz]; identity here.
        let json = r#"
        { "openlabel": {
          "objects": {
            "1": { "type": "car", "object_data": { "cuboid": [
              { "name": "box3D",
                "quaternion": [1.0, 0.0, 0.0, 0.0],
                "traslation": [0.0, 10.0, -0.85],
                "size": [1.5, 4.5, 1.7],
                "val": null }
            ] } }
          }
        } }
        "#;
        let r = OpenLabelReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.frame_times(), &[0]);
        assert_eq!(r.meta().channels[0].sample_count, 1);

        let ipc = r
            .fetch_range(
                "objects",
                TimeRange {
                    start_ns: 0,
                    end_ns: 1,
                },
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);

        let centers = batch.column(1).as_list::<i32>().value(0);
        let c = centers.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(c.values(), &[0.0, 10.0, -0.85]);

        let sizes = batch.column(2).as_list::<i32>().value(0);
        let s = sizes.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(s.values(), &[1.5, 4.5, 1.7]);

        // Scalar-first identity [1,0,0,0] → scalar-last [0,0,0,1].
        let rots = batch.column(3).as_list::<i32>().value(0);
        let q = rots.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(q.values(), &[0.0, 0.0, 0.0, 1.0]);

        let labels = batch.column(4).as_list::<i32>().value(0);
        let l = labels.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(l.value(0), "car");
    }

    #[test]
    fn convenience_quaternion_scalar_first_conversion() {
        // Scalar-first [qw,qx,qy,qz] = [c, 0, 0, s] (yaw about z) must emit
        // scalar-last [0, 0, s, c].
        let s = (std::f64::consts::FRAC_PI_4).sin();
        let c = (std::f64::consts::FRAC_PI_4).cos();
        let json = format!(
            r#"
        {{ "openlabel": {{
          "objects": {{
            "0": {{ "type": "car", "object_data": {{ "cuboid": [
              {{ "quaternion": [{c}, 0.0, 0.0, {s}],
                 "translation": [1.0, 2.0, 3.0],
                 "size": [1.0, 1.0, 1.0] }}
            ] }} }}
          }}
        }} }}
        "#
        );
        let r = OpenLabelReader::open(json.as_bytes()).unwrap();
        let ipc = r
            .fetch_range(
                "objects",
                TimeRange {
                    start_ns: 0,
                    end_ns: 1,
                },
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        let rots = batch.column(3).as_list::<i32>().value(0);
        let q = rots.as_any().downcast_ref::<Float32Array>().unwrap();
        assert!((q.value(0)).abs() < 1e-6);
        assert!((q.value(1)).abs() < 1e-6);
        assert!((q.value(2) - s as f32).abs() < 1e-6);
        assert!((q.value(3) - c as f32).abs() < 1e-6);
    }

    #[test]
    fn convenience_missing_translation_skipped() {
        // No translation/traslation and no `val` → skip (not an error).
        let json = r#"
        { "openlabel": {
          "objects": {
            "0": { "type": "car", "object_data": { "cuboid": [
              { "size": [1.0, 1.0, 1.0], "quaternion": [1.0, 0.0, 0.0, 0.0], "val": null }
            ] } }
          }
        } }
        "#;
        let r = OpenLabelReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.meta().channels[0].sample_count, 0);
    }

    #[test]
    fn skips_malformed_cuboid_val() {
        // An 8-element `val` is neither 9 nor 10 → skipped, not an error.
        let json = r#"
        { "openlabel": {
          "objects": {
            "0": { "type": "car", "object_data": { "cuboid": [
              { "val": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 4.0] }
            ] } }
          }
        } }
        "#;
        let r = OpenLabelReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.frame_times(), &[0]);
        assert_eq!(r.meta().channels[0].sample_count, 0); // no valid boxes
    }

    #[test]
    fn unknown_channel_errors() {
        let r = OpenLabelReader::open(SAMPLE.as_bytes()).unwrap();
        let err = r
            .fetch_range("nope", r.meta().time_range, FetchOpts::default())
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn numeric_ns_timestamp_passthrough() {
        // A numeric timestamp already in ns magnitude is not multiplied by 1e9.
        let json = r#"
        { "openlabel": {
          "objects": { "0": { "type": "car" } },
          "frames": {
            "0": {
              "frame_properties": { "timestamp": 1700000000000000000 },
              "objects": { "0": { "object_data": { "cuboid": [
                { "val": [0,0,0, 0,0,0,1, 1,1,1] }
              ] } } }
            }
          }
        } }
        "#;
        let r = OpenLabelReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.frame_times(), &[1_700_000_000_000_000_000]);
    }
}
