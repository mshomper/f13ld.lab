/* ============================================================
   F13LD.lab · 30-view-tabs.js
   Global view-mode state and tab switching.
   View mode applies to ALL designs synchronously — clicking
   "Stiffness" swaps every viewport at once for true comparison.
   ============================================================ */

var VIEW_STATE = {
  mode: 'geom',                            // current view mode
  deformAmps: { /* designId: 0..1 */ }     // per-design deformation amplitude
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

  // Re-render
  if (typeof renderDesignGrid === 'function') renderDesignGrid();
}

/* ----------------------------------------------------------
   Slider handler for per-design deformation amplitude.
   Wired in 40-design-grid.js when sliders are rendered.
   ---------------------------------------------------------- */
function onDeformAmpInput(designId, amp){
  VIEW_STATE.deformAmps[designId] = amp;
  if (typeof renderDesignGrid === 'function') renderDesignGrid();
}

/* ----------------------------------------------------------
   Get the deformation amplitude for a given design,
   defaulting to 0.5 if never set.
   ---------------------------------------------------------- */
function getDeformAmp(designId){
  if (VIEW_STATE.deformAmps[designId] === undefined) return 0.5;
  return VIEW_STATE.deformAmps[designId];
}
