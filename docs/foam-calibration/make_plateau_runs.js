/* ============================================================
   F13LD.lab · docs/foam-calibration/make_runs.js   (v0.14.0)
   Builds foam_plateau_runs.csv — the plateau-border pass of the F13LD.foam
   stiffness calibration (docs/FOAM_CALIBRATION.md §7).

   Run from the repo root:   node docs/foam-calibration/make_plateau_runs.js

   Each row's thickness is solved here so the foam's voxel solid
   fraction (before island trim) is exactly the target at 64³ (the run grid) — the
   same thresholding the sweep builder uses ("step by solid fraction").
   ============================================================ */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ctx = { console: { log() {}, warn() {} }, Math, JSON, Float32Array, Float64Array, Uint8Array, Int32Array, Uint32Array,
              Array, Object, isFinite, parseFloat, parseInt, String, Number, Error };
vm.createContext(ctx);
['13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '13d-foam-kernel.js', '14-rasterizer.js', '14a-connectivity.js',
 '14c-stl-import.js', '14d-voxel-stats.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
const L = (s) => vm.runInContext(s, ctx);
/* v0.17.3 — FOAM_FIELD=2 (default) builds F13LD.foam v0.6.0's exact field and
   writes <name>_field2.csv; FOAM_FIELD=1 rebuilds the original-field file. */
const FIELD = process.env.FOAM_FIELD === '1' ? 1 : 2;

const N_TARGET = 64;    /* the run grid: the build check then matches exactly; fits use each run's measured ρ */
const rows = [];
function run(id, set, purpose, o) {
  rows.push(Object.assign({ run_id: id, family: 'foam', set, purpose, seed_mode: 'lloyd', regularity: 0.9, lloyd_iterations: 4,
                            rng_seed: 1, plateau_k: '', organic: 0, stretch_x: 1, stretch_y: 1, stretch_z: 1, normalize: 'true',
                            grid_N: 64, nu_s: 0.3, field: FIELD === 2 ? 2 : '', note: '' }, o));
}
const pct = (v) => Math.round(v * 100);
const kTag = (k) => k === 0 ? 'open' : 'k' + k;

/* P — plateau borders at thin struts, each k paired with an open run (same cells, density, seeds) */
for (const [cells, rho, ks] of [[27, 0.05, [0, 0.1, 0.2, 0.3]], [50, 0.05, [0, 0.05, 0.1, 0.2]], [50, 0.08, [0, 0.05, 0.1, 0.2, 0.3]]])
  for (const k of ks)
    run('P-c' + cells + '-' + pct(rho) + '-' + kTag(k), 'P', 'plateau k', { topology: k === 0 ? 'open' : 'plateau', cells, target: rho, plateau_k: k === 0 ? '' : k });
/* P2 — second realization of the 50-cell pairs */
for (const rho of [0.05, 0.08]) for (const k of [0, 0.2])
  run('P-c50-' + pct(rho) + '-' + kTag(k) + '-r2', 'P', 'plateau k (realization 2)', { topology: k === 0 ? 'open' : 'plateau', cells: 50, rng_seed: 2, target: rho, plateau_k: k === 0 ? '' : k });
/* N — cell-count check for the open law at 12 % (set A is 27 cells) */
for (const cells of [16, 50]) run('N-c' + cells + '-open-12', 'N', 'cell count', { topology: 'open', cells, target: 0.12 });

/* Solve thickness for each target at 128³ (exact quantile of the zero-thickness field). */
function recipeOf(r) {
  return { family: 'foam', name: r.run_id,
    seeds: { mode: r.seed_mode, count: r.cells, regularity: r.regularity === '' ? 0.9 : r.regularity,
             lloyd_iterations: r.lloyd_iterations === '' ? 0 : r.lloyd_iterations, rng_seed: r.rng_seed === '' ? 42 : r.rng_seed },
    anisotropy: { enabled: true, stretch: [r.stretch_x, r.stretch_y, r.stretch_z] },
    foam: { mode: r.topology, thickness: 0.1, plateau_k: r.plateau_k === '' ? null : r.plateau_k, organic: 0, normalize: true, field: FIELD === 2 ? 2 : undefined },
    geometry: { mode: 'solid', cellSizeMm: 5, cellMult: 1 } };
}
const t0 = Date.now();
rows.forEach((r, i) => {
  const rec = recipeOf(r); ctx.__r = rec; ctx.__s = L('sweepSpecByKey(__r, "foam.thickness")');
  const t = L('sweepParamsForFractions(__r, __s, ' + N_TARGET + ', [' + r.target + '])')[0];
  r.thickness = +t.toFixed(5);
  rec.foam.thickness = r.thickness; ctx.__r = rec;
  const width = 2 * r.thickness;               /* wall / strut Ø in tile units (normalize on) */
  r.feature_vox_64 = +(width * 6.4).toFixed(1); r.feature_vox_128 = +(width * 12.8).toFixed(1);
  /* expected = what this thickness actually builds at the run grid (ordered lattices
     have tied field values, so the quantile can't always split them exactly) */
  const vf = L('sweepVoxelFraction(__r, ' + N_TARGET + ')');
  r.expected_vf_pct = +(100 * vf).toFixed(2);
  r.target_vf_pct = +(100 * r.target).toFixed(2);
  if (r.feature_vox_64 < 2.5) r.note = 'thin at 64 (' + r.feature_vox_64 + ' voxels, 2t): compare with its paired open run';
  process.stderr.write('\r' + (i + 1) + '/' + rows.length + '  ' + r.run_id + '        ');
});
process.stderr.write('\n' + rows.length + ' runs, ' + Math.round((Date.now() - t0) / 1000) + ' s\n');

const cols = ['run_id', 'family', 'set', 'purpose', 'seed_mode', 'cells', 'regularity', 'lloyd_iterations', 'rng_seed', 'topology',
              'thickness', 'plateau_k', 'organic', 'stretch_x', 'stretch_y', 'stretch_z', 'normalize', 'field', 'grid_N', 'nu_s',
              'expected_vf_pct', 'target_vf_pct', 'feature_vox_64', 'feature_vox_128', 'note'];
const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
fs.writeFileSync(path.join(__dirname, 'foam_plateau_runs' + (FIELD === 2 ? '_field2' : '') + '.csv'),
  [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n') + '\n');
console.log('wrote foam_plateau_runs' + (FIELD === 2 ? '_field2' : '') + '.csv (' + rows.length + ' runs)');
