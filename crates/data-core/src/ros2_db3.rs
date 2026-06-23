//! `Ros2Db3Reader`: a reader for ROS2 rosbag2 **SQLite** (`.db3`) bags.
//!
//! ## How the bag is read
//!
//! rosbag2 `.db3` bags are SQLite files. Driveline ships a minimal, read-only,
//! pure-Rust SQLite reader ([`crate::sqlite`]) that parses the file directly
//! from its bytes on `wasm32-unknown-unknown` (no C deps, no `sql.js`).
//! [`Ros2Db3Reader::open`] uses it to read the rosbag2 `topics` / `messages`
//! (and optional `message_definitions`) tables, then delegates to
//! [`Ros2Db3Reader::open_rows`], which decodes the per-message CDR payloads
//! with the shared dynamic decoder in [`crate::ros`] plus the bundled typestore
//! in [`crate::ros::lookup_typedef`].
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

use crate::reader::{ArrowIpc, Reader};
use crate::ros::reader_common::{
    expand_topic_channels, fetch_topic_range, is_image_type, RosTopic,
};
use crate::ros::{lookup_typedef, MessageRegistry, Wire};
use crate::sqlite::{column_index, SqliteDb, Value};
use crate::types::{Channel, FetchOpts, SourceKind, SourceMeta, TimeRange};

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

pub struct Ros2Db3Reader {
    meta: SourceMeta,
    /// Topic name -> resolved topic (used by `fetch_range` to resolve
    /// `topic.path`). Only topics whose definition resolved and parsed are
    /// present.
    by_topic: HashMap<String, RosTopic>,
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
            embedded.entry(normalize(name)).or_insert(def.as_str());
        }

        let mut by_topic: HashMap<String, RosTopic> = HashMap::new();
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
            // topic so lookups don't crash. ROS2 type names carry a middle
            // `msg`/`srv` segment, so normalise before the image check.
            let make_channels = !is_image_type(&normalize(msg_type));

            expand_topic_channels(
                topic,
                &registry,
                &messages,
                make_channels,
                &mut channels,
                &mut overall,
            );

            by_topic.insert(
                topic.clone(),
                RosTopic {
                    topic: topic.clone(),
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
}

/// Extract the `open_rows` arguments from a parsed rosbag2 SQLite database.
///
/// Maps tables to rows as follows:
/// - `topics`: each row contributes `(name, type)` to `topics`, keyed by the
///   topic's `id` *column* (not the SQLite rowid) so `messages.topic_id` can be
///   resolved to a dense `0..T` index.
/// - `messages`: `(topic_id, timestamp, data)` per row. Messages are sorted by
///   timestamp so each topic's samples are ascending (defensive — `open_rows`
///   re-sorts per topic anyway).
/// - `message_definitions` (optional): `(topic_type, encoded_message_definition)`.
struct ExtractedRows {
    topics: Vec<(String, String)>,
    msg_topic_idx: Vec<u32>,
    msg_ts_ns: Vec<i64>,
    blob_data: Vec<u8>,
    blob_offsets: Vec<u32>,
    embedded_defs: Vec<(String, String)>,
}

/// Resolve a column index by name, with a positional fallback when the
/// `CREATE TABLE` SQL could not be parsed.
fn col_idx(cols: &Option<HashMap<String, usize>>, name: &str, fallback: usize) -> usize {
    cols.as_ref()
        .and_then(|m| m.get(name).copied())
        .unwrap_or(fallback)
}

fn extract_rows(db: &SqliteDb) -> crate::Result<ExtractedRows> {
    // Column maps (name-based with positional fallback for the known schema).
    let topics_cols = db.columns("topics").ok().map(|c| column_index(&c));
    // Known rosbag2 `topics` positions: id, name, type, ...
    let ti_id = col_idx(&topics_cols, "id", 0);
    let ti_name = col_idx(&topics_cols, "name", 1);
    let ti_type = col_idx(&topics_cols, "type", 2);

    let topic_rows = db
        .rows("topics")
        .map_err(|e| err(format!("reading topics: {e}")))?;

    // Build the dense topic list and an id-column -> index map.
    let mut topics: Vec<(String, String)> = Vec::with_capacity(topic_rows.len());
    let mut id_to_idx: HashMap<i64, u32> = HashMap::new();
    for (rowid, cols) in &topic_rows {
        let name = cols
            .get(ti_name)
            .and_then(Value::as_str)
            .ok_or_else(|| err("topics.name missing or not text"))?
            .to_string();
        let ty = cols
            .get(ti_type)
            .and_then(Value::as_str)
            .ok_or_else(|| err("topics.type missing or not text"))?
            .to_string();
        // Prefer the `id` column; fall back to the SQLite rowid.
        let id = cols.get(ti_id).and_then(Value::as_i64).unwrap_or(*rowid);
        let idx = topics.len() as u32;
        id_to_idx.insert(id, idx);
        topics.push((name, ty));
    }

    // messages: topic_id, timestamp, data.
    let messages_cols = db.columns("messages").ok().map(|c| column_index(&c));
    let mi_topic = col_idx(&messages_cols, "topic_id", 1);
    let mi_ts = col_idx(&messages_cols, "timestamp", 2);
    let mi_data = col_idx(&messages_cols, "data", 3);

    let mut message_rows = db
        .rows("messages")
        .map_err(|e| err(format!("reading messages: {e}")))?;

    // Sort by timestamp (then rowid for stability) so per-topic series are
    // ascending. `open_rows` re-sorts per topic, but this keeps behaviour
    // deterministic regardless of physical row order.
    message_rows.sort_by_key(|(rowid, cols)| {
        let ts = cols.get(mi_ts).and_then(Value::as_i64).unwrap_or(0);
        (ts, *rowid)
    });

    let mut msg_topic_idx: Vec<u32> = Vec::with_capacity(message_rows.len());
    let mut msg_ts_ns: Vec<i64> = Vec::with_capacity(message_rows.len());
    let mut blob_data: Vec<u8> = Vec::new();
    let mut blob_offsets: Vec<u32> = Vec::with_capacity(message_rows.len() + 1);
    blob_offsets.push(0);

    for (_rowid, cols) in &message_rows {
        let topic_id = cols
            .get(mi_topic)
            .and_then(Value::as_i64)
            .ok_or_else(|| err("messages.topic_id missing or not integer"))?;
        let &idx = id_to_idx.get(&topic_id).ok_or_else(|| {
            err(format!(
                "messages.topic_id {topic_id} has no matching topic"
            ))
        })?;
        let ts = cols
            .get(mi_ts)
            .and_then(Value::as_i64)
            .ok_or_else(|| err("messages.timestamp missing or not integer"))?;
        let data = cols
            .get(mi_data)
            .and_then(Value::as_blob)
            .ok_or_else(|| err("messages.data missing or not a blob"))?;

        msg_topic_idx.push(idx);
        msg_ts_ns.push(ts);
        blob_data.extend_from_slice(data);
        blob_offsets.push(blob_data.len() as u32);
    }

    // Optional message_definitions: (topic_type, encoded_message_definition).
    let mut embedded_defs: Vec<(String, String)> = Vec::new();
    if db.has_table("message_definitions") {
        let def_cols = db
            .columns("message_definitions")
            .ok()
            .map(|c| column_index(&c));
        // Known positions: id, topic_type, encoding, encoded_message_definition, ...
        let di_type = col_idx(&def_cols, "topic_type", 1);
        let di_def = col_idx(&def_cols, "encoded_message_definition", 3);
        let def_rows = db
            .rows("message_definitions")
            .map_err(|e| err(format!("reading message_definitions: {e}")))?;
        for (_rowid, cols) in &def_rows {
            let (Some(ty), Some(def)) = (
                cols.get(di_type).and_then(Value::as_str),
                cols.get(di_def).and_then(Value::as_str),
            ) else {
                continue;
            };
            embedded_defs.push((ty.to_string(), def.to_string()));
        }
    }

    Ok(ExtractedRows {
        topics,
        msg_topic_idx,
        msg_ts_ns,
        blob_data,
        blob_offsets,
        embedded_defs,
    })
}

impl Reader for Ros2Db3Reader {
    /// Open a rosbag2 `.db3` (SQLite) bag directly from its bytes. Parses the
    /// `topics` / `messages` / optional `message_definitions` tables with the
    /// in-crate [`crate::sqlite`] reader, then delegates to
    /// [`Ros2Db3Reader::open_rows`].
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        let db = SqliteDb::open(bytes).map_err(|e| err(e.to_string()))?;
        let rows = extract_rows(&db)?;
        Ros2Db3Reader::open_rows(
            &rows.topics,
            &rows.msg_topic_idx,
            &rows.msg_ts_ns,
            &rows.blob_data,
            &rows.blob_offsets,
            &rows.embedded_defs,
        )
    }

    fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    fn fetch_range(
        &self,
        channel_id: &str,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        fetch_topic_range(&self.by_topic, channel_id, range, opts, Wire::Cdr)
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
        let r = Ros2Db3Reader::open_rows(&topics, &[0], &[1], &[0, 0, 0, 0], &[0, 4], &[]).unwrap();
        assert!(r.meta().channels.is_empty());
        let err = r
            .fetch_range("/weird.data", r.meta().time_range, FetchOpts::default())
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
