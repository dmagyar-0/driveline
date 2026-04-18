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
