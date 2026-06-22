// LiDAR point-cloud-on-video overlay sub-system (PANEL-03, docs/13).
//
// Lifted out of VideoPanel.tsx so the panel's responsibility stays the video
// blit + transport wiring, and this overlay's projection/cache/draw machinery
// lives in one cohesive module. Behaviour is IDENTICAL to the inline version:
//   - the per-tick `draw()` runs the exact same dirty-check + clear + bucketed
//     Path2D fill the panel's rAF tick used (same `OVERLAY_DRAW*` perf marks);
//   - the async spin fetch+project is still coalesced to ≤1 outstanding
//     refresh via a busy flag + monotonic request token;
//   - all hot-path inputs stay in refs, so the tick never reads a reactive
//     selector and allocates nothing new per frame beyond what it did before.
//
// The controller owns every overlay-specific ref the panel previously held at
// component scope. The panel keeps the `<canvas>` element ref (it attaches it
// in JSX and locks its CSS zoom/pan transform to the video) and hands it in
// here; everything else is internal to the controller.

import {
  makeProjectionBuffers,
  projectPointsInto,
  type ProjectionBuffers,
} from "./cameraProjection";
import { fetchDecodedSpin } from "./pointCloudSpinCache";
import {
  buildDepthPalette,
  contentRect,
  depthBucketIndex,
  type DepthPalette,
} from "./videoOverlay";
import { setVideoOverlayInfo } from "./videoOverlayDevState";
import type { CameraCalibration } from "./calibrationFromArrow";
import type { PointCloudOverlayBinding } from "../layout/persist";
import {
  mark,
  measure,
  OVERLAY_DRAW,
  OVERLAY_DRAW_END,
  OVERLAY_DRAW_START,
} from "../perf";

export interface LidarOverlay {
  /** Per-tick overlay paint. `blitPtsNs` is the PTS of the frame the worker
   *  last blitted (drives the active spin pick); `null` means no frame on
   *  canvas. Sizes the overlay canvas to its CSS box, kicks a coalesced async
   *  refresh when the active spin index changes, and (only when the painted
   *  pixels would differ) clears + redraws the cached projection. */
  draw(blitPtsNs: bigint | null): void;
  /** Binding effect inputs (run once per binding change, off the hot path). */
  setBinding(binding: PointCloudOverlayBinding | null): void;
  setCalibration(calib: CameraCalibration | null): void;
  setSpinTimes(times: BigInt64Array | null): void;
  /** The binding currently set on the controller — the binding effect uses
   *  this for its async-staleness check (a late `loadCalibration` /
   *  `lidarSpinTimes` resolve must no-op if the binding changed underneath). */
  currentBinding(): PointCloudOverlayBinding | null;
  /** Reset cached projection/index state (binding changed). Does NOT clear the
   *  canvas pixels — the panel clears those directly in its binding effect. */
  resetProjection(): void;
}

/**
 * Create the LiDAR overlay controller for a video panel. `overlayCanvasRef`
 * is the panel-owned `<canvas>` (shared so the panel can lock its zoom/pan
 * transform to the video); `panelId` keys the dev-state mirror.
 */
export function createLidarOverlay(
  overlayCanvasRef: { current: HTMLCanvasElement | null },
  panelId: string,
): LidarOverlay {
  // The currently-bound overlay inputs, mirrored into refs so the per-tick
  // draw never reads a reactive selector.
  const bindingRef: { current: PointCloudOverlayBinding | null } = {
    current: null,
  };
  const calibRef: { current: CameraCalibration | null } = { current: null };
  // Spin start timestamps for the bound point-cloud channel.
  const spinTimesRef: { current: BigInt64Array | null } = { current: null };
  // The spin index currently projected + its cached projection, so we only
  // recompute when the active spin index OR the calibration changes.
  const spinIdxRef = { current: -1 };
  const projRef: { current: ProjectionBuffers | null } = { current: null };
  const projCountRef = { current: 0 };
  const depthsRef = { current: { near: 1, far: 60 } };
  // Bumped whenever the cached projection changes (new spin landed, or it
  // emptied). The per-tick overlay draw compares this against the last paint to
  // skip a redundant clear+redraw when nothing visible changed.
  const genRef = { current: 0 };
  // The (gen, canvas size, depth range) actually last painted onto the overlay.
  // A sentinel `gen: -1` means the overlay canvas currently holds nothing.
  const drawnRef = {
    current: { gen: -1, w: -1, h: -1, near: NaN, far: NaN },
  };
  // Cached depth->colour palette (rebuilt only when the depth range changes)
  // and the per-bucket Path2D scratch reused across redraws.
  const paletteRef: { current: DepthPalette | null } = { current: null };
  const bucketPathsRef: { current: Path2D[] | null } = { current: null };
  // True while an async spin fetch+project is inflight, so the tick coalesces
  // to ≤1 outstanding overlay refresh (never stacks fetches per rAF).
  const busyRef = { current: false };
  // Monotonic token so a late spin fetch result for a stale binding is dropped.
  const reqRef = { current: 0 };

  // Largest spin index with `times[i] <= ptsNs`, or -1 if before the first
  // spin. `times` is ascending. Same binary search the ScenePanel uses.
  const activeSpinIndex = (times: BigInt64Array, ptsNs: bigint): number => {
    if (times.length === 0 || ptsNs < times[0]) return -1;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= ptsNs) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // Fetch + decode + project the spin at `idx` into the cached projection
  // buffers. Coalesced: at most one outstanding refresh; a stale binding's
  // late result is dropped via the request token. Off the synchronous tick.
  const refreshOverlaySpin = (idx: number) => {
    const binding = bindingRef.current;
    const calib = calibRef.current;
    const times = spinTimesRef.current;
    if (!binding || !calib || !times || idx < 0 || idx >= times.length) {
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    const token = ++reqRef.current;
    const ts = times[idx];
    void (async () => {
      try {
        // Shared with the 3D scene panel: the spin is decoded once per
        // (channel, ts) and both viewers read the same buffers.
        const res = await fetchDecodedSpin(binding.pointcloudChannelId, ts);
        if (token !== reqRef.current) return;
        if (!res.ok || res.count === 0) {
          projCountRef.current = 0;
          spinIdxRef.current = idx;
          genRef.current += 1;
          return;
        }
        // Grow the reusable projection buffers when the spin gets denser.
        let buf = projRef.current;
        if (!buf || buf.us.length < res.count) {
          buf = makeProjectionBuffers(res.count);
          projRef.current = buf;
        }
        const visible = projectPointsInto(calib, res.positions, res.count, buf);
        projCountRef.current = res.count;
        spinIdxRef.current = idx;
        genRef.current += 1;
        setVideoOverlayInfo(panelId, {
          enabled: true,
          cameraName: binding.cameraName,
          spinTsNs: (res.tsNs ?? ts).toString(),
          pointCount: res.count,
          projectedVisibleCount: visible,
        });
      } catch {
        /* advisory overlay; leave the previous projection on screen */
      } finally {
        if (token === reqRef.current) busyRef.current = false;
      }
    })();
  };

  const draw = (blitPtsNs: bigint | null) => {
    const overlayCanvas = overlayCanvasRef.current;
    const overlayCtx = overlayCanvas?.getContext("2d") ?? null;
    if (!overlayCanvas || !overlayCtx) return;
    const binding = bindingRef.current;
    const calib = calibRef.current;
    const times = spinTimesRef.current;
    const blitPts = blitPtsNs;
    const drawn = drawnRef.current;
    // Match the overlay canvas's pixel buffer to its CSS box (the panel) so
    // its coordinate space is panel pixels. Setting width/height clears the
    // canvas, so only touch it on an actual size change.
    const cw = overlayCanvas.clientWidth;
    const ch = overlayCanvas.clientHeight;
    if (cw > 0 && ch > 0) {
      if (overlayCanvas.width !== cw) overlayCanvas.width = cw;
      if (overlayCanvas.height !== ch) overlayCanvas.height = ch;
    }

    if (!binding || !calib || !times || blitPts === null) {
      // Nothing to project. Clear once on the transition into this state so a
      // stale cloud doesn't linger; then stay idle (no per-tick clears).
      if (drawn.gen !== -1) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        drawn.gen = -1;
      }
      return;
    }
    // Refetch only when the active spin actually changes.
    const idx = activeSpinIndex(times, blitPts);
    if (idx !== spinIdxRef.current && idx >= 0) {
      refreshOverlaySpin(idx);
    }
    const { near, far } = depthsRef.current;

    // The overlay canvas is a separate layer stacked over the video, and
    // zoom/pan is a CSS transform on the element — not a pixel redraw. So the
    // painted pixels are a pure function of the projected spin
    // (`genRef`), the canvas size, and the depth range. When none of
    // those changed since the last paint, the cached pixels are still correct
    // and we skip the (expensive) clear + per-point redraw entirely. This
    // collapses a ~60 Hz redraw into a ~spin-rate one, freeing the main
    // thread for the video blit and keeping playback smooth under load.
    const gen = genRef.current;
    if (
      drawn.gen === gen &&
      drawn.w === overlayCanvas.width &&
      drawn.h === overlayCanvas.height &&
      drawn.near === near &&
      drawn.far === far
    ) {
      return;
    }
    drawn.gen = gen;
    drawn.w = overlayCanvas.width;
    drawn.h = overlayCanvas.height;
    drawn.near = near;
    drawn.far = far;

    mark(OVERLAY_DRAW_START);
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const buf = projRef.current;
    const count = projCountRef.current;
    if (buf && count > 0) {
      // Rebuild the colour palette only when the depth range changes.
      let palette = paletteRef.current;
      if (!palette || palette.near !== near || palette.far !== far) {
        palette = buildDepthPalette(near, far);
        paletteRef.current = palette;
      }
      const rect = contentRect(
        calib.intrinsics.width,
        calib.intrinsics.height,
        overlayCanvas.width,
        overlayCanvas.height,
      );
      const radius = Math.max(1, rect.width / 760);
      const fw = calib.intrinsics.width;
      const fh = calib.intrinsics.height;
      const sx = rect.width / fw;
      const sy = rect.height / fh;
      // One Path2D per depth bucket: accumulate every dot, then emit a single
      // fill per bucket. Turns a fillStyle assignment + beginPath + arc +
      // fill *per point* into ~`buckets` fills total — the dominant overlay
      // cost when a dense spin lands. Path2D has no clear, so re-allocate.
      let paths = bucketPathsRef.current;
      if (!paths || paths.length !== palette.buckets) {
        paths = Array.from({ length: palette.buckets }, () => new Path2D());
      } else {
        for (let b = 0; b < paths.length; b++) paths[b] = new Path2D();
      }
      bucketPathsRef.current = paths;
      const TWO_PI = Math.PI * 2;
      for (let i = 0; i < count; i++) {
        if (buf.visible[i] === 0) continue;
        const px = rect.left + buf.us[i] * sx;
        const py = rect.top + buf.vs[i] * sy;
        const path = paths[depthBucketIndex(buf.depths[i], palette)];
        // `moveTo` before `arc` starts a fresh subpath so the dots don't get
        // chained together by an implicit line from the previous arc's end.
        path.moveTo(px + radius, py);
        path.arc(px, py, radius, 0, TWO_PI);
      }
      for (let b = 0; b < paths.length; b++) {
        overlayCtx.fillStyle = palette.colors[b];
        overlayCtx.fill(paths[b]);
      }
    }
    mark(OVERLAY_DRAW_END);
    measure(OVERLAY_DRAW, OVERLAY_DRAW_START, OVERLAY_DRAW_END);
  };

  return {
    draw,
    setBinding(binding) {
      bindingRef.current = binding;
    },
    setCalibration(calib) {
      calibRef.current = calib;
    },
    setSpinTimes(times) {
      spinTimesRef.current = times;
    },
    currentBinding() {
      return bindingRef.current;
    },
    resetProjection() {
      calibRef.current = null;
      spinTimesRef.current = null;
      spinIdxRef.current = -1;
      projCountRef.current = 0;
    },
  };
}
