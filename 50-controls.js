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

var RUN_STATE = {
  running: false,
  currentIndex: 0,  // which design is currently being solved (mock)
  timer: null,
  progress: 0
};

/* ============================================================
   PHYSICS TOGGLES
   ============================================================ */
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
   ESTIMATE — recomputes wall-time estimate based on grid,
   physics modes, and design count. Mock formula matches the
   compute-envelope numbers from the proposal docs.
   ============================================================ */
function recomputeEstimate(){
  var n = LAB_STATE.designs.length;
  if (n === 0){
    setEstimate('—');
    setDesignCount('0');
    return;
  }
  setDesignCount(String(n));

  // Base seconds per design at N=64
  var s = 0;
  if (PHYS_STATE.elastic) s += 2;
  if (PHYS_STATE.buckle)  s += 30;
  if (PHYS_STATE.nonlin)  s += 130;
  if (PHYS_STATE.thermal) s += 1;

  // Grid scaling: roughly N³ log N per FFT, and CG iter count grows
  // mildly. Keep simple: 64 → ×1, 128 → ×10, 32 → ×0.12
  var scale = 1;
  if (GRID_STATE.N === 32) scale = 0.12;
  if (GRID_STATE.N === 128) scale = 10;

  var total = s * scale * n;

  // CPU fallback adjustment
  if (!HW.webgpu_available) total *= 18;

  setEstimate(formatTime(total));
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
  runRealSweep(runN);
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
     3. Otherwise, await solveDesignElastic(recipe, N) and map
        return value into d.results schema.

   Progress: one tick per design completion, plus an inner tick
   while a design is mid-solve.  Cancel honored between designs.

   Tabs supported by real numbers:
     ✓ Geometry (already working from raymarcher)
     ✓ Stiffness — uses E11/zener
     ✓ Stress — heuristic (E11-derived) via existing svg
   Tabs that get sentinel values for now (physics not yet wired):
     × Buckling      — lambda_cr, pcr_py     (stub)
     × Thermal       — kappa_z               (stub)
     × Nonlinear     — sigma_y_z, hardening  (stub)
   ============================================================ */
async function runRealSweep(N){
  var nDesigns = LAB_STATE.designs.length;
  var t0 = performance.now();

  /* Make sure WebGPU is alive — solveDesignElastic requires it */
  if (typeof ensureDevice === 'function'){
    var ok = false;
    try { ok = await ensureDevice(); } catch (e) { ok = false; }
    if (!ok){
      paintRunStatus('WebGPU unavailable — cannot run real elastic solver');
      paintSolverPill('webgpu unavailable', 'bad');
      finishRunFailed('WebGPU not available');
      return;
    }
  }

  for (var i = 0; i < nDesigns; i++){
    if (RUN_STATE.cancelled) return;     /* cancel between designs */
    RUN_STATE.currentIndex = i;
    var d = LAB_STATE.designs[i];

    /* Inner progress: rough fractional progress assuming each design takes
       roughly equal time.  Update before solve starts so the bar moves
       smoothly even for the first design. */
    var pStart = i / nDesigns;
    RUN_STATE.progress = pStart;
    paintRunProgress(pStart);
    paintRunStatus('<span class="v">Elastic</span> · Design ' + letterFor(i) +
                   ' · N=' + N + ' · solving…');
    renderDesignGrid();

    /* Resolve recipe */
    var recipe = (typeof recipeForDesign === 'function') ? recipeForDesign(d) : null;

    if (!recipe){
      /* No real recipe (e.g. RD design with no lab kernel).  Keep any
         pre-populated mock results, or fill sentinel values so the UI
         doesn't crash. */
      if (!d.results) d.results = stubResults();
      d.results._runSource = 'stub (no kernel)';
      continue;
    }

    /* Real solve */
    var elasticResult = null;
    var solveErr = null;
    try {
      elasticResult = await solveDesignElastic(recipe, N);
    } catch (err){
      solveErr = err;
      console.error('[run] design ' + d.id + ' elastic solve failed:', err);
    }

    if (RUN_STATE.cancelled) return;

    if (solveErr || !elasticResult || !elasticResult.valid){
      d.results = stubResults();
      d.results._runSource = solveErr ? ('error: ' + solveErr.message) : 'invalid (singular C)';
      d.results._error = true;
    } else {
      d.results = mapElasticToResults(elasticResult);
      d.results._runSource = 'real elastic · N=' + N + ' · ' + (elasticResult.tCG_ms|0) + ' ms';
    }
  }

  if (RUN_STATE.cancelled) return;

  RUN_STATE.progress = 1;
  paintRunProgress(1);
  paintRunStatus('<span class="v">Run complete</span> · ' + ((performance.now()-t0)/1000).toFixed(1) + ' s');
  finishRun();
}


/* mapElasticToResults — build the d.results object the comparison UI expects
   from a solveDesignElastic return value.  Fields the elastic 3-LC normal-block
   pipeline doesn't compute (shears, buckling, yield, thermal) get either a
   computed surrogate or a sentinel that the UI displays gracefully. */
function mapElasticToResults(R){
  var Ex = R.Ex_MPa / 1000;     /* MPa → GPa for UI */
  var Ey = R.Ey_MPa / 1000;
  var Ez = R.Ez_MPa / 1000;

  /* Anisotropy ratio — true Zener needs C44; we don't have shear LCs.  Use
     diagonal-Young anisotropy as a labeled surrogate.  Values near 1.0 → 
     near-isotropic; values >>1 → anisotropic.  This matches user intuition
     for the existing UI's "0.91 near-isotropic / 1.34 diagonal dominant" copy. */
  var Emin = Math.min(Ex, Ey, Ez);
  var Emax = Math.max(Ex, Ey, Ez);
  var aniso = (Emin > 1e-6) ? (Emax / Emin) : 1.0;

  /* Poisson surrogate from compliance off-diagonals.  C_eff is the 3×3
     normal block; full Poisson would need the inverted compliance.  Use
     the recipe nu as a fallback — keeps the UI populated without lying
     about precision. */
  var nu_use = (R.nu != null) ? R.nu : 0.30;

  return {
    /* Real elastic results */
    E11: Ex, E22: Ey, E33: Ez,
    zener: aniso,
    nu12: nu_use, nu13: nu_use, nu23: nu_use,
    /* Shear surrogate — G ≈ E / (2(1+ν)), rough-only.  Would need a
       6-LC homogenization to compute properly. */
    G12: Ex / (2 * (1 + nu_use)),
    G13: Ex / (2 * (1 + nu_use)),
    G23: Ey / (2 * (1 + nu_use)),
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
    converged:    R.converged
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
  /* No useful ETA for real runs (each design's wall time is unpredictable);
     hide the ETA element until we have per-design timing data. */
  var etaEl = document.getElementById('progEta');
  if (etaEl) etaEl.textContent = '—';
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
}

function finishRun(){
  /* Defensive: any legacy mock timer */
  if (RUN_STATE.timer){
    clearInterval(RUN_STATE.timer);
    RUN_STATE.timer = null;
  }
  RUN_STATE.running = false;
  LAB_STATE.runHasCompleted = true;

  // Pick winner: highest E11 with P_cr/P_y >= 1
  var winner = null;
  var bestE = -Infinity;
  for (var i = 0; i < LAB_STATE.designs.length; i++){
    var d = LAB_STATE.designs[i];
    if (d.results && d.results.pcr_py >= 1 && d.results.E11 > bestE){
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

function letterFor(idx){
  return String.fromCharCode(65 + idx);    // A, B, C
}
