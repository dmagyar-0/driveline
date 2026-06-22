//! Shared reader logic for the two ROS bag readers.
//!
//! [`Ros1BagReader`](crate::ros1_bag::Ros1BagReader) and
//! [`Ros2Db3Reader`](crate::ros2_db3::Ros2Db3Reader) differ only by *wire
//! format* (ROS1 message vs. OMG-CDR) and by *where the messages come from* (a
//! bag file vs. SQLite rows). Everything downstream of "a topic with a parsed
//! [`MessageRegistry`] and a time-sorted list of `(time_ns, payload)`" is
//! identical: the per-leaf channel expansion, the longest-prefix
//! `"{topic}.{path}"` resolution, and the range fetch + decode. This module
//! owns that shared core so the two readers carry only their format-specific
//! decode.

use std::collections::HashMap;

use crate::reader::ArrowIpc;
use crate::ros::{extract, Extracted, MessageRegistry, Wire};
use crate::types::{Channel, ChannelKind, DType, FetchOpts, TimeRange};

/// One resolved ROS topic: its parsed message registry and the time-sorted list
/// of message `(time_ns, payload)`. Shared by both bag readers; the only thing
/// that varies between them is the [`Wire`] used to decode `payload`.
pub(crate) struct RosTopic {
    pub topic: String,
    pub registry: MessageRegistry,
    /// `(time_ns, payload)` sorted ascending by time.
    pub messages: Vec<(i64, Vec<u8>)>,
}

/// Image-like message types that surface no scalar channels (a later phase adds
/// video). `type_name` must already be in canonical `pkg/Type` form — ROS1
/// names already are; ROS2 callers normalise first.
pub(crate) fn is_image_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "sensor_msgs/Image" | "sensor_msgs/CompressedImage"
    )
}

/// Expand one topic's numeric leaves into Driveline [`Channel`]s, appending them
/// to `channels`, and fold the topic's `(start, end)` into `overall`.
///
/// `make_channels` is `false` for image/video topics (kept addressable but
/// surfacing no signal channels). The returned per-topic [`TimeRange`] is the
/// half-open `[first, last+1)` over the topic's messages, used as each leaf
/// channel's range and as the source-level fold.
pub(crate) fn expand_topic_channels(
    topic: &str,
    registry: &MessageRegistry,
    messages: &[(i64, Vec<u8>)],
    make_channels: bool,
    channels: &mut Vec<Channel>,
    overall: &mut Option<(i64, i64)>,
) -> TimeRange {
    let (start, end) = match (messages.first(), messages.last()) {
        (Some((a, _)), Some((b, _))) => (*a, b.saturating_add(1)),
        _ => (0, 0),
    };
    let range = TimeRange {
        start_ns: start,
        end_ns: end,
    };
    if !messages.is_empty() {
        *overall = Some(match *overall {
            Some((s, e)) => (s.min(start), e.max(end)),
            None => (start, end),
        });
    }

    if make_channels {
        for leaf in crate::ros::numeric_leaves(registry) {
            // Dynamic-length arrays (dims == 0) are not plottable as a fixed
            // channel.
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
                time_range: range,
            });
        }
    }

    range
}

/// Resolve a `"{topic}.{path}"` channel id to its topic and the field path
/// within the message. Topics contain `/` and may contain `.`-free segments, so
/// we match against known topics by longest prefix (defensive against topic
/// names that are prefixes of one another).
pub(crate) fn resolve<'a>(
    by_topic: &'a HashMap<String, RosTopic>,
    channel_id: &str,
) -> Option<(&'a RosTopic, String)> {
    let mut best: Option<(&RosTopic, String)> = None;
    for (topic, t) in by_topic {
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

/// Fetch a `"{topic}.{path}"` channel's samples over `[range)` and build the
/// Arrow IPC. `wire` selects the decode (ROS1 vs. CDR); everything else — index
/// selection, `include_prev`, per-sample decode, scalar/vector disambiguation —
/// is shared.
///
/// Individual messages that fail to decode are skipped so a single malformed
/// payload doesn't sink the whole range. The first successfully-decoded sample
/// fixes whether the channel is scalar or vector; later samples of the other
/// shape (or a mismatched vector width) are dropped.
pub(crate) fn fetch_topic_range(
    by_topic: &HashMap<String, RosTopic>,
    channel_id: &str,
    range: TimeRange,
    opts: FetchOpts,
    wire: Wire,
) -> crate::Result<ArrowIpc> {
    let (topic, path) = resolve(by_topic, channel_id)
        .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.to_string()))?;

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

    let mut ts: Vec<i64> = Vec::with_capacity(indices.len());
    let mut scalars: Vec<f64> = Vec::new();
    let mut vectors: Vec<Vec<f64>> = Vec::new();
    // Track the vector width once known (from the first decoded vector).
    let mut vec_width: Option<usize> = None;
    // Are we producing scalars or vectors? Determined by the first success.
    let mut is_vector: Option<bool> = None;

    for &i in &indices {
        let (t, payload) = &msgs[i];
        match extract(&topic.registry, payload, wire, &path) {
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
            let mut flat = Vec::with_capacity(vectors.len() * n);
            for v in &vectors {
                flat.extend_from_slice(v);
            }
            crate::arrow::build_vector_ipc(ts, flat, n)
        }
        // Scalars, or an empty range (default to scalar schema).
        _ => crate::arrow::build_scalar_ipc(ts, scalars),
    }
}
