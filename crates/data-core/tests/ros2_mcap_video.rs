//! Integration test for ROS2 (CDR) H.264 video in `McapReader`.
//!
//! Exercises the committed fixture `test-fixtures/ros/video_h264.mcap`: one
//! topic `/camera/video` of `foxglove_msgs/msg/CompressedVideo` (CDR, ros2msg),
//! 20 messages of 128x96 H.264, 100ms apart. The reader must surface it as a
//! single `Video` channel (NOT numeric-expanded) and stream the compressed
//! Annex-B bytes pulled out of each CDR message's top-level `data` field.

use std::path::PathBuf;

use data_core::types::ChannelKind;
use data_core::McapReader;

fn fixture(name: &str) -> Vec<u8> {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../test-fixtures/ros");
    p.push(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read fixture {}: {e}", p.display()))
}

/// Index of the first byte after the next Annex-B start code at/after `from`.
fn start_code_end(data: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                return Some(i + 3);
            }
            if i + 3 < data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                return Some(i + 4);
            }
        }
        i += 1;
    }
    None
}

/// Collect the set of NAL unit types present in an Annex-B access unit.
fn nal_types(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(sc_end) = start_code_end(data, i) {
        if sc_end >= data.len() {
            break;
        }
        out.push(data[sc_end] & 0x1F);
        i = sc_end + 1;
    }
    out
}

#[test]
fn ros2_cdr_h264_video_surfaces_as_single_video_channel() {
    let bytes = fixture("video_h264.mcap");
    let r = McapReader::open(&bytes).expect("open video_h264.mcap");

    // Exactly one channel, and it is Video — NOT numeric-expanded into
    // `/camera/video.data` or similar.
    let chans = &r.meta().channels;
    assert_eq!(
        chans.len(),
        1,
        "expected exactly one channel, got {:?}",
        chans.iter().map(|c| c.id.as_str()).collect::<Vec<_>>()
    );
    let ch = &chans[0];
    assert_eq!(ch.kind, ChannelKind::Video, "channel must be Video");
    assert_eq!(ch.id, "/camera/video");
    assert!(
        !ch.id.contains(".data"),
        "CDR video must not be numeric-expanded, got id {:?}",
        ch.id
    );

    // Stream from the very start: 20 access units, ascending pts, 100ms apart.
    let channel_id = ch.id.clone();
    let chunks: Vec<_> = r
        .video_stream(&channel_id, i64::MIN)
        .expect("video_stream")
        .collect();
    assert_eq!(chunks.len(), 20, "expected 20 encoded access units");

    // First access unit is a keyframe: starts with a 4-byte Annex-B start code
    // and carries SPS (type 7) and IDR (type 5).
    let first = &chunks[0];
    assert!(first.is_keyframe, "first chunk must be a keyframe");
    assert_eq!(
        &first.data[..4],
        &[0x00, 0x00, 0x00, 0x01],
        "first chunk must start with a 4-byte Annex-B start code"
    );
    let types = nal_types(&first.data);
    assert!(
        types.contains(&7),
        "first AU must contain SPS (7): {types:?}"
    );
    assert!(
        types.contains(&5),
        "first AU must contain IDR (5): {types:?}"
    );

    // pts ascending, 100ms (1e8 ns) spacing.
    for w in chunks.windows(2) {
        assert!(w[1].pts_ns > w[0].pts_ns, "pts must be ascending");
        assert_eq!(
            w[1].pts_ns - w[0].pts_ns,
            100_000_000,
            "frames are 100ms apart"
        );
    }
}
