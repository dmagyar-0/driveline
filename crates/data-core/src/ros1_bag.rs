//! `Ros1BagReader`: a minimal pure-Rust reader for ROS1 `.bag` files
//! (rosbag format v2.0).
//!
//! The bag is parsed whole-file in memory by [`Ros1BagReader::open`]. Each ROS
//! *topic* (connection) is expanded into one Driveline [`Channel`] per numeric
//! leaf of its message type, using the shared dynamic decoder in
//! [`crate::ros`]. The channel id is `"{topic}.{leaf_path}"`, e.g.
//! `/turtle1/pose.x` or `/turtle1/cmd_vel.linear.x`. Messages are decoded
//! lazily in [`fetch_range`](Ros1BagReader::fetch_range) — `open` only retains
//! each message's `(time_ns, payload)`.
//!
//! ## Format (rosbag v2.0)
//!
//! The file starts with the ASCII magic `#ROSBAG V2.0\n`, then a stream of
//! records. Each record is:
//!
//! ```text
//! <u32 LE header_len><header bytes><u32 LE data_len><data bytes>
//! ```
//!
//! A *header* is a sequence of `<u32 LE field_len><name=value>` pairs; the
//! `op=<1 byte>` field gives the record type. We handle:
//!
//! - `0x03` Bag header (ignored beyond skipping).
//! - `0x05` Chunk: holds a (possibly compressed) blob of concatenated
//!   Connection + Message Data records. Only `compression=none` is supported;
//!   `bz2`/`lz4` return [`crate::Error::Ros1Bag`] (no compression dependency is
//!   pulled in just for this — the committed fixture is uncompressed).
//! - `0x07` Connection: maps a connection id to `{topic, type, registry}`.
//! - `0x02` Message Data: a `(conn, time)` header + raw ROS1 payload.
//! - `0x04` Index Data / `0x06` Chunk Info: skipped.
//!
//! Connection / Message Data records also appear directly in the top-level
//! stream in unchunked bags; both layouts are handled.

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::{FixedSizeListArray, Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};

use crate::reader::{ArrowIpc, Reader};
use crate::ros::{extract, numeric_leaves, Extracted, MessageRegistry, Wire};
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

const MAGIC: &[u8] = b"#ROSBAG V2.0\n";

const OP_BAG_HEADER: u8 = 0x03;
const OP_CHUNK: u8 = 0x05;
const OP_CONNECTION: u8 = 0x07;
const OP_MESSAGE_DATA: u8 = 0x02;

/// Image-like message types we skip (no scalar channels): a later phase adds
/// video.
fn is_image_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "sensor_msgs/Image" | "sensor_msgs/CompressedImage"
    )
}

/// One decoded connection: its topic, message type, parsed registry, and the
/// time-sorted list of message `(time_ns, payload)`.
struct Connection {
    topic: String,
    #[allow(dead_code)]
    msg_type: String,
    registry: MessageRegistry,
    /// `(time_ns, payload)` sorted ascending by time.
    messages: Vec<(i64, Vec<u8>)>,
}

/// In-progress accumulator while walking records (before sorting / channel
/// expansion).
struct Builder {
    /// conn id -> (topic, msg_type, registry)
    conns: HashMap<u32, (String, String, MessageRegistry)>,
    /// conn id -> messages (unsorted)
    messages: HashMap<u32, Vec<(i64, Vec<u8>)>>,
}

impl Builder {
    fn new() -> Self {
        Self {
            conns: HashMap::new(),
            messages: HashMap::new(),
        }
    }
}

pub struct Ros1BagReader {
    meta: SourceMeta,
    /// Topic -> connection (used by `fetch_range` to resolve `topic.path`).
    by_topic: HashMap<String, Connection>,
}

// ---------------------------------------------------------------------------
// Low-level framing helpers
// ---------------------------------------------------------------------------

/// Read a little-endian `u32` at `off`, advancing it. Returns `None` on EOF.
fn read_u32(buf: &[u8], off: &mut usize) -> Option<u32> {
    let end = off.checked_add(4)?;
    if end > buf.len() {
        return None;
    }
    let v = u32::from_le_bytes(buf[*off..end].try_into().ok()?);
    *off = end;
    Some(v)
}

/// Read `len` bytes at `off` as a sub-slice, advancing it. Returns `None` on
/// EOF.
fn read_slice<'a>(buf: &'a [u8], off: &mut usize, len: usize) -> Option<&'a [u8]> {
    let end = off.checked_add(len)?;
    if end > buf.len() {
        return None;
    }
    let s = &buf[*off..end];
    *off = end;
    Some(s)
}

/// A parsed record: its header field map and its data payload.
struct Record<'a> {
    header: HashMap<String, &'a [u8]>,
    data: &'a [u8],
}

impl Record<'_> {
    fn op(&self) -> Option<u8> {
        self.header.get("op").and_then(|v| v.first().copied())
    }
}

/// Parse a header blob (a sequence of `<u32 len><name=value>` fields) into a
/// map. Borrows from `blob`.
fn parse_header(blob: &[u8]) -> Result<HashMap<String, &[u8]>, crate::Error> {
    let mut map = HashMap::new();
    let mut off = 0usize;
    while off < blob.len() {
        let field_len =
            read_u32(blob, &mut off).ok_or_else(|| err("truncated header field length"))? as usize;
        let field =
            read_slice(blob, &mut off, field_len).ok_or_else(|| err("truncated header field"))?;
        // Split on the first '='.
        let eq = field
            .iter()
            .position(|&b| b == b'=')
            .ok_or_else(|| err("header field missing '='"))?;
        let name = std::str::from_utf8(&field[..eq])
            .map_err(|_| err("header field name not utf-8"))?
            .to_string();
        map.insert(name, &field[eq + 1..]);
    }
    Ok(map)
}

/// Read one record (header + data) from `buf` at `off`, advancing it.
fn read_record<'a>(buf: &'a [u8], off: &mut usize) -> Result<Record<'a>, crate::Error> {
    let header_len =
        read_u32(buf, off).ok_or_else(|| err("truncated record header length"))? as usize;
    let header_bytes =
        read_slice(buf, off, header_len).ok_or_else(|| err("truncated record header"))?;
    let header = parse_header(header_bytes)?;
    let data_len = read_u32(buf, off).ok_or_else(|| err("truncated record data length"))? as usize;
    let data = read_slice(buf, off, data_len).ok_or_else(|| err("truncated record data"))?;
    Ok(Record { header, data })
}

fn err(msg: impl Into<String>) -> crate::Error {
    crate::Error::Ros1Bag(msg.into())
}

/// Read a little-endian `u32` from the first 4 bytes of a header value field.
fn field_u32(rec: &Record, key: &str) -> Result<u32, crate::Error> {
    let v = rec
        .header
        .get(key)
        .ok_or_else(|| err(format!("record header missing `{key}`")))?;
    if v.len() < 4 {
        return Err(err(format!("header field `{key}` too short for u32")));
    }
    Ok(u32::from_le_bytes(v[..4].try_into().unwrap()))
}

// ---------------------------------------------------------------------------
// Record handling
// ---------------------------------------------------------------------------

/// Process a Connection record: parse its data blob (itself a header-style
/// key=value map) for `topic`, `type`, and `message_definition`, build a
/// registry, and register it under its connection id.
fn handle_connection(rec: &Record, builder: &mut Builder) -> Result<(), crate::Error> {
    let conn_id = field_u32(rec, "conn")?;
    // The connection's DATA payload is a header-style blob.
    let data_fields = parse_header(rec.data)?;

    let topic = data_fields
        .get("topic")
        .and_then(|b| std::str::from_utf8(b).ok())
        // Fall back to the topic in the record header (also present).
        .or_else(|| {
            rec.header
                .get("topic")
                .and_then(|b| std::str::from_utf8(b).ok())
        })
        .ok_or_else(|| err("connection missing `topic`"))?
        .to_string();

    let msg_type = data_fields
        .get("type")
        .and_then(|b| std::str::from_utf8(b).ok())
        .ok_or_else(|| err("connection missing `type`"))?
        .to_string();

    let message_definition = data_fields
        .get("message_definition")
        .and_then(|b| std::str::from_utf8(b).ok())
        .ok_or_else(|| err("connection missing `message_definition`"))?;

    // A connection id may legitimately repeat across the chunk + index; keep
    // the first successful parse.
    if builder.conns.contains_key(&conn_id) {
        return Ok(());
    }

    let registry = MessageRegistry::parse(&msg_type, message_definition)
        .map_err(|e| err(format!("parse {msg_type}: {e}")))?;

    builder.conns.insert(conn_id, (topic, msg_type, registry));
    Ok(())
}

/// Process a Message Data record: pull `conn` and `time`, store the raw payload.
fn handle_message(rec: &Record, builder: &mut Builder) -> Result<(), crate::Error> {
    let conn_id = field_u32(rec, "conn")?;
    let time = rec
        .header
        .get("time")
        .ok_or_else(|| err("message data missing `time`"))?;
    if time.len() < 8 {
        return Err(err("message `time` field too short"));
    }
    let secs = u32::from_le_bytes(time[0..4].try_into().unwrap()) as i64;
    let nsecs = u32::from_le_bytes(time[4..8].try_into().unwrap()) as i64;
    let time_ns = secs * 1_000_000_000 + nsecs;

    builder
        .messages
        .entry(conn_id)
        .or_default()
        .push((time_ns, rec.data.to_vec()));
    Ok(())
}

/// Walk a stream of records (the top-level body, or a chunk's inner stream),
/// dispatching Connection / Message Data records into `builder`. Chunks
/// encountered at the top level are descended into.
fn walk_records(buf: &[u8], builder: &mut Builder, top_level: bool) -> Result<(), crate::Error> {
    let mut off = 0usize;
    while off < buf.len() {
        let rec = read_record(buf, &mut off)?;
        match rec.op() {
            Some(OP_CONNECTION) => handle_connection(&rec, builder)?,
            Some(OP_MESSAGE_DATA) => handle_message(&rec, builder)?,
            Some(OP_CHUNK) if top_level => handle_chunk(&rec, builder)?,
            // Bag header, index, chunk info, nested chunks: skip.
            _ => {}
        }
    }
    Ok(())
}

/// Process a Chunk record: only `compression=none` is supported. Its data is an
/// inner record stream of Connection + Message Data records.
fn handle_chunk(rec: &Record, builder: &mut Builder) -> Result<(), crate::Error> {
    let compression = rec
        .header
        .get("compression")
        .and_then(|b| std::str::from_utf8(b).ok())
        .unwrap_or("none");
    if compression != "none" {
        return Err(err(format!(
            "unsupported chunk compression `{compression}` (only `none` is supported)"
        )));
    }
    walk_records(rec.data, builder, false)
}

// ---------------------------------------------------------------------------
// Channel expansion
// ---------------------------------------------------------------------------

impl Ros1BagReader {
    fn from_builder(builder: Builder) -> Result<Self, crate::Error> {
        let mut by_topic: HashMap<String, Connection> = HashMap::new();
        let mut channels: Vec<Channel> = Vec::new();
        let mut overall: Option<(i64, i64)> = None;

        // Deterministic order over connection ids for stable channel ordering.
        let mut conn_ids: Vec<u32> = builder.conns.keys().copied().collect();
        conn_ids.sort_unstable();

        for conn_id in conn_ids {
            let (topic, msg_type, registry) = builder.conns.get(&conn_id).unwrap();
            let mut messages = builder.messages.get(&conn_id).cloned().unwrap_or_default();
            messages.sort_by_key(|(t, _)| *t);

            // Skip image/video topics for now (no channels), but still keep the
            // connection so we don't crash on lookups.
            let make_channels = !is_image_type(msg_type);

            let (conn_start, conn_end) = match (messages.first(), messages.last()) {
                (Some((a, _)), Some((b, _))) => (*a, b.saturating_add(1)),
                _ => (0, 0),
            };
            let conn_range = TimeRange {
                start_ns: conn_start,
                end_ns: conn_end,
            };
            if !messages.is_empty() {
                overall = Some(match overall {
                    Some((s, e)) => (s.min(conn_start), e.max(conn_end)),
                    None => (conn_start, conn_end),
                });
            }

            if make_channels {
                for leaf in numeric_leaves(registry) {
                    // Dynamic-length arrays (dims == 0) are not plottable as a
                    // fixed channel.
                    if leaf.dims == 0 {
                        continue;
                    }
                    let id = format!("{topic}.{}", leaf.path);
                    let (kind, dtype) = if leaf.dims == 1 {
                        (ChannelKind::Scalar, Some(DType::F64))
                    } else {
                        (ChannelKind::Vector, Some(DType::F64))
                    };
                    channels.push(Channel {
                        id: id.clone(),
                        source_id: String::new(),
                        name: id,
                        kind,
                        dtype,
                        unit: None,
                        sample_count: messages.len() as u64,
                        time_range: conn_range,
                    });
                }
            }

            by_topic.insert(
                topic.clone(),
                Connection {
                    topic: topic.clone(),
                    msg_type: msg_type.clone(),
                    registry: registry.clone(),
                    messages,
                },
            );
        }

        let time_range = match overall {
            Some((s, e)) => TimeRange {
                start_ns: s,
                end_ns: e,
            },
            None => TimeRange::empty(),
        };

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::Ros1,
            time_range,
            channels,
        };

        Ok(Ros1BagReader { meta, by_topic })
    }

    /// Resolve a `"{topic}.{path}"` channel id to its connection and the field
    /// path within the message. Topics contain `/` and may themselves contain
    /// `.`-free segments, so we match against known topics by longest prefix.
    fn resolve<'a>(&'a self, channel_id: &str) -> Option<(&'a Connection, String)> {
        // Try every known topic; the path is the remainder after `"{topic}."`.
        // Prefer the longest matching topic (defensive against topic names that
        // are prefixes of one another).
        let mut best: Option<(&Connection, String)> = None;
        for (topic, conn) in &self.by_topic {
            if let Some(rest) = channel_id.strip_prefix(topic.as_str()) {
                if let Some(path) = rest.strip_prefix('.') {
                    let better = match &best {
                        Some((c, _)) => topic.len() > c.topic.len(),
                        None => true,
                    };
                    if better {
                        best = Some((conn, path.to_string()));
                    }
                }
            }
        }
        best
    }
}

// ---------------------------------------------------------------------------
// Arrow batch construction
// ---------------------------------------------------------------------------

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

fn write_ipc(schema: Arc<Schema>, batch: RecordBatch) -> crate::Result<ArrowIpc> {
    let mut buf = Vec::new();
    {
        let mut w = FileWriter::try_new(&mut buf, &schema)?;
        w.write(&batch)?;
        w.finish()?;
    }
    Ok(buf)
}

impl Reader for Ros1BagReader {
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        if bytes.len() < MAGIC.len() || &bytes[..MAGIC.len()] != MAGIC {
            return Err(err("not a rosbag v2.0 file (bad magic)"));
        }
        // Sanity: the first record after the magic should be the bag header.
        let mut builder = Builder::new();
        let body = &bytes[MAGIC.len()..];
        // We can walk the whole body linearly; the bag header (op 0x03) is just
        // skipped by `walk_records`.
        let _ = OP_BAG_HEADER; // documented op code; bag header is skipped.
        walk_records(body, &mut builder, true)?;
        Self::from_builder(builder)
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
        let (conn, path) = self
            .resolve(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        let msgs = &conn.messages;
        let start_idx = msgs.partition_point(|(t, _)| *t < range.start_ns);
        let end_idx = msgs
            .partition_point(|(t, _)| *t < range.end_ns)
            .max(start_idx);
        let prev_idx = if opts.include_prev && start_idx > 0 {
            Some(start_idx - 1)
        } else {
            None
        };

        // Build the selected index list: optional prev, then [start, end).
        let mut indices: Vec<usize> = Vec::new();
        if let Some(p) = prev_idx {
            indices.push(p);
        }
        indices.extend(start_idx..end_idx);

        // Decode each selected message; skip individual decode failures so a
        // single malformed payload doesn't sink the whole range.
        let mut ts: Vec<i64> = Vec::with_capacity(indices.len());
        let mut scalars: Vec<f64> = Vec::new();
        let mut vectors: Vec<Vec<f64>> = Vec::new();
        // Track the vector width once known (from the first decoded vector).
        let mut vec_width: Option<usize> = None;
        // Are we producing scalars or vectors? Determined by the first success.
        let mut is_vector: Option<bool> = None;

        for &i in &indices {
            let (t, payload) = &msgs[i];
            match extract(&conn.registry, payload, Wire::Ros1, &path) {
                Ok(Extracted::Scalar(v)) => {
                    if is_vector == Some(true) {
                        continue;
                    }
                    is_vector = Some(false);
                    ts.push(*t);
                    scalars.push(v);
                }
                Ok(Extracted::Enum(v)) => {
                    if is_vector == Some(true) {
                        continue;
                    }
                    is_vector = Some(false);
                    ts.push(*t);
                    scalars.push(v as f64);
                }
                Ok(Extracted::Vector(vals)) => {
                    if is_vector == Some(false) {
                        continue;
                    }
                    // Lock width to the first vector; skip mismatched widths.
                    match vec_width {
                        None => vec_width = Some(vals.len()),
                        Some(w) if w != vals.len() => continue,
                        _ => {}
                    }
                    is_vector = Some(true);
                    ts.push(*t);
                    vectors.push(vals);
                }
                Err(_) => {
                    // Skip undecodable samples.
                }
            }
        }

        match is_vector {
            Some(true) => {
                let n = vec_width.unwrap_or(0);
                let schema = vector_schema(n);
                let ts_arr = TimestampNanosecondArray::from(ts).with_timezone("UTC");
                let mut flat = Vec::with_capacity(vectors.len() * n);
                for v in &vectors {
                    flat.extend_from_slice(v);
                }
                let child = Arc::new(Float64Array::from(flat));
                let inner_field = Arc::new(Field::new("item", DataType::Float64, false));
                let list = FixedSizeListArray::new(inner_field, n as i32, child, None);
                let batch =
                    RecordBatch::try_new(schema.clone(), vec![Arc::new(ts_arr), Arc::new(list)])?;
                write_ipc(schema, batch)
            }
            // Scalars, or an empty range (default to scalar schema).
            _ => {
                let schema = scalar_schema();
                let ts_arr = TimestampNanosecondArray::from(ts).with_timezone("UTC");
                let val = Float64Array::from(scalars);
                let batch =
                    RecordBatch::try_new(schema.clone(), vec![Arc::new(ts_arr), Arc::new(val)])?;
                write_ipc(schema, batch)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a header blob from `(name, value)` pairs in rosbag framing.
    fn build_header(fields: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, value) in fields {
            let mut field = Vec::new();
            field.extend_from_slice(name.as_bytes());
            field.push(b'=');
            field.extend_from_slice(value);
            out.extend_from_slice(&(field.len() as u32).to_le_bytes());
            out.extend_from_slice(&field);
        }
        out
    }

    /// Build a full record (header + data) in rosbag framing.
    fn build_record(header: &[u8], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(header);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn parses_header_field_map() {
        let header = build_header(&[("op", &[OP_MESSAGE_DATA]), ("conn", &7u32.to_le_bytes())]);
        let map = parse_header(&header).unwrap();
        assert_eq!(map.get("op").unwrap(), &[OP_MESSAGE_DATA].as_slice());
        assert_eq!(
            u32::from_le_bytes(map.get("conn").unwrap()[..4].try_into().unwrap()),
            7
        );
    }

    #[test]
    fn reads_record_framing() {
        let header = build_header(&[("op", &[OP_MESSAGE_DATA])]);
        let data = b"hello payload";
        let rec_bytes = build_record(&header, data);
        let mut off = 0usize;
        let rec = read_record(&rec_bytes, &mut off).unwrap();
        assert_eq!(rec.op(), Some(OP_MESSAGE_DATA));
        assert_eq!(rec.data, data);
        assert_eq!(off, rec_bytes.len());
    }

    #[test]
    fn truncated_header_errors() {
        // header_len claims 100 bytes but buffer is short.
        let mut buf = Vec::new();
        buf.extend_from_slice(&100u32.to_le_bytes());
        buf.extend_from_slice(b"short");
        let mut off = 0usize;
        assert!(read_record(&buf, &mut off).is_err());
    }
}
