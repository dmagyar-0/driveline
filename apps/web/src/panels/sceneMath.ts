// Column-major mat4 / vec3 helpers (WebGL convention) for the 3D scene panel.
//
// Extracted verbatim from `pointCloudRenderer.ts` so the hand-rolled linear
// algebra the renderer needs (the project bans three.js for size budget, so we
// roll the ~80 lines a point cloud actually uses) lives in one cohesive,
// dependency-free, UNIT-TESTABLE module instead of being trapped inside the
// 800-line WebGL class. Behaviour is identical — the renderer imports these and
// drives them exactly as before. Keeping them out here means the projection /
// orbit-camera / quaternion math (a sign error in which silently mis-orients
// every 3D box) can be verified without a GL context.

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function perspective(
  fovyRad: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Rotate a vector by a unit quaternion `[qx,qy,qz,qw]` (scalar-LAST, the
// OpenLABEL/Arrow wire convention). Uses the standard `v' = v + 2*q_xyz ×
// (q_xyz × v + q_w*v)` form so we avoid building a full rotation matrix.
export function quatRotate(q: [number, number, number, number], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q_xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  // v' = v + w*t + cross(q_xyz, t)
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const f = normalize(sub(center, eye)); // forward
  const s = normalize(cross(f, up)); // right
  const u = cross(s, f); // true up
  const out = new Float32Array(16);
  out[0] = s[0];
  out[4] = s[1];
  out[8] = s[2];
  out[1] = u[0];
  out[5] = u[1];
  out[9] = u[2];
  out[2] = -f[0];
  out[6] = -f[1];
  out[10] = -f[2];
  out[12] = -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]);
  out[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
  out[14] = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2];
  out[15] = 1;
  return out;
}
