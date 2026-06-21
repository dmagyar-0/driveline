//! Integration coverage for the `NoopReader` and the public `TimeRange`
//! value type. These pin two contracts that were previously only
//! exercised as a side effect of the noop unit tests:
//!
//! 1. `Reader::video_stream` has a default body (`Err(UnsupportedKind)`).
//!    `NoopReader` does not override it, so calling it through the
//!    trait surface must still report `UnsupportedKind`.
//! 2. `TimeRange::is_empty` is a public helper with a less-than-or-equal
//!    comparison; the unit tests only cover the `start == end == 0`
//!    case via `SourceMeta::empty()`.

use data_core::noop::NoopReader;
use data_core::{Error, Reader, TimeRange};

#[test]
fn noop_video_stream_defaults_to_unsupported_kind() {
    let r = NoopReader::open(&[]).expect("open noop");
    let result = r.video_stream("any", 0);
    match result {
        Err(Error::UnsupportedKind) => {}
        Err(e) => panic!("expected UnsupportedKind, got {e:?}"),
        Ok(_) => panic!("expected Err, got Ok"),
    }
}

#[test]
fn time_range_empty_constant_is_empty() {
    assert!(TimeRange::empty().is_empty());
}

#[test]
fn time_range_positive_width_is_not_empty() {
    let r = TimeRange {
        start_ns: 100,
        end_ns: 200,
    };
    assert!(!r.is_empty());
}

#[test]
fn time_range_zero_width_is_empty() {
    let r = TimeRange {
        start_ns: 5,
        end_ns: 5,
    };
    assert!(r.is_empty());
}

#[test]
fn time_range_inverted_bounds_are_empty() {
    // `is_empty` uses `end_ns <= start_ns`, so a reader that somehow
    // surfaced a negative-width range would still be treated as empty
    // by downstream consumers.
    let r = TimeRange {
        start_ns: 1_000,
        end_ns: 500,
    };
    assert!(r.is_empty());
}
