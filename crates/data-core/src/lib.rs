//! Portable reader core for driveline. Native-only (no wasm-bindgen).
//!
//! M1 provides the `Reader` trait skeleton and a `NoopReader`; real MCAP /
//! MF4 readers land in M2.

pub mod noop;
pub mod reader;
pub mod types;

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
}

pub type Result<T> = std::result::Result<T, Error>;
