//! Canonical types. Mirrors `docs/03-data-model.md`.

pub type SourceId = String;
pub type ChannelId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeRange {
    pub start_ns: i64,
    pub end_ns: i64,
}

impl TimeRange {
    pub const fn empty() -> Self {
        Self {
            start_ns: 0,
            end_ns: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.end_ns <= self.start_ns
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Scalar,
    Vector,
    Video,
    Enum,
    Bytes,
    /// A per-frame array of 3D points (e.g. a LiDAR spin). Each "sample" is a
    /// whole point cloud, fetched one frame at a time by the 3D scene panel —
    /// not a scalar time series. See `pointcloud.rs` for the Arrow schema.
    PointCloud,
    /// A per-frame set of 3D oriented bounding boxes (cuboids), sourced from
    /// ASAM OpenLABEL JSON. Each "sample" is a whole frame's worth of boxes
    /// (centers/sizes/rotations/labels), fetched one frame at a time by the 3D
    /// scene panel. See `openlabel.rs` for the Arrow schema.
    BoundingBox,
    /// Camera calibration tying a 2D camera (a `Video` channel) to the 3D
    /// scene/LiDAR frame: a pinhole intrinsic plus a translation+quaternion
    /// extrinsic. This is **config, not a time series** — one fetch returns all
    /// cameras (one row per camera), and the range is ignored. Sourced from a
    /// `driveline.calibration/v1` JSON file. See `calibration.rs` for the Arrow
    /// schema and `docs/13-camera-lidar-calibration.md` for the contract.
    CameraCalibration,
    /// A per-frame predicted ego future trajectory (Alpamayo-style), sourced
    /// from a Driveline `*.trajectory.json` file. Each "sample" is a whole
    /// frame's worth of one-or-more candidate waypoint polylines (with a
    /// confidence per path), fetched one frame at a time by the 3D scene panel.
    /// See `trajectory.rs` for the Arrow schema.
    Trajectory,
    /// A road-network "map": a single static frame of typed polylines (lane
    /// boundaries, road edges, centerlines, crosswalks, stop lines), sourced
    /// from an OpenDRIVE `.xodr` file or the simple `drivelineMap` JSON format.
    /// Rendered as lines in the 3D scene panel. See `map_geometry.rs` for the
    /// Arrow schema.
    MapGeometry,
}

impl ChannelKind {
    /// The canonical lowercase wire string for this kind. This is a
    /// cross-surface contract: the web app, the agent API, the `data-cli`
    /// JSON, and the docs all key off these exact values — see
    /// `docs/03-data-model.md`. Both `wasm-bindings` and `data-cli` route
    /// through here so the two surfaces can never drift.
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelKind::Scalar => "scalar",
            ChannelKind::Vector => "vector",
            ChannelKind::Video => "video",
            ChannelKind::Enum => "enum",
            ChannelKind::Bytes => "bytes",
            ChannelKind::PointCloud => "point_cloud",
            ChannelKind::BoundingBox => "bounding_box",
            ChannelKind::CameraCalibration => "camera_calibration",
            ChannelKind::Trajectory => "trajectory",
            ChannelKind::MapGeometry => "map_geometry",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    F32,
    F64,
    I32,
    I64,
    U32,
    U64,
}

impl DType {
    /// The canonical lowercase wire string for this dtype (`"f32"`, `"i64"`,
    /// …). Shared by every surface; see [`ChannelKind::as_str`].
    pub fn as_str(self) -> &'static str {
        match self {
            DType::F32 => "f32",
            DType::F64 => "f64",
            DType::I32 => "i32",
            DType::I64 => "i64",
            DType::U32 => "u32",
            DType::U64 => "u64",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: ChannelId,
    pub source_id: SourceId,
    pub name: String,
    pub kind: ChannelKind,
    pub dtype: Option<DType>,
    pub unit: Option<String>,
    pub sample_count: u64,
    pub time_range: TimeRange,
}

#[derive(Debug, Clone)]
pub struct SourceMeta {
    pub id: SourceId,
    pub kind: SourceKind,
    pub time_range: TimeRange,
    pub channels: Vec<Channel>,
}

impl SourceMeta {
    pub fn empty() -> Self {
        Self {
            id: String::new(),
            kind: SourceKind::Noop,
            time_range: TimeRange::empty(),
            channels: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Noop,
    Mcap,
    Mf4,
    Mp4Sidecar,
    Tabular,
    /// A source decoded from an unknown format via a declarative Ingest Recipe
    /// (the Format Agent path). See `RecipeReader` and `docs/12-format-agent.md`.
    Recipe,
    /// A ROS1 `.bag` (rosbag v2.0). See `Ros1BagReader`.
    Ros1,
    /// A Driveline point-cloud Parquet (one row per LiDAR spin). See
    /// `PointCloudReader`.
    Lidar,
    /// An ASAM OpenLABEL JSON file of 3D cuboid annotations. See
    /// `OpenLabelReader`.
    OpenLabel,
    /// A `driveline.calibration/v1` JSON file describing one or more camera
    /// calibrations (intrinsic + scene/LiDAR→camera extrinsic). See
    /// `CalibrationReader`.
    Calibration,
    /// A Driveline `*.trajectory.json` file of per-frame predicted ego future
    /// trajectories (candidate waypoint polylines). See `TrajectoryReader`.
    Trajectory,
    /// A road-network map (OpenDRIVE `.xodr` or the simple `drivelineMap` JSON
    /// format) surfaced as a single static frame of typed polylines. See
    /// `MapGeometryReader`.
    MapGeometry,
}

impl SourceKind {
    /// The canonical lowercase wire string for this source kind, as emitted by
    /// the `data-cli` `info` JSON. Shared so any future consumer stays in sync.
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Noop => "noop",
            SourceKind::Mcap => "mcap",
            SourceKind::Mf4 => "mf4",
            SourceKind::Mp4Sidecar => "mp4-sidecar",
            SourceKind::Tabular => "tabular",
            SourceKind::Recipe => "recipe",
            SourceKind::Ros1 => "ros1",
            SourceKind::Lidar => "lidar",
            SourceKind::OpenLabel => "openlabel",
            SourceKind::Calibration => "calibration",
            SourceKind::Trajectory => "trajectory",
            SourceKind::MapGeometry => "map_geometry",
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FetchOpts {
    pub include_prev: bool,
}

/// One access unit (frame's worth of NAL units, Annex-B framed) as pulled
/// from a `Reader::video_stream` iterator. `pts_ns` is absolute ns UTC;
/// `is_keyframe` is true for IDR/SPS-bearing access units.
#[derive(Debug, Clone)]
pub struct EncodedChunk {
    pub pts_ns: i64,
    pub is_keyframe: bool,
    pub data: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The kind/dtype/source-kind wire strings are a cross-surface contract
    /// (web app, agent API, `data-cli`, docs). Pin every variant so a rename
    /// can't silently drift the two surfaces apart.
    #[test]
    fn channel_kind_strings_are_stable() {
        assert_eq!(ChannelKind::Scalar.as_str(), "scalar");
        assert_eq!(ChannelKind::Vector.as_str(), "vector");
        assert_eq!(ChannelKind::Video.as_str(), "video");
        assert_eq!(ChannelKind::Enum.as_str(), "enum");
        assert_eq!(ChannelKind::Bytes.as_str(), "bytes");
        assert_eq!(ChannelKind::PointCloud.as_str(), "point_cloud");
        assert_eq!(ChannelKind::BoundingBox.as_str(), "bounding_box");
        assert_eq!(
            ChannelKind::CameraCalibration.as_str(),
            "camera_calibration"
        );
        assert_eq!(ChannelKind::Trajectory.as_str(), "trajectory");
        assert_eq!(ChannelKind::MapGeometry.as_str(), "map_geometry");
    }

    #[test]
    fn dtype_strings_are_stable() {
        assert_eq!(DType::F32.as_str(), "f32");
        assert_eq!(DType::F64.as_str(), "f64");
        assert_eq!(DType::I32.as_str(), "i32");
        assert_eq!(DType::I64.as_str(), "i64");
        assert_eq!(DType::U32.as_str(), "u32");
        assert_eq!(DType::U64.as_str(), "u64");
    }

    #[test]
    fn source_kind_strings_are_stable() {
        assert_eq!(SourceKind::Noop.as_str(), "noop");
        assert_eq!(SourceKind::Mcap.as_str(), "mcap");
        assert_eq!(SourceKind::Mf4.as_str(), "mf4");
        assert_eq!(SourceKind::Mp4Sidecar.as_str(), "mp4-sidecar");
        assert_eq!(SourceKind::Tabular.as_str(), "tabular");
        assert_eq!(SourceKind::Recipe.as_str(), "recipe");
        assert_eq!(SourceKind::Ros1.as_str(), "ros1");
        assert_eq!(SourceKind::Lidar.as_str(), "lidar");
        assert_eq!(SourceKind::OpenLabel.as_str(), "openlabel");
        assert_eq!(SourceKind::Calibration.as_str(), "calibration");
        assert_eq!(SourceKind::Trajectory.as_str(), "trajectory");
        assert_eq!(SourceKind::MapGeometry.as_str(), "map_geometry");
    }
}
