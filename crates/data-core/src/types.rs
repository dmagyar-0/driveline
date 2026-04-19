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
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FetchOpts {
    pub max_points: Option<u32>,
    pub include_prev: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_range_empty_constructor_is_empty() {
        let r = TimeRange::empty();
        assert_eq!(r.start_ns, 0);
        assert_eq!(r.end_ns, 0);
        assert!(r.is_empty());
    }

    #[test]
    fn time_range_is_empty_half_open_semantics() {
        // Non-empty: end_ns > start_ns.
        assert!(!TimeRange {
            start_ns: 10,
            end_ns: 11,
        }
        .is_empty());
        // Zero-length range (end == start) is empty under the half-open
        // [start, end) contract in docs/03-data-model.md.
        assert!(TimeRange {
            start_ns: 42,
            end_ns: 42,
        }
        .is_empty());
        // Inverted ranges (end < start) are also treated as empty so callers
        // can skip work without having to validate ordering themselves.
        assert!(TimeRange {
            start_ns: 100,
            end_ns: 50,
        }
        .is_empty());
    }
}
