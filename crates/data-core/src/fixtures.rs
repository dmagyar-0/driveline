//! Canonical contract-test fixtures. The Arrow IPC bytes produced here are
//! bit-identical to `test-fixtures/arrow_scalar.ipc` and are consumed by both
//! the Rust contract test (`tests/arrow_contract.rs`) and the JS vitest suite
//! that loads the committed file with `apache-arrow`.
//!
//! Using a shared generator prevents Rust ↔ JS schema drift.

use arrow_array::{Float64Array, RecordBatch, TimestampNanosecondArray};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use base64::Engine as _;
use mf4_rs::blocks::common::DataType as Mf4DataType;
use mf4_rs::writer::MdfWriter;
use std::collections::BTreeMap;
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

/// 2024-01-01T00:00:00Z, matching `docs/spike-T0.3-sample-corpus.md:47`.
const T0_MCAP_NS: u64 = 1_704_067_200_000_000_000;

/// Synthesises a minimal MCAP file in memory via the `mcap` crate's writer.
/// Unit tests and the integration test (`tests/mcap_reader.rs`) consume it;
/// a committed copy lives at `test-fixtures/short.mcap`, produced by
/// `examples/gen_mcap_fixture.rs`.
///
/// Four channels, mirroring the T0.3 fixture spec as closely as practical
/// for Rust-side tests:
///
/// - `/vehicle/speed` — `foxglove.Float64`, 10 samples @ 10 ms.
/// - `/imu/accel` — `foxglove.Vector3`, 5 samples @ 20 ms.
/// - `/control/mode` — `driveline.ControlMode`, 3 sparse samples at 0 / 40 / 80 ms.
/// - `/camera/front` — `foxglove.CompressedVideo`, 3 synthetic Annex-B
///   keyframes (SPS + IDR start codes, no real payload) base64-encoded
///   inside the JSON envelope.
///
/// Output is deterministic: compression is disabled, the `library` string
/// is pinned, chunks are suppressed (`use_chunks = false`) so no indexes or
/// CRCs of chunk bytes bleed into the stream.
pub fn short_mcap_bytes() -> crate::Result<Vec<u8>> {
    use ::mcap::{records::MessageHeader, WriteOptions};

    let buf: Vec<u8> = Vec::new();
    let cursor = Cursor::new(buf);

    let mut writer = WriteOptions::new()
        .compression(None)
        .library("driveline-test-fixtures")
        .use_chunks(false)
        .create(cursor)?;

    let float_schema = writer.add_schema("foxglove.Float64", "jsonschema", b"")?;
    let speed_ch =
        writer.add_channel(float_schema, "/vehicle/speed", "json", &BTreeMap::new())?;
    for i in 0u32..10 {
        let ts = T0_MCAP_NS + (i as u64) * 10_000_000;
        let payload = format!(r#"{{"value":{}}}"#, i).into_bytes();
        writer.write_to_known_channel(
            &MessageHeader {
                channel_id: speed_ch,
                sequence: i,
                log_time: ts,
                publish_time: ts,
            },
            &payload,
        )?;
    }

    let vec3_schema = writer.add_schema("foxglove.Vector3", "jsonschema", b"")?;
    let accel_ch = writer.add_channel(vec3_schema, "/imu/accel", "json", &BTreeMap::new())?;
    for i in 0u32..5 {
        let ts = T0_MCAP_NS + (i as u64) * 20_000_000;
        let payload = br#"{"x":1.0,"y":2.0,"z":3.0}"#.to_vec();
        writer.write_to_known_channel(
            &MessageHeader {
                channel_id: accel_ch,
                sequence: i,
                log_time: ts,
                publish_time: ts,
            },
            &payload,
        )?;
    }

    let enum_schema = writer.add_schema("driveline.ControlMode", "jsonschema", b"")?;
    let mode_ch = writer.add_channel(enum_schema, "/control/mode", "json", &BTreeMap::new())?;
    for (i, (offset_ms, code)) in [(0u64, 0i32), (40, 1), (80, 0)].into_iter().enumerate() {
        let ts = T0_MCAP_NS + offset_ms * 1_000_000;
        let payload = format!(r#"{{"value":{}}}"#, code).into_bytes();
        writer.write_to_known_channel(
            &MessageHeader {
                channel_id: mode_ch,
                sequence: i as u32,
                log_time: ts,
                publish_time: ts,
            },
            &payload,
        )?;
    }

    // Synthetic H.264 Annex-B: 4-byte start code + SPS (NAL type 7, header
    // byte 0x67), then start code + IDR (NAL type 5, header byte 0x65).
    // Exercises `is_keyframe` + `extract_video_bytes_from_json` without
    // bundling a real H.264 encoder.
    const FAKE_SPS_IDR: &[u8] = &[
        0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1e, // SPS header + minimal bytes
        0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, // IDR header + minimal bytes
    ];
    let video_schema =
        writer.add_schema("foxglove.CompressedVideo", "jsonschema", b"")?;
    let camera_ch =
        writer.add_channel(video_schema, "/camera/front", "json", &BTreeMap::new())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(FAKE_SPS_IDR);
    for i in 0u32..3 {
        let ts = T0_MCAP_NS + (i as u64) * 30_000_000;
        let payload =
            format!(r#"{{"data":"{}","format":"h264"}}"#, b64).into_bytes();
        writer.write_to_known_channel(
            &MessageHeader {
                channel_id: camera_ch,
                sequence: i,
                log_time: ts,
                publish_time: ts,
            },
            &payload,
        )?;
    }

    writer.finish()?;
    Ok(writer.into_inner().into_inner())
}

/// 2023-11-14T22:13:20Z — chosen to land beyond `Number.MAX_SAFE_INTEGER`
/// when expressed as ns, which lets the JS side exercise the BigInt path.
const T0_MP4_NS: i64 = 1_700_000_000_000_000_000;

/// Frame step for the mp4 fixture: 33_333_333 ns ≈ 30 fps.
const STEP_MP4_NS: i64 = 33_333_333;

/// Sample count of the mp4 fixture.
const MP4_SAMPLE_COUNT: usize = 10;

/// Dummy H.264 SPS NAL bytes. Valid enough for the `mp4` crate's `avcC`
/// serialiser to accept; these never reach a real decoder — the T2.4 e2e
/// only exercises the parse + sidecar-pairing path.
const DUMMY_SPS: &[u8] = &[
    0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9, 0x40, 0xa0, 0x3d, 0xa1, 0x00, 0x00, 0x03, 0x00, 0x01,
    0x00, 0x00, 0x03, 0x00, 0x3c, 0x0f, 0x16, 0x2e, 0x48,
];
const DUMMY_PPS: &[u8] = &[0x68, 0xeb, 0xec, 0xb2, 0x2c];

/// Build a minimal in-memory H.264 mp4 with `MP4_SAMPLE_COUNT` samples at
/// 30 fps. Sample payloads are placeholder length-prefixed NAL bytes —
/// adequate for `Mp4SidecarReader::open_pair` (which only reads the `moov`)
/// but not playable. Paired with `short_sidecar_bytes`.
pub fn short_mp4_bytes() -> crate::Result<Vec<u8>> {
    use mp4::{AvcConfig, Bytes, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig, TrackType};

    let config = Mp4Config {
        major_brand: "isom".parse().expect("static str parses as FourCC"),
        minor_version: 512,
        compatible_brands: vec![
            "isom".parse().expect("static str parses as FourCC"),
            "iso2".parse().expect("static str parses as FourCC"),
            "avc1".parse().expect("static str parses as FourCC"),
            "mp41".parse().expect("static str parses as FourCC"),
        ],
        timescale: 30,
    };
    let mut writer = Mp4Writer::write_start(Cursor::new(Vec::<u8>::new()), &config)?;
    let track = TrackConfig {
        track_type: TrackType::Video,
        timescale: 30,
        language: "und".to_string(),
        media_conf: MediaConfig::AvcConfig(AvcConfig {
            width: 16,
            height: 16,
            seq_param_set: DUMMY_SPS.to_vec(),
            pic_param_set: DUMMY_PPS.to_vec(),
        }),
    };
    writer.add_track(&track)?;

    let payload = Bytes::from_static(&[0x00, 0x00, 0x00, 0x01, 0x09]);
    for i in 0..MP4_SAMPLE_COUNT {
        let sample = Mp4Sample {
            start_time: i as u64,
            duration: 1,
            rendering_offset: 0,
            is_sync: i == 0,
            bytes: payload.clone(),
        };
        writer.write_sample(1, &sample)?;
    }
    writer.write_end()?;
    Ok(writer.into_writer().into_inner())
}

/// Text sidecar payload matching `short_mp4_bytes`: one line per frame of
/// the form `<frame_index>\t<ts_ns>\n`, where `ts_ns = T0_MP4_NS + i *
/// STEP_MP4_NS` for `i in 0..MP4_SAMPLE_COUNT`. UTF-8, no header.
pub fn short_sidecar_bytes() -> Vec<u8> {
    let mut out = String::with_capacity(MP4_SAMPLE_COUNT * 32);
    for i in 0..MP4_SAMPLE_COUNT {
        let t = T0_MP4_NS + (i as i64) * STEP_MP4_NS;
        out.push_str(&format!("{i}\t{t}\n"));
    }
    out.into_bytes()
}
