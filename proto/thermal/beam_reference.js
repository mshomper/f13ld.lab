/* BCC beam N = 128 thermal reference (docs/THERMAL_SCOPE.md §11.4 †).
     node --max-old-space-size=8000 proto/thermal/beam_reference.js [N ...]
   Default N = 32 64 128.  Ti-6Al-4V (6.7) and copper (400) in air (0.027).
   Prints κ_x per grid and writes proto/thermal/beam_reference.json. */
var fs = require('fs'), path = require('path');
var S = path.resolve(__dirname, '../..');
global.window = global; global.document = { getElementById: function () { return null; }, baseURI: 'http://x/' };
global.performance = require('perf_hooks').performance;
(0, eval)(['12b-fft-cpu.js', '14-rasterizer.js', '14a-connectivity.js', '13-kernels.js', '13b-kernels-new.js',
  '13c-import-kernel.js', '13d-foam-kernel.js', '14c-stl-import.js', '15-demo-recipes.js', '15b-demo-recipes-new.js',
  '14e-link-field.js', '17a-thermal-cpu-ref.js']
  .map(function (f) { return fs.readFileSync(S + '/' + f, 'utf8'); }).join('\n'));
var grids = process.argv.slice(2).map(Number).filter(Boolean);
if (!grids.length) grids = [32, 64, 128];
var out = [];
grids.forEach(function (N) {
  [['Ti/air', 6.7], ['Cu/air', 400]].forEach(function (m) {
    var t0 = Date.now(), R = homogenizeThermalCPU(DEMO_RECIPES.beamBCC, N, { kS: m[1], kF: 0.027, tol: 1e-8 });
    var row = { design: 'beamBCC', filler: m[0], N: N, kx: +R.K[0].toFixed(5), ky: +R.K[4].toFixed(5), kz: +R.K[8].toFixed(5),
      iters: R.perLC.map(function (p) { return p.iters + (p.converged ? '' : '!'); }).join('/'), s: +((Date.now() - t0) / 1000).toFixed(1) };
    out.push(row); console.log(JSON.stringify(row));
  });
});
fs.writeFileSync(path.join(__dirname, 'beam_reference.json'), JSON.stringify(out, null, 1));
