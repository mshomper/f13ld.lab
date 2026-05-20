/* ============================================================
   F13LD.lab · 30-view-tabs.js
   Global view-mode state and tab switching.
   View mode applies to ALL designs synchronously — clicking
   "Stiffness" swaps every viewport at once for true comparison.
   ============================================================ */

var VIEW_STATE = {
  mode: 'geom',                            // current view mode
  deformAmps: { /* designId: 0..1 */ },    // per-design deformation amplitude
  loadAxis:   { /* designId: 'x'|'y'|'z' */ },  // A.2.2 — per-design active load axis
  stressNormMode: 'per'                    // A.3.3 — 'per' (auto per-design) | 'shared' (global p95, linear)
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

  /* A.3.3 — show/hide the stress-normalization toggle based on view mode.
     Only appears when stress tab is active.  The toggle's hidden state
     is set by display style; visual highlight of the active button is
     handled in updateStressNormToggleVisual. */
  var normGroup = document.getElementById('stressNormToggle');
  if (normGroup) {
    normGroup.style.display = (mode === 'stress') ? '' : 'none';
    updateStressNormToggleVisual();
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
   defaulting to 0.5 if never set.
   ---------------------------------------------------------- */
function getDeformAmp(designId){
  if (VIEW_STATE.deformAmps[designId] === undefined) return 0.5;
  return VIEW_STATE.deformAmps[designId];
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
