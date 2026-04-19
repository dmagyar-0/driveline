//! Min-max per-bucket decimation for scalar signals.
//!
//! `McapReader` and `Mf4Reader` honour `FetchOpts.max_points` by routing
//! the sliced scalar vectors through [`min_max_decimate`] before Arrow
//! serialisation. The output row count is bounded by `max_points`, which
//! lets PlotPanel meet the 16 ms redraw budget from
//! `docs/09-verification-plan.md:146` even on 1 M-sample windows.

/// Reduce `(ts, vals)` to at most `max_points` rows by picking the
/// minimum-value and maximum-value samples from each index-based bucket
/// and emitting them in chronological order within the bucket.
///
/// Guarantees:
///
/// * If `max_points == 0` or `max_points as usize >= ts.len()`, the
///   input is returned verbatim — decimation never makes the output
///   longer than the input.
/// * Output length is `<= max_points`.
/// * Sample identity is preserved: every returned `(ts, val)` pair
///   matches an input pair. No interpolation, no synthesised
///   timestamps. This keeps min-max decimation safe to use as the
///   server-side reduction for a step-hold line renderer.
/// * NaN-tolerant: the first finite sample in a bucket seeds the
///   extrema search; if every sample in a bucket is NaN, one NaN row
///   is emitted at the bucket's start so gaps remain visible.
///
/// Bucketing is index-based (`start = b * n / bucket_count`), which is
/// both cheap and appropriate for PlotPanel's uniformly-sampled signals.
/// Callers that need non-uniform decimation must do their own slicing
/// first.
///
/// The caller is responsible for any `include_prev` leading sample: the
/// prev sample must be prepended *after* this function returns so the
/// first bucket cannot silently absorb it.
pub(crate) fn min_max_decimate(
    ts: &[i64],
    vals: &[f64],
    max_points: u32,
) -> (Vec<i64>, Vec<f64>) {
    debug_assert_eq!(
        ts.len(),
        vals.len(),
        "min_max_decimate: parallel arrays must have equal length",
    );

    let n = ts.len();
    let m = max_points as usize;
    if n == 0 || m == 0 || m >= n {
        return (ts.to_vec(), vals.to_vec());
    }

    // Each bucket contributes at most two rows (min, max) so the output
    // row count is <= 2 * bucket_count <= max_points.
    let bucket_count = (m / 2).max(1);
    if bucket_count >= n {
        return (ts.to_vec(), vals.to_vec());
    }

    let mut out_ts = Vec::with_capacity(2 * bucket_count);
    let mut out_vals = Vec::with_capacity(2 * bucket_count);

    for b in 0..bucket_count {
        let start = b * n / bucket_count;
        let end = ((b + 1) * n / bucket_count).min(n);
        if start >= end {
            continue;
        }

        let mut min_i = start;
        let mut max_i = start;
        let mut seen_finite = false;
        for i in start..end {
            if !vals[i].is_finite() {
                continue;
            }
            if !seen_finite {
                min_i = i;
                max_i = i;
                seen_finite = true;
            } else {
                if vals[i] < vals[min_i] {
                    min_i = i;
                }
                if vals[i] > vals[max_i] {
                    max_i = i;
                }
            }
        }

        if !seen_finite {
            out_ts.push(ts[start]);
            out_vals.push(vals[start]);
            continue;
        }

        if min_i == max_i {
            out_ts.push(ts[min_i]);
            out_vals.push(vals[min_i]);
        } else if min_i < max_i {
            out_ts.push(ts[min_i]);
            out_vals.push(vals[min_i]);
            out_ts.push(ts[max_i]);
            out_vals.push(vals[max_i]);
        } else {
            out_ts.push(ts[max_i]);
            out_vals.push(vals[max_i]);
            out_ts.push(ts[min_i]);
            out_vals.push(vals[min_i]);
        }
    }

    (out_ts, out_vals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_when_n_le_max_points() {
        let ts = vec![1, 2, 3, 4];
        let vs = vec![10.0, 20.0, 15.0, 5.0];
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 10);
        assert_eq!(out_ts, ts);
        assert_eq!(out_vs, vs);
    }

    #[test]
    fn passthrough_when_max_points_is_zero() {
        let ts = vec![1, 2, 3];
        let vs = vec![1.0, 2.0, 3.0];
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 0);
        assert_eq!(out_ts, ts);
        assert_eq!(out_vs, vs);
    }

    #[test]
    fn empty_input_emits_empty_output() {
        let (out_ts, out_vs) = min_max_decimate(&[], &[], 100);
        assert!(out_ts.is_empty());
        assert!(out_vs.is_empty());
    }

    #[test]
    fn min_before_max_order_preserved() {
        // Single bucket, samples increase monotonically. Min is at t=0,
        // max is at t=4. Output must be [(0, 0.0), (4, 4.0)].
        let ts: Vec<i64> = (0..5).collect();
        let vs: Vec<f64> = ts.iter().map(|&x| x as f64).collect();
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 2);
        assert_eq!(out_ts, vec![0, 4]);
        assert_eq!(out_vs, vec![0.0, 4.0]);
    }

    #[test]
    fn max_before_min_order_preserved() {
        // Single bucket, samples decrease. Max is at t=0, min is at t=4.
        let ts: Vec<i64> = (0..5).collect();
        let vs: Vec<f64> = ts.iter().map(|&x| 4.0 - x as f64).collect();
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 2);
        assert_eq!(out_ts, vec![0, 4]);
        assert_eq!(out_vs, vec![4.0, 0.0]);
    }

    #[test]
    fn constant_bucket_emits_single_row() {
        let ts = vec![10, 20, 30, 40];
        let vs = vec![1.5; 4];
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 2);
        assert_eq!(out_ts.len(), 1);
        assert_eq!(out_ts[0], 10);
        assert_eq!(out_vs[0], 1.5);
    }

    #[test]
    fn partial_nan_bucket_picks_finite_extrema() {
        let ts = vec![0, 1, 2, 3, 4];
        let vs = vec![f64::NAN, 3.0, f64::NAN, 1.0, 2.0];
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 2);
        // Min is 1.0 at t=3; max is 3.0 at t=1; max precedes min.
        assert_eq!(out_ts, vec![1, 3]);
        assert_eq!(out_vs, vec![3.0, 1.0]);
    }

    #[test]
    fn all_nan_bucket_emits_single_nan_at_bucket_start() {
        let ts = vec![10, 20, 30];
        let vs = vec![f64::NAN, f64::NAN, f64::NAN];
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 2);
        assert_eq!(out_ts, vec![10]);
        assert_eq!(out_vs.len(), 1);
        assert!(out_vs[0].is_nan());
    }

    #[test]
    fn bucket_count_never_exceeds_max_points() {
        // Every bucket should emit at most two rows. 1000 → 100 should
        // produce <= 100 rows; empirically exactly 100 for a triangle.
        let ts: Vec<i64> = (0..1000).collect();
        let vs: Vec<f64> = ts
            .iter()
            .map(|&x| ((x % 20) as f64 - 10.0).abs())
            .collect();
        let (out_ts, out_vs) = min_max_decimate(&ts, &vs, 100);
        assert!(out_ts.len() <= 100, "got {} rows", out_ts.len());
        assert_eq!(out_ts.len(), out_vs.len());
        // Each output timestamp must be from the input.
        for t in &out_ts {
            assert!(ts.contains(t));
        }
    }

    #[test]
    fn output_timestamps_are_strictly_non_decreasing() {
        let ts: Vec<i64> = (0..500).collect();
        let vs: Vec<f64> = ts.iter().map(|&x| (x as f64).sin()).collect();
        let (out_ts, _) = min_max_decimate(&ts, &vs, 50);
        for w in out_ts.windows(2) {
            assert!(w[0] <= w[1], "timestamps out of order: {:?}", w);
        }
    }

    #[test]
    fn odd_max_points_still_produces_valid_output() {
        // max_points = 5 → bucket_count = max(1, 5 / 2) = 2; each bucket
        // contributes <= 2 rows → output length <= 4.
        let ts: Vec<i64> = (0..100).collect();
        let vs: Vec<f64> = ts.iter().map(|&x| x as f64).collect();
        let (out_ts, _) = min_max_decimate(&ts, &vs, 5);
        assert!(out_ts.len() <= 4);
        assert!(out_ts.len() >= 2);
    }
}
