//! MCAP container parsing: the summary section, record framing, and chunk
//! decompression.
//!
//! This is the lowest layer of the MCAP reader — everything here works on raw
//! bytes and the `mcap` crate's sans-IO primitives, with no knowledge of
//! Driveline channel kinds, ROS2 CDR, or video. [`super::McapReader`] drives
//! these helpers: [`read_summary`] at open, then [`read_segment_bytes`] +
//! [`for_each_message`] to walk a chunk's records on demand.

use std::io::SeekFrom;

use mcap::sans_io::summary_reader::{SummaryReadEvent, SummaryReader, SummaryReaderOptions};
use mcap::McapError;
use mf4_rs::index::ByteRangeReader;

use crate::mf4::BoxedRangeReader;

use super::Segment;

/// MCAP file magic — opens and closes every well-formed file.
pub(super) const MCAP_MAGIC: &[u8] = b"\x89MCAP0\r\n";

/// Bytes occupied by the footer record plus the trailing end magic:
/// 1 opcode + 8 length + 8 summary_start + 8 summary_offset_start +
/// 4 summary_crc + 8 end magic.
pub(super) const FOOTER_AND_END_MAGIC: u64 = 1 + 8 + 8 + 8 + 4 + 8;

/// Serialized length of an MCAP `MessageHeader`: channel_id(2) + sequence(4) +
/// log_time(8) + publish_time(8).
pub(super) const MESSAGE_HEADER_LEN: usize = 2 + 4 + 8 + 8;

/// Drive the sans-IO [`SummaryReader`] over `reader` to pull the summary
/// section. `file_size` is supplied so the reader seeks directly to the footer
/// rather than relying on a seek-to-end probe.
pub(super) fn read_summary(
    reader: &mut BoxedRangeReader,
    file_size: u64,
) -> crate::Result<mcap::Summary> {
    let mut sr =
        SummaryReader::new_with_options(SummaryReaderOptions::default().with_file_size(file_size));
    let mut pos: u64 = 0;
    while let Some(event) = sr.next_event() {
        match event? {
            SummaryReadEvent::SeekRequest(to) => {
                pos = match to {
                    SeekFrom::Start(p) => p,
                    SeekFrom::End(e) => (file_size as i64 + e).max(0) as u64,
                    SeekFrom::Current(c) => (pos as i64 + c).max(0) as u64,
                };
                sr.notify_seeked(pos);
            }
            SummaryReadEvent::ReadRequest(n) => {
                let want = (n as u64).min(file_size.saturating_sub(pos));
                if want == 0 {
                    sr.notify_read(0);
                    continue;
                }
                let bytes = reader.read_range(pos, want)?;
                let dst = sr.insert(want as usize);
                dst[..bytes.len()].copy_from_slice(&bytes);
                sr.notify_read(bytes.len());
                pos += bytes.len() as u64;
            }
        }
    }
    sr.finish().ok_or(crate::Error::McapMissingSummary)
}

/// Little-endian `u64` from `buf[at..at+8]`, or `None` if the slice is too
/// short. Replaces `buf[a..b].try_into().expect("8-byte slice")` so a malformed
/// record yields a clean skip rather than a panic.
pub(super) fn read_u64_le(buf: &[u8], at: usize) -> Option<u64> {
    buf.get(at..at + 8)
        .and_then(|s| <[u8; 8]>::try_from(s).ok())
        .map(u64::from_le_bytes)
}

/// Read the footer at the tail of the file and return its `summary_start`
/// offset. Only used for unchunked files (to bound the data section).
pub(super) fn read_footer_summary_start(
    reader: &mut BoxedRangeReader,
    file_size: u64,
) -> crate::Result<u64> {
    if file_size < FOOTER_AND_END_MAGIC {
        return Err(crate::Error::McapMissingSummary);
    }
    let buf = reader.read_range(file_size - FOOTER_AND_END_MAGIC, FOOTER_AND_END_MAGIC)?;
    // [op:1][len:8][summary_start:8][summary_offset_start:8][crc:4][magic:8]
    read_u64_le(&buf, 9).ok_or(crate::Error::McapMissingSummary)
}

/// Read a segment's bytes through `reader` and decompress them.
pub(super) fn read_segment_bytes(
    reader: &mut BoxedRangeReader,
    seg: &Segment,
) -> crate::Result<Vec<u8>> {
    if seg.compressed_size == 0 {
        return Ok(Vec::new());
    }
    let comp = reader.read_range(seg.data_offset, seg.compressed_size)?;
    decompress_records(&seg.compression, comp, seg.uncompressed_size as usize)
}

/// Decompress a chunk's record stream. zstd uses the pure-Rust `ruzstd`
/// decoder so the wasm build needs no C `zstd-sys`.
pub(super) fn decompress_records(
    compression: &str,
    compressed: Vec<u8>,
    uncompressed_size: usize,
) -> crate::Result<Vec<u8>> {
    match compression {
        "" => Ok(compressed),
        "zstd" => {
            use std::io::Read;
            let mut decoder =
                ruzstd::StreamingDecoder::new(compressed.as_slice()).map_err(|e| {
                    crate::Error::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("ruzstd init failed: {e:?}"),
                    ))
                })?;
            let mut out = Vec::with_capacity(uncompressed_size.max(compressed.len()));
            decoder.read_to_end(&mut out)?;
            Ok(out)
        }
        other => Err(crate::Error::Mcap(McapError::UnsupportedCompression(
            other.to_string(),
        ))),
    }
}

/// Walk a decompressed record stream, invoking `f(channel_id, log_time,
/// payload)` for every `Message` record. Non-message records are skipped; a
/// `DataEnd` record or a truncated tail stops the walk.
pub(super) fn for_each_message(buf: &[u8], mut f: impl FnMut(u16, i64, &[u8])) {
    use mcap::records::op;
    let mut off = 0usize;
    while off + 9 <= buf.len() {
        let opcode = buf[off];
        let Some(len) = read_u64_le(buf, off + 1).map(|v| v as usize) else {
            break;
        };
        let body_start = off + 9;
        let Some(body_end) = body_start.checked_add(len) else {
            break;
        };
        if body_end > buf.len() {
            break;
        }
        if opcode == op::DATA_END {
            break;
        }
        if opcode == op::MESSAGE {
            let body = &buf[body_start..body_end];
            if body.len() >= MESSAGE_HEADER_LEN {
                let channel_id = u16::from_le_bytes([body[0], body[1]]);
                // `body` is >= MESSAGE_HEADER_LEN (>= 14), so the 8-byte read at
                // offset 6 is always in bounds; default to 0 defensively.
                let log_time = read_u64_le(body, 6).unwrap_or(0) as i64;
                f(channel_id, log_time, &body[MESSAGE_HEADER_LEN..]);
            }
        }
        off = body_end;
    }
}
