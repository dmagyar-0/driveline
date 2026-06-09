//! `Ros2Db3Reader`: a reader for ROS2 rosbag2 **SQLite** (`.db3`) bags.
//!
//! ## Why this reader does not parse a file
//!
//! SQLite cannot be parsed on our `wasm32-unknown-unknown` target (no C deps,
//! no filesystem). So the SQLite query lives on the JS side (sql.js): JS reads
//! the rosbag2 `topics` / `messages` (and optional `message_definitions`)
//! tables, then hands the already-extracted rows to this reader, which decodes
//! the per-message CDR payloads with the shared dynamic decoder in
//! [`crate::ros`] plus the bundled typestore in [`crate::ros::lookup_typedef`].
//!
//! Because of that, the [`Reader`] trait's `open(bytes)` does not fit — there
//! is no single byte blob to parse. [`Ros2Db3Reader::open`] therefore returns
//! [`crate::Error::Ros2Db3`]; construct the reader via
//! [`Ros2Db3Reader::open_rows`] instead.
//!
//! ## Channel shape
//!
//! Identical to [`crate::ros1_bag::Ros1BagReader`]: each ROS *topic* is
//! expanded into one Driveline [`Channel`] per numeric leaf of its message
//! type, id `"{topic}.{leaf_path}"` (e.g. `/imu/data.linear_acceleration.z` or
//! `/imu/data.angular_velocity`). The only differences from the ROS1 bag
//! reader are the input (rows, not a bag file), the wire format ([`Wire::Cdr`]
//! rather than [`Wire::Ros1`]), and where the message definitions come from
//! (the typestore / embedded defs, not text embedded in the bag).
//!
//! ## `SourceKind`
//!
//! Reported as [`SourceKind::Mcap`]: a ROS2 db3 bag is logically an MCAP-like
//! CDR source (same OMG-CDR payloads, same per-leaf channel expansion), and
//! reusing the existing variant avoids editing `types.rs` (off-limits for this
//! change). See the task brief for the rationale.

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::{FixedSizeListArray, Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};

use crate::reader::{ArrowIpc, Reader};
use crate::ros::{extract, lookup_typedef, numeric_leaves, Extracted, MessageRegistry, Wire};
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

/// Image-like message types we skip (no scalar channels); mirrors the ROS1 bag
/// reader so a later phase can add video for these.
fn is_image_type(type_name: &str) -> bool {
    matches!(
        normalize(type_name).as_str(),
        "sensor_msgs/Image" | "sensor_msgs/CompressedImage"
    )
}

/// Normalise a type name to the canonical `pkg/Type` key by stripping a middle
/// `msg`/`srv` segment from a ROS2 `pkg/msg/Type` name. ROS1 `pkg/Type` names
/// pass through unchanged. (Same convention as `ros::typestore::normalize`.)
fn normalize(type_name: &str) -> String {
    let raw = type_name.trim();
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() == 3 && matches!(parts[1], "msg" | "srv") {
        format!("{}/{}", parts[0], parts[2])
    } else {
        raw.to_string()
    }
}

fn err(msg: impl Into<String>) -> crate::Error {
    crate::Error::Ros2Db3(msg.into())
}

/// One resolved topic: its message type, parsed registry, and the time-sorted
/// list of message `(time_ns, payload)`.
struct Topic {
    topic: String,
    #[allow(dead_code)]
    msg_type: String,
    registry: MessageRegistry,
    /// `(time_ns, payload)` sorted ascending by time.
    messages: Vec<(i64, Vec<u8>)>,
}

pub struct Ros2Db3Reader {
    meta: SourceMeta,
    /// Topic name -> resolved topic (used by `fetch_range` to resolve
    /// `topic.path`). Only topics whose definition resolved and parsed are
    /// present.
    by_topic: HashMap<String, Topic>,
}

impl Ros2Db3Reader {
    /// Build a reader from rows extracted from a rosbag2 SQLite bag.
    ///
    /// - `topics`: `(topic_name, type_name)` for each topic, indexed `0..T`.
    ///   `type_name` is the rosbag2 spelling, e.g. `sensor_msgs/msg/Imu`.
    /// - `msg_topic_idx[i]`: index into `topics` for message `i`.
    /// - `msg_ts_ns[i]`: timestamp (ns) for message `i` (the rosbag2
    ///   `messages.timestamp`).
    /// - `blob_data` + `blob_offsets`: message `i`'s CDR payload is
    ///   `blob_data[blob_offsets[i] .. blob_offsets[i+1]]` (cumulative offsets,
    ///   length `msg_count + 1`, non-decreasing).
    /// - `embedded_defs`: optional `(type_name, concatenated_def)` pairs from a
    ///   `message_definitions` table, checked *before* the bundled typestore.
    ///   The def text must already be in the concatenated form consumed by
    ///   [`MessageRegistry::parse`] (root fields, then each dependent type after
    ///   an `====` separator and a `MSG: pkg/Type` header).
    ///
    /// A topic whose definition resolves in neither `embedded_defs` nor the
    /// bundled typestore — or whose definition fails to parse — is skipped
    /// (surfaces no channels). Its messages are still indexed enough that a
    /// `fetch_range` on an unknown channel returns
    /// [`crate::Error::ChannelNotFound`].
    pub fn open_rows(
        topics: &[(String, String)],
        msg_topic_idx: &[u32],
        msg_ts_ns: &[i64],
        blob_data: &[u8],
        blob_offsets: &[u32],
        embedded_defs: &[(String, String)],
    ) -> crate::Result<Self> {
        let msg_count = msg_topic_idx.len();
        if msg_ts_ns.len() != msg_count {
            return Err(err(format!(
                "msg_ts_ns length {} != msg_topic_idx length {msg_count}",
                msg_ts_ns.len()
            )));
        }
        if blob_offsets.len() != msg_count + 1 {
            return Err(err(format!(
                "blob_offsets length {} != msg_count + 1 ({})",
                blob_offsets.len(),
                msg_count + 1
            )));
        }
        // Offsets must be non-decreasing and within the blob.
        for w in blob_offsets.windows(2) {
            if w[0] > w[1] {
                return Err(err("blob_offsets must be non-decreasing"));
            }
        }
        if let Some(&last) = blob_offsets.last() {
            if last as usize > blob_data.len() {
                return Err(err(format!(
                    "blob_offsets end {last} exceeds blob_data length {}",
                    blob_data.len()
                )));
            }
        }

        // Group raw `(ts, payload)` per topic index (unsorted at first).
        let mut per_topic: Vec<Vec<(i64, Vec<u8>)>> = vec![Vec::new(); topics.len()];
        for i in 0..msg_count {
            let tidx = msg_topic_idx[i] as usize;
            if tidx >= topics.len() {
                return Err(err(format!(
                    "msg_topic_idx[{i}] = {tidx} out of range (topics len {})",
                    topics.len()
                )));
            }
            let lo = blob_offsets[i] as usize;
            let hi = blob_offsets[i + 1] as usize;
            // Bounds already validated above; slice is safe.
            let payload = blob_data[lo..hi].to_vec();
            per_topic[tidx].push((msg_ts_ns[i], payload));
        }

        // Build a quick lookup of embedded defs, by exact key and normalized
        // `pkg/Type` key.
        let mut embedded: HashMap<String, &str> = HashMap::new();
        for (name, def) in embedded_defs {
            embedded.entry(name.clone()).or_insert(def.as_str());
            embedded
                .entry(normalize(name))
                .or_insert(def.as_str());
        }

        let mut by_topic: HashMap<String, Topic> = HashMap::new();
        let mut channels: Vec<Channel> = Vec::new();
        let mut overall: Option<(i64, i64)> = None;

        // Iterate topics in declared order for stable channel ordering.
        for (tidx, (topic, msg_type)) in topics.iter().enumerate() {
            let mut messages = std::mem::take(&mut per_topic[tidx]);
            messages.sort_by_key(|(t, _)| *t);

            // Resolve the concatenated message definition: embedded first
            // (exact, then normalized), else the bundled typestore.
            let def: Option<&str> = embedded
                .get(msg_type.as_str())
                .copied()
                .or_else(|| embedded.get(&normalize(msg_type)).copied())
                .or_else(|| lookup_typedef(msg_type));

            // Parse the registry; on missing def or parse error, skip the topic
            // (no channels), but do not crash.
            let registry = match def {
                Some(text) => match MessageRegistry::parse(msg_type, text) {
                    Ok(reg) => reg,
                    Err(_) => continue,
                },
                None => continue,
            };

            // Skip image/video topics for now (no channels), but still keep the
            // topic so lookups don't crash.
            let make_channels = !is_image_type(msg_type);

            let (t_start, t_end) = match (messages.first(), messages.last()) {
                (Some((a, _)), Some((b, _))) => (*a, b.saturating_add(1)),
                _ => (0, 0),
            };
            let topic_range = TimeRange {
                start_ns: t_start,
                end_ns: t_end,
            };
            if !messages.is_empty() {
                overall = Some(match overall {
                    Some((s, e)) => (s.min(t_start), e.max(t_end)),
                    None => (t_start, t_end),
                });
            }

            if make_channels {
                for leaf in numeric_leaves(&registry) {
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
                        time_range: topic_range,
                    });
                }
            }

            by_topic.insert(
                topic.clone(),
                Topic {
                    topic: topic.clone(),
                    msg_type: msg_type.clone(),
                    registry,
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
            kind: SourceKind::Mcap,
            time_range,
            channels,
        };

        Ok(Ros2Db3Reader { meta, by_topic })
    }

    /// Resolve a `"{topic}.{path}"` channel id to its topic and the field path
    /// within the message. Topics contain `/` and may contain `.`-free
    /// segments, so we match against known topics by longest prefix (defensive
    /// against topic names that are prefixes of one another).
    fn resolve<'a>(&'a self, channel_id: &str) -> Option<(&'a Topic, String)> {
        let mut best: Option<(&Topic, String)> = None;
        for (topic, t) in &self.by_topic {
            if let Some(rest) = channel_id.strip_prefix(topic.as_str()) {
                if let Some(path) = rest.strip_prefix('.') {
                    let better = match &best {
                        Some((c, _)) => topic.len() > c.topic.len(),
                        None => true,
                    };
                    if better {
                        best = Some((t, path.to_string()));
                    }
                }
            }
        }
        best
    }
}

// ---------------------------------------------------------------------------
// Arrow batch construction (identical schema to `ros1_bag.rs`)
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

impl Reader for Ros2Db3Reader {
    /// ROS2 db3 bags are not opened from a byte slice — see the module docs.
    /// Construct via [`Ros2Db3Reader::open_rows`].
    fn open(_bytes: &[u8]) -> crate::Result<Self> {
        Err(err(
            "ROS2 db3 (SQLite) cannot be opened from a byte slice on wasm32; \
             use Ros2Db3Reader::open_rows with rows extracted in JS (sql.js)",
        ))
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
        let (topic, path) = self
            .resolve(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        let msgs = &topic.messages;
        let start_idx = msgs.partition_point(|(t, _)| *t < range.start_ns);
        let end_idx = msgs
            .partition_point(|(t, _)| *t < range.end_ns)
            .max(start_idx);
        let prev_idx = if opts.include_prev && start_idx > 0 {
            Some(start_idx - 1)
        } else {
            None
        };

        // Selected index list: optional prev, then [start, end).
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
        let mut vec_width: Option<usize> = None;
        let mut is_vector: Option<bool> = None;

        for &i in &indices {
            let (t, payload) = &msgs[i];
            match extract(&topic.registry, payload, Wire::Cdr, &path) {
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

    /// Empty input builds an empty reader (no channels, empty time range).
    #[test]
    fn open_rows_empty_is_ok() {
        let r = Ros2Db3Reader::open_rows(&[], &[], &[], &[], &[0], &[]).unwrap();
        assert!(r.meta().channels.is_empty());
        assert!(r.meta().time_range.is_empty());
        assert_eq!(r.meta().kind, SourceKind::Mcap);
    }

    /// `blob_offsets` must have length `msg_count + 1`.
    #[test]
    fn open_rows_bad_offsets_len_errors() {
        let topics = vec![("/t".to_string(), "std_msgs/msg/Float64".to_string())];
        // one message, but offsets has wrong length (needs 2).
        let res = Ros2Db3Reader::open_rows(&topics, &[0], &[1], &[0u8; 0], &[0], &[]);
        assert!(matches!(res, Err(crate::Error::Ros2Db3(_))));
    }

    /// `msg_ts_ns` length must match `msg_topic_idx`.
    #[test]
    fn open_rows_mismatched_ts_len_errors() {
        let topics = vec![("/t".to_string(), "std_msgs/msg/Float64".to_string())];
        let res = Ros2Db3Reader::open_rows(&topics, &[0, 0], &[1], &[], &[0, 0, 0], &[]);
        assert!(matches!(res, Err(crate::Error::Ros2Db3(_))));
    }

    /// A topic index out of range is an error, not a panic.
    #[test]
    fn open_rows_topic_idx_out_of_range_errors() {
        let topics = vec![("/t".to_string(), "std_msgs/msg/Float64".to_string())];
        let res = Ros2Db3Reader::open_rows(&topics, &[5], &[1], &[], &[0, 0], &[]);
        assert!(matches!(res, Err(crate::Error::Ros2Db3(_))));
    }

    /// Non-decreasing offsets are required.
    #[test]
    fn open_rows_decreasing_offsets_errors() {
        let topics = vec![("/t".to_string(), "std_msgs/msg/Float64".to_string())];
        let res = Ros2Db3Reader::open_rows(&topics, &[0, 0], &[1, 2], &[0u8; 8], &[8, 4, 0], &[]);
        assert!(matches!(res, Err(crate::Error::Ros2Db3(_))));
    }

    /// A topic whose type is not in the typestore (and has no embedded def) is
    /// skipped: no channels surface, and a fetch on it is ChannelNotFound.
    #[test]
    fn unknown_type_topic_is_skipped() {
        let topics = vec![("/weird".to_string(), "made_up_pkg/msg/Nope".to_string())];
        // One 4-byte payload (content irrelevant — topic is skipped).
        let r =
            Ros2Db3Reader::open_rows(&topics, &[0], &[1], &[0, 0, 0, 0], &[0, 4], &[]).unwrap();
        assert!(r.meta().channels.is_empty());
        let err = r
            .fetch_range(&"/weird.data".to_string(), r.meta().time_range, FetchOpts::default())
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    /// `open()` (the byte-slice trait entry) is unsupported for db3.
    #[test]
    fn open_byte_slice_errors() {
        let res = Ros2Db3Reader::open(b"not a db3");
        assert!(matches!(res, Err(crate::Error::Ros2Db3(_))));
    }
}
