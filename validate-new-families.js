/* ============================================================
   F13LD.lab · _validation/validate-new-families.js
   Cross-checks the three new SDF kernels (Beam · Bundle · Wave)
   in 13b-kernels-new.js against the verbatim mesh builders in
   mesh-ref.js (extracted from index_-_mesh.html).

   Method
   ------
   Sample the unit cell on an M³ grid. For each Lab solver point
   s ∈ [-π,π], the matched mesh world point is w = s·(5/π).
   We compare:
     · sign agreement  (solid mask: SDF < 0)  → must be ~100%
     · volume fraction (fraction with SDF < 0) → must match
     · value ratio     lab / mesh              → constant per family
                       (wave 1.0 ; bundle & beam π/5 ≈ 0.6283)

   A faithful port gives 100.00% sign agreement and identical VF.
   ============================================================ */

const mesh = require('./mesh-ref.js');
const lab  = require('../13b-kernels-new.js');

const PI = Math.PI, W = 5 / PI;     /* solver→world */
const M = 40;                       /* grid per side */

function sweep(labKernel, buildMeshSDF, recipe, label) {
  const params  = labKernel.parseRecipe(JSON.parse(JSON.stringify(recipe)));
  const meshSDF = buildMeshSDF(JSON.parse(JSON.stringify(recipe)));
  let disagree = 0, total = 0, labSolid = 0, meshSolid = 0;
  let ratSum = 0, ratN = 0;
  const step = (2 * PI) / M;
  for (let i = 0; i < M; i++) {
    const x = -PI + (i + 0.5) * step;
    for (let j = 0; j < M; j++) {
      const y = -PI + (j + 0.5) * step;
      for (let k = 0; k < M; k++) {
        const z = -PI + (k + 0.5) * step;
        const lv = labKernel.evaluate(params, x, y, z);
        const mv = meshSDF([x * W, y * W, z * W]);
        const ls = lv < 0, ms = mv < 0;
        if (ls) labSolid++;
        if (ms) meshSolid++;
        if (ls !== ms) disagree++;
        total++;
        /* value ratio away from the surface (avoid 0/0 near iso) */
        if (Math.abs(mv) > 1e-3 && Math.abs(lv) > 1e-9) { ratSum += lv / mv; ratN++; }
      }
    }
  }
  const labVF = labSolid / total, meshVF = meshSolid / total;
  const agree = (1 - disagree / total) * 100;
  const ratio = ratN ? ratSum / ratN : NaN;
  const ok = agree >= 99.9 && Math.abs(labVF - meshVF) < 0.002;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} ` +
    `sign-agree ${agree.toFixed(2).padStart(6)}%  ` +
    `VF lab ${(labVF*100).toFixed(2).padStart(5)}% / mesh ${(meshVF*100).toFixed(2).padStart(5)}%  ` +
    `Δ ${((labVF-meshVF)*100).toFixed(3).padStart(6)}pp  ` +
    `mean(lab/mesh) ${ratio.toFixed(4)}`
  );
  return ok;
}

console.log('── Lab new-family kernels vs mesh reference ──────────────────────────');
let all = true;

/* WAVE — three symmetry operators, solid + sheet */
all &= sweep(lab.WaveKernel, mesh.buildWaveSDF, {
  family: 'wave',
  field: { symmetry: 'cubic', mode: 'solid', iso: 0,
           modes: [{ n:1,m:1,p:1,A:1,phi:0 }, { n:2,m:1,p:1,A:0.4,phi:0.3 }] }
}, 'wave · cubic solid');

all &= sweep(lab.WaveKernel, mesh.buildWaveSDF, {
  family: 'wave',
  field: { symmetry: 'chladni', mode: 'sheet', iso: 0.2, thickness: 0.25,
           modes: [{ n:2,m:1,p:1,A:1,phi:0 }, { n:1,m:3,p:2,A:0.6,phi:1.1 }] }
}, 'wave · chladni sheet');

all &= sweep(lab.WaveKernel, mesh.buildWaveSDF, {
  family: 'wave',
  field: { symmetry: 'chiral', mode: 'solid', iso: -0.1, signFlip: true,
           modes: [{ n:1,m:2,p:1,A:1,phi:0 }] }
}, 'wave · chiral flip');

/* BUNDLE — all four structures */
all &= sweep(lab.BundleKernel, mesh.buildBundleSDF, {
  family: 'bundle',
  surface: { structure: 'bundle', iso_offset: 0.0 },
  geometry: { beam_radius: 0.10, beams_per_side: 3, beam_spacing: 0.30, column_gap: 0.20, twist_rate: 1.2, blend_k: 0.01 }
}, 'bundle · twisted array');

all &= sweep(lab.BundleKernel, mesh.buildBundleSDF, {
  family: 'bundle',
  surface: { structure: 'helicoid' },
  geometry: { pitch: 1.5, thickness: 0.05, outer_radius: 0.4, inner_radius: 0.0, starts: 2, column_gap: 0.2, helicoid_blend: 0.01 }
}, 'bundle · helicoid');

all &= sweep(lab.BundleKernel, mesh.buildBundleSDF, {
  family: 'bundle',
  surface: { structure: 'braid' },
  geometry: { strand_count: 3, braid_radius: 0.12, pitch: 1.2, fiber_radius: 0.06, column_gap: 0.2, blend_k: 0.01 }
}, 'bundle · braid');

all &= sweep(lab.BundleKernel, mesh.buildBundleSDF, {
  family: 'bundle',
  surface: { structure: 'weave', topology: 'sheet', sheet_width: 0.03 },
  geometry: { weave_pitch: 0.5, weave_amplitude: 0.1, fiber_radius: 0.06, blend_k: 0.01 }
}, 'bundle · weave sheet');

/* BEAM — old scalar schema + new per-axis schema + node decorations */
all &= sweep(lab.BeamKernel, mesh.buildBeamSDF, {
  family: 'beam',
  beams: [[-1,0,0,1,0,0,1],[0,-1,0,0,1,0,1],[0,0,-1,0,0,1,1],
          [-1,-1,-1,1,1,1,1],[-1,1,-1,1,-1,1,1]],
  geometry: { cell_scale: 1, radius: 0.12 }
}, 'beam · old schema');

all &= sweep(lab.BeamKernel, mesh.buildBeamSDF, {
  family: 'beam',
  beams: [[-1,0,0,1,0,0,1],[0,-1,0,0,1,0,1],[0,0,-1,0,0,1,1]],
  geometry: { cell: 5, scale_xyz: [5, 5, 2.5], radius_x: 0.15, radius_y: 0.15, radius_z: 0.10 }
}, 'beam · per-axis schema');

all &= sweep(lab.BeamKernel, mesh.buildBeamSDF, {
  family: 'beam',
  beams: [[-1,0,0,1,0,0,1],[0,-1,0,0,1,0,1],[0,0,-1,0,0,1,1],
          [-1,-1,-1,1,1,1,1]],
  geometry: { cell: 5, scale_xyz: [5,5,5], radius_x: 0.12, node_ball_radius: 0.18, node_smoothing_k: 0.10 }
}, 'beam · nodes + smin');

console.log('──────────────────────────────────────────────────────────────────────');
console.log(all ? 'ALL NEW-FAMILY CHECKS PASSED' : 'SOME CHECKS FAILED — see above');
process.exit(all ? 0 : 1);
