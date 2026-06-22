//! NAL / Annex-B video frame scanning for MCAP video channels.
//!
//! [`super::McapReader::decode_video_samples`] pulls the compressed bytes out of
//! each message (either a Foxglove-JSON base64 envelope via
//! [`extract_video_bytes_from_json`], or a ROS2 CDR `data` field) and then asks
//! [`is_keyframe`] whether the resulting Annex-B access unit begins an
//! independently-decodable picture. None of this touches the MCAP container —
//! it's pure byte scanning over an H.264 Annex-B stream.

use base64::Engine as _;

/// Decode the base64 `data` field out of a Foxglove `CompressedVideo` JSON
/// envelope, returning the raw Annex-B bytes. Falls back to `None` so the
/// caller can treat the payload as already-raw bytes.
pub(super) fn extract_video_bytes_from_json(data: &[u8]) -> Option<Vec<u8>> {
    let v: serde_json::Value = serde_json::from_slice(data).ok()?;
    let b64 = v.get("data")?.as_str()?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// True if the given Annex-B byte stream is a keyframe (contains IDR or
/// SPS before any non-IDR VCL slice). NAL type is the low 5 bits of the
/// first byte after each start code.
pub(super) fn is_keyframe(annex_b: &[u8]) -> bool {
    let mut i = 0;
    while i < annex_b.len() {
        let Some(sc_end) = find_start_code(annex_b, i) else {
            break;
        };
        if sc_end >= annex_b.len() {
            break;
        }
        let nal_type = annex_b[sc_end] & 0x1F;
        match nal_type {
            5 | 7 => return true,  // IDR slice or SPS
            1..=4 => return false, // Non-IDR VCL slice
            _ => {}                // AUD (9), PPS (8), SEI (6), etc. — keep scanning.
        }
        i = sc_end + 1;
    }
    false
}

/// Returns the index of the first byte AFTER a start code, searching from
/// `from`. Handles both 3-byte (`00 00 01`) and 4-byte (`00 00 00 01`) codes.
fn find_start_code(data: &[u8], from: usize) -> Option<usize> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_keyframe_detects_idr_and_sps() {
        // Annex-B: 4-byte start code + SPS header byte (0x67 = NAL type 7).
        assert!(is_keyframe(&[0x00, 0x00, 0x00, 0x01, 0x67, 0xff]));
        // 3-byte start code + IDR header (0x65 = NAL type 5).
        assert!(is_keyframe(&[0x00, 0x00, 0x01, 0x65, 0xde, 0xad]));
        // AUD (type 9) then IDR.
        assert!(is_keyframe(&[
            0x00, 0x00, 0x00, 0x01, 0x09, 0x10, 0x00, 0x00, 0x00, 0x01, 0x65
        ]));
        // Non-IDR VCL slice header (type 1): not a keyframe.
        assert!(!is_keyframe(&[0x00, 0x00, 0x00, 0x01, 0x41, 0xaa]));
    }
}
