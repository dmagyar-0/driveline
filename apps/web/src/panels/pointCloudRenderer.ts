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

// --- column-major mat4 helpers (WebGL convention) ------------------------

type Vec3 = [number, number, number];
type Mat4 = Float32Array;

function multiply(a: Mat4, b: Mat4): Mat4 {
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

function perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
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

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
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
      0.13572138 + 4.6153926 * t - 42.66032258 * t2 + 132.13108234 * t3 -
      152.94239396 * t4 + 59.28637943 * t5;
    const g =
      0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 +
      4.27729857 * t4 + 2.82956604 * t5;
    const b =
      0.1066733 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 -
      89.90310912 * t4 + 27.34824973 * t5;
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

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
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

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
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
function gridLines(extent: number, step: number): { grid: Float32Array; axes: Float32Array } {
  const grid: number[] = [];
  for (let v = -extent; v <= extent + 1e-6; v += step) {
    // lines parallel to x
    grid.push(-extent, v, 0, extent, v, 0);
    // lines parallel to y
    grid.push(v, -extent, 0, v, extent, 0);
  }
  const axes = new Float32Array([
    0, 0, 0, extent, 0, 0, // +x
    0, 0, 0, 0, extent, 0, // +y
  ]);
  return { grid: new Float32Array(grid), axes };
}

export interface SceneCameraInfo {
  azimuth: number;
  elevation: number;
  distance: number;
  target: Vec3;
}

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

  private pointCount = 0;
  private gridCount: number;
  private gridExtent: number;

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

    // Colormap LUT texture (256x1 RGBA8).
    this.lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, turboLut(),
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
  setPoints(positions: Float32Array, intensities: Float32Array, count: number): void {
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

  /** Fit the camera to a cloud — called once per binding so a fresh cloud is
   *  framed without fighting subsequent manual orbiting. Uses the centroid and
   *  a 90th-percentile horizontal radius rather than the raw bounding box: a
   *  LiDAR spin has sparse returns out to ~190 m that would otherwise push the
   *  camera so far back the dense near-field cloud shrinks to a dot. */
  frameToBounds(positions: Float32Array): void {
    if (positions.length < 3) return;
    // Stride large clouds — framing doesn't need every one of ~250k points.
    const stride = Math.max(3, Math.floor(positions.length / (20000 * 3)) * 3);
    let cx = 0, cy = 0, cz = 0, n = 0;
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
      gl.uniformMatrix4fv(gl.getUniformLocation(this.pointProg, "u_mvp"), false, mvp);
      gl.uniform1f(gl.getUniformLocation(this.pointProg, "u_pointScale"), this.pointScale);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.uniform1i(gl.getUniformLocation(this.pointProg, "u_lut"), 0);
      gl.bindVertexArray(this.pointVao);
      gl.drawArrays(gl.POINTS, 0, this.pointCount);
    }
    gl.bindVertexArray(null);
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
    gl.deleteTexture(this.lut);
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.intBuf);
  }
}
