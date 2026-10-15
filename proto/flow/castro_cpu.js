/* F12 preview (v0.32.0): Castro et al. 2019 ranking on the Float64 CPU reference.
   node proto/flow/castro_cpu.js [N=24]   — sheet and network gyroid / Schwarz P / Schwarz D
   at 70 % porosity, flow along x.  The GPU version is runFlowCastroCheck() in 19g. */
var H = require('./harness.js'), N = +process.argv[2] || 24, PI = Math.PI;
var F = { G: function (x, y, z) { return Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x); },
  P: function (x, y, z) { return Math.cos(x) + Math.cos(y) + Math.cos(z); },
  D: function (x, y, z) { return Math.sin(x) * Math.sin(y) * Math.sin(z) + Math.sin(x) * Math.cos(y) * Math.cos(z) + Math.cos(x) * Math.sin(y) * Math.cos(z) + Math.cos(x) * Math.cos(y) * Math.sin(z); } };
var s = 2 * PI / N;
['sheet', 'network'].forEach(function (kind) {
  var k = {};
  Object.keys(F).forEach(function (n) {
    var f = F[n], vals = [];
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var l = 0; l < N; l++) { var v = f((i + .5) * s, (j + .5) * s, (l + .5) * s); vals.push(kind === 'sheet' ? Math.abs(v) : v); }
    vals.sort(function (a, b) { return a - b; });
    var c = 0.5 * (vals[Math.round(0.3 * vals.length) - 1] + vals[Math.round(0.3 * vals.length)]);
    /* fluid where lat > 0 (harness convention: positive = fluid?) */
    var lat = kind === 'sheet' ? function (x, y, z) { return c - Math.abs(f(x * s, y * s, z * s)); } : function (x, y, z) { return c - f(x * s, y * s, z * s); };
    var L = H.linksFromLat(lat, [N, N, N], false), dom = H.prepareFlowDomain(L, {});
    var r = H.solveFlowCPU(dom, { force: [1e-6, 0, 0], tol: 1e-8, tauPlus: 1.5 });
    k[n] = r.nu * r.U[0] / 1e-6 / (N * N);
    console.log(kind, n, 'level', c.toFixed(4), 'fluid', (dom.n / (N * N * N) * 100).toFixed(1) + '%', 'k/L2', k[n].toExponential(3));
  });
  console.log(kind, 'P below G', ((1 - k.P / k.G) * 100).toFixed(1) + '%', 'D below G', ((1 - k.D / k.G) * 100).toFixed(1) + '%', 'ranking G>P>D', k.G > k.P && k.P > k.D);
});
