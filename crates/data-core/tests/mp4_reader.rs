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

/// T5.3: `video_stream` must yield one Annex-B access unit per mp4 sample,
/// with the first chunk carrying inline SPS + PPS so the video-decode
/// worker's codec-string probe works without the mp4's avcC extradata.
#[test]
fn video_stream_yields_annex_b_chunks_from_fixture() {
    let r = Mp4SidecarReader::open_pair(MP4, SIDECAR).expect("open pair");
    let ch_id = r.meta().channels[0].id.clone();

    let chunks: Vec<_> = r
        .video_stream(&ch_id, i64::MIN)
        .expect("video_stream")
        .collect();
    assert_eq!(chunks.len(), 10);

    for c in &chunks {
        assert_eq!(
            &c.data[..4],
            &[0x00, 0x00, 0x00, 0x01],
            "chunk must start with Annex-B start code",
        );
    }

    // Timestamps must strictly increase, matching the sidecar.
    let mut prev = i64::MIN;
    for c in &chunks {
        assert!(c.pts_ns > prev, "ptss must strictly increase");
        prev = c.pts_ns;
    }

    // First chunk contains SPS (NAL 7) and PPS (NAL 8). Scan for start
    // code + (header & 0x1f).
    let first = &chunks[0].data;
    let mut has_sps = false;
    let mut has_pps = false;
    let mut i = 0;
    while i + 4 < first.len() {
        if first[i..i + 4] == [0x00, 0x00, 0x00, 0x01] {
            let header = first[i + 4];
            match header & 0x1f {
                7 => has_sps = true,
                8 => has_pps = true,
                _ => {}
            }
            i += 4;
        } else {
            i += 1;
        }
    }
    assert!(has_sps, "first chunk missing SPS (NAL 7)");
    assert!(has_pps, "first chunk missing PPS (NAL 8)");
    assert!(chunks[0].is_keyframe);
}
