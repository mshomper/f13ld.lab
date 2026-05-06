/* ============================================================
   F13LD.lab · 17-elastic-test.js
   Verifies the GPU elastic FFT-CG solver end-to-end:
     parseRecipe → buildVoxels → buildGamma → CG homogenization
       → Ex / Ey / Ez

   IMPORTANT — solver method and its limits:
     This solver mirrors F13LD.sweep's cgSolveNormal: a NORMAL-
     STRAIN-ONLY approximation that solves three load cases (xx,
     yy, zz) and pins local shear strains to zero everywhere.
     Exact for the macro response of isotropic constituents under
     pure normal loading — but for heterogeneous microstructures
     it OVERESTIMATES effective stiffness by ~10-20% versus full
     6-strain FFT-CG (because shear DOFs that would localize stress
     at material boundaries are constrained out).

     Sweep uses this approximation knowingly for design RANKING
     across thousands of recipes.  Lab inherits it for Phase 3
     and lifts to full 6-strain (with shear cases yz, xz, xy)
     in Phase 4 alongside the directional stiffness surface viz.

   Self-test 3 pass criteria for Schwarz P (most-tested demo):
     1. CG converges in ≤ CG_MAXITER iters on all 3 load cases
     2. Cubic isotropy: max(|Ex-Ey|, |Ey-Ez|, |Ez-Ex|)/Ex < 1.5%
        (Schwarz P has cubic point group; the solver should respect
         this near machine precision.  Verified at 0.00% in CPU
         reference at N=8/16/32.)
     3. Magnitude in expected NORMAL-ONLY band:
        E_eff/Es ∈ [0.40, 0.55]  for Schwarz P solid at ρ=0.5.
        With Ti-6Al-4V Es=110 GPa → 44–60 GPa.  CPU reference at
        all of N=8/16/32 lands at 0.49 ± 0.001 · Es ≈ 54 GPa.
        Same expected range here.
     4. All Ex/Ey/Ez under the Voigt upper bound (ρ × Es = 55 GPa)
        — sanity check that we're below the maximum-mixing limit.
        Note: 0.49·Es leaves only 5 GPa of headroom against Voigt;
        a tighter check would be brittle, so we use 1.05·Voigt as
        the hard cap.

   Spinodoid and Hyperuniform get a softer test (no isotropy check
   since they're directionally biased; just convergence + magnitude
   between Reuss-like 0 and Voigt-like ρ·Es).
   ============================================================ */

var ELASTIC_TEST = {
  state:      'idle',
  lastResult: null
};

async function runElasticTest() {
  paintElasticLink('running', '⟳ Initializing solver...');

  try {
    await ensureDevice();
  } catch (err) {
    paintElasticLink('fail', '✗ ' + (err.message || 'WebGPU init failed'));
    return;
  }

  var N = 64;
  var results = [];
  var allOK   = true;
  var totalMs = 0;

  for (var i = 0; i < DEMO_RECIPE_LIST.length; i++) {
    var entry  = DEMO_RECIPE_LIST[i];
    var recipe = entry.recipe;

    paintElasticLink('running', '⟳ ' + recipe.name + ' · CG...');

    try {
      var t0 = performance.now();
      var res = await solveDesignElastic(recipe, N);
      var totalThis = performance.now() - t0;
      totalMs += totalThis;

      /* ── Per-design pass checks ─────────────────────────────────── */
      var checks = checkResult(entry.id, res);
      if (!checks.ok) allOK = false;

      results.push({
        id:        entry.id,
        res:       res,
        totalMs:   totalThis,
        checks:    checks
      });

      logResult(entry.id, res, totalThis, checks);

    } catch (err) {
      console.error('[elastic-test] ' + entry.id + ' failed:', err);
      allOK = false;
      results.push({ id: entry.id, error: err.message || String(err) });
      paintElasticLink('fail', '✗ ' + entry.id + ' threw · check console');
      return;
    }
  }

  ELASTIC_TEST.lastResult = { results: results, totalMs: totalMs, allOK: allOK };

  /* Final summary line */
  var summary = results.map(function(r){
    if (r.error) return r.id + ':err';
    var avgE = (r.res.Ex_MPa + r.res.Ey_MPa + r.res.Ez_MPa) / 3;
    return (avgE / 1000).toFixed(1) + ' GPa';
  }).join(' / ');

  if (allOK) {
    paintElasticLink('pass',
      '✓ Elastic 64³ · ' + (totalMs/1000).toFixed(1) + ' s · E̅ = ' + summary);
  } else {
    paintElasticLink('fail',
      '⚠ Elastic 64³ · ' + (totalMs/1000).toFixed(1) + ' s · E̅ = ' + summary + ' · checks failed (see console)');
  }

  /* Patch real E11 into the design cards (cosmetic) */
  try { paintDesignE(results); } catch (e) { /* non-critical */ }
}


/* ============================================================
   checkResult — apply the per-design pass criteria
   ============================================================ */
function checkResult(id, res) {
  var ck = { ok: true, notes: [] };

  if (!res.valid) { ck.ok = false; ck.notes.push('stiffness matrix singular'); return ck; }
  if (!res.converged) { ck.ok = false; ck.notes.push('CG did not converge in ' + CG_MAXITER + ' iters/load case'); }

  var Ex = res.Ex_MPa, Ey = res.Ey_MPa, Ez = res.Ez_MPa;
  var Es = res.Es_MPa;
  var voigtUpper = res.rho * Es;

  if (Ex > voigtUpper * 1.05 || Ey > voigtUpper * 1.05 || Ez > voigtUpper * 1.05) {
    ck.ok = false; ck.notes.push('exceeds Voigt bound ρ·Es = ' + (voigtUpper/1000).toFixed(1) + ' GPa');
  }
  if (Ex < 0 || Ey < 0 || Ez < 0) {
    ck.ok = false; ck.notes.push('negative stiffness — solver inverted');
  }

  if (id === 'schwarzP') {
    /* Cubic isotropy — verified at 0.00% in CPU reference at N=8/16/32.
       Allow 1.5% slop for FP32 + GPU rounding differences. */
    var emax = Math.max(Math.max(Ex, Ey), Ez);
    var emin = Math.min(Math.min(Ex, Ey), Ez);
    var anisoFrac = (emax - emin) / emax;
    if (anisoFrac > 0.015) {
      ck.ok = false; ck.notes.push('isotropy broken: |max-min|/max = ' + (anisoFrac*100).toFixed(2) + '% (expected < 1.5%)');
    }
    /* Magnitude band — normal-only FFT-CG expected E/Es ∈ [0.40, 0.55] for ρ=0.5.
       CPU reference: 0.49 · Es ≈ 54 GPa for Es=110 GPa. */
    var avgE = (Ex + Ey + Ez) / 3;
    var ratio = avgE / Es;
    if (ratio < 0.40 || ratio > 0.55) {
      ck.ok = false;
      ck.notes.push('mean E/Es = ' + ratio.toFixed(3) + ' outside expected band [0.40, 0.55] for normal-only FFT-CG');
    } else {
      ck.notes.push('mean E/Es = ' + ratio.toFixed(3) + ' · in band [0.40, 0.55] (normal-only ref ≈ 0.49)');
    }
  }

  return ck;
}


/* ============================================================
   logResult — pretty-print a per-design result block to console
   ============================================================ */
function logResult(id, res, totalMs, checks) {
  var avgE = (res.Ex_MPa + res.Ey_MPa + res.Ez_MPa) / 3;
  var voigtUpper = res.rho * res.Es_MPa;
  var emax = Math.max(Math.max(res.Ex_MPa, res.Ey_MPa), res.Ez_MPa);
  var emin = Math.min(Math.min(res.Ex_MPa, res.Ey_MPa), res.Ez_MPa);
  var aniso = ((emax - emin) / emax * 100).toFixed(2);

  var bg = checks.ok ? '#34d399' : '#fb7185';
  var fg = checks.ok ? '#06080f' : '#fff';

  console.log(
    '%c ' + (checks.ok ? '✓' : '✗') + ' ' + res.name + ' ',
    'background:' + bg + '; color:' + fg + '; font-weight:bold; padding:2px 8px; border-radius:3px;',
    '\n  family:        ' + res.family + ' · mode: ' + res.mode +
    '\n  ρ (VF):        ' + (res.rho * 100).toFixed(2) + '%' +
    '\n  Ex / Ey / Ez:  ' + (res.Ex_MPa/1000).toFixed(3) + ' / ' +
                            (res.Ey_MPa/1000).toFixed(3) + ' / ' +
                            (res.Ez_MPa/1000).toFixed(3) + ' GPa' +
    '\n  mean E:        ' + (avgE/1000).toFixed(3) + ' GPa  ' +
                            '(E/Es = ' + (avgE/res.Es_MPa).toFixed(4) + ')' +
    '\n  Voigt upper:   ' + (voigtUpper/1000).toFixed(2) + ' GPa  (ρ·Es)' +
    '\n  anisotropy:    ' + aniso + '%  (|max-min|/max)' +
    '\n  CG iters:      ' + res.iters + ' total · converged: ' + res.converged +
    '\n  rasterize:     ' + res.tRast_ms.toFixed(0) + ' ms' +
    '\n  Γ build:       ' + res.tGamma_ms.toFixed(0) + ' ms' +
    '\n  CG solve:      ' + res.tCG_ms.toFixed(0) + ' ms' +
    '\n  total:         ' + totalMs.toFixed(0) + ' ms' +
    (checks.notes.length ? '\n  notes:         ' + checks.notes.join(' · ') : '')
  );
}


/* ============================================================
   paintElasticLink / paintDesignE — UI surface
   ============================================================ */
function paintElasticLink(state, text) {
  var link = document.getElementById('elasticTestLink');
  if (!link) return;
  ELASTIC_TEST.state = state;
  link.classList.remove('running','pass','fail');
  if (state !== 'idle') link.classList.add(state);
  link.textContent = text;
}

/* Patch the design column .dc-stat blocks with real E11 (mean of Ex/Ey/Ez).
   Best-effort: silently no-ops if the card structure has shifted. */
function paintDesignE(results) {
  var cols = document.querySelectorAll('.design-col');
  if (!cols.length) return;

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r.error) continue;

    /* Match by recipe.name appearing in title */
    var matched = null;
    for (var c = 0; c < cols.length; c++) {
      var titleEl = cols[c].querySelector('.dc-name .title');
      if (titleEl && titleEl.textContent.indexOf(r.res.name) !== -1) {
        matched = cols[c];
        break;
      }
    }
    if (!matched) continue;

    var avgE_GPa = (r.res.Ex_MPa + r.res.Ey_MPa + r.res.Ez_MPa) / 3 / 1000;
    var statBlocks = matched.querySelectorAll('.dc-stat');
    for (var s = 0; s < statBlocks.length; s++) {
      var lbl = statBlocks[s].querySelector('.lbl');
      var val = statBlocks[s].querySelector('.val');
      if (!lbl || !val) continue;
      var lblText = lbl.textContent.trim();
      if (lblText === 'E11' || lblText === 'E1' || lblText === 'YOUNG' || lblText.indexOf('Young') === 0) {
        val.textContent = avgE_GPa.toFixed(2) + ' GPa';
      }
    }
  }
}
