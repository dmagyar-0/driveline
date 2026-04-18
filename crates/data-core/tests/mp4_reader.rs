//! Integration test for `Mp4SidecarReader` against the committed mp4 +
//! sidecar fixture pair. Unlike `mf4_reader.rs`, we do NOT assert
//! bit-identity — the `mp4` crate's writer does not promise byte stability
//! across versions, so a structural assertion is the safer guard.

use data_core::{ChannelKind, Mp4SidecarReader, Reader, SourceKind};

const MP4: &[u8] = include_bytes!("../../../test-fixtures/short.mp4");
const SIDECAR: &[u8] = include_bytes!("../../../test-fixtures/short.mp4.ts.bin");

#[test]
fn opens_and_describes_fixture_pair() {
    let r = Mp4SidecarReader::open_pair(MP4, SIDECAR).expect("open pair");
    assert_eq!(r.meta().kind, SourceKind::Mp4Sidecar);
    assert_eq!(r.meta().channels.len(), 1);

    let ch = &r.meta().channels[0];
    assert_eq!(ch.kind, ChannelKind::Video);
    assert!(ch.dtype.is_none());
    assert_eq!(ch.sample_count, 10);

    // The sidecar generator emits `T0 + i * STEP` for i in 0..10; the
    // resulting half-open range must cover all ten samples. T0 lands
    // beyond MAX_SAFE_INTEGER on purpose (see fixtures.rs) so the JS
    // side exercises the BigInt path.
    assert!(ch.time_range.start_ns >= 1_700_000_000_000_000_000);
    assert_eq!(
        ch.time_range.end_ns - ch.time_range.start_ns,
        9 * 33_333_333 + 1
    );
    assert_eq!(r.pts_ns().len(), 10);
}

#[test]
fn sidecar_generator_is_deterministic() {
    let a = data_core::fixtures::short_sidecar_bytes();
    let b = data_core::fixtures::short_sidecar_bytes();
    assert_eq!(a, b);
    assert_eq!(a.as_slice(), SIDECAR);
}
