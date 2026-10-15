/* Fluids Phase 2 checks (v0.30.0): the lab's wall shear pipeline — 14e
   marginWallProbes + 19h flowWallTractions — on Float64 CPU flow fields.
   node proto/flow/wss_checks.js [W1 W2 W3 W4]
     W1  circular pipe along x, R = 8 / 16: mean wall shear vs G·R/2, scatter, force balance
     W2  square duct (sharp inside corners): mean wall shear vs G·a/4, force balance
     W3  probe area equals marginSurfaceArea (sheet gyroid, BCC-like spheres)
     W4  sheet gyroid 32³ (periodic, all three axes): force balance, rescale identity
     W5  (v0.32.0) sweep summary: statistics from the 1,000-point summary vs every probe, sheet gyroid 24³ */
var fs = require('fs'), path = require('path');
var H = require('./harness.js');
var S = process.env.SRC || path.resolve(__dirname, '../..');
(0, eval)(fs.readFileSync(S + '/19h-flow-wss.js', 'utf8'));
var want = process.argv.slice(2);
function on(t) { return !want.length || want.indexOf(t) >= 0; }
var PI = Math.PI, per = H.per;
function now() { return Date.now(); }

/* CPU solution → the GPU layout 19h reads: 7 floats per cell + fluid mask */
function cellFields(dom, sol, N3) {
  var F = new Float32Array(7 * N3), fluid = new Uint8Array(N3);
  for (var a = 0; a < dom.n; a++) {
    var x = dom.nodes[a]; fluid[x] = 1;
    for (var m = 0; m < 6; m++) F[7 * x + m] = sol.sigma[6 * a + m];
    F[7 * x + 6] = sol.dr[a];
  }
  return { F: F, fluid: fluid };
}
function cornerAndKept(fnLat, N) {
  var N3 = N * N * N, kept = new Float32Array(N3), mC = new Float32Array(N3);
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    var id = i * N * N + j * N + k;
    kept[id] = fnLat(i + .5, j + .5, k + .5) > 0 ? 1 : 0; mC[id] = fnLat(i, j, k);
  }
  return { kept: kept, mC: mC };
}
function areaMean(tr, probes, u) {
  var s = 0, a = 0, vals = [];
  for (var p = 0; p < probes.n; p++) if (tr.ok[p]) {
    var v = tr.tau[3 * p] * u[0] + tr.tau[3 * p + 1] * u[1] + tr.tau[3 * p + 2] * u[2];
    s += probes.area[p] * v; a += probes.area[p]; vals.push(v);
  }
  return { mean: s / a, st: H.stats(vals) };
}

if (on('W1')) [8, 16].forEach(function (R) {
  var N = 2 * R + 6, c = N / 2 + 0.17, G = 1e-6, t0 = now();
  var fnLat = function (x, y, z) { var dy = per(y - c, N), dz = per(z - c, N); return Math.sqrt(dy * dy + dz * dz) - R; };
  var L = H.linksFromLat(fnLat, [N, N, N], false), ck = cornerAndKept(fnLat, N);
  var dom = H.prepareFlowDomain(L, {}), r = H.solveFlowCPU(dom, { force: [G, 0, 0], tol: 1e-10, fields: true });
  var cf = cellFields(dom, r, N * N * N), probes = marginWallProbes(ck.mC, N, ck.kept, ck.kept);
  var tr = flowWallTractions(probes, cf.F, cf.fluid, N, G, 0, N * N * N - probes.solidVol), am = areaMean(tr, probes, [1, 0, 0]);
  var ex = R / 2, err = am.mean / ex - 1;
  H.emit(null, { test: 'W1 pipe x', R: R, N: N, probes: probes.n, split: probes.nSplit, pair: tr.nPair, near: tr.nNear, single: tr.nSingle, drop: tr.nDrop,
    wss_mean_err: H.pct(err), scatter_sd: H.pct(am.st.sd / am.st.mean), force_residual: H.pct(tr.residual),
    fluid_vol_err: H.pct((N * N * N - probes.solidVol) / (PI * R * R * N) - 1), pass: Math.abs(err) < 0.02 && Math.abs(tr.residual) < 0.02, ms: now() - t0 });
});

if (on('W2')) [[32, 28.6], [48, 44.3]].forEach(function (cs) {
  var N = cs[0], a = cs[1], cc = N / 2 + 0.23, G = 1e-6, t0 = now();
  var fnLat = function (x, y, z) { return Math.max(Math.abs(per(y - cc, N)), Math.abs(per(z - cc, N))) - a / 2; };
  var L = H.linksFromLat(fnLat, [N, N, N], false), ck = cornerAndKept(fnLat, N);
  var dom = H.prepareFlowDomain(L, {}), r = H.solveFlowCPU(dom, { force: [G, 0, 0], tol: 1e-10, fields: true });
  var cf = cellFields(dom, r, N * N * N), probes = marginWallProbes(ck.mC, N, ck.kept, ck.kept);
  var tr = flowWallTractions(probes, cf.F, cf.fluid, N, G, 0, N * N * N - probes.solidVol), am = areaMean(tr, probes, [1, 0, 0]);
  var err = am.mean / (a / 4) - 1;
  H.emit(null, { test: 'W2 square duct', side: a, N: N, probes: probes.n, near: tr.nNear, single: tr.nSingle, drop: tr.nDrop,
    wss_mean_err: H.pct(err), force_residual: H.pct(tr.residual), ms: now() - t0 });
});

if (on('W3')) [24, 32].forEach(function (N) {
  var gy = function (x, y, z) { var s = 2 * PI / N; return 0.4 - Math.abs(Math.sin(x * s) * Math.cos(y * s) + Math.sin(y * s) * Math.cos(z * s) + Math.sin(z * s) * Math.cos(x * s)); };
  var ck = cornerAndKept(gy, N), pr = marginWallProbes(ck.mC, N, ck.kept, ck.kept), A = 0;
  for (var p = 0; p < pr.n; p++) A += pr.area[p];
  var ref = marginSurfaceArea(ck.mC, N, ck.kept, ck.kept) * N * N;
  /* slabs merged equal the whole */
  var h = N / 2, m = mergeWallProbes([marginWallProbes(ck.mC, N, ck.kept, ck.kept, [0, h]), marginWallProbes(ck.mC, N, ck.kept, ck.kept, [h, N])]), A2 = 0;
  for (var q = 0; q < m.n; q++) A2 += m.area[q];
  /* normals point away from the solid: the discretized wall's margin (trilinear in the corner
     grid, what the triangles are cut from) falls along them.  The analytic field can disagree
     where a sheet is thinner than a voxel. */
  var mC = ck.mC;
  function tri(x, y, z) {
    var i0 = Math.floor(x), j0 = Math.floor(y), k0 = Math.floor(z), tx = x - i0, ty = y - j0, tz = z - k0, v = 0;
    for (var c = 0; c < 8; c++) {
      var di = c & 1, dj = (c >> 1) & 1, dk = c >> 2, w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
      v += w * mC[((i0 + di) % N + N) % N * N * N + ((j0 + dj) % N + N) % N * N + ((k0 + dk) % N + N) % N];
    }
    return v;
  }
  var bad = 0;
  for (var p2 = 0; p2 < pr.n; p2++) {
    var x = pr.pos[3 * p2], y = pr.pos[3 * p2 + 1], z = pr.pos[3 * p2 + 2], nx = pr.nrm[3 * p2], ny = pr.nrm[3 * p2 + 1], nz = pr.nrm[3 * p2 + 2];
    if (tri(x + 0.02 * nx, y + 0.02 * ny, z + 0.02 * nz) > tri(x - 0.02 * nx, y - 0.02 * ny, z - 0.02 * nz)) bad++;
  }
  H.emit(null, { test: 'W3 probe area', N: N, probes: pr.n, split: pr.nSplit, area_rel: (A / ref - 1).toExponential(2), slabs_rel: (A2 / ref - 1).toExponential(2),
    normals_wrong: bad, pass: Math.abs(A / ref - 1) < 1e-5 && Math.abs(A2 / ref - 1) < 1e-5 && bad === 0 });
});

if (on('W4')) (function () {
  var N = +(process.env.W4_N || 32), s = 2 * PI / N, G = 1e-6, t0 = now();
  var gy = function (x, y, z) { return 0.4 - Math.abs(Math.sin(x * s) * Math.cos(y * s) + Math.sin(y * s) * Math.cos(z * s) + Math.sin(z * s) * Math.cos(x * s)); };
  var L = H.linksFromLat(gy, [N, N, N], false), ck = cornerAndKept(gy, N), dom = H.prepareFlowDomain(L, {});
  var probes = marginWallProbes(ck.mC, N, ck.kept, ck.kept), axes = [], K = new Float64Array(9), sols = [];
  for (var ax = 0; ax < 3; ax++) {
    var Fv = [0, 0, 0]; Fv[ax] = G;
    var r = H.solveFlowCPU(dom, { force: Fv, tol: 1e-9, tauPlus: 1.5, fields: true });
    for (var i = 0; i < 3; i++) K[i * 3 + ax] = r.nu * r.U[i] / G;
    var cf = cellFields(dom, r, N * N * N);
    axes.push(flowWallTractions(probes, cf.F, cf.fluid, N, G, ax, N * N * N - probes.solidVol)); sols.push(r);
  }
  var Ks = new Float64Array(9);
  for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) Ks[a * 3 + b] = 0.5 * (K[a * 3 + b] + K[b * 3 + a]);
  /* rescale identity: a solve along (1,1,0) equals the x + y combination */
  var r2 = H.solveFlowCPU(dom, { force: [G, G, 0], tol: 1e-9, tauPlus: 1.5, fields: true }), cf2 = cellFields(dom, r2, N * N * N);
  var t2 = flowWallTractions(probes, cf2.F, cf2.fluid, N, G, 0, N * N * N - probes.solidVol), maxd = 0, maxv = 0;
  for (var p = 0; p < probes.n; p++) if (t2.ok[p]) for (var m = 0; m < 3; m++) {
    var comb = axes[0].tau[3 * p + m] + axes[1].tau[3 * p + m];
    maxd = Math.max(maxd, Math.abs(comb - t2.tau[3 * p + m])); maxv = Math.max(maxv, Math.abs(t2.tau[3 * p + m]));
  }
  var fr = { N: N, Ksym: Ks, perAxis: [{ open: true }, { open: true }, { open: true }], medPoreVox: 8,
             wss: { n: probes.n, area: probes.area, axes: axes }, wssKey: 'check' };
  var st = flowShearStats(fr, 2, { mu: 0.69e-3, rho: 993, cellMm: 2, target: [0.010, 0.030], chamberMm: 10 });
  H.emit(null, { test: 'W4 sheet gyroid', N: N, probes: probes.n, split: probes.nSplit, near: axes[2].nNear, single: axes[2].nSingle, drop: axes[2].nDrop,
    force_residual: axes.map(function (t) { return H.pct(t.residual); }).join(' / '), superposition: (maxd / maxv).toExponential(2),
    kL2: [Ks[0] / (N * N), Ks[4] / (N * N), Ks[8] / (N * N)].map(function (v) { return v.toExponential(3); }).join(' / '),
    per_mm_s_mPa: { median: +st.median.toPrecision(3), p95: +st.p95.toPrecision(3) },
    ti_target: { bestU_mm_s: +(st.bestU * 1000).toPrecision(3), in: H.pct(st.inTarget), under: H.pct(st.under), over: H.pct(st.over),
                 range_mm_s: [+(st.rangeLo * 1000).toPrecision(3), +(st.rangeHi * 1000).toPrecision(3)], mL_min: +st.mlMin.toPrecision(3), Re: +st.Re.toPrecision(2) },
    ms: now() - t0 });
})();

/* W5 (v0.32.0) — the sweep keeps a 1,000-point summary of each run's wall
   shear (19h flowShearSummary); its statistics must match the card's
   (every probe) for any fluid, cell size and target. */
if (on('W5')) (function () {
  var N = +(process.env.W5_N || 24), s = 2 * PI / N, G = 1e-6, t0 = now();
  /* a mildly anisotropic sheet gyroid (y squashed) so the three axes differ */
  var gy = function (x, y, z) { var X = x * s, Y = y * s, Z = z * s; return 0.4 - Math.abs(Math.sin(X) * Math.cos(Y) + 0.8 * Math.sin(Y) * Math.cos(Z) + Math.sin(Z) * Math.cos(X)); };
  var L = H.linksFromLat(gy, [N, N, N], false), ck = cornerAndKept(gy, N), dom = H.prepareFlowDomain(L, {});
  var probes = marginWallProbes(ck.mC, N, ck.kept, ck.kept), axes = [], K = new Float64Array(9);
  for (var ax = 0; ax < 3; ax++) {
    var Fv = [0, 0, 0]; Fv[ax] = G;
    var r = H.solveFlowCPU(dom, { force: Fv, tol: 1e-9, tauPlus: 1.5, fields: true });
    for (var i = 0; i < 3; i++) K[i * 3 + ax] = r.nu * r.U[i] / G;
    var cf = cellFields(dom, r, N * N * N);
    axes.push(flowWallTractions(probes, cf.F, cf.fluid, N, G, ax, N * N * N - probes.solidVol));
  }
  var Ks = new Float64Array(9);
  for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) Ks[a * 3 + b] = 0.5 * (K[a * 3 + b] + K[b * 3 + a]);
  var fr = { N: N, Ksym: Ks, perAxis: [{ open: true }, { open: true }, { open: true }], medPoreVox: 8,
             wss: { n: probes.n, area: probes.area, axes: axes }, wssKey: 'w5' };
  var sum = flowShearSummary(fr, +process.env.W5_Q || undefined), worst = { med: 0, p95: 0, share: 0, U: 0, range: 0 }, cases = 0, picks = 0;
  var rec = { open: [true, true, true], kL2: [Ks[0], Ks[4], Ks[8]].map(function (v) { return v / (N * N); }), shear: sum, medPoreVox: 8 };
  [[0.69e-3, 993, 2], [1.0e-3, 1000, 5], [0.78e-3, 1007, 0.8]].forEach(function (fl) {
    [null, [0.005, 0.015], [0.010, 0.030], [0.020, 0.060], [0.5, 1.5]].forEach(function (tg) {
      var cfg = { mu: fl[0], rho: fl[1], cellMm: fl[2], target: tg, chamberMm: 10, dir: 'all' };
      for (var ax2 = 0; ax2 < 3; ax2++) {
        var A = flowShearStats(fr, ax2, cfg), B = flowSummaryStats(sum, ax2, cfg, 8);
        worst.med = Math.max(worst.med, Math.abs(B.median / A.median - 1)); worst.p95 = Math.max(worst.p95, Math.abs(B.p95 / A.p95 - 1));
        if (tg) {
          worst.share = Math.max(worst.share, Math.abs(B.inTarget - A.inTarget));
          if (A.bestU > 0 && A.inTarget > 0.05) {
            /* the best speed sits on a plateau of near-equal windows: compare the share
               the summary's speed gets on the full data, not the speed itself */
            var sh = flowShareIn(A, tg[0] / B.bestU, tg[1] / B.bestU);
            worst.U = Math.max(worst.U, A.inTarget - sh);
            worst.range = Math.max(worst.range, Math.abs(Math.log(B.rangeLo / A.rangeLo)), Math.abs(Math.log(B.rangeHi / A.rangeHi)));
          }
        }
        cases++;
      }
      var pc = flowShearPick(fr, cfg), ps = flowSummaryPick(rec, cfg);
      if (pc && ps && pc.axis === ps.axis) picks++;
    });
  });
  /* the best speed is centred on the plateau of windows within 1 % of wall of the best
     (19h flowShearStatsSorted), so the reported share is only defined to that 1 %;
     the summary must land inside it.  The median and 95th are compared directly. */
  var lim = 0.01;
  H.emit(null, { test: 'W5 sweep summary', N: N, probes: probes.n, Q: sum.Q, cases: cases,
    kL2: rec.kL2.map(function (v) { return v.toExponential(3); }).join(' / '),
    worst_median: H.pct(worst.med), worst_p95: H.pct(worst.p95), worst_share_pts: (worst.share * 100).toFixed(3),
    best_speed_share_loss_pts: (worst.U * 100).toFixed(3), worst_range_log: worst.range.toFixed(4), same_pick: picks + '/15',
    share_limit_pts: (lim * 100).toFixed(1),
    pass: worst.med < 0.01 && worst.p95 < 0.01 && worst.share <= lim && worst.U <= lim && worst.range < 0.02 && picks === 15, ms: now() - t0 });
})();
