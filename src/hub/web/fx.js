// Murmur background effects: vanilla WebGL ports of three Originkit components.
//   dotMatrix     noise-driven halftone dots, the page-wide backdrop
//   particleDrift drifting linked particles that reach for the pointer, auth screens
//   tornado       twisted strand vortex with flickering dots and comets, home hero
// Each takes a <canvas> and runs until that canvas has been out of the DOM for a moment,
// then frees its GL context. Views are rebuilt freely, so there is no unmount hook.

const still = matchMedia('(prefers-reduced-motion: reduce)');
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u, a: name => gl.getAttribLocation(p, name) };
}

// Size the canvas to its box and call frame() every animation frame while it is mounted.
// Reduced motion: dt is 0 and t is pinned past every entrance ramp, so frames are static.
function run(canvas, gl, frame, cleanup) {
  let raf = 0, last = performance.now(), t = 0, seen = false, lostAt = 0;
  const tick = now => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!canvas.isConnected) {
      if (seen && !lostAt) lostAt = now;
      if (lostAt && now - lostAt > 1500) {
        cancelAnimationFrame(raf);
        cleanup?.();
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      return;
    }
    seen = true; lostAt = 0;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    const resized = canvas.width !== bw || canvas.height !== bh;
    if (resized) { canvas.width = bw; canvas.height = bh; }
    t = still.matches ? 30 : t + dt;
    gl.viewport(0, 0, bw, bh);
    frame({ dt: still.matches ? 0 : dt, t, w, h, dpr, bw, bh, resized });
  };
  raf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- Dot Matrix
// The original renders simplex noise to a texture, then samples it per cell. Sampling the
// noise at the cell centre directly gives the same picture in one pass with no render target.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const DOT_MATRIX_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime, uCell;
out vec4 o;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Palette, low to high intensity: grey haze to white. rgb + alpha.
const vec4 P0 = vec4(0.45, 0.45, 0.45, 0.03);
const vec4 P1 = vec4(0.70, 0.70, 0.70, 0.07);
const vec4 P2 = vec4(1.00, 1.00, 1.00, 0.17);

void main() {
  vec2 pix = gl_FragCoord.xy;
  vec2 uv = (floor(pix / uCell) + 0.5) * uCell / uRes;
  uv = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0) + 0.5;
  vec3 col = hsv2rgb(vec3(abs(snoise(vec3(uv * 0.3, uTime * 0.12))), 1.0, 1.0));
  float gray = pow(clamp(0.3 * col.r + 0.59 * col.g + 0.11 * col.b, 0.0001, 1.0), 1.68);
  float g = clamp(gray + 0.05, 0.0, 1.0);

  float dist = length(fract(pix / uCell) - 0.5);
  float r = g * 0.5, aa = fwidth(dist) + 1e-4;
  float mark = 1.0 - smoothstep(r - aa, r + aa, dist);

  vec4 c = g < 0.5 ? mix(P0, P1, g * 2.0) : mix(P1, P2, g * 2.0 - 1.0);
  o = vec4(c.rgb * c.a * mark, c.a * mark);
}`;

export function dotMatrix(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, premultipliedAlpha: true });
  if (!gl) return;
  const { p, u } = program(gl, FULLSCREEN_VS, DOT_MATRIX_FS);
  let acc = 1;
  run(canvas, gl, f => {
    if (!f.resized && (acc += f.dt) < 1 / 30) return; // 30fps is plenty for a backdrop
    acc = 0;
    gl.useProgram(p);
    gl.uniform2f(u.uRes, f.bw, f.bh);
    gl.uniform1f(u.uTime, f.t);
    gl.uniform1f(u.uCell, 20 * f.dpr);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
}

// ---------------------------------------------------------------- Particle Drift
const DRIFT_LINE_VS = `
precision highp float;
attribute vec2 a_p0, a_p1, a_corner;
attribute vec3 a_shade;
uniform vec2 uSize;
varying float v_alpha, v_mix, v_off, v_half;
void main() {
  vec2 d = a_p1 - a_p0;
  float len = max(length(d), 1e-5);
  vec2 nrm = vec2(-d.y, d.x) / len;
  float half_ = max(a_shade.z * 0.5, 0.35);
  float ext = half_ + 0.75;
  vec2 p = mix(a_p0, a_p1, a_corner.x) + nrm * a_corner.y * ext;
  v_alpha = a_shade.x; v_mix = a_shade.y; v_off = a_corner.y * ext; v_half = half_;
  gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, 0.0, 1.0);
}`;

const DRIFT_LINE_FS = `
precision mediump float;
uniform vec3 uBase, uAccent;
varying float v_alpha, v_mix, v_off, v_half;
void main() {
  float a = v_alpha * clamp((v_half - abs(v_off)) / 0.75 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(mix(uBase, uAccent, v_mix) * a, a);
}`;

const DRIFT_DOT_VS = `
precision highp float;
attribute vec2 a_pos;
attribute float a_lit;
uniform vec2 uSize;
uniform float uDpr, uDot;
varying float v_lit;
void main() {
  gl_PointSize = max(1.0, uDot * uDpr);
  v_lit = a_lit;
  gl_Position = vec4(a_pos.x / uSize.x * 2.0 - 1.0, 1.0 - a_pos.y / uSize.y * 2.0, 0.0, 1.0);
}`;

const DRIFT_DOT_FS = `
precision mediump float;
uniform vec3 uBase, uAccent;
uniform float uRestAlpha;
varying float v_lit;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.72, 1.0, d)) * mix(uRestAlpha, 1.0, v_lit);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(mix(uBase, uAccent, v_lit) * a, a);
}`;

export function particleDrift(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, premultipliedAlpha: true });
  if (!gl) return;
  const MAX_LINES = 8000, EDGE = 20, REACH = 180, HOVER = 2, LINKD = 190, LINKW = 1, DOT = 5;
  const BASE = [0.62, 0.62, 0.62], ACCENT = [1, 1, 1]; // monochrome: lit = full white
  const CORNERS = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]];
  const L = program(gl, DRIFT_LINE_VS, DRIFT_LINE_FS), D = program(gl, DRIFT_DOT_VS, DRIFT_DOT_FS);

  const lP0 = new Float32Array(MAX_LINES * 12), lP1 = new Float32Array(MAX_LINES * 12);
  const lCorner = new Float32Array(MAX_LINES * 12), lShade = new Float32Array(MAX_LINES * 18);
  for (let e = 0; e < MAX_LINES; e++) for (let c = 0; c < 6; c++) lCorner.set(CORNERS[c], (e * 6 + c) * 2);
  const buf = data => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, typeof data === 'number' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    return b;
  };
  const bP0 = buf(lP0.byteLength), bP1 = buf(lP1.byteLength), bCorner = buf(lCorner), bShade = buf(lShade.byteLength);
  // Bind a buffer to a program attribute, optionally uploading data first. Returns the location.
  const attr = (prog, name, b, size, data) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    if (data) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    const a = prog.a(name);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, size, gl.FLOAT, false, 0, 0);
    return a;
  };

  // The canvas sits behind the page content, so track the pointer on the window.
  const ptr = { x: -1e4, y: -1e4 };
  const track = e => { const r = canvas.getBoundingClientRect(); ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; };
  const leave = () => { ptr.x = ptr.y = -1e4; };
  addEventListener('pointermove', track);
  document.documentElement.addEventListener('pointerleave', leave);

  let n = 0, nx, ny, spd, gPos, gLit, bPos, bLit, builtW = 0, builtH = 0;
  run(canvas, gl, ({ dt, w, h, dpr }) => {
    if (!n) {
      n = Math.round(clamp((w * h) / 5200, 60, 400)); // density scales with screen area
      nx = new Float32Array(n); ny = new Float32Array(n); spd = new Float32Array(n);
      gPos = new Float32Array(n * 2); gLit = new Float32Array(n);
      for (let i = 0; i < n; i++) { nx[i] = Math.random() * w; ny[i] = Math.random() * h; spd[i] = (Math.random() * 0.4 + 0.1) * 60; }
      bPos = buf(gPos.byteLength); bLit = buf(gLit.byteLength);
      builtW = w; builtH = h;
    }
    if (w !== builtW || h !== builtH) {
      for (let i = 0; i < n; i++) { nx[i] *= w / builtW; ny[i] *= h / builtH; }
      builtW = w; builtH = h;
    }

    let lines = 0;
    const pushLine = (x0, y0, x1, y1, a, mix) => {
      if (lines >= MAX_LINES) return;
      for (let c = 0; c < 6; c++) {
        const k = (lines * 6 + c) * 2, s3 = (lines * 6 + c) * 3;
        lP0[k] = x0; lP0[k + 1] = y0; lP1[k] = x1; lP1[k + 1] = y1;
        lShade[s3] = a; lShade[s3 + 1] = mix; lShade[s3 + 2] = LINKW;
      }
      lines++;
    };

    for (let i = 0; i < n; i++) {
      ny[i] += spd[i] * dt;
      if (ny[i] > h + EDGE) { ny[i] = -EDGE; nx[i] = Math.random() * w; }
      const dx = ptr.x - nx[i], dy = ptr.y - ny[i], d = Math.sqrt(dx * dx + dy * dy);
      const lit = d < REACH ? 1 : 0;
      if (lit) pushLine(nx[i], ny[i], ptr.x, ptr.y, 0.5 * (1 - d / REACH) * HOVER, 1);
      gPos[i * 2] = nx[i]; gPos[i * 2 + 1] = ny[i]; gLit[i] = lit;
    }
    // ponytail: O(n²) pair scan, fine at n<=400; grid-bucket it if density goes up
    const l2 = LINKD * LINKD;
    for (let i = 0; i < n && lines < MAX_LINES; i++) {
      for (let j = i + 1; j < n && lines < MAX_LINES; j++) {
        const dx = nx[i] - nx[j], dy = ny[i] - ny[j], dd = dx * dx + dy * dy;
        if (dd < l2) pushLine(nx[i], ny[i], nx[j], ny[j], 0.15 * (1 - Math.sqrt(dd) / LINKD), 0);
      }
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (lines) {
      const verts = lines * 6;
      gl.useProgram(L.p);
      const as = [
        attr(L, 'a_p0', bP0, 2, lP0.subarray(0, verts * 2)),
        attr(L, 'a_p1', bP1, 2, lP1.subarray(0, verts * 2)),
        attr(L, 'a_corner', bCorner, 2),
        attr(L, 'a_shade', bShade, 3, lShade.subarray(0, verts * 3)),
      ];
      gl.uniform2f(L.u.uSize, w, h);
      gl.uniform3fv(L.u.uBase, BASE);
      gl.uniform3fv(L.u.uAccent, ACCENT);
      gl.drawArrays(gl.TRIANGLES, 0, verts);
      for (const a of as) gl.disableVertexAttribArray(a);
    }

    gl.useProgram(D.p);
    const as = [attr(D, 'a_pos', bPos, 2, gPos), attr(D, 'a_lit', bLit, 1, gLit)];
    gl.uniform2f(D.u.uSize, w, h);
    gl.uniform1f(D.u.uDpr, dpr);
    gl.uniform1f(D.u.uDot, DOT);
    gl.uniform1f(D.u.uRestAlpha, 0.4);
    gl.uniform3fv(D.u.uBase, BASE);
    gl.uniform3fv(D.u.uAccent, ACCENT);
    gl.drawArrays(gl.POINTS, 0, n);
    for (const a of as) gl.disableVertexAttribArray(a);
  }, () => {
    removeEventListener('pointermove', track);
    document.documentElement.removeEventListener('pointerleave', leave);
  });
}

// ---------------------------------------------------------------- Tornado
// Preset: top 380 / waist 53 @ 50% / bottom 1150, twist 3, zoom 75, speed 10. Comets white (monochrome).
// Skipped from the original: comet-dot collisions (ripples, shockwaves) and hover repel.
const CURVE_SAMPLES = 1024, FORM_HEIGHT = 10, WOBBLE = 0.008, FADE_ZONE = 0.15;
const RUN_LOW = 0.03, RUN_HIGH = 0.95, RUN_FADE = 0.1;

function ramp(now, from, to) {
  if (now <= from) return 0;
  if (now >= to) return 1;
  const t = (now - from) / (to - from);
  return 1 - (1 - t) ** 3;
}

// Monotone cubic (Fritsch-Carlson) through points, baked into a lookup table.
function curve(points) {
  const n = points.length, slope = [], m = [];
  for (let i = 0; i < n - 1; i++) slope[i] = (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]);
  m[0] = slope[0];
  for (let i = 1; i < n - 1; i++) m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  m[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(slope[i]) < 1e-12) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * slope[i]; m[i + 1] = k * b * slope[i]; }
  }
  const table = new Float32Array(CURVE_SAMPLES);
  for (let k = 0, i = 0; k < CURVE_SAMPLES; k++) {
    const x = k / (CURVE_SAMPLES - 1);
    while (i < n - 2 && points[i + 1][0] < x) i++;
    const h = points[i + 1][0] - points[i][0], t = (x - points[i][0]) / h, t2 = t * t, t3 = t2 * t;
    table[k] = (2 * t3 - 3 * t2 + 1) * points[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * points[i + 1][1] + (t3 - t2) * h * m[i + 1];
  }
  return table;
}

function sample(table, t) {
  if (t <= 0) return table[0];
  const last = table.length - 1;
  if (t >= 1) return table[last];
  const x = t * last, i = x | 0;
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

// Returns write(out, at, s, lane, flow, phase, time): the vortex point at height fraction s.
function vortexShape(w, floor, waist, crown, twist) {
  const turn = twist * TAU;
  const radius = curve([[0, floor], [0.24 * w, floor * 0.667], [0.5 * w, floor * 0.3], [0.76 * w, floor * 0.08], [w, waist],
    [w + 0.3 * (1 - w), crown * 0.2], [w + 0.6 * (1 - w), crown * 0.44], [1, crown]]);
  const height = curve([[0, 0], [0.1, 0.2], [0.2, 0.8], [0.35, 2], [0.5, FORM_HEIGHT * 0.38], [0.75, FORM_HEIGHT * 0.7], [1, FORM_HEIGHT]]);
  const angle = curve([[0, 0], [0.15, 0.15 * turn], [0.25, 0.25 * turn], [0.45, 0.55 * turn], [0.6, 0.7 * turn], [0.8, 0.88 * turn], [1, turn]]);
  return (out, at, s, lane, flow, phase, time) => {
    const r = sample(radius, s), a = sample(angle, s) + lane + flow;
    const rr = r + Math.sin(s * 25 + phase + time * 0.3) * WOBBLE * r;
    out[at] = Math.cos(a) * rr;
    out[at + 1] = sample(height, s);
    out[at + 2] = Math.sin(a) * rr;
  };
}

// Column-major perspective(fov) * lookAt(eye -> target), the camera framing of the original.
function viewProj(fovDeg, aspect, eye, target) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360), near = 0.1, far = 500;
  const P = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(eye.map((x, i) => x - target[i])), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  const V = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  const M = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += P[k * 4 + r] * V[c * 4 + k];
    M[c * 4 + r] = s;
  }
  return M;
}

const TORNADO_VS = `
attribute vec3 a_pos, a_col;
uniform mat4 uMVP;
uniform float uSize;
varying vec3 v_col;
void main() {
  v_col = a_col;
  gl_Position = uMVP * vec4(a_pos, 1.0);
  gl_PointSize = max(1.0, uSize / gl_Position.w);
}`;

// uMode 0: lines, 1: soft dot, 2: comet-head glow. Reinhard (exposure 1.25) then sRGB encode,
// matching three's ReinhardToneMapping + sRGB output that the original rendered with.
const TORNADO_FS = `
precision mediump float;
uniform float uAlpha, uMode;
varying vec3 v_col;
void main() {
  float m = 1.0;
  if (uMode > 0.5) {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    m = uMode < 1.5 ? 1.0 - smoothstep(0.5, 1.0, d)
      : d < 0.3 ? mix(0.9, 0.4, d / 0.3) : d < 0.7 ? mix(0.4, 0.08, (d - 0.3) / 0.4) : mix(0.08, 0.0, (d - 0.7) / 0.3);
  }
  vec3 c = v_col * 1.25;
  c = pow(c / (1.0 + c), vec3(1.0 / 2.2)) * uAlpha * m;
  gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
}`;

export function tornado(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, depth: false, premultipliedAlpha: true });
  if (!gl) return;
  const LINES = 200, SEGS = 300, DOTS = 6000, COMETS = 10, TAIL = 19;
  const DOT_GLOW = 4.2, COMET_GLOW = 0.6, COMET_SPEED = 0.09, COMET_DELAY = 8, FLOW_SPEED = 0.1;
  const COMET = [1, 1, 1];
  const FOV = 59, TARGET = [0, FORM_HEIGHT / 2, 0];
  const dir = [3.4, -0.6, 10], dl = Math.hypot(...dir), dist = FORM_HEIGHT / 2 / Math.tan((67 * Math.PI) / 360);
  const EYE = TARGET.map((x, i) => x + (dir[i] / dl) * dist);
  const shape = vortexShape(0.5, 1150 / 60, 53 / 60, 380 / 60, 3);
  const prog = program(gl, TORNADO_VS, TORNADO_FS);
  const aPos = prog.a('a_pos'), aCol = prog.a('a_col');

  const strands = Array.from({ length: LINES }, (_, i) => ({ lane: (i / LINES) * TAU, speed: 0.95 + Math.random() * 0.1, pulse: Math.random() * TAU, phase: Math.random() * TAU }));
  const dots = Array.from({ length: DOTS }, () => ({
    s: Math.random() < 0.5 ? 0.2 + Math.random() * 0.4 : 0.05 + Math.random() * 0.9,
    strand: strands[Math.floor(Math.random() * LINES)],
    pulse: Math.random() * TAU, rate: 0.15 + Math.random() * 4.5, bright: 0.04 + Math.random() ** 1.5 * 0.96,
  }));
  const comets = Array.from({ length: COMETS }, (_, i) => ({ racing: false, idle: 0, idleFor: 0.4 + (i / COMETS) * COMET_DELAY, s: 0, speed: 0, lane: 0, pulse: 1, phase: 0, op: 0, bright: 0.7 + Math.random() * 0.3 }));

  const group = verts => ({ pos: new Float32Array(verts * 3), col: new Float32Array(verts * 3), bp: gl.createBuffer(), bc: gl.createBuffer() });
  const S = group(LINES * (SEGS - 1) * 2), Dt = group(DOTS), C = group(COMETS * TAIL), H = group(COMETS);
  const pts = new Float32Array(SEGS * 3), shade = new Float32Array(SEGS);
  const bind = (g, upload) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, g.bp);
    if (upload) gl.bufferData(gl.ARRAY_BUFFER, g.pos, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.bc);
    if (upload) gl.bufferData(gl.ARRAY_BUFFER, g.col, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
  };

  let flow = 0, clock = 1, drawn = false;
  run(canvas, gl, ({ dt, t, bw, bh, resized }) => {
    if (!dt && !resized && drawn) return;
    drawn = true;
    const fadeS = ramp(t, 0, 2), fadeD = ramp(t, 1.2, 3), fadeC = ramp(t, 3, 5);
    flow += dt * FLOW_SPEED;

    // Strands: rebuilt at 30Hz (as in the original), expanded into LINES segment pairs.
    const fresh = (clock += dt) >= 1 / 30;
    if (fresh) {
      clock = 0;
      let w = 0;
      const put = j => {
        S.pos[w] = pts[j * 3]; S.pos[w + 1] = pts[j * 3 + 1]; S.pos[w + 2] = pts[j * 3 + 2];
        S.col[w] = S.col[w + 1] = S.col[w + 2] = shade[j];
        w += 3;
      };
      for (const st of strands) {
        const alpha = Math.min(0.25 * (0.9 + 0.1 * Math.sin(t * 0.18 + st.pulse)), 0.7) * Math.min(fadeS * 3, 1);
        for (let i = 0; i < SEGS; i++) {
          const u = i / (SEGS - 1);
          shape(pts, i * 3, u, st.lane, flow * st.speed, st.phase, t);
          const edge = u < FADE_ZONE ? (u / FADE_ZONE) ** 2 : u > 1 - FADE_ZONE ? ((1 - u) / FADE_ZONE) ** 2 : 1;
          const tip = u > fadeS ? 0 : u > fadeS - 0.15 ? ((fadeS - u) / 0.15) ** 2 : 1;
          shade[i] = edge * 0.9 * tip * alpha;
        }
        for (let i = 0; i < SEGS - 1; i++) { put(i); put(i + 1); }
      }
    }

    for (let i = 0; i < DOTS; i++) {
      const d = dots[i], st = d.strand, at = i * 3;
      shape(Dt.pos, at, d.s, st.lane, flow * st.speed, st.phase, t);
      const beat = 0.08 + 0.92 * Math.max(0, Math.sin(t * d.rate + d.pulse)) ** 2.5;
      Dt.col[at] = Dt.col[at + 1] = Dt.col[at + 2] = d.bright * beat * DOT_GLOW * fadeD;
    }

    comets.forEach((c, k) => {
      if (!c.racing) {
        c.op = 0;
        if (fadeC < 0.3 || (c.idle += dt) <= c.idleFor) return;
        const home = strands[Math.floor(Math.random() * LINES)];
        Object.assign(c, { racing: true, s: RUN_LOW, speed: COMET_SPEED * (0.7 + Math.random() * 0.6), lane: home.lane, pulse: home.speed, phase: home.phase });
      }
      c.s += dt * c.speed;
      if (c.s > RUN_HIGH) {
        Object.assign(c, { racing: false, idle: 0, idleFor: COMET_DELAY * (0.6 + Math.random() * 0.8), op: 0 });
        return;
      }
      const ends = clamp((c.s - RUN_LOW) / RUN_FADE, 0, 1) * clamp((RUN_HIGH - c.s) / RUN_FADE, 0, 1);
      for (let i = 0; i < TAIL; i++) {
        const at = (k * TAIL + i) * 3;
        shape(C.pos, at, clamp(c.s - i * 0.005, 0.005, 0.995), c.lane, flow * c.pulse, c.phase, t);
        const v = c.bright * COMET_GLOW * (1 - i / TAIL) ** 2 * ends * fadeC * (i < 3 ? 1.3 : 1);
        for (let ch = 0; ch < 3; ch++) C.col[at + ch] = COMET[ch] * v;
      }
      H.pos.set(C.pos.subarray(k * TAIL * 3, k * TAIL * 3 + 3), k * 3);
      for (let ch = 0; ch < 3; ch++) H.col[k * 3 + ch] = COMET[ch] * 1.2;
      c.op = ends * 0.35 * fadeC;
    });

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive, like three's AdditiveBlending
    gl.useProgram(prog.p);
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aCol);
    gl.uniformMatrix4fv(prog.u.uMVP, false, viewProj(FOV, bw / bh, EYE, TARGET));
    const pxPerUnit = bh / (2 * Math.tan((FOV * Math.PI) / 360)); // world size -> device px at depth 1

    bind(S, fresh);
    gl.uniform1f(prog.u.uMode, 0);
    gl.uniform1f(prog.u.uAlpha, 0.5);
    gl.drawArrays(gl.LINES, 0, LINES * (SEGS - 1) * 2);

    bind(Dt, true);
    gl.uniform1f(prog.u.uMode, 1);
    gl.uniform1f(prog.u.uAlpha, 0.9 * fadeD);
    gl.uniform1f(prog.u.uSize, 0.024 * pxPerUnit);
    gl.drawArrays(gl.POINTS, 0, DOTS);

    bind(C, true);
    gl.uniform1f(prog.u.uMode, 0);
    gl.uniform1f(prog.u.uAlpha, 0.9);
    comets.forEach((c, k) => { if (c.racing) gl.drawArrays(gl.LINE_STRIP, k * TAIL, TAIL); });

    bind(H, true);
    gl.uniform1f(prog.u.uMode, 2);
    gl.uniform1f(prog.u.uSize, 0.35 * pxPerUnit);
    comets.forEach((c, k) => { if (c.op > 0) { gl.uniform1f(prog.u.uAlpha, c.op); gl.drawArrays(gl.POINTS, k, 1); } });
  });
}
