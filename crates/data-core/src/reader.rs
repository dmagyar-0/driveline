//! The `Reader` trait is the single seam between format adapters (MCAP, MF4,
//! mp4+sidecar) and everything downstream.
//!
//! See `docs/04-reader-abstraction.md` for the contract. For M1 the trait is
//! simplified: `open` takes an in-memory slice; `video_stream` is not present
//! yet because no `Video` channels are produced in this milestone.

use crate::types::{ChannelId, FetchOpts, SourceMeta, TimeRange};

/// A freshly-serialised Arrow IPC (File format) byte payload, ready to
/// `postMessage` to the main thread as a `Transferable`.
pub type ArrowIpc = Vec<u8>;

pub trait Reader: Send {
    fn open(bytes: &[u8]) -> crate::Result<Self>
    where
        Self: Sized;

    fn meta(&self) -> &SourceMeta;

    fn fetch_range(
        &self,
        channel_id: &ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc>;
}

#[cfg(test)]
mod tests {
    use crate::mcap::infer_channel_kind;
    use crate::types::{ChannelKind, DType};

    /// Corresponds to `docs/09-verification-plan.md:66` —
    /// `reader::tests::infers_channel_kind_from_schema`.
    #[test]
    fn infers_channel_kind_from_schema() {
        assert_eq!(
            infer_channel_kind("foxglove.CompressedVideo", "jsonschema"),
            (ChannelKind::Video, None)
        );
        assert_eq!(
            infer_channel_kind("foxglove.Float64", "jsonschema"),
            (ChannelKind::Scalar, Some(DType::F64))
        );
        assert_eq!(
            infer_channel_kind("foxglove.Float32", "jsonschema"),
            (ChannelKind::Scalar, Some(DType::F32))
        );
        assert_eq!(
            infer_channel_kind("foxglove.Vector3", "jsonschema"),
            (ChannelKind::Vector, Some(DType::F64))
        );
        assert_eq!(
            infer_channel_kind("driveline.ControlMode", "jsonschema"),
            (ChannelKind::Enum, Some(DType::I32))
        );
        assert_eq!(
            infer_channel_kind("some.Unknown", "jsonschema"),
            (ChannelKind::Bytes, None)
        );
        // Protobuf video name heuristic.
        assert_eq!(
            infer_channel_kind("foxglove_msgs/ImageCompressed", "protobuf"),
            (ChannelKind::Video, None)
        );
        assert_eq!(
            infer_channel_kind("ros.H264Packet", "protobuf"),
            (ChannelKind::Video, None)
        );
    }
}
