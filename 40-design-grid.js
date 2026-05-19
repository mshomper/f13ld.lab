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

  for (var i = 0; i < LAB_STATE.designs.length && i < 3; i++){
    var d = LAB_STATE.designs[i];
    var fam = familyKey(d);
    var amp = getDeformAmp(d.id);
    var svgInner = '';
    var useRM = rmModes && isRMDesign(i);

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
      if (!LAB_STATE.runHasCompleted) svgInner = svgEmptyViewport('Run to see stiffness surface');
      else svgInner = svgStiffness(d.results.zener, d.color, i);
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
    /* A.3 — colorbar overlay only when stress raymarcher is mounted and
       fields are available.  Shared σ_VM max across all three axes so
       toggling X/Y/Z preserves the colormap scale. */
    var showColorbar = (VIEW_STATE.mode === 'stress' && useRM &&
                        d.results && d.results._fieldsByAxis);
    var stressMaxMPa = showColorbar
                       ? computeStressMaxAcrossAxes(d.results._fieldsByAxis)
                       : 0;
    var statusClass = '';
    if (LAB_STATE.runHasCompleted) statusClass = 'done';
    else if (RUN_STATE && RUN_STATE.running && i === RUN_STATE.currentIndex) statusClass = 'running';
    else statusClass = 'idle';

    var viewportInner = useRM
      ? '<div class="rm-mount" data-design-id="'+d.id+'" style="width:100%;height:100%;"></div>'
      : '<svg viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet">'+svgInner+'</svg>';

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
        (showColorbar ? buildStressColorbar(stressMaxMPa) : '') +
        (showControls ? buildDeformControl(d.id, amp, (typeof getLoadAxis === 'function') ? getLoadAxis(d.id) : 'z') : '') +
      '</div>' +
      buildSummary(stats) +
      '</div>';
  }
  grid.innerHTML = html;

  /* Mount any raymarcher canvases into their .rm-mount placeholders */
  if (typeof mountRaymarcherTiles === 'function') mountRaymarcherTiles();

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
        var sharedMax = computeStressMaxAcrossAxes(rdesign.results._fieldsByAxis);
        rkrm.uploadFields(fs, sharedMax);
      }
    }
    if (rkrm.setViewMode) rkrm.setViewMode(VIEW_STATE.mode);
    if (rkrm.setDeformAmp) rkrm.setDeformAmp(getDeformAmp(rkid));
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
      /* Update the displayed ×N label inline (no DOM rebuild). */
      var labelEl = e.target.parentNode.querySelector('.v');
      if (labelEl) labelEl.textContent = '×' + (v*200).toFixed(0);
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
        /* A.3 — use shared σ_VM max across all three axes so the colormap
           range stays constant when toggling.  Axis-with-highest-stress
           reads as yellow; axes-with-lower-stress show as closer to blue. */
        var sharedMax = computeStressMaxAcrossAxes(design.results._fieldsByAxis);
        rm.uploadFields(design.results._fieldsByAxis[axis], sharedMax);
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

function buildDeformControl(designId, amp, axis){
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
  var toggleStyle = 'display:inline-flex; gap:0; margin-right:8px;';
  /* Make sibling buttons share borders — collapse the middle button's
     side borders so the trio reads as a segmented control. */
  return '<div class="vp-deform-control show">' +
    '<div class="load-axis-toggle" style="'+toggleStyle+'">' +
      btn('x') + btn('y') + btn('z') +
    '</div>' +
    '<label>amp</label>' +
    '<input type="range" min="0" max="1" step="0.01" value="'+amp+'" data-design-id="'+designId+'" class="amp-slider">' +
    '<span class="v">×'+(amp*200).toFixed(0)+'</span>' +
    '</div>';
}

function readoutForDesign(d, mode){
  var r = d.results || {};
  var amp = getDeformAmp(d.id);
  if (mode === 'geom')   return d.title + ' · ρ=' + d.rho_rel.toFixed(2);
  if (mode === 'deform') return 'δ_max scaled · amp ×' + (amp*200).toFixed(0);
  if (mode === 'stress' && LAB_STATE.runHasCompleted){
    /* A.3 — σ_VM,max from captured fields across all three axes
       (shared per-design max — matches the colorbar legend). */
    if (r._fieldsByAxis) {
      var svMax = computeStressMaxAcrossAxes(r._fieldsByAxis);
      if (svMax > 0) {
        var unit = svMax >= 1000 ? ' GPa' : ' MPa';
        var val  = svMax >= 1000 ? (svMax/1000).toFixed(2) : svMax.toFixed(1);
        return 'σ_VM,max = ' + val + unit + ' · amp ×' + (amp*200).toFixed(0);
      }
    }
    return 'σ_VM,max = — (not computed)';
  }
  if (mode === 'stiff'  && LAB_STATE.runHasCompleted) return 'E_max = ' + (r.E11*1.05).toFixed(2) + ' GPa';
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
   A.3 — Build the stress-mode colorbar overlay HTML.

   Renders a small vertical bar on the right side of the
   viewport with a CSS-gradient approximation of viridis.
   The numeric label is the shared σ_VM_max across all three
   load axes (MPa).  Bottom of bar = 0, top = σ_VM_max.

   Inline-styled to keep the A.3 push out of lab.css; can be
   promoted to .stress-colorbar selectors in a later polish
   pass alongside the deform-control axis toggle.
   ---------------------------------------------------------- */
function buildStressColorbar(stressMaxMPa){
  /* Viridis stops sampled at 8 anchor points for the CSS gradient. */
  var grad = 'linear-gradient(to top, ' +
             'rgb(68,1,84) 0%, rgb(72,40,120) 15%, rgb(62,73,137) 30%, ' +
             'rgb(49,104,142) 45%, rgb(38,130,142) 60%, rgb(53,183,121) 75%, ' +
             'rgb(110,206,88) 88%, rgb(253,231,37) 100%)';
  var barStyle = 'position:absolute; right:14px; top:46px; bottom:68px; ' +
                 'width:8px; border-radius:1px; background:' + grad + '; ' +
                 'border:1px solid rgba(255,255,255,0.18);';
  var labelTopStyle = 'position:absolute; right:28px; top:42px; ' +
                      'font:9px JetBrains Mono,ui-monospace,monospace; ' +
                      'color:rgba(255,255,255,0.85); letter-spacing:0.05em; ' +
                      'white-space:nowrap;';
  var labelBotStyle = 'position:absolute; right:28px; bottom:64px; ' +
                      'font:9px JetBrains Mono,ui-monospace,monospace; ' +
                      'color:rgba(255,255,255,0.5); letter-spacing:0.05em;';
  var headerStyle  = 'position:absolute; right:14px; top:30px; ' +
                     'font:9px JetBrains Mono,ui-monospace,monospace; ' +
                     'color:rgba(255,255,255,0.55); letter-spacing:0.08em; ' +
                     'text-transform:uppercase;';
  /* Format the max in sensible units */
  var maxStr;
  if (stressMaxMPa >= 1000) maxStr = (stressMaxMPa/1000).toFixed(2) + ' GPa';
  else if (stressMaxMPa >= 1) maxStr = stressMaxMPa.toFixed(1) + ' MPa';
  else if (stressMaxMPa > 0) maxStr = stressMaxMPa.toExponential(1) + ' MPa';
  else maxStr = '—';
  return '<div class="stress-colorbar-header" style="'+headerStyle+'">σ_VM</div>' +
         '<div class="stress-colorbar" style="'+barStyle+'"></div>' +
         '<div class="stress-colorbar-label-top" style="'+labelTopStyle+'">'+maxStr+'</div>' +
         '<div class="stress-colorbar-label-bot" style="'+labelBotStyle+'">0</div>';
}
