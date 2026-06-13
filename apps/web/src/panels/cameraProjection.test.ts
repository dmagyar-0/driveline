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
  model: "pinhole",
  intrinsics: { fx: 900, fy: 900, cx: 640, cy: 360, width: 1280, height: 720 },
  distortion: [],
  forwardPoly: [],
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

// f-theta fisheye: a camera whose optical frame equals the scene frame
// (identity extrinsic) so the maths is transparent. Forward polynomial
// `ρ(θ) = 100·θ` (focal length 100), principal point (500,500), 1000x1000. The
// ray angle from +Z is `θ = atan2(hypot(X,Y), Z)`; the pixel sits at radius
// `ρ(θ)` from (cx,cy) along the (X,Y) direction.
const FTHETA: CameraCalibration = {
  name: "FISHEYE",
  model: "ftheta",
  intrinsics: { fx: 100, fy: 100, cx: 500, cy: 500, width: 1000, height: 1000 },
  distortion: [],
  forwardPoly: [0, 100],
  translation: [0, 0, 0],
  quaternion: [0, 0, 0, 1], // identity: camera optical frame == scene frame
};

describe("projectPoint (f-theta fisheye)", () => {
  it("maps an on-axis point to the principal point", () => {
    const p = projectPoint(FTHETA, [0, 0, 5]);
    expect(p.visible).toBe(true);
    expect(p.u).toBeCloseTo(500, 4);
    expect(p.v).toBeCloseTo(500, 4);
    expect(p.depth).toBeCloseTo(5, 4);
  });

  it("places an off-axis point at radius ρ(θ) = 100·θ", () => {
    // (3,0,4): θ = atan2(3,4); along +X so only u shifts by ρ.
    const theta = Math.atan2(3, 4);
    const p = projectPoint(FTHETA, [3, 0, 4]);
    expect(p.visible).toBe(true);
    expect(p.u).toBeCloseTo(500 + 100 * theta, 3);
    expect(p.v).toBeCloseTo(500, 4);
    expect(p.depth).toBeCloseTo(4, 4);
  });

  it("bends a wide-angle ray inward vs an equivalent pinhole (ρ=fθ < f·tanθ)", () => {
    // The whole point of f-theta: at a wide angle the fisheye radius fθ is
    // smaller than the pinhole radius f·tanθ. (0,5,5) is at θ = 45°.
    const p = projectPoint(FTHETA, [0, 5, 5]);
    const theta = Math.PI / 4;
    expect(p.v).toBeCloseTo(500 + 100 * theta, 3); // 578.54, fisheye
    // A pinhole with the same focal length would land at 500 + 100·tan(45°)=600.
    expect(p.v).toBeLessThan(500 + 100 * Math.tan(theta));
  });

  it("marks a behind-camera point not visible", () => {
    const p = projectPoint(FTHETA, [0, 0, -5]);
    expect(p.visible).toBe(false);
    expect(p.depth).toBeLessThanOrEqual(0);
  });

  it("batch projection matches the single-point path", () => {
    const scenes: [number, number, number][] = [
      [0, 0, 5],
      [3, 0, 4],
      [0, 5, 5],
      [-2, 1, 6],
    ];
    const xyz = new Float32Array(scenes.flat());
    const buf = makeProjectionBuffers(scenes.length);
    projectPointsInto(FTHETA, xyz, scenes.length, buf);
    scenes.forEach((s, i) => {
      const single = projectPoint(FTHETA, s);
      expect(buf.us[i]).toBeCloseTo(single.u, 3);
      expect(buf.vs[i]).toBeCloseTo(single.v, 3);
      expect(buf.visible[i]).toBe(single.visible ? 1 : 0);
    });
  });
});
