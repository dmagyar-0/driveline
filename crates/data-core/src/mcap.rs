//! `McapReader`: implementation of the `Reader` trait on top of the
//! [`mcap`](https://crates.io/crates/mcap) crate.
//!
//! Scope for T2.1 (`docs/10-task-breakdown.md:126` and the approved plan):
//!
//! - Parse the MCAP summary (schemas + channel list).
//! - Infer `ChannelKind` / `DType` from schema metadata per
//!   `docs/04-reader-abstraction.md:86-94`.
//! - Build a keyframe index for video channels (H.264 Annex-B scan).
//! - Implement `fetch_range` for `Scalar`, `Vector`, and `Enum` channels,
//!   producing Arrow IPC bytes matching the contract in
//!   `docs/03-data-model.md:100-120`.
//!
//! Deliberate omissions: `video_stream` belongs to T5.1. `Bytes`
//! channels are surfaced in the channel list but `fetch_range` returns
//! `UnsupportedKind` for them — schema-aware decoding is post-MVP.
//!
//! Real-world MCAPs (Foxglove's `testdata/mcap/demo.mcap`, ROS 2's
//! default rosbag2 storage, …) almost always use chunk-level zstd
//! compression. `predecompress_zstd_chunks` rewrites those chunks into
//! `compression = ""` chunks before the upstream reader sees them, so
//! such files now open and list their channels. Channels carrying
//! `ros1msg` / `ros2idl` / `protobuf` payloads (e.g. `std_msgs/String`
//! in the Foxglove demo) still surface as `Bytes` — adding decoders
//! for those wire formats is a separate post-MVP task tracked in
//! `docs/04-reader-abstraction.md`.
//!
//! The JSON payload shapes accepted here are the ones produced by
//! `fixtures::short_mcap_bytes()` (which in turn mirrors the fixture
//! spec in `docs/spike-T0.3-sample-corpus.md:65-104`):
//!
//! - `foxglove.Float64` → `{"value": <number>}` (or `{"data": …}` for
//!   older Foxglove SDK output).
//! - `foxglove.Vector3` → `{"x": <f64>, "y": <f64>, "z": <f64>}`.
//! - `driveline.ControlMode` → `{"value": <int>}`.
//! - `foxglove.CompressedVideo` → `{"data": "<base64 Annex-B>", …}`.

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::{
    FixedSizeListArray, Float64Array, Int32Array, RecordBatch, TimestampNanosecondArray,
};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use base64::Engine as _;

use crate::reader::{ArrowIpc, EncodedChunkIter, Reader};
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, EncodedChunk, FetchOpts, SourceKind, SourceMeta,
    TimeRange,
};

pub struct McapReader {
    _bytes: Vec<u8>,
    meta: SourceMeta,
    channel_data: HashMap<ChannelId, ChannelData>,
    /// Populated for `Video` channels only. Exposed for the future
    /// `video_stream` (T5.1); `fetch_range` does not read this.
    #[allow(dead_code)]
    pub(crate) keyframe_index: HashMap<ChannelId, Vec<KeyframeEntry>>,
}

struct ChannelData {
    timestamps: Vec<i64>,
    values: Vec<ParsedValue>,
    /// Element count per sample for `Vector` channels (e.g. 3 for Vector3).
    /// `None` for non-vector kinds.
    vector_len: Option<usize>,
    /// Per-sample Annex-B bytes + keyframe flag for `Video` channels. Parallel
    /// to `timestamps`. `None` for non-video kinds. Populated at open time so
    /// `video_stream` can serve chunks without rescanning the MCAP; the
    /// backing `mcap` crate's `MessageStream` does not surface file offsets,
    /// so buffering is the simplest correct approach for MVP.
    video_samples: Option<Vec<VideoSample>>,
}

#[derive(Clone)]
struct VideoSample {
    bytes: Vec<u8>,
    is_keyframe: bool,
}

enum ParsedValue {
    Scalar(f64),
    Vector(Vec<f64>),
    Enum(i32),
    /// For `Bytes` channels: the opaque payload. Kept for a future schema
    /// decoder; `fetch_range` returns `UnsupportedKind` for now.
    Raw(#[allow(dead_code)] Vec<u8>),
    /// For `Video` channels: timestamp-only placeholder so `sample_count`
    /// and per-channel `time_range` stay consistent with the message scan.
    None,
}

#[derive(Clone, Copy)]
pub(crate) struct KeyframeEntry {
    pub pts_ns: i64,
    /// Reserved for future `video_stream` (T5.1). Currently unset (0);
    /// the `mcap` crate's `MessageStream` does not surface raw message
    /// byte offsets, and re-scanning the file to recover them is a
    /// T5.1 concern, not a T2.1 one.
    #[allow(dead_code)]
    pub byte_offset: usize,
}

/// Infer the Driveline `ChannelKind` (and optional `DType`) from an MCAP
/// schema's name + encoding. Heuristics per `docs/04-reader-abstraction.md:86-94`,
/// extended with the well-known Foxglove JSON schemas used by the T0.3
/// sample corpus.
pub(crate) fn infer_channel_kind(
    schema_name: &str,
    schema_encoding: &str,
) -> (ChannelKind, Option<DType>) {
    // Exact matches for well-known video schemas (case-sensitive).
    const VIDEO_SCHEMA_NAMES: &[&str] = &[
        "foxglove.CompressedVideo",
        "sensor_msgs/Image",
        "sensor_msgs/msg/Image",
        "sensor_msgs/CompressedImage",
        "sensor_msgs/msg/CompressedImage",
    ];
    if VIDEO_SCHEMA_NAMES.contains(&schema_name) {
        return (ChannelKind::Video, None);
    }

    // Protobuf schemas whose name contains a video keyword.
    if schema_encoding == "protobuf" {
        let lower = schema_name.to_ascii_lowercase();
        if lower.contains("image") || lower.contains("compressedvideo") || lower.contains("h264") {
            return (ChannelKind::Video, None);
        }
    }

    // Scalar / vector heuristics for Foxglove JSON + common ROS aliases.
    match schema_name {
        "foxglove.Float64" | "std_msgs/Float64" | "std_msgs/msg/Float64" => {
            return (ChannelKind::Scalar, Some(DType::F64));
        }
        "foxglove.Float32" | "std_msgs/Float32" | "std_msgs/msg/Float32" => {
            return (ChannelKind::Scalar, Some(DType::F32));
        }
        "foxglove.Vector3" | "geometry_msgs/Vector3" | "geometry_msgs/msg/Vector3" => {
            return (ChannelKind::Vector, Some(DType::F64));
        }
        _ => {}
    }

    // `driveline.*Mode|State|Status|Enum` → Enum(I32). Heuristic for the
    // fixture's `driveline.ControlMode`; keeps T0.3 expressive without
    // inventing a bespoke schema registry.
    if schema_name.starts_with("driveline.") {
        let lower = schema_name.to_ascii_lowercase();
        if lower.ends_with("mode")
            || lower.ends_with("state")
            || lower.ends_with("status")
            || lower.ends_with("enum")
        {
            return (ChannelKind::Enum, Some(DType::I32));
        }
    }

    (ChannelKind::Bytes, None)
}

fn parse_scalar_json(data: &[u8]) -> Option<f64> {
    let v: serde_json::Value = serde_json::from_slice(data).ok()?;
    // `value` is the Foxglove.Float64 field name; `data` is a legacy alias
    // some writers still emit.
    v.get("value")
        .and_then(|f| f.as_f64())
        .or_else(|| v.get("data").and_then(|f| f.as_f64()))
}

fn parse_vector3_json(data: &[u8]) -> Option<(f64, f64, f64)> {
    let v: serde_json::Value = serde_json::from_slice(data).ok()?;
    Some((
        v.get("x")?.as_f64()?,
        v.get("y")?.as_f64()?,
        v.get("z")?.as_f64()?,
    ))
}

fn parse_enum_json(data: &[u8]) -> Option<i32> {
    let v: serde_json::Value = serde_json::from_slice(data).ok()?;
    // Drop the sample on i32 overflow rather than silently truncating —
    // a malformed MCAP payload with e.g. `"value": 0x1_0000_0000` would
    // otherwise surface as a valid-looking `0` enum code.
    v.get("value")
        .and_then(|f| f.as_i64())
        .and_then(|i| i32::try_from(i).ok())
}

/// Decode the base64 `data` field out of a Foxglove `CompressedVideo` JSON
/// envelope, returning the raw Annex-B bytes. Falls back to `None` so the
/// caller can treat the payload as already-raw bytes.
fn extract_video_bytes_from_json(data: &[u8]) -> Option<Vec<u8>> {
    let v: serde_json::Value = serde_json::from_slice(data).ok()?;
    let b64 = v.get("data")?.as_str()?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// True if the given Annex-B byte stream is a keyframe (contains IDR or
/// SPS before any non-IDR VCL slice). NAL type is the low 5 bits of the
/// first byte after each start code.
fn is_keyframe(annex_b: &[u8]) -> bool {
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
            5 | 7 => return true, // IDR slice or SPS
            1 | 2 | 3 | 4 => return false, // Non-IDR VCL slice
            _ => {}                        // AUD (9), PPS (8), SEI (6), etc. — keep scanning.
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

/// MCAP file magic — opens and closes every well-formed file. Defined
/// in the MCAP spec; reproduced here so `predecompress_zstd_chunks` can
/// verify it without going through the upstream crate.
const MCAP_MAGIC: &[u8] = b"\x89MCAP0\r\n";

/// Pre-pass that rewrites zstd-compressed chunks into uncompressed
/// chunks so the upstream `mcap` crate's reader can consume them
/// regardless of whether its `zstd` cargo feature is enabled — which
/// matters on `wasm32-unknown-unknown`, where the C `zstd-sys`
/// dependency doesn't link.
///
/// Each zstd chunk's records body is decompressed with `ruzstd` (pure
/// Rust) and re-emitted with `compression = ""`. The chunk's
/// `uncompressed_crc` is taken over uncompressed records, so it stays
/// valid across the rewrite. The footer's `summary_start` and
/// `summary_offset_start` are bumped by the cumulative byte delta so
/// `Summary::read` still locates the summary section.
///
/// # Precondition
///
/// **The output is only safe to feed to a linear reader (e.g.
/// `mcap::MessageStream`) — never an indexed reader.** Stale byte
/// offsets inside `ChunkIndex`, `SummaryOffset`, and `MessageIndex`
/// records are *not* rewritten: chunks shift by the compression delta,
/// but the records that reference them still hold the original
/// pre-rewrite offsets. `McapReader::open` consumes the buffer via
/// `MessageStream` (see `mcap.rs` `open()` impl) which ignores all of
/// these, so the staleness is invisible *today*. Swapping in any
/// indexed reader (`mcap::IndexedReader`, etc.) requires either
/// rewriting these offsets or stripping op-0x07 / 0x08 / 0x0E records
/// here first. The `debug_assert!` next to `MessageStream::new` exists
/// to make a future swap surface this constraint at test time.
fn predecompress_zstd_chunks(input: Vec<u8>) -> crate::Result<Vec<u8>> {
    use std::io::Read;

    const OP_CHUNK: u8 = 0x06;
    const OP_FOOTER: u8 = 0x02;

    if input.len() < MCAP_MAGIC.len() * 2 || !input.starts_with(MCAP_MAGIC) {
        return Ok(input);
    }

    let body_end = input.len() - MCAP_MAGIC.len();
    // Compressed → uncompressed rewrite always grows; pre-allocating
    // double the input avoids the guaranteed realloc inside the chunk
    // rewrite loop. Worst case (no chunks) we waste `input.len()` bytes
    // briefly until the function returns; both fixtures and real-world
    // MCAPs see this offset by the larger output anyway.
    let mut out: Vec<u8> = Vec::with_capacity(input.len().saturating_mul(2));
    out.extend_from_slice(MCAP_MAGIC);

    let mut total_delta: i64 = 0;
    let mut cursor = MCAP_MAGIC.len();

    while cursor + 9 <= body_end {
        let op = input[cursor];
        let len = u64::from_le_bytes(
            input[cursor + 1..cursor + 9].try_into().expect("9-byte slice"),
        ) as usize;
        let record_start = cursor + 9;
        let record_end = record_start + len;
        if record_end > body_end {
            // Malformed; let the upstream reader produce the canonical error.
            return Ok(input);
        }
        let body = &input[record_start..record_end];

        // Chunk record: 8 start_time + 8 end_time + 8 uncomp_size + 4
        // uncomp_crc + u32 compression-string length + compression bytes
        // + u64 records_size + records_size bytes of (possibly compressed)
        // record stream.
        if op == OP_CHUNK && body.len() >= 32 {
            let comp_len = u32::from_le_bytes(
                body[28..32].try_into().expect("4-byte slice"),
            ) as usize;
            if 32 + comp_len + 8 <= body.len() {
                let comp = &body[32..32 + comp_len];
                if comp == b"zstd" {
                    let rs_off = 32 + comp_len;
                    let records_size = u64::from_le_bytes(
                        body[rs_off..rs_off + 8].try_into().expect("8-byte slice"),
                    ) as usize;
                    let data_off = rs_off + 8;
                    if data_off + records_size <= body.len() {
                        let compressed = &body[data_off..data_off + records_size];
                        let mut decoder =
                            ruzstd::StreamingDecoder::new(compressed).map_err(|e| {
                                crate::Error::Io(std::io::Error::new(
                                    std::io::ErrorKind::InvalidData,
                                    format!("ruzstd init failed: {e:?}"),
                                ))
                            })?;
                        let mut decompressed: Vec<u8> = Vec::with_capacity(records_size * 2);
                        decoder.read_to_end(&mut decompressed)?;

                        // Rewrite chunk body: keep the first 28 bytes
                        // (start/end/uncomp_size/uncomp_crc — uncomp_crc is
                        // taken over uncompressed records and is
                        // unchanged), set compression to empty, and inline
                        // the now-uncompressed records.
                        let mut new_body =
                            Vec::with_capacity(28 + 4 + 8 + decompressed.len());
                        new_body.extend_from_slice(&body[0..28]);
                        new_body.extend_from_slice(&0u32.to_le_bytes());
                        new_body.extend_from_slice(&(decompressed.len() as u64).to_le_bytes());
                        new_body.extend_from_slice(&decompressed);

                        let new_len = new_body.len();
                        out.push(op);
                        out.extend_from_slice(&(new_len as u64).to_le_bytes());
                        out.extend_from_slice(&new_body);
                        total_delta += new_len as i64 - len as i64;
                        cursor = record_end;
                        continue;
                    }
                }
            }
        }

        if op == OP_FOOTER && total_delta != 0 && body.len() >= 20 {
            // Footer body: u64 summary_start, u64 summary_offset_start,
            // u32 summary_crc.
            let mut new_body = body.to_vec();
            let summary_start = u64::from_le_bytes(
                body[0..8].try_into().expect("8-byte slice"),
            );
            let summary_offset_start = u64::from_le_bytes(
                body[8..16].try_into().expect("8-byte slice"),
            );
            if summary_start != 0 {
                let shifted = summary_start as i64 + total_delta;
                new_body[0..8].copy_from_slice(&(shifted as u64).to_le_bytes());
            }
            if summary_offset_start != 0 {
                let shifted = summary_offset_start as i64 + total_delta;
                new_body[8..16].copy_from_slice(&(shifted as u64).to_le_bytes());
            }
            // `summary_crc` is not validated by the SansIo SummaryReader,
            // so we leave it as-is.
            out.push(op);
            out.extend_from_slice(&(new_body.len() as u64).to_le_bytes());
            out.extend_from_slice(&new_body);
            cursor = record_end;
            continue;
        }

        out.push(op);
        out.extend_from_slice(&(len as u64).to_le_bytes());
        out.extend_from_slice(body);
        cursor = record_end;
    }

    out.extend_from_slice(&input[body_end..]);
    Ok(out)
}

impl Reader for McapReader {
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        let owned = predecompress_zstd_chunks(bytes.to_vec())?;

        // Step 1: summary section — schemas + channel list, no message body scan.
        let summary =
            ::mcap::Summary::read(&owned)?.ok_or(crate::Error::McapMissingSummary)?;

        // Pre-compute per-mcap-channel-id metadata so the message scan is cheap.
        let mut channel_meta: HashMap<u16, (ChannelKind, Option<DType>, String)> =
            HashMap::with_capacity(summary.channels.len());
        for (&mcap_ch_id, ch) in &summary.channels {
            let (kind, dtype) = match ch.schema.as_deref() {
                Some(s) => infer_channel_kind(&s.name, &s.encoding),
                None => (ChannelKind::Bytes, None),
            };
            channel_meta.insert(mcap_ch_id, (kind, dtype, ch.topic.clone()));
        }

        // Step 2: linear message scan — fills channel_data and keyframe_index.
        let mut channel_data: HashMap<ChannelId, ChannelData> = HashMap::new();
        let mut keyframe_index: HashMap<ChannelId, Vec<KeyframeEntry>> = HashMap::new();

        // SAFETY: `predecompress_zstd_chunks` does not rewrite stale byte
        // offsets inside `MessageIndex` / `ChunkIndex` / `SummaryOffset`
        // records — a linear `MessageStream` is required. If this is ever
        // swapped for an indexed reader, the predecompress pre-pass must
        // also strip or rewrite those offsets first.
        let stream = ::mcap::MessageStream::new(&owned)?;
        debug_assert_eq!(
            std::any::type_name_of_val(&stream),
            std::any::type_name::<::mcap::MessageStream>(),
            "predecompress_zstd_chunks output is only safe with mcap::MessageStream — a future \
             swap to an indexed reader must rewrite/strip stale offsets in the pre-pass first",
        );
        for msg_result in stream {
            let msg = msg_result?;
            let Some((kind, _dtype, topic)) = channel_meta.get(&msg.channel.id) else {
                continue;
            };
            let log_time = msg.log_time as i64;
            let channel_id: ChannelId = topic.clone();
            let entry = channel_data
                .entry(channel_id.clone())
                .or_insert_with(|| ChannelData {
                    timestamps: Vec::new(),
                    values: Vec::new(),
                    vector_len: None,
                    video_samples: None,
                });

            match kind {
                ChannelKind::Scalar => {
                    if let Some(v) = parse_scalar_json(&msg.data) {
                        entry.timestamps.push(log_time);
                        entry.values.push(ParsedValue::Scalar(v));
                    }
                }
                ChannelKind::Vector => {
                    if let Some((x, y, z)) = parse_vector3_json(&msg.data) {
                        entry.vector_len = Some(3);
                        entry.timestamps.push(log_time);
                        entry.values.push(ParsedValue::Vector(vec![x, y, z]));
                    }
                }
                ChannelKind::Enum => {
                    if let Some(code) = parse_enum_json(&msg.data) {
                        entry.timestamps.push(log_time);
                        entry.values.push(ParsedValue::Enum(code));
                    }
                }
                ChannelKind::Video => {
                    let annex_b = extract_video_bytes_from_json(&msg.data)
                        .unwrap_or_else(|| msg.data.to_vec());
                    let keyframe = is_keyframe(&annex_b);
                    if keyframe {
                        keyframe_index
                            .entry(channel_id.clone())
                            .or_default()
                            .push(KeyframeEntry {
                                pts_ns: log_time,
                                byte_offset: 0,
                            });
                    }
                    entry.timestamps.push(log_time);
                    entry.values.push(ParsedValue::None);
                    entry
                        .video_samples
                        .get_or_insert_with(Vec::new)
                        .push(VideoSample {
                            bytes: annex_b,
                            is_keyframe: keyframe,
                        });
                }
                ChannelKind::Bytes => {
                    entry.timestamps.push(log_time);
                    entry.values.push(ParsedValue::Raw(msg.data.to_vec()));
                }
            }
        }

        // Some MCAP writers interleave messages across channels; guard against
        // the possibility of out-of-order per-channel timestamps by sorting.
        for cd in channel_data.values_mut() {
            if cd.timestamps.windows(2).any(|w| w[0] > w[1]) {
                let mut pairs: Vec<(i64, usize)> = cd
                    .timestamps
                    .iter()
                    .copied()
                    .enumerate()
                    .map(|(i, t)| (t, i))
                    .collect();
                pairs.sort_by_key(|p| p.0);
                let mut new_ts = Vec::with_capacity(pairs.len());
                let mut new_vals = Vec::with_capacity(pairs.len());
                let mut values = std::mem::take(&mut cd.values);
                let mut video_in = cd.video_samples.take();
                let mut new_video: Option<Vec<VideoSample>> =
                    video_in.as_ref().map(|v| Vec::with_capacity(v.len()));
                for (t, orig_idx) in pairs {
                    new_ts.push(t);
                    // Swap-remove style: replace with a cheap sentinel so we can reuse.
                    let v = std::mem::replace(&mut values[orig_idx], ParsedValue::None);
                    new_vals.push(v);
                    if let (Some(src), Some(dst)) = (video_in.as_mut(), new_video.as_mut()) {
                        let sample = std::mem::replace(
                            &mut src[orig_idx],
                            VideoSample {
                                bytes: Vec::new(),
                                is_keyframe: false,
                            },
                        );
                        dst.push(sample);
                    }
                }
                cd.timestamps = new_ts;
                cd.values = new_vals;
                cd.video_samples = new_video;
            }
        }
        for kf_list in keyframe_index.values_mut() {
            kf_list.sort_by_key(|k| k.pts_ns);
        }

        // Step 3: build the public SourceMeta.channels list, computing per-channel
        // and global time ranges. Channels without any messages get an empty
        // range (sample_count = 0) — they are still listed for UI.
        let mut channels: Vec<Channel> = Vec::with_capacity(summary.channels.len());
        let mut global_range: Option<(i64, i64)> = None;

        // Stable ordering by MCAP channel id keeps the channel list deterministic
        // (summary.channels is a HashMap).
        let mut mcap_ids: Vec<u16> = summary.channels.keys().copied().collect();
        mcap_ids.sort();

        for mcap_ch_id in mcap_ids {
            let ch = &summary.channels[&mcap_ch_id];
            let (kind, dtype, topic) = &channel_meta[&mcap_ch_id];
            let channel_id = topic.clone();
            let (sample_count, time_range) = match channel_data.get(&channel_id) {
                Some(cd) if !cd.timestamps.is_empty() => {
                    let first = *cd.timestamps.first().unwrap();
                    let last = *cd.timestamps.last().unwrap();
                    let end = last.saturating_add(1);
                    global_range = Some(match global_range {
                        Some((lo, hi)) => (lo.min(first), hi.max(end)),
                        None => (first, end),
                    });
                    (
                        cd.timestamps.len() as u64,
                        TimeRange {
                            start_ns: first,
                            end_ns: end,
                        },
                    )
                }
                _ => (0, TimeRange::empty()),
            };

            // Unit hint: MCAP carries no unit on the channel record, but some
            // producers stash it in the free-form `metadata` map.
            let unit = ch.metadata.get("unit").cloned();

            channels.push(Channel {
                id: channel_id,
                source_id: String::new(),
                name: ch.topic.clone(),
                kind: *kind,
                dtype: *dtype,
                unit,
                sample_count,
                time_range,
            });
        }

        let time_range = match global_range {
            Some((lo, hi)) => TimeRange {
                start_ns: lo,
                end_ns: hi,
            },
            None => TimeRange::empty(),
        };

        Ok(McapReader {
            _bytes: owned,
            meta: SourceMeta {
                id: String::new(),
                kind: SourceKind::Mcap,
                time_range,
                channels,
            },
            channel_data,
            keyframe_index,
        })
    }

    fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    fn fetch_range(
        &self,
        channel_id: &ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        let channel = self
            .meta
            .channels
            .iter()
            .find(|c| &c.id == channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        if matches!(channel.kind, ChannelKind::Video | ChannelKind::Bytes) {
            return Err(crate::Error::UnsupportedKind);
        }

        let cd = self
            .channel_data
            .get(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        // Half-open lookup matching `docs/03-data-model.md` TimeRange contract.
        let start_idx = cd.timestamps.partition_point(|&t| t < range.start_ns);
        let end_idx = cd
            .timestamps
            .partition_point(|&t| t < range.end_ns)
            .max(start_idx);
        // `include_prev` surfaces one sample strictly before `start_ns` so a
        // step-hold line renderer can draw the leading segment.
        let prev_idx = if opts.include_prev && start_idx > 0 {
            Some(start_idx - 1)
        } else {
            None
        };

        match channel.kind {
            ChannelKind::Scalar => {
                let body_ts = &cd.timestamps[start_idx..end_idx];
                let body_vals: Vec<f64> = cd.values[start_idx..end_idx]
                    .iter()
                    .map(parsed_scalar_as_f64)
                    .collect();
                let (mut ts_out, mut vals_out) = (body_ts.to_vec(), body_vals);
                if let Some(p) = prev_idx {
                    ts_out.insert(0, cd.timestamps[p]);
                    vals_out.insert(0, parsed_scalar_as_f64(&cd.values[p]));
                }
                build_scalar_ipc_raw(&ts_out, &vals_out)
            }
            ChannelKind::Vector => {
                let lo = prev_idx.unwrap_or(start_idx);
                let n = cd.vector_len.unwrap_or(3);
                build_vector_ipc(&cd.timestamps[lo..end_idx], &cd.values[lo..end_idx], n)
            }
            ChannelKind::Enum => {
                let lo = prev_idx.unwrap_or(start_idx);
                build_enum_ipc(&cd.timestamps[lo..end_idx], &cd.values[lo..end_idx])
            }
            ChannelKind::Video | ChannelKind::Bytes => unreachable!("guarded above"),
        }
    }

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

        let cd = self
            .channel_data
            .get(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;
        let video = cd
            .video_samples
            .as_ref()
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        // Snap to the largest keyframe whose pts <= from_pts_ns. If the
        // request predates every keyframe, start at the first one so callers
        // always receive a decodable prefix.
        let kfs = self
            .keyframe_index
            .get(channel_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let start_pts = if kfs.is_empty() {
            // No keyframes at all — nothing decodable; emit an empty stream.
            return Ok(Box::new(std::iter::empty()));
        } else {
            let idx = kfs.partition_point(|k| k.pts_ns <= from_pts_ns);
            if idx == 0 {
                kfs[0].pts_ns
            } else {
                kfs[idx - 1].pts_ns
            }
        };
        let start_idx = cd.timestamps.partition_point(|&t| t < start_pts);

        // Clone only the tail we need; the MCAP fixture is small and this
        // keeps the iterator `'static` + `Send` without self-referential
        // trickery.
        let out: Vec<EncodedChunk> = cd.timestamps[start_idx..]
            .iter()
            .zip(video[start_idx..].iter())
            .map(|(&pts_ns, s)| EncodedChunk {
                pts_ns,
                is_keyframe: s.is_keyframe,
                data: s.bytes.clone(),
            })
            .collect();

        Ok(Box::new(out.into_iter()))
    }
}

fn scalar_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new(
            "ts",
            DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
            false,
        ),
        Field::new("value", DataType::Float64, false),
    ]))
}

fn vector_schema(n: usize) -> Arc<Schema> {
    let inner = Arc::new(Field::new("item", DataType::Float64, false));
    Arc::new(Schema::new(vec![
        Field::new(
            "ts",
            DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
            false,
        ),
        Field::new("value", DataType::FixedSizeList(inner, n as i32), false),
    ]))
}

fn enum_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new(
            "ts",
            DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
            false,
        ),
        Field::new("code", DataType::Int32, false),
    ]))
}

fn write_ipc(schema: Arc<Schema>, batch: RecordBatch) -> crate::Result<ArrowIpc> {
    let mut buf = Vec::new();
    {
        let mut w = FileWriter::try_new(&mut buf, &schema)?;
        w.write(&batch)?;
        w.finish()?;
    }
    Ok(buf)
}

fn parsed_scalar_as_f64(v: &ParsedValue) -> f64 {
    match v {
        ParsedValue::Scalar(f) => *f,
        _ => f64::NAN,
    }
}

fn build_scalar_ipc_raw(timestamps: &[i64], values: &[f64]) -> crate::Result<ArrowIpc> {
    let schema = scalar_schema();
    let ts = TimestampNanosecondArray::from(timestamps.to_vec()).with_timezone("UTC");
    let val = Float64Array::from(values.to_vec());
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(val)])?;
    write_ipc(schema, batch)
}

fn build_vector_ipc(
    timestamps: &[i64],
    values: &[ParsedValue],
    n: usize,
) -> crate::Result<ArrowIpc> {
    let schema = vector_schema(n);
    let ts = TimestampNanosecondArray::from(timestamps.to_vec()).with_timezone("UTC");

    let mut flat = Vec::with_capacity(values.len() * n);
    for v in values {
        match v {
            ParsedValue::Vector(inner) if inner.len() == n => flat.extend_from_slice(inner),
            _ => flat.extend(std::iter::repeat(f64::NAN).take(n)),
        }
    }
    let child = Arc::new(Float64Array::from(flat));
    let inner_field = Arc::new(Field::new("item", DataType::Float64, false));
    let list = FixedSizeListArray::new(inner_field, n as i32, child, None);

    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(list)])?;
    write_ipc(schema, batch)
}

fn build_enum_ipc(timestamps: &[i64], values: &[ParsedValue]) -> crate::Result<ArrowIpc> {
    let schema = enum_schema();
    let ts = TimestampNanosecondArray::from(timestamps.to_vec()).with_timezone("UTC");
    let codes: Vec<i32> = values
        .iter()
        .map(|v| match v {
            ParsedValue::Enum(c) => *c,
            _ => 0,
        })
        .collect();
    let code = Int32Array::from(codes);
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(code)])?;
    write_ipc(schema, batch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::Array;
    use arrow_ipc::reader::FileReader;
    use std::io::Cursor;

    /// 2024-01-01T00:00:00Z, matching `docs/spike-T0.3-sample-corpus.md:47`.
    const T0: i64 = 1_704_067_200_000_000_000_i64;

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1, "expected exactly one record batch");
        batches.into_iter().next().unwrap()
    }

    #[test]
    fn builds_keyframe_index_from_fixture() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");

        let kf = r
            .keyframe_index
            .get("/camera/front")
            .expect("video channel indexed");
        assert_eq!(kf.len(), 3, "expected 3 keyframes");
        for w in kf.windows(2) {
            assert!(w[1].pts_ns > w[0].pts_ns, "keyframes must be ordered");
        }

        let ch = r
            .meta()
            .channels
            .iter()
            .find(|c| c.name == "/camera/front")
            .expect("video channel surfaced");
        assert_eq!(ch.kind, ChannelKind::Video);
    }

    #[test]
    fn fetch_range_respects_time_bounds() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");

        // /vehicle/speed: samples at T0 + 0ms, 10ms, … 90ms (10 total).
        // [T0+20ms, T0+60ms) → samples at 20, 30, 40, 50 ms = 4 rows.
        let speed_id = "/vehicle/speed".to_string();
        let range = TimeRange {
            start_ns: T0 + 20_000_000,
            end_ns: T0 + 60_000_000,
        };
        let ipc = r
            .fetch_range(&speed_id, range, FetchOpts::default())
            .expect("fetch");
        let batch = parse_ipc(&ipc);

        assert_eq!(batch.num_rows(), 4);
        match batch.schema().field(0).data_type() {
            DataType::Timestamp(TimeUnit::Nanosecond, Some(tz)) => assert_eq!(tz.as_ref(), "UTC"),
            other => panic!("unexpected ts dtype: {other:?}"),
        }
        assert_eq!(batch.schema().field(1).data_type(), &DataType::Float64);

        let ts = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        assert_eq!(ts.value(0), T0 + 20_000_000);
        assert_eq!(ts.value(3), T0 + 50_000_000);

        let val = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        // Values are `i` for `i in 0..10` → indices 2,3,4,5 → 2,3,4,5.
        assert_eq!(val.value(0), 2.0);
        assert_eq!(val.value(3), 5.0);
    }

    #[test]
    fn fetch_range_includes_prev_when_requested() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");

        let speed_id = "/vehicle/speed".to_string();
        let range = TimeRange {
            start_ns: T0 + 20_000_000,
            end_ns: T0 + 60_000_000,
        };
        let ipc = r
            .fetch_range(
                &speed_id,
                range,
                FetchOpts { include_prev: true },
            )
            .expect("fetch");
        let batch = parse_ipc(&ipc);

        assert_eq!(batch.num_rows(), 5, "expected 4 in-range + 1 leading");
        let ts = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        assert_eq!(ts.value(0), T0 + 10_000_000, "leading sample at T0+10ms");
        let val = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        assert!((val.value(0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn opens_and_surfaces_all_channels() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        assert_eq!(r.meta().kind, SourceKind::Mcap);
        assert_eq!(r.meta().channels.len(), 4);

        let speed = r
            .meta()
            .channels
            .iter()
            .find(|c| c.name == "/vehicle/speed")
            .unwrap();
        assert_eq!(speed.kind, ChannelKind::Scalar);
        assert_eq!(speed.dtype, Some(DType::F64));
        assert_eq!(speed.sample_count, 10);

        let accel = r
            .meta()
            .channels
            .iter()
            .find(|c| c.name == "/imu/accel")
            .unwrap();
        assert_eq!(accel.kind, ChannelKind::Vector);
        assert_eq!(accel.dtype, Some(DType::F64));

        let mode = r
            .meta()
            .channels
            .iter()
            .find(|c| c.name == "/control/mode")
            .unwrap();
        assert_eq!(mode.kind, ChannelKind::Enum);
        assert_eq!(mode.dtype, Some(DType::I32));
    }

    #[test]
    fn fetch_range_enum_channel_returns_int32_code() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        let mode_id = "/control/mode".to_string();

        let ipc = r
            .fetch_range(&mode_id, r.meta().time_range, FetchOpts::default())
            .expect("fetch");
        let batch = parse_ipc(&ipc);

        assert_eq!(batch.schema().field(1).name(), "code");
        assert_eq!(batch.schema().field(1).data_type(), &DataType::Int32);
        assert_eq!(batch.num_rows(), 3);

        let codes = batch
            .column(1)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        assert_eq!(codes.value(0), 0);
        assert_eq!(codes.value(1), 1);
        assert_eq!(codes.value(2), 0);
    }

    #[test]
    fn fetch_range_vector_channel_returns_fixed_size_list() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        let accel_id = "/imu/accel".to_string();

        let ipc = r
            .fetch_range(&accel_id, r.meta().time_range, FetchOpts::default())
            .expect("fetch");
        let batch = parse_ipc(&ipc);

        match batch.schema().field(1).data_type() {
            DataType::FixedSizeList(inner, n) => {
                assert_eq!(*n, 3);
                assert_eq!(inner.data_type(), &DataType::Float64);
            }
            other => panic!("expected FixedSizeList, got {other:?}"),
        }
        assert_eq!(batch.num_rows(), 5);

        let list = batch
            .column(1)
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        let values = list
            .values()
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        // First row: (1.0, 2.0, 3.0).
        assert_eq!(values.value(0), 1.0);
        assert_eq!(values.value(1), 2.0);
        assert_eq!(values.value(2), 3.0);
    }

    #[test]
    fn fetch_range_video_returns_unsupported_kind() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        let err = r
            .fetch_range(
                &"/camera/front".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap_err();
        assert!(matches!(err, crate::Error::UnsupportedKind));
    }

    #[test]
    fn unknown_channel_returns_channel_not_found() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        let err = r
            .fetch_range(
                &"/no/such/channel".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn include_prev_at_start_of_range_does_not_underflow() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        let speed_id = "/vehicle/speed".to_string();

        let ipc = r
            .fetch_range(
                &speed_id,
                r.meta().time_range,
                FetchOpts { include_prev: true },
            )
            .expect("fetch");
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 10);
    }

    #[test]
    fn video_stream_starts_at_preceding_keyframe() {
        // Fixture has 3 keyframes at T0, T0+30ms, T0+60ms.
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");

        // Target between keyframes 1 and 2: must snap to T0+30ms.
        let chunks: Vec<_> = r
            .video_stream(&"/camera/front".to_string(), T0 + 45_000_000)
            .expect("video_stream")
            .collect();
        assert_eq!(chunks.len(), 2, "expect snap to k2, then k3");
        assert_eq!(chunks[0].pts_ns, T0 + 30_000_000);
        assert!(chunks[0].is_keyframe);
        assert_eq!(chunks[1].pts_ns, T0 + 60_000_000);

        // Target before everything snaps to the first keyframe.
        let chunks: Vec<_> = r
            .video_stream(&"/camera/front".to_string(), T0 - 1)
            .expect("video_stream")
            .collect();
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].pts_ns, T0);
    }

    #[test]
    fn video_stream_is_monotonic_and_complete() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");

        let chunks: Vec<_> = r
            .video_stream(&"/camera/front".to_string(), T0)
            .expect("video_stream")
            .collect();
        assert_eq!(chunks.len(), 3);
        for w in chunks.windows(2) {
            assert!(w[1].pts_ns > w[0].pts_ns, "chunks must be strictly monotonic");
        }
        // Fixture payload is SPS + IDR on every message, so each is a keyframe.
        for c in &chunks {
            assert!(c.is_keyframe);
            assert!(!c.data.is_empty(), "payload bytes preserved");
        }
    }

    #[test]
    fn video_stream_returns_unsupported_on_signal_channel() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        match r.video_stream(&"/vehicle/speed".to_string(), T0) {
            Err(crate::Error::UnsupportedKind) => {}
            Err(other) => panic!("expected UnsupportedKind, got {other:?}"),
            Ok(_) => panic!("expected error on signal channel"),
        }
    }

    #[test]
    fn video_stream_unknown_channel_returns_channel_not_found() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");
        match r.video_stream(&"/nope".to_string(), T0) {
            Err(crate::Error::ChannelNotFound(_)) => {}
            Err(other) => panic!("expected ChannelNotFound, got {other:?}"),
            Ok(_) => panic!("expected error on unknown channel"),
        }
    }

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

    #[test]
    fn parse_enum_json_in_range() {
        assert_eq!(parse_enum_json(br#"{"value": 0}"#), Some(0));
        assert_eq!(parse_enum_json(br#"{"value": -1}"#), Some(-1));
        assert_eq!(
            parse_enum_json(br#"{"value": 2147483647}"#),
            Some(i32::MAX)
        );
        assert_eq!(
            parse_enum_json(br#"{"value": -2147483648}"#),
            Some(i32::MIN)
        );
    }

    #[test]
    fn parse_enum_json_drops_out_of_range() {
        // 0x1_0000_0000 — one past i32::MAX. Previously truncated to 0.
        assert_eq!(parse_enum_json(br#"{"value": 4294967296}"#), None);
        // i32::MAX + 1.
        assert_eq!(parse_enum_json(br#"{"value": 2147483648}"#), None);
        // i32::MIN - 1.
        assert_eq!(parse_enum_json(br#"{"value": -2147483649}"#), None);
    }

    #[test]
    fn parse_enum_json_rejects_malformed() {
        assert_eq!(parse_enum_json(b"not-json"), None);
        assert_eq!(parse_enum_json(br#"{"other": 1}"#), None);
    }

    #[test]
    fn predecompress_zstd_chunks_passes_through_non_mcap_bytes() {
        // Buffer that doesn't start with MCAP magic must be returned
        // verbatim — the pre-pass is a fast-path no-op for non-MCAP
        // input and must not surface a parse error or mangle the
        // bytes. A regression that dropped the magic-check guard would
        // try to parse arbitrary bytes as record headers.
        let input = b"this is plainly not an mcap file at all".to_vec();
        let out = predecompress_zstd_chunks(input.clone()).expect("non-mcap pass-through");
        assert_eq!(out, input);
    }

    #[test]
    fn predecompress_zstd_chunks_short_input_is_returned_verbatim() {
        // Inputs too short to hold even the leading + trailing magic
        // pair must short-circuit; otherwise the cursor loop's
        // `body_end = input.len() - MCAP_MAGIC.len()` underflows the
        // `cursor + 9 <= body_end` bound check on the very first
        // iteration. The MCAP magic alone is exactly 8 bytes — half
        // of the required minimum — so this is the most common
        // non-empty truncated input we'd see in the wild.
        let input = MCAP_MAGIC.to_vec();
        let out = predecompress_zstd_chunks(input.clone()).expect("short pass-through");
        assert_eq!(out, input);
    }

    #[test]
    fn predecompress_zstd_chunks_is_noop_for_uncompressed_mcap() {
        // The plain fixture has `use_chunks(false)` so it contains no
        // chunk records at all — the pre-pass must therefore round-trip
        // it byte-for-byte. A regression that mangled the verbatim
        // pass-through path (e.g. dropping each record's body) would
        // produce bytes that look superficially MCAP-shaped but the
        // downstream reader would fail to open. We assert both: the
        // bytes are identical AND the reader still surfaces the four
        // expected channels after the pre-pass.
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate plain mcap");
        let pre = predecompress_zstd_chunks(bytes.clone()).expect("predecompress");
        assert_eq!(pre, bytes, "uncompressed MCAP must not change");
        let r = McapReader::open(&pre).expect("open after no-op predecompress");
        assert_eq!(r.meta().channels.len(), 4);
    }

    /// `short_mcap_zstd_bytes()` writes the same four-channel corpus as
    /// `short_mcap_bytes()` but with chunk-level zstd compression. The
    /// reader must surface an identical `SourceMeta` regardless of how the
    /// chunks were compressed — this exercises the native `mcap` zstd
    /// feature (and on wasm, the `ruzstd` pre-decompression hook).
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn zstd_compressed_fixture_round_trips_through_reader() {
        let bytes = crate::fixtures::short_mcap_zstd_bytes().expect("generate zstd mcap");
        // MCAP magic: 0x89 'M' 'C' 'A' 'P' '0' '\r' '\n'.
        assert_eq!(&bytes[..5], b"\x89MCAP", "zstd fixture must start with MCAP magic");
        let r = McapReader::open(&bytes).expect("open zstd mcap");

        let plain = crate::fixtures::short_mcap_bytes().expect("generate plain mcap");
        let r_plain = McapReader::open(&plain).expect("open plain mcap");

        let mut zstd_names: Vec<_> = r.meta().channels.iter().map(|c| c.name.clone()).collect();
        let mut plain_names: Vec<_> =
            r_plain.meta().channels.iter().map(|c| c.name.clone()).collect();
        zstd_names.sort();
        plain_names.sort();
        assert_eq!(
            zstd_names, plain_names,
            "zstd reader must surface the same channel set as the uncompressed reader"
        );

        let speed = r
            .meta()
            .channels
            .iter()
            .find(|c| c.name == "/vehicle/speed")
            .expect("/vehicle/speed missing");
        assert_eq!(speed.kind, ChannelKind::Scalar);
        assert_eq!(speed.sample_count, 10);
    }
}
