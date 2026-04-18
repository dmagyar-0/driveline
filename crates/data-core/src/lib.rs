//! Portable reader core for driveline. Native-only (no wasm-bindgen).
//!
//! M1 provides the `Reader` trait skeleton and a `NoopReader`; real MCAP /
//! MF4 readers land in M2.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported channel kind for this reader")]
    UnsupportedKind,

    #[error("arrow error: {0}")]
    Arrow(#[from] arrow_schema::ArrowError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
