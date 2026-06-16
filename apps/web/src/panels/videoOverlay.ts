// Pure helpers for the point-cloud-on-video overlay (docs/13). Kept out of
// `VideoPanel.tsx` so the letterbox math and the depth->colour ramp are unit
// testable without a DOM/canvas.

// The rectangle (in CSS pixels, relative to the panel's top-left) that the
// video frame actually occupies once `object-fit: contain` has letterboxed it
// inside the panel. The overlay canvas is sized/positioned to this rect so a
// projected camera pixel maps linearly into it.
export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Compute the letterboxed content rect for a frame of intrinsic size
 * `frameW x frameH` displayed in a `clientW x clientH` panel with
 * `object-fit: contain` (the VideoPanel canvas CSS). The frame is scaled by the
 * smaller of the two axis ratios and centred; the leftover is the letterbox.
 * Returns a zero rect for degenerate inputs.
 */
export function contentRect(
  frameW: number,
  frameH: number,
  clientW: number,
  clientH: number,
): ContentRect {
  if (frameW <= 0 || frameH <= 0 || clientW <= 0 || clientH <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(clientW / frameW, clientH / frameH);
  const width = frameW * scale;
  const height = frameH * scale;
  return {
    left: (clientW - width) / 2,
    top: (clientH - height) / 2,
    width,
    height,
  };
}

/**
 * Map a camera-image pixel `(u, v)` — in the source frame's intrinsic
 * resolution `frameW x frameH` — into the content rect's local pixel space
 * (origin at the content-rect top-left). Used to place a projected point on the
 * overlay canvas, whose own coordinate space is exactly the content rect.
 */
export function imagePixelToContent(
  u: number,
  v: number,
  frameW: number,
  frameH: number,
  rect: ContentRect,
): [number, number] {
  return [(u / frameW) * rect.width, (v / frameH) * rect.height];
}

/**
 * Depth -> RGB ramp for the overlay dots: near = warm (red/orange), far = cool
 * (blue), clamped to `[nearM, farM]`. A simple three-stop ramp (warm -> green
 * -> cool) reads well over arbitrary video.
 */
function depthRgb(
  depth: number,
  nearM: number,
  farM: number,
): [number, number, number] {
  const span = farM - nearM;
  const t = span > 0 ? Math.min(1, Math.max(0, (depth - nearM) / span)) : 0;
  // Hue from 0deg (red, near) through 120deg (green) to 240deg (blue, far).
  const hue = t * 240;
  return hslToRgb(hue / 360, 0.9, 0.5);
}

/**
 * Depth -> CSS `rgb(...)` string for a single dot. Kept for callers/tests that
 * want one colour; the per-frame overlay draw uses a precomputed `DepthPalette`
 * instead so it never builds a colour string per point.
 */
export function depthColor(depth: number, nearM: number, farM: number): string {
  const [r, g, b] = depthRgb(depth, nearM, farM);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Per-dot alpha as a function of normalised depth `t` (0 = near, 1 = far). Near
 * structure stays solid; far returns fade so the dense far scan-rings recede
 * instead of smearing into horizontal streaks when the frame is viewed small
 * (near->far alpha 0.98->0.48).
 */
export function depthAlpha(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 0.98 - 0.5 * c;
}

/**
 * A depth -> colour lookup precomputed once per `[near, far]` range. Each bucket
 * is a ready-to-use `rgba(...)` string with the depth-fade alpha baked in, so
 * the per-frame overlay draw can bucket points by depth and emit a single fill
 * per bucket — no `rgb(...)` string allocation or `fillStyle` churn per point.
 */
export interface DepthPalette {
  near: number;
  far: number;
  /** Number of colour buckets (>= 2). */
  buckets: number;
  /** `rgba(...)` strings, one per bucket, alpha baked in. */
  colors: string[];
}

/**
 * Build a `DepthPalette` of `buckets` evenly-spaced `rgba(...)` strings across
 * `[near, far]`. 64 buckets keep the gradient visually smooth while collapsing
 * a per-point colour computation into a tiny lookup.
 */
export function buildDepthPalette(
  near: number,
  far: number,
  buckets = 64,
): DepthPalette {
  const n = Math.max(2, buckets | 0);
  const colors = new Array<string>(n);
  for (let b = 0; b < n; b++) {
    const t = b / (n - 1);
    const depth = near + t * (far - near);
    const [r, g, bl] = depthRgb(depth, near, far);
    colors[b] = `rgba(${r}, ${g}, ${bl}, ${depthAlpha(t).toFixed(3)})`;
  }
  return { near, far, buckets: n, colors };
}

/** Bucket index (0 .. `palette.buckets - 1`) for a raw depth value. */
export function depthBucketIndex(depth: number, palette: DepthPalette): number {
  const span = palette.far - palette.near;
  const t = span > 0 ? (depth - palette.near) / span : 0;
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  const idx = Math.round(c * (palette.buckets - 1));
  return idx < 0 ? 0 : idx > palette.buckets - 1 ? palette.buckets - 1 : idx;
}

// Minimal HSL->RGB (0..1 inputs, 0..255 integer outputs). Inlined so the
// overlay has no colour-library dependency.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToChannel(p, q, h + 1 / 3);
  const g = hueToChannel(p, q, h);
  const b = hueToChannel(p, q, h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hueToChannel(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}
