/* ============================================================
   F13LD.lab · 17c-thermal-voxel-pool.js   (v0.20.0 — thermal Phase 1)
   Sub-voxel wall data for the GPU thermal solver (17b), built in parallel.

   buildVoxelTensors (14e) evaluates the design's field about 70 times in
   every surface voxel (64 samples, the centre and a gradient).  On grain
   and hyperuniform fields that is the slow part of a thermal run: about
   11 s at N = 32 on one core for the hyperuniform demo, and it grows with
   N³.  This file splits it into x-slabs across a small pool of Web
   Workers (cores − 1, at most 8), as the buckling pool does:

     1. raw 0/1 cube and the island-trimmed cube — reused from the elastic
        solve of the same design and grid when Run All just made them
        (thermalStashVoxels, called from 16b), otherwise built here;
     2. the corner margin grid — reused from the elastic partial-volume
        pass when available, otherwise built in slabs on the pool;
     3. per-voxel solid fraction and wall normal — slabs on the pool.

   The result is identical to buildVoxelTensors(recipe, N, opts) (same
   functions, same order of evaluation per voxel); thermalVoxelSelfTest()
   checks that.  Without Worker support (node, old browsers) it falls back
   to buildVoxelTensors on the main thread.

   API
     thermalStashVoxels(recipe, N, opts, raw, kept)      (16b, after the trim)
     thermalStashMargin(recipe, N, opts, m)              (16b, partial volume)
     buildVoxelTensorsParallel(recipe, N, opts, onProgress) → Promise<vt>
         vt as buildVoxelTensors: { N, kept, raw, phi, n, rho, rhoPhi,
           nSurf, nPlane, area (wall area ÷ cell edge², v0.23.0), t_ms, t_setup_ms, t_sample_ms, workers, reused }
     thermalVoxelPoolInfo()  → { size, spawned }
     thermalVoxelSelfTest(recipe, N)  → Promise<{ maxDiff, ... }>  (console)
   ============================================================ */

var THERMAL_VOXEL_FILES = [
  '14-rasterizer.js', '14a-connectivity.js', '13-kernels.js', '13b-kernels-new.js',
  '13c-import-kernel.js', '13d-foam-kernel.js', '14e-link-field.js'
];
var THERMAL_VOXEL_VERSION = 'tv-2';   /* v0.23.0 — slabs also return wall area */   /* bump when a worker file changes (blob workers cache separately) */

/* ── Stash: the elastic solves of this Run All ───────────────────────
   Entries { recipe, N, conn, raw, kept, m }, newest last, matched by the
   recipe OBJECT (Run All passes the same object to every phase), kept
   under a byte budget so a 128³ run holds a few designs, not dozens. */
var _TV_STASH = [];
var THERMAL_STASH_BYTES = 200e6;
function _tvConnKey(opts) {
  opts = opts || {};
  var c = opts.connectivity || 'networks';
  return (opts.pruneLargest === false || c === 'off') ? 'off' : c;
}
function _tvStashFor(recipe, N, opts) {
  var c = _tvConnKey(opts);
  for (var i = _TV_STASH.length - 1; i >= 0; i--) { var s = _TV_STASH[i]; if (s.recipe === recipe && s.N === N && s.conn === c) return s; }
  return null;
}
function _tvStashBytes(s) { return (s.raw ? s.raw.byteLength : 0) + (s.kept && s.kept !== s.raw ? s.kept.byteLength : 0) + (s.m ? s.m.byteLength : 0); }
function _tvStashTrim() {
  var total = 0;
  for (var i = 0; i < _TV_STASH.length; i++) total += _tvStashBytes(_TV_STASH[i]);
  while (_TV_STASH.length > 1 && total > THERMAL_STASH_BYTES) total -= _tvStashBytes(_TV_STASH.shift());
}
function thermalStashVoxels(recipe, N, opts, raw, kept) {
  var c = _tvConnKey(opts);
  _TV_STASH = _TV_STASH.filter(function (s) { return !(s.recipe === recipe && s.N === N && s.conn === c); });
  _TV_STASH.push({ recipe: recipe, N: N, conn: c, raw: raw, kept: kept, m: null });
  _tvStashTrim();
}
function thermalStashMargin(recipe, N, opts, m) {
  var s = _tvStashFor(recipe, N, opts);
  if (s) { s.m = m; _tvStashTrim(); }
}

/* ── Worker pool ────────────────────────────────────────────────────── */
var THERMAL_VOXEL_ONMESSAGE =
  'var _fnCache = { key: null, fn: null };\n' +
  'function marginFn(recipe, N, key){\n' +
  '  if (_fnCache.key === key) return _fnCache.fn;\n' +
  '  var family = recipe.family, params = KERNELS[family].parseRecipe(recipe), a = resolveBuildArgs(recipe);\n' +
  '  var mg = buildVoxelMargin(family, params, a.offset, N, a.mode, a.wt, a.nWeights, a.pipeR, a.phaseShift, true);\n' +
  '  _fnCache = { key: key, fn: mg.fn }; return mg.fn;\n' +
  '}\n' +
  'onmessage = function(e){\n' +
  '  var job = e.data, N = job.N, NN = N*N;\n' +
  '  try {\n' +
  '    if (job.importGrid) registerImportGrid(job.importGrid);\n' +
  '    var fn = marginFn(job.recipe, N, job.key);\n' +
  '    if (job.type === "margin"){\n' +
  '      var L = Math.PI, step = 2*L/N, m = new Float32Array((job.i1 - job.i0) * NN);\n' +
  '      for (var i = job.i0; i < job.i1; i++){ var x = -L + i*step, o = (i - job.i0)*NN;\n' +
  '        for (var j = 0; j < N; j++){ var y = -L + j*step;\n' +
  '          for (var k = 0; k < N; k++) m[o + j*N + k] = fn(x, y, -L + k*step); } }\n' +
  '      postMessage({ id: job.id, ok: true, m: m }, [m.buffer]);\n' +
  '    } else {\n' +
  '      var vt = voxelTensorsFromMargin({ m: job.m, fn: fn }, N, job.kept, job.raw, { iRange: [job.i0, job.i1] });\n' +
  '      var a0 = job.i0*NN, a1 = job.i1*NN;\n' +
  '      var phi = vt.phi.slice(a0, a1), nrm = vt.n.slice(3*a0, 3*a1);\n' +
  '      postMessage({ id: job.id, ok: true, phi: phi, n: nrm, nSurf: vt.nSurf, nPlane: vt.nPlane, area: vt.area }, [phi.buffer, nrm.buffer]);\n' +
  '    }\n' +
  '  } catch (err){ postMessage({ id: job.id, ok: false, message: (err && err.message) || String(err) }); }\n' +
  '};\n';

var _TV_POOL = { workers: [], idle: [], queue: [], pending: {}, nextId: 1, size: 0 };

function _tvPoolSize() {
  var hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(8, hc - 1));
}
function _tvCanUseWorkers() {
  return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof document !== 'undefined';
}
function _tvMakeWorker() {
  var base = (document && document.baseURI) ? document.baseURI : location.href, urls = [];
  for (var i = 0; i < THERMAL_VOXEL_FILES.length; i++) {
    var u = new URL(THERMAL_VOXEL_FILES[i], base); u.search = '?v=' + THERMAL_VOXEL_VERSION; urls.push(JSON.stringify(u.href));
  }
  var body = 'importScripts(' + urls.join(',') + ');\n' + THERMAL_VOXEL_ONMESSAGE;
  var w = new Worker(URL.createObjectURL(new Blob([body], { type: 'application/javascript' })));
  w.onmessage = function (ev) { _tvOnMessage(w, ev.data); };
  w.onerror = function (ev) { _tvOnError(w, (ev && ev.message) || 'worker error'); };
  return w;
}
function _tvDispatch() {
  var P = _TV_POOL;
  if (!P.size) P.size = _tvPoolSize();
  while (P.queue.length) {
    var w = P.idle.pop();
    if (!w) {
      if (P.workers.length >= P.size) return;
      w = _tvMakeWorker(); P.workers.push(w);
    }
    var t = P.queue.shift();
    w._tvJob = t.msg.id;
    P.pending[t.msg.id] = t;
    w.postMessage(t.msg, t.transfer || []);
  }
}
function _tvOnMessage(w, data) {
  var P = _TV_POOL, t = P.pending[data.id];
  delete P.pending[data.id]; w._tvJob = null; P.idle.push(w);
  if (t) { if (data.ok) t.resolve(data); else t.reject(new Error(data.message || 'thermal voxel worker failed')); }
  _tvDispatch();
}
function _tvOnError(w, msg) {
  var P = _TV_POOL, id = w._tvJob, t = id != null ? P.pending[id] : null;
  if (t) { delete P.pending[id]; t.reject(new Error(msg)); }
  /* drop the broken worker */
  var k = P.workers.indexOf(w); if (k >= 0) P.workers.splice(k, 1);
  try { w.terminate(); } catch (e) {}
  _tvDispatch();
}
function _tvRun(msg, transfer) {
  return new Promise(function (resolve, reject) {
    msg.id = _TV_POOL.nextId++;
    _TV_POOL.queue.push({ msg: msg, transfer: transfer, resolve: resolve, reject: reject });
    _tvDispatch();
  });
}
function thermalVoxelPoolInfo() { return { size: _TV_POOL.size || _tvPoolSize(), spawned: _TV_POOL.workers.length }; }

/* Slabs: about 3 per worker so uneven surfaces balance out. */
function _tvSlabs(N, nWorkers) {
  var nSlab = Math.min(N, Math.max(1, nWorkers * 3)), out = [], i0 = 0;
  for (var s = 0; s < nSlab; s++) { var i1 = Math.round((s + 1) * N / nSlab); if (i1 > i0) out.push([i0, i1]); i0 = i1; }
  return out;
}

async function buildVoxelTensorsParallel(recipe, N, opts, onProgress) {
  opts = opts || {};
  var t0 = linkNowMs();
  if (!_tvCanUseWorkers() || opts.noWorkers) {
    var vt0 = buildVoxelTensors(recipe, N, opts);
    vt0.workers = 0; vt0.reused = false; return vt0;
  }
  var NN = N * N, N3 = NN * N, conn = _tvConnKey(opts);
  var st = _tvStashFor(recipe, N, opts), raw, kept, m, reused = [];
  if (st) { raw = st.raw; kept = st.kept; reused.push('voxels'); }
  else {
    var family = recipe.family, params = KERNELS[family].parseRecipe(recipe), args = resolveBuildArgs(recipe);
    raw = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
    kept = raw;
    if (conn !== 'off' && typeof pruneVoxels === 'function')
      kept = pruneVoxels(raw, N, family, { connectivity: opts.connectivity || 'networks', pruneLargest: true });
  }
  var key = (typeof recipeFingerprint === 'function' ? recipeFingerprint(recipe) : String(linkNowMs())) + '|' + N;
  var importGrid = (recipe.family === 'import' && typeof importGridMessage === 'function') ? importGridMessage(recipe) : null;
  var slabs = _tvSlabs(N, _tvPoolSize()), done = 0, total = slabs.length * ((st && st.m) ? 1 : 2);
  function tick(stage) { done++; if (onProgress) onProgress({ stage: stage, done: done, total: total }); }
  if (st && st.m) { m = st.m; reused.push('margin'); }
  else {
    m = new Float32Array(N3);
    await Promise.all(slabs.map(function (sl) {
      return _tvRun({ type: 'margin', recipe: recipe, N: N, key: key, i0: sl[0], i1: sl[1], importGrid: importGrid }).then(function (r) {
        m.set(r.m, sl[0] * NN); tick('margin');
      });
    }));
  }
  var tSetup = linkNowMs() - t0, t1 = linkNowMs();
  var phi = Float32Array.from(kept), nrm = new Float32Array(3 * N3), nSurf = 0, nPlane = 0, area = 0;
  await Promise.all(slabs.map(function (sl) {
    return _tvRun({ type: 'tensors', recipe: recipe, N: N, key: key, i0: sl[0], i1: sl[1], m: m, kept: kept, raw: raw, importGrid: importGrid }).then(function (r) {
      phi.set(r.phi, sl[0] * NN); nrm.set(r.n, 3 * sl[0] * NN); nSurf += r.nSurf; nPlane += r.nPlane; area += (r.area || 0); tick('walls');
    });
  }));
  var solid = 0, ps = 0;
  for (var p = 0; p < N3; p++) { if (kept[p] > 0.5) solid++; ps += phi[p]; }
  return { N: N, kept: kept, raw: raw, phi: phi, n: nrm, rho: solid / N3, rhoPhi: ps / N3, nSurf: nSurf, nPlane: nPlane, area: area,
           t_ms: linkNowMs() - t0, t_setup_ms: tSetup, t_sample_ms: linkNowMs() - t1,
           workers: Math.min(slabs.length, thermalVoxelPoolInfo().size), reused: reused.join('+') || 'none' };
}

/* Console: parallel vs single-thread build on one recipe (default the
   hyperuniform demo) — must match exactly; prints both times. */
async function thermalVoxelSelfTest(recipe, N) {
  N = N || 32;
  recipe = recipe || (typeof DEMO_RECIPES !== 'undefined' ? DEMO_RECIPES.hyperuniform : null);
  var tA = linkNowMs(), A = buildVoxelTensors(recipe, N, { connectivity: 'networks' }), sA = linkNowMs() - tA;
  var tB = linkNowMs(), B = await buildVoxelTensorsParallel(recipe, N, { connectivity: 'networks' }), sB = linkNowMs() - tB;
  var maxDiff = 0, N3 = N * N * N;
  for (var p = 0; p < N3; p++) maxDiff = Math.max(maxDiff, Math.abs(A.phi[p] - B.phi[p]));
  for (var q = 0; q < 3 * N3; q++) maxDiff = Math.max(maxDiff, Math.abs(A.n[q] - B.n[q]));
  var out = { N: N, maxDiff: maxDiff, pass: maxDiff === 0 && A.nSurf === B.nSurf, single_s: +(sA / 1000).toFixed(2), parallel_s: +(sB / 1000).toFixed(2), workers: B.workers, nSurf: B.nSurf };
  console.log('[thermal voxels] ' + (out.pass ? 'PASS' : 'FAIL'), out);
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildVoxelTensorsParallel: buildVoxelTensorsParallel, thermalStashVoxels: thermalStashVoxels, thermalStashMargin: thermalStashMargin };
}
