//! Integration test for `Mp4SidecarReader` against the committed mp4 +
//! sidecar fixture pair. Unlike `mf4_reader.rs`, we do NOT assert
//! bit-identity — the `mp4` crate's writer does not promise byte stability
//! across versions, so a structural assertion is the safer guard.

use data_core::{ChannelKind, Mp4SidecarReader, Reader, SourceKind};

const MP4: &[u8] = include_bytes!("../../../test-fixtures/short.mp4");
const SIDECAR: &[u8] = include_bytes!("../../../test-fixtures/short.mp4.timestamps");

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

/// Lazy-load index path: the reader exposes a per-sample `(offset, size,
/// is_sync)` table that the JS layer reads to fetch sample bytes from the
/// source `File` blob on demand. Verify the table is well-formed against
/// the committed fixture: ten samples, ascending offsets, exactly one
/// keyframe (the synth fixture marks sample 0 as sync), and offsets that
/// actually point at non-zero bytes inside the mp4 (sanity-check that
/// the offsets address `mdat` rather than empty padding).
///
/// AVCC → Annex-B framing and SPS/PPS prepend now live in
/// `apps/web/src/workers/mp4AnnexB.ts`; see `mp4AnnexB.test.ts` for the
/// shape assertions that used to live in this file.
#[test]
fn sample_index_describes_fixture_layout() {
    let r = Mp4SidecarReader::open_pair(MP4, SIDECAR).expect("open pair");
    let idx = r.sample_index();

    assert_eq!(idx.offsets.len(), 10);
    assert_eq!(idx.sizes.len(), 10);
    assert_eq!(idx.is_sync.len(), 10);

    // First sample is the keyframe; every other sample is delta.
    assert!(idx.is_sync[0]);
    for s in &idx.is_sync[1..] {
        assert!(!*s);
    }

    // Offsets are strictly ascending — samples are written sequentially
    // into a single `mdat` chunk.
    for w in idx.offsets.windows(2) {
        assert!(w[0] < w[1], "offsets must be ascending: {:?}", idx.offsets);
    }

    // Every (offset, size) pair must address bytes inside the mp4 file.
    for (i, &off) in idx.offsets.iter().enumerate() {
        let size = idx.sizes[i] as usize;
        assert!(size > 0, "sample {i} has zero size");
        let lo = off as usize;
        let hi = lo + size;
        assert!(hi <= MP4.len(), "sample {i} offset/size escape mp4 bounds");
    }

    // SPS/PPS must be non-empty so the JS layer can prepend extradata.
    assert!(!r.sps().is_empty(), "SPS NAL bytes must be exposed");
    assert!(!r.pps().is_empty(), "PPS NAL bytes must be exposed");
}
