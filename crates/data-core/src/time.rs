//! Shared time-window helpers used by every ranged reader.
//!
//! The half-open range-window slice idiom and the median-gap period inference
//! used to be hand-rolled and copy-pasted across ~8 readers. Keeping the
//! bounds / `include_prev` semantics in one place removes a correctness-drift
//! hazard: a subtle change to inclusive vs exclusive bounds in one reader can
//! no longer silently diverge from the others.

/// Resolve the contiguous slice `[lo, hi)` of a **sorted** timestamp array that
/// covers the half-open window `[start_ns, end_ns)`.
///
/// The window is half-open: a sample at exactly `start_ns` is included, a
/// sample at exactly `end_ns` is excluded. `hi` is clamped so that
/// `hi >= start_idx`, i.e. the returned range is never reversed even for an
/// empty or degenerate window.
///
/// When `include_prev` is true and the window does not start at index 0, the
/// returned `lo` is pulled back by one to include the sample immediately
/// *before* the window. This is how panels ask for "the value active at the
/// cursor": a zero/one-width window plus the preceding sample. Because that
/// previous sample sits immediately before the in-range body, the contiguous
/// range `lo..hi` is exactly equivalent to "optional prev sample, then the
/// in-range body `start_idx..end_idx`".
///
/// `sorted_ts` must be ascending; the half-open semantics rely on
/// [`slice::partition_point`] over a sorted slice. The function never panics
/// and never allocates.
pub(crate) fn range_window(
    sorted_ts: &[i64],
    start_ns: i64,
    end_ns: i64,
    include_prev: bool,
) -> (usize, usize) {
    let start_idx = sorted_ts.partition_point(|&t| t < start_ns);
    let end_idx = sorted_ts.partition_point(|&t| t < end_ns).max(start_idx);
    let lo = if include_prev && start_idx > 0 {
        start_idx - 1
    } else {
        start_idx
    };
    (lo, end_idx)
}

/// Infer the per-sample display duration from the median positive inter-sample
/// gap of a **sorted** timestamp array.
///
/// Falls back to `fallback` for fewer than two samples, or when no positive gap
/// exists (e.g. every timestamp is identical). Using the median makes the
/// estimate robust to a stray out-of-order or duplicated timestamp. The
/// `fallback` parameter lets each reader keep its own default cadence
/// (e.g. video-rate frames vs slower lidar spins).
pub(crate) fn infer_period_ns(sorted_ts: &[i64], fallback: i64) -> i64 {
    if sorted_ts.len() < 2 {
        return fallback;
    }
    let mut gaps: Vec<i64> = sorted_ts
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|&g| g > 0)
        .collect();
    if gaps.is_empty() {
        return fallback;
    }
    gaps.sort_unstable();
    gaps[gaps.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    const FALLBACK: i64 = 33_333_333;

    #[test]
    fn empty_slice_yields_zero_zero() {
        assert_eq!(range_window(&[], 0, 100, false), (0, 0));
        assert_eq!(range_window(&[], 0, 100, true), (0, 0));
    }

    #[test]
    fn single_element_inside_window() {
        let ts = [50];
        // 50 is within [0, 100): included.
        assert_eq!(range_window(&ts, 0, 100, false), (0, 1));
    }

    #[test]
    fn single_element_before_window() {
        let ts = [50];
        // window starts after the only sample; body is empty.
        assert_eq!(range_window(&ts, 60, 100, false), (1, 1));
        // include_prev pulls the preceding sample (index 0) into the slice.
        assert_eq!(range_window(&ts, 60, 100, true), (0, 1));
    }

    #[test]
    fn single_element_after_window() {
        let ts = [50];
        // window ends before the only sample; nothing selected, no prev exists.
        assert_eq!(range_window(&ts, 0, 50, false), (0, 0));
        assert_eq!(range_window(&ts, 0, 50, true), (0, 0));
    }

    #[test]
    fn start_outside_below_range() {
        let ts = [10, 20, 30, 40];
        // start_ns below the first sample: lo stays at 0.
        assert_eq!(range_window(&ts, 0, 25, false), (0, 2));
        // include_prev at index 0 cannot pull back further.
        assert_eq!(range_window(&ts, 0, 25, true), (0, 2));
    }

    #[test]
    fn end_outside_above_range() {
        let ts = [10, 20, 30, 40];
        // end_ns past the last sample: hi == len.
        assert_eq!(range_window(&ts, 20, 1000, false), (1, 4));
    }

    #[test]
    fn both_bounds_outside_select_all() {
        let ts = [10, 20, 30, 40];
        assert_eq!(range_window(&ts, -100, 1000, false), (0, 4));
        assert_eq!(range_window(&ts, -100, 1000, true), (0, 4));
    }

    #[test]
    fn half_open_boundary_semantics() {
        let ts = [10, 20, 30, 40];
        // start hits a sample exactly -> that sample is INCLUDED (>= start).
        // end hits a sample exactly -> that sample is EXCLUDED (< end).
        // [20, 30) selects index 1 only.
        assert_eq!(range_window(&ts, 20, 30, false), (1, 2));
        // [20, 40) selects indices 1, 2.
        assert_eq!(range_window(&ts, 20, 40, false), (1, 3));
        // [10, 10) is empty: start==end on the first sample boundary. Both
        // partition_points land at index 0 (no element is strictly < 10).
        assert_eq!(range_window(&ts, 10, 10, false), (0, 0));
        // [20, 20) is empty at a mid-array boundary: index 1 (one element < 20).
        assert_eq!(range_window(&ts, 20, 20, false), (1, 1));
    }

    #[test]
    fn include_prev_at_index_zero_is_noop() {
        let ts = [10, 20, 30, 40];
        // body starts at index 0, so there is no previous sample to pull.
        let no_prev = range_window(&ts, 5, 25, false);
        let with_prev = range_window(&ts, 5, 25, true);
        assert_eq!(no_prev, (0, 2));
        assert_eq!(with_prev, (0, 2));
    }

    #[test]
    fn include_prev_mid_array() {
        let ts = [10, 20, 30, 40];
        // body is [30, 40) -> index 2 only; prev pulls index 1 in.
        assert_eq!(range_window(&ts, 30, 40, false), (2, 3));
        assert_eq!(range_window(&ts, 30, 40, true), (1, 3));
    }

    #[test]
    fn include_prev_on_empty_body_yields_single_prev() {
        let ts = [10, 20, 30, 40];
        // Zero-width window between samples (no body), but prev exists.
        // [25, 25): start_idx == end_idx == 2; prev pulls index 1.
        assert_eq!(range_window(&ts, 25, 25, false), (2, 2));
        assert_eq!(range_window(&ts, 25, 25, true), (1, 2));
    }

    #[test]
    fn reversed_window_is_clamped_not_reversed() {
        let ts = [10, 20, 30, 40];
        // end_ns < start_ns must not produce hi < lo.
        let (lo, hi) = range_window(&ts, 35, 15, false);
        assert!(hi >= lo, "hi {hi} must be >= lo {lo}");
        // start_idx for 35 is 3; end clamps up to 3.
        assert_eq!((lo, hi), (3, 3));
    }

    #[test]
    fn duplicate_timestamps_grouped_consistently() {
        // Equal timestamps: half-open bounds still group them deterministically.
        let ts = [10, 20, 20, 20, 30];
        // [20, 30) includes all three 20s but not 30.
        assert_eq!(range_window(&ts, 20, 30, false), (1, 4));
        // [20, 20) is empty (exclusive upper hits the first 20).
        assert_eq!(range_window(&ts, 20, 20, false), (1, 1));
    }

    #[test]
    fn period_fewer_than_two_uses_fallback() {
        assert_eq!(infer_period_ns(&[], FALLBACK), FALLBACK);
        assert_eq!(infer_period_ns(&[42], FALLBACK), FALLBACK);
    }

    #[test]
    fn period_median_of_gaps() {
        // gaps: 10, 10, 10 -> median 10.
        assert_eq!(infer_period_ns(&[0, 10, 20, 30], FALLBACK), 10);
        // gaps: 10, 30 -> sorted [10, 30], median index 1 -> 30.
        assert_eq!(infer_period_ns(&[0, 10, 40], FALLBACK), 30);
    }

    #[test]
    fn period_ignores_nonpositive_gaps() {
        // Duplicate / out-of-order timestamps produce <=0 gaps that are filtered.
        // Gaps: (5-5)=0 dropped, (15-5)=10 kept -> median 10.
        assert_eq!(infer_period_ns(&[5, 5, 15], FALLBACK), 10);
        // All identical -> no positive gap -> fallback.
        assert_eq!(infer_period_ns(&[7, 7, 7], FALLBACK), FALLBACK);
    }
}
