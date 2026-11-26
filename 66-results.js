/* ============================================================
   F13LD.lab · 66-results.js  (UI refresh stage 4)
   Results follow the settings (Matt, 2026-11-26; docs/UI_AUDIT.md §8).

   • labResultSig(mode, design[, o]) is the one cache key per mode
     (elastic, crush base, buckle, thermal, flow).  The run (50 runRealSweep)
     stamps it on every result, errors included, and reuses a result whose key
     matches; the display compares it with the current settings and design.
   • A result whose key no longer matches is hidden, not deleted: switching the
     setting back shows it again, and Run is then a cache hit.  Readout settings
     (flow direction, fluid, viscosity, shear target, units, chamber), view
     choices and sweep runs are not in any key and never hide anything.
   • Display entry points (renderDesignGrid and the Crush / Flow-chart / phone
     Results renders) run inside labShowResults(): for that call the result
     stores hold only the results that are shown, so every card row, tile,
     delta and plot reads the same thing.  Derived values follow their inputs:
     a delta needs both designs' values (the baseline's hidden results read as
     none), buckling-to-yield and the failure mode need the buckling result and
     every crush result it was based on, Load Capacity needs every input shown,
     and the Mesh hand-off needs every elastic result shown (no buckling hidden).
     Export PDF needs every result shown.
   • Hidden rows say "settings changed · Run", tiles "Run to update", and the
     status chip "settings changed · Run" instead of "run complete".
   • A settings change (paintDock / recomputeEstimate / material) re-renders
     the cards only when the set of shown results changed.

   Mobile rules: function declarations, var, no modules.
   ============================================================ */

var LAB_STALE_NOTE = 'settings changed · Run';
var LAB_STALE_TILE = 'Run to update';
var LAB_STALE_CHIP = 'settings changed · Run';
var LAB_RESULTS = { depth: 0, pass: null, lastSt: null, shownKey: '', syncQueued: false, wasStale: false };

/* Recipe + selected material fingerprint, as the run computes it (memoized for one pass). */
function labResultFp(d) {
  var P = LAB_RESULTS.pass;
  if (P && Object.prototype.hasOwnProperty.call(P.fp, d.id)) return P.fp[d.id];
  var rc = (typeof recipeForDesign === 'function') ? recipeForDesign(d) : null;
  var fp = rc ? recipeFingerprint(applySelectedMaterial(rc)) : null;
  if (P) P.fp[d.id] = fp;
  return fp;
}

/* The cache key of one mode for one design.  o (run only) pins what the run captured at its start:
   { N, fp, kS }.  null = the design has no recipe (stub results are always shown). */
function labResultSig(mode, d, o) {
  o = o || {};
  var fp = (o.fp != null) ? o.fp : labResultFp(d);
  if (!fp) return null;
  var conn = GEOM_STATE.connectivity;
  if (mode === 'elastic') return 'N' + (o.N || GRID_STATE.N) + '|p' + conn + '|full6|cg' + CG_MAXITER_FULL + '|vs1|pv' + (GEOM_STATE.partialVolume ? 1 : 0) + '|r' + fp;
  if (mode === 'crush')   return 'N' + (o.N || NONLIN_STATE.N) + '|c' + NONLIN_STATE.cap + '|p' + conn + '|r' + fp;
  if (mode === 'buckle')  return 'N' + (o.N || BUCKLE_STATE.N) + '|p' + conn + '|g' + (window.BUCKLE_GPU ? 1 : 0) + '|r' + fp;
  if (mode === 'thermal') {
    var kS = (o.kS !== undefined) ? o.kS : thermalKsFor(applySelectedMaterial(recipeForDesign(d)));
    return 'N' + (o.N || GRID_STATE.N) + '|p' + conn + '|tol' + THERMAL_STATE.tol + '|ks' + kS + '|' + THERMAL_GPU_VERSION + '|r' + fp;
  }
  if (mode === 'flow')    return 'N' + (o.N || FLOW_STATE.N) + '|p' + conn + '|tol' + FLOW_STATE.tol + '|' + FLOW_GPU_VERSION + '|r' + fp;
  return null;
}

/* The crush void comes from the elastic result at run time (50 runRealSweep, Phase 2).  When the
   next run would re-solve elastic first, the void it will use is unknown: null (crush hidden). */
function labCrushVoid(d, st) {
  if (typeof PHYS_STATE !== 'undefined' && PHYS_STATE.elastic && st.elastic !== 'shown') return null;
  var rc = applySelectedMaterial(recipeForDesign(d));
  var es = (rc && rc.material && rc.material.Es_MPa) || 110000;
  var r = d.results && !d.results._error ? d.results : null;
  var e = r ? 1000 * Math.min(r.E11 || Infinity, r.E22 || Infinity, r.E33 || Infinity) : 0;
  if (!isFinite(e)) e = 0;
  var v = voidForStiffness(e, es, NL_VOID_CONTRAST);
  return v != null ? v : 1e-4;
}

/* Per mode: 'shown' | 'stale' | 'none'.  crushAxes[k] per solved axis; ratio = buckling-to-yield. */
function labResultStates(d) {
  var st = { elastic: 'none', crush: 'none', crushStale: false, crushAxes: {}, buckle: 'none', ratio: 'none', thermal: 'none', flow: 'none' };
  var r = d.results, s;
  if (r) { s = labResultSig('elastic', d); st.elastic = (s == null || r._elasticSig === s) ? 'shown' : 'stale'; }
  var ax = (typeof NONLIN_AXES !== 'undefined') ? NONLIN_AXES[d.id] : null;
  if (ax) {
    var base = labResultSig('crush', d), v = labCrushVoid(d, st), any = false;
    for (var i = 0; i < NL_AXIS_KEYS.length; i++) {
      var k = NL_AXIS_KEYS[i], e = ax[k];
      if (!e) continue;
      var ok = base == null || (ax.base === base && v != null && e._sig === base + '|a' + k + '|v' + v);
      st.crushAxes[k] = ok ? 'shown' : 'stale';
      if (ok) any = true; else st.crushStale = true;
    }
    st.crush = any ? 'shown' : (st.crushStale ? 'stale' : 'none');
  }
  var bk = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
  if (bk) {
    s = labResultSig('buckle', d);
    st.buckle = (s == null || bk._sig === s) ? 'shown' : 'stale';
    st.ratio = (st.buckle === 'shown' && !st.crushStale) ? 'shown' : 'stale';
  }
  var th = (typeof THERMAL_BY_DESIGN !== 'undefined') ? THERMAL_BY_DESIGN[d.id] : null;
  if (th) { s = labResultSig('thermal', d); st.thermal = (s == null || th.base === s) ? 'shown' : 'stale'; }
  var fl = (typeof FLOW_BY_DESIGN !== 'undefined') ? FLOW_BY_DESIGN[d.id] : null;
  if (fl) { s = labResultSig('flow', d); st.flow = (s == null || fl.base === s) ? 'shown' : 'stale'; }
  return st;
}

function labResultsDesigns() { return (typeof LAB_STATE !== 'undefined' && LAB_STATE.designs) ? LAB_STATE.designs : []; }
/* States of every design for one display pass (reused by nested calls). */
function labResultsPassStates() {
  var P = LAB_RESULTS.pass;
  if (P && P.st) return P.st;
  var own = !P;
  if (own) P = LAB_RESULTS.pass = { fp: {}, st: null };
  var ds = labResultsDesigns(), st = {};
  for (var i = 0; i < ds.length; i++) st[ds[i].id] = labResultStates(ds[i]);
  P.st = st;
  if (own) LAB_RESULTS.pass = null;
  return st;
}
function labResultsKeyOf(st) {
  var ds = labResultsDesigns(), out = [];
  for (var i = 0; i < ds.length; i++) {
    var s = st[ds[i].id]; if (!s) continue;
    var a = []; for (var k in s.crushAxes) a.push(k + s.crushAxes[k]);
    out.push(ds[i].id + ':' + [s.elastic, s.crush, a.join(','), s.buckle, s.ratio, s.thermal, s.flow].join('/'));
  }
  return out.join(';');
}
/* { anyStale, elasticAll (every elastic result shown), buckleStale } */
function labResultsSummary(st) {
  st = st || labResultsPassStates();
  var ds = labResultsDesigns(), o = { anyStale: false, elasticAll: true, buckleStale: false };
  for (var i = 0; i < ds.length; i++) {
    var s = st[ds[i].id]; if (!s) continue;
    if (s.elastic !== 'shown') o.elasticAll = false;
    if (s.buckle === 'stale' || s.ratio === 'stale') o.buckleStale = true;
    if (s.elastic === 'stale' || s.crushStale || s.buckle === 'stale' || s.ratio === 'stale' || s.thermal === 'stale' || s.flow === 'stale') o.anyStale = true;
  }
  return o;
}
/* The card note for a hidden result of this mode, or null.  mode: elastic | crush | buckle | ratio |
   thermal | flow | capacity (Load Capacity: buckling, ratio or crush hidden). */
function labStaleNote(mode, d) {
  if (!d) return null;
  var st = labResultsPassStates()[d.id];
  if (!st) return null;
  var stale = (mode === 'crush') ? st.crushStale
            : (mode === 'capacity') ? (st.crushStale || st.buckle === 'stale' || st.ratio === 'stale')
            : (st[mode] === 'stale');
  return stale ? LAB_STALE_NOTE : null;
}

/* Run fn with the result stores narrowed to the shown results (see the header). */
function labShowResults(fn, self, args) {
  if (LAB_RESULTS.depth) return fn.apply(self, args);
  LAB_RESULTS.pass = { fp: {}, st: null };
  var st = labResultsPassStates();
  LAB_RESULTS.lastSt = st;
  var G = { B: BUCKLE_BY_DESIGN, N: NONLIN_BY_DESIGN, A: NONLIN_AXES, T: THERMAL_BY_DESIGN, F: FLOW_BY_DESIGN };
  var B = {}, N = {}, A = {}, T = {}, F = {}, k, savedRes = [], crushIds = [];
  for (k in G.B) B[k] = G.B[k];
  for (k in G.N) N[k] = G.N[k];
  for (k in G.A) A[k] = G.A[k];
  for (k in G.T) T[k] = G.T[k];
  for (k in G.F) F[k] = G.F[k];
  var ds = labResultsDesigns();
  for (var i = 0; i < ds.length; i++) {
    var d = ds[i], s = st[d.id];
    if (!s) continue;
    if (s.elastic === 'stale') { savedRes.push([d, d.results]); d.results = null; }
    if (s.buckle === 'stale') delete B[d.id];
    else if (s.buckle === 'shown' && s.ratio !== 'shown')
      B[d.id] = Object.assign({}, G.B[d.id], { pcr_py: NaN, failure_mode: null, ratioAxis: null, provisional: false, yieldBound: false, _ratioHidden: true });
    if (s.crushStale) {
      var a0 = G.A[d.id], a1 = {};
      for (k in a0) if (NL_AXIS_KEYS.indexOf(k) < 0 || s.crushAxes[k] === 'shown') a1[k] = a0[k];
      A[d.id] = a1; crushIds.push(d.id);
    }
    if (s.thermal === 'stale') delete T[d.id];
    if (s.flow === 'stale') delete F[d.id];
  }
  LAB_RESULTS.depth++;
  BUCKLE_BY_DESIGN = B; NONLIN_AXES = A; THERMAL_BY_DESIGN = T; FLOW_BY_DESIGN = F;
  for (i = 0; i < crushIds.length; i++) { var g = nlGoverning(crushIds[i]); if (g) N[crushIds[i]] = g; else delete N[crushIds[i]]; }
  NONLIN_BY_DESIGN = N;
  try { return fn.apply(self, args); }
  finally {
    BUCKLE_BY_DESIGN = G.B; NONLIN_BY_DESIGN = G.N; NONLIN_AXES = G.A; THERMAL_BY_DESIGN = G.T; FLOW_BY_DESIGN = G.F;
    for (i = 0; i < savedRes.length; i++) savedRes[i][0].results = savedRes[i][1];
    LAB_RESULTS.depth--;
    LAB_RESULTS.pass = null;
  }
}

/* Status chip: "run complete" only while every result is shown. */
function labResultsChip(st) {
  if (typeof RUN_STATE !== 'undefined' && RUN_STATE.running) return;
  if (typeof LAB_STATE === 'undefined' || !LAB_STATE.runHasCompleted) return;
  var el = document.getElementById('solverPill'), txt = el ? el.textContent : '';
  if (txt !== 'run complete' && txt !== LAB_STALE_CHIP) return;   /* leave errors and other states alone */
  var stale = labResultsSummary(st).anyStale;
  /* phone: the Results tab gets the amber dot when its numbers go hidden */
  if (stale && !LAB_RESULTS.wasStale && window.F13UI && F13UI.onAnalyze) F13UI.onAnalyze('stale');
  LAB_RESULTS.wasStale = stale;
  if (stale && txt !== LAB_STALE_CHIP) paintSolverPill(LAB_STALE_CHIP, 'warn');
  else if (!stale && txt !== 'run complete') paintSolverPill('run complete', 'live');
}

/* Export PDF and the Mesh hand-off follow the same rule. */
function labResultsActions(st) {
  if (typeof LAB_STATE === 'undefined' || !LAB_STATE.runHasCompleted) return;
  var sum = labResultsSummary(st), why = 'Settings changed since the run · Run all to update';
  var pdf = document.getElementById('exportPdfBtn'), mesh = document.getElementById('meshHandoffBtn');
  if (pdf) { pdf.disabled = sum.anyStale; pdf.title = sum.anyStale ? why : 'Export PDF'; }
  if (mesh && LAB_STATE.winningId && (!sum.elasticAll || sum.buckleStale)) { mesh.disabled = true; mesh.title = why; }
}
function labResultsBlocked(kind) {
  if (typeof LAB_STATE === 'undefined' || !LAB_STATE.runHasCompleted) return false;
  var sum = labResultsSummary();
  return kind === 'pdf' ? sum.anyStale : (!sum.elasticAll || sum.buckleStale);
}

/* After a settings change: re-render only when the set of shown results changed. */
function labResultsSync() {
  if (LAB_RESULTS.syncQueued) return;
  LAB_RESULTS.syncQueued = true;
  setTimeout(function () {
    LAB_RESULTS.syncQueued = false;
    var st = labResultsPassStates(), key = labResultsKeyOf(st);
    if (key !== LAB_RESULTS.shownKey && typeof renderDesignGrid === 'function') renderDesignGrid();
    else { labResultsChip(st); if (typeof updateActionButtons === 'function') updateActionButtons(); }
  }, 0);
}

/* ── Wiring (this file loads after 50–65, before 99-init; 53b has already wrapped renderDesignGrid) ── */
(function () {
  function wrapShown(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var r = labShowResults(orig, this, arguments);
      if (after && !LAB_RESULTS.depth) { try { after(); } catch (e) { console.error('[results]', e); } }
      return r;
    };
  }
  wrapShown('renderDesignGrid', function () {
    var st = LAB_RESULTS.lastSt || labResultsPassStates();
    LAB_RESULTS.shownKey = labResultsKeyOf(st);
    labResultsChip(st);
    if (typeof updateActionButtons === 'function') updateActionButtons();
  });
  ['renderNonlinearViz', 'renderMergedCurvePlot', 'curvePlotData', 'renderFlowCharts', 'labResultsPaint'].forEach(function (n) { wrapShown(n); });
  function after(name, fn) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { var r = orig.apply(this, arguments); try { fn(); } catch (e) { console.error('[results]', e); } return r; };
  }
  after('updateActionButtons', function () { labResultsActions(); });
  ['paintDock', 'recomputeEstimate', 'onMaterialChange', 'onConnectivityChange', 'onSurfaceVoxelChange'].forEach(function (n) { after(n, labResultsSync); });
  function guard(name, kind) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { if (labResultsBlocked(kind)) return; return orig.apply(this, arguments); };
  }
  guard('onExportPdfClick', 'pdf');
  guard('onMeshHandoffClick', 'mesh');
})();
