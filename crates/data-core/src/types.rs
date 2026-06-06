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
