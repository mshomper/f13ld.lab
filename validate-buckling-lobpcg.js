/* ============================================================
   F13LD.lab · validate-buckling-lobpcg.js
   PASTE INTO THE BROWSER CONSOLE on the F13LD.lab page.

   Head-to-head drift + speed check for the new Γ⁰-preconditioned
   block LOBPCG eigensolver (bk_lobpcgGen) against the legacy
   exact-inner-solve subspace solver (bk_subspaceGen).

   Both paths target the identical generalized pencil
   (−K_g)·φ = θ·K·φ, so λ_cr MUST agree (no drift); LOBPCG just
   never solves K, so it should be ~50–100× faster and unlock N=32.

   Gate:
     · λ_cr relative drift < 1e-3   (comparative-tool tolerance)
     · critical axis agrees
     · LOBPCG strictly faster
   The synthetic solid is solver-agnostic; the geometry only has to
   produce one connected load path with a finite positive λ_cr.
   ============================================================ */
(function () {
  'use strict';
  if (typeof bucklingFromSolid !== 'function' || typeof isoC !== 'function') {
    console.error('[lobpcg-check] run this on the F13LD.lab page (16c globals not found).');
    return;
  }
  var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : Date.now;
  var Es = 110000, nu = 0.34;                       /* Ti-6Al-4V default, matches homogenizeBucklingCPU */
  var C_s = isoC(Es, nu), C_v = isoC(Es * 1e-4, nu);

  /* synthetic gyroid-ish P-sheet (same family as the 16c B3 self-test gate) */
  function buildSheet(N, thr) {
    var N3 = N * N * N, solid = new Uint8Array(N3), TP = 2 * Math.PI;
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
      var g = Math.sin(TP * i / N) * Math.cos(TP * j / N)
            + Math.sin(TP * j / N) * Math.cos(TP * k / N)
            + Math.sin(TP * k / N) * Math.cos(TP * i / N);
      solid[i * N * N + j * N + k] = (Math.abs(g) < thr) ? 1 : 0;
    }
    return solid;
  }
  function rho(solid) { var s = 0; for (var i = 0; i < solid.length; i++) s += solid[i]; return s / solid.length; }
  function rel(a, b) { return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-30); }
  function critM(res) { for (var i = 0; i < res.perAxis.length; i++) if (res.perAxis[i].axis === res.critAxis) return res.perAxis[i].mWave; return 0; }

  function compareOnSolid(label, solid, N, opts) {
    opts = opts || {};
    var base = { block: opts.block || 4, axes: opts.axes || [0, 1, 2] };
    function timed(method) {
      var o = {}; for (var k in base) o[k] = base[k]; o.eigMethod = method;
      var t0 = now(); var r = bucklingFromSolid(solid, C_s, C_v, N, o); var t1 = now();
      return { r: r, ms: t1 - t0 };
    }
    var sub = timed('subspace');
    var lob = timed('lobpcg');
    var drift = (isFinite(sub.r.lambda_cr) && isFinite(lob.r.lambda_cr)) ? rel(sub.r.lambda_cr, lob.r.lambda_cr) : Infinity;
    var speedup = lob.ms > 0 ? sub.ms / lob.ms : Infinity;
    var pass = drift < 1e-3 && sub.r.critAxis === lob.r.critAxis && lob.ms <= sub.ms;

    console.log('\n=== ' + label + '  (N=' + N + ', ρ=' + rho(solid).toFixed(3) + ', block=' + base.block + ') ===');
    console.log('  subspace (ref) : λ_cr=' + sub.r.lambda_cr.toExponential(3) +
                '  σ_cr=' + (isFinite(sub.r.pcr) ? sub.r.pcr.toFixed(2) + ' MPa' : '—') +
                '  crit=' + sub.r.critAxis + '  m̄=' + critM(sub.r).toFixed(1) +
                '  ' + sub.ms.toFixed(0) + ' ms');
    console.log('  lobpcg  (live) : λ_cr=' + lob.r.lambda_cr.toExponential(3) +
                '  σ_cr=' + (isFinite(lob.r.pcr) ? lob.r.pcr.toFixed(2) + ' MPa' : '—') +
                '  crit=' + lob.r.critAxis + '  m̄=' + critM(lob.r).toFixed(1) +
                '  ' + lob.ms.toFixed(0) + ' ms');
    console.log('  drift(λ_cr rel)=' + drift.toExponential(2) + '   speedup=' + speedup.toFixed(1) + '×   ' + (pass ? '✓ PASS' : '✗ FAIL'));
    return pass;
  }

  var ok = true;
  ok = compareOnSolid('synthetic P-sheet', buildSheet(8, 0.9), 8) && ok;
  ok = compareOnSolid('synthetic P-sheet', buildSheet(16, 1.0), 16) && ok;

  /* optional: run on the live loaded designs (real recipes through the rasterizer) */
  if (typeof homogenizeBucklingCPU === 'function' &&
      typeof LAB_STATE !== 'undefined' && LAB_STATE && LAB_STATE.designs && LAB_STATE.designs.length) {
    var Nlive = 16;
    for (var d = 0; d < LAB_STATE.designs.length; d++) {
      var des = LAB_STATE.designs[d];
      if (!des || !des.recipe) continue;
      try {
        var t0 = now(); var rs = homogenizeBucklingCPU(des.recipe, Nlive, { block: 4, eigMethod: 'subspace' }); var t1 = now();
        var t2 = now(); var rl = homogenizeBucklingCPU(des.recipe, Nlive, { block: 4, eigMethod: 'lobpcg' }); var t3 = now();
        if (rs.skip_reason || rl.skip_reason) { console.log('\n[live] ' + (des.name || des.id) + ' skipped: ' + (rs.skip_reason || rl.skip_reason)); continue; }
        var dr = rel(rs.lambda_cr, rl.lambda_cr), sp = (t3 - t2) > 0 ? (t1 - t0) / (t3 - t2) : Infinity;
        var p = dr < 1e-3 && rs.critAxis === rl.critAxis;
        console.log('\n=== live · ' + (des.name || des.id) + ' (N=' + Nlive + ', ρ=' + (rl.rho || 0).toFixed(3) + ') ===');
        console.log('  subspace λ_cr=' + rs.lambda_cr.toExponential(3) + '  ' + (t1 - t0).toFixed(0) + ' ms');
        console.log('  lobpcg   λ_cr=' + rl.lambda_cr.toExponential(3) + '  ' + (t3 - t2).toFixed(0) + ' ms');
        console.log('  drift=' + dr.toExponential(2) + '  speedup=' + sp.toFixed(1) + '×  ' + (p ? '✓' : '✗'));
        ok = p && ok;
      } catch (e) { console.warn('[live] ' + (des.name || des.id) + ' error:', e); }
    }
  } else {
    console.log('\n[live] no loaded designs (LAB_STATE.designs) — synthetic checks only.');
  }

  console.log('\n==== buckling LOBPCG drift check: ' + (ok ? '✓ PASS — no drift, LOBPCG faster' : '✗ FAIL — review above') + ' ====');
})();
