/* ============================================================
   F13LD.lab · validate-foam.js   (v0.14.0)
   F13LD.foam family parity with F13LD.mesh v0.9.1 / F13LD.foam v0.3.0.

   Run from the repo root:   node validate-foam.js
   Optional sibling checkouts for the cross-repo checks (1, 2):
     MESH_DIR=../f13ld.mesh  FOAM_DIR=../f13ld.foam  node validate-foam.js
   (defaults: ../f13ld.mesh and ../f13ld.foam; skipped if absent)

   Checks
     1. FoamSeeds block is byte-identical in lab, mesh and foam
     2. foamSeedsFromRecipe + buildFoamSDF are byte-identical to mesh
        (and to F13LD.foam v0.4.0+, which carries the field for its readout)
     3. Lab field == mesh's own buildFoamSDF (run from mesh's file) at
        random points, for open / closed / plateau+organic / stretched
     4. Import: a foam export goes through normalizeDesignJson, the stored
        seed positions are used (not regenerated), title, cell size
     5. Pre-v0.3.0 export (no family key) is recognised by meta.tool
     6. Non-periodic foam is refused with an explanation
     7. Sweep: foam parameters listed; thickness targets solid fraction
        exactly; cell count regenerates the seeds; stretch applies
   ============================================================ */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console, Math, JSON, Float32Array, Float64Array, Uint8Array, Int32Array, Uint32Array, Array, Object,
              isFinite, parseFloat, parseInt, String, Number, Error, setTimeout, clearTimeout,
              document: { getElementById: () => null }, window: {}, LAB_STATE: { designs: [] } };
vm.createContext(ctx);
['13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '13d-foam-kernel.js', '14-rasterizer.js', '14a-connectivity.js',
 '14c-stl-import.js', '14d-voxel-stats.js', '60-add-design.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f }));
const L = (src) => vm.runInContext(src, ctx);

let fails = 0, skips = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
}
function skip(name, why) { console.log('  SKIP ' + name + '  — ' + why); skips++; }

const MESH_DIR = process.env.MESH_DIR || path.join(__dirname, '..', 'f13ld.mesh');
const FOAM_DIR = process.env.FOAM_DIR || path.join(__dirname, '..', 'f13ld.foam');
const meshFile = path.join(MESH_DIR, 'worker', 'm25-sdf-foam.js');
const foamFile = path.join(FOAM_DIR, 'index.html');
const labSrc = fs.readFileSync(path.join(__dirname, '13d-foam-kernel.js'), 'utf8');
const block = (s) => { const m = s.match(/\/\/ ==== BEGIN FoamSeeds[\s\S]*?\/\/ ==== END FoamSeeds[^\n]*\n/); return m ? m[0] : null; };
const builders = (s) => { const a = s.indexOf('function foamSeedsFromRecipe'), b = s.indexOf('\n// ── Registry', a);
  const b2 = s.indexOf('// ==== END verbatim mesh port', a), b3 = s.indexOf('// ==== END foam field', a);
  const e = b >= 0 ? b : (b2 >= 0 ? b2 : b3); return a >= 0 && e > a ? s.slice(a, e).trimEnd() : null; };

console.log('\n1–2. Byte-identical copies');
const haveMesh = fs.existsSync(meshFile), haveFoam = fs.existsSync(foamFile);
if (haveMesh) {
  const ms = fs.readFileSync(meshFile, 'utf8');
  check('FoamSeeds block: lab == mesh', block(labSrc) !== null && block(labSrc) === block(ms));
  check('foamSeedsFromRecipe + buildFoamSDF: lab == mesh', builders(labSrc) !== null && builders(labSrc) === builders(ms));
} else skip('lab == mesh', 'no checkout at ' + MESH_DIR);
if (haveFoam) {
  const fsrc = fs.readFileSync(foamFile, 'utf8');
  check('FoamSeeds block: lab == foam', block(labSrc) !== null && block(labSrc) === block(fsrc));
  if (fsrc.indexOf('function buildFoamSDF') >= 0)
    check('foamSeedsFromRecipe + buildFoamSDF: lab == foam (v0.4.0+)', builders(labSrc) === builders(fsrc));
} else skip('lab == foam', 'no checkout at ' + FOAM_DIR);

/* A foam export exactly as F13LD.foam v0.3.0 builds it (buildExportJSON). */
function foamExport(o) {
  const FS = L('FoamSeeds');
  const gen = FS.generate({ mode: o.mode, count: o.count, regularity: o.regularity, lloydIter: o.lloyd || 0,
                            rngSeed: o.rng || 42, periodic: o.periodic !== false });
  const positions = [];
  for (const sp of gen.seeds) positions.push(+sp[0].toFixed(4), +sp[1].toFixed(4), +sp[2].toFixed(4));
  const lattice = ['kelvin', 'weairePhelan'].includes(o.mode);
  return {
    family: o.noFamily ? undefined : 'foam',
    meta: { tool: 'f13ld.foam', version: '0.3.0', timestamp: '2026-10-02T00:00:00Z', preset: o.preset || 'Lloyd-relaxed · ' + o.topo },
    domain: { world: [-5, 5], periodic: o.periodic !== false, bake_res: 96 },
    seeds: { mode: o.mode, count: o.count, count_actual: gen.seeds.length,
             regularity: (o.mode === 'poisson' || o.mode === 'lloyd') ? o.regularity : null, min_spacing: null,
             lloyd_iterations: o.mode === 'lloyd' ? o.lloyd : null, rng_seed: lattice ? null : (o.rng || 42),
             generator: 'FoamSeeds/' + FS.VERSION, positions },
    anisotropy: { enabled: !!o.stretch, stretch: o.stretch || [1, 1, 1] },
    geometry: { mode: o.topo, thickness: o.t, plateau_k: o.topo === 'plateau' ? (o.k != null ? o.k : 0.05) : null,
                organic: o.organic || 0, normalize: o.normalize !== false, tile_mm: o.tile_mm || null }
  };
}

console.log('\n3. Lab field vs mesh buildFoamSDF (mesh\'s own file)');
if (haveMesh) {
  const mctx = { console, Math, JSON, Float64Array, Int32Array, Array, Object, isFinite, Error, registerSDF: () => {} };
  vm.createContext(mctx);
  vm.runInContext(fs.readFileSync(meshFile, 'utf8'), mctx, { filename: 'm25-sdf-foam.js' });
  const cases = [
    { name: 'open · Lloyd 50', mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.12 },
    { name: 'closed · Poisson 60', mode: 'poisson', count: 60, regularity: 0.85, topo: 'closed', t: 0.06 },
    { name: 'plateau k 0.08 + organic 1.5', mode: 'lloyd', count: 40, regularity: 0.9, lloyd: 3, topo: 'plateau', t: 0.1, k: 0.08, organic: 1.5 },
    { name: 'open · stretch 1,1,1.6', mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.12, stretch: [1, 1, 1.6] },
    { name: 'Kelvin closed', mode: 'kelvin', count: 54, topo: 'closed', t: 0.07 },
    { name: 'Weaire–Phelan open, un-normalized', mode: 'weairePhelan', count: 64, topo: 'open', t: 0.15, normalize: false }
  ];
  let rs = 12345; const rnd = () => (rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const c of cases) {
    const json = foamExport(c);
    mctx.__j = json;
    const meshSdf = vm.runInContext('buildFoamSDF(__j)', mctx);
    const d = L('normalizeDesignJson')(json, 'case.json');
    const K = L('KERNELS.foam'), P = K.parseRecipe(d.recipe);
    let maxErr = 0, signFlips = 0;
    for (let i = 0; i < 4000; i++) {
      const w = [-5 + 10 * rnd(), -5 + 10 * rnd(), -5 + 10 * rnd()];
      const m = meshSdf(w);
      const l = K.evaluate(P, w[0] * Math.PI / 5, w[1] * Math.PI / 5, w[2] * Math.PI / 5) * 5 / Math.PI;
      maxErr = Math.max(maxErr, Math.abs(m - l));
      if ((m < 0) !== (l < 0) && Math.abs(m) > 1e-9) signFlips++;
    }
    check(c.name, maxErr < 1e-9 && signFlips === 0, 'max |Δ| ' + maxErr.toExponential(1) + ', sign flips ' + signFlips);
  }
} else skip('field parity', 'no mesh checkout');

console.log('\n4–6. Import');
{
  const json = foamExport({ mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.12, tile_mm: 4.5,
                            preset: 'Lloyd-relaxed · open' });
  const d = L('normalizeDesignJson')(json, 'foam.json');
  check('family foam, mode solid, recipe built', d.family === 'foam' && d.recipe && d.recipe.geometry.mode === 'solid' && d.recipe.foam.mode === 'open');
  check('title', d.title === 'Foam · Lloyd-relaxed · open · 50 cells', d.title);
  check('cell size = tile_mm', d.cell_mm === 4.5 && d.recipe.geometry.cellSizeMm === 4.5);
  /* stored positions are what gets built: nudge one seed far away → field changes there */
  const K = L('KERNELS.foam');
  const moved = JSON.parse(JSON.stringify(d.recipe)); moved.seeds.positions[0] += 2.5;
  const p0 = K.parseRecipe(d.recipe), p1 = K.parseRecipe(moved);
  let diff = 0; const H = Math.PI;
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) for (let k = 0; k < 16; k++) {
    const x = -H + (i + .5) * H / 8, y = -H + (j + .5) * H / 8, z = -H + (k + .5) * H / 8;
    if (K.evaluate(p0, x, y, z) !== K.evaluate(p1, x, y, z)) diff++;
  }
  check('stored seed positions are used (moving one changes the field)', diff > 0, diff + ' / 4096 samples changed');
  const regen = JSON.parse(JSON.stringify(d.recipe)); delete regen.seeds.positions; delete regen.seeds.positions_for;
  const vA = L('sweepVoxelFraction')(d.recipe, 48), vB = L('sweepVoxelFraction')(regen, 48);
  check('stored positions ≈ regenerated layout (4-decimal rounding only)', Math.abs(vA - vB) < 2e-3, (100 * vA).toFixed(3) + ' % vs ' + (100 * vB).toFixed(3) + ' %');

  const old = foamExport({ mode: 'poisson', count: 60, regularity: 0.9, topo: 'closed', t: 0.06, noFamily: true });
  delete old.family;
  const d2 = L('normalizeDesignJson')(old, 'old.json');
  check('pre-v0.3.0 export recognised by meta.tool', d2.family === 'foam' && !!d2.recipe);

  let msg = null;
  try { L('normalizeDesignJson')(foamExport({ mode: 'poisson', count: 60, regularity: 0.9, topo: 'open', t: 0.1, periodic: false }), 'np.json'); }
  catch (e) { msg = e.message; }
  check('non-periodic foam refused with an explanation', !!msg && /periodic/.test(msg), msg && msg.split('\n')[0]);
}

console.log('\n7. Sweep parameters');
{
  const json = foamExport({ mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'closed', t: 0.06 });
  const rec = L('normalizeDesignJson')(json, 'f.json').recipe;
  ctx.__rec = rec;
  const keys = L('sweepParamCatalog(__rec)').map(s => s.key);
  const want = ['foam.thickness', 'foam.organic', 'stretch_x', 'stretch_y', 'stretch_z', 'seeds.count', 'seeds.regularity', 'seeds.lloyd_iterations', 'seeds.rng_seed'];
  check('foam parameters listed', want.every(k => keys.includes(k)), keys.filter(k => !/^(geometry|surface|field)\./.test(k)).join(', '));
  const spec = L('sweepSpecByKey(__rec, "foam.thickness")');
  check('thickness targets solid fraction exactly (threshold)', spec && spec.target === 'threshold');
  ctx.__spec = spec;
  const targets = [0.08, 0.18, 0.30];
  const vals = L('sweepParamsForFractions(__rec, __spec, 48, [0.08, 0.18, 0.30])');
  const got = vals.map(v => { const r = JSON.parse(JSON.stringify(rec)); ctx.__r = r; ctx.__v = v; L('sweepParamSet(__r, __spec, __v)'); return L('sweepVoxelFraction(__r, 48)'); });
  check('thickness → solid fraction 8 / 18 / 30 %', got.every((g, i) => Math.abs(g - targets[i]) < 1e-3),
        got.map(g => (100 * g).toFixed(2) + ' %').join(', ') + ' at t = ' + vals.map(v => v.toFixed(4)).join(', '));

  const cnt = L('sweepSpecByKey(__rec, "seeds.count")'); ctx.__cnt = cnt;
  const r2 = JSON.parse(JSON.stringify(rec)); ctx.__r2 = r2; L('sweepParamSet(__r2, __cnt, 30)');
  const mj = L('foamMeshJson(__r2)');
  const n2 = L('foamSeedsFromRecipe')(mj).length;
  check('cell count 50 → 30 regenerates 30 seeds (stored positions set aside)', !mj.seeds.positions && n2 === 30, n2 + ' seeds');
  const vf50 = L('sweepVoxelFraction(__rec, 48)'), vf30 = L('sweepVoxelFraction(__r2, 48)');
  check('fewer cells at the same wall thickness → less solid', vf30 < vf50, (100 * vf50).toFixed(2) + ' % → ' + (100 * vf30).toFixed(2) + ' %');

  const sz = L('sweepSpecByKey(__rec, "stretch_z")'); ctx.__sz = sz;
  const r3 = JSON.parse(JSON.stringify(rec)); ctx.__r3 = r3; L('sweepParamSet(__r3, __sz, 1.8)');
  check('stretch z applies', r3.anisotropy.enabled && r3.anisotropy.stretch[2] === 1.8 && L('sweepVoxelFraction(__r3, 48)') !== vf50);
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + (skips ? ' (' + skips + ' skipped)' : ''));
process.exit(fails ? 1 : 0);
