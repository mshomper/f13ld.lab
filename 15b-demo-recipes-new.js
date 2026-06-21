/* ============================================================
   F13LD.lab · 15b-demo-recipes-new.js
   One ready-to-solve demo per new SDF family (Beam · Bundle ·
   Wave).  These are native lab recipes — consumed directly by
   KERNELS[family].parseRecipe → resolveBuildArgs → buildVoxels.
   All three carry geometry.mode = 'solid' so the rasterizer's
   default branch thresholds the negative-inside SDF at < 0.

   Loaded after 15-demo-recipes.js, so DEMO_RECIPES and
   DEMO_RECIPE_LIST already exist and are extended in place.
   ============================================================ */

var _DEMO_MAT = (typeof MATERIAL_TI64_BONE !== 'undefined') ? MATERIAL_TI64_BONE
  : { Es_MPa: 110000, nu: 0.34, ks_WmK: 6.7, muFluid_PaS: 0.001 };

/* ------------------------------------------------------------
   Demo — BCC beam lattice
   Four body-diagonal struts of the [-1,1]³ cell meeting at the
   centre, plus three axis struts, with smoothed nodes.  A fully
   periodic, fully connected strut network — no pruning needed.
   ------------------------------------------------------------ */
var DEMO_BEAM_BCC = {
  family: 'beam',
  name:   'BCC lattice',
  beams: [
    [-1,-1,-1,  1, 1, 1, 1],
    [-1,-1, 1,  1, 1,-1, 1],
    [-1, 1,-1,  1,-1, 1, 1],
    [ 1,-1,-1, -1, 1, 1, 1],
    [-1, 0, 0,  1, 0, 0, 1],
    [ 0,-1, 0,  0, 1, 0, 1],
    [ 0, 0,-1,  0, 0, 1, 1]
  ],
  geometry: {
    mode:       'solid',
    cell_scale: 1,
    radius:     0.10,
    node_ball_radius:  0.0,
    node_smoothing_k:  0.0,
    cellSizeMm: 5.0,
    cellMult:   1.0
  },
  material: _DEMO_MAT
};

/* ------------------------------------------------------------
   Demo — Twisted fiber bundle
   3×3 array of circular fibers with a gentle 1.2 rad/cell twist.
   Interwoven, mostly-disconnected fibers → island-prune policy.
   ------------------------------------------------------------ */
var DEMO_BUNDLE_TWIST = {
  family: 'bundle',
  name:   'Twisted bundle',
  surface: { structure: 'bundle', topology: 'solid', iso_offset: 0.0 },
  geometry: {
    mode:          'solid',
    beam_radius:   0.10,
    beam_shape:    'circle',
    beams_per_side: 3,
    beam_spacing:  0.30,
    column_gap:    0.20,
    twist_rate:    1.20,
    twist_mode:    0,
    blend_k:       0.01,
    cellSizeMm:    5.0,
    cellMult:      1.0
  },
  material: _DEMO_MAT
};

/* ------------------------------------------------------------
   Demo — Cymatic standing wave (cubic symmetry)
   Two cosine modes under the cubic operator, solid topology at
   iso = 0.  Resolves into interwoven networks → island-prune.
   ------------------------------------------------------------ */
var DEMO_WAVE_CUBIC = {
  family: 'wave',
  name:   'Cymatic · cubic',
  field: {
    symmetry: 'cubic',
    mode:     'solid',
    iso:      0.0,
    modes: [
      { n: 1, m: 1, p: 1, A: 1.0, phi: 0.0 },
      { n: 2, m: 1, p: 1, A: 0.4, phi: 0.3 }
    ]
  },
  geometry: { mode: 'solid', cellSizeMm: 5.0, cellMult: 1.0 },
  material: _DEMO_MAT
};

/* ── Extend the demo registry built in 15-demo-recipes.js ──── */
if (typeof DEMO_RECIPES !== 'undefined') {
  DEMO_RECIPES.beamBCC      = DEMO_BEAM_BCC;
  DEMO_RECIPES.bundleTwist  = DEMO_BUNDLE_TWIST;
  DEMO_RECIPES.waveCubic    = DEMO_WAVE_CUBIC;
}
if (typeof DEMO_RECIPE_LIST !== 'undefined') {
  DEMO_RECIPE_LIST.push({ id: 'beamBCC',     recipe: DEMO_BEAM_BCC });
  DEMO_RECIPE_LIST.push({ id: 'bundleTwist', recipe: DEMO_BUNDLE_TWIST });
  DEMO_RECIPE_LIST.push({ id: 'waveCubic',   recipe: DEMO_WAVE_CUBIC });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEMO_BEAM_BCC, DEMO_BUNDLE_TWIST, DEMO_WAVE_CUBIC };
}
