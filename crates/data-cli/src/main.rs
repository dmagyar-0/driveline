//! `driveline-data` — query driveline-readable log files from the shell.
//!
//! ```text
//! driveline-data info <file>
//! driveline-data fetch <file> <channel-id> [--start NS] [--end NS]
//!                      [--include-prev] [--json]
//! ```
//!
//! `info` prints source metadata + the channel list as JSON. `fetch`
//! prints one channel's samples over `[start, end)` as CSV (default) or
//! JSON; the window defaults to the channel's full time range. All
//! nanosecond values are absolute UTC, matching the web app's timeline.

use std::path::PathBuf;
use std::process::ExitCode;

use data_cli::{channel_range, fetch_csv, fetch_json, open_reader, source_info_json};
use data_core::types::TimeRange;

const USAGE: &str = "usage:
  driveline-data info <file>
  driveline-data fetch <file> <channel-id> [--start NS] [--end NS] [--include-prev] [--json]

supported files: .mcap, .mf4, .bag (ROS1), .db3 (ROS2), .xodr (OpenDRIVE map)";

fn fail(msg: &str) -> ExitCode {
    eprintln!("driveline-data: {msg}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("info") => {
            let [_, file] = args.as_slice() else {
                return fail(USAGE);
            };
            let reader = match open_reader(&PathBuf::from(file)) {
                Ok(r) => r,
                Err(e) => return fail(&e),
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&source_info_json(&reader))
                    .expect("metadata serialises")
            );
            ExitCode::SUCCESS
        }
        Some("fetch") => {
            if args.len() < 3 {
                return fail(USAGE);
            }
            let file = &args[1];
            let channel_id = &args[2];
            let mut start: Option<i64> = None;
            let mut end: Option<i64> = None;
            let mut include_prev = false;
            let mut json = false;
            let mut rest = args[3..].iter();
            while let Some(flag) = rest.next() {
                match flag.as_str() {
                    "--start" | "--end" => {
                        let Some(value) = rest.next() else {
                            return fail(&format!("{flag} needs a nanosecond value"));
                        };
                        let Ok(ns) = value.parse::<i64>() else {
                            return fail(&format!("{flag} {value}: not a valid i64 ns value"));
                        };
                        if flag == "--start" {
                            start = Some(ns);
                        } else {
                            end = Some(ns);
                        }
                    }
                    "--include-prev" => include_prev = true,
                    "--json" => json = true,
                    other => return fail(&format!("unknown flag {other:?}\n{USAGE}")),
                }
            }
            let reader = match open_reader(&PathBuf::from(file)) {
                Ok(r) => r,
                Err(e) => return fail(&e),
            };
            let full = match channel_range(&reader, channel_id) {
                Ok(r) => r,
                Err(e) => return fail(&e),
            };
            let range = TimeRange {
                start_ns: start.unwrap_or(full.start_ns),
                // The fetch window is half-open; +1 so the default covers
                // the channel's (inclusive) last sample.
                end_ns: end.unwrap_or(full.end_ns.saturating_add(1)),
            };
            let result = if json {
                fetch_json(&reader, channel_id, range, include_prev)
                    .map(|v| serde_json::to_string_pretty(&v).expect("rows serialise"))
            } else {
                fetch_csv(&reader, channel_id, range, include_prev)
            };
            match result {
                Ok(text) => {
                    print!("{text}");
                    ExitCode::SUCCESS
                }
                Err(e) => fail(&e),
            }
        }
        _ => fail(USAGE),
    }
}
