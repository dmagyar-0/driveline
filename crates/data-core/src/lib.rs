//! Portable reader core for driveline. Native-only (no wasm-bindgen).
//!
//! M2 introduces the three concrete `Reader` implementations: `Mf4Reader`
//! on top of `mf4-rs`, `McapReader` on top of the `mcap` crate, and
//! `Mp4SidecarReader` for mp4 + `.mp4.timestamps` sidecar pairs.

pub mod fixtures;
pub mod mcap;
pub mod mf4;
pub mod mp4_sidecar;
pub mod noop;
pub mod reader;
pub mod types;

pub use mcap::McapReader;
pub use mf4::Mf4Reader;
pub use mp4_sidecar::{Mp4SampleIndex, Mp4SidecarReader};
pub use reader::{ArrowIpc, EncodedChunkIter, Reader};
pub use types::{
    Channel, ChannelId, ChannelKind, DType, EncodedChunk, FetchOpts, SourceId, SourceKind,
    SourceMeta, TimeRange,
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

    #[error("mcap error: {0}")]
    Mcap(#[from] ::mcap::McapError),

    #[error("mcap file has no summary section")]
    McapMissingSummary,

    #[error("mp4 parse error: {0}")]
    Mp4(#[from] mp4::Error),

    #[error(
        "mp4 video track has {mp4_count} samples but sidecar has {sidecar_count} entries; \
         the sidecar must contain exactly one `frame\\ttimestamp_ns` line per mp4 sample"
    )]
    SidecarLengthMismatch {
        mp4_count: usize,
        sidecar_count: usize,
    },

    #[error("sidecar is not valid UTF-8: {0}")]
    SidecarNotUtf8(#[from] std::str::Utf8Error),

    #[error("sidecar line {line_no}: {reason}")]
    SidecarMalformedLine { line_no: usize, reason: String },

    #[error(
        "mp4+sidecar MVP requires exactly one video track, found {0}; \
         see docs/05-video-pipeline.md for the sidecar format"
    )]
    Mp4VideoTrackCount(usize),

    #[error("Mp4SidecarReader requires two blobs; use Mp4SidecarReader::open_pair")]
    Mp4SidecarRequiresPair,
}

pub type Result<T> = std::result::Result<T, Error>;
