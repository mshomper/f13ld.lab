/* ============================================================
   F13LD.lab · validate-geometry.js   (v0.23.0 — thermal Phase 3)
   node validate-geometry.js

   Checks the sweep's geometry columns (14e-link-field.js):
     1. Sphere on a synthetic margin: area = 4πr² as the grid refines
     2. Island trim: a removed sphere adds no area
     3. TPMS solids (Schwarz P, gyroid, diamond nodal surfaces) converge
        with N and land within 1 % of the exact minimal surfaces'
        areas per cubic cell (2.3451, 3.0919, 3.8377 — the nodal level sets
        are close approximations of them)
     4. Sheet (shell) Schwarz P carries about twice the solid's area
     5. Open pore axes: an open Schwarz P solid is open on x, y, z;
        a nearly full one (isolated pores) is closed on all three
   ============================================================ */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console, Math, JSON, Float32Array, Float64Array, Uint8Array, Int8Array, Int32Array, Uint32Array, Array, Object,
              isFinite, parseFloat, parseInt, String, Number, Error, setTimeout, clearTimeout,
              document: { getElementById: () => null }, window: {}, LAB_STATE: { designs: [] } };
vm.createContext(ctx);
['13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '13d-foam-kernel.js', '14-rasterizer.js', '14a-connectivity.js',
 '14e-link-field.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f }));
const L = (src) => vm.runInContext(src, ctx);
const marginSurfaceArea = L('marginSurfaceArea'), voidOpenAxes = L('voidOpenAxes'), designGeometryMetrics = L('designGeometryMetrics');

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
}
const pct = (a, b) => ((a - b) / b * 100).toFixed(2) + ' %';

/* synthetic margin: union of spheres (cell edge = 1, centres in cell units) */
function sphereGrid(N, spheres) {
  const m = new Float32Array(N * N * N), kept = new Float32Array(N * N * N);
  const val = (x, y, z) => {
    let best = -1e9;
    for (const s of spheres) {
      let dx = x - s.c[0], dy = y - s.c[1], dz = z - s.c[2];
      dx -= Math.round(dx); dy -= Math.round(dy); dz -= Math.round(dz);
      best = Math.max(best, s.r - Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return best;
  };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
    const id = i * N * N + j * N + k;
    m[id] = val(i / N, j / N, k / N);                                   /* corners */
    kept[id] = val((i + 0.5) / N, (j + 0.5) / N, (k + 0.5) / N) > 0 ? 1 : 0;   /* centres */
  }
  return { m, kept };
}

console.log('\n1. Sphere, r = 0.3 cell');
const r = 0.3, exact = 4 * Math.PI * r * r;
let prevErr = Infinity, conv = true;
[16, 32, 64, 128].forEach(N => {
  const g = sphereGrid(N, [{ c: [0.5, 0.5, 0.5], r }]);
  const a = marginSurfaceArea(g.m, N, g.kept, null), err = Math.abs(a - exact) / exact;
  console.log('     N = ' + N + ': ' + a.toFixed(5) + ' vs ' + exact.toFixed(5) + ' (' + pct(a, exact) + ')');
  if (err > prevErr * 1.05) conv = false;
  prevErr = err;
  if (N === 64) check('sphere within 0.5 % at N = 64', err < 0.005, pct(a, exact));
});
check('sphere error falls as N grows', conv);

console.log('\n2. Island trim');
{
  const N = 64, g = sphereGrid(N, [{ c: [0.3, 0.3, 0.3], r: 0.15 }, { c: [0.75, 0.75, 0.75], r: 0.15 }]);
  const both = marginSurfaceArea(g.m, N, g.kept, null);
  const raw = g.kept, kept = Float32Array.from(raw);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++)
    if (i / N > 0.5 && j / N > 0.5 && k / N > 0.5) kept[i * N * N + j * N + k] = 0;   /* remove sphere 2 */
  const one = marginSurfaceArea(g.m, N, kept, raw), ex1 = 4 * Math.PI * 0.15 * 0.15;
  check('two spheres = 2 × 4πr²', Math.abs(both - 2 * ex1) / (2 * ex1) < 0.01, both.toFixed(4) + ' vs ' + (2 * ex1).toFixed(4));
  check('trimmed sphere adds no area', Math.abs(one - ex1) / ex1 < 0.01, one.toFixed(4) + ' vs ' + ex1.toFixed(4));
}

function tpmsRecipe(terms, mode, offset, wt) {
  return { family: 'tpms', surface: { type: 'terms', terms: terms.map(t => ({ on: true, coef: t[0], factors: t[1].map(f => ({ trig: f, fx: 1, fy: 1, fz: 1 })) })) },
           geometry: Object.assign({ mode: mode, offset: offset || 0, cellSizeMm: 5, cellMult: 1 }, wt != null ? { wallThickness: wt } : {}) };
}
const P = [[1, ['cos(x)']], [1, ['cos(y)']], [1, ['cos(z)']]];
const G = [[1, ['sin(x)', 'cos(y)']], [1, ['sin(y)', 'cos(z)']], [1, ['sin(z)', 'cos(x)']]];
const D = [[1, ['sin(x)', 'sin(y)', 'sin(z)']], [1, ['sin(x)', 'cos(y)', 'cos(z)']], [1, ['cos(x)', 'sin(y)', 'cos(z)']], [1, ['cos(x)', 'cos(y)', 'sin(z)']]];

console.log('\n3. TPMS solids (area per cell edge²)');
[['Schwarz P', P, 2.3451], ['gyroid', G, 3.0919], ['diamond', D, 3.8377]].forEach(([nm, terms, ref]) => {
  const out = [32, 64, 128].map(N => designGeometryMetrics(tpmsRecipe(terms, 'solid', 0), N, { connectivity: 'networks' }).area);
  console.log('     ' + nm + ': N 32/64/128 = ' + out.map(a => a.toFixed(4)).join(' / ') + '  (minimal surface ' + ref + ')');
  check(nm + ': 64 vs 128 within 0.5 %', Math.abs(out[1] - out[2]) / out[2] < 0.005, pct(out[1], out[2]));
  check(nm + ': within 1 % of the minimal surface', Math.abs(out[2] - ref) / ref < 0.01, pct(out[2], ref));
});

console.log('\n4. Sheet Schwarz P');
{
  const solid = designGeometryMetrics(tpmsRecipe(P, 'solid', 0), 64, { connectivity: 'networks' }).area;
  const sheet = designGeometryMetrics(tpmsRecipe(P, 'shell', 0, 0.3), 64, { connectivity: 'networks' }).area;
  console.log('     solid ' + solid.toFixed(4) + ', sheet ' + sheet.toFixed(4) + ', ratio ' + (sheet / solid).toFixed(3));
  check('sheet ≈ 2 × solid (1.9–2.1)', sheet / solid > 1.9 && sheet / solid < 2.1);
}

console.log('\n5. Open pore axes');
{
  const open = designGeometryMetrics(tpmsRecipe(P, 'solid', 0), 32, { connectivity: 'networks' });
  check('Schwarz P solid at offset 0: pores open on x, y, z', open.open.x && open.open.y && open.open.z, JSON.stringify(open.open));
  const closed = designGeometryMetrics(tpmsRecipe(P, 'solid', 2.2), 32, { connectivity: 'networks' });
  check('nearly full Schwarz P (offset 2.2): pores closed', !closed.open.x && !closed.open.y && !closed.open.z,
        JSON.stringify(closed.open) + ', solid ' + (closed.vfKept * 100).toFixed(1) + ' %');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
