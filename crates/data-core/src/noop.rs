//! Wiring-only reader. Used by the worker plumbing tests and as a sanity
//! check that the trait compiles end-to-end.

use crate::reader::{ArrowIpc, Reader};
use crate::types::{ChannelId, FetchOpts, SourceMeta, TimeRange};

pub struct NoopReader {
    meta: SourceMeta,
}

impl Reader for NoopReader {
    fn open(_bytes: &[u8]) -> crate::Result<Self> {
        Ok(Self { meta: SourceMeta::empty() })
    }

    fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    fn fetch_range(
        &self,
        _channel_id: &ChannelId,
        _range: TimeRange,
        _opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_has_zero_channels_and_empty_range() {
        let r = NoopReader::open(&[]).unwrap();
        assert!(r.meta().channels.is_empty());
        assert_eq!(r.meta().time_range.start_ns, 0);
        assert_eq!(r.meta().time_range.end_ns, 0);
        assert!(r.meta().time_range.is_empty());
    }

    #[test]
    fn noop_fetch_range_returns_empty() {
        let r = NoopReader::open(&[]).unwrap();
        let out = r
            .fetch_range(&"any".to_string(), TimeRange::empty(), FetchOpts::default())
            .unwrap();
        assert!(out.is_empty());
    }
}
