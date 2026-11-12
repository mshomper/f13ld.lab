/* F13LD.lab v0.35.2 — Crush prep on the workers, browser-console check (Matt's PC).
   1. Open Lab with your designs loaded (Crush does not need to be on).
   2. Press F12 and paste this one line into the Console, then press Enter:
        fetch('proto/crush-prep/console_check.js').then(r => r.text()).then(eval)
   For every design, at the Crush grid in Configure and your connectivity setting, it builds the Crush
   voxels both ways: on the main thread as before (the page holds still while it runs), and on the
   workers as Run now does.  Every row should read "identical"; the times show what Run no longer
   blocks on.  Nothing is solved and nothing on the page changes. */
(async function () {
  var N = NONLIN_STATE.N, conn = connOpts(), rows = [];
  var recipes = LAB_STATE.designs.map(function (d) { return applySelectedMaterial(recipeForDesign(d)); });   /* as Run resolves them */
  for (var i = 0; i < LAB_STATE.designs.length; i++) {
    var d = LAB_STATE.designs[i], r = recipes[i];
    if (!r || !KERNELS[r.family]) { rows.push({ design: d.label || d.id, result: 'skipped (no recipe)' }); continue; }
    var t0 = performance.now(), fam = r.family, p = KERNELS[fam].parseRecipe(r), a = resolveBuildArgs(r);
    var ref = buildVoxels(fam, p, a.offset, N, a.mode, a.wt, a.nWeights, a.pipeR, a.phaseShift);
    if (conn.pruneLargest) ref = pruneVoxels(ref, N, fam, conn);   /* as the crush solver builds it */
    var tMain = performance.now() - t0;
    _TV_CRUSH_CACHE = null;
    var t1 = performance.now(), got = await labPrepCrushParallel(r, N, conn), tPool = performance.now() - t1;
    var diff = -1;
    if (got && got.length === ref.length) { diff = 0; for (var k = 0; k < ref.length; k++) if (got[k] !== ref[k]) diff++; }
    rows.push({ design: d.label || d.id, grid: N + '³', connectivity: conn.connectivity,
                result: diff === 0 ? 'identical' : (diff < 0 ? 'NO WORKER GRID' : diff + ' voxels differ'),
                main_thread_ms: Math.round(tMain), workers_ms: Math.round(tPool) });
  }
  _TV_CRUSH_CACHE = null;
  console.table(rows);
  var bad = rows.filter(function (x) { return x.result !== 'identical' && x.result.indexOf('skipped') !== 0; });
  console.log(bad.length ? bad.length + ' design(s) differ — send me the table' : 'All Crush grids identical (pool size ' + thermalVoxelPoolInfo().size + ').');
})();
