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
   For pre-run mock data the same fields have nonzero defaults from
   00-mock-data.js, so this only kicks in for real-run output. */
function fmtComputed(value, suffix, digits){
  if (LAB_STATE.runHasCompleted && value === 0) return '—';
  return value.toFixed(digits != null ? digits : 2) + (suffix || '');
}
function failureModeText(r){
  if (LAB_STATE.runHasCompleted && r.failure_mode === 'not-computed') return '(not computed)';
  if (LAB_STATE.runHasCompleted && r.failure_mode === 'no-data')      return '(no kernel)';
  return r.failure_mode;
}
function pcrPyDeltaClass(r){
  if (LAB_STATE.runHasCompleted && r.pcr_py === 0) return 'neut';
  return r.pcr_py < 1 ? 'down' : 'neut';
}

function statsForDesign(d, mode){
  var r = d.results;
  if (!r) return [];

  // Default: stiffness-flavored summary
  if (mode === 'geom' || mode === 'deform' || mode === 'stress' || mode === 'stiff'){
    return [
      { lbl:'E11',       val:r.E11.toFixed(2)+' GPa',  delta:deltaVsBaseline(r.E11, 'E11', d.id) },
      { lbl:'Zener A',   val:r.zener.toFixed(2),       delta:[zenerDescriptor(r.zener), 'neut'] },
      { lbl:'σ_y (z)',   val:fmtComputed(r.sigma_y_z, ' MPa', 1),     delta:[failureModeText(r), 'neut'] },
      { lbl:'P_cr / P_y',val:fmtComputed(r.pcr_py, '', 2),            delta:[failureModeText(r), pcrPyDeltaClass(r)] }
    ];
  }
  // Thermal mode prioritizes κ
  if (mode === 'thermal'){
    return [
      { lbl:'κ_z',    val:fmtComputed(r.kappa_z, ' W/mK', 2),     delta:[failureModeText(r), 'neut'] },
      { lbl:'ρ_rel',  val:d.rho_rel.toFixed(2),                    delta:['baseline','neut'] },
      { lbl:'E11',    val:r.E11.toFixed(2)+' GPa',                 delta:deltaVsBaseline(r.E11, 'E11', d.id) },
      { lbl:'Zener',  val:r.zener.toFixed(2),                      delta:[zenerDescriptor(r.zener), 'neut'] }
    ];
  }
  // Buckling mode prioritizes λ_cr
  if (mode === 'buckle'){
    return [
      { lbl:'λ_cr (mode 1)', val:fmtComputed(r.lambda_cr, '', 2),  delta:[failureModeText(r), pcrPyDeltaClass(r)] },
      { lbl:'σ_y (z)',       val:fmtComputed(r.sigma_y_z, ' MPa', 1), delta:[failureModeText(r), 'neut'] },
      { lbl:'P_cr / P_y',    val:fmtComputed(r.pcr_py, '', 2),      delta:[failureModeText(r), pcrPyDeltaClass(r)] },
      { lbl:'E11',           val:r.E11.toFixed(2)+' GPa',           delta:deltaVsBaseline(r.E11, 'E11', d.id) }
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
  if (d.variant === 'reaction_diffusion') return 'trabecular';
  if (d.family === 'tpms') return 'tpms';
  if (d.family === 'grain') return 'grain';
  return 'tpms';
}

/* ----------------------------------------------------------
   Main render function. Called by view-tab clicks, design
   load events, run progress, and amp-slider changes.
   ---------------------------------------------------------- */
function renderDesignGrid(){
  var grid    = document.getElementById('compareGrid');
  var merged  = document.getElementById('mergedView');
  var mPlot   = document.getElementById('mergedPlot');
  if (!grid || !merged || !mPlot) return;

  // σ–ε mode — collapse to merged plot
  if (VIEW_STATE.mode === 'curve'){
    grid.style.display   = 'none';
    merged.style.display = 'grid';
    mPlot.innerHTML = buildMergedCurvePlot();
    return;
  }

  grid.style.display   = 'grid';
  merged.style.display = 'none';

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
  var rmModes = (VIEW_STATE.mode === 'geom' || VIEW_STATE.mode === 'deform' || VIEW_STATE.mode === 'stress');
  var needsFields = (VIEW_STATE.mode === 'deform' || VIEW_STATE.mode === 'stress');
  if (rmModes) {
    for (var ri = 0; ri < LAB_STATE.designs.length && ri < 3; ri++) {
      var rd = LAB_STATE.designs[ri];
      var rcp = (typeof recipeForDesign === 'function') ? recipeForDesign(rd) : null;
      if (!rcp) continue;
      if (needsFields) {
        if (!rd.results || !rd.results._fieldsByAxis) continue;
        var rdAxis = (typeof getLoadAxis === 'function') ? getLoadAxis(rd.id) : 'z';
        if (!rd.results._fieldsByAxis[rdAxis]) continue;
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
      if (!LAB_STATE.runHasCompleted) svgInner = svgEmptyViewport('Enable Thermal · Run to see κ surface');
      else svgInner = svgThermal(d.results.zener, i);
    }
    else if (VIEW_STATE.mode === 'buckle'){
      if (!LAB_STATE.runHasCompleted) svgInner = svgEmptyViewport('Run to see buckling modes');
      else svgInner = svgBuckle(d.results.lambda_cr, d.color);
    }

    var readout = readoutForDesign(d, VIEW_STATE.mode);
    var stats = statsForDesign(d, VIEW_STATE.mode);
    /* A.3 — both deform and stress modes expose the load-axis toggle + amp
       slider (stress mode uses the same warp; colormap reads on the
       deformed shape — standard FEA viz). */
    var showControls = (VIEW_STATE.mode === 'deform' || VIEW_STATE.mode === 'stress');
    /* A.3.1 / A.3.3 — colorbar overlay only when stress raymarcher is
       mounted and fields are available.  resolveStressDisplay picks
       per-design or shared cap + gamma based on stressNormMode. */
    var showColorbar = (VIEW_STATE.mode === 'stress' && useRM &&
                        d.results && d.results._fieldsByAxis);
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

    html += '<div class="design-col">' +
      '<div class="dc-head">' +
        '<div class="dc-name">' +
          '<span class="label">'+d.label+'</span>' +
          '<span class="title">'+d.title+'</span>' +
          '<span class="source">'+sourceText+'</span>' +
        '</div>' +
        '<div class="dc-controls">' +
          '<span class="dc-status-dot '+statusClass+'" title="'+statusClass+'"></span>' +
          '<button class="dc-icon-btn" title="Set as baseline" onclick="setBaseline(\''+d.id+'\')">★</button>' +
          '<button class="dc-icon-btn" title="Remove" onclick="removeDesign(\''+d.id+'\')">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="dc-viewport">' +
        viewportInner +
        '<div class="vp-axis">+Z<br>↑ +Y<br>→ +X</div>' +
        (readout ? '<div class="vp-readout"><span class="v">'+readout+'</span></div>' : '') +
        (showColorbar ? buildStressColorbar(stressCapMPa, stressGamma, stressMode) : '') +
        (showControls
          ? (VIEW_STATE.mode === 'stress'
              ? buildStressControl(d.id,
                                   (typeof getStressSat === 'function') ? getStressSat(d.id) : 1.0,
                                   (typeof getDispInterp === 'function') ? getDispInterp(d.id) : 'linear')
              : buildDeformControl(d.id, amp,
                                   (typeof getLoadAxis === 'function') ? getLoadAxis(d.id) : 'z',
                                   (typeof getDispInterp === 'function') ? getDispInterp(d.id) : 'linear'))
          : '') +
      '</div>' +
      buildSummary(stats) +
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
    if (rdesign.results && rdesign.results._fieldsByAxis && rkrm.uploadFields) {
      var rkAxis = (typeof getLoadAxis === 'function') ? getLoadAxis(rkid) : 'z';
      var fs = rdesign.results._fieldsByAxis[rkAxis];
      if (fs) {
        /* A.3.3 — resolve cap + gamma based on current normalization mode
           (per-design auto or shared across designs). */
        var sd = resolveStressDisplay(rdesign, LAB_STATE.designs);
        rkrm.uploadFields(fs, sd.cap);
        if (rkrm.setStressGamma) rkrm.setStressGamma(sd.gamma);
      }
    }
    if (rkrm.setViewMode) rkrm.setViewMode(VIEW_STATE.mode);
    if (rkrm.setDeformAmp) rkrm.setDeformAmp(getDeformAmp(rkid));
    /* 4b — push per-design sampling kernel (linear / cubic) at mount. */
    if (rkrm.setDispInterp) rkrm.setDispInterp(
      (typeof getDispInterp === 'function') ? getDispInterp(rkid) : 'linear'
    );
  }

  /* Push 5 — Push per-design Emax to mounted StiffnessViz instances after
     mount.  Reuses the per/shared toggle from the stress-field tab (push
     4b precedent) via resolveStiffEmax → getStressNormMode.  In 'shared'
     mode every design renders against the global max E across designs;
     in 'per' mode each surface saturates against its own E_max. */
  for (var svk = 0; svk < svDesigns.length; svk++) {
    var svkid = svDesigns[svk].id;
    var svkSV = (typeof LAB_SV_REGISTRY !== 'undefined') ? LAB_SV_REGISTRY[svkid] : null;
    if (!svkSV || svkSV.failed) continue;
    var svDesign = LAB_STATE.designs[svDesigns[svk].i];
    if (typeof resolveStiffEmax === 'function') {
      svkSV.setEmaxGlobal(resolveStiffEmax(svDesign, LAB_STATE.designs));
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
        var axis = (typeof getLoadAxis === 'function') ? getLoadAxis(id) : 'z';
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

  /* 4b — Wire interp toggle (lin / cub).  On click: update state, push
     uDispInterp to the matching raymarcher, swap active class on the
     pair inline (no full re-render). */
  var interpBtns = document.querySelectorAll('.disp-interp-btn');
  for (var ib = 0; ib < interpBtns.length; ib++){
    interpBtns[ib].addEventListener('click', function(e){
      var btn = e.currentTarget;
      var id   = btn.dataset.designId;
      var mode = btn.dataset.mode;
      if (!id || !mode) return;
      if (typeof onDispInterpClick === 'function') onDispInterpClick(id, mode);
      var rm = (typeof LAB_RM_REGISTRY !== 'undefined') ? LAB_RM_REGISTRY[id] : null;
      if (rm && !rm.failed && rm.setDispInterp) {
        rm.setDispInterp(mode);
      }
      /* Swap visual active state across the pair, inline. */
      var siblings = btn.parentNode.querySelectorAll('.disp-interp-btn');
      for (var sb = 0; sb < siblings.length; sb++){
        var sibMode = siblings[sb].dataset.mode;
        var isActive = (sibMode === mode);
        siblings[sb].style.background = isActive ? '#c8f542' : 'transparent';
        siblings[sb].style.borderColor = isActive ? '#c8f542' : 'rgba(255,255,255,0.18)';
        siblings[sb].style.color = isActive ? '#0a0a0a' : 'rgba(255,255,255,0.55)';
      }
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
      if (rm && !rm.failed && rm.uploadFields && design && design.results &&
          design.results._fieldsByAxis && design.results._fieldsByAxis[axis]) {
        /* A.3.3 — resolve cap + gamma based on current normalization mode. */
        var sd2 = resolveStressDisplay(design, LAB_STATE.designs);
        rm.uploadFields(design.results._fieldsByAxis[axis], sd2.cap);
        if (rm.setStressGamma) rm.setStressGamma(sd2.gamma);
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
function buildSummary(stats){
  if (!stats || stats.length === 0) return '';
  var html = '<div class="dc-summary">';
  for (var i = 0; i < stats.length; i++){
    var s = stats[i];
    html += '<div class="dc-stat">' +
      '<span class="lbl">'+s.lbl+'</span>' +
      '<span class="val'+(s.valcls ? ' '+s.valcls : '')+'">'+s.val+'</span>' +
      '<span class="delta '+(s.delta && s.delta[1] ? s.delta[1] : 'neut')+'">'+(s.delta && s.delta[0] ? s.delta[0] : '—')+'</span>' +
      '</div>';
  }
  html += '</div>';
  return html;
}

function buildDeformControl(designId, amp, axis, interp){
  /* A.2.2 — Load-axis toggle.  Three buttons (X/Y/Z) — clicking one
     re-uploads the matching fieldset from d.results._fieldsByAxis
     to the raymarcher.  Inline styles avoid touching lab.css for
     this small addition; can be promoted to .load-axis-btn class
     selectors during a later polish pass. */
  function btn(ax) {
    var active = (axis === ax);
    var base = 'background:transparent; border:1px solid rgba(255,255,255,0.18); ' +
               'color:rgba(255,255,255,0.55); font:11px JetBrains Mono,ui-monospace,monospace; ' +
               'padding:2px 7px; cursor:pointer; letter-spacing:0.05em; line-height:1;';
    var on   = 'background:#c8f542; border-color:#c8f542; color:#0a0a0a;';
    return '<button class="load-axis-btn" data-design-id="'+designId+'" data-axis="'+ax+'" ' +
           'style="'+base + (active ? on : '') +'">'+ax.toUpperCase()+'</button>';
  }
  /* 4b — interp toggle: lin / cub.  Same visual language as X/Y/Z. */
  function ibtn(mode, label) {
    var active = (interp === mode);
    var base = 'background:transparent; border:1px solid rgba(255,255,255,0.18); ' +
               'color:rgba(255,255,255,0.55); font:11px JetBrains Mono,ui-monospace,monospace; ' +
               'padding:2px 7px; cursor:pointer; letter-spacing:0.05em; line-height:1;';
    var on   = 'background:#c8f542; border-color:#c8f542; color:#0a0a0a;';
    return '<button class="disp-interp-btn" data-design-id="'+designId+'" data-mode="'+mode+'" ' +
           'style="'+base + (active ? on : '') +'">'+label+'</button>';
  }
  var toggleStyle = 'display:inline-flex; gap:0; margin-right:8px;';
  /* 4b — slider value 0..1 now maps to "δ_max as % of cell".  Default 0.25
     → 5% cell stretch.  Step 0.01 preserves smooth slider feel. */
  return '<div class="vp-deform-control show">' +
    '<div class="load-axis-toggle" style="'+toggleStyle+'">' +
      btn('x') + btn('y') + btn('z') +
    '</div>' +
    '<label>amp</label>' +
    '<input type="range" min="0" max="1" step="0.01" value="'+amp+'" data-design-id="'+designId+'" class="amp-slider">' +
    '<span class="v">'+(amp*20).toFixed(1)+'% cell</span>' +
    '<div class="disp-interp-toggle" style="'+toggleStyle+'; margin-left:10px;">' +
      ibtn('linear', 'lin') + ibtn('cubic', 'cub') +
    '</div>' +
    '</div>';
}

/* 4b — Stress mode saturation slider.  Per-design multiplier on the
   auto p95 cap.  Range 0..2 with default 1.0 (= no change).  Value
   reads as "× auto" so the user sees how far they're scaling from
   the auto-tuned baseline.  Reuses the .amp-slider visual but tags
   class .sat-slider for handler routing. */
function buildStressControl(designId, sat, interp){
  function ibtn(mode, label) {
    var active = (interp === mode);
    var base = 'background:transparent; border:1px solid rgba(255,255,255,0.18); ' +
               'color:rgba(255,255,255,0.55); font:11px JetBrains Mono,ui-monospace,monospace; ' +
               'padding:2px 7px; cursor:pointer; letter-spacing:0.05em; line-height:1;';
    var on   = 'background:#c8f542; border-color:#c8f542; color:#0a0a0a;';
    return '<button class="disp-interp-btn" data-design-id="'+designId+'" data-mode="'+mode+'" ' +
           'style="'+base + (active ? on : '') +'">'+label+'</button>';
  }
  var toggleStyle = 'display:inline-flex; gap:0; margin-left:10px;';
  return '<div class="vp-deform-control show">' +
    '<label>sat</label>' +
    '<input type="range" min="0" max="2" step="0.05" value="'+sat+'" data-design-id="'+designId+'" class="sat-slider">' +
    '<span class="v">×'+sat.toFixed(2)+' auto</span>' +
    '<div class="disp-interp-toggle" style="'+toggleStyle+'">' +
      ibtn('linear', 'lin') + ibtn('cubic', 'cub') +
    '</div>' +
    '</div>';
}

function readoutForDesign(d, mode){
  var r = d.results || {};
  var amp = getDeformAmp(d.id);
  if (mode === 'geom')   return d.title + ' · ρ=' + d.rho_rel.toFixed(2);
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
      var p95 = computeStressP95AcrossAxes(r._fieldsByAxis);
      var trueMax = computeStressMaxAcrossAxes(r._fieldsByAxis);
      var satMul = (typeof getStressSat === 'function') ? getStressSat(d.id) : 1.0;
      var effCap = p95 * satMul;
      if (p95 > 0 || trueMax > 0) {
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
  if (mode === 'thermal'&& LAB_STATE.runHasCompleted){
    return r.kappa_z === 0 ? 'κ_max = — (not computed)'
                            : 'κ_max = ' + (r.kappa_z*1.04).toFixed(2) + ' W/mK';
  }
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

  LAB_STATE.designs = LAB_STATE.designs.filter(function(d){ return d.id !== designId; });
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
  var axes = ['x', 'y', 'z'];
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
function computeStressStatsAcrossAxes(fieldsByAxis){
  var noData = { p95: 0, median: 0, max: 0, autoGamma: 1.0 };
  if (!fieldsByAxis) return noData;
  var axes = ['x', 'y', 'z'];

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
  var axes = ['x', 'y', 'z'];

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
function resolveStressDisplay(design, allDesigns){
  var mode = (typeof getStressNormMode === 'function') ? getStressNormMode() : 'per';
  var sat  = (typeof getStressSat === 'function') ? getStressSat(design.id) : 1.0;
  if (mode === 'shared') {
    var globalP95 = computeGlobalStressP95(allDesigns);
    return { cap: globalP95 * sat, gamma: 1.0, mode: 'shared' };
  }
  /* per-design */
  var stats = computeStressStatsAcrossAxes(design.results && design.results._fieldsByAxis);
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
  var grad = 'linear-gradient(to top, ' +
             'rgb(0,32,77) 0%, rgb(28,62,101) 14.3%, rgb(60,88,120) 28.6%, ' +
             'rgb(91,114,124) 42.9%, rgb(127,137,117) 57.1%, rgb(170,162,99) 71.4%, ' +
             'rgb(216,193,76) 85.7%, rgb(255,234,70) 100%)';
  var barStyle = 'position:absolute; right:14px; top:46px; bottom:68px; ' +
                 'width:8px; border-radius:1px; background:' + grad + '; ' +
                 'border:1px solid rgba(255,255,255,0.18);';
  var labelTopStyle = 'position:absolute; right:28px; top:42px; ' +
                      'font:9px JetBrains Mono,ui-monospace,monospace; ' +
                      'color:rgba(255,255,255,0.85); letter-spacing:0.05em; ' +
                      'white-space:nowrap; text-align:right;';
  var labelBotStyle = 'position:absolute; right:28px; bottom:64px; ' +
                      'font:9px JetBrains Mono,ui-monospace,monospace; ' +
                      'color:rgba(255,255,255,0.5); letter-spacing:0.05em;';
  var headerStyle  = 'position:absolute; right:14px; top:30px; ' +
                     'font:9px JetBrains Mono,ui-monospace,monospace; ' +
                     'color:rgba(255,255,255,0.55); letter-spacing:0.08em; ' +
                     'text-transform:uppercase;';
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
  var suffixStyle = 'display:block; font-size:8px; color:rgba(255,255,255,0.45); ' +
                    'letter-spacing:0.08em; margin-top:1px;';

  return '<div class="stress-colorbar-header" style="'+headerStyle+'">σ_VM</div>' +
         '<div class="stress-colorbar" style="'+barStyle+'"></div>' +
         '<div class="stress-colorbar-label-top" style="'+labelTopStyle+'">'+capStr +
           '<span style="'+suffixStyle+'">'+suffixText+'</span></div>' +
         '<div class="stress-colorbar-label-bot" style="'+labelBotStyle+'">0</div>';
}
