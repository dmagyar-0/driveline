import { describe, expect, it } from "vitest";
import {
  buildDepthPalette,
  contentRect,
  depthAlpha,
  depthBucketIndex,
  depthColor,
  imagePixelToContent,
} from "./videoOverlay";

describe("contentRect (object-fit: contain letterbox)", () => {
  it("pillarboxes a 16:9 frame in a square panel", () => {
    // 1280x720 in 720x720: scale by height (720/720=1 vs 720/1280<1) -> use
    // the smaller ratio (width-limited): scale = 720/1280 = 0.5625.
    const r = contentRect(1280, 720, 720, 720);
    expect(r.width).toBeCloseTo(720, 5);
    expect(r.height).toBeCloseTo(405, 5);
    expect(r.left).toBeCloseTo(0, 5);
    expect(r.top).toBeCloseTo((720 - 405) / 2, 5);
  });

  it("matches the panel exactly when aspect ratios agree", () => {
    const r = contentRect(1280, 720, 640, 360);
    expect(r.left).toBeCloseTo(0, 5);
    expect(r.top).toBeCloseTo(0, 5);
    expect(r.width).toBeCloseTo(640, 5);
    expect(r.height).toBeCloseTo(360, 5);
  });

  it("returns a zero rect for degenerate inputs", () => {
    expect(contentRect(0, 720, 100, 100)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("imagePixelToContent", () => {
  it("maps frame pixels into the content rect linearly", () => {
    const rect = { left: 0, top: 10, width: 640, height: 360 };
    // Centre of a 1280x720 frame -> centre of the content rect.
    const [x, y] = imagePixelToContent(640, 360, 1280, 720, rect);
    expect(x).toBeCloseTo(320, 5);
    expect(y).toBeCloseTo(180, 5);
  });
});

describe("depthColor", () => {
  it("is warm near and cool far", () => {
    const near = depthColor(0, 0, 100);
    const far = depthColor(100, 0, 100);
    // Near should be red-dominant; far should be blue-dominant.
    const nearRgb = near.match(/\d+/g)!.map(Number);
    const farRgb = far.match(/\d+/g)!.map(Number);
    expect(nearRgb[0]).toBeGreaterThan(nearRgb[2]); // R > B near
    expect(farRgb[2]).toBeGreaterThan(farRgb[0]); // B > R far
  });

  it("clamps out-of-range depths", () => {
    expect(depthColor(-5, 0, 100)).toBe(depthColor(0, 0, 100));
    expect(depthColor(500, 0, 100)).toBe(depthColor(100, 0, 100));
  });
});

describe("depthAlpha", () => {
  it("fades from near (solid) to far (translucent)", () => {
    expect(depthAlpha(0)).toBeCloseTo(0.98, 5);
    expect(depthAlpha(1)).toBeCloseTo(0.48, 5);
    expect(depthAlpha(0.5)).toBeCloseTo(0.73, 5);
  });

  it("clamps t outside [0, 1]", () => {
    expect(depthAlpha(-1)).toBe(depthAlpha(0));
    expect(depthAlpha(2)).toBe(depthAlpha(1));
  });
});

describe("buildDepthPalette / depthBucketIndex", () => {
  it("emits one rgba string per bucket with alpha baked in", () => {
    const p = buildDepthPalette(0, 100, 8);
    expect(p.buckets).toBe(8);
    expect(p.colors).toHaveLength(8);
    for (const c of p.colors) {
      expect(c).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/);
    }
    // Near bucket is warm + near-solid; far bucket is cool + faded.
    const near = p.colors[0].match(/[\d.]+/g)!.map(Number);
    const far = p.colors[7].match(/[\d.]+/g)!.map(Number);
    expect(near[0]).toBeGreaterThan(near[2]); // R > B near
    expect(far[2]).toBeGreaterThan(far[0]); // B > R far
    expect(near[3]).toBeGreaterThan(far[3]); // near more opaque than far
  });

  it("never returns fewer than two buckets", () => {
    expect(buildDepthPalette(0, 1, 1).buckets).toBe(2);
    expect(buildDepthPalette(0, 1, 0).buckets).toBe(2);
  });

  it("maps depths to in-range bucket indices, clamping the extremes", () => {
    const p = buildDepthPalette(10, 110, 64);
    expect(depthBucketIndex(10, p)).toBe(0);
    expect(depthBucketIndex(110, p)).toBe(63);
    expect(depthBucketIndex(-100, p)).toBe(0); // below near -> first bucket
    expect(depthBucketIndex(1000, p)).toBe(63); // above far -> last bucket
    const mid = depthBucketIndex(60, p);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(63);
  });

  it("is monotonic in depth", () => {
    const p = buildDepthPalette(0, 100, 32);
    let prev = -1;
    for (let d = 0; d <= 100; d += 5) {
      const b = depthBucketIndex(d, p);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it("collapses a degenerate range to the first bucket", () => {
    const p = buildDepthPalette(50, 50, 16);
    expect(depthBucketIndex(50, p)).toBe(0);
    expect(depthBucketIndex(999, p)).toBe(0);
  });
});
