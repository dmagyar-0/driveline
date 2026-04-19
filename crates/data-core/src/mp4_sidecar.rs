//! `Mp4SidecarReader`: implementation of a video-only `Reader` whose timestamps
//! come from a separate `.ts.bin` sidecar blob rather than the mp4's own
//! `stts`/`ctts` tables.
//!
//! Covers T2.3 of `docs/10-task-breakdown.md`. See `docs/05-video-pipeline.md`
//! §"mp4 + sidecar timestamp path" for the format and rationale, and
//! `docs/04-reader-abstraction.md` §"`Mp4SidecarReader`" for the API shape.
//!
//! T5.3 adds `Reader::video_stream`, producing Annex-B access units from the
//! cached mp4 samples. `fetch_range` on the video channel still returns
//! `Err(UnsupportedKind)` — scalar/vector APIs don't apply to video. The
//! MVP sidecar format is a single-track spec (one i64 LE per sample, no
//! header), so an mp4 with zero or multiple video tracks is rejected up
//! front.
//!
//! ## Annex-B vs AVCC
//!
//! mp4 samples live in the mdat as length-prefixed AVCC NAL units. The
//! video-decode worker's codec probe scans the first chunk for an inline
//! SPS using Annex-B start codes (see `videoDecode.worker.ts::findSps`),
//! matching the MCAP reader's output. We therefore convert AVCC → Annex-B
//! inside `video_stream` and prepend the SPS/PPS (from the track's `avcC`
//! box) to the first emitted chunk so the consumer gets the same shape
//! regardless of source format.

use std::io::Cursor;

use mp4::{Mp4Reader as Mp4Parser, TrackType};

use crate::reader::{ArrowIpc, EncodedChunkIter, Reader};
use crate::types::{
    Channel, ChannelId, ChannelKind, EncodedChunk, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

/// One mp4 video sample, cached at open time. `bytes` is the raw sample
/// payload from `mdat` — length-prefixed AVCC NAL units. `is_sync` mirrors
/// the mp4's own sync-sample table (`stss`), which is authoritative for
/// keyframes on H.264 mp4 tracks.
#[derive(Debug, Clone)]
struct Mp4SampleCache {
    bytes: Vec<u8>,
    is_sync: bool,
}

#[derive(Debug)]
pub struct Mp4SidecarReader {
    meta: SourceMeta,
    /// One entry per mp4 video sample in decode order, absolute ns UTC.
    /// Parallel to the mp4 track's `stsz` sample table.
    pts_ns: Vec<i64>,
    /// Cached mp4 sample bytes + sync flags. Parallel to `pts_ns`. The
    /// MVP reader holds the whole stream in memory (matching `McapReader`);
    /// lazy reads against the mp4 bytes can come later.
    samples: Vec<Mp4SampleCache>,
    /// SPS NAL bytes (including the NAL header byte) from the `avcC` box,
    /// prepended to the first `video_stream` chunk so consumers see
    /// inline extradata identical to the MCAP path.
    sps: Vec<u8>,
    /// PPS NAL bytes, same role as `sps`.
    pps: Vec<u8>,
}

impl Mp4SidecarReader {
    /// Open an mp4 + sidecar pair. Parses the mp4 `moov`, locates the single
    /// video track, and validates that the sidecar contains exactly one
    /// little-endian `i64` ns-UTC timestamp per mp4 sample.
    ///
    /// Errors:
    /// - [`crate::Error::Mp4`] — mp4 parse failed (malformed box structure).
    /// - [`crate::Error::Mp4VideoTrackCount`] — mp4 had zero or multiple
    ///   video tracks. The MVP sidecar format only addresses a single track.
    /// - [`crate::Error::SidecarByteLengthNotMultipleOf8`] — sidecar byte
    ///   length is not `8 * N`.
    /// - [`crate::Error::SidecarLengthMismatch`] — sidecar entry count does
    ///   not match the video track's sample count. This is the named
    ///   acceptance-criterion failure from `docs/10-task-breakdown.md` T2.3.
    pub fn open_pair(mp4_bytes: &[u8], sidecar_bytes: &[u8]) -> crate::Result<Self> {
        let size = mp4_bytes.len() as u64;
        let mut mp4 = Mp4Parser::read_header(Cursor::new(mp4_bytes), size)?;

        // Drop the track borrow before calling `mp4.read_sample`, which
        // needs `&mut mp4`. We only need the track_id, sample count, and
        // the SPS/PPS NAL bytes from avcC past this scope.
        let (track_id, mp4_count, sps, pps) = {
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
            (
                track.track_id(),
                track.sample_count() as usize,
                sps,
                pps,
            )
        };

        if !sidecar_bytes.len().is_multiple_of(8) {
            return Err(crate::Error::SidecarByteLengthNotMultipleOf8(
                sidecar_bytes.len(),
            ));
        }
        let sidecar_count = sidecar_bytes.len() / 8;
        if sidecar_count != mp4_count {
            return Err(crate::Error::SidecarLengthMismatch {
                mp4_count,
                sidecar_count,
            });
        }

        let mut pts_ns = Vec::with_capacity(sidecar_count);
        for chunk in sidecar_bytes.chunks_exact(8) {
            let arr: [u8; 8] = chunk.try_into().expect("chunks_exact(8) yields 8-byte slices");
            pts_ns.push(i64::from_le_bytes(arr));
        }

        // Read every sample into memory now so `video_stream` can be a pure
        // iterator over owned bytes — no self-referential `Cursor` lifetimes
        // to thread through the `EncodedChunkIter` trait object.
        let mut samples: Vec<Mp4SampleCache> = Vec::with_capacity(mp4_count);
        for sid in 1..=mp4_count as u32 {
            let s = mp4
                .read_sample(track_id, sid)?
                .ok_or_else(|| crate::Error::Mp4(mp4::Error::InvalidData("sample_not_found")))?;
            samples.push(Mp4SampleCache {
                bytes: s.bytes.to_vec(),
                is_sync: s.is_sync,
            });
        }

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
            samples,
            sps,
            pps,
        })
    }

    /// Stable channel id used by the one video channel. Format: `"<track_id>/video"`.
    fn channel_id(track_id: u32) -> ChannelId {
        format!("{track_id}/video")
    }

    /// Exposes the parsed per-sample absolute ns timestamps. Intended for
    /// tests and debugging; the `video_stream` iterator uses the internal
    /// `samples` cache directly.
    pub fn pts_ns(&self) -> &[i64] {
        &self.pts_ns
    }
}

/// 4-byte big-endian length-prefixed NAL → Annex-B start-coded NAL.
///
/// Pushes `00 00 00 01` start codes in front of each NAL unit. Malformed
/// or truncated inputs return whatever start codes + NAL bytes were
/// successfully walked before the break — the decoder will either surface
/// the bad frame as an `EncodingError` (expected) or skip it. We'd rather
/// not panic in the reader for a locally-damaged sample.
fn avcc_to_annexb(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let nal_len =
            u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        i += 4;
        if nal_len == 0 {
            continue;
        }
        let end = match i.checked_add(nal_len) {
            Some(e) if e <= bytes.len() => e,
            _ => break,
        };
        out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        out.extend_from_slice(&bytes[i..end]);
        i = end;
    }
    out
}

/// Append an Annex-B framed NAL (`00 00 00 01 <nal>`).
fn push_annexb_nal(out: &mut Vec<u8>, nal: &[u8]) {
    out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
    out.extend_from_slice(nal);
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
    /// decoded frames flow through `video_stream` instead. We still look up
    /// the channel by id so an unknown id surfaces as `ChannelNotFound` —
    /// matching the diagnostic behaviour of the other readers.
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

    /// Yields Annex-B framed access units starting from the largest sync
    /// sample whose PTS is `<= from_pts_ns`. SPS + PPS are prepended onto
    /// the first emitted chunk so the video-decode worker can derive the
    /// codec string the same way it does for MCAP (scan for an inline SPS).
    ///
    /// Because the reader owns its sample bytes, this is always a
    /// pre-materialised `Vec<EncodedChunk>` — no streaming IO, no borrow
    /// threading into the trait object.
    fn video_stream(
        &self,
        channel_id: &ChannelId,
        from_pts_ns: i64,
    ) -> crate::Result<EncodedChunkIter> {
        let channel = self
            .meta
            .channels
            .iter()
            .find(|c| &c.id == channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;
        if channel.kind != ChannelKind::Video {
            return Err(crate::Error::UnsupportedKind);
        }

        // Snap to the largest sync sample whose PTS is <= target. If the
        // request predates every keyframe, fall back to the first keyframe
        // so callers still get a decodable prefix. No keyframes at all →
        // empty stream (matches the MCAP reader's contract).
        let sync_indices: Vec<usize> = self
            .samples
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.is_sync.then_some(i))
            .collect();
        if sync_indices.is_empty() {
            return Ok(Box::new(std::iter::empty()));
        }
        let start_idx = {
            let mut latest: Option<usize> = None;
            for &i in &sync_indices {
                if self.pts_ns[i] <= from_pts_ns {
                    latest = Some(i);
                } else {
                    break;
                }
            }
            latest.unwrap_or(sync_indices[0])
        };

        // Prepend SPS+PPS (Annex-B framed) onto the first emitted chunk so
        // `videoDecode.worker.ts::findSps` finds the extradata inline, just
        // as it does for MCAP. Every subsequent chunk is the raw mp4 sample
        // converted from AVCC to Annex-B.
        let mut out: Vec<EncodedChunk> = Vec::with_capacity(self.samples.len() - start_idx);
        for (i, sample) in self.samples[start_idx..].iter().enumerate() {
            let mut data = Vec::with_capacity(sample.bytes.len() + 16);
            if i == 0 {
                push_annexb_nal(&mut data, &self.sps);
                push_annexb_nal(&mut data, &self.pps);
            }
            data.extend_from_slice(&avcc_to_annexb(&sample.bytes));
            out.push(EncodedChunk {
                pts_ns: self.pts_ns[start_idx + i],
                is_keyframe: sample.is_sync,
                data,
            });
        }
        Ok(Box::new(out.into_iter()))
    }
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

    /// `n` i64 LE entries of the form `base + i * step_ns`.
    fn synth_sidecar(base_ns: i64, step_ns: i64, n: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(n * 8);
        for i in 0..n {
            let t = base_ns + (i as i64) * step_ns;
            out.extend_from_slice(&t.to_le_bytes());
        }
        out
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
    fn rejects_sidecar_not_aligned_to_i64() {
        let mp4 = synth_mp4(3);
        // 7 bytes — clearly not a multiple of 8.
        let sidecar = vec![0u8; 7];
        let err = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap_err();
        assert!(matches!(
            err,
            crate::Error::SidecarByteLengthNotMultipleOf8(7)
        ));
    }

    #[test]
    fn rejects_mp4_without_video_track() {
        // An mp4 with zero tracks is still syntactically valid.
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

    fn first_start_code_offset(bytes: &[u8]) -> Option<usize> {
        bytes
            .windows(4)
            .position(|w| w == [0x00, 0x00, 0x00, 0x01])
    }

    /// Scan Annex-B `data` for a NAL with the given `nal_type` (5 bits).
    fn contains_nal_type(data: &[u8], nal_type: u8) -> bool {
        let mut i = 0;
        while i + 4 < data.len() {
            if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
                let header = data[i + 4];
                if header & 0x1f == nal_type {
                    return true;
                }
                i += 4;
            } else {
                i += 1;
            }
        }
        false
    }

    #[test]
    fn video_stream_yields_sample_count_annex_b_chunks() {
        let mp4 = synth_mp4(10);
        let sidecar = synth_sidecar(0, 33_333_333, 10);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap();
        let ch_id = r.meta().channels[0].id.clone();

        let chunks: Vec<_> = r.video_stream(&ch_id, i64::MIN).unwrap().collect();
        assert_eq!(chunks.len(), 10);
        // Every chunk must begin with an Annex-B start code.
        for c in &chunks {
            assert_eq!(first_start_code_offset(&c.data), Some(0));
        }
        // PTS must be monotonic non-decreasing and match `pts_ns`.
        let ptss: Vec<i64> = chunks.iter().map(|c| c.pts_ns).collect();
        assert_eq!(ptss, r.pts_ns());
        // First sample of synth_mp4 is sync; rest are delta.
        assert!(chunks[0].is_keyframe);
        for c in &chunks[1..] {
            assert!(!c.is_keyframe);
        }
    }

    #[test]
    fn video_stream_first_chunk_contains_sps_and_pps() {
        let mp4 = synth_mp4(5);
        let sidecar = synth_sidecar(0, 1_000_000, 5);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap();
        let ch_id = r.meta().channels[0].id.clone();

        let chunks: Vec<_> = r.video_stream(&ch_id, i64::MIN).unwrap().collect();
        assert!(contains_nal_type(&chunks[0].data, 7), "SPS (nal=7) missing");
        assert!(contains_nal_type(&chunks[0].data, 8), "PPS (nal=8) missing");
        // Subsequent chunks must NOT carry the prepended extradata — only
        // the first chunk does.
        for c in &chunks[1..] {
            assert!(!contains_nal_type(&c.data, 7));
            assert!(!contains_nal_type(&c.data, 8));
        }
    }

    #[test]
    fn video_stream_snaps_to_preceding_sync_sample() {
        // synth_mp4 emits `is_sync` on index 0 only. Every request past the
        // first sample's PTS should still start the stream at index 0.
        let mp4 = synth_mp4(10);
        let step = 10_000_000;
        let base = 1_700_000_000_000_000_000;
        let sidecar = synth_sidecar(base, step, 10);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap();
        let ch_id = r.meta().channels[0].id.clone();

        let chunks: Vec<_> = r
            .video_stream(&ch_id, base + 5 * step + step / 2)
            .unwrap()
            .collect();
        // Starts at the sole sync sample (index 0), so we get all 10.
        assert_eq!(chunks.len(), 10);
        assert_eq!(chunks[0].pts_ns, base);
        assert!(chunks[0].is_keyframe);
    }

    #[test]
    fn video_stream_before_any_keyframe_starts_at_first_keyframe() {
        let mp4 = synth_mp4(3);
        let base: i64 = 1_000_000_000;
        let sidecar = synth_sidecar(base, 1_000_000, 3);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap();
        let ch_id = r.meta().channels[0].id.clone();

        // Request predates every sample; should still start at index 0.
        let chunks: Vec<_> = r.video_stream(&ch_id, 0).unwrap().collect();
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].pts_ns, base);
    }

    #[test]
    fn video_stream_unknown_channel_returns_channel_not_found() {
        let mp4 = synth_mp4(1);
        let sidecar = synth_sidecar(0, 0, 1);
        let r = Mp4SidecarReader::open_pair(&mp4, &sidecar).unwrap();

        let err = match r.video_stream(&"not-a-channel".to_string(), 0) {
            Ok(_) => panic!("expected ChannelNotFound"),
            Err(e) => e,
        };
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn avcc_to_annexb_walks_multiple_nals_and_tolerates_truncation() {
        // Two NALs: [0x05] and [0xAA, 0xBB]. Well-formed input.
        let input = [
            0x00, 0x00, 0x00, 0x01, 0x05, // len=1, NAL=0x05
            0x00, 0x00, 0x00, 0x02, 0xAA, 0xBB, // len=2, NAL=AA BB
        ];
        let out = avcc_to_annexb(&input);
        assert_eq!(
            out,
            vec![
                0x00, 0x00, 0x00, 0x01, 0x05, //
                0x00, 0x00, 0x00, 0x01, 0xAA, 0xBB,
            ]
        );

        // Truncated length: second length says 99 bytes but the buffer ends
        // after 5 bytes. First NAL still emits; second is dropped.
        let truncated = [
            0x00, 0x00, 0x00, 0x01, 0x05, //
            0x00, 0x00, 0x00, 0x63, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        ];
        let out = avcc_to_annexb(&truncated);
        assert_eq!(out, vec![0x00, 0x00, 0x00, 0x01, 0x05]);
    }
}
