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
//! Deliberate omissions: `opts.max_points` decimation belongs to T4.3
//! ("PlotPanel — decimation"); `video_stream` belongs to T5.1. `Bytes`
//! channels are surfaced in the channel list but `fetch_range` returns
//! `UnsupportedKind` for them — schema-aware decoding is post-MVP.
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

use crate::reader::{ArrowIpc, Reader};
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, FetchOpts, SourceKind, SourceMeta, TimeRange,
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
    v.get("value").and_then(|f| f.as_i64()).map(|i| i as i32)
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

impl Reader for McapReader {
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        let owned = bytes.to_vec();

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

        for msg_result in ::mcap::MessageStream::new(&owned)? {
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
                    if is_keyframe(&annex_b) {
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
                for (t, orig_idx) in pairs {
                    new_ts.push(t);
                    // Swap-remove style: replace with a cheap sentinel so we can reuse.
                    let v = std::mem::replace(&mut values[orig_idx], ParsedValue::None);
                    new_vals.push(v);
                }
                cd.timestamps = new_ts;
                cd.values = new_vals;
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
        let mut lo = cd.timestamps.partition_point(|&t| t < range.start_ns);
        let hi = cd.timestamps.partition_point(|&t| t < range.end_ns);

        if opts.include_prev && lo > 0 {
            lo -= 1;
        }

        let (lo, hi) = if hi <= lo { (lo, lo) } else { (lo, hi) };

        match channel.kind {
            ChannelKind::Scalar => build_scalar_ipc(&cd.timestamps[lo..hi], &cd.values[lo..hi]),
            ChannelKind::Vector => {
                let n = cd.vector_len.unwrap_or(3);
                build_vector_ipc(&cd.timestamps[lo..hi], &cd.values[lo..hi], n)
            }
            ChannelKind::Enum => build_enum_ipc(&cd.timestamps[lo..hi], &cd.values[lo..hi]),
            ChannelKind::Video | ChannelKind::Bytes => unreachable!("guarded above"),
        }
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

fn build_scalar_ipc(timestamps: &[i64], values: &[ParsedValue]) -> crate::Result<ArrowIpc> {
    let schema = scalar_schema();
    let ts = TimestampNanosecondArray::from(timestamps.to_vec()).with_timezone("UTC");
    let vals: Vec<f64> = values
        .iter()
        .map(|v| match v {
            ParsedValue::Scalar(f) => *f,
            _ => f64::NAN,
        })
        .collect();
    let val = Float64Array::from(vals);
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
                FetchOpts {
                    max_points: None,
                    include_prev: true,
                },
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
                FetchOpts {
                    max_points: None,
                    include_prev: true,
                },
            )
            .expect("fetch");
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 10);
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
}
