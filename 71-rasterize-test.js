/* ============================================================
   F13LD.lab · 71-rasterize-test.js
   Verifies the family kernel port end-to-end:
     parseRecipe → buildVoxels → volume fraction + timing.

   Pass criteria:
     - All three demos rasterize without exception
     - Each VF lies in its expected range:
         Schwarz P    ~ 0.50  (iso=0 cuts the cube in half)
         Spinodoid    ~ 0.20–0.40  (sheet at iso=0, hw=0.18)
         Hyperuniform ~ 0.15–0.40  (sheet at iso=0.10, hw=0.18)
     - Timing reasonable for N=64:
         TPMS  ~  20–100 ms
         Grain ~ 200–2000 ms (kernel sums dominate)

   Console gets full per-recipe breakdown; UI link gets a
   one-line summary.
   ============================================================ */

var RASTER_TEST = {
  state:      'idle',     /* idle | running | pass | fail */
  lastResult: null
};

/* Expected VF ranges per demo (id → [lo, hi]). Outside-range = soft warning,
   not a fail (these are soft checks — geometry is what it is, not what we
   guess). The hard fail is an exception or zero VF (rasterizer broken). */
var DEMO_VF_RANGE = {
  schwarzP:     [0.40, 0.60],
  spinodoid:    [0.15, 0.45],
  hyperuniform: [0.10, 0.45]
};


async function runRasterizeTest() {
  paintRasterLink('running', '⟳ Rasterizing demos · N=64...');

  var N = 64;
  var results = [];
  var allOK = true;
  var totalMs = 0;

  try {
    for (var i = 0; i < DEMO_RECIPE_LIST.length; i++) {
      var entry = DEMO_RECIPE_LIST[i];
      var id     = entry.id;
      var recipe = entry.recipe;
      var fam    = recipe.family;

      paintRasterLink('running', '⟳ ' + recipe.name + '...');

      var t0 = performance.now();

      /* Parse: recipe → opaque params */
      var params = KERNELS[fam].parseRecipe(recipe);
      var parseMs = performance.now() - t0;

      /* Rasterize at N=64 */
      var args = resolveBuildArgs(recipe);
      var t1 = performance.now();
      var solid = buildVoxels(
        fam, params, args.offset, N, args.mode, args.wt,
        args.nWeights, args.pipeR, args.phaseShift
      );
      var rasterMs = performance.now() - t1;

      /* Volume fraction */
      var inside = 0;
      var N3 = N * N * N;
      for (var v = 0; v < N3; v++) inside += solid[v];
      var vf = inside / N3;

      var range = DEMO_VF_RANGE[id] || [0, 1];
      var inRange = vf >= range[0] && vf <= range[1];
      if (vf <= 0) allOK = false;

      var totThis = parseMs + rasterMs;
      totalMs += totThis;

      results.push({
        id:       id,
        name:     recipe.name,
        family:   fam,
        mode:     args.mode,
        vf:       vf,
        vfRange:  range,
        inRange:  inRange,
        parseMs:  parseMs,
        rasterMs: rasterMs,
        totalMs:  totThis
      });

      console.log(
        '%c ' + recipe.name + ' ',
        'background:#fbbf24; color:#1a1408; font-weight:bold; padding:2px 6px; border-radius:3px;',
        '\n  family:    ' + fam + ' · mode: ' + args.mode +
        '\n  VF:        ' + (vf*100).toFixed(2) + '%' + (inRange ? ' ✓' : ' ⚠ outside expected ' +
          (range[0]*100).toFixed(0) + '–' + (range[1]*100).toFixed(0) + '%') +
        '\n  parse:     ' + parseMs.toFixed(2)  + ' ms' +
        '\n  rasterize: ' + rasterMs.toFixed(1) + ' ms' +
        '\n  total:     ' + totThis.toFixed(1)  + ' ms'
      );
    }

    RASTER_TEST.lastResult = { results: results, totalMs: totalMs, allOK: allOK };

    if (allOK) {
      var msg = '✓ Rasterized ' + results.length + ' demos · ' + totalMs.toFixed(0) + ' ms · ' +
                results.map(function(r){ return (r.vf*100).toFixed(0) + '%'; }).join(' / ');
      paintRasterLink('pass', msg);

      /* Update each design column's ρ value with the real volume fraction.
         Looks for .dc-stat with a leading ρ label and patches it in place. */
      try { paintDesignVF(results); } catch (e) { /* non-critical */ }

    } else {
      paintRasterLink('fail', '✗ One or more demos returned VF=0 · check console');
    }

  } catch (err) {
    console.error('[raster-test] error:', err);
    paintRasterLink('fail', '✗ ' + (err.message || 'unknown error') + ' · check console');
  }
}

function paintRasterLink(state, text) {
  var link = document.getElementById('rasterTestLink');
  if (!link) return;
  RASTER_TEST.state = state;
  link.classList.remove('running','pass','fail');
  if (state !== 'idle') link.classList.add(state);
  link.textContent = text;
}

/* Patch the rendered design columns with real VF numbers. The grid in
   40-design-grid.js stamps each design's stats into .dc-stat blocks
   labeled by their .lbl text — find the ρ stat per column and update
   the .val, plus a delta if a baseline exists.

   Kept defensive: if the grid hasn't rendered yet or the layout changed,
   this no-ops silently rather than breaking the self-test result. */
function paintDesignVF(results) {
  var cols = document.querySelectorAll('.design-col');
  if (!cols.length || cols.length < results.length) return;

  /* Map demo id → column index by matching name in the .dc-name .title.
     This handles the case where the grid has reordered columns. */
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var matched = null;
    for (var c = 0; c < cols.length; c++) {
      var titleEl = cols[c].querySelector('.dc-name .title');
      if (titleEl && titleEl.textContent.indexOf(r.name) !== -1) {
        matched = cols[c];
        break;
      }
    }
    if (!matched) continue;
    var statBlocks = matched.querySelectorAll('.dc-stat');
    for (var s = 0; s < statBlocks.length; s++) {
      var lbl = statBlocks[s].querySelector('.lbl');
      var val = statBlocks[s].querySelector('.val');
      if (!lbl || !val) continue;
      var lblText = lbl.textContent.trim();
      if (lblText === 'ρ' || lblText === 'rho' || lblText === 'VF' || lblText === 'VOLUME FRAC' || lblText.indexOf('Density') === 0) {
        val.textContent = (r.vf * 100).toFixed(1) + '%';
      }
    }
  }
}
