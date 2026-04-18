//! `Mp4SidecarReader`: implementation of a video-only `Reader` whose timestamps
//! come from a separate `.ts.bin` sidecar blob rather than the mp4's own
//! `stts`/`ctts` tables.
//!
//! Covers T2.3 of `docs/10-task-breakdown.md`. See `docs/05-video-pipeline.md`
//! §"mp4 + sidecar timestamp path" for the format and rationale, and
//! `docs/04-reader-abstraction.md` §"`Mp4SidecarReader`" for the API shape.
//!
//! Deliberate M2 scope limits: no `video_stream` iterator yet (that lands in
//! T5.3 alongside the video decode worker), so `fetch_range` on the produced
//! `Video` channel returns `Err(UnsupportedKind)`. The mp4 sample bytes are
//! parsed here only far enough to validate the sidecar count; access-unit
//! extraction is the decoder pipeline's job.
//!
//! The MVP sidecar format is a single-track spec (one i64 LE per sample, no
//! header), so an mp4 with zero or multiple video tracks is rejected up front
//! — there is no unambiguous way to split a flat sidecar array across
//! tracks.

use std::io::Cursor;

use mp4::{Mp4Reader as Mp4Parser, TrackType};

use crate::reader::{ArrowIpc, Reader};
use crate::types::{
    Channel, ChannelId, ChannelKind, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

#[derive(Debug)]
pub struct Mp4SidecarReader {
    meta: SourceMeta,
    /// One entry per mp4 video sample in decode order, absolute ns UTC.
    /// Parallel to the mp4 track's `stsz` sample table.
    pts_ns: Vec<i64>,
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
        let mp4 = Mp4Parser::read_header(Cursor::new(mp4_bytes), size)?;

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
        let mp4_count = track.sample_count() as usize;

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
            id: Self::channel_id(track.track_id()),
            source_id: String::new(),
            name: format!("track_{}", track.track_id()),
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
        })
    }

    /// Stable channel id used by the one video channel. Format: `"<track_id>/video"`.
    fn channel_id(track_id: u32) -> ChannelId {
        format!("{track_id}/video")
    }

    /// Exposes the parsed per-sample absolute ns timestamps. Intended for the
    /// future `video_stream` iterator (T5.3) to zip with mp4 sample bytes.
    pub fn pts_ns(&self) -> &[i64] {
        &self.pts_ns
    }
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
    /// decoded frames flow through a dedicated `video_stream` pipeline (T5.3).
    /// For M2 every call returns an error. We still look up the channel by id
    /// so an unknown id surfaces as `ChannelNotFound` — matching the diagnostic
    /// behaviour of the other readers.
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
}
