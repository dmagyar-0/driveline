//! `Mf4Reader`: a lazy, range-reading MF4 adapter on top of `mf4-rs`.
//!
//! For each channel group we resolve the master (time) channel, translate its
//! per-sample float seconds offsets into absolute i64 nanoseconds
//! (`start_time_ns + round(t_rel * 1e9)`), and surface every non-master
//! channel as a `Scalar` / `Float64` Arrow column on demand.
//!
//! ## Memory model
//!
//! The reader never holds the file bytes. It keeps only the lightweight
//! [`MdfIndex`] (block offsets/metadata, no sample data) plus the decoded
//! per-group timelines, and pulls sample bytes through a [`ByteRangeReader`]
//! on demand — so a multi-gigabyte file is never materialised in memory.
//! In the browser the reader is backed by an OPFS sync access handle
//! (see `wasm-bindings`); native callers and tests use an in-memory
//! [`SliceRangeReader`]. Decoded values for *plotted* channels are cached so
//! repeated pan/zoom fetches don't re-stream the file; `release_channel`
//! drops a channel's cache when it stops being plotted.
//!
//! Deliberate scope limits: no vector / enum / bytes channels, and no
//! compressed-block (`##DZ`) or VLSD decoding (the upstream index reader
//! itself does not support those yet). Those are follow-up tasks.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::{Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use mf4_rs::error::MdfError;
use mf4_rs::index::{ByteRangeReader, IndexedChannelGroup, MdfIndex, SliceRangeReader};

use crate::reader::ArrowIpc;
use crate::types::{
    Channel, ChannelId, ChannelKind, DType, FetchOpts, SourceKind, SourceMeta, TimeRange,
};

/// Decoded full-channel values keyed by `(group_index, channel_index)`.
type ValueCache = HashMap<(usize, usize), Arc<[f64]>>;

/// MDF 4.1 channel type marking a master (time) channel.
const CHANNEL_TYPE_MASTER: u8 = 2;
/// MDF 4.1 channel type for a synthetic / virtual master.
const CHANNEL_TYPE_VIRTUAL_MASTER: u8 = 3;

/// Owned, object-safe wrapper around any [`ByteRangeReader`].
///
/// `mf4-rs`'s read methods are generic over `R: ByteRangeReader` (which
/// requires a `Sized` reader), so we cannot hand them a `&mut dyn` directly.
/// This newtype is `Sized`, implements the trait by delegating, and lets a
/// single non-generic `Mf4Reader` hold either the in-memory slice reader
/// (native/tests) or the JS/OPFS-backed reader (wasm) behind one boxed value.
pub struct BoxedRangeReader(Box<dyn ByteRangeReader<Error = MdfError>>);

impl BoxedRangeReader {
    pub fn new<R: ByteRangeReader<Error = MdfError> + 'static>(reader: R) -> Self {
        BoxedRangeReader(Box::new(reader))
    }
}

impl ByteRangeReader for BoxedRangeReader {
    type Error = MdfError;
    fn read_range(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, MdfError> {
        self.0.read_range(offset, length)
    }
}

pub struct Mf4Reader {
    idx: MdfIndex,
    meta: SourceMeta,
    /// Source of sample bytes. `RefCell` because decoding takes `&mut R` while
    /// `fetch_range` only has `&self`. Never holds the whole file — reads are
    /// per-data-block and dropped after each block is decoded.
    reader: RefCell<BoxedRangeReader>,
    /// Per-CG absolute timestamps in ns-UTC. Parallel to `idx.channel_groups`.
    /// Groups that had no usable master end up with an empty vector and are
    /// absent from `channel_map` so they can never be queried.
    cg_time_ns: Vec<Vec<i64>>,
    channel_map: HashMap<ChannelId, (usize, usize)>,
    /// Decoded full-channel values for currently-plotted channels, keyed by
    /// `(group, channel)`. Populated on first `fetch_range` and reused for
    /// subsequent pan/zoom so the file is not re-streamed per interaction.
    /// Bounded to the plotted set via `release_channel` / `close`.
    value_cache: RefCell<ValueCache>,
}

impl Mf4Reader {
    fn channel_id(group_index: usize, channel_index: usize) -> ChannelId {
        format!("{group_index}/{channel_index}")
    }

    fn master_index(group: &IndexedChannelGroup) -> Option<usize> {
        group.channels.iter().position(|c| {
            c.channel_type == CHANNEL_TYPE_MASTER || c.channel_type == CHANNEL_TYPE_VIRTUAL_MASTER
        })
    }

    fn translate_abs_ns(start_time_ns: u64, t_rel_seconds: &[f64]) -> Vec<i64> {
        let base = start_time_ns as i64;
        t_rel_seconds
            .iter()
            .map(|&t| {
                // MF4 master time channels are float seconds; `NaN` comes through
                // as the library's placeholder for a failed decode. Collapsing it
                // to the file base is good enough for the range binary search —
                // these samples are unusable anyway, and ignoring them would
                // desynchronise the value vector we later slice against.
                if t.is_nan() {
                    base
                } else {
                    base.saturating_add((t * 1.0e9).round() as i64)
                }
            })
            .collect()
    }

    /// Convenience constructor used by native callers and tests: build a
    /// reader over an in-memory byte slice. The bytes are moved into a
    /// [`SliceRangeReader`] and not copied again.
    pub fn open_slice(bytes: &[u8]) -> crate::Result<Self> {
        let file_size = bytes.len() as u64;
        Self::open_ranged(
            BoxedRangeReader::new(SliceRangeReader::new(bytes.to_vec())),
            file_size,
        )
    }

    /// Build a reader that streams sample bytes through `reader`. Only the
    /// file's metadata blocks and the per-group master (time) channels are
    /// read here — value channels are decoded lazily on `fetch_range`.
    pub fn open_ranged(mut reader: BoxedRangeReader, file_size: u64) -> crate::Result<Self> {
        let idx = MdfIndex::from_range_reader(&mut reader, file_size)?;
        let start_time_ns = idx.start_time_ns.unwrap_or(0);

        let mut channels = Vec::new();
        let mut channel_map = HashMap::new();
        let mut cg_time_ns: Vec<Vec<i64>> = Vec::with_capacity(idx.channel_groups.len());
        let mut range: Option<(i64, i64)> = None;

        for (g, group) in idx.channel_groups.iter().enumerate() {
            let Some(master_idx) = Self::master_index(group) else {
                // CGs without a master (e.g. unset in a test writer) are not
                // queryable; push an empty timeline so the vector indices stay
                // aligned with `idx.channel_groups`.
                cg_time_ns.push(Vec::new());
                continue;
            };

            // Decode the master timeline once, via ranged reads. Master and
            // value channels share the group's data blocks, so this streams
            // each block, keeps only the timestamps, and discards the rest.
            let t_rel = idx.read_channel_values_as_f64(g, master_idx, &mut reader)?;
            let abs_ns = Self::translate_abs_ns(start_time_ns, &t_rel);

            if let (Some(&first), Some(&last)) = (abs_ns.first(), abs_ns.last()) {
                // `docs/03-data-model.md` defines TimeRange as a half-open
                // interval; `+1` on the last ns makes the union operation
                // commutative with single-sample groups.
                let end = last.saturating_add(1);
                range = Some(match range {
                    Some((lo, hi)) => (lo.min(first), hi.max(end)),
                    None => (first, end),
                });
            }

            for (c, ch) in group.channels.iter().enumerate() {
                if c == master_idx {
                    continue;
                }
                let id = Self::channel_id(g, c);
                let name = ch.name.clone().unwrap_or_else(|| format!("ch_{g}_{c}"));
                let time_range = match (abs_ns.first(), abs_ns.last()) {
                    (Some(&a), Some(&b)) => TimeRange {
                        start_ns: a,
                        end_ns: b.saturating_add(1),
                    },
                    _ => TimeRange::empty(),
                };
                channels.push(Channel {
                    id: id.clone(),
                    source_id: String::new(),
                    name,
                    kind: ChannelKind::Scalar,
                    dtype: Some(DType::F64),
                    unit: ch.unit.clone(),
                    sample_count: abs_ns.len() as u64,
                    time_range,
                });
                channel_map.insert(id, (g, c));
            }
            cg_time_ns.push(abs_ns);
        }

        let time_range = match range {
            Some((lo, hi)) => TimeRange {
                start_ns: lo,
                end_ns: hi,
            },
            None => TimeRange::empty(),
        };

        Ok(Mf4Reader {
            idx,
            meta: SourceMeta {
                id: String::new(),
                kind: SourceKind::Mf4,
                time_range,
                channels,
            },
            reader: RefCell::new(reader),
            cg_time_ns,
            channel_map,
            value_cache: RefCell::new(HashMap::new()),
        })
    }

    pub fn meta(&self) -> &SourceMeta {
        &self.meta
    }

    /// Human-readable label for the channel group that owns `channel_id`
    /// (`{group}/{channel}`). Prefers the MDF channel-group name, then its
    /// comment, then a positional `Group {g}` fallback so MF4 channels can
    /// always be nested under a named group in the UI. Returns `None` only
    /// for an unknown id.
    pub fn group_label(&self, channel_id: &ChannelId) -> Option<String> {
        let &(g, _c) = self.channel_map.get(channel_id)?;
        let cg = self.idx.channel_groups.get(g)?;
        let non_empty = |s: &String| !s.trim().is_empty();
        Some(
            cg.name
                .clone()
                .filter(&non_empty)
                .or_else(|| cg.comment.clone().filter(&non_empty))
                .unwrap_or_else(|| format!("Group {g}")),
        )
    }

    /// Decode (or fetch from cache) the full value vector for `(g, c)`.
    fn channel_values(&self, g: usize, c: usize) -> crate::Result<Arc<[f64]>> {
        if let Some(cached) = self.value_cache.borrow().get(&(g, c)) {
            return Ok(cached.clone());
        }
        let values: Arc<[f64]> = self
            .idx
            .read_channel_values_as_f64(g, c, &mut *self.reader.borrow_mut())?
            .into();
        self.value_cache.borrow_mut().insert((g, c), values.clone());
        Ok(values)
    }

    /// Drop the cached decoded values for `channel_id`, e.g. when the channel
    /// is removed from all plots. Timestamps and the index are retained.
    pub fn release_channel(&self, channel_id: &ChannelId) {
        if let Some(&(g, c)) = self.channel_map.get(channel_id) {
            self.value_cache.borrow_mut().remove(&(g, c));
        }
    }

    pub fn fetch_range(
        &self,
        channel_id: &ChannelId,
        range: TimeRange,
        opts: FetchOpts,
    ) -> crate::Result<ArrowIpc> {
        let &(g, c) = self
            .channel_map
            .get(channel_id)
            .ok_or_else(|| crate::Error::ChannelNotFound(channel_id.clone()))?;

        let abs_ns = &self.cg_time_ns[g];
        // Half-open lookup matching the data-model contract.
        let start_idx = abs_ns.partition_point(|&t| t < range.start_ns);
        let end_idx = abs_ns.partition_point(|&t| t < range.end_ns).max(start_idx);
        // `include_prev` is tracked separately from the in-range body so
        // the T4.3 min-max decimation path cannot absorb the leading
        // sample into a bucket.
        let prev_idx = if opts.include_prev && start_idx > 0 {
            Some(start_idx - 1)
        } else {
            None
        };

        let schema = Arc::new(Schema::new(vec![
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
                false,
            ),
            Field::new("value", DataType::Float64, false),
        ]));

        let (ts_final, vals_final): (Vec<i64>, Vec<f64>) =
            if start_idx == end_idx && prev_idx.is_none() {
                (Vec::new(), Vec::new())
            } else {
                let all_values = self.channel_values(g, c)?;
                let mut ts: Vec<i64> = abs_ns[start_idx..end_idx].to_vec();
                let mut vs: Vec<f64> = all_values[start_idx..end_idx].to_vec();
                if let Some(p) = prev_idx {
                    ts.insert(0, abs_ns[p]);
                    vs.insert(0, all_values[p]);
                }
                (ts, vs)
            };

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
    use mf4_rs::blocks::common::DataType as Mf4DataType;
    use mf4_rs::writer::MdfWriter;
    use std::io::Cursor;
    use std::sync::Mutex;

    /// In-memory MF4 builder. `MdfWriter::finalize` consumes self and drops
    /// the underlying writer, so we share the cursor through `Arc<Mutex<…>>`
    /// and recover the bytes after finalize.
    struct InMemoryMf4 {
        cursor: Arc<Mutex<Cursor<Vec<u8>>>>,
    }

    impl std::io::Write for InMemoryMf4 {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.cursor.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.cursor.lock().unwrap().flush()
        }
    }

    impl std::io::Seek for InMemoryMf4 {
        fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
            self.cursor.lock().unwrap().seek(pos)
        }
    }

    fn new_writer() -> (MdfWriter, Arc<Mutex<Cursor<Vec<u8>>>>) {
        let cursor = Arc::new(Mutex::new(Cursor::new(Vec::<u8>::new())));
        let w = MdfWriter::new_from_writer(InMemoryMf4 {
            cursor: cursor.clone(),
        });
        (w, cursor)
    }

    fn bytes_of(cursor: Arc<Mutex<Cursor<Vec<u8>>>>) -> Vec<u8> {
        cursor.lock().unwrap().get_ref().clone()
    }

    /// One CG at 100 Hz for 0.1 s: time (master) + speed.
    fn synth_single_group() -> Vec<u8> {
        let (mut w, cursor) = new_writer();
        w.init_mdf_file().unwrap();
        let cg = w.add_channel_group(None, |_| {}).unwrap();
        let t = w
            .add_channel(&cg, None, |ch| {
                ch.data_type = Mf4DataType::FloatLE;
                ch.name = Some("Time".into());
                ch.bit_count = 64;
            })
            .unwrap();
        w.set_time_channel(&t).unwrap();
        w.add_channel(&cg, Some(&t), |ch| {
            ch.data_type = Mf4DataType::FloatLE;
            ch.name = Some("speed".into());
            ch.bit_count = 64;
        })
        .unwrap();

        w.start_data_block_for_cg(&cg, 0).unwrap();
        let t_samples: Vec<f64> = (0..10).map(|i| i as f64 * 0.01).collect();
        let speed_samples: Vec<f64> = (0..10).map(|i| (i as f64) * 2.0).collect();
        w.write_columns_f64(&cg, &[&t_samples, &speed_samples])
            .unwrap();
        w.finish_data_block(&cg).unwrap();
        w.finalize().unwrap();
        bytes_of(cursor)
    }

    fn parse_ipc(bytes: &[u8]) -> RecordBatch {
        let reader = FileReader::try_new(Cursor::new(bytes), None).unwrap();
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(batches.len(), 1, "expected exactly one record batch");
        batches.into_iter().next().unwrap()
    }

    #[test]
    fn synthesises_and_reads_scalar_channel() {
        let bytes = synth_single_group();
        let r = Mf4Reader::open_slice(&bytes).unwrap();
        assert_eq!(r.meta().kind, SourceKind::Mf4);
        // Master is hidden, only `speed` remains.
        assert_eq!(r.meta().channels.len(), 1);
        let ch = &r.meta().channels[0];
        assert_eq!(ch.name, "speed");
        assert_eq!(ch.kind, ChannelKind::Scalar);
        assert_eq!(ch.dtype, Some(DType::F64));
        assert_eq!(ch.sample_count, 10);

        // The writer leaves this group unnamed, so `group_label` falls back
        // to the positional `Group {g}` so the UI can still nest it.
        assert_eq!(r.group_label(&ch.id), Some("Group 0".to_string()));
        assert_eq!(r.group_label(&"9/9".to_string()), None);

        // Default MDF header abs_time is 2h in ns; the exact value doesn't
        // matter, only that all samples are within [start, end).
        assert!(r.meta().time_range.end_ns > r.meta().time_range.start_ns);
    }

    #[test]
    fn fetch_range_returns_expected_arrow_schema() {
        let bytes = synth_single_group();
        let r = Mf4Reader::open_slice(&bytes).unwrap();
        let channel_id = r.meta().channels[0].id.clone();

        let ipc = r
            .fetch_range(&channel_id, r.meta().time_range, FetchOpts::default())
            .unwrap();
        let batch = parse_ipc(&ipc);

        assert_eq!(batch.num_rows(), 10);
        assert_eq!(batch.schema().field(0).name(), "ts");
        assert_eq!(batch.schema().field(1).name(), "value");
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
        for i in 1..ts.len() {
            assert!(
                ts.value(i) > ts.value(i - 1),
                "timestamps must be strictly increasing"
            );
        }

        let value = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        let sum: f64 = (0..value.len()).map(|i| value.value(i)).sum();
        // 0 + 2 + 4 + ... + 18 = 90
        assert!((sum - 90.0).abs() < 1e-9);
    }

    #[test]
    fn fetch_range_respects_time_bounds() {
        let bytes = synth_single_group();
        let r = Mf4Reader::open_slice(&bytes).unwrap();
        let channel_id = r.meta().channels[0].id.clone();
        let base = r.meta().time_range.start_ns;

        // 30 ms .. 70 ms window — expect indices 3..7 → 4 samples, values 6..12.
        let range = TimeRange {
            start_ns: base + 30_000_000,
            end_ns: base + 70_000_000,
        };
        let ipc = r
            .fetch_range(&channel_id, range, FetchOpts::default())
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 4);

        let value = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        let values: Vec<f64> = (0..value.len()).map(|i| value.value(i)).collect();
        assert_eq!(values, vec![6.0, 8.0, 10.0, 12.0]);
    }

    #[test]
    fn include_prev_adds_leading_sample() {
        let bytes = synth_single_group();
        let r = Mf4Reader::open_slice(&bytes).unwrap();
        let channel_id = r.meta().channels[0].id.clone();
        let base = r.meta().time_range.start_ns;

        let range = TimeRange {
            start_ns: base + 30_000_000,
            end_ns: base + 70_000_000,
        };
        let ipc = r
            .fetch_range(&channel_id, range, FetchOpts { include_prev: true })
            .unwrap();
        let batch = parse_ipc(&ipc);
        assert_eq!(batch.num_rows(), 5);
        let value = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        // One leading sample at index 2 → value 4.0.
        assert!((value.value(0) - 4.0).abs() < 1e-9);
    }

    #[test]
    fn unknown_channel_returns_channel_not_found() {
        let bytes = synth_single_group();
        let r = Mf4Reader::open_slice(&bytes).unwrap();
        let err = r
            .fetch_range(
                &"99/99".to_string(),
                r.meta().time_range,
                FetchOpts::default(),
            )
            .unwrap_err();
        assert!(matches!(err, crate::Error::ChannelNotFound(_)));
    }

    #[test]
    fn skips_cg_without_master() {
        let (mut w, cursor) = new_writer();
        w.init_mdf_file().unwrap();
        let cg = w.add_channel_group(None, |_| {}).unwrap();
        // Two non-master channels; no `set_time_channel` call.
        let a = w
            .add_channel(&cg, None, |ch| {
                ch.data_type = Mf4DataType::FloatLE;
                ch.name = Some("a".into());
                ch.bit_count = 64;
            })
            .unwrap();
        w.add_channel(&cg, Some(&a), |ch| {
            ch.data_type = Mf4DataType::FloatLE;
            ch.name = Some("b".into());
            ch.bit_count = 64;
        })
        .unwrap();
        w.start_data_block_for_cg(&cg, 0).unwrap();
        w.write_columns_f64(&cg, &[&[0.0, 0.1], &[1.0, 2.0]])
            .unwrap();
        w.finish_data_block(&cg).unwrap();
        w.finalize().unwrap();
        let bytes = bytes_of(cursor);

        let r = Mf4Reader::open_slice(&bytes).unwrap();
        assert!(r.meta().channels.is_empty());
        assert!(r.meta().time_range.is_empty());
    }

    #[test]
    fn translates_cg_time_to_ns_utc() {
        // Two CGs at different rates — 100 Hz speed, 1 kHz accel — verifying
        // that per-CG time bases translate independently into absolute ns.
        let (mut w, cursor) = new_writer();
        w.init_mdf_file().unwrap();

        let cg1 = w.add_channel_group(None, |_| {}).unwrap();
        let t1 = w
            .add_channel(&cg1, None, |ch| {
                ch.data_type = Mf4DataType::FloatLE;
                ch.name = Some("Time".into());
                ch.bit_count = 64;
            })
            .unwrap();
        w.set_time_channel(&t1).unwrap();
        w.add_channel(&cg1, Some(&t1), |ch| {
            ch.data_type = Mf4DataType::FloatLE;
            ch.name = Some("speed".into());
            ch.bit_count = 64;
        })
        .unwrap();

        let cg2 = w.add_channel_group(None, |_| {}).unwrap();
        let t2 = w
            .add_channel(&cg2, None, |ch| {
                ch.data_type = Mf4DataType::FloatLE;
                ch.name = Some("Time".into());
                ch.bit_count = 64;
            })
            .unwrap();
        w.set_time_channel(&t2).unwrap();
        w.add_channel(&cg2, Some(&t2), |ch| {
            ch.data_type = Mf4DataType::FloatLE;
            ch.name = Some("accel".into());
            ch.bit_count = 64;
        })
        .unwrap();

        w.start_data_block_for_cg(&cg1, 0).unwrap();
        let t_slow: Vec<f64> = (0..5).map(|i| i as f64 * 0.01).collect(); // 100 Hz
        let v_slow: Vec<f64> = (0..5).map(|i| i as f64).collect();
        w.write_columns_f64(&cg1, &[&t_slow, &v_slow]).unwrap();
        w.finish_data_block(&cg1).unwrap();

        w.start_data_block_for_cg(&cg2, 0).unwrap();
        let t_fast: Vec<f64> = (0..50).map(|i| i as f64 * 0.001).collect(); // 1 kHz
        let v_fast: Vec<f64> = (0..50).map(|i| i as f64).collect();
        w.write_columns_f64(&cg2, &[&t_fast, &v_fast]).unwrap();
        w.finish_data_block(&cg2).unwrap();
        w.finalize().unwrap();
        let bytes = bytes_of(cursor);

        let r = Mf4Reader::open_slice(&bytes).unwrap();
        // 2 non-master channels across 2 CGs.
        assert_eq!(r.meta().channels.len(), 2);

        // Both CGs started at the same absolute base; the faster CG runs
        // slightly past the slower one (49 ms vs 40 ms span), so the union
        // range's end_ns should match the fast CG's last sample + 1.
        let start = r.idx.start_time_ns.unwrap_or(0) as i64;
        assert_eq!(r.meta().time_range.start_ns, start);
        assert_eq!(r.meta().time_range.end_ns, start + 49_000_000 + 1);
    }
}
