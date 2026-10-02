/* ============================================================
   F13LD.lab · docs/foam-calibration/make_runs.js   (v0.14.0)
   Builds foam_calibration_runs.csv — the F13LD.foam stiffness
   calibration study (docs/FOAM_CALIBRATION.md).

   Run from the repo root:   node docs/foam-calibration/make_runs.js

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

const N_TARGET = 64;    /* the run grid: the build check then matches exactly; fits use each run's measured ρ */
const CELLS = { open: 27, plateau: 27, closed: 16 };   /* resolution-driven, see FOAM_CALIBRATION.md §2 */
const rows = [];
function run(id, set, purpose, o) {
  rows.push(Object.assign({ run_id: id, family: 'foam', set, purpose, seed_mode: 'lloyd', regularity: 0.9, lloyd_iterations: 4,
                            rng_seed: 1, plateau_k: '', organic: 0, stretch_x: 1, stretch_y: 1, stretch_z: 1, normalize: 'true',
                            grid_N: 64, nu_s: 0.3, note: '' }, o));
}
const pct = (v) => Math.round(v * 100);

/* A — core law: Lloyd-relaxed, 2 realizations */
for (const topo of ['open', 'plateau', 'closed']) {
  const levels = topo === 'closed' ? [0.12, 0.18, 0.25, 0.35] : [0.08, 0.12, 0.18, 0.25, 0.35];
  for (const rho of levels) for (const r of [1, 2])
    run('A-' + topo + '-' + pct(rho) + '-r' + r, 'A', 'core law', { topology: topo, cells: CELLS[topo], rng_seed: r, target: rho,
        plateau_k: topo === 'plateau' ? 0.05 : '' });
}
/* B — disorder: Poisson-disk seeds (no relaxation) */
[['open', 0.08], ['open', 0.18], ['open', 0.35], ['plateau', 0.18], ['closed', 0.18], ['closed', 0.35]].forEach(([topo, rho]) =>
  run('B-' + topo + '-' + pct(rho), 'B', 'disorder (Poisson)', { topology: topo, cells: CELLS[topo], seed_mode: 'poisson',
      lloyd_iterations: '', target: rho, plateau_k: topo === 'plateau' ? 0.05 : '' }));
/* C — ordered: Kelvin (BCC, 2 per cube → 16 seeds) and Weaire–Phelan (8 per cube → 8 seeds) */
for (const [mode, count, tag] of [['kelvin', 16, 'K'], ['weairePhelan', 8, 'WP']])
  for (const topo of ['open', 'closed']) for (const rho of [0.12, 0.25])
    run('C-' + tag + '-' + topo + '-' + pct(rho), 'C', 'ordered (' + (tag === 'K' ? 'Kelvin' : 'Weaire–Phelan') + ')',
        { topology: topo, cells: count, seed_mode: mode, regularity: '', lloyd_iterations: '', rng_seed: '', target: rho });
/* D — stretch along z (directional split) */
for (const topo of ['open', 'closed']) for (const s of [1.25, 1.5, 2])
  run('D-' + topo + '-sz' + s, 'D', 'stretch z', { topology: topo, cells: CELLS[topo], stretch_z: s, target: 0.18 });

/* Solve thickness for each target at 128³ (exact quantile of the zero-thickness field). */
function recipeOf(r) {
  return { family: 'foam', name: r.run_id,
    seeds: { mode: r.seed_mode, count: r.cells, regularity: r.regularity === '' ? 0.9 : r.regularity,
             lloyd_iterations: r.lloyd_iterations === '' ? 0 : r.lloyd_iterations, rng_seed: r.rng_seed === '' ? 42 : r.rng_seed },
    anisotropy: { enabled: true, stretch: [r.stretch_x, r.stretch_y, r.stretch_z] },
    foam: { mode: r.topology, thickness: 0.1, plateau_k: r.plateau_k === '' ? null : r.plateau_k, organic: 0, normalize: true },
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
  if (r.feature_vox_128 < 3) r.note = 'thin: ' + r.feature_vox_128 + ' voxels across at 128 (' + r.feature_vox_64 + ' at 64) — read as indicative';
  process.stderr.write('\r' + (i + 1) + '/' + rows.length + '  ' + r.run_id + '        ');
});
process.stderr.write('\n' + rows.length + ' runs, ' + Math.round((Date.now() - t0) / 1000) + ' s\n');

const cols = ['run_id', 'family', 'set', 'purpose', 'seed_mode', 'cells', 'regularity', 'lloyd_iterations', 'rng_seed', 'topology',
              'thickness', 'plateau_k', 'organic', 'stretch_x', 'stretch_y', 'stretch_z', 'normalize', 'grid_N', 'nu_s',
              'expected_vf_pct', 'target_vf_pct', 'feature_vox_64', 'feature_vox_128', 'note'];
const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
fs.writeFileSync(path.join(__dirname, 'foam_calibration_runs.csv'),
  [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n') + '\n');
console.log('wrote foam_calibration_runs.csv (' + rows.length + ' runs)');
