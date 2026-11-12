/* HX-1 checks (v0.37.0): inertial pressure drop on the Float64 CPU reference (19f) through the
   lab's own point driver and fit (19i), docs/FLUIDS_LBM_SCOPE.md §19.
     node proto/flow/hx_checks.js [H1 H2 H3 H5 H6 H8]      (no argument: all)
   SRC=<folder> runs the files of another copy (the throwaway check folder).
     H1  straight channel and round pipe, Re 1–200: no inertia exists, so resistance ÷ Darcy = 1
     H2  same Reynolds number at three relaxation times: the same resistance (only Re matters)
     H3  weak inertia, square cylinder array: (resistance − 1) grows as Re² (Mei & Auriault 1991)
     H5  sheet gyroid at 70 % porosity, 24³ and 32³: Forchheimer factor between grids
     H6  fit, onset, unit conversions and the Reynolds field parser on synthetic points
     H8  the 19i driver end to end on the CPU: points land on their Reynolds numbers, fit quality
   H4 (published moderate-Re arrays) and H7 (creeping flow unchanged on the GPU) are not here:
   H4 waits for confirmed table values; H7 is code inspection plus Matt's runFlowGPUCheck. */
var fs = require('fs'), path = require('path');
var H = require('./harness.js');
var S = process.env.SRC || path.resolve(__dirname, '../..');
global.FLOW_TAU_PLUS = 1.5; global.FLOW_CHECK_EVERY = 500;
(0, eval)(fs.readFileSync(S + '/19i-flow-hx.js', 'utf8'));
var want = process.argv.slice(2);
function on(t) { return !want.length || want.indexOf(t) >= 0; }
var PI = Math.PI, per = H.per;
function now() { return Date.now(); }
function out(t) { var f = path.join(__dirname, 'results-' + t + '.jsonl'); if (fs.existsSync(f)) fs.unlinkSync(f); return f; }

/* creeping permeability along x (voxels²) at a tiny force, from rest */
function darcyK(dom, ax) {
  var g = 1e-9, F = [0, 0, 0]; F[ax || 0] = g;
  var r = H.solveFlowCPU(dom, { force: F, tauPlus: 1.5, tol: 1e-12, checkEvery: 500, maxSteps: 400000 });
  return r.nu * r.U[ax || 0] / g;
}
/* a CPU stand-in for the GPU solver, so flowHXRun runs unchanged (warm starts through opts.init) */
function cpuSolver(dom, tolOverride) {
  var st = null, last = null;
  return {
    solveHX: async function (F, o) {
      var r = H.solveFlowCPU(dom, { force: F, tauPlus: o.tauPlus, lambda: o.lambda || 3 / 16, tol: tolOverride || o.tol || 1e-5, checkEvery: 500,
                                   maxSteps: o.maxSteps || 60000, minSteps: 1000, init: o.warm && st ? st : null, fields: true });
      if (!isFinite(r.U[0] + r.U[1] + r.U[2])) { st = null; return { unstable: true, steps: r.steps }; }
      st = r.state; last = r.u;
      return { U: r.U, steps: r.steps, converged: r.converged, unsteady: false, t_ms: 0, nu: r.nu };
    },
    readVelocity: async function () { return last; }
  };
}
/* aim a point at Reynolds number ReT (re-aim from the measured drag until within tolRe) → { Re, Pi, steps } */
function pointAt(dom, ax, ReT, dh, eps, K, tau, tolRe, tol) {
  var nu = (tau - 0.5) / 3, UsT = ReT * nu / dh * eps, g = nu * UsT / K, r = null, st = null, steps = 0, Us = 0, Re = 0;
  for (var t = 0; t < 6; t++) {
    var F = [0, 0, 0]; F[ax] = g;
    r = H.solveFlowCPU(dom, { force: F, tauPlus: tau, tol: tol || 1e-10, checkEvery: 500, maxSteps: 600000, minSteps: 1000, init: st });
    st = r.state; steps += r.steps; Us = r.U[ax]; Re = Us / eps * dh / nu;
    if (Math.abs(Re / ReT - 1) < tolRe) break;
    var b = (g - nu * Us / K) / (Us * Us);
    g = b > 0 ? nu * UsT / K + b * UsT * UsT : g * UsT / Us;
  }
  return { Re: Re, Pi: g * K / (nu * Us), steps: steps, uMax: r.uMax, converged: r.converged };
}
/* square array of cylinders along z, radius R, cell N (2-D: a box N × N × 1) */
function cylLinks(N, R) {
  var c = N / 2;
  return H.linksFromLat(function (x, y) { var dx = per(x - c, N), dy = per(y - c, N); return R - Math.sqrt(dx * dx + dy * dy); }, [N, N, 1], false);
}
function cylDh(N, R) { var eps = 1 - PI * R * R / (N * N); return { eps: eps, dh: 4 * eps * N * N / (2 * PI * R) }; }

(async function main() {
  /* ---------- H1: straight channel and round pipe — exact answer has no inertia ---------- */
  if (on('H1')) {
    var f1 = out('H1');
    var NY = 32, y0 = 0.7, y1 = 3.3, Hc = NY - (y1 - y0), mid = 0.5 * (y0 + y1), half = 0.5 * (y1 - y0);
    var Lc = H.linksFromLat(function (x, y) { return half - Math.abs(per(y - mid, NY)); }, [1, NY, 1], false);
    var dc = H.prepareFlowDomain(Lc, {}), epsC = dc.n / NY, Kc = darcyK(dc, 0), dhC = 2 * Hc;
    var R = 14, NP = 32;
    var Lp = H.linksFromLat(function (x, y, z) { var dy = per(y - NP / 2, NP), dz = per(z - NP / 2, NP); return Math.sqrt(dy * dy + dz * dz) - R; }, [1, NP, NP], false);
    var dp = H.prepareFlowDomain(Lp, {}), epsP = PI * R * R / (NP * NP), Kp = darcyK(dp, 0), dhP = 2 * R;
    [['channel', dc, epsC, Kc, dhC], ['pipe', dp, epsP, Kp, dhP]].forEach(function (c) {
      [1, 10, 50, 100, 200].forEach(function (Re) {
        var t0 = now(), su = flowHXPointSetup(Re, c[4]);
        if (!su) { H.emit(f1, { test: 'H1 ' + c[0], Re: Re, skipped: 'beyond grid' }); return; }
        var p = pointAt(c[1], 0, Re, c[4], c[2], c[3], su.tau, 0.02, 1e-11);
        H.emit(f1, { test: 'H1 ' + c[0], Re_target: Re, Re: +p.Re.toPrecision(4), tau: +su.tau.toFixed(4), resistance_over_darcy: +p.Pi.toFixed(5),
          err_pct: +((p.Pi - 1) * 100).toFixed(3), peak_mach: +(p.uMax / Math.sqrt(1 / 3)).toFixed(3), steps: p.steps, pass: Math.abs(p.Pi - 1) < 0.005, ms: now() - t0 });
      });
    });
  }

  /* ---------- H2: same Reynolds number, three relaxation times ---------- */
  if (on('H2')) {
    var f2 = out('H2'), N2 = 48, R2 = 12, g2 = cylDh(N2, R2), L2 = cylLinks(N2, R2), d2 = H.prepareFlowDomain(L2, {}), K2 = darcyK(d2, 0), res = [];
    [0.6, 0.55, 0.52].forEach(function (tau) {
      var t0 = now(), p = pointAt(d2, 0, 20, g2.dh, g2.eps, K2, tau, 0.001, 1e-11);
      res.push(p.Pi);
      H.emit(f2, { test: 'H2 cylinders, Re 20', tau: tau, Re: +p.Re.toPrecision(5), resistance_over_darcy: +p.Pi.toFixed(5), steps: p.steps, ms: now() - t0 });
    });
    var spread = (Math.max.apply(null, res) - Math.min.apply(null, res)) / res[0];
    H.emit(f2, { test: 'H2 spread', spread_pct: +(spread * 100).toFixed(3), pass: spread < 0.005 });
  }

  /* ---------- H3: weak inertia — (Pi − 1) ∝ Re² ---------- */
  if (on('H3')) {
    var f3 = out('H3'), N3 = 48, R3 = 12, g3 = cylDh(N3, R3), L3 = cylLinks(N3, R3), d3 = H.prepareFlowDomain(L3, {}), K3 = darcyK(d3, 0), pts = [];
    [0.25, 0.5, 1].forEach(function (Re) {
      var t0 = now(), p = pointAt(d3, 0, Re, g3.dh, g3.eps, K3, 1.5, 0.05, 1e-13);
      pts.push(p);
      H.emit(f3, { test: 'H3 cylinders weak inertia', Re: +p.Re.toPrecision(4), excess: (p.Pi - 1).toExponential(3), steps: p.steps, ms: now() - t0 });
    });
    var sl = Math.log((pts[2].Pi - 1) / (pts[0].Pi - 1)) / Math.log(pts[2].Re / pts[0].Re);
    H.emit(f3, { test: 'H3 slope of log(excess) vs log(Re)', slope: +sl.toFixed(3), expected: 2, pass: Math.abs(sl - 2) < 0.15 });
  }

  /* ---------- H6: fit, onset, conversions, parser (synthetic) ---------- */
  if (on('H6')) {
    var f6 = out('H6'), F0 = 0.4, K = 9, eps = 0.7, dh = 30, rec = { v: 'hx-1', N: 64, eps: eps, epsTot: eps, dh: dh, K: [K, K, K], ReList: [2, 5, 10, 20, 50, 100], axes: [null, null, null] };
    rec.axes[2] = { points: rec.ReList.map(function (Re) { var ReK = Re * eps * Math.sqrt(K) / dh; return { ReT: Re, Re: Re, ReK: ReK, Pi: 1 + F0 * ReK, converged: true }; }) };
    var fit = flowHXFit(rec, 2);
    var ReOn = (1 / 0.9 - 1) / F0 * dh / (eps * Math.sqrt(K));      /* exact for a straight line in Pi vs Re */
    var cfg = { mu: 0.891e-3, rho: 997, cellMm: 3.25 }, ph = flowHXPhysical(rec, 2, cfg), dx = 3.25e-3 / 64, Km = K * dx * dx, dhm = dh * dx, nu = cfg.mu / cfg.rho;
    var Us100 = eps * 100 * nu / dhm, dp100 = (1 + F0 * 100 * eps * Math.sqrt(K) / dh) * cfg.mu * Us100 / Km;
    var fan = (1 + F0 * 100 * eps * Math.sqrt(K) / dh) * eps * dh * dh / (2 * K * 100);
    var checks = {
      F: Math.abs(fit.F / F0 - 1), worst: fit.worst, onset: Math.abs(fit.onset / ReOn - 1), beta: Math.abs(ph.beta / (F0 / Math.sqrt(Km)) - 1),
      dpdx: Math.abs(ph.top.dpdx / dp100 - 1), fanning: Math.abs(ph.top.f / fan - 1),
      forch_matches_points: Math.abs(ph.forch(Us100) / dp100 - 1), darcy: Math.abs(ph.darcy(Us100) / (cfg.mu * Us100 / Km) - 1)
    };
    var parse = JSON.stringify(flowHXParseRe('100, 2;5 5 abc 0.01 2000 20,50 10')) === JSON.stringify([2, 5, 10, 20, 50, 100]);
    var pick = flowHXPick(rec, 'all').axis === 2 && flowHXPick(rec, 'xx').missing === true;
    var maxErr = Math.max.apply(null, Object.keys(checks).map(function (k) { return checks[k]; }));
    H.emit(f6, { test: 'H6 fit and conversions', errors: checks, parser: parse, pick: pick, pass: maxErr < 1e-9 && parse && pick });
    /* the 10 % rule: points under 10 % inertia are not fitted */
    var low = { v: 'hx-1', N: 64, eps: eps, epsTot: eps, dh: dh, K: [K, K, K], axes: [{ points: [{ Re: 1, ReK: 0.07, Pi: 1.001, converged: true }, { Re: 2, ReK: 0.14, Pi: 1.004, converged: true }] }, null, null] };
    var fl = flowHXFit(low, 0);
    H.emit(f6, { test: 'H6 no fit under 10 % inertia', F: fl.F, onsetAbove: fl.onsetAbove, pass: fl.F === null && fl.onsetAbove });
  }

  /* ---------- H8: the 19i driver on the CPU ---------- */
  if (on('H8')) {
    /* dense array (porosity 0.56, gap 12 voxels) so inertia passes 10 % inside the list; the open
       one of H2/H3 (porosity 0.80) stays under 10 % up to Re 50 and never reaches the fit */
    var f8 = out('H8'), N8 = 48, R8 = 18, g8 = cylDh(N8, R8), L8 = cylLinks(N8, R8), d8 = H.prepareFlowDomain(L8, {}), K8 = darcyK(d8, 0), t8 = now();
    var rec8 = await flowHXRun({ S: cpuSolver(d8), N: N8, eps: g8.eps, epsTot: g8.eps, dh: g8.dh, K: [K8, 0, 0], openBits: 1 },
                               { ReList: [5, 10, 20, 50, 100], axes: [0] });
    var fit8 = flowHXFit(rec8, 0), pts8 = rec8.axes[0].points, off = 0;
    pts8.forEach(function (p) { if (!p.skipped) off = Math.max(off, Math.abs(p.Re / p.ReT - 1)); });
    H.emit(f8, { test: 'H8 driver, cylinder array 48 × 48, dh ' + g8.dh.toFixed(1) + ' voxels',
      points: pts8.map(function (p) { return p.skipped ? { ReT: p.ReT, skipped: p.skipped } : { ReT: p.ReT, Re: +p.Re.toPrecision(4), Pi: +p.Pi.toFixed(4), mach: +p.mach.toFixed(3), steps: p.steps }; }),
      F: fit8.F != null ? +fit8.F.toPrecision(4) : null, fit_points: fit8.nFit, fit_worst_pct: +(fit8.worst * 100).toFixed(2), onset_Re: fit8.onset != null ? +fit8.onset.toPrecision(3) : null,
      worst_Re_miss_pct: +(off * 100).toFixed(2), pass: off <= FLOW_HX_RETARGET + 1e-9 && fit8.nFit >= 2, ms: now() - t8 });
  }

  /* ---------- H5: sheet gyroid, 70 % porosity, 24³ vs 32³ ---------- */
  if (on('H5')) {
    var f5 = out('H5');
    var gy = function (x, y, z) { return Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x); };
    for (var gi = 0; gi < 2; gi++) {
      var N5 = [24, 32][gi], s = 2 * PI / N5, vals = [];
      for (var i = 0; i < N5; i++) for (var j = 0; j < N5; j++) for (var k = 0; k < N5; k++) vals.push(Math.abs(gy((i + .5) * s, (j + .5) * s, (k + .5) * s)));
      vals.sort(function (a, b) { return a - b; });
      var c = 0.5 * (vals[Math.round(0.3 * vals.length) - 1] + vals[Math.round(0.3 * vals.length)]);
      var lat = function (x, y, z) { return c - Math.abs(gy(x * s, y * s, z * s)); };
      var L5 = H.linksFromLat(lat, [N5, N5, N5], false), d5 = H.prepareFlowDomain(L5, {}), N53 = N5 * N5 * N5;
      var kept = new Float32Array(N53), mC = new Float32Array(N53);
      for (var a = 0; a < N5; a++) for (var b = 0; b < N5; b++) for (var e = 0; e < N5; e++) { var id = a * N5 * N5 + b * N5 + e; kept[id] = lat(a + .5, b + .5, e + .5) > 0 ? 1 : 0; mC[id] = lat(a, b, e); }
      var pr = marginWallProbes(mC, N5, kept, kept), eps5 = d5.n / N53, dh5 = flowHXHydraulicDiameter(pr, eps5, N5), K5 = darcyK(d5, 0), t5 = now();
      var rec5 = await flowHXRun({ S: cpuSolver(d5), N: N5, eps: eps5, epsTot: eps5, dh: dh5, K: [K5, 0, 0], openBits: 1 }, { ReList: [4, 7, 10, 15, 20], axes: [0] });
      var fit5 = flowHXFit(rec5, 0);
      H.emit(f5, { test: 'H5 sheet gyroid 70 %', N: N5, dh_vox: +dh5.toFixed(2), dh_over_L: +(dh5 / N5).toFixed(4), kL2: +(K5 / N5 / N5).toExponential(4),
        points: rec5.axes[0].points.map(function (p) { return p.skipped ? { ReT: p.ReT, skipped: p.skipped } : { ReT: p.ReT, Re: +p.Re.toPrecision(4), Pi: +p.Pi.toFixed(4), tau: +p.tau.toFixed(3), mach: +p.mach.toFixed(3), steps: p.steps }; }),
        F: fit5.F != null ? +fit5.F.toPrecision(4) : null, fit_points: fit5.nFit, fit_worst_pct: +(fit5.worst * 100).toFixed(2), onset_Re: fit5.onset != null ? +fit5.onset.toPrecision(3) : null, ms: now() - t5 });
    }
  }
})().catch(function (e) { console.error(e); process.exit(1); });
