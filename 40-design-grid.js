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
function statsForDesign(d, mode){
  var r = d.results;
  if (!r) return [];

  // Default: stiffness-flavored summary
  if (mode === 'geom' || mode === 'deform' || mode === 'stress' || mode === 'stiff'){
    return [
      { lbl:'E11',       val:r.E11.toFixed(2)+' GPa',  delta:deltaVsBaseline(r.E11, 'E11', d.id) },
      { lbl:'Zener A',   val:r.zener.toFixed(2),       delta:[zenerDescriptor(r.zener), 'neut'] },
      { lbl:'σ_y (z)',   val:r.sigma_y_z.toFixed(1)+' MPa', delta:deltaVsBaseline(r.sigma_y_z, 'sigma_y_z', d.id) },
      { lbl:'P_cr / P_y',val:r.pcr_py.toFixed(2),      delta:[r.failure_mode, r.pcr_py < 1 ? 'down' : 'neut'] }
    ];
  }
  // Thermal mode prioritizes κ
  if (mode === 'thermal'){
    return [
      { lbl:'κ_z',    val:r.kappa_z.toFixed(2)+' W/mK', delta:deltaVsBaseline(r.kappa_z, 'kappa_z', d.id) },
      { lbl:'ρ_rel',  val:d.rho_rel.toFixed(2),         delta:['baseline','neut'] },
      { lbl:'E11',    val:r.E11.toFixed(2)+' GPa',      delta:deltaVsBaseline(r.E11, 'E11', d.id) },
      { lbl:'Zener',  val:r.zener.toFixed(2),           delta:[zenerDescriptor(r.zener), 'neut'] }
    ];
  }
  // Buckling mode prioritizes λ_cr
  if (mode === 'buckle'){
    return [
      { lbl:'λ_cr (mode 1)', val:r.lambda_cr.toFixed(2),   delta:[r.failure_mode, r.pcr_py < 1 ? 'down' : 'neut'] },
      { lbl:'σ_y (z)',       val:r.sigma_y_z.toFixed(1)+' MPa', delta:deltaVsBaseline(r.sigma_y_z, 'sigma_y_z', d.id) },
      { lbl:'P_cr / P_y',    val:r.pcr_py.toFixed(2),      delta:[r.pcr_py < 1 ? 'BUCKLING-LIMITED' : 'safe', r.pcr_py < 1 ? 'down' : 'up'] },
      { lbl:'E11',           val:r.E11.toFixed(2)+' GPa',  delta:deltaVsBaseline(r.E11, 'E11', d.id) }
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
  for (var i = 0; i < LAB_STATE.designs.length && i < 3; i++){
    var d = LAB_STATE.designs[i];
    var fam = familyKey(d);
    var amp = getDeformAmp(d.id);
    var svgInner = '';

    if (VIEW_STATE.mode === 'geom')        svgInner = svgGeom(fam, false, 0);
    else if (VIEW_STATE.mode === 'deform') svgInner = svgGeom(fam, true, amp);
    else if (VIEW_STATE.mode === 'stress'){
      if (!LAB_STATE.runHasCompleted) svgInner = svgEmptyViewport('Run to see stress field');
      else svgInner = svgStress(fam, i);
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
    var showDeform = (VIEW_STATE.mode === 'deform');
    var statusClass = '';
    if (LAB_STATE.runHasCompleted) statusClass = 'done';
    else if (RUN_STATE && RUN_STATE.running && i === RUN_STATE.currentIndex) statusClass = 'running';
    else statusClass = 'idle';

    html += '<div class="design-col">' +
      '<div class="dc-head">' +
        '<div class="dc-name">' +
          '<span class="label">'+d.label+'</span>' +
          '<span class="title">'+d.title+'</span>' +
          '<span class="source">'+d.source+'</span>' +
        '</div>' +
        '<div class="dc-controls">' +
          '<span class="dc-status-dot '+statusClass+'" title="'+statusClass+'"></span>' +
          '<button class="dc-icon-btn" title="Set as baseline" onclick="setBaseline(\''+d.id+'\')">★</button>' +
          '<button class="dc-icon-btn" title="Remove" onclick="removeDesign(\''+d.id+'\')">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="dc-viewport">' +
        '<svg viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet">'+svgInner+'</svg>' +
        '<div class="vp-axis">+Z<br>↑ +Y<br>→ +X</div>' +
        (readout ? '<div class="vp-readout"><span class="v">'+readout+'</span></div>' : '') +
        (showDeform ? buildDeformControl(d.id, amp) : '') +
      '</div>' +
      buildSummary(stats) +
      '</div>';
  }
  grid.innerHTML = html;

  // Wire up amp sliders after DOM injection
  var sliders = document.querySelectorAll('.amp-slider');
  for (var s = 0; s < sliders.length; s++){
    sliders[s].addEventListener('input', function(e){
      var id = e.target.dataset.designId;
      var v = parseFloat(e.target.value);
      onDeformAmpInput(id, v);
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

function buildDeformControl(designId, amp){
  return '<div class="vp-deform-control show">' +
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
  if (mode === 'stress' && LAB_STATE.runHasCompleted) return 'σ_VM,max = ' + r.sigma_y_z.toFixed(1) + ' MPa';
  if (mode === 'stiff'  && LAB_STATE.runHasCompleted) return 'E_max = ' + (r.E11*1.05).toFixed(2) + ' GPa';
  if (mode === 'thermal'&& LAB_STATE.runHasCompleted) return 'κ_max = ' + (r.kappa_z*1.04).toFixed(2) + ' W/mK';
  if (mode === 'buckle' && LAB_STATE.runHasCompleted) return 'λ_cr = ' + r.lambda_cr.toFixed(2);
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
