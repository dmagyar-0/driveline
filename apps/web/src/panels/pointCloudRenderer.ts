// Self-contained WebGL2 point-cloud renderer for the 3D scene panel.
//
// Deliberately dependency-free: the project's size budget counts every emitted
// JS chunk (lazy ones too) toward first-load, and three.js is explicitly off
// the table, so we hand-roll the ~200 lines of GL + mat4 + orbit-camera a
// point cloud actually needs. A point cloud has no scene graph — it's one draw
// call of `gl.POINTS` — so a full 3D engine would be pure overhead here.
//
// How LiDAR clouds are conventionally shown (RViz / Foxglove / Open3D /
// CloudCompare), distilled into the defaults below:
//   • colour by a scalar — intensity here — via a perceptual colormap (turbo);
//   • orbit / turntable camera with perspective projection, z-up;
//   • round, mildly perspective-scaled points;
//   • a ground grid for spatial reference.
// The cloud is in the sensor/ego frame (metres), x-forward / y-left / z-up.

// --- column-major mat4 / vec3 helpers (WebGL convention) -----------------
// The hand-rolled linear algebra lives in `sceneMath.ts` so it can be unit
// tested without a GL context; the renderer just drives it.

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

// --- turbo colormap (Mikhailov polynomial fit), 256-entry RGBA8 LUT -------

function turboLut(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    const t5 = t4 * t;
    const r =
      0.13572138 +
      4.6153926 * t -
      42.66032258 * t2 +
      132.13108234 * t3 -
      152.94239396 * t4 +
      59.28637943 * t5;
    const g =
      0.09140261 +
      2.19418839 * t +
      4.84296658 * t2 -
      14.18503333 * t3 +
      4.27729857 * t4 +
      2.82956604 * t5;
    const b =
      0.1066733 +
      12.64194608 * t -
      60.58204836 * t2 +
      110.36276771 * t3 -
      89.90310912 * t4 +
      27.34824973 * t5;
    lut[i * 4 + 0] = Math.max(0, Math.min(255, Math.round(r * 255)));
    lut[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
    lut[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

// --- shaders --------------------------------------------------------------

const POINT_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in float a_intensity;
uniform mat4 u_mvp;
uniform float u_pointScale;
out float v_intensity;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  // Mild perspective sizing: nearer points (smaller clip.w) draw larger.
  gl_PointSize = clamp(u_pointScale / max(gl_Position.w, 0.001), 1.0, 5.0);
  v_intensity = a_intensity;
}`;

const POINT_FS = `#version 300 es
precision highp float;
in float v_intensity;
uniform sampler2D u_lut;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if (dot(c, c) > 1.0) discard;            // round points
  vec3 rgb = texture(u_lut, vec2(clamp(v_intensity, 0.0, 1.0), 0.5)).rgb;
  fragColor = vec4(rgb, 1.0);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`;

// Vertex-coloured line program for trajectories: each endpoint carries its own
// RGBA so a path can fade along its time horizon and lower-confidence
// candidates draw more transparent — all without extra draw calls.
const VCLINE_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec4 a_color;
uniform mat4 u_mvp;
out vec4 v_color;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  v_color = a_color;
}`;

const VCLINE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("createProgram failed");
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

// Build a ground grid on the z=0 plane plus stronger x (red) / y (green) axes.
function gridLines(
  extent: number,
  step: number,
): { grid: Float32Array; axes: Float32Array } {
  const grid: number[] = [];
  for (let v = -extent; v <= extent + 1e-6; v += step) {
    // lines parallel to x
    grid.push(-extent, v, 0, extent, v, 0);
    // lines parallel to y
    grid.push(v, -extent, 0, v, extent, 0);
  }
  const axes = new Float32Array([
    0,
    0,
    0,
    extent,
    0,
    0, // +x
    0,
    0,
    0,
    0,
    extent,
    0, // +y
  ]);
  return { grid: new Float32Array(grid), axes };
}

export interface SceneCameraInfo {
  azimuth: number;
  elevation: number;
  distance: number;
  target: Vec3;
}

/** One 3D bounding box in the vehicle frame (metres, z-up). `size` is FULL
 *  extents; `quat` is scalar-LAST `[qx,qy,qz,qw]`. */
export interface SceneBox {
  center: [number, number, number];
  size: [number, number, number];
  quat: [number, number, number, number];
  label: string;
}

/** One predicted candidate trajectory in the vehicle frame (metres, z-up): a
 *  polyline of waypoints plus the model's confidence in `[0, 1]`. */
export interface SceneTrajectoryPath {
  points: [number, number, number][];
  confidence: number;
}

/** One road-network polyline in the world/vehicle frame (metres, z-up): a
 *  sequence of vertices plus its feature type. The renderer colours each
 *  vertex by `type` via `ROAD_TYPE_LUT`. */
export interface SceneRoadFeature {
  points: [number, number, number][];
  type: string;
}

// Per-feature-type RGB colour LUT for road geometry. Picked so the feature
// classes read distinctly against the dark scene background and the grey grid:
//   lane_boundary → white   road_edge → yellow   centerline → cyan
//   crosswalk     → magenta stop_line → red      driving   → grey
//   other (and any unknown string) → grey
// Alpha is applied uniformly at upload (`ROAD_ALPHA`).
const ROAD_TYPE_LUT: Record<string, [number, number, number]> = {
  lane_boundary: [0.92, 0.92, 0.95],
  road_edge: [0.96, 0.86, 0.18],
  centerline: [0.18, 0.82, 0.92],
  crosswalk: [0.92, 0.26, 0.86],
  stop_line: [0.95, 0.22, 0.22],
  driving: [0.55, 0.58, 0.62],
  other: [0.55, 0.58, 0.62],
};
const ROAD_OTHER: [number, number, number] = ROAD_TYPE_LUT.other;
const ROAD_ALPHA = 0.9;

function roadColor(type: string): [number, number, number] {
  return ROAD_TYPE_LUT[type] ?? ROAD_OTHER;
}

/** A box-centre (or any world point) projected to CSS pixels for label
 *  placement. `visible` is false when the point is behind the camera or
 *  outside the view frustum. */
export interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
}

// The 12 edges of a unit box as pairs of corner indices. Corner index bit
// layout: bit0 = +x, bit1 = +y, bit2 = +z (so corner i has sign per axis).
const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  // bottom face (z-)
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0],
  // top face (z+)
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4],
  // vertical pillars
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const FOV = (60 * Math.PI) / 180;
const MIN_EL = -1.5;
const MAX_EL = 1.5;

export class PointCloudRenderer {
  private gl: WebGL2RenderingContext;
  private pointProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private pointVao: WebGLVertexArrayObject;
  private gridVao: WebGLVertexArrayObject;
  private axesVao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private intBuf: WebGLBuffer;
  private lut: WebGLTexture;

  private boxVao: WebGLVertexArrayObject;
  private boxBuf: WebGLBuffer;
  private boxVertexCount = 0;

  // Predicted-trajectory polylines (dynamic; uploaded by `setTrajectories`).
  // Interleaved [x,y,z, r,g,b,a] per vertex so the vertex-coloured line program
  // renders a time-horizon gradient + per-confidence alpha in one draw call.
  private trajProg: WebGLProgram;
  private trajVao: WebGLVertexArrayObject;
  private trajBuf: WebGLBuffer;
  private trajVertexCount = 0;
  private trajPathCount = 0;

  // Road-network polylines (static; uploaded once by `setRoads`). Same
  // interleaved [x,y,z, r,g,b,a] layout as trajectories, drawn with the same
  // vertex-coloured line program — each vertex coloured by its feature type via
  // `ROAD_TYPE_LUT`. A dedicated VBO so roads and trajectories can coexist.
  private roadVao: WebGLVertexArrayObject;
  private roadBuf: WebGLBuffer;
  private roadVertexCount = 0;
  private roadFeatureCount = 0;

  private pointCount = 0;
  private gridCount: number;
  private gridExtent: number;

  // Last view-projection computed in `render()`, exposed via `getMvp()` so the
  // panel can project box centres to screen for the HTML label overlay.
  private lastMvp: Mat4 = new Float32Array(16);

  // Optional hook invoked at the END of every `render()` (after the draw),
  // letting the panel re-glue its label divs during orbit/zoom/resize.
  private onRender: (() => void) | null = null;

  // Orbit camera. Defaults to a 3/4 view looking down the +x ("forward") axis.
  private az = -2.2;
  private el = 0.5;
  private dist = 80;
  private target: Vec3 = [0, 0, 0];

  private viewW = 1;
  private viewH = 1;
  private pointScale = 85;

  private dirty = true;
  private rafId: number | null = null;
  private disposed = false;

  // Pointer-drag state.
  private dragMode: "orbit" | "pan" | null = null;
  private lastX = 0;
  private lastY = 0;

  private boundCanvas: HTMLCanvasElement;
  private onPointerDown: (e: PointerEvent) => void;
  private onPointerMove: (e: PointerEvent) => void;
  private onPointerUp: (e: PointerEvent) => void;
  private onWheel: (e: WheelEvent) => void;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true, // so dev-hook/Playwright screenshots are stable
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.boundCanvas = canvas;

    this.pointProg = link(gl, POINT_VS, POINT_FS);
    this.lineProg = link(gl, LINE_VS, LINE_FS);
    this.trajProg = link(gl, VCLINE_VS, VCLINE_FS);

    // Points: position (loc 0) + intensity (loc 1), separate dynamic buffers.
    this.pointVao = gl.createVertexArray()!;
    this.posBuf = gl.createBuffer()!;
    this.intBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.intBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Ground grid + axes (static).
    this.gridExtent = 100;
    const { grid, axes } = gridLines(this.gridExtent, 10);
    this.gridCount = grid.length / 3;
    this.gridVao = gl.createVertexArray()!;
    const gridBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.axesVao = gl.createVertexArray()!;
    const axesBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.axesVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, axesBuf);
    gl.bufferData(gl.ARRAY_BUFFER, axes, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Bounding-box wireframes (dynamic; uploaded by `setBoxes`). One VBO of
    // line-segment endpoints, drawn with the LINE program.
    this.boxVao = gl.createVertexArray()!;
    this.boxBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.boxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Trajectory polylines (dynamic; uploaded by `setTrajectories`). One VBO of
    // interleaved [pos(3) + rgba(4)] vertices, 28-byte stride, drawn with the
    // vertex-coloured LINE program as `gl.LINES`.
    this.trajVao = gl.createVertexArray()!;
    this.trajBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.trajVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trajBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);

    // Road-network polylines (static; uploaded by `setRoads`). Same interleaved
    // [pos(3) + rgba(4)] vertex layout as trajectories (28-byte stride), drawn
    // with the vertex-coloured LINE program as `gl.LINES`.
    this.roadVao = gl.createVertexArray()!;
    this.roadBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.roadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);

    // Colormap LUT texture (256x1 RGBA8).
    this.lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      turboLut(),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.clearColor(0.04, 0.05, 0.07, 1);
    gl.enable(gl.DEPTH_TEST);

    // Orbit / pan / zoom controls.
    this.onPointerDown = (e) => {
      this.dragMode = e.button === 2 || e.shiftKey ? "pan" : "orbit";
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    this.onPointerMove = (e) => {
      if (!this.dragMode) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragMode === "orbit") {
        this.az -= dx * 0.006;
        this.el = Math.max(MIN_EL, Math.min(MAX_EL, this.el + dy * 0.006));
      } else {
        this.pan(dx, dy);
      }
      this.requestRender();
    };
    this.onPointerUp = (e) => {
      this.dragMode = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be released */
      }
    };
    this.onWheel = (e) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0012);
      this.dist = Math.max(0.5, Math.min(5000, this.dist * factor));
      this.requestRender();
    };
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private eye(): Vec3 {
    const ce = Math.cos(this.el);
    return [
      this.target[0] + this.dist * ce * Math.cos(this.az),
      this.target[1] + this.dist * ce * Math.sin(this.az),
      this.target[2] + this.dist * Math.sin(this.el),
    ];
  }

  private pan(dx: number, dy: number): void {
    const eye = this.eye();
    const fwd = normalize(sub(this.target, eye));
    const right = normalize(cross(fwd, [0, 0, 1]));
    const up = cross(right, fwd);
    const k = this.dist * 0.0016;
    for (let i = 0; i < 3; i++) {
      this.target[i] += (-dx * right[i] + dy * up[i]) * k;
    }
  }

  /** Upload a new spin's geometry. `positions` is flattened xyz (len 3*count),
   *  `intensities` is 0..1 (len count). */
  setPoints(
    positions: Float32Array,
    intensities: Float32Array,
    count: number,
  ): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.intBuf);
    gl.bufferData(gl.ARRAY_BUFFER, intensities, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.pointCount = count;
    this.requestRender();
  }

  clearPoints(): void {
    this.pointCount = 0;
    this.requestRender();
  }

  /** Upload a set of 3D bounding boxes as wireframe geometry. Each box becomes
   *  12 edges (24 line vertices): the 8 local corners at `(±sx/2,±sy/2,±sz/2)`
   *  are rotated by the box quaternion and translated by its centre, then the
   *  `BOX_EDGES` index pairs are expanded into `gl.LINES` endpoints. */
  setBoxes(boxes: readonly SceneBox[]): void {
    const gl = this.gl;
    const verts = new Float32Array(boxes.length * BOX_EDGES.length * 2 * 3);
    let o = 0;
    for (const box of boxes) {
      const hx = box.size[0] / 2;
      const hy = box.size[1] / 2;
      const hz = box.size[2] / 2;
      // 8 world-space corners, indexed by (bit0=+x, bit1=+y, bit2=+z).
      const corners: Vec3[] = [];
      for (let i = 0; i < 8; i++) {
        const local: Vec3 = [
          i & 1 ? hx : -hx,
          i & 2 ? hy : -hy,
          i & 4 ? hz : -hz,
        ];
        const r = quatRotate(box.quat, local);
        corners.push([
          r[0] + box.center[0],
          r[1] + box.center[1],
          r[2] + box.center[2],
        ]);
      }
      for (const [a, b] of BOX_EDGES) {
        verts[o++] = corners[a][0];
        verts[o++] = corners[a][1];
        verts[o++] = corners[a][2];
        verts[o++] = corners[b][0];
        verts[o++] = corners[b][1];
        verts[o++] = corners[b][2];
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.boxVertexCount = verts.length / 3;
    this.requestRender();
  }

  clearBoxes(): void {
    this.boxVertexCount = 0;
    this.requestRender();
  }

  /** Upload a set of predicted trajectories as vertex-coloured line geometry.
   *  Each path of `k` waypoints becomes `k-1` line segments (`2*(k-1)`
   *  vertices); each vertex carries an RGBA colour that (a) shifts hue along the
   *  path's time horizon — cyan at the ego/near end → green at the far,
   *  predicted end — and (b) scales alpha + saturation with the path's
   *  confidence, so high-confidence candidates read brighter and more opaque
   *  than low-confidence alternates. Reads distinctly from the amber boxes.
   *  Buffer layout is interleaved `[x,y,z, r,g,b,a]` (28-byte stride). */
  setTrajectories(paths: readonly SceneTrajectoryPath[]): void {
    const gl = this.gl;
    // Count line vertices: 2 per segment, (k-1) segments per path.
    let segVerts = 0;
    for (const p of paths) {
      if (p.points.length >= 2) segVerts += (p.points.length - 1) * 2;
    }
    const stride = 7; // floats per vertex (pos3 + rgba4)
    const verts = new Float32Array(segVerts * stride);
    let o = 0;
    let pathCount = 0;
    for (const path of paths) {
      const pts = path.points;
      if (pts.length < 2) continue;
      pathCount++;
      // Confidence in [0,1] drives alpha (floor so a faint path still shows) and
      // a slight desaturation of the low-confidence candidates.
      const conf = Math.max(0, Math.min(1, path.confidence));
      const alpha = 0.35 + 0.65 * conf;
      for (let i = 0; i < pts.length - 1; i++) {
        // Endpoint colours by normalised position along the path (time horizon):
        // near end cyan (0.1, 0.9, 0.95) → far end green (0.3, 1.0, 0.4).
        const tA = i / (pts.length - 1);
        const tB = (i + 1) / (pts.length - 1);
        for (const [pt, t] of [
          [pts[i], tA] as const,
          [pts[i + 1], tB] as const,
        ]) {
          const r = (0.1 + 0.2 * t) * (0.5 + 0.5 * conf);
          const g = (0.9 + 0.1 * t) * (0.6 + 0.4 * conf);
          const b = (0.95 - 0.55 * t) * (0.6 + 0.4 * conf);
          verts[o++] = pt[0];
          verts[o++] = pt[1];
          verts[o++] = pt[2];
          verts[o++] = r;
          verts[o++] = g;
          verts[o++] = b;
          verts[o++] = alpha;
        }
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trajBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.trajVertexCount = segVerts;
    this.trajPathCount = pathCount;
    this.requestRender();
  }

  clearTrajectories(): void {
    this.trajVertexCount = 0;
    this.trajPathCount = 0;
    this.requestRender();
  }

  /** Upload a road network as vertex-coloured line geometry. Each feature of
   *  `k` vertices becomes `k-1` line segments (`2*(k-1)` vertices); every vertex
   *  is coloured by the feature's type via `ROAD_TYPE_LUT` (lane boundaries
   *  white, road edges yellow, centerlines cyan, crosswalks magenta, stop lines
   *  red, driving/other grey) at a uniform alpha so the classes read distinctly.
   *  A road source is STATIC, so this is called once per fresh binding rather
   *  than per cursor tick. Buffer layout is interleaved `[x,y,z, r,g,b,a]`
   *  (28-byte stride), shared with the trajectory program. */
  setRoads(features: readonly SceneRoadFeature[]): void {
    const gl = this.gl;
    let segVerts = 0;
    for (const f of features) {
      if (f.points.length >= 2) segVerts += (f.points.length - 1) * 2;
    }
    const stride = 7; // floats per vertex (pos3 + rgba4)
    const verts = new Float32Array(segVerts * stride);
    let o = 0;
    let featureCount = 0;
    for (const feature of features) {
      const pts = feature.points;
      if (pts.length < 2) continue;
      featureCount++;
      const [r, g, b] = roadColor(feature.type);
      for (let i = 0; i < pts.length - 1; i++) {
        for (const pt of [pts[i], pts[i + 1]]) {
          verts[o++] = pt[0];
          verts[o++] = pt[1];
          verts[o++] = pt[2];
          verts[o++] = r;
          verts[o++] = g;
          verts[o++] = b;
          verts[o++] = ROAD_ALPHA;
        }
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.roadVertexCount = segVerts;
    this.roadFeatureCount = featureCount;
    this.requestRender();
  }

  clearRoads(): void {
    this.roadVertexCount = 0;
    this.roadFeatureCount = 0;
    this.requestRender();
  }

  /** Frame the camera to a road network — the road equivalent of
   *  `frameToTrajectories`. A map_geometry source carries no point cloud, so
   *  the cloud auto-frame never fires and the roads would sit off-screen at the
   *  default camera. Computes the vertices' axis-aligned bounds and reuses the
   *  same centroid+radius framing maths. Called once per fresh feature set. */
  frameToRoads(features: readonly SceneRoadFeature[]): void {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    let any = false;
    for (const feature of features) {
      for (const p of feature.points) {
        any = true;
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        minZ = Math.min(minZ, p[2]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
        maxZ = Math.max(maxZ, p[2]);
      }
    }
    if (!any) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const radius = Math.max(
      Math.hypot(maxX - cx, maxY - cy),
      (maxZ - minZ) / 2,
      3,
    );
    this.target = [cx, cy, cz];
    this.dist = Math.max(8, (radius / Math.tan(FOV / 2)) * 1.3);
    this.requestRender();
  }

  /** Frame the camera to a set of predicted trajectories — the trajectory
   *  equivalent of `frameToBoxes`. A trajectory source carries no point cloud,
   *  so the cloud auto-frame never fires and the paths would sit off-screen at
   *  the default camera. Computes the waypoints' axis-aligned bounds and reuses
   *  the same centroid+radius framing maths. Called once per fresh path set. */
  frameToTrajectories(paths: readonly SceneTrajectoryPath[]): void {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    let any = false;
    for (const path of paths) {
      for (const p of path.points) {
        any = true;
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        minZ = Math.min(minZ, p[2]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
        maxZ = Math.max(maxZ, p[2]);
      }
    }
    if (!any) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const radius = Math.max(
      Math.hypot(maxX - cx, maxY - cy),
      (maxZ - minZ) / 2,
      3,
    );
    this.target = [cx, cy, cz];
    this.dist = Math.max(8, (radius / Math.tan(FOV / 2)) * 1.3);
    this.requestRender();
  }

  /** Register (or clear with `null`) a callback fired at the end of every
   *  `render()` — used by the panel to reposition HTML box labels each frame so
   *  they track the camera during orbit/zoom/resize. */
  setOnRender(cb: (() => void) | null): void {
    this.onRender = cb;
  }

  /** Current view-projection matrix (column-major) from the last `render()`. */
  getMvp(): Float32Array {
    return this.lastMvp;
  }

  /** Drawing-buffer size in device pixels `[w, h]`. */
  viewportSize(): [number, number] {
    return [this.viewW, this.viewH];
  }

  /** Project a world point to CSS pixels (origin top-left). Returns `visible:
   *  false` when the point is behind the camera or outside the NDC cube. The
   *  caller divides device pixels by `dpr` itself if it works in CSS units —
   *  here we return CSS pixels directly, matching `clientX/clientY`. */
  project(p: Vec3): ProjectedPoint {
    const m = this.lastMvp;
    const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (cw <= 0) return { x: 0, y: 0, visible: false };
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.viewW / dpr;
    const cssH = this.viewH / dpr;
    const x = (ndcX * 0.5 + 0.5) * cssW;
    const y = (1 - (ndcY * 0.5 + 0.5)) * cssH;
    const visible = ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
    return { x, y, visible };
  }

  /** Fit the camera to a cloud — called once per binding so a fresh cloud is
   *  framed without fighting subsequent manual orbiting. Uses the centroid and
   *  a 90th-percentile horizontal radius rather than the raw bounding box: a
   *  LiDAR spin has sparse returns out to ~190 m that would otherwise push the
   *  camera so far back the dense near-field cloud shrinks to a dot. */
  frameToBounds(positions: Float32Array): void {
    if (positions.length < 3) return;
    // Stride large clouds — framing doesn't need every one of ~250k points.
    const stride = Math.max(3, Math.floor(positions.length / (20000 * 3)) * 3);
    let cx = 0,
      cy = 0,
      cz = 0,
      n = 0;
    for (let i = 0; i + 2 < positions.length; i += stride) {
      cx += positions[i];
      cy += positions[i + 1];
      cz += positions[i + 2];
      n++;
    }
    if (n === 0) return;
    cx /= n;
    cy /= n;
    cz /= n;
    const dists: number[] = [];
    for (let i = 0; i + 2 < positions.length; i += stride) {
      dists.push(Math.hypot(positions[i] - cx, positions[i + 1] - cy));
    }
    dists.sort((a, b) => a - b);
    const radius = dists[Math.floor(dists.length * 0.9)] || 10;
    this.target = [cx, cy, cz];
    // Distance so the bulk of the cloud fits the vertical FOV, with headroom.
    this.dist = Math.max(8, (radius / Math.tan(FOV / 2)) * 1.25);
    this.requestRender();
  }

  /** Fit the camera to a set of bounding boxes — the box equivalent of
   *  `frameToBounds`. A `bounding_box` source carries no point cloud, so the
   *  point-cloud auto-frame never fires and the boxes would sit off-screen at
   *  the default camera. Computes the boxes' axis-aligned bounds (using each
   *  box centre ± half its full extent, ignoring orientation — a small
   *  over-estimate that only adds harmless headroom) and reuses the same
   *  centroid+radius framing maths as `frameToBounds`. Called once per fresh
   *  box set (the panel gates on `!hasFramed`) so manual orbiting afterwards is
   *  never overridden. */
  frameToBoxes(boxes: readonly SceneBox[]): void {
    if (boxes.length === 0) return;
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (const b of boxes) {
      const hx = Math.abs(b.size[0]) / 2;
      const hy = Math.abs(b.size[1]) / 2;
      const hz = Math.abs(b.size[2]) / 2;
      // Conservative AABB: the box may be rotated, so pad by the largest
      // half-extent on every axis. Cheap and only ever frames a touch wider.
      const pad = Math.max(hx, hy, hz);
      minX = Math.min(minX, b.center[0] - pad);
      minY = Math.min(minY, b.center[1] - pad);
      minZ = Math.min(minZ, b.center[2] - pad);
      maxX = Math.max(maxX, b.center[0] + pad);
      maxY = Math.max(maxY, b.center[1] + pad);
      maxZ = Math.max(maxZ, b.center[2] + pad);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    // Horizontal radius drives the framing (same as the cloud path, which fits
    // the vertical FOV to the in-plane spread); include z so tall trucks/poles
    // still fit. Floor keeps a single small box from zooming uncomfortably close.
    const radius = Math.max(
      Math.hypot(maxX - cx, maxY - cy),
      (maxZ - minZ) / 2,
      3,
    );
    this.target = [cx, cy, cz];
    this.dist = Math.max(8, (radius / Math.tan(FOV / 2)) * 1.3);
    this.requestRender();
  }

  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.boundCanvas.width !== w || this.boundCanvas.height !== h) {
      this.boundCanvas.width = w;
      this.boundCanvas.height = h;
    }
    this.viewW = w;
    this.viewH = h;
    this.requestRender();
  }

  requestRender(): void {
    this.dirty = true;
    if (this.rafId !== null || this.disposed) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.dirty) this.render();
    });
  }

  private render(): void {
    if (this.disposed) return;
    this.dirty = false;
    const gl = this.gl;
    gl.viewport(0, 0, this.viewW, this.viewH);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye = this.eye();
    const proj = perspective(FOV, this.viewW / this.viewH, 0.1, 4000);
    const view = lookAt(eye, this.target, [0, 0, 1]);
    const mvp = multiply(proj, view);
    this.lastMvp = mvp;

    // Grid + axes first (depth-tested, drawn under the cloud).
    gl.useProgram(this.lineProg);
    const lineMvp = gl.getUniformLocation(this.lineProg, "u_mvp");
    const lineColor = gl.getUniformLocation(this.lineProg, "u_color");
    gl.uniformMatrix4fv(lineMvp, false, mvp);
    gl.uniform4f(lineColor, 0.25, 0.28, 0.34, 1);
    gl.bindVertexArray(this.gridVao);
    gl.drawArrays(gl.LINES, 0, this.gridCount);
    gl.uniform4f(lineColor, 0.55, 0.3, 0.3, 1);
    gl.bindVertexArray(this.axesVao);
    gl.drawArrays(gl.LINES, 0, 2); // +x axis (reddish)
    gl.uniform4f(lineColor, 0.3, 0.5, 0.3, 1);
    gl.drawArrays(gl.LINES, 2, 2); // +y axis (greenish)

    // Point cloud.
    if (this.pointCount > 0) {
      gl.useProgram(this.pointProg);
      gl.uniformMatrix4fv(
        gl.getUniformLocation(this.pointProg, "u_mvp"),
        false,
        mvp,
      );
      gl.uniform1f(
        gl.getUniformLocation(this.pointProg, "u_pointScale"),
        this.pointScale,
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.uniform1i(gl.getUniformLocation(this.pointProg, "u_lut"), 0);
      gl.bindVertexArray(this.pointVao);
      gl.drawArrays(gl.POINTS, 0, this.pointCount);
    }

    // Bounding boxes last, in a bright amber that reads against both the dark
    // background and the gray grid. Drawn with the LINE program regardless of
    // whether a point cloud is present (a bounding_box source carries no
    // points). Depth test stays on so boxes occlude correctly against geometry.
    if (this.boxVertexCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(
        gl.getUniformLocation(this.lineProg, "u_mvp"),
        false,
        mvp,
      );
      gl.uniform4f(
        gl.getUniformLocation(this.lineProg, "u_color"),
        1.0,
        0.8,
        0.1,
        1,
      );
      gl.bindVertexArray(this.boxVao);
      gl.drawArrays(gl.LINES, 0, this.boxVertexCount);
    }

    // Predicted trajectories last, with the vertex-coloured line program (cyan→
    // green time-horizon gradient, per-confidence alpha) so they read distinctly
    // from the amber boxes. Alpha-blended; depth test stays on so paths occlude
    // correctly against the cloud/grid but blend among themselves.
    if (this.trajVertexCount > 0 || this.roadVertexCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.trajProg);
      gl.uniformMatrix4fv(
        gl.getUniformLocation(this.trajProg, "u_mvp"),
        false,
        mvp,
      );
      // Road network (static): per-feature-type coloured polylines. Shares the
      // vertex-coloured line program with trajectories; the colour lives in the
      // per-vertex RGBA so no extra uniform/draw call is needed.
      if (this.roadVertexCount > 0) {
        gl.bindVertexArray(this.roadVao);
        gl.drawArrays(gl.LINES, 0, this.roadVertexCount);
      }
      if (this.trajVertexCount > 0) {
        gl.bindVertexArray(this.trajVao);
        gl.drawArrays(gl.LINES, 0, this.trajVertexCount);
      }
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);

    // Let the panel re-place its HTML label overlay against the fresh MVP.
    this.onRender?.();
  }

  cameraInfo(): SceneCameraInfo {
    return {
      azimuth: this.az,
      elevation: this.el,
      distance: this.dist,
      target: [this.target[0], this.target[1], this.target[2]],
    };
  }

  pointCountValue(): number {
    return this.pointCount;
  }

  /** Number of boxes currently uploaded (24 line vertices per box). */
  boxCountValue(): number {
    return this.boxVertexCount / (BOX_EDGES.length * 2);
  }

  /** Number of candidate trajectory paths currently uploaded. */
  trajectoryPathCountValue(): number {
    return this.trajPathCount;
  }

  /** Number of road-network features currently uploaded. */
  roadFeatureCountValue(): number {
    return this.roadFeatureCount;
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    const c = this.boundCanvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("wheel", this.onWheel);
    const gl = this.gl;
    // Drop GPU resources; the context itself is released when the canvas is
    // removed from the DOM by React.
    gl.deleteProgram(this.pointProg);
    gl.deleteProgram(this.lineProg);
    gl.deleteProgram(this.trajProg);
    gl.deleteTexture(this.lut);
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.intBuf);
    gl.deleteBuffer(this.boxBuf);
    gl.deleteBuffer(this.trajBuf);
    gl.deleteBuffer(this.roadBuf);
  }
}
