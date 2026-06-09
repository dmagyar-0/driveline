//! `McapReader`: a lazy, range-reading MCAP adapter on top of the
//! [`mcap`](https://crates.io/crates/mcap) crate's sans-IO primitives.
//!
//! ## Memory model
//!
//! The reader never holds the whole file. At open it drives the sans-IO
//! [`SummaryReader`] over a [`ByteRangeReader`] to pull just the summary
//! section (schemas, channel list, chunk index, statistics) — no message
//! payloads. `fetch_range` then range-reads only the chunks overlapping the
//! requested `[start, end)`, decompresses them (zstd via the pure-Rust
//! `ruzstd`, so the wasm build needs no C `zstd-sys`), and extracts the
//! requested channel's samples. Video streams the same way through a
//! [`McapVideoCursor`] that pulls chunks on demand from a seek keyframe
//! forward, so a multi-gigabyte remote MCAP is read incrementally and never
//! fully materialised.
//!
//! In the browser the reader is backed by an OPFS sync access handle or an
//! HTTP-range XHR (see `wasm-bindings`); native callers and tests use an
//! in-memory [`SliceRangeReader`] via [`McapReader::open`].
//!
//! ## Compression
//!
//! Chunks are decompressed here rather than through the upstream
//! `IndexedReader` (whose decompression is gated behind the `mcap` crate's
//! `zstd`/`lz4` cargo features, which the wasm target deliberately keeps off).
//! `compression = ""` and `"zstd"` are supported on every target; `"lz4"`
//! surfaces [`McapError::UnsupportedCompression`] (the project's build never
//! enabled lz4 on any target).
//!
//! ## Channel kinds & payloads
//!
//! `infer_channel_kind` maps an MCAP schema name + encoding onto a Driveline
//! `ChannelKind`. The JSON payload shapes accepted are the ones produced by
//! `fixtures::short_mcap_bytes()`:
//!
//! - `foxglove.Float64` → `{"value": <number>}` (or `{"data": …}`).
//! - `foxglove.Vector3` → `{"x": <f64>, "y": <f64>, "z": <f64>}`.
//! - `driveline.ControlMode` → `{"value": <int>}`.
//! - `foxglove.CompressedVideo` → `{"data": "<base64 Annex-B>", …}`.
//!
//! Channels carrying `ros1msg` / `ros2idl` / `protobuf` payloads still surface
//! as `Bytes`; `fetch_range` returns `UnsupportedKind` for them.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::io::SeekFrom;
use std::rc::Rc;
use std::sync::Arc;

use arrow_array::{
    FixedSizeListArray, Float64Array, Int32Array, RecordBatch, TimestampNanosecondArray,
};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use base64::Engine as _;
use mcap::sans_io::summary_reader::{SummaryReadEvent, SummaryReader, SummaryReaderOptions};
use mcap::McapError;
use mf4_rs::index::{ByteRangeReader, SliceRangeReader};

use crate::mf4::BoxedRangeReader;
use crate::reader::{ArrowIpc, EncodedChunkIter};
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, EncodedChunk, FetchOpts, SourceKind, SourceMeta,
    TimeRange,
};

/// MCAP file magic — opens and closes every well-formed file.
const MCAP_MAGIC: &[u8] = b"\x89MCAP0\r\n";

/// Bytes occupied by the footer record plus the trailing end magic:
/// 1 opcode + 8 length + 8 summary_start + 8 summary_offset_start +
/// 4 summary_crc + 8 end magic.
const FOOTER_AND_END_MAGIC: u64 = 1 + 8 + 8 + 8 + 4 + 8;

/// Serialized length of an MCAP `MessageHeader`: channel_id(2) + sequence(4) +
/// log_time(8) + publish_time(8).
const MESSAGE_HEADER_LEN: usize = 2 + 4 + 8 + 8;

/// Per-channel routing metadata resolved from the summary. Keyed by topic
/// (the public `ChannelId`).
struct ChannelMeta {
    kind: ChannelKind,
    #[allow(dead_code)]
    dtype: Option<DType>,
    /// MCAP channel id used to filter messages within a decoded chunk.
    mcap_id: u16,
    /// Element count per sample for `Vector` channels (3 for Vector3); 0 otherwise.
    vector_len: usize,
}

/// Routing metadata for a ROS2 (CDR) topic expanded into one Driveline channel
/// per numeric leaf. Keyed by the expanded channel id (`"{topic}.{path}"`).
/// The `registry` is `Arc`-shared across every leaf of the same topic.
struct RosExpanded {
    /// MCAP channel id of the underlying topic, used to filter messages.
    mcap_id: u16,
    /// Shared message-definition registry for the topic's root type.
    registry: Arc<crate::ros::MessageRegistry>,
    /// Dot-separated leaf path passed to `crate::ros::extract`.
    leaf_path: String,
    /// Driveline kind for this leaf: `Scalar`, `Vector`, or `Enum`.
    kind: ChannelKind,
    /// Element count per sample for `Vector` leaves; 0 otherwise.
    width: usize,
}

/// A decodable run of records: either one chunk (chunked file) or the whole
/// data section (unchunked file). `start_time`/`end_time` are the inclusive
/// min/max message `log_time` covered (i64::MIN/MAX for the unchunked
/// catch-all, which is always selected).
#[derive(Clone)]
struct Segment {
    /// File offset of the (possibly compressed) record bytes.
    data_offset: u64,
    /// Length of the record bytes at `data_offset`.
    compressed_size: u64,
    /// Decompressed length (used to size the output buffer).
    uncompressed_size: u64,
    /// MCAP compression string: `""`, `"zstd"`, or unsupported.
    compression: String,
    start_time: i64,
    end_time: i64,
    /// Channel ids known to be present (from the chunk's message-index keys).
    /// Empty means "unknown — assume all channels present".
    channel_ids: Vec<u16>,
}

impl Segment {
    fn has_channel(&self, mcap_id: u16) -> bool {
        self.channel_ids.is_empty() || self.channel_ids.contains(&mcap_id)
    }
}

/// A decoded scalar/vector/enum value, paired with a timestamp during a fetch.
enum ParsedValue {
    Scalar(f64),
    Vector(Vec<f64>),
    Enum(i32),
}

/// Stateful, bounded cursor over a video channel. Holds only owned data (no
/// reference to the reader or its byte source), so it can live in a
/// thread-local slab on the wasm side and be advanced one batch at a time via
/// [`McapReader::video_pull`].
pub struct McapVideoCursor {
    mcap_id: u16,
    /// Indices into `McapReader::segments` that bear this video channel, in
    /// time order.
    chunk_order: Vec<usize>,
    /// Position in `chunk_order` of the next segment to decode.
    next: usize,
    /// Decoded-but-not-yet-yielded chunks from already-decoded segments.
    pending: VecDeque<EncodedChunk>,
    done: bool,
}

/// How many decompressed chunk record buffers to keep resident. Bounds memory
/// to a handful of recently-touched chunks so a video re-seek or a fetch over
/// an already-touched window doesn't re-range-read and re-decompress, without
/// holding the whole file.
const CHUNK_CACHE_CAP: usize = 8;

/// How many parsed per-(segment, channel) sample runs to keep resident. A
/// dense dashboard refetches many channels over the same window on every seek;
/// caching the parsed samples turns those repeats into a slice instead of
/// re-parsing every message's JSON. FIFO-bounded so panning over a long file
/// can't grow unbounded.
const VALUE_CACHE_CAP: usize = 256;

/// One parsed-sample cache entry: `((segment index, mcap channel id), time-sorted samples)`.
type ValueCacheEntry = ((usize, u16), Rc<Vec<(i64, ParsedValue)>>);

pub struct McapReader {
    /// Source of record bytes. `RefCell` because reads take `&mut R` while the
    /// public methods only have `&self`. Never holds the whole file.
    reader: RefCell<BoxedRangeReader>,
    meta: SourceMeta,
    /// Topic → routing metadata.
    channels: HashMap<ChannelId, ChannelMeta>,
    /// Expanded ROS2 channel id (`"{topic}.{path}"`) → ROS routing metadata.
    /// Disjoint from `channels`: a ROS2-expanded topic surfaces its leaves
    /// here, not as a single `Bytes` channel.
    ros_expanded: HashMap<ChannelId, RosExpanded>,
    /// Decodable segments, sorted by `start_time`.
    segments: Vec<Segment>,
    /// FIFO cache of decompressed chunk record buffers, keyed by segment index.
    /// Feeds both video decode (re-seek locality) and signal parsing.
    chunk_cache: RefCell<VecDeque<(usize, Rc<Vec<u8>>)>>,
    /// FIFO cache of parsed signal samples, keyed by `(segment index, mcap
    /// channel id)`. Time-sorted within each entry. Makes repeated pan/seek
    /// fetches over the same window cheap (no re-parse).
    value_cache: RefCell<VecDeque<ValueCacheEntry>>,
}

impl McapReader {
    /// Open an in-memory MCAP blob. Used by native callers and tests; the
    /// bytes are moved into a [`SliceRangeReader`] and read lazily (only the
    /// summary at open, payloads on demand) exactly like the ranged path.
    pub fn open(bytes: &[u8]) -> crate::Result<Self> {
        let file_size = bytes.len() as u64;
        Self::open_ranged(
            BoxedRangeReader::new(SliceRangeReader::new(bytes.to_vec())),
            file_size,
        )
    }

    /// Build a reader that streams record bytes through `reader`. Only the
    /// summary section is read here; message payloads are pulled on demand in
    /// `fetch_range` / `video_pull`.
    pub fn open_ranged(mut reader: BoxedRangeReader, file_size: u64) -> crate::Result<Self> {
        let summary = read_summary(&mut reader, file_size)?;

        // Resolve per-channel routing metadata in a deterministic order.
        let mut ids: Vec<u16> = summary.channels.keys().copied().collect();
        ids.sort_unstable();

        let mut channel_meta: HashMap<ChannelId, ChannelMeta> = HashMap::with_capacity(ids.len());
        let mut ros_expanded: HashMap<ChannelId, RosExpanded> = HashMap::new();
        // Topics (mcap ids) that were expanded into ROS2 leaf channels and so
        // must NOT also surface as their own default (Bytes) channel.
        let mut ros_topics: std::collections::HashSet<u16> = std::collections::HashSet::new();
        for &id in &ids {
            let ch = &summary.channels[&id];
            let (kind, dtype) = match ch.schema.as_deref() {
                Some(s) => infer_channel_kind(&s.name, &s.encoding),
                None => (ChannelKind::Bytes, None),
            };

            // ROS2-over-MCAP expansion: `message_encoding=="cdr"` with a
            // `ros2msg` schema, excluding channels already classified as Video
            // (sensor_msgs/Image et al. keep their existing video path). On any
            // parse failure (IDL, malformed def) we fall back to the default
            // `ChannelMeta` below — the channel just behaves as it did before.
            if kind != ChannelKind::Video && ch.message_encoding == "cdr" {
                if let Some(schema) = ch.schema.as_deref() {
                    if schema.encoding == "ros2msg" {
                        if let Ok(leaves) =
                            try_expand_ros2(&schema.name, &schema.data, &ch.topic, id)
                        {
                            if !leaves.is_empty() {
                                ros_topics.insert(id);
                                for (cid, exp) in leaves {
                                    ros_expanded.insert(cid, exp);
                                }
                                continue;
                            }
                        }
                    }
                }
            }

            let vector_len = if kind == ChannelKind::Vector { 3 } else { 0 };
            channel_meta.insert(
                ch.topic.clone(),
                ChannelMeta {
                    kind,
                    dtype,
                    mcap_id: id,
                    vector_len,
                },
            );
        }

        let chunked = !summary.chunk_indexes.is_empty();

        // Build the segment list.
        let mut segments: Vec<Segment> = Vec::new();
        if chunked {
            for ci in &summary.chunk_indexes {
                let data_offset = ci.compressed_data_offset()?;
                segments.push(Segment {
                    data_offset,
                    compressed_size: ci.compressed_size,
                    uncompressed_size: ci.uncompressed_size,
                    compression: ci.compression.clone(),
                    start_time: ci.message_start_time as i64,
                    end_time: ci.message_end_time as i64,
                    channel_ids: ci.message_index_offsets.keys().copied().collect(),
                });
            }
            segments.sort_by_key(|s| s.start_time);
        } else {
            // Unchunked: one catch-all segment spanning the data section
            // [magic, summary_start). The footer holds `summary_start`.
            let summary_start = read_footer_summary_start(&mut reader, file_size)?;
            let data_start = MCAP_MAGIC.len() as u64;
            let len = summary_start.saturating_sub(data_start);
            segments.push(Segment {
                data_offset: data_start,
                compressed_size: len,
                uncompressed_size: len,
                compression: String::new(),
                start_time: i64::MIN,
                end_time: i64::MAX,
                channel_ids: Vec::new(),
            });
        }

        // Per-channel sample counts and (where available) exact time ranges.
        let mut counts: HashMap<u16, u64> = HashMap::new();
        let mut ranges: HashMap<u16, (i64, i64)> = HashMap::new();
        if chunked {
            // Counts come from the summary statistics; exact per-channel
            // ranges are not carried in the summary, so chunked channels fall
            // back to the file-global range below.
            if let Some(stats) = &summary.stats {
                for (&id, &c) in &stats.channel_message_counts {
                    counts.insert(id, c);
                }
            }
        } else {
            // Unchunked files have no index granularity, so we scan the single
            // data segment once to recover exact counts and ranges. Unchunked
            // MCAPs are small in practice (real-world writers chunk).
            let buf = read_segment_bytes(&mut reader, &segments[0])?;
            for_each_message(&buf, |cid, log_time, _payload| {
                *counts.entry(cid).or_insert(0) += 1;
                let r = ranges.entry(cid).or_insert((log_time, log_time));
                if log_time < r.0 {
                    r.0 = log_time;
                }
                if log_time > r.1 {
                    r.1 = log_time;
                }
            });
        }

        // File-global range.
        let global: Option<(i64, i64)> = if chunked {
            let from_stats = summary
                .stats
                .as_ref()
                .filter(|s| s.message_count > 0)
                .map(|s| {
                    (
                        s.message_start_time as i64,
                        (s.message_end_time as i64).saturating_add(1),
                    )
                });
            from_stats.or_else(|| {
                let lo = summary
                    .chunk_indexes
                    .iter()
                    .map(|c| c.message_start_time as i64)
                    .min();
                let hi = summary
                    .chunk_indexes
                    .iter()
                    .map(|c| c.message_end_time as i64)
                    .max();
                match (lo, hi) {
                    (Some(lo), Some(hi)) => Some((lo, hi.saturating_add(1))),
                    _ => None,
                }
            })
        } else {
            let lo = ranges.values().map(|r| r.0).min();
            let hi = ranges.values().map(|r| r.1).max();
            match (lo, hi) {
                (Some(lo), Some(hi)) => Some((lo, hi.saturating_add(1))),
                _ => None,
            }
        };

        // Per-channel time range helper, shared by the default and ROS2 paths.
        let time_range_for = |id: u16, sample_count: u64| -> TimeRange {
            if sample_count == 0 {
                TimeRange::empty()
            } else if let Some(&(lo, hi)) = ranges.get(&id) {
                TimeRange {
                    start_ns: lo,
                    end_ns: hi.saturating_add(1),
                }
            } else {
                match global {
                    Some((lo, hi)) => TimeRange {
                        start_ns: lo,
                        end_ns: hi,
                    },
                    None => TimeRange::empty(),
                }
            }
        };

        // Public channel list.
        let mut channels: Vec<Channel> = Vec::with_capacity(ids.len());
        for &id in &ids {
            // ROS2-expanded topics surface their leaves below, not as one
            // default channel.
            if ros_topics.contains(&id) {
                continue;
            }
            let ch = &summary.channels[&id];
            let topic = ch.topic.clone();
            let cm = &channel_meta[&topic];
            let sample_count = counts.get(&id).copied().unwrap_or(0);
            let time_range = time_range_for(id, sample_count);
            channels.push(Channel {
                id: topic,
                source_id: String::new(),
                name: ch.topic.clone(),
                kind: cm.kind,
                dtype: cm.dtype,
                unit: ch.metadata.get("unit").cloned(),
                sample_count,
                time_range,
            });
        }

        // ROS2-expanded leaf channels, in a deterministic order (sorted by
        // expanded id). Each shares its underlying topic's per-message count
        // and time range. `id == "{topic}.{path}"` matches the ROS1 bag / db3
        // path convention so the same signal is addressable across readers.
        let mut ros_ids: Vec<&ChannelId> = ros_expanded.keys().collect();
        ros_ids.sort();
        for cid in ros_ids {
            let exp = &ros_expanded[cid];
            let sample_count = counts.get(&exp.mcap_id).copied().unwrap_or(0);
            let time_range = time_range_for(exp.mcap_id, sample_count);
            let dtype = if exp.kind == ChannelKind::Enum {
                Some(DType::I32)
            } else {
                Some(DType::F64)
            };
            channels.push(Channel {
                id: cid.clone(),
                source_id: String::new(),
                name: exp.leaf_path.clone(),
                kind: exp.kind,
                dtype,
                unit: None,
                sample_count,
                time_range,
            });
        }

        let time_range = match global {
            Some((lo, hi)) => TimeRange {
                start_ns: lo,
                end_ns: hi,
            },
            None => TimeRange::empty(),
        };

        Ok(McapReader {
            reader: RefCell::new(reader),
            meta: SourceMeta {
                id: String::new(),
                kind: SourceKind::Mcap,
                time_range,
                channels,
            },
            channels: channel_meta,
            ros_expanded,
            segments,
            chunk_cache: RefCell::new(VecDeque::new()),
            value_cache: RefCell::new(VecDeque::new()),
        })
    }

    pub fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    /// Read+decompress segment `idx`'s record bytes, serving from (and
    /// populating) the bounded chunk cache so a re-touch is a cheap clone.
    fn read_segment(&self, idx: usize) -> crate::Result<Rc<Vec<u8>>> {
        let cached = self
            .chunk_cache
            .borrow()
            .iter()
            .find(|(i, _)| *i == idx)
            .map(|(_, b)| b.clone());
        if let Some(hit) = cached {
            return Ok(hit);
        }
        let seg = self.segments[idx].clone();
        let buf = Rc::new(read_segment_bytes(&mut self.reader.borrow_mut(), &seg)?);
        let mut cache = self.chunk_cache.borrow_mut();
        cache.push_back((idx, buf.clone()));
        while cache.len() > CHUNK_CACHE_CAP {
            cache.pop_front();
        }
        Ok(buf)
    }

    /// Parsed signal samples for one channel within one segment, time-sorted,
    /// served from (and populating) the bounded value cache. Repeated fetches
    /// over the same window reuse this instead of re-parsing message JSON.
    fn parsed_for(
        &self,
        seg_idx: usize,
        mcap_id: u16,
        kind: ChannelKind,
    ) -> crate::Result<Rc<Vec<(i64, ParsedValue)>>> {
        let key = (seg_idx, mcap_id);
        let cached = self
            .value_cache
            .borrow()
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.clone());
        if let Some(hit) = cached {
            return Ok(hit);
        }
        let buf = self.read_segment(seg_idx)?;
        let mut samples: Vec<(i64, ParsedValue)> = Vec::new();
        for_each_message(buf.as_slice(), |cid, log_time, payload| {
            if cid != mcap_id {
                return;
            }
            if let Some(v) = parse_value(kind, payload) {
                samples.push((log_time, v));
            }
        });
        samples.sort_by_key(|s| s.0);
        let samples = Rc::new(samples);
        let mut cache = self.value_cache.borrow_mut();
        cache.push_back((key, samples.clone()));
        while cache.len() > VALUE_CACHE_CAP {
            cache.pop_front();
        }
        Ok(samples)
    }

    pub fn fetch_range(
        &self,
        channel_id: &ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        // ROS2-expanded leaf channels decode CDR on the fly via the shared ROS
        // decoder; everything else takes the existing JSON/foxglove path.
        if self.ros_expanded.contains_key(channel_id) {
            return self.fetch_range_ros2(channel_id, range, opts);
        }

        let cm = self
            .channels
            .get(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        if matches!(
            cm.kind,
            ChannelKind::Video | ChannelKind::Bytes | ChannelKind::PointCloud
        ) {
            return Err(crate::Error::UnsupportedKind);
        }
        let mcap_id = cm.mcap_id;

        let idxs = self.select_segments(mcap_id, range, opts.include_prev);

        // Pull the selected segments' parsed samples (cached) and merge into a
        // single time-sorted view. The `Rc`s are held in `seg_parsed` so the
        // borrowed refs in `merged` stay valid.
        let mut seg_parsed: Vec<Rc<Vec<(i64, ParsedValue)>>> = Vec::with_capacity(idxs.len());
        for i in idxs {
            seg_parsed.push(self.parsed_for(i, mcap_id, cm.kind)?);
        }
        let mut merged: Vec<(i64, &ParsedValue)> = seg_parsed
            .iter()
            .flat_map(|s| s.iter().map(|(t, v)| (*t, v)))
            .collect();
        merged.sort_by_key(|r| r.0);

        let timestamps: Vec<i64> = merged.iter().map(|r| r.0).collect();
        let start_idx = timestamps.partition_point(|&t| t < range.start_ns);
        let end_idx = timestamps
            .partition_point(|&t| t < range.end_ns)
            .max(start_idx);
        let lo = if opts.include_prev && start_idx > 0 {
            start_idx - 1
        } else {
            start_idx
        };

        let ts_slice = &timestamps[lo..end_idx];
        let val_refs: Vec<&ParsedValue> = merged[lo..end_idx].iter().map(|r| r.1).collect();

        match cm.kind {
            ChannelKind::Scalar => {
                let vals: Vec<f64> = val_refs.iter().map(|v| parsed_scalar_as_f64(v)).collect();
                build_scalar_ipc_raw(ts_slice, &vals)
            }
            ChannelKind::Vector => {
                let n = if cm.vector_len > 0 { cm.vector_len } else { 3 };
                build_vector_ipc(ts_slice, &val_refs, n)
            }
            ChannelKind::Enum => build_enum_ipc(ts_slice, &val_refs),
            ChannelKind::Video | ChannelKind::Bytes | ChannelKind::PointCloud => {
                unreachable!("guarded above")
            }
        }
    }

    /// Select segment indices overlapping `[start, end)` that bear `mcap_id`,
    /// optionally including the latest strictly-preceding segment so a
    /// step-hold renderer's leading sample is available. Sorted ascending.
    fn select_segments(&self, mcap_id: u16, range: TimeRange, include_prev: bool) -> Vec<usize> {
        let mut idxs: Vec<usize> = (0..self.segments.len())
            .filter(|&i| {
                let s = &self.segments[i];
                s.end_time >= range.start_ns
                    && s.start_time < range.end_ns
                    && s.has_channel(mcap_id)
            })
            .collect();
        if include_prev {
            if let Some(prev) = (0..self.segments.len())
                .filter(|&i| {
                    let s = &self.segments[i];
                    s.start_time < range.start_ns && s.has_channel(mcap_id)
                })
                .max_by_key(|&i| self.segments[i].start_time)
            {
                if !idxs.contains(&prev) {
                    idxs.push(prev);
                }
            }
        }
        idxs.sort_unstable();
        idxs
    }

    /// Fetch a ROS2-expanded leaf channel: read the underlying topic's CDR
    /// messages over the selected segments and decode the leaf value out of
    /// each with the shared ROS decoder. Honors `include_prev` like the JSON
    /// path; individual messages that fail to decode are skipped.
    fn fetch_range_ros2(
        &self,
        channel_id: &ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        let exp = &self.ros_expanded[channel_id];
        let mcap_id = exp.mcap_id;

        let idxs = self.select_segments(mcap_id, range, opts.include_prev);

        // Decode (log_time, value) for every message of this topic in the
        // selected segments. Re-uses `read_segment` (chunk cache); the JSON
        // value cache is keyed for the foxglove path and bypassed here.
        let mut samples: Vec<(i64, ParsedValue)> = Vec::new();
        for i in idxs {
            let buf = self.read_segment(i)?;
            for_each_message(buf.as_slice(), |cid, log_time, payload| {
                if cid != mcap_id {
                    return;
                }
                match crate::ros::extract(
                    &exp.registry,
                    payload,
                    crate::ros::Wire::Cdr,
                    &exp.leaf_path,
                ) {
                    Ok(crate::ros::Extracted::Scalar(f)) => {
                        samples.push((log_time, ParsedValue::Scalar(f)));
                    }
                    // A Scalar leaf (dims == 1) over an integer field surfaces
                    // as Enum from the decoder; widen to f64 for the scalar batch.
                    Ok(crate::ros::Extracted::Enum(v)) => {
                        samples.push((log_time, ParsedValue::Scalar(v as f64)));
                    }
                    Ok(crate::ros::Extracted::Vector(v)) => {
                        samples.push((log_time, ParsedValue::Vector(v)));
                    }
                    // Skip a message that fails to decode rather than failing
                    // the whole range.
                    Err(_) => {}
                }
            });
        }
        samples.sort_by_key(|s| s.0);

        let timestamps: Vec<i64> = samples.iter().map(|s| s.0).collect();
        let start_idx = timestamps.partition_point(|&t| t < range.start_ns);
        let end_idx = timestamps
            .partition_point(|&t| t < range.end_ns)
            .max(start_idx);
        let lo = if opts.include_prev && start_idx > 0 {
            start_idx - 1
        } else {
            start_idx
        };

        let ts_slice = &timestamps[lo..end_idx];
        let val_refs: Vec<&ParsedValue> = samples[lo..end_idx].iter().map(|s| &s.1).collect();

        match exp.kind {
            ChannelKind::Scalar => {
                let vals: Vec<f64> = val_refs.iter().map(|v| parsed_scalar_as_f64(v)).collect();
                build_scalar_ipc_raw(ts_slice, &vals)
            }
            ChannelKind::Vector => {
                let n = if exp.width > 0 { exp.width } else { 3 };
                build_vector_ipc(ts_slice, &val_refs, n)
            }
            _ => Err(crate::Error::UnsupportedKind),
        }
    }

    /// Open a bounded, lazy video cursor, snapping to the keyframe at or
    /// before `from_pts_ns`. Only the chunk(s) needed to locate that keyframe
    /// are decoded here; subsequent chunks stream on demand via
    /// [`Self::video_pull`].
    pub fn open_video_cursor(
        &self,
        channel_id: &ChannelId,
        from_pts_ns: i64,
    ) -> crate::Result<McapVideoCursor> {
        let cm = self
            .channels
            .get(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;
        if cm.kind != ChannelKind::Video {
            return Err(crate::Error::UnsupportedKind);
        }
        let mcap_id = cm.mcap_id;

        let chunk_order: Vec<usize> = (0..self.segments.len())
            .filter(|&i| self.segments[i].has_channel(mcap_id))
            .collect();

        let mut cursor = McapVideoCursor {
            mcap_id,
            chunk_order,
            next: 0,
            pending: VecDeque::new(),
            done: false,
        };

        // Walk candidate segments (those that could start at/before the
        // target) newest-first, looking for the latest keyframe <= from_pts.
        let candidates: Vec<usize> = cursor
            .chunk_order
            .iter()
            .enumerate()
            .filter(|&(_, &si)| self.segments[si].start_time <= from_pts_ns)
            .map(|(pos, _)| pos)
            .collect();

        let mut found = false;
        for &pos in candidates.iter().rev() {
            let samples = self.decode_video_samples(cursor.chunk_order[pos], mcap_id)?;
            if let Some(kf) = samples
                .iter()
                .rposition(|c| c.is_keyframe && c.pts_ns <= from_pts_ns)
            {
                let start_pts = samples[kf].pts_ns;
                cursor.pending = samples
                    .into_iter()
                    .filter(|c| c.pts_ns >= start_pts)
                    .collect();
                cursor.next = pos + 1;
                found = true;
                break;
            }
        }

        // No keyframe at/before the target (target precedes every keyframe, or
        // the earlier chunks carry none): start at the first keyframe overall
        // so callers always get a decodable prefix.
        if !found {
            for pos in 0..cursor.chunk_order.len() {
                let samples = self.decode_video_samples(cursor.chunk_order[pos], mcap_id)?;
                if let Some(kf) = samples.iter().position(|c| c.is_keyframe) {
                    let start_pts = samples[kf].pts_ns;
                    cursor.pending = samples
                        .into_iter()
                        .filter(|c| c.pts_ns >= start_pts)
                        .collect();
                    cursor.next = pos + 1;
                    found = true;
                    break;
                }
            }
        }

        if !found {
            cursor.done = true;
        }
        Ok(cursor)
    }

    /// Pull up to `max_n` encoded access units, decoding further chunks only
    /// as needed. An empty result means end-of-stream.
    pub fn video_pull(
        &self,
        cursor: &mut McapVideoCursor,
        max_n: usize,
    ) -> crate::Result<Vec<EncodedChunk>> {
        let mut out = Vec::new();
        while out.len() < max_n {
            if let Some(c) = cursor.pending.pop_front() {
                out.push(c);
                continue;
            }
            if cursor.done || cursor.next >= cursor.chunk_order.len() {
                cursor.done = true;
                break;
            }
            let si = cursor.chunk_order[cursor.next];
            cursor.next += 1;
            let samples = self.decode_video_samples(si, cursor.mcap_id)?;
            cursor.pending.extend(samples);
        }
        Ok(out)
    }

    /// Convenience for native callers and tests: fully materialise a video
    /// stream from the snapped keyframe forward. The wasm path uses the
    /// bounded cursor (`open_video_cursor` + `video_pull`) instead.
    pub fn video_stream(
        &self,
        channel_id: &ChannelId,
        from_pts_ns: i64,
    ) -> crate::Result<EncodedChunkIter> {
        let mut cursor = self.open_video_cursor(channel_id, from_pts_ns)?;
        let mut all: Vec<EncodedChunk> = Vec::new();
        loop {
            let batch = self.video_pull(&mut cursor, 256)?;
            if batch.is_empty() {
                break;
            }
            all.extend(batch);
        }
        Ok(Box::new(all.into_iter()))
    }

    /// Decode a segment and return its video-channel access units (Annex-B),
    /// sorted by pts.
    fn decode_video_samples(
        &self,
        seg_idx: usize,
        mcap_id: u16,
    ) -> crate::Result<Vec<EncodedChunk>> {
        let buf = self.read_segment(seg_idx)?;
        let mut out: Vec<EncodedChunk> = Vec::new();
        for_each_message(buf.as_slice(), |cid, log_time, payload| {
            if cid != mcap_id {
                return;
            }
            let annex_b =
                extract_video_bytes_from_json(payload).unwrap_or_else(|| payload.to_vec());
            let is_keyframe = is_keyframe(&annex_b);
            out.push(EncodedChunk {
                pts_ns: log_time,
                is_keyframe,
                data: annex_b,
            });
        });
        out.sort_by_key(|c| c.pts_ns);
        Ok(out)
    }
}

/// Drive the sans-IO [`SummaryReader`] over `reader` to pull the summary
/// section. `file_size` is supplied so the reader seeks directly to the footer
/// rather than relying on a seek-to-end probe.
fn read_summary(reader: &mut BoxedRangeReader, file_size: u64) -> crate::Result<mcap::Summary> {
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

/// Read the footer at the tail of the file and return its `summary_start`
/// offset. Only used for unchunked files (to bound the data section).
fn read_footer_summary_start(reader: &mut BoxedRangeReader, file_size: u64) -> crate::Result<u64> {
    if file_size < FOOTER_AND_END_MAGIC {
        return Err(crate::Error::McapMissingSummary);
    }
    let buf = reader.read_range(file_size - FOOTER_AND_END_MAGIC, FOOTER_AND_END_MAGIC)?;
    // [op:1][len:8][summary_start:8][summary_offset_start:8][crc:4][magic:8]
    let summary_start = u64::from_le_bytes(buf[9..17].try_into().expect("8-byte slice"));
    Ok(summary_start)
}

/// Read a segment's bytes through `reader` and decompress them.
fn read_segment_bytes(reader: &mut BoxedRangeReader, seg: &Segment) -> crate::Result<Vec<u8>> {
    if seg.compressed_size == 0 {
        return Ok(Vec::new());
    }
    let comp = reader.read_range(seg.data_offset, seg.compressed_size)?;
    decompress_records(&seg.compression, comp, seg.uncompressed_size as usize)
}

/// Decompress a chunk's record stream. zstd uses the pure-Rust `ruzstd`
/// decoder so the wasm build needs no C `zstd-sys`.
fn decompress_records(
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
fn for_each_message(buf: &[u8], mut f: impl FnMut(u16, i64, &[u8])) {
    use mcap::records::op;
    let mut off = 0usize;
    while off + 9 <= buf.len() {
        let opcode = buf[off];
        let len =
            u64::from_le_bytes(buf[off + 1..off + 9].try_into().expect("8-byte slice")) as usize;
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
                let log_time =
                    u64::from_le_bytes(body[6..14].try_into().expect("8-byte slice")) as i64;
                f(channel_id, log_time, &body[MESSAGE_HEADER_LEN..]);
            }
        }
        off = body_end;
    }
}

/// Parse a message payload into a `ParsedValue` for the given channel kind.
fn parse_value(kind: ChannelKind, payload: &[u8]) -> Option<ParsedValue> {
    match kind {
        ChannelKind::Scalar => parse_scalar_json(payload).map(ParsedValue::Scalar),
        ChannelKind::Vector => {
            parse_vector3_json(payload).map(|(x, y, z)| ParsedValue::Vector(vec![x, y, z]))
        }
        ChannelKind::Enum => parse_enum_json(payload).map(ParsedValue::Enum),
        _ => None,
    }
}

/// Attempt to expand a ROS2 (`ros2msg`) schema into one `RosExpanded` routing
/// entry per numeric leaf. Returns the `(expanded_channel_id, RosExpanded)`
/// pairs, or an error if the definition fails to parse (IDL / malformed) — the
/// caller falls back to the channel's default behaviour in that case.
///
/// `schema_name` is the ROS root type (e.g. `sensor_msgs/msg/Imu`),
/// `def_bytes` the UTF-8 concatenated `.msg` text, `topic` the MCAP topic
/// (which prefixes every expanded id), `mcap_id` the underlying channel id.
fn try_expand_ros2(
    schema_name: &str,
    def_bytes: &[u8],
    topic: &str,
    mcap_id: u16,
) -> Result<Vec<(ChannelId, RosExpanded)>, crate::ros::RosDecodeError> {
    let def_text = std::str::from_utf8(def_bytes)
        .map_err(|_| crate::ros::RosDecodeError::PathNotFound("non-utf8 schema".into()))?;
    let registry = crate::ros::MessageRegistry::parse(schema_name, def_text)?;
    let registry = Arc::new(registry);

    let mut out: Vec<(ChannelId, RosExpanded)> = Vec::new();
    for leaf in crate::ros::numeric_leaves(&registry) {
        // dims == 0 is a dynamic numeric array: not a single plottable signal.
        let (kind, width) = match leaf.dims {
            0 => continue,
            1 => (ChannelKind::Scalar, 0),
            n => (ChannelKind::Vector, n),
        };
        let id = format!("{topic}.{}", leaf.path);
        out.push((
            id,
            RosExpanded {
                mcap_id,
                registry: registry.clone(),
                leaf_path: leaf.path,
                kind,
                width,
            },
        ));
    }
    Ok(out)
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
    values: &[&ParsedValue],
    n: usize,
) -> crate::Result<ArrowIpc> {
    let schema = vector_schema(n);
    let ts = TimestampNanosecondArray::from(timestamps.to_vec()).with_timezone("UTC");

    let mut flat = Vec::with_capacity(values.len() * n);
    for v in values {
        match v {
            ParsedValue::Vector(inner) if inner.len() == n => flat.extend_from_slice(inner),
            _ => flat.extend(std::iter::repeat_n(f64::NAN, n)),
        }
    }
    let child = Arc::new(Float64Array::from(flat));
    let inner_field = Arc::new(Field::new("item", DataType::Float64, false));
    let list = FixedSizeListArray::new(inner_field, n as i32, child, None);

    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(list)])?;
    write_ipc(schema, batch)
}

fn build_enum_ipc(timestamps: &[i64], values: &[&ParsedValue]) -> crate::Result<ArrowIpc> {
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
    fn surfaces_video_keyframes_from_fixture() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");

        // Fixture writes 3 video access units, each SPS+IDR (all keyframes).
        let chunks: Vec<_> = r
            .video_stream(&"/camera/front".to_string(), T0 - 1)
            .expect("video_stream")
            .collect();
        assert_eq!(chunks.len(), 3, "expected 3 access units");
        assert_eq!(chunks.iter().filter(|c| c.is_keyframe).count(), 3);
        for w in chunks.windows(2) {
            assert!(w[1].pts_ns > w[0].pts_ns, "access units must be ordered");
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
            .fetch_range(&speed_id, range, FetchOpts { include_prev: true })
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
        // /vehicle/speed spans 90 ms → end_ns is half-open (+1 on last).
        assert_eq!(
            speed.time_range.end_ns - speed.time_range.start_ns,
            90_000_000 + 1
        );

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
            assert!(
                w[1].pts_ns > w[0].pts_ns,
                "chunks must be strictly monotonic"
            );
        }
        // Fixture payload is SPS + IDR on every message, so each is a keyframe.
        for c in &chunks {
            assert!(c.is_keyframe);
            assert!(!c.data.is_empty(), "payload bytes preserved");
        }
    }

    #[test]
    fn video_pull_is_bounded_and_resumable() {
        let bytes = crate::fixtures::short_mcap_bytes().expect("generate mcap");
        let r = McapReader::open(&bytes).expect("open");

        let mut cursor = r
            .open_video_cursor(&"/camera/front".to_string(), T0 - 1)
            .expect("cursor");
        let first = r.video_pull(&mut cursor, 1).expect("pull");
        assert_eq!(first.len(), 1, "max_n caps the batch");
        assert_eq!(first[0].pts_ns, T0);

        // Drain the rest; the cursor resumes where it left off.
        let mut rest = Vec::new();
        loop {
            let b = r.video_pull(&mut cursor, 8).expect("pull");
            if b.is_empty() {
                break;
            }
            rest.extend(b);
        }
        assert_eq!(rest.len(), 2);
        assert_eq!(rest[0].pts_ns, T0 + 30_000_000);
        assert_eq!(rest[1].pts_ns, T0 + 60_000_000);
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
        assert_eq!(parse_enum_json(br#"{"value": 2147483647}"#), Some(i32::MAX));
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

    /// `short_mcap_zstd_bytes()` writes the same four-channel corpus as
    /// `short_mcap_bytes()` but with chunk-level zstd compression. The lazy
    /// reader must decode those chunks on demand (via `ruzstd`) and surface an
    /// identical channel set + sample counts.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn zstd_compressed_fixture_round_trips_through_reader() {
        let bytes = crate::fixtures::short_mcap_zstd_bytes().expect("generate zstd mcap");
        // MCAP magic: 0x89 'M' 'C' 'A' 'P' '0' '\r' '\n'.
        assert_eq!(
            &bytes[..5],
            b"\x89MCAP",
            "zstd fixture must start with MCAP magic"
        );
        let r = McapReader::open(&bytes).expect("open zstd mcap");

        let plain = crate::fixtures::short_mcap_bytes().expect("generate plain mcap");
        let r_plain = McapReader::open(&plain).expect("open plain mcap");

        let mut zstd_names: Vec<_> = r.meta().channels.iter().map(|c| c.name.clone()).collect();
        let mut plain_names: Vec<_> = r_plain
            .meta()
            .channels
            .iter()
            .map(|c| c.name.clone())
            .collect();
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

        // Lazy ranged fetch over a zstd-chunked file must decode the right rows.
        let ipc = r
            .fetch_range(
                &"/vehicle/speed".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .expect("fetch");
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 10);

        // And video streams from a zstd chunk too.
        let chunks: Vec<_> = r
            .video_stream(&"/camera/front".to_string(), i64::MIN)
            .expect("video_stream")
            .collect();
        assert_eq!(chunks.len(), 3);
    }
}
