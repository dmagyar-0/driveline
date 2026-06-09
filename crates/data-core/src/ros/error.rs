//! Error type for the dynamic ROS message decoder.
//!
//! Kept local to the `ros` module (not wired into the crate-wide `Error`)
//! so a later integration pass can add a `#[from]` conversion without this
//! module taking a dependency on the reader layer.

use std::fmt;

/// Errors raised while parsing message definitions or walking CDR / ROS1
/// payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RosDecodeError {
    /// Malformed message-definition text.
    Parse(String),
    /// The definition is an IDL (`ros2idl` / `omgidl`) encoding, which this
    /// decoder does not parse yet.
    IdlUnsupported,
    /// A field referenced a complex type that is not in the registry.
    UnknownType(String),
    /// The requested field path does not exist in the message.
    PathNotFound(String),
    /// The payload ended before a field could be fully read.
    UnexpectedEof {
        /// Byte offset (relative to the buffer start) the read began at.
        offset: usize,
        /// Number of bytes the read needed.
        needed: usize,
        /// Bytes actually remaining.
        remaining: usize,
    },
    /// The CDR encapsulation header was missing or invalid.
    BadEncapsulation(String),
    /// A leaf was reached that is not numeric (e.g. a bare string) where a
    /// numeric value was required.
    NotNumeric(String),
    /// A string field was not valid UTF-8.
    BadUtf8(String),
}

impl fmt::Display for RosDecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RosDecodeError::Parse(m) => write!(f, "ros msgdef parse error: {m}"),
            RosDecodeError::IdlUnsupported => {
                write!(f, "ros IDL (ros2idl/omgidl) definitions are not supported yet")
            }
            RosDecodeError::UnknownType(t) => write!(f, "unknown ros type: {t}"),
            RosDecodeError::PathNotFound(p) => write!(f, "field path not found: {p}"),
            RosDecodeError::UnexpectedEof {
                offset,
                needed,
                remaining,
            } => write!(
                f,
                "unexpected end of payload at offset {offset}: needed {needed} bytes, {remaining} remaining"
            ),
            RosDecodeError::BadEncapsulation(m) => write!(f, "bad CDR encapsulation: {m}"),
            RosDecodeError::NotNumeric(p) => write!(f, "field `{p}` is not a numeric leaf"),
            RosDecodeError::BadUtf8(p) => write!(f, "field `{p}` is not valid UTF-8"),
        }
    }
}

impl std::error::Error for RosDecodeError {}
