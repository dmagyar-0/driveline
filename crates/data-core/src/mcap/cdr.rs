//! Channel classification and per-message value extraction for MCAP.
//!
//! Two related concerns live here:
//!
//! - **Schema → channel kind.** [`infer_channel_kind`] maps an MCAP schema
//!   name + encoding onto a Driveline [`ChannelKind`], and [`try_expand_ros2`]
//!   expands a ROS2 (`ros2msg` / CDR) topic into one routing entry per numeric
//!   leaf via the shared dynamic decoder in [`crate::ros`].
//! - **Payload → value.** The Foxglove-JSON value parsers and the
//!   [`ParsedValue`] intermediate, plus the Arrow IPC builders that turn a
//!   window of parsed values into the wire batch.
//!
//! [`super::McapReader`] owns the routing state and the byte source; this module
//! is the pure "what kind is this channel, and what value does this message
//! carry" layer.

use std::sync::Arc;

use crate::reader::ArrowIpc;
use crate::types::{ChannelId, ChannelKind, DType};

/// Decoder for a ROS2 (CDR) video channel: the message-definition registry and
/// the top-level field path (`"data"`) carrying the compressed Annex-B bytes.
pub(super) struct RosVideo {
    pub registry: Arc<crate::ros::MessageRegistry>,
    pub data_path: String,
}

/// Routing metadata for a ROS2 (CDR) topic expanded into one Driveline channel
/// per numeric leaf. Keyed by the expanded channel id (`"{topic}.{path}"`).
/// The `registry` is `Arc`-shared across every leaf of the same topic.
pub(super) struct RosExpanded {
    /// MCAP channel id of the underlying topic, used to filter messages.
    pub mcap_id: u16,
    /// Shared message-definition registry for the topic's root type.
    pub registry: Arc<crate::ros::MessageRegistry>,
    /// Dot-separated leaf path passed to `crate::ros::extract`.
    pub leaf_path: String,
    /// Driveline kind for this leaf: `Scalar`, `Vector`, or `Enum`.
    pub kind: ChannelKind,
    /// Element count per sample for `Vector` leaves; 0 otherwise.
    pub width: usize,
}

/// A decoded scalar/vector/enum value, paired with a timestamp during a fetch.
pub(super) enum ParsedValue {
    Scalar(f64),
    Vector(Vec<f64>),
    Enum(i32),
}

/// Attempt to expand a ROS2 (`ros2msg`) schema into one `RosExpanded` routing
/// entry per numeric leaf. Returns the `(expanded_channel_id, RosExpanded)`
/// pairs, or an error if the definition fails to parse (IDL / malformed) — the
/// caller falls back to the channel's default behaviour in that case.
///
/// `schema_name` is the ROS root type (e.g. `sensor_msgs/msg/Imu`),
/// `def_bytes` the UTF-8 concatenated `.msg` text, `topic` the MCAP topic
/// (which prefixes every expanded id), `mcap_id` the underlying channel id.
pub(super) fn try_expand_ros2(
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
        "foxglove_msgs/CompressedVideo",
        "foxglove_msgs/msg/CompressedVideo",
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

/// Parse a message payload into a `ParsedValue` for the given channel kind.
pub(super) fn parse_value(kind: ChannelKind, payload: &[u8]) -> Option<ParsedValue> {
    match kind {
        ChannelKind::Scalar => parse_scalar_json(payload).map(ParsedValue::Scalar),
        ChannelKind::Vector => {
            parse_vector3_json(payload).map(|(x, y, z)| ParsedValue::Vector(vec![x, y, z]))
        }
        ChannelKind::Enum => parse_enum_json(payload).map(ParsedValue::Enum),
        _ => None,
    }
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

pub(super) fn parse_enum_json(data: &[u8]) -> Option<i32> {
    let v: serde_json::Value = serde_json::from_slice(data).ok()?;
    // Drop the sample on i32 overflow rather than silently truncating —
    // a malformed MCAP payload with e.g. `"value": 0x1_0000_0000` would
    // otherwise surface as a valid-looking `0` enum code.
    v.get("value")
        .and_then(|f| f.as_i64())
        .and_then(|i| i32::try_from(i).ok())
}

pub(super) fn parsed_scalar_as_f64(v: &ParsedValue) -> f64 {
    match v {
        ParsedValue::Scalar(f) => *f,
        _ => f64::NAN,
    }
}

/// Build a scalar Arrow IPC buffer from owned timestamp and value vectors.
/// Takes ownership so the vecs can be moved directly into Arrow arrays without
/// an extra `to_vec()` copy at the call site.
pub(super) fn build_scalar_ipc_raw(
    timestamps: Vec<i64>,
    values: Vec<f64>,
) -> crate::Result<ArrowIpc> {
    crate::arrow::build_scalar_ipc(timestamps, values)
}

pub(super) fn build_vector_ipc(
    timestamps: &[i64],
    values: &[&ParsedValue],
    n: usize,
) -> crate::Result<ArrowIpc> {
    let mut flat = Vec::with_capacity(values.len() * n);
    for v in values {
        match v {
            ParsedValue::Vector(inner) if inner.len() == n => flat.extend_from_slice(inner),
            _ => flat.extend(std::iter::repeat_n(f64::NAN, n)),
        }
    }
    crate::arrow::build_vector_ipc(timestamps.to_vec(), flat, n)
}

pub(super) fn build_enum_ipc(
    timestamps: &[i64],
    values: &[&ParsedValue],
) -> crate::Result<ArrowIpc> {
    let codes: Vec<i32> = values
        .iter()
        .map(|v| match v {
            ParsedValue::Enum(c) => *c,
            _ => 0,
        })
        .collect();
    crate::arrow::build_enum_ipc(timestamps.to_vec(), codes)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
