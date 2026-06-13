//! `RecipeReader`: decodes an *unknown* binary log format using a declarative
//! **Ingest Recipe** — never executable code. See `docs/12-format-agent.md`.
//!
//! A recipe describes how to slice a file into fixed-size records and how to
//! read typed fields out of each record. Each declared channel becomes a
//! `Scalar` / `Float64` time-series channel, emitting exactly the same Arrow
//! IPC schema as [`crate::tabular::TabularReader`] (`ts: Timestamp(ns, UTC)`,
//! `value: Float64`), so everything downstream — the wasm slab, the JS store,
//! `seriesFromArrow.ts`, the plot panel — treats a recipe source identically to
//! a CSV/Parquet source.
//!
//! ## Trust boundary
//!
//! A recipe is **model-authored and therefore untrusted input** (it may come
//! from the Format Agent or a colleague's shared JSON). Every numeric bound is
//! clamped (`MAX_RECORD_SIZE`, `MAX_FIELDS`, `MAX_CHANNELS`) and every byte read
//! is bounds-checked, so a malformed recipe over a hostile file produces decode
//! *statistics*, never a panic, OOB read, or unbounded allocation.
//!
//! ## Timestamp precision
//!
//! When the time field's dtype is integral, the conversion
//! `ts_ns = raw * scale(unit) + epoch_offset_ns` stays in the i64 domain so an
//! absolute-epoch microsecond/nanosecond timestamp survives without the
//! precision loss an f64 round-trip would cause (mirrors `tabular.rs`). Value
//! fields are always materialised as f64, which is fine for signals.

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::{Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use serde::{Deserialize, Serialize};

use crate::reader::{ArrowIpc, Reader};
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

// --- Safety clamps -----------------------------------------------------------

/// A single fixed record may not exceed 1 MiB. Length-prefixed strategies (when
/// added) get their own per-record ceiling.
const MAX_RECORD_SIZE: u64 = 1 << 20;
/// Upper bound on fields declared in a recipe.
const MAX_FIELDS: usize = 512;
/// Upper bound on channels surfaced by a recipe.
const MAX_CHANNELS: usize = 256;

// --- Recipe schema (serde) ---------------------------------------------------

/// Magnitude of one time unit in nanoseconds. Distinct from
/// [`crate::tabular::TimeUnitScale`] only in its JSON spelling
/// (`"micros"` vs `"Micros"`) so recipe JSON reads naturally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecipeTimeUnit {
    Nanos,
    Micros,
    Millis,
    Seconds,
}

impl RecipeTimeUnit {
    fn scale_ns(self) -> i64 {
        match self {
            RecipeTimeUnit::Nanos => 1,
            RecipeTimeUnit::Micros => 1_000,
            RecipeTimeUnit::Millis => 1_000_000,
            RecipeTimeUnit::Seconds => 1_000_000_000,
        }
    }
}

/// Whether the time column is an absolute epoch or relative to file start.
/// Informational only — the arithmetic is identical either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RecipeTimeMode {
    #[default]
    Absolute,
    Relative,
}

/// Expectation on the decoded time series, asserted by [`RecipeReader::dry_run`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Monotonicity {
    #[default]
    None,
    NonDecreasing,
    StrictlyIncreasing,
}

/// One numeric field's binary layout within a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldDType {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
    F32,
    F64,
}

impl FieldDType {
    fn size(self) -> u64 {
        match self {
            FieldDType::U8 | FieldDType::I8 => 1,
            FieldDType::U16 | FieldDType::I16 => 2,
            FieldDType::U32 | FieldDType::I32 | FieldDType::F32 => 4,
            FieldDType::U64 | FieldDType::I64 | FieldDType::F64 => 8,
        }
    }

    fn is_integer(self) -> bool {
        !matches!(self, FieldDType::F32 | FieldDType::F64)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Endian {
    #[default]
    Le,
    Be,
}

/// Container framing strategy. v1 implements `fixed_record`; the enum is the
/// extension point for `length_prefixed` / `delimited_text` / `chunked`
/// (`docs/12-format-agent.md` §3.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Container {
    /// File = `header_skip_bytes` of preamble, then back-to-back records of
    /// `record_size_bytes` each. A trailing partial record is ignored.
    //
    // NOTE: serde does not support `deny_unknown_fields` on a variant of an
    // internally-tagged enum (the tag field is consumed by the enum, leaving
    // the variant unable to reason about unknown keys). Unknown keys inside the
    // container are therefore rejected at the JSON-Schema layer
    // (`additionalProperties:false` in `docs/schemas/recipe.v1.schema.json`,
    // enforced by ajv before the recipe ever reaches Rust), not here.
    #[serde(rename_all = "camelCase")]
    FixedRecord {
        #[serde(default)]
        header_skip_bytes: u64,
        record_size_bytes: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeSpec {
    /// Name of the field (declared in `fields`) holding the timestamp.
    pub field: String,
    pub unit: RecipeTimeUnit,
    #[serde(default)]
    pub mode: RecipeTimeMode,
    /// Added to every timestamp after scaling. Decimal string (ns values exceed
    /// 2^53). Defaults to `"0"`.
    #[serde(default)]
    pub epoch_offset_ns: Option<String>,
    #[serde(default)]
    pub monotonicity: Monotonicity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldSpec {
    pub name: String,
    pub offset: u64,
    pub dtype: FieldDType,
    #[serde(default)]
    pub endian: Endian,
    /// Linear transform applied to value fields: `out = raw * scale + value_offset`.
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default)]
    pub value_offset: f64,
    #[serde(default)]
    pub unit: Option<String>,
    /// Optional code→label map for enum-like fields. Parsed and surfaced in the
    /// recipe for completeness; in v1 the channel still decodes to the numeric
    /// code as a scalar (see module docs).
    #[serde(default)]
    pub enum_dict: Option<HashMap<String, String>>,
}

fn default_scale() -> f64 {
    1.0
}

/// Channel kinds a recipe may declare. v1 surfaces every channel as a scalar
/// f64 series regardless of `kind`; `Enum` is accepted (single code field) so
/// recipes are forward-compatible with enum-lane rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RecipeChannelKind {
    #[default]
    Scalar,
    Enum,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelSpec {
    /// Stable id, unique within the source. Used as the channel id + name when
    /// `name` is absent.
    pub native_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub kind: RecipeChannelKind,
    /// Exactly one field name in v1 (the value/code field).
    pub fields: Vec<String>,
    #[serde(default)]
    pub unit: Option<String>,
}

/// The full recipe document. `detect` and `provenance` are consumed by the
/// JS-side Format Registry, not the decoder — they are accepted and ignored
/// here so a registry round-trip never strips them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipe {
    pub recipe_version: u32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub container: Container,
    pub time: TimeSpec,
    pub fields: Vec<FieldSpec>,
    pub channels: Vec<ChannelSpec>,
    #[serde(default)]
    pub detect: Option<serde_json::Value>,
    #[serde(default)]
    pub provenance: Option<serde_json::Value>,
}

// --- Dry-run report (agent feedback signal) ----------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PerChannelStat {
    pub native_id: String,
    pub count: u64,
    pub min: f64,
    pub max: f64,
    pub nan_count: u64,
    pub constant: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimeStats {
    pub start_ns: i64,
    pub end_ns: i64,
    pub monotonic_violations: u64,
    pub median_delta_ns: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DryRunError {
    pub byte_offset: u64,
    pub reason: String,
}

/// Statistics from decoding (a bounded prefix of) the full file with a candidate
/// recipe. This is what the Format Agent's `validate_recipe` tool returns to the
/// model so it can iterate (`docs/12-format-agent.md` §4.4).
#[derive(Debug, Clone, Serialize)]
pub struct DryRunReport {
    pub records_decoded: u64,
    pub records_rejected: u64,
    pub first_error: Option<DryRunError>,
    pub time_stats: Option<TimeStats>,
    pub per_channel: Vec<PerChannelStat>,
    /// Fraction of the file's bytes the recipe consumed as whole records.
    pub coverage: f64,
}

// --- Low-level binary reads (bounds-checked) ---------------------------------

/// Read a field as f64 from `rec` (one record's bytes). Returns `None` if the
/// field would read out of bounds — the caller treats that as a rejected record.
fn read_f64(rec: &[u8], f: &FieldSpec) -> Option<f64> {
    let off = usize::try_from(f.offset).ok()?;
    let sz = f.dtype.size() as usize;
    let end = off.checked_add(sz)?;
    let b = rec.get(off..end)?;
    let le = matches!(f.endian, Endian::Le);
    let v = match f.dtype {
        FieldDType::U8 => b[0] as f64,
        FieldDType::I8 => (b[0] as i8) as f64,
        FieldDType::U16 => to_u16(b, le) as f64,
        FieldDType::I16 => (to_u16(b, le) as i16) as f64,
        FieldDType::U32 => to_u32(b, le) as f64,
        FieldDType::I32 => (to_u32(b, le) as i32) as f64,
        FieldDType::U64 => to_u64(b, le) as f64,
        FieldDType::I64 => (to_u64(b, le) as i64) as f64,
        FieldDType::F32 => f32::from_bits(to_u32(b, le)) as f64,
        FieldDType::F64 => f64::from_bits(to_u64(b, le)),
    };
    Some(v * f.scale + f.value_offset)
}

/// Read an integral field as i64 (raw, before scaling). `None` for non-integer
/// dtypes or OOB.
fn read_i64(rec: &[u8], f: &FieldSpec) -> Option<i64> {
    if !f.dtype.is_integer() {
        return None;
    }
    let off = usize::try_from(f.offset).ok()?;
    let sz = f.dtype.size() as usize;
    let b = rec.get(off..off.checked_add(sz)?)?;
    let le = matches!(f.endian, Endian::Le);
    let v = match f.dtype {
        FieldDType::U8 => b[0] as i64,
        FieldDType::I8 => (b[0] as i8) as i64,
        FieldDType::U16 => to_u16(b, le) as i64,
        FieldDType::I16 => (to_u16(b, le) as i16) as i64,
        FieldDType::U32 => to_u32(b, le) as i64,
        FieldDType::I32 => (to_u32(b, le) as i32) as i64,
        FieldDType::U64 => to_u64(b, le) as i64,
        FieldDType::I64 => to_u64(b, le) as i64,
        _ => return None,
    };
    Some(v)
}

fn to_u16(b: &[u8], le: bool) -> u16 {
    let a = [b[0], b[1]];
    if le {
        u16::from_le_bytes(a)
    } else {
        u16::from_be_bytes(a)
    }
}
fn to_u32(b: &[u8], le: bool) -> u32 {
    let a = [b[0], b[1], b[2], b[3]];
    if le {
        u32::from_le_bytes(a)
    } else {
        u32::from_be_bytes(a)
    }
}
fn to_u64(b: &[u8], le: bool) -> u64 {
    let a = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]];
    if le {
        u64::from_le_bytes(a)
    } else {
        u64::from_be_bytes(a)
    }
}

// --- Reader ------------------------------------------------------------------

/// Parsed in-memory recipe source: time column converted to absolute ns plus
/// each channel as a parallel `Vec<f64>`, sorted ascending by time so
/// `fetch_range` can binary-search (identical layout to `TabularReader`).
struct ParsedRecipe {
    ts_ns: Vec<i64>,
    columns: HashMap<String, Vec<f64>>,
    order: Vec<String>,
    /// Records that failed bounds checks during the full decode.
    rejected: u64,
    first_error: Option<DryRunError>,
    coverage: f64,
}

pub struct RecipeReader {
    meta: SourceMeta,
    table: ParsedRecipe,
    rejected: u64,
}

impl RecipeReader {
    /// Parse `recipe_json` and decode `bytes` into channels. The recipe is
    /// validated and clamped before any byte is read.
    pub fn open(bytes: &[u8], recipe_json: &str) -> crate::Result<Self> {
        let recipe: Recipe = serde_json::from_str(recipe_json)
            .map_err(|e| crate::Error::TabularParse(format!("invalid recipe JSON: {e}")))?;
        Self::open_with_recipe(bytes, &recipe, u64::MAX)
    }

    /// Bounded decode used by both `open` (budget `u64::MAX`) and `dry_run`.
    fn open_with_recipe(bytes: &[u8], recipe: &Recipe, budget: u64) -> crate::Result<Self> {
        let plan = DecodePlan::build(recipe)?;
        let parsed = plan.decode(bytes, budget);
        let rejected = parsed.rejected;

        let time_range = match (parsed.ts_ns.first(), parsed.ts_ns.last()) {
            (Some(&a), Some(&b)) => TimeRange {
                start_ns: a,
                end_ns: b.saturating_add(1),
            },
            _ => TimeRange::empty(),
        };

        let channels = parsed
            .order
            .iter()
            .map(|native_id| {
                let spec = plan.channel_by_id(native_id);
                Channel {
                    id: native_id.clone(),
                    source_id: String::new(),
                    name: spec
                        .map(|c| c.display_name.clone())
                        .unwrap_or_else(|| native_id.clone()),
                    kind: ChannelKind::Scalar,
                    dtype: Some(DType::F64),
                    unit: spec.and_then(|c| c.unit.clone()),
                    sample_count: parsed.ts_ns.len() as u64,
                    time_range,
                }
            })
            .collect();

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::Recipe,
            time_range,
            channels,
        };

        Ok(RecipeReader {
            meta,
            table: parsed,
            rejected,
        })
    }

    /// Decode at most `budget` records and return statistics, without retaining
    /// the source. This is the agent's `validate_recipe` feedback signal — it
    /// never panics and never allocates past the budget.
    pub fn dry_run(bytes: &[u8], recipe_json: &str, budget: u32) -> crate::Result<DryRunReport> {
        let recipe: Recipe = serde_json::from_str(recipe_json)
            .map_err(|e| crate::Error::TabularParse(format!("invalid recipe JSON: {e}")))?;
        let plan = DecodePlan::build(&recipe)?;
        let parsed = plan.decode(bytes, budget as u64);

        let per_channel = parsed
            .order
            .iter()
            .map(|id| {
                let vals = &parsed.columns[id];
                let mut min = f64::INFINITY;
                let mut max = f64::NEG_INFINITY;
                let mut nan_count = 0u64;
                for &v in vals {
                    if v.is_nan() {
                        nan_count += 1;
                    } else {
                        min = min.min(v);
                        max = max.max(v);
                    }
                }
                if !min.is_finite() {
                    min = 0.0;
                    max = 0.0;
                }
                PerChannelStat {
                    native_id: id.clone(),
                    count: vals.len() as u64,
                    min,
                    max,
                    nan_count,
                    constant: (max - min).abs() < f64::EPSILON,
                }
            })
            .collect();

        let time_stats = if parsed.ts_ns.is_empty() {
            None
        } else {
            let mut violations = 0u64;
            let mut deltas: Vec<i64> = Vec::with_capacity(parsed.ts_ns.len().saturating_sub(1));
            for w in parsed.ts_ns.windows(2) {
                if w[1] < w[0] {
                    violations += 1;
                }
                deltas.push(w[1].saturating_sub(w[0]));
            }
            deltas.sort_unstable();
            let median = deltas.get(deltas.len() / 2).copied().unwrap_or(0);
            Some(TimeStats {
                start_ns: *parsed.ts_ns.first().unwrap(),
                end_ns: *parsed.ts_ns.last().unwrap(),
                monotonic_violations: violations,
                median_delta_ns: median,
            })
        };

        Ok(DryRunReport {
            records_decoded: parsed.ts_ns.len() as u64,
            records_rejected: parsed.rejected,
            first_error: parsed.first_error,
            time_stats,
            per_channel,
            coverage: parsed.coverage,
        })
    }

    /// Records skipped (bounds violations) during the full decode.
    pub fn rejected_records(&self) -> u64 {
        self.rejected
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

/// A validated, clamped decode plan derived once from a [`Recipe`].
struct DecodePlan {
    header_skip: usize,
    record_size: usize,
    time_field: FieldSpec,
    time_is_integer: bool,
    time_scale: i64,
    time_offset: i64,
    /// (channel native id) -> value field to read, plus display metadata.
    channels: Vec<PlanChannel>,
}

struct PlanChannel {
    native_id: String,
    display_name: String,
    unit: Option<String>,
    field: FieldSpec,
}

impl DecodePlan {
    fn channel_by_id(&self, id: &str) -> Option<&PlanChannel> {
        self.channels.iter().find(|c| c.native_id == id)
    }

    fn build(recipe: &Recipe) -> crate::Result<DecodePlan> {
        if recipe.recipe_version != 1 {
            return Err(crate::Error::TabularParse(format!(
                "unsupported recipeVersion: {}",
                recipe.recipe_version
            )));
        }
        if recipe.fields.len() > MAX_FIELDS {
            return Err(crate::Error::TabularParse(format!(
                "recipe declares {} fields (max {MAX_FIELDS})",
                recipe.fields.len()
            )));
        }
        if recipe.channels.len() > MAX_CHANNELS {
            return Err(crate::Error::TabularParse(format!(
                "recipe declares {} channels (max {MAX_CHANNELS})",
                recipe.channels.len()
            )));
        }

        let (header_skip, record_size) = match &recipe.container {
            Container::FixedRecord {
                header_skip_bytes,
                record_size_bytes,
            } => {
                if *record_size_bytes == 0 || *record_size_bytes > MAX_RECORD_SIZE {
                    return Err(crate::Error::TabularParse(format!(
                        "recordSizeBytes {record_size_bytes} out of range (1..={MAX_RECORD_SIZE})"
                    )));
                }
                (*header_skip_bytes, *record_size_bytes)
            }
        };

        // Every field must fit inside a record.
        let field_by_name =
            |name: &str| -> Option<&FieldSpec> { recipe.fields.iter().find(|f| f.name == name) };
        for f in &recipe.fields {
            let end = f.offset.saturating_add(f.dtype.size());
            if end > record_size {
                return Err(crate::Error::TabularParse(format!(
                    "field `{}` reads bytes {}..{} past record size {}",
                    f.name, f.offset, end, record_size
                )));
            }
        }

        let time_field = field_by_name(&recipe.time.field)
            .ok_or_else(|| {
                crate::Error::TabularParse(format!(
                    "time.field `{}` not declared in fields",
                    recipe.time.field
                ))
            })?
            .clone();
        let time_offset: i64 = match &recipe.time.epoch_offset_ns {
            Some(s) => s.parse().map_err(|_| {
                crate::Error::TabularParse(format!("epochOffsetNs `{s}` is not an integer"))
            })?,
            None => 0,
        };

        let mut channels = Vec::with_capacity(recipe.channels.len());
        for c in &recipe.channels {
            let fname = c.fields.first().ok_or_else(|| {
                crate::Error::TabularParse(format!("channel `{}` has no fields", c.native_id))
            })?;
            let field = field_by_name(fname)
                .ok_or_else(|| {
                    crate::Error::TabularParse(format!(
                        "channel `{}` references unknown field `{fname}`",
                        c.native_id
                    ))
                })?
                .clone();
            channels.push(PlanChannel {
                native_id: c.native_id.clone(),
                display_name: c.name.clone().unwrap_or_else(|| c.native_id.clone()),
                unit: c.unit.clone().or_else(|| field.unit.clone()),
                field,
            });
        }

        Ok(DecodePlan {
            header_skip: usize::try_from(header_skip).unwrap_or(usize::MAX),
            record_size: record_size as usize,
            time_field,
            time_is_integer: time_field_is_integer(&recipe.time, &recipe.fields),
            time_scale: recipe.time.unit.scale_ns(),
            time_offset,
            channels,
        })
    }

    /// Decode up to `budget` records from `bytes`. Out-of-bounds records are
    /// counted in `rejected`, never decoded.
    fn decode(&self, bytes: &[u8], budget: u64) -> ParsedRecipe {
        let mut ts_unsorted: Vec<i64> = Vec::new();
        let mut cols: HashMap<String, Vec<f64>> = HashMap::new();
        let order: Vec<String> = self.channels.iter().map(|c| c.native_id.clone()).collect();
        for id in &order {
            cols.insert(id.clone(), Vec::new());
        }

        let mut rejected = 0u64;
        let mut first_error: Option<DryRunError> = None;
        let mut consumed: u64 = 0;

        if self.record_size == 0 || self.header_skip >= bytes.len() {
            return ParsedRecipe {
                ts_ns: Vec::new(),
                columns: cols,
                order,
                rejected,
                first_error,
                coverage: 0.0,
            };
        }

        let mut pos = self.header_skip;
        let mut decoded: u64 = 0;
        while pos + self.record_size <= bytes.len() && decoded < budget {
            let rec = &bytes[pos..pos + self.record_size];

            // Time first — a record with no readable timestamp is rejected.
            let ts = if self.time_is_integer {
                read_i64(rec, &self.time_field).map(|raw| {
                    raw.saturating_mul(self.time_scale)
                        .saturating_add(self.time_offset)
                })
            } else {
                read_f64(rec, &self.time_field)
                    .map(|raw| (raw * self.time_scale as f64).round() as i64 + self.time_offset)
            };
            let ts = match ts {
                Some(t) => t,
                None => {
                    rejected += 1;
                    if first_error.is_none() {
                        first_error = Some(DryRunError {
                            byte_offset: pos as u64,
                            reason: "time field out of bounds".into(),
                        });
                    }
                    pos += self.record_size;
                    continue;
                }
            };

            ts_unsorted.push(ts);
            for ch in &self.channels {
                let v = read_f64(rec, &ch.field).unwrap_or(f64::NAN);
                cols.get_mut(&ch.native_id).unwrap().push(v);
            }
            decoded += 1;
            consumed += self.record_size as u64;
            pos += self.record_size;
        }

        // Sort by time, carrying value columns along (cheap no-op when already
        // ordered, the common case for log files).
        let already_sorted = ts_unsorted.windows(2).all(|w| w[0] <= w[1]);
        let (ts_ns, cols) = if already_sorted {
            (ts_unsorted, cols)
        } else {
            let mut idx: Vec<usize> = (0..ts_unsorted.len()).collect();
            idx.sort_by_key(|&i| ts_unsorted[i]);
            let ts_sorted: Vec<i64> = idx.iter().map(|&i| ts_unsorted[i]).collect();
            let mut sorted_cols: HashMap<String, Vec<f64>> = HashMap::new();
            for id in &order {
                let src = &cols[id];
                sorted_cols.insert(id.clone(), idx.iter().map(|&i| src[i]).collect());
            }
            (ts_sorted, sorted_cols)
        };

        let total = bytes.len() as u64;
        let coverage = if total > 0 {
            (self.header_skip as u64 + consumed) as f64 / total as f64
        } else {
            0.0
        };

        ParsedRecipe {
            ts_ns,
            columns: cols,
            order,
            rejected,
            first_error,
            coverage,
        }
    }
}

fn time_field_is_integer(time: &TimeSpec, fields: &[FieldSpec]) -> bool {
    fields
        .iter()
        .find(|f| f.name == time.field)
        .map(|f| f.dtype.is_integer())
        .unwrap_or(false)
}

impl Reader for RecipeReader {
    /// `Reader::open` takes only bytes, but a recipe source is meaningless
    /// without its recipe. This entry point is therefore unsupported; callers
    /// use [`RecipeReader::open`] with the recipe JSON.
    fn open(_bytes: &[u8]) -> crate::Result<Self> {
        Err(crate::Error::TabularParse(
            "RecipeReader requires a recipe; use RecipeReader::open(bytes, recipe_json)".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::Array;
    use arrow_ipc::reader::FileReader;
    use std::io::Cursor;

    /// A 4-byte magic header followed by N little-endian records:
    /// `[u64 t_us][f32 speed][u8 gear][3 pad]` = 16 bytes/record.
    fn synth_acme(rows: &[(u64, f32, u8)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"ACME");
        for &(t, speed, gear) in rows {
            out.extend_from_slice(&t.to_le_bytes());
            out.extend_from_slice(&speed.to_le_bytes());
            out.push(gear);
            out.extend_from_slice(&[0u8, 0, 0]);
        }
        out
    }

    fn recipe_json() -> String {
        r#"{
          "recipeVersion": 1,
          "name": "ACME test",
          "container": { "type": "fixed_record", "headerSkipBytes": 4, "recordSizeBytes": 16 },
          "time": { "field": "t", "unit": "micros", "mode": "absolute", "epochOffsetNs": "0" },
          "fields": [
            { "name": "t", "offset": 0, "dtype": "u64", "endian": "le" },
            { "name": "speed", "offset": 8, "dtype": "f32", "endian": "le", "unit": "m/s" },
            { "name": "gear", "offset": 12, "dtype": "u8" }
          ],
          "channels": [
            { "nativeId": "speed", "name": "wheel/speed", "kind": "scalar", "fields": ["speed"] },
            { "nativeId": "gear", "name": "trans/gear", "kind": "enum", "fields": ["gear"] }
          ]
        }"#
        .to_string()
    }

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1);
        batches.into_iter().next().unwrap()
    }

    fn col_ts(b: &RecordBatch) -> Vec<i64> {
        let t = b
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        (0..t.len()).map(|i| t.value(i)).collect()
    }
    fn col_f64(b: &RecordBatch) -> Vec<f64> {
        let v = b.column(1).as_any().downcast_ref::<Float64Array>().unwrap();
        (0..v.len()).map(|i| v.value(i)).collect()
    }

    #[test]
    fn decodes_fixed_records_to_scalar_channels() {
        let bytes = synth_acme(&[
            (1_704_067_200_000_000, 10.0, 3),
            (1_704_067_200_001_000, 11.0, 3),
            (1_704_067_200_002_000, 12.5, 4),
        ]);
        let r = RecipeReader::open(&bytes, &recipe_json()).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Recipe);
        let names: Vec<&str> = r.meta().channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["wheel/speed", "trans/gear"]);

        let ipc = r
            .fetch_range(
                &"speed".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        // micros → ns in the integer domain (beyond f64 exact range).
        assert_eq!(
            col_ts(&batch),
            vec![
                1_704_067_200_000_000_000,
                1_704_067_200_001_000_000,
                1_704_067_200_002_000_000
            ]
        );
        assert_eq!(col_f64(&batch), vec![10.0, 11.0, 12.5]);

        let gears = parse_ipc(
            &r.fetch_range(
                &"gear".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap(),
        );
        assert_eq!(col_f64(&gears), vec![3.0, 3.0, 4.0]);
    }

    #[test]
    fn dry_run_reports_coverage_and_stats() {
        let bytes = synth_acme(&[(1000, 1.0, 0), (2000, 2.0, 1), (3000, 3.0, 1)]);
        let report = RecipeReader::dry_run(&bytes, &recipe_json(), 100_000).unwrap();
        assert_eq!(report.records_decoded, 3);
        assert_eq!(report.records_rejected, 0);
        assert!(report.first_error.is_none());
        // 4-byte header + 3*16 = 52 bytes, all of the 52-byte file.
        assert!((report.coverage - 1.0).abs() < 1e-9);
        let ts = report.time_stats.unwrap();
        assert_eq!(ts.monotonic_violations, 0);
        let speed = report
            .per_channel
            .iter()
            .find(|c| c.native_id == "speed")
            .unwrap();
        assert_eq!(speed.count, 3);
        assert_eq!(speed.min, 1.0);
        assert_eq!(speed.max, 3.0);
        assert!(!speed.constant);
        let gear = report
            .per_channel
            .iter()
            .find(|c| c.native_id == "gear")
            .unwrap();
        assert!(!gear.constant);
    }

    #[test]
    fn dry_run_budget_caps_records() {
        let rows: Vec<(u64, f32, u8)> = (0..1000).map(|i| (i as u64 * 1000, i as f32, 0)).collect();
        let bytes = synth_acme(&rows);
        let report = RecipeReader::dry_run(&bytes, &recipe_json(), 10).unwrap();
        assert_eq!(report.records_decoded, 10);
        // Only part of the file consumed under the budget.
        assert!(report.coverage < 1.0);
    }

    #[test]
    fn rejects_oversized_record() {
        let recipe = r#"{
          "recipeVersion": 1,
          "container": { "type": "fixed_record", "recordSizeBytes": 2000000 },
          "time": { "field": "t", "unit": "nanos" },
          "fields": [ { "name": "t", "offset": 0, "dtype": "u64" } ],
          "channels": []
        }"#;
        assert!(matches!(
            RecipeReader::open(b"xxxxxxxxxxxxxxxx", recipe),
            Err(crate::Error::TabularParse(_))
        ));
    }

    #[test]
    fn rejects_field_past_record_end() {
        let recipe = r#"{
          "recipeVersion": 1,
          "container": { "type": "fixed_record", "recordSizeBytes": 8 },
          "time": { "field": "t", "unit": "nanos" },
          "fields": [ { "name": "t", "offset": 4, "dtype": "u64" } ],
          "channels": []
        }"#;
        assert!(matches!(
            RecipeReader::open(b"xxxxxxxx", recipe),
            Err(crate::Error::TabularParse(_))
        ));
    }

    #[test]
    fn unknown_recipe_version_rejected() {
        let recipe = r#"{
          "recipeVersion": 99,
          "container": { "type": "fixed_record", "recordSizeBytes": 8 },
          "time": { "field": "t", "unit": "nanos" },
          "fields": [ { "name": "t", "offset": 0, "dtype": "u64" } ],
          "channels": []
        }"#;
        assert!(RecipeReader::open(b"xxxxxxxx", recipe).is_err());
    }

    #[test]
    fn trait_open_without_recipe_errors() {
        assert!(<RecipeReader as Reader>::open(b"data").is_err());
    }
}
