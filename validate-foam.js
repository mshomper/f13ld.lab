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
     8. Exact field (geometry.field = 2, F13LD.foam v0.6.0): lab == mesh;
        walls, struts, fillet + node, wet borders and power-cell weights
        match a brute-force reference over every periodic copy; tiles
        seamlessly; few-seed tiles and stretch; sweep CSV columns
     9. Seed modes (FoamSeeds v2): power cells fill the cube; lattice cell
        volumes; two-size mix hits its cell volumes; symmetric seeds keep
        their symmetry; v1 modes and jitter-free lattices are unchanged
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
                            rngSeed: o.rng || 42, periodic: o.periodic !== false,
                            sizeRatio: o.size_ratio, largeFraction: o.large_fraction, jitter: o.jitter });
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
             generator: 'FoamSeeds/' + FS.VERSION, positions,
             weights: gen.weights || undefined, size_ratio: o.size_ratio, large_fraction: o.large_fraction, jitter: o.jitter },
    anisotropy: { enabled: !!o.stretch, stretch: o.stretch || [1, 1, 1] },
    geometry: { mode: o.topo, thickness: o.t, plateau_k: o.topo === 'plateau' ? (o.k != null ? o.k : 0.05) : null,
                organic: o.organic || 0, normalize: o.normalize !== false, tile_mm: o.tile_mm || null,
                field: o.field, fillet: o.fillet, node: o.node, border: o.border }
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
    { name: 'Weaire–Phelan open, un-normalized', mode: 'weairePhelan', count: 64, topo: 'open', t: 0.15, normalize: false },
    { name: 'exact field · open Lloyd 50', mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.12, field: 2 },
    { name: 'exact field · plateau + fillet + node, stretch', mode: 'lloyd', count: 40, regularity: 0.9, lloyd: 3, topo: 'plateau', t: 0.1, k: 0.08, fillet: 0.2, node: 0.08, stretch: [1, 1, 1.6], field: 2 },
    { name: 'exact field · wet, two-size mix', mode: 'bimodal', count: 30, regularity: 0.9, lloyd: 2, topo: 'wet', t: 0.1, border: 0.5, size_ratio: 2, large_fraction: 0.3, field: 2 },
    { name: 'exact field · Kelvin one cube, closed', mode: 'kelvin', count: 2, topo: 'closed', t: 0.1, field: 2 }
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

console.log('\n8. Exact field (field 2)');
{
  /* Brute-force reference: every seed's 27 periodic copies, nearest 20 as
     planes, every edge line / vertex tested — no grid, no pruning. */
  function reference(json) {
    const S = L('foamSeedsFromRecipe')(json), an = json.anisotropy || {}, g = json.geometry || {};
    const st = an.enabled ? an.stretch : [1, 1, 1], m = st.map(v => 1 / (v * v));
    const W = S.weights, wmax = W ? Math.max(...W) : 0;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    return (p) => {
      const c = [];
      S.forEach((s, i) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) {
        const v = [p[0] - s[0] - 10 * a, p[1] - s[1] - 10 * b, p[2] - s[2] - 10 * e];
        c.push({ v, d: v[0] * v[0] * m[0] + v[1] * v[1] * m[1] + v[2] * v[2] * m[2] + (W ? wmax - W[i] : 0) });
      } });
      c.sort((x, y) => x.d - y.d);
      const shift = g.mode === 'wet' ? g.border : 0, P = [];
      for (let j = 1; j < Math.min(20, c.length); j++) {
        const w = [0, 1, 2].map(i => (c[0].v[i] - c[j].v[i]) * m[i]), l = Math.hypot(...w);
        P.push({ n: w.map(x => x / l), c: (c[j].d - c[0].d) / (2 * l) - shift });
      }
      const ins = (x, sk) => P.every((q, i) => sk.includes(i) || dot(q.n, x) <= q.c + 1e-9);
      const V = [], E = {};
      for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) for (let k = b + 1; k < P.length; k++) {
        const A = P[a], B = P[b], C = P[k], nb = cr(B.n, C.n), nc = cr(C.n, A.n), na = cr(A.n, B.n), d = dot(A.n, nb);
        if (Math.abs(d) < 1e-12) continue;
        const y = [0, 1, 2].map(i => (A.c * nb[i] + B.c * nc[i] + C.c * na[i]) / d);
        if (!ins(y, [a, b, k])) continue;
        const dv = Math.hypot(...y); V.push(dv);
        for (const kk of [a + ',' + b, a + ',' + k, b + ',' + k]) E[kk] = Math.min(E[kk] ?? Infinity, dv);
      }
      for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) {
        const A = P[a], B = P[b], cab = dot(A.n, B.n), det = 1 - cab * cab;
        if (det < 1e-12) continue;
        const al = (A.c - B.c * cab) / det, be = (B.c - A.c * cab) / det, x = [0, 1, 2].map(i => al * A.n[i] + be * B.n[i]);
        if (ins(x, [a, b])) E[a + ',' + b] = Math.hypot(...x);
      }
      const faceDist = j => { const q = P[j], x = q.n.map(t => t * q.c); if (ins(x, [j])) return q.c;
        let d = Infinity; for (const k in E) { const [a, b] = k.split(',').map(Number); if (a === j || b === j) d = Math.min(d, E[k]); } return d; };
      if (g.mode === 'wet') {
        let best = 0;
        if (!P.every(q => q.c >= 0)) { best = Infinity; P.forEach((q, j) => { const x = q.n.map(t => t * q.c); if (ins(x, [j])) best = Math.min(best, Math.abs(q.c)); });
          for (const k in E) best = Math.min(best, E[k]); }
        return { wet: g.border - Math.min(best, g.border + 1) + 0.02 * g.border };
      }
      const blend = (mem) => { if (g.node > 0) V.forEach(v => mem.push(v - g.node)); mem.sort((a, b) => a - b);
        let mm = mem[0]; const k = g.fillet || 0;
        if (k > 0) for (let i = 1; i < mem.length && mem[i] < mm + k; i++) { const h = Math.max(k - Math.abs(mm - mem[i]), 0) / k; mm = Math.min(mm, mem[i]) - k * 0.5 * (1 + h - Math.sqrt(1 - h * (h - 2))); }
        return mm; };
      return { wall: blend(P.map((q, j) => faceDist(j)).filter(isFinite)), edge: blend(Object.values(E)) };
    };
  }
  const cases = [
    { name: 'open · Lloyd 60', mode: 'lloyd', count: 60, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.1 },
    { name: 'closed · Poisson 60', mode: 'poisson', count: 60, regularity: 0.85, topo: 'closed', t: 0.06 },
    { name: 'open · stretch 1, 1, 1.6', mode: 'lloyd', count: 40, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.1, stretch: [1, 1, 1.6] },
    { name: 'closed · stretch 1.4, 1, 0.8', mode: 'poisson', count: 40, regularity: 0.9, topo: 'closed', t: 0.08, stretch: [1.4, 1, 0.8] },
    { name: 'open · Lloyd 8', mode: 'lloyd', count: 8, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.2 },
    { name: 'closed · Kelvin one cube (2 seeds)', mode: 'kelvin', count: 2, topo: 'closed', t: 0.1 },
    { name: 'open · Kelvin one cube (2 seeds)', mode: 'kelvin', count: 2, topo: 'open', t: 0.15 },
    { name: 'closed · Weaire–Phelan one cube (8 seeds)', mode: 'weairePhelan', count: 8, topo: 'closed', t: 0.1 },
    { name: 'open · fillet 0.25 + node 0.1', mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.1, fillet: 0.25, node: 0.1 },
    { name: 'closed · fillet 0.3, stretch', mode: 'poisson', count: 40, regularity: 0.9, topo: 'closed', t: 0.07, fillet: 0.3, stretch: [1.3, 1, 1] },
    { name: 'wet · border 0.4', mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'wet', t: 0.1, border: 0.4 },
    { name: 'wet · Kelvin one cube, border 1.0', mode: 'kelvin', count: 2, topo: 'wet', t: 0.1, border: 1.0 },
    { name: 'open · two-size mix (weights) + fillet', mode: 'bimodal', count: 40, regularity: 0.9, lloyd: 2, topo: 'open', t: 0.1, size_ratio: 2, large_fraction: 0.3, fillet: 0.15 },
    { name: 'closed · two-size mix (weights)', mode: 'bimodal', count: 40, regularity: 0.9, lloyd: 2, topo: 'closed', t: 0.07, size_ratio: 2.5, large_fraction: 0.2 },
    { name: 'open · cubic-symmetric', mode: 'cubic', count: 48, regularity: 0.9, lloyd: 2, topo: 'open', t: 0.12 },
    { name: 'closed · C15 one cube', mode: 'c15', count: 24, topo: 'closed', t: 0.08 },
    { name: 'open · FCC, disorder 0.15', mode: 'fcc', count: 32, topo: 'open', t: 0.12, jitter: 0.15 }
  ];
  let rs = 777; const rnd = () => (rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const c of cases) {
    const json = foamExport(Object.assign({ field: 2 }, c));
    const f = L('buildFoamSDF')(json), ref = reference(json), closed = c.topo === 'closed';
    let maxErr = 0, n = 0, maxTile = 0;
    for (let i = 0; i < 20000 && n < 300; i++) {
      const p = [-5 + 10 * rnd(), -5 + 10 * rnd(), -5 + 10 * rnd()];
      const r = ref(p), wet = c.topo === 'wet', want = wet ? r.wet : (closed ? r.wall : r.edge) - c.t;
      if (Math.abs(want) > 0.15) continue;   /* near the surface, where the shape is decided */
      n++; maxErr = Math.max(maxErr, Math.abs(f(p) - want));
      const q = p.slice(); q[i % 3] += 10 * (1 + i % 2); maxTile = Math.max(maxTile, Math.abs(f(q) - f(p)));
    }
    check(c.name, n > 20 && maxErr < 1e-9 && maxTile < 1e-12, 'max |Δ| vs reference ' + maxErr.toExponential(1) + ' over ' + n + ' points, tile seam ' + maxTile.toExponential(1));
  }
  /* field 2 is opt-in: the same recipe without it builds the original field */
  const j1 = foamExport({ mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.12 });
  const j2 = foamExport({ mode: 'lloyd', count: 50, regularity: 0.9, lloyd: 4, topo: 'open', t: 0.12, field: 2 });
  const f1 = L('buildFoamSDF')(j1), f2 = L('buildFoamSDF')(j2);
  let differ = 0; for (let i = 0; i < 500; i++) { const p = [-5 + 10 * rnd(), -5 + 10 * rnd(), -5 + 10 * rnd()]; if (f1(p) !== f2(p)) differ++; }
  check('recipes without field 2 keep the original field', differ > 400, differ + ' / 500 points differ between the two');
  /* sweep CSV rows can ask for the exact field */
  if (typeof ctx.sweepFoamRunFromCsvRow !== 'function') vm.runInContext(fs.readFileSync(path.join(__dirname, '62-sweep.js'), 'utf8'), ctx, { filename: '62-sweep.js' });
  const row = L('sweepFoamRunFromCsvRow')({ seed_mode: 'lloyd', cells: '27', topology: 'open', thickness: '0.1', field: '2' }, 'r1');
  const row0 = L('sweepFoamRunFromCsvRow')({ seed_mode: 'lloyd', cells: '27', topology: 'open', thickness: '0.1' }, 'r0');
  check('sweep CSV: field column selects the exact field', row.recipe.foam.field === 2 && row0.recipe.foam.field === undefined);
  const roww = L('sweepFoamRunFromCsvRow')({ seed_mode: 'bimodal', cells: '30', topology: 'wet', border: '0.5', field: '2', size_ratio: '2', large_fraction: '0.3' }, 'r2');
  check('sweep CSV: wet foam, border and two-size columns', roww.recipe.foam.mode === 'wet' && roww.recipe.foam.border === 0.5 && roww.recipe.seeds.size_ratio === 2);
}

console.log('\n9. Seed modes (FoamSeeds v2)');
{
  const FS = L('FoamSeeds');
  const sumVol = (pts, w) => Array.from(FS.powerCells(pts, w).vol).reduce((a, b) => a + b, 0);
  const lat = (mode, count) => FS.generate({ mode, count, periodic: true }).seeds;
  for (const [mode, count, want] of [['kelvin', 16, [62.5]], ['fcc', 32, [31.25]], ['weairePhelan', 64, null], ['c15', 24, null]]) {
    const pts = lat(mode, count), v = Array.from(FS.powerCells(pts, null).vol);
    const classes = [...new Set(v.map(x => x.toFixed(4)))];
    const ok = Math.abs(v.reduce((a, b) => a + b, 0) - 1000) < 1e-6 && (want ? classes.length === 1 && Math.abs(+classes[0] - want[0]) < 1e-4 : classes.length === 2);
    check(mode + ': cells fill the cube, ' + classes.length + ' cell size(s)', ok, classes.join(', '));
  }
  const b = FS.generate({ mode: 'bimodal', count: 60, regularity: 0.9, lloydIter: 3, rngSeed: 5, periodic: true, sizeRatio: 2, largeFraction: 0.3 });
  const vb = Array.from(FS.powerCells(b.seeds, b.weights).vol).sort((x, y) => x - y), nL = 18, vS = 1000 / (nL * 8 + 42);
  const errB = Math.max(...vb.slice(0, 42).map(x => Math.abs(x / vS - 1)), ...vb.slice(42).map(x => Math.abs(x / (8 * vS) - 1)));
  check('two-size mix: every cell within 0.5 % of its volume (ratio 2, 30 % large)', errB < 0.005, 'worst ' + (100 * errB).toFixed(3) + ' %');
  for (const [mode, count] of [['mirror', 120], ['cubic', 96]]) {
    const pts = FS.generate({ mode, count, regularity: 0.9, lloydIter: 2, rngSeed: 3, periodic: true }).seeds;
    const has = q => pts.some(o => [0, 1, 2].every(a => Math.abs(((o[a] - q[a] + 15) % 10) - 5) < 1e-6));
    let missing = 0;
    for (const p of pts) {
      const imgs = [[-p[0], p[1], p[2]], [p[0], -p[1], p[2]], [p[0], p[1], -p[2]]].concat(mode === 'cubic' ? [[p[1], p[0], p[2]], [p[2], p[1], p[0]]] : []);
      for (const q of imgs) if (!has(q)) missing++;
    }
    check(mode + '-symmetric: every mirror' + (mode === 'cubic' ? ' and axis-swap' : '') + ' image present (' + pts.length + ' seeds)', missing === 0, missing + ' missing');
  }
  const k0 = lat('kelvin', 54), k1 = FS.generate({ mode: 'kelvin', count: 54, periodic: true, jitter: 0, rngSeed: 9 }).seeds;
  check('lattice with no disorder is unchanged by the random seed', JSON.stringify(k0) === JSON.stringify(k1));
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + (skips ? ' (' + skips + ' skipped)' : ''));
process.exit(fails ? 1 : 0);
