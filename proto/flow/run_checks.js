/* Fluids Phase 0 checks F1–F7 on the Float64 CPU reference (docs/FLUIDS_LBM_SCOPE.md §4).
     node proto/flow/run_checks.js F1 [F2 …]      (no argument: all)
   Each row is printed and appended to proto/flow/results-<test>.jsonl.
   Geometry is built from analytic margins through 14e buildFlowLinksFromFn,
   so the wall fractions the solver sees are the lab's own.  Lattice units:
   ρ₀ = 1, μ = ν = (τ⁺ − ½)/3, G = body force density. */
var H = require('./harness.js'), path = require('path'), fs = require('fs');
var PI = Math.PI, per = H.per, pct = H.pct;
var want = process.argv.slice(2);
function on(t) { return !want.length || want.indexOf(t) >= 0; }
function out(t) { var f = path.join(__dirname, 'results-' + t + '.jsonl'); if (fs.existsSync(f)) fs.unlinkSync(f); return f; }
function now() { return Date.now(); }

/* ---------- F1: plane Poiseuille, walls on the grid, halfway, TRT Λ = 3/16 ---------- */
if (on('F1')) (function () {
  var file = out('F1'), NY = 16, Hc = 14, G = 1e-6, t0 = now();
  var L = H.linksFromLat(function (x, y) { return 1 - Math.abs(per(y - 1, NY)); }, [1, NY, 1], true);
  var dom = H.prepareFlowDomain(L, { wall: 'halfway' });
  var r = H.solveFlowCPU(dom, { force: [G, 0, 0], tol: 1e-12, fields: true, maxSteps: 400000 });
  var maxErr = 0;
  for (var j = 2; j < NY; j++) {
    var a = dom.idx[j], s = j - 2 + 0.5, ex = G / (2 * r.nu) * s * (Hc - s);
    maxErr = Math.max(maxErr, Math.abs(r.u[3 * a] - ex) / (G * Hc * Hc / (8 * r.nu)));
  }
  var ws = H.wallShearAt(dom, r, 0.5, 2, 0.5, 0, 1, 0);
  H.emit(file, { test: 'F1 plane Poiseuille, walls on grid', NY: NY, steps: r.steps, converged: r.converged,
    profile_max_rel_err: maxErr.toExponential(2), wss_rel_err: (ws.tau[0] / (G * Hc / 2) - 1).toExponential(2),
    pass: maxErr < 1e-10 && Math.abs(ws.tau[0] / (G * Hc / 2) - 1) < 1e-10, ms: now() - t0 });
})();

/* ---------- F2: plane Poiseuille, walls at fractional positions ---------- */
if (on('F2')) (function () {
  var file = out('F2'), G = 1e-6;
  [16, 32].forEach(function (NY) {
    /* solid band y ∈ [y0, y1); q at each wall set by the offsets */
    [[0.6, 3.4], [0.75, 3.0], [1.0, 2.6], [0.3, 2.2], [1.45, 2.55], [0.9, 2.2]].forEach(function (c) {
      var y0 = c[0], y1 = c[1], Hc = NY - (y1 - y0), mid = 0.5 * (y0 + y1), half = 0.5 * (y1 - y0);
      var L = H.linksFromLat(function (x, y) { return half - Math.abs(per(y - mid, NY)); }, [1, NY, 1], false);
      var qB = (Math.ceil(y1 - 0.5) + 0.5) - y1, qT = (y0 + NY) - (Math.ceil(y0 + NY - 0.5) - 0.5);
      ['cli', 'bouzidi', 'halfway'].forEach(function (wl) {
        var t0 = now(), dom = H.prepareFlowDomain(L, { wall: wl });
        var r = H.solveFlowCPU(dom, { force: [G, 0, 0], tol: 1e-11, fields: true });
        var Qex = G * Hc * Hc * Hc / (12 * r.nu), Qn = r.U[0] * NY, eQ = Qn / Qex - 1;
        var wb = H.wallShearAt(dom, r, 0.5, y1, 0.5, 0, 1, 0).tau[0] / (G * Hc / 2) - 1;
        var wt = H.wallShearAt(dom, r, 0.5, y0 + NY, 0.5, 0, -1, 0).tau[0] / (G * Hc / 2) - 1;
        H.emit(file, { test: 'F2 plane Poiseuille, off-grid walls', wall: wl, NY: NY, gap: +Hc.toFixed(2),
          q_bottom: +qB.toFixed(2), q_top: +qT.toFixed(2), steps: r.steps, flow_err: pct(eQ),
          wss_bottom_err: pct(wb), wss_top_err: pct(wt), mass_drift: r.massDrift.toExponential(1),
          pass: wl !== 'cli' ? null : (NY < 32 ? null : Math.abs(eQ) < 0.01 && Math.abs(wb) < 0.01 && Math.abs(wt) < 0.01), ms: now() - t0 });
      });
    });
  });
})();

/* sphere at the cell centre of a simple-cubic array, radius r (lattice units) */
function sphereLinks(N, r) {
  var c = N / 2;
  return H.linksFromLat(function (x, y, z) {
    var dx = per(x - c, N), dy = per(y - c, N), dz = per(z - c, N);
    return r - Math.sqrt(dx * dx + dy * dy + dz * dz);
  }, [N, N, N], false);
}
/* Zick & Homsy drag: force per sphere F = G L³ = 6π μ a K U  (U superficial) */
function zhK(G, N, r, nu, U) { return G * N * N * N / (6 * PI * nu * r * U); }

/* ---------- F3: viscosity independence (TRT at fixed Λ vs BGK) ---------- */
if (on('F3')) (function () {
  var file = out('F3'), N = 16, phi = 0.216, r = N * Math.cbrt(3 * phi / (4 * PI)), G = 1e-6;
  var L = sphereLinks(N, r), ref = {};
  [['trt', 'cli'], ['trt', 'bouzidi'], ['trt', 'halfway'], ['bgk', 'cli']].forEach(function (cw) {
    var col = cw[0], wl = cw[1], dom = H.prepareFlowDomain(L, { wall: wl }), key = col + wl;
    [1.0, 0.6, 2.0].forEach(function (tau) {
      var t0 = now(), s = H.solveFlowCPU(dom, { force: [G, 0, 0], tauPlus: tau, collision: col, tol: 1e-10 });
      var k = s.nu * s.U[0] / G;
      if (tau === 1.0) ref[key] = k;
      H.emit(file, { test: 'F3 viscosity independence, SC spheres φ=' + phi, collision: col, wall: wl, tauPlus: tau, N: N, radius: +r.toFixed(2),
        steps: s.steps, K_cells2: k.toPrecision(10), vs_tau1: pct(k / ref[key] - 1), K_ZH: zhK(G, N, r, s.nu, s.U[0]).toFixed(4),
        pass: key === 'trtcli' ? Math.abs(k / ref[key] - 1) < 1e-3 : null, ms: now() - t0 });
    });
  });
})();

/* ---------- F4: circular pipe along four directions ---------- */
function pipeGeom(d, R) {
  var dn = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]), u = [d[0] / dn, d[1] / dn, d[2] / dn];
  /* nearest-image spacing of the periodic axis lines, per unit box */
  var spacing = Infinity;
  for (var a = -3; a <= 3; a++) for (var b = -3; b <= 3; b++) for (var c = -3; c <= 3; c++) {
    if (!a && !b && !c) continue;
    var t = a * u[0] + b * u[1] + c * u[2], px = a - t * u[0], py = b - t * u[1], pz = c - t * u[2];
    var dd = Math.sqrt(px * px + py * py + pz * pz);
    if (dd > 1e-9) spacing = Math.min(spacing, dd);
  }
  var N = Math.ceil((2 * R + 4) / spacing);
  return { u: u, dn: dn, N: N, spacing: spacing };
}
function pipeDist(g, x, y, z) {
  var N = g.N, u = g.u, c = N / 2, best = Infinity;
  var X = per(x - c, N), Y = per(y - c, N), Z = per(z - c, N);
  for (var a = -2; a <= 2; a++) for (var b = -2; b <= 2; b++) for (var e = -2; e <= 2; e++) {
    var px = X - a * N, py = Y - b * N, pz = Z - e * N, t = px * u[0] + py * u[1] + pz * u[2];
    px -= t * u[0]; py -= t * u[1]; pz -= t * u[2];
    var dd = px * px + py * py + pz * pz;
    if (dd < best) best = dd;
  }
  return Math.sqrt(best);
}
if (on('F4')) (function () {
  var file = out('F4'), G = 1e-6;
  var cases = [[[1, 0, 0], 8], [[1, 1, 0], 8], [[1, 1, 1], 8], [[1, 2, 3], 8], [[1, 0, 0], 16], [[1, 1, 0], 16], [[1, 1, 1], 16]];
  if (process.env.F4_BIG) cases.push([[1, 2, 3], 16]);
  cases.forEach(function (cs) {
    var d = cs[0], R = cs[1], g = pipeGeom(d, R), N = g.N, u = g.u, t0 = now();
    var L = H.linksFromLat(function (x, y, z) { return pipeDist(g, x, y, z) - R; }, [N, N, N], false);
    var dom = H.prepareFlowDomain(L, {});
    var r = H.solveFlowCPU(dom, { force: [G * u[0], G * u[1], G * u[2]], tol: 1e-10, fields: true });
    /* flux: ∫ u·d̂ dV = Q_exact × (axis length per cell = N |d|) */
    var Ud = r.U[0] * u[0] + r.U[1] * u[1] + r.U[2] * u[2];
    var flowErr = Ud * N * N * N / (PI * R * R * R * R * G / (8 * r.nu) * N * g.dn) - 1;
    /* wall shear around the circumference at 24 axial stations along one period */
    var e1 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], dt = e1[0] * u[0] + e1[1] * u[1] + e1[2] * u[2];
    e1 = [e1[0] - dt * u[0], e1[1] - dt * u[1], e1[2] - dt * u[2]];
    var n1 = Math.sqrt(e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2]); e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1];
    var e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
    var vals = [], c0 = N / 2, Lax = N * g.dn;
    for (var s = 0; s < 24; s++) for (var th = 0; th < 48; th++) {
      var t = (s + 0.37) / 24 * Lax, ang = 2 * PI * (th + 0.5) / 48, ca = Math.cos(ang), sa = Math.sin(ang);
      var rx = ca * e1[0] + sa * e2[0], ry = ca * e1[1] + sa * e2[1], rz = ca * e1[2] + sa * e2[2];
      var W = [c0 + t * u[0] + R * rx, c0 + t * u[1] + R * ry, c0 + t * u[2] + R * rz];
      var w = H.wallShearAt(dom, r, W[0], W[1], W[2], -rx, -ry, -rz);
      if (w) vals.push(w.tau[0] * u[0] + w.tau[1] * u[1] + w.tau[2] * u[2]);
    }
    var st = H.stats(vals), ex = G * R / 2, meanErr = st.mean / ex - 1, scatter = st.sd / st.mean, spread = (st.max - st.min) / st.mean;
    H.emit(file, { test: 'F4 pipe', dir: d.join(','), R: R, N: N, nodes: dom.n, steps: r.steps, flow_err: pct(flowErr),
      wss_mean_err: pct(meanErr), wss_scatter_sd: pct(scatter), wss_spread: pct(spread), samples: vals.length,
      pass: Math.abs(meanErr) < 0.02 && (R < 16 || scatter < 0.05), ms: now() - t0 });
  });
})();

/* ---------- F5: square duct (walls off the grid) ---------- */
function ductQ(a, G, mu) {
  /* Q = G a⁴ / (12 μ) [1 − (192 / π⁵) Σ_{n odd} tanh(nπ/2) / n⁵] */
  var s = 0;
  for (var n = 1; n < 200; n += 2) s += Math.tanh(n * PI / 2) / Math.pow(n, 5);
  return G * a * a * a * a / (12 * mu) * (1 - 192 / Math.pow(PI, 5) * s);
}
if (on('F5')) (function () {
  var file = out('F5'), G = 1e-6;
  [[24, 20.6], [32, 28.6], [48, 44.3]].forEach(function (c) {
    var NN = c[0], a = c[1], cc = NN / 2 + 0.23, t0 = now();
    var L = H.linksFromLat(function (x, y, z) { return Math.max(Math.abs(per(y - cc, NN)), Math.abs(per(z - cc, NN))) - a / 2; }, [1, NN, NN], false);
    var dom = H.prepareFlowDomain(L, {});
    var r = H.solveFlowCPU(dom, { force: [G, 0, 0], tol: 1e-11, fields: true });
    var Qn = r.U[0] * NN * NN, Qex = ductQ(a, G, r.nu), eQ = Qn / Qex - 1;
    /* mean wall shear over the perimeter (uniform stations on each side) */
    var vals = [], M = 200;
    for (var side = 0; side < 4; side++) for (var m = 0; m < M; m++) {
      var t = -a / 2 + a * (m + 0.5) / M, W, nrm;
      if (side === 0) { W = [0.5, cc - a / 2, cc + t]; nrm = [0, 1, 0]; }
      else if (side === 1) { W = [0.5, cc + a / 2, cc + t]; nrm = [0, -1, 0]; }
      else if (side === 2) { W = [0.5, cc + t, cc - a / 2]; nrm = [0, 0, 1]; }
      else { W = [0.5, cc + t, cc + a / 2]; nrm = [0, 0, -1]; }
      var w = H.wallShearAt(dom, r, W[0], W[1], W[2], nrm[0], nrm[1], nrm[2]);
      if (w) vals.push(w.tau[0]);
    }
    var mean = H.stats(vals).mean, eW = mean / (G * a / 4) - 1;
    H.emit(file, { test: 'F5 square duct', side: a, NY: NN, steps: r.steps, flow_err: pct(eQ), mean_wss_err: pct(eW), samples: vals.length,
      pass: NN >= 32 ? Math.abs(eQ) < 0.01 && Math.abs(eW) < 0.01 : null, ms: now() - t0 });
  });
})();

/* ---------- F6: simple-cubic sphere arrays vs Zick & Homsy (1982) Table 2 ---------- */
if (on('F6')) (function () {
  var file = out('F6'), G = 1e-6, tau = +(process.env.F_TAU || 1.5);
  var ZH = [[0.027, 2.008], [0.064, 2.810], [0.125, 4.292], [0.216, 7.442], [0.343, 15.4], [0.45, 28.1], [0.5236, 42.1]];
  var rTarget = +(process.env.F6_R || 8);
  ZH.forEach(function (z) {
    var phi = z[0], ratio = Math.cbrt(3 * phi / (4 * PI)), N = Math.max(8, Math.round(rTarget / ratio)), r = ratio * N, t0 = now();
    var L = sphereLinks(N, r), dom = H.prepareFlowDomain(L, {});
    var s = H.solveFlowCPU(dom, { force: [G, 0, 0], tauPlus: tau, tol: 1e-9 });
    var K = zhK(G, N, r, s.nu, s.U[0]), e = K / z[1] - 1;
    H.emit(file, { test: 'F6 SC sphere array', phi: phi, N: N, radius: +r.toFixed(2), tauPlus: tau, steps: s.steps, K: +K.toFixed(4), K_ZH: z[1],
      err: pct(e), pass: Math.abs(e) < 0.02, ms: now() - t0 });
  });
})();

/* ---------- F7: square arrays of cylinders, transverse flow, vs Sangani & Acrivos (1982) Table 1 ---------- */
if (on('F7')) (function () {
  var file = out('F7'), G = 1e-6, tau = +(process.env.F_TAU || 1.5);
  var SA = [[0.05, 15.56], [0.10, 24.83], [0.20, 51.53], [0.30, 102.90], [0.40, 217.89], [0.50, 532.55], [0.60, 1763]];
  [8, 16].forEach(function (rT) {
    SA.forEach(function (z) {
      var phi = z[0], ratio = Math.sqrt(phi / PI), N = Math.max(8, Math.round(rT / ratio)), r = ratio * N, c = N / 2, t0 = now();
      var L = H.linksFromLat(function (x, y) { var dx = per(x - c, N), dy = per(y - c, N); return r - Math.sqrt(dx * dx + dy * dy); }, [N, N, 1], false);
      var dom = H.prepareFlowDomain(L, {});
      var s = H.solveFlowCPU(dom, { force: [G, 0, 0], tauPlus: tau, tol: 1e-9 });
      /* force per unit length per cylinder F = G L²;  F / (μ U), U superficial */
      var D = G * N * N / (s.nu * s.U[0]), e = D / z[1] - 1, gap = N - 2 * r;
      H.emit(file, { test: 'F7 square cylinder array', phi: phi, N: N, radius: +r.toFixed(2), gap_cells: +gap.toFixed(2), tauPlus: tau, steps: s.steps,
        drag: +D.toFixed(3), drag_SA: z[1], err: pct(e), pass: phi <= 0.5 ? Math.abs(e) < 0.02 : null, ms: now() - t0 });
    });
  });
})();
