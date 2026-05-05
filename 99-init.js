/* ============================================================
   F13LD.lab · 99-init.js
   Boot sequence. Runs after all numbered scripts have loaded.
   Detects hardware, picks initial grid, paints controls,
   handles ?r= URL param, and triggers first render.
   ============================================================ */

(function init(){
  // 1. Hardware detection (async — paints the pill when done)
  detectHardware().then(function(){
    // Auto-pick grid based on detected hardware
    if (GRID_STATE.mode === 'auto'){
      GRID_STATE.N = autoPickGrid();
      paintGridPill();
      recomputeEstimate();
    }
  });

  // 2. Initial pill paint (placeholder until detection completes)
  paintGridPill();
  paintHardwarePill('detecting…', '');
  paintSolverPill('starting…', '');
  updateLoadedPill();
  updateActionButtons();
  recomputeEstimate();

  // 3. First render (preloaded demo designs are already in LAB_STATE)
  renderDesignGrid();

  // 4. Handle ?r= URL param (replaces demo set with imported design)
  setTimeout(ingestUrlParam, 50);

  // 5. Window resize — re-render to keep responsive layout sane
  window.addEventListener('resize', function(){
    // Debounce
    clearTimeout(window.__labResizeTimer);
    window.__labResizeTimer = setTimeout(function(){
      renderDesignGrid();
    }, 150);
  });

  console.log('%c F13LD.lab · v0.1.0-shell ', 'background:#fbbf24; color:#1a1408; font-weight:bold; padding:2px 8px; border-radius:3px;');
  console.log('Phase 1 · UI shell · no compute yet · all run output is mock');
})();
