//! Canonical contract-test fixtures. The Arrow IPC bytes produced here are
//! bit-identical to `test-fixtures/arrow_scalar.ipc` and are consumed by both
//! the Rust contract test (`tests/arrow_contract.rs`) and the JS vitest suite
//! that loads the committed file with `apache-arrow`.
//!
//! Using a shared generator prevents Rust ↔ JS schema drift.

use arrow_array::{Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use mf4_rs::blocks::common::DataType as Mf4DataType;
use mf4_rs::writer::MdfWriter;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

/// Schema: `{ ts: Timestamp(ns, UTC), value: Float64 }` — 3 rows.
/// See `docs/03-data-model.md` for the Scalar channel wire format.
pub fn arrow_scalar_ipc() -> crate::Result<Vec<u8>> {
    let schema = Arc::new(Schema::new(vec![
        Field::new(
            "ts",
            DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())),
            false,
        ),
        Field::new("value", DataType::Float64, false),
    ]));

    let ts = TimestampNanosecondArray::from(vec![1_000_000_000, 1_010_000_000, 1_020_000_000])
        .with_timezone("UTC");
    let value = Float64Array::from(vec![1.0, 2.0, 3.0]);

    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ts), Arc::new(value)])?;

    let mut buf = Vec::new();
    {
        let mut w = FileWriter::try_new(&mut buf, &schema)?;
        w.write(&batch)?;
        w.finish()?;
    }
    Ok(buf)
}

/// Synthesises a small MF4 file in memory via `mf4-rs`'s own writer. Used
/// by `examples/gen_mf4_fixture.rs` to produce the canonical
/// `test-fixtures/short.mf4` and by the integration test that reads the
/// same bytes back through `Mf4Reader`.
///
/// Layout: one data group, one channel group at 100 Hz for 0.1 s,
/// containing a master `Time` channel plus a `speed` signal whose samples
/// are `i * 2` for `i in 0..10`.
pub fn short_mf4_bytes() -> crate::Result<Vec<u8>> {
    struct SharedCursor(Arc<Mutex<Cursor<Vec<u8>>>>);
    impl std::io::Write for SharedCursor {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.0.lock().unwrap().flush()
        }
    }
    impl std::io::Seek for SharedCursor {
        fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
            self.0.lock().unwrap().seek(pos)
        }
    }

    let cursor = Arc::new(Mutex::new(Cursor::new(Vec::<u8>::new())));
    let mut w = MdfWriter::new_from_writer(SharedCursor(cursor.clone()));
    w.init_mdf_file()?;
    let cg = w.add_channel_group(None, |_| {})?;
    let t = w.add_channel(&cg, None, |ch| {
        ch.data_type = Mf4DataType::FloatLE;
        ch.name = Some("Time".into());
        ch.bit_count = 64;
    })?;
    w.set_time_channel(&t)?;
    w.add_channel(&cg, Some(&t), |ch| {
        ch.data_type = Mf4DataType::FloatLE;
        ch.name = Some("speed".into());
        ch.bit_count = 64;
    })?;
    w.start_data_block_for_cg(&cg, 0)?;
    let t_samples: Vec<f64> = (0..10).map(|i| i as f64 * 0.01).collect();
    let speed_samples: Vec<f64> = (0..10).map(|i| i as f64 * 2.0).collect();
    w.write_columns_f64(&cg, &[&t_samples, &speed_samples])?;
    w.finish_data_block(&cg)?;
    w.finalize()?;

    let bytes = cursor.lock().unwrap().get_ref().clone();
    Ok(bytes)
}
