/* ============================================================
   F13LD.lab · 15-demo-recipes.js
   Three real recipes that replace the mocked demo designs once
   the solver lights up. Geometry is parsed and rasterized through
   the same KERNELS pipeline a vault-loaded recipe would use.

   Lab recipe schema (top-level):
     family    : 'tpms' | 'noise' | 'grain'
     name      : display string
     surface   : kernel-specific surface block (TPMS, Noise)
     field     : kernel-specific field block   (Grain)
     geometry  : { mode, offset, wallThickness, pipeR, phaseShift,
                   center, half_width, half_invert,
                   cellSizeMm, cellMult }
     material  : { Es_MPa, nu, ks_WmK, muFluid_PaS }

   The three demos are calibrated to land in the orthopedic
   working range (Ti-6Al-4V scaffold, ~5 mm cell, ~30-50% solid).
   ============================================================ */


/* ── Material defaults — Ti-6Al-4V scaffold in body fluid ─────────── */
var MATERIAL_TI64_BONE = {
  Es_MPa:      110000,    /* Ti-6Al-4V Young's modulus */
  nu:          0.34,      /* Ti-6Al-4V Poisson */
  ks_WmK:      6.7,       /* Ti-6Al-4V thermal conductivity */
  muFluid_PaS: 0.001      /* Body fluid (water-like) dynamic viscosity */
};


/* ============================================================
   Demo 1 — Schwarz P primitive · TPMS solid
   ϕ(x,y,z) = cos(x) + cos(y) + cos(z)
   At iso=0 the surface bisects the cube → ~0.50 volume fraction.
   ============================================================ */
var DEMO_SCHWARZ_P = {
  family: 'tpms',
  name:   'Schwarz P',
  surface: {
    type: 'terms',
    terms: [
      { on: true, coef: 1, factors: [{ trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] },
      { on: true, coef: 1, factors: [{ trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
      { on: true, coef: 1, factors: [{ trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] }
    ]
  },
  geometry: {
    mode:       'solid',
    offset:     0,         /* iso level — solid where ϕ < offset */
    cellSizeMm: 5.0,       /* one TPMS cell = 5 mm cube */
    cellMult:   1.0
  },
  material: MATERIAL_TI64_BONE
};


/* ============================================================
   Demo 2 — Spinodoid (single-direction) · Grain sheet
   48 cosine waves with VMF(κ=8) directions clustered around +z,
   sheet topology at iso=0, half-width 0.18.
   Expected: ~0.30 VF, anisotropy aligned with z.
   ============================================================ */
var DEMO_SPINODOID = {
  family: 'grain',
  name:   'Spinodoid · z-aligned',
  field: {
    type:                'spinodoid',
    frequency:           0.45,
    rng_seed:            42,
    dir_mode:            'single',
    kappa:               8,
    principal_direction: [0, 0, 1],
    n_waves:             48
  },
  geometry: {
    mode:        'grain-sheet',
    center:      0,        /* iso level on raw spinodoid field (~[-1, 1]) */
    half_width:  0.18,
    half_invert: false,
    cellSizeMm:  5.0,
    cellMult:    1.0
  },
  material: MATERIAL_TI64_BONE
};


/* ============================================================
   Demo 3 — Hyperuniform · Grain half
   100 anisotropic Gaussian kernels (aspect 3, width 0.08) on a
   jittered grid, half topology at iso=-0.12. Solid where each
   kernel bump rises above the void baseline, giving struts
   rather than the narrow shells that grain-sheet would carve.
   Stand-in for a trabecular-bone-like scaffold — quasi-random,
   load-bearing column-like ligaments. Verified VF ≈ 17%, which
   sits in the trabecular bone volume range (10–20% in cancellous).
   ============================================================ */
var DEMO_HYPERUNIFORM = {
  family: 'grain',
  name:   'Hyperuniform · trabecular',
  field: {
    type:                'hyperuniform',
    rng_seed:            7,
    dir_mode:            'single',
    kappa:               4,
    principal_direction: [0, 0, 1],
    hu_n:                100,
    hu_aspect:           3.0,
    hu_width:            0.08
  },
  geometry: {
    mode:        'grain-half',
    center:      -0.12,    /* solid where raw_field > -0.12 → catches each bump's halo as a strut */
    half_width:  0,        /* unused in half mode but kept for schema consistency */
    half_invert: false,
    cellSizeMm:  5.0,
    cellMult:    1.0
  },
  material: MATERIAL_TI64_BONE
};


/* ============================================================
   Registry — keyed by stable id used elsewhere in the app
   ============================================================ */
var DEMO_RECIPES = {
  schwarzP:     DEMO_SCHWARZ_P,
  spinodoid:    DEMO_SPINODOID,
  hyperuniform: DEMO_HYPERUNIFORM
};

/* Convenience — array form for iteration order */
var DEMO_RECIPE_LIST = [
  { id: 'schwarzP',     recipe: DEMO_SCHWARZ_P },
  { id: 'spinodoid',    recipe: DEMO_SPINODOID },
  { id: 'hyperuniform', recipe: DEMO_HYPERUNIFORM }
];
