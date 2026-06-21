//! `CalibrationReader`: ingests a **`driveline.calibration/v1`** JSON file
//! (`*.calib.json`) describing one or more camera calibrations and surfaces a
//! single [`ChannelKind::CameraCalibration`] channel.
//!
//! A calibration ties a 2D camera (a `Video` channel) to the 3D scene/LiDAR
//! frame so a LiDAR point cloud can be projected onto the camera image. It is
//! **config, not a time series**: one fetch returns *all* cameras (one row per
//! camera), and the requested time range is ignored. See
//! `docs/13-camera-lidar-calibration.md` for the full cross-cutting contract.
//!
//! ## Coordinate frames & conventions
//!
//! - Scene / LiDAR (ego) frame: metres, x-forward, y-left, z-up (ISO-8855).
//! - Camera optical frame: x-right, y-down, z-forward (OpenCV pinhole).
//! - The extrinsic takes a point **from the scene/LiDAR frame into the camera
//!   optical frame**: `p_cam = quatRotate(quaternion, p_scene) + translation`.
//! - `quaternion` is a unit quaternion, **scalar-last `[qx, qy, qz, qw]`** —
//!   the same wire convention as OpenLABEL cuboids.
//!
//! ## Camera models
//!
//! Two projection models are supported, selected per camera by `model`:
//!
//! - **`pinhole`** (default): the OpenCV pinhole `intrinsics` `[fx, fy, cx, cy]`
//!   with optional Brown–Conrady `distortion`. Used by nuScenes and the
//!   synthetic fixture.
//! - **`ftheta`**: NVIDIA's f-theta polynomial fisheye model (Alpamayo and most
//!   modern AV stacks). A `forward_poly` maps the ray's angle from the optical
//!   axis (radians) to a pixel radius from the principal point — it captures the
//!   wide-FOV lens distortion a pinhole `fx`/`fy` cannot. `distortion` is unused
//!   for `ftheta`; `intrinsics.fx`/`fy` carry the linear-term approximation so a
//!   pinhole-only consumer degrades gracefully, while `cx`/`cy` stay exact.
//!
//! ## Source structure (what `open` expects)
//!
//! Root must carry `"schema": "driveline.calibration/v1"` — this marker (not
//! the file extension) is how a `.calib.json` is distinguished from any other
//! `.json` drop. Under `cameras` is an array of objects:
//!
//! ```jsonc
//! {
//!   "schema": "driveline.calibration/v1",
//!   "cameras": [{
//!     "name": "CAM_FRONT",
//!     "model": "pinhole",                     // optional; "pinhole" (default) or "ftheta"
//!     "intrinsics": { "fx": 1266.4, "fy": 1266.4, "cx": 816.3, "cy": 491.5,
//!                     "width": 1600, "height": 900 },
//!     "distortion": [0, 0, 0, 0, 0],          // optional; omit or [] = none (pinhole only)
//!     "forward_poly": [0, 926.1, -3.2, -19.3, 3.7], // required for "ftheta"; angle(rad)->px radius
//!     "extrinsic": {                          // scene/LiDAR -> camera optical
//!       "translation": [0.0, 0.0, 0.0],
//!       "quaternion":  [-0.5, 0.5, -0.5, 0.5] // [qx,qy,qz,qw], scalar-last
//!     },
//!     "target_frame": "lidar"                 // informational only
//!   }]
//! }
//! ```
//!
//! ## Fetch schema (what `fetch_range` returns)
//!
//! One row per camera, all columns **non-nullable**, every vector field a
//! `List<Float32>` / `List<Int32>` to match the OpenLABEL precedent:
//!
//! | column         | Arrow type      | meaning                                    |
//! | -------------- | --------------- | ------------------------------------------ |
//! | `name`         | `Utf8`          | camera name, e.g. `CAM_FRONT`              |
//! | `model`        | `Utf8`          | `"pinhole"` or `"ftheta"`                  |
//! | `intrinsics`   | `List<Float32>` | length 4 = `[fx, fy, cx, cy]` (px)         |
//! | `resolution`   | `List<Int32>`   | length 2 = `[width, height]` (px)          |
//! | `distortion`   | `List<Float32>` | length 0 or 5 = `[k1,k2,p1,p2,k3]`         |
//! | `forward_poly` | `List<Float32>` | length 0 (pinhole) or ≥2 ftheta coeffs     |
//! | `translation`  | `List<Float32>` | length 3 = `[tx, ty, tz]` (m)              |
//! | `quaternion`   | `List<Float32>` | length 4 = `[qx, qy, qz, qw]` scalar-last  |

use std::sync::Arc;

use arrow_array::builder::{Float32Builder, Int32Builder, ListBuilder, StringBuilder};
use arrow_array::RecordBatch;
use arrow_schema::{DataType, Field, Schema};
use serde_json::Value;

use crate::reader::{ArrowIpc, Reader};
use crate::types::{Channel, ChannelId, ChannelKind, FetchOpts, SourceKind, SourceMeta, TimeRange};

/// The schema marker that identifies a Driveline calibration JSON. `open`
/// requires this exact value so a `.calib.json` is told apart from any other
/// `.json` drop by content, not by file extension.
const SCHEMA_MARKER: &str = "driveline.calibration/v1";

/// The fixed channel id/name for the single calibration channel a source
/// surfaces. Calibration is config, not a time series, so there is exactly one
/// channel carrying every camera.
const CHANNEL_NAME: &str = "calibration";

/// Camera projection model. `Pinhole` uses `intrinsics` + Brown–Conrady
/// `distortion`; `FTheta` uses the `forward_poly` (angle→pixel-radius) fisheye
/// polynomial and ignores `distortion`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CameraModel {
    Pinhole,
    FTheta,
}

impl CameraModel {
    /// Wire string emitted in the `model` Arrow column / accepted in the JSON.
    fn as_str(self) -> &'static str {
        match self {
            CameraModel::Pinhole => "pinhole",
            CameraModel::FTheta => "ftheta",
        }
    }
}

/// One decoded camera calibration. Vector fields are owned so `fetch_range` can
/// append them straight into the Arrow builders.
struct Camera {
    name: String,
    /// Projection model: `pinhole` (intrinsics + distortion) or `ftheta`
    /// (forward_poly fisheye).
    model: CameraModel,
    /// `[fx, fy, cx, cy]` in pixels. For `ftheta`, `fx`/`fy` are the linear-term
    /// approximation and `cx`/`cy` are exact.
    intrinsics: [f32; 4],
    /// `[width, height]` in pixels.
    resolution: [i32; 2],
    /// `[]` (no distortion) or exactly 5 floats `[k1, k2, p1, p2, k3]`. Unused
    /// for `ftheta`.
    distortion: Vec<f32>,
    /// f-theta forward polynomial: `[]` for pinhole, else ≥2 coefficients
    /// `[c0, c1, …]` mapping a ray's angle from the optical axis (radians) to a
    /// pixel radius from the principal point (`r = Σ cᵢ·θⁱ`).
    forward_poly: Vec<f32>,
    /// `[tx, ty, tz]` metres.
    translation: [f32; 3],
    /// `[qx, qy, qz, qw]`, scalar-last, unit length.
    quaternion: [f32; 4],
}

pub struct CalibrationReader {
    meta: SourceMeta,
    channel_id: ChannelId,
    cameras: Vec<Camera>,
}

impl CalibrationReader {
    /// Parse calibration JSON bytes into a reader. Rejects any JSON whose
    /// `schema` is not [`SCHEMA_MARKER`] (so a non-calibration `.json` cannot
    /// be opened by this reader) and any camera with malformed fields.
    fn parse(bytes: &[u8]) -> crate::Result<Self> {
        let root: Value = serde_json::from_slice(bytes)
            .map_err(|e| crate::Error::CalibrationParse(e.to_string()))?;

        let schema = root.get("schema").and_then(Value::as_str);
        if schema != Some(SCHEMA_MARKER) {
            return Err(crate::Error::CalibrationParse(format!(
                "missing or wrong `schema` (expected `{SCHEMA_MARKER}`, got {schema:?})"
            )));
        }

        let cameras_val = root
            .get("cameras")
            .and_then(Value::as_array)
            .ok_or_else(|| crate::Error::CalibrationParse("missing `cameras` array".into()))?;

        let mut cameras: Vec<Camera> = Vec::with_capacity(cameras_val.len());
        for (i, cam) in cameras_val.iter().enumerate() {
            cameras.push(parse_camera(cam, i)?);
        }

        Ok(Self::from_cameras(cameras))
    }

    /// Build a reader from decoded cameras, computing the channel meta. There
    /// is no meaningful time range for config — `time_range` is empty and the
    /// channel `sample_count` is the camera count.
    fn from_cameras(cameras: Vec<Camera>) -> Self {
        let time_range = TimeRange::empty();
        let channel = Channel {
            id: CHANNEL_NAME.to_string(),
            source_id: String::new(),
            name: CHANNEL_NAME.to_string(),
            kind: ChannelKind::CameraCalibration,
            dtype: None,
            unit: None,
            // "sample_count" for calibration is the number of cameras carried.
            sample_count: cameras.len() as u64,
            time_range,
        };

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::Calibration,
            time_range,
            channels: vec![channel],
        };

        CalibrationReader {
            meta,
            channel_id: CHANNEL_NAME.to_string(),
            cameras,
        }
    }

    /// Open from an owned buffer (preferred at the wasm boundary).
    pub fn open_owned(bytes: Vec<u8>) -> crate::Result<Self> {
        Self::parse(&bytes)
    }

    /// Arrow schema `fetch_range` emits. All eight columns are non-nullable;
    /// every vector field is a variable-length `List<Float32>` / `List<Int32>`.
    fn fetch_schema() -> Arc<Schema> {
        let f32_item = || Arc::new(Field::new("item", DataType::Float32, true));
        let i32_item = Arc::new(Field::new("item", DataType::Int32, true));
        Arc::new(Schema::new(vec![
            Field::new("name", DataType::Utf8, false),
            Field::new("model", DataType::Utf8, false),
            Field::new("intrinsics", DataType::List(f32_item()), false),
            Field::new("resolution", DataType::List(i32_item), false),
            Field::new("distortion", DataType::List(f32_item()), false),
            Field::new("forward_poly", DataType::List(f32_item()), false),
            Field::new("translation", DataType::List(f32_item()), false),
            Field::new("quaternion", DataType::List(f32_item()), false),
        ]))
    }
}

impl Reader for CalibrationReader {
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        Self::parse(bytes)
    }

    fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    /// Calibration is config: the requested `range`/`opts` are irrelevant and
    /// ignored — every camera is always returned, one row each.
    fn fetch_range(
        &self,
        channel_id: &str,
        _range: TimeRange,
        _opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        if channel_id != self.channel_id {
            return Err(crate::Error::ChannelNotFound(channel_id.to_string()));
        }

        let schema = Self::fetch_schema();
        let n = self.cameras.len();

        let mut name_b = StringBuilder::new();
        let mut model_b = StringBuilder::new();
        let mut intrinsics_b = ListBuilder::with_capacity(Float32Builder::with_capacity(n * 4), n);
        let mut resolution_b = ListBuilder::with_capacity(Int32Builder::with_capacity(n * 2), n);
        let mut distortion_b = ListBuilder::with_capacity(Float32Builder::with_capacity(n * 5), n);
        let mut forward_poly_b =
            ListBuilder::with_capacity(Float32Builder::with_capacity(n * 5), n);
        let mut translation_b = ListBuilder::with_capacity(Float32Builder::with_capacity(n * 3), n);
        let mut quaternion_b = ListBuilder::with_capacity(Float32Builder::with_capacity(n * 4), n);

        for cam in &self.cameras {
            name_b.append_value(&cam.name);
            model_b.append_value(cam.model.as_str());

            intrinsics_b.values().append_slice(&cam.intrinsics);
            intrinsics_b.append(true);

            resolution_b.values().append_slice(&cam.resolution);
            resolution_b.append(true);

            distortion_b.values().append_slice(&cam.distortion);
            distortion_b.append(true);

            forward_poly_b.values().append_slice(&cam.forward_poly);
            forward_poly_b.append(true);

            translation_b.values().append_slice(&cam.translation);
            translation_b.append(true);

            quaternion_b.values().append_slice(&cam.quaternion);
            quaternion_b.append(true);
        }

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(name_b.finish()),
                Arc::new(model_b.finish()),
                Arc::new(intrinsics_b.finish()),
                Arc::new(resolution_b.finish()),
                Arc::new(distortion_b.finish()),
                Arc::new(forward_poly_b.finish()),
                Arc::new(translation_b.finish()),
                Arc::new(quaternion_b.finish()),
            ],
        )?;

        crate::arrow::write_ipc(schema, batch)
    }
}

/// Parse one camera object. `index` is used only for error messages.
fn parse_camera(cam: &Value, index: usize) -> crate::Result<Camera> {
    let err = |msg: String| crate::Error::CalibrationParse(format!("camera {index}: {msg}"));

    let name = cam
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| err("missing `name`".into()))?
        .to_string();

    // Projection model: absent or "pinhole" → Pinhole; "ftheta" → FTheta.
    let model = match cam.get("model").and_then(Value::as_str) {
        None | Some("pinhole") => CameraModel::Pinhole,
        Some("ftheta") => CameraModel::FTheta,
        Some(other) => {
            return Err(err(format!(
                "unknown `model` {other:?} (expected \"pinhole\" or \"ftheta\")"
            )))
        }
    };

    let intr = cam
        .get("intrinsics")
        .ok_or_else(|| err("missing `intrinsics`".into()))?;
    let fx = read_num(intr, "fx").ok_or_else(|| err("missing `intrinsics.fx`".into()))?;
    let fy = read_num(intr, "fy").ok_or_else(|| err("missing `intrinsics.fy`".into()))?;
    let cx = read_num(intr, "cx").ok_or_else(|| err("missing `intrinsics.cx`".into()))?;
    let cy = read_num(intr, "cy").ok_or_else(|| err("missing `intrinsics.cy`".into()))?;
    let width = read_num(intr, "width").ok_or_else(|| err("missing `intrinsics.width`".into()))?;
    let height =
        read_num(intr, "height").ok_or_else(|| err("missing `intrinsics.height`".into()))?;

    // Distortion is optional: absent or `[]` → none; otherwise exactly 5.
    let distortion: Vec<f32> = match cam.get("distortion") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(arr)) => {
            let nums: Vec<f32> = arr
                .iter()
                .filter_map(Value::as_f64)
                .map(|n| n as f32)
                .collect();
            if nums.len() != arr.len() {
                return Err(err("`distortion` contains a non-numeric entry".into()));
            }
            if !nums.is_empty() && nums.len() != 5 {
                return Err(err(format!(
                    "`distortion` must be length 0 or 5, got {}",
                    nums.len()
                )));
            }
            nums
        }
        Some(_) => return Err(err("`distortion` must be an array".into())),
    };

    // Forward polynomial: absent/`[]` for pinhole; ≥2 numeric coefficients for
    // ftheta. Cross-checked against `model` so the two never disagree.
    let forward_poly: Vec<f32> = match cam.get("forward_poly") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(arr)) => {
            let nums: Vec<f32> = arr
                .iter()
                .filter_map(Value::as_f64)
                .map(|n| n as f32)
                .collect();
            if nums.len() != arr.len() {
                return Err(err("`forward_poly` contains a non-numeric entry".into()));
            }
            nums
        }
        Some(_) => return Err(err("`forward_poly` must be an array".into())),
    };
    match model {
        CameraModel::FTheta if forward_poly.len() < 2 => {
            return Err(err(
                "`model: \"ftheta\"` requires a `forward_poly` of at least 2 coefficients".into(),
            ))
        }
        CameraModel::Pinhole if !forward_poly.is_empty() => {
            return Err(err(
                "`forward_poly` is only valid with `model: \"ftheta\"`".into()
            ))
        }
        _ => {}
    }

    let extr = cam
        .get("extrinsic")
        .ok_or_else(|| err("missing `extrinsic`".into()))?;
    let translation = read_vec_n(extr.get("translation"), 3)
        .ok_or_else(|| err("`extrinsic.translation` must be 3 numbers".into()))?;
    let quaternion = read_vec_n(extr.get("quaternion"), 4)
        .ok_or_else(|| err("`extrinsic.quaternion` must be 4 numbers".into()))?;

    Ok(Camera {
        name,
        model,
        intrinsics: [fx, fy, cx, cy],
        resolution: [width as i32, height as i32],
        distortion,
        forward_poly,
        translation: [translation[0], translation[1], translation[2]],
        quaternion: [quaternion[0], quaternion[1], quaternion[2], quaternion[3]],
    })
}

/// Read a numeric field `key` off an object as `f32`, else `None`.
fn read_num(obj: &Value, key: &str) -> Option<f32> {
    obj.get(key).and_then(Value::as_f64).map(|n| n as f32)
}

/// Read a JSON array of exactly `n` numbers into a `Vec<f32>`, else `None`.
fn read_vec_n(v: Option<&Value>, n: usize) -> Option<Vec<f32>> {
    let arr = v?.as_array()?;
    let nums: Vec<f32> = arr
        .iter()
        .filter_map(Value::as_f64)
        .map(|x| x as f32)
        .collect();
    if nums.len() != n {
        return None;
    }
    Some(nums)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::cast::AsArray;
    use arrow_array::{Float32Array, Int32Array, StringArray};
    use arrow_ipc::reader::FileReader;
    use std::io::Cursor;

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1);
        batches.into_iter().next().unwrap()
    }

    /// The CAM_FRONT example from docs/13 (nuScenes-style intrinsics, zero
    /// distortion, identity-ish extrinsic).
    const SAMPLE: &str = r#"
    {
      "schema": "driveline.calibration/v1",
      "cameras": [
        {
          "name": "CAM_FRONT",
          "intrinsics": { "fx": 1266.4, "fy": 1266.4, "cx": 816.3, "cy": 491.5,
                          "width": 1600, "height": 900 },
          "distortion": [0, 0, 0, 0, 0],
          "extrinsic": {
            "translation": [0.0, 0.0, 0.0],
            "quaternion":  [-0.5, 0.5, -0.5, 0.5]
          },
          "target_frame": "lidar"
        }
      ]
    }
    "#;

    #[test]
    fn parses_meta_and_one_camera() {
        let r = CalibrationReader::open(SAMPLE.as_bytes()).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Calibration);
        assert_eq!(r.meta().channels.len(), 1);
        let ch = &r.meta().channels[0];
        assert_eq!(ch.name, "calibration");
        assert_eq!(ch.kind, ChannelKind::CameraCalibration);
        assert_eq!(ch.sample_count, 1);
    }

    #[test]
    fn fetch_emits_camera_row() {
        let r = CalibrationReader::open(SAMPLE.as_bytes()).unwrap();
        let ipc = r
            .fetch_range("calibration", TimeRange::empty(), FetchOpts::default())
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 1);

        let name = batch
            .column(0)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        assert_eq!(name.value(0), "CAM_FRONT");

        let model = batch
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        assert_eq!(model.value(0), "pinhole");

        let intr = batch.column(2).as_list::<i32>().value(0);
        let intr = intr.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(intr.values(), &[1266.4, 1266.4, 816.3, 491.5]);

        let res = batch.column(3).as_list::<i32>().value(0);
        let res = res.as_any().downcast_ref::<Int32Array>().unwrap();
        assert_eq!(res.values(), &[1600, 900]);

        let dist = batch.column(4).as_list::<i32>().value(0);
        let dist = dist.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(dist.values(), &[0.0, 0.0, 0.0, 0.0, 0.0]);

        // Pinhole camera carries an empty forward_poly.
        let fwd = batch.column(5).as_list::<i32>().value(0);
        let fwd = fwd.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(fwd.len(), 0);

        let trans = batch.column(6).as_list::<i32>().value(0);
        let trans = trans.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(trans.values(), &[0.0, 0.0, 0.0]);

        let quat = batch.column(7).as_list::<i32>().value(0);
        let quat = quat.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(quat.values(), &[-0.5, 0.5, -0.5, 0.5]);
    }

    #[test]
    fn omitted_distortion_is_empty() {
        let json = r#"
        { "schema": "driveline.calibration/v1", "cameras": [
          { "name": "CAM", "intrinsics": { "fx": 1, "fy": 1, "cx": 1, "cy": 1,
            "width": 10, "height": 20 },
            "extrinsic": { "translation": [0,0,0], "quaternion": [0,0,0,1] } }
        ] }
        "#;
        let r = CalibrationReader::open(json.as_bytes()).unwrap();
        let ipc = r
            .fetch_range("calibration", TimeRange::empty(), FetchOpts::default())
            .unwrap();
        let batch = parse_ipc(&ipc);
        let dist = batch.column(4).as_list::<i32>().value(0);
        let dist = dist.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(dist.len(), 0);
    }

    #[test]
    fn multiple_cameras_round_trip() {
        let json = r#"
        { "schema": "driveline.calibration/v1", "cameras": [
          { "name": "A", "intrinsics": { "fx": 1, "fy": 2, "cx": 3, "cy": 4,
            "width": 100, "height": 200 },
            "extrinsic": { "translation": [1,2,3], "quaternion": [0,0,0,1] } },
          { "name": "B", "intrinsics": { "fx": 5, "fy": 6, "cx": 7, "cy": 8,
            "width": 300, "height": 400 }, "distortion": [1,2,3,4,5],
            "extrinsic": { "translation": [4,5,6], "quaternion": [1,0,0,0] } }
        ] }
        "#;
        let r = CalibrationReader::open(json.as_bytes()).unwrap();
        assert_eq!(r.meta().channels[0].sample_count, 2);
        let ipc = r
            .fetch_range("calibration", TimeRange::empty(), FetchOpts::default())
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 2);
        let name = batch
            .column(0)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        assert_eq!(name.value(0), "A");
        assert_eq!(name.value(1), "B");
        // Second camera carries a 5-element distortion vector.
        let dist = batch.column(4).as_list::<i32>().value(1);
        let dist = dist.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(dist.values(), &[1.0, 2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn ftheta_model_round_trips() {
        let json = r#"
        { "schema": "driveline.calibration/v1", "cameras": [
          { "name": "FISHEYE", "model": "ftheta",
            "intrinsics": { "fx": 926.1, "fy": 926.1, "cx": 960.0, "cy": 540.0,
              "width": 1920, "height": 1080 },
            "forward_poly": [0.0, 926.1, -3.16, -19.34, 3.72],
            "extrinsic": { "translation": [1,2,3], "quaternion": [0,0,0,1] } }
        ] }
        "#;
        let r = CalibrationReader::open(json.as_bytes()).unwrap();
        let ipc = r
            .fetch_range("calibration", TimeRange::empty(), FetchOpts::default())
            .unwrap();
        let batch = parse_ipc(&ipc);
        let model = batch
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        assert_eq!(model.value(0), "ftheta");
        // forward_poly (column 5) carries the 5 coefficients verbatim;
        // distortion (column 4) stays empty.
        let fwd = batch.column(5).as_list::<i32>().value(0);
        let fwd = fwd.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(fwd.values(), &[0.0, 926.1, -3.16, -19.34, 3.72]);
        let dist = batch.column(4).as_list::<i32>().value(0);
        let dist = dist.as_any().downcast_ref::<Float32Array>().unwrap();
        assert_eq!(dist.len(), 0);
    }

    #[test]
    fn ftheta_without_forward_poly_rejected() {
        let json = r#"
        { "schema": "driveline.calibration/v1", "cameras": [
          { "name": "FISHEYE", "model": "ftheta",
            "intrinsics": { "fx": 1, "fy": 1, "cx": 1, "cy": 1, "width": 10, "height": 20 },
            "extrinsic": { "translation": [0,0,0], "quaternion": [0,0,0,1] } }
        ] }
        "#;
        assert!(matches!(
            CalibrationReader::open(json.as_bytes()),
            Err(crate::Error::CalibrationParse(_))
        ));
    }

    #[test]
    fn forward_poly_on_pinhole_rejected() {
        let json = r#"
        { "schema": "driveline.calibration/v1", "cameras": [
          { "name": "CAM", "intrinsics": { "fx": 1, "fy": 1, "cx": 1, "cy": 1,
            "width": 10, "height": 20 }, "forward_poly": [0, 900],
            "extrinsic": { "translation": [0,0,0], "quaternion": [0,0,0,1] } }
        ] }
        "#;
        assert!(matches!(
            CalibrationReader::open(json.as_bytes()),
            Err(crate::Error::CalibrationParse(_))
        ));
    }

    #[test]
    fn wrong_schema_marker_rejected() {
        let json = r#"{ "schema": "something.else/v1", "cameras": [] }"#;
        assert!(matches!(
            CalibrationReader::open(json.as_bytes()),
            Err(crate::Error::CalibrationParse(_))
        ));
        // A plain OpenLABEL file (no `schema` key) is rejected too.
        let ol = r#"{ "openlabel": { "objects": {} } }"#;
        assert!(matches!(
            CalibrationReader::open(ol.as_bytes()),
            Err(crate::Error::CalibrationParse(_))
        ));
    }

    #[test]
    fn bad_distortion_length_rejected() {
        let json = r#"
        { "schema": "driveline.calibration/v1", "cameras": [
          { "name": "CAM", "intrinsics": { "fx": 1, "fy": 1, "cx": 1, "cy": 1,
            "width": 10, "height": 20 }, "distortion": [1, 2, 3],
            "extrinsic": { "translation": [0,0,0], "quaternion": [0,0,0,1] } }
        ] }
        "#;
        assert!(matches!(
            CalibrationReader::open(json.as_bytes()),
            Err(crate::Error::CalibrationParse(_))
        ));
    }

    #[test]
    fn unknown_channel_errors() {
        let r = CalibrationReader::open(SAMPLE.as_bytes()).unwrap();
        let err = r
            .fetch_range("nope", TimeRange::empty(), FetchOpts::default())
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }
}
