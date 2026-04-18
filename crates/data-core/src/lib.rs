//! Portable reader core for driveline. Native-only (no wasm-bindgen).
//!
//! M2 introduces the first concrete `Reader` implementations: `Mf4Reader`
//! on top of `mf4-rs`, and `McapReader` on top of the `mcap` crate.
//! mp4+sidecar (T2.3) lands in a follow-up milestone.

pub mod fixtures;
pub mod mcap;
pub mod mf4;
pub mod noop;
pub mod reader;
pub mod types;

pub use mcap::McapReader;
pub use mf4::Mf4Reader;
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

    #[error("mcap error: {0}")]
    Mcap(#[from] ::mcap::McapError),

    #[error("mcap file has no summary section")]
    McapMissingSummary,
}

pub type Result<T> = std::result::Result<T, Error>;
