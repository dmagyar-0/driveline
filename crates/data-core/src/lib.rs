//! Portable reader core for driveline. Native-only (no wasm-bindgen).
//!
//! M2 introduces `Mf4Reader` — the first real `Reader` implementation — on
//! top of the WASM-safe entry points of `mf4-rs`. MCAP / mp4+sidecar land
//! in follow-up milestones.

pub mod fixtures;
pub mod mf4;
pub mod mp4_sidecar;
pub mod noop;
pub mod reader;
pub mod types;

pub use mf4::Mf4Reader;
pub use mp4_sidecar::Mp4SidecarReader;
pub use reader::{ArrowIpc, Reader};
pub use types::{
    Channel, ChannelId, ChannelKind, DType, FetchOpts, SourceId, SourceKind, SourceMeta, TimeRange,
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported channel kind for this reader")]
    UnsupportedKind,

    #[error("channel not found: {0}")]
    ChannelNotFound(ChannelId),

    #[error("arrow error: {0}")]
    Arrow(#[from] arrow_schema::ArrowError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("mf4 error: {0}")]
    Mf4(#[from] mf4_rs::error::MdfError),

    #[error("mf4 channel group {group_index} has no master (time) channel")]
    MasterChannelMissing { group_index: usize },

    #[error("mp4 parse error: {0}")]
    Mp4(#[from] mp4::Error),

    #[error(
        "mp4 video track has {mp4_count} samples but sidecar has {sidecar_count} entries; \
         the sidecar must contain exactly one i64 ns timestamp per mp4 sample"
    )]
    SidecarLengthMismatch {
        mp4_count: usize,
        sidecar_count: usize,
    },

    #[error("sidecar byte length {0} is not a multiple of 8; expected a packed i64 LE array")]
    SidecarByteLengthNotMultipleOf8(usize),

    #[error(
        "mp4+sidecar MVP requires exactly one video track, found {0}; \
         see docs/05-video-pipeline.md for the sidecar format"
    )]
    Mp4VideoTrackCount(usize),

    #[error("Mp4SidecarReader requires two blobs; use Mp4SidecarReader::open_pair")]
    Mp4SidecarRequiresPair,
}

pub type Result<T> = std::result::Result<T, Error>;
