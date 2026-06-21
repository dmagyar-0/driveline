//! The `Reader` trait is the single seam between format adapters (MCAP, MF4,
//! mp4+sidecar) and everything downstream.
//!
//! See `docs/04-reader-abstraction.md` for the contract. For M1 the trait is
//! simplified: `open` takes an in-memory slice; `video_stream` is not present
//! yet because no `Video` channels are produced in this milestone.

use crate::types::{EncodedChunk, FetchOpts, SourceMeta, TimeRange};

/// A freshly-serialised Arrow IPC (File format) byte payload, ready to
/// `postMessage` to the main thread as a `Transferable`.
pub type ArrowIpc = Vec<u8>;

/// Owning iterator of encoded video access units produced by
/// `Reader::video_stream`. Boxed so the worker-facing handle table can
/// store heterogeneous readers behind a single trait object.
pub type EncodedChunkIter = Box<dyn Iterator<Item = EncodedChunk> + Send>;

/// The single seam between format adapters and downstream consumers.
///
/// Not `Send`: the MCAP and MF4 adapters hold `Rc`/`RefCell`-based caches and a
/// non-`Send` byte-range source, and the only multi-threaded boundary
/// (the browser worker) keeps readers in a thread-local slab and never moves
/// them across threads. The video iterator that *does* cross a boundary carries
/// its own `Send` bound on [`EncodedChunkIter`].
pub trait Reader {
    fn open(bytes: &[u8]) -> crate::Result<Self>
    where
        Self: Sized;

    fn meta(&self) -> &SourceMeta;

    fn fetch_range(
        &self,
        channel_id: &str,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc>;

    /// Return an iterator over the Annex-B access units of the video
    /// channel `channel_id`, starting at the largest keyframe whose PTS is
    /// `<= from_pts_ns`. If no such keyframe exists, the iterator starts at
    /// the first keyframe. Readers that do not produce video channels
    /// return `Err(UnsupportedKind)`.
    fn video_stream(&self, channel_id: &str, from_pts_ns: i64) -> crate::Result<EncodedChunkIter> {
        let _ = (channel_id, from_pts_ns);
        Err(crate::Error::UnsupportedKind)
    }
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
