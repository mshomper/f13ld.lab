// F13LD.lab · Geometry tab curvature check (v0.35.0): is curvature baked from the viewer's field
// accurate?  Runs the real labBakeCurvature from 21-raymarcher.js, then reads it as the shader does
// (trilinear at the surface point).  Run from the repo root: node proto/geom-views/curvature_check.js
const fs = require('fs');
const rm = fs.readFileSync('21-raymarcher.js', 'utf8').replace(/\r\n/g, '\n');
const at = rm.indexOf('function labBakeCurvature');
const labBakeCurvature = new Function(rm.slice(at, rm.indexOf('\n}\n', at) + 2) + ';return labBakeCurvature;')();
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

console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
