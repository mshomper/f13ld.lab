/* Thermal Phase 0 validation (node), docs/THERMAL_SCOPE.md §4 and §11.
     node --max-old-space-size=6000 proto/thermal/run_tests.js [quick]
   T1/T2 grid-aligned laminates (exact), T2b inclined laminates (exact; the
   first face-based scheme alongside), T3 dilute spheres (Maxwell), T4 demo
   designs inside the Hashin–Shtrikman bounds + iteration counts (air /
   water / tissue), T6 sheet gyroid toward 2φ/3, T7 cubic struts toward the
   strut area fraction, T8 grid convergence: composite voxels vs the 0/1
   staircase vs the face-based scheme.  "quick" skips the N = 64 runs. */
var fs = require('fs'), path = require('path');
var S = process.env.SRC || path.resolve(__dirname, '../..');
global.window = global; global.document = { getElementById: function () { return null; }, baseURI: 'http://x/' };
global.performance = require('perf_hooks').performance;
(0, eval)(['12b-fft-cpu.js', '14-rasterizer.js', '14a-connectivity.js', '13-kernels.js', '13b-kernels-new.js',
  '13c-import-kernel.js', '13d-foam-kernel.js', '14c-stl-import.js', '15-demo-recipes.js', '15b-demo-recipes-new.js', '14e-link-field.js', '17a-thermal-cpu-ref.js', 'proto/thermal/faces-tpfa.js']
  .map(function (f) { return fs.readFileSync(S + '/' + f, 'utf8'); }).join('\n'));
var quick = process.argv[2] === 'quick';
var PI = Math.PI, TWO = 2 * PI;
function wrap(d) { d = (d + PI) % TWO; if (d < 0) d += TWO; return d - PI; }
/* link field for an analytic margin function (solid ⟺ fn > 0) */
function fieldFromFn(fn, N, staircase) {
  var h = TWO / N, N3 = N * N * N, kept = new Float32Array(N3), mC = new Float32Array(N3);
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    var id = i * N * N + j * N + k;
    kept[id] = fn(-PI + (i + .5) * h, -PI + (j + .5) * h, -PI + (k + .5) * h) > 0 ? 1 : 0;
    mC[id] = fn(-PI + i * h, -PI + j * h, -PI + k * h);
  }
  return voxelTensorsFromMargin({ m: mC, fn: fn }, N, kept, kept, { staircase: !!staircase });
}
function facesFromFn(fn, N) {
  var h = TWO / N, N3 = N * N * N, kept = new Float32Array(N3), mC = new Float32Array(N3);
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    var id = i * N * N + j * N + k;
    kept[id] = fn(-PI + (i + .5) * h, -PI + (j + .5) * h, -PI + (k + .5) * h) > 0 ? 1 : 0;
    mC[id] = fn(-PI + i * h, -PI + j * h, -PI + k * h);
  }
  return linkFieldFacesFromFn(fn, N, kept, kept, mC, {});
}
function pct(a, b) { return ((a / b - 1) * 100).toFixed(3) + ' %'; }
function its(R) { return R.perLC.map(function (p) { return p.iters + (p.converged ? '' : '!'); }).join('/'); }
var out = [];
function row(o) { out.push(o); console.log(JSON.stringify(o)); }

/* T1 / T2 — slab normal z, quarter of the cell, contrast 100 */
(function () {
  var N = 16, h = TWO / N, kS = 1, kF = 0.01, phi = 0.25;
  [['T1 laminate on faces', 0], ['T2 laminate offset 0.3 voxel', 0.3], ['T2 laminate offset 0.5 voxel', 0.5]].forEach(function (c) {
    var z0 = -PI + 8 * h + c[1] * h, fn = function (x, y, z) { return phi * PI - Math.abs(wrap(z - z0)); };
    [false, true].forEach(function (st) {
      var R = solveThermalCPU(fieldFromFn(fn, N, st), kS, kF, { tol: 1e-10 });
      var par = phi * kS + (1 - phi) * kF, ser = 1 / (phi / kS + (1 - phi) / kF);
      row({ test: c[0] + (st ? ' · staircase' : ''), N: N, Kxx_err: pct(R.K[0], par), Kzz_err: pct(R.K[8], ser), iters: its(R), asym: R.asym.toExponential(1) });
    });
  });
})();

/* T2b — inclined laminates (normal (1,1,0) and (1,1,1)), N = 32, contrast 100.
   Exact: K = k_par (I − n nᵀ) + k_ser n nᵀ.  Wall thickness in voxels shown. */
(function () {
  var N = 32, kS = 1, kF = 0.01;
  [[[1, 1, 0], 0.1], [[1, 1, 0], 0.25], [[1, 1, 1], 0.1], [[1, 1, 1], 0.25]].forEach(function (c) {
    var nv = c[0], phi = c[1], nn = Math.sqrt(nv[0] * nv[0] + nv[1] * nv[1] + nv[2] * nv[2]);
    var fn = function (x, y, z) { return phi * PI - Math.abs(wrap(nv[0] * x + nv[1] * y + nv[2] * z - 0.37)); };
    var par = phi * kS + (1 - phi) * kF, ser = 1 / (phi / kS + (1 - phi) / kF), nx2 = nv[0] * nv[0] / (nn * nn);
    var exx = par + (ser - par) * nx2, exy = (ser - par) * nv[0] * nv[1] / (nn * nn);
    var tv = (phi * TWO / nn) / (TWO / N);
    var R = solveThermalCPU(fieldFromFn(fn, N), kS, kF, { tol: 1e-10 });
    var F = solveThermalFacesCPU(facesFromFn(fn, N), kS, kF, { tol: 1e-10 });
    row({ test: 'T2b laminate normal (' + nv.join(',') + ') φ=' + phi, N: N, wall_voxels: +tv.toFixed(2), Kxx_err: pct(R.K[0], exx), Kxy_err: pct(R.K[1], exy),
          faces_Kxx_err: pct(F.K[0], exx), iters: its(R) });
  });
})();

/* T3 — one sphere per cell (simple cubic), dilute, vs Maxwell */
(function () {
  var N = 32;
  [[0.01, 10, 1], [0.03, 10, 1], [0.03, 0.1, 1], [0.05, 0.1, 1]].forEach(function (c) {
    var phi = c[0], r = Math.cbrt(phi * TWO * TWO * TWO * 3 / (4 * PI)), ki = c[1], km = c[2];
    var fn = function (x, y, z) { return r - Math.sqrt(x * x + y * y + z * z); };
    var R = solveThermalCPU(fieldFromFn(fn, N), ki, km, { tol: 1e-10 });
    var mx = km * (1 + 3 * phi * (ki - km) / (ki + 2 * km - phi * (ki - km)));
    row({ test: 'T3 sphere φ=' + phi + ' k_in/k_out=' + (ki / km), N: N, K_err_vs_Maxwell: pct(R.K[0], mx), iters: its(R) });
  });
})();

/* T4 — demo designs, Ti-6Al-4V (6.7) in air / water / tissue */
(function () {
  var rows = runThermalCPUCheck(32);
  rows.forEach(function (r) { row(Object.assign({ test: 'T4 HS envelope + iterations' }, r)); });
})();

/* T6 — sheet gyroid, empty pores (filler 1e-6 kS), toward 2φ/3 */
function gyroidSheet(c) {
  return { family: 'tpms', surface: { type: 'terms', terms: [
    { on: true, coef: 1, factors: [{ trig: 'sin(x)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
    { on: true, coef: 1, factors: [{ trig: 'sin(y)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] },
    { on: true, coef: 1, factors: [{ trig: 'sin(z)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] }] },
    geometry: { mode: 'shell', offset: 0, wallThickness: c, cellSizeMm: 5 }, material: { Es_MPa: 110000, nu: 0.3, ks_WmK: 1 } };
}
(function () {
  var grids = quick ? [32] : [32, 64];
  [0.1, 0.2, 0.35].forEach(function (c) {
    grids.forEach(function (N) {
      var R = homogenizeThermalCPU(gyroidSheet(c), N, { kS: 1, kF: 1e-6, tol: 1e-9 });
      var phi = R.rhoPhi, kmean = (R.K[0] + R.K[4] + R.K[8]) / 3;
      row({ test: 'T6 sheet gyroid c=' + c + ' (island trim on)', N: N, solid_pct: +(phi * 100).toFixed(2), k_over_kS: +kmean.toFixed(5), ratio_to_2phi_3: +(kmean / (2 * phi / 3)).toFixed(4),
            ratio_to_HS: +(kmean / thermalHSUpper(phi, 1, 1e-6)).toFixed(4), iters: its(R) });
    });
  });
  /* the thinnest sheet at N = 32 is broken into islands by the 0/1 trim; without it: */
  var R0 = homogenizeThermalCPU(gyroidSheet(0.1), 32, { kS: 1, kF: 1e-6, tol: 1e-9, connectivity: 'off' }), k0 = (R0.K[0] + R0.K[4] + R0.K[8]) / 3;
  row({ test: 'T6 sheet gyroid c=0.1 (island trim off)', N: 32, solid_pct: +(R0.rhoPhi * 100).toFixed(2), k_over_kS: +k0.toFixed(5), ratio_to_2phi_3: +(k0 / (2 * R0.rhoPhi / 3)).toFixed(4),
        ratio_to_HS: +(k0 / thermalHSUpper(R0.rhoPhi, 1, 1e-6)).toFixed(4), iters: its(R0) });
})();

/* T7 — simple-cubic struts (three orthogonal cylinders), empty pores */
(function () {
  var N = 32;
  [0.25, 0.4].forEach(function (rr) {
    var fn = function (x, y, z) { return rr - Math.min(Math.sqrt(y * y + z * z), Math.sqrt(x * x + z * z), Math.sqrt(x * x + y * y)); };
    var R = solveThermalCPU(fieldFromFn(fn, N), 1, 1e-6, { tol: 1e-9 });
    var area = PI * rr * rr / (TWO * TWO);
    row({ test: 'T7 cubic struts r=' + rr + ' (' + (2 * rr / TWO * N).toFixed(1) + ' voxels across)', N: N, Kx: +R.K[0].toFixed(5), strut_area_fraction: +area.toFixed(5), ratio: +(R.K[0] / area).toFixed(4), iters: its(R) });
  });
})();

/* T8 — grid convergence, sheet gyroid in Ti/air (6.7 / 0.027 W/m·K): composite
   voxels vs the 0/1 staircase (same grid) vs the first face-based scheme.
   N = 128 references (run separately, 2026-10-07): c=0.2 → 0.5760 face-based,
   c=0.1 (trim off) → composite 0.3064, face-based 0.2856. */
(function () {
  var grids = quick ? [32] : [32, 64];
  [[0.2, 'networks'], [0.1, 'off']].forEach(function (cc) {
    grids.forEach(function (N) {
      var o = { kS: 6.7, kF: 0.027, tol: 1e-9, connectivity: cc[1] };
      var R = homogenizeThermalCPU(gyroidSheet(cc[0]), N, o);
      var Rs = homogenizeThermalCPU(gyroidSheet(cc[0]), N, Object.assign({ staircase: true }, o));
      var d = designMarginSetup(gyroidSheet(cc[0]), N, o);
      var F = solveThermalFacesCPU(linkFieldFacesFromFn(d.mg.fn, N, d.kept, d.raw, d.mg.m, {}), 6.7, 0.027, { tol: 1e-9 });
      row({ test: 'T8 sheet gyroid c=' + cc[0] + ', Ti/air, trim ' + cc[1], N: N, composite: +R.K[0].toFixed(5), staircase: +Rs.K[0].toFixed(5), faces: +F.K[0].toFixed(5),
            solid_pct: +(R.rhoPhi * 100).toFixed(3), iters: its(R), link_s: +(R.tensors.t_ms / 1000).toFixed(2) });
    });
  });
})();

fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(out, null, 1));
console.log('done · ' + out.length + ' rows → proto/thermal/results.json');
