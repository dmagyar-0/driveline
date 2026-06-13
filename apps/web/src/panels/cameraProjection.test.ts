import { describe, expect, it } from "vitest";
import {
  makeProjectionBuffers,
  projectPoint,
  projectPointsInto,
} from "./cameraProjection";
import type { CameraCalibration } from "./calibrationFromArrow";

// The synthetic-fixture oracle camera from the task contract: a forward-looking
// pinhole at fx=fy=900, principal point (640,360), 1280x720, with a
// scene -> camera-optical extrinsic of translation [0,1.5,0] and scalar-last
// quaternion [0.5,-0.5,0.5,0.5]. The five (scene -> pixel) rows below are the
// ground-truth projections of known scene markers (computed independently).
const ORACLE: CameraCalibration = {
  name: "CAM_FRONT",
  intrinsics: { fx: 900, fy: 900, cx: 640, cy: 360, width: 1280, height: 720 },
  distortion: [],
  translation: [0, 1.5, 0],
  quaternion: [0.5, -0.5, 0.5, 0.5],
};

interface OracleRow {
  scene: [number, number, number];
  u: number;
  v: number;
  depth: number;
}
const ROWS: OracleRow[] = [
  { scene: [5, 0, 3], u: 640, v: 90, depth: 5 },
  { scene: [10, 4, 3], u: 280, v: 225, depth: 10 },
  { scene: [10, -4, 3], u: 1000, v: 225, depth: 10 },
  { scene: [18, 8, 3], u: 240, v: 285, depth: 18 },
  { scene: [30, 3, 3], u: 550, v: 315, depth: 30 },
];

describe("projectPoint (synthetic fixture oracle)", () => {
  for (const row of ROWS) {
    it(`scene ${JSON.stringify(row.scene)} -> pixel (${row.u}, ${row.v}) depth ${row.depth}`, () => {
      const p = projectPoint(ORACLE, row.scene);
      expect(p.visible).toBe(true);
      expect(p.u).toBeCloseTo(row.u, 4);
      expect(p.v).toBeCloseTo(row.v, 4);
      expect(p.depth).toBeCloseTo(row.depth, 4);
    });
  }

  it("marks a behind-camera point not visible (Z <= 0)", () => {
    // A point directly behind the ego (scene -x) lands behind the lens.
    const p = projectPoint(ORACLE, [-5, 0, 3]);
    expect(p.visible).toBe(false);
    expect(p.depth).toBeLessThanOrEqual(0);
  });

  it("marks an in-front but off-image point not visible", () => {
    // Far to the left in the scene -> projects well outside the image width.
    const p = projectPoint(ORACLE, [3, 50, 3]);
    expect(p.depth).toBeGreaterThan(0);
    expect(p.visible).toBe(false);
  });

  it("applies Brown-Conrady distortion when present", () => {
    // A non-zero k1 must shift an off-axis pixel relative to the pinhole-only
    // projection; an on-axis point (u=cx,v=cy) is unaffected by radial terms.
    const withDist: CameraCalibration = {
      ...ORACLE,
      distortion: [0.1, 0, 0, 0, 0],
    };
    const offAxis: [number, number, number] = [10, 4, 3];
    const plain = projectPoint(ORACLE, offAxis);
    const dist = projectPoint(withDist, offAxis);
    expect(dist.u).not.toBeCloseTo(plain.u, 2);
  });
});

describe("projectPointsInto (batch)", () => {
  it("matches projectPoint row-for-row and counts visibles", () => {
    const count = ROWS.length;
    const xyz = new Float32Array(count * 3);
    ROWS.forEach((r, i) => {
      xyz[i * 3] = r.scene[0];
      xyz[i * 3 + 1] = r.scene[1];
      xyz[i * 3 + 2] = r.scene[2];
    });
    const buf = makeProjectionBuffers(count);
    const visible = projectPointsInto(ORACLE, xyz, count, buf);
    expect(visible).toBe(count);
    for (let i = 0; i < count; i++) {
      const single = projectPoint(ORACLE, ROWS[i].scene);
      expect(buf.us[i]).toBeCloseTo(single.u, 3);
      expect(buf.vs[i]).toBeCloseTo(single.v, 3);
      expect(buf.depths[i]).toBeCloseTo(single.depth, 3);
      expect(buf.visible[i]).toBe(1);
    }
  });

  it("culls behind-camera and off-image points", () => {
    const xyz = new Float32Array([
      5,
      0,
      3, // visible
      -5,
      0,
      3, // behind camera
      3,
      50,
      3, // off-image left
    ]);
    const buf = makeProjectionBuffers(3);
    const visible = projectPointsInto(ORACLE, xyz, 3, buf);
    expect(visible).toBe(1);
    expect(buf.visible[0]).toBe(1);
    expect(buf.visible[1]).toBe(0);
    expect(Number.isNaN(buf.us[1])).toBe(true);
    expect(buf.visible[2]).toBe(0);
  });
});
