/* STL import validation (node).  Generate the STLs first:
     OUT=/tmp/stl/ python3 genstl.py            (needs numpy + scikit-image)
   then:
     D=/tmp/stl node --max-old-space-size=6000 run_tests.js [elastic]
   Prints the import report for every test file; with "elastic" also runs the
   CPU elastic reference (N=64) and FE buckling (N=32) against native recipes. */
var fs = require('fs'), path = require('path');
var S = process.env.SRC || path.resolve(__dirname, '../..'), D = process.env.D || 'stl';
global.window = global; global.document = { getElementById: function () { return null; }, baseURI: 'http://x/' };
global.performance = require('perf_hooks').performance;
(0, eval)(['18-stokes-cpu-ref.js', '14-rasterizer.js', '14a-connectivity.js', '13-kernels.js', '13b-kernels-new.js',
  '13c-import-kernel.js', '14c-stl-import.js', '15-demo-recipes.js', '16a-elastic-cpu-ref-full.js',
  '16c-buckling-cpu-ref.js', '16h-buckling-fe.js'].map(function (f) { return fs.readFileSync(S + '/' + f, 'utf8'); }).join('\n'));
var MAT = { Es_MPa: 110000, nu: 0.34 };
function load(f, st) {
  var buf = fs.readFileSync(D + '/' + f);
  return buildImportGridFromStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), st || {});
}
function show(f, st) {
  var r = load(f, st);
  if (!r.ok) { console.log(f, 'REFUSED:', r.error, '-', r.message); return null; }
  var p = r.report;
  console.log(f, (p.ms / 1000).toFixed(1) + 's', 'cell', p.cellMm.toFixed(3), 'stretch', (p.mismatch * 100).toFixed(2) + '%',
    'rho', p.density.toFixed(4), 'face', p.faceMatch.map(function (x) { return (x * 100).toFixed(1); }).join('/'),
    'agree', (p.fillAgreement * 100).toFixed(2) + '%', 'thin', p.thinnestWallMm.toFixed(3), 'open', p.health.openEdges, 'watertight', p.health.watertight);
  registerImportGrid({ hash: f + JSON.stringify(st || {}), n: r.n, R: r.R, bytes: r.bytes });
  return { family: 'import', import: { hash: f + JSON.stringify(st || {}) }, geometry: { mode: 'solid', offset: 0, cellSizeMm: r.cellMm }, material: MAT };
}
var P = show('schwarzP_5mm.stl'), G = show('gyroid_sheet_t03.stl'), L = show('sc_lattice_r012.stl'), T = show('two_networks.stl');
show('schwarzP_offperiod.stl'); show('schwarzP_holes.stl');
show('schwarzP_5mm_inch.stl', { units: 'in' }); show('schwarzP_5mm_shifted.stl');
show('schwarzP_5mm.stl', { cellMode: 'set', cellMm: 4 });
if (fs.existsSync(D + '/schwarzP_x101.stl')) { show('schwarzP_x101.stl'); show('schwarzP_x103.stl'); }
var pc = periodicComponents(buildVoxels('import', ImportKernel.parseRecipe(T), 0, 64, 'solid'), 64);
console.log('two networks: components', pc.count, 'wraps', pc.wraps.slice(1).join(','));
if (process.argv[2] === 'elastic') {
  var pN = JSON.parse(JSON.stringify(DEMO_SCHWARZ_P)); pN.material = MAT;
  var gN = { family: 'tpms', surface: { type: 'terms', terms: [
    { on: true, coef: 1, factors: [{ trig: 'sin(x)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
    { on: true, coef: 1, factors: [{ trig: 'sin(y)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] },
    { on: true, coef: 1, factors: [{ trig: 'sin(z)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] }] },
    geometry: { mode: 'shell', offset: 0, wallThickness: 0.3 }, material: MAT };
  [[P, pN, 'Schwarz P'], [G, gN, 'gyroid sheet']].forEach(function (c) {
    var a = homogenizeFullCPU(c[0], 64, {}), b = homogenizeFullCPU(c[1], 64, {});
    function pct(x, y) { return ((x - y) / y * 100).toFixed(2) + '%'; }
    console.log(c[2], 'N=64 rho', pct(a.rho, b.rho), 'Ex', pct(a.Ex, b.Ex), 'Ez', pct(a.Ez, b.Ez), 'Gxy', pct(a.Gxy, b.Gxy));
    var ba = homogenizeBucklingFE(c[0], 32, { axes: [2] }).perAxis[0], bb = homogenizeBucklingFE(c[1], 32, { axes: [2] }).perAxis[0];
    console.log('  buckling zz N=32', pct(ba.lambda, bb.lambda));
  });
  var e = homogenizeFullCPU(L, 64, {});
  console.log('SC lattice Ez/Es', (e.Ez / 110000).toFixed(4), 'vs strut area fraction', (Math.PI * 0.12 * 0.12).toFixed(4), 'Gxy/Es', (e.Gxy / 110000).toFixed(5));
}
