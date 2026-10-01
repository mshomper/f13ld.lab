/* ============================================================
   F13LD.lab · 99-init.js
   Boot sequence. Runs after all numbered scripts have loaded.
   Detects hardware, picks initial grid, paints controls,
   handles ?r= URL param, and triggers first render.
   ============================================================ */

(function init(){
  // 1. Hardware detection (async — paints the pill when done)
  detectHardware().then(function(){
    if (GRID_STATE.mode === 'auto'){
      GRID_STATE.N = autoPickGrid();
      paintGridPill();
      recomputeEstimate();
    }
  });

  // 2. Initial pill paint (placeholder until detection completes)
  paintGridPill();
  paintBucklePill();
  if (typeof initMaterialPicker === 'function') initMaterialPicker();
  paintHardwarePill('detecting…', '');
  paintSolverPill('starting…', '');
  updateLoadedPill();
  updateActionButtons();
  recomputeEstimate();

  // 3. First render (preloaded demo designs are already in LAB_STATE)
  renderDesignGrid();

  // 3b. Imported STL cells: load their grids from IndexedDB, then re-render
  //     (until then their cards show the SVG fallback and runs skip them)
  if (typeof hydrateImportGrids === 'function'){
    hydrateImportGrids().then(function(changed){ if (changed) renderDesignGrid(); })
      .catch(function(e){ console.warn('[import] grid restore failed:', e); });
  }

  // 4. Handle ?r= URL param (replaces demo set with imported design)
  setTimeout(ingestUrlParam, 50);

  // 5. Window resize — re-render to keep responsive layout sane
  window.addEventListener('resize', function(){
    clearTimeout(window.__labResizeTimer);
    window.__labResizeTimer = setTimeout(function(){
      renderDesignGrid();
    }, 150);
  });

  console.log('%c F13LD.lab · v0.12.1 ', 'background:#fbbf24; color:#1a1408; font-weight:bold; padding:2px 8px; border-radius:3px;');
  console.log('Phase 6 · nonlinear J2 plasticity + adaptive crush live · real σ_y retires the buckling seam · σ–ε comparison tab');
  console.log('Loaded demo recipes: ' + Object.keys(DEMO_RECIPES).join(', '));
})();
