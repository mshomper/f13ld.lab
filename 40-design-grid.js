/* ============================================================
   F13LD.lab · 40-design-grid.js
   Renders the 3-design comparison area. In σ–ε curve mode,
   the 3 columns collapse into one merged comparison plot.
   ============================================================ */

/* ----------------------------------------------------------
   Property summary card values per view mode.
   Returns an array of {lbl, val, valcls?, dlcls, delta} for
   the 4 stat tiles below each viewport.
   ---------------------------------------------------------- */
/* Honest formatting for sentinel "not-computed" values.
   Lab currently solves only elastic (E11/E22/E33 + anisotropy from the 3-LC
   normal block).  Buckling, yield, thermal aren't wired up yet — the run
   pipeline writes 0 for them.  When we know a run completed and the value
   is exactly 0, render "—" instead of "0.00 MPa" so users aren't misled.
   Sprint A — the demo designs no longer carry invented results, so a 0 /
   missing value is ALWAYS a sentinel (also mid-run or after a cancel), not
   only once a run has completed. */
function fmtComputed(value, suffix, digits){
  if (value == null || value === 0 || !isFinite(value)) return '—';
  return value.toFixed(digits != null ? digits : 2) + (suffix || '');
}
function failureModeText(r){
  if (r.failure_mode === 'not-computed') return '(not computed)';
  if (r.failure_mode === 'no-data')      return '(no kernel)';
  return r.failure_mode || '—';
}
function pcrPyDeltaClass(r){
  if (!r.pcr_py || !isFinite(r.pcr_py)) return 'neut';   /* Sprint A — sentinel at any time (see fmtComputed) */
  return r.pcr_py < 1 ? 'warn' : 'neut';   /* status, not comparison → amber */
}

/* ----------------------------------------------------------
   Load Capacity — "how much can this cell carry."  Governing strength is the
   smaller of effective yield (crush) and buckling, when both exist; load is
   that stress over one unit-cell footprint:  F = sigma[MPa] x cell_mm^2  (= N,
   since 1 MPa = 1 N/mm^2).  Per-cell basis — intrinsic to the design.
   ---------------------------------------------------------- */
function governingStrength(d){
  var bkd = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
  var nld = (typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[d.id] : null;
  var sy  = (nld && nld.yielded && isFinite(nld.sigma_y_eff)) ? nld.sigma_y_eff : null;
  var scr = (bkd && !bkd.error && isFinite(bkd.pcr)) ? bkd.pcr : null;
  if (sy != null && scr != null) return (scr < sy) ? { stress: scr, mode: 'buckling-governed' } : { stress: sy, mode: 'yield-governed' };
  if (sy  != null) return { stress: sy,  mode: 'yield' };
  if (scr != null) return { stress: scr, mode: 'buckling' };
  return null;
}
function loadCapacity(d){
  var g = governingStrength(d);
  if (!g) return null;
  var cell = (d && isFinite(d.cell_mm) && d.cell_mm > 0) ? d.cell_mm : null;
  if (cell == null) return null;
  return { N: g.stress * cell * cell, mode: g.mode, stress: g.stress, cell_mm: cell };
}
function loadCapacityCell(d){
  var lc = loadCapacity(d);
  if (!lc) return { lbl:'Load Capacity', val:'\u2014', delta:['needs yield or buckling','neut'] };
  var govCls = /buckl/.test(lc.mode) ? 'warn' : 'neut';   /* governing-mode status → amber */
  return { lbl:'Load Capacity', val:fmtForceN(lc.N), delta:[lc.mode + ' \u00b7 ' + lc.cell_mm + ' mm cell', govCls] };
}

/* Sprint A — relative density shown on cards.  After a solve: the voxel
   density the elastic solver actually meshed (d.results.rho at run N), with
   the imported nominal value alongside when it differs by > 2 points.
   Before a solve: the imported nominal value, labelled as such, or "—".
   Built-in demos carry no nominal (their old 0.42/0.38/0.40 were invented;
   raw_json gates out stale values restored from localStorage). */
function densityText(d){
  var r = d && d.results;
  var solved = (r && !r._error && isFinite(r.rho) && r.rho > 0) ? r.rho : null;
  var nominal = (d && d.raw_json && d.rho_rel != null && isFinite(d.rho_rel)) ? +d.rho_rel : null;
  if (solved != null){
    var t = solved.toFixed(2);
    if (nominal != null && Math.abs(nominal - solved) > 0.02) t += ' (nominal ' + nominal.toFixed(2) + ')';
    return t;
  }
  return (nominal != null) ? (nominal.toFixed(2) + ' nominal') : '\u2014';
}

/* Sprint A — pre-run placeholder tiles: same rows/labels as the real card so
   the layout does not jump, but no numbers until a solve produces them. */
function preRunStats(d, mode){
  var p = ['run to compute', 'neut'];
  if (mode === 'thermal'){
    return [
      { lbl:'Thermal Conductivity', val:'\u2014', delta:['solver not yet available', 'neut'] },
      { lbl:'Relative Density',     val:densityText(d), delta:p },
      { lbl:'Modulus Z',            val:'\u2014', delta:p },
      { lbl:'Anisotropy',           val:'\u2014', delta:p }
    ];
  }
  if (mode === 'buckle'){
    return [
      { lbl:'Buckling Strength',       val:'\u2014', delta:p },
      { lbl:'Buckling-to-Yield Ratio', val:'\u2014', delta:p },
      { lbl:'Load Capacity',           val:'\u2014', delta:p },
      { lbl:'Critical Load Factor',    val:'\u2014', delta:p },
      { lbl:'Modulus Z',               val:'\u2014', delta:p }
    ];
  }
  return [
    { lbl:'Modulus X', val:'\u2014', delta:p },
    { lbl:'Modulus Y', val:'\u2014', delta:p },
    { lbl:'Modulus Z', val:'\u2014', delta:p },
    { lbl:'Anisotropy', val:'\u2014', delta:p },
    { lbl:'Yield Strength', val:'\u2014', delta:p },
    { lbl:'Buckling-to-Yield Ratio', val:'\u2014', delta:p },
    { lbl:'Load Capacity', val:'\u2014', delta:p }
  ];
}

/* v0.8.0 — card-header pill: which failure governs this design.
   Ratio = buckling strength / yield strength (applyBuckleYield, 50-controls):
   ≥ 1 → yields first (yield-limited), < 1 → buckles first.  When the crush
   never reached yield the ratio is an upper bound, so ≥ 1 is undetermined.
   Without a crush result the yield is the solid material's (marked est.). */
function governingLimitPill(d){
  var bk = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
  if (!bk || bk.error || bk.skip_reason || !isFinite(bk.pcr_py)) return '';
  var r = bk.pcr_py, fx = (r >= 10) ? r.toFixed(0) : (r >= 1 ? r.toFixed(1) : r.toFixed(2));
  var est = bk.provisional && !bk.yieldBound ? ' · est.' : '';
  var axTxt = bk.ratioAxis ? ' (' + String(bk.ratioAxis).toUpperCase() + ' buckling vs ' + String(bk.ratioAxis).toUpperCase() + ' yield)' : '';
  var cls, txt, tip;
  if (bk.yieldBound && r >= 1){
    cls = 'unk'; txt = 'Limit undetermined';
    tip = 'Buckling strength is at least ' + fx + '× the highest stress the crush reached without yielding. Raise the crush strain cap to find the yield.';
  } else if (r >= 1){
    cls = 'yield'; txt = 'Yield-limited · buckles at ' + fx + '× yield' + est;
    tip = 'The structure yields before it buckles: buckling strength is ' + fx + '× the yield strength' + axTxt + (est ? ' (yield estimated from the solid material; run the Nonlinear crush for the design\'s own yield)' : '') + '.';
  } else {
    cls = 'buckle'; txt = 'Buckling-limited · buckles at ' + fx + '× yield' + est;
    tip = 'The structure buckles before it yields: buckling strength is only ' + fx + '× the yield strength' + axTxt + (est ? ' (yield estimated from the solid material)' : '') + '.';
  }
  if (bk.eigConverged === false){ txt += ' · not converged'; tip += ' The buckling eigen-solve hit its iteration cap; treat the number with care.'; }
  return '<span class="dc-limit-pill ' + cls + '" title="' + tip + '">' + txt + '</span>';
}

/* v0.16.0 — "not converged · 1000 it" when any elastic load case stopped at
   the CG cap; null when converged (or no record). */
function elasticNotConvergedText(r){
  if (!r || r.converged !== false) return null;
  var worst = 0, lcs = r.perLC || [];
  for (var i = 0; i < lcs.length; i++) if (lcs[i] && !lcs[i].converged && lcs[i].iters > worst) worst = lcs[i].iters;
  if (!worst && r.cgMaxiter) worst = r.cgMaxiter;
  return 'not converged' + (worst ? ' \u00b7 ' + worst + ' it' : '');
}

function statsForDesign(d, mode){
  var r = d.results;
  if (!r){
    /* Sprint A — was [] (no drawer).  With no elastic results but buckling /
       nonlinear data present (elastic toggled off), fall through with an
       all-sentinel block so those real numbers still render. */
    var hasOther = (typeof BUCKLE_BY_DESIGN !== 'undefined' && BUCKLE_BY_DESIGN[d.id]) ||
                   (typeof NONLIN_BY_DESIGN !== 'undefined' && NONLIN_BY_DESIGN[d.id]);
    if (!hasOther) return preRunStats(d, mode);
    r = (typeof stubResults === 'function') ? stubResults() : { E11:0, E22:0, E33:0, zener:0, pcr_py:0, sigma_y_z:0, kappa_z:0 };
    r.failure_mode = 'not-computed';
  }
  /* Sprint A — sentinel-safe elastic cells (0 = not computed, never "-100% vs B").
     v0.16.0 — when a load case hit the CG iteration cap the moduli read high
     (the solve starts from a uniform strain and works down), so the stiffness
     rows say so instead of showing a baseline delta. */
  var cgFlag = elasticNotConvergedText(r);
  function dv(key){
    if (cgFlag && /^E\d\d$|^G\d\d$/.test(key) && r[key] && isFinite(r[key])) return [cgFlag, 'warn'];
    /* v0.16.0 — stiffness within 50x of the void (void at its floor) */
    if (/^E\d\d$|^G\d\d$/.test(key) && r[key] > 0 && typeof voidLimited === 'function' && voidLimited(r[key] * 1000, r.Es_MPa, r.voidRatio))
      return ['void-limited \u00b7 void ' + r.voidRatio.toExponential(0) + ' of solid', 'warn'];
    return (r[key] && isFinite(r[key])) ? deltaVsBaseline(r[key], key, d.id) : ['\u2014','neut'];
  }
  var zVal = (r.zener > 0 && isFinite(r.zener)) ? r.zener.toFixed(2) : '\u2014';
  var zDesc = (r.zener > 0 && isFinite(r.zener)) ? zenerDescriptor(r.zener) : '\u2014';

  // Default: stiffness-flavored summary
  if (mode === 'geom' || mode === 'deform' || mode === 'stress' || mode === 'stiff'){
    /* P_cr/P_y reflects the buckling run (BUCKLE_BY_DESIGN), not d.results,
       so the metric shows on every tab once buckling has run. */
    var bkd = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
    var nld = (typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[d.id] : null;
    var bkPcrPy = (bkd && !bkd.error && isFinite(bkd.pcr_py)) ? bkd.pcr_py : null;
    var pcrLbl = (bkd && bkd.provisional) ? 'Buckling-to-Yield Ratio*' : 'Buckling-to-Yield Ratio';
    var pcrVal = (bkPcrPy != null) ? ((bkd && bkd.yieldBound) ? ('< '+bkPcrPy.toFixed(2)) : bkPcrPy.toFixed(2)) : fmtComputed(r.pcr_py, '', 2);
    var pcrDelta = (bkPcrPy != null)
      ? [(bkPcrPy < 1 ? 'buckling-limited' : 'yield-limited'), (bkPcrPy < 1 ? 'warn' : 'neut')]
      : [failureModeText(r), pcrPyDeltaClass(r)];
    var yVal, yDelta;
    if (nld && nld.yielded && isFinite(nld.sigma_y_eff)) {
      yVal = fmtEngMPa(nld.sigma_y_eff);
      var nAx = (typeof nlAvailableAxes === 'function') ? nlAvailableAxes(d.id).length : 1;
      yDelta = [(nld.axis||'zz').toUpperCase() + (nld.truncated ? ' · partial' : (nAx > 1 ? ' · weakest of ' + nAx : ' · crush')), 'neut'];
    } else if (nld && !nld.error) {
      yVal = isFinite(nld.sigmaCap) ? ('> ' + fmtEngMPa(nld.sigmaCap)) : 'no yield';
      yDelta = (nld.truncReason === 'step-budget' && isFinite(nld.eAxisMax))
        ? ['stopped at ε=' + (nld.eAxisMax*100).toFixed(2) + '% (step budget) · no yield in range reached', 'warn']
        : ['no yield · ≤ ' + Math.round((nld.epsCap||0.05)*100) + '% strain', 'neut'];
    } else {
      yVal = fmtComputed(r.sigma_y_z, ' MPa', 1);
      yDelta = [failureModeText(r), 'neut'];
    }
    return [
      { lbl:'Modulus X', val:fmtEngMPa(r.E11 * 1000), delta:dv('E11') },
      { lbl:'Modulus Y', val:fmtEngMPa(r.E22 * 1000), delta:dv('E22') },
      { lbl:'Modulus Z', val:fmtEngMPa(r.E33 * 1000), delta:dv('E33') },
      { lbl:'Anisotropy', val:zVal, delta:[zDesc, 'neut'] },
      { lbl:'Yield Strength', val:yVal, delta:yDelta },
      { lbl:pcrLbl, val:pcrVal, delta:pcrDelta },
      loadCapacityCell(d)
    ];
  }
  // Thermal mode prioritizes κ
  if (mode === 'thermal'){
    return [
      { lbl:'Thermal Conductivity', val:'\u2014',                            delta:['solver not yet available', 'neut'] },
      { lbl:'Relative Density',     val:densityText(d),                      delta:['solver voxel \u03c1','neut'] },
      { lbl:'Modulus Z',            val:fmtEngMPa(r.E33 * 1000),            delta:dv('E33') },
      { lbl:'Anisotropy',           val:zVal,                                delta:[zDesc, 'neut'] }
    ];
  }
  // Buckling mode — reads BUCKLE_BY_DESIGN (Run All buckling phase), not d.results.
  if (mode === 'buckle'){
    var modZ = fmtEngMPa(isFinite(r.E33) ? r.E33 * 1000 : NaN);
    var bk = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
    if (bk && !bk.error && isFinite(bk.lambda_cr)){
      var limited = isFinite(bk.pcr_py) && bk.pcr_py < 1;
      var safeTxt = isFinite(bk.pcr_py) ? (limited ? 'buckling-limited' : 'yield-limited') : '—';
      var ratLbl = bk.provisional ? 'Buckling-to-Yield Ratio*' : 'Buckling-to-Yield Ratio';
      return [
        { lbl:'Buckling Strength',       val:(isFinite(bk.pcr) ? fmtEngMPa(bk.pcr) : '—'),                              delta:(bk.eigConverged === false) ? ['not converged · N='+(bk.N||'—'), 'warn'] : ['N='+(bk.N||'—'), 'neut'] },
        { lbl:ratLbl,                    val:(isFinite(bk.pcr_py) ? ((bk.yieldBound?'< ':'')+bk.pcr_py.toFixed(2)) : '—'), delta:[safeTxt, limited ? 'warn' : 'neut'] },
        loadCapacityCell(d),
        /* lambda_cr = critical axial macro strain (16c header; free-sided uniaxial loading by default) — shown as a strain, not a bare multiplier */
        { lbl:'Critical Strain',         val:(bk.lambda_cr * 100).toPrecision(3) + '%',                                delta:['crit '+(bk.critAxis||'—'), 'neut'] },
        { lbl:'Modulus Z',               val:modZ,                                                                     delta:dv('E33') }
      ];
    }
    var note = (bk && bk.skip_reason) ? bk.skip_reason : (bk && bk.error) ? bk.error : (LAB_STATE.runHasCompleted ? 'enable Buckling + Run' : 'not run');
    return [
      { lbl:'Buckling Strength',       val:'—',   delta:[note, (bk && bk.skip_reason) ? 'warn' : 'neut'] },
      { lbl:'Buckling-to-Yield Ratio', val:'—',   delta:['—', 'neut'] },
      loadCapacityCell(d),
      { lbl:'Critical Strain',         val:'—',   delta:['—', 'neut'] },
      { lbl:'Modulus Z',               val:modZ,  delta:dv('E33') }
    ];
  }
  return [];
}

function zenerDescriptor(z){
  if (z < 0.7) return 'strongly axial';
  if (z < 0.9) return 'axial dominant';
  if (z < 1.1) return 'near-isotropic';
  if (z < 1.5) return 'diagonal dominant';
  return 'strongly diagonal';
}

/* ----------------------------------------------------------
   Map design family/variant to the SVG generator family key.
   ---------------------------------------------------------- */
function familyKey(d){
  if (d.variant === 'spinodoid') return 'spinodoid';
  if (d.variant === 'reaction_diffusion' || d.variant === 'hyperuniform') return 'trabecular';
  if (d.family === 'tpms') return 'tpms';
  if (d.family === 'grain') return 'grain';
  return 'tpms';
}

/* ----------------------------------------------------------
   Buckling tab field access.  Buckling mode shapes (phi) live in
   BUCKLE_BY_DESIGN (populated by the Run All buckling phase), not in
   d.results._fieldsByAxis.  These helpers let the Deformed-tab raymarcher
   machinery serve the Buckling tab unchanged by routing the active
   fieldset / axis / availability through the current view mode.
   ---------------------------------------------------------- */
function buckleDataFor(id){
  return (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[id] : null;
}
/* Localization read for the displayed buckling axis: m-bar (waves/cell) + band
   label.  Global < 1.5 <= Mixed < 3.0 <= Local. */
function getBuckleLoc(d, axis){
  var bk = buckleDataFor(d.id);
  if (!bk || !bk.perAxis) return null;
  var mw = null;
  for (var i = 0; i < bk.perAxis.length; i++){ if (bk.perAxis[i].axis === axis){ mw = bk.perAxis[i].mWave; break; } }
  if (mw == null || !isFinite(mw)) return null;
  var label, cls;
  if (mw < 1.5){ label = 'Global'; cls = 'global'; }
  else if (mw < 3.0){ label = 'Mixed'; cls = 'mixed'; }
  else { label = 'Local'; cls = 'local'; }
  return { mWave: mw, label: label, cls: cls };
}
function hasActiveFields(design, mode){
  if (mode === 'buckle'){
    var bk = buckleDataFor(design.id);
    return !!(bk && bk.modes && (bk.modes.xx || bk.modes.yy || bk.modes.zz));
  }
  return !!(design.results && design.results._fieldsByAxis);
}
function activeFieldsFor(design, axis, mode){
  if (mode === 'buckle'){
    var bk = buckleDataFor(design.id);
    return (bk && bk.modes && bk.modes[axis]) ? bk.modes[axis] : null;
  }
  return (design.results && design.results._fieldsByAxis) ? design.results._fieldsByAxis[axis] : null;
}
function getBuckleAxis(id){
  var set = (typeof VIEW_STATE !== 'undefined' && VIEW_STATE.loadAxis) ? VIEW_STATE.loadAxis[id] : undefined;
  if (set === 'xx' || set === 'yy' || set === 'zz') return set;
  var bk = buckleDataFor(id);
  return (bk && (bk.critAxis === 'xx' || bk.critAxis === 'yy' || bk.critAxis === 'zz')) ? bk.critAxis : 'zz';
}
function activeAxisFor(design, mode){
  if (mode === 'stress') return (typeof getStressAxis === 'function') ? getStressAxis(design.id) : 'zz';
  if (mode === 'buckle') return getBuckleAxis(design.id);
  return (typeof getDeformAxis === 'function') ? getDeformAxis(design.id) : 'zz';
}
/* p90 of |phi| across a mode fieldset — caps the relative-displacement
   colormap so the buckling zones saturate at the hot end, rather than a single
   peak voxel pinning the scale (which washed the surface blue).  Cached. */
function buckleMagCap(fs){
  if (!fs || !fs.sigma_vm) return 1;
  if (fs._magCap !== undefined) return fs._magCap;
  var a = fs.sigma_vm, n = a.length;
  var copy = new Float32Array(a);   /* typed-array sort is numeric ascending */
  copy.sort();
  var cap = copy[Math.floor(0.90 * (n - 1))];
  fs._magCap = (cap > 0) ? cap : 1;
  return fs._magCap;
}

/* ----------------------------------------------------------
   Main render function. Called by view-tab clicks, design
   load events, run progress, and amp-slider changes.
   ---------------------------------------------------------- */
function renderDesignGrid(){
  /* Import-time buckling-grid prediction — idempotent annotate pass.  This is
     the universal choke point (seed, restore, paste, drop all render here), so
     every design is badged once regardless of script load order (00-mock-data
     restores before 16c is defined, so this cannot live there). */
  if (typeof annotateBucklingPredict === 'function' && LAB_STATE && LAB_STATE.designs){
    for (var _bpI = 0; _bpI < LAB_STATE.designs.length; _bpI++) annotateBucklingPredict(LAB_STATE.designs[_bpI]);
  }
  /* Phase 5 polish — persist the current design set (definitions only)
     so an imported comparison survives a reload.  renderDesignGrid is the
     common sink for every state mutation (add / remove / baseline / load). */
  if (typeof saveDesigns === 'function') saveDesigns();
  var grid    = document.getElementById('compareGrid');
  var merged  = document.getElementById('mergedView');
  var mPlot   = document.getElementById('mergedPlot');
  if (!grid || !merged || !mPlot) return;

  // Nonlinear mode (internal id 'curve') — collapse to merged σ–ε plot plus
  // the α-progression cubes + scrubber.  Clearing grid.innerHTML here is
  // REQUIRED: the cubes reuse the same per-design raymarcher instances, so a
  // stale hidden grid tile carrying the same data-design-id would make
  // mountRaymarcherTiles() fight over where each shared canvas lands.  The
  // non-curve path below always rebuilds grid.innerHTML, so this is safe.
  if (VIEW_STATE.mode === 'curve'){
    grid.style.display   = 'none';
    grid.innerHTML       = '';
    merged.style.display = 'grid';
    if (typeof renderMergedCurvePlot === 'function') renderMergedCurvePlot(mPlot); else mPlot.innerHTML = buildMergedCurvePlot();
    if (typeof renderNonlinearViz === 'function') renderNonlinearViz();   /* tie-up #1 */
    return;
  }

  grid.style.display   = 'grid';
  merged.style.display = 'none';
  if (typeof nlvizStop === 'function') nlvizStop();   /* tie-up #1 — halt α animation on leaving the Nonlinear tab */

  // Empty state
  if (LAB_STATE.designs.length === 0){
    grid.innerHTML = '<div class="design-col" style="grid-column:1/-1; align-items:center; justify-content:center; padding:60px; text-align:center; color:var(--ink-dim);">' +
      '<div style="font-family:JetBrains Mono,monospace; font-size:11px; letter-spacing:0.16em; text-transform:uppercase;">No designs loaded</div>' +
      '<div style="margin-top:10px; font-size:13px; color:var(--ink-mute);">Browse the vault or import a design JSON to begin.</div>' +
      '</div>';
    return;
  }

  // Render each design column
  var html = '';
  /* Designs whose viewport tile should be raymarcher-backed in this render.
     We figure out the recipe NOW so we can pre-create the LabRaymarcher and
     bake the field BEFORE the grid HTML is committed; that way the canvas is
     already populated when mountRaymarcherTiles attaches it.  Designs with
     no recipe (e.g. mock RD designs lacking a lab kernel) fall back to SVG.

     A.2 — Eligibility:
       · geom   → recipe required (always)
       · deform → recipe AND d.results._fieldsByAxis[activeAxis] required
       · stress → recipe AND d.results._fieldsByAxis[activeAxis] required
       · stiff  → push 5 — d.results.S (full Voigt compliance) required;
                  no recipe needed since the surface is purely tensor-driven
     A.2.2 — gating now considers the active load axis from VIEW_STATE. */
  var rmDesigns = [];   /* [{i, id}, …] */
  var rmModes = (VIEW_STATE.mode === 'geom' || VIEW_STATE.mode === 'deform' || VIEW_STATE.mode === 'stress' || VIEW_STATE.mode === 'buckle');
  var needsFields = (VIEW_STATE.mode === 'deform' || VIEW_STATE.mode === 'stress' || VIEW_STATE.mode === 'buckle');
  if (rmModes) {
    for (var ri = 0; ri < LAB_STATE.designs.length && ri < 3; ri++) {
      var rd = LAB_STATE.designs[ri];
      var rcp = (typeof recipeForDesign === 'function') ? recipeForDesign(rd) : null;
      if (!rcp) continue;
      if (needsFields) {
        if (!hasActiveFields(rd, VIEW_STATE.mode)) continue;
        var rdAxis = activeAxisFor(rd, VIEW_STATE.mode);
        if (!activeFieldsFor(rd, rdAxis, VIEW_STATE.mode)) continue;
      }
      if (typeof getOrCreateRaymarcher === 'function') {
        getOrCreateRaymarcher(rd.id, rcp);
      }
      rmDesigns.push({ i: ri, id: rd.id });
    }
  }
  function isRMDesign(idx){ for (var k = 0; k < rmDesigns.length; k++) if (rmDesigns[k].i === idx) return true; return false; }

  /* Push 5 — Stiffness ⊕ tile gating.  Separate registry/canvas/shader
     from the raymarcher (parallel pattern; see 22-stiffness-viz.js).
     Eligibility: design has a full Voigt compliance matrix in results.S
     (post-push 4a, full-Voigt is the production path, so every successful
     elastic Run All populates this). */
  var svDesigns = [];   /* [{i, id}, …] */
  var svMode = (VIEW_STATE.mode === 'stiff');
  if (svMode) {
    for (var si = 0; si < LAB_STATE.designs.length && si < 3; si++) {
      var sd_g = LAB_STATE.designs[si];
      if (!sd_g.results || !sd_g.results.S || sd_g.results.S.length !== 36) continue;
      if (typeof getOrCreateStiffnessViz === 'function') {
        var svInst = getOrCreateStiffnessViz(sd_g.id);
        if (svInst) {
          /* Upload compliance to the GL viz.  Cheap (36 floats + 642 CPU
             samples for E_max/E_min stats).  Re-uploading on every render
             is fine — uploadDesign is idempotent and won't trigger a GL
             buffer realloc. */
          svInst.uploadDesign(sd_g.results.S);
        }
      }
      svDesigns.push({ i: si, id: sd_g.id });
    }
  }
  function isSVDesign(idx){ for (var k = 0; k < svDesigns.length; k++) if (svDesigns[k].i === idx) return true; return false; }

  for (var i = 0; i < LAB_STATE.designs.length && i < 3; i++){
    var d = LAB_STATE.designs[i];
    var fam = familyKey(d);
    var amp = getDeformAmp(d.id);
    var svgInner = '';
    var useRM = rmModes && isRMDesign(i);
    var useSV = svMode && isSVDesign(i);   /* push 5 — stiffness GL viz */

    if (VIEW_STATE.mode === 'geom') {
      if (!useRM) svgInner = svgGeom(fam, false, 0);
    }
    else if (VIEW_STATE.mode === 'deform') {
      if (!useRM) {
        /* A.2 — honest fallback: no fields means no warp.  Show empty
           viewport with prompt rather than the static-geometry mock.
           Pre-run designs land here. */
        svgInner = svgEmptyViewport('Run to see deformed field');
      }
    }
    else if (VIEW_STATE.mode === 'stress'){
      if (!useRM) {
        if (!LAB_STATE.runHasCompleted) svgInner = svgEmptyViewport('Run to see stress field');
        else svgInner = svgStress(fam, i);
      }
    }
    else if (VIEW_STATE.mode === 'stiff'){
      /* Push 5 — fallback only when full Voigt compliance is missing.
         Successful elastic Run All always populates d.results.S, so this
         branch fires pre-run, on failed solves, or for stub designs. */
      if (!useSV) {
        if (!LAB_STATE.runHasCompleted) svgInner = svgEmptyViewport('Run to see stiffness surface');
        else svgInner = svgStiffness((d.results && d.results.zener) || 1.0, d.color, i);
      }
    }
    else if (VIEW_STATE.mode === 'thermal'){
      /* Sprint A — svgThermal(zener) drew a κ surface faked from the ELASTIC
         anisotropy.  No thermal solver is wired, so say so plainly. */
      svgInner = svgEmptyViewport('Thermal κ solver not yet available');
    }
    else if (VIEW_STATE.mode === 'buckle'){
      if (!useRM) {
        var bkv = buckleDataFor(d.id);
        if (bkv && bkv.error) svgInner = svgEmptyViewport('Buckling: ' + bkv.error);
        else svgInner = svgEmptyViewport('Enable Buckling · Run to see modes');
      }
    }

    var readout = readoutForDesign(d, VIEW_STATE.mode);
    var stats = statsForDesign(d, VIEW_STATE.mode);
    /* A.3 — both deform and stress modes expose the load-axis toggle + amp
       slider (stress mode uses the same warp; colormap reads on the
       deformed shape — standard FEA viz). */
    var showControls = (VIEW_STATE.mode === 'deform' || VIEW_STATE.mode === 'stress' || VIEW_STATE.mode === 'buckle');
    /* A.3.1 / A.3.3 — colorbar overlay only when stress raymarcher is
       mounted and fields are available.  resolveStressDisplay picks
       per-design or shared cap + gamma based on stressNormMode. */
    var showColorbar = (VIEW_STATE.mode === 'stress' && useRM &&
                        d.results && d.results._fieldsByAxis);
    /* Buckling tab shows a qualitative relative-displacement bar (no units). */
    var showBuckleBar = (VIEW_STATE.mode === 'buckle' && useRM);
    /* Localization chip (top-left) — only when buckling data is mounted. */
    var buckleChip = '';
    if (VIEW_STATE.mode === 'buckle' && useRM){
      var bloc = getBuckleLoc(d, activeAxisFor(d, 'buckle'));
      if (bloc){
        buckleChip = '<div class="vp-buckle-chip '+bloc.cls+'">' +
          '<span class="lbl">'+bloc.label+'</span>' +
          '<span class="val">m\u0304 '+bloc.mWave.toFixed(1)+'</span>' +
          '</div>';
      }
    }
    var stressDisplay = showColorbar
                        ? resolveStressDisplay(d, LAB_STATE.designs)
                        : null;
    var stressCapMPa = stressDisplay ? stressDisplay.cap   : 0;
    var stressGamma  = stressDisplay ? stressDisplay.gamma : 1.0;
    var stressMode   = stressDisplay ? stressDisplay.mode  : 'per';
    var stressMaxMPa = showColorbar
                       ? computeStressMaxAcrossAxes(d.results._fieldsByAxis)
                       : 0;
    var statusClass = '';
    if (LAB_STATE.runHasCompleted) statusClass = 'done';
    else if (RUN_STATE && RUN_STATE.running && i === RUN_STATE.currentIndex) statusClass = 'running';
    else statusClass = 'idle';

    /* Push 5 — viewport tile dispatcher:
         useSV → .sv-mount (StiffnessViz canvas)
         useRM → .rm-mount (LabRaymarcher canvas)
         else  → inline SVG (mock or empty-state) */
    var viewportInner;
    if (useSV) {
      viewportInner = '<div class="sv-mount" data-design-id="'+d.id+'" style="width:100%;height:100%;"></div>';
    } else if (useRM) {
      viewportInner = '<div class="rm-mount" data-design-id="'+d.id+'" style="width:100%;height:100%;"></div>';
    } else {
      viewportInner = '<svg viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet">'+svgInner+'</svg>';
    }

    /* Honest provenance line.  When a real run has produced results, append a
       small decoration that shows where the numbers came from.  d.results._runSource
       is set by runRealSweep in 50-controls.js. */
    var sourceText = d.source;
    if (LAB_STATE.runHasCompleted && d.results && d.results._runSource){
      var rsClass = d.results._error ? 'rs-err' : (d.results._runSource.indexOf('stub') === 0 ? 'rs-stub' : 'rs-real');
      sourceText += ' · <span class="' + rsClass + '">' + d.results._runSource + '</span>';
    }
    var _bp = d.buckle_predict;
    if (_bp){
      var _bpCls = _bp.prone ? 'prone' : 'ok';
      var _bpTxt = 'N' + _bp.N + (_bp.prone ? ' \u00b7 PRONE' : ' \u00b7 OK');
      var _bpTip = 'Predicted buckling grid N=' + _bp.N + ' \u2014 median wall ' + _bp.median +
                   ' vox @ probe N=' + _bp.probeN + (_bp.prone
                     ? ' \u2014 thin, buckling-prone, needs the fine grid'
                     : ' \u2014 stocky, resolves at the coarse grid');
      sourceText += ' <span class="dc-predict-pill ' + _bpCls + '" title="' + _bpTip + '">' + _bpTxt + '</span>';
    }
    /* STL import — geometry state, not-periodic tag, wall offset */
    if (d.family === 'import' && typeof importCardPills === 'function') sourceText += importCardPills(d);
    /* v0.8.0 — governing failure mode, on every tab: yield vs buckling. */
    var limitPill = governingLimitPill(d);

    html += '<div class="design-col">' +
      '<div class="dc-head">' +
        '<div class="dc-name">' +
          '<span class="label">'+d.label+'</span>' +
          '<span class="title">'+d.title+'</span>' +
          '<span class="source">'+sourceText+'</span>' +
          limitPill +
        '</div>' +
        '<div class="dc-controls">' +
          '<span class="dc-status-dot '+statusClass+'" title="'+statusClass+'"></span>' +
          '<button class="dc-icon-btn'+(d.id===LAB_STATE.baselineId?' is-baseline':'')+'" title="'+(d.id===LAB_STATE.baselineId?'Baseline (comparison reference)':'Set as baseline')+'" onclick="setBaseline(\''+d.id+'\')">★</button>' +
          ((d.family === 'import' && typeof importCardButtons === 'function') ? importCardButtons(d) : '') +
          '<button class="dc-icon-btn" title="Remove" onclick="removeDesign(\''+d.id+'\')">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="dc-viewport">' +
        viewportInner +
        buckleChip +
        ((useRM || useSV) ? buildGimbalOverlay() : '') +
        (readout ? '<div class="vp-readout"><span class="v">'+readout+'</span></div>' : '') +
        (showColorbar ? buildStressColorbar(stressCapMPa, stressGamma, stressMode) : '') +
        (showBuckleBar ? buildBuckleColorbar() : '') +
        (showControls
          ? (VIEW_STATE.mode === 'stress'
              ? buildStressControl(d.id,
                                   (typeof getStressSat === 'function') ? getStressSat(d.id) : 1.0,
                                   (typeof getStressAxis === 'function') ? getStressAxis(d.id) : 'zz')
              : (VIEW_STATE.mode === 'buckle'
                  ? buildBuckleControl(d.id,
                                       (typeof getBuckleExag === 'function') ? getBuckleExag(d.id) : 10,
                                       activeAxisFor(d, 'buckle'))
                  : buildDeformControl(d.id, amp, activeAxisFor(d, VIEW_STATE.mode))))
          : '') +
      '</div>' +
      buildSummary(stats, d) +
      '</div>';
  }
  grid.innerHTML = html;

  /* Mount any raymarcher canvases into their .rm-mount placeholders */
  if (typeof mountRaymarcherTiles === 'function') mountRaymarcherTiles();
  /* Push 5 — mount any stiffness-viz canvases into their .sv-mount placeholders */
  if (typeof mountStiffnessTiles === 'function') mountStiffnessTiles();

  /* A.2 — Push per-design state to mounted raymarchers AFTER mount.
     The raymarcher needs the current view mode (gates auto-rotate +
     warp shader branch), the current amp (deform slider), and the
     captured displacement fields (uploaded once per run completion).
     A.2.2 — the active load axis selects which of the three captured
     fieldsets to upload.
     A.3 — for stress colormap, we pass the max σ_VM across all three
     axes as the shared stress range.  Toggling axes then reveals the
     stress hierarchy (high-stress axis saturates, lower-stress axes
     stay closer to blue) instead of renormalizing per axis. */
  for (var rk = 0; rk < rmDesigns.length; rk++) {
    var rkid = rmDesigns[rk].id;
    var rkrm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[rkid] : null;
    if (!rkrm || rkrm.failed) continue;
    var rdesign = LAB_STATE.designs[rmDesigns[rk].i];
    if (rkrm.uploadFields) {
      var rkAxis = activeAxisFor(rdesign, VIEW_STATE.mode);
      var fs = activeFieldsFor(rdesign, rkAxis, VIEW_STATE.mode);
      if (fs) {
        if (VIEW_STATE.mode === 'buckle') {
          /* |phi| relative-displacement colormap reuses the stress R8 path;
             cap = max|phi| normalizes the contour to 0..1. */
          rkrm.uploadFields(fs, buckleMagCap(fs));
          if (rkrm.setStressGamma) rkrm.setStressGamma(1.0);
        } else {
          var sd = resolveStressDisplay(rdesign, LAB_STATE.designs);
          rkrm.uploadFields(fs, sd.cap);
          if (rkrm.setStressGamma) rkrm.setStressGamma(sd.gamma);
        }
      }
    }
    if (VIEW_STATE.mode === 'buckle') {
      /* warp + |phi| colormap both live in the stress view mode (effective 2) */
      if (rkrm.setViewMode)   rkrm.setViewMode('stress');
      if (rkrm.setBuckleMap)  rkrm.setBuckleMap(true);
      if (rkrm.setBuckleAmp)  rkrm.setBuckleAmp((typeof getBuckleExag === 'function') ? getBuckleExag(rkid) : 10);
      if (rkrm.setPulse)      rkrm.setPulse(true);
    } else {
      if (rkrm.setViewMode)   rkrm.setViewMode(VIEW_STATE.mode);
      if (rkrm.setBuckleMap)  rkrm.setBuckleMap(false);
      if (rkrm.setPulse)      rkrm.setPulse(false);
      if (rkrm.setWarpExpand) rkrm.setWarpExpand(0);
      if (rkrm.setDeformAmp)  rkrm.setDeformAmp(getDeformAmp(rkid));
    }
  }

  /* Push 5 — Push per-design viz params to mounted StiffnessViz instances
     after mount.  Reuses the per/shared toggle from the stress-field tab
     (push 4b precedent) via resolveStiffViz → getStressNormMode.
     Push 5.3 — resolver now returns (REmax, Cmin, Cmax) so the per/shared
     toggle drives BOTH radius normalization AND color stretch.  In 'shared'
     mode every design renders against the global max E across designs AND
     stretches color over the global E_min..E_max range, so weaker designs
     read as both smaller and darker — matching the stress tab's "same
     color = same value everywhere" cross-comparison pattern. */
  for (var svk = 0; svk < svDesigns.length; svk++) {
    var svkid = svDesigns[svk].id;
    var svkSV = (typeof LAB_SV_REGISTRY !== 'undefined') ? LAB_SV_REGISTRY[svkid] : null;
    if (!svkSV || svkSV.failed) continue;
    var svDesign = LAB_STATE.designs[svDesigns[svk].i];
    if (typeof resolveStiffViz === 'function' && svkSV.setVizParams) {
      var vp = resolveStiffViz(svDesign, LAB_STATE.designs);
      svkSV.setVizParams(vp.REmax, vp.Cmin, vp.Cmax);
    }
  }

  /* Pause raymarchers if we're in a non-geometry view (defensive — they
     wouldn't have been mounted, but registry instances might still be
     registered as "running" from a previous geom render). */
  if (typeof pauseRaymarcherTilesForViewMode === 'function') {
    pauseRaymarcherTilesForViewMode(VIEW_STATE.mode);
  }

  // Wire up amp sliders after DOM injection.
  // A.2 — direct uniform update for raymarcher-backed designs avoids
  // a full grid re-render on every input event (which was rebuilding
  // HTML at 60Hz under continuous slider movement).  SVG-mock fallback
  // designs still trigger renderDesignGrid to update their static-warp
  // visualization.
  var sliders = document.querySelectorAll('.amp-slider');
  for (var s = 0; s < sliders.length; s++){
    sliders[s].addEventListener('input', function(e){
      var id = e.target.dataset.designId;
      var v = parseFloat(e.target.value);
      onDeformAmpInput(id, v);
      /* 4b — update the displayed "% cell" label inline (no DOM rebuild). */
      var labelEl = e.target.parentNode.querySelector('.v');
      if (labelEl) labelEl.textContent = (v*20).toFixed(1) + '% cell';
      /* Push to raymarcher uniform if mounted; otherwise let the SVG
         fallback re-render handle visual update. */
      var rm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[id] : null;
      if (rm && !rm.failed && rm.setDeformAmp) {
        rm.setDeformAmp(v);
      } else {
        if (typeof renderDesignGrid === 'function') renderDesignGrid();
      }
    });
  }

  /* Wire the buckling exaggeration slider.  Updates the mode amplitude live
     (pulse peak + fit envelope) without a grid rebuild. */
  var buckleSliders = document.querySelectorAll('.buckle-exag-slider');
  for (var bxs = 0; bxs < buckleSliders.length; bxs++){
    buckleSliders[bxs].addEventListener('input', function(e){
      var id = e.target.dataset.designId;
      var v = parseFloat(e.target.value);
      if (typeof setBuckleExag === 'function') setBuckleExag(id, v);
      var labelEl = e.target.parentNode.querySelector('.v');
      if (labelEl) labelEl.textContent = v.toFixed(0) + '% cell';
      var rm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[id] : null;
      if (rm && !rm.failed && rm.setBuckleAmp) rm.setBuckleAmp(v);
    });
  }

  /* 4b — Wire stress saturation sliders.  Per-design multiplier on the
     auto p95 cap.  On input: update state, re-resolve the (cap, gamma)
     pair, re-upload σ_VM normalization to the raymarcher (cheap — the
     R8 stress texture stays; only stressMin/stressMax/stressGamma change),
     and update the readout/colorbar inline. */
  var satSliders = document.querySelectorAll('.sat-slider');
  for (var ss = 0; ss < satSliders.length; ss++){
    satSliders[ss].addEventListener('input', function(e){
      var id = e.target.dataset.designId;
      var v = parseFloat(e.target.value);
      if (typeof onStressSatInput === 'function') onStressSatInput(id, v);
      /* Update inline label */
      var labelEl = e.target.parentNode.querySelector('.v');
      if (labelEl) labelEl.textContent = '×' + v.toFixed(2) + ' auto';
      /* Find design, re-resolve display params, re-upload stress norm
         to raymarcher.  We DON'T need to re-upload the u'/σ_VM texture
         data — uploadFields with the same fieldset and new stressMaxOverride
         just rebinds the R8 texture with new byte normalization, which is
         the cheapest way to push a new cap to the shader. */
      var design = null;
      for (var di = 0; di < LAB_STATE.designs.length; di++){
        if (LAB_STATE.designs[di].id === id){ design = LAB_STATE.designs[di]; break; }
      }
      var rm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[id] : null;
      if (rm && !rm.failed && rm.uploadFields && design && design.results && design.results._fieldsByAxis) {
        /* Piece B — this handler runs only in stress mode, so use stress axis directly. */
        var axis = (typeof getStressAxis === 'function') ? getStressAxis(id) : 'zz';
        var fs = design.results._fieldsByAxis[axis];
        if (fs) {
          var sd = resolveStressDisplay(design, LAB_STATE.designs);
          rm.uploadFields(fs, sd.cap);
          if (rm.setStressGamma) rm.setStressGamma(sd.gamma);
        }
      }
      /* Re-render to refresh the colorbar overlay (its CSS-side labels
         show the new cap value).  This is a DOM rebuild, but stress
         saturation isn't typically dragged at 60Hz — pulled or stepped. */
      if (typeof renderDesignGrid === 'function') renderDesignGrid();
    });
  }

  /* A.2.2 — Wire load-axis toggle buttons.  On click: update state,
     re-upload the matching fieldset to the raymarcher, swap active-class
     on the buttons inline (no full re-render). */
  var axisBtns = document.querySelectorAll('.load-axis-btn');
  for (var ab = 0; ab < axisBtns.length; ab++){
    axisBtns[ab].addEventListener('click', function(e){
      var btn = e.currentTarget;
      var id   = btn.dataset.designId;
      var axis = btn.dataset.axis;
      if (!id || !axis) return;
      if (typeof onLoadAxisClick === 'function') onLoadAxisClick(id, axis);

      /* Find the matching design + new fieldset */
      var design = null;
      for (var di = 0; di < LAB_STATE.designs.length; di++){
        if (LAB_STATE.designs[di].id === id){ design = LAB_STATE.designs[di]; break; }
      }
      var rm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[id] : null;
      var fsTog = (design && typeof activeFieldsFor === 'function') ? activeFieldsFor(design, axis, VIEW_STATE.mode) : null;
      if (rm && !rm.failed && rm.uploadFields && fsTog) {
        if (VIEW_STATE.mode === 'buckle') {
          rm.uploadFields(fsTog, buckleMagCap(fsTog));
          if (rm.setStressGamma) rm.setStressGamma(1.0);
          if (rm.setBuckleAmp) rm.setBuckleAmp((typeof getBuckleExag === 'function') ? getBuckleExag(id) : 10);
        } else {
          var sd2 = resolveStressDisplay(design, LAB_STATE.designs);
          rm.uploadFields(fsTog, sd2.cap);
          if (rm.setStressGamma) rm.setStressGamma(sd2.gamma);
        }
      } else if (rm && !rm.failed && rm.uploadFields) {
        /* No fields for selected axis → re-render so the empty-viewport
           fallback shows.  Same path as the no-fields-yet pre-run case. */
        if (typeof renderDesignGrid === 'function') renderDesignGrid();
        return;
      }

      /* Swap visual active state across the three siblings, inline. */
      var siblings = btn.parentNode.querySelectorAll('.load-axis-btn');
      for (var sb = 0; sb < siblings.length; sb++){
        var sibAxis = siblings[sb].dataset.axis;
        var isActive = (sibAxis === axis);
        siblings[sb].style.background = isActive ? '#c8f542' : 'transparent';
        siblings[sb].style.borderColor = isActive ? '#c8f542' : 'rgba(255,255,255,0.18)';
        siblings[sb].style.color = isActive ? '#0a0a0a' : 'rgba(255,255,255,0.55)';
      }
    });
  }
}

/* ----------------------------------------------------------
   Helpers used by render.
   ---------------------------------------------------------- */
/* Metrics drawer open-state.  null = auto (open on wide screens, collapsed on
   small); once the user taps, METRICS_OPEN latches their choice for the session
   and all three tiles toggle together (parallel comparison). */
var METRICS_OPEN = null;
function drawersEffectiveOpen(){
  if (METRICS_OPEN === null) return (typeof window !== 'undefined') ? (window.innerWidth >= 880) : true;
  return METRICS_OPEN;
}
function toggleMetricsDrawers(){
  METRICS_OPEN = !drawersEffectiveOpen();
  var open = METRICS_OPEN, ds = document.querySelectorAll('.dc-drawer'), i;
  for (i = 0; i < ds.length; i++) ds[i].classList.toggle('collapsed', !open);
}

function buildSummary(stats, d){
  if (!stats || stats.length === 0) return '';

  /* Collapsed-bar teaser: Load Capacity when a strength exists, else Modulus Z. */
  var teaserLbl, teaserVal;
  var lc = (typeof loadCapacity === 'function') ? loadCapacity(d) : null;
  if (lc){
    teaserLbl = 'Load';
    teaserVal = fmtForceN(lc.N);
  } else {
    teaserLbl = 'Modulus Z';
    teaserVal = (d && d.results && isFinite(d.results.E33)) ? fmtEngMPa(d.results.E33 * 1000) : '\u2014';
  }

  var rows = '';
  for (var i = 0; i < stats.length; i++){
    var s = stats[i];
    var dtxt = (s.delta && s.delta[0]) ? s.delta[0] : '';
    var dcls = (s.delta && s.delta[1]) ? s.delta[1] : 'neut';
    rows += '<div class="dc-row">' +
              '<span class="rl">'+s.lbl+'</span>' +
              '<span class="rr">' +
                '<span class="rv'+(s.valcls ? ' '+s.valcls : '')+'">'+s.val+'</span>' +
                (dtxt ? ('<span class="rd '+dcls+'">'+dtxt+'</span>') : '') +
              '</span>' +
            '</div>';
  }

  var collapsed = !drawersEffectiveOpen();
  return '<div class="dc-drawer'+(collapsed ? ' collapsed' : '')+'">' +
           '<div class="dc-drawer-bar" onclick="toggleMetricsDrawers()">' +
             '<span class="db-left"><span class="chev">\u25be</span> Metrics</span>' +
             '<span class="db-teaser">'+teaserLbl+' <b>'+teaserVal+'</b></span>' +
           '</div>' +
           '<div class="dc-drawer-panel"><div class="dc-rows">'+rows+'</div></div>' +
         '</div>';
}

function buildDeformControl(designId, amp, axis){
  /* A.2.2 / Piece B — Load-axis toggle for the Deform tab.  Three
     buttons (XX/YY/ZZ — normal Voigt axes only) — clicking one
     re-uploads the matching fieldset from d.results._fieldsByAxis
     to the raymarcher.  Shear axes (yz/xz/xy) are not shown here
     because u'(x) is undefined for them; see buildStressControl
     for the 6-button variant used on the Stress tab.  Inline styles
     avoid touching lab.css for this small addition; can be promoted
     to .load-axis-btn class selectors during a later polish pass. */
  function btn(ax) {
    var active = (axis === ax);
    return '<button class="load-axis-btn'+(active ? ' active' : '')+'" data-design-id="'+designId+'" data-axis="'+ax+'">'+ax.toUpperCase()+'</button>';
  }
  /* 4b — slider value 0..1 now maps to "δ_max as % of cell".  Default 0.25
     → 5% cell stretch.  Step 0.01 preserves smooth slider feel.
     Sampling kernel is fixed at 8-tap cubic B-spline (Sigg-Hadwiger) —
     the lin/cub toggle was removed because the cubic path is uniformly
     better at lab grid sizes and the cost is imperceptible on target
     hardware.  See 21-raymarcher.js sampleDisp/sampleStress. */
  return '<div class="vp-deform-control show">' +
    '<div class="load-axis-toggle">' +
      btn('xx') + btn('yy') + btn('zz') +
    '</div>' +
    '<label>amp</label>' +
    '<input type="range" min="0" max="1" step="0.01" value="'+amp+'" data-design-id="'+designId+'" class="amp-slider">' +
    '<span class="v">'+(amp*20).toFixed(1)+'% cell</span>' +
    '</div>';
}

/* Buckling tab control — XX/YY/ZZ axis toggle + qualitative exaggeration slider
   (0..30% of cell; a buckling eigenmode has no absolute scale). */
function buildBuckleControl(designId, exagPct, axis){
  function btn(ax){
    var active = (axis === ax);
    return '<button class="load-axis-btn'+(active ? ' active' : '')+'" data-design-id="'+designId+'" data-axis="'+ax+'">'+ax.toUpperCase()+'</button>';
  }
  return '<div class="vp-deform-control show">' +
    '<div class="load-axis-toggle">' + btn('xx') + btn('yy') + btn('zz') + '</div>' +
    '<label>exag</label>' +
    '<input type="range" min="0" max="30" step="1" value="'+exagPct+'" data-design-id="'+designId+'" class="buckle-exag-slider">' +
    '<span class="v">'+exagPct.toFixed(0)+'% cell</span>' +
    '</div>';
}

/* Buckling tab colorbar — relative displacement only (node -> antinode), no
   units, since eigenmode magnitude is qualitative.  Reuses the stress-bar CSS. */
function buildBuckleColorbar(){
  /* Turbo gradient (blue node at bottom -> red antinode at top) matching the
     shader's turbo() stops; inline so it overrides the cividis stress-bar CSS. */
  var turbo = 'linear-gradient(to top,' +
    'rgb(36,38,128) 0%,rgb(38,102,242) 14%,rgb(26,179,230) 29%,' +
    'rgb(38,230,140) 43%,rgb(140,250,64) 57%,rgb(242,217,38) 71%,' +
    'rgb(247,128,38) 86%,rgb(224,33,20) 100%)';
  return '<div class="stress-colorbar-header">rel. disp</div>' +
         '<div class="stress-colorbar" style="background:'+turbo+';"></div>' +
         '<div class="stress-colorbar-label-top">antinode' +
           '<span class="stress-colorbar-suffix">qualitative</span></div>' +
         '<div class="stress-colorbar-label-bot">node</div>';
}

/* 4b / Piece B — Stress mode controls.  Six-button axis toggle
   (XX/YY/ZZ/YZ/XZ/XY — all Voigt axes — since σ_VM is well-defined
   for every load case) + saturation slider.

   The 6-button toggle uses the same .load-axis-btn class so the
   existing click handler in attachDesignGridListeners routes to it
   transparently — only the buttons inside .load-axis-toggle change.

   Sat slider: per-design multiplier on the auto p95 cap.  Range 0..2
   with default 1.0.  Reuses the .amp-slider visual but class-tagged
   .sat-slider for handler routing.  Sampling kernel hardcoded to
   cubic — see buildDeformControl note. */
function buildStressControl(designId, sat, axis){
  function btn(ax) {
    var active = (axis === ax);
    return '<button class="load-axis-btn'+(active ? ' active' : '')+'" data-design-id="'+designId+'" data-axis="'+ax+'">'+ax.toUpperCase()+'</button>';
  }
  return '<div class="vp-deform-control show">' +
    '<div class="load-axis-toggle six">' +
      btn('xx') + btn('yy') + btn('zz') + btn('yz') + btn('xz') + btn('xy') +
    '</div>' +
    '<label>sat</label>' +
    '<input type="range" min="0" max="2" step="0.05" value="'+sat+'" data-design-id="'+designId+'" class="sat-slider">' +
    '<span class="v">×'+sat.toFixed(2)+' auto</span>' +
    '</div>';
}

function readoutForDesign(d, mode){
  var r = d.results || {};
  var amp = getDeformAmp(d.id);
  if (mode === 'geom')   return d.title + ' · ρ=' + densityText(d);
  if (mode === 'buckle'){
    var bkr = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
    if (bkr && !bkr.error && isFinite(bkr.lambda_cr)){
      var axb = (typeof activeAxisFor === 'function') ? activeAxisFor(d, 'buckle') : 'zz';
      return 'mode ' + axb + ' · ε_cr=' + (bkr.lambda_cr * 100).toPrecision(3) + '%';
    }
    return 'Enable Buckling · Run';
  }
  /* 4b — slider value × 0.20 = δ_max as fraction of cell half-extent.
     Independent of design's natural u'_max; cross-design comparable. */
  if (mode === 'deform') return 'δ_max = ' + (amp*20).toFixed(1) + '% of cell';
  if (mode === 'stress' && LAB_STATE.runHasCompleted){
    /* A.3.1 — show p95 (colormap cap — what yellow saturation represents)
       and the true max separately.  Honest reporting: the colorbar tells
       you yellow = p95, the readout tells you what the actual peak σ_VM
       was.  Units auto-format at the GPa boundary.
       4b — readout shows the EFFECTIVE cap (auto p95 × user saturation
       multiplier) and the user multiplier value.  When sat ≠ 1.0 the
       cap is what the colorbar yellow actually represents on this design. */
    if (r._fieldsByAxis) {
      var satMul = (typeof getStressSat === 'function') ? getStressSat(d.id) : 1.0;
      var sd = (typeof resolveStressDisplay === 'function') ? resolveStressDisplay(d, LAB_STATE.designs) : { cap: 0 };
      var effCap = sd.cap;   /* #3 — displayed-axis (per) or global (shared) cap, already × sat */
      var trueMax = computeStressMaxAcrossAxes(r._fieldsByAxis);
      if (effCap > 0 || trueMax > 0) {
        function fmt(v){
          if (v >= 1000) return (v/1000).toFixed(2) + ' GPa';
          if (v >= 1) return v.toFixed(1) + ' MPa';
          if (v > 0) return v.toExponential(1) + ' MPa';
          return '—';
        }
        var satNote = (Math.abs(satMul - 1.0) < 0.01) ? '' : ' (×'+satMul.toFixed(2)+' auto)';
        return 'σ_VM cap=' + fmt(effCap) + satNote + ' · max ' + fmt(trueMax);
      }
    }
    return 'σ_VM,max = — (not computed)';
  }
  /* Push 5 — Stiffness ⊕ readout: pull real E_max / E_min / anisotropy
     ratio from the StiffnessViz GL instance (which computed them via
     642-vertex CPU sampling at upload time).  Falls back to the old
     surrogate when no GL viz is mounted (pre-run or fallback design). */
  if (mode === 'stiff'){
    if (LAB_STATE.runHasCompleted && typeof LAB_SV_REGISTRY !== 'undefined') {
      var sv = LAB_SV_REGISTRY[d.id];
      if (sv && sv.getStats) {
        var ss = sv.getStats();
        if (ss.hasData) {
          function fmtE(v){
            if (v >= 1000) return (v/1000).toFixed(2) + ' GPa';
            if (v >= 1)    return v.toFixed(1)        + ' MPa';
            if (v > 0)     return v.toExponential(1)  + ' MPa';
            return '—';
          }
          var anisoStr = isFinite(ss.aniso) ? ss.aniso.toFixed(2) : '∞';
          return 'E_max ' + fmtE(ss.E_max) + ' · E_min ' + fmtE(ss.E_min) +
                 ' · aniso ' + anisoStr;
        }
      }
    }
    return 'E_max = — (not computed)';
  }
  if (mode === 'thermal') return 'κ = — (solver not yet available)';   /* Sprint A — no thermal solver; was kappa_z*1.04 of mock data */
  if (mode === 'buckle' && LAB_STATE.runHasCompleted){
    return r.lambda_cr === 0 ? 'λ_cr = — (not computed)'
                              : 'λ_cr = ' + r.lambda_cr.toFixed(2);
  }
  return '';
}

/* ----------------------------------------------------------
   Set a different design as the comparison baseline.
   ---------------------------------------------------------- */
function setBaseline(designId){
  LAB_STATE.baselineId = designId;
  renderDesignGrid();
}

/* ----------------------------------------------------------
   Remove a design from the comparison.
   ---------------------------------------------------------- */
function removeDesign(designId){
  /* Dispose any LabRaymarcher attached to this design before pulling it
     from state, so its GL context and texture are freed immediately. */
  if (typeof disposeRaymarcher === 'function') disposeRaymarcher(designId);
  if (typeof disposeStiffnessViz === 'function') disposeStiffnessViz(designId);
  /* Sprint A — drop this id's transient per-design caches so a later design
     reusing the id can never be served these results (the elastic cache lives
     on the design object's d.results and leaves with it).  A run in flight is
     cancelled: its comparison set just changed and its jobs would write here. */
  if (typeof RUN_STATE !== 'undefined' && RUN_STATE.running && typeof cancelRun === 'function') cancelRun();
  if (typeof BUCKLE_BY_DESIGN !== 'undefined') delete BUCKLE_BY_DESIGN[designId];
  if (typeof NONLIN_BY_DESIGN !== 'undefined') delete NONLIN_BY_DESIGN[designId];
  if (typeof NONLIN_AXES !== 'undefined') delete NONLIN_AXES[designId];

  LAB_STATE.designs = LAB_STATE.designs.filter(function(d){ return d.id !== designId; });
  if (typeof reconcileDesignSlots === 'function') reconcileDesignSlots();   /* freed slot returns to the pool; survivors keep theirs */
  if (LAB_STATE.baselineId === designId && LAB_STATE.designs.length > 0){
    LAB_STATE.baselineId = LAB_STATE.designs[0].id;
  }
  // Reset run state — comparison set has changed
  LAB_STATE.runHasCompleted = false;
  LAB_STATE.winningId = null;
  if (typeof updateActionButtons === 'function') updateActionButtons();
  if (typeof updateLoadedPill === 'function') updateLoadedPill();
  renderDesignGrid();
}


/* ----------------------------------------------------------
   A.3 — Compute σ_VM max across all three captured axes for a
   design.  Returns the per-design shared stress range so the
   colormap stays calibrated when toggling X/Y/Z (axis with
   highest stress saturates yellow, others closer to blue).

   Returns 0 if no axes have data (caller should hide the
   colorbar in that case).
   ---------------------------------------------------------- */
function computeStressMaxAcrossAxes(fieldsByAxis){
  if (!fieldsByAxis) return 0;
  var globalMax = 0;
  /* Piece B — all six Voigt axes carry σ_VM; shear axes have null u_prime
     but their sigma_vm is fully populated. */
  var axes = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  for (var i = 0; i < axes.length; i++){
    var f = fieldsByAxis[axes[i]];
    if (!f || !f.sigma_vm) continue;
    var sv = f.sigma_vm;
    for (var j = 0; j < sv.length; j++){
      if (sv[j] > globalMax) globalMax = sv[j];
    }
  }
  return globalMax;   /* MPa — same units as Es_MPa in mat config */
}


/* ----------------------------------------------------------
   A.3.3 — Compute σ_VM distribution stats across all three
   captured axes for one design.

   Returns { p95, median, max, autoGamma }.

   p95       — 95th percentile of significant voxels (excludes
               void via 1%-of-max threshold).  Used as the
               colormap top in per-design mode.
   median    — 50th percentile of the same pool.  Used to
               compute autoGamma.
   max       — true max σ_VM across all voxels.  Surfaced in
               the readout for honest reporting.
   autoGamma — γ chosen so that median, after pow(t, γ) remap,
               lands at the colormap midpoint (0.5).  Clamped
               to [0.3, 1.0] so the remap never under-shoots
               (heavy darkening) or over-shoots (raising 1.0
               above 1.0 makes no visual sense).

   For sheet-TPMS-style structures with tight distributions
   (median ≈ p95/2), autoGamma comes out near 1.0 → no
   visual change.  For thin-wall and long-tail structures,
   autoGamma comes out lower (0.3-0.5) and significantly
   brightens the visible low-stress bulk.

   Cost: one sort of significant-voxel array (~30K-100K
   floats), ~20-50 ms at N=32.  Replaces the separate
   computeStressP95AcrossAxes call.
   ---------------------------------------------------------- */
function computeStressStatsForAxes(fieldsByAxis, axes){
  var noData = { p95: 0, median: 0, max: 0, autoGamma: 1.0 };
  if (!fieldsByAxis) return noData;
  /* Piece B — pools σ_VM across all six Voigt axes for per-design stats.
     This makes p95/median sensitive to shear-LC stress concentrations,
     which is correct: per-design auto-cap should reflect the full
     loading envelope, not just the normal-axis subset. */
  if (!axes || !axes.length) axes = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];

  /* Pass 1: global max */
  var globalMax = 0;
  for (var i = 0; i < axes.length; i++){
    var f = fieldsByAxis[axes[i]];
    if (!f || !f.sigma_vm) continue;
    var sv = f.sigma_vm;
    for (var j = 0; j < sv.length; j++){
      if (sv[j] > globalMax) globalMax = sv[j];
    }
  }
  if (globalMax === 0) return noData;

  /* Pass 2: count significant voxels (>1% of max — excludes void) */
  var threshold = globalMax * 0.01;
  var nSig = 0;
  for (var i2 = 0; i2 < axes.length; i2++){
    var f2 = fieldsByAxis[axes[i2]];
    if (!f2 || !f2.sigma_vm) continue;
    var sv2 = f2.sigma_vm;
    for (var j2 = 0; j2 < sv2.length; j2++){
      if (sv2[j2] > threshold) nSig++;
    }
  }
  if (nSig === 0) {
    return { p95: globalMax, median: globalMax * 0.5, max: globalMax, autoGamma: 1.0 };
  }

  /* Pass 3: collect, sort, extract p95 + median */
  var significant = new Float32Array(nSig);
  var idx = 0;
  for (var i3 = 0; i3 < axes.length; i3++){
    var f3 = fieldsByAxis[axes[i3]];
    if (!f3 || !f3.sigma_vm) continue;
    var sv3 = f3.sigma_vm;
    for (var j3 = 0; j3 < sv3.length; j3++){
      if (sv3[j3] > threshold) significant[idx++] = sv3[j3];
    }
  }
  significant.sort();
  var p95 = significant[Math.floor(nSig * 0.95)];
  var median = significant[Math.floor(nSig * 0.50)];

  /* Auto-gamma: map median to colormap midpoint (0.5).
     γ such that pow(median/p95, γ) = 0.5  →  γ = log(0.5)/log(medianNorm). */
  var autoGamma = 1.0;
  if (p95 > 0) {
    var medianNorm = median / p95;
    if (medianNorm > 0.01 && medianNorm < 0.99) {
      autoGamma = Math.log(0.5) / Math.log(medianNorm);
      autoGamma = Math.max(0.3, Math.min(1.0, autoGamma));
    }
  }

  return { p95: p95, median: median, max: globalMax, autoGamma: autoGamma };
}

/* Pool across all six Voigt axes (shared mode + honest readout max).  Kept as
   a thin wrapper so existing callers are unchanged. */
function computeStressStatsAcrossAxes(fieldsByAxis){
  return computeStressStatsForAxes(fieldsByAxis, ['xx', 'yy', 'zz', 'yz', 'xz', 'xy']);
}


/* A.3.3 — Compute global σ_VM p95 across ALL designs in the
   comparison set, for shared-mode normalization.

   Pools significant voxels (>1% of each design's max) from all
   axes of all designs, then takes the 95th percentile of the
   pooled distribution.  This is what every design's uploadFields
   uses as its stress cap in shared mode, so "yellow" anywhere
   maps to the same σ_VM value.

   In shared mode, gamma is fixed at 1.0 — linear cividis — so
   cross-design comparison is direct.

   Returns 0 if no designs have field data yet.
   ---------------------------------------------------------- */
function computeGlobalStressP95(designs){
  if (!designs || designs.length === 0) return 0;
  /* Piece B — shared-mode pool covers all six Voigt axes across all
     designs.  Shear-LC σ_VM tends to concentrate at material interfaces;
     the resulting global p95 is tighter than the pre-Piece-B normal-only
     pool.  Users can dial up the sat slider to brighten low-stress
     designs against this stricter cap. */
  var axes = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];

  /* Pass 1: global max across ALL designs */
  var globalMax = 0;
  for (var d = 0; d < designs.length; d++){
    var fb = designs[d].results && designs[d].results._fieldsByAxis;
    if (!fb) continue;
    for (var i = 0; i < axes.length; i++){
      var f = fb[axes[i]];
      if (!f || !f.sigma_vm) continue;
      var sv = f.sigma_vm;
      for (var j = 0; j < sv.length; j++){
        if (sv[j] > globalMax) globalMax = sv[j];
      }
    }
  }
  if (globalMax === 0) return 0;

  /* Pass 2: count significant voxels across all designs+axes */
  var threshold = globalMax * 0.01;
  var nSig = 0;
  for (var d2 = 0; d2 < designs.length; d2++){
    var fb2 = designs[d2].results && designs[d2].results._fieldsByAxis;
    if (!fb2) continue;
    for (var i2 = 0; i2 < axes.length; i2++){
      var f2 = fb2[axes[i2]];
      if (!f2 || !f2.sigma_vm) continue;
      var sv2 = f2.sigma_vm;
      for (var j2 = 0; j2 < sv2.length; j2++){
        if (sv2[j2] > threshold) nSig++;
      }
    }
  }
  if (nSig === 0) return globalMax;

  /* Pass 3: collect + sort + p95 */
  var significant = new Float32Array(nSig);
  var idx = 0;
  for (var d3 = 0; d3 < designs.length; d3++){
    var fb3 = designs[d3].results && designs[d3].results._fieldsByAxis;
    if (!fb3) continue;
    for (var i3 = 0; i3 < axes.length; i3++){
      var f3 = fb3[axes[i3]];
      if (!f3 || !f3.sigma_vm) continue;
      var sv3 = f3.sigma_vm;
      for (var j3 = 0; j3 < sv3.length; j3++){
        if (sv3[j3] > threshold) significant[idx++] = sv3[j3];
      }
    }
  }
  significant.sort();
  return significant[Math.floor(nSig * 0.95)];
}


/* A.3 / A.3.1 / A.3.3 — Resolve the (cap, gamma) pair for one design's
   stress upload, based on the current normalization mode.

   per-design mode (default):
     cap   = p95 of this design's own σ_VM
     gamma = auto-tuned so the design's median maps to colormap midpoint
   shared mode:
     cap   = global p95 across ALL designs
     gamma = 1.0 (linear cividis for honest cross-comparison)

   4b — both modes multiply the resolved cap by the per-design user
   saturation slider (0..2, default 1.0).  Slider value 1.0 is a no-op.
   Sub-1 values pull the cap down (earlier saturation; high-stress regions
   blow out); super-1 values push the cap up (de-saturation; peak stress
   reads as mid-spectrum).

   Returns { cap, gamma, mode } in MPa / unitless / string.
   ---------------------------------------------------------- */
/* #5 — rotating axis-gimbal overlay markup.  Neutral slate triad with X/Y/Z
   letters; the viewer's _updateGimbal() rewrites the line endpoints + label
   positions each frame via the shared labGimbal* helpers.  Replaces the old
   static corner label so the axes actually track the rendered rotation. */
function buildGimbalOverlay(){
  return '<div class="vp-gimbal" aria-hidden="true">' +
    '<svg viewBox="-22 -22 44 44">' +
      '<line class="gax gx" x1="0" y1="0" x2="15" y2="0"></line>' +
      '<line class="gax gy" x1="0" y1="0" x2="0" y2="-15"></line>' +
      '<line class="gax gz" x1="0" y1="0" x2="0" y2="0"></line>' +
      '<circle class="gctr" cx="0" cy="0" r="1.6"></circle>' +
      '<text class="glb glx" x="21" y="3">X</text>' +
      '<text class="glb gly" x="0" y="-19">Y</text>' +
      '<text class="glb glz" x="0" y="3">Z</text>' +
    '</svg></div>';
}

/* #6b — p99 cap for the nonlinear plastic-strain (alpha) colormap.  Using the
   raw max lets a single hot voxel pin the scale and wash the body to one color;
   clipping at the 99th percentile of the fully-crushed (final-step) significant
   alpha distributes color across the whole cell.  Cached on nl._p99cap. */
function nlAlphaCap(nl){
  if (!nl || !nl.alphaSteps || !nl.alphaSteps.length) return 0;
  if (nl._p99cap !== undefined) return nl._p99cap;
  var last = nl.alphaSteps[nl.alphaSteps.length - 1].alpha;
  var fallback = (nl.alphaMax && nl.alphaMax > 0) ? nl.alphaMax : 0;
  if (!last || !last.length){ nl._p99cap = fallback; return fallback; }
  var i, mx = 0;
  for (i = 0; i < last.length; i++){ if (last[i] > mx) mx = last[i]; }
  if (mx <= 0){ nl._p99cap = 0; return 0; }
  var thr = mx * 0.001, n = 0;
  for (i = 0; i < last.length; i++){ if (last[i] > thr) n++; }
  if (n === 0){ nl._p99cap = mx; return mx; }
  var arr = new Float32Array(n), k = 0;
  for (i = 0; i < last.length; i++){ if (last[i] > thr) arr[k++] = last[i]; }
  arr.sort();
  var cap = arr[Math.floor(0.99 * (n - 1))];
  nl._p99cap = (cap > 0) ? cap : (fallback > 0 ? fallback : mx);
  return nl._p99cap;
}

function resolveStressDisplay(design, allDesigns){
  var mode = (typeof getStressNormMode === 'function') ? getStressNormMode() : 'per';
  var sat  = (typeof getStressSat === 'function') ? getStressSat(design.id) : 1.0;
  if (mode === 'shared') {
    var globalP95 = computeGlobalStressP95(allDesigns);
    return { cap: globalP95 * sat, gamma: 1.0, mode: 'shared' };
  }
  /* per-design, per-DISPLAYED-axis (#3): cap/gamma reflect only the axis
     currently shown, so low-magnitude shear axes (yz/xz/xy) are no longer
     washed out by a cap pooled from the larger normal-axis stresses.  The
     'shared' toggle (handled above) still pools globally across axes/designs. */
  var axis = (typeof getStressAxis === 'function') ? getStressAxis(design.id) : 'zz';
  var stats = computeStressStatsForAxes(design.results && design.results._fieldsByAxis, [axis]);
  return { cap: stats.p95 * sat, gamma: stats.autoGamma, mode: 'per' };
}


/* A.3.1 — Backward-compat wrapper around stats.p95.  Some readout code
   still calls this directly. */
function computeStressP95AcrossAxes(fieldsByAxis){
  return computeStressStatsAcrossAxes(fieldsByAxis).p95;
}


/* ----------------------------------------------------------
   A.3 / A.3.3 — Build the stress-mode colorbar overlay HTML.

   Renders a small vertical bar on the right side of the
   viewport with a CSS-gradient approximation of cividis.

   capMPa  — value at the top of the colorbar (yellow saturation).
             In per-design mode this is the design's own p95.
             In shared mode this is the global p95 across all
             designs.
   gamma   — non-linear remap exponent applied in the shader
             before the colormap lookup.  In per-design mode
             this is auto-tuned; in shared mode it's 1.0.
   mode    — 'per' or 'shared'.  Drives the small annotation
             below the cap value so users know which mode they
             are looking at and whether the colormap is linear
             in σ_VM.
   ---------------------------------------------------------- */
function buildStressColorbar(capMPa, gamma, mode){
  /* 4b — Cividis stops sampled at t = i/7 from matplotlib cividis (same
     8 anchors used by the shader cividis() function).  CSS percentages
     match: i/7 × 100% for i = 0..7. */
  /* Format the cap in sensible units */
  var capStr;
  if (capMPa >= 1000) capStr = (capMPa/1000).toFixed(2) + ' GPa';
  else if (capMPa >= 1) capStr = capMPa.toFixed(1) + ' MPa';
  else if (capMPa > 0) capStr = capMPa.toExponential(1) + ' MPa';
  else capStr = '—';

  /* Suffix annotation:
       per-design with γ<1 — "p95 γ=X.XX"  (non-linear, auto-tuned)
       per-design with γ=1 — "p95"          (already linear naturally)
       shared              — "global p95"   (cross-design comparable)  */
  var suffixText;
  if (mode === 'shared') suffixText = 'global p95';
  else if (gamma < 0.99) suffixText = 'p95 · γ=' + gamma.toFixed(2);
  else                   suffixText = 'p95';
  return '<div class="stress-colorbar-header">von Mises stress</div>' +
         '<div class="stress-colorbar"></div>' +
         '<div class="stress-colorbar-label-top">'+capStr +
           '<span class="stress-colorbar-suffix">'+suffixText+'</span></div>' +
         '<div class="stress-colorbar-label-bot">0</div>';
}


/* ════════════════════════════════════════════════════════════════════════
   Phase-6 tie-up #1 — NONLINEAR-TAB VISUALIZER (NLVIZ)
   The relabeled "Nonlinear" tab pairs the merged σ–ε plot (left) with up to
   three small raymarcher cubes (right) that loop the crush deformation colored
   by plastic strain (α).  One shared scrubber drives all cubes in lockstep:
   it auto-loops on entry, then hands control to the user on first slider touch.

   α (captured per accepted crush step at the solver's N, default 16³) RIDES ON
   the crush — i.e. it is uploaded as the raymarcher's scalar field while the
   deformation warp uses the elastic u'(x) (at the elastic run-N), and α is
   trilinearly upsampled to that elastic N so color and geometry co-register.
   ════════════════════════════════════════════════════════════════════════ */

var NLVIZ = {
  playing:   true,     /* auto-loop until the user grabs the slider */
  manual:    false,    /* latched true after first slider interaction */
  frac:      0,        /* 0..1 position along the shared crush timeline */
  raf:       null,
  t0:        0,
  periodMs:  3000,     /* one full crush loop */
  maxAmp:    0.32,     /* deform-slider units at full crush (≈6.4% cell) */
  entries:   [],       /* [{ id, design, nl, elastic, axisKey, n }] */
  lastInt:   {}        /* id -> last integer step uploaded (skip redundant texture swaps) */
};

/* Trilinear upsample of a scalar field Ns³ -> Nd³ (i*N²+j*N+k order, periodic
   wrap to match the cell's periodicity).  Run once per integer step change. */
function upsampleScalarTrilinear(src, Ns, Nd){
  if (!src) return src;
  if (Ns === Nd) return src;
  var out = new Float32Array(Nd * Nd * Nd);
  var Ns2 = Ns * Ns, Nd2 = Nd * Nd, r = Ns / Nd;
  for (var i = 0; i < Nd; i++){
    var fx = i * r, x0 = Math.floor(fx) % Ns, x1 = (x0 + 1) % Ns, tx = fx - Math.floor(fx);
    for (var j = 0; j < Nd; j++){
      var fy = j * r, y0 = Math.floor(fy) % Ns, y1 = (y0 + 1) % Ns, ty = fy - Math.floor(fy);
      for (var k = 0; k < Nd; k++){
        var fz = k * r, z0 = Math.floor(fz) % Ns, z1 = (z0 + 1) % Ns, tz = fz - Math.floor(fz);
        var c000 = src[x0*Ns2 + y0*Ns + z0], c001 = src[x0*Ns2 + y0*Ns + z1];
        var c010 = src[x0*Ns2 + y1*Ns + z0], c011 = src[x0*Ns2 + y1*Ns + z1];
        var c100 = src[x1*Ns2 + y0*Ns + z0], c101 = src[x1*Ns2 + y0*Ns + z1];
        var c110 = src[x1*Ns2 + y1*Ns + z0], c111 = src[x1*Ns2 + y1*Ns + z1];
        var c00 = c000 + (c001 - c000) * tz, c01 = c010 + (c011 - c010) * tz;
        var c10 = c100 + (c101 - c100) * tz, c11 = c110 + (c111 - c110) * tz;
        var c0 = c00 + (c01 - c00) * ty, c1 = c10 + (c11 - c10) * ty;
        out[i*Nd2 + j*Nd + k] = c0 + (c1 - c0) * tx;
      }
    }
  }
  return out;
}

/* v0.16.0 — compact "other axes" row on a crush metric card: modulus and
   yield of the axes not in view, e.g. "X 1.21 GPa · 38 MPa  Y …". */
function nlOtherAxesRow(id, viewAx){
  if (typeof nlAvailableAxes !== 'function') return '';
  var av = nlAvailableAxes(id), parts = [];
  for (var i = 0; i < av.length; i++){
    if (av[i] === viewAx) continue;
    var e = nlAxisEntry(id, av[i]);
    var y = (e.yielded && isFinite(e.sigma_y_eff)) ? fmtEngMPa(e.sigma_y_eff) : (isFinite(e.sigmaCap) ? '> ' + fmtEngMPa(e.sigmaCap) : 'no yield');
    parts.push(av[i].charAt(0).toUpperCase() + ' ' + (isFinite(e.E0) ? fmtEngMPa(e.E0) : '\u2014') + ' \u00b7 ' + y);
  }
  if (!parts.length) return '';
  return '<div class="nl-mc-row nl-mc-other"><span>Other axes</span><b>' + parts.join('<br>') + '</b></div>';
}

/* Gather up to 3 loaded designs that have a usable α progression. */
function nlEntries(){
  var out = [];
  for (var i = 0; i < LAB_STATE.designs.length && out.length < 3; i++){
    var d = LAB_STATE.designs[i];
    var nl = (typeof nlForView === 'function') ? nlForView(d.id) : ((typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[d.id] : null);
    if (!nl || nl.error || !nl.alphaSteps || !nl.alphaSteps.length) continue;
    var axisKey = nl.axis || 'zz';
    var elastic = (d.results && d.results._fieldsByAxis) ? d.results._fieldsByAxis[axisKey] : null;
    out.push({ id: d.id, design: d, nl: nl, elastic: elastic, axisKey: axisKey, n: nl.alphaSteps.length });
  }
  return out;
}

function nlCubeLabel(d){
  if (d.label && d.label.indexOf('\u00b7') >= 0) return d.label.split('\u00b7').pop().trim();
  return d.label || d.name || d.id;
}

/* Build the cube column + scrubber, mount raymarchers, prime each one for the
   α-on-crush view, and start the auto-loop. */
function renderNonlinearViz(){
  var cubes = document.getElementById('mergedCubes');
  var scrub = document.getElementById('mergedScrubber');
  var metrics = document.getElementById('mergedMetrics');
  var view  = document.getElementById('mergedView');
  if (!cubes || !scrub || !view) return;

  var entries = nlEntries();
  NLVIZ.entries = entries;
  NLVIZ.lastInt = {};

  /* No α data → keep the merged plot full-width, hide cubes + metrics + scrubber. */
  if (!entries.length){
    nlvizStop();
    view.classList.remove('has-cubes');
    cubes.style.display = 'none';
    scrub.style.display = 'none';
    cubes.innerHTML = '';
    scrub.innerHTML = '';
    if (metrics){ metrics.style.display = 'none'; metrics.innerHTML = ''; }
    return;
  }

  view.classList.add('has-cubes');
  cubes.style.display = '';
  scrub.style.display = '';
  if (metrics) metrics.style.display = '';

  /* Cube tiles (each reuses the design's shared raymarcher via .rm-mount). */
  var ch = '';
  for (var i = 0; i < entries.length; i++){
    var e = entries[i], lab = nlCubeLabel(e.design);
    ch += '<div class="nl-cube">' +
            '<div class="nl-cube-head"><span class="dot" style="background:' + e.design.color + '"></span>' +
              '<span class="nm">' + lab + '</span></div>' +
            '<div class="rm-mount" data-design-id="' + e.id + '"></div>' +
            '<div class="nl-cube-readout" id="nlcr-' + e.id + '">\u03b5 0.00%</div>' +
          '</div>';
  }
  cubes.innerHTML = ch;

  /* Shared scrubber.  v0.16.0 — axis switch (X/Y/Z) on the left when more
     than one axis has been crushed for any design. */
  var axSeen = {}, axCount = 0;
  for (var ai = 0; ai < LAB_STATE.designs.length; ai++){
    var avl = (typeof nlAvailableAxes === 'function') ? nlAvailableAxes(LAB_STATE.designs[ai].id) : [];
    for (var aj = 0; aj < avl.length; aj++) if (!axSeen[avl[aj]]){ axSeen[avl[aj]] = 1; axCount++; }
  }
  var axSw = '';
  var plotHasFocus = (typeof CURVE_PLOTLY !== 'undefined') && !CURVE_PLOTLY.failed;   /* v0.17.0 — the plot header's Focus switch drives the cubes */
  if (axCount > 1 && !plotHasFocus){
    var curView = entries[0].axisKey;
    axSw = '<span class="nl-axis-sw" title="Crush axis shown in the preview and metric cards (bold on the plot)">';
    for (var ak = 0; ak < 3; ak++){
      var axk = ['xx', 'yy', 'zz'][ak];
      axSw += '<button class="nl-axis-btn' + (axk === curView ? ' active' : '') + '"' + (axSeen[axk] ? '' : ' disabled') +
              ' onclick="onNonlinViewAxis(\'' + axk + '\')">' + axk.charAt(0).toUpperCase() + '</button>';
    }
    axSw += '</span>';
  }
  scrub.innerHTML = axSw +
    '<button class="nl-play" id="nlPlayBtn" title="Play / pause">\u275a\u275a</button>' +
    '<div class="nl-track-wrap">' +
      '<div class="nl-ticks" id="nlTicks"></div>' +
      '<input type="range" id="nlScrub" min="0" max="1000" value="0" step="1">' +
    '</div>' +
    '<span class="nl-readout" id="nlReadout">crush \u03b5 0.00%</span>';

  /* v0.17.0 — per-design crush KPIs: modulus and yield on the preview axis,
     the weakest crushed axis, buckling-to-yield on the preview axis, and the
     per-cell Load Capacity; warnings underneath. */
  if (metrics){
    var mh = '';
    for (var mi = 0; mi < entries.length; mi++){
      var em = entries[mi], nlm = em.nl, axU = em.axisKey.charAt(0).toUpperCase();
      var crushMod = isFinite(nlm.E0) ? fmtEngMPa(nlm.E0) : '—';
      var yStr = (nlm.yielded && isFinite(nlm.sigma_y_eff)) ? fmtEngMPa(nlm.sigma_y_eff)
                 : (isFinite(nlm.sigmaCap) ? ('> ' + fmtEngMPa(nlm.sigmaCap)) : 'no yield');
      var lc = loadCapacity(em.design);
      var loadStr = lc ? fmtForceN(lc.N) : '—';
      var wk = null, wkAx = '';
      var avAx = (typeof nlAvailableAxes === 'function') ? nlAvailableAxes(em.id) : [];
      for (var wa = 0; wa < avAx.length; wa++){
        var we = nlAxisEntry(em.id, avAx[wa]);
        if (we && we.yielded && isFinite(we.sigma_y_eff) && (wk == null || we.sigma_y_eff < wk)){ wk = we.sigma_y_eff; wkAx = avAx[wa].charAt(0).toUpperCase(); }
      }
      var bkm = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[em.id] : null;
      var pcrAx = (typeof _mpAxisPcr === 'function') ? _mpAxisPcr(bkm, em.axisKey) : null;
      var bRat = (pcrAx != null && nlm.yielded && nlm.sigma_y_eff > 0) ? pcrAx / nlm.sigma_y_eff : null;
      var kpi = function(v, k, warn){ return '<div class="nl-kpi' + (warn ? ' warn' : '') + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; };
      var warns = '';
      if (typeof voidLimited === 'function' && voidLimited(nlm.E0, nlm.Es_MPa, nlm.voidContrast))
        warns += '<div class="nl-mc-warn">⚠ void-limited · void ' + nlm.voidContrast.toExponential(0) + ' of solid</div>';
      if (nlm.voidScaled === false) warns += '<div class="nl-mc-warn">⚠ void not scaled · run Elastic too</div>';
      if (nlm.lateralFloor > (typeof NL_LATERAL_FLAG !== 'undefined' ? NL_LATERAL_FLAG : 0.05))
        warns += '<div class="nl-mc-warn" title="The side stress of this crush could only be resolved to about ' + Math.round(nlm.lateralFloor * 100) + '% of the axial stress at the solver\'s tolerance. The elastic slope and the yield onset hold; the curve past yield is approximate.">⚠ post-yield approximate · side stress ±' + Math.round(nlm.lateralFloor * 100) + '%</div>';
      if (nlm.truncated) warns += '<div class="nl-mc-warn">⚠ partial curve' + (nlm.truncReason ? ' (' + nlm.truncReason + ')' : '') + '</div>';
      mh += '<div class="nl-metric-card nl-kpi-card" style="--c:' + em.design.color + '">' +
              '<div class="nl-mc-head"><span class="dot"></span><b>' + nlCubeLabel(em.design) + '</b>' +
                '<span class="t">' + (em.design.title || '') + '</span><span class="ax">' + axU + ' crush</span></div>' +
              '<div class="nl-kpis">' +
                kpi(crushMod, 'E · ' + axU) +
                kpi(yStr, 'σ<sub>y</sub> · ' + axU) +
                (avAx.length > 1 ? kpi(wk != null ? fmtEngMPa(wk) : '—', 'weakest · ' + (wkAx || '—')) : '') +
                kpi(bRat != null ? (bRat >= 10 ? bRat.toFixed(0) : bRat.toFixed(1)) + '×' : '—', 'σ<sub>cr</sub> / σ<sub>y</sub> · ' + axU, bRat != null && bRat < 1) +
                kpi(loadStr, 'load capacity') +
              '</div>' + warns +
            '</div>';
    }
    metrics.innerHTML = mh;
  }

  /* ε_cr onset ticks (per design, colored): mark where the buckling cross-over
     σ_cr would be reached in strain (ε_cr = σ_cr / E0), as a fraction of that
     design's displayed crush range.  A tick that sits before the yield knee is
     the "buckling-limited" warning the merged plot also annotates. */
  var ticks = document.getElementById('nlTicks'), th = '';
  for (var t = 0; t < entries.length; t++){
    var et = entries[t];
    var bk = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[et.id] : null;
    var pcr = (bk && !bk.error && isFinite(bk.pcr)) ? bk.pcr : null;
    var E0 = et.nl.E0;
    var epsMax = nlvizEpsMax();   /* v0.17.0 — one strain timeline for every cube */
    if (pcr != null && isFinite(E0) && E0 > 0 && epsMax > 0){
      var ecr = pcr / E0;
      var frac = Math.max(0, Math.min(1, ecr / epsMax));
      th += '<span class="nl-tick" title="\u03b5_cr (buckling onset)" style="left:' + (frac * 100).toFixed(2) + '%;background:' + et.design.color + '"></span>';
    }
  }
  if (ticks) ticks.innerHTML = th;

  /* Ensure each design has a raymarcher, then mount canvases into the cubes. */
  for (var m = 0; m < entries.length; m++){
    var em = entries[m];
    var rcp = (typeof recipeForDesign === 'function') ? recipeForDesign(em.design) : null;
    if (rcp && typeof getOrCreateRaymarcher === 'function') getOrCreateRaymarcher(em.id, rcp);
  }
  if (typeof mountRaymarcherTiles === 'function') mountRaymarcherTiles();

  /* Prime each raymarcher: upload elastic u'(x) once + α step-0 as the scalar,
     turbo colormap, stress (warp+color) mode, no auto-pulse (the scrubber drives
     the deformation), unit gamma. */
  for (var q = 0; q < entries.length; q++){
    var eq = entries[q];
    var rm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[eq.id] : null;
    if (!rm) continue;
    var Nd = (eq.elastic && eq.elastic.N) ? eq.elastic.N : eq.nl.N;
    var uPrime = (eq.elastic && eq.elastic.u_prime) ? eq.elastic.u_prime : null;
    var a0 = upsampleScalarTrilinear(eq.nl.alphaSteps[0].alpha, eq.nl.N, Nd);
    var cap = nlAlphaCap(eq.nl);   /* #6b — p99 cap */
    if (rm.uploadFields) rm.uploadFields({ u_prime: uPrime, sigma_vm: a0, N: Nd,
                                           eps_bar: (eq.elastic && eq.elastic.eps_bar) ? eq.elastic.eps_bar : null }, cap);
    if (rm.setBuckleMap)   rm.setBuckleMap(true);     /* turbo ramp for α */
    if (rm.setPulse)       rm.setPulse(false);
    if (rm.setStressGamma) rm.setStressGamma(1.0);
    if (rm.setViewMode)    rm.setViewMode('stress');
    if (rm.setDeformSign)  rm.setDeformSign(-1);   /* #6a — crush compresses, not expands */
    if (rm.setMacroAmp)    rm.setMacroAmp(0);      /* #6 fix — bounded axial stretch (decoupled from uPrimeMaxNorm) */
    if (rm.setDeformAmp)   rm.setDeformAmp(0);
    if (rm.setActive)      rm.setActive(true);   /* render now; IO will manage it thereafter */
    eq._Nd = Nd;
    NLVIZ.lastInt[eq.id] = -1;
  }

  /* Wire scrubber interactions. */
  var slider = document.getElementById('nlScrub');
  var playBtn = document.getElementById('nlPlayBtn');
  if (slider){
    slider.addEventListener('input', function(){
      NLVIZ.manual = true;
      NLVIZ.playing = false;
      if (playBtn) playBtn.innerHTML = '\u25b6';
      NLVIZ.frac = (+this.value) / 1000;
      nlvizApply(NLVIZ.frac);
    });
  }
  if (playBtn){
    playBtn.addEventListener('click', function(){
      NLVIZ.pinned = false;
      NLVIZ.playing = !NLVIZ.playing;
      this.innerHTML = NLVIZ.playing ? '\u275a\u275a' : '\u25b6';
      if (NLVIZ.playing){
        NLVIZ.manual = false;
        NLVIZ.t0 = performance.now() - NLVIZ.frac * NLVIZ.periodMs;
        if (!NLVIZ.raf) NLVIZ.raf = requestAnimationFrame(nlvizTick);
      }
    });
  }

  /* Start the auto-loop. */
  NLVIZ.manual = false;
  NLVIZ.playing = true;
  NLVIZ.frac = 0;
  NLVIZ.t0 = performance.now();
  nlvizApply(0);
  if (NLVIZ.raf) cancelAnimationFrame(NLVIZ.raf);
  NLVIZ.raf = requestAnimationFrame(nlvizTick);
}

/* Apply a timeline fraction to every cube: pick each design's step, swap the α
   texture only when the integer step changes, scale the deformation with the
   step, and update the readouts. */
/* v0.17.0 — the scrubber is a STRAIN timeline shared by every cube (0 ..
   the largest crushed strain), so it lines up with the stress–strain plot:
   each cube shows its last solved step at or below the scrubber strain. */
function nlvizEpsMax(){
  var m = 0, en = NLVIZ.entries || [];
  for (var i = 0; i < en.length; i++){ var s = en[i].nl.alphaSteps; if (s && s.length && s[s.length - 1].eps > m) m = s[s.length - 1].eps; }
  return m;
}
function nlvizScrubToEps(eps, kind){
  var m = nlvizEpsMax(); if (!(m > 0)) return;
  if (kind === 'hover' && !NLVIZ.hovering){ NLVIZ.hovering = true; NLVIZ.resumePlay = NLVIZ.playing && !NLVIZ.pinned; }
  if (kind === 'pin'){ NLVIZ.pinned = true; NLVIZ.resumePlay = false; }
  NLVIZ.playing = false;
  NLVIZ.manual = true;
  var pb = document.getElementById('nlPlayBtn'); if (pb) pb.innerHTML = '▶';
  NLVIZ.frac = Math.max(0, Math.min(1, eps / m));
  var sl = document.getElementById('nlScrub'); if (sl) sl.value = Math.round(NLVIZ.frac * 1000);
  nlvizApply(NLVIZ.frac);
}
function nlvizScrubRelease(){
  if (!NLVIZ.hovering) return;
  NLVIZ.hovering = false;
  if (NLVIZ.resumePlay && !NLVIZ.pinned){
    NLVIZ.playing = true; NLVIZ.manual = false;
    var pb = document.getElementById('nlPlayBtn'); if (pb) pb.innerHTML = '❚❚';
    NLVIZ.t0 = performance.now() - NLVIZ.frac * NLVIZ.periodMs;
    if (!NLVIZ.raf) NLVIZ.raf = requestAnimationFrame(nlvizTick);
  }
}

function nlvizApply(frac){
  var entries = NLVIZ.entries || [];
  var leadEps = 0, target = frac * nlvizEpsMax();
  for (var i = 0; i < entries.length; i++){
    var e = entries[i], n = e.n;
    if (n < 1) continue;
    var rm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[e.id] : null;
    if (!rm) continue;
    var si = 0;
    for (var sk = 0; sk < n; sk++) if (e.nl.alphaSteps[sk].eps <= target + 1e-12) si = sk;
    if (si !== NLVIZ.lastInt[e.id]){
      var Nd = e._Nd || ((e.elastic && e.elastic.N) ? e.elastic.N : e.nl.N);
      var aUp = upsampleScalarTrilinear(e.nl.alphaSteps[si].alpha, e.nl.N, Nd);
      var cap = nlAlphaCap(e.nl);   /* #6b — p99 cap */
      if (rm.updateScalarField) rm.updateScalarField(aUp, Nd, cap);
      NLVIZ.lastInt[e.id] = si;
    }
    if (rm.setDeformAmp) rm.setDeformAmp(NLVIZ.maxAmp * (n > 1 ? si / (n - 1) : 0));
    /* #6 fix — bounded axial-compression factor, scaled by this cube's actual
       strain (real ~2.5% crush exaggerated ~6x to a legible ~15%, hard-capped
       at 0.2 so the macro denominator can never invert). */
    if (rm.setMacroAmp){
      var epsStep = (e.nl.alphaSteps[si] && isFinite(e.nl.alphaSteps[si].eps)) ? e.nl.alphaSteps[si].eps : 0;
      rm.setMacroAmp(Math.min(0.2, 6.0 * epsStep));
    }
    var epsPct = e.nl.alphaSteps[si].eps * 100;
    if (epsPct > leadEps) leadEps = epsPct;
    var cr = document.getElementById('nlcr-' + e.id);
    if (cr) cr.textContent = '\u03b5 ' + epsPct.toFixed(2) + '%';
  }
  var slider = document.getElementById('nlScrub');
  if (slider && !NLVIZ.manual) slider.value = Math.round(frac * 1000);
  var ro = document.getElementById('nlReadout');
  if (ro) ro.textContent = 'crush \u03b5 ' + (target * 100).toFixed(2) + '%';
  if (typeof curvePlotCursor === 'function') curvePlotCursor(target * 100);   /* v0.17.0 — strain cursor on the plot */
}

function nlvizTick(ts){
  if (!NLVIZ.playing){ NLVIZ.raf = null; return; }
  var frac = ((ts - NLVIZ.t0) % NLVIZ.periodMs) / NLVIZ.periodMs;
  NLVIZ.frac = frac;
  nlvizApply(frac);
  NLVIZ.raf = requestAnimationFrame(nlvizTick);
}

function nlvizStop(){
  NLVIZ.playing = false;
  if (NLVIZ.raf){ cancelAnimationFrame(NLVIZ.raf); NLVIZ.raf = null; }
  /* Tear down the cube + scrubber DOM.  CRITICAL: #mergedView sits AFTER
     #compareGrid in document order, so any leftover cube .rm-mount (carrying
     the same data-design-id as a live grid tile) would win the last-wins
     appendChild inside mountRaymarcherTiles() and pull each design's single
     shared canvas into the hidden merged view — blanking every non-Nonlinear
     tab.  Clearing here (before the grid rebuild + remount) keeps the canvases
     with the visible grid tiles. */
  var cubes = document.getElementById('mergedCubes');
  var scrub = document.getElementById('mergedScrubber');
  var metrics = document.getElementById('mergedMetrics');
  var view  = document.getElementById('mergedView');
  if (cubes) cubes.innerHTML = '';
  if (scrub) scrub.innerHTML = '';
  if (metrics){ metrics.innerHTML = ''; metrics.style.display = 'none'; }
  if (view)  view.classList.remove('has-cubes');
  NLVIZ.entries = [];
  NLVIZ.lastInt = {};
}
