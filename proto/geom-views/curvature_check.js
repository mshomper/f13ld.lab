// F13LD.lab · Geometry tab curvature check (v0.35.0): is curvature baked from the viewer's field
// accurate?  Runs the real labBakeCurvature (14f-geom-curvature.js since v0.36.0), then reads it as the
// shader does (trilinear at the surface point).  Run: node proto/geom-views/curvature_check.js (from any folder)
const path = require('path');
const { labBakeCurvature, labBakeCompDistance, labBakeCompCurvature } = require(path.join(__dirname, '..', '..', '14f-geom-curvature.js'));
const TAU = 2 * Math.PI;

function grid(f, N) {
  const d = new Float32Array(N * N * N);
  for (let k = 0, o = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++, o++) d[o] = f((i + .5) / N * TAU - Math.PI, (j + .5) / N * TAU - Math.PI, (k + .5) / N * TAU - Math.PI);
  return d;
}
/* read channel c (0 mean, 1 Gaussian) of the bake, trilinear */
function reader(bake, N, c) {
  const m = n => ((n % N) + N) % N, g = (I, J, K) => bake[2 * (m(I) + m(J) * N + m(K) * N * N) + c], l = (p, q, t) => p + (q - p) * t;
  return (x, y, z) => {
    const u = (x + Math.PI) / TAU * N - .5, v = (y + Math.PI) / TAU * N - .5, w = (z + Math.PI) / TAU * N - .5;
    const i = Math.floor(u), j = Math.floor(v), k = Math.floor(w), a = u - i, b = v - j, e = w - k;
    return l(l(l(g(i, j, k), g(i + 1, j, k), a), l(g(i, j + 1, k), g(i + 1, j + 1, k), a), b), l(l(g(i, j, k + 1), g(i + 1, j, k + 1), a), l(g(i, j + 1, k + 1), g(i + 1, j + 1, k + 1), a), b), e);
  };
}

/* the formula on an analytic field: the truth */
function curvature(F, x, y, z, h) {
  const s = (a, b, c) => F(x + a * h, y + b * h, z + c * h), f0 = F(x, y, z);
  const xp = s(1, 0, 0), xm = s(-1, 0, 0), yp = s(0, 1, 0), ym = s(0, -1, 0), zp = s(0, 0, 1), zm = s(0, 0, -1);
  const gx = (xp - xm) / (2 * h), gy = (yp - ym) / (2 * h), gz = (zp - zm) / (2 * h), i2 = 1 / (h * h), i4 = i2 / 4;
  const xx = (xp - 2 * f0 + xm) * i2, yy = (yp - 2 * f0 + ym) * i2, zz = (zp - 2 * f0 + zm) * i2;
  const xy = (s(1, 1, 0) - s(1, -1, 0) - s(-1, 1, 0) + s(-1, -1, 0)) * i4;
  const xz = (s(1, 0, 1) - s(1, 0, -1) - s(-1, 0, 1) + s(-1, 0, -1)) * i4;
  const yz = (s(0, 1, 1) - s(0, 1, -1) - s(0, -1, 1) + s(0, -1, -1)) * i4;
  const g2 = gx * gx + gy * gy + gz * gz, g = Math.sqrt(g2);
  const gHg = gx * gx * xx + gy * gy * yy + gz * gz * zz + 2 * (gx * gy * xy + gx * gz * xz + gy * gz * yz);
  return {
    H: (g2 * (xx + yy + zz) - gHg) / (2 * g2 * g),
    K: (gx * gx * (yy * zz - yz * yz) + gy * gy * (xx * zz - xz * xz) + gz * gz * (xx * yy - xy * xy) + 2 * (gx * gy * (xz * yz - xy * zz) + gy * gz * (xy * xz - yz * xx) + gx * gz * (xy * yz - xz * yy))) / (g2 * g2)
  };
}

function surfacePoints(f, c, n) {
  let s = 1; const r = () => (s = (s * 16807) % 2147483647) / 2147483647, out = [];
  while (out.length < n) {
    let p = [r() * TAU - Math.PI, r() * TAU - Math.PI, r() * TAU - Math.PI], ok = false;
    for (let it = 0; it < 30; it++) {
      const e = 1e-4, v = f(...p) - c;
      const g = [(f(p[0] + e, p[1], p[2]) - f(p[0] - e, p[1], p[2])) / (2 * e), (f(p[0], p[1] + e, p[2]) - f(p[0], p[1] - e, p[2])) / (2 * e), (f(p[0], p[1], p[2] + e) - f(p[0], p[1], p[2] - e)) / (2 * e)];
      const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2]; if (g2 < 1e-6) break;
      p = p.map((q, i) => q - v * g[i] / g2);
      if (Math.abs(v) < 1e-9) { ok = true; break; }
    }
    if (ok && p.every(q => Math.abs(q) < Math.PI)) out.push(p);
  }
  return out;
}

let fails = 0;
const check = (name, value, limit, unit) => { const ok = value <= limit; if (!ok) fails++; console.log((ok ? 'pass  ' : 'FAIL  ') + name + ': ' + value.toFixed(1) + unit + ' (limit ' + limit + unit + ')'); };

const gyroid = (x, y, z) => Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x);
const schwarzP = (x, y, z) => Math.cos(x) + Math.cos(y) + Math.cos(z);

// C1 — TPMS at the viewer's 48³.  Errors as RMS, on the surface's curvature scale.
for (const [name, f, c] of [['gyroid level 0', gyroid, 0], ['gyroid level 0.6', gyroid, .6], ['Schwarz P level 0', schwarzP, 0]]) {
  const pts = surfacePoints(f, c, 1500), truth = pts.map(p => curvature(f, ...p, 2e-3));
  const scale = Math.sqrt(truth.reduce((a, t) => a + Math.max(t.H * t.H - t.K, 0) + t.H * t.H, 0) / pts.length);
  const Krms = Math.sqrt(truth.reduce((a, t) => a + t.K * t.K, 0) / pts.length);
  const bake = labBakeCurvature(grid(f, 48), 48), RH = reader(bake, 48, 0), RK = reader(bake, 48, 1); let eH = 0, eK = 0;
  pts.forEach((p, i) => { eH += (RH(...p) - truth[i].H) ** 2; eK += (RK(...p) - truth[i].K) ** 2; });
  check('C1 ' + name + ' mean', 100 * Math.sqrt(eH / pts.length) / scale, 1, ' %');
  check('C1 ' + name + ' Gaussian', 100 * Math.sqrt(eK / pts.length) / Krms, 2, ' %');
}

// C2 — strut (cylinder distance field), mean curvature 1/(2r), at 48³ and the 96³ fine grid.
for (const N of [48, 96]) for (const rv of [2, 4, 8]) {
  const r = rv * TAU / N, R = reader(labBakeCurvature(grid((x, y) => Math.hypot(x, y) - r, N), N), N, 0); let s = 0, s2 = 0; const n = 300;
  for (let i = 0; i < n; i++) { const a = i * 2.4, H = R(r * Math.cos(a), r * Math.sin(a), (i / n - .5) * 2); s += H; s2 += H * H; }
  const m = s / n;
  check('C2 strut N=' + N + ' r=' + rv + ' texels, bias', Math.abs(100 * m * 2 * r - 100), 4, ' %');
  check('C2 strut N=' + N + ' r=' + rv + ' texels, scatter', 100 * Math.sqrt(Math.max(s2 / n - m * m, 0)) * 2 * r, 6, ' %');
}

// C3 — the bake's speed on the 96³ fine grid (it runs on the page, the first time curvature is shown).
{
  const d = grid(gyroid, 96), t0 = Date.now(); labBakeCurvature(d, 96); const ms = Date.now() - t0;
  check('C3 bake at 96³', ms, 150, ' ms');
}

// C4 (v0.35.1) — PI-TPMS and normalized shells at the viewer's 48³: curvature of their own distance,
// baked from the 32-bit field (labBakeCompDistance + labBakeCurvature), against the analytic distance.
// For comparison, the v0.35.0 path: a one-texel stencil on the distance rebuilt from the stored
// 16-bit texture, as the shader did.  Errors as RMS on the surface's curvature scale.
{
  const N = 48, h = TAU / N;
  const gG = (x, y, z) => [Math.cos(x) * Math.cos(y) - Math.sin(z) * Math.sin(x), -Math.sin(x) * Math.sin(y) + Math.cos(y) * Math.cos(z), -Math.sin(y) * Math.sin(z) + Math.cos(z) * Math.cos(x)];
  const len = g => Math.hypot(g[0], g[1], g[2]);
  const cases = [
    { name: 'normalized gyroid shell, t 0.3', u: { topoMode: 0, normMode: 1, isoLevel: 0, thickness: 0.3 } },
    { name: 'normalized gyroid shell, t 0.15', u: { topoMode: 0, normMode: 1, isoLevel: 0.2, thickness: 0.15 } },
    { name: 'PI gyroid, normalized, r 0.35', u: { topoMode: 3, normMode: 2, isoLevel: 0, pipeR: 0.35, pipeOffset: [0.5 * Math.PI, 0.3, 0.7], pairMode: 0 }, same: true },
    { name: 'PI gyroid, plain, r 0.4', u: { topoMode: 3, normMode: 0, isoLevel: 0, pipeR: 0.4, pipeOffset: [Math.PI, 0, 0], pairMode: 0 } }
  ];
  /* the shader's implicit0 for these modes, on any field sampler F and gradient G */
  const implicit = (u, F, G) => (x, y, z) => {
    if (u.topoMode > 2.5) {
      const o = u.pipeOffset, a = F(x, y, z) - u.isoLevel, b = F(x + o[0], y + o[1], z + o[2]) - u.isoLevel;
      if (u.normMode < 1.5) return Math.max(Math.abs(a), Math.abs(b)) - u.pipeR;
      const gA = G(x, y, z), gB = G(x + o[0], y + o[1], z + o[2]), mA = Math.max(len(gA), .08), mB = Math.max(len(gB), .08);
      const dA = a / mA, dB = b / mB, ca = Math.max(-.95, Math.min(.95, (gA[0] * gB[0] + gA[1] * gB[1] + gA[2] * gB[2]) / (mA * mB)));
      return Math.sqrt(Math.max(dA * dA - 2 * ca * dA * dB + dB * dB, 0) / (1 - ca * ca)) - u.pipeR;
    }
    return Math.abs(F(x, y, z) - u.isoLevel) / Math.max(len(G(x, y, z)), .08) - u.thickness;
  };
  /* the stored texture: field normalized to 0..1 and rounded to half precision, read trilinear */
  const toHalf = v => { if (v <= 0) return 0; const e = Math.floor(Math.log2(v)), s = Math.pow(2, Math.max(e, -14) - 10); return Math.round(v / s) * s; };
  const field = grid(gyroid, N); let lo = Infinity, hi = -Infinity; for (const v of field) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const tex = Float32Array.from(field, v => toHalf((v - lo) / (hi - lo)));
  const R16 = reader(Float32Array.from({ length: 2 * N * N * N }, (_, i) => i % 2 ? 0 : tex[i >> 1]), N, 0);
  const F16 = (x, y, z) => R16(x, y, z) * (hi - lo) + lo, e = 0.75 * h;
  const G16 = (x, y, z) => [(F16(x + e, y, z) - F16(x - e, y, z)) / (2 * e), (F16(x, y + e, z) - F16(x, y - e, z)) / (2 * e), (F16(x, y, z + e) - F16(x, y, z - e)) / (2 * e)];
  /* the plain PI pipe is square in section: real edges where |a| = |b|, unbounded curvature there.
     Keep points more than a texel and a half (in field units) from an edge. */
  const awayFromEdge = u => u.topoMode > 2.5 && u.normMode < 1.5
    ? p => { const o = u.pipeOffset; return Math.abs(Math.abs(gyroid(...p) - u.isoLevel) - Math.abs(gyroid(p[0] + o[0], p[1] + o[1], p[2] + o[2]) - u.isoLevel)) > 1.5 * h; }
    : () => true;
  /* a surface point about one texel away, along the surface: speckle is texel-scale */
  const neighbour = (F, p) => {
    const e = 1e-4, g = [(F(p[0] + e, p[1], p[2]) - F(p[0] - e, p[1], p[2])) / (2 * e), (F(p[0], p[1] + e, p[2]) - F(p[0], p[1] - e, p[2])) / (2 * e), (F(p[0], p[1], p[2] + e) - F(p[0], p[1], p[2] - e)) / (2 * e)];
    const a = Math.abs(g[0]) < .9 * len(g) ? [1, 0, 0] : [0, 1, 0], t = [g[1] * a[2] - g[2] * a[1], g[2] * a[0] - g[0] * a[2], g[0] * a[1] - g[1] * a[0]], tl = len(t);
    let q = p.map((v, i) => v + h * t[i] / tl);
    for (let it = 0; it < 20; it++) {
      const v = F(...q), gq = [(F(q[0] + e, q[1], q[2]) - F(q[0] - e, q[1], q[2])) / (2 * e), (F(q[0], q[1] + e, q[2]) - F(q[0], q[1] - e, q[2])) / (2 * e), (F(q[0], q[1], q[2] + e) - F(q[0], q[1], q[2] - e)) / (2 * e)];
      const g2 = gq[0] ** 2 + gq[1] ** 2 + gq[2] ** 2; if (g2 < 1e-9) break; q = q.map((w, i) => w - v * gq[i] / g2); if (Math.abs(v) < 1e-9) break;
    }
    return q;
  };
  for (const c of cases) {
    const truthF = implicit(c.u, gyroid, gG), keep = awayFromEdge(c.u);
    const pts = surfacePoints(truthF, 0, 2400).filter(keep).slice(0, 800), nbr = pts.map(p => neighbour(truthF, p));
    const H0 = p => curvature(truthF, ...p, 2e-3).H, truth = pts.map(H0), truthN = nbr.map(H0);
    const scale = Math.sqrt(pts.reduce((a, p) => { const t = curvature(truthF, ...p, 2e-3); return a + Math.max(t.H * t.H - t.K, 0) + t.H * t.H; }, 0) / pts.length);
    const t0 = Date.now(), bk = labBakeCompCurvature(field, null, N, c.u), ms = Date.now() - t0;
    /* read as the shader does (21 buildLabGeomFS, curvc) */
    const st = bk.rgba ? 4 : 2, rd = ch => reader(Float32Array.from({ length: 2 * N * N * N }, (_, i) => i % 2 ? 0 : bk.data[st * (i >> 1) + ch]), N, 0);
    const RA = rd(0), RB = bk.rgba ? rd(2) : null, sg = v => v >= 0 ? 1 : -1;
    const readNew = p => {
      if (bk.rgba) { const o = c.u.pipeOffset, a = gyroid(...p) - c.u.isoLevel, b = gyroid(p[0] + o[0], p[1] + o[1], p[2] + o[2]) - c.u.isoLevel; return Math.abs(a) >= Math.abs(b) ? sg(a) * RA(...p) : sg(b) * RB(...p); }
      return (c.u.topoMode > 2.5 ? 1 : sg(gyroid(...p) - c.u.isoLevel)) * RA(...p);
    }, oldF = implicit(c.u, F16, G16), readOld = p => Math.max(-1 / h, Math.min(1 / h, curvature(oldF, ...p, h).H));
    const stats = read => {
      let e = 0, s = 0;
      pts.forEach((p, i) => { const r = read(p); e += (r - truth[i]) ** 2; s += ((r - read(nbr[i])) - (truth[i] - truthN[i])) ** 2; });
      return { err: 100 * Math.sqrt(e / pts.length) / scale, speckle: 100 * Math.sqrt(s / pts.length) / scale };
    };
    const sn = stats(readNew), so = stats(readOld);
    console.log('      C4 ' + c.name + ' (' + pts.length + ' points): error ' + sn.err.toFixed(1) + ' %, speckle ' + sn.speckle.toFixed(1) + ' %  |  v0.35.0 stencil: error ' + so.err.toFixed(1) + ' %, speckle ' + so.speckle.toFixed(1) + ' %  |  bake ' + ms + ' ms');
    /* normalized PI: its texel-scale roughness comes from the grid (a distance built from the field's
       gradient, then differenced twice), not from the stored texture, so the bake only has to match it */
    if (c.same) check('C4 ' + c.name + ' speckle no worse than the old + 0.5 pt', sn.speckle - so.speckle, 0.5, ' pt');
    else check('C4 ' + c.name + ' speckle, at most half the old', 100 * sn.speckle / Math.max(so.speckle, 1e-9), 50, ' % of old');
    check('C4 ' + c.name + ' error no worse than the old + 1 pt', sn.err - so.err, 1, ' pt');
    check('C4 ' + c.name + ' bake time', ms, 100, ' ms');
  }
}

console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
