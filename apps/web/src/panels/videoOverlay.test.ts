import { describe, expect, it } from "vitest";
import { contentRect, depthColor, imagePixelToContent } from "./videoOverlay";

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
