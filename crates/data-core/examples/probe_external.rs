//! Probe driveline's MCAP / MF4 readers against an arbitrary user-supplied file.
//!
//! This is a smoke-test, not a benchmark — it does one `open`, prints
//! the resulting `SourceMeta`, and (for MF4) runs a single
//! `fetch_range` with `FetchOpts::default()` against the first channel.
//! Use it to confirm a file parses end-to-end; do not draw timing
//! conclusions from its output.
//!
//! Usage:
//!   cargo run -p data-core --example probe_external -- <kind> <path>
//!   kind = mf4 | mcap

use data_core::{McapReader, Mf4Reader, Reader};
use std::env;
use std::fs;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let kind = match args.next() {
        Some(k) => k,
        None => {
            eprintln!("usage: probe_external <mf4|mcap> <path>");
            return ExitCode::from(2);
        }
    };
    let path = match args.next() {
        Some(p) => p,
        None => {
            eprintln!("usage: probe_external <mf4|mcap> <path>");
            return ExitCode::from(2);
        }
    };

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read {path}: {e}");
            return ExitCode::from(2);
        }
    };
    println!("file: {path}  ({} bytes)", bytes.len());

    match kind.as_str() {
        "mf4" => probe_mf4(&bytes),
        "mcap" => probe_mcap(&bytes),
        other => {
            eprintln!("unknown kind: {other}");
            ExitCode::from(2)
        }
    }
}

fn probe_mf4(bytes: &[u8]) -> ExitCode {
    match Mf4Reader::open_slice(bytes) {
        Err(e) => {
            println!("Mf4Reader::open FAILED: {e}");
            ExitCode::from(1)
        }
        Ok(r) => {
            let m = r.meta();
            println!("Mf4Reader OK");
            println!(
                "  time_range: [{}, {})",
                m.time_range.start_ns, m.time_range.end_ns
            );
            println!("  channels:   {}", m.channels.len());
            for ch in m.channels.iter().take(20) {
                println!(
                    "   - {:>20} kind={:?} dtype={:?} samples={} unit={:?}",
                    ch.name, ch.kind, ch.dtype, ch.sample_count, ch.unit
                );
            }
            if m.channels.len() > 20 {
                println!("   ... and {} more", m.channels.len() - 20);
            }
            // Try one fetch on the first channel.
            if let Some(ch) = m.channels.first() {
                match r.fetch_range(&ch.id, m.time_range, Default::default()) {
                    Ok(buf) => {
                        println!("  fetch_range first channel: {} arrow IPC bytes", buf.len())
                    }
                    Err(e) => println!("  fetch_range first channel FAILED: {e}"),
                }
            }
            ExitCode::SUCCESS
        }
    }
}

fn probe_mcap(bytes: &[u8]) -> ExitCode {
    match McapReader::open(bytes) {
        Err(e) => {
            println!("McapReader::open FAILED: {e}");
            ExitCode::from(1)
        }
        Ok(r) => {
            let m = r.meta();
            println!("McapReader OK");
            println!(
                "  time_range: [{}, {})",
                m.time_range.start_ns, m.time_range.end_ns
            );
            println!("  channels:   {}", m.channels.len());
            for ch in m.channels.iter().take(40) {
                println!(
                    "   - {:>40} kind={:?} dtype={:?} samples={}",
                    ch.name, ch.kind, ch.dtype, ch.sample_count
                );
            }
            if m.channels.len() > 40 {
                println!("   ... and {} more", m.channels.len() - 40);
            }
            ExitCode::SUCCESS
        }
    }
}
