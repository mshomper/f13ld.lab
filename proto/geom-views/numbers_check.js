// F13LD.lab v0.36.0 · per-design geometry numbers check (decision 0010).
// Run: node proto/geom-views/numbers_check.js (from any folder).  No browser, no GPU.
//   N1  tightest radius (14f geomTightestRadius) on shapes with a known answer: strut, ball, pore ball
//   N2  thinnest wall and tightest gap (14d inscribed-ball measure) on a periodic plate
//   N3  the real pool job code (17c THERMAL_VOXEL_ONMESSAGE): 'voxels' slabs + 'geomnums' + 'georadius'
//       give the same numbers as calling the functions directly (Schwarz P and gyroid demos)
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ctx = vm.createContext({ console, Math, Float32Array, Float64Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Array, Object, JSON, Date, Infinity, NaN, isFinite, Error, Map, Set, performance: { now: () => Date.now() } });
const load = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
['13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '13d-foam-kernel.js', '14-rasterizer.js', '14a-connectivity.js',
 '14c-stl-import.js', '14d-voxel-stats.js', '14e-link-field.js', '14f-geom-curvature.js', '15-demo-recipes.js'].forEach(load);
const TAU = 2 * Math.PI;
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log((ok ? 'pass  ' : 'FAIL  ') + name + (detail ? ': ' + detail : '')); };
const grid = (f, N) => { const d = new Float32Array(N * N * N); for (let k = 0, o = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++, o++) d[o] = f((i + .5) / N * TAU - Math.PI, (j + .5) / N * TAU - Math.PI, (k + .5) / N * TAU - Math.PI); return d; };
const SOLID_BELOW = { topoMode: 1, halfInvert: 1, isoLevel: 0 };   /* TPMS solid: solid where field < level */

// N1 — tightest radius: strut (r), solid ball (R), spherical pore (R); all should read their radius
for (const N of [48, 96]) {
  const h = TAU / N;
  for (const [name, f, R] of [['strut r = 4 voxels', (x, y) => Math.hypot(x, y) - 4 * h, 4 * h],
                              ['ball R = 1.2', (x, y, z) => Math.hypot(x, y, z) - 1.2, 1.2],
                              ['pore ball R = 1.5', (x, y, z) => 1.5 - Math.hypot(x, y, z), 1.5]]) {
    const t0 = Date.now(), r = ctx.geomTightestRadius(grid(f, N), null, N, SOLID_BELOW), ms = Date.now() - t0;
    const err = 100 * (r.r5 - R) / R;
    check('N1 ' + name + ' at ' + N + '³', Math.abs(err) < 5, 'r5 ' + r.r5.toFixed(4) + ' vs ' + R.toFixed(4) + ' (' + err.toFixed(1) + ' %), ' + r.n + ' crossings, ' + ms + ' ms');
  }
}

// N2 — periodic plate, solid |x| < t/2: thinnest wall = t, tightest gap = cell − t (in voxels, ±1)
{
  const N = 96, tv = 20, kept = new Float32Array(N * N * N);
  for (let x = 0; x < N; x++) if (Math.abs(x + 0.5 - N / 2) < tv / 2) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) kept[x * N * N + y * N + z] = 1;
  const wall = ctx.sweepLocalThickness(kept, N, [0.05])[0], pore = Uint8Array.from(kept, v => v > .5 ? 0 : 1), gap = ctx.sweepLocalThickness(pore, N, [0.05])[0];
  check('N2 plate wall ' + tv + ' voxels', Math.abs(wall - tv) <= 1, 'measured ' + wall.toFixed(2));
  check('N2 plate gap ' + (N - tv) + ' voxels', Math.abs(gap - (N - tv)) <= 1, 'measured ' + gap.toFixed(2));
}

// N3 — the worker job code itself, run in this context with postMessage captured
{
  const pool = fs.readFileSync(path.join(ROOT, '17c-thermal-voxel-pool.js'), 'utf8');
  const pctx = vm.createContext({ document: undefined, console });
  vm.runInContext(pool, pctx);
  check('N3 pool loads 14c, 14d and 14f', ['14c-stl-import.js', '14d-voxel-stats.js', '14f-geom-curvature.js'].every(f => pctx.THERMAL_VOXEL_FILES.indexOf(f) >= 0), pctx.THERMAL_VOXEL_VERSION);
  let last = null; ctx.postMessage = m => { last = m; };
  vm.runInContext(pctx.THERMAL_VOXEL_ONMESSAGE, ctx);
  const job = m => { last = null; ctx.onmessage({ data: m }); if (!last || !last.ok) throw new Error((last && last.message) || 'no reply'); return last; };
  for (const key of ['schwarzP', 'spinodoid']) {
    const recipe = ctx.DEMO_RECIPES[key]; if (!recipe) { check('N3 demo ' + key, false, 'missing'); continue; }
    const N = 96, NN = N * N, raw = new Float32Array(NN * N), t0 = Date.now();
    for (const [i0, i1] of [[0, 30], [30, 61], [61, 96]]) raw.set(job({ type: 'voxels', recipe, N, key: 'k', i0, i1 }).v, i0 * NN);
    const tVox = Date.now() - t0, t1 = Date.now();
    const keptJ = job({ type: 'geomtrim', N, raw: Float32Array.from(raw), family: recipe.family, prune: true, conn: { connectivity: 'networks', pruneLargest: true } }).kept;
    const got = { wallVox: ctx.sweepLocalThickness(keptJ, N, [0.05])[0], gapVox: ctx.sweepLocalThickness(Uint8Array.from(keptJ, v => v > .5 ? 0 : 1), N, [0.05])[0] };
    const tNum = Date.now() - t1;
    const st = ctx.sweepGeometryStats(recipe, N, 'networks');   /* the sweep's own thinnest feature */
    const kept = ctx.pruneVoxels(raw, N, recipe.family, { connectivity: 'networks', pruneLargest: true });
    const gap = ctx.sweepLocalThickness(Uint8Array.from(kept, v => v > .5 ? 0 : 1), N, [0.05])[0];
    check('N3 ' + key + ' wall = sweep thinnest feature', got.wallVox === st.thinVox, got.wallVox + ' vs ' + st.thinVox + ' voxels (' + (got.wallVox / N * 5).toFixed(3) + ' mm at 5 mm cell)');
    check('N3 ' + key + ' gap = direct measure', got.gapVox === gap, got.gapVox + ' voxels; voxels ' + tVox + ' ms single-thread, trim + measures ' + tNum + ' ms');
    /* radius: the tile's field (buildRawField at 48³) and the tile's uniforms for a TPMS solid */
    const params = ctx.KERNELS[recipe.family].parseRecipe(recipe), args = ctx.resolveBuildArgs(recipe), fr = ctx.buildRawField(recipe.family, params, 48);
    const u = { topoMode: 1, halfInvert: 1, isoLevel: args.offset || 0, thickness: 0.3, pipeR: 0.1, pipeOffset: [0, 0, 0], normMode: 0, pairMode: 0 };
    const rj = job({ type: 'georadius', N: 48, d: Float32Array.from(fr.data), dB: null, u }), rd = ctx.geomTightestRadius(fr.data, null, 48, u);
    check('N3 ' + key + ' radius job = direct', rj.r5 === rd.r5 && rj.n === rd.n, 'r5 ' + rj.r5.toFixed(4) + ' world (' + (rj.r5 * 5 / TAU).toFixed(3) + ' mm at 5 mm cell), ' + rj.n + ' crossings');
  }
}

// N4 — local thickness (decision 0012): the fast method against the definition, painted ball by ball
// (every solid voxel takes the largest inscribed ball that holds it), at 32³; and timing at 64³ / 96³
{
  const lt = (solid, N) => {   /* brute force: paint every voxel's inscribed ball */
    const N3 = N * N * N, NN = N * N, A = new Float32Array(N3); for (let i = 0; i < N3; i++) A[i] = solid[i] ? ctx.EDT_INF : 0; ctx.periodicEdt3d(A, N);
    const T = new Float32Array(N3);
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
      const id = x * NN + y * N + z; if (!solid[id] || !A[id]) continue; const r2 = A[id], r = Math.sqrt(r2), R = Math.floor(r);
      for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) for (let c = -R; c <= R; c++) if (a * a + b * b + c * c <= r2) {
        const q = ((x + a + N) % N) * NN + ((y + b + N) % N) * N + ((z + c + N) % N); if (r > T[q]) T[q] = r; }
    }
    const v = []; for (let i = 0; i < N3; i++) if (solid[i]) v.push(2 * T[i] + 0.5); v.sort((p, q) => p - q);
    return [v[Math.floor(v.length * 0.05)], v[Math.floor(v.length * 0.5)]];
  };
  for (const key of ['schwarzP', 'spinodoid']) {
    const r = ctx.DEMO_RECIPES[key], p = ctx.KERNELS[r.family].parseRecipe(r), a = ctx.resolveBuildArgs(r), N = 32;
    const kept = ctx.pruneVoxels(ctx.buildVoxels(r.family, p, a.offset, N, a.mode, a.wt, a.nWeights, a.pipeR, a.phaseShift), N, r.family, { connectivity: 'networks', pruneLargest: true });
    const fast = ctx.sweepLocalThickness(kept, N, [0.05, 0.5]), ref = lt(kept, N);
    check('N4 ' + key + ' 32³ thinnest wall, fast vs painted', Math.abs(fast[0] - ref[0]) <= 0.5, fast[0].toFixed(2) + ' vs ' + ref[0].toFixed(2) + ' voxels');
    check('N4 ' + key + ' 32³ median wall, fast vs painted', Math.abs(fast[1] - ref[1]) <= 0.5, fast[1].toFixed(2) + ' vs ' + ref[1].toFixed(2) + ' voxels');
  }
  for (const N of [64, 96]) {
    const r = ctx.DEMO_RECIPES.schwarzP, p = ctx.KERNELS[r.family].parseRecipe(r), a = ctx.resolveBuildArgs(r);
    const kept = ctx.buildVoxels(r.family, p, a.offset, N, a.mode, a.wt, a.nWeights, a.pipeR, a.phaseShift), t0 = Date.now();
    const v = ctx.sweepLocalThickness(kept, N, [0.05, 0.5]), ms = Date.now() - t0;
    console.log('      N4 Schwarz P ' + N + '³, one thread (for reference; the pool times are in N5): ' + ms + ' ms; thinnest ' + v[0].toFixed(1) + ', median ' + v[1].toFixed(1) + ' voxels (old measure gave the node, 82.5 at 96³)');
  }
}

// N5 — the pool version (17c labLocalThicknessParallel: every pass split into slabs across workers)
// gives exactly the single-thread numbers, and how long it takes.  Real worker threads stand in for
// the page's pool: each loads the pool's files and runs THERMAL_VOXEL_ONMESSAGE, as a browser worker does.
(async () => {
  const { Worker } = require('worker_threads'), os = require('os');
  const nW = Math.max(1, Math.min(8, os.cpus().length - 1));   /* as 17c _tvPoolSize */
  const pctx = vm.createContext({ document: undefined, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, '17c-thermal-voxel-pool.js'), 'utf8'), pctx);
  const files = pctx.THERMAL_VOXEL_FILES.map(f => path.join(ROOT, f)), onmsg = pctx.THERMAL_VOXEL_ONMESSAGE;
  const src = `const { parentPort, workerData } = require('worker_threads'), fs = require('fs'), vm = require('vm');
    globalThis.postMessage = (m, t) => parentPort.postMessage(m, t || []);
    for (const f of workerData.files) vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f });
    vm.runInThisContext(workerData.onmsg);
    parentPort.on('message', d => onmessage({ data: d }));`;
  const idle = [], queue = [], pending = new Map(), workers = [];
  for (let i = 0; i < nW; i++) {
    const w = new Worker(src, { eval: true, workerData: { files, onmsg } });
    w.on('message', m => { const p = pending.get(m.id); pending.delete(m.id); idle.push(w); pump(); m.ok ? p.resolve(m) : p.reject(new Error(m.message)); });
    workers.push(w); idle.push(w);
  }
  let nextId = 1;
  function pump() { while (idle.length && queue.length) { const w = idle.pop(), t = queue.shift(); pending.set(t.msg.id, t); w.postMessage(t.msg, t.transfer || []); } }
  ctx.__nodeRun = (msg, transfer) => new Promise((resolve, reject) => { msg.id = nextId++; queue.push({ msg, transfer, resolve, reject }); pump(); });
  vm.runInContext(fs.readFileSync(path.join(ROOT, '17c-thermal-voxel-pool.js'), 'utf8'), ctx);
  vm.runInContext('_tvCanUseWorkers = function () { return true; }; _tvPoolSize = function () { return ' + nW + '; }; _tvRun = function (m, t) { return __nodeRun(m, t); };', ctx);
  console.log('      N5 pool: ' + nW + ' worker threads (' + os.cpus().length + ' logical cores, ' + os.cpus()[0].model.trim() + ')');
  try {
    for (const [key, N] of [['schwarzP', 64], ['spinodoid', 64], ['schwarzP', 96], ['spinodoid', 96]]) {
      const r = ctx.DEMO_RECIPES[key], p = ctx.KERNELS[r.family].parseRecipe(r), a = ctx.resolveBuildArgs(r);
      const kept = ctx.pruneVoxels(ctx.buildVoxels(r.family, p, a.offset, N, a.mode, a.wt, a.nWeights, a.pipeR, a.phaseShift), N, r.family, { connectivity: 'networks', pruneLargest: true });
      const t0 = Date.now(), one = ctx.sweepLocalThickness(kept, N, [0.05, 0.5]), tOne = Date.now() - t0;
      const t1 = Date.now(), par = await ctx.labLocalThicknessParallel(kept, N, [0.05, 0.5], false), tPar = Date.now() - t1;
      check('N5 ' + key + ' ' + N + '³ pool = single thread, exactly', par[0] === one[0] && par[1] === one[1],
        'thinnest ' + par[0].toFixed(2) + ', median ' + par[1].toFixed(2) + ' voxels; one thread ' + tOne + ' ms, pool ' + tPar + ' ms');
    }
    /* tile numbers: voxels + trim + wall and gap, all on the pool, at 96³ */
    for (const key of ['schwarzP', 'spinodoid']) {
      const t0 = Date.now(), g = await ctx.labGeomWallGapAsync(ctx.DEMO_RECIPES[key], 96, { connectivity: 'networks', pruneLargest: true }), ms = Date.now() - t0;
      check('N5 ' + key + ' tile numbers at 96³ within a few seconds', ms < 5000, 'wall ' + g.wallVox.toFixed(2) + ', gap ' + g.gapVox.toFixed(2) + ' voxels, ' + ms + ' ms');
    }
    /* sweep geometry check: runs spread over the pool, one run per worker, at 64³ */
    {
      const runs = 2 * nW, recipes = Array.from({ length: runs }, (_, i) => ctx.DEMO_RECIPES[i % 2 ? 'spinodoid' : 'schwarzP']);
      const t0 = Date.now(); await Promise.all(recipes.map(rc => ctx.labGeomStatsAsync(rc, 64, 'networks'))); const ms = Date.now() - t0;
      check('N5 sweep geometry check at 64³ under 1 s per run', ms / runs < 1000, runs + ' runs in ' + ms + ' ms = ' + Math.round(ms / runs) + ' ms per run');
    }
  } catch (e) { check('N5 pool', false, e.message); }
  workers.forEach(w => w.terminate());
  console.log(fails ? fails + ' failed' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
