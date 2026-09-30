/* ============================================================
   F13LD.lab · 00-mock-data.js
   Placeholder design data — preloaded demos so the comparison
   layout renders on first visit. Replaced by real F13LD.vault
   entries in Phase 10.
   ============================================================ */

var MOCK_DESIGNS = [
  {
    id:'demo-047a',
    label:'DESIGN · A',
    title:'Schwarz P TPMS',
    source:'demo · F13LD.vault stub #047a',
    family:'tpms',
    variant:'schwarz_p',
    topology:'sheet',
    rho_rel:null,   /* Sprint A — shown from the solver's voxel density after a run */
    cell_mm:4.0,
    mat_es_gpa:110, mat_nu:0.30,
    color:'#4f86f7',
    slot:0,
    /* Sprint A — no pre-baked results: every number on a card comes from a
       solve (the old invented E/σy/κ/λ values rendered before any run). */
    results:null
  },
  {
    id:'demo-g3f1',
    label:'DESIGN · B',
    title:'Spinodoid · VMF',
    source:'demo · F13LD.Grain JSON · κ=6',
    family:'grain',
    variant:'spinodoid',
    topology:'sheet',
    rho_rel:null,
    cell_mm:4.0,
    mat_es_gpa:110, mat_nu:0.30,
    color:'#a78bfa',
    slot:1,
    results:null
  },
  {
    id:'demo-rda9',
    label:'DESIGN · C',
    title:'Trabecular · GS',
    source:'demo · F13LD.Grain JSON · RD',
    family:'grain',
    variant:'reaction_diffusion',
    topology:'sheet',
    rho_rel:null,
    cell_mm:4.0,
    mat_es_gpa:110, mat_nu:0.30,
    color:'#e879c9',
    slot:2,
    results:null
  }
];

/* ----------------------------------------------------------
   Live state of designs currently loaded into the comparison.
   Up to 3 entries. Phase 1 starts populated with all 3 demos;
   user can clear and reload from vault (Phase 10) or JSON file.
   ---------------------------------------------------------- */
var LAB_STATE = {
  designs: MOCK_DESIGNS.slice(),  // shallow copy
  baselineId: 'demo-g3f1',         // which design is the comparison baseline
  runHasCompleted: false,          // gates Export PDF, mesh handoff
  winningId: null                  // set by mock run, drives mesh handoff
};

/* ----------------------------------------------------------
   Design persistence (scheme f13ld.lab.designs.v1).

   Persists the loaded design DEFINITIONS (including each design's
   recipe) so an imported comparison survives a page reload.  Solver
   RESULTS are intentionally dropped on save — including the large
   per-voxel field arrays from a run — and are recomputed by re-running.
   All access is wrapped because localStorage can throw (quota, privacy
   mode, storage disabled); persistence is strictly best-effort.
   ---------------------------------------------------------- */
var LAB_DESIGNS_KEY = 'f13ld.lab.designs.v1';

function saveDesigns(){
  try {
    var slim = LAB_STATE.designs.map(function(d){
      var c = {};
      for (var k in d){ if (d.hasOwnProperty(k) && k !== 'results') c[k] = d[k]; }
      return c;
    });
    localStorage.setItem(LAB_DESIGNS_KEY, JSON.stringify({
      v: 1, baselineId: LAB_STATE.baselineId, designs: slim
    }));
  } catch (e){ /* storage unavailable — silent, best-effort */ }
}

function loadDesigns(){
  try {
    var raw = localStorage.getItem(LAB_DESIGNS_KEY);
    if (!raw) return null;
    var p = JSON.parse(raw);
    if (!p || p.v !== 1 || !Array.isArray(p.designs)) return null;
    for (var i = 0; i < p.designs.length; i++){
      if (!p.designs[i] || !p.designs[i].id) return null;   // shape guard
    }
    return p;
  } catch (e){ return null; }
}

/* ----------------------------------------------------------
   Slot-stable design identity.  Each design owns a slot 0/1/2 -> letter
   A/B/C and a fixed color, kept for the design's whole life: removing a
   different design never reshuffles it, and the lowest free slot is handed
   to the next add, so duplicate letters/colors are impossible.  Honors
   existing valid, unique slot claims; (re)assigns only the rest.
   ---------------------------------------------------------- */
/* ----------------------------------------------------------
   Adaptive engineering-unit formatters (shared across tabs).
   Pressure-like quantities (modulus, strength) carry an MPa base:
   show GPa at/above 1 GPa, MPa below — so 0.05 GPa reads as 50 MPa
   and 2.5 GPa stays GPa.  Force shows N below 1 kN, kN above.
   ---------------------------------------------------------- */
function fmtEngMPa(mpa){
  if (mpa == null || !isFinite(mpa) || mpa === 0) return '\u2014';   /* 0 = sentinel/no-data */
  if (mpa >= 1000) return (mpa / 1000).toFixed(2) + ' GPa';
  if (mpa >= 100)  return mpa.toFixed(0) + ' MPa';
  return mpa.toFixed(1) + ' MPa';
}
function fmtForceN(n){
  if (n == null || !isFinite(n) || n === 0) return '\u2014';
  if (n >= 1000) return (n / 1000).toFixed(2) + ' kN';
  if (n >= 100)  return n.toFixed(0) + ' N';
  return n.toFixed(1) + ' N';
}

var DESIGN_PALETTE = ['#4f86f7', '#a78bfa', '#e879c9'];   /* A=azure blue, B=violet, C=magenta — chosen clear of metric green/amber/red, lab accent (#fbbf24), neon, and section-label cyan (#22d3ee) */
function reconcileDesignSlots(){
  var ds = LAB_STATE.designs, used = [false, false, false], i;
  for (i = 0; i < ds.length; i++){
    var s = ds[i].slot;
    if (s === 0 || s === 1 || s === 2){
      if (!used[s]) used[s] = true; else ds[i].slot = -1;   /* duplicate claim → reassign */
    } else ds[i].slot = -1;
  }
  for (i = 0; i < ds.length; i++){
    if (ds[i].slot === -1){
      for (var f = 0; f < 3; f++){ if (!used[f]){ ds[i].slot = f; used[f] = true; break; } }
    }
  }
  for (i = 0; i < ds.length; i++){
    var sl = ds[i].slot;
    ds[i].label = 'DESIGN \u00b7 ' + String.fromCharCode(65 + sl);
    ds[i].color = DESIGN_PALETTE[sl] || '#aaa';
  }
}

/* Restore on load.  Empty or invalid saved state falls back to the demo
   seed, so a first visit (or a cleared+reloaded session) still shows the
   built-in comparison rather than an empty grid. */
(function restoreSavedDesigns(){
  var saved = loadDesigns();
  if (saved && saved.designs.length){
    LAB_STATE.designs = saved.designs;
    if (saved.baselineId) LAB_STATE.baselineId = saved.baselineId;
  }
  reconcileDesignSlots();   /* normalize slots/letters/colors for saved + seed alike */
})();

/* ----------------------------------------------------------
   Compute deltas vs the baseline design for the property card.
   Returns a string like "+18% vs B" or "baseline".
   ---------------------------------------------------------- */
function deltaVsBaseline(value, key, designId){
  if (designId === LAB_STATE.baselineId) return ['baseline','neut'];
  var baseline = LAB_STATE.designs.find(function(d){ return d.id === LAB_STATE.baselineId; });
  if (!baseline || !baseline.results || baseline.results[key] === undefined) return ['—','neut'];
  var b = baseline.results[key];
  if (b === 0) return ['—','neut'];
  var pct = (value - b) / Math.abs(b) * 100;
  var letter = LAB_STATE.designs.find(function(d){ return d.id === LAB_STATE.baselineId; }).label.split('·').pop().trim();
  if (Math.abs(pct) < 2) return ['~ baseline','neut'];
  var sign = pct > 0 ? '+' : '';
  var dir = pct > 0 ? 'up' : 'down';
  return [sign + pct.toFixed(0) + '% vs ' + letter, dir];
}
