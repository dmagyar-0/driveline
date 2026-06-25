import { describe, expect, it } from "vitest";

import {
  type Mat4,
  type Vec3,
  cross,
  lookAt,
  multiply,
  normalize,
  perspective,
  quatRotate,
  sub,
} from "./sceneMath";

const identity = (): Mat4 =>
  // prettier-ignore
  new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);

/** Transform a point (w=1) by a column-major mat4 — the convention the GL
 *  shader uses, so tests read the matrices the same way the renderer does. */
function transformPoint(m: Mat4, [x, y, z]: Vec3): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function expectVecClose(a: Vec3, b: Vec3, digits = 5): void {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

describe("multiply", () => {
  it("is the identity's fixed point on both sides", () => {
    const a = new Float32Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(Array.from(multiply(identity(), a))).toEqual(Array.from(a));
    expect(Array.from(multiply(a, identity()))).toEqual(Array.from(a));
  });

  it("composes transforms (translate then the result maps a point)", () => {
    const t = identity();
    t[12] = 10; // translate +x by 10
    const t2 = identity();
    t2[13] = 5; // translate +y by 5
    const composed = multiply(t, t2);
    expectVecClose(transformPoint(composed, [0, 0, 0]), [10, 5, 0]);
  });
});

describe("perspective", () => {
  it("matches the closed-form projection entries", () => {
    const fovy = Math.PI / 2; // 90° → f == 1
    const m = perspective(fovy, 2, 1, 100);
    const f = 1;
    expect(m[0]).toBeCloseTo(f / 2, 6); // f / aspect
    expect(m[5]).toBeCloseTo(f, 6);
    expect(m[10]).toBeCloseTo((100 + 1) / (1 - 100), 6);
    expect(m[11]).toBe(-1); // perspective divide hook
    expect(m[14]).toBeCloseTo((2 * 100 * 1) / (1 - 100), 5);
  });
});

describe("sub / cross / normalize", () => {
  it("subtracts componentwise", () => {
    expect(sub([5, 7, 9], [1, 2, 3])).toEqual([4, 5, 6]);
  });

  it("cross follows the right-hand rule (x × y == z)", () => {
    expectVecClose(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
    expectVecClose(cross([0, 1, 0], [0, 0, 1]), [1, 0, 0]);
    // Anti-commutative.
    expectVecClose(cross([0, 1, 0], [1, 0, 0]), [0, 0, -1]);
  });

  it("normalize returns a unit vector and is divide-by-zero safe", () => {
    const n = normalize([3, 0, 4]);
    expectVecClose(n, [0.6, 0, 0.8]);
    expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    // The `|| 1` guard keeps a zero vector finite instead of NaN.
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("quatRotate (scalar-last [x,y,z,w])", () => {
  it("leaves a vector unchanged under the identity quaternion", () => {
    expectVecClose(quatRotate([0, 0, 0, 1], [1, 2, 3]), [1, 2, 3]);
  });

  it("rotates +x to +y for a 90° turn about z", () => {
    const s = Math.SQRT1_2; // sin/cos of 45°
    expectVecClose(quatRotate([0, 0, s, s], [1, 0, 0]), [0, 1, 0]);
  });

  it("rotates +x to -x for a 180° turn about z", () => {
    expectVecClose(quatRotate([0, 0, 1, 0], [1, 0, 0]), [-1, 0, 0]);
  });

  it("rotates +z to +x for a 90° turn about y", () => {
    const s = Math.SQRT1_2;
    expectVecClose(quatRotate([0, s, 0, s], [0, 0, 1]), [1, 0, 0]);
  });

  it("preserves vector length (rotations are isometries)", () => {
    const s = Math.SQRT1_2;
    const v: Vec3 = [1, 2, 3];
    const r = quatRotate([0, 0, s, s], v);
    expect(Math.hypot(...r)).toBeCloseTo(Math.hypot(...v), 5);
  });
});

describe("lookAt", () => {
  it("maps the eye point to the view-space origin", () => {
    const eye: Vec3 = [0, 0, 10];
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    expectVecClose(transformPoint(view, eye), [0, 0, 0]);
  });

  it("puts the look target down the -z view axis (right-handed)", () => {
    const view = lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    // The origin (the target) sits 10 units in front of the camera, i.e. at
    // view-space z == -10.
    const target = transformPoint(view, [0, 0, 0]);
    expect(target[0]).toBeCloseTo(0, 5);
    expect(target[1]).toBeCloseTo(0, 5);
    expect(target[2]).toBeCloseTo(-10, 5);
  });

  it("produces an orthonormal rotation basis", () => {
    const view = lookAt([3, -4, 5], [1, 1, 1], [0, 0, 1]);
    // Columns 0..2 of the upper-left 3x3 (the basis rows here) should be unit
    // length; sample the right axis.
    const right: Vec3 = [view[0], view[4], view[8]];
    const up: Vec3 = [view[1], view[5], view[9]];
    expect(Math.hypot(...right)).toBeCloseTo(1, 5);
    expect(Math.hypot(...up)).toBeCloseTo(1, 5);
    // Right ⟂ up.
    expect(right[0] * up[0] + right[1] * up[1] + right[2] * up[2]).toBeCloseTo(
      0,
      5,
    );
  });
});
