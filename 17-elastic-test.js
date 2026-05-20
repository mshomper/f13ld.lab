/* ============================================================
   F13LD.lab · 17-elastic-test.js
   Verifies the GPU elastic FFT-CG solver end-to-end:
     parseRecipe → buildVoxels → buildGammaFull → CG homogenization
       → Ex / Ey / Ez / Gxy / Gxz / Gyz

   Solver method (Phase 4 push 4a):
     This test drives solveDesignElasticFull, the full 6-strain
     FFT-CG solver (3 normal + 3 shear load cases per design).
     The result is the complete 6×6 effective stiffness tensor,
     from which the three Young's moduli, three shear moduli,
     three Poisson ratios, and the Zener anisotropy ratio are
     derived.  This is the lab's production qualification path.

     F13LD.sweep continues to use the normal-strain-only solver
     (solveDesignElastic) for fast triage across thousands of
     recipes — that path stays available in 16-elastic-solver.js
     for future use cases requiring sub-second feedback.  Lab is
     the deep-compute home; the full tensor lives here.

   Self-test pass criteria for Schwarz P (most-tested demo):
     1. CG converges in ≤ CG_MAXITER_FULL iters on all 6 load cases
     2. Cubic isotropy: max(|Ex-Ey|, |Ey-Ez|, |Ez-Ex|)/Ex < 1.5%
        (Schwarz P has cubic point group; the solver should respect
         this near machine precision.  Verified at 0.00% in CPU
         reference at N=16.)
     3. Magnitude in expected FULL-VOIGT band:
        E_eff/Es ∈ [0.25, 0.34]  for Schwarz P solid at ρ=0.5.
        With Ti-6Al-4V Es=110 GPa → ~27.5–37 GPa.  CPU/GPU
        cross-validated at N=16: 32.35 GPa = 0.294·Es.  Same
        regime expected at N=64.
     4. All Ex/Ey/Ez under 1.05 × Voigt upper bound (ρ × Es) —
        full-Voigt removes the normal-only overshoot, so Voigt
        is a hard ceiling with only finite-precision slop allowed.

   Spinodoid and Hyperuniform get a softer test (no isotropy check
   since they're directionally biased; just convergence + magnitude
   under 1.05 × Voigt).
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

  /* Drain any pre-existing uncaptured GPU errors so we attribute fresh ones
     to this run.  Pipeline-creation errors from a prior solver instance
     could otherwise leak into our diagnostics. */
  drainGpuErrors();

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
      var res = await solveDesignElasticFull(recipe, N);
      var totalThis = performance.now() - t0;
      totalMs += totalThis;

      /* Surface any uncaptured GPU errors that happened during this design.
         Silent pipeline failures (e.g., kernel exceeded a per-stage limit)
         leave the dispatches as no-ops, which produces wrong numbers
         WITHOUT throwing.  Drain after each design to attribute. */
      var gpuErrs = drainGpuErrors();
      if (gpuErrs.length) {
        console.error('[elastic-test] GPU errors during ' + entry.id + ':\n  ' + gpuErrs.join('\n  '));
        allOK = false;
        results.push({ id: entry.id, gpuErrors: gpuErrs, res: res, totalMs: totalThis });
        paintElasticLink('fail', '✗ ' + entry.id + ' · GPU errors · check console');
        return;
      }

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
    if (r.gpuErrors) return r.id + ':gpu-err';
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

   Full-Voigt pass logic (Phase 4 push 4a):
     With all six load cases solved, Voigt rule-of-mixtures
     (ρ·Es) is a TRUE upper bound for the effective stiffness
     of any heterogeneous microstructure — there's no normal-
     only overshoot to allow for.  The 1.05× ceiling here is
     just finite-precision slop (float32 GPU + finite-N FFT-CG
     rounding); any result above that signals a real solver
     defect (e.g. a kernel no-oping into the identity map).

     Schwarz P at ρ=0.5 is the strictest gate: cubic symmetry
     means Ex=Ey=Ez to machine precision, and the magnitude
     band E/Es ∈ [0.25, 0.34] flags both under-shoot (lossy
     solver, wrong sign convention) and over-shoot (Voigt
     overshoot from a stray normal-only constraint leak).
   ============================================================ */
function checkResult(id, res) {
  var ck = { ok: true, notes: [] };

  if (!res.valid) { ck.ok = false; ck.notes.push('stiffness matrix singular'); return ck; }
  if (!res.converged) { ck.ok = false; ck.notes.push('CG did not converge in ' + CG_MAXITER_FULL + ' iters/load case'); }

  var Ex = res.Ex_MPa, Ey = res.Ey_MPa, Ez = res.Ez_MPa;
  var Es = res.Es_MPa;
  var voigtUpper = res.rho * Es + (1 - res.rho) * Es * 1e-4;

  /* Voigt rule-of-mixtures is a hard upper bound under full-Voigt.
     1.05× allowance is for FP32 + finite-N rounding only. */
  if (Ex > voigtUpper * 1.05 || Ey > voigtUpper * 1.05 || Ez > voigtUpper * 1.05) {
    ck.ok = false;
    ck.notes.push('exceeds 1.05× Voigt ceiling = ' + (voigtUpper*1.05/1000).toFixed(1) + ' GPa (real defect under full-Voigt)');
  }
  if (Ex < 0 || Ey < 0 || Ez < 0) {
    ck.ok = false; ck.notes.push('negative stiffness — solver inverted');
  }

  if (id === 'schwarzP') {
    /* Cubic isotropy — verified at 0.00% in CPU reference at N=16.
       Allow 1.5% slop for FP32 + GPU rounding differences. */
    var emax = Math.max(Math.max(Ex, Ey), Ez);
    var emin = Math.min(Math.min(Ex, Ey), Ez);
    var anisoFrac = (emax - emin) / emax;
    if (anisoFrac > 0.015) {
      ck.ok = false; ck.notes.push('isotropy broken: |max-min|/max = ' + (anisoFrac*100).toFixed(2) + '% (expected < 1.5%)');
    }
    /* Magnitude band — full-Voigt expected E/Es ∈ [0.25, 0.34] for ρ=0.5.
       CPU/GPU cross-validated at N=16: 0.294 · Es ≈ 32.35 GPa. */
    var avgE = (Ex + Ey + Ez) / 3;
    var ratio = avgE / Es;
    if (ratio < 0.25 || ratio > 0.34) {
      ck.ok = false;
      ck.notes.push('mean E/Es = ' + ratio.toFixed(3) + ' outside expected band [0.25, 0.34] for full-Voigt FFT-CG');
    } else {
      ck.notes.push('mean E/Es = ' + ratio.toFixed(3) + ' · in band [0.25, 0.34] (full-Voigt ref ≈ 0.294)');
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

  /* Per-LC breakdown helps diagnose silent solver failures (e.g., a kernel
     that no-ops will show iters=1 with breakReason='pAp_zero' across all
     six LCs — a fingerprint we don't want to hide in the totals). */
  var lcLine = '';
  if (res.perLC && res.perLC.length === 6) {
    lcLine = '\n  per-LC:        ' + res.perLC.map(function(p){
      return p.axis + ':' + p.iters + '·' + p.breakReason;
    }).join('  ');
  }

  /* Full-Voigt provides true shear moduli and Zener anisotropy — log them
     so the smoke test surfaces the full 6×6 information at a glance. */
  var Gxy_GPa  = (res.Gxy_MPa  != null) ? (res.Gxy_MPa  / 1000).toFixed(3) : '—';
  var Gxz_GPa  = (res.Gxz_MPa  != null) ? (res.Gxz_MPa  / 1000).toFixed(3) : '—';
  var Gyz_GPa  = (res.Gyz_MPa  != null) ? (res.Gyz_MPa  / 1000).toFixed(3) : '—';
  var zenerStr = (res.zenerA   != null && isFinite(res.zenerA)) ? res.zenerA.toFixed(4) : '—';
  var nuxy     = (res.nu_xy    != null) ? res.nu_xy.toFixed(3) : '—';
  var nuxz     = (res.nu_xz    != null) ? res.nu_xz.toFixed(3) : '—';
  var nuyz     = (res.nu_yz    != null) ? res.nu_yz.toFixed(3) : '—';

  console.log(
    '%c ' + (checks.ok ? '✓' : '✗') + ' ' + res.name + ' ',
    'background:' + bg + '; color:' + fg + '; font-weight:bold; padding:2px 8px; border-radius:3px;',
    '\n  family:        ' + res.family + ' · mode: ' + res.mode +
    '\n  ρ (VF):        ' + (res.rho * 100).toFixed(2) + '%' +
    '\n  Ex / Ey / Ez:  ' + (res.Ex_MPa/1000).toFixed(3) + ' / ' +
                            (res.Ey_MPa/1000).toFixed(3) + ' / ' +
                            (res.Ez_MPa/1000).toFixed(3) + ' GPa' +
    '\n  Gxy/Gxz/Gyz:   ' + Gxy_GPa + ' / ' + Gxz_GPa + ' / ' + Gyz_GPa + ' GPa' +
    '\n  ν_xy/xz/yz:    ' + nuxy + ' / ' + nuxz + ' / ' + nuyz +
    '\n  Zener A:       ' + zenerStr + '   (A=1 isotropic, A<1 stiff along [100], A>1 stiff along [111])' +
    '\n  mean E:        ' + (avgE/1000).toFixed(3) + ' GPa  ' +
                            '(E/Es = ' + (avgE/res.Es_MPa).toFixed(4) + ')' +
    '\n  Voigt upper:   ' + (voigtUpper/1000).toFixed(2) + ' GPa  (ρ·Es)' +
    '\n  anisotropy:    ' + aniso + '%  (|max-min|/max)' +
    '\n  CG iters:      ' + res.iters + ' total · converged: ' + res.converged +
    lcLine +
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
