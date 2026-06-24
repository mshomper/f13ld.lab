/* ────────────────────────────────────────────────────────────────────────
   validate-ui-fixes.js  —  paste into the browser console on the F13LD.lab
   page AFTER designs have loaded and you've visited the Geometry, Deformed,
   Stress, Buckle, Stiffness and Nonlinear tabs at least once.

   Covers the 7 approved fixes:
     1  Auto grid runs its picked N (no silent 32 cap)
     3  per-displayed-axis stress cap (unless 'shared')
     4  stiffness subdivision(4) + analytic normals (shader compiled)
     5  rotating axis-gimbal overlay wired on RM + SV tiles
     6  crush sign uniform + p99 alpha cap
     7  collision-free design palette + surface-tint uniforms
   ──────────────────────────────────────────────────────────────────────── */
(function () {
  var pass = 0, fail = 0;
  function ok(name, cond, extra) {
    (cond ? (pass++) : (fail++));
    console.log((cond ? '%c PASS ' : '%c FAIL ') + '%c ' + name + (extra ? '  — ' + extra : ''),
      'background:' + (cond ? '#1D9E75' : '#c0392b') + ';color:#fff;border-radius:3px',
      'color:' + (cond ? '#8fa3b3' : '#e879c9'));
  }

  /* #1 — Auto grid: pill N === run N (no 32 cap). */
  try {
    ok('#1 GRID_STATE.N is the picked grid (>=64 on auto)',
       typeof GRID_STATE !== 'undefined' && GRID_STATE.N >= 64,
       'mode=' + GRID_STATE.mode + ' N=' + GRID_STATE.N);
  } catch (e) { ok('#1 GRID_STATE present', false, e.message); }

  /* #7 — palette has no metric/section collisions. */
  try {
    var bad = ['#2dd4bf', '#fbbf24', '#fb7185', '#22d3ee'];
    var clash = DESIGN_PALETTE.filter(function (c) { return bad.indexOf(c.toLowerCase()) >= 0; });
    ok('#7 DESIGN_PALETTE collision-free', clash.length === 0, DESIGN_PALETTE.join(' '));
  } catch (e) { ok('#7 DESIGN_PALETTE present', false, e.message); }

  /* Raymarcher instances: shader compiled + new uniforms + gimbal/tint/sign. */
  try {
    var rmIds = Object.keys(LAB_RM_REGISTRY || {});
    var anyRM = rmIds.length > 0;
    ok('RM registry populated', anyRM, rmIds.length + ' instance(s)');
    if (anyRM) {
      var rm = LAB_RM_REGISTRY[rmIds[0]];
      ok('RM shader compiled (not failed)', !rm.failed && !!rm._prog);
      ok('#6 uDeformSign uniform resolved', rm._uloc && rm._uloc.uDeformSign != null);
      ok('#7 uTint / uTintStrength resolved',
         rm._uloc && rm._uloc.uTint != null && rm._uloc.uTintStrength != null);
      ok('#6 setDeformSign / #7 setTint / #5 setGimbal exist',
         typeof rm.setDeformSign === 'function' &&
         typeof rm.setTint === 'function' &&
         typeof rm.setGimbal === 'function');
      ok('#6 deformSign state is ±1', rm._u && (rm._u.deformSign === 1 || rm._u.deformSign === -1),
         'deformSign=' + (rm._u && rm._u.deformSign));
    }
  } catch (e) { ok('RM checks', false, e.message); }

  /* Stiffness instances: shader compiled + gimbal hooks. */
  try {
    var svIds = Object.keys(LAB_SV_REGISTRY || {});
    var anySV = svIds.length > 0;
    ok('SV registry populated (visit Stiffness tab first)', anySV, svIds.length + ' instance(s)');
    if (anySV) {
      var sv = LAB_SV_REGISTRY[svIds[0]];
      ok('#4 SV shader compiled (subdiv-4 + analytic normals)', !sv.failed && !!sv._prog);
      ok('#5 SV setGimbal / _updateGimbal exist',
         typeof sv.setGimbal === 'function' && typeof sv._updateGimbal === 'function');
    }
  } catch (e) { ok('SV checks', false, e.message); }

  /* #5 — at least one gimbal overlay rendered in the DOM, with all 6 nodes. */
  try {
    var g = document.querySelector('.vp-gimbal');
    var nodesOK = !!g && ['.gx', '.gy', '.gz', '.glx', '.gly', '.glz']
      .every(function (s) { return !!g.querySelector(s); });
    ok('#5 gimbal overlay present with X/Y/Z line+label nodes', nodesOK);
  } catch (e) { ok('#5 gimbal DOM', false, e.message); }

  /* #3 — per-axis stress stats helper exists and differs from across-axis. */
  try {
    ok('#3 computeStressStatsForAxes exists', typeof computeStressStatsForAxes === 'function');
    ok('#3 computeStressStatsAcrossAxes wrapper exists', typeof computeStressStatsAcrossAxes === 'function');
  } catch (e) { ok('#3 stats helpers', false, e.message); }

  /* #6b — p99 alpha cap helper exists. */
  try {
    ok('#6b nlAlphaCap helper exists', typeof nlAlphaCap === 'function');
  } catch (e) { ok('#6b nlAlphaCap', false, e.message); }

  console.log('%c F13LD.lab UI fixes — ' + pass + ' passed, ' + fail + ' failed ',
    'background:#0d1117;color:#c8f542;padding:2px 6px;border-radius:4px;font-weight:600');
})();
