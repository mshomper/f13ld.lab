/* ============================================================
   F13LD.lab · 30-view-tabs.js
   Global view-mode state and tab switching.
   View mode applies to ALL designs synchronously — clicking
   "Stiffness" swaps every viewport at once for true comparison.
   ============================================================ */

var VIEW_STATE = {
  mode: 'geom',                            // current view mode
  deformAmps: { /* designId: 0..1 */ },    // per-design deformation amplitude
                                            //   4b — slider value 0..1 now maps to
                                            //   "δ_max as fraction of cell half-extent",
                                            //   capped at 0..20% (slider×0.20).
                                            //   Default 0.25 → 5% cell stretch.
  loadAxis:   { /* designId: 'x'|'y'|'z' */ },  // A.2.2 — per-design active load axis
  stressNormMode: 'per',                   // A.3.3 — 'per' (auto per-design) | 'shared' (global p95, linear)
  stressSat:  { /* designId: 0..2 */ }     // 4b — per-design saturation multiplier on auto p95 cap
};

/* ----------------------------------------------------------
   Click handler for view tabs. Updates global mode and
   triggers re-render of the comparison area.
   ---------------------------------------------------------- */
function onViewModeClick(mode){
  VIEW_STATE.mode = mode;

  // Update tab visual state
  var tabs = document.querySelectorAll('.view-tab');
  for (var i = 0; i < tabs.length; i++){
    if (tabs[i].dataset.mode === mode){
      tabs[i].classList.add('active');
    } else {
      tabs[i].classList.remove('active');
    }
  }

  /* A.3.3 — show/hide the per/shared normalization toggle based on view
     mode.  Push 5 — toggle is now dual-purpose: in stress mode it scales
     the σ_VM colormap cap; in stiff mode it scales the E(n̂) surface
     normalization (per-design vs shared E_max across designs).  Same
     state variable (stressNormMode) drives both. */
  var normGroup = document.getElementById('stressNormToggle');
  if (normGroup) {
    normGroup.style.display = (mode === 'stress' || mode === 'stiff') ? '' : 'none';
    updateStressNormToggleVisual();
    /* Push 5 — swap the label text so the user knows what the toggle
       affects in the current mode.  The visible label is the first
       <span> child of the toggle group. */
    var labelEl = normGroup.querySelector('span');
    if (labelEl) {
      if (mode === 'stiff')      labelEl.textContent = 'E surface scale';
      else if (mode === 'stress') labelEl.textContent = 'σ_VM scale';
    }
  }

  // Re-render
  if (typeof renderDesignGrid === 'function') renderDesignGrid();
}

/* ----------------------------------------------------------
   Slider handler for per-design deformation amplitude.
   Wired in 40-design-grid.js when sliders are rendered.

   A.2 — Pure state-update only.  The slider's input event in
   40-design-grid.js handles visual dispatch: direct uniform
   update for raymarcher-backed designs, full re-render for
   SVG-mock fallback designs.  Triggering renderDesignGrid here
   would rebuild the entire 3-design HTML on every slider tick.
   ---------------------------------------------------------- */
function onDeformAmpInput(designId, amp){
  VIEW_STATE.deformAmps[designId] = amp;
}

/* ----------------------------------------------------------
   Get the deformation amplitude for a given design,
   defaulting to 0.25 if never set.

   4b — slider value now maps to "δ_max as fraction of cell
   half-extent" via slider × 0.20.  Default 0.25 → 5% cell
   stretch (was 0.5 → 50× raw multiplier before reframe).
   The raymarcher uses _u'_maxNorm (computed at upload time)
   to convert the slider value to an effective shader multiplier
   that lands the largest displacement at exactly (slider×20)%
   of the cell half-extent.
   ---------------------------------------------------------- */
function getDeformAmp(designId){
  if (VIEW_STATE.deformAmps[designId] === undefined) return 0.25;
  return VIEW_STATE.deformAmps[designId];
}


/* ----------------------------------------------------------
   4b — Per-design stress colormap saturation multiplier.
   Slider value 0..2 with default 1.0:
     0.5 — cap = 0.5 × auto p95   (saturates earlier; high-stress
                                    regions blow out to yellow)
     1.0 — cap = 1.0 × auto p95   (current behavior)
     2.0 — cap = 2.0 × auto p95   (de-saturates; peak stress reads
                                    as mid-spectrum)
   ---------------------------------------------------------- */
function getStressSat(designId){
  if (VIEW_STATE.stressSat[designId] === undefined) return 1.0;
  return VIEW_STATE.stressSat[designId];
}

function onStressSatInput(designId, sat){
  VIEW_STATE.stressSat[designId] = sat;
}

/* ----------------------------------------------------------
   A.2.2 — Per-design active load axis.  The elastic solver
   captures fields for all three physical axes; this state
   tracks which one each design tile is currently visualizing.
   Default is Z (vertical compression — physiological loading
   on orthopedic implants).
   ---------------------------------------------------------- */
function getLoadAxis(designId){
  return VIEW_STATE.loadAxis[designId] || 'z';
}

/* Pure state mutation — dispatch (re-upload fields to raymarcher,
   update toggle button visual state) lives in 40-design-grid.js's
   load-axis click handler.  Same pattern as onDeformAmpInput. */
function onLoadAxisClick(designId, axis){
  VIEW_STATE.loadAxis[designId] = axis;
}


/* ----------------------------------------------------------
   A.3.3 — Stress-normalization mode (per-design vs shared).

   'per'    — each design auto-calibrates: p95 cap per-design,
              auto-gamma maps median to colormap midpoint.  Best
              for spatial pattern discovery within one structure.
              Color meaning differs across tiles.
   'shared' — global p95 cap across all designs, gamma=1.0
              (linear viridis).  "Yellow" anywhere maps to the
              same σ_VM.  Best for cross-design comparison; low-
              stress designs look proportionally dim.

   Toggle UI lives in the view-strip and is only visible while
   the stress tab is active.  Default 'per' (per-design auto).
   ---------------------------------------------------------- */
function getStressNormMode(){
  return VIEW_STATE.stressNormMode || 'per';
}

function onStressNormToggleClick(mode){
  if (mode !== 'per' && mode !== 'shared') return;
  VIEW_STATE.stressNormMode = mode;
  updateStressNormToggleVisual();
  /* Trigger re-render to apply the new normalization across all tiles. */
  if (typeof renderDesignGrid === 'function') renderDesignGrid();
}

function updateStressNormToggleVisual(){
  var btns = document.querySelectorAll('.stress-norm-btn');
  var active = getStressNormMode();
  for (var i = 0; i < btns.length; i++){
    var isActive = (btns[i].dataset.norm === active);
    if (isActive) btns[i].classList.add('active');
    else          btns[i].classList.remove('active');
    /* Inline style swap — matches the X/Y/Z toggle and stress-tile patterns
       that opted to keep A.2.2/A.3 changes out of lab.css.  Can be promoted
       to .stress-norm-btn / .stress-norm-btn.active selectors in a later
       polish pass alongside the other inline-styled toggle UIs. */
    btns[i].style.background  = isActive ? '#c8f542' : 'transparent';
    btns[i].style.borderColor = isActive ? '#c8f542' : 'rgba(255,255,255,0.18)';
    btns[i].style.color       = isActive ? '#0a0a0a' : 'rgba(255,255,255,0.55)';
  }
}
