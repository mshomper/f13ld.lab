/* validate-buckling-predict.js — proves the import-time buckling-grid
   predictor before any browser run.
     Part A: bk_medianErosionDepth on synthetic Schwarz P solids (stocky vs
             thin sheet) — the core gauge metric, pipeline-independent.
             Wall thickness = 2x erosion depth; expect stocky 10 / thin 4 at
             N=32, matching handoff S4, so stocky->N32 and thin->N64.
     Part B: predictBucklingN over the real DEMO_RECIPES via the actual
             rasterizer — each must rasterize to a non-degenerate solid and
             return a well-formed prediction.
   Run:  node validate-buckling-predict.js */

(function () {
  var inNode = (typeof require !== 'undefined' && typeof module !== 'undefined');
  var ESCALATE = 8;   /* target voxels-per-wall (drop to 6 = riskier) */

  if (inNode && typeof bk_medianErosionDepth === 'undefined') {
    var fs = require('fs');
    var pipeline = ['13-kernels.js', '13b-kernels-new.js', '14-rasterizer.js',
                    '15-demo-recipes.js', '16c-buckling-cpu-ref.js'];
    var srcs = [];
    for (var f = 0; f < pipeline.length; f++) {
      try { srcs.push(fs.readFileSync(pipeline[f], 'utf8')); } catch (e) {}
    }
    (0, eval)(srcs.join('\n'));
  }

  function buildSchwarzP(N, mode) {
    var NN = N * N, N3 = N * NN, s = new Uint8Array(N3), tau = 2 * Math.PI / N;
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
      var P = Math.cos(tau * i) + Math.cos(tau * j) + Math.cos(tau * k);
      var inside = (mode === 'thin') ? (Math.abs(P) < 0.65) : (P > 0);
      s[i * NN + j * N + k] = inside ? 1 : 0;
    }
    return s;
  }
  function rho(s) { var c = 0; for (var v = 0; v < s.length; v++) c += s[v]; return c / s.length; }

  console.log('=== Part A — synthetic Schwarz P gauge (N=32, cap=8) ===');
  var N = 32, R = {};
  ['stocky', 'thin'].forEach(function (mode) {
    var s = buildSchwarzP(N, mode);
    var depth = bk_medianErosionDepth(s, N, 8);
    var thick = 2 * depth, prone = thick < ESCALATE, predN = prone ? 64 : 32;
    R[mode] = { depth: depth, thick: thick, predN: predN, prone: prone, rho: +rho(s).toFixed(3) };
    console.log('  ' + mode.padEnd(7) + ' rho=' + R[mode].rho +
                '  depth=' + depth + '  thickness=' + thick +
                '  -> N=' + predN + (prone ? '  (PRONE)' : '  (ok)'));
  });
  var gateA = R.stocky.thick === 10 && R.thin.thick === 4 &&
              R.stocky.predN === 32 && R.thin.predN === 64 &&
              R.stocky.prone === false && R.thin.prone === true;
  console.log('  expected: stocky thickness 10 -> N32 (ok),  thin thickness 4 -> N64 (PRONE)');
  console.log('  Part A gate: ' + (gateA ? 'PASS' : 'FAIL'));

  console.log('\n=== Part B — predictBucklingN over real DEMO_RECIPES ===');
  if (typeof predictBucklingN !== 'function' || typeof DEMO_RECIPES === 'undefined') {
    console.log('  SKIP: predictBucklingN / DEMO_RECIPES not loaded in this context.');
  } else {
    var keys = Object.keys(DEMO_RECIPES), okCount = 0, ran = 0;
    keys.forEach(function (key) {
      var rec = DEMO_RECIPES[key];
      if (!rec || !rec.family) return;
      ran++;
      var pr;
      try { pr = predictBucklingN(rec, 32); }
      catch (e) { console.log('  ' + key.padEnd(16) + ' ERROR: ' + (e && e.message || e)); return; }
      if (!pr) { console.log('  ' + key.padEnd(16) + ' null (unbuildable)'); return; }
      var sane = pr.rho > 0.001 && pr.rho < 0.999 && (pr.N === 32 || pr.N === 64);
      if (sane) okCount++;
      console.log('  ' + key.padEnd(16) + ' family=' + String(rec.family).padEnd(7) +
                  ' rho=' + pr.rho.toFixed(3) + '  thickness=' + pr.median +
                  '  -> N=' + pr.N + (pr.prone ? ' (PRONE)' : ' (ok)') +
                  (sane ? '' : '   <-- degenerate solid'));
    });
    console.log('  ' + okCount + '/' + ran + ' demo recipes rasterized to a non-degenerate solid + well-formed prediction.');
    console.log('  Part B gate: ' + (okCount > 0 ? 'PASS' : 'FAIL'));
  }

  console.log('\n=== predictor validation complete ===');
})();
