/* ============================================================
   F13LD.lab · 50-controls.js
   Physics-mode toggles, grid pill (auto + manual override),
   run button with mock progress walkthrough.
   ============================================================ */

var PHYS_STATE = {
  elastic: true,
  buckle:  true,
  nonlin:  true,
  thermal: false
};

var GRID_STATE = {
  mode: 'auto',     // 'auto' | 'manual'
  N: 64             // resolved value (32, 64, 128)
};

/* Buckling runs on the CPU reference oracle (16c) at a much smaller grid
   than the GPU elastic/thermal path — seconds per axis at N=16, minutes at N=64.  Its
   resolution is configured separately from the main Grid pill. */
var BUCKLE_STATE = {
  N: 32             // 16 | 32 | 64 (resolves thin-wall shells); radix-2 FFT -> powers of two only
};

/* Transient per-design buckling results (id -> { lambda_cr, pcr, pcr_py,
   critAxis, perAxis, modes, N, failure_mode, provisional } | { error }).
   Kept OUT of d.results (a Run All elastic pass rebuilds d.results and
   would wipe buckling) and OUT of the design objects (the heavy mode-field
   arrays must not hit localStorage).  The Buckling view tab reads here. */
var BUCKLE_BY_DESIGN = {};

/* Nonlinear crush resolution + load axis (GPU J2 plasticity, 16g).
   Nonlin pill cycles 16 -> 32 -> 64 (radix-2 FFT); axis xx/yy/zz -> crush() physical 0/1/2,
   'all' crushes every axis in turn (v0.16.0).  view = the axis the Nonlinear-tab
   preview (cubes, scrubber, metric cards) shows. */
var NONLIN_STATE = { N: 32, axis: 'zz', cap: 0.05, view: 'zz' };

/* v0.7.2 — Material pill.  One material applied to every design in the
   comparison ('recipe' keeps each design's own).  The choice is a per-viewer
   convenience (localStorage, try/catch); results are keyed by recipe
   fingerprint, which includes the material, so a change re-solves. */
var MATERIAL_STATE = { id: (typeof F13LD_MATERIAL_RECIPE_ID !== 'undefined') ? F13LD_MATERIAL_RECIPE_ID : 'recipe' };
var MATERIAL_STORE_KEY = 'f13ld.lab.material.v1';

/* Transient per-design nonlinear results (id -> { sigma_y_eff, E0, curve,
   axis, N, truncated } | { error }).  Feeds the sigma-epsilon curve tab, the
   sigma_y(z) metric, and the P_cr/P_y seam (replaces provisional SIGMA_Y_TI64_MPA). */
var NONLIN_BY_DESIGN = {};

/* v0.20.0 — thermal κ (17b GPU solver, docs/THERMAL_SCOPE.md).
   THERMAL_BY_DESIGN[id] = { base, N, kS, rho, rhoPhi, trimLoss, wraps,
   underResolved, byFiller: { air|water|tissue: {...} } } | { error }.  Kept
   out of d.results (the elastic pass rebuilds it) and out of localStorage
   (temperature fields).  Fillers are cached one by one under the same base
   signature, so ticking a filler back on never re-solves the others.
   Temperature and flux fields for the viewer are kept at half precision for
   every grid (v0.21.0, Matt: ~70 MB per design at 128³, ~9 MB at 64³). */
var THERMAL_STATE = { fillers: { air: true, water: true, tissue: true }, tol: 1e-5, maxiter: 3000, captureMaxN: 128 };
var THERMAL_BY_DESIGN = {};
var THERMAL_FRAG_FLAG = 0.05;   /* > 5 % of the solid in sub-3³-voxel fragments the island trim drops → under-resolved (Matt, 2026-10-07: trim stays on, flag it) */
function thermalFillersOn(){
  if (typeof THERMAL_FILLERS === 'undefined') return [];
  return THERMAL_FILLERS.filter(function(f){ return !!THERMAL_STATE.fillers[f.id]; });
}
/* Solid conductivity for a run: the selected library material's ks_WmK
   (null in the library = no data → thermal refuses), or the F13LD default
   Ti-6Al-4V Grade 5 (6.7 W/m·K) for a design without a library material. */
function thermalKsFor(recipe){
  var m = recipe && recipe.material;
  if (m && Object.prototype.hasOwnProperty.call(m, 'ks_WmK')) return (isFinite(m.ks_WmK) && m.ks_WmK > 0) ? m.ks_WmK : null;
  return 6.7;
}
function onThermalFillerToggle(id, on){
  THERMAL_STATE.fillers[id] = !!on;
  recomputeEstimate();
}

/* v0.16.0 — per-axis crush results (id -> { base, xx, yy, zz }).  base is the
   N|cap|prune|recipe part of the cache signature: a run with a different base
   clears the design's axes, so every stored axis belongs to the same settings.
   NONLIN_BY_DESIGN[id] is the GOVERNING axis (weakest yield) of these, which
   the cards, Load Capacity and the buckling seam read. */
var NONLIN_AXES = {};
var NL_AXIS_KEYS = ['xx', 'yy', 'zz'];

/* v0.16.0 — void stiffness scaled to the design.  The void (empty space) is
   given VOID_SCALE_FRAC of the design's own stiffness, as a fraction of the
   solid, clamped to [VOID_FLOOR, cap] and rounded down to one significant
   figure (stable cache signatures).  At a fixed 1e-4 (linear) / 1e-3 (crush)
   an ultra-compliant design (E/Es ~3e-4) read 44 / 166 MPa against 30.4 MPa
   at 1e-6; iterations were unchanged (342 -> 351). */
var VOID_SCALE_FRAC = 0.01, VOID_FLOOR = 1e-6, VOID_LINEAR_DEFAULT = 1e-4, VOID_LIMIT_FACTOR = 50;
function voidForStiffness(E_MPa, Es_MPa, cap){
  if (!(E_MPa > 0) || !(Es_MPa > 0)) return null;
  var v = Math.max(VOID_FLOOR, Math.min(cap, VOID_SCALE_FRAC * E_MPa / Es_MPa));
  var p = Math.pow(10, Math.floor(Math.log10(v) + 1e-9));
  return Math.max(VOID_FLOOR, +(Math.floor(v / p + 1e-9) * p).toPrecision(1));
}
/* True when a stiffness sits within VOID_LIMIT_FACTOR of the void (only
   possible at the floor): the void carries a visible share of the load. */
function voidLimited(E_MPa, Es_MPa, voidRatio){
  return (E_MPa > 0 && Es_MPa > 0 && voidRatio > 0) ? (E_MPa / Es_MPa < VOID_LIMIT_FACTOR * voidRatio) : false;
}
/* Softer void for a linear re-solve, or null when the default is already
   at most ~2 % of the softest axis. */
function elasticSoftVoid(R){
  if (!R || !R.valid) return null;
  var Emin = Math.min(R.Ex_MPa, R.Ey_MPa, R.Ez_MPa), cur = R.voidRatio || VOID_LINEAR_DEFAULT;
  var v = voidForStiffness(Emin, R.Es_MPa, VOID_LINEAR_DEFAULT);
  return (v != null && v <= 0.5 * cur) ? v : null;
}

function nlAxesToRun(){ return NONLIN_STATE.axis === 'all' ? NL_AXIS_KEYS.slice() : [NONLIN_STATE.axis]; }
function nlAxisEntry(id, ax){ var s = NONLIN_AXES[id]; return (s && s[ax]) || null; }
/* Axes with a usable (non-error) crush result for this design. */
function nlAvailableAxes(id){
  var out = [];
  for (var i = 0; i < NL_AXIS_KEYS.length; i++){
    var e = nlAxisEntry(id, NL_AXIS_KEYS[i]);
    if (e && !e.error) out.push(NL_AXIS_KEYS[i]);
  }
  return out;
}
/* Weakest axis: lowest 0.2%-offset yield among the axes that yielded; when
   none yielded, the lowest stress reached at the cap (a lower bound on yield). */
function nlGoverning(id){
  var best = null, bestKey = Infinity, anyYield = false, firstErr = null, i, e;
  for (i = 0; i < NL_AXIS_KEYS.length; i++){
    e = nlAxisEntry(id, NL_AXIS_KEYS[i]);
    if (e && !e.error && e.yielded && isFinite(e.sigma_y_eff)) anyYield = true;
  }
  for (i = 0; i < NL_AXIS_KEYS.length; i++){
    e = nlAxisEntry(id, NL_AXIS_KEYS[i]);
    if (!e) continue;
    if (e.error){ if (!firstErr) firstErr = e; continue; }
    var key = anyYield ? ((e.yielded && isFinite(e.sigma_y_eff)) ? e.sigma_y_eff : Infinity)
                       : (isFinite(e.sigmaCap) ? e.sigmaCap : Infinity);
    if (!best || key < bestKey){ best = e; bestKey = key; }
  }
  return best || firstErr;
}
function nlRefreshGoverning(id){
  var g = nlGoverning(id);
  if (g) NONLIN_BY_DESIGN[id] = g; else delete NONLIN_BY_DESIGN[id];
}
/* Result the Nonlinear-tab preview shows: the viewed axis, else the governing one. */
function nlForView(id){
  return nlAxisEntry(id, NONLIN_STATE.view) || ((typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[id] : null);
}
function nlForget(id){ delete NONLIN_BY_DESIGN[id]; delete NONLIN_AXES[id]; }

/* Provisional yield stress for P_cr/P_y until the nonlinear solver supplies
   a real macroscopic sigma_y.  Solid Ti-6Al-4V, MPa.  Derived from the crush
   material (16f NL_MAT_DEFAULT.sigY0_MPa, 950) so the seam and the solver
   cannot drift apart; 950 literal only if 16f failed to load. */
var SIGMA_Y_TI64_MPA = (typeof NL_MAT_DEFAULT !== 'undefined' && isFinite(NL_MAT_DEFAULT.sigY0_MPa)) ? NL_MAT_DEFAULT.sigY0_MPa : 950;

/* Connectivity gate — keep only the largest periodically-connected solid
   component before every solve (prunes floating islands).  Default on; the
   flag is part of each mode's recompute signature, so toggling it forces a
   fresh solve. */
/* v0.8.2 — connectivity policy (was a keep-largest toggle):
     'networks' keep every network that spans the cell, drop floating islands (default)
     'largest'  keep only the largest network — one side of an interwoven weave
     'off'      keep everything (buckling still drops floating islands: they are free bodies)
   pruneLargest mirrors "not off" for solvers/tests that only read the old flag. */
var GEOM_STATE = { connectivity: 'networks', pruneLargest: true, partialVolume: true };   /* v0.19.0 — partial-volume voxels for stiffness (default on) */
function connOpts(){ return { connectivity: GEOM_STATE.connectivity, pruneLargest: GEOM_STATE.connectivity !== 'off', partialVolume: !!GEOM_STATE.partialVolume }; }

var RUN_STATE = {
  running: false,
  currentIndex: 0,  // which design is currently being solved (mock)
  timer: null,
  progress: 0,
  /* Phase-6 tie-up #3 — run-token + live-activity gating so a stale, early,
     or duplicate finishRun() can never paint a "run complete" pill while the
     real pipeline is still solving.  startRun() bumps `token`; runRealSweep()
     captures it and hands it to finishRun(), which no-ops on a token mismatch.
     cancelRun() also bumps `token`, invalidating any in-flight completion.
     `activeWorkers` is the live-activity flag: > 0 means buckling workers are
     still in flight, so finishRun() refuses to finalize. */
  token: 0,
  finishedToken: -1,
  activeWorkers: 0,
  /* Sprint A — sweep serialization: sweepDone chains every sweep so a new one
     starts only after the previous (cancelled) one has returned; sweepLive is
     the token of the sweep currently executing (0 = none). */
  sweepDone: null,
  sweepLive: 0,
  /* Phase-6 tie-up #4 — wall-clock anchors for the live ETA + per-mode timing. */
  t0: 0,
  estTotalSec: 0
};

/* Phase-6 tie-up #4 — last run's measured per-mode wall-times (ms), surfaced
   to the console and folded into the next estimate via RUN_CALIB. */
var RUN_TIMING = { elastic: 0, nonlinear: 0, buckling: 0, thermal: 0 };

/* ============================================================
   PHYSICS TOGGLES
   ============================================================ */
function onConnectivityChange(v){
  if (v !== 'networks' && v !== 'largest' && v !== 'off') return;
  GEOM_STATE.connectivity = v;
  GEOM_STATE.pruneLargest = (v !== 'off');
}

/* v0.19.0 — surface voxels for the stiffness solve: partial volume (default;
   each voxel the surface passes through carries its solid fraction and blends
   solid and void stiffness — grid-converged at N = 64 on the PI-TPMS paper's
   trio, docs/PARTIAL_VOLUME.md) or the plain 0/1 cube (behaviour before
   v0.19.0).  Crush and buckling always use the 0/1 cube. */
function onSurfaceVoxelChange(v){
  GEOM_STATE.partialVolume = (v !== 'binary');
}

function onPhysToggle(el){
  var key = el.dataset.phys;
  PHYS_STATE[key] = !PHYS_STATE[key];
  if (PHYS_STATE[key]) el.classList.add('on');
  else                  el.classList.remove('on');
  recomputeEstimate();
  if (typeof paintDock === 'function') paintDock();
}

/* ============================================================
   GRID PILL — auto-pick by default, click to cycle through
   manual options. Cycles: Auto → 32³ → 64³ → 128³ → Auto
   ============================================================ */
function onGridPillClick(){
  var cycle = ['auto', 32, 64, 128];
  var current = (GRID_STATE.mode === 'auto') ? 'auto' : GRID_STATE.N;
  var idx = cycle.indexOf(current);
  var next = cycle[(idx + 1) % cycle.length];
  if (next === 'auto'){
    GRID_STATE.mode = 'auto';
    GRID_STATE.N = autoPickGrid();
  } else {
    GRID_STATE.mode = 'manual';
    GRID_STATE.N = next;
  }
  paintGridPill();
  recomputeEstimate();
}

function paintGridPill(){
  if (typeof paintDock === 'function') paintDock();   /* v0.22.0 — grid lives in the dock drawer */
}

/* ============================================================
   BUCKLE GRID PILL — cycles the CPU buckling resolution 16 → 32 → 64.
   ============================================================ */
function onBucklePillClick(){
  BUCKLE_STATE.N = (BUCKLE_STATE.N === 16) ? 32 : (BUCKLE_STATE.N === 32) ? 64 : 16;
  paintBucklePill();
  recomputeEstimate();
}

function paintBucklePill(){
  if (typeof paintDock === 'function') paintDock();
}

/* ============================================================
   NONLIN GRID PILL — cycles GPU nonlinear crush resolution 16 → 32 → 64,
   plus the load-axis dropdown handler.
   ============================================================ */
function onNonlinPillClick(){
  NONLIN_STATE.N = (NONLIN_STATE.N === 16) ? 32 : (NONLIN_STATE.N === 32) ? 64 : 16;
  paintNonlinPill();
  recomputeEstimate();
}

function paintNonlinPill(){
  if (typeof paintDock === 'function') paintDock();
}

function onNonlinAxisChange(axis){
  if (axis === 'xx' || axis === 'yy' || axis === 'zz' || axis === 'all') NONLIN_STATE.axis = axis;
  if (axis !== 'all' && NONLIN_STATE.axis === axis) NONLIN_STATE.view = axis;
  recomputeEstimate();   /* All = three crushes per design */
}

/* Nonlinear-tab axis switch (preview cubes, scrubber, metric cards; the
   matching curves are drawn bold on the merged plot). */
function onNonlinViewAxis(axis){
  if (NL_AXIS_KEYS.indexOf(axis) < 0) return;
  NONLIN_STATE.view = axis;
  var mPlot = document.getElementById('mergedPlot');
  if (mPlot && typeof renderMergedCurvePlot === 'function') renderMergedCurvePlot(mPlot);
  if (typeof renderNonlinearViz === 'function') renderNonlinearViz();
}

/* CRUSH-STRAIN CAP pill — cycles the adaptive crush ceiling 2% -> 5% -> 10%. */
function onNonlinCapPillClick(){
  var cyc = [0.02, 0.05, 0.10];
  var idx = cyc.indexOf(NONLIN_STATE.cap);
  NONLIN_STATE.cap = cyc[(idx + 1) % cyc.length];
  paintNonlinCapPill();
  recomputeEstimate();
}

function paintNonlinCapPill(){
  if (typeof paintDock === 'function') paintDock();
}

/* ============================================================
   ESTIMATE — recomputes wall-time estimate based on grid,
   physics modes, and design count. Mock formula matches the
   compute-envelope numbers from the proposal docs.
   ============================================================ */
/* Phase-6 tie-up #4 — per-mode run-time model.
   The old estimate scaled the WHOLE base sum by the elastic Grid pill — wrong,
   because buckling and nonlinear run at their OWN grids (BUCKLE_STATE.N /
   NONLIN_STATE.N) and the nonlinear stage also scales with the crush-ε cap.
   We now estimate each mode separately, scaled by its own grid (and nonlinear
   by the cap), then sum.  After the first real run, RUN_CALIB.<mode> holds the
   MEASURED seconds-per-design at the grid that run used; subsequent estimates
   prefer the calibrated figure (rescaled to the currently-selected grid) over
   the hard-coded reference, so the headline number self-corrects per machine. */

/* Reference seconds-per-design at each mode's reference grid (uncalibrated). */
var RUN_REF = {
  elastic:   { sec: 2.0,  refN: 64 },   /* full-Voigt 6-LC @ N=64 */
  buckling:  { sec: 25.0, refN: 32 },   /* v0.8.0 voxel FE, 3-axis pool @ N=32: Schwarz P (dense) 34 s / axis in a
                                           slow single-thread sandbox, axes in parallel; sheets ~12 s */
  nonlinear: { sec: 90.0, refN: 16, refCap: 0.05 }, /* sync-bound crush @ N=16, 5% cap */
  thermal:   { sec: 2.0,  refN: 64 }   /* v0.20.0 — per filler, incl. its share of the wall-voxel build (uncalibrated guess) */
};

/* Calibration: measured seconds-per-design keyed by mode → { sec, N, cap }.
   Persisted so the estimate is already calibrated on the next page load. */
var RUN_CALIB_KEY = 'f13ld.lab.timing.v3';   /* v0.8.0 — buckling method changed (voxel FE); drop spectral calibrations */
var RUN_CALIB = (function(){
  try { var j = localStorage.getItem(RUN_CALIB_KEY); if (j) return JSON.parse(j); } catch(e){}
  return {};
})();
function saveRunCalib(){ try { localStorage.setItem(RUN_CALIB_KEY, JSON.stringify(RUN_CALIB)); } catch(e){} }

/* gridScale — FFT/CG cost grows ~N^3 with a mild log term; we use a plain
   N^3 ratio, which matches the old 32→0.12 / 128→10 anchors closely enough. */
function gridScale(N, refN){ var r = N / refN; return r*r*r; }

/* Per-design seconds for one mode at the currently-selected grid, preferring
   measured calibration (rescaled from the grid it was measured at) over RUN_REF. */
function modePerDesignSec(mode){
  var ref = RUN_REF[mode];
  var cal = RUN_CALIB[mode];
  if (mode === 'elastic'){
    var N = GRID_STATE.N;
    var base = cal ? cal.sec * gridScale(N, cal.N) : ref.sec * gridScale(N, ref.refN);
    if (!HW.webgpu_available) base *= 18;   /* CPU WASM fallback only hits the GPU elastic path */
    return base;
  }
  if (mode === 'buckling'){
    var bN = BUCKLE_STATE.N;
    return cal ? cal.sec * gridScale(bN, cal.N) : ref.sec * gridScale(bN, ref.refN);
  }
  if (mode === 'nonlinear'){
    var nN = (typeof NONLIN_STATE !== 'undefined') ? NONLIN_STATE.N : 16;
    var cap = (typeof NONLIN_STATE !== 'undefined') ? NONLIN_STATE.cap : 0.05;
    if (cal){ return cal.sec * gridScale(nN, cal.N) * (cap / (cal.cap || 0.05)); }
    return ref.sec * gridScale(nN, ref.refN) * (cap / ref.refCap);
  }
  if (mode === 'thermal'){
    var tN = GRID_STATE.N, nF = Math.max(1, thermalFillersOn().length);
    return nF * (cal ? cal.sec * gridScale(tN, cal.N) : ref.sec * gridScale(tN, ref.refN));
  }
  return 0;
}

/* estimateSeconds — total predicted wall-time across enabled modes × designs. */
function estimateSeconds(){
  var n = LAB_STATE.designs.length;
  if (n === 0) return 0;
  var total = 0;
  if (PHYS_STATE.elastic) total += modePerDesignSec('elastic')   * n;
  if (PHYS_STATE.nonlin)  total += modePerDesignSec('nonlinear') * n * nlAxesToRun().length;   /* per crush; All = 3 */
  if (PHYS_STATE.buckle)  total += modePerDesignSec('buckling')  * n;
  if (PHYS_STATE.thermal) total += modePerDesignSec('thermal')   * n;
  return total;
}

function recomputeEstimate(){
  var n = LAB_STATE.designs.length;
  if (n === 0){
    setEstimate('—');
    setDesignCount('0');
    return;
  }
  setDesignCount(String(n));
  setEstimate(formatTime(estimateSeconds()));
}

function formatTime(seconds){
  if (seconds < 60) return '~' + Math.round(seconds) + ' sec';
  if (seconds < 3600){
    var m = seconds / 60;
    return '~' + (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' min';
  }
  return '~' + (seconds / 3600).toFixed(1) + ' hr';
}

function setEstimate(text){
  var el = document.getElementById('estTimeVal');
  if (el) el.textContent = text;
}
function setDesignCount(text){
  var el = document.getElementById('designCountVal');
  if (el) el.textContent = text + (text === '1' ? ' design' : ' designs');
}

/* ============================================================
   RUN BUTTON — Phase 1 mock progress walkthrough.
   Real solver pipeline lands in Phases 3–6.
   ============================================================ */
function onRunClick(){
  if (typeof SWEEP_STATE !== 'undefined' && SWEEP_STATE.running){
    alert('A parameter sweep is running. Stop it from the Sweep panel first.');
    return;
  }
  if (RUN_STATE.running){
    cancelRun();
    return;
  }
  if (LAB_STATE.designs.length === 0) return;
  startRun();
}

function startRun(){
  RUN_STATE.running = true;
  RUN_STATE.progress = 0;
  RUN_STATE.currentIndex = 0;
  RUN_STATE.cancelled = false;       /* cancel token — checked between designs */
  RUN_STATE.token++;                 /* tie-up #3 — new run identity; stale finishRun() calls no-op */
  RUN_STATE.activeWorkers = 0;       /* tie-up #3 — live-activity flag resets each run */
  RUN_STATE.t0 = performance.now();  /* tie-up #4 — ETA anchor */
  RUN_STATE.estTotalSec = estimateSeconds();
  LAB_STATE.runHasCompleted = false;
  LAB_STATE.winningId = null;

  var btn = document.getElementById('runBtn');
  if (btn){
    btn.classList.add('running');
    btn.classList.remove('done');
    btn.innerHTML = (typeof DOCK_RUN_CANCEL !== 'undefined') ? DOCK_RUN_CANCEL : '■ Cancel';
  }
  var prog = document.getElementById('progRow');
  if (prog) prog.style.display = 'flex';

  paintSolverPill('solving', 'warn');
  setSolverSpinner(true);            /* tie-up #2 — branded "still working" mark */

  /* Pick run resolution.  Whatever the Grid pill shows is what we solve —
     Auto resolves to autoPickGrid()'s hardware-tier choice at load (128 on
     high-tier, 64 otherwise); Manual respects the user's pick.  Keeping a
     single source of truth means the pill label, the time estimate, and the
     N reported in the run status all agree with the grid passed to the solver. */
  var runN = GRID_STATE.N;

  /* Kick off the real sweep in the background (UI stays responsive; each
     design's compute is itself async).  Sprint A — sweeps are SERIALIZED: a
     cancelled sweep may still be awaiting one GPU solve it cannot abort, and it
     shares window.__sharedFFT(Batched) with any new sweep, so either could
     destroy the other's plan.  The new sweep starts only once the old one has
     hit its next token check and returned.  Any throw now ends the run cleanly
     via onSweepCrashed (was fire-and-forget: a throw left the spinner on). */
  var myToken = RUN_STATE.token;
  if (RUN_STATE.sweepLive) paintRunStatus('Stopping previous run — waiting for its in-flight solve…');
  RUN_STATE.sweepDone = (RUN_STATE.sweepDone || Promise.resolve()).then(function(){
    if (myToken !== RUN_STATE.token) return;          /* cancelled while waiting */
    RUN_STATE.sweepLive = myToken;
    return runRealSweep(runN, myToken);
  }).catch(function(err){
    onSweepCrashed(err, myToken);
  }).then(function(){
    if (RUN_STATE.sweepLive === myToken) RUN_STATE.sweepLive = 0;
  });
}


/* ============================================================
   runRealSweep — drives real elastic homogenization across all
   loaded designs sequentially.  Replaces the mock setInterval
   pipeline.

   Per-design pipeline:
     1. Resolve recipe via recipeForDesign(d) (returns null for
        designs without a usable recipe — e.g. RD demos).
     2. If recipe is null, populate d.results with sentinel
        "(stub)" values and continue.  This lets the existing
        comparison UI render without crashing while clearly
        indicating the result is not real.
     3. Otherwise, await solveDesignElasticFull(recipe, N) and
        map the full 6×6 effective stiffness tensor into the
        d.results schema (E11/E22/E33, G12/G13/G23, three Poisson
        ratios, real Zener anisotropy).

   Progress: one tick per design completion, plus an inner tick
   while a design is mid-solve.  Cancel honored between designs.

   Tabs supported by real numbers:
     ✓ Geometry (already working from raymarcher)
     ✓ Stiffness — uses E11/zener (now real C44-derived Zener A)
     ✓ Stress — heuristic (E11-derived) via existing svg
   Tabs that get sentinel values for now (physics not yet wired):
     × Buckling      — lambda_cr, pcr_py     (stub)
     × Thermal       — kappa_z               (stub)
     × Nonlinear     — sigma_y_z, hardening  (stub)
     × Deformed/σ_VM — _fieldsByAxis null until field-extraction
                       lands for the 6-LC full-Voigt path
   ============================================================ */
async function runRealSweep(N, runToken){
  var designs  = LAB_STATE.designs;
  var nDesigns = designs.length;
  var t0 = performance.now();
  /* Sprint A — per-run token guard.  startRun() and cancelRun() both bump
     RUN_STATE.token, so every await-resume checks stale() rather than the
     shared RUN_STATE.cancelled flag (which a new run used to reset to false,
     letting a cancelled sweep resume alongside it). */
  function stale(){ return runToken !== RUN_STATE.token; }
  var nFresh = { elastic: 0, nonlinear: 0, buckling: 0, thermal: 0 };   /* Sprint A — calibrate on fresh solves only (thermal: per filler) */

  var doElastic = !!PHYS_STATE.elastic;
  var doBuckle  = !!PHYS_STATE.buckle;
  var doNonlin  = !!PHYS_STATE.nonlin && typeof NonlinearSolverFull === 'function';
  var thFill    = thermalFillersOn();
  var doThermal = !!PHYS_STATE.thermal && typeof homogenizeThermalGPU === 'function' && thFill.length > 0;   /* v0.20.0 */

  /* WebGPU is required only for the elastic / GPU path. */
  if ((doElastic || doNonlin || doThermal) && typeof ensureDevice === 'function'){   /* Sprint A — nonlinear builds an FFTPlan too */
    var ok = false;
    try { ok = await ensureDevice(); } catch (e) { ok = false; }
    if (stale()) return;
    if (!ok && !doElastic){ doNonlin = false; doThermal = false; ok = true; console.warn('[run] WebGPU unavailable — skipping nonlinear and thermal'); }
    if (!ok){
      paintRunStatus('WebGPU unavailable — cannot run real elastic solver');
      paintSolverPill('webgpu unavailable', 'bad');
      finishRunFailed('WebGPU not available');
      return;
    }
  }

  /* Resolve recipes once; designs without a recipe can't run real physics. */
  var recipes = [];
  for (var ri = 0; ri < nDesigns; ri++){
    recipes.push(applySelectedMaterial((typeof recipeForDesign === 'function') ? recipeForDesign(designs[ri]) : null));
  }
  /* Sprint A — content fingerprint (sorted-key JSON hash, includes material)
     folded into every cache signature, so an id collision or an edited recipe
     can never be served another design's cached result. */
  var recipeFp = [];
  for (var rfi = 0; rfi < nDesigns; rfi++) recipeFp.push(recipes[rfi] ? recipeFingerprint(recipes[rfi]) : '');
  var nBuckleDesigns = 0;
  if (doBuckle){ for (var bi = 0; bi < nDesigns; bi++){ if (recipes[bi]) nBuckleDesigns++; } }
  var nNonlinDesigns = 0;
  if (doNonlin){ for (var npi = 0; npi < nDesigns; npi++){ if (recipes[npi]) nNonlinDesigns++; } }
  var nlRunAxes = nlAxesToRun();
  var nThermalDesigns = 0;
  if (doThermal){ for (var tpi = 0; tpi < nDesigns; tpi++){ if (recipes[tpi]) nThermalDesigns++; } }

  /* Progress in work-units: 1 per elastic design + 3 per buckled design. */
  var totalUnits = (doElastic ? nDesigns : 0) + (doNonlin ? nNonlinDesigns * 4 * nlRunAxes.length : 0) + (doBuckle ? nBuckleDesigns * 3 : 0) + (doThermal ? nThermalDesigns * thFill.length : 0);
  if (totalUnits < 1) totalUnits = 1;
  var doneUnits = 0;
  function bumpProgress(){ RUN_STATE.progress = doneUnits / totalUnits; paintRunProgress(RUN_STATE.progress); }

  var tEl0 = performance.now();
  /* ---------- Phase 1 · Elastic (GPU) ---------- */
  if (doElastic){
    for (var i = 0; i < nDesigns; i++){
      if (stale()) return;
      RUN_STATE.currentIndex = i;
      var d = designs[i];
      bumpProgress();
      var recipe = recipes[i];
      if (!recipe){
        if (!d.results) d.results = stubResults();
        d.results._runSource = 'stub (no kernel)';
        doneUnits++; bumpProgress();
        continue;
      }

      /* Skip recompute when nothing this mode depends on changed: grid N,
         prune flag, solver path (full 6-LC Voigt) and the recipe/material
         fingerprint (Sprint A — ids alone are not unique across imports). */
      var elSig = 'N' + N + '|p' + GEOM_STATE.connectivity + '|full6|cg' + CG_MAXITER_FULL + '|vs1|pv' + (GEOM_STATE.partialVolume ? 1 : 0) + '|r' + recipeFp[i];
      if (d.results && !d.results._error && d.results._elasticSig === elSig){
        paintRunStatus('<span class="v">Elastic</span> · Design ' + dletter(d, i) + ' · cached');
        doneUnits++; bumpProgress();
        continue;
      }
      paintRunStatus('<span class="v">Elastic</span> · Design ' + dletter(d, i) + ' · N=' + N + ' · solving…');
      renderDesignGrid();

      var elasticResult = null, solveErr = null;
      nFresh.elastic++;
      try {
        elasticResult = await solveDesignElasticFull(recipe, N, connOpts());
        /* v0.16.0 — compliant design: re-solve with the void scaled to it */
        var vSoft = elasticSoftVoid(elasticResult);
        if (vSoft != null && !stale()){
          paintRunStatus('<span class="v">Elastic</span> · Design ' + dletter(d, i) + ' · N=' + N + ' · compliant design · re-solving with void ' + vSoft.toExponential(0) + '…');
          var R2 = await solveDesignElasticFull(recipe, N, Object.assign({}, connOpts(), { voidRatio: vSoft }));
          if (R2 && R2.valid){ R2.voidFirst = elasticResult.voidRatio; R2.tCG_ms = (R2.tCG_ms || 0) + (elasticResult.tCG_ms || 0); elasticResult = R2; }
        }
      }
      catch (err){ solveErr = err; console.error('[run] design ' + d.id + ' elastic solve failed:', err); }
      if (stale()) return;

      if (solveErr || !elasticResult || !elasticResult.valid){
        d.results = stubResults();
        var sourceMsg;
        if (solveErr) {
          sourceMsg = 'error: ' + solveErr.message;
        } else if (elasticResult && elasticResult.reject_reason === 'disconnected') {
          var conn = elasticResult.connectivity;
          sourceMsg = 'disconnected · ' + (conn ? (conn.orphans + ' orphan voxels in ' +
                      (conn.numComponents - 1) + ' island(s) · largest ' +
                      (conn.largestFraction * 100).toFixed(1) + '%') : 'islands detected');
          d.results.connectivity = conn || null;
        } else {
          sourceMsg = (elasticResult && elasticResult.reject_reason === 'nonconvergent')
            ? ('non-physical modulus' + (elasticResult.badAxes ? ' (' + elasticResult.badAxes.join('/') + ')' : '') +
               ' — solve did not converge; likely disconnected or non-periodic in that axis')
            : 'invalid (singular C)';
        }
        d.results._runSource = sourceMsg;
        d.results._error = true;
      } else {
        d.results = mapElasticToResults(elasticResult);
        d.results._runSource = 'real elastic · N=' + N + (elasticResult.partialVolume ? ' · partial volume' : ' · 0/1 cube') + ' · ' + (elasticResult.tCG_ms|0) + ' ms';
        d.results._elasticSig = elSig;
      }
      doneUnits++; bumpProgress();
    }
  }

  if (stale()) return;

  RUN_TIMING.elastic = performance.now() - tEl0;
  var tNl0 = performance.now();
  /* ---------- Phase 2 · Nonlinear crush (GPU, 16g) ---------- */
  if (doNonlin && nNonlinDesigns > 0){
    var nlN = NONLIN_STATE.N;
    var axisMap = { xx: 0, yy: 1, zz: 2 };
    if (nlRunAxes.length === 1) NONLIN_STATE.view = nlRunAxes[0];
    var nlfft;
    if (window.__sharedFFT && window.__sharedFFT.N === nlN && window.__sharedFFT.device === WGPU.device){ nlfft = window.__sharedFFT; }
    else { if (window.__sharedFFT) window.__sharedFFT.destroy(); nlfft = new FFTPlan(nlN); window.__sharedFFT = nlfft; }

    for (var ni = 0; ni < nDesigns; ni++){
      if (stale()) return;
      RUN_STATE.currentIndex = ni;
      var dn = designs[ni];
      var rcpN = recipes[ni];
      if (!rcpN) continue;

      /* v0.16.0 — one crush per requested axis.  Axes solved earlier with the
         same grid/cap/prune/recipe are kept (and reused), so X/Y/Z run one at a
         time still build up the full three-axis set. */
      var nlBase = 'N' + nlN + '|c' + NONLIN_STATE.cap + '|p' + GEOM_STATE.connectivity + '|r' + recipeFp[ni];
      if (!NONLIN_AXES[dn.id] || NONLIN_AXES[dn.id].base !== nlBase) NONLIN_AXES[dn.id] = { base: nlBase };
      var axStore = NONLIN_AXES[dn.id];

      for (var nai = 0; nai < nlRunAxes.length; nai++){
        if (stale()) return;
        var axKey = nlRunAxes[nai];
        var axLbl = axKey.toUpperCase() + (nlRunAxes.length > 1 ? ' (' + (nai + 1) + '/' + nlRunAxes.length + ')' : '');
        paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · N=' + nlN +
                       ' · ' + axLbl + ' · crushing…');
        renderDesignGrid();

        var baseUnits = doneUnits;
        /* v0.16.0 — void scaled to the design's linear stiffness (cap 1e-3,
           the old fixed value); 1e-4 when no linear result is available.
           v0.17.1 — from the softest axis, so all three crush axes share one
           void and one elastic setup (cached in axStore._macro). */
        var nlEs = (rcpN.material && rcpN.material.Es_MPa) || 110000;
        var rLin = dn.results && !dn.results._error ? dn.results : null;
        var eLin = rLin ? 1000 * Math.min(rLin.E11 || Infinity, rLin.E22 || Infinity, rLin.E33 || Infinity) : 0;
        if (!isFinite(eLin)) eLin = 0;
        var nlVoid = voidForStiffness(eLin, nlEs, NL_VOID_CONTRAST);
        var nlVoidScaled = nlVoid != null;
        if (!nlVoidScaled) nlVoid = 1e-4;
        var nlSig = nlBase + '|a' + axKey + '|v' + nlVoid;
        var nlExist = axStore[axKey];
        if (nlExist && !nlExist.error && nlExist._sig === nlSig && nlExist.alphaSteps){
          paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · ' + axLbl + ' · cached');
          doneUnits = baseUnits + 4; bumpProgress();
          continue;
        }
        /* v0.7.2 — materials without yield data, or where J2 does not apply
           (NiTi, most polymers), get an honest skip instead of the Ti fallback. */
        if (rcpN.material && rcpN.material.crushSupported === false){
          axStore[axKey] = { error: 'crush not available for ' + (rcpN.material.name || 'this material') + ' (no yield data or J2 plasticity does not apply)', skip: true, N: nlN, axis: axKey, _sig: nlSig };
          doneUnits = baseUnits + 4; bumpProgress();
          continue;
        }
        var nlEstSteps = Math.max(8, Math.round(NONLIN_STATE.cap / 0.003125));
        var onNlStep = (function(baseU, lbl){ return function(stepIdx, eps, sig){
          /* Sprint A — throwing here aborts crush() at the next load step (16g
             calls onStep outside any try), so Cancel / a new Run no longer waits
             out a whole crush curve. */
          if (stale()) throw new Error('run superseded');
          doneUnits = baseU + 4 * Math.min(stepIdx / nlEstSteps, 0.95);
          bumpProgress();
          paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · N=' + nlN +
                         ' · ' + lbl + ' · step ' + stepIdx +
                         ' · ε=' + (eps * 100).toFixed(2) + '% · σ=' + sig.toFixed(1) + ' MPa');
        }; })(baseUnits, axLbl);
        var nlErr = null, nlOut = null;
        nFresh.nonlinear++;
        /* v0.17.1 — one crush attempt.  tight: NL_TIGHT_* field tolerances.
           The elastic setup (macro stiffness) depends only on design, grid,
           void and tolerance, so it is reused across axes (axStore._macro). */
        var runCrush = async function(tight, axisKey, store, voidC, stepCb){
          var s = new NonlinearSolverFull(nlN, nlfft);
          try {
            if (tight){ s.newtonTol = NL_TIGHT_NEWTON_TOL; if (NL_TIGHT_CG_TOL) s.cgTol = NL_TIGHT_CG_TOL; }
            s.upload(rcpN, Object.assign({}, connOpts(), { voidContrast: voidC }));
            /* the elastic setup depends on void and cgTol only (it solves at newtonTol = cgTol),
               so a tight retry reuses the first attempt's setup (v0.17.2) */
            var mk = 'v' + voidC + '|cg' + s.cgTol;
            if (store._macro && store._macro[mk]) s._Cmacro = new Float64Array(store._macro[mk]);
            var o = await s.crush(axisMap[axisKey], { control: 'stress', nSteps: 16, epsTarget: NONLIN_STATE.cap, onStep: stepCb, captureAlpha: true /* tie-up #5 — per-step plastic-strain field for the Nonlinear-tab scrubber */,
                                                      tightOnFloor: !tight });
            if (s._Cmacro){ store._macro = store._macro || {}; store._macro[mk] = Array.from(s._Cmacro); }
            return o;
          } finally { try { s.destroy(); } catch (e2){} }
        };
        var nlTight = !!axStore._tight;   /* a design that needed it once starts every later axis tight */
        try {
          nlOut = await runCrush(nlTight, axKey, axStore, nlVoid, onNlStep);
          if (nlOut && nlOut.retryTight && !stale()){
            axStore._tight = nlTight = true;
            console.log('[run] ' + dn.id + ' ' + axKey + ': ' + (nlOut.retryReason === 'cutbacks' ? nlOut.lateralCutbacks + ' side-stress cutbacks' : 'side-stress floor ' + (nlOut.lateralFloor * 100).toFixed(1) + '%') + ' — re-running the crush at the tighter step tolerance (newtonTol ' + NL_TIGHT_NEWTON_TOL + '), reusing the elastic setup');
            paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · ' + axLbl + ' · tighter solve…');
            nlOut = await runCrush(true, axKey, axStore, nlVoid, onNlStep);
          }
          /* v0.19.1 — a crush whose field solve diverges before yield is retried
             once at the tighter step tolerance (compliant designs creep up to the
             f32 precision floor — the same cure as the side-stress restart above) */
          if (nlOut && nlOut.error === 'newton_diverged' && !nlTight && !stale()){
            console.log('[run] ' + dn.id + ' ' + axKey + ': field solve diverged at ε=' + ((nlOut.eAxis || 0) * 100).toFixed(2) + '% before yield — re-running the crush at the tighter step tolerance (newtonTol ' + NL_TIGHT_NEWTON_TOL + '), reusing the elastic setup');
            paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · ' + axLbl + ' · diverged · tighter solve…');
            axStore._tight = nlTight = true;
            var firstDiv = nlOut;
            nlOut = await runCrush(true, axKey, axStore, nlVoid, onNlStep);
            /* the tight run diverging earlier than the first: keep the longer curve */
            if (nlOut && nlOut.error === 'newton_diverged' && firstDiv.curve && nlOut.curve && firstDiv.curve.length > nlOut.curve.length) nlOut = firstDiv;
          }
          /* v0.19.1 — still diverged: keep the accepted steps as a partial curve
             (no yield reached, stopped at eAxisMax) instead of dropping the design */
          if (nlOut && nlOut.error === 'newton_diverged' && nlOut.curve && nlOut.curve.length >= 2 && isFinite(nlOut.E0)){
            var lastPt = nlOut.curve[nlOut.curve.length - 1];
            console.warn('[run] ' + dn.id + ' ' + axKey + ': crush stopped at ε=' + (lastPt.eps * 100).toFixed(2) + '% (σ=' + lastPt.sigma.toFixed(1) + ' MPa) before yield — kept as a partial curve');
            nlOut = Object.assign({}, nlOut, { error: null, sigma_y_eff: lastPt.sigma, yielded: false, truncated: true, truncReason: 'diverged' });
          }
        } catch (e){ nlErr = e; if (!stale()) console.error('[run] nonlinear solve failed for ' + dn.id + ' (' + axKey + '):', e); }
        if (stale()) return;

        if (nlErr || !nlOut || nlOut.error || nlOut.retryTight || !isFinite(nlOut.sigma_y_eff)){
          axStore[axKey] = { error: (nlErr && nlErr.message) || (nlOut && nlOut.error) || 'failed', N: nlN, axis: axKey };
        } else {
          axStore[axKey] = {
            sigma_y_eff: nlOut.sigma_y_eff, yielded: !!nlOut.yielded, E0: nlOut.E0, curve: nlOut.curve,
            axis: axKey, N: nlN, truncated: !!nlOut.truncated,
            truncReason: nlOut.truncReason || null,   /* 'step-budget' | 'diverged' | null */
            eAxisMax: (nlOut.eAxisMax != null ? nlOut.eAxisMax : null),
            lateralResMax: (nlOut.lateralResMax != null ? nlOut.lateralResMax : null),
            epsCap: (nlOut.epsCap != null ? nlOut.epsCap : NONLIN_STATE.cap),
            sigmaCap: (nlOut.curve && nlOut.curve.length ? nlOut.curve[nlOut.curve.length - 1].sigma : null),
            /* tie-up #1/#5 — α progression for the Nonlinear field tab (transient; never localStorage'd) */
            alphaSteps: nlOut.alphaSteps || null,
            alphaMax: nlOut.alphaMax || 0,
            voidContrast: nlVoid, voidScaled: nlVoidScaled, Es_MPa: nlEs,
            lateralFloor: (nlOut.lateralFloor != null ? nlOut.lateralFloor : null),   /* v0.16.3 — side-stress precision floor (step 1) */
            tightSolve: nlTight,   /* v0.17.1 — ran at NL_TIGHT_* */
            _sig: nlSig
          };
        }
        nlRefreshGoverning(dn.id);
        doneUnits = baseUnits + 4; bumpProgress();
      }
      nlRefreshGoverning(dn.id);
    }
    renderDesignGrid();
  }

  if (stale()) return;

  RUN_TIMING.nonlinear = performance.now() - tNl0;
  var tBk0 = performance.now();
  /* ---------- Phase 3 · Buckling (CPU worker pool) ---------- */
  if (doBuckle && nBuckleDesigns > 0 && typeof computeBucklingCPU === 'function'){
    var bN = (typeof BUCKLE_STATE !== 'undefined') ? BUCKLE_STATE.N : 8;
    paintRunStatus('<span class="v">Buckling</span> · N=' + bN + ' · ' + nBuckleDesigns + ' design(s) · pool solving…');
    renderDesignGrid();

    var bkSigBase = 'N' + bN + '|p' + GEOM_STATE.connectivity + '|g' + (window.BUCKLE_GPU ? 1 : 0);
    var jobs = [];
    for (var k = 0; k < nDesigns; k++){
      if (!recipes[k]) continue;
      /* Skip recompute when buckling grid + prune + solver path (GPU/CPU) +
         recipe fingerprint are unchanged and a valid result is cached. */
      var bkSig = bkSigBase + '|r' + recipeFp[k];
      var bkExist = BUCKLE_BY_DESIGN[designs[k].id];
      if (bkExist && !bkExist.error && bkExist._sig === bkSig){
        applyBuckleYield(bkExist, designs[k].id);   /* Sprint A — re-derive P_cr/P_y from the CURRENT nonlinear yield */
        doneUnits += 3; bumpProgress();
        continue;
      }
      (function(design, recipe, sig){
        RUN_STATE.activeWorkers++;            /* tie-up #3 — live-activity flag up while this axis-set is in flight */
        nFresh.buckling++;
        jobs.push(
          (typeof computeBuckling === 'function' ? computeBuckling : computeBucklingCPU)(recipe, bN, connOpts(), function(p){
            if (stale()) return;              /* Sprint A — superseded job: no UI writes */
            doneUnits++; bumpProgress();
            paintRunStatus('<span class="v">Buckling</span> · ' + (design.label || design.id) +
                           ' · ' + p.axis + ' (' + p.done + '/' + p.total + ') · N=' + bN);
          }).then(function(res){
            if (stale()) return;              /* Sprint A — discard; the new run owns activeWorkers + BUCKLE_BY_DESIGN */
            RUN_STATE.activeWorkers--;        /* tie-up #3 */
            applyBuckleYield(res, design.id);
            res.N = bN;
            res._sig = sig;
            BUCKLE_BY_DESIGN[design.id] = res;
          }).catch(function(e){
            if (stale()) return;              /* Sprint A — cancelled/superseded (incl. pool cancelAll rejections) */
            RUN_STATE.activeWorkers--;        /* tie-up #3 */
            BUCKLE_BY_DESIGN[design.id] = { error: (e && e.message) || String(e), N: bN };
            console.error('[run] buckling failed for ' + design.id + ':', e);
          })
        );
      })(designs[k], recipes[k], bkSig);
    }
    await Promise.all(jobs);
    if (stale()) return;
    renderDesignGrid();
  }

  RUN_TIMING.buckling = performance.now() - tBk0;
  var tTh0 = performance.now();
  /* ---------- Phase 4 · Thermal κ (GPU, 17b) — v0.20.0 ----------
     Same grid as the elastic run.  Wall voxels (solid fraction + normal) are
     built once per design on the CPU worker pool (17c, reusing the elastic
     run's voxels and margin when it just made them), then one GPU solve per
     ticked filler, all three axes together. */
  if (doThermal && nThermalDesigns > 0){
    for (var ti = 0; ti < nDesigns; ti++){
      if (stale()) return;
      var dt = designs[ti], rt = recipes[ti];
      if (!rt) continue;
      RUN_STATE.currentIndex = ti;
      var kS = thermalKsFor(rt);
      if (!(kS > 0)){
        THERMAL_BY_DESIGN[dt.id] = { error: 'no conductivity data for this material', noData: true, N: N };
        doneUnits += thFill.length; bumpProgress();
        continue;
      }
      var thBase = 'N' + N + '|p' + GEOM_STATE.connectivity + '|tol' + THERMAL_STATE.tol + '|ks' + kS + '|' + THERMAL_GPU_VERSION + '|r' + recipeFp[ti];
      var thEx = THERMAL_BY_DESIGN[dt.id];
      if (!thEx || thEx.error || thEx.base !== thBase) thEx = { base: thBase, N: N, kS: kS, byFiller: {} };
      var thNeed = thFill.filter(function(f){ return !thEx.byFiller[f.id]; });
      THERMAL_BY_DESIGN[dt.id] = thEx;
      doneUnits += thFill.length - thNeed.length; bumpProgress();
      if (!thNeed.length){
        paintRunStatus('<span class="v">Thermal</span> · Design ' + dletter(dt, ti) + ' · cached');
        continue;
      }
      paintRunStatus('<span class="v">Thermal</span> · Design ' + dletter(dt, ti) + ' · N=' + N + ' · building wall voxels…');
      renderDesignGrid();
      var thCount = 0;
      try {
        var TR = await homogenizeThermalGPU(rt, N, Object.assign({}, connOpts(), {
          kS: kS, fillers: thNeed, tol: THERMAL_STATE.tol, maxiter: THERMAL_STATE.maxiter, capture: N <= THERMAL_STATE.captureMaxN,
          onVoxelProgress: (function(dd, ii){ return function(p){
            if (!stale()) paintRunStatus('<span class="v">Thermal</span> · Design ' + dletter(dd, ii) + ' · N=' + N + ' · wall voxels ' + p.done + '/' + p.total);
          }; })(dt, ti),
          onProgress: (function(dd, ii){ return function(p){
            if (stale()) return;
            if (p.index > 0){ doneUnits++; thCount++; bumpProgress(); }
            var fl = thermalFillerById(p.filler);
            paintRunStatus('<span class="v">Thermal</span> · Design ' + dletter(dd, ii) + ' · N=' + N + ' · ' + (fl ? fl.label.toLowerCase() : p.filler) + ' in the pores (' + (p.index + 1) + '/' + p.total + ') · solving…');
          }; })(dt, ti)
        }));
        if (stale()) return;
        thEx.rho = TR.rho; thEx.rhoPhi = TR.rhoPhi; thEx.rhoRaw = TR.rhoRaw; thEx.trimLoss = TR.trimLoss; thEx.wraps = TR.wraps;
        thEx.nSurf = TR.nSurf; thEx.t_voxels_ms = TR.t_voxels_ms; thEx.voxReuse = TR.voxReuse;
        if (TR.phi8) thEx.phi8 = TR.phi8;
        thEx._tex = null;   /* v0.21.0 — viewer texture cache */
        thEx.fragLoss = TR.fragLoss;
        thEx.underResolved = TR.fragLoss > THERMAL_FRAG_FLAG;
        for (var fk in TR.byFiller) thEx.byFiller[fk] = TR.byFiller[fk];
        nFresh.thermal += thNeed.length;
        console.log('[thermal] ' + (dt.label || dt.id) + ' · N=' + N + ' · walls ' + (TR.t_voxels_ms / 1000).toFixed(1) + ' s (' + TR.voxReuse + ' reused, ' + TR.voxWorkers + ' workers) · ' +
                    thNeed.map(function(f){ var g = TR.byFiller[f.id]; return f.id + ' ' + (g.t_ms / 1000).toFixed(2) + ' s ' + g.perLC.map(function(q){ return q.iters; }).join('/') + ' it'; }).join(' · '));
      } catch (err){
        if (stale()) return;
        console.error('[run] design ' + dt.id + ' thermal solve failed:', err);
        THERMAL_BY_DESIGN[dt.id] = { error: 'thermal solve failed: ' + ((err && err.message) || err), N: N };
      }
      doneUnits += thNeed.length - thCount; bumpProgress();
      renderDesignGrid();
    }
  }
  RUN_TIMING.thermal = performance.now() - tTh0;

  /* ---------- Unimplemented modes: honest status, no fake numbers ---------- */
  var notWired = [];

  /* tie-up #4 — fold measured per-mode wall-times into the calibration store
     so the next estimate is machine-accurate; log the actuals to the console. */
  if (nDesigns > 0){
    /* Sprint A — divide by FRESHLY solved designs only: cached designs cost
       ~0 ms and used to drag the per-design figure low. */
    if (doElastic && nFresh.elastic > 0)   RUN_CALIB.elastic   = { sec: (RUN_TIMING.elastic   / 1000) / nFresh.elastic,   N: N };
    if (doNonlin && nFresh.nonlinear > 0)  RUN_CALIB.nonlinear = { sec: (RUN_TIMING.nonlinear / 1000) / nFresh.nonlinear, N: NONLIN_STATE.N, cap: NONLIN_STATE.cap };
    if (doBuckle && nFresh.buckling > 0)   RUN_CALIB.buckling  = { sec: (RUN_TIMING.buckling  / 1000) / nFresh.buckling,  N: BUCKLE_STATE.N };
    if (doThermal && nFresh.thermal > 0)   RUN_CALIB.thermal   = { sec: (RUN_TIMING.thermal   / 1000) / nFresh.thermal,   N: N };   /* per filler solve */
    saveRunCalib();
    console.log('[run] per-mode wall-time (s) — elastic ' + (RUN_TIMING.elastic/1000).toFixed(1) +
                ' · nonlinear ' + (RUN_TIMING.nonlinear/1000).toFixed(1) +
                ' · buckling ' + (RUN_TIMING.buckling/1000).toFixed(1) +
                ' · thermal ' + (RUN_TIMING.thermal/1000).toFixed(1));
    recomputeEstimate();   /* refresh the headline Est. with the just-measured calibration */
  }

  RUN_STATE.progress = 1;
  paintRunProgress(1);
  var elapsed = ((performance.now()-t0)/1000).toFixed(1);
  var msg = '<span class="v">Run complete</span> · ' + elapsed + ' s';
  if (notWired.length) msg += ' · <span class="warn">' + notWired.join(' / ') + ' not yet wired</span>';
  if (doBuckle && nBuckleDesigns > 0){
    var bkSkipped = [];
    for (var bsk = 0; bsk < nDesigns; bsk++){
      if (!recipes[bsk]) continue;
      var br = BUCKLE_BY_DESIGN[designs[bsk].id];
      if (br && br.skip_reason) bkSkipped.push(designs[bsk].label || designs[bsk].id);
    }
    if (bkSkipped.length) msg += ' · <span class="warn">Buckling under-resolved — raise grid: ' + bkSkipped.join(', ') + '</span>';
  }
  if (doThermal && nThermalDesigns > 0){   /* v0.20.0 */
    var thUnder = [], thErr = [];
    for (var tsk = 0; tsk < nDesigns; tsk++){
      var tr = THERMAL_BY_DESIGN[designs[tsk].id];
      if (!recipes[tsk] || !tr) continue;
      if (tr.error) thErr.push(designs[tsk].label || designs[tsk].id);
      else if (tr.underResolved) thUnder.push(designs[tsk].label || designs[tsk].id);
    }
    if (thUnder.length) msg += ' · <span class="warn">Thermal under-resolved — raise grid: ' + thUnder.join(', ') + '</span>';
    if (thErr.length) msg += ' · <span class="warn">Thermal not computed: ' + thErr.join(', ') + '</span>';
  }
  paintRunStatus(msg);
  finishRun(runToken);
}


/* ============================================================
   MATERIAL PILL (v0.7.2)
   ============================================================ */
function initMaterialPicker(){
  if (typeof F13LD_MATERIALS === 'undefined') return;
  try { var saved = localStorage.getItem(MATERIAL_STORE_KEY); if (saved && (saved === F13LD_MATERIAL_RECIPE_ID || findMaterial(saved))) MATERIAL_STATE.id = saved; } catch (e) {}
  var sel = document.getElementById('materialSel');   /* v0.22.0 — the dock drop-down (51-dock.js) replaces this select */
  if (!sel) return;
  var html = '<option value="' + F13LD_MATERIAL_RECIPE_ID + '">From design (default Ti-6Al-4V)</option>';
  var fam = null;
  for (var i = 0; i < F13LD_MATERIALS.length; i++){
    var m = F13LD_MATERIALS[i];
    if (m.family !== fam){ if (fam !== null) html += '</optgroup>'; fam = m.family; html += '<optgroup label="' + fam + '">'; }
    html += '<option value="' + m.id + '">' + m.name + ' · ' + m.condition + (m.crushSupported ? '' : ' (no crush)') + '</option>';
  }
  if (fam !== null) html += '</optgroup>';
  sel.innerHTML = html;
  sel.value = MATERIAL_STATE.id;
}

function onMaterialChange(id){
  if (id !== F13LD_MATERIAL_RECIPE_ID && !findMaterial(id)) return;
  MATERIAL_STATE.id = id;
  try { localStorage.setItem(MATERIAL_STORE_KEY, id); } catch (e) {}
  var m = findMaterial(id);
  if (typeof paintRunStatus === 'function')
    paintRunStatus('<span class="v">Material</span> · ' + (m ? (m.name + ' · ' + m.condition) : 'from design') + ' · Run to update results');
}

/* Returns a shallow recipe copy carrying the selected material (never mutates
   the design's own recipe, which the viewer and imports share). */
function applySelectedMaterial(recipe){
  if (!recipe) return recipe;
  var mat = (typeof materialForSolver === 'function') ? materialForSolver(MATERIAL_STATE.id) : null;
  if (!mat) return recipe;
  var out = {};
  for (var k in recipe) if (Object.prototype.hasOwnProperty.call(recipe, k)) out[k] = recipe[k];
  out.material = mat;
  return out;
}

/* Sprint A — derive P_cr/P_y + failure mode for a buckling result from the
   CURRENT nonlinear yield (fresh solves and cache hits alike, so a newer
   crush run is always reflected).  Logic unchanged from the inline version. */
function applyBuckleYield(res, designId){
  var nl = NONLIN_BY_DESIGN[designId];
  var haveY = !!(nl && nl.yielded && isFinite(nl.sigma_y_eff));
  var boundBasis = (nl && isFinite(nl.sigmaCap)) ? nl.sigmaCap : null;  /* cap stress = lower bound on true yield */
  var matSel = (typeof materialForSolver === 'function') ? materialForSolver(MATERIAL_STATE.id) : null;
  var sigY0Mat = (matSel && isFinite(matSel.sigY0_MPa)) ? matSel.sigY0_MPa : SIGMA_Y_TI64_MPA;
  var sigY = haveY ? nl.sigma_y_eff : (boundBasis != null ? boundBasis : sigY0Mat);
  /* v0.8.0 — compare like with like: when a crush result exists its yield is
     for ONE axis, so divide that axis's buckling strength by it (the weakest-
     axis pcr can sit on a different axis; spinodoid: X buckling over Z yield).
     Without a crush the yield is the isotropic solid's, so the weakest axis. */
  var pcrRef = res.pcr, ratioAxis = res.critAxis;
  if (nl && !nl.error && nl.axis && res.perAxis){
    for (var pa = 0; pa < res.perAxis.length; pa++){
      var q = res.perAxis[pa];
      if (q && q.axis === nl.axis && isFinite(q.lambda) && isFinite(q.sBar)){ pcrRef = q.lambda * Math.abs(q.sBar); ratioAxis = q.axis; }
    }
  }
  /* v0.16.0 — with more than one crushed axis, the ratio is the LOWEST of the
     per-axis ratios (each axis's buckling over that axis's own yield), so a
     design that buckles first on any crushed axis is flagged. */
  var crushed = (typeof nlAvailableAxes === 'function') ? nlAvailableAxes(designId) : [];
  if (crushed.length > 1 && res.perAxis){
    var bestR = Infinity;
    for (var ca = 0; ca < crushed.length; ca++){
      var ne = nlAxisEntry(designId, crushed[ca]);
      var neY = !!(ne.yielded && isFinite(ne.sigma_y_eff));
      var neS = neY ? ne.sigma_y_eff : (isFinite(ne.sigmaCap) ? ne.sigmaCap : null);
      if (neS == null) continue;
      for (var pb = 0; pb < res.perAxis.length; pb++){
        var qb = res.perAxis[pb];
        if (!qb || qb.axis !== crushed[ca] || !isFinite(qb.lambda) || !isFinite(qb.sBar)) continue;
        var pb_ = qb.lambda * Math.abs(qb.sBar), rr = pb_ / neS;
        if (rr < bestR){ bestR = rr; pcrRef = pb_; ratioAxis = qb.axis; haveY = neY; sigY = neS; boundBasis = neY ? null : neS; }
      }
    }
  }
  res.pcr_ratio_ref = pcrRef;
  res.ratioAxis = ratioAxis;
  res.pcr_py = isFinite(pcrRef) ? pcrRef / sigY : Infinity;
  res.failure_mode = (res.pcr_py >= 1) ? 'Yield-limited' : 'Buckling-limited';
  res.sigma_y_ref = sigY;
  res.provisional = !haveY;
  res.yieldBound = (!haveY && boundBasis != null);  /* pcr_py is an UPPER bound: true sigma_y >= cap stress */
  return res;
}

/* Sprint A — recipe fingerprint for cache signatures.  stableStringify is
   JSON with object keys sorted at every level (typed arrays as plain arrays,
   functions/undefined dropped), so key order never changes the hash; two
   FNV-1a 32-bit passes with different offset bases give a 64-bit hex id. */
function stableStringify(v){
  if (v === null || v === undefined || typeof v === 'function') return 'null';
  if (typeof v !== 'object') return (typeof v === 'number' && !isFinite(v)) ? JSON.stringify(String(v)) : JSON.stringify(v);
  if (Array.isArray(v) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v) && v.length != null)){
    var parts = [];
    for (var i = 0; i < v.length; i++) parts.push(stableStringify(v[i]));
    return '[' + parts.join(',') + ']';
  }
  var keys = Object.keys(v).sort(), out = [];
  for (var k = 0; k < keys.length; k++){
    var val = v[keys[k]];
    if (val === undefined || typeof val === 'function') continue;
    out.push(JSON.stringify(keys[k]) + ':' + stableStringify(val));
  }
  return '{' + out.join(',') + '}';
}
function fnv1a32(str, basis){
  var h = basis >>> 0;
  for (var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function recipeFingerprint(recipe){
  if (!recipe) return '';
  var s = stableStringify(recipe);
  function hex(h){ return ('0000000' + h.toString(16)).slice(-8); }
  return hex(fnv1a32(s, 0x811c9dc5)) + hex(fnv1a32(s, 0x01000193 ^ s.length));
}


/* mapElasticToResults — build the d.results object the comparison UI expects
   from a solveDesignElasticFull return value.  Full-Voigt now provides every
   field directly: three Young's moduli, three shear moduli, three Poisson
   ratios, and the real Zener anisotropy ratio.  No surrogates remain in the
   elastic block.

   Per-voxel u'(x) and σ_VM(x) for all three physical axes (when present
   in R.fieldsByAxis) are stashed under d.results._fieldsByAxis for
   downstream consumption by the raymarcher (Push A.2 / A.2.2 / A.3 —
   Deformed and Stress tab visualization).  Underscore prefix flags this
   as internal data, not a UI-rendered metric.  Full-Voigt field extraction
   for the 6 LCs lands in a later push; until then R.fieldsByAxis is null
   and Deformed/Stress tabs degrade to "(stub)" gracefully.

   Other physics blocks (buckling, yield, hardening, thermal) remain stubbed
   until their respective solvers are wired in. */
function mapElasticToResults(R){
  var Ex  = R.Ex_MPa  / 1000;     /* MPa → GPa for UI */
  var Ey  = R.Ey_MPa  / 1000;
  var Ez  = R.Ez_MPa  / 1000;
  var Gxy = R.Gxy_MPa / 1000;
  var Gxz = R.Gxz_MPa / 1000;
  var Gyz = R.Gyz_MPa / 1000;

  /* Real Zener anisotropy from C11/C12/C44.  A=1 isotropic; A<1 stiff along
     [100]; A>1 stiff along [111].  zenerDescriptor() in 40-design-grid.js
     already maps the full range to descriptive labels. */
  var zenerA = (R.zenerA != null && isFinite(R.zenerA)) ? R.zenerA : 1.0;

  return {
    /* Real elastic results — all six moduli and three Poisson ratios from
       the full 6×6 effective stiffness tensor. */
    E11: Ex, E22: Ey, E33: Ez,
    zener: zenerA,
    nu12: R.nu_xy, nu13: R.nu_xz, nu23: R.nu_yz,
    G12:  Gxy,     G13:  Gxz,     G23:  Gyz,
    /* Stress / Yield / Buckling / Thermal — physics not yet wired into lab.
       Use sentinel zeros so the UI's `.toFixed()` doesn't crash; the views
       will get a "(stub)" decoration via _runSource. */
    sigma_y_z:    0,
    sigma_peak:   0,
    hardening:    0,
    lambda_cr:    0,
    pcr_py:       0,
    kappa_z:      0,
    failure_mode: 'not-computed',
    /* Solver provenance for the UI's run-source pill */
    rho:          R.rho,
    iters:        R.iters,
    converged:    R.converged,
    /* v0.16.0 — per-load-case CG record ({axis, iters, converged}); the cards
       flag the moduli when any load case stopped at the iteration cap. */
    perLC:        R.perLC || null,
    voidRatio:    R.voidRatio || null,     /* v0.16.0 — void used (scaled to the design when compliant) */
    Es_MPa:       R.Es_MPa || null,
    cgMaxiter:    (typeof CG_MAXITER_FULL !== 'undefined') ? CG_MAXITER_FULL : null,
    /* Push 5 — full Voigt 6×6 effective compliance (S) and stiffness (C_eff)
       tensors in PHYSICAL-axis coordinates, units MPa.  S is consumed by the
       Stiffness ⊕ tab (22-stiffness-viz.js) to render the directional
       Young's modulus surface E(n̂) = 1 / (v^T·S·v).  C_eff is plumbed
       through for future use (orthotropy diagnostics, Mohr-3D viz).
       Stored as plain Array(36) (the solver does Array.from on the
       Float64Array at the API boundary so downstream consumers don't
       have to worry about typed-array identity. */
    S:            R.S || null,
    C_eff:        R.C_eff || null,
    /* Per-voxel fields for Deformed / Stress tab raymarchers (Push A.2/A.3).
       A.2.2 — captures all three physical axes by default.  null until the
       elastic solver is invoked with field capture (default since A.1).
       Underscore prefix = internal-only, not a UI metric.
       Shape: { x: {u_prime, sigma_vm, N, eps_bar}, y: {…}, z: {…} } */
    _fieldsByAxis: R.fieldsByAxis || null,
    /* Push 6.1 — periodic 6-connectivity report from 14a-connectivity.js.
       Always populated when the solver runs to completion (and on the
       disconnected-reject path; null only on hard exceptions or when the
       helper file isn't loaded).  Available for UI surfacing (e.g. an
       "N orphans" badge in the design grid), and for the optional
       opts.connectivity.minLargestFraction rejection gate. */
    connectivity:  R.connectivity || null
  };
}


/* stubResults — sentinel values for designs without a real recipe (e.g. RD)
   or for solves that failed.  Keeps the UI from crashing while signalling
   that the numbers are not from a real solve.  */
function stubResults(){
  return {
    E11: 0, E22: 0, E33: 0,
    zener: 0,
    nu12: 0, nu13: 0, nu23: 0,
    G12: 0, G13: 0, G23: 0,
    sigma_y_z: 0, sigma_peak: 0, hardening: 0,
    lambda_cr: 0, pcr_py: 0, kappa_z: 0,
    failure_mode: 'no-data'
  };
}


/* paintRunProgress / paintRunStatus — small helpers extracted from the
   inlined mock so runRealSweep stays compact. */
function paintRunProgress(p){
  var fill = document.getElementById('progFill');
  if (fill) fill.style.width = (p * 100).toFixed(1) + '%';
  /* tie-up #4 — live ETA.  progress is the work-unit fraction; we drain the
     per-mode time estimate by it.  Honest: it is an estimate, sharpened run
     over run by the measured calibration (RUN_CALIB). */
  var etaEl = document.getElementById('progEta');
  if (etaEl){
    var est = RUN_STATE.estTotalSec || 0;
    if (p >= 1)            etaEl.textContent = '0:00';
    else if (est > 0)      etaEl.textContent = formatClock(est * (1 - p));
    else                   etaEl.textContent = '—';
  }
}

/* tie-up #2 — toggle the branded "still working" spinner beside the solver pill. */
function setSolverSpinner(on){
  var sp = document.getElementById('solverSpinner');
  if (sp) sp.classList.toggle('active', !!on);
}

/* tie-up #4 — m:ss clock for the ETA readout (distinct from formatTime's
   "~N min" estimate label). */
function formatClock(seconds){
  if (!(seconds > 0)) return '0:00';
  var s = Math.round(seconds);
  var m = Math.floor(s / 60);
  var r = s % 60;
  return m + ':' + (r < 10 ? '0' + r : r);
}

function paintRunStatus(html){
  var statusEl = document.getElementById('progStatus');
  if (statusEl) statusEl.innerHTML = html;
}

function finishRunFailed(reason){
  RUN_STATE.running = false;
  RUN_STATE.progress = 0;
  var btn = document.getElementById('runBtn');
  if (btn){
    btn.classList.remove('running');
    btn.innerHTML = (typeof DOCK_RUN_IDLE !== 'undefined') ? DOCK_RUN_IDLE : '▶ Run All';
  }
  var prog = document.getElementById('progRow');
  if (prog) prog.style.display = 'none';
  setSolverSpinner(false);
}

/* Sprint A — any throw out of runRealSweep lands here.  Only the LIVE run is
   torn down (a superseded sweep's crash is just logged); bumping the token
   makes any of its still-pending async work stale. */
function onSweepCrashed(err, runToken){
  console.error('[run] sweep crashed:', err);
  if (runToken !== RUN_STATE.token) return;
  RUN_STATE.token++;
  RUN_STATE.activeWorkers = 0;
  if (typeof cancelBucklingCPU === 'function') cancelBucklingCPU('run failed');
  finishRunFailed((err && err.message) || String(err));
  paintSolverPill('run failed · see console', 'bad');
  if (typeof updateActionButtons === 'function') updateActionButtons();
  try { renderDesignGrid(); } catch (e2){ console.error('[run] render after crash failed:', e2); }
}

function finishRun(runToken){
  /* tie-up #3 — completion gate.  finishRun is the SOLE writer of the
     "run complete" pill, so the mid-run-on-tab-switch report means it was
     being reached/repainted out of turn.  These guards make it idempotent
     and impossible to fire for anything but the live run at true end:
       · token mismatch  → a newer run started, or a cancel bumped the token
       · already finalized this token → duplicate call
       · activeWorkers>0 → buckling workers still in flight (live-activity flag) */
  if (runToken != null && runToken !== RUN_STATE.token) return;
  if (RUN_STATE.finishedToken === RUN_STATE.token) return;
  if (RUN_STATE.activeWorkers > 0) return;
  RUN_STATE.finishedToken = RUN_STATE.token;

  /* Defensive: any legacy mock timer */
  if (RUN_STATE.timer){
    clearInterval(RUN_STATE.timer);
    RUN_STATE.timer = null;
  }
  RUN_STATE.running = false;
  LAB_STATE.runHasCompleted = true;

  // Pick winner: highest E11 that is not buckling-limited.  Buckling data
  // (when present) comes from BUCKLE_BY_DESIGN; designs without buckling data
  // are not penalised.
  var winner = null;
  var bestE = -Infinity;
  for (var i = 0; i < LAB_STATE.designs.length; i++){
    var d = LAB_STATE.designs[i];
    if (!d.results) continue;
    var bk = BUCKLE_BY_DESIGN[d.id];
    var buckleOk = !bk || bk.error || !isFinite(bk.pcr_py) || bk.pcr_py >= 1;
    if (buckleOk && d.results.E11 > bestE){
      winner = d.id;
      bestE = d.results.E11;
    }
  }
  if (!winner && LAB_STATE.designs.length > 0){
    winner = LAB_STATE.designs[0].id;
  }
  LAB_STATE.winningId = winner;

  var btn = document.getElementById('runBtn');
  if (btn){
    btn.classList.remove('running');
    btn.classList.add('done');
    btn.innerHTML = (typeof DOCK_RUN_DONE !== 'undefined') ? DOCK_RUN_DONE : '✓ Run Complete';
    setTimeout(function(){
      btn.classList.remove('done');
      btn.innerHTML = (typeof DOCK_RUN_RERUN !== 'undefined') ? DOCK_RUN_RERUN : '▶ Re-run';
    }, 2400);
  }
  var statusEl = document.getElementById('progStatus');
  if (statusEl) statusEl.innerHTML = '<span class="v" style="color:var(--good)">Complete</span> · ' + LAB_STATE.designs.length + ' designs';
  var etaEl = document.getElementById('progEta');
  if (etaEl) etaEl.textContent = '0:00';

  paintSolverPill('run complete', 'live');
  setSolverSpinner(false);

  if (typeof updateActionButtons === 'function') updateActionButtons();
  renderDesignGrid();
}

function cancelRun(){
  /* Defensive: clear any legacy mock timer if one is still set */
  if (RUN_STATE.timer){
    clearInterval(RUN_STATE.timer);
    RUN_STATE.timer = null;
  }
  /* Set the cancel flag — the async runRealSweep loop checks this between
     designs and aborts.  An elastic GPU solve in progress still completes (no
     mid-solve cancellation in the CG loop) and its result is discarded; a
     nonlinear crush aborts at its next load step; buckling workers are
     terminated outright (Sprint A). */
  RUN_STATE.cancelled = true;
  RUN_STATE.running = false;
  RUN_STATE.token++;                 /* tie-up #3 — invalidate any in-flight finishRun for the cancelled run */
  RUN_STATE.activeWorkers = 0;       /* Sprint A — stale jobs no longer decrement (token-gated) */
  if (typeof cancelBucklingCPU === 'function') cancelBucklingCPU('cancelled');
  RUN_STATE.progress = 0;
  RUN_STATE.currentIndex = 0;
  LAB_STATE.runHasCompleted = false;
  LAB_STATE.winningId = null;

  var btn = document.getElementById('runBtn');
  if (btn){
    btn.classList.remove('running');
    btn.classList.remove('done');
    btn.innerHTML = (typeof DOCK_RUN_IDLE !== 'undefined') ? DOCK_RUN_IDLE : '▶ Run All';
  }
  var prog = document.getElementById('progRow');
  if (prog) prog.style.display = 'none';
  var fill = document.getElementById('progFill');
  if (fill) fill.style.width = '0%';

  paintSolverPill('solver ready', 'live');
  setSolverSpinner(false);

  if (typeof updateActionButtons === 'function') updateActionButtons();
  renderDesignGrid();
}

function parseEstimateSeconds(){
  var el = document.getElementById('estTimeVal');
  if (!el) return 10;
  var txt = el.textContent;
  var match = txt.match(/([\d.]+)\s*(sec|min|hr)/i);
  if (!match) return 10;
  var num = parseFloat(match[1]);
  if (match[2].toLowerCase() === 'sec') return num;
  if (match[2].toLowerCase() === 'min') return num * 60;
  return num * 3600;
}

/* slot-correct letter for a design (falls back to array index). */
function dletter(d, i){
  if (d && typeof d.slot === 'number' && d.slot >= 0 && d.slot < 26) return String.fromCharCode(65 + d.slot);
  return letterFor(i);
}

function letterFor(idx){
  return String.fromCharCode(65 + idx);    // A, B, C
}
