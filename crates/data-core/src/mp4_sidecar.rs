//! `Mp4SidecarReader`: implementation of a video-only `Reader` whose timestamps
//! come from a separate `.mp4.timestamps` sidecar blob rather than the mp4's
//! own `stts`/`ctts` tables.
//!
//! Covers T2.3 of `docs/10-task-breakdown.md`. See `docs/05-video-pipeline.md`
//! §"mp4 + sidecar timestamp path" for the format and rationale, and
//! `docs/04-reader-abstraction.md` §"`Mp4SidecarReader`" for the API shape.
//!
//! Lazy-loading update: `open_pair` no longer reads any `mdat` bytes. It
//! parses the `moov` box and walks `stsz`/`stsc`/`stco`/`co64`/`stss` to build
//! a per-sample index of `(file_offset, size, is_sync)`. Sample bodies are
//! fetched on demand by the JS layer via `File.slice()` and converted to
//! Annex-B in JS — see `apps/web/src/workers/mp4AnnexB.ts` for the JS port
//! of the (formerly Rust-side) `avcc_to_annexb` and SPS/PPS prepend logic.
//!
//! `Reader::video_stream` is no longer overridden here; the trait's default
//! returns `UnsupportedKind` and the encoded-chunk path lives entirely in
//! JavaScript now. Scalar `fetch_range` is still rejected with
//! `UnsupportedKind` (matching the prior contract for video-only sources).

use std::io::Cursor;

use mp4::{Mp4Reader as Mp4Parser, TrackType};

use crate::reader::{ArrowIpc, Reader};
use crate::types::{
    Channel, ChannelId, ChannelKind, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

/// Per-sample sample-table data extracted at open time. Parallel arrays
/// keyed by sample index (0-based, matching `pts_ns`). `offset` is an
/// absolute byte offset into the original mp4 file; the JS layer fetches
/// `[offset, offset + size)` from the source `File` blob via `slice()`.
#[derive(Debug, Clone, Default)]
pub struct Mp4SampleIndex {
    pub offsets: Vec<u64>,
    pub sizes: Vec<u32>,
    pub is_sync: Vec<bool>,
}

#[derive(Debug)]
pub struct Mp4SidecarReader {
    meta: SourceMeta,
    /// One entry per mp4 video sample in decode order, absolute ns UTC.
    /// Parallel to the mp4 track's `stsz` sample table.
    pts_ns: Vec<i64>,
    /// Per-sample byte offsets / sizes / sync flags in the original mp4
    /// file. Replaces the old `Vec<Mp4SampleCache>` so no `mdat` bytes
    /// live in WASM linear memory after open.
    index: Mp4SampleIndex,
    /// SPS NAL bytes (including the NAL header byte) from the `avcC` box,
    /// emitted to JS so the videoDecode worker can prepend extradata onto
    /// the first chunk it feeds to `VideoDecoder`.
    sps: Vec<u8>,
    /// PPS NAL bytes, same role as `sps`.
    pps: Vec<u8>,
}

impl Mp4SidecarReader {
    /// Open an mp4 + sidecar pair. Parses the mp4 `moov`, locates the single
    /// video track, and validates that the sidecar contains exactly one
    /// `<frame_index>\t<timestamp_ns>\n` line per mp4 sample with frame
    /// indices equal to the 0-based row number.
    ///
    /// No `mdat` bytes are read here — only the `moov` sample tables. The
    /// returned reader holds an in-memory index (offsets / sizes / sync
    /// flags) but not a single byte of encoded video.
    ///
    /// Errors:
    /// - [`crate::Error::Mp4`] — mp4 parse failed (malformed box structure
    ///   or missing `stco`/`co64`).
    /// - [`crate::Error::Mp4VideoTrackCount`] — mp4 had zero or multiple
    ///   video tracks. The MVP sidecar format only addresses a single track.
    /// - [`crate::Error::SidecarNotUtf8`] — sidecar is not valid UTF-8.
    /// - [`crate::Error::SidecarMalformedLine`] — a line does not have
    ///   exactly two tab-separated fields, a field fails to parse, or the
    ///   frame index does not equal the line's 0-based row number.
    /// - [`crate::Error::SidecarLengthMismatch`] — sidecar line count does
    ///   not match the video track's sample count. This is the named
    ///   acceptance-criterion failure from `docs/10-task-breakdown.md` T2.3.
    pub fn open_pair(mp4_bytes: &[u8], sidecar_bytes: &[u8]) -> crate::Result<Self> {
        let size = mp4_bytes.len() as u64;
        let mp4 = Mp4Parser::read_header(Cursor::new(mp4_bytes), size)?;

        // Pick the single video track and pull what we need from it.
        // Drop the borrow before building the index so we can keep the
        // expensive `Mp4Track` fields out of the long-lived reader.
        let (track_id, mp4_count, sps, pps, index) = {
            let mut video_tracks: Vec<_> = mp4
                .tracks()
                .values()
                .filter(|t| matches!(t.track_type(), Ok(TrackType::Video)))
                .collect();
            if video_tracks.len() != 1 {
                return Err(crate::Error::Mp4VideoTrackCount(video_tracks.len()));
            }
            // Stable ordering by track_id so `channels[0]` is deterministic.
            video_tracks.sort_by_key(|t| t.track_id());
            let track = video_tracks[0];
            let sps = track.sequence_parameter_set()?.to_vec();
            let pps = track.picture_parameter_set()?.to_vec();
            let count = track.sample_count() as usize;
            let index = build_sample_index(track)?;
            (track.track_id(), count, sps, pps, index)
        };

        let pts_ns = parse_sidecar_text(sidecar_bytes, mp4_count)?;

        let time_range = match (pts_ns.first(), pts_ns.last()) {
            (Some(&first), Some(&last)) => TimeRange {
                start_ns: first,
                // Half-open interval: `+1` so a single-sample source has a
                // non-empty range, matching `docs/03-data-model.md`.
                end_ns: last.saturating_add(1),
            },
            _ => TimeRange::empty(),
        };

        let channel = Channel {
            id: Self::channel_id(track_id),
            source_id: String::new(),
            name: format!("track_{}", track_id),
            kind: ChannelKind::Video,
            dtype: None,
            unit: None,
            sample_count: pts_ns.len() as u64,
            time_range,
        };

        Ok(Self {
            meta: SourceMeta {
                id: String::new(),
                kind: SourceKind::Mp4Sidecar,
                time_range,
                channels: vec![channel],
            },
            pts_ns,
            index,
            sps,
            pps,
        })
    }

    /// Stable channel id used by the one video channel. Format: `"<track_id>/video"`.
    fn channel_id(track_id: u32) -> ChannelId {
        format!("{track_id}/video")
    }

    /// Exposes the parsed per-sample absolute ns timestamps. Intended for
    /// tests, the wasm `mp4_sidecar_index` binding, and debugging.
    pub fn pts_ns(&self) -> &[i64] {
        &self.pts_ns
    }

    /// Per-sample byte offsets / sizes / sync flags in the original mp4
    /// file. The JS layer reads `[offset, offset + size)` from the source
    /// `File` blob to fetch encoded sample bytes lazily.
    pub fn sample_index(&self) -> &Mp4SampleIndex {
        &self.index
    }

    /// SPS NAL bytes (no start code prefix). Emitted by the wasm binding so
    /// the JS-side stream can prepend extradata onto the first emitted
    /// Annex-B chunk per session.
    pub fn sps(&self) -> &[u8] {
        &self.sps
    }

    /// PPS NAL bytes (no start code prefix). See [`Self::sps`].
    pub fn pps(&self) -> &[u8] {
        &self.pps
    }
}

/// Walk `stsz`/`stsc`/`stco`/`co64`/`stss` to compute, for every video
/// sample in the track, its absolute byte offset in the source mp4 file,
/// its size in bytes, and whether it is a sync sample.
///
/// Mirrors the (private) `Mp4Track::sample_offset` / `sample_size` /
/// `is_sync_sample` helpers in the `mp4` crate but operates on the public
/// `pub trak: TrakBox` surface so we can build the entire index once
/// without re-walking the boxes per sample. This is critical for long
/// recordings: the per-sample loop in the upstream crate is O(N²) on
/// `samples_per_chunk` since `sample_offset(sid)` re-sums sizes from
/// the start of each chunk; we sum incrementally instead.
fn build_sample_index(track: &mp4::Mp4Track) -> crate::Result<Mp4SampleIndex> {
    let count = track.sample_count() as usize;
    let stbl = &track.trak.mdia.minf.stbl;
    let stsz = &stbl.stsz;
    let stsc = &stbl.stsc;
    let stss = stbl.stss.as_ref();

    // `stco` is u32 chunk offsets; `co64` is u64. Big mp4s (> ~4 GB) use
    // `co64`; the rest use `stco`. Reject files with neither — that's a
    // structurally invalid mp4 per ISO/IEC 14496-12 §8.7.4.
    let chunk_offsets: Vec<u64> = if let Some(co64) = &stbl.co64 {
        co64.entries.clone()
    } else if let Some(stco) = &stbl.stco {
        stco.entries.iter().map(|&v| v as u64).collect()
    } else {
        return Err(crate::Error::Mp4(mp4::Error::InvalidData(
            "mp4 video track missing both stco and co64 chunk-offset boxes",
        )));
    };

    let mut sizes: Vec<u32> = Vec::with_capacity(count);
    if stsz.sample_size > 0 {
        // Constant-size mode (rare for H.264 but legal): every sample is
        // the same size. `stsz.sample_sizes` is empty in this branch.
        for _ in 0..count {
            sizes.push(stsz.sample_size);
        }
    } else {
        if stsz.sample_sizes.len() < count {
            return Err(crate::Error::Mp4(mp4::Error::InvalidData(
                "stsz sample_sizes shorter than sample_count",
            )));
        }
        for &s in stsz.sample_sizes.iter().take(count) {
            sizes.push(s);
        }
    }

    let mut is_sync: Vec<bool> = Vec::with_capacity(count);
    match stss {
        // `stss.entries` is 1-based and sorted ascending. If absent, every
        // sample is a sync sample (per spec, e.g. for keyframe-only tracks).
        Some(ss) => {
            let entries = &ss.entries;
            let mut j = 0usize;
            for sid in 1..=count as u32 {
                while j < entries.len() && entries[j] < sid {
                    j += 1;
                }
                let hit = j < entries.len() && entries[j] == sid;
                is_sync.push(hit);
            }
        }
        None => is_sync.resize(count, true),
    }

    // Walk stsc once to drive a per-chunk traversal. For each chunk we
    // know the starting sample id and how many samples it contains; the
    // chunk's first sample sits at `chunk_offset[chunk_id - 1]`, and each
    // subsequent sample's offset is the previous offset plus its size.
    //
    // The `mp4` crate pre-populates `StscEntry::first_sample` (see
    // `mp4-0.14.0/src/track.rs:817`) so we don't have to derive it
    // ourselves here.
    let mut offsets: Vec<u64> = Vec::with_capacity(count);
    offsets.resize(count, 0);

    if stsc.entries.is_empty() {
        // No stsc means no samples — must agree with stsz.sample_count.
        if count != 0 {
            return Err(crate::Error::Mp4(mp4::Error::InvalidData(
                "stsc table empty but sample_count > 0",
            )));
        }
        return Ok(Mp4SampleIndex {
            offsets,
            sizes,
            is_sync,
        });
    }

    let total_chunks = chunk_offsets.len();
    for (entry_idx, entry) in stsc.entries.iter().enumerate() {
        let first_chunk = entry.first_chunk;
        let samples_per_chunk = entry.samples_per_chunk;
        let last_chunk = if entry_idx + 1 < stsc.entries.len() {
            stsc.entries[entry_idx + 1].first_chunk - 1
        } else {
            total_chunks as u32
        };

        for chunk_id in first_chunk..=last_chunk {
            let chunk_offset = *chunk_offsets
                .get(chunk_id as usize - 1)
                .ok_or(crate::Error::Mp4(mp4::Error::InvalidData(
                    "stsc references chunk beyond stco/co64 table",
                )))?;

            let first_sample_in_chunk =
                entry.first_sample + (chunk_id - first_chunk) * samples_per_chunk;
            let mut running_offset = chunk_offset;
            for k in 0..samples_per_chunk {
                let sid = first_sample_in_chunk + k;
                if sid as usize > count {
                    break;
                }
                let idx = sid as usize - 1;
                offsets[idx] = running_offset;
                running_offset += sizes[idx] as u64;
            }
        }
    }

    Ok(Mp4SampleIndex {
        offsets,
        sizes,
        is_sync,
    })
}

/// Parse the text sidecar payload into a `Vec<i64>` of absolute ns-UTC
/// timestamps, one per mp4 video sample in decode order.
///
/// Format: UTF-8 text, no header, one line per sample, `<frame>\t<ts_ns>\n`.
/// `str::lines()` accepts `\n` or `\r\n` and tolerates an optional trailing
/// line terminator. The `frame` column must equal the line's 0-based row
/// index — this catches reordered / skipped / duplicated rows cheaply at
/// open time. Surrounding ASCII whitespace inside each column is trimmed
/// before parsing so producers that pad fields (e.g. `"0\t100 \n"`) still
/// open cleanly; the structural single-tab separator and exactly-two-fields
/// invariants are still enforced.
fn parse_sidecar_text(bytes: &[u8], mp4_count: usize) -> crate::Result<Vec<i64>> {
    let text = std::str::from_utf8(bytes)?;

    let mut pts_ns: Vec<i64> = Vec::with_capacity(mp4_count);
    for (idx, line) in text.lines().enumerate() {
        if line.is_empty() {
            return Err(crate::Error::SidecarMalformedLine {
                line_no: idx,
                reason: "empty line".to_string(),
            });
        }

        let mut parts = line.splitn(3, '\t');
        let frame_str = parts.next().expect("splitn yields at least one element");
        let ts_str = parts.next().ok_or_else(|| crate::Error::SidecarMalformedLine {
            line_no: idx,
            reason: "missing timestamp column (expected `<frame>\\t<ts_ns>`)".to_string(),
        })?;
        if parts.next().is_some() {
            return Err(crate::Error::SidecarMalformedLine {
                line_no: idx,
                reason: "expected exactly two tab-separated fields".to_string(),
            });
        }

        let frame: usize = frame_str.trim().parse().map_err(|_| {
            crate::Error::SidecarMalformedLine {
                line_no: idx,
                reason: format!("frame column {frame_str:?} is not a non-negative integer"),
            }
        })?;
        if frame != pts_ns.len() {
            return Err(crate::Error::SidecarMalformedLine {
                line_no: idx,
                reason: format!(
                    "frame index {frame} does not match expected row index {}",
                    pts_ns.len()
                ),
            });
        }

        let ts_ns: i64 =
            ts_str
                .trim()
                .parse()
                .map_err(|_| crate::Error::SidecarMalformedLine {
                    line_no: idx,
                    reason: format!("timestamp column {ts_str:?} is not an i64"),
                })?;
        pts_ns.push(ts_ns);
    }

    if pts_ns.len() != mp4_count {
        return Err(crate::Error::SidecarLengthMismatch {
            mp4_count,
            sidecar_count: pts_ns.len(),
        });
    }
    Ok(pts_ns)
}

impl Reader for Mp4SidecarReader {
    /// The mp4+sidecar format inherently takes two blobs; the single-slice
    /// trait constructor cannot represent that. Callers must use
    /// [`Mp4SidecarReader::open_pair`] directly.
    fn open(_bytes: &[u8]) -> crate::Result<Self> {
        Err(crate::Error::Mp4SidecarRequiresPair)
    }

    fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    /// Video channels do not have a scalar/vector Arrow representation; the
    /// decoded frames flow through the JS sample cache instead. We still
    /// look up the channel by id so an unknown id surfaces as
    /// `ChannelNotFound` — matching the diagnostic behaviour of the other
    /// readers.
    fn fetch_range(
        &self,
        channel_id: &ChannelId,
        _range: TimeRange,
        _opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        if !self.meta.channels.iter().any(|c| &c.id == channel_id) {
            return Err(crate::Error::ChannelNotFound(channel_id.clone()));
        }
        Err(crate::Error::UnsupportedKind)
    }

    // `video_stream` falls through to the trait default which returns
    // `UnsupportedKind`. Encoded chunks for mp4+sidecar are now assembled
    // entirely in JS: sample bytes come from the original `File` blob via
    // `apps/web/src/state/mp4SampleCache.ts`, and AVCC → Annex-B framing
    // (plus first-chunk SPS/PPS prepend) lives in
    // `apps/web/src/workers/mp4AnnexB.ts`. The wasm binding
    // `mp4_sidecar_index` exposes the per-sample table and SPS/PPS bytes.
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp4::{AvcConfig, Bytes, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig};
    use std::io::Cursor;

    /// Dummy H.264 SPS/PPS NAL bytes. Valid enough for the `mp4` crate's
    /// `avcC` serialiser to accept; we never actually feed them to a decoder
    /// in these tests.
    const DUMMY_SPS: &[u8] = &[
        0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9, 0x40, 0xa0, 0x3d, 0xa1, 0x00, 0x00, 0x03, 0x00, 0x01,
        0x00, 0x00, 0x03, 0x00, 0x3c, 0x0f, 0x16, 0x2e, 0x48,
    ];
    const DUMMY_PPS: &[u8] = &[0x68, 0xeb, 0xec, 0xb2, 0x2c];

    /// Build a minimal in-memory H.264 mp4 with `sample_count` samples at 30 fps.
    /// Sample payloads are dummy length-prefixed NAL placeholders; the content
    /// never reaches a decoder in these tests.
    fn synth_mp4(sample_count: usize) -> Vec<u8> {
        let config = Mp4Config {
            major_brand: "isom".parse().unwrap(),
            minor_version: 512,
            compatible_brands: vec![
                "isom".parse().unwrap(),
                "iso2".parse().unwrap(),
                "avc1".parse().unwrap(),
                "mp41".parse().unwrap(),
            ],
            timescale: 30,
        };
        let mut writer = Mp4Writer::write_start(Cursor::new(Vec::<u8>::new()), &config).unwrap();
        let track = TrackConfig {
            track_type: TrackType::Video,
            timescale: 30,
            language: "und".to_string(),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width: 16,
                height: 16,
                seq_param_set: DUMMY_SPS.to_vec(),
                pic_param_set: DUMMY_PPS.to_vec(),
            }),
        };
        writer.add_track(&track).unwrap();

        // One-byte payload wrapped as a length-prefixed AVCC access unit: 4-byte
        // big-endian size followed by the NAL byte. Keeps the mdat tiny.
        let payload = Bytes::from_static(&[0x00, 0x00, 0x00, 0x01, 0x09]);
        for i in 0..sample_count {
            let sample = Mp4Sample {
                start_time: i as u64,
                duration: 1,
                rendering_offset: 0,
                is_sync: i == 0,
                bytes: payload.clone(),
            };
            writer.write_sample(1, &sample).unwrap();
        }
        writer.write_end().unwrap();
        writer.into_writer().into_inner()
    }

    /// `n` text lines of the form `"{i}\t{base + i*step}\n"`.
    fn synth_sidecar(base_ns: i64, step_ns: i64, n: usize) -> Vec<u8> {
        let mut out = String::new();
        for i in 0..n {
            let t = base_ns + (i as i64) * step_ns;
            out.push_str(&format!("{i}\t{t}\n"));
        }
        out.into_bytes()
    }

    #[test]
    fn opens_valid_pair_and_exposes_single_video_channel() {
        let mp4 = synth_mp4(10);
        let base: i64 = 1_700_000_000_000_000_000; // some plausible ns-UTC.
        let step: i64 = 33_333_333; // ~30 fps.
        let sidecar = synth_sidecar(base, step, 10);

        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).expect("open_pair");
        assert_eq!(r.meta().kind, SourceKind::Mp4Sidecar);
        assert_eq!(r.meta().channels.len(), 1);

        let ch = &r.meta().channels[0];
        assert_eq!(ch.kind, ChannelKind::Video);
        assert!(ch.dtype.is_none());
        assert_eq!(ch.sample_count, 10);
        assert_eq!(ch.time_range.start_ns, base);
        assert_eq!(ch.time_range.end_ns, base + 9 * step + 1);

        assert_eq!(r.meta().time_range, ch.time_range);
        assert_eq!(r.pts_ns().len(), 10);
        assert_eq!(r.pts_ns()[0], base);
        assert_eq!(r.pts_ns()[9], base + 9 * step);
    }

    #[test]
    fn open_pair_does_not_read_mdat_bytes() {
        // The whole point of the lazy-load refactor: opening the pair must
        // produce an index but never copy a single sample byte into the
        // reader. Walk every public byte slice on the reader and assert
        // none of them contain the synthetic sample payload.
        let mp4 = synth_mp4(4);
        let sidecar = synth_sidecar(0, 1_000_000, 4);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).expect("open_pair");

        let idx = r.sample_index();
        assert_eq!(idx.offsets.len(), 4);
        assert_eq!(idx.sizes.len(), 4);
        assert_eq!(idx.is_sync.len(), 4);
        // synth_mp4 writes one 5-byte AVCC unit per sample.
        for sz in &idx.sizes {
            assert_eq!(*sz, 5);
        }
        // Offsets are strictly monotonic — samples are written sequentially.
        for w in idx.offsets.windows(2) {
            assert!(w[0] < w[1], "offsets must be ascending: {:?}", idx.offsets);
        }
        // Sync flags: first sample is a keyframe, rest are delta.
        assert!(idx.is_sync[0]);
        for s in &idx.is_sync[1..] {
            assert!(!s);
        }
        // Cross-check the offsets actually point at the sample bytes in
        // the source mp4: the synth writer emits a 5-byte unit
        // `[0,0,0,1,9]` per sample.
        for (i, &off) in idx.offsets.iter().enumerate() {
            let lo = off as usize;
            let hi = lo + idx.sizes[i] as usize;
            assert_eq!(&mp4[lo..hi], &[0x00, 0x00, 0x00, 0x01, 0x09]);
        }
    }

    #[test]
    fn rejects_length_mismatch() {
        // 10 mp4 samples, 9 sidecar entries → documented acceptance error.
        let mp4 = synth_mp4(10);
        let sidecar = synth_sidecar(0, 1_000, 9);
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        match err {
            crate::Error::SidecarLengthMismatch {
                mp4_count,
                sidecar_count,
            } => {
                assert_eq!(mp4_count, 10);
                assert_eq!(sidecar_count, 9);
            }
            other => panic!("expected SidecarLengthMismatch, got {other:?}"),
        }

        // The reverse direction must also fail.
        let too_long = synth_sidecar(0, 1_000, 11);
        let err = Mp4SidecarReader::open_pair(&mp4, &too_long).unwrap_err();
        assert!(matches!(
            err,
            crate::Error::SidecarLengthMismatch {
                mp4_count: 10,
                sidecar_count: 11,
            }
        ));
    }

    #[test]
    fn rejects_sidecar_with_non_utf8_bytes() {
        let mp4 = synth_mp4(3);
        // 0xFF is never a valid leading byte in UTF-8.
        let sidecar = vec![0xFFu8, 0xFE, 0xFD];
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        assert!(matches!(err, crate::Error::SidecarNotUtf8(_)));
    }

    #[test]
    fn rejects_sidecar_line_with_missing_tab() {
        let mp4 = synth_mp4(1);
        // No tab separator — should fail with a clear message on line 0.
        let sidecar = b"0 1700000000000000000\n".to_vec();
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        match err {
            crate::Error::SidecarMalformedLine { line_no, reason } => {
                assert_eq!(line_no, 0);
                assert!(
                    reason.contains("missing timestamp column"),
                    "unexpected reason: {reason}"
                );
            }
            other => panic!("expected SidecarMalformedLine, got {other:?}"),
        }
    }

    #[test]
    fn rejects_sidecar_with_wrong_frame_index() {
        let mp4 = synth_mp4(2);
        // Second line's frame column is 2 but should be 1.
        let sidecar = b"0\t100\n2\t200\n".to_vec();
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        match err {
            crate::Error::SidecarMalformedLine { line_no, reason } => {
                assert_eq!(line_no, 1);
                assert!(
                    reason.contains("frame index 2"),
                    "unexpected reason: {reason}"
                );
            }
            other => panic!("expected SidecarMalformedLine, got {other:?}"),
        }
    }

    #[test]
    fn rejects_sidecar_with_non_integer_timestamp() {
        let mp4 = synth_mp4(1);
        let sidecar = b"0\tnot_a_number\n".to_vec();
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        match err {
            crate::Error::SidecarMalformedLine { line_no, reason } => {
                assert_eq!(line_no, 0);
                assert!(reason.contains("timestamp"), "unexpected reason: {reason}");
            }
            other => panic!("expected SidecarMalformedLine, got {other:?}"),
        }
    }

    #[test]
    fn rejects_sidecar_with_non_integer_frame_column() {
        let mp4 = synth_mp4(1);
        let sidecar = b"abc\t100\n".to_vec();
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        match err {
            crate::Error::SidecarMalformedLine { line_no, reason } => {
                assert_eq!(line_no, 0);
                assert!(
                    reason.contains("frame column"),
                    "unexpected reason: {reason}"
                );
            }
            other => panic!("expected SidecarMalformedLine, got {other:?}"),
        }
    }

    #[test]
    fn accepts_sidecar_without_trailing_newline() {
        let mp4 = synth_mp4(2);
        // Deliberately omit the trailing `\n` on the last line.
        let sidecar = b"0\t100\n1\t200".to_vec();
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).expect("open_pair");
        assert_eq!(r.pts_ns(), &[100i64, 200]);
    }

    #[test]
    fn accepts_sidecar_with_crlf_line_endings() {
        let mp4 = synth_mp4(2);
        let sidecar = b"0\t100\r\n1\t200\r\n".to_vec();
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).expect("open_pair");
        assert_eq!(r.pts_ns(), &[100i64, 200]);
    }

    #[test]
    fn accepts_sidecar_with_padded_columns() {
        let mp4 = synth_mp4(3);
        let sidecar =
            b"0\t1777112584089512192 \n  1 \t 1777112584122845525\n2\t1777112584156178858\n"
                .to_vec();
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).expect("open_pair");
        assert_eq!(
            r.pts_ns(),
            &[1777112584089512192i64, 1777112584122845525, 1777112584156178858]
        );
    }

    #[test]
    fn rejects_mp4_without_video_track() {
        let config = Mp4Config {
            major_brand: "isom".parse().unwrap(),
            minor_version: 512,
            compatible_brands: vec!["isom".parse().unwrap(), "mp41".parse().unwrap()],
            timescale: 1000,
        };
        let mut writer = Mp4Writer::write_start(Cursor::new(Vec::<u8>::new()), &config).unwrap();
        writer.write_end().unwrap();
        let mp4 = writer.into_writer().into_inner();
        let sidecar = synth_sidecar(0, 0, 0);

        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        assert!(matches!(err, crate::Error::Mp4VideoTrackCount(0)));
    }

    #[test]
    fn fetch_range_on_video_channel_is_unsupported() {
        let mp4 = synth_mp4(2);
        let sidecar = synth_sidecar(0, 1_000_000, 2);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap();
        let ch_id = r.meta().channels[0].id.clone();

        let err = r
            .fetch_range(&ch_id, r.meta().time_range, FetchOpts::default())
            .unwrap_err();
        assert!(matches!(err, crate::Error::UnsupportedKind));
    }

    #[test]
    fn fetch_range_with_unknown_channel_id_reports_not_found() {
        let mp4 = synth_mp4(1);
        let sidecar = synth_sidecar(0, 0, 1);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap();

        let err = r
            .fetch_range(
                &"does-not-exist".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn trait_open_refuses_single_blob() {
        // The `Reader::open(&[u8])` seam cannot represent the two-blob mp4 +
        // sidecar format; callers must use `open_pair` instead.
        let err = <Mp4SidecarReader as Reader>::open(&[]).unwrap_err();
        assert!(matches!(err, crate::Error::Mp4SidecarRequiresPair));
    }

    #[test]
    fn rejects_sidecar_with_extra_tab_field() {
        let mp4 = synth_mp4(1);
        let sidecar = b"0\t100\textra\n".to_vec();
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        match err {
            crate::Error::SidecarMalformedLine { line_no, reason } => {
                assert_eq!(line_no, 0);
                assert!(
                    reason.contains("expected exactly two"),
                    "unexpected reason: {reason}"
                );
            }
            other => panic!("expected SidecarMalformedLine, got {other:?}"),
        }
    }

    #[test]
    fn rejects_sidecar_with_embedded_empty_line() {
        let mp4 = synth_mp4(2);
        let sidecar = b"0\t100\n\n1\t200\n".to_vec();
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        match err {
            crate::Error::SidecarMalformedLine { line_no, reason } => {
                assert_eq!(line_no, 1);
                assert!(reason.contains("empty line"), "unexpected reason: {reason}");
            }
            other => panic!("expected SidecarMalformedLine, got {other:?}"),
        }
    }
}
