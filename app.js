/* Slow Light — rendering core
 *
 * Pipeline (all on-device):
 *   1. analyze()   — find point sources (stars) and warm knots (star-forming regions)
 *   2. buildGL()   — upload image, mask and flow textures; fill instance buffers
 *   3. render()    — one frame at loop phase u in [0,1):
 *        a. galaxy pass: per-pixel inverse warp = differential rotation + slow flow
 *        b. sprite pass: knots and stars as additive gaussian quads (instanced)
 *   4. exportLoop() — record exactly one loop from the canvas at native size
 *
 * Every animated quantity is a function of u with an integer number of cycles,
 * so frame u=1 equals frame u=0 and the loop is seamless by construction.
 */

'use strict';

const $ = (s) => document.querySelector(s);
const canvas = $('#gl');
const stage = $('#stage');
const statusEl = $('#status');

const P = {                 // user parameters
  sweepDeg: 12,
  flowAmp: 1.7,             // px, roughly the std-dev of gas displacement
  knotGain: 1.0,
  twinkleGain: 1.0,
  density: 0.85,            // fraction of detected stars that twinkle
  loopSec: 16,
  zoom: 1.045,              // constant crop margin so warps never expose edges
};

const S = {                 // scene state
  W: 0, H: 0, bitmap: null,
  stars: null, nStars: 0,   // Float32Array, 11 floats per instance
  knots: null, nKnots: 0,
  gl: null, prog: {}, bufs: {}, tex: {}, vao: {},
  playing: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  t0: performance.now(), pauseU: 0,
  exporting: false,
};

const FLOW_NF = 4;          // flow fields per loop (each an integer share of the loop)
const FLOW_SCALE = 4.2;     // px of displacement at field value ±1, per unit of P.flowAmp
const INST_FLOATS = 11;     // x y sigma amp r g b n1 n2 ph1 ph2

// --------------------------------------------------------------------------
// Image analysis
// --------------------------------------------------------------------------

function setStatus(msg, err = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', err);
}

function boxBlur1D(src, dst, w, h, r, horizontal) {
  // running-sum box blur along one axis, edge-clamped
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        dst[row + x] = acc / (2 * r + 1);
        const xo = Math.max(0, x - r), xi = Math.min(w - 1, x + r + 1);
        acc += src[row + xi] - src[row + xo];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc / (2 * r + 1);
        const yo = Math.max(0, y - r), yi = Math.min(h - 1, y + r + 1);
        acc += src[yi * w + x] - src[yo * w + x];
      }
    }
  }
}

function boxBlur(a, w, h, r, passes = 1) {
  let src = a, dst = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    boxBlur1D(src, dst, w, h, r, true);
    boxBlur1D(dst, src, w, h, r, false);
  }
  return src;
}

function downsample(src, W, H, s) {
  // block mean to (W/s, H/s)
  const w = Math.ceil(W / s), h = Math.ceil(H / s);
  const out = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let y = 0; y < H; y++) {
    const oy = (y / s) | 0;
    for (let x = 0; x < W; x++) {
      const i = oy * w + ((x / s) | 0);
      out[i] += src[y * W + x]; cnt[i]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i];
  return { data: out, w, h };
}

function bilinear(sm, w, h, fx, fy) {
  const x = Math.min(w - 1.001, Math.max(0, fx)), y = Math.min(h - 1.001, Math.max(0, fy));
  const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
  const a = sm[y0 * w + x0], b = sm[y0 * w + x0 + 1], c = sm[(y0 + 1) * w + x0], d = sm[(y0 + 1) * w + x0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

async function analyze(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const off = ('OffscreenCanvas' in window) ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const N = W * H;

  // luminance
  const lum = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) lum[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];

  // ---- flow mask: heavily blurred luminance, so empty sky and point stars stay still
  const m8 = downsample(lum, W, H, 8);
  const maskSm = boxBlur(Float32Array.from(m8.data), m8.w, m8.h, 6, 2);
  const mask = new Uint8Array(m8.w * m8.h);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(255 * Math.min(1, Math.max(0, (maskSm[i] - 18) / 70)));

  // ---- point sources: top-hat against a smooth background, then local maxima
  const bgSm = boxBlur(Float32Array.from(m8.data), m8.w, m8.h, 2, 2);
  const top = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const fy = (y + 0.5) / 8 - 0.5;
    for (let x = 0; x < W; x++) {
      const v = lum[y * W + x] - bilinear(bgSm, m8.w, m8.h, (x + 0.5) / 8 - 0.5, fy);
      top[y * W + x] = v > 0 ? v : 0;
    }
  }
  // noise floor from blank-sky corners
  const cs = Math.min(300, W >> 3, H >> 3);
  const corner = [];
  for (const [ox, oy] of [[0, 0], [W - cs, 0], [0, H - cs], [W - cs, H - cs]])
    for (let y = oy; y < oy + cs; y++) for (let x = ox; x < ox + cs; x++) corner.push(top[y * W + x]);
  const noise = percentile(corner, 0.995);
  const THR = Math.max(9, noise * 1.35);

  const cand = [];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x, v = top[i];
      if (v <= THR) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if ((dx | dy) === 0) continue;
          if (top[i + dy * W + dx] > v) { isMax = false; break; }
        }
      if (isMax) cand.push(x, y, v);
    }
  }
  // sort by brightness, suppress neighbours on a 7px grid
  const idx = Array.from({ length: cand.length / 3 }, (_, k) => k).sort((a, b) => cand[b * 3 + 2] - cand[a * 3 + 2]);
  const GRID = 7, gw = (W / GRID | 0) + 2, gh = (H / GRID | 0) + 2;
  const occ = new Uint8Array(gw * gh);
  const MAXSTARS = 3000;
  const stars = new Float32Array(MAXSTARS * INST_FLOATS);
  let nStars = 0;
  for (const k of idx) {
    if (nStars >= MAXSTARS) break;
    const x = cand[k * 3], y = cand[k * 3 + 1], v = cand[k * 3 + 2];
    const gx = x / GRID | 0, gy = y / GRID | 0;
    if (occ[gy * gw + gx]) continue;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const yy = gy + a, xx = gx + b;
      if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) occ[yy * gw + xx] = 1;
    }
    // colour: 5x5 mean, normalised so the brightest channel is 1
    let r = 0, g = 0, b = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const j = ((y + dy) * W + (x + dx)) * 4; r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2];
    }
    const mx = Math.max(r, g, b, 1);
    const o = nStars * INST_FLOATS;
    stars[o] = x; stars[o + 1] = y;
    stars[o + 2] = Math.min(4.4, 1.8 + v / 85);                     // sigma px
    stars[o + 3] = Math.min(1, Math.max(0.14, v / 90)) * 95;         // amplitude (0-255 scale)
    stars[o + 4] = r / mx; stars[o + 5] = g / mx; stars[o + 6] = b / mx;
    const n1 = 3 + Math.floor(Math.random() * 9);                     // 3..11 cycles per loop
    stars[o + 7] = n1; stars[o + 8] = n1 + 2 + Math.floor(Math.random() * 5);
    stars[o + 9] = Math.random() * Math.PI * 2; stars[o + 10] = Math.random() * Math.PI * 2;
    nStars++;
  }

  // ---- warm knots (HII regions): red excess, connected components at 1/4 res
  const q = 4, qw = Math.ceil(W / q), qh = Math.ceil(H / q);
  const warm = new Float32Array(qw * qh), lq = new Float32Array(qw * qh), cnt = new Float32Array(qw * qh);
  for (let y = 0; y < H; y++) {
    const oy = (y / q) | 0;
    for (let x = 0; x < W; x++) {
      const j = (y * W + x) * 4, i = oy * qw + ((x / q) | 0);
      warm[i] += rgba[j] - 0.5 * rgba[j + 2] - 0.25 * rgba[j + 1];
      lq[i] += lum[y * W + x]; cnt[i]++;
    }
  }
  for (let i = 0; i < warm.length; i++) { warm[i] /= cnt[i]; lq[i] /= cnt[i]; }
  const warmB = boxBlur(warm, qw, qh, 1, 2);
  let bin = new Uint8Array(qw * qh);
  for (let i = 0; i < bin.length; i++) bin[i] = (warmB[i] > 26 && lq[i] > 55) ? 1 : 0;
  // open: erode then dilate, 3x3
  const morph = (src, keepIf) => {
    const out = new Uint8Array(src.length);
    for (let y = 1; y < qh - 1; y++) for (let x = 1; x < qw - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[(y + dy) * qw + x + dx];
      out[y * qw + x] = keepIf(s) ? 1 : 0;
    }
    return out;
  };
  bin = morph(morph(bin, (s) => s === 9), (s) => s > 0);

  const labels = new Int32Array(qw * qh);
  const comps = [];
  const stack = [];
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || labels[i]) continue;
    const id = comps.length + 1;
    let area = 0, sx = 0, sy = 0;
    stack.push(i); labels[i] = id;
    while (stack.length) {
      const c = stack.pop(); area++;
      const cy = (c / qw) | 0, cx = c - cy * qw; sx += cx; sy += cy;
      const nb = [c - 1, c + 1, c - qw, c + qw, c - qw - 1, c - qw + 1, c + qw - 1, c + qw + 1];
      for (const n of nb) if (n >= 0 && n < bin.length && bin[n] && !labels[n]) { labels[n] = id; stack.push(n); }
    }
    const fullArea = area * q * q;
    if (fullArea >= 90 && fullArea <= 90000) comps.push({ x: (sx / area + 0.5) * q, y: (sy / area + 0.5) * q, area: fullArea });
  }
  comps.sort((a, b) => b.area - a.area);
  const MAXKNOTS = 420;
  const kn = comps.slice(0, MAXKNOTS);
  const knots = new Float32Array((kn.length + 1) * INST_FLOATS);
  kn.forEach((k, i) => {
    const rad = Math.sqrt(k.area / Math.PI);
    const x = Math.round(k.x), y = Math.round(k.y);
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = (yy * W + xx) * 4; r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; n++;
    }
    const mx = Math.max(r, g, b, 1);
    const o = i * INST_FLOATS;
    knots[o] = k.x; knots[o + 1] = k.y;
    knots[o + 2] = Math.min(48, Math.max(8.8, rad * 1.15));
    knots[o + 3] = Math.min(1, Math.max(0.35, rad / 32)) * 52;
    knots[o + 4] = r / mx; knots[o + 5] = g / mx; knots[o + 6] = b / mx;
    knots[o + 7] = 2 + Math.floor(Math.random() * 4);                // 2..5 cycles per loop
    knots[o + 8] = 0; knots[o + 9] = Math.random() * Math.PI * 2; knots[o + 10] = 0;
  });
  // central bulge breathing as one very wide knot, one cycle per loop
  {
    const o = kn.length * INST_FLOATS;
    knots[o] = W / 2; knots[o + 1] = H / 2; knots[o + 2] = 0.115 * W; knots[o + 3] = 9;
    knots[o + 4] = 0.90; knots[o + 5] = 0.93; knots[o + 6] = 0.95;
    knots[o + 7] = 1; knots[o + 8] = 0; knots[o + 9] = 0; knots[o + 10] = 0;
  }

  return { W, H, stars: stars.subarray(0, nStars * INST_FLOATS), nStars, knots, nKnots: kn.length + 1, mask, maskW: m8.w, maskH: m8.h };
}

// --------------------------------------------------------------------------
// Flow fields: NF smooth random fields, upsampled, normalised to ±1
// --------------------------------------------------------------------------

function makeFlow() {
  const nw = 15, nh = 11, up = 4, ow = nw * up, oh = nh * up;
  const out = new Uint8Array(ow * oh * 4 * FLOW_NF);
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const fields = [];
  let maxAbs = 1e-6;
  for (let f = 0; f < FLOW_NF; f++) {
    for (let ch = 0; ch < 2; ch++) {
      const sm = new Float32Array(nw * nh);
      for (let i = 0; i < sm.length; i++) sm[i] = gauss();
      const smB = boxBlur(sm, nw, nh, 1, 1);
      const big = new Float32Array(ow * oh);
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) big[y * ow + x] = bilinear(smB, nw, nh, (x + 0.5) / up - 0.5, (y + 0.5) / up - 0.5);
      const bigB = boxBlur(big, ow, oh, 2, 2);
      for (let i = 0; i < bigB.length; i++) maxAbs = Math.max(maxAbs, Math.abs(bigB[i]));
      fields.push(bigB);
    }
  }
  for (let f = 0; f < FLOW_NF; f++) {
    const fx = fields[f * 2], fy = fields[f * 2 + 1];
    for (let i = 0; i < ow * oh; i++) {
      const o = (f * ow * oh + i) * 4;
      out[o] = Math.round(255 * (fx[i] / maxAbs * 0.5 + 0.5));
      out[o + 1] = Math.round(255 * (fy[i] / maxAbs * 0.5 + 0.5));
      out[o + 2] = 128; out[o + 3] = 255;
    }
  }
  return { data: out, w: ow, h: oh };
}

// --------------------------------------------------------------------------
// WebGL2
// --------------------------------------------------------------------------

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_GALAXY = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_img;
uniform sampler2D u_mask;
uniform sampler2DArray u_flow;
uniform vec2 u_size;
uniform float u_ang;       // core rotation this frame, radians
uniform float u_rc;        // rotation-curve scale radius, px
uniform float u_zoom;
uniform float u_flowAmp;   // px
uniform float u_flowPos;   // in [0, NF)
uniform float u_nf;
void main() {
  vec2 c = u_size * 0.5;
  vec2 p = v_uv * u_size;
  vec2 d = p - c;
  float r = length(d);
  float prof = 0.42 + 0.58 / (1.0 + r / u_rc);
  float a = -u_ang * prof;
  float cs = cos(a), sn = sin(a);
  vec2 s = c + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y) / u_zoom;

  float i0 = floor(u_flowPos);
  float bl = u_flowPos - i0;
  bl = bl * bl * (3.0 - 2.0 * bl);
  float l0 = mod(i0, u_nf);
  float l1 = mod(i0 + 1.0, u_nf);
  vec2 f0 = texture(u_flow, vec3(v_uv, l0)).rg * 2.0 - 1.0;
  vec2 f1 = texture(u_flow, vec3(v_uv, l1)).rg * 2.0 - 1.0;
  s += mix(f0, f1, bl) * texture(u_mask, v_uv).r * u_flowAmp * ${FLOW_SCALE.toFixed(2)};

  o = vec4(texture(u_img, s / u_size).rgb, 1.0);
}`;

const VS_SPRITE = `#version 300 es
layout(location=0) in vec2 a_corner;   // per-vertex, -1..1
layout(location=1) in vec2 a_pos;      // per-instance, source px
layout(location=2) in float a_sigma;
layout(location=3) in float a_amp;
layout(location=4) in vec3 a_col;
layout(location=5) in vec4 a_cyc;      // n1 n2 ph1 ph2
uniform vec2 u_size;
uniform float u_ang, u_rc, u_zoom, u_tau, u_kind, u_sign, u_gain;
out vec2 v_local;
out vec3 v_col;
out float v_int;
void main() {
  vec2 c = u_size * 0.5;
  vec2 d = a_pos - c;
  float r = length(d);
  float prof = 0.42 + 0.58 / (1.0 + r / u_rc);
  float a = u_ang * prof;
  float cs = cos(a), sn = sin(a);
  vec2 pc = c + u_zoom * vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
  float hs = 3.2 * a_sigma;
  vec2 p = pc + a_corner * hs;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  v_local = a_corner * 3.2;
  v_col = a_col;
  float m;
  if (u_kind < 0.5) {
    float m1 = 0.5 + 0.5 * sin(a_cyc.x * u_tau + a_cyc.z);
    float m2 = 0.5 + 0.5 * sin(a_cyc.y * u_tau + a_cyc.w);
    m = 0.40 * m1 + 0.60 * m1 * m2 - 0.18;
  } else {
    m = 0.5 + 0.5 * sin(a_cyc.x * u_tau + a_cyc.z);
  }
  v_int = max(a_amp * m * u_gain * u_sign, 0.0);
}`;

const FS_SPRITE = `#version 300 es
precision highp float;
in vec2 v_local;
in vec3 v_col;
in float v_int;
out vec4 o;
void main() {
  float g = exp(-0.5 * dot(v_local, v_local));
  o = vec4(v_col * (v_int * g / 255.0), 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

function initGL() {
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, alpha: false });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  S.gl = gl;
  S.prog.galaxy = program(gl, VS_QUAD, FS_GALAXY);
  S.prog.sprite = program(gl, VS_SPRITE, FS_SPRITE);

  // fullscreen quad
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  S.bufs.quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, S.bufs.quad); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  S.vao.quad = gl.createVertexArray();
  gl.bindVertexArray(S.vao.quad);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // sprite VAO factory: per-vertex corner + per-instance attributes
  S.bufs.corner = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, S.bufs.corner); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  S.makeSpriteVAO = (instBuf) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.bufs.corner);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const st = INST_FLOATS * 4;
    const attr = (loc, size, off) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, st, off * 4); gl.vertexAttribDivisor(loc, 1); };
    attr(1, 2, 0); attr(2, 1, 2); attr(3, 1, 3); attr(4, 3, 4); attr(5, 4, 7);
    gl.bindVertexArray(null);
    return vao;
  };

  // flow texture array is independent of the image
  const fl = makeFlow();
  S.tex.flow = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, S.tex.flow);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, fl.w, fl.h, FLOW_NF, 0, gl.RGBA, gl.UNSIGNED_BYTE, fl.data);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function tex2D(gl, target, filter) {
  const t = gl.createTexture();
  gl.bindTexture(target, t);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function buildGL(an) {
  const gl = S.gl;
  const maxT = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (an.W > maxT || an.H > maxT) throw new Error(`This device's GPU supports images up to ${maxT} px on a side; this one is ${an.W}×${an.H}. Slow Light won't downscale it.`);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  S.tex.img = tex2D(gl, gl.TEXTURE_2D, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, S.bitmap);

  S.tex.mask = tex2D(gl, gl.TEXTURE_2D, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, an.maskW, an.maskH, 0, gl.RED, gl.UNSIGNED_BYTE, an.mask);

  const up = (buf, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); };
  S.bufs.stars = S.bufs.stars || gl.createBuffer(); up(S.bufs.stars, an.stars);
  S.bufs.knots = S.bufs.knots || gl.createBuffer(); up(S.bufs.knots, an.knots);
  S.vao.stars = S.makeSpriteVAO(S.bufs.stars);
  S.vao.knots = S.makeSpriteVAO(S.bufs.knots);
}

// --------------------------------------------------------------------------
// Frame
// --------------------------------------------------------------------------

function loopPhase(now) {
  if (!S.playing) return S.pauseU;
  const t = (now - S.t0) / 1000;
  return (t / P.loopSec) % 1;
}

function render(u) {
  const gl = S.gl, W = S.W, H = S.H;
  const tau = 2 * Math.PI * u;
  const ang = (P.sweepDeg * Math.PI / 180) * 0.5 * (1 - Math.cos(tau));  // returns to 0 at u=1
  const rc = 0.35 * Math.hypot(W / 2, H / 2);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.BLEND);

  // galaxy pass
  let g = S.prog.galaxy;
  gl.useProgram(g.p);
  gl.bindVertexArray(S.vao.quad);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.tex.img);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, S.tex.mask);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, S.tex.flow);
  gl.uniform1i(g.u.u_img, 0); gl.uniform1i(g.u.u_mask, 1); gl.uniform1i(g.u.u_flow, 2);
  gl.uniform2f(g.u.u_size, W, H);
  gl.uniform1f(g.u.u_ang, ang); gl.uniform1f(g.u.u_rc, rc); gl.uniform1f(g.u.u_zoom, P.zoom);
  gl.uniform1f(g.u.u_flowAmp, P.flowAmp); gl.uniform1f(g.u.u_flowPos, u * FLOW_NF); gl.uniform1f(g.u.u_nf, FLOW_NF);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // sprite passes
  g = S.prog.sprite;
  gl.useProgram(g.p);
  gl.uniform2f(g.u.u_size, W, H);
  gl.uniform1f(g.u.u_ang, ang); gl.uniform1f(g.u.u_rc, rc); gl.uniform1f(g.u.u_zoom, P.zoom); gl.uniform1f(g.u.u_tau, tau);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);

  gl.blendEquation(gl.FUNC_ADD);
  gl.uniform1f(g.u.u_kind, 1); gl.uniform1f(g.u.u_sign, 1); gl.uniform1f(g.u.u_gain, P.knotGain);
  gl.bindVertexArray(S.vao.knots);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, S.nKnots);

  const nDraw = Math.round(P.density * S.nStars);
  if (nDraw > 0) {
    gl.uniform1f(g.u.u_kind, 0); gl.uniform1f(g.u.u_gain, P.twinkleGain);
    gl.bindVertexArray(S.vao.stars);
    gl.uniform1f(g.u.u_sign, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nDraw);
    gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);            // the dip below baseline
    gl.uniform1f(g.u.u_sign, -1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nDraw);
    gl.blendEquation(gl.FUNC_ADD);
  }
  gl.bindVertexArray(null);
}

function fitCanvas() {
  if (!S.W) return;
  const r = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(r.width / S.W, r.height / S.H);
  const cw = Math.max(1, Math.round(S.W * scale)), ch = Math.max(1, Math.round(S.H * scale));
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  const bw = Math.min(S.W, Math.round(cw * dpr)), bh = Math.min(S.H, Math.round(ch * dpr));
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
}

function frame(now) {
  if (S.W && !S.exporting) {
    fitCanvas();
    const u = loopPhase(now);
    render(u);
    $('#scrubFill').style.width = (u * 100).toFixed(2) + '%';
    $('#clock').textContent = (u * P.loopSec).toFixed(1) + ' s';
  }
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------------------
// Export: record exactly one loop from the canvas at native size
// --------------------------------------------------------------------------

function pickMime() {
  const c = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4;codecs=avc1.640033', 'video/mp4', 'video/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
}

async function exportLoop() {
  const mime = pickMime();
  if (!mime) { setStatus('This browser cannot record video. Try Chrome or Edge.', true); return; }
  S.exporting = true;
  $('#exportBtn').disabled = true;
  setStatus(`Recording one ${P.loopSec} s loop at ${S.W}×${S.H}…`);

  const prevW = canvas.width, prevH = canvas.height;
  canvas.width = S.W; canvas.height = S.H;                 // native backing store; CSS size unchanged
  const gl = S.gl;
  const fps = 30;
  const stream = canvas.captureStream(0);                   // we push frames manually
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 80_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start();

  const total = Math.round(P.loopSec * fps);
  const start = performance.now();
  for (let f = 0; f < total; f++) {
    render(f / total);
    gl.finish();
    if (track.requestFrame) track.requestFrame();
    // hold real-time pacing so the recorder timestamps land where they should
    const target = start + (f + 1) * 1000 / fps;
    const wait = target - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if ((f & 15) === 0) setStatus(`Recording… ${Math.round(100 * f / total)}%`);
  }
  await new Promise((r) => setTimeout(r, 120));
  rec.stop(); await done;
  track.stop();

  canvas.width = prevW; canvas.height = prevH;
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const name = `slow-light-${S.W}x${S.H}.${ext}`;
  try {
    const how = await saveBlob(blob, name);
    setStatus(how === 'shared'
      ? `Loop ready (${(blob.size / 1e6).toFixed(1)} MB). Choose where to keep it.`
      : `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB).`);
  } catch (e) {
    console.error(e);
    setStatus(`Recorded, but saving failed: ${e.message}`, true);
  }
  S.exporting = false;
  $('#exportBtn').disabled = false;
}

function isNativeApp() {
  const c = window.Capacitor;
  return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
}

async function saveBlob(blob, name) {
  // Inside a Capacitor app a download link does nothing, so write the file and
  // hand it to the system share sheet (Photos, Drive, Messages, ...).
  if (isNativeApp() && window.Capacitor.Plugins.Filesystem) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(new Error('Could not read the recording.'));
      r.readAsDataURL(blob);
    });
    const written = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
    if (Share) await Share.share({ title: name, url: written.uri, dialogTitle: 'Save your loop' });
    return 'shared';
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  return 'downloaded';
}

// --------------------------------------------------------------------------
// Loading and UI
// --------------------------------------------------------------------------

async function loadFile(file) {
  const looksImage = file && (file.type.startsWith('image/') || /\.(jpe?g|png|webp|tiff?|bmp|gif|avif)$/i.test(file.name || ''));
  if (!looksImage) { setStatus('That file is not an image.', true); return; }
  try {
    setStatus('Reading image…');
    const bitmap = await createImageBitmap(file);
    setStatus(`Finding stars in ${bitmap.width}×${bitmap.height}…`);
    await new Promise((r) => setTimeout(r, 20));           // let the status paint
    const an = await analyze(bitmap);
    S.bitmap = bitmap; S.W = an.W; S.H = an.H;
    S.nStars = an.nStars; S.nKnots = an.nKnots;
    buildGL(an);
    S.t0 = performance.now(); S.pauseU = 0;
    $('#empty').classList.add('hidden');
    $('#transport').classList.remove('hidden');
    $('#exportBtn').disabled = false;
    updateDensityOut();
    setStatus(`${an.nStars.toLocaleString()} stars and ${(an.nKnots - 1).toLocaleString()} star-forming regions found in ${an.W}×${an.H}.`);
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  }
}

function densityText() {
  if (!S.nStars) return '–';
  return `${Math.round(P.density * S.nStars).toLocaleString()} of ${S.nStars.toLocaleString()}`;
}
function updateDensityOut() { $('#densityOut').textContent = densityText(); }

function bindSlider(id, fmt, apply) {
  const el = $('#' + id), out = $('#' + id + 'Out');
  const upd = () => { const v = parseFloat(el.value); apply(v); out.textContent = fmt(v); };
  el.addEventListener('input', upd); upd();
}

const PRESETS = {
  calm:   { sweep: 12, flow: 1.7, knots: 100, twinkle: 100, density: 85, loop: 16 },
  alive:  { sweep: 20, flow: 2.6, knots: 160, twinkle: 150, density: 100, loop: 14 },
  stars:  { sweep: 0,  flow: 0,   knots: 0,   twinkle: 160, density: 100, loop: 12 },
  nebula: { sweep: 4,  flow: 3.2, knots: 180, twinkle: 60,  density: 40, loop: 20 },
};

function applyPreset(name) {
  const pr = PRESETS[name]; if (!pr) return;
  for (const [id, v] of Object.entries(pr)) {
    const el = $('#' + id); el.value = v; el.dispatchEvent(new Event('input'));
  }
  document.querySelectorAll('#presets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === name)));
}

function wireUI() {
  bindSlider('sweep', (v) => `${v.toFixed(1).replace(/\.0$/, '')}°`, (v) => { P.sweepDeg = v; });
  bindSlider('flow', (v) => `${v.toFixed(1)} px`, (v) => { P.flowAmp = v; });
  bindSlider('knots', (v) => `${v}%`, (v) => { P.knotGain = v / 100; });
  bindSlider('twinkle', (v) => `${v}%`, (v) => { P.twinkleGain = v / 100; });
  bindSlider('density', densityText, (v) => { P.density = v / 100; });
  bindSlider('loop', (v) => `${v} s`, (v) => {
    // keep the current phase so the loop doesn't jump when the length changes
    const u = loopPhase(performance.now());
    P.loopSec = v;
    S.t0 = performance.now() - u * v * 1000;
  });

  const file = $('#file');
  $('#openBtn').onclick = () => file.click();
  $('#openBtn2').onclick = () => file.click();
  file.onchange = () => loadFile(file.files[0]);

  ['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove('dragging'); }));
  stage.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  const playBtn = $('#playBtn');
  playBtn.onclick = () => {
    if (S.playing) { S.pauseU = loopPhase(performance.now()); S.playing = false; playBtn.textContent = 'Play'; }
    else { S.t0 = performance.now() - S.pauseU * P.loopSec * 1000; S.playing = true; playBtn.textContent = 'Pause'; }
  };
  if (!S.playing) playBtn.textContent = 'Play';

  $('#exportBtn').onclick = exportLoop;
  window.addEventListener('resize', fitCanvas);

  // presets
  document.querySelectorAll('#presets button').forEach((b) => { b.onclick = () => applyPreset(b.dataset.preset); });
  // a manual slider change means we're no longer on a preset
  document.querySelectorAll('.ctl input[type=range]').forEach((el) => el.addEventListener('pointerdown', () => {
    document.querySelectorAll('#presets button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }));

  // help dialog
  const help = $('#help');
  $('#helpLink').onclick = (e) => { e.preventDefault(); help.showModal(); };
  $('#helpClose').onclick = () => help.close();

  // keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, button') && e.key !== ' ') return;
    if (help.open) return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); playBtn.click(); break;
      case 'o': file.click(); break;
      case 'e': if (!$('#exportBtn').disabled) exportLoop(); break;
      case 'r': S.t0 = performance.now(); S.pauseU = 0; break;
    }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

try {
  initGL();
  wireUI();
  requestAnimationFrame(frame);
} catch (e) {
  console.error(e);
  setStatus(e.message, true);
}
