#!/usr/bin/env python3
"""Detect on-screen BACK-AND-FORTH (frame-order regressions) in a video.

The cadence scorer (`score-cadence.mjs`) measures *timing* — how long each
frame dwells. It cannot see a frame ORDER fault: `backwardSteps` in the worker's
CadenceSummary is computed AFTER the blit's own monotonic guard, so it is 0 by
construction and proves nothing about what actually reached the screen. A
recorded clip (or the live compositor) can still visibly jump back-and-forth —
frames presented out of order, an overlay flickering between sweeps, or a screen
recording reverting in high-motion regions.

This scores that directly and model-free: for each DISTINCT displayed frame, find
the EARLIER frame it most resembles. Smooth forward playback → that is always the
immediately-previous frame. Back-and-forth → frame N resembles a frame several
steps back (the content returned to where it was).

  python3 score-frame-order.py CLIP.webm
  python3 score-frame-order.py CLIP.webm --crop 780:300:20:230 --ss 4 --t 6
  python3 score-frame-order.py CLIP.webm --control SOURCE.mp4   # validate the test

ALWAYS pair a real run with `--control SOURCE.mp4` (a clip you KNOW is forward-
only, e.g. the raw source the playback was built from). The control must score
~0%; if it doesn't, your crop/scale is too aggressive and the number is noise.

Exit: 0 forward-ordered, 1 back-and-forth detected, 2 could-not-measure.

Localising the cause (run it on sub-regions):
  • a region with NO overlay (sky/buildings) that scores ~0% while the
    overlay/road region scores high ⇒ the VIDEO is monotonic and the fault is
    the OVERLAY (drawn separately on top), not the decoder.
  • if it only shows up in the VP8 recording but the live compositor (Playwright
    `page.screenshot`, which bypasses the video encoder) is clean ⇒ it is a
    SCREEN-RECORDING artifact, not the app.
"""
import argparse
import subprocess
import sys

import numpy as np

# Back-and-forth budget: fraction of distinct frames that may resemble an older
# frame more than their immediate predecessor before we call it out-of-order.
# A clean forward clip scores ~0%; the headless nuScenes recording with a
# jittering LiDAR overlay scored ~25-41%.
THRESHOLD = 0.05
# A frame counts as "resembling an older frame" only if that older frame is a
# clear winner (this much closer than the immediate predecessor) — guards against
# near-ties on slow-moving content.
CLEAR_MARGIN = 0.85
# Two consecutive extracted frames closer than this (mean abs diff, 0-255) are
# the same displayed frame captured twice (recording fps > video fps) — merged.
DEDUP_MAD = 1.5


def extract_gray(path, crop, ss, t, w, h):
    """Decode VIDEO to a stack of (h,w) grayscale float32 frames via ffmpeg."""
    vf = []
    if crop:
        vf.append(f"crop={crop}")
    vf.append(f"scale={w}:{h}")
    vf.append("format=gray")
    cmd = ["ffmpeg", "-v", "error"]
    if ss is not None:
        cmd += ["-ss", str(ss)]
    if t is not None:
        cmd += ["-t", str(t)]
    cmd += ["-i", path, "-vf", ",".join(vf),
            "-vsync", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // (w * h)
    if n == 0:
        return None
    return np.frombuffer(raw[: n * w * h], dtype=np.uint8).astype(np.float32).reshape(n, h, w)


def score(frames):
    """Return (distinct_count, backforth_count, backforth_fraction)."""
    distinct = []
    for f in frames:
        if not distinct or np.abs(f - distinct[-1]).mean() > DEDUP_MAD:
            distinct.append(f)
    a = np.stack(distinct)
    n = len(a)
    if n < 4:
        return n, 0, 0.0
    revs = 0
    for i in range(2, n):
        d_prev = np.abs(a[i] - a[i - 1]).mean()
        dists = np.abs(a[:i] - a[i]).reshape(i, -1).mean(axis=1)
        j = int(np.argmin(dists))
        if j < i - 1 and dists[j] < CLEAR_MARGIN * d_prev:
            revs += 1
    return n, revs, revs / (n - 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--control", help="a known forward-only clip to validate the test")
    ap.add_argument("--crop", help="ffmpeg crop=W:H:X:Y to focus a region")
    ap.add_argument("--ss", type=float, help="start seconds")
    ap.add_argument("--t", type=float, help="duration seconds")
    ap.add_argument("--w", type=int, default=120, help="downscale width")
    ap.add_argument("--h", type=int, default=68, help="downscale height")
    args = ap.parse_args()

    frames = extract_gray(args.video, args.crop, args.ss, args.t, args.w, args.h)
    if frames is None:
        print("VERDICT: COULD NOT MEASURE (no frames extracted)")
        sys.exit(2)
    n, revs, frac = score(frames)

    ctrl_line = ""
    if args.control:
        cf = extract_gray(args.control, args.crop, args.ss, args.t, args.w, args.h)
        if cf is not None:
            cn, cr, cfrac = score(cf)
            ctrl_line = (f"  control  : {cn} distinct, {cr} back-and-forth "
                         f"({cfrac*100:.0f}%)  {'OK (test is valid)' if cfrac <= THRESHOLD else 'WARNING: control itself flags — crop/scale too lossy, number is noise'}")

    print(f"Frame-order over {n} distinct displayed frames")
    print(f"  back-and-forth: {revs} frames resemble an OLDER frame more than the previous one "
          f"= {frac*100:.0f}%  (budget <= {THRESHOLD*100:.0f}%)")
    if ctrl_line:
        print(ctrl_line)
    smooth = frac <= THRESHOLD
    print("=" * 56)
    print(f"VERDICT: {'FORWARD-ORDERED' if smooth else 'BACK-AND-FORTH DETECTED'}")
    print("=" * 56)
    sys.exit(0 if smooth else 1)


if __name__ == "__main__":
    main()
