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
  loadAxis:   { /* designId: 'xx'|'yy'|'zz'|'yz'|'xz'|'xy' */ },  // A.2.2 / Piece B — per-design active load axis (Voigt)
  stressNormMode: 'per',                   // A.3.3 — 'per' (auto per-design) | 'shared' (global p95, linear)
  stressSat:  { /* designId: 0..2 */ },    // 4b — per-design saturation multiplier on auto p95 cap
  buckleExag: { /* designId: 0..30 */ }    // buckling tab mode-shape exaggeration (% of cell), default 10
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
    normGroup.classList.toggle('show', (mode === 'stress' || mode === 'stiff'));
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

function getBuckleExag(designId){
  if (VIEW_STATE.buckleExag[designId] === undefined) return 10;
  return VIEW_STATE.buckleExag[designId];
}
function setBuckleExag(designId, pct){
  VIEW_STATE.buckleExag[designId] = pct;
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
   A.2.2 / Piece B — Per-design active load axis.  The elastic
   solver captures fields for all SIX Voigt axes (xx/yy/zz/yz/xz/xy):
     · normal axes (xx/yy/zz) carry both u'(x) and σ_VM
     · shear  axes (yz/xz/xy) carry σ_VM only — u'(x) reconstruction
       requires the diagonal spectral inversion which is undefined
       off-diagonal.

   Default 'zz' (vertical compression — physiological loading on
   orthopedic implants).

   One-slot state: loadAxis[id] holds the user's most recent pick
   across either tab.  getDeformAxis() coerces shear → 'zz' on read
   without mutating state, so switching stress→deform→stress will
   preserve the shear pick UNLESS the user actively clicks a deform
   button in between.

   Backward-compat: state values 'x'/'y'/'z' (from before Piece B)
   are promoted to 'xx'/'yy'/'zz' on read.  Relevant for the
   upcoming localStorage persistence.
   ---------------------------------------------------------- */
function getLoadAxis(designId){
  var v = VIEW_STATE.loadAxis[designId];
  if (!v) return 'zz';
  /* Promote pre-Piece-B single-letter values. */
  if (v === 'x') return 'xx';
  if (v === 'y') return 'yy';
  if (v === 'z') return 'zz';
  return v;
}

/* getDeformAxis — for the Deform tab, which can only render u'(x)
   for normal axes.  If state holds a shear axis, return 'zz' (read-
   only coercion; does not mutate state). */
function getDeformAxis(designId){
  var v = getLoadAxis(designId);
  if (v === 'xx' || v === 'yy' || v === 'zz') return v;
  return 'zz';
}

/* getStressAxis — for the Stress tab, which can render all six. */
function getStressAxis(designId){
  return getLoadAxis(designId);
}

/* Pure state mutation — dispatch (re-upload fields to raymarcher,
   update toggle button visual state) lives in 40-design-grid.js's
   load-axis click handler.  Same pattern as onDeformAmpInput.
   Silently rejects unknown axis strings. */
function onLoadAxisClick(designId, axis){
  if (axis !== 'xx' && axis !== 'yy' && axis !== 'zz' &&
      axis !== 'yz' && axis !== 'xz' && axis !== 'xy') return;
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
    /* Active state is driven by the .stress-norm-btn.active selector in
       lab.css (promoted from inline styles in the Phase 5 polish pass). */
  }
}
