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

  var totalSec = parseEstimateSeconds();
  if (totalSec < 5) totalSec = 5;             // floor for the mock
  if (totalSec > 30) totalSec = 30;           // cap so the demo doesn't take 7 minutes

  var ticks = totalSec * 10;                  // 100 ms per tick
  var t = 0;

  RUN_STATE.timer = setInterval(function(){
    t++;
    var p = t / ticks;
    if (p > 1) p = 1;
    RUN_STATE.progress = p;

    // Stage transitions
    var stageMsg, designIdx;
    if (p < 0.10){
      stageMsg = 'Rasterizing geometry · <span class="v">' + LAB_STATE.designs.length + ' designs</span>';
      designIdx = 0;
    } else if (p < 0.30){
      designIdx = Math.floor((p - 0.10) / 0.20 * LAB_STATE.designs.length);
      designIdx = Math.min(designIdx, LAB_STATE.designs.length - 1);
      stageMsg = '<span class="v">Elastic</span> · Design ' + letterFor(designIdx);
    } else if (p < 0.55){
      designIdx = Math.floor((p - 0.30) / 0.25 * LAB_STATE.designs.length);
      designIdx = Math.min(designIdx, LAB_STATE.designs.length - 1);
      stageMsg = '<span class="v">Buckling · LOBPCG</span> · Design ' + letterFor(designIdx);
    } else if (p < 1.0){
      designIdx = Math.floor((p - 0.55) / 0.45 * LAB_STATE.designs.length);
      designIdx = Math.min(designIdx, LAB_STATE.designs.length - 1);
      var iter = Math.floor((p - 0.55) / 0.45 * 15) + 1;
      stageMsg = '<span class="v">Nonlinear</span> · Design ' + letterFor(designIdx) + ' · iter <span class="v">' + iter + '</span> / 15';
    }
    RUN_STATE.currentIndex = designIdx;

    var statusEl = document.getElementById('progStatus');
    if (statusEl) statusEl.innerHTML = stageMsg;

    var fill = document.getElementById('progFill');
    if (fill) fill.style.width = (p * 100).toFixed(1) + '%';

    var remain = (1 - p) * totalSec;
    var m = Math.floor(remain / 60);
    var sec = Math.floor(remain % 60);
    var etaEl = document.getElementById('progEta');
    if (etaEl) etaEl.textContent = m + ':' + (sec < 10 ? '0' : '') + sec;

    renderDesignGrid();

    if (p >= 1){
      finishRun();
    }
  }, 100);
}

function finishRun(){
  clearInterval(RUN_STATE.timer);
  RUN_STATE.timer = null;
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
  clearInterval(RUN_STATE.timer);
  RUN_STATE.timer = null;
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
