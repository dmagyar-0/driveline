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
    /// A per-frame predicted ego future trajectory (Alpamayo-style), sourced
    /// from a Driveline `*.trajectory.json` file. Each "sample" is a whole
    /// frame's worth of one-or-more candidate waypoint polylines (with a
    /// confidence per path), fetched one frame at a time by the 3D scene panel.
    /// See `trajectory.rs` for the Arrow schema.
    Trajectory,
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
    /// A Driveline `*.trajectory.json` file of per-frame predicted ego future
    /// trajectories (candidate waypoint polylines). See `TrajectoryReader`.
    Trajectory,
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
