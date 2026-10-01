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
  standard: { tol: 1e-4, maxiter: 300,  label: 'Standard (1e-4)' },
  high:     { tol: 1e-5, maxiter: 1000, label: 'High (1e-5)' }
};
var VOIGT = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];

var SWEEP_STATE = {
  open: false, running: false, stopRequested: false,
  name: '', source: null,          /* 'csv' | 'builder' */
  runs: [],                        /* run definitions (see sweepRunFromCsvRow / sweepBuildRuns) */
  results: {},                     /* run_id → result record */
  selected: {},                    /* run_id → bool */
  precision: 'standard',
  preview: {},                     /* run_id → geometry stats (14d-voxel-stats.js) */
  previewing: false, previewDone: 0, previewTotal: 0,
  current: null, startedAt: 0, log: []
};

/* ── Persistence ──────────────────────────────────────────── */
function sweepSave() {
  try {
    localStorage.setItem(SWEEP_STORE_KEY, JSON.stringify({
      v: 1, name: SWEEP_STATE.name, source: SWEEP_STATE.source, runs: SWEEP_STATE.runs,
      results: SWEEP_STATE.results, selected: SWEEP_STATE.selected, precision: SWEEP_STATE.precision,
      preview: SWEEP_STATE.preview
    }));
  } catch (e) { console.warn('[sweep] not saved (storage full or blocked):', e); }
}
function sweepLoad() {
  try {
    var raw = localStorage.getItem(SWEEP_STORE_KEY);
    if (!raw) return;
    var p = JSON.parse(raw);
    if (!p || p.v !== 1 || !Array.isArray(p.runs)) return;
    SWEEP_STATE.name = p.name || ''; SWEEP_STATE.source = p.source || null;
    SWEEP_STATE.runs = p.runs; SWEEP_STATE.results = p.results || {};
    SWEEP_STATE.selected = p.selected || {}; SWEEP_STATE.precision = p.precision || 'standard';
    SWEEP_STATE.preview = p.preview || {};
  } catch (e) {}
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

function sweepLoadCsvText(text, name) {
  var rows = sweepParseCsv(text), runs = [], errs = [];
  rows.forEach(function (r) { try { runs.push(sweepRunFromCsvRow(r)); } catch (e) { errs.push(e.message); } });
  if (!runs.length) throw new Error(errs[0] || 'no runs found');
  var ids = {};
  runs.forEach(function (r) { if (ids[r.id]) errs.push('duplicate run_id ' + r.id); ids[r.id] = true; });
  return { runs: runs, errors: errs, name: name };
}

/* ── Builder: parameters per family / mode ────────────────── */
function sweepParamsFor(recipe) {
  var g = recipe.geometry || {}, fam = recipe.family, mode = g.mode || 'solid', out = [];
  function geo(key, label, unit, def) {
    out.push({ key: key, label: label, unit: unit || '',
      get: function (r) { var v = (r.geometry || {})[key]; return v != null ? v : def; },
      set: function (r, v) { r.geometry = r.geometry || {}; r.geometry[key] = v; } });
  }
  if (fam === 'import') {
    var cell = g.cellSizeMm || 5;
    out.push({ key: 'wallOffsetMm', label: 'Wall offset', unit: 'mm',
      get: function (r) { return (r.geometry && r.geometry.wallOffsetMm) || 0; },
      set: function (r, v) { r.geometry.wallOffsetMm = v; r.geometry.offset = v * 2 * Math.PI / cell; } });
    return out;
  }
  if (fam === 'tpms') {
    if (mode === 'pi-tpms') {
      out.push({ key: 'wall_ratio', label: 'Wall ratio (tube diameter ÷ cell)', unit: '',
        get: function (r) { return (r.geometry.pipeR != null ? r.geometry.pipeR : 0.1) / Math.PI; },
        set: function (r, v) { r.geometry.pipeR = v * Math.PI; } });
      ['x', 'y', 'z'].forEach(function (a) {
        out.push({ key: 'shift_' + a, label: 'Shift ' + a + ' (cycles)', unit: '',
          get: function (r) { return ((r.geometry.phaseShift || {})[a]) || 0; },
          set: function (r, v) { r.geometry.phaseShift = r.geometry.phaseShift || { x: 0, y: 0, z: 0 }; r.geometry.phaseShift[a] = v; } });
      });
    } else if (mode === 'shell') {
      geo('wallThickness', 'Sheet half-thickness (level c)', '', 0.3);
      geo('offset', 'Level offset', '', 0);
    } else {
      geo('offset', 'Level (solid where field < level)', '', 0);
    }
    return out;
  }
  if (fam === 'grain') { geo('center', 'Level', '', 0); geo('half_width', 'Half-width', '', 0.15); return out; }
  if (fam === 'noise') {
    function surf(key, label, def) {
      out.push({ key: key, label: label, unit: '',
        get: function (r) { var v = (r.surface || {})[key]; return v != null ? v : def; },
        set: function (r, v) { r.surface = r.surface || {}; r.surface[key] = v; } });
    }
    surf('center', 'Level', 0); surf('half_width', 'Half-width', 0.15);
    return out;
  }
  return out;
}

/* Recipe the solver would use for a loaded design (demo designs resolve
   through recipeForDesign; imported ones carry their own). */
function sweepRecipeOf(d) {
  var r = (typeof recipeForDesign === 'function') ? recipeForDesign(d) : d.recipe;
  return r || null;
}

function sweepBuildRuns(design, paramKey, from, to, steps, N, nu, prefix) {
  var base = sweepClone(sweepRecipeOf(design));
  var p = sweepParamsFor(base).filter(function (x) { return x.key === paramKey; })[0];
  if (!p) throw new Error('that parameter does not apply to this design');
  steps = Math.max(1, Math.min(200, steps | 0));
  var runs = [];
  for (var i = 0; i < steps; i++) {
    var v = steps === 1 ? from : from + (to - from) * i / (steps - 1);
    v = +v.toPrecision(10);
    var r = sweepClone(base);
    p.set(r, v);
    var id = prefix + String(i + 1).padStart(2, '0');
    r.name = id;
    runs.push({ id: id, tier: '', set: design.title, purpose: p.label + ' = ' + v, note: '',
      label: design.title, shift: '', N: N, nu: nu,
      param: { name: p.key, value: v }, expectedVf: null, ref: null, recipe: r });
  }
  return runs;
}

/* ── Execution ────────────────────────────────────────────── */
function sweepVoigtUpper(C) {
  var out = {};
  for (var i = 0; i < 6; i++) for (var j = i; j < 6; j++) out['C' + (i + 1) + (j + 1)] = C[i * 6 + j] / SWEEP_ES;
  return out;
}

async function sweepRunOne(run) {
  var prec = SWEEP_PRECISION[SWEEP_STATE.precision] || SWEEP_PRECISION.standard;
  var recipe = sweepClone(run.recipe);
  recipe.material = { Es_MPa: SWEEP_ES, nu: run.nu };
  if (recipe.family === 'import' && !(typeof importGridReady === 'function' && importGridReady(recipe)))
    throw new Error('imported geometry is not loaded');
  var conn = (typeof GEOM_STATE !== 'undefined') ? GEOM_STATE.connectivity : 'networks';
  var t0 = performance.now();
  var R = await solveDesignElasticFull(recipe, run.N, {
    connectivity: conn, pruneLargest: conn !== 'off',
    captureFieldsLCs: [], cgTol: prec.tol, cgMaxiter: prec.maxiter
  });
  var wall = (performance.now() - t0) / 1000;
  if (!R.valid) throw new Error('solve invalid: ' + (R.reject_reason || 'unknown'));
  var per = R.perLC || [], itersBy = {}, resMax = 0, itTot = 0;
  per.forEach(function (p, k) {
    itersBy['iters_' + VOIGT[k]] = p.iters; itTot += p.iters;
    if (p.finalResidual != null && p.finalResidual > resMax) resMax = p.finalResidual;
  });
  var vfRaw = R.rho_raw != null ? R.rho_raw * 100 : R.rho * 100, vf = R.rho * 100;
  var res = {
    id: run.id, when: new Date().toISOString(), N: run.N, nu: run.nu,
    tol: prec.tol, maxiter: prec.maxiter, connectivity: conn,
    vf_voxel: vfRaw, vf_solved: vf, trim_removed_pct: vfRaw > 0 ? (vfRaw - vf) / vfRaw * 100 : 0,
    vf_check: run.expectedVf ? (vfRaw - run.expectedVf) / run.expectedVf : null,
    C: sweepVoigtUpper(R.C_eff),
    Ex: R.Ex_MPa / SWEEP_ES, Ey: R.Ey_MPa / SWEEP_ES, Ez: R.Ez_MPa / SWEEP_ES,
    Gyz: R.Gyz_MPa / SWEEP_ES, Gxz: R.Gxz_MPa / SWEEP_ES, Gxy: R.Gxy_MPa / SWEEP_ES,
    nu_xy: R.nu_xy, nu_xz: R.nu_xz, nu_yz: R.nu_yz,
    iters: itTot, itersBy: itersBy, residual: resMax, converged: !!R.converged, wall_s: wall
  };
  res.notes = sweepNotesFor(run, res);
  return res;
}

function sweepNotesFor(run, r) {
  var n = [];
  if (r.vf_check != null && Math.abs(r.vf_check) > SWEEP_VF_TOL)
    n.push('build check: voxel solid ' + r.vf_voxel.toFixed(2) + ' % vs expected ' + run.expectedVf + ' % (' + (r.vf_check * 100).toFixed(1) + ' %)');
  if (r.trim_removed_pct > 0.005)
    n.push('island trim removed ' + r.trim_removed_pct.toFixed(2) + ' % of the solid (' + r.vf_voxel.toFixed(2) + ' → ' + r.vf_solved.toFixed(2) + ' % of the cell)');
  if (!r.converged) n.push('did not converge to ' + r.tol + ' in ' + r.maxiter + ' iterations per load case');
  if (run.ref && run.ref.Ex != null) {
    var fl = [];
    ['Ex', 'Ey', 'Ez'].forEach(function (k) {
      var ref = run.ref[k];
      if (Math.abs(ref) > 1e-5) { var d = (r[k] - ref) / ref; if (Math.abs(d) > 0.05) fl.push(k + ' ' + (d * 100 > 0 ? '+' : '') + (d * 100).toFixed(0) + ' %'); }
    });
    if (fl.length) n.push('vs ' + run.ref.name + ': ' + fl.join(', '));
  }
  return n;
}

/* ── Geometry checks (worker) ─────────────────────────────── */
var SWEEP_GEOM_VERSION = 'swg-1';
var SWEEP_THIN_VOX = 6;          /* Matt, 2026-10-01: flag under 6 voxels across the thinnest feature */
var _swWorker = null, _swJobs = {}, _swNext = 1;
function sweepGeomWorker() {
  if (_swWorker) return _swWorker;
  var base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : location.href;
  var files = ['14-rasterizer.js', '14a-connectivity.js', '13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '14c-stl-import.js', '14d-voxel-stats.js'];
  var urls = files.map(function (f) { var u = new URL(f, base); u.search = '?v=' + SWEEP_GEOM_VERSION; return JSON.stringify(u.href); });
  var body = 'importScripts(' + urls.join(',') + ');\n' + SWEEP_WORKER_ONMESSAGE;
  _swWorker = new Worker(URL.createObjectURL(new Blob([body], { type: 'application/javascript' })));
  _swWorker.onmessage = function (ev) {
    var m = ev.data, j = _swJobs[m.id];
    if (!j) return;
    delete _swJobs[m.id];
    if (m.ok) j.resolve(m); else j.reject(new Error(m.message || 'geometry check failed'));
  };
  _swWorker.onerror = function (e) {
    for (var id in _swJobs) _swJobs[id].reject(new Error((e && e.message) || 'geometry worker failed'));
    _swJobs = {}; try { _swWorker.terminate(); } catch (x) {} _swWorker = null;
  };
  return _swWorker;
}
function sweepGeomCall(msg) {
  return new Promise(function (resolve, reject) {
    var id = _swNext++;
    _swJobs[id] = { resolve: resolve, reject: reject };
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
      var m = await sweepGeomCall({ type: 'stats', recipe: run.recipe, N: run.N, connectivity: conn });
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
    f.push({ level: 'warn', short: 'spans ' + ax + ' only', text: 'carries load along ' + ax + ' only; stiffness on the other axes will sit near the void level (about 1e-4)' });
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
      console.log('[sweep] ' + run.id + ' N=' + run.N + ' vf ' + res.vf_solved.toFixed(2) + '% Ex ' + res.Ex.toExponential(3) +
                  ' Ey ' + res.Ey.toExponential(3) + ' Ez ' + res.Ez.toExponential(3) + ' · ' + res.wall_s.toFixed(1) + ' s');
    } catch (err) {
      SWEEP_STATE.results[run.id] = { id: run.id, error: (err && err.message) || String(err), when: new Date().toISOString() };
      console.error('[sweep] ' + run.id + ' failed:', err);
    }
    sweepSave();
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
  var cols = ['run_id', 'tier', 'set', 'purpose', 'grid_N', 'nu_s', 'cg_tol', 'connectivity', 'param_name', 'param_value',
              'expected_vf_pct', 'vf_voxel_pct', 'vf_measured_pct', 'vf_check_rel_pct', 'trim_removed_pct'];
  for (var i = 1; i <= 6; i++) for (var j = i; j <= 6; j++) cols.push('C' + i + j);
  cols = cols.concat(['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy', 'nu_xy', 'nu_xz', 'nu_yz',
    'iters_total', 'iters_xx', 'iters_yy', 'iters_zz', 'iters_yz', 'iters_xz', 'iters_xy', 'final_residual_max', 'converged', 'wall_time_s',
    'ref_Ex', 'ref_Ey', 'ref_Ez', 'ratio_Ex', 'ratio_Ey', 'ratio_Ez',
    'thinnest_feature_vox', 'median_feature_vox', 'spans', 'checks', 'notes', 'error']);
  var lines = [cols.join(',')];
  SWEEP_STATE.runs.forEach(function (run) {
    var r = SWEEP_STATE.results[run.id];
    if (!r) return;
    var ref = run.ref || {};
    var row = {
      run_id: run.id, tier: run.tier, set: run.set, purpose: run.purpose, grid_N: run.N, nu_s: run.nu,
      param_name: run.param && run.param.name, param_value: run.param && run.param.value,
      expected_vf_pct: run.expectedVf, error: r.error || ''
    };
    if (!r.error) {
      row.cg_tol = r.tol; row.connectivity = r.connectivity;
      row.vf_voxel_pct = r.vf_voxel; row.vf_measured_pct = r.vf_solved;
      row.vf_check_rel_pct = r.vf_check != null ? r.vf_check * 100 : null; row.trim_removed_pct = r.trim_removed_pct;
      for (var k in r.C) row[k] = r.C[k];
      ['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy', 'nu_xy', 'nu_xz', 'nu_yz'].forEach(function (q) { row[q] = r[q]; });
      row.iters_total = r.iters;
      for (var ib in r.itersBy) row[ib] = r.itersBy[ib];
      row.final_residual_max = r.residual; row.converged = r.converged ? 'yes' : 'no'; row.wall_time_s = r.wall_s;
      ['Ex', 'Ey', 'Ez'].forEach(function (q) {
        row['ref_' + q] = ref[q];
        row['ratio_' + q] = (ref[q] != null && Math.abs(ref[q]) > 1e-5) ? r[q] / ref[q] : null;
      });
      row.notes = (r.notes || []).join('; ');
    }
    var st = SWEEP_STATE.preview[run.id];
    if (st && !st.error) {
      row.thinnest_feature_vox = st.thinVox; row.median_feature_vox = st.medVox;
      row.spans = ['x', 'y', 'z'].filter(function (a) { return st.spans[a]; }).join('');
      row.checks = sweepFlags(run, st).map(function (f) { return f.text; }).join('; ');
    }
    lines.push(cols.map(function (c) { return sweepCsvCell(row[c]); }).join(','));
  });
  var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (SWEEP_STATE.name || 'sweep').replace(/\.csv$/i, '').replace(/[^\w.-]+/g, '_') + '_results.csv';
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
      '<div class="imp-head"><div class="imp-title">Parameter sweep</div>' +
        '<button class="dc-icon-btn" title="Close (a running sweep keeps going)" onclick="closeSweepPanel()">×</button></div>' +
      '<div class="sw-source">' +
        '<div class="sw-box"><div class="sw-box-t">From a run matrix</div>' +
          '<div class="imp-note">CSV with run_id, surface, mode, shift, wall_ratio or tube_radius_over_T, level_c, grid_N, nu_s, expected_vf_pct (optional reference columns vixiv_Ex / Ey / Ez).</div>' +
          '<button class="fh-action-btn ghost" onclick="sweepPickCsv()">Load CSV…</button></div>' +
        '<div class="sw-box"><div class="sw-box-t">Build one</div><div id="swBuilder"></div></div>' +
      '</div>' +
      '<div class="sw-bar" id="swBar"></div>' +
      '<div class="sw-table-wrap"><table class="sw-table" id="swTable"></table></div>' +
      '<div class="sw-notes" id="swNotes"></div>' +
    '</div>';
  document.body.appendChild(ov);
  SWEEP_STATE.open = true;
  sweepRenderBuilder();
  sweepRender();
  sweepPreviewAll();
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

function sweepReplaceRuns(runs, name, source) {
  var hasResults = Object.keys(SWEEP_STATE.results).length > 0;
  if (hasResults && !confirm('Replace the current sweep? Its results will be cleared (export them first if you need them).')) return;
  SWEEP_STATE.runs = runs; SWEEP_STATE.name = name; SWEEP_STATE.source = source;
  SWEEP_STATE.results = {}; SWEEP_STATE.selected = {}; SWEEP_STATE.preview = {};
  runs.forEach(function (r) { SWEEP_STATE.selected[r.id] = true; });
  sweepSave(); sweepRender();
  sweepPreviewAll();
}

function sweepRenderBuilder() {
  var el = swEl('swBuilder');
  if (!el) return;
  var ds = LAB_STATE.designs.filter(function (d) { var r = sweepRecipeOf(d); return r && sweepParamsFor(r).length; });
  if (!ds.length) { el.innerHTML = '<div class="imp-note">Load a design with an adjustable parameter first (TPMS, PI-TPMS, grain, noise or an imported STL cell).</div>'; return; }
  var sel = swEl('swDesign') ? swEl('swDesign').value : ds[0].id;
  if (!ds.some(function (d) { return d.id === sel; })) sel = ds[0].id;
  var d = ds.filter(function (x) { return x.id === sel; })[0];
  var rec = sweepRecipeOf(d);
  var ps = sweepParamsFor(rec);
  var pk = swEl('swParam') && ps.some(function (p) { return p.key === swEl('swParam').value; }) ? swEl('swParam').value : ps[0].key;
  var p = ps.filter(function (x) { return x.key === pk; })[0];
  var cur = p.get(rec);
  var nu = (rec.material && rec.material.nu) || 0.34;
  var canVf = sweepTargetable(rec, pk);
  var byVf = canVf && swEl('swBy') && swEl('swBy').value === 'vf';
  el.innerHTML =
    '<div class="imp-settings">' +
      '<label>Design <select id="swDesign" onchange="sweepRenderBuilder()">' + ds.map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === sel ? ' selected' : '') + '>' + swEsc(x.label.split('·').pop().trim() + ' · ' + x.title) + '</option>'; }).join('') + '</select></label>' +
      '<label>Parameter <select id="swParam" onchange="sweepRenderBuilder()">' + ps.map(function (x) {
        return '<option value="' + x.key + '"' + (x.key === pk ? ' selected' : '') + '>' + swEsc(x.label) + '</option>'; }).join('') + '</select></label>' +
      '<label>Step by <select id="swBy" onchange="sweepRenderBuilder()">' +
        '<option value="value"' + (byVf ? '' : ' selected') + '>parameter value</option>' +
        (canVf ? '<option value="vf"' + (byVf ? ' selected' : '') + '>solid fraction</option>' : '') + '</select></label>' +
    '</div><div class="imp-settings">' +
      (byVf
        ? '<label>From <input id="swFrom" type="number" step="any" min="0" max="100" value="5"> %</label>' +
          '<label>To <input id="swTo" type="number" step="any" min="0" max="100" value="40"> %</label>'
        : '<label>From <input id="swFrom" type="number" step="any" value="' + (+cur.toPrecision(4)) + '"></label>' +
          '<label>To <input id="swTo" type="number" step="any" value="' + (+(cur === 0 ? 0.1 : cur * 2).toPrecision(4)) + '"></label>') +
      '<label>Steps <input id="swSteps" type="number" min="1" max="200" value="5"></label>' +
      (byVf ? '<span class="imp-sub">solid % before island trim, exact at the chosen grid</span>'
            : '<span class="imp-sub">' + (p.unit ? p.unit + ' · ' : '') + 'now ' + (+cur.toPrecision(4)) + '</span>') +
    '</div><div class="imp-settings">' +
      '<label>Grid <select id="swN"><option>32</option><option selected>64</option><option>128</option></select></label>' +
      '<label>Poisson’s ratio <input id="swNu" type="number" step="0.001" min="0" max="0.499" value="' + nu + '"></label>' +
      '<button class="fh-action-btn ghost" onclick="sweepBuildFromUI()">Create runs</button>' +
    '</div>';
}

function sweepBuildFromUI() {
  if (SWEEP_STATE.running) return;
  var d = LAB_STATE.designs.filter(function (x) { return x.id === swEl('swDesign').value; })[0];
  var from = parseFloat(swEl('swFrom').value), to = parseFloat(swEl('swTo').value), steps = parseInt(swEl('swSteps').value, 10);
  var N = parseInt(swEl('swN').value, 10), nu = parseFloat(swEl('swNu').value);
  if (!d || !isFinite(from) || !isFinite(to) || !(steps >= 1)) { alert('Enter a start, end and number of steps.'); return; }
  if (!(nu >= 0 && nu < 0.5)) { alert('Poisson’s ratio must be between 0 and 0.5.'); return; }
  var key = swEl('swParam').value;
  var byVf = swEl('swBy') && swEl('swBy').value === 'vf';
  if (!byVf) {
    try {
      var runs = sweepBuildRuns(d, key, from, to, steps, N, nu, 'S');
      sweepReplaceRuns(runs, (d.title + '_' + key).replace(/\s+/g, '_'), 'builder');
    } catch (e) { alert(e.message); }
    return;
  }
  if (!(from >= 0 && from <= 100 && to >= 0 && to <= 100)) { alert('Solid fractions are percentages from 0 to 100.'); return; }
  steps = Math.max(1, Math.min(200, steps | 0));
  var fr = [];
  for (var i = 0; i < steps; i++) fr.push((steps === 1 ? from : from + (to - from) * i / (steps - 1)) / 100);
  var btn = document.activeElement; if (btn && btn.tagName === 'BUTTON') { btn.disabled = true; btn.textContent = 'Finding values…'; }
  sweepGeomCall({ type: 'target', recipe: sweepRecipeOf(d), key: key, N: N, fractions: fr }).then(function (m) {
    if (!m.values) throw new Error('this parameter can\u2019t be stepped by solid fraction');
    var runs = sweepBuildRuns(d, key, 0, 0, 1, N, nu, 'S');   /* template */
    runs = m.values.map(function (v, k) {
      var r = sweepClone(runs[0]), p = sweepParamsFor(r.recipe).filter(function (x) { return x.key === key; })[0];
      v = +v.toPrecision(8);
      p.set(r.recipe, v);
      r.id = 'S' + String(k + 1).padStart(2, '0'); r.recipe.name = r.id;
      r.param = { name: key, value: v };
      r.purpose = 'target ' + (fr[k] * 100).toFixed(2) + ' % solid → ' + p.label + ' = ' + v;
      r.expectedVf = +(fr[k] * 100).toFixed(4);
      return r;
    });
    sweepReplaceRuns(runs, (d.title + '_' + key + '_by_vf').replace(/\s+/g, '_'), 'builder');
  }).catch(function (e) { alert(e.message); }).then(function () { sweepRenderBuilder(); });
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
function sweepSetPrecision(v) { if (!SWEEP_STATE.running) { SWEEP_STATE.precision = v; sweepSave(); sweepRenderBar(); } }

function sweepEta(todoRuns) {
  /* seconds per run by grid, from finished runs of this sweep; fallback guesses */
  var byN = {}, guess = { 32: 3, 64: 15, 128: 120 };
  for (var id in SWEEP_STATE.results) {
    var r = SWEEP_STATE.results[id];
    if (r && r.wall_s) { (byN[r.N] = byN[r.N] || []).push(r.wall_s); }
  }
  var hi = SWEEP_STATE.precision === 'high' ? 1.6 : 1;
  return todoRuns.reduce(function (s, run) {
    var a = byN[run.N];
    return s + (a ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : guess[run.N] * hi);
  }, 0);
}
function sweepFmtDur(s) { return s < 90 ? Math.round(s) + ' s' : (s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'); }

function sweepRenderBar() {
  var el = swEl('swBar');
  if (!el) return;
  var runs = SWEEP_STATE.runs, nSel = 0, nDone = 0, nTodo = [], tiers = {};
  runs.forEach(function (r) {
    if (r.tier) tiers[r.tier] = true;
    if (SWEEP_STATE.results[r.id]) nDone++;
    if (SWEEP_STATE.selected[r.id]) { nSel++; if (!SWEEP_STATE.results[r.id]) nTodo.push(r); }
  });
  var conn = (typeof GEOM_STATE !== 'undefined') ? GEOM_STATE.connectivity : 'networks';
  var connTxt = { networks: 'all networks · islands removed', largest: 'largest network only', off: 'keep everything' }[conn] || conn;
  if (!runs.length) { el.innerHTML = '<span class="imp-sub">No runs yet.</span>'; return; }
  var tierBtns = Object.keys(tiers).sort().map(function (t) { return '<a href="#" onclick="sweepSelect(\'' + t + '\');return false;">tier ' + t + '</a>'; }).join(' · ');
  el.innerHTML =
    '<div class="sw-bar-row"><b>' + swEsc(SWEEP_STATE.name) + '</b> <span class="imp-sub">' + runs.length + ' runs · ' + nDone + ' done · ' + nSel + ' selected</span>' +
      '<span class="sw-sel imp-sub">Select: <a href="#" onclick="sweepSelect(\'all\');return false;">all</a>' + (tierBtns ? ' · ' + tierBtns : '') +
      ' · <a href="#" onclick="sweepSelect(\'pending\');return false;">not run</a> · <a href="#" onclick="sweepSelect(\'none\');return false;">none</a></span></div>' +
    '<div class="sw-bar-row">' +
      '<label class="imp-sub">Precision <select id="swPrec" onchange="sweepSetPrecision(this.value)"' + (SWEEP_STATE.running ? ' disabled' : '') + '>' +
        Object.keys(SWEEP_PRECISION).map(function (k) { return '<option value="' + k + '"' + (k === SWEEP_STATE.precision ? ' selected' : '') + '>' + SWEEP_PRECISION[k].label + '</option>'; }).join('') +
      '</select></label>' +
      '<span class="imp-sub" title="Set by the Connectivity selector in the run controls">Islands: ' + connTxt + '</span>' +
      '<span class="imp-sub">Stiffness ÷ solid modulus</span>' +
      '<span class="sw-spacer"></span>' +
      (SWEEP_STATE.previewing
        ? '<span class="imp-sub">Checking geometry ' + SWEEP_STATE.previewDone + ' / ' + SWEEP_STATE.previewTotal + '…</span>'
        : '') +
      (SWEEP_STATE.running
        ? '<span class="imp-sub">Running ' + swEsc(SWEEP_STATE.current || '') + ' · ~' + sweepFmtDur(sweepEta(nTodo)) + ' left</span>' +
          '<button class="fh-action-btn ghost" onclick="SWEEP_STATE.stopRequested=true;this.disabled=true;this.textContent=\'Stopping after this run…\'">Stop</button>'
        : (nTodo.length ? '<span class="imp-sub">' + nTodo.length + ' to run · ~' + sweepFmtDur(sweepEta(nTodo)) + '</span>' : '') +
          '<button class="fh-action-btn ghost" onclick="sweepClearResults(true)">Clear selected</button>' +
          '<button class="fh-action-btn ghost" onclick="sweepExportCsv()"' + (nDone ? '' : ' disabled') + '>Export CSV</button>' +
          '<button class="fh-action-btn" onclick="sweepStart()"' + (nTodo.length && !SWEEP_STATE.previewing ? '' : ' disabled') + '>▶ Run ' + nTodo.length + '</button>') +
    '</div>';
}

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
  var allNotes = [];
  SWEEP_STATE.runs.forEach(function (run) {
    var r = SWEEP_STATE.results[run.id], cur = SWEEP_STATE.current === run.id;
    var cls = cur ? 'cur' : (r && r.error ? 'err' : (r ? 'done' : ''));
    var setting = run.param ? run.param.name + ' ' + (+(+run.param.value).toPrecision(4)) : '';
    if (run.shift) setting = run.shift + ' · ' + setting;
    h += '<tr class="' + cls + '" title="' + swEsc(run.purpose + (run.note ? ' — ' + run.note : '')) + '">' +
      '<td><input type="checkbox"' + (SWEEP_STATE.selected[run.id] ? ' checked' : '') + (SWEEP_STATE.running ? ' disabled' : '') +
        ' onchange="sweepToggle(\'' + run.id + '\', this.checked)"></td>' +
      '<td class="id">' + swEsc(run.id) + '</td><td class="set">' + swEsc((run.label ? run.label.split(' · ')[0] + ' · ' : '') + setting) + '</td>' +
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
      var ratios = '';
      if (showRef) ratios = '<td>' + (run.ref && run.ref.Ex != null ? ['Ex', 'Ey', 'Ez'].map(function (k) {
        var ref = run.ref[k]; return Math.abs(ref) > 1e-5 ? (r[k] / ref).toFixed(2) : '—'; }).join(' / ') : '') + '</td>';
      h += '<td' + vfCls + '>' + r.vf_solved.toFixed(2) + (r.trim_removed_pct > 0.005 ? '<sup title="before island trim ' + r.vf_voxel.toFixed(2) + ' %">*</sup>' : '') + '</td>' +
        '<td>' + swFmt(r.Ex) + '</td><td>' + swFmt(r.Ey) + '</td><td>' + swFmt(r.Ez) + '</td>' +
        '<td>' + swFmt(r.Gyz) + '</td><td>' + swFmt(r.Gxz) + '</td><td>' + swFmt(r.Gxy) + '</td>' + ratios +
        '<td' + (r.converged ? '' : ' class="warn"') + '>' + r.iters + '</td><td>' + r.residual.toExponential(1) + '</td><td>' + sweepFmtDur(r.wall_s) + '</td>';
      (r.notes || []).forEach(function (n) { allNotes.push('<b>' + swEsc(run.id) + '</b> ' + swEsc(n)); });
    } else h += preVf + '<td colspan="' + (7 + (showRef ? 1 : 0)) + '"></td><td></td><td></td>';
    h += flagHtml + '</tr>';
    if (st && !r) flags.forEach(function (f) { if (f.level !== 'info') allNotes.push('<b>' + swEsc(run.id) + '</b> ' + swEsc(f.text)); });
  });
  tb.innerHTML = h + '</tbody>';
  if (notes) notes.innerHTML = allNotes.length ? '<div class="imp-warn">' + allNotes.join('<br>') + '</div>' : '';
}

function sweepPaintHeaderBtn(i, n) {
  var b = swEl('sweepBtn');
  if (!b) return;
  if (SWEEP_STATE.running) b.textContent = '⟳ Sweep ' + ((i || 0) + 1) + '/' + (n || '?');
  else b.textContent = '⟳ Sweep';
  b.classList.toggle('sw-running', !!SWEEP_STATE.running);
}

sweepLoad();
