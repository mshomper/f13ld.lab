/* ============================================================
   F13LD.lab · 62-sweep.js
   Parameter sweep — homogenized elastic stiffness over a list of runs.

   Two ways to get a run list:
     · Load a run-matrix CSV (the PI-TPMS paper format: run_id, surface,
       mode, shift, wall_ratio, tube_radius_over_T, level_c, grid_N, nu_s,
       expected_vf_pct, vixiv_* …).  Each row becomes one recipe.
     · Build one: pick a loaded design and one of its parameters (level,
       wall thickness, PI wall ratio, a shift component, grain/noise level
       or half-width, wall offset of an imported STL cell), a range and a
       number of steps.

   Each run: elastic only, on the GPU, E_s normalized out (all stiffness
   reported ÷ E_s), Poisson's ratio per run, the lab's island-trim setting
   (connectivity selector) — reported per run as voxel solid fraction before
   and after trim — and a precision toggle (CG tolerance 1e-4 or 1e-5).
   Results persist in localStorage (small: a few kB per run), so a reload
   resumes where it stopped.  Export: one CSV row per run with the 21
   upper-triangle stiffness terms, engineering constants and solver record.
   ============================================================ */

var SWEEP_STORE_KEY = 'f13ld.lab.sweep.v1';
var SWEEP_ES = 110000;            /* MPa; every stiffness is divided by this */
var SWEEP_VF_TOL = 0.01;          /* build check: |vf − expected| / expected */
var SWEEP_PRECISION = {
  /* v0.16.0 — Standard cap 300 -> 1000: 27 of the 48 foam calibration runs stopped at 300
     (open/plateau 18-35 %, closed 12-18 % at 64³), and a stopped solve reads stiff. */
  standard: { tol: 1e-4, maxiter: 1000, label: 'Standard (1e-4)' },
  high:     { tol: 1e-5, maxiter: 1000, label: 'High (1e-5)' }
};
var VOIGT = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];

var SWEEP_STATE = {
  open: false, running: false, stopRequested: false,
  name: '', source: null,          /* name = CSV file name or builder save name; source 'csv' | 'builder' */
  title: '',                       /* v0.12.1 — readable study title shown in the panel (renamable) */
  runs: [],                        /* run definitions (sweepRunFromCsvRow / sweepRunsFromCombos) */
  bases: {},                       /* builder sweeps: base recipe(s) the runs modify */
  axes: null,                      /* builder sweeps: [{key,label,unit,values,byVf}] for maps */
  review: null,                    /* builder review in progress (not saved) */
  results: {},                     /* run_id → result record */
  selected: {},                    /* run_id → bool */
  precision: 'standard',
  physics: 'stiffness',            /* v0.23.0 — 'stiffness' | 'thermal' (stiffness + thermal κ per filler) */
  preview: {},                     /* run_id → geometry stats (14d-voxel-stats.js) */
  builder: {},                     /* last builder settings (kept across redraws and reloads) */
  voidRatio: 1e-6,                 /* void stiffness ÷ solid (Matt, 2026-10-01: 1e-6 for sweeps) */
  refine: 'off',                   /* 'off' | 'coarser' | 'finer' | 'pair' (64 ↔ 128) — second grid for extrapolation */
  order: 2,                        /* assumed convergence order for the extrapolation */
  partialVolume: true,             /* v0.19.0 — surface voxels carry their solid fraction in the stiffness solve (default on; saved sweeps from before keep the cube) */
  previewing: false, previewDone: 0, previewTotal: 0,
  current: null, startedAt: 0, log: []
};

/* ── Persistence ──────────────────────────────────────────── */
/* Saved in IndexedDB ('f13ld.lab.sweep' / 'state' / key 'current') so big
   sweeps aren't capped by localStorage's ~5 MB; writes are coalesced.
   Older sweeps saved in localStorage are read once and moved over. */
var _swDbP = null, _swSaveT = 0;
function sweepDb() {
  if (_swDbP) return _swDbP;
  _swDbP = new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    var req = indexedDB.open('f13ld.lab.sweep', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('state'); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  _swDbP.catch(function () { _swDbP = null; });
  return _swDbP;
}
function sweepSnapshot() {
  return { v: 2, name: SWEEP_STATE.name, title: SWEEP_STATE.title, source: SWEEP_STATE.source, runs: SWEEP_STATE.runs, bases: SWEEP_STATE.bases, axes: SWEEP_STATE.axes,
    results: SWEEP_STATE.results, selected: SWEEP_STATE.selected, precision: SWEEP_STATE.precision,
    preview: SWEEP_STATE.preview, builder: SWEEP_STATE.builder,
    voidRatio: SWEEP_STATE.voidRatio, refine: SWEEP_STATE.refine, order: SWEEP_STATE.order, timing: SWEEP_STATE.timing,
    partialVolume: SWEEP_STATE.partialVolume, physics: SWEEP_STATE.physics };
}
function sweepSave() {
  if (_swSaveT) return;
  _swSaveT = setTimeout(function () {
    _swSaveT = 0;
    var snap = sweepSnapshot();
    sweepDb().then(function (db) {
      var tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(snap, 'current');
    }).catch(function (e) {
      try { localStorage.setItem(SWEEP_STORE_KEY, JSON.stringify(snap)); } catch (e2) { console.warn('[sweep] not saved:', e2); }
    });
  }, 250);
}
function sweepApplySaved(p) {
  if (!p || !Array.isArray(p.runs)) return false;
  SWEEP_STATE.name = p.name || ''; SWEEP_STATE.source = p.source || null;
  SWEEP_STATE.title = p.title || sweepTitleFromName(SWEEP_STATE.name, SWEEP_STATE.source);
  SWEEP_STATE.runs = p.runs; SWEEP_STATE.results = p.results || {};
  SWEEP_STATE.bases = p.bases || {}; SWEEP_STATE.axes = p.axes || null;
  SWEEP_STATE.selected = p.selected || {}; SWEEP_STATE.precision = p.precision || 'standard';
  SWEEP_STATE.preview = p.preview || {};
  SWEEP_STATE.builder = p.builder || {};
  if (p.voidRatio > 0) SWEEP_STATE.voidRatio = p.voidRatio;
  SWEEP_STATE.refine = p.refine || 'off'; SWEEP_STATE.order = p.order || 2;
  SWEEP_STATE.partialVolume = p.partialVolume === true;
  SWEEP_STATE.physics = p.physics === 'thermal' ? 'thermal' : 'stiffness';
  SWEEP_STATE.timing = p.timing || SWEEP_STATE.timing || {};
  return true;
}
var SWEEP_LOADED = null;
function sweepLoad() {
  var legacy = null;
  try { var raw = localStorage.getItem(SWEEP_STORE_KEY); if (raw) legacy = JSON.parse(raw); } catch (e) {}
  SWEEP_LOADED = sweepDb().then(function (db) {
    return new Promise(function (resolve) {
      var req = db.transaction('state', 'readonly').objectStore('state').get('current');
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { resolve(null); };
    });
  }).catch(function () { return null; }).then(function (saved) {
    if (saved) sweepApplySaved(saved);
    else if (legacy && sweepApplySaved(legacy)) { sweepSave(); }
    try { localStorage.removeItem(SWEEP_STORE_KEY); } catch (e) {}
    if (SWEEP_STATE.open) { sweepRenderBuilder(); sweepRender(); }
  });
}

/* ── Geometry helpers ─────────────────────────────────────── */
var SWEEP_GYROID = [
  { on: true, coef: 1, factors: [{ trig: 'sin(x)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
  { on: true, coef: 1, factors: [{ trig: 'sin(y)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] },
  { on: true, coef: 1, factors: [{ trig: 'sin(z)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] }
];
function sweepClone(o) { return JSON.parse(JSON.stringify(o)); }
function sweepFrac(s) {
  s = String(s).trim();
  var p = s.split('/');
  return p.length === 2 ? (+p[0]) / (+p[1]) : +s;
}
function sweepSurface(name) {
  var n = String(name || '').toLowerCase();
  if (/gyroid/.test(n)) return { type: 'terms', terms: sweepClone(SWEEP_GYROID) };
  if (/fischer|koch|fks/.test(n)) return { type: 'raw_preset', preset: 'fks' };
  if (/lidinoid/.test(n)) return { type: 'raw_preset', preset: 'lidinoid' };
  if (/schwarz\s*p|primitive/.test(n)) return { type: 'terms', terms: [
    { on: true, coef: 1, factors: [{ trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] },
    { on: true, coef: 1, factors: [{ trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
    { on: true, coef: 1, factors: [{ trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] }] };
  return null;
}
function sweepNegate(surface) {
  var s = sweepClone(surface);
  if (s.type === 'raw_preset') s = { type: 'terms', terms: resolveRawPreset(s.preset) };
  s.terms = s.terms.map(function (t) { var c = sweepClone(t); c.coef = -c.coef; return c; });
  return s;
}

/* ── Run-matrix CSV ───────────────────────────────────────── */
function sweepParseCsv(text) {
  var rows = [], row = [], cur = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  var hdr = rows[0].map(function (h) { return h.trim(); });
  return rows.slice(1).map(function (r) {
    var o = {};
    hdr.forEach(function (h, k) { o[h] = (r[k] != null ? r[k] : '').trim(); });
    return o;
  });
}
function sweepNum(v) { var x = parseFloat(v); return isFinite(x) ? x : null; }

/* One CSV row → one run definition.  Mapping (validated against all 41
   rows of the PI-TPMS §5 matrix — every run within ~1 % of expected_vf_pct
   at its own grid, B3 −2.2 % at N = 64 / +0.1 % at 128, F1 intentionally
   coarse):
     PI-TPMS round   → pi-tpms, gradient-normalized, pipeR = tube_radius_over_T · 2π,
                       phaseShift in cycles from "shift"
     Sheet |φ| ≤ c   → shell, offset 0, wallThickness = c
     Skeletal φ ≥ c  → solid on −φ, offset −c */
function sweepRunFromCsvRow(r) {
  var id = r.run_id || r.id;
  if (!id) throw new Error('a row has no run_id');
  if (String(r.family || '').toLowerCase() === 'foam') return sweepFoamRunFromCsvRow(r, id);
  var surf = sweepSurface(r.surface);
  if (!surf) throw new Error(id + ': unknown surface "' + r.surface + '"');
  var mode = String(r.mode || '').toLowerCase(), g, param;
  if (/pi/.test(mode)) {
    var tr = sweepNum(r.tube_radius_over_T), wr = sweepNum(r.wall_ratio);
    if (tr == null && wr != null) tr = wr / 2;
    if (tr == null) throw new Error(id + ': PI run needs tube_radius_over_T or wall_ratio');
    var sh = String(r.shift || '0,0,0').replace(/[()\s]/g, '').split(',').map(sweepFrac);
    g = { mode: 'pi-tpms', pi_normalize: !/not normalized|raw/.test(mode), pipeR: tr * 2 * Math.PI,
          phaseShift: { x: sh[0] || 0, y: sh[1] || 0, z: sh[2] || 0 }, cellSizeMm: 5 };
    param = { name: 'wall_ratio', value: wr != null ? wr : 2 * tr };
  } else if (/sheet/.test(mode)) {
    var c = sweepNum(r.level_c);
    if (c == null) throw new Error(id + ': sheet run needs level_c');
    g = { mode: 'shell', offset: 0, wallThickness: c, cellSizeMm: 5 };
    param = { name: 'level_c', value: c };
  } else if (/skelet|solid/.test(mode)) {
    var c2 = sweepNum(r.level_c);
    if (c2 == null) throw new Error(id + ': skeletal run needs level_c');
    surf = sweepNegate(surf);
    g = { mode: 'solid', offset: -c2, cellSizeMm: 5 };
    param = { name: 'level_c', value: c2 };
  } else throw new Error(id + ': unknown mode "' + r.mode + '"');
  var N = sweepNum(r.grid_N) || 64;
  if ([32, 64, 128].indexOf(N) < 0) throw new Error(id + ': grid ' + N + ' not available (32, 64 or 128)');
  return {
    id: id, tier: r.tier || '', set: r.set || '', purpose: r.purpose || '', note: r.note || '',
    label: (r.surface || '') + ' · ' + (r.mode || ''), shift: r.shift || '',
    N: N, nu: sweepNum(r.nu_s) != null ? sweepNum(r.nu_s) : 0.3,
    param: param, expectedVf: sweepNum(r.expected_vf_pct),
    ref: { name: 'Vixiv', vf: sweepNum(r.vixiv_vf_pct), Ex: sweepNum(r.vixiv_Ex), Ey: sweepNum(r.vixiv_Ey), Ez: sweepNum(r.vixiv_Ez) },
    recipe: { family: 'tpms', name: id, surface: surf, geometry: g }
  };
}

/* v0.14.0 — F13LD.foam rows (family = foam).  Seeds are regenerated from
   the generator settings with the foam tool's own FoamSeeds code, so a row
   is the foam F13LD.foam shows for the same settings.  Columns:
     seed_mode (poisson | lloyd | random | kelvin | weairePhelan), cells,
     regularity, lloyd_iterations, rng_seed, topology (open | closed |
     plateau), thickness, plateau_k, organic, stretch_x/y/z, normalize,
     field (2 = F13LD.foam v0.6.0's exact field; blank = the original),
     fillet, node, border, edge_min (exact field only), size_ratio, large_fraction
     (seed_mode bimodal), jitter (lattices),
     grid_N, nu_s, expected_vf_pct, set, purpose, note. */
function sweepFoamRunFromCsvRow(r, id) {
  var sm = String(r.seed_mode || 'lloyd').trim(), topo = String(r.topology || 'plateau').trim().toLowerCase();
  if (FoamSeeds.MODES.indexOf(sm) < 0) throw new Error(id + ': unknown seed_mode "' + sm + '"');
  if (['open', 'closed', 'plateau', 'wet'].indexOf(topo) < 0) throw new Error(id + ': unknown topology "' + r.topology + '"');
  if (topo === 'wet' && sweepNum(r.field) !== 2) throw new Error(id + ': wet foam needs field 2 (the exact field)');
  var t = sweepNum(r.thickness), cells = sweepNum(r.cells);
  if (topo !== 'wet' && (t == null || !(t > 0))) throw new Error(id + ': foam run needs a thickness above 0');
  if (cells == null || cells < 1) throw new Error(id + ': foam run needs cells');
  var sx = sweepNum(r.stretch_x), sy = sweepNum(r.stretch_y), sz = sweepNum(r.stretch_z);
  var N = sweepNum(r.grid_N) || 64;
  if ([32, 64, 128].indexOf(N) < 0) throw new Error(id + ': grid ' + N + ' not available (32, 64 or 128)');
  var seeds = { mode: sm, count: Math.round(cells), regularity: sweepNum(r.regularity) != null ? sweepNum(r.regularity) : 0.9,
                lloyd_iterations: sweepNum(r.lloyd_iterations) != null ? Math.round(sweepNum(r.lloyd_iterations)) : (sm === 'lloyd' ? 4 : 0),
                rng_seed: sweepNum(r.rng_seed) != null ? Math.round(sweepNum(r.rng_seed)) : 42 };
  if (sweepNum(r.size_ratio) != null) seeds.size_ratio = sweepNum(r.size_ratio);
  if (sweepNum(r.large_fraction) != null) seeds.large_fraction = sweepNum(r.large_fraction);
  if (sweepNum(r.jitter) != null) seeds.jitter = sweepNum(r.jitter);
  var foam = { mode: topo, thickness: t, plateau_k: topo === 'plateau' ? (sweepNum(r.plateau_k) != null ? sweepNum(r.plateau_k) : 0.05) : null,
               organic: sweepNum(r.organic) || 0, normalize: !/^(false|0|no|off)$/i.test(String(r.normalize || 'true').trim()) };
  if (sweepNum(r.field) === 2) {
    foam.field = 2;
    ['fillet', 'node', 'border', 'edge_min'].forEach(function (k) { if (sweepNum(r[k]) != null) foam[k] = sweepNum(r[k]); });
  }
  if (topo === 'wet' && !(t > 0)) foam.thickness = 0.08;   /* unused by wet foam */
  return {
    id: id, tier: r.tier || '', set: r.set || '', purpose: r.purpose || '', note: r.note || '',
    label: 'foam · ' + sm + ' · ' + topo, shift: '',
    N: N, nu: sweepNum(r.nu_s) != null ? sweepNum(r.nu_s) : 0.3,
    param: { name: 'thickness', value: t }, expectedVf: sweepNum(r.expected_vf_pct),
    ref: { name: '', vf: null, Ex: null, Ey: null, Ez: null },
    recipe: { family: 'foam', name: id, seeds: seeds,
              anisotropy: { enabled: true, stretch: [sx || 1, sy || 1, sz || 1] }, foam: foam,
              geometry: { mode: 'solid', cellSizeMm: 5, cellMult: 1.0 } }
  };
}

function sweepLoadCsvText(text, name) {
  var rows = sweepParseCsv(text), runs = [], errs = [];
  rows.forEach(function (r) { try { runs.push(sweepRunFromCsvRow(r)); } catch (e) { errs.push(e.message); } });
  if (!runs.length) throw new Error(errs[0] || 'no runs found');
  var ids = {};
  runs.forEach(function (r) { if (ids[r.id]) errs.push('duplicate run_id ' + r.id); ids[r.id] = true; });
  return { runs: runs, errors: errs, name: name };
}

/* ── Builder runs (v0.11.0) ───────────────────────────────── */
/* Recipe the solver would use for a loaded design (demo designs resolve
   through recipeForDesign; imported ones carry their own). */
function sweepRecipeOf(d) {
  var r = (typeof recipeForDesign === 'function') ? recipeForDesign(d) : d.recipe;
  return r || null;
}

/* Builder runs keep one base recipe per sweep (SWEEP_STATE.bases) plus the
   values written into it, so a large sweep of a large recipe (a beam with
   hundreds of struts) stays small.  CSV runs carry their own recipe. */
/* Cell edge in mm for a recipe (a foam tile is one lab cell). */
function sweepCellMm(rc) {
  var gm = (rc && rc.geometry) || {};
  return (rc && rc.family === 'foam' && gm.tile_mm > 0) ? gm.tile_mm : (gm.cellSizeMm > 0 ? gm.cellSizeMm : 5);
}
function sweepRecipeForRun(run) {
  if (run.recipe) return run.recipe;
  var base = SWEEP_STATE.bases && SWEEP_STATE.bases[run.baseId];
  if (!base) throw new Error('base design for ' + run.id + ' is missing');
  var r = sweepClone(base);
  (run.applied || []).forEach(function (a) { sweepSetPath(r, a.p, a.v); });
  r.name = run.id;
  return r;
}

/* Values typed as a list ("0, 1/8, 0.25") or a range (from, to, steps). */
function sweepValues(spec) {
  var list = String(spec.list || '').trim();
  if (list) {
    var vals = list.split(/[,;\s]+/).filter(Boolean).map(sweepFrac);
    if (vals.some(function (v) { return !isFinite(v); })) throw new Error('the list "' + list + '" has a value that isn’t a number');
    return vals;
  }
  var from = parseFloat(spec.from), to = parseFloat(spec.to), steps = parseInt(spec.steps, 10);
  if (!isFinite(from) || !isFinite(to) || !(steps >= 1)) throw new Error('enter a start, an end and a number of steps (or a list of values)');
  steps = Math.min(steps, 1000);
  var out = [];
  for (var i = 0; i < steps; i++) out.push(+(steps === 1 ? from : from + (to - from) * i / (steps - 1)).toPrecision(10));
  return out;
}

function sweepFmtVal(v) { return (v == null || !isFinite(v)) ? '—' : String(+(+v).toPrecision(4)); }

/* Turn reviewed combinations into runs (skipped ones unticked). */
function sweepRunsFromCombos(plan, combos) {
  var runs = [], twoD = !!plan.spec2, w = String(Math.max(plan.n1, plan.n2 || 1)).length;
  combos.forEach(function (c) {
    if (c.unreachable) return;
    var id = 'S' + String(c.i + 1).padStart(w, '0') + (twoD ? '-' + String(c.j + 1).padStart(w, '0') : '');
    var r = sweepClone(plan.base), applied = [];
    if (plan.spec2) sweepParamSet(r, plan.spec2, c.v2);
    sweepParamSet(r, plan.spec1, c.v1);
    [plan.spec1].concat(plan.spec2 ? [plan.spec2] : []).forEach(function (sp) {
      sp.apply.forEach(function (ap) { applied.push({ p: ap.p, v: sweepGetPath(r, ap.p) }); });
    });
    var iv = function (sp, v) { return sp.integer ? Math.max(1, Math.round(v)) : v; };   /* whole-number params report what was applied */
    var params = [{ key: plan.spec1.key, name: plan.spec1.label, unit: plan.spec1.unit, value: iv(plan.spec1, c.v1) }];
    if (plan.spec2) params.push({ key: plan.spec2.key, name: plan.spec2.label, unit: plan.spec2.unit, value: iv(plan.spec2, c.v2) });
    var purpose = params.map(function (p) { return p.name + ' = ' + sweepFmtVal(p.value) + (p.unit ? ' ' + p.unit : ''); }).join(', ');
    if (c.target != null) purpose = 'target ' + (c.target * 100).toFixed(2) + ' % solid → ' + purpose;
    if (c.featTarget != null) purpose = 'target thinnest ' + sweepFmtVal(c.featTarget) + ' mm (got ' + sweepFmtVal(c.featVox / plan.N * plan.cellMm) + ' mm at N = ' + plan.N + ') → ' + purpose;
    runs.push({
      id: id, tier: '', set: plan.title, purpose: purpose, note: '', label: plan.title, shift: '',
      N: plan.N, nu: plan.nu, baseId: 'b0', applied: applied, grid: [c.i, c.j],
      param: { name: plan.spec1.key, value: c.v1 }, params: params,
      expectedVf: c.target != null ? +(c.target * 100).toFixed(4) : null, ref: null,
      quick: c.stats ? { vf_trim: c.stats.vf_trim, spans: c.stats.spans, thinVox32: c.stats.thinVox } : null
    });
  });
  return runs;
}

/* ── Execution ────────────────────────────────────────────── */
function sweepVoigtUpper(C) {
  var out = {};
  for (var i = 0; i < 6; i++) for (var j = i; j < 6; j++) out['C' + (i + 1) + (j + 1)] = C[i * 6 + j] / SWEEP_ES;
  return out;
}

var SWEEP_VOID_OPTIONS = [1e-4, 1e-6, 1e-8];
var SWEEP_GRIDS = [32, 64, 128];

/* Second grid for extrapolation: one step coarser or finer than the run's
   grid, within 32–128; null when there is no such grid. */
function sweepCompanionN(N, mode) {
  var i = SWEEP_GRIDS.indexOf(N);
  if (mode === 'coarser') return i > 0 ? SWEEP_GRIDS[i - 1] : null;
  if (mode === 'finer') return (i >= 0 && i < SWEEP_GRIDS.length - 1) ? SWEEP_GRIDS[i + 1] : null;
  /* v0.12.1 — one extrapolation basis for a whole matrix: every run is paired with the other of
     64 and 128 (32 → 64), whatever grid it was listed at (Matt, 2026-10-01). */
  if (mode === 'pair') return N === 128 ? 64 : (N === 64 ? 128 : (N === 32 ? 64 : null));
  return null;
}

/* Engineering constants from a flat 6×6 stiffness (already ÷ E_s). */
function sweepConstants(C) {
  var S = invert6x6(C);
  if (!S) return null;
  return { Ex: 1 / S[0], Ey: 1 / S[7], Ez: 1 / S[14], Gyz: 1 / S[21], Gxz: 1 / S[28], Gxy: 1 / S[35],
           nu_xy: -S[1] / S[0], nu_xz: -S[2] / S[0], nu_yz: -S[8] / S[7] };
}

/* One elastic solve at grid N → normalized record. */
async function sweepSolveAt(recipe, N, prec, conn) {
  var t0 = performance.now();
  var R = await solveDesignElasticFull(recipe, N, {
    connectivity: conn, pruneLargest: conn !== 'off',
    captureFieldsLCs: [], cgTol: prec.tol, cgMaxiter: prec.maxiter, voidRatio: SWEEP_STATE.voidRatio,
    partialVolume: SWEEP_STATE.partialVolume === true
  });
  var wall = (performance.now() - t0) / 1000;
  var noLoad = null;
  if (!R.valid) {
    /* v0.12 — the solver rejects any axis whose modulus reads ≤ 0 or above the solid.  Layers and
       strands (B6) have unloaded axes that read ~0, sometimes a hair negative, after a converged
       solve: keep those with a warning instead of discarding the run. */
    var bad = (R.badAxes || []).map(function (a) { var k = { xx: 'Ex', yy: 'Ey', zz: 'Ez' }[a]; return { axis: a.charAt(0), E: R[k + '_MPa'] / SWEEP_ES }; });
    var lim = sweepNoLoadLimit();
    var keep = R.reject_reason === 'nonconvergent' && R.C_eff && R.converged && bad.length &&
               bad.every(function (b) { return isFinite(b.E) && Math.abs(b.E) <= lim; });
    if (!keep) {
      var why = bad.length ? bad.map(function (b) { return 'E' + b.axis + ' = ' + (isFinite(b.E) ? b.E.toExponential(2) : String(b.E)); }).join(', ') : '';
      throw new Error('solve rejected at N = ' + N + ': ' + (R.reject_reason === 'nonconvergent'
        ? (R.converged ? 'modulus outside 0 … E solid (' + why + ' ÷ E solid)' : 'did not converge' + (why ? ' (' + why + ' ÷ E solid)' : ''))
        : (R.reject_reason || 'unknown')));
    }
    noLoad = bad;
  }
  var per = R.perLC || [], itersBy = {}, resMax = 0, itTot = 0;
  per.forEach(function (p, k) {
    itersBy['iters_' + VOIGT[k]] = p.iters; itTot += p.iters;
    if (p.finalResidual != null && p.finalResidual > resMax) resMax = p.finalResidual;
  });
  var Cfull = R.C_eff.map(function (v) { return v / SWEEP_ES; });
  return { N: N, R: R, Cfull: Cfull, wall: wall, iters: itTot, itersBy: itersBy, residual: resMax, converged: !!R.converged, noLoad: noLoad,
           solver: R.solverPath || 'legacy', gamma_s: (R.tGamma_ms || 0) / 1000 };
}
/* An axis reading within this of zero (÷ E solid) carries no load: 20 × the void stiffness, at least 1e-5. */
function sweepNoLoadLimit() { return Math.max(20 * (SWEEP_STATE.voidRatio || 1e-4), 1e-5); }

async function sweepRunOne(run) {
  var prec = SWEEP_PRECISION[SWEEP_STATE.precision] || SWEEP_PRECISION.standard;
  var recipe = sweepClone(sweepRecipeForRun(run));
  recipe.material = { Es_MPa: SWEEP_ES, nu: run.nu };
  if (recipe.family === 'import' && !(typeof importGridReady === 'function' && importGridReady(recipe)))
    throw new Error('imported geometry is not loaded');
  var conn = (typeof GEOM_STATE !== 'undefined') ? GEOM_STATE.connectivity : 'networks';
  /* v0.23.0 — geometry columns (surface area, open pores) on the geometry
     worker while the GPU solves; a failure only blanks those columns */
  var geomP = sweepGeomCall({ type: 'geom', recipe: recipe, N: run.N, connectivity: conn })
    .then(function (m) { return m.geom; }, function (e) { return { error: (e && e.message) || String(e) }; });
  var A = await sweepSolveAt(recipe, run.N, prec, conn), R = A.R;
  /* v0.19.0 — vf_solved stays the 0/1 voxel count after the trim; with
     partial-volume voxels the fraction-weighted solid is vf_partial */
  var vfRaw = R.rho_raw != null ? R.rho_raw * 100 : R.rho * 100, vf = (R.rho_binary != null ? R.rho_binary : R.rho) * 100;
  var res = {
    id: run.id, when: new Date().toISOString(), N: run.N, nu: run.nu,
    tol: prec.tol, maxiter: prec.maxiter, connectivity: conn, voidRatio: SWEEP_STATE.voidRatio,
    vf_voxel: vfRaw, vf_solved: vf, trim_removed_pct: vfRaw > 0 ? (vfRaw - vf) / vfRaw * 100 : 0,
    partialVolume: !!R.partialVolume, vf_partial: R.partialVolume ? R.rho * 100 : null,
    vf_check: run.expectedVf ? (vfRaw - run.expectedVf) / run.expectedVf : null,
    C: sweepVoigtUpper(R.C_eff),
    Ex: R.Ex_MPa / SWEEP_ES, Ey: R.Ey_MPa / SWEEP_ES, Ez: R.Ez_MPa / SWEEP_ES,
    Gyz: R.Gyz_MPa / SWEEP_ES, Gxz: R.Gxz_MPa / SWEEP_ES, Gxy: R.Gxy_MPa / SWEEP_ES,
    nu_xy: R.nu_xy, nu_xz: R.nu_xz, nu_yz: R.nu_yz,
    iters: A.iters, itersBy: A.itersBy, residual: A.residual, converged: A.converged, wall_s: A.wall,
    solver: A.solver, gamma_s: A.gamma_s   /* v0.15.0 — 'fast' (16i) or 'legacy'; Γ build time (0 when cached) */
  };
  if (A.noLoad) res.noLoad = A.noLoad;
  /* Optional second grid + extrapolation: C_ext = C_fine + (C_fine − C_coarse) / (2^p − 1),
     element by element, then constants from C_ext. */
  var N2 = sweepCompanionN(run.N, SWEEP_STATE.refine);
  if (SWEEP_STATE.refine !== 'off' && !N2) res.extNote = (SWEEP_STATE.refine === 'pair' ? 'no pairing grid for N = ' + run.N : 'no ' + SWEEP_STATE.refine + ' grid than N = ' + run.N) + '; not extrapolated';
  if (N2) {
    var B = await sweepSolveAt(recipe, N2, prec, conn);
    var c = sweepConstants(B.Cfull) || {};
    res.companion = { N: N2, C: sweepVoigtUpper(B.R.C_eff), Ex: c.Ex, Ey: c.Ey, Ez: c.Ez, Gyz: c.Gyz, Gxz: c.Gxz, Gxy: c.Gxy,
                      vf_solved: (B.R.rho_binary != null ? B.R.rho_binary : B.R.rho) * 100, vf_partial: B.R.partialVolume ? B.R.rho * 100 : null, iters: B.iters, residual: B.residual, converged: B.converged, wall_s: B.wall,
                      vf_voxel: (B.R.rho_raw != null ? B.R.rho_raw : B.R.rho) * 100, itersBy: B.itersBy };   /* v0.15.1 */
    res.wall_s += B.wall;
    if (!B.converged) res.converged = false;
    var fine = N2 > run.N ? B : A, coarse = N2 > run.N ? A : B, k = 1 / (Math.pow(2, SWEEP_STATE.order) - 1);
    var Cx = fine.Cfull.map(function (v, i) { return v + (v - coarse.Cfull[i]) * k; });
    var ce = sweepConstants(Cx);
    var Cu = {};
    for (var i = 0; i < 6; i++) for (var j = i; j < 6; j++) Cu['C' + (i + 1) + (j + 1)] = Cx[i * 6 + j];
    res.ext = { order: SWEEP_STATE.order, fineN: fine.N, coarseN: coarse.N, C: Cu };
    if (ce) for (var q in ce) res.ext[q] = ce[q];
  }
  /* v0.23.0 — geometry columns: porosity from the solve's solid fraction
     (partial volume when on, after the island trim, so trimmed islands
     count as pore space); area and open pores from the worker */
  var G = await geomP, cellMm = sweepCellMm(sweepRecipeForRun(run));
  var vfSolid = (res.vf_partial != null ? res.vf_partial : res.vf_solved) / 100;
  res.geom = { porosity: 1 - vfSolid, cell_mm: cellMm, error: G && G.error ? G.error : null };
  if (G && !G.error) {
    res.geom.area = G.area; res.geom.open = G.open;
    res.geom.sad_m2m3 = G.area > 0 ? G.area / (cellMm / 1000) : null;
    res.geom.dh_mm = G.area > 0 ? 4 * res.geom.porosity * cellMm / G.area : null;
  }
  if (SWEEP_STATE.physics === 'thermal') {
    try { res.thermal = await sweepThermalOne(run, recipe); res.wall_s += res.thermal.wall_s || 0; }
    catch (e) { res.thermal = { error: (e && e.message) || String(e) }; }
  }
  res.notes = sweepNotesFor(run, res);
  return res;
}

/* v0.23.0 — thermal κ for one sweep run: the material and pore fillers set
   in the Configure drawer, the run's own grid (no second grid: the
   composite wall voxels are grid-converged by N = 64, THERMAL_SCOPE.md §11). */
async function sweepThermalOne(run, recipe) {
  var mat = (typeof applySelectedMaterial === 'function') ? applySelectedMaterial(sweepRecipeForRun(run)) : sweepRecipeForRun(run);
  var kS = thermalKsFor(mat), cpS = thermalCpFor(mat), rhoS = thermalRhoFor(mat);
  var name = (mat && mat.material && mat.material.name) || 'Ti-6Al-4V (default)';
  var basis = (mat && mat.material && mat.material.ksBasis) || (mat && mat.material && mat.material.ks_WmK != null ? '' : 'wrought (default)');
  if (!(kS > 0)) throw new Error('no conductivity data for ' + name);
  var fillers = thermalFillersOn();
  if (!fillers.length) throw new Error('no pore filler ticked (Configure → Thermal κ)');
  var t0 = performance.now();
  var TR = await homogenizeThermalGPU(recipe, run.N, Object.assign({}, connOpts(), {
    kS: kS, fillers: fillers, tol: THERMAL_STATE.tol, maxiter: THERMAL_STATE.maxiter, capture: false }));
  var out = { material: name, kS: kS, basis: basis, cpS: cpS, rhoS: rhoS, rhoPhi: TR.rhoPhi, wraps: TR.wraps,
              fragLoss: TR.fragLoss, underResolved: TR.fragLoss > THERMAL_FRAG_FLAG, byFiller: {}, wall_s: (performance.now() - t0) / 1000 };
  fillers.forEach(function (f) {
    var g = TR.byFiller[f.id];
    if (!g) return;
    var kMean = (g.kx + g.ky + g.kz) / 3;
    var rc = (cpS > 0 && rhoS > 0) ? TR.rhoPhi * rhoS * cpS + (1 - TR.rhoPhi) * f.rho * f.cp : null;
    out.byFiller[f.id] = { kx: g.kx, ky: g.ky, kz: g.kz, kMean: kMean, kRel: g.kRel, eff: g.eff,
      rhoc: rc, alpha: rc ? kMean / rc : null,
      iters: g.perLC.map(function (q) { return q.iters; }).join('/'), converged: g.converged };
  });
  return out;
}

function sweepNotesFor(run, r) {
  var n = [];
  if (r.vf_check != null && Math.abs(r.vf_check) > SWEEP_VF_TOL)
    n.push('build check: voxel solid ' + r.vf_voxel.toFixed(2) + ' % vs expected ' + run.expectedVf + ' % (' + (r.vf_check * 100).toFixed(1) + ' %)');
  if (r.trim_removed_pct > 0.005)
    n.push('island trim removed ' + r.trim_removed_pct.toFixed(2) + ' % of the solid (' + r.vf_voxel.toFixed(2) + ' → ' + r.vf_solved.toFixed(2) + ' % of the cell)');
  if (!r.converged) n.push('did not converge to ' + r.tol + ' in ' + r.maxiter + ' iterations per load case');
  if (r.extNote) n.push(r.extNote);
  if (r.geom && r.geom.error) n.push('geometry columns not computed: ' + r.geom.error);
  if (r.thermal && r.thermal.error) n.push('thermal not computed: ' + r.thermal.error);
  if (r.thermal && r.thermal.underResolved) n.push('thermal under-resolved: ' + Math.round(r.thermal.fragLoss * 100) + ' % of the solid in fragments under 3³ voxels — raise the grid');
  if (r.thermal && r.thermal.byFiller) {
    var nc = Object.keys(r.thermal.byFiller).filter(function (f) { return !r.thermal.byFiller[f].converged; });
    if (nc.length) n.push('thermal did not converge (' + nc.join(', ') + ')');
  }
  if (r.noLoad) n.push('no load on ' + r.noLoad.map(function (b) { return b.axis; }).join(', ') + ': ' +
    r.noLoad.map(function (b) { return 'E' + b.axis + ' reads ' + b.E.toExponential(1); }).join(', ') +
    ' ÷ E solid, i.e. zero within solver noise — kept (the solver alone would reject it)');
  if (r.C) {
    var negG = ['44', '55', '66'].filter(function (k) { return r.C['C' + k] < 0; });
    if (negG.length) {
      var dmax = Math.max(r.C.C11, r.C.C22, r.C.C33);
      n.push('negative shear stiffness ' + negG.map(function (k) { return 'C' + k + ' = ' + r.C['C' + k].toExponential(1); }).join(', ') +
        ' (' + (Math.abs(Math.min.apply(null, negG.map(function (k) { return r.C['C' + k]; }))) / dmax * 100).toFixed(2) + ' % of the largest normal term) — not physical; rerun at high precision to see whether it is tolerance');
    }
  }
  if (run.ref && run.ref.Ex != null) {
    var fl = [], src = r.ext && r.ext.Ex != null ? r.ext : r;
    ['Ex', 'Ey', 'Ez'].forEach(function (k) {
      var ref = run.ref[k];
      if (Math.abs(ref) > 1e-5) { var d = (src[k] - ref) / ref; if (Math.abs(d) > 0.05) fl.push(k + ' ' + (d * 100 > 0 ? '+' : '') + (d * 100).toFixed(0) + ' %'); }
    });
    if (fl.length) n.push('vs ' + run.ref.name + (src === r ? '' : ' (extrapolated)') + ': ' + fl.join(', '));
  }
  return n;
}

/* ── Geometry checks (worker) ─────────────────────────────── */
var SWEEP_GEOM_VERSION = 'swg-6';   /* v0.26.0 — noise kernel + anisotropic shell wall */   /* v0.23.0 — 14e geometry metrics (surface area, open pores) */
var SWEEP_THIN_VOX = 6;          /* Matt, 2026-10-01: flag under 6 voxels across the thinnest feature */
var _swWorker = null, _swJobs = {}, _swNext = 1;
function sweepGeomWorker() {
  if (_swWorker) return _swWorker;
  var base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : location.href;
  var files = ['14-rasterizer.js', '14a-connectivity.js', '13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '13d-foam-kernel.js', '14c-stl-import.js', '14d-voxel-stats.js', '14e-link-field.js'];
  var urls = files.map(function (f) { var u = new URL(f, base); u.search = '?v=' + SWEEP_GEOM_VERSION; return JSON.stringify(u.href); });
  var body = 'importScripts(' + urls.join(',') + ');\n' + SWEEP_WORKER_ONMESSAGE;
  _swWorker = new Worker(URL.createObjectURL(new Blob([body], { type: 'application/javascript' })));
  _swWorker.onmessage = function (ev) {
    var m = ev.data, j = _swJobs[m.id];
    if (!j) return;
    if (m.progress) { if (j.onProgress) j.onProgress(m.progress); return; }
    delete _swJobs[m.id];
    if (m.ok) j.resolve(m); else j.reject(new Error(m.message || 'geometry check failed'));
  };
  _swWorker.onerror = function (e) {
    for (var id in _swJobs) _swJobs[id].reject(new Error((e && e.message) || 'geometry worker failed'));
    _swJobs = {}; try { _swWorker.terminate(); } catch (x) {} _swWorker = null;
  };
  return _swWorker;
}
function sweepGeomCall(msg, onProgress) {
  return new Promise(function (resolve, reject) {
    var id = _swNext++;
    _swJobs[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
    msg.id = id;
    if (msg.recipe && msg.recipe.family === 'import' && typeof importGridMessage === 'function') msg.importGrid = importGridMessage(msg.recipe);
    sweepGeomWorker().postMessage(msg);
  });
}

/* Check every run that has no (or stale) geometry stats; untick dead runs. */
async function sweepPreviewAll() {
  if (SWEEP_STATE.previewing) return;
  var conn = (typeof GEOM_STATE !== 'undefined') ? GEOM_STATE.connectivity : 'networks';
  var todo = SWEEP_STATE.runs.filter(function (r) { var p = SWEEP_STATE.preview[r.id]; return !p || p.connectivity !== conn; });
  if (!todo.length) return;
  SWEEP_STATE.previewing = true; SWEEP_STATE.previewDone = 0; SWEEP_STATE.previewTotal = todo.length;
  sweepRender();
  for (var i = 0; i < todo.length; i++) {
    var run = todo[i];
    try {
      var m = await sweepGeomCall({ type: 'stats', recipe: sweepRecipeForRun(run), N: run.N, connectivity: conn });
      var st = m.stats; st.connectivity = conn;
      SWEEP_STATE.preview[run.id] = st;
      if (sweepFlags(run, st).some(function (f) { return f.level === 'skip'; })) SWEEP_STATE.selected[run.id] = false;
    } catch (e) {
      SWEEP_STATE.preview[run.id] = { error: e.message, connectivity: conn };
    }
    SWEEP_STATE.previewDone = i + 1;
    if (SWEEP_STATE.open) sweepRender();
  }
  SWEEP_STATE.previewing = false;
  sweepSave(); sweepRender();
}

/* Flags from the geometry check.  level 'skip' = nothing to solve (unticked
   automatically); 'warn' = solve, but read with care; 'info'. */
function sweepFlags(run, st) {
  var f = [];
  if (!st) return f;
  if (st.error) { f.push({ level: 'warn', short: 'check failed', text: 'geometry check failed: ' + st.error }); return f; }
  var pct = function (v) { return (v * 100).toFixed(v < 0.1 ? 2 : 1) + ' %'; };
  if (st.vf_raw === 0) { f.push({ level: 'skip', short: 'empty', text: 'empty cell: no solid at this setting' }); return f; }
  if (st.vf_trim === 0) { f.push({ level: 'skip', short: 'no load path', text: 'every piece is a floating island; nothing spans the cell' }); return f; }
  if (st.vf_trim >= 0.999) { f.push({ level: 'skip', short: 'fully solid', text: 'the cell is fully solid at this setting' }); return f; }
  if (!st.spans.x && !st.spans.y && !st.spans.z) { f.push({ level: 'skip', short: 'no load path', text: 'the solid spans the cell on no axis' }); return f; }
  if (!(st.spans.x && st.spans.y && st.spans.z)) {
    var ax = ['x', 'y', 'z'].filter(function (a) { return st.spans[a]; }).join(', ');
    f.push({ level: 'warn', short: 'spans ' + ax + ' only', text: 'carries load along ' + ax + ' only; stiffness on the other axes will sit near the void level (about ' + (SWEEP_STATE.voidRatio || 1e-4).toExponential(0) + ' of the solid)' });
  }
  if (st.vf_trim < 0.02) f.push({ level: 'warn', short: '< 2 % solid', text: 'very low solid fraction (' + pct(st.vf_trim) + ')' });
  if (st.vf_trim > 0.95) f.push({ level: 'warn', short: '> 95 % solid', text: 'very high solid fraction (' + pct(st.vf_trim) + ')' });
  if (st.thinVox != null && st.thinVox < SWEEP_THIN_VOX)
    f.push({ level: 'warn', short: 'thin ' + st.thinVox.toFixed(1) + ' vox', text: 'thinnest feature ≈ ' + st.thinVox.toFixed(1) + ' voxels at N = ' + run.N + ' (under ' + SWEEP_THIN_VOX + '); stiffness will read low — use a finer grid if available' });
  if (st.vf_trim < st.vf_raw - 1e-9) f.push({ level: 'info', short: 'trim ' + ((st.vf_raw - st.vf_trim) / st.vf_raw * 100).toFixed(1) + ' %', text: 'island trim removes ' + ((st.vf_raw - st.vf_trim) / st.vf_raw * 100).toFixed(2) + ' % of the solid (' + pct(st.vf_raw) + ' → ' + pct(st.vf_trim) + ')' });
  if (run.expectedVf != null) {
    var d = (st.vf_raw * 100 - run.expectedVf) / run.expectedVf;
    if (Math.abs(d) > SWEEP_VF_TOL) f.push({ level: 'warn', short: 'vf ' + (d > 0 ? '+' : '') + (d * 100).toFixed(1) + ' %', text: 'build check: voxel solid ' + (st.vf_raw * 100).toFixed(2) + ' % vs expected ' + run.expectedVf + ' %' });
  }
  return f;
}

async function sweepStart() {
  if (SWEEP_STATE.running || SWEEP_STATE.previewing) return;
  if (typeof RUN_STATE !== 'undefined' && RUN_STATE.running) { alert('A lab run is in progress. Let it finish or cancel it first.'); return; }
  var todo = SWEEP_STATE.runs.filter(function (r) { return SWEEP_STATE.selected[r.id] && !SWEEP_STATE.results[r.id]; });
  if (!todo.length) { alert('Nothing to run: select runs without results (or clear results to redo them).'); return; }
  var ok = false;
  try { ok = await ensureDevice(); } catch (e) { ok = false; }
  if (!ok) { alert('WebGPU is not available, so the sweep cannot run.'); return; }
  SWEEP_STATE.running = true; SWEEP_STATE.stopRequested = false; SWEEP_STATE.startedAt = performance.now();
  sweepRender(); sweepPaintHeaderBtn();
  for (var i = 0; i < todo.length; i++) {
    if (SWEEP_STATE.stopRequested) break;
    var run = todo[i];
    SWEEP_STATE.current = run.id; sweepRender(); sweepPaintHeaderBtn(i, todo.length);
    await new Promise(function (r) { setTimeout(r, 30); });   /* let the table paint */
    try {
      var res = await sweepRunOne(run);
      SWEEP_STATE.results[run.id] = res;
      sweepRecordTiming(run.N, res.wall_s - (res.companion ? res.companion.wall_s : 0));
      if (res.companion) sweepRecordTiming(res.companion.N, res.companion.wall_s);
      console.log('[sweep] ' + run.id + ' N=' + run.N + ' vf ' + res.vf_solved.toFixed(2) + '% Ex ' + res.Ex.toExponential(3) +
                  ' Ey ' + res.Ey.toExponential(3) + ' Ez ' + res.Ez.toExponential(3) + ' · ' + res.wall_s.toFixed(1) + ' s');
    } catch (err) {
      SWEEP_STATE.results[run.id] = { id: run.id, error: (err && err.message) || String(err), when: new Date().toISOString() };
      console.error('[sweep] ' + run.id + ' failed:', err);
    }
    sweepSave();
    if (typeof atlasOnResult === 'function') atlasOnResult();
  }
  SWEEP_STATE.running = false; SWEEP_STATE.current = null;
  sweepRender(); sweepPaintHeaderBtn();
}

/* ── Export ───────────────────────────────────────────────── */
function sweepCsvCell(v) {
  if (v == null || (typeof v === 'number' && !isFinite(v))) return '';
  if (typeof v === 'number') return Math.abs(v) >= 1e-3 || v === 0 ? +v.toPrecision(6) + '' : v.toExponential(5);
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function sweepExportCsv() {
  var cols = ['run_id', 'tier', 'set', 'purpose', 'grid_N', 'nu_s', 'cg_tol', 'cg_maxiter', 'connectivity', 'param_name', 'param_value', 'param2_name', 'param2_value',
              'expected_vf_pct', 'vf_voxel_pct', 'vf_measured_pct', 'vf_check_rel_pct', 'trim_removed_pct', 'partial_volume', 'vf_partial_pct'];
  cols.push('void_ratio');
  for (var i = 1; i <= 6; i++) for (var j = i; j <= 6; j++) cols.push('C' + i + j);
  cols = cols.concat(['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy', 'nu_xy', 'nu_xz', 'nu_yz',
    'iters_total', 'iters_xx', 'iters_yy', 'iters_zz', 'iters_yz', 'iters_xz', 'iters_xy', 'final_residual_max', 'converged', 'wall_time_s',
    'ref_Ex', 'ref_Ey', 'ref_Ez', 'ratio_Ex', 'ratio_Ey', 'ratio_Ez',
    'thinnest_feature_vox', 'median_feature_vox', 'thinnest_feature_T', 'median_feature_T', 'thinnest_feature_mm', 'median_feature_mm', 'cell_mm', 'spans', 'checks',
    'grid2_N', 'grid2_Ex', 'grid2_Ey', 'grid2_Ez', 'grid2_Gyz', 'grid2_Gxz', 'grid2_Gxy', 'grid2_iters', 'grid2_residual', 'grid2_wall_time_s',
    'grid2_vf_voxel_pct', 'grid2_vf_measured_pct', 'grid2_converged',
    'grid2_iters_xx', 'grid2_iters_yy', 'grid2_iters_zz', 'grid2_iters_yz', 'grid2_iters_xz', 'grid2_iters_xy',
    'ext_order', 'ext_from_grids']);
  for (var ie = 1; ie <= 6; ie++) for (var je = ie; je <= 6; je++) cols.push('ext_C' + ie + je);
  cols = cols.concat(['ext_Ex', 'ext_Ey', 'ext_Ez', 'ext_Gyz', 'ext_Gxz', 'ext_Gxy', 'ext_nu_xy', 'ext_nu_xz', 'ext_nu_yz',
    'ext_ratio_Ex', 'ext_ratio_Ey', 'ext_ratio_Ez', 'solver', 'gamma_build_s']);
  /* v0.23.0 — geometry columns (heat-exchanger / surrogate use) and thermal
     columns, one set per pore filler solved in this sweep */
  cols = cols.concat(['porosity', 'surface_area_density_m2m3', 'hydraulic_diameter_mm', 'open_x', 'open_y', 'open_z']);
  var thFillers = ['air', 'water', 'tissue'].filter(function (f) {
    return SWEEP_STATE.runs.some(function (run) { var r = SWEEP_STATE.results[run.id]; return r && r.thermal && r.thermal.byFiller && r.thermal.byFiller[f]; });
  });
  if (thFillers.length) {
    cols = cols.concat(['thermal_material', 'ks_WmK', 'ks_basis', 'cp_s_JkgK', 'rho_s_kgm3', 'thermal_under_resolved', 'thermal_wall_time_s']);
    thFillers.forEach(function (f) {
      ['kx_WmK', 'ky_WmK', 'kz_WmK', 'k_rel', 'k_eff_hs', 'rhoc_eff_MJm3K', 'alpha_mm2s', 'k_iters', 'k_converged'].forEach(function (c) { cols.push(c + '_' + f); });
    });
  }
  cols = cols.concat(['notes', 'error']);
  var lines = [cols.join(',')];
  SWEEP_STATE.runs.forEach(function (run) {
    var r = SWEEP_STATE.results[run.id];
    if (!r) return;
    var ref = run.ref || {};
    var row = {
      run_id: run.id, tier: run.tier, set: run.set, purpose: run.purpose, grid_N: run.N, nu_s: run.nu,
      param_name: run.param && run.param.name, param_value: run.param && run.param.value,
      param2_name: run.params && run.params[1] ? run.params[1].key : '', param2_value: run.params && run.params[1] ? run.params[1].value : '',
      expected_vf_pct: run.expectedVf, error: r.error || ''
    };
    if (!r.error) {
      row.cg_tol = r.tol; row.cg_maxiter = r.maxiter; row.connectivity = r.connectivity; row.void_ratio = r.voidRatio != null ? r.voidRatio : 1e-4;
      if (r.companion) {
        var cp = r.companion;
        row.grid2_N = cp.N; row.grid2_iters = cp.iters; row.grid2_residual = cp.residual; row.grid2_wall_time_s = cp.wall_s;
        /* v0.15.1 — the second grid's own solid fraction and per-load-case iterations */
        row.grid2_vf_voxel_pct = cp.vf_voxel; row.grid2_vf_measured_pct = cp.vf_solved; row.grid2_converged = cp.converged == null ? '' : (cp.converged ? 'yes' : 'no');
        for (var ib2 in (cp.itersBy || {})) row['grid2_' + ib2] = cp.itersBy[ib2];
        ['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy'].forEach(function (q) { row['grid2_' + q] = cp[q]; });
      }
      if (r.ext) {
        row.ext_order = r.ext.order; row.ext_from_grids = r.ext.coarseN + '+' + r.ext.fineN;
        for (var ck in r.ext.C) row['ext_' + ck] = r.ext.C[ck];
        ['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy', 'nu_xy', 'nu_xz', 'nu_yz'].forEach(function (q) { row['ext_' + q] = r.ext[q]; });
        ['Ex', 'Ey', 'Ez'].forEach(function (q) { row['ext_ratio_' + q] = (ref[q] != null && Math.abs(ref[q]) > 1e-5) ? r.ext[q] / ref[q] : null; });
      }
      row.vf_voxel_pct = r.vf_voxel; row.vf_measured_pct = r.vf_solved;
      row.partial_volume = r.partialVolume ? 'yes' : 'no'; row.vf_partial_pct = r.vf_partial;
      row.vf_check_rel_pct = r.vf_check != null ? r.vf_check * 100 : null; row.trim_removed_pct = r.trim_removed_pct;
      for (var k in r.C) row[k] = r.C[k];
      ['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy', 'nu_xy', 'nu_xz', 'nu_yz'].forEach(function (q) { row[q] = r[q]; });
      row.iters_total = r.iters;
      for (var ib in r.itersBy) row[ib] = r.itersBy[ib];
      row.final_residual_max = r.residual; row.converged = r.converged ? 'yes' : 'no'; row.wall_time_s = r.wall_s;
      row.solver = r.solver || ''; row.gamma_build_s = r.gamma_s;
      ['Ex', 'Ey', 'Ez'].forEach(function (q) {
        row['ref_' + q] = ref[q];
        row['ratio_' + q] = (ref[q] != null && Math.abs(ref[q]) > 1e-5) ? r[q] / ref[q] : null;
      });
      row.notes = (r.notes || []).join('; ');
      if (r.geom) {
        row.porosity = r.geom.porosity; row.surface_area_density_m2m3 = r.geom.sad_m2m3; row.hydraulic_diameter_mm = r.geom.dh_mm;
        if (r.geom.open) { row.open_x = r.geom.open.x ? 'yes' : 'no'; row.open_y = r.geom.open.y ? 'yes' : 'no'; row.open_z = r.geom.open.z ? 'yes' : 'no'; }
      }
      if (r.thermal && !r.thermal.error) {
        var T = r.thermal;
        row.thermal_material = T.material; row.ks_WmK = T.kS; row.ks_basis = T.basis; row.cp_s_JkgK = T.cpS; row.rho_s_kgm3 = T.rhoS;
        row.thermal_under_resolved = T.underResolved ? 'yes' : 'no'; row.thermal_wall_time_s = T.wall_s;
        for (var tf in T.byFiller) {
          var g = T.byFiller[tf];
          row['kx_WmK_' + tf] = g.kx; row['ky_WmK_' + tf] = g.ky; row['kz_WmK_' + tf] = g.kz; row['k_rel_' + tf] = g.kRel; row['k_eff_hs_' + tf] = g.eff;
          row['rhoc_eff_MJm3K_' + tf] = g.rhoc != null ? g.rhoc / 1e6 : null; row['alpha_mm2s_' + tf] = g.alpha != null ? g.alpha * 1e6 : null;
          row['k_iters_' + tf] = g.iters; row['k_converged_' + tf] = g.converged ? 'yes' : 'no';
        }
      }
    }
    var st = SWEEP_STATE.preview[run.id];
    if (st && !st.error) {
      row.thinnest_feature_vox = st.thinVox; row.median_feature_vox = st.medVox;
      /* v0.19.0 — the same features in cell units (T = fraction of the cell edge)
         and in mm at the run's cell size */
      var rc = null; try { rc = sweepRecipeForRun(run); } catch (e) { rc = null; }
      var cellMm = sweepCellMm(rc);
      row.cell_mm = cellMm;
      if (st.thinVox != null) { row.thinnest_feature_T = st.thinVox / run.N; row.thinnest_feature_mm = st.thinVox / run.N * cellMm; }
      if (st.medVox != null) { row.median_feature_T = st.medVox / run.N; row.median_feature_mm = st.medVox / run.N * cellMm; }
      row.spans = ['x', 'y', 'z'].filter(function (a) { return st.spans[a]; }).join('');
      row.checks = sweepFlags(run, st).map(function (f) { return f.text; }).join('; ');
    }
    lines.push(cols.map(function (c) { return sweepCsvCell(row[c]); }).join(','));
  });
  var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (sweepTitle() || 'sweep').replace(/\.csv$/i, '').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') + '_results.csv';
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 1000);
}

/* ── UI ───────────────────────────────────────────────────── */
function swEl(id) { return document.getElementById(id); }
function swEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function swFmt(v) { return (v == null || !isFinite(v)) ? '—' : (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : v.toPrecision(3)); }

function openSweepPanel() {
  if (SWEEP_STATE.open) return;
  var ov = document.createElement('div');
  ov.id = 'swOverlay'; ov.className = 'imp-overlay';
  ov.innerHTML =
    '<div class="imp-dialog sw-dialog" role="dialog" aria-label="Parameter sweep">' +
      '<div class="imp-head"><div class="imp-title">Parameter sweep</div><div class="sw-headbtns">' +
        '<button class="fh-action-btn ghost" onclick="sweepNew()" title="Start over: no runs, empty builder, default run settings">↺ New sweep</button>' +
        '<button class="dc-icon-btn" title="Close (a running sweep keeps going)" onclick="closeSweepPanel()">×</button></div></div>' +
      '<section class="sw-sec"><div class="sw-sec-t"><span class="sw-num">1</span>Define runs<div class="sw-tabs" id="swTabs"></div></div>' +
        '<div class="sw-build" id="swPaneBuild"><div id="swBuilder"></div></div>' +
        '<div id="swPaneCsv" hidden></div></section>' +
      '<section class="sw-sec"><div class="sw-sec-t"><span class="sw-num">2</span>Run settings</div><div class="sw-bar-row" id="swSettings"></div></section>' +
      '<section class="sw-sec"><div class="sw-sec-t"><span class="sw-num">3</span>Runs</div>' +
        '<div class="sw-bar" id="swBar"></div>' +
        '<div class="sw-table-wrap" id="swTableWrap"><table class="sw-table" id="swTable"></table></div>' +
        '<div class="sw-notes" id="swNotes"></div></section>' +
    '</div>';
  document.body.appendChild(ov);
  SWEEP_STATE.open = true;
  sweepRenderSources();
  sweepRenderBuilder();
  sweepRender();
  (SWEEP_LOADED || Promise.resolve()).then(function () { if (SWEEP_STATE.open) { SWEEP_UI.tab = null; sweepRenderSources(); sweepRenderBuilder(); sweepRender(); sweepPreviewAll(); } });
}
function closeSweepPanel() {
  var ov = swEl('swOverlay');
  if (ov) ov.parentNode.removeChild(ov);
  SWEEP_STATE.open = false;
}

function sweepPickCsv() {
  if (SWEEP_STATE.running || SWEEP_STATE.previewing) return;
  var input = document.createElement('input');
  input.type = 'file'; input.accept = '.csv,text/csv'; input.style.display = 'none';
  input.onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    document.body.removeChild(input);
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function (ev) {
      try {
        var out = sweepLoadCsvText(ev.target.result, f.name);
        sweepReplaceRuns(out.runs, out.name, 'csv');
        if (out.errors.length) alert('Loaded ' + out.runs.length + ' runs. Skipped:\n\n' + out.errors.join('\n'));
      } catch (err) { alert('Could not read this run matrix.\n\n' + err.message); }
    };
    rd.readAsText(f);
  };
  document.body.appendChild(input); input.click();
}

function sweepReplaceRuns(runs, name, source, extra) {
  var hasResults = Object.keys(SWEEP_STATE.results).length > 0;
  if (hasResults && !confirm('Replace the current sweep? Its results will be cleared (export them first if you need them).')) return false;
  SWEEP_STATE.runs = runs; SWEEP_STATE.name = name; SWEEP_STATE.source = source;
  SWEEP_STATE.title = (extra && extra.title) || sweepTitleFromName(name, source);
  SWEEP_STATE.bases = (extra && extra.bases) || {}; SWEEP_STATE.axes = (extra && extra.axes) || null;
  SWEEP_STATE.results = {}; SWEEP_STATE.selected = {}; SWEEP_STATE.preview = {};
  runs.forEach(function (r) { SWEEP_STATE.selected[r.id] = true; });
  sweepSave(); sweepRender();
  sweepPreviewAll();
  return true;
}

/* ── Builder UI (v0.11.0) ─────────────────────────────────
   Settings live in SWEEP_STATE.builder (kept across redraws and reloads).
   Two parameters; each is a range (from, to, steps) or a typed list.
   Parameter 1 can instead step by solid fraction when solid grows steadily
   with it.  Review resolves every combination and checks its geometry at
   N = 32 before anything is created. */
var SWEEP_BUILDER_FIELDS = ['design', 'p1', 'by', 'from1', 'to1', 'steps1', 'list1', 'p2', 'from2', 'to2', 'steps2', 'list2', 'N', 'nu'];
function sweepReadBuilder() {
  var b = SWEEP_STATE.builder || (SWEEP_STATE.builder = {});
  SWEEP_BUILDER_FIELDS.forEach(function (f) { var el = swEl('swb_' + f); if (el) b[f] = el.value; });
  return b;
}
function sweepBuilderChanged(redraw) {
  sweepReadBuilder(); SWEEP_STATE.review = null; sweepSave();
  if (redraw) sweepRenderBuilder(); else sweepRenderReview();
}

function sweepBuilderDesigns() {
  return LAB_STATE.designs.filter(function (d) { var r = sweepRecipeOf(d); return r && sweepParamCatalog(r).length; });
}

function sweepRenderBuilder() {
  var el = swEl('swBuilder');
  if (!el) return;
  var b = sweepReadBuilder();
  var ds = sweepBuilderDesigns();
  if (!ds.length) { el.innerHTML = '<div class="imp-note">Load a design first. Every family works: TPMS and PI-TPMS, grain, noise, beam, bundle, wave, foam and imported STL cells.</div>'; return; }
  if (!ds.some(function (d) { return d.id === b.design; })) b.design = ds[0].id;
  var d = ds.filter(function (x) { return x.id === b.design; })[0], rec = sweepRecipeOf(d);
  var cat = sweepParamCatalog(rec);
  if (!cat.some(function (c) { return c.key === b.p1; })) { b.p1 = cat[0].key; b.from1 = b.to1 = null; }
  if (b.p2 && b.p2 !== 'none' && (!cat.some(function (c) { return c.key === b.p2; }) || b.p2 === b.p1)) { b.p2 = 'none'; }
  var s1 = cat.filter(function (c) { return c.key === b.p1; })[0];
  var s2 = (b.p2 && b.p2 !== 'none') ? cat.filter(function (c) { return c.key === b.p2; })[0] : null;
  var canVf = !!s1.target, byVf = canVf && b.by === 'vf', byFeat = canVf && b.by === 'feat';
  var key1 = b.design + '|' + b.p1 + '|' + (byVf ? 'vf' : (byFeat ? 'feat' : 'v'));
  if (b.key1 !== key1 || b.from1 == null || b.from1 === '') {
    var c1 = sweepParamGet(rec, s1);
    b.from1 = byVf ? '5' : (byFeat ? '0.3' : sweepFmtVal(s1.hint ? Math.max(s1.hint[0], c1 * 0.5) : c1 * 0.5));
    b.to1 = byVf ? '40' : (byFeat ? '0.8' : sweepFmtVal(s1.hint ? Math.min(s1.hint[1], c1 === 0 ? s1.hint[1] / 2 : c1 * 1.5) : (c1 === 0 ? 0.1 : c1 * 1.5)));
    b.list1 = ''; b.key1 = key1;
    /* whole-number parameters (field B frequency): one step per integer across the hint */
    if (s1.integer && !byVf && !byFeat) { b.from1 = String(s1.hint[0]); b.to1 = String(s1.hint[1]); b.steps1 = String(s1.hint[1] - s1.hint[0] + 1); }
    /* v0.14.0 — a spec may suggest its own starting range (foam cell count, random seed) */
    if (s1.range && !byVf && !byFeat) { b.from1 = String(s1.range[0]); b.to1 = String(s1.range[1]); b.steps1 = String(s1.range[2]); }
  }
  var key2 = b.design + '|' + (b.p2 || 'none');
  if (s2 && (b.key2 !== key2 || b.from2 == null || b.from2 === '')) {
    var c2 = sweepParamGet(rec, s2);
    b.from2 = sweepFmtVal(c2); b.to2 = sweepFmtVal(c2 === 0 ? (s2.hint ? s2.hint[1] / 2 : 0.5) : c2 * 1.5); b.steps2 = b.steps2 || '3'; b.list2 = '';
    if (s2.integer) { b.from2 = String(s2.hint[0]); b.to2 = String(s2.hint[1]); b.steps2 = String(s2.hint[1] - s2.hint[0] + 1); }
    if (s2.range) { b.from2 = String(s2.range[0]); b.to2 = String(s2.range[1]); b.steps2 = String(s2.range[2]); }
  }
  b.key2 = key2;
  b.steps1 = b.steps1 || '5'; b.N = String(b.N || 64);
  b.nu = (b.nu != null && b.nu !== '') ? b.nu : String((rec.material && rec.material.nu) || 0.34);
  b.by = byVf ? 'vf' : (byFeat ? 'feat' : 'value'); b.p2 = s2 ? b.p2 : 'none';
  var unit1 = byVf ? ' %' : (byFeat ? ' mm' : '');

  function opt(c, sel) { return '<option value="' + swEsc(c.key) + '"' + (c.key === sel ? ' selected' : '') + '>' + swEsc(c.label + (c.unit ? ' (' + c.unit + ')' : '')) + '</option>'; }
  function opts(sel, exclude, withNone) {
    var cur = cat.filter(function (c) { return c.group !== 'other' && c.key !== exclude; }), oth = cat.filter(function (c) { return c.group === 'other' && c.key !== exclude; });
    return (withNone ? '<option value="none"' + (sel === 'none' ? ' selected' : '') + '>none</option>' : '') +
      cur.map(function (c) { return opt(c, sel); }).join('') +
      (oth.length ? '<optgroup label="Other numeric fields">' + oth.map(function (c) { return opt(c, sel); }).join('') + '</optgroup>' : '');
  }
  function inp(f, w, extra) { return '<input id="swb_' + f + '" style="width:' + w + 'px" value="' + swEsc(b[f] == null ? '' : b[f]) + '" onchange="sweepBuilderChanged()"' + (extra || '') + '>'; }
  var now1 = sweepParamGet(rec, s1), now2 = s2 ? sweepParamGet(rec, s2) : null;
  el.innerHTML =
    '<div class="imp-settings"><label>Design <select id="swb_design" onchange="sweepBuilderChanged(true)">' + ds.map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === b.design ? ' selected' : '') + '>' + swEsc(x.label.split('·').pop().trim() + ' · ' + x.title) + '</option>'; }).join('') + '</select></label>' +
      '<span class="imp-sub">' + swEsc(rec.family) + (rec.geometry && rec.geometry.mode ? ' · ' + swEsc(rec.geometry.mode) : '') + '</span></div>' +
    '<div class="sw-prow"><span class="sw-pn">1</span>' +
      '<select id="swb_p1" onchange="sweepBuilderChanged(true)">' + opts(b.p1, null, false) + '</select>' +
      (canVf ? '<select id="swb_by" onchange="sweepBuilderChanged(true)"><option value="value"' + (byVf || byFeat ? '' : ' selected') + '>by value</option><option value="vf"' + (byVf ? ' selected' : '') + '>by solid fraction</option><option value="feat"' + (byFeat ? ' selected' : '') + '>by thinnest feature</option></select>' : '<input type="hidden" id="swb_by" value="value">') +
      '<label>from ' + inp('from1', 66) + unit1 + '</label><label>to ' + inp('to1', 66) + unit1 + '</label><label>steps ' + inp('steps1', 44) + '</label>' +
      (byVf ? '<input type="hidden" id="swb_list1" value="">' : (byFeat ? '<label>or sizes ' + inp('list1', 120, ' placeholder="e.g. 0.3, 0.4, 0.5"') + ' mm</label>' : '<label>or values ' + inp('list1', 120, ' placeholder="e.g. 0.05, 0.1, 0.2"') + '</label>')) +
      '<span class="imp-sub">' + (byVf ? (s1.target === 'threshold' ? 'exact at the grid' : 'found by bisection') :
        (byFeat ? 'found by bisection at the run grid, to the nearest quarter voxel · cell ' + sweepFmtVal(sweepCellMm(rec)) + ' mm' : 'now ' + sweepFmtVal(now1))) + '</span></div>' +
    '<div class="sw-prow"><span class="sw-pn">2</span>' +
      '<select id="swb_p2" onchange="sweepBuilderChanged(true)">' + opts(b.p2, b.p1, true) + '</select>' +
      (s2 ? '<label>from ' + inp('from2', 66) + '</label><label>to ' + inp('to2', 66) + '</label><label>steps ' + inp('steps2', 44) + '</label>' +
            '<label>or values ' + inp('list2', 120, ' placeholder="e.g. 0, 1/8, 1/4"') + '</label><span class="imp-sub">now ' + sweepFmtVal(now2) + '</span>'
          : '<span class="imp-sub">optional second parameter</span>') + '</div>' +
    '<div class="imp-settings"><label>Grid <select id="swb_N" onchange="sweepBuilderChanged()">' + ['32', '64', '128'].map(function (n) {
        return '<option' + (n === b.N ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label>Poisson’s ratio ' + inp('nu', 64) + '</label>' +
      '<button class="fh-action-btn" onclick="sweepReview()">Review</button></div>' +
    '<div id="swReview"></div>';
  sweepRenderReview();
}

/* Plan from the builder fields (throws with a plain message when incomplete). */
function sweepPlan() {
  var b = sweepReadBuilder();
  var d = LAB_STATE.designs.filter(function (x) { return x.id === b.design; })[0];
  if (!d) throw new Error('pick a design');
  var base = sweepClone(sweepRecipeOf(d)), cat = sweepParamCatalog(base);
  var s1 = cat.filter(function (c) { return c.key === b.p1; })[0];
  var s2 = (b.p2 && b.p2 !== 'none') ? cat.filter(function (c) { return c.key === b.p2; })[0] : null;
  var byVf = b.by === 'vf' && s1.target, byFeat = b.by === 'feat' && s1.target;
  var nu = parseFloat(b.nu), N = parseInt(b.N, 10);
  if (!(nu >= 0 && nu < 0.5)) throw new Error('Poisson’s ratio must be between 0 and 0.5');
  var v1 = null, targets = null, featTargets = null, cellMm = sweepCellMm(base);
  if (byVf) {
    var lo = parseFloat(b.from1), hi = parseFloat(b.to1), st = parseInt(b.steps1, 10);
    if (!(lo >= 0 && lo <= 100 && hi >= 0 && hi <= 100 && st >= 1)) throw new Error('solid fractions are percentages from 0 to 100, with at least one step');
    targets = sweepValues({ from: lo / 100, to: hi / 100, steps: st });
  } else if (byFeat) {
    featTargets = sweepValues({ from: b.from1, to: b.to1, steps: b.steps1, list: b.list1 });
    if (featTargets.some(function (t) { return !(t > 0) || t >= cellMm; })) throw new Error('feature sizes are in mm, above 0 and smaller than the ' + sweepFmtVal(cellMm) + ' mm cell');
  } else v1 = sweepValues({ from: b.from1, to: b.to1, steps: b.steps1, list: b.list1 });
  var v2 = s2 ? sweepValues({ from: b.from2, to: b.to2, steps: b.steps2, list: b.list2 }) : null;
  return { design: d, title: d.title, base: base, spec1: s1, spec2: s2, byVf: !!byVf, byFeat: !!byFeat, values1: v1, targets: targets,
           featTargets: featTargets, cellMm: cellMm, values2: v2,
           n1: byVf ? targets.length : (byFeat ? featTargets.length : v1.length), n2: s2 ? v2.length : 1, N: N, nu: nu };
}

/* Review: resolve values + quick geometry check at N = 32, in the worker. */
async function sweepReview() {
  if (SWEEP_STATE.running || (SWEEP_STATE.review && SWEEP_STATE.review.busy)) return;
  var plan;
  try { plan = sweepPlan(); } catch (e) { SWEEP_STATE.review = { error: e.message }; sweepRenderReview(); return; }
  var conn = (typeof GEOM_STATE !== 'undefined') ? GEOM_STATE.connectivity : 'networks';
  var rv = SWEEP_STATE.review = { plan: plan, busy: true, done: 0, total: plan.n1 * plan.n2, combos: [], stage: 'checking' };
  sweepRenderReview();
  try {
    var m = await sweepGeomCall({ type: 'review', recipe: plan.base, spec1: plan.spec1, spec2: plan.spec2, values1: plan.values1,
      values2: plan.values2, byVf: plan.byVf, targets: plan.targets, N: plan.N, checkN: 32, connectivity: conn,
      byFeat: plan.byFeat, featTargets: plan.featTargets,
      featTargetsVox: plan.byFeat ? plan.featTargets.map(function (t) { return t / plan.cellMm * plan.N; }) : null },
      function (p) { if (SWEEP_STATE.review !== rv) return; rv.done = p.done; rv.stage = p.stage; if (p.combo) rv.combos.push(p.combo); sweepRenderReviewSoon(); });
    if (SWEEP_STATE.review !== rv) return;
    rv.combos = m.combos; rv.busy = false;
  } catch (e) { rv.busy = false; rv.error = e.message; }
  sweepRenderReview();
}
var _swRevT = 0;
function sweepRenderReviewSoon() { if (_swRevT) return; _swRevT = setTimeout(function () { _swRevT = 0; sweepRenderReview(); }, 120); }

function sweepComboSkip(c) {
  if (c.unreachable) return 'target out of reach';
  if (c.error) return 'check failed';
  var st = c.stats;
  if (!st) return null;
  if (st.vf_raw === 0) return 'empty';
  if (st.vf_trim >= 0.999) return 'fully solid';
  if (!st.spans.x && !st.spans.y && !st.spans.z) return 'no load path';
  return null;
}

function sweepRenderReview() {
  var el = swEl('swReview');
  if (!el) return;
  var rv = SWEEP_STATE.review;
  if (!rv) { el.innerHTML = ''; return; }
  if (rv.error) { el.innerHTML = '<div class="imp-error" style="display:block">' + swEsc(rv.error) + '</div>'; return; }
  var plan = rv.plan, nRuns = plan.n1 * plan.n2, N2 = sweepCompanionN(plan.N, SWEEP_STATE.refine);
  var solves = nRuns * (N2 ? 2 : 1);
  var fakeRuns = []; for (var q = 0; q < nRuns; q++) fakeRuns.push({ N: plan.N });
  var eta = sweepEta(fakeRuns);
  var combos = rv.combos || [], skipped = 0, thin = 0, vmin = Infinity, vmax = -Infinity, partial = 0;
  combos.forEach(function (c) {
    if (sweepComboSkip(c)) { skipped++; return; }
    var st = c.stats; if (!st) return;
    vmin = Math.min(vmin, st.vf_trim); vmax = Math.max(vmax, st.vf_trim);
    if (st.thinVox != null && st.thinVox * plan.N / 32 < SWEEP_THIN_VOX) thin++;
    if (!(st.spans.x && st.spans.y && st.spans.z)) partial++;
  });
  var kv = function (n, l) { return '<div class="sw-kv"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>'; };
  var hw = sweepHardwareNote(plan.N);
  var store = sweepStorageEstimate(nRuns, plan);
  var h = '<div class="sw-review">' +
    '<div class="sw-kvs">' +
      kv(nRuns.toLocaleString(), 'runs' + (plan.spec2 ? ' (' + plan.n1 + ' × ' + plan.n2 + ')' : '')) +
      kv(solves.toLocaleString(), 'solves' + (N2 ? ' (N = ' + plan.N + ' and ' + N2 + ')' : ' at N = ' + plan.N)) +
      kv('≈ ' + sweepFmtDur(eta), sweepHasTiming() ? 'at this machine’s measured speed' : 'estimate (no runs timed yet)') +
      kv(isFinite(vmin) ? (vmin * 100).toFixed(1) + '–' + (vmax * 100).toFixed(1) + ' %' : (rv.busy ? '…' : '—'), 'solid fraction (N = 32 check)') +
    '</div>';
  if (rv.busy) h += '<div class="imp-progress" style="display:flex"><div class="imp-bar"><div style="height:100%;background:var(--lab);width:' +
      Math.round(100 * rv.done / Math.max(1, rv.total)) + '%"></div></div><span>' + (rv.stage === 'targeting' ? 'Finding values for each solid fraction… ' : 'Checking geometry ') + rv.done + ' / ' + rv.total + '</span></div>';
  h += sweepReviewMap(plan, combos);
  var notes = [];
  if (!rv.busy) {
    if (skipped) notes.push(skipped + ' run' + (skipped === 1 ? '' : 's') + ' will be skipped (empty, fully solid, no load path or target out of reach) — shown hatched');
    if (partial) notes.push(partial + ' carry load on only some axes');
    if (thin) {
      var fake128 = fakeRuns.map(function () { return { N: 128 }; });
      var up = plan.N < 128 ? ' — the whole sweep at N = 128 would take about ' + sweepFmtDur(sweepEta(fake128)) : '';
      notes.push(thin + ' would have features thinner than ' + SWEEP_THIN_VOX + ' voxels at N = ' + plan.N + up);
    }
  }
  if (hw) notes.push(hw);
  notes.push(store);
  h += '<div class="imp-sub sw-rnotes">' + notes.map(swEsc).join('<br>') + '</div>';
  h += '<div class="sw-rfoot"><button class="fh-action-btn ghost" onclick="SWEEP_STATE.review=null;sweepRenderReview()">Back</button>' +
       '<button class="fh-action-btn" onclick="sweepCommitReview()"' + (rv.busy ? ' disabled' : '') + '>Create ' + (nRuns - skipped).toLocaleString() + ' runs' + (skipped ? ' (+' + skipped + ' skipped)' : '') + '</button></div>';
  el.innerHTML = h + '</div>';
}

/* Parameter-1 × parameter-2 map of solid fraction at the N = 32 check. */
function sweepReviewMap(plan, combos) {
  var n1 = plan.n1, n2 = plan.n2;
  if (n1 * n2 > 2500) return '<div class="imp-sub">' + (n1 * n2).toLocaleString() + ' runs — too many to draw the map</div>';
  var byKey = {};
  combos.forEach(function (c) { byKey[c.i + ',' + c.j] = c; });
  var lab1 = plan.byVf ? plan.targets.map(function (t) { return (t * 100).toFixed(1) + '%'; })
           : (plan.byFeat ? plan.featTargets.map(function (t) { return sweepFmtVal(t) + ' mm'; }) : plan.values1.map(sweepFmtVal));
  var lab2 = plan.spec2 ? plan.values2.map(sweepFmtVal) : [''];
  var cw = Math.max(10, Math.min(40, Math.floor(560 / n1)));
  var h = '<div class="sw-map"><div class="sw-map-ax imp-sub">' + swEsc(plan.spec1.label) + (plan.byVf ? ' (by solid fraction)' : (plan.byFeat ? ' (by thinnest feature)' : '')) + ' →' +
          (plan.spec2 ? ' · rows: ' + swEsc(plan.spec2.label) : '') + '</div><table class="sw-mtab"><tr><th></th>';
  var every = Math.ceil(n1 / Math.floor(560 / 44));
  for (var i = 0; i < n1; i++) h += '<th style="width:' + cw + 'px">' + (i % every === 0 ? swEsc(lab1[i]) : '') + '</th>';
  h += '</tr>';
  for (var j = 0; j < n2; j++) {
    h += '<tr><th>' + swEsc(lab2[j]) + '</th>';
    for (var i2 = 0; i2 < n1; i2++) {
      var c = byKey[i2 + ',' + j], skip = c ? sweepComboSkip(c) : null, st = c && c.stats, bg = 'transparent', cls = '', tip = '';
      if (c && skip) { cls = 'skip'; tip = skip; }
      else if (st) { bg = sweepSeqColor(st.vf_trim); tip = (st.vf_trim * 100).toFixed(1) + ' % solid' + (st.thinVox != null ? ' · thinnest ≈ ' + (st.thinVox * plan.N / 32).toFixed(1) + ' vox at N = ' + plan.N : '') +
        (!(st.spans.x && st.spans.y && st.spans.z) ? ' · spans ' + ['x', 'y', 'z'].filter(function (a) { return st.spans[a]; }).join('') + ' only' : ''); }
      if (c) tip = sweepFmtVal(c.v1) + (plan.spec2 ? ', ' + sweepFmtVal(c.v2) : '') + ' — ' + tip;
      if (c && c.featVox != null) tip += ' · thinnest ' + sweepFmtVal(c.featVox / plan.N * plan.cellMm) + ' mm at N = ' + plan.N;
      h += '<td class="' + cls + '" style="background:' + bg + '" title="' + swEsc(tip) + '"></td>';
    }
    h += '</tr>';
  }
  return h + '</table><div class="sw-legend imp-sub"><span class="sw-ramp"></span> solid fraction 0 → 60 %+ <span class="sw-hatch"></span> skipped</div></div>';
}
function sweepSeqColor(v) {
  /* F13LD ramp: deep slate → brand green → neon */
  var stops = [[0, [20, 28, 36]], [0.15, [16, 84, 66]], [0.35, [29, 158, 117]], [0.6, [200, 245, 66]]];
  v = Math.max(0, Math.min(0.6, v));
  for (var k = 1; k < stops.length; k++) if (v <= stops[k][0]) {
    var a = stops[k - 1], b = stops[k], f = (v - a[0]) / (b[0] - a[0]);
    return 'rgb(' + a[1].map(function (x, i) { return Math.round(x + (b[1][i] - x) * f); }).join(',') + ')';
  }
  return 'rgb(200,245,66)';
}


/* Hardware limits: no run-count cap; warn when the grid exceeds what the
   detected GPU tier handles, refuse when there is no WebGPU at all. */
function sweepHardwareNote(N) {
  if (typeof HW === 'undefined') return null;
  if (HW.webgpu_available === false) return 'WebGPU is not available in this browser, so the sweep can’t run here.';
  var maxN = (typeof autoPickGrid === 'function') ? autoPickGrid() : 128;
  if (N > maxN) return 'This GPU is rated for N = ' + maxN + ' (' + (HW.tier || 'unknown') + ' tier); N = ' + N + ' may run out of GPU memory or be slow.';
  return null;
}
function sweepStorageEstimate(nRuns, plan) {
  var perRun = 3.5 + (SWEEP_STATE.refine !== 'off' ? 2.5 : 0) + 0.4;   /* kB: result + second grid + geometry check */
  var base = JSON.stringify(plan.base).length / 1024;
  var total = nRuns * perRun + base;
  return 'Saved in this browser: about ' + (total < 1024 ? Math.round(total) + ' kB' : (total / 1024).toFixed(1) + ' MB') + ' for the results' +
         (sweepStoreQuota ? ' (' + sweepStoreQuota + ' free)' : '');
}
var sweepStoreQuota = null;
if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
  navigator.storage.estimate().then(function (e) { if (e && e.quota) { var f = (e.quota - (e.usage || 0)) / 1048576; sweepStoreQuota = f > 1024 ? (f / 1024).toFixed(0) + ' GB' : Math.round(f) + ' MB'; } }).catch(function () {});
}

function sweepCommitReview() {
  var rv = SWEEP_STATE.review;
  if (!rv || rv.busy || !rv.combos) return;
  var runs = sweepRunsFromCombos(rv.plan, rv.combos);
  var skipIds = {};
  rv.combos.forEach(function (c) {
    if (!c.unreachable && sweepComboSkip(c)) {
      var w = String(Math.max(rv.plan.n1, rv.plan.n2 || 1)).length;
      skipIds['S' + String(c.i + 1).padStart(w, '0') + (rv.plan.spec2 ? '-' + String(c.j + 1).padStart(w, '0') : '')] = true;
    }
  });
  var axes = [{ key: rv.plan.spec1.key, label: rv.plan.spec1.label, unit: rv.plan.spec1.unit, byVf: rv.plan.byVf, byFeat: rv.plan.byFeat,
                values: rv.plan.byVf ? rv.plan.targets.map(function (t) { return t * 100; }) : (rv.plan.byFeat ? rv.plan.featTargets : rv.plan.values1) }];
  if (rv.plan.spec2) axes.push({ key: rv.plan.spec2.key, label: rv.plan.spec2.label, unit: rv.plan.spec2.unit, values: rv.plan.values2 });
  var name = (rv.plan.title + '_' + rv.plan.spec1.label + (rv.plan.spec2 ? '_x_' + rv.plan.spec2.label : '')).replace(/[^\w.-]+/g, '_');
  var title = rv.plan.title + ' · ' + rv.plan.spec1.label + (rv.plan.spec2 ? ' × ' + rv.plan.spec2.label : '');
  if (!sweepReplaceRuns(runs, name, 'builder', { bases: { b0: rv.plan.base }, axes: axes, title: title })) return;
  runs.forEach(function (r) { if (skipIds[r.id]) SWEEP_STATE.selected[r.id] = false; });
  SWEEP_STATE.review = null;
  sweepSave(); sweepRenderBuilder(); sweepRender();
}

function sweepSelect(mode) {
  if (SWEEP_STATE.running) return;
  SWEEP_STATE.runs.forEach(function (r) {
    var v;
    if (mode === 'all') v = true;
    else if (mode === 'none') v = false;
    else if (mode === 'pending') v = !SWEEP_STATE.results[r.id];
    else v = String(r.tier) === String(mode);
    SWEEP_STATE.selected[r.id] = v;
  });
  sweepSave(); sweepRender();
}
function sweepToggle(id, on) { SWEEP_STATE.selected[id] = !!on; sweepSave(); sweepRenderBar(); }
function sweepClearResults(onlySelected) {
  if (SWEEP_STATE.running) return;
  if (!confirm(onlySelected ? 'Clear the results of the selected runs so they run again?' : 'Clear all results?')) return;
  SWEEP_STATE.runs.forEach(function (r) { if (!onlySelected || SWEEP_STATE.selected[r.id]) delete SWEEP_STATE.results[r.id]; });
  sweepSave(); sweepRender();
}
function sweepSetOpt(k, v) { if (!SWEEP_STATE.running) { SWEEP_STATE[k] = v; sweepSave(); sweepRenderBar(); sweepRender(); } }
function sweepSetPrecision(v) { if (!SWEEP_STATE.running) { SWEEP_STATE.precision = v; sweepSave(); sweepRenderBar(); } }

/* Seconds per solve by grid on this machine: a running average kept across
   sweeps (SWEEP_STATE.timing, saved), else defaults from a mid-range desktop
   GPU (Matt's 2026-10-01 run: ~2 s at N = 32/64, ~19 s at 128). */
var SWEEP_TIME_GUESS = { 32: 2, 64: 3, 128: 20 };
function sweepRecordTiming(N, sec) {
  if (!(sec > 0)) return;
  var t = SWEEP_STATE.timing || (SWEEP_STATE.timing = {}), e = t[N] || (t[N] = { n: 0, mean: 0 });
  e.n = Math.min(e.n + 1, 50); e.mean += (sec - e.mean) / e.n;   /* running mean, recent-weighted after 50 */
}
function sweepSecPerSolve(N) {
  var t = SWEEP_STATE.timing && SWEEP_STATE.timing[N];
  var hi = SWEEP_STATE.precision === 'high' ? 1.6 : 1;
  if (t && t.n) return t.mean * hi;
  return (SWEEP_TIME_GUESS[N] || 20) * hi;
}
function sweepHasTiming() { var t = SWEEP_STATE.timing || {}; return Object.keys(t).some(function (k) { return t[k] && t[k].n; }); }
function sweepEta(todoRuns) {
  return todoRuns.reduce(function (s, run) {
    var N2 = sweepCompanionN(run.N, SWEEP_STATE.refine);
    return s + sweepSecPerSolve(run.N) + (N2 ? sweepSecPerSolve(N2) : 0) + sweepThermalSec(run.N);
  }, 0);
}
/* v0.23.0 — thermal seconds per run: measured per-filler time (RUN_CALIB) or the default, × ticked fillers */
function sweepThermalSec(N) {
  if (SWEEP_STATE.physics !== 'thermal' || typeof thermalFillersOn !== 'function' || typeof gridScale !== 'function') return 0;
  var cal = (typeof RUN_CALIB !== 'undefined') ? RUN_CALIB.thermal : null, ref = (typeof RUN_REF !== 'undefined') ? RUN_REF.thermal : null;
  var per = cal ? cal.sec * gridScale(N, cal.N) : (ref ? ref.sec * gridScale(N, ref.refN) : 1);
  return per * Math.max(1, thermalFillersOn().length);
}
function sweepFmtDur(s) { return s < 90 ? Math.round(s) + ' s' : (s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'); }

function sweepRenderBar() {
  sweepRenderSettings();
  sweepRenderSources();
  var el = swEl('swBar');
  if (!el) return;
  var runs = SWEEP_STATE.runs, nSel = 0, nDone = 0, nTodo = [], tiers = {};
  runs.forEach(function (r) {
    if (r.tier) tiers[r.tier] = true;
    if (SWEEP_STATE.results[r.id]) nDone++;
    if (SWEEP_STATE.selected[r.id]) { nSel++; if (!SWEEP_STATE.results[r.id]) nTodo.push(r); }
  });
  var wrap = swEl('swTableWrap'); if (wrap) wrap.hidden = !runs.length;
  if (!runs.length) { el.innerHTML = '<div class="sw-empty">No runs yet. Build a sweep from a design or load a CSV run matrix above.</div>'; return; }
  var tierBtns = Object.keys(tiers).sort().map(function (t) { return '<a href="#" onclick="sweepSelect(\'' + t + '\');return false;">tier ' + t + '</a>'; }).join(' · ');
  el.innerHTML =
    '<div class="sw-bar-row sw-runs-head"><div class="sw-title-blk"><div class="sw-title"><span>' + swEsc(sweepTitle()) + '</span>' +
        '<button class="sw-rename" onclick="sweepRename()"' + (SWEEP_STATE.running ? ' disabled' : '') + ' title="Rename this study (also names the exported CSV)">✎ rename</button></div>' +
      '<div class="imp-sub">' + runs.length + ' runs · ' + nDone + ' done · ' + nSel + ' selected' +
      '<span class="sw-sel"> &nbsp;Select: <a href="#" onclick="sweepSelect(\'all\');return false;">all</a>' + (tierBtns ? ' · ' + tierBtns : '') +
      ' · <a href="#" onclick="sweepSelect(\'pending\');return false;">not run</a> · <a href="#" onclick="sweepSelect(\'none\');return false;">none</a></span>' +
      (SWEEP_STATE.previewing ? ' · <span class="sw-checking">checking geometry ' + SWEEP_STATE.previewDone + ' / ' + SWEEP_STATE.previewTotal + '…</span>' : '') + '</div></div>' +
      '<span class="sw-spacer"></span><div class="sw-actions">' +
      '<button class="fh-action-btn ghost" onclick="openSweepAtlas()"' + (nDone ? '' : ' disabled') + ' title="Explore the results: geometry, stiffness surface, parameter map and charts">◈ Atlas</button>' +
      (SWEEP_STATE.running
        ? '<span class="imp-sub">Running ' + swEsc(SWEEP_STATE.current || '') + ' · ~' + sweepFmtDur(sweepEta(nTodo)) + ' left</span>' +
          '<button class="fh-action-btn ghost" onclick="SWEEP_STATE.stopRequested=true;this.disabled=true;this.textContent=\'Stopping after this run…\'">Stop</button>'
        : '<button class="fh-action-btn ghost" onclick="sweepClearResults(true)" title="Delete the results of the ticked runs so they run again; the runs stay in the list">Clear results of selected</button>' +
          '<button class="fh-action-btn ghost" onclick="sweepExportCsv()"' + (nDone ? '' : ' disabled') + '>Export CSV</button>' +
          (nTodo.length ? '<span class="imp-sub">' + nTodo.length + ' to run · ~' + sweepFmtDur(sweepEta(nTodo)) + '</span>' : '') +
          '<button class="fh-action-btn" onclick="sweepStart()"' + (nTodo.length && !SWEEP_STATE.previewing ? '' : ' disabled') + '>▶ Run ' + nTodo.length + '</button>') +
    '</div></div>';
}
/* Run settings: precision, void, second grid (v0.12.1: its own section). */
function sweepRenderSettings() {
  var el = swEl('swSettings');
  if (!el) return;
  var dis = SWEEP_STATE.running ? ' disabled' : '';
  var conn = (typeof GEOM_STATE !== 'undefined') ? GEOM_STATE.connectivity : 'networks';
  var connTxt = { networks: 'all networks · islands removed', largest: 'largest network only', off: 'keep everything' }[conn] || conn;
  var thFill = (typeof thermalFillersOn === 'function') ? thermalFillersOn().map(function (f) { return f.id; }).join(', ') : '';
  el.innerHTML =
    '<label class="imp-sub" title="Stiffness + thermal also solves thermal conductivity for every run, with the material and pore fillers set in Configure (Model, Thermal κ). About 1–3 s per filler at 64³.">Physics <select onchange="sweepSetOpt(\'physics\', this.value)"' + dis + '>' +
      '<option value="stiffness"' + (SWEEP_STATE.physics !== 'thermal' ? ' selected' : '') + '>stiffness</option>' +
      '<option value="thermal"' + (SWEEP_STATE.physics === 'thermal' ? ' selected' : '') + '>stiffness + thermal' + (thFill ? ' (' + thFill + ')' : '') + '</option></select></label>' +
    '<label class="imp-sub">Precision <select id="swPrec" onchange="sweepSetPrecision(this.value)"' + dis + '>' +
      Object.keys(SWEEP_PRECISION).map(function (k) { return '<option value="' + k + '"' + (k === SWEEP_STATE.precision ? ' selected' : '') + '>' + SWEEP_PRECISION[k].label + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="imp-sub" title="Stiffness given to empty space, as a fraction of the solid. 1e-4 is the lab default for normal runs; it inflates low-density lattices.">Void <select onchange="sweepSetOpt(\'voidRatio\', +this.value)"' + dis + '>' +
      SWEEP_VOID_OPTIONS.map(function (v) { return '<option value="' + v + '"' + (v === SWEEP_STATE.voidRatio ? ' selected' : '') + '>' + v.toExponential(0) + '</option>'; }).join('') + '</select></label>' +
    '<label class="imp-sub" title="Also solve each run on a second grid and extrapolate to an infinitely fine grid. 64 ↔ 128 pair: every run uses grids 64 and 128 (32 pairs with 64), one basis for a whole matrix.">Second grid <select onchange="sweepSetOpt(\'refine\', this.value)"' + dis + '>' +
      [['off', 'off'], ['coarser', 'one coarser'], ['finer', 'one finer'], ['pair', '64 ↔ 128 pair']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === SWEEP_STATE.refine ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    (SWEEP_STATE.refine !== 'off' ? '<label class="imp-sub" title="Assumed convergence order. The F set measured about 2 for PI-gyroid Ex and Ey, 1.4 for Ez and 1.2 for the sheet gyroid.">order <select onchange="sweepSetOpt(\'order\', +this.value)"' + dis + '>' +
      [1, 2].map(function (o) { return '<option' + (o === SWEEP_STATE.order ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>' : '') +
    '<label class="imp-sub" title="Partial volume (default): voxels the surface passes through carry their solid fraction — exact solid fraction, stiffness grid-converged by N = 64. 0/1 cube: the behaviour before v0.19.0; use it to reproduce earlier results such as the PI-TPMS paper.">Surface voxels <select onchange="sweepSetOpt(\'partialVolume\', this.value === \'pv\')"' + dis + '>' +
      '<option value="pv"' + (SWEEP_STATE.partialVolume === true ? ' selected' : '') + '>partial volume</option><option value="binary"' + (SWEEP_STATE.partialVolume !== true ? ' selected' : '') + '>0/1 cube (before v0.19.0)</option></select></label>' +
    '<span class="imp-sub" title="Set by the Connectivity selector in the run controls">Islands: ' + connTxt + '</span>' +
    '<span class="imp-sub">Stiffness ÷ solid modulus</span>';
}
/* Define runs: builder or CSV, as two tabs (v0.12.1). */
function sweepRenderSources() {
  var tabs = swEl('swTabs'), pb = swEl('swPaneBuild'), pc = swEl('swPaneCsv');
  if (!tabs || !pb || !pc) return;
  if (!SWEEP_UI.tab) SWEEP_UI.tab = SWEEP_STATE.source === 'csv' ? 'csv' : 'build';
  var t = SWEEP_UI.tab, dis = (SWEEP_STATE.running || SWEEP_STATE.previewing) ? ' disabled' : '';
  tabs.innerHTML = '<button aria-pressed="' + (t === 'build') + '" onclick="sweepTab(\'build\')">Build from a design</button>' +
                   '<button aria-pressed="' + (t === 'csv') + '" onclick="sweepTab(\'csv\')">Load a CSV run matrix</button>';
  pb.hidden = t !== 'build'; pc.hidden = t !== 'csv';
  if (t !== 'csv') return;
  var isCsv = SWEEP_STATE.source === 'csv' && SWEEP_STATE.runs.length;
  pc.innerHTML = '<div class="sw-csvrow">' +
    (isCsv
      ? '<span class="sw-file">' + swEsc(SWEEP_STATE.name) + ' · ' + SWEEP_STATE.runs.length + ' runs <button class="sw-x" onclick="sweepRemoveRuns()"' + dis + ' title="Remove this run list (asks first if there are results)">✕ remove</button></span>' +
        '<button class="fh-action-btn ghost" onclick="sweepPickCsv()"' + dis + '>Replace CSV…</button>'
      : '<button class="fh-action-btn" onclick="sweepPickCsv()"' + dis + '>Load CSV…</button>' +
        (SWEEP_STATE.runs.length ? '<span class="imp-sub">Loading a CSV replaces the current builder runs.</span>' : '')) +
    '<span class="imp-sub">Columns read: run_id, surface, mode, shift, wall_ratio, level_c, grid_N, nu_s, expected_vf_pct (optional reference stiffness, tier, set, purpose)</span></div>';
}
function sweepTab(t) { SWEEP_UI.tab = t; sweepRenderSources(); if (t === 'build') sweepRenderBuilder(); }
function sweepTitleFromName(name, source) {
  if (!name) return '';
  if (source === 'csv') return name.replace(/\.csv$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return name.replace(/_x_/g, ' × ').replace(/_+/g, ' ').trim();
}
function sweepTitle() { return SWEEP_STATE.title || sweepTitleFromName(SWEEP_STATE.name, SWEEP_STATE.source) || 'Untitled sweep'; }
function sweepRename() {
  if (SWEEP_STATE.running) return;
  var t = prompt('Name this study (also used for the exported CSV):', sweepTitle());
  if (t == null) return;
  t = t.trim(); if (!t) return;
  SWEEP_STATE.title = t; sweepSave(); sweepRenderBar();
}
/* Remove the run list (and its results), keep the run settings. */
function sweepRemoveRuns() {
  if (SWEEP_STATE.running || SWEEP_STATE.previewing) return;
  var hasRes = Object.keys(SWEEP_STATE.results).length > 0;
  if (!confirm(hasRes ? 'Remove this run list and its results? Export them first if you need them.' : 'Remove this run list?')) return;
  sweepResetRuns();
  sweepSave(); sweepRender();
}
function sweepResetRuns() {
  if (typeof closeSweepAtlas === 'function' && typeof ATLAS !== 'undefined' && ATLAS.open) closeSweepAtlas();
  SWEEP_STATE.runs = []; SWEEP_STATE.results = {}; SWEEP_STATE.selected = {}; SWEEP_STATE.preview = {};
  SWEEP_STATE.bases = {}; SWEEP_STATE.axes = null; SWEEP_STATE.review = null;
  SWEEP_STATE.name = ''; SWEEP_STATE.title = ''; SWEEP_STATE.source = null;
}
/* ↺ New sweep: everything back to defaults (the machine's measured solve speeds are kept). */
function sweepNew() {
  if (SWEEP_STATE.running || SWEEP_STATE.previewing) { alert('Stop the sweep (or wait for the geometry check) first.'); return; }
  var hasRes = Object.keys(SWEEP_STATE.results).length > 0;
  if (!confirm('Start a new sweep? This clears the run list' + (hasRes ? ' and its results (export them first if you need them)' : '') + ', the builder and the run settings.')) return;
  sweepResetRuns();
  SWEEP_STATE.builder = {}; SWEEP_STATE.precision = 'standard'; SWEEP_STATE.voidRatio = 1e-6; SWEEP_STATE.refine = 'off'; SWEEP_STATE.order = 2; SWEEP_STATE.partialVolume = true;
  SWEEP_UI.tab = 'build'; SWEEP_UI.notesOpen = false;
  sweepSave(); sweepRenderSources(); sweepRenderBuilder(); sweepRender();
}
var SWEEP_UI = { notesOpen: false, tab: null };
function sweepRender() {
  sweepRenderBar();
  var tb = swEl('swTable'), notes = swEl('swNotes');
  if (!tb) return;
  var showRef = SWEEP_STATE.runs.some(function (r) { return r.ref && r.ref.Ex != null; });
  var showExp = SWEEP_STATE.runs.some(function (r) { return r.expectedVf != null; });
  var h = '<thead><tr><th></th><th>Run</th><th>Setting</th><th>N</th><th>ν</th>' +
    (showExp ? '<th>Expected %</th>' : '') + '<th>Solid %</th><th>Ex</th><th>Ey</th><th>Ez</th><th>Gyz</th><th>Gxz</th><th>Gxy</th>' +
    (showRef ? '<th title="Ex, Ey, Ez ÷ reference">÷ ref</th>' : '') +
    '<th>Iter.</th><th>Resid.</th><th>Time</th><th class="fl">Checks</th></tr></thead><tbody>';
  var allNotes = [], noteRuns = {};
  SWEEP_STATE.runs.forEach(function (run) {
    var r = SWEEP_STATE.results[run.id], cur = SWEEP_STATE.current === run.id;
    var cls = cur ? 'cur' : (r && r.error ? 'err' : (r ? 'done' : ''));
    var setting = run.params ? run.params.map(function (p) { return p.name + ' ' + sweepFmtVal(p.value); }).join(' \u00b7 ')
                             : (run.param ? run.param.name + ' ' + (+(+run.param.value).toPrecision(4)) : '');
    if (run.shift) setting = run.shift + ' · ' + setting;
    h += '<tr class="' + cls + '" title="' + swEsc(run.purpose + (run.note ? ' — ' + run.note : '')) + '">' +
      '<td><input type="checkbox"' + (SWEEP_STATE.selected[run.id] ? ' checked' : '') + (SWEEP_STATE.running ? ' disabled' : '') +
        ' onchange="sweepToggle(\'' + run.id + '\', this.checked)"></td>' +
      '<td class="id">' + swEsc(run.id) + '</td><td class="set">' + swEsc((run.recipe && run.label ? run.label.split(' · ')[0] + ' · ' : '') + setting) + '</td>' +
      '<td>' + run.N + '</td><td>' + run.nu + '</td>' + (showExp ? '<td>' + (run.expectedVf != null ? run.expectedVf : '') + '</td>' : '');
    var st = SWEEP_STATE.preview[run.id], flags = sweepFlags(run, st);
    var flagHtml = '<td class="fl">' + (st ? (flags.length ? flags.map(function (f) {
        return '<span class="imp-chip ' + (f.level === 'skip' ? 'bad' : (f.level === 'warn' ? 'warn' : '')) + '" title="' + swEsc(f.text) + '">' + swEsc(f.short) + '</span>'; }).join(' ')
      : '<span class="imp-chip good" title="solid ' + (st.vf_trim * 100).toFixed(2) + ' %, spans x y z' + (st.thinVox ? ', thinnest feature ≈ ' + st.thinVox.toFixed(1) + ' voxels' : '') + '">ok</span>')
      : (SWEEP_STATE.previewing ? '<span class="imp-sub">…</span>' : '')) + '</td>';
    var preVf = st && !st.error ? '<td class="pre" title="voxel solid after island trim (geometry check)">' + (st.vf_trim * 100).toFixed(2) + '</td>' : '<td></td>';
    if (cur) h += preVf + '<td colspan="' + (7 + (showRef ? 1 : 0)) + '" class="imp-sub">solving…</td><td></td><td></td>';
    else if (r && r.error) h += preVf + '<td colspan="' + (7 + (showRef ? 1 : 0)) + '" class="sw-err">' + swEsc(r.error) + '</td><td></td><td></td>';
    else if (r) {
      var vfCls = r.vf_check != null && Math.abs(r.vf_check) > SWEEP_VF_TOL ? ' class="warn"' : '';
      var src = r.ext && r.ext.Ex != null ? r.ext : r;
      var ratios = '';
      if (showRef) ratios = '<td>' + (run.ref && run.ref.Ex != null ? ['Ex', 'Ey', 'Ez'].map(function (k) {
        var ref = run.ref[k]; return Math.abs(ref) > 1e-5 ? (src[k] / ref).toFixed(2) : '—'; }).join(' / ') : '') + '</td>';
      function ec(k) {
        if (src === r) return '<td>' + swFmt(r[k]) + '</td>';
        return '<td class="ext" title="extrapolated from N = ' + r.ext.coarseN + ' and ' + r.ext.fineN + ' (order ' + r.ext.order + '); N = ' + r.N + ': ' +
          swFmt(r[k]) + ', N = ' + r.companion.N + ': ' + swFmt(r.companion[k]) + '">' + swFmt(r.ext[k]) + '<sup>e</sup></td>';
      }
      h += '<td' + vfCls + '>' + r.vf_solved.toFixed(2) + (r.trim_removed_pct > 0.005 ? '<sup title="before island trim ' + r.vf_voxel.toFixed(2) + ' %">*</sup>' : '') + '</td>' +
        ec('Ex') + ec('Ey') + ec('Ez') + ec('Gyz') + ec('Gxz') + ec('Gxy') + ratios +
        '<td' + (r.converged ? '' : ' class="warn"') + '>' + r.iters + '</td><td>' + r.residual.toExponential(1) + '</td><td>' + sweepFmtDur(r.wall_s) + '</td>';
      (r.notes || []).forEach(function (n) { noteRuns[run.id] = 1; allNotes.push('<b>' + swEsc(run.id) + '</b> ' + swEsc(n)); });
    } else h += preVf + '<td colspan="' + (7 + (showRef ? 1 : 0)) + '"></td><td></td><td></td>';
    h += flagHtml + '</tr>';
    if (st && !r) flags.forEach(function (f) { if (f.level !== 'info') { noteRuns[run.id] = 1; allNotes.push('<b>' + swEsc(run.id) + '</b> ' + swEsc(f.text)); } });
  });
  tb.innerHTML = h + '</tbody>';
  var nNoteRuns = Object.keys(noteRuns).length;
  if (notes) {
    var prevOpen = notes.querySelector('details');
    if (prevOpen) SWEEP_UI.notesOpen = prevOpen.open;
    notes.innerHTML = allNotes.length
      ? '<details class="sw-ndet"' + (SWEEP_UI.notesOpen ? ' open' : '') + ' ontoggle="SWEEP_UI.notesOpen=this.open"><summary>Notes and warnings (' + allNotes.length + ')' +
        '<span class="imp-sub">on ' + nNoteRuns + ' run' + (nNoteRuns === 1 ? '' : 's') + '</span></summary><div class="imp-warn">' + allNotes.join('<br>') + '</div></details>'
      : '';
  }
}

function sweepPaintHeaderBtn(i, n) {
  var b = swEl('sweepBtn');
  if (!b) return;
  if (SWEEP_STATE.running) b.textContent = '⟳ Sweep ' + ((i || 0) + 1) + '/' + (n || '?');
  else b.textContent = '⟳ Sweep';
  b.classList.toggle('sw-running', !!SWEEP_STATE.running);
}

sweepLoad();
