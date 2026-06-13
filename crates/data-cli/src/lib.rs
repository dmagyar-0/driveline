//! `driveline-data` — a thin native wrapper around `data-core`'s readers
//! so agents and scripts can query log files without a browser.
//!
//! The web app's WASM path and this CLI share the exact same readers and
//! Arrow producers; the CLI only adds file loading, a format dispatcher
//! keyed on the extension, and CSV/JSON printers for the fetched Arrow
//! batches. Time values are nanoseconds (`i64`) end to end and are
//! emitted as **strings** in JSON output — they exceed 2^53, which JSON
//! number consumers (JS) cannot hold losslessly.

use std::io::Cursor;
use std::path::Path;

use arrow_array::Array;
use arrow_cast::display::{ArrayFormatter, FormatOptions};
use arrow_ipc::reader::FileReader;
use arrow_schema::DataType;
use data_core::reader::{ArrowIpc, Reader};
use data_core::types::{ChannelKind, DType, FetchOpts, SourceKind, SourceMeta, TimeRange};
use data_core::{MapGeometryReader, McapReader, Mf4Reader, Ros1BagReader, Ros2Db3Reader};
use serde_json::{json, Value};

/// Enum dispatcher over the format readers. `McapReader`/`Mf4Reader`
/// expose `meta`/`fetch_range` as inherent methods (not via the `Reader`
/// trait), so a `Box<dyn Reader>` cannot cover all four formats.
pub enum LogReader {
    Mcap(McapReader),
    Mf4(Mf4Reader),
    Ros1(Ros1BagReader),
    Ros2(Ros2Db3Reader),
    MapGeometry(MapGeometryReader),
}

impl LogReader {
    pub fn meta(&self) -> &SourceMeta {
        match self {
            LogReader::Mcap(r) => r.meta(),
            LogReader::Mf4(r) => r.meta(),
            LogReader::Ros1(r) => r.meta(),
            LogReader::Ros2(r) => r.meta(),
            LogReader::MapGeometry(r) => r.meta(),
        }
    }

    pub fn fetch_range(
        &self,
        channel_id: &str,
        range: TimeRange,
        opts: FetchOpts,
    ) -> data_core::Result<ArrowIpc> {
        let id = channel_id.to_string();
        match self {
            LogReader::Mcap(r) => r.fetch_range(&id, range, opts),
            LogReader::Mf4(r) => r.fetch_range(&id, range, opts),
            LogReader::Ros1(r) => r.fetch_range(&id, range, opts),
            LogReader::Ros2(r) => r.fetch_range(&id, range, opts),
            LogReader::MapGeometry(r) => r.fetch_range(&id, range, opts),
        }
    }
}

/// Open `path` with the reader matching its extension.
/// Supported: `.mcap`, `.mf4`, `.bag` (ROS1), `.db3` (ROS2), `.xodr` (OpenDRIVE
/// map geometry).
pub fn open_reader(path: &Path) -> Result<LogReader, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mcap" => Ok(LogReader::Mcap(
            McapReader::open(&bytes).map_err(|e| e.to_string())?,
        )),
        "mf4" => Ok(LogReader::Mf4(
            Mf4Reader::open_slice(&bytes).map_err(|e| e.to_string())?,
        )),
        "bag" => Ok(LogReader::Ros1(
            Ros1BagReader::open(&bytes).map_err(|e| e.to_string())?,
        )),
        "db3" => Ok(LogReader::Ros2(
            Ros2Db3Reader::open(&bytes).map_err(|e| e.to_string())?,
        )),
        "xodr" => Ok(LogReader::MapGeometry(
            MapGeometryReader::open(&bytes).map_err(|e| e.to_string())?,
        )),
        other => Err(format!(
            "unsupported extension {other:?} (expected .mcap, .mf4, .bag, .db3 or .xodr)"
        )),
    }
}

fn kind_str(kind: ChannelKind) -> &'static str {
    match kind {
        ChannelKind::Scalar => "scalar",
        ChannelKind::Vector => "vector",
        ChannelKind::Video => "video",
        ChannelKind::Enum => "enum",
        ChannelKind::Bytes => "bytes",
        ChannelKind::PointCloud => "pointcloud",
        ChannelKind::BoundingBox => "bounding_box",
        ChannelKind::CameraCalibration => "camera_calibration",
        ChannelKind::Trajectory => "trajectory",
        ChannelKind::MapGeometry => "map_geometry",
    }
}

fn source_kind_str(kind: SourceKind) -> &'static str {
    match kind {
        SourceKind::Noop => "noop",
        SourceKind::Mcap => "mcap",
        SourceKind::Mf4 => "mf4",
        SourceKind::Mp4Sidecar => "mp4-sidecar",
        SourceKind::Tabular => "tabular",
        SourceKind::Recipe => "recipe",
        SourceKind::Ros1 => "ros1",
        SourceKind::Lidar => "lidar",
        SourceKind::OpenLabel => "openlabel",
        SourceKind::Calibration => "calibration",
        SourceKind::Trajectory => "trajectory",
        SourceKind::MapGeometry => "map_geometry",
    }
}

fn dtype_str(dtype: Option<DType>) -> Option<&'static str> {
    dtype.map(|d| match d {
        DType::F32 => "f32",
        DType::F64 => "f64",
        DType::I32 => "i32",
        DType::I64 => "i64",
        DType::U32 => "u32",
        DType::U64 => "u64",
    })
}

/// `info` — source metadata + channel list as JSON. Nanosecond ranges
/// are decimal strings (see module docs).
pub fn source_info_json(reader: &LogReader) -> Value {
    let meta = reader.meta();
    json!({
        "id": meta.id,
        "kind": source_kind_str(meta.kind),
        "timeRange": {
            "startNs": meta.time_range.start_ns.to_string(),
            "endNs": meta.time_range.end_ns.to_string(),
        },
        "channels": meta.channels.iter().map(|c| json!({
            "id": c.id,
            "name": c.name,
            "kind": kind_str(c.kind),
            "dtype": dtype_str(c.dtype),
            "unit": c.unit,
            "sampleCount": c.sample_count,
            "timeRange": {
                "startNs": c.time_range.start_ns.to_string(),
                "endNs": c.time_range.end_ns.to_string(),
            },
        })).collect::<Vec<_>>(),
    })
}

/// The channel's own time range — the default fetch window.
pub fn channel_range(reader: &LogReader, channel_id: &str) -> Result<TimeRange, String> {
    reader
        .meta()
        .channels
        .iter()
        .find(|c| c.id == channel_id)
        .map(|c| c.time_range)
        .ok_or_else(|| format!("channel not found: {channel_id}"))
}

struct FetchedBatches {
    column_names: Vec<String>,
    /// Per batch: one formatted string per (row, column). 64-bit integer
    /// and timestamp cells are raw ns digits (cast before formatting).
    batches: Vec<Vec<Vec<String>>>,
    /// Columns holding float values — JSON numbers; everything else
    /// (incl. int64/timestamp ns) stays a string.
    float_like: Vec<bool>,
    rows: usize,
}

fn fetch_batches(
    reader: &LogReader,
    channel_id: &str,
    range: TimeRange,
    include_prev: bool,
) -> Result<FetchedBatches, String> {
    let ipc = reader
        .fetch_range(channel_id, range, FetchOpts { include_prev })
        .map_err(|e| e.to_string())?;
    let file = FileReader::try_new(Cursor::new(ipc), None).map_err(|e| e.to_string())?;
    let schema = file.schema();
    let column_names: Vec<String> = schema.fields().iter().map(|f| f.name().clone()).collect();
    let int64_like: Vec<bool> = schema
        .fields()
        .iter()
        .map(|f| {
            matches!(
                f.data_type(),
                DataType::Int64 | DataType::UInt64 | DataType::Timestamp(_, _)
            )
        })
        .collect();
    let float_like: Vec<bool> = schema
        .fields()
        .iter()
        .map(|f| {
            matches!(
                f.data_type(),
                DataType::Float16 | DataType::Float32 | DataType::Float64
            )
        })
        .collect();
    let options = FormatOptions::default().with_null("");
    let mut batches = Vec::new();
    let mut rows = 0usize;
    for batch in file {
        let batch = batch.map_err(|e| e.to_string())?;
        rows += batch.num_rows();
        // Timestamp columns are emitted as raw nanosecond integers (the
        // agent contract), not formatted datetimes — cast every 64-bit /
        // timestamp column to Int64 before formatting.
        let columns: Vec<arrow_array::ArrayRef> = batch
            .columns()
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if int64_like[i] {
                    arrow_cast::cast(c.as_ref(), &DataType::Int64).map_err(|e| e.to_string())
                } else {
                    Ok(c.clone())
                }
            })
            .collect::<Result<_, String>>()?;
        let formatters: Vec<ArrayFormatter> = columns
            .iter()
            .map(|c| ArrayFormatter::try_new(c.as_ref(), &options).map_err(|e| e.to_string()))
            .collect::<Result<_, String>>()?;
        let mut rows_out = Vec::with_capacity(batch.num_rows());
        for row in 0..batch.num_rows() {
            let mut cells = Vec::with_capacity(formatters.len());
            for (col, fmt) in formatters.iter().enumerate() {
                if columns[col].is_null(row) {
                    cells.push(String::new());
                } else {
                    cells.push(fmt.value(row).to_string());
                }
            }
            rows_out.push(cells);
        }
        batches.push(rows_out);
    }
    Ok(FetchedBatches {
        column_names,
        batches,
        float_like,
        rows,
    })
}

fn csv_escape(cell: &str) -> String {
    if cell.contains([',', '"', '\n']) {
        format!("\"{}\"", cell.replace('"', "\"\""))
    } else {
        cell.to_string()
    }
}

/// `fetch` as CSV: header row of column names, then one line per sample.
pub fn fetch_csv(
    reader: &LogReader,
    channel_id: &str,
    range: TimeRange,
    include_prev: bool,
) -> Result<String, String> {
    let fetched = fetch_batches(reader, channel_id, range, include_prev)?;
    let mut out = String::new();
    out.push_str(&fetched.column_names.join(","));
    out.push('\n');
    for batch in &fetched.batches {
        for row in batch {
            let line: Vec<String> = row.iter().map(|c| csv_escape(c)).collect();
            out.push_str(&line.join(","));
            out.push('\n');
        }
    }
    Ok(out)
}

/// `fetch --json`: `{ rows, columns: [{ name, values }] }`, matching the
/// web agent API's `fetchChannelRange` shape — 64-bit integer columns
/// (timestamps) stay strings, float columns become JSON numbers.
pub fn fetch_json(
    reader: &LogReader,
    channel_id: &str,
    range: TimeRange,
    include_prev: bool,
) -> Result<Value, String> {
    let fetched = fetch_batches(reader, channel_id, range, include_prev)?;
    let n_cols = fetched.column_names.len();
    let mut columns: Vec<Vec<Value>> = vec![Vec::with_capacity(fetched.rows); n_cols];
    for batch in &fetched.batches {
        for row in batch {
            for (col, cell) in row.iter().enumerate() {
                // int64-like and non-numeric columns both stay strings
                // (the ns-as-string rule covers the former).
                let v = if cell.is_empty() {
                    Value::Null
                } else if fetched.float_like[col] {
                    cell.parse::<f64>().map(Value::from).unwrap_or(Value::Null)
                } else {
                    Value::String(cell.clone())
                };
                columns[col].push(v);
            }
        }
    }
    Ok(json!({
        "rows": fetched.rows,
        "columns": fetched
            .column_names
            .iter()
            .zip(columns)
            .map(|(name, values)| json!({ "name": name, "values": values }))
            .collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::fixtures;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("driveline-data-cli-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).expect("write temp fixture");
        path
    }

    #[test]
    fn info_lists_mcap_channels() {
        let path = temp_file("short.mcap", &fixtures::short_mcap_bytes().unwrap());
        let reader = open_reader(&path).unwrap();
        let info = source_info_json(&reader);
        assert_eq!(info["kind"], "mcap");
        let channels = info["channels"].as_array().unwrap();
        assert!(!channels.is_empty());
        // ns ranges cross as decimal strings, not JSON numbers.
        assert!(info["timeRange"]["startNs"].is_string());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn fetch_csv_returns_header_and_rows() {
        let path = temp_file("short2.mcap", &fixtures::short_mcap_bytes().unwrap());
        let reader = open_reader(&path).unwrap();
        let info = source_info_json(&reader);
        let channel = info["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["kind"] == "scalar")
            .expect("scalar channel in fixture");
        let id = channel["id"].as_str().unwrap();
        let range = channel_range(&reader, id).unwrap();
        let csv = fetch_csv(&reader, id, range, false).unwrap();
        let mut lines = csv.lines();
        let header = lines.next().unwrap();
        assert!(header.contains("ts"), "header: {header}");
        assert!(lines.count() > 0, "expected at least one data row");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn fetch_json_keeps_ts_as_strings() {
        let path = temp_file("short.mf4", &fixtures::short_mf4_bytes().unwrap());
        let reader = open_reader(&path).unwrap();
        let info = source_info_json(&reader);
        let channel = &info["channels"].as_array().unwrap()[0];
        let id = channel["id"].as_str().unwrap();
        let range = channel_range(&reader, id).unwrap();
        let out = fetch_json(&reader, id, range, false).unwrap();
        assert!(out["rows"].as_u64().unwrap() > 0);
        let ts_col = out["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "ts")
            .expect("ts column");
        assert!(ts_col["values"].as_array().unwrap()[0].is_string());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn unknown_extension_is_rejected() {
        let path = temp_file("bogus.xyz", b"not a log");
        let err = match open_reader(&path) {
            Ok(_) => panic!("expected an error for an unknown extension"),
            Err(e) => e,
        };
        assert!(err.contains("unsupported extension"));
        // The message now lists the .xodr map-geometry extension too.
        assert!(err.contains(".xodr"), "message: {err}");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn opens_opendrive_map_geometry() {
        let xml = br#"<OpenDRIVE>
          <header name="cli_map"/>
          <road id="1" length="10"><planView>
            <geometry s="0" x="0" y="0" hdg="0" length="10"><line/></geometry>
          </planView>
          <lanes><laneSection s="0">
            <right><lane id="-1" type="driving"><width sOffset="0" a="3.5"/></lane></right>
          </laneSection></lanes>
          </road>
        </OpenDRIVE>"#;
        let path = temp_file("map.xodr", xml);
        let reader = open_reader(&path).unwrap();
        let info = source_info_json(&reader);
        assert_eq!(info["kind"], "map_geometry");
        let channels = info["channels"].as_array().unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0]["kind"], "map_geometry");

        // Fetch the single static frame and confirm it carries polyline rows.
        let id = channels[0]["id"].as_str().unwrap();
        let range = channel_range(&reader, id).unwrap();
        let csv = fetch_csv(&reader, id, range, false).unwrap();
        let header = csv.lines().next().unwrap();
        assert!(header.contains("points"), "header: {header}");
        assert!(header.contains("path_lengths"), "header: {header}");
        assert!(header.contains("types"), "header: {header}");
        assert!(csv.lines().count() > 1, "expected a data row");
        std::fs::remove_file(path).ok();
    }
}
