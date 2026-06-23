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
   than the GPU elastic/thermal path — ~per-axis seconds at N=8.  Its
   resolution is configured separately from the main Grid pill. */
var BUCKLE_STATE = {
  N: 32             // 8 (fast) | 16 | 32 (resolves thin struts)
};

/* Transient per-design buckling results (id -> { lambda_cr, pcr, pcr_py,
   critAxis, perAxis, modes, N, failure_mode, provisional } | { error }).
   Kept OUT of d.results (a Run All elastic pass rebuilds d.results and
   would wipe buckling) and OUT of the design objects (the heavy mode-field
   arrays must not hit localStorage).  The Buckling view tab reads here. */
var BUCKLE_BY_DESIGN = {};

/* Nonlinear crush resolution + load axis (GPU J2 plasticity, 16g).
   N=8 fast / N=16 more accurate; axis xx/yy/zz -> crush() physical 0/1/2. */
var NONLIN_STATE = { N: 32, axis: 'zz', cap: 0.05 };

/* Transient per-design nonlinear results (id -> { sigma_y_eff, E0, curve,
   axis, N, truncated } | { error }).  Feeds the sigma-epsilon curve tab, the
   sigma_y(z) metric, and the P_cr/P_y seam (replaces provisional 880 MPa). */
var NONLIN_BY_DESIGN = {};

/* Provisional yield stress for P_cr/P_y until the nonlinear solver supplies
   a real macroscopic sigma_y.  Solid Ti-6Al-4V, MPa. */
var SIGMA_Y_TI64_MPA = 880;

/* Connectivity gate — keep only the largest periodically-connected solid
   component before every solve (prunes floating islands).  Default on; the
   flag is part of each mode's recompute signature, so toggling it forces a
   fresh solve. */
var GEOM_STATE = { pruneLargest: true };

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
  /* Phase-6 tie-up #4 — wall-clock anchors for the live ETA + per-mode timing. */
  t0: 0,
  estTotalSec: 0
};

/* Phase-6 tie-up #4 — last run's measured per-mode wall-times (ms), surfaced
   to the console and folded into the next estimate via RUN_CALIB. */
var RUN_TIMING = { elastic: 0, nonlinear: 0, buckling: 0 };

/* ============================================================
   PHYSICS TOGGLES
   ============================================================ */
function onPruneToggle(el){
  GEOM_STATE.pruneLargest = !GEOM_STATE.pruneLargest;
  if (el) el.classList.toggle('on', GEOM_STATE.pruneLargest);
}

function onPhysToggle(el){
  var key = el.dataset.phys;
  PHYS_STATE[key] = !PHYS_STATE[key];
  if (PHYS_STATE[key]) el.classList.add('on');
  else                  el.classList.remove('on');
  recomputeEstimate();
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
  var val = document.getElementById('gridPillVal');
  if (!val) return;
  if (GRID_STATE.mode === 'auto'){
    val.textContent = 'Auto · ' + GRID_STATE.N + '³';
  } else {
    val.textContent = GRID_STATE.N + '³';
  }
}

/* ============================================================
   BUCKLE GRID PILL — cycles the CPU buckling resolution 8 ⇄ 16.
   ============================================================ */
function onBucklePillClick(){
  BUCKLE_STATE.N = (BUCKLE_STATE.N === 8) ? 16 : (BUCKLE_STATE.N === 16) ? 32 : 8;
  paintBucklePill();
  recomputeEstimate();
}

function paintBucklePill(){
  var val = document.getElementById('bucklePillVal');
  if (!val) return;
  val.textContent = BUCKLE_STATE.N + '³';
}

/* ============================================================
   NONLIN GRID PILL — cycles GPU nonlinear crush resolution 8 ⇄ 16,
   plus the load-axis dropdown handler.
   ============================================================ */
function onNonlinPillClick(){
  NONLIN_STATE.N = (NONLIN_STATE.N === 8) ? 16 : (NONLIN_STATE.N === 16) ? 32 : 8;
  paintNonlinPill();
  recomputeEstimate();
}

function paintNonlinPill(){
  var val = document.getElementById('nonlinPillVal');
  if (!val) return;
  val.textContent = NONLIN_STATE.N + '³';
}

function onNonlinAxisChange(axis){
  if (axis === 'xx' || axis === 'yy' || axis === 'zz') NONLIN_STATE.axis = axis;
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
  var val = document.getElementById('nonlinCapPillVal');
  if (!val) return;
  val.textContent = Math.round(NONLIN_STATE.cap * 100) + '%';
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
  buckling:  { sec: 18.0, refN: 8  },   /* 3-axis pool @ N=8 (README desktop figure) */
  nonlinear: { sec: 90.0, refN: 16, refCap: 0.05 }  /* sync-bound crush @ N=16, 5% cap */
};

/* Calibration: measured seconds-per-design keyed by mode → { sec, N, cap }.
   Persisted so the estimate is already calibrated on the next page load. */
var RUN_CALIB_KEY = 'f13ld.lab.timing.v1';
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
    var bN = (typeof BUCKLE_STATE !== 'undefined') ? BUCKLE_STATE.N : 8;
    return cal ? cal.sec * gridScale(bN, cal.N) : ref.sec * gridScale(bN, ref.refN);
  }
  if (mode === 'nonlinear'){
    var nN = (typeof NONLIN_STATE !== 'undefined') ? NONLIN_STATE.N : 16;
    var cap = (typeof NONLIN_STATE !== 'undefined') ? NONLIN_STATE.cap : 0.05;
    if (cal){ return cal.sec * gridScale(nN, cal.N) * (cap / (cal.cap || 0.05)); }
    return ref.sec * gridScale(nN, ref.refN) * (cap / ref.refCap);
  }
  if (mode === 'thermal') return 1.0;
  return 0;
}

/* estimateSeconds — total predicted wall-time across enabled modes × designs. */
function estimateSeconds(){
  var n = LAB_STATE.designs.length;
  if (n === 0) return 0;
  var total = 0;
  if (PHYS_STATE.elastic) total += modePerDesignSec('elastic')   * n;
  if (PHYS_STATE.nonlin)  total += modePerDesignSec('nonlinear') * n;
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
  if (el) el.textContent = text;
}

/* ============================================================
   RUN BUTTON — Phase 1 mock progress walkthrough.
   Real solver pipeline lands in Phases 3–6.
   ============================================================ */
function onRunClick(){
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
    btn.innerHTML = '■ Cancel';
  }
  var prog = document.getElementById('progRow');
  if (prog) prog.style.display = 'flex';

  paintSolverPill('solving', 'warn');
  setSolverSpinner(true);            /* tie-up #2 — branded "still working" mark */

  /* Pick run resolution.  For real CPU/GPU elastic, N=32 is the sweet spot
     for interactive use (~2-5 sec/design on most hardware).  N=64 is 8× more
     work; N=128 is 64× more.  If the user explicitly picked a manual N via
     the grid pill, respect it.  Auto mode → cap at 32 for real runs because
     autoPickGrid's default of 64 was tuned for the mock and is too slow. */
  var runN = GRID_STATE.N;
  if (GRID_STATE.mode === 'auto') runN = 32;

  /* Kick off the real sweep.  Don't await here — we let the function run in
     the background while the UI stays responsive (each design's compute is
     itself async, yielding to the browser between FFTs and readbacks). */
  runRealSweep(runN, RUN_STATE.token);
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

  var doElastic = !!PHYS_STATE.elastic;
  var doBuckle  = !!PHYS_STATE.buckle;
  var doNonlin  = !!PHYS_STATE.nonlin && typeof NonlinearSolverFull === 'function';

  /* WebGPU is required only for the elastic / GPU path. */
  if (doElastic && typeof ensureDevice === 'function'){
    var ok = false;
    try { ok = await ensureDevice(); } catch (e) { ok = false; }
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
    recipes.push((typeof recipeForDesign === 'function') ? recipeForDesign(designs[ri]) : null);
  }
  var nBuckleDesigns = 0;
  if (doBuckle){ for (var bi = 0; bi < nDesigns; bi++){ if (recipes[bi]) nBuckleDesigns++; } }
  var nNonlinDesigns = 0;
  if (doNonlin){ for (var npi = 0; npi < nDesigns; npi++){ if (recipes[npi]) nNonlinDesigns++; } }

  /* Progress in work-units: 1 per elastic design + 3 per buckled design. */
  var totalUnits = (doElastic ? nDesigns : 0) + (doNonlin ? nNonlinDesigns * 4 : 0) + (doBuckle ? nBuckleDesigns * 3 : 0);
  if (totalUnits < 1) totalUnits = 1;
  var doneUnits = 0;
  function bumpProgress(){ RUN_STATE.progress = doneUnits / totalUnits; paintRunProgress(RUN_STATE.progress); }

  var tEl0 = performance.now();
  /* ---------- Phase 1 · Elastic (GPU) ---------- */
  if (doElastic){
    for (var i = 0; i < nDesigns; i++){
      if (RUN_STATE.cancelled) return;
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

      /* Skip recompute when nothing this mode depends on changed (grid N +
         prune flag).  A design's geometry is immutable for its id, so the
         settings signature is sufficient. */
      var elSig = 'N' + N + '|p' + (GEOM_STATE.pruneLargest ? 1 : 0);
      if (d.results && !d.results._error && d.results._elasticSig === elSig){
        paintRunStatus('<span class="v">Elastic</span> · Design ' + dletter(d, i) + ' · cached');
        doneUnits++; bumpProgress();
        continue;
      }
      paintRunStatus('<span class="v">Elastic</span> · Design ' + dletter(d, i) + ' · N=' + N + ' · solving…');
      renderDesignGrid();

      var elasticResult = null, solveErr = null;
      try { elasticResult = await solveDesignElasticFull(recipe, N, { pruneLargest: GEOM_STATE.pruneLargest }); }
      catch (err){ solveErr = err; console.error('[run] design ' + d.id + ' elastic solve failed:', err); }
      if (RUN_STATE.cancelled) return;

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
        d.results._runSource = 'real elastic · N=' + N + ' · ' + (elasticResult.tCG_ms|0) + ' ms';
        d.results._elasticSig = elSig;
      }
      doneUnits++; bumpProgress();
    }
  }

  if (RUN_STATE.cancelled) return;

  RUN_TIMING.elastic = performance.now() - tEl0;
  var tNl0 = performance.now();
  /* ---------- Phase 2 · Nonlinear crush (GPU, 16g) ---------- */
  if (doNonlin && nNonlinDesigns > 0){
    var nlN = NONLIN_STATE.N;
    var axisMap = { xx: 0, yy: 1, zz: 2 };
    var nlAxis = (axisMap[NONLIN_STATE.axis] != null) ? axisMap[NONLIN_STATE.axis] : 2;
    var nlfft;
    if (window.__sharedFFT && window.__sharedFFT.N === nlN){ nlfft = window.__sharedFFT; }
    else { if (window.__sharedFFT) window.__sharedFFT.destroy(); nlfft = new FFTPlan(nlN); window.__sharedFFT = nlfft; }

    for (var ni = 0; ni < nDesigns; ni++){
      if (RUN_STATE.cancelled) return;
      RUN_STATE.currentIndex = ni;
      var dn = designs[ni];
      var rcpN = recipes[ni];
      if (!rcpN) continue;
      paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · N=' + nlN +
                     ' · ' + NONLIN_STATE.axis.toUpperCase() + ' · crushing…');
      renderDesignGrid();

      var baseUnits = doneUnits;

      /* Skip recompute when grid/axis/cap/prune are unchanged and a valid
         result (with captured α) is already cached. */
      var nlSig = 'N' + nlN + '|a' + NONLIN_STATE.axis + '|c' + NONLIN_STATE.cap + '|p' + (GEOM_STATE.pruneLargest ? 1 : 0);
      var nlExist = NONLIN_BY_DESIGN[dn.id];
      if (nlExist && !nlExist.error && nlExist._sig === nlSig && nlExist.alphaSteps){
        paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · cached');
        doneUnits = baseUnits + 4; bumpProgress();
        continue;
      }
      var nlEstSteps = Math.max(8, Math.round(NONLIN_STATE.cap / 0.003125));
      var onNlStep = function(stepIdx, eps, sig){
        if (RUN_STATE.cancelled) return;
        doneUnits = baseUnits + 4 * Math.min(stepIdx / nlEstSteps, 0.95);
        bumpProgress();
        paintRunStatus('<span class="v">Nonlinear</span> · Design ' + dletter(dn, ni) + ' · N=' + nlN +
                       ' · ' + NONLIN_STATE.axis.toUpperCase() + ' · step ' + stepIdx +
                       ' · ε=' + (eps * 100).toFixed(2) + '% · σ=' + sig.toFixed(1) + ' MPa');
      };
      var nlSolver = null, nlErr = null, nlOut = null;
      try {
        nlSolver = new NonlinearSolverFull(nlN, nlfft);
        nlSolver.upload(rcpN, { pruneLargest: GEOM_STATE.pruneLargest });
        nlOut = await nlSolver.crush(nlAxis, { control: 'stress', nSteps: 16, epsTarget: NONLIN_STATE.cap, onStep: onNlStep, captureAlpha: true /* tie-up #5 — per-step plastic-strain field for the Nonlinear-tab scrubber */ });
      } catch (e){ nlErr = e; console.error('[run] nonlinear solve failed for ' + dn.id + ':', e); }
      if (nlSolver){ try { nlSolver.destroy(); } catch (e2){} }
      if (RUN_STATE.cancelled) return;

      if (nlErr || !nlOut || nlOut.error || !isFinite(nlOut.sigma_y_eff)){
        NONLIN_BY_DESIGN[dn.id] = { error: (nlErr && nlErr.message) || (nlOut && nlOut.error) || 'failed', N: nlN };
      } else {
        NONLIN_BY_DESIGN[dn.id] = {
          sigma_y_eff: nlOut.sigma_y_eff, yielded: !!nlOut.yielded, E0: nlOut.E0, curve: nlOut.curve,
          axis: NONLIN_STATE.axis, N: nlN, truncated: !!nlOut.truncated,
          epsCap: (nlOut.epsCap != null ? nlOut.epsCap : NONLIN_STATE.cap),
          sigmaCap: (nlOut.curve && nlOut.curve.length ? nlOut.curve[nlOut.curve.length - 1].sigma : null),
          /* tie-up #1/#5 — α progression for the Nonlinear field tab (transient; never localStorage'd) */
          alphaSteps: nlOut.alphaSteps || null,
          alphaMax: nlOut.alphaMax || 0,
          _sig: nlSig
        };
      }
      doneUnits = baseUnits + 4; bumpProgress();
    }
    renderDesignGrid();
  }

  if (RUN_STATE.cancelled) return;

  RUN_TIMING.nonlinear = performance.now() - tNl0;
  var tBk0 = performance.now();
  /* ---------- Phase 3 · Buckling (CPU worker pool) ---------- */
  if (doBuckle && nBuckleDesigns > 0 && typeof computeBucklingCPU === 'function'){
    var bN = (typeof BUCKLE_STATE !== 'undefined') ? BUCKLE_STATE.N : 8;
    paintRunStatus('<span class="v">Buckling</span> · N=' + bN + ' · ' + nBuckleDesigns + ' design(s) · pool solving…');
    renderDesignGrid();

    var bkSig = 'N' + bN + '|p' + (GEOM_STATE.pruneLargest ? 1 : 0);
    var jobs = [];
    for (var k = 0; k < nDesigns; k++){
      if (!recipes[k]) continue;
      /* Skip recompute when buckling grid + prune are unchanged and a valid
         result is cached. */
      var bkExist = BUCKLE_BY_DESIGN[designs[k].id];
      if (bkExist && !bkExist.error && bkExist._sig === bkSig){
        doneUnits += 3; bumpProgress();
        continue;
      }
      (function(design, recipe){
        RUN_STATE.activeWorkers++;            /* tie-up #3 — live-activity flag up while this axis-set is in flight */
        jobs.push(
          (typeof computeBuckling === 'function' ? computeBuckling : computeBucklingCPU)(recipe, bN, { pruneLargest: GEOM_STATE.pruneLargest }, function(p){
            doneUnits++; bumpProgress();
            paintRunStatus('<span class="v">Buckling</span> · ' + (design.label || design.id) +
                           ' · ' + p.axis + ' (' + p.done + '/' + p.total + ') · N=' + bN);
          }).then(function(res){
            RUN_STATE.activeWorkers--;        /* tie-up #3 */
            var nl = NONLIN_BY_DESIGN[design.id];
            var haveY = !!(nl && nl.yielded && isFinite(nl.sigma_y_eff));
            var boundBasis = (nl && isFinite(nl.sigmaCap)) ? nl.sigmaCap : null;  /* cap stress = lower bound on true yield */
            var sigY = haveY ? nl.sigma_y_eff : (boundBasis != null ? boundBasis : SIGMA_Y_TI64_MPA);
            res.pcr_py = isFinite(res.pcr) ? res.pcr / sigY : Infinity;
            res.failure_mode = (res.pcr_py >= 1) ? 'Yield-limited' : 'Buckling-limited';
            res.sigma_y_ref = sigY;
            res.provisional = !haveY;
            res.yieldBound = (!haveY && boundBasis != null);  /* pcr_py is an UPPER bound: true sigma_y >= cap stress */
            res.N = bN;
            res._sig = bkSig;
            BUCKLE_BY_DESIGN[design.id] = res;
          }).catch(function(e){
            RUN_STATE.activeWorkers--;        /* tie-up #3 */
            BUCKLE_BY_DESIGN[design.id] = { error: (e && e.message) || String(e), N: bN };
            console.error('[run] buckling failed for ' + design.id + ':', e);
          })
        );
      })(designs[k], recipes[k]);
    }
    await Promise.all(jobs);
    if (RUN_STATE.cancelled) return;
    renderDesignGrid();
  }

  RUN_TIMING.buckling = performance.now() - tBk0;
  /* ---------- Unimplemented modes: honest status, no fake numbers ---------- */
  var notWired = [];
  if (PHYS_STATE.thermal) notWired.push('Thermal');

  /* tie-up #4 — fold measured per-mode wall-times into the calibration store
     so the next estimate is machine-accurate; log the actuals to the console. */
  if (nDesigns > 0){
    if (doElastic)                       RUN_CALIB.elastic   = { sec: (RUN_TIMING.elastic   / 1000) / nDesigns,        N: N };
    if (doNonlin && nNonlinDesigns > 0)  RUN_CALIB.nonlinear = { sec: (RUN_TIMING.nonlinear / 1000) / nNonlinDesigns,  N: NONLIN_STATE.N, cap: NONLIN_STATE.cap };
    if (doBuckle && nBuckleDesigns > 0)  RUN_CALIB.buckling  = { sec: (RUN_TIMING.buckling  / 1000) / nBuckleDesigns,  N: ((typeof BUCKLE_STATE !== 'undefined') ? BUCKLE_STATE.N : 8) };
    saveRunCalib();
    console.log('[run] per-mode wall-time (s) — elastic ' + (RUN_TIMING.elastic/1000).toFixed(1) +
                ' · nonlinear ' + (RUN_TIMING.nonlinear/1000).toFixed(1) +
                ' · buckling ' + (RUN_TIMING.buckling/1000).toFixed(1));
    recomputeEstimate();   /* refresh the headline Est. with the just-measured calibration */
  }

  RUN_STATE.progress = 1;
  paintRunProgress(1);
  var elapsed = ((performance.now()-t0)/1000).toFixed(1);
  var msg = '<span class="v">Run complete</span> · ' + elapsed + ' s';
  if (notWired.length) msg += ' · <span class="warn">' + notWired.join(' / ') + ' not yet wired</span>';
  paintRunStatus(msg);
  finishRun(runToken);
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
    btn.innerHTML = '▶ Run All';
  }
  var prog = document.getElementById('progRow');
  if (prog) prog.style.display = 'none';
  setSolverSpinner(false);
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
    btn.innerHTML = '✓ Run Complete';
    setTimeout(function(){
      btn.classList.remove('done');
      btn.innerHTML = '▶ Re-run';
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
     designs and aborts.  A solve-in-progress will still complete (we don't
     have mid-solve cancellation in the GPU CG loop), but no further designs
     are started.  This typically aborts within seconds at N=32. */
  RUN_STATE.cancelled = true;
  RUN_STATE.running = false;
  RUN_STATE.token++;                 /* tie-up #3 — invalidate any in-flight finishRun for the cancelled run */
  RUN_STATE.progress = 0;
  RUN_STATE.currentIndex = 0;
  LAB_STATE.runHasCompleted = false;
  LAB_STATE.winningId = null;

  var btn = document.getElementById('runBtn');
  if (btn){
    btn.classList.remove('running');
    btn.classList.remove('done');
    btn.innerHTML = '▶ Run All';
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
