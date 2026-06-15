//! `PointCloudReader`: ingests a *Driveline point-cloud Parquet* — one row per
//! LiDAR spin (a full 360° sweep). This is the format the
//! `tools/alpamayo_lidar_to_driveline.py` converter emits after decoding the
//! Draco-compressed point clouds in the NVIDIA Alpamayo dataset, but the schema
//! is sensor-agnostic: anything that can write the three columns below loads.
//!
//! [`PointCloudReader::open_alpamayo_parquet`] reads the **raw** Alpamayo LiDAR
//! parquet directly (Draco blobs in, decoded via an injected closure), so the
//! converter is no longer required to view a clip's LiDAR — see that method.
//!
//! ## Source schema (what `open` expects)
//!
//! | column        | Arrow type          | meaning                              |
//! | ------------- | ------------------- | ------------------------------------ |
//! | `t_ns`        | `Int64`             | spin timestamp, absolute nanoseconds |
//! | `positions`   | `List<Float32>`     | flattened xyz, length `3 * N` (metres) |
//! | `intensities` | `List<UInt8>`       | per-point intensity 0..255, length `N` |
//!
//! Optional schema metadata `driveline.pointcloud.name` names the channel
//! (e.g. `lidar_top_360fov`); `driveline.format = "pointcloud"` is written too
//! so callers can sniff the format, but `open` only requires the columns.
//!
//! ## Fetch schema (what `fetch_range` returns)
//!
//! One row per spin in the window:
//!
//! | column        | Arrow type          |
//! | ------------- | ------------------- |
//! | `ts`          | `Timestamp(ns, UTC)`|
//! | `positions`   | `List<Float32>`     |
//! | `intensities` | `List<Float32>`     | (normalised 0..1 — render-ready)     |
//!
//! Positions stay `f32`: a single spin is ~250k points, so `f64` would double
//! both the wasm→JS transfer and GPU upload for no precision gain (LiDAR ranges
//! are metres, well within `f32`). The 3D scene panel fetches **one spin at a
//! time** (it binary-searches `spin_times()` locally and only refetches when
//! the active spin changes), so a frame's worth of points crosses the boundary
//! at most once per spin, not once per cursor tick.
//!
//! ## Memory at open
//!
//! Decoded spins stay resident for the reader's lifetime (that's the design —
//! scrubbing needs random access to any spin), but `open` itself **streams**:
//! batches of [`OPEN_BATCH_ROWS`] rows are decoded and converted to spins one
//! at a time, so peak memory is `file bytes + spins + one small batch`. A
//! full-density Alpamayo clip (~52M points) opens in ~1.1 GB of wasm heap,
//! where decoding everything before extraction used to need ~2× that and trap.

use std::sync::Arc;

use arrow_array::builder::{Float32Builder, ListBuilder};
use arrow_array::cast::AsArray;
use arrow_array::types::Int64Type;
use arrow_array::{Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

use crate::reader::{ArrowIpc, Reader};
use crate::types::{Channel, ChannelId, ChannelKind, FetchOpts, SourceKind, SourceMeta, TimeRange};

/// Default per-spin display duration (ns) when a source has a single spin (or
/// we otherwise can't infer the cadence). 100 ms ≈ the 10 Hz Alpamayo cadence.
const DEFAULT_SPIN_PERIOD_NS: i64 = 100_000_000;

/// Rows per decoded Arrow batch while opening. At native Alpamayo density a
/// spin row decodes to ~3.4 MB (260k points × 13 bytes), so 8 rows caps the
/// transient decode buffer at ~27 MB. The parquet default (1024 rows) would
/// decode a whole ~200-spin file into one batch, holding every point twice
/// (batch + extracted spins) and trapping the wasm heap above ~48M points.
const OPEN_BATCH_ROWS: usize = 8;

/// Metadata key naming the point-cloud channel; matches the converter.
const NAME_META_KEY: &str = "driveline.pointcloud.name";

/// One decoded spin held in memory: its timestamp plus the owned point buffers.
/// Positions are flattened xyz (`len == 3 * point_count`); intensities are the
/// raw 0..255 bytes (normalised to `f32` only for the spin actually fetched, so
/// idle spins stay compact at one byte per point).
struct Spin {
    ts_ns: i64,
    positions: Vec<f32>,
    intensities: Vec<u8>,
}

impl Spin {
    fn point_count(&self) -> usize {
        self.intensities.len()
    }
}

pub struct PointCloudReader {
    meta: SourceMeta,
    channel_id: ChannelId,
    spins: Vec<Spin>,
    /// Parallel to `spins`, ascending — the scene panel pulls this to map a
    /// cursor time to a spin index without a wasm round-trip per tick.
    spin_ts: Vec<i64>,
}

impl PointCloudReader {
    /// Ascending spin start timestamps (ns), one per frame. The 3D panel binary
    /// searches this locally to decide which spin is active at the cursor.
    pub fn spin_times(&self) -> &[i64] {
        &self.spin_ts
    }

    /// Open a **PCD** (Point Cloud Data) file — the PCL/ROS interchange format
    /// for LiDAR scans. A PCD holds a single cloud, so the resulting reader has
    /// exactly one spin at `ts = 0`; the scene panel renders it like any other
    /// point-cloud frame. See [`crate::pcd`] for the supported subset.
    pub fn open_pcd(bytes: &[u8]) -> crate::Result<Self> {
        let cloud = crate::pcd::parse_pcd(bytes)?;
        // A single, timestamp-less frame parks at t = 0; `from_spins` gives it
        // the default display duration so a cursor on it always resolves.
        let spin = Spin {
            ts_ns: 0,
            positions: cloud.positions,
            intensities: cloud.intensities,
        };
        Ok(Self::from_spins(vec![spin], "points".to_string()))
    }

    /// Build a reader from decoded spins, computing the channel meta and the
    /// covering time range. Spins are sorted ascending (callers may pass them in
    /// any order); `name` becomes both the channel id and display name. Shared
    /// by [`Self::open`] (Parquet) and [`Self::open_pcd`].
    fn from_spins(mut spins: Vec<Spin>, name: String) -> Self {
        // Spins are normally written in order, but don't rely on it —
        // `fetch_range` and `spin_times` both assume ascending ts.
        spins.sort_by_key(|s| s.ts_ns);
        let spin_ts: Vec<i64> = spins.iter().map(|s| s.ts_ns).collect();

        // Cover the last spin's display duration so the cursor parked on the
        // final frame still resolves to it. Infer the cadence from the median
        // inter-spin gap; fall back to 100 ms for a single spin.
        let period = infer_period_ns(&spin_ts);
        let time_range = match (spin_ts.first(), spin_ts.last()) {
            (Some(&a), Some(&b)) => TimeRange {
                start_ns: a,
                end_ns: b.saturating_add(period),
            },
            _ => TimeRange::empty(),
        };

        let max_points = spins.iter().map(Spin::point_count).max().unwrap_or(0) as u64;
        let channel = Channel {
            id: name.clone(),
            source_id: String::new(),
            name: name.clone(),
            kind: ChannelKind::PointCloud,
            // No scalar dtype — the renderer reads positions/intensities from
            // the fetch batch directly.
            dtype: None,
            unit: None,
            // For a point cloud, "sample_count" is the peak points-per-spin, so
            // the UI can show how dense the cloud is. Spin count is the
            // channel's frame count, surfaced via `spin_times`.
            sample_count: max_points,
            time_range,
        };

        let meta = SourceMeta {
            id: String::new(),
            kind: SourceKind::Lidar,
            time_range,
            channels: vec![channel],
        };

        PointCloudReader {
            meta,
            channel_id: name,
            spins,
            spin_ts,
        }
    }

    /// Open from an owned buffer. Preferred at the wasm boundary: the incoming
    /// `Vec<u8>` is wrapped in `Bytes` without copying (the `parquet` crate's
    /// `ChunkReader: 'static` bound is why a borrowed `&[u8]` must be copied),
    /// so a multi-hundred-MB file exists in the heap once, not twice.
    pub fn open_owned(bytes: Vec<u8>) -> crate::Result<Self> {
        Self::open_bytes(bytes::Bytes::from(bytes))
    }

    /// Streaming open: decode [`OPEN_BATCH_ROWS`]-row batches one at a time,
    /// extracting each batch's spins before the next is read, so peak memory
    /// is the file bytes + accumulated spins + one small batch — never the
    /// whole file decoded at once.
    fn open_bytes(data: bytes::Bytes) -> crate::Result<Self> {
        let builder = ParquetRecordBatchReaderBuilder::try_new(data)
            .map_err(|e| crate::Error::PointCloudParse(e.to_string()))?;
        let schema = builder.schema().clone();

        let t_idx = schema
            .index_of("t_ns")
            .map_err(|_| crate::Error::PointCloudSchema("missing `t_ns` column".into()))?;
        let pos_idx = schema
            .index_of("positions")
            .map_err(|_| crate::Error::PointCloudSchema("missing `positions` column".into()))?;
        let int_idx = schema
            .index_of("intensities")
            .map_err(|_| crate::Error::PointCloudSchema("missing `intensities` column".into()))?;

        let name = schema
            .metadata()
            .get(NAME_META_KEY)
            .cloned()
            .unwrap_or_else(|| "points".to_string());

        // Row count from the footer, capped so a corrupt header can't trigger
        // a giant up-front allocation (the Vec still grows past this fine).
        let total_rows = usize::try_from(builder.metadata().file_metadata().num_rows())
            .unwrap_or(0)
            .min(65_536);

        let reader = builder
            .with_batch_size(OPEN_BATCH_ROWS)
            .build()
            .map_err(|e| crate::Error::PointCloudParse(e.to_string()))?;

        let mut spins: Vec<Spin> = Vec::with_capacity(total_rows);
        for batch in reader {
            let batch = batch.map_err(|e| crate::Error::PointCloudParse(e.to_string()))?;
            Self::extract_spins(&batch, t_idx, pos_idx, int_idx, &mut spins)?;
            // `batch` drops here, before the next one is decoded.
        }

        Ok(Self::from_spins(spins, name))
    }

    /// Open a **raw NVIDIA Alpamayo LiDAR** Parquet — the format the dataset
    /// ships, *before* any conversion. One row per spin:
    ///
    /// | column                     | Arrow type | meaning                       |
    /// | -------------------------- | ---------- | ----------------------------- |
    /// | `spin_start_timestamp`     | `Int64`    | spin timestamp, MICROSECONDS  |
    /// | `draco_encoded_pointcloud` | `Binary`   | Draco-compressed point cloud  |
    ///
    /// (Extra columns like `spin_index` / `spin_end_timestamp` are ignored.)
    ///
    /// `data-core` deliberately does **not** bundle a Draco decoder — the codec
    /// is a large C++ library and would blow the WASM size budget — so the blob
    /// decode is injected as a closure. `decode(blob)` returns the spin's
    /// flattened `xyz` (`len == 3 * N`, metres) and per-point `intensity`
    /// (`0..=255`, `len == N`). The browser backs this with Google's reference
    /// Draco decoder compiled to WASM; native callers (tests, the CLI) supply
    /// their own. A decode `Err(msg)` aborts the open with `msg` attached.
    ///
    /// Spins are read **one row at a time** (batch size 1), so peak memory is
    /// the compressed file + accumulated spins + a single decoded spin — never
    /// every Draco blob decoded at once. `sensor` names the channel (defaults to
    /// `lidar_top_360fov`, the only LiDAR Alpamayo ships).
    pub fn open_alpamayo_parquet<F>(
        bytes: Vec<u8>,
        sensor: Option<String>,
        mut decode: F,
    ) -> crate::Result<Self>
    where
        F: FnMut(&[u8]) -> std::result::Result<(Vec<f32>, Vec<u8>), String>,
    {
        let builder = ParquetRecordBatchReaderBuilder::try_new(bytes::Bytes::from(bytes))
            .map_err(|e| crate::Error::PointCloudParse(e.to_string()))?;
        let schema = builder.schema().clone();

        let ts_idx = schema.index_of("spin_start_timestamp").map_err(|_| {
            crate::Error::PointCloudSchema(
                "missing `spin_start_timestamp` column (not a raw Alpamayo LiDAR parquet)".into(),
            )
        })?;
        let blob_idx = schema.index_of("draco_encoded_pointcloud").map_err(|_| {
            crate::Error::PointCloudSchema(
                "missing `draco_encoded_pointcloud` column (not a raw Alpamayo LiDAR parquet)"
                    .into(),
            )
        })?;

        let total_rows = usize::try_from(builder.metadata().file_metadata().num_rows())
            .unwrap_or(0)
            .min(65_536);

        // One row per batch: a single ~1.3 MB Draco blob is materialised as
        // Arrow at a time, decoded, and pushed before the next is read.
        let reader = builder
            .with_batch_size(1)
            .build()
            .map_err(|e| crate::Error::PointCloudParse(e.to_string()))?;

        let name = sensor.unwrap_or_else(|| "lidar_top_360fov".to_string());
        let mut spins: Vec<Spin> = Vec::with_capacity(total_rows);
        for batch in reader {
            let batch = batch.map_err(|e| crate::Error::PointCloudParse(e.to_string()))?;
            let ts_col = batch.column(ts_idx);
            let ts_vals: &[i64] = match ts_col.data_type() {
                DataType::Int64 => ts_col.as_primitive::<Int64Type>().values(),
                other => {
                    return Err(crate::Error::PointCloudSchema(format!(
                        "`spin_start_timestamp` must be Int64, got {other:?}"
                    )))
                }
            };
            let blob_col = batch.column(blob_idx);
            for (row, &ts_us) in ts_vals.iter().enumerate() {
                let blob: &[u8] = match blob_col.data_type() {
                    DataType::Binary => blob_col.as_binary::<i32>().value(row),
                    DataType::LargeBinary => blob_col.as_binary::<i64>().value(row),
                    other => {
                        return Err(crate::Error::PointCloudSchema(format!(
                            "`draco_encoded_pointcloud` must be Binary, got {other:?}"
                        )))
                    }
                };
                // `spins.len()` is this spin's file-absolute index.
                let idx = spins.len();
                let (positions, intensities) = decode(blob).map_err(|m| {
                    crate::Error::PointCloudParse(format!("spin {idx}: Draco decode failed: {m}"))
                })?;
                if positions.len() != intensities.len() * 3 {
                    return Err(crate::Error::PointCloudSchema(format!(
                        "spin {idx}: decoded positions ({}) != 3 * intensities ({})",
                        positions.len(),
                        intensities.len()
                    )));
                }
                spins.push(Spin {
                    // us -> ns, absolute on the clip timeline (same clock the
                    // bundle's video sidecars and egomotion land on).
                    ts_ns: ts_us.saturating_mul(1_000),
                    positions,
                    intensities,
                });
            }
        }

        if spins.is_empty() {
            return Err(crate::Error::PointCloudSchema(
                "raw Alpamayo LiDAR parquet has no spins".into(),
            ));
        }
        Ok(Self::from_spins(spins, name))
    }

    /// Append one decoded batch's rows to `spins` as owned [`Spin`]s.
    fn extract_spins(
        batch: &RecordBatch,
        t_idx: usize,
        pos_idx: usize,
        int_idx: usize,
        spins: &mut Vec<Spin>,
    ) -> crate::Result<()> {
        // Accept either a plain Int64 or an Int64-backed Timestamp(ns)
        // column for `t_ns` — both decode to the same i64 ns values.
        let ts_col = batch.column(t_idx);
        let ts_vals: Vec<i64> = match ts_col.data_type() {
            DataType::Int64 => ts_col.as_primitive::<Int64Type>().values().to_vec(),
            DataType::Timestamp(TimeUnit::Nanosecond, _) => ts_col
                .as_any()
                .downcast_ref::<TimestampNanosecondArray>()
                .ok_or_else(|| {
                    crate::Error::PointCloudSchema("malformed `t_ns` timestamp column".into())
                })?
                .values()
                .to_vec(),
            other => {
                return Err(crate::Error::PointCloudSchema(format!(
                    "`t_ns` must be Int64 or Timestamp(ns), got {other:?}"
                )))
            }
        };

        let pos_col = batch.column(pos_idx);
        let int_col = batch.column(int_idx);
        for (row, &ts_ns) in ts_vals.iter().enumerate() {
            let positions = Self::list_f32_row(pos_col.as_ref(), row)?;
            let intensities = Self::list_u8_row(int_col.as_ref(), row)?;
            // Each point needs 3 position floats; a mismatch means a
            // malformed file — surface it rather than render garbage.
            if positions.len() != intensities.len() * 3 {
                // `spins.len()` = rows already extracted = this row's
                // file-absolute index (one spin is pushed per row).
                return Err(crate::Error::PointCloudSchema(format!(
                    "spin row {}: positions ({}) != 3 * intensities ({})",
                    spins.len(),
                    positions.len(),
                    intensities.len()
                )));
            }
            spins.push(Spin {
                ts_ns,
                positions,
                intensities,
            });
        }
        Ok(())
    }

    /// Pull one row's `Float32` list value out of a `List<Float32>` /
    /// `LargeList<Float32>` column as an owned `Vec<f32>`.
    fn list_f32_row(col: &dyn Array, row: usize) -> crate::Result<Vec<f32>> {
        let values: Arc<dyn Array> = match col.data_type() {
            DataType::List(_) => col.as_list::<i32>().value(row),
            DataType::LargeList(_) => col.as_list::<i64>().value(row),
            other => {
                return Err(crate::Error::PointCloudSchema(format!(
                    "`positions` must be List<Float32>, got {other:?}"
                )))
            }
        };
        let prim = values
            .as_any()
            .downcast_ref::<arrow_array::Float32Array>()
            .ok_or_else(|| {
                crate::Error::PointCloudSchema("`positions` list items must be Float32".into())
            })?;
        Ok(prim.values().to_vec())
    }

    /// Pull one row's `UInt8` list value out of a `List<UInt8>` /
    /// `LargeList<UInt8>` column as an owned `Vec<u8>`.
    fn list_u8_row(col: &dyn Array, row: usize) -> crate::Result<Vec<u8>> {
        let values: Arc<dyn Array> = match col.data_type() {
            DataType::List(_) => col.as_list::<i32>().value(row),
            DataType::LargeList(_) => col.as_list::<i64>().value(row),
            other => {
                return Err(crate::Error::PointCloudSchema(format!(
                    "`intensities` must be List<UInt8>, got {other:?}"
                )))
            }
        };
        let prim = values
            .as_any()
            .downcast_ref::<arrow_array::UInt8Array>()
            .ok_or_else(|| {
                crate::Error::PointCloudSchema("`intensities` list items must be UInt8".into())
            })?;
        Ok(prim.values().to_vec())
    }

    /// Arrow schema `fetch_range` emits. Positions and intensities are both
    /// variable-length `List<Float32>` (one list per spin row).
    fn fetch_schema() -> Arc<Schema> {
        let pos_item = Arc::new(Field::new("item", DataType::Float32, true));
        let int_item = Arc::new(Field::new("item", DataType::Float32, true));
        Arc::new(Schema::new(vec![
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
                false,
            ),
            Field::new("positions", DataType::List(pos_item), false),
            Field::new("intensities", DataType::List(int_item), false),
        ]))
    }
}

impl Reader for PointCloudReader {
    fn open(bytes: &[u8]) -> crate::Result<Self> {
        // The copy is forced by the `ChunkReader: 'static` bound; callers that
        // own their buffer should use `open_owned` and skip it.
        Self::open_bytes(bytes::Bytes::copy_from_slice(bytes))
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
        if channel_id != &self.channel_id {
            return Err(crate::Error::ChannelNotFound(channel_id.clone()));
        }

        // Spins overlapping [start, end). With `include_prev` we also emit the
        // spin just before the window — that's exactly how the panel asks for
        // "the spin active at the cursor" (a zero/one-width window + prev).
        let ts = &self.spin_ts;
        let start_idx = ts.partition_point(|&t| t < range.start_ns);
        let end_idx = ts.partition_point(|&t| t < range.end_ns).max(start_idx);
        let prev_idx = if opts.include_prev && start_idx > 0 {
            Some(start_idx - 1)
        } else {
            None
        };

        let mut idxs: Vec<usize> = Vec::new();
        if let Some(p) = prev_idx {
            idxs.push(p);
        }
        idxs.extend(start_idx..end_idx);

        let schema = Self::fetch_schema();

        // Pre-compute total point count so builders can reserve capacity up
        // front rather than growing incrementally.
        let total_points: usize = idxs.iter().map(|&i| self.spins[i].point_count()).sum();

        let mut ts_vals: Vec<i64> = Vec::with_capacity(idxs.len());
        // `with_capacity(items, values)`: outer list rows + total value slots.
        let mut pos_builder =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_points * 3), idxs.len());
        let mut int_builder =
            ListBuilder::with_capacity(Float32Builder::with_capacity(total_points), idxs.len());

        // Reusable scratch buffer for normalised intensities; avoids a new heap
        // allocation per spin. Sized to the largest spin we will process.
        let max_pts = idxs
            .iter()
            .map(|&i| self.spins[i].point_count())
            .max()
            .unwrap_or(0);
        let mut int_scratch: Vec<f32> = Vec::with_capacity(max_pts);

        for &i in &idxs {
            let spin = &self.spins[i];
            ts_vals.push(spin.ts_ns);
            pos_builder.values().append_slice(&spin.positions);
            pos_builder.append(true);
            // Normalise intensity to 0..1 for the renderer in bulk: build a
            // temporary f32 slice then append_slice, replacing ~N individual
            // append_value calls with a single memcpy-backed slice append.
            int_scratch.clear();
            int_scratch.extend(spin.intensities.iter().map(|&b| b as f32 / 255.0));
            int_builder.values().append_slice(&int_scratch);
            int_builder.append(true);
        }

        let ts_array = TimestampNanosecondArray::from(ts_vals).with_timezone("UTC");
        let pos_array = pos_builder.finish();
        let int_array = int_builder.finish();

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(ts_array), Arc::new(pos_array), Arc::new(int_array)],
        )?;

        // Pre-size the IPC output buffer: each point contributes 3×f32 (pos)
        // + 1×f32 (intensity) = 16 bytes; add ~2 KiB of header/schema slack.
        let mut buf = Vec::with_capacity(total_points * 16 + 2048);
        {
            let mut w = FileWriter::try_new(&mut buf, &schema)?;
            w.write(&batch)?;
            w.finish()?;
        }
        Ok(buf)
    }
}

/// Infer the per-spin display duration from the median gap between spin
/// timestamps. Robust to a stray out-of-order or duplicated timestamp; falls
/// back to [`DEFAULT_SPIN_PERIOD_NS`] for fewer than two spins.
fn infer_period_ns(spin_ts: &[i64]) -> i64 {
    if spin_ts.len() < 2 {
        return DEFAULT_SPIN_PERIOD_NS;
    }
    let mut gaps: Vec<i64> = spin_ts
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|&g| g > 0)
        .collect();
    if gaps.is_empty() {
        return DEFAULT_SPIN_PERIOD_NS;
    }
    gaps.sort_unstable();
    gaps[gaps.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::builder::UInt8Builder;
    use arrow_array::{Int64Array, ListArray};
    use arrow_ipc::reader::FileReader;
    use std::io::Cursor;

    /// One spin for the test fixtures: `(ts_ns, points)` where each point is
    /// `(x, y, z, intensity)`.
    type TestSpin = (i64, Vec<(f32, f32, f32, u8)>);

    /// Build a Driveline point-cloud Parquet in memory from `spins`.
    fn write_pointcloud_parquet(spins: &[TestSpin]) -> Vec<u8> {
        write_pointcloud_parquet_rg(spins, None)
    }

    /// Like [`write_pointcloud_parquet`] but with an explicit max row-group
    /// size, so tests can force multi-row-group files.
    fn write_pointcloud_parquet_rg(spins: &[TestSpin], max_row_group: Option<usize>) -> Vec<u8> {
        use parquet::arrow::ArrowWriter;
        use parquet::file::properties::WriterProperties;

        let ts = Int64Array::from(spins.iter().map(|(t, _)| *t).collect::<Vec<_>>());

        let mut pos_b = ListBuilder::new(Float32Builder::new());
        let mut int_b = ListBuilder::new(UInt8Builder::new());
        for (_, pts) in spins {
            for &(x, y, z, _) in pts {
                pos_b.values().append_value(x);
                pos_b.values().append_value(y);
                pos_b.values().append_value(z);
            }
            pos_b.append(true);
            for &(_, _, _, i) in pts {
                int_b.values().append_value(i);
            }
            int_b.append(true);
        }
        let pos: ListArray = pos_b.finish();
        let int: ListArray = int_b.finish();

        let schema = Arc::new(
            Schema::new(vec![
                Field::new("t_ns", DataType::Int64, false),
                Field::new("positions", pos.data_type().clone(), false),
                Field::new("intensities", int.data_type().clone(), false),
            ])
            .with_metadata(
                [
                    (NAME_META_KEY.to_string(), "lidar_top_360fov".to_string()),
                    ("driveline.format".to_string(), "pointcloud".to_string()),
                ]
                .into_iter()
                .collect(),
            ),
        );

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(ts), Arc::new(pos), Arc::new(int)],
        )
        .unwrap();

        let props = max_row_group.map(|n| {
            WriterProperties::builder()
                .set_max_row_group_size(n)
                .build()
        });
        let mut buf = Vec::new();
        {
            let mut w = ArrowWriter::try_new(&mut buf, schema, props).unwrap();
            w.write(&batch).unwrap();
            w.close().unwrap();
        }
        buf
    }

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1);
        batches.into_iter().next().unwrap()
    }

    fn sample() -> Vec<u8> {
        write_pointcloud_parquet(&[
            (
                1_000_000_000,
                vec![(1.0, 2.0, 3.0, 0), (4.0, 5.0, 6.0, 255)],
            ),
            (
                1_100_000_000,
                vec![
                    (7.0, 8.0, 9.0, 128),
                    (-1.0, -2.0, -3.0, 64),
                    (0.0, 0.0, 0.0, 200),
                ],
            ),
        ])
    }

    // --- raw Alpamayo LiDAR (Draco-blob) path -------------------------------

    /// Encode one "spin" the test's stub decoder understands: each point is 13
    /// bytes — `x,y,z` little-endian `f32` then a `u8` intensity. Stands in for
    /// a real Draco blob; `open_alpamayo_parquet` is decoder-agnostic, so the
    /// round-trip still exercises the full parquet + spin-assembly path.
    fn encode_fake_blob(points: &[(f32, f32, f32, u8)]) -> Vec<u8> {
        let mut b = Vec::with_capacity(points.len() * 13);
        for &(x, y, z, i) in points {
            b.extend_from_slice(&x.to_le_bytes());
            b.extend_from_slice(&y.to_le_bytes());
            b.extend_from_slice(&z.to_le_bytes());
            b.push(i);
        }
        b
    }

    /// Inverse of [`encode_fake_blob`] — the closure `open_alpamayo_parquet`
    /// invokes per spin.
    fn decode_fake_blob(blob: &[u8]) -> std::result::Result<(Vec<f32>, Vec<u8>), String> {
        if !blob.len().is_multiple_of(13) {
            return Err(format!("blob len {} not a multiple of 13", blob.len()));
        }
        let mut pos = Vec::new();
        let mut int = Vec::new();
        for c in blob.chunks_exact(13) {
            pos.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
            pos.push(f32::from_le_bytes([c[4], c[5], c[6], c[7]]));
            pos.push(f32::from_le_bytes([c[8], c[9], c[10], c[11]]));
            int.push(c[12]);
        }
        Ok((pos, int))
    }

    /// Build a **raw Alpamayo LiDAR** parquet in memory: `spin_index` +
    /// `spin_start_timestamp` (µs) + `draco_encoded_pointcloud` (the fake blob).
    /// `spins` carries ns timestamps for parity with the other fixtures; they're
    /// converted back to µs here so the µs→ns round-trip in `open_alpamayo_parquet`
    /// lands on the original ns value.
    fn write_alpamayo_parquet(spins: &[TestSpin]) -> Vec<u8> {
        use arrow_array::BinaryArray;
        use parquet::arrow::ArrowWriter;

        let spin_index = Int64Array::from((0..spins.len() as i64).collect::<Vec<_>>());
        let ts = Int64Array::from(spins.iter().map(|(t, _)| *t / 1_000).collect::<Vec<_>>());
        let blobs: Vec<Vec<u8>> = spins.iter().map(|(_, p)| encode_fake_blob(p)).collect();
        let blob_arr = BinaryArray::from_iter_values(blobs.iter());

        let schema = Arc::new(Schema::new(vec![
            Field::new("spin_index", DataType::Int64, false),
            Field::new("spin_start_timestamp", DataType::Int64, false),
            Field::new("draco_encoded_pointcloud", DataType::Binary, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(spin_index), Arc::new(ts), Arc::new(blob_arr)],
        )
        .unwrap();
        let mut buf = Vec::new();
        {
            let mut w = ArrowWriter::try_new(&mut buf, schema, None).unwrap();
            w.write(&batch).unwrap();
            w.close().unwrap();
        }
        buf
    }

    #[test]
    fn open_alpamayo_decodes_spins_via_closure() {
        // Same logical spins as `sample()` (ns timestamps), so the expectations
        // carry over after the µs round-trip.
        let raw = write_alpamayo_parquet(&[
            (
                1_000_000_000,
                vec![(1.0, 2.0, 3.0, 0), (4.0, 5.0, 6.0, 255)],
            ),
            (
                1_100_000_000,
                vec![
                    (7.0, 8.0, 9.0, 128),
                    (-1.0, -2.0, -3.0, 64),
                    (0.0, 0.0, 0.0, 200),
                ],
            ),
        ]);
        let r = PointCloudReader::open_alpamayo_parquet(raw, None, decode_fake_blob).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Lidar);
        assert_eq!(r.meta().channels[0].name, "lidar_top_360fov");
        assert_eq!(r.meta().channels[0].sample_count, 3); // peak points/spin
                                                          // µs in the file × 1000 == the ns timestamps we started from.
        assert_eq!(r.spin_times(), &[1_000_000_000, 1_100_000_000]);

        // The decoded points survive the full parquet → closure → spin path.
        let range = TimeRange {
            start_ns: 1_150_000_000,
            end_ns: 1_150_000_000,
        };
        let ipc = r
            .fetch_range(
                &"lidar_top_360fov".to_string(),
                range,
                FetchOpts { include_prev: true },
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        let pos = batch.column(1).as_list::<i32>().value(0);
        let f = pos
            .as_any()
            .downcast_ref::<arrow_array::Float32Array>()
            .unwrap();
        assert_eq!(
            f.values(),
            &[7.0, 8.0, 9.0, -1.0, -2.0, -3.0, 0.0, 0.0, 0.0]
        );
    }

    #[test]
    fn open_alpamayo_custom_sensor_name() {
        let raw = write_alpamayo_parquet(&[(2_000_000_000, vec![(0.0, 0.0, 0.0, 1)])]);
        let r = PointCloudReader::open_alpamayo_parquet(
            raw,
            Some("roof_lidar".into()),
            decode_fake_blob,
        )
        .unwrap();
        assert_eq!(r.meta().channels[0].name, "roof_lidar");
        assert_eq!(r.spin_times(), &[2_000_000_000]); // 2_000_000 µs × 1000
    }

    #[test]
    fn open_alpamayo_rejects_driveline_parquet() {
        // A *converted* Driveline parquet lacks the raw columns → a clear schema
        // error (so the caller can fall back), never a panic.
        let err = PointCloudReader::open_alpamayo_parquet(sample(), None, decode_fake_blob)
            .err()
            .unwrap();
        assert!(
            matches!(err, crate::Error::PointCloudSchema(_)),
            "got {err:?}"
        );
        assert!(err.to_string().contains("spin_start_timestamp"));
    }

    #[test]
    fn open_alpamayo_propagates_decode_error() {
        let raw = write_alpamayo_parquet(&[(1_000_000_000, vec![(1.0, 1.0, 1.0, 9)])]);
        let err = PointCloudReader::open_alpamayo_parquet(raw, None, |_| Err("boom".to_string()))
            .err()
            .unwrap();
        assert!(err.to_string().contains("boom"), "got {err}");
    }

    #[test]
    fn open_reads_meta_and_spins() {
        let r = PointCloudReader::open(&sample()).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Lidar);
        assert_eq!(r.meta().channels.len(), 1);
        let ch = &r.meta().channels[0];
        assert_eq!(ch.name, "lidar_top_360fov");
        assert_eq!(ch.kind, ChannelKind::PointCloud);
        assert_eq!(ch.sample_count, 3); // peak points-per-spin
        assert_eq!(r.spin_times(), &[1_000_000_000, 1_100_000_000]);
        // 100 ms cadence inferred → last spin covered to +100 ms.
        assert_eq!(r.meta().time_range.start_ns, 1_000_000_000);
        assert_eq!(r.meta().time_range.end_ns, 1_200_000_000);
    }

    #[test]
    fn fetch_active_spin_via_prev() {
        let r = PointCloudReader::open(&sample()).unwrap();
        // A zero-width window at t just inside the second spin + include_prev
        // returns exactly that spin.
        let range = TimeRange {
            start_ns: 1_150_000_000,
            end_ns: 1_150_000_000,
        };
        let ipc = r
            .fetch_range(
                &"lidar_top_360fov".to_string(),
                range,
                FetchOpts { include_prev: true },
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 1);

        // ts column.
        let ts = batch
            .column(0)
            .as_any()
            .downcast_ref::<TimestampNanosecondArray>()
            .unwrap();
        assert_eq!(ts.value(0), 1_100_000_000);

        // positions: 3 points * 3 = 9 floats.
        let pos = batch.column(1).as_list::<i32>();
        let row0 = pos.value(0);
        let f = row0
            .as_any()
            .downcast_ref::<arrow_array::Float32Array>()
            .unwrap();
        assert_eq!(
            f.values(),
            &[7.0, 8.0, 9.0, -1.0, -2.0, -3.0, 0.0, 0.0, 0.0]
        );

        // intensities normalised to 0..1.
        let int = batch.column(2).as_list::<i32>();
        let irow = int.value(0);
        let fi = irow
            .as_any()
            .downcast_ref::<arrow_array::Float32Array>()
            .unwrap();
        assert!((fi.value(0) - 128.0 / 255.0).abs() < 1e-6);
        assert!((fi.value(1) - 64.0 / 255.0).abs() < 1e-6);
        assert!((fi.value(2) - 200.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn fetch_range_window_selects_spins() {
        let r = PointCloudReader::open(&sample()).unwrap();
        // Window covering both spins.
        let ipc = r
            .fetch_range(
                &"lidar_top_360fov".to_string(),
                TimeRange {
                    start_ns: 1_000_000_000,
                    end_ns: 1_200_000_000,
                },
                FetchOpts::default(),
            )
            .unwrap();
        assert_eq!(parse_ipc(&ipc).num_rows(), 2);
    }

    #[test]
    fn unknown_channel_errors() {
        let r = PointCloudReader::open(&sample()).unwrap();
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
    fn missing_column_errors() {
        // A plain scalar parquet (no positions/intensities) must be rejected so
        // the reader is only used for the point-cloud format.
        use parquet::arrow::ArrowWriter;
        let schema = Arc::new(Schema::new(vec![Field::new(
            "t_ns",
            DataType::Int64,
            false,
        )]));
        let batch =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(vec![1i64]))])
                .unwrap();
        let mut buf = Vec::new();
        {
            let mut w = ArrowWriter::try_new(&mut buf, schema, None).unwrap();
            w.write(&batch).unwrap();
            w.close().unwrap();
        }
        assert!(matches!(
            PointCloudReader::open(&buf),
            Err(crate::Error::PointCloudSchema(_))
        ));
    }

    /// `open` must produce identical spins whether the file arrives in one
    /// decode batch or is streamed across many batches and row groups. 20
    /// spins with 3-row row groups forces 7 row groups and (with
    /// `OPEN_BATCH_ROWS` = 8) at least 3 decode batches.
    #[test]
    fn open_streams_across_row_groups_and_batches() {
        // Compile-time guard: the fixture must span multiple decode batches.
        const _: () = assert!(20 > OPEN_BATCH_ROWS);
        let spins: Vec<TestSpin> = (0..20i64)
            .map(|i| {
                let v = i as f32;
                (
                    1_000_000_000 + i * 100_000_000,
                    vec![(v, v + 0.5, -v, (i * 12) as u8), (10.0 + v, 0.0, 1.0, 7)],
                )
            })
            .collect();
        let bytes = write_pointcloud_parquet_rg(&spins, Some(3));
        let r = PointCloudReader::open(&bytes).unwrap();

        // Every spin survived, in order, none duplicated across batch seams.
        let want_ts: Vec<i64> = (0..20i64)
            .map(|i| 1_000_000_000 + i * 100_000_000)
            .collect();
        assert_eq!(r.spin_times(), &want_ts[..]);
        assert_eq!(r.meta().channels[0].sample_count, 2);

        // Spot-check a spin that sits mid-file (row 9: second decode batch,
        // fourth row group) — values must not be smeared by neighbours.
        let ipc = r
            .fetch_range(
                &"lidar_top_360fov".to_string(),
                TimeRange {
                    start_ns: 1_900_000_000,
                    end_ns: 1_900_000_001,
                },
                FetchOpts::default(),
            )
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 1);
        let pos = batch.column(1).as_list::<i32>().value(0);
        let f = pos
            .as_any()
            .downcast_ref::<arrow_array::Float32Array>()
            .unwrap();
        assert_eq!(f.values(), &[9.0, 9.5, -9.0, 19.0, 0.0, 1.0]);
    }

    /// The zero-copy owned-buffer path must behave exactly like the slice path.
    #[test]
    fn open_owned_matches_open() {
        let bytes = sample();
        let a = PointCloudReader::open(&bytes).unwrap();
        let b = PointCloudReader::open_owned(bytes).unwrap();
        assert_eq!(a.spin_times(), b.spin_times());
        assert_eq!(a.meta().time_range.start_ns, b.meta().time_range.start_ns);
        assert_eq!(a.meta().time_range.end_ns, b.meta().time_range.end_ns);
        assert_eq!(
            a.meta().channels[0].sample_count,
            b.meta().channels[0].sample_count
        );
        assert_eq!(a.meta().channels[0].name, b.meta().channels[0].name);
    }
}
