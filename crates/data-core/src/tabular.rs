//! `TabularReader`: ingests CSV and Parquet files as time-series signal
//! channels.
//!
//! A tabular source has one designated *time* column and zero or more numeric
//! *value* columns. Each numeric value column becomes a `Scalar` / `Float64`
//! channel whose `id` and `name` are the column name. Non-numeric columns are
//! skipped (and recorded as such) rather than failing the open.
//!
//! ## Timestamp precision
//!
//! Time values are converted to absolute nanoseconds with:
//!
//! ```text
//! ts_ns = raw_time * scale(unit) + epoch_offset_ns
//! ```
//!
//! When the source time value is an integer (a CSV integer string or a Parquet
//! integer column) the conversion stays in the i64 domain — routing an
//! absolute-epoch ns/us timestamp through f64 would lose precision (an f64 has
//! only 52 bits of mantissa, far short of the ~61 bits a 2020s-era ns epoch
//! needs). Only genuinely fractional time values fall back to f64. Value
//! columns are always materialised as f64, which is fine for signals.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;

use arrow_array::cast::AsArray;
use arrow_array::{Array, Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde::{Deserialize, Serialize};

use crate::reader::{ArrowIpc, Reader};
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

/// Which container format the bytes are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TabularFormat {
    Csv,
    Parquet,
}

/// Magnitude of one time unit in nanoseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeUnitScale {
    Nanos,
    Micros,
    Millis,
    Seconds,
}

impl TimeUnitScale {
    /// Nanoseconds per one unit of this scale.
    pub fn scale_ns(self) -> i64 {
        match self {
            TimeUnitScale::Nanos => 1,
            TimeUnitScale::Micros => 1_000,
            TimeUnitScale::Millis => 1_000_000,
            TimeUnitScale::Seconds => 1_000_000_000,
        }
    }
}

/// Whether the time column is an absolute epoch or relative to the file start.
/// Purely an informational/UI hint — the arithmetic is identical either way
/// (`raw * scale + epoch_offset_ns`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeMode {
    Absolute,
    Relative,
}

/// How to interpret the time column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeBasis {
    pub time_column: String,
    pub unit: TimeUnitScale,
    pub mode: TimeMode,
    /// Added to every timestamp after scaling. For a relative file this is the
    /// absolute start; for an absolute file it is usually 0.
    pub epoch_offset_ns: i64,
}

/// One column as seen by [`inspect`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabularColumn {
    pub name: String,
    /// Human-readable source dtype label (e.g. `"int64"`, `"float64"`,
    /// `"string"`). Informational only.
    pub dtype: String,
    pub is_numeric: bool,
}

/// Result of [`inspect`]: the column list plus a suggested [`TimeBasis`] the UI
/// can present pre-filled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabularSchema {
    pub columns: Vec<TabularColumn>,
    pub suggested: TimeBasis,
}

/// Heuristic: does this column name look like a time/timestamp column?
fn looks_like_time(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    matches!(
        n.as_str(),
        "time"
            | "timestamp"
            | "ts"
            | "t"
            | "t_us"
            | "t_ns"
            | "t_ms"
            | "t_s"
            | "time_ns"
            | "time_us"
            | "time_ms"
            | "time_s"
            | "timestamp_ns"
            | "timestamp_us"
            | "timestamp_ms"
    )
}

/// Guess the unit from the magnitude of a representative absolute timestamp.
/// Recent epochs land around: ns ~1.7e18, us ~1.7e15, ms ~1.7e12, s ~1.7e9.
/// Small values (relative offsets) default to Micros.
fn guess_unit_from_magnitude(sample: f64) -> TimeUnitScale {
    let m = sample.abs();
    if m >= 1e17 {
        TimeUnitScale::Nanos
    } else if m >= 1e14 {
        TimeUnitScale::Micros
    } else if m >= 1e11 {
        TimeUnitScale::Millis
    } else if m >= 1e8 {
        TimeUnitScale::Seconds
    } else {
        // Small relative offsets — no reliable epoch magnitude to key off.
        TimeUnitScale::Micros
    }
}

/// A column's raw time values, kept in their precise integer domain when the
/// source is integral so absolute-epoch timestamps survive conversion.
enum RawTime {
    Int(Vec<i64>),
    Float(Vec<f64>),
}

impl RawTime {
    fn len(&self) -> usize {
        match self {
            RawTime::Int(v) => v.len(),
            RawTime::Float(v) => v.len(),
        }
    }

    /// Convert to absolute ns using the basis. Integer time stays in i64 so
    /// precision is preserved; float time is rounded.
    fn to_ns(&self, basis: &TimeBasis) -> Vec<i64> {
        let scale = basis.unit.scale_ns();
        let off = basis.epoch_offset_ns;
        match self {
            RawTime::Int(v) => v
                .iter()
                .map(|&raw| raw.saturating_mul(scale).saturating_add(off))
                .collect(),
            RawTime::Float(v) => v
                .iter()
                .map(|&raw| {
                    let scaled = (raw * scale as f64).round() as i64;
                    scaled.saturating_add(off)
                })
                .collect(),
        }
    }
}

/// Parsed, in-memory representation of a tabular file: the time column already
/// converted to absolute ns, plus each numeric value column as a parallel
/// `Vec<f64>`. Time is sorted ascending (with values carried along) so
/// `fetch_range` can binary-search.
struct ParsedTable {
    ts_ns: Vec<i64>,
    /// column name -> values (parallel to `ts_ns`).
    columns: HashMap<String, Vec<f64>>,
    /// Stable column order for deterministic meta.
    order: Vec<String>,
}

/// Parse output: raw time column, `(name, values)` for each numeric value
/// column, and the names of columns that were skipped (non-numeric).
type ParseResult = (RawTime, Vec<(String, Vec<f64>)>, Vec<String>);

impl TabularFormat {
    fn from_str(s: &str) -> crate::Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "csv" => Ok(TabularFormat::Csv),
            "parquet" => Ok(TabularFormat::Parquet),
            other => Err(crate::Error::TabularUnsupportedFormat(other.to_string())),
        }
    }
}

/// Parse a string token as an integer if it is a clean integer literal,
/// otherwise as a float. Returns `None` if neither parses (so the column is
/// non-numeric / has missing data).
fn parse_numeric(tok: &str) -> Option<NumCell> {
    let t = tok.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(i) = t.parse::<i64>() {
        return Some(NumCell::Int(i));
    }
    if let Ok(f) = t.parse::<f64>() {
        return Some(NumCell::Float(f));
    }
    None
}

#[derive(Clone, Copy)]
enum NumCell {
    Int(i64),
    Float(f64),
}

impl NumCell {
    fn as_f64(self) -> f64 {
        match self {
            NumCell::Int(i) => i as f64,
            NumCell::Float(f) => f,
        }
    }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/// Read a CSV into per-column string vectors plus the header order.
fn read_csv_columns(bytes: &[u8]) -> crate::Result<(Vec<String>, Vec<Vec<String>>)> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(Cursor::new(bytes));
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| crate::Error::TabularParse(e.to_string()))?
        .iter()
        .map(|s| s.to_string())
        .collect();
    if headers.is_empty() {
        return Err(crate::Error::TabularParse("CSV has no header row".into()));
    }
    let mut cols: Vec<Vec<String>> = vec![Vec::new(); headers.len()];
    for rec in rdr.records() {
        let rec = rec.map_err(|e| crate::Error::TabularParse(e.to_string()))?;
        for (i, col) in cols.iter_mut().enumerate() {
            col.push(rec.get(i).unwrap_or("").to_string());
        }
    }
    Ok((headers, cols))
}

/// True if every non-empty cell parses as numeric (and at least one does).
fn csv_column_is_numeric(cells: &[String]) -> bool {
    let mut any = false;
    for c in cells {
        if c.trim().is_empty() {
            continue;
        }
        match parse_numeric(c) {
            Some(_) => any = true,
            None => return false,
        }
    }
    any
}

/// True if every non-empty cell parses as a clean integer (and at least one
/// does). Used to keep absolute-epoch time columns in the i64 domain.
fn csv_column_is_integer(cells: &[String]) -> bool {
    let mut any = false;
    for c in cells {
        let t = c.trim();
        if t.is_empty() {
            continue;
        }
        match t.parse::<i64>() {
            Ok(_) => any = true,
            Err(_) => return false,
        }
    }
    any
}

// ---------------------------------------------------------------------------
// Parquet
// ---------------------------------------------------------------------------

/// Read all row groups of a Parquet file into a single concatenated set of
/// Arrow record batches, returning the schema and the batches.
fn read_parquet_batches(bytes: &[u8]) -> crate::Result<(Arc<Schema>, Vec<RecordBatch>)> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes_to_owned(bytes))
        .map_err(|e| crate::Error::TabularParse(e.to_string()))?;
    let schema = builder.schema().clone();
    let reader = builder
        .build()
        .map_err(|e| crate::Error::TabularParse(e.to_string()))?;
    let mut batches = Vec::new();
    for batch in reader {
        batches.push(batch.map_err(|e| crate::Error::TabularParse(e.to_string()))?);
    }
    Ok((schema, batches))
}

/// `ParquetRecordBatchReaderBuilder::try_new` wants something implementing
/// `ChunkReader`; `bytes::Bytes` does. Copy the slice into an owned `Bytes`.
fn bytes_to_owned(bytes: &[u8]) -> bytes::Bytes {
    bytes::Bytes::copy_from_slice(bytes)
}

/// Is this Arrow dtype something we can read as a numeric value column?
fn parquet_dtype_is_numeric(dt: &DataType) -> bool {
    matches!(
        dt,
        DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float16
            | DataType::Float32
            | DataType::Float64
            | DataType::Boolean
    )
}

/// Is this Arrow dtype an integer type (so it can hold a precise time column)?
fn parquet_dtype_is_integer(dt: &DataType) -> bool {
    matches!(
        dt,
        DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
    )
}

/// Pull one numeric column out of the batches as f64 (NaN for nulls). Returns
/// `None` if the column isn't numeric.
fn parquet_column_as_f64(batches: &[RecordBatch], col_idx: usize) -> Option<Vec<f64>> {
    let mut out = Vec::new();
    for batch in batches {
        let arr = batch.column(col_idx);
        match arr.data_type() {
            DataType::Float64 => {
                let a = arr.as_primitive::<arrow_array::types::Float64Type>();
                push_f64(&mut out, a, |x| x);
            }
            DataType::Float32 => {
                let a = arr.as_primitive::<arrow_array::types::Float32Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::Int8 => {
                let a = arr.as_primitive::<arrow_array::types::Int8Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::Int16 => {
                let a = arr.as_primitive::<arrow_array::types::Int16Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::Int32 => {
                let a = arr.as_primitive::<arrow_array::types::Int32Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::Int64 => {
                let a = arr.as_primitive::<arrow_array::types::Int64Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::UInt8 => {
                let a = arr.as_primitive::<arrow_array::types::UInt8Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::UInt16 => {
                let a = arr.as_primitive::<arrow_array::types::UInt16Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::UInt32 => {
                let a = arr.as_primitive::<arrow_array::types::UInt32Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::UInt64 => {
                let a = arr.as_primitive::<arrow_array::types::UInt64Type>();
                push_f64(&mut out, a, |x| x as f64);
            }
            DataType::Boolean => {
                let a = arr.as_boolean();
                for i in 0..a.len() {
                    out.push(if a.is_null(i) {
                        f64::NAN
                    } else if a.value(i) {
                        1.0
                    } else {
                        0.0
                    });
                }
            }
            _ => return None,
        }
    }
    Some(out)
}

fn push_f64<T>(
    out: &mut Vec<f64>,
    arr: &arrow_array::PrimitiveArray<T>,
    conv: impl Fn(T::Native) -> f64,
) where
    T: arrow_array::ArrowPrimitiveType,
{
    for i in 0..arr.len() {
        if arr.is_null(i) {
            out.push(f64::NAN);
        } else {
            out.push(conv(arr.value(i)));
        }
    }
}

/// Pull an integer time column out of the batches as i64. Returns `None` if the
/// column isn't an integer type.
fn parquet_column_as_i64(batches: &[RecordBatch], col_idx: usize) -> Option<Vec<i64>> {
    let mut out = Vec::new();
    for batch in batches {
        let arr = batch.column(col_idx);
        match arr.data_type() {
            DataType::Int8 => {
                push_i64(&mut out, arr.as_primitive::<arrow_array::types::Int8Type>())
            }
            DataType::Int16 => push_i64(
                &mut out,
                arr.as_primitive::<arrow_array::types::Int16Type>(),
            ),
            DataType::Int32 => push_i64(
                &mut out,
                arr.as_primitive::<arrow_array::types::Int32Type>(),
            ),
            DataType::Int64 => push_i64(
                &mut out,
                arr.as_primitive::<arrow_array::types::Int64Type>(),
            ),
            DataType::UInt8 => push_i64(
                &mut out,
                arr.as_primitive::<arrow_array::types::UInt8Type>(),
            ),
            DataType::UInt16 => push_i64(
                &mut out,
                arr.as_primitive::<arrow_array::types::UInt16Type>(),
            ),
            DataType::UInt32 => push_i64(
                &mut out,
                arr.as_primitive::<arrow_array::types::UInt32Type>(),
            ),
            DataType::UInt64 => push_i64(
                &mut out,
                arr.as_primitive::<arrow_array::types::UInt64Type>(),
            ),
            _ => return None,
        }
    }
    Some(out)
}

fn push_i64<T>(out: &mut Vec<i64>, arr: &arrow_array::PrimitiveArray<T>)
where
    T: arrow_array::ArrowPrimitiveType,
    T::Native: TryInto<i64> + Copy,
{
    for i in 0..arr.len() {
        if arr.is_null(i) {
            out.push(0);
        } else {
            out.push(arr.value(i).try_into().ok().unwrap_or(0));
        }
    }
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

/// Parse headers (and enough rows to classify columns) and suggest a
/// [`TimeBasis`]. Does not retain the bytes.
pub fn inspect(bytes: &[u8], format: TabularFormat) -> crate::Result<TabularSchema> {
    match format {
        TabularFormat::Csv => inspect_csv(bytes),
        TabularFormat::Parquet => inspect_parquet(bytes),
    }
}

fn build_suggested(
    columns: &[TabularColumn],
    integer_names: &std::collections::HashSet<String>,
    first_value: impl Fn(&str) -> Option<f64>,
) -> TimeBasis {
    // Prefer a column that *looks* like time; else the first integer column;
    // else the first numeric column; else the first column.
    let time_col = columns
        .iter()
        .find(|c| c.is_numeric && looks_like_time(&c.name))
        .or_else(|| {
            columns
                .iter()
                .find(|c| c.is_numeric && integer_names.contains(&c.name))
        })
        .or_else(|| columns.iter().find(|c| c.is_numeric))
        .or_else(|| columns.first());

    let time_column = time_col.map(|c| c.name.clone()).unwrap_or_default();
    let unit = first_value(&time_column)
        .map(guess_unit_from_magnitude)
        .unwrap_or(TimeUnitScale::Micros);

    TimeBasis {
        time_column,
        unit,
        mode: TimeMode::Absolute,
        epoch_offset_ns: 0,
    }
}

fn inspect_csv(bytes: &[u8]) -> crate::Result<TabularSchema> {
    let (headers, cols) = read_csv_columns(bytes)?;
    let mut columns = Vec::with_capacity(headers.len());
    let mut integer_names = std::collections::HashSet::new();
    for (name, cells) in headers.iter().zip(cols.iter()) {
        let is_numeric = csv_column_is_numeric(cells);
        let is_integer = is_numeric && csv_column_is_integer(cells);
        if is_integer {
            integer_names.insert(name.clone());
        }
        let dtype = if is_integer {
            "int64".to_string()
        } else if is_numeric {
            "float64".to_string()
        } else {
            "string".to_string()
        };
        columns.push(TabularColumn {
            name: name.clone(),
            dtype,
            is_numeric,
        });
    }

    let first_value = |name: &str| -> Option<f64> {
        let idx = headers.iter().position(|h| h == name)?;
        cols[idx]
            .iter()
            .find_map(|c| parse_numeric(c).map(|n| n.as_f64()))
    };
    let suggested = build_suggested(&columns, &integer_names, first_value);
    Ok(TabularSchema { columns, suggested })
}

fn inspect_parquet(bytes: &[u8]) -> crate::Result<TabularSchema> {
    let (schema, batches) = read_parquet_batches(bytes)?;
    let mut columns = Vec::with_capacity(schema.fields().len());
    let mut integer_names = std::collections::HashSet::new();
    for field in schema.fields() {
        let dt = field.data_type();
        let is_numeric = parquet_dtype_is_numeric(dt);
        if is_numeric && parquet_dtype_is_integer(dt) {
            integer_names.insert(field.name().clone());
        }
        columns.push(TabularColumn {
            name: field.name().clone(),
            dtype: format!("{dt:?}").to_ascii_lowercase(),
            is_numeric,
        });
    }

    let first_value = |name: &str| -> Option<f64> {
        let idx = schema.index_of(name).ok()?;
        let col = parquet_column_as_f64(&batches, idx)?;
        col.into_iter().find(|x| !x.is_nan())
    };
    let suggested = build_suggested(&columns, &integer_names, first_value);
    Ok(TabularSchema { columns, suggested })
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

pub struct TabularReader {
    meta: SourceMeta,
    table: ParsedTable,
    /// Columns skipped because they were non-numeric or were the time column.
    skipped: Vec<String>,
}

impl TabularReader {
    /// The real entry point: parse `bytes` in `format`, interpreting the time
    /// column per `basis`. Each non-time numeric column becomes a `Scalar`
    /// channel.
    pub fn open_with_basis(
        bytes: &[u8],
        format: TabularFormat,
        basis: TimeBasis,
    ) -> crate::Result<Self> {
        let (raw_time, value_cols, mut skipped) = match format {
            TabularFormat::Csv => Self::parse_csv(bytes, &basis)?,
            TabularFormat::Parquet => Self::parse_parquet(bytes, &basis)?,
        };

        let n = raw_time.len();
        let ts_unsorted = raw_time.to_ns(&basis);

        // Sort by time, carrying every value column along. Most logs are
        // already ordered, but we don't rely on it — `fetch_range` binary
        // searches.
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&i| ts_unsorted[i]);
        let already_sorted = order.iter().enumerate().all(|(i, &j)| i == j);

        let ts_ns: Vec<i64> = if already_sorted {
            ts_unsorted
        } else {
            order.iter().map(|&i| ts_unsorted[i]).collect()
        };

        let mut columns: HashMap<String, Vec<f64>> = HashMap::new();
        let mut col_order: Vec<String> = Vec::new();
        for (name, values) in value_cols {
            let sorted_vals: Vec<f64> = if already_sorted {
                values
            } else {
                order.iter().map(|&i| values[i]).collect()
            };
            col_order.push(name.clone());
            columns.insert(name, sorted_vals);
        }

        skipped.sort();
        skipped.dedup();

        let table = ParsedTable {
            ts_ns,
            columns,
            order: col_order,
        };

        let time_range = match (table.ts_ns.first(), table.ts_ns.last()) {
            (Some(&a), Some(&b)) => TimeRange {
                start_ns: a,
                end_ns: b.saturating_add(1),
            },
            _ => TimeRange::empty(),
        };

        let channels = table
            .order
            .iter()
            .map(|name| Channel {
                id: name.clone(),
                source_id: String::new(),
                name: name.clone(),
                kind: ChannelKind::Scalar,
                dtype: Some(DType::F64),
                unit: None,
                sample_count: table.ts_ns.len() as u64,
                time_range,
            })
            .collect();

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::Tabular,
            time_range,
            channels,
        };

        Ok(TabularReader {
            meta,
            table,
            skipped,
        })
    }

    /// Column names that were present but not surfaced as channels (non-numeric
    /// columns and the time column itself).
    pub fn skipped_columns(&self) -> &[String] {
        &self.skipped
    }

    fn parse_csv(bytes: &[u8], basis: &TimeBasis) -> crate::Result<ParseResult> {
        let (headers, cols) = read_csv_columns(bytes)?;
        let time_idx = headers
            .iter()
            .position(|h| h == &basis.time_column)
            .ok_or_else(|| crate::Error::TabularTimeColumnMissing(basis.time_column.clone()))?;

        // Read the time column in integer domain when it is clean integers,
        // preserving absolute-epoch precision.
        let raw_time = if csv_column_is_integer(&cols[time_idx]) {
            RawTime::Int(
                cols[time_idx]
                    .iter()
                    .map(|c| c.trim().parse::<i64>().unwrap_or(0))
                    .collect(),
            )
        } else {
            RawTime::Float(
                cols[time_idx]
                    .iter()
                    .map(|c| parse_numeric(c).map(|n| n.as_f64()).unwrap_or(f64::NAN))
                    .collect(),
            )
        };

        let mut value_cols = Vec::new();
        let mut skipped = Vec::new();
        for (i, name) in headers.iter().enumerate() {
            if i == time_idx {
                continue;
            }
            if csv_column_is_numeric(&cols[i]) {
                let vals: Vec<f64> = cols[i]
                    .iter()
                    .map(|c| parse_numeric(c).map(|n| n.as_f64()).unwrap_or(f64::NAN))
                    .collect();
                value_cols.push((name.clone(), vals));
            } else {
                skipped.push(name.clone());
            }
        }
        Ok((raw_time, value_cols, skipped))
    }

    fn parse_parquet(bytes: &[u8], basis: &TimeBasis) -> crate::Result<ParseResult> {
        let (schema, batches) = read_parquet_batches(bytes)?;
        let time_idx = schema
            .index_of(&basis.time_column)
            .map_err(|_| crate::Error::TabularTimeColumnMissing(basis.time_column.clone()))?;

        let time_dt = schema.field(time_idx).data_type();
        let raw_time = if parquet_dtype_is_integer(time_dt) {
            RawTime::Int(parquet_column_as_i64(&batches, time_idx).unwrap_or_default())
        } else {
            RawTime::Float(parquet_column_as_f64(&batches, time_idx).unwrap_or_default())
        };

        let mut value_cols = Vec::new();
        let mut skipped = Vec::new();
        for (i, field) in schema.fields().iter().enumerate() {
            if i == time_idx {
                continue;
            }
            if parquet_dtype_is_numeric(field.data_type()) {
                if let Some(vals) = parquet_column_as_f64(&batches, i) {
                    value_cols.push((field.name().clone(), vals));
                    continue;
                }
            }
            skipped.push(field.name().clone());
        }
        Ok((raw_time, value_cols, skipped))
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
}

impl Reader for TabularReader {
    /// The trait `open` has no basis parameter, so it inspects the bytes,
    /// adopts the *suggested* basis, and opens with that. Callers that need a
    /// specific basis use [`TabularReader::open_with_basis`].
    ///
    /// `Reader::open` is format-agnostic by signature; we sniff CSV vs Parquet
    /// from the magic bytes (`PAR1` header for Parquet, else CSV).
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        let format = if bytes.len() >= 4 && &bytes[..4] == b"PAR1" {
            TabularFormat::Parquet
        } else {
            TabularFormat::Csv
        };
        let schema = inspect(bytes, format)?;
        Self::open_with_basis(bytes, format, schema.suggested)
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
        let values = self
            .table
            .columns
            .get(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        let ts = &self.table.ts_ns;
        let start_idx = ts.partition_point(|&t| t < range.start_ns);
        let end_idx = ts.partition_point(|&t| t < range.end_ns).max(start_idx);
        let prev_idx = if opts.include_prev && start_idx > 0 {
            Some(start_idx - 1)
        } else {
            None
        };

        let (ts_final, vals_final): (Vec<i64>, Vec<f64>) =
            if start_idx == end_idx && prev_idx.is_none() {
                (Vec::new(), Vec::new())
            } else {
                let mut t: Vec<i64> = ts[start_idx..end_idx].to_vec();
                let mut v: Vec<f64> = values[start_idx..end_idx].to_vec();
                if let Some(p) = prev_idx {
                    t.insert(0, ts[p]);
                    v.insert(0, values[p]);
                }
                (t, v)
            };

        let schema = Self::scalar_schema();
        let ts_array = TimestampNanosecondArray::from(ts_final).with_timezone("UTC");
        let value_array = Float64Array::from(vals_final);
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(ts_array), Arc::new(value_array)],
        )?;

        let mut buf = Vec::new();
        {
            let mut w = FileWriter::try_new(&mut buf, &schema)?;
            w.write(&batch)?;
            w.finish()?;
        }
        Ok(buf)
    }
}

/// Convenience for the wasm layer: parse a `TabularFormat` from its lowercase
/// string name (`"csv"` / `"parquet"`).
pub fn format_from_str(s: &str) -> crate::Result<TabularFormat> {
    TabularFormat::from_str(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::Array;
    use arrow_ipc::reader::FileReader;

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1, "expected exactly one record batch");
        batches.into_iter().next().unwrap()
    }

    fn col_f64(batch: &RecordBatch) -> Vec<f64> {
        let v = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        (0..v.len()).map(|i| v.value(i)).collect()
    }

    fn col_ts(batch: &RecordBatch) -> Vec<i64> {
        let t = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        (0..t.len()).map(|i| t.value(i)).collect()
    }

    const CSV_US: &str = "timestamp_us,speed,rpm\n\
1704067200000000,10,1000\n\
1704067200001000,11,1100\n\
1704067200002000,12,1200\n";

    #[test]
    fn inspect_csv_suggests_time_column_and_unit() {
        let schema = inspect(CSV_US.as_bytes(), TabularFormat::Csv).unwrap();
        assert_eq!(schema.columns.len(), 3);
        assert_eq!(schema.suggested.time_column, "timestamp_us");
        assert_eq!(schema.suggested.unit, TimeUnitScale::Micros);
        assert_eq!(schema.suggested.mode, TimeMode::Absolute);
        assert_eq!(schema.suggested.epoch_offset_ns, 0);
        // speed and rpm are numeric (integers here).
        assert!(schema.columns.iter().all(|c| c.is_numeric));
    }

    #[test]
    fn csv_absolute_us_preserves_integer_precision() {
        let basis = TimeBasis {
            time_column: "timestamp_us".into(),
            unit: TimeUnitScale::Micros,
            mode: TimeMode::Absolute,
            epoch_offset_ns: 0,
        };
        let r =
            TabularReader::open_with_basis(CSV_US.as_bytes(), TabularFormat::Csv, basis).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Tabular);
        assert_eq!(r.meta().channels.len(), 2); // speed + rpm

        let ipc = r
            .fetch_range(
                &"speed".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        // 1704067200000000 us = 1704067200000000000 ns exactly (beyond f64
        // exact-integer range, so this proves the i64 path).
        assert_eq!(
            col_ts(&batch),
            vec![
                1_704_067_200_000_000_000,
                1_704_067_200_001_000_000,
                1_704_067_200_002_000_000
            ]
        );
        assert_eq!(col_f64(&batch), vec![10.0, 11.0, 12.0]);
    }

    #[test]
    fn csv_relative_mode_with_epoch_offset_shifts() {
        let csv = "t,val\n0,1\n100,2\n200,3\n";
        let basis = TimeBasis {
            time_column: "t".into(),
            unit: TimeUnitScale::Millis,
            mode: TimeMode::Relative,
            epoch_offset_ns: 1_704_067_200_000_000_000,
        };
        let r = TabularReader::open_with_basis(csv.as_bytes(), TabularFormat::Csv, basis).unwrap();
        let ipc = r
            .fetch_range(
                &"val".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(
            col_ts(&batch),
            vec![
                1_704_067_200_000_000_000,
                1_704_067_200_100_000_000,
                1_704_067_200_200_000_000
            ]
        );
        assert_eq!(col_f64(&batch), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn csv_skips_non_numeric_columns() {
        let csv = "t,label,val\n0,foo,1\n1,bar,2\n";
        let basis = TimeBasis {
            time_column: "t".into(),
            unit: TimeUnitScale::Seconds,
            mode: TimeMode::Relative,
            epoch_offset_ns: 0,
        };
        let r = TabularReader::open_with_basis(csv.as_bytes(), TabularFormat::Csv, basis).unwrap();
        let names: Vec<&str> = r.meta().channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["val"]);
        assert_eq!(r.skipped_columns(), &["label".to_string()]);
    }

    #[test]
    fn fetch_range_respects_bounds_and_include_prev() {
        let basis = TimeBasis {
            time_column: "timestamp_us".into(),
            unit: TimeUnitScale::Micros,
            mode: TimeMode::Absolute,
            epoch_offset_ns: 0,
        };
        let r =
            TabularReader::open_with_basis(CSV_US.as_bytes(), TabularFormat::Csv, basis).unwrap();
        // Window covering only the middle sample.
        let range = TimeRange {
            start_ns: 1_704_067_200_001_000_000,
            end_ns: 1_704_067_200_002_000_000,
        };
        let ipc = r
            .fetch_range(&"speed".to_string(), range, FetchOpts::default())
            .unwrap();
        assert_eq!(col_f64(&parse_ipc(&ipc)), vec![11.0]);

        let ipc_prev = r
            .fetch_range(
                &"speed".to_string(),
                range,
                FetchOpts { include_prev: true },
            )
            .unwrap();
        assert_eq!(col_f64(&parse_ipc(&ipc_prev)), vec![10.0, 11.0]);
    }

    #[test]
    fn unknown_channel_errors() {
        let basis = TimeBasis {
            time_column: "timestamp_us".into(),
            unit: TimeUnitScale::Micros,
            mode: TimeMode::Absolute,
            epoch_offset_ns: 0,
        };
        let r =
            TabularReader::open_with_basis(CSV_US.as_bytes(), TabularFormat::Csv, basis).unwrap();
        let err = r
            .fetch_range(
                &"nope".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn emitted_schema_matches_fixture_scalar_schema() {
        // Byte-for-byte the scalar schema fixtures.rs builds: ts Timestamp(ns,
        // UTC) + value Float64.
        let basis = TimeBasis {
            time_column: "timestamp_us".into(),
            unit: TimeUnitScale::Micros,
            mode: TimeMode::Absolute,
            epoch_offset_ns: 0,
        };
        let r =
            TabularReader::open_with_basis(CSV_US.as_bytes(), TabularFormat::Csv, basis).unwrap();
        let ipc = r
            .fetch_range(
                &"speed".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);

        let fixture = crate::fixtures::arrow_scalar_ipc().unwrap();
        let fixture_batch = parse_ipc(&fixture);
        assert_eq!(
            batch.schema().as_ref(),
            fixture_batch.schema().as_ref(),
            "tabular scalar schema must match the canonical fixture schema"
        );
    }

    #[test]
    fn unsorted_csv_is_sorted_by_time() {
        let csv = "t,val\n2,30\n0,10\n1,20\n";
        let basis = TimeBasis {
            time_column: "t".into(),
            unit: TimeUnitScale::Seconds,
            mode: TimeMode::Relative,
            epoch_offset_ns: 0,
        };
        let r = TabularReader::open_with_basis(csv.as_bytes(), TabularFormat::Csv, basis).unwrap();
        let ipc = r
            .fetch_range(
                &"val".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(col_ts(&batch), vec![0, 1_000_000_000, 2_000_000_000]);
        assert_eq!(col_f64(&batch), vec![10.0, 20.0, 30.0]);
    }

    // ---- Parquet ----

    fn write_parquet(schema: Arc<Schema>, batch: RecordBatch) -> Vec<u8> {
        use parquet::arrow::ArrowWriter;
        let mut buf = Vec::new();
        {
            let mut w = ArrowWriter::try_new(&mut buf, schema, None).unwrap();
            w.write(&batch).unwrap();
            w.close().unwrap();
        }
        buf
    }

    fn sample_parquet() -> Vec<u8> {
        use arrow_array::{Int64Array, StringArray};
        let schema = Arc::new(Schema::new(vec![
            Field::new("t_us", DataType::Int64, false),
            Field::new("speed", DataType::Float64, false),
            Field::new("label", DataType::Utf8, false),
        ]));
        let t = Int64Array::from(vec![
            1_704_067_200_000_000i64,
            1_704_067_200_001_000,
            1_704_067_200_002_000,
        ]);
        let speed = Float64Array::from(vec![5.5, 6.5, 7.5]);
        let label = StringArray::from(vec!["a", "b", "c"]);
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(t), Arc::new(speed), Arc::new(label)],
        )
        .unwrap();
        write_parquet(schema, batch)
    }

    #[test]
    fn inspect_parquet_classifies_columns() {
        let bytes = sample_parquet();
        let schema = inspect(&bytes, TabularFormat::Parquet).unwrap();
        let by_name = |n: &str| schema.columns.iter().find(|c| c.name == n).unwrap();
        assert!(by_name("t_us").is_numeric);
        assert!(by_name("speed").is_numeric);
        assert!(!by_name("label").is_numeric);
        // t_us looks like time and is integer -> suggested.
        assert_eq!(schema.suggested.time_column, "t_us");
        assert_eq!(schema.suggested.unit, TimeUnitScale::Micros);
    }

    #[test]
    fn parquet_reads_and_preserves_integer_precision() {
        let bytes = sample_parquet();
        let basis = TimeBasis {
            time_column: "t_us".into(),
            unit: TimeUnitScale::Micros,
            mode: TimeMode::Absolute,
            epoch_offset_ns: 0,
        };
        let r = TabularReader::open_with_basis(&bytes, TabularFormat::Parquet, basis).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Tabular);
        // speed only; label skipped, t_us is the time column.
        let names: Vec<&str> = r.meta().channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["speed"]);
        assert_eq!(r.skipped_columns(), &["label".to_string()]);

        let ipc = r
            .fetch_range(
                &"speed".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(
            col_ts(&batch),
            vec![
                1_704_067_200_000_000_000,
                1_704_067_200_001_000_000,
                1_704_067_200_002_000_000
            ]
        );
        assert_eq!(col_f64(&batch), vec![5.5, 6.5, 7.5]);
    }

    #[test]
    fn open_sniffs_format_from_magic() {
        // Parquet magic.
        let pq = sample_parquet();
        let r = TabularReader::open(&pq).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Tabular);
        // CSV (no PAR1 magic).
        let r2 = TabularReader::open(CSV_US.as_bytes()).unwrap();
        assert_eq!(r2.meta().kind, SourceKind::Tabular);
    }
}
