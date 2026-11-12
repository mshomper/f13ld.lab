/* ============================================================
   F13LD.lab · 19i-flow-hx.js   (v0.37.0 — HX-1, inertial pressure drop)
   Pressure drop through the periodic cell beyond Darcy's law, at a list of
   Reynolds numbers (docs/FLUIDS_LBM_SCOPE.md §11.2, §19; decisions 0003–0005).

   Method (decision 0003 A): the 19g kernel unchanged — D3Q19, TRT, CLI
   walls, Guo body force.  Its equilibrium keeps the quadratic velocity
   terms, so it already solves the full Navier–Stokes equations; creeping
   flow only looked linear because it ran slow and viscous.  Each point keeps
   the mean pore (interstitial) lattice speed at FLOW_HX_U and lowers the
   relaxation time to reach its Reynolds number:
       ν = U · d_h / Re,   τ⁺ = ½ + 3ν   (capped at 1.5 for the low points).
   TRT with a fixed magic parameter and CLI walls keeps the wall where it is
   whatever τ⁺ is (check F3), so the answer depends on Re alone.
   A point is skipped when τ⁺ would fall below FLOW_HX_TAU_MIN or the
   boundary layer d_h/√Re below FLOW_HX_BL_MIN voxels (beyond this grid).

   Reynolds number on the hydraulic diameter d_h = 4ε/a (ε porosity, a wall
   area per volume, the marching-tetrahedra wall of 14e) with the interstitial
   speed U_s/ε_open (scope §11.2).

   Driving: the force for each point is predicted from the points already
   solved on that axis (Darcy plus the Forchheimer slope so far) and the run
   starts from the previous point's flow (warm start).  The fit uses the
   Reynolds number actually reached; one warm correction when a point lands
   more than 25 % off its target.  A point whose mean flow stops settling is
   averaged over a window and flagged unsteady (shown, not fitted).

   Record (decision 0004 A) — FLOW_HX_BY_DESIGN[id], dimensionless, so fluid,
   cell size and units are display-only:
     { v: 'hx-1', base, N, eps (open porosity), epsTot, dh (voxels), K [3]
       (voxels², creeping-flow diagonal), kL2 [3], ReList, axes [3]: null |
       { points: [{ ReT, Re, Pi, ReK, steps, converged, unsteady, tau, mach,
       t_ms } | { ReT, skipped: 'grid' | 'unstable' }], t_ms }, t_ms }
   Pi = pressure gradient ÷ Darcy's at that speed (1 = pure Darcy).

   Fit (flowHXFit): Pi = 1 + F · Re_K, Re_K = U_s √K / ν, K fixed from the
   creeping run; F by least squares on relative error over the points where
   inertia is at least 10 % of the drop.  β = F / √K (1/m).  Inertia onset:
   the Reynolds number where inertia reaches 10 %.  Fanning friction factor
   f = Pi · ε · d_h² / (2 K Re).

   API
     flowHXRun(ctx, opts)                    points on uploaded tables (19g afterSolve hook)
     homogenizeFlowHX(recipe, N, opts)       standalone (creeping result cached)
     flowHXFit(rec, axis)                    F, fit range, onset, top point
     flowHXPhysical(rec, axis, cfg)          speeds, Pa/m, β for a fluid and cell size
     flowHXPick(rec, dir)                    the axis the card reports
     flowHXParseRe(text)                     the Reynolds list from the settings field
     runFlowHXGPUCheck(i, N, steps, Re)      console: GPU vs Float64 CPU at a Reynolds number
     runFlowCastroHXCheck(N)                 console: Castro / Tupin & Ohta β ranking
   ============================================================ */

var FLOW_HX_VERSION = 'hx-1';
var FLOW_HX_RE_DEFAULT = [2, 5, 10, 20, 50, 100];   /* decision 0005 A */
var FLOW_HX_U = 0.03;            /* mean pore lattice speed per point (peaks about 0.1) */
var FLOW_HX_TAU_MAX = 1.5;       /* the creeping-flow relaxation time */
var FLOW_HX_TAU_MIN = 0.51;
var FLOW_HX_BL_MIN = 2.5;        /* voxels across d_h / √Re */
var FLOW_HX_TOL = 1e-5;          /* change of the mean flow over 500 steps */
var FLOW_HX_MAX_STEPS = 60000;   /* per solve at 64³ (× (N/64)²); Matt's bench: Re 100 settled in 7,500 */
var FLOW_HX_FIT_SHARE = 0.10;    /* fit points where inertia is ≥ 10 % of the drop */
var FLOW_HX_LAMBDA = 3 / 16;
var FLOW_HX_RETARGET = 0.10;     /* re-aim a point that lands more than 10 % off its Reynolds number … */
var FLOW_HX_RETRIES = 2;         /* … at most twice, warm */
var FLOW_HX_MACH_MAX = 0.3;      /* peak speed ÷ lattice sound speed; above it the point re-runs slower */
var FLOW_HX_RUNAWAY = 4;         /* mean flow above 4× the point's target counts as a blow-up */
var FLOW_HX_MAX_POINTS = 12;
var FLOW_HX_BY_DESIGN = {};

/* ---------- solver: continue from the current state, any τ⁺ ----------
   Same kernels and uniform layout as FlowGPUSolver.prototype.solve (19g),
   which stays as it is for creeping flow.  opts: { tauPlus, lambda, warm,
   tol, maxSteps, minSteps, checkEvery, noUnsteady, isStale }. */
async function flowHXSolveGPU(F, opts) {
  opts = opts || {};
  var dev = this.device, tauP = opts.tauPlus || FLOW_TAU_PLUS, lam = opts.lambda || FLOW_HX_LAMBDA;
  var tol = opts.tol != null ? opts.tol : FLOW_HX_TOL, every = opts.checkEvery || FLOW_CHECK_EVERY;
  var maxSteps = opts.maxSteps || FLOW_HX_MAX_STEPS, minSteps = opts.minSteps || 2 * every;
  var tauM = 0.5 + lam / (tauP - 0.5), wP = 1 / tauP, wM = 1 / tauM;
  var u = new ArrayBuffer(48), uu = new Uint32Array(u), uf = new Float32Array(u);
  uu[0] = this.N; uu[1] = this.N3; uf[2] = 1 / this.nFluid; uf[3] = 1 / this.N3; uf[4] = F[0]; uf[5] = F[1]; uf[6] = F[2]; uf[7] = wP; uf[8] = wM;
  dev.queue.writeBuffer(this.ub, 0, u);
  var ru = new ArrayBuffer(16), ruu = new Uint32Array(ru), ruf = new Float32Array(ru);
  ruu[0] = this.nWG; ruf[1] = 1 / this.nFluid; ruf[2] = 1 / this.N3;
  dev.queue.writeBuffer(this.rb, 0, ru);
  var parity = 0;
  if (opts.warm && this._last) parity = this._last === this.B ? 1 : 0;
  else {
    var enc0 = dev.createCommandEncoder();
    enc0.clearBuffer(this.A); enc0.clearBuffer(this.B); enc0.clearBuffer(this.red);
    dev.queue.submit([enc0.finish()]);
  }
  var steps = 0, prev = null, rel = 1, R = null, t0 = performance.now(), rels = [], unsteady = false, avg = null, nAvg = 0, avgLeft = 0;
  while (steps < maxSteps) {
    var enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
    for (var s = 0; s < every; s++) {
      pass.setPipeline(this.pStep); pass.setBindGroup(0, parity ? this.bgBA : this.bgAB); pass.dispatchWorkgroups(this.nWG);
      pass.setPipeline(this.pRed); pass.setBindGroup(0, this.bgR); pass.dispatchWorkgroups(1);
      parity ^= 1;
    }
    pass.end(); dev.queue.submit([enc.finish()]); steps += every;
    R = await this._readRed();
    if (opts.isStale && opts.isStale()) return null;
    var Um = Math.hypot(R[1], R[2], R[3]);
    /* blow-up: not a number, or the mean flow running away past opts.runaway (Matt's bench, 2026-11-12:
       an unstable point stayed finite for 231,500 steps before it showed as NaN) */
    if (!isFinite(Um) || (opts.runaway > 0 && (Um > opts.runaway || R[4] > 3 * opts.runaway))) {
      this._last = parity ? this.B : this.A; return { unstable: true, steps: steps, t_ms: performance.now() - t0 };
    }
    rel = prev ? Math.hypot(R[1] - prev[0], R[2] - prev[1], R[3] - prev[2]) / Math.max(Um, 1e-30) : 1;
    prev = [R[1], R[2], R[3]];
    if (avg) {
      avg[0] += R[1]; avg[1] += R[2]; avg[2] += R[3]; avg[3] += R[4]; nAvg++;
      if (--avgLeft <= 0) break;
      continue;
    }
    rels.push(rel);
    if (steps >= minSteps && rel < tol) break;
    /* unsteady: the smallest change over the last 8 checks is no smaller than
       70 % of the smallest over the 8 before — the flow stopped settling */
    if (!opts.noUnsteady && rels.length >= 24) {
      var a = Infinity, b = Infinity;
      for (var k = rels.length - 8; k < rels.length; k++) a = Math.min(a, rels[k]);
      for (var k2 = rels.length - 16; k2 < rels.length - 8; k2++) b = Math.min(b, rels[k2]);
      if (a >= 0.7 * b) { unsteady = true; avg = [0, 0, 0, 0]; avgLeft = Math.max(8, Math.min(rels.length, Math.floor((maxSteps - steps) / every))); }
    }
  }
  this._last = parity ? this.B : this.A;
  var U = [R[1], R[2], R[3]], Uabs = R[4];
  if (avg && nAvg) { U = [avg[0] / nAvg, avg[1] / nAvg, avg[2] / nAvg]; Uabs = avg[3] / nAvg; }
  return { U: U, Uabs: Uabs, steps: steps, rel: rel, converged: !unsteady && rel < tol, unsteady: unsteady,
           t_ms: performance.now() - t0, nu: (tauP - 0.5) / 3 };
}
if (typeof FlowGPUSolver !== 'undefined') FlowGPUSolver.prototype.solveHX = flowHXSolveGPU;

/* peak lattice speed of the last solve (Mach check) */
async function flowHXPeakSpeed(S) {
  var v = await S.readVelocity(), pk = 0;
  for (var c = 0; c < v.length; c += 3) { var s = v[c] * v[c] + v[c + 1] * v[c + 1] + v[c + 2] * v[c + 2]; if (s > pk) pk = s; }
  return Math.sqrt(pk);
}

/* hydraulic diameter in voxels from the wall probes' area (14e marginWallProbes) */
function flowHXHydraulicDiameter(probes, porosity, N) {
  if (!probes || !probes.n) return null;
  var A = 0;
  for (var p = 0; p < probes.n; p++) A += probes.area[p];
  return A > 0 ? 4 * porosity * N * N * N / A : null;
}

/* the relaxation time and lattice speed of one point; null when beyond the grid */
function flowHXPointSetup(Re, dh, uI) {
  uI = uI || FLOW_HX_U;
  var nu = uI * dh / Re, tau = 0.5 + 3 * nu, u = uI;
  if (tau > FLOW_HX_TAU_MAX) { tau = FLOW_HX_TAU_MAX; nu = (tau - 0.5) / 3; u = Re * nu / dh; }
  if (tau < FLOW_HX_TAU_MIN || dh / Math.sqrt(Re) < FLOW_HX_BL_MIN) return null;
  return { tau: tau, nu: nu, u: u };
}

/* force for a point: Darcy at the target speed times the resistance the earlier points on this
   axis predict (their Forchheimer slope, the latest one), so the first try lands close (Matt's
   bench with a fixed guess overshot Re by up to 3.4× on a 95 % open design) */
function flowHXForce(pts, su, UsT, sqK, K) {
  var last = null;
  for (var q = pts.length - 1; q >= 0; q--) if (pts[q].Pi > 0) { last = pts[q]; break; }
  var slope = last && last.ReK > 0 ? Math.max(0, (last.Pi - 1) / last.ReK) : 0;
  return (1 + slope * UsT * sqK / su.nu) * su.nu * UsT / K;
}

/* ---------- the points on tables already on the GPU ----------
   ctx: { S, N, eps (open porosity), epsTot, dh (voxels), K [3] (voxels²), openBits }
   opts: { ReList, axes [0..2], isStale, onProgress({ axis, point, total, Re }), tol, maxSteps, uI, lambda } */
async function flowHXRun(ctx, opts) {
  opts = opts || {};
  var t0 = performance.now(), S = ctx.S, N = ctx.N, ReList = (opts.ReList || FLOW_HX_RE_DEFAULT).slice();
  var rec = { v: FLOW_HX_VERSION, N: N, eps: ctx.eps, epsTot: ctx.epsTot, dh: ctx.dh, K: ctx.K.slice(), kL2: ctx.K.map(function (k) { return k / (N * N); }),
              ReList: ReList, axes: [null, null, null], uI: opts.uI || FLOW_HX_U, lambda: opts.lambda || FLOW_HX_LAMBDA, steps: 0, t_ms: 0 };
  if (!(ctx.dh > 0)) return rec;
  var axes = (opts.axes || [0, 1, 2]).filter(function (a) { return (ctx.openBits & (1 << a)) && ctx.K[a] > 0; });
  var total = axes.length * ReList.length, done = 0;
  for (var ai = 0; ai < axes.length; ai++) {
    var ax = axes[ai], K = ctx.K[ax], sqK = Math.sqrt(K), pts = [], warm = false, dead = false, tA = performance.now();
    var vec = function (g) { var v = [0, 0, 0]; v[ax] = g; return v; };
    for (var pi = 0; pi < ReList.length; pi++) {
      var ReT = ReList[pi];
      if (opts.onProgress) opts.onProgress({ axis: 'xyz'[ax], point: done, total: total, Re: ReT });
      done++;
      var su = dead ? null : flowHXPointSetup(ReT, ctx.dh, rec.uI);
      if (!su) { pts.push({ ReT: ReT, skipped: dead ? 'unstable' : 'grid' }); continue; }
      var steps = 0, tP = 0, r = null, g = 0, Us = 0, Re = 0, mach = 0, fail = false, slowed = false;
      var maxSteps = opts.maxSteps || Math.round(FLOW_HX_MAX_STEPS * (N / 64) * (N / 64));
      for (var pass = 0; pass < 2 && su; pass++) {
        var UsT = su.u * ctx.eps;
        var so = { tauPlus: su.tau, lambda: rec.lambda, tol: opts.tol, maxSteps: maxSteps, isStale: opts.isStale, runaway: FLOW_HX_RUNAWAY * UsT };
        g = flowHXForce(pts, su, UsT, sqK, K);
        /* aim, then re-aim from the drag just measured (Darcy + Forchheimer through this point) */
        for (var t = 0; t <= FLOW_HX_RETRIES; t++) {
          r = await S.solveHX(vec(g), Object.assign({ warm: warm }, so));
          if (!r) return null;
          steps += r.steps; tP += r.t_ms;
          if (r.unstable) { fail = true; break; }
          warm = true;
          Us = r.U[ax]; Re = Us / ctx.eps * ctx.dh / su.nu;
          if (!(Us > 0) || Math.abs(Re / ReT - 1) <= FLOW_HX_RETARGET || t === FLOW_HX_RETRIES) break;
          var b = (g - su.nu * Us / K) / (Us * Us);
          g = b > 0 ? su.nu * UsT / K + b * UsT * UsT : g * UsT / Us;
        }
        if (fail) break;
        mach = (await flowHXPeakSpeed(S)) / Math.sqrt(1 / 3);
        if (opts.isStale && opts.isStale()) return null;
        if (mach <= FLOW_HX_MACH_MAX || pass === 1) break;
        /* too fast at the peak: the same Reynolds number at a lower lattice speed (and viscosity) */
        su = flowHXPointSetup(ReT, ctx.dh, su.u * 0.9 * FLOW_HX_MACH_MAX / mach);
        slowed = true;
      }
      rec.steps += steps;
      if (fail) { pts.push({ ReT: ReT, skipped: 'unstable', tau: su.tau, steps: steps }); dead = true; warm = false; continue; }
      if (!su) { pts.push({ ReT: ReT, skipped: 'grid', steps: steps }); continue; }
      pts.push({ ReT: ReT, Re: Re, Pi: g * K / (su.nu * Us), ReK: Us * sqK / su.nu, steps: steps, converged: r.converged, unsteady: r.unsteady,
                 tau: su.tau, mach: mach, slowed: slowed, t_ms: tP });
    }
    rec.axes[ax] = { points: pts, t_ms: performance.now() - tA };
  }
  rec.t_ms = performance.now() - t0;
  return rec;
}

/* ---------- standalone: build the walls, take K from the creeping record or solve it ----------
   opts: { connectivity, pruneLargest, tol (creeping), ReList, axes, Kvox [3] (creeping diagonal,
           voxels² — skips the creeping solves), isStale, onVoxelProgress, onProgress } */
async function homogenizeFlowHX(recipe, N, opts) {
  opts = opts || {};
  var links = await buildFlowLinksParallel(recipe, N, { connectivity: opts.connectivity, pruneLargest: opts.pruneLargest }, opts.onVoxelProgress);
  if (opts.isStale && opts.isStale()) return null;
  var dom = flowFluidDomain(links.solid, N), N3 = N * N * N;
  var dh = flowHXHydraulicDiameter(links.probes, dom.nFluid / N3, N);
  var T = flowGPUTables(links, dom.mask);
  links = null;
  var S = flowGPUSolver(N);
  S.upload(T);
  var axes = (opts.axes || [0, 1, 2]).filter(function (a) { return dom.openBits & (1 << a); });
  var K = [0, 0, 0], g0 = 1e-5 * (64 / N) * (64 / N);
  for (var i = 0; i < axes.length; i++) {
    var a = axes[i];
    if (opts.Kvox && opts.Kvox[a] > 0) { K[a] = opts.Kvox[a]; continue; }
    var F = [0, 0, 0]; F[a] = g0;
    var r = await S.solve(F, { tol: opts.tol || 1e-6, tauPlus: FLOW_TAU_PLUS, isStale: opts.isStale });
    if (!r) return null;
    K[a] = r.nu * r.U[a] / g0;
  }
  return flowHXRun({ S: S, N: N, eps: dom.nOpen / N3, epsTot: dom.nFluid / N3, dh: dh, K: K, openBits: dom.openBits },
                   { ReList: opts.ReList, axes: axes, isStale: opts.isStale, onProgress: opts.onProgress, tol: opts.hxTol, maxSteps: opts.maxSteps });
}

/* the 19g afterSolve hook: points on the tables the creeping solve just used */
function flowHXHook(opts, sink) {
  return async function (c) {
    var N = c.N, N3 = N * N * N, o = c.out;
    var K = [0, 1, 2].map(function (a) { return (o.perAxis[a] && o.perAxis[a].open) ? o.Ksym[4 * a] : 0; });
    var dh = flowHXHydraulicDiameter(c.probes, o.porosity, N);
    var rec = await flowHXRun({ S: c.S, N: N, eps: o.openPorosity, epsTot: o.porosity, dh: dh, K: K, openBits: o.openBits }, opts);
    sink.rec = rec;
    return rec;
  };
}

/* ---------- fit ---------- */
function flowHXValid(p) { return p && !p.skipped && p.Pi > 0 && isFinite(p.Pi) && p.Re > 0; }
function flowHXFit(rec, axis) {
  var A = rec && rec.axes && rec.axes[axis];
  if (!A) return null;
  var pts = A.points.filter(flowHXValid), use = [], sxy = 0, sxx = 0;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    if (!p.unsteady && 1 - 1 / p.Pi >= FLOW_HX_FIT_SHARE) {
      use.push(p);
      var w = 1 / (p.Pi * p.Pi);
      sxy += w * p.ReK * (p.Pi - 1); sxx += w * p.ReK * p.ReK;
    }
  }
  var F = sxx > 0 ? sxy / sxx : null, worst = 0;
  if (F != null) for (var j = 0; j < use.length; j++) worst = Math.max(worst, Math.abs(1 + F * use[j].ReK - use[j].Pi) / use[j].Pi);
  /* inertia onset: where 1 − 1/Pi crosses 10 %, log-log between points */
  var onset = null, onsetBelow = false, onsetAbove = false, cut = 1 / (1 - FLOW_HX_FIT_SHARE);
  if (pts.length) {
    if (pts[0].Pi >= cut) onsetBelow = true;
    else {
      for (var k = 1; k < pts.length && onset == null; k++) {
        var p0 = pts[k - 1], p1 = pts[k];
        if (p0.Pi < cut && p1.Pi >= cut) {
          var y0 = Math.log(Math.max(p0.Pi - 1, 1e-12)), y1 = Math.log(p1.Pi - 1), yc = Math.log(cut - 1);
          var t = (y1 > y0) ? (yc - y0) / (y1 - y0) : 0;
          onset = Math.exp(Math.log(p0.Re) + t * (Math.log(p1.Re) - Math.log(p0.Re)));
        }
      }
      if (onset == null) onsetAbove = true;
    }
  }
  var skipped = A.points.filter(function (p) { return p.skipped; });
  return { F: F, nFit: use.length, worst: worst, ReLo: use.length ? use[0].Re : null, ReHi: use.length ? use[use.length - 1].Re : null,
           onset: onset, onsetBelow: onsetBelow, onsetAbove: onsetAbove, top: pts.length ? pts[pts.length - 1] : null, first: pts.length ? pts[0] : null,
           n: pts.length, nSkipGrid: skipped.filter(function (p) { return p.skipped === 'grid'; }).length,
           nUnstable: skipped.filter(function (p) { return p.skipped === 'unstable'; }).length,
           nUnsteady: pts.filter(function (p) { return p.unsteady; }).length,
           nUnconv: pts.filter(function (p) { return !p.converged && !p.unsteady; }).length,
           machMax: pts.reduce(function (m, p) { return Math.max(m, p.mach || 0); }, 0) };
}

/* ---------- physical units for a fluid and cell size ----------
   cfg: { mu (Pa·s), rho (kg/m³), cellMm }.  Speeds are superficial (flow rate ÷ section), as on the shear rows. */
function flowHXPhysical(rec, axis, cfg) {
  var fit = flowHXFit(rec, axis);
  if (!fit || !(cfg && cfg.mu > 0 && cfg.rho > 0 && cfg.cellMm > 0)) return null;
  var N = rec.N, dx = cfg.cellMm / 1000 / N, K = rec.K[axis], Km = K * dx * dx, dhm = rec.dh * dx, nu = cfg.mu / cfg.rho, eps = rec.eps;
  function at(p) {
    var Ui = p.Re * nu / dhm, Us = eps * Ui;
    return { Re: p.Re, Us: Us, Ui: Ui, dpdx: p.Pi * cfg.mu * Us / Km, f: p.Pi * eps * rec.dh * rec.dh / (2 * K * p.Re), Kapp: Km / p.Pi, Pi: p.Pi,
             unsteady: !!p.unsteady, converged: !!p.converged };
  }
  var pts = rec.axes[axis].points.filter(flowHXValid).map(at);
  return { fit: fit, points: pts, K_m2: Km, dh_m: dhm, nu: nu,
           beta: fit.F != null ? fit.F / Math.sqrt(Km) : null,
           onsetUs: fit.onset != null ? eps * fit.onset * nu / dhm : null,
           top: fit.top ? at(fit.top) : null,
           /* Darcy and fitted pressure gradient at a superficial speed (for the chart) */
           darcy: function (Us) { return cfg.mu * Us / Km; },
           forch: function (Us) { return fit.F != null ? cfg.mu * Us / Km + fit.F / Math.sqrt(Km) * cfg.rho * Us * Us : null; },
           ReOf: function (Us) { return Us / eps * dhm / nu; } };
}

/* the axis the card reports: the Flow direction setting, All = the most permeable axis solved */
function flowHXPick(rec, dir) {
  if (!rec || !rec.axes) return null;
  var want = dir === 'xx' ? 0 : dir === 'yy' ? 1 : dir === 'zz' ? 2 : -1;
  if (want >= 0) return rec.axes[want] ? { axis: want, best: false } : { axis: want, missing: true };
  var best = -1;
  for (var a = 0; a < 3; a++) if (rec.axes[a] && (best < 0 || rec.K[a] > rec.K[best])) best = a;
  return best >= 0 ? { axis: best, best: true } : null;
}
function flowHXAxesFor(dir) { return dir === 'xx' ? [0] : dir === 'yy' ? [1] : dir === 'zz' ? [2] : [0, 1, 2]; }

/* the Reynolds list from the settings field: numbers 0.1–1000, sorted, at most 12 */
function flowHXParseRe(text) {
  var v = String(text || '').split(/[\s,;]+/).map(function (s) { return parseFloat(s); })
    .filter(function (x) { return isFinite(x) && x >= 0.1 && x <= 1000; });
  v.sort(function (a, b) { return a - b; });
  var out = [];
  v.forEach(function (x) { x = +x.toPrecision(3); if (out.indexOf(x) < 0) out.push(x); });
  return out.slice(0, FLOW_HX_MAX_POINTS);
}

/* ---------- console check: GPU vs the Float64 CPU reference at a Reynolds number ----------
   runFlowHXGPUCheck()                 design A, 24³, Re 50, 2,000 steps along x
   runFlowHXGPUCheck(1, 32, 3000, 100)
   Same relaxation time and force on both, from rest; pass: mean velocity and every
   population within 1e-4 relative. */
async function runFlowHXGPUCheck(designIndex, N, steps, Re) {
  designIndex = designIndex || 0; N = N || 24; steps = steps || 2000; Re = Re || 50;
  if (typeof prepareFlowDomain !== 'function') {
    await new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = '19f-flow-cpu-ref.js?v=' + FLOW_HX_VERSION; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  }
  if (typeof ensureDevice === 'function') await ensureDevice();
  var d = LAB_STATE.designs[designIndex], rcp = d && applySelectedMaterial(recipeForDesign(d));
  if (!rcp) { console.warn('[flow HX check] no recipe for design ' + designIndex); return null; }
  var links = await buildFlowLinksParallel(rcp, N, connOpts()), dom = flowFluidDomain(links.solid, N), N3 = N * N * N;
  var dh = flowHXHydraulicDiameter(links.probes, dom.nFluid / N3, N);
  var su = dh ? flowHXPointSetup(Re, dh) : null;
  if (!su) { console.warn('[flow HX check] Re ' + Re + ' is beyond a ' + N + '³ grid for this design (hydraulic diameter ' + (dh ? dh.toFixed(1) : '—') + ' voxels)'); return null; }
  var T = flowGPUTables(links, dom.mask), cpuDom = prepareFlowDomain(links, { wall: 'cli', mask: dom.mask });
  /* force for about the target speed with a Forchheimer guess of 1 */
  var K0 = 2e-3 * N * N, Us = su.u * dom.nOpen / N3, g = su.nu * Us / K0 + Us * Us / Math.sqrt(K0);
  var t0 = performance.now();
  var cpu = solveFlowCPU(cpuDom, { force: [g, 0, 0], tauPlus: su.tau, lambda: FLOW_HX_LAMBDA, tol: 0, maxSteps: steps, checkEvery: steps });
  var cpuMs = performance.now() - t0, S = flowGPUSolver(N);
  S.upload(T);
  var gpu = await S.solveHX([g, 0, 0], { tauPlus: su.tau, tol: 0, maxSteps: steps, minSteps: steps, checkEvery: Math.min(500, steps), noUnsteady: true });
  var st = await S.readState(), maxAbs = 0, maxF = 0;
  for (var a = 0; a < cpuDom.n; a++) { var x = cpuDom.nodes[a]; for (var i = 0; i < 19; i++) {
    var c = cpu.state[a * 19 + i]; maxAbs = Math.max(maxAbs, Math.abs(c - st[i * N3 + x])); maxF = Math.max(maxF, Math.abs(c)); } }
  var relU = Math.abs(gpu.U[0] - cpu.U[0]) / Math.max(Math.abs(cpu.U[0]), 1e-30), relF = maxF > 0 ? maxAbs / maxF : 0;
  var res = { design: d.label || d.id, N: N, steps: steps, Re_target: Re, tauPlus: +su.tau.toFixed(4), Re_cpu: +(cpu.U[0] / (dom.nOpen / N3) * dh / su.nu).toPrecision(3),
              relU: relU, relPop: relF, cpuMs: Math.round(cpuMs), pass: relU < 1e-4 && relF < 1e-4 && cpuDom.nWallLinks === T.nWall };
  console.log('[flow HX check] ' + JSON.stringify(res));
  return res;
}

/* ---------- console check: Castro et al. 2019 refit by Tupin & Ohta 2020 ----------
   runFlowCastroHXCheck()       flow grid from Configure (64 by default)
   Sheet gyroid, Schwarz P and Schwarz D at 70 % porosity, 3.25 mm cells (as runFlowCastroCheck),
   pressure-drop points along x.  Tupin & Ohta (Materials 2020, 13:2535) fitted Castro's water data
   (Re 29–145) with Darcy–Forchheimer: β = 3,044 (gyroid), 4,035 (P), 5,390 (D) 1/m.
   Pass: the same ranking D > P > G in β.  Ratios to gyroid are informational (theirs 1.33 and 1.77).
   Their permeabilities (2.4e-7 m² gyroid) are about 14× the sheet value at 3.25 mm, so their samples
   may not be the sheets modelled here; read the ratios with that in mind. */
var FLOW_CASTRO_BETA = { 'Gyroid': 3044, 'Schwarz P': 4035, 'Schwarz D': 5390 };
async function runFlowCastroHXCheck(N, ReList) {
  N = N || (typeof FLOW_STATE !== 'undefined' && FLOW_STATE.N) || 64;
  ReList = ReList || [10, 20, 50, 100];
  if (typeof ensureDevice === 'function') await ensureDevice();
  var cell = 3.25, water = { mu: 0.89e-3, rho: 997, cellMm: cell }, out = [], t0 = performance.now(), by = {};
  for (var name in FLOW_CASTRO_TERMS) {
    var terms = FLOW_CASTRO_TERMS[name].map(function (fs) { return { on: true, coef: 1, factors: fs.map(function (t) { return { trig: t, fx: 1, fy: 1, fz: 1 }; }) }; });
    var rc = { family: 'tpms', name: name + ' sheet', surface: { type: 'terms', terms: terms },
               geometry: { mode: 'shell', offset: 0, wallThickness: 0.3, cellSizeMm: cell, cellMult: 1 } };
    var spec = sweepSpecByKey(rc, 'wallThickness'), v = spec ? sweepParamsForFractions(rc, spec, N, [0.30])[0] : null;
    if (v == null) { console.warn('[flow Castro HX] ' + rc.name + ': 30 % solid not reachable'); continue; }
    sweepParamSet(rc, spec, v);
    var sink = {}, hxo = { ReList: ReList, axes: [0] };
    await homogenizeFlowGPU(rc, N, Object.assign({}, connOpts(), { tol: 1e-6, keepFields: false, keepWss: false, afterSolve: flowHXHook(hxo, sink) }));
    var ph = sink.rec ? flowHXPhysical(sink.rec, 0, water) : null;
    var row = { surface: name, level: +v.toPrecision(4), dh_vox: sink.rec ? +sink.rec.dh.toFixed(1) : null,
                F: ph && ph.fit.F != null ? +ph.fit.F.toPrecision(3) : null, beta_1m: ph && ph.beta != null ? Math.round(ph.beta) : null,
                fit_points: ph ? ph.fit.nFit : 0, fit_worst_pct: ph ? +(ph.fit.worst * 100).toFixed(1) : null,
                top_Re: ph && ph.top ? +ph.top.Re.toPrecision(3) : null, Kapp_top_e9: ph && ph.top ? +(ph.top.Kapp * 1e9).toPrecision(3) : null,
                tupin_beta_1m: FLOW_CASTRO_BETA[name] };
    by[name] = row; out.push(row);
  }
  var G = by['Gyroid'], P = by['Schwarz P'], D = by['Schwarz D'];
  if (G && G.beta_1m) [P, D].forEach(function (r) { if (r && r.beta_1m) { r.beta_over_gyroid = +(r.beta_1m / G.beta_1m).toFixed(2); r.tupin_over_gyroid = +(r.tupin_beta_1m / G.tupin_beta_1m).toFixed(2); } });
  var pass = !!(G && P && D && D.beta_1m > P.beta_1m && P.beta_1m > G.beta_1m);
  out.push({ surface: 'ranking D > P > G in β', pass: pass });
  console.table(out);
  console.log('[flow Castro HX] N=' + N + ' · ' + (pass ? 'pass' : 'FAIL') + ' · ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { flowHXFit: flowHXFit, flowHXPhysical: flowHXPhysical, flowHXPick: flowHXPick, flowHXParseRe: flowHXParseRe,
    flowHXPointSetup: flowHXPointSetup, flowHXHydraulicDiameter: flowHXHydraulicDiameter, FLOW_HX_VERSION: FLOW_HX_VERSION };
}
