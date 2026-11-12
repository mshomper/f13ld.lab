/* ============================================================
   F13LD.lab · validate-prep.js   (v0.24.0)
   node validate-prep.js

   The elastic voxel prep now runs in x-slabs on the geometry worker pool
   (17c labPrepElasticParallel).  This runs the REAL worker message handler
   (THERMAL_VOXEL_ONMESSAGE) in a node context and checks, slab by slab,
   that the assembled results are bit-identical to the main-thread build:
     1. 0/1 voxels (buildVoxels with iRange) — every family and mode the
        demos use, plus anisotropic shell, isotropic shell and PI-TPMS
     2. partial-volume fractions (voxelFractionsFromMargin with iRange,
        rows packed as the main thread sends them)
     3. v0.35.2 — the crush grid (labPrepCrushParallel) against 16g upload's own build
   ============================================================ */
const fs = require('fs'), vm = require('vm'), path = require('path');
const out = [];
const ctx = { console, Math, JSON, Float32Array, Float64Array, Uint8Array, Int8Array, Int32Array, Uint32Array, Array, Object,
              isFinite, parseFloat, parseInt, String, Number, Error, performance,
              document: { getElementById: () => null }, window: {}, LAB_STATE: { designs: [] },
              postMessage: (m) => out.push(m), registerImportGrid: () => {} };
vm.createContext(ctx);
['13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '13d-foam-kernel.js', '14-rasterizer.js', '14a-connectivity.js',
 '14e-link-field.js', '15-demo-recipes.js', '17c-thermal-voxel-pool.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f }));
vm.runInContext(vm.runInContext('THERMAL_VOXEL_ONMESSAGE', ctx), ctx);
const L = (s) => vm.runInContext(s, ctx);
const call = (msg) => { out.length = 0; ctx.onmessage({ data: msg }); const r = out[0]; if (!r.ok) throw new Error(r.message); return r; };

let fails = 0;
function check(name, ok, detail) { console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  — ' + detail : '')); if (!ok) fails++; }

const recipes = Object.assign({}, L('DEMO_RECIPES'));
const P = [{ on: true, coef: 1, factors: [{ trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] }, { on: true, coef: 1, factors: [{ trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
           { on: true, coef: 1, factors: [{ trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] }];
recipes.shellP = { family: 'tpms', surface: { type: 'terms', terms: P }, geometry: { mode: 'shell', offset: 0, wallThickness: 0.35, cellSizeMm: 5 } };
recipes.anisoShellP = { family: 'tpms', surface: { type: 'terms', terms: P }, geometry: { mode: 'shell', offset: 0, wallThickness: 0.35, cellSizeMm: 5, nWeights: { wx: 1.4, wy: 0.8, wz: 1.0 } } };
recipes.piP = { family: 'tpms', surface: { type: 'terms', terms: P }, geometry: { mode: 'pi-tpms', offset: 0, pipeR: 0.35, phaseShift: { x: 0.5, y: 0.5, z: 0.5 }, cellSizeMm: 5 } };

const N = 20, NN = N * N, N3 = NN * N;
const slabs = L('_tvSlabs')(N, 3), rowList = L('_tvRowList'), pack = L('_tvPackRows');

for (const name of Object.keys(recipes)) {
  const r = recipes[name], fam = r.family;
  const args = L('resolveBuildArgs')(r), params = L('KERNELS')[fam].parseRecipe(r);
  const mode = args.mode + (args.nWeights ? '+aniso' : '');
  const full = L('buildVoxels')(fam, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  const asm = new Float32Array(N3), m = new Float32Array(N3);
  for (const sl of slabs) {
    asm.set(call({ type: 'voxels', recipe: r, N, key: name, i0: sl[0], i1: sl[1] }).v, sl[0] * NN);
    m.set(call({ type: 'margin', recipe: r, N, key: name, i0: sl[0], i1: sl[1] }).m, sl[0] * NN);
  }
  let d = 0; for (let p = 0; p < N3; p++) if (asm[p] !== full[p]) d++;
  check(name + ' (' + fam + ' / ' + mode + '): voxels identical', d === 0, d ? d + ' voxels differ' : (full.reduce((a, b) => a + b, 0) / N3 * 100).toFixed(1) + ' % solid');

  const kept = L('pruneVoxels')(full, N, fam, { connectivity: 'networks', pruneLargest: true });
  const mg = L('buildVoxelMargin')(fam, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  let dm = 0; for (let p = 0; p < N3; p++) if (mg.m[p] !== m[p]) dm++;
  const pvFull = L('voxelFractionsFromMargin')(mg, N, kept, full, 4);
  const pv = Float32Array.from(kept);
  for (const sl of slabs) {
    const mRows = rowList(N, sl[0], sl[1], 0, 1), kRows = rowList(N, sl[0], sl[1], 1, 1);
    pv.set(call({ type: 'pv', recipe: r, N, key: name, i0: sl[0], i1: sl[1], sub: 4, mRows, m: pack(m, N, mRows), kRows,
                  kept: pack(kept, N, kRows), raw: kept !== full ? pack(full, N, kRows) : null }).v, sl[0] * NN);
  }
  let dp = 0; for (let p = 0; p < N3; p++) if (pv[p] !== pvFull[p]) dp++;
  check(name + ': margin + partial volume identical', dm === 0 && dp === 0, (dm || dp) ? dm + ' margin / ' + dp + ' fraction values differ' : '');
}
/* 3. v0.35.2 — Crush prep on the pool (17c labPrepCrushParallel): the grid handed to the crush solver
   must be bit-identical to what NonlinearSolverFull.upload builds on the main thread (16g: buildVoxels,
   then pruneVoxels with the run's connectivity options when pruneLargest).  The pool is replaced by
   the real message handler run in place; every recipe at 32³ and 64³, connectivity networks / largest
   / off; plus the reuse of an elastic prep of the same recipe object. */
(async () => {
  L('_tvCanUseWorkers = function () { return true; }');
  ctx.__call = call;
  L('_tvRun = function (msg) { return Promise.resolve(__call(msg)); }');
  for (const NC of [32, 64]) for (const conn of ['networks', 'largest', 'off']) {
    let bad = [];
    for (const name of Object.keys(recipes)) {
      const r = recipes[name], fam = r.family, opts = { connectivity: conn, pruneLargest: conn !== 'off', partialVolume: false, voidContrast: 1e-4 };
      const args = L('resolveBuildArgs')(r), params = L('KERNELS')[fam].parseRecipe(r);
      let ref = L('buildVoxels')(fam, params, args.offset, NC, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
      if (opts.pruneLargest) ref = L('pruneVoxels')(ref, NC, fam, opts);   /* as 16g upload */
      L('_TV_CRUSH_CACHE = null; _TV_PREP_CACHE = null;');
      const got = await L('labPrepCrushParallel')(r, NC, opts);
      let d = got && got.length === ref.length ? 0 : -1;
      if (d === 0) for (let p = 0; p < ref.length; p++) if (got[p] !== ref[p]) d++;
      if (d) bad.push(name + ' (' + (d < 0 ? 'no grid' : d + ' voxels') + ')');
    }
    check('crush grid ' + NC + '³, connectivity ' + conn + ': identical on ' + Object.keys(recipes).length + ' recipes', !bad.length, bad.join(', '));
  }
  /* reuse: the elastic prep of the same recipe object (one-entry cache) gives the same kept grid */
  {
    const r = recipes.schwarzP, opts = { connectivity: 'networks', pruneLargest: true, partialVolume: true, voidContrast: 1e-4 };
    L('_TV_CRUSH_CACHE = null; _TV_PREP_CACHE = null;');
    await L('labPrepElasticParallel')(r, 32, opts);
    const reused = await L('labPrepCrushParallel')(r, 32, opts);
    L('_TV_CRUSH_CACHE = null; _TV_PREP_CACHE = null;');
    const fresh = await L('labPrepCrushParallel')(r, 32, opts);
    let d = 0; for (let p = 0; p < fresh.length; p++) if (reused[p] !== fresh[p]) d++;
    check('crush grid reused from the elastic prep: identical', d === 0, d ? d + ' voxels differ' : '');
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
