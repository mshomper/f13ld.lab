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
    rho_rel:0.42,
    cell_mm:4.0,
    mat_es_gpa:110, mat_nu:0.30,
    color:'#22d3ee',
    /* mock results (populated by mock run, in real Phase 3+ these
       come from solver output) */
    results:{
      E11:1.24, E22:1.24, E33:1.24,
      G12:0.50, G13:0.50, G23:0.50,
      nu12:0.23, nu13:0.23, nu23:0.23,
      zener:0.91,
      sigma_y_z:28.3, sigma_peak:42.1, hardening:0.064,
      lambda_cr:1.84,
      pcr_py:1.84,
      kappa_z:0.84,
      failure_mode:'Yield-limited'
    }
  },
  {
    id:'demo-g3f1',
    label:'DESIGN · B',
    title:'Spinodoid · VMF',
    source:'demo · F13LD.Grain JSON · κ=6',
    family:'grain',
    variant:'spinodoid',
    topology:'sheet',
    rho_rel:0.38,
    cell_mm:4.0,
    mat_es_gpa:110, mat_nu:0.30,
    color:'#fbbf24',
    results:{
      E11:0.89, E22:0.89, E33:0.89,
      G12:0.38, G13:0.38, G23:0.38,
      nu12:0.31, nu13:0.31, nu23:0.31,
      zener:1.34,
      sigma_y_z:18.6, sigma_peak:26.2, hardening:0.041,
      lambda_cr:0.71,
      pcr_py:0.71,
      kappa_z:0.91,
      failure_mode:'Buckling-limited'
    }
  },
  {
    id:'demo-rda9',
    label:'DESIGN · C',
    title:'Trabecular · GS',
    source:'demo · F13LD.Grain JSON · RD',
    family:'grain',
    variant:'reaction_diffusion',
    topology:'sheet',
    rho_rel:0.40,
    cell_mm:4.0,
    mat_es_gpa:110, mat_nu:0.30,
    color:'#fb7185',
    results:{
      E11:1.05, E22:1.05, E33:1.05,
      G12:0.42, G13:0.42, G23:0.42,
      nu12:0.27, nu13:0.27, nu23:0.27,
      zener:1.12,
      sigma_y_z:22.0, sigma_peak:32.4, hardening:0.052,
      lambda_cr:1.41,
      pcr_py:1.41,
      kappa_z:0.86,
      failure_mode:'Mixed mode'
    }
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
