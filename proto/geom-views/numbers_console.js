/* F13LD.lab v0.36.0 — per-design Geometry numbers, browser-console check (Matt's PC).
   1. Open Lab with your designs, open the Geometry tab.
   2. Press F12 and paste this one line into the Console, then press Enter:
        fetch('proto/geom-views/numbers_console.js').then(r => r.text()).then(eval)
   For every design it measures again, on the worker pool, what the tiles show (thinnest wall,
   tightest gap, tightest radius) and how long each took.  Nothing on the page changes. */
(async function () {
  var conn = connOpts(), rows = [], t00 = performance.now();
  for (var i = 0; i < LAB_STATE.designs.length; i++) {
    var d = LAB_STATE.designs[i], rm = LAB_RM_REGISTRY[d.id];
    if (!rm || !rm._recipe) { rows.push({ design: d.label || d.id, note: 'no tile yet' }); continue; }
    var cell = (isFinite(d.cell_mm) && d.cell_mm > 0) ? d.cell_mm : 5;
    var t0 = performance.now(), wg = await labGeomWallGapAsync(rm._recipe, GEOM_NUM_N, conn), tWG = performance.now() - t0;
    var t1 = performance.now(), rr = rm._geomData ? await labGeomRadiusAsync(rm._geomData, rm._geomDataB, rm._geomN, rm._u) : null, tR = performance.now() - t1;
    rows.push({ design: d.label || d.id,
      thinnest_wall_mm: wg && wg.wallVox != null ? +(wg.wallVox / GEOM_NUM_N * cell).toFixed(3) : null,
      tightest_gap_mm: wg && wg.gapVox != null ? +(wg.gapVox / GEOM_NUM_N * cell).toFixed(3) : null,
      tightest_radius_mm: rr && isFinite(rr.r5) ? +(rr.r5 * cell / (2 * Math.PI)).toFixed(3) : null,
      wall_gap_ms: Math.round(tWG), radius_ms: Math.round(tR) });
  }
  console.table(rows);
  console.log('Pool size ' + thermalVoxelPoolInfo().size + ', total ' + Math.round(performance.now() - t00) + ' ms. The tiles should show the same numbers.');
})();
