/* Shared loader for the fluids Phase 0 checks (node). */
var fs = require('fs'), path = require('path');
var S = process.env.SRC || path.resolve(__dirname, '../..');
global.window = global; global.document = { getElementById: function () { return null; }, baseURI: 'http://x/' };
global.performance = require('perf_hooks').performance;
(0, eval)(['14e-link-field.js', '19f-flow-cpu-ref.js'].map(function (f) { return fs.readFileSync(S + '/' + f, 'utf8'); }).join('\n'));
var PI = Math.PI, TWO = 2 * PI;
function wrap(d) { d = (d + PI) % TWO; if (d < 0) d += TWO; return d - PI; }
/* Links for an analytic margin (solid ⟺ fn > 0).  fnLat takes LATTICE
   coordinates (node (i, j, k) centred at (i + ½, j + ½, k + ½)); the box is
   dims = [NX, NY, NZ] voxels at spacing 2π/N, N = NX. */
function linksFromLat(fnLat, dims, staircase) {
  var NX = dims[0], NY = dims[1], NZ = dims[2], N = NX, h = TWO / N, N3 = NX * NY * NZ;
  var fn = function (x, y, z) { return fnLat((x + PI) / h, (y + PI) / h, (z + PI) / h); };
  var kept = new Float32Array(N3), mC = new Float32Array(N3);
  for (var i = 0; i < NX; i++) for (var j = 0; j < NY; j++) for (var k = 0; k < NZ; k++) {
    var id = i * NY * NZ + j * NZ + k;
    kept[id] = fnLat(i + .5, j + .5, k + .5) > 0 ? 1 : 0;
    mC[id] = fnLat(i, j, k);
  }
  return buildFlowLinksFromFn(fn, N, kept, kept, mC, { staircase: !!staircase, dims: [NX, NY, NZ] });
}
/* signed periodic offset in a box of length n */
function per(d, n) { return d - n * Math.round(d / n); }
function stats(a) {
  var m = 0; a.forEach(function (v) { m += v; }); m /= a.length;
  var sd = 0, lo = Infinity, hi = -Infinity; a.forEach(function (v) { sd += (v - m) * (v - m); lo = Math.min(lo, v); hi = Math.max(hi, v); });
  return { mean: m, sd: Math.sqrt(sd / a.length), min: lo, max: hi };
}
function pct(x) { return (100 * x).toFixed(3) + ' %'; }
function emit(file, row) {
  console.log(JSON.stringify(row));
  if (file) fs.appendFileSync(file, JSON.stringify(row) + '\n');
}
module.exports = { PI: PI, TWO: TWO, wrap: wrap, per: per, stats: stats, pct: pct, emit: emit, linksFromLat: linksFromLat,
  prepareFlowDomain: prepareFlowDomain, solveFlowCPU: solveFlowCPU, flowPermeabilityCPU: flowPermeabilityCPU,
  sampleStressAt: sampleStressAt, wallShearAt: wallShearAt, FLOW_DIRS: FLOW_DIRS };
