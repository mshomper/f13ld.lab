/* ============================================================
   F13LD.lab · validate-field-pairs.js   (v0.13.0)
   Field-pair PI-TPMS parity with F13LD.tpms v1.1.0 / F13LD.mesh v0.7.1.

   Run from the repo root:   node validate-field-pairs.js

   Recipes go through the real import path (normalizeDesignJson) and the
   real voxelizer (buildVoxels).  The reference is an independent copy of
   the F13LD.tpms / F13LD.mesh math (raw preset functions with their
   constants, amp·φB(k·p + δ), angle-corrected pipe distance).

   Checks
     1. Self-pair gyroid (normalized + raw) — unchanged path, matches reference
     2. gyroid × Fischer-Koch S at 2×, scale exported by F13LD.tpms
     3. same recipe without field_b_scale — Lab recomputes the same scale
     4. gyroid × Schwarz P (terms), un-normalized
     5. split-P self-pair — preset constant now in the solve (the v0.13.0 fix)
     6. gyroid × split-P — field B keeps its own constant
     7. sweep: frequency parameter listed, rounded when applied,
        and solid-fraction targeting by pipe radius works on a pair
     8. preview bake of field B equals the solver's field B
   ============================================================ */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console, Math, JSON, Float32Array, Float64Array, Uint8Array, Int32Array, Uint32Array, Array, Object,
              isFinite, parseFloat, parseInt, String, Number, Error, setTimeout, clearTimeout,
              document: { getElementById: () => null }, window: {}, LAB_STATE: { designs: [] } };
vm.createContext(ctx);
['13-kernels.js', '13b-kernels-new.js', '13c-import-kernel.js', '14-rasterizer.js', '14a-connectivity.js',
 '14c-stl-import.js', '14d-voxel-stats.js', '60-add-design.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f }));
const L = (src) => vm.runInContext(src, ctx);

/* ── Reference (F13LD.tpms / F13LD.mesh math) ─────────────── */
const T = (trig) => ({ trig, fx: 1, fy: 1, fz: 1 });
const GYROID = [[T('sin(x)'), T('cos(y)')], [T('sin(y)'), T('cos(z)')], [T('sin(z)'), T('cos(x)')]]
  .map(f => ({ on: true, coef: 1, factors: f }));
const SCHWARZ_P = ['cos(x)', 'cos(y)', 'cos(z)'].map(c => ({ on: true, coef: 1, factors: [T(c)] }));
const RAW = {
  fks:    (x, y, z) => Math.cos(2*x)*Math.sin(y)*Math.cos(z) + Math.cos(2*y)*Math.sin(z)*Math.cos(x) + Math.cos(2*z)*Math.sin(x)*Math.cos(y),
  splitP: (x, y, z) => Math.sin(x)*Math.sin(y)*Math.cos(z) + Math.sin(y)*Math.sin(z)*Math.cos(x) + Math.sin(z)*Math.sin(x)*Math.cos(y) - 0.3
};
function termsFn(terms) {
  return (x, y, z) => terms.reduce((s, t) => s + (t.on ? t.factors.reduce((p, f) => {
    const a = f.trig.includes('(x)') ? f.fx * x : f.trig.includes('(y)') ? f.fy * y : f.fz * z;
    return p * (f.trig.startsWith('sin') ? Math.sin(a) : Math.cos(a));
  }, t.coef) : 0), 0);
}
const surfFn = (s) => s.type === 'raw_preset' ? RAW[s.preset] : termsFn(s.terms);
function rms(fn) { const M = 16, H = Math.PI, st = 2*H/M; let a = 0;
  for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) for (let k = 0; k < M; k++) {
    const v = fn(-H+(i+.5)*st, -H+(j+.5)*st, -H+(k+.5)*st); a += v*v; }
  return Math.sqrt(a / (M*M*M)); }
function refMask(json, N) {
  const g = json.geometry, TP = 2*Math.PI, ps = g.phase_shift, k = g.field_b_freq || 1;
  const fA = surfFn(json.surface), fBb = json.surface_b ? surfFn(json.surface_b) : fA;
  const amp = (g.field_b_scale != null) ? g.field_b_scale : (json.surface_b ? rms(fA) / rms(fBb) : 1);
  const fB = (x, y, z) => amp * fBb(k*x + ps.x*TP, k*y + ps.y*TP, k*z + ps.z*TP);
  const e = 0.012, gr = (f, x, y, z) => [(f(x+e,y,z)-f(x-e,y,z))/(2*e), (f(x,y+e,z)-f(x,y-e,z))/(2*e), (f(x,y,z+e)-f(x,y,z-e))/(2*e)];
  const H = Math.PI, st = 2*H/N, out = new Uint8Array(N*N*N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let q = 0; q < N; q++) {
    const x = -H+(i+.5)*st, y = -H+(j+.5)*st, z = -H+(q+.5)*st, a = fA(x, y, z), b = fB(x, y, z);
    let d;
    if (g.pi_normalize) {
      const A = gr(fA, x, y, z), B = gr(fB, x, y, z);
      const mA = Math.max(Math.hypot(...A), 0.08), mB = Math.max(Math.hypot(...B), 0.08);
      let c = (A[0]*B[0] + A[1]*B[1] + A[2]*B[2]) / (mA*mB); c = Math.max(-0.95, Math.min(0.95, c));
      const dA = a/mA, dB = b/mB; d = Math.sqrt(Math.max(dA*dA - 2*c*dA*dB + dB*dB, 0) / (1 - c*c));
    } else d = Math.max(Math.abs(a), Math.abs(b));
    out[i*N*N + j*N + q] = d < g.pipe_radius ? 1 : 0;
  }
  return out;
}

/* ── Lab side ─────────────────────────────────────────────── */
function labRecipe(json) { ctx.__j = json; return L('normalizeDesignJson(__j, "test.json").recipe'); }
function labMask(recipe, N) {
  ctx.__r = recipe; ctx.__N = N;
  return L('(function(){var p=KERNELS.tpms.parseRecipe(__r),a=resolveBuildArgs(__r);' +
           'return buildVoxels("tpms",p,a.offset,__N,a.mode,a.wt,a.nWeights,a.pipeR,a.phaseShift);})()');
}

let all = true;
function check(name, ok, detail) { all = all && ok; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); }
function compare(name, json, N, minAgree) {
  const r = labRecipe(json), lab = labMask(r, N), ref = refMask(json, N);
  let same = 0, solid = 0; for (let i = 0; i < ref.length; i++) { if (lab[i] === ref[i]) same++; solid += lab[i]; }
  const agree = same / ref.length;
  check(name, agree >= minAgree, 'agree ' + (100*agree).toFixed(3) + ' %, solid ' + (100*solid/ref.length).toFixed(2) + ' %');
  return r;
}
const pi = (extra) => Object.assign({ mode: 'pi-tpms', pipe_radius: 0.3, pi_normalize: true, phase_shift: { x: 0, y: 0.125, z: 0.5 } }, extra || {});
const N = 40;

compare('1a self-pair gyroid, normalized', { surface: { type: 'terms', terms: GYROID }, geometry: pi() }, N, 0.999);
compare('1b self-pair gyroid, raw', { surface: { type: 'terms', terms: GYROID }, geometry: pi({ pi_normalize: false, pipe_radius: 0.18 }) }, N, 0.999);
const fksPair = { meta: { preset: 'gyroid' }, surface: { type: 'terms', terms: GYROID },
  surface_b: { type: 'raw_preset', preset: 'fks', label: 'Fischer-Koch S' },
  geometry: pi({ field_b_freq: 2, field_b_scale: 1.414214 }) };
const rFks = compare('2  gyroid × Fischer-Koch S at 2× (exported scale)', fksPair, N, 0.999);
check('2b title names both fields', /gyroid × Fischer-Koch S \(2×\) · pi-tpms/.test(L('normalizeDesignJson(__j,"t.json").title')),
      L('normalizeDesignJson(__j,"t.json").title'));
const noScale = JSON.parse(JSON.stringify(fksPair)); delete noScale.geometry.field_b_scale;
ctx.__r = labRecipe(noScale);
const ampRe = L('KERNELS.tpms.parseRecipe(__r).pair.amp');
check('3  scale recomputed when absent', Math.abs(ampRe - Math.SQRT2) < 1e-6, 'amp = ' + ampRe.toFixed(6));
compare('3b gyroid × Fischer-Koch S, recomputed scale', noScale, N, 0.999);
compare('4  gyroid × Schwarz P (terms), raw', { surface: { type: 'terms', terms: GYROID },
  surface_b: { type: 'terms', preset: 'schwarzP', terms: SCHWARZ_P }, geometry: pi({ pi_normalize: false, pipe_radius: 0.2 }) }, N, 0.999);
const sp = { surface: { type: 'raw_preset', preset: 'splitP', label: 'split-P' }, geometry: pi({ pipe_radius: 0.25 }) };
compare('5  split-P self-pair includes its −0.3 constant', sp, N, 0.999);
compare('6  gyroid × split-P keeps field B’s constant', { surface: { type: 'terms', terms: GYROID },
  surface_b: { type: 'raw_preset', preset: 'splitP', label: 'split-P' }, geometry: pi({ field_b_freq: 1 }) }, N, 0.999);

/* 7 — sweep */
ctx.__r = rFks;
const spec = L('sweepParamCatalog(__r).filter(function(s){return s.key==="fieldBFreq";})[0]');
check('7a sweep lists the field B frequency', !!spec && spec.integer === true);
L('var __c = JSON.parse(JSON.stringify(__r)); sweepParamSet(__c, sweepParamCatalog(__c).filter(function(s){return s.key==="fieldBFreq";})[0], 2.6)');
check('7b frequency rounded when applied', L('__c.geometry.fieldBFreq') === 3, 'applied ' + L('__c.geometry.fieldBFreq'));
check('7c derived scale is not offered as a sweep parameter', !L('sweepParamCatalog(__r).some(function(s){return /fieldBScale/.test(s.key);})'));
const fr = L('(function(){var s=sweepParamCatalog(__r).filter(function(s){return s.key==="wall_ratio";})[0];' +
             'var v=sweepParamsForFractions(__r,s,32,[0.08])[0]; var c=JSON.parse(JSON.stringify(__r)); sweepParamSet(c,s,v);' +
             'var p=KERNELS.tpms.parseRecipe(c),a=resolveBuildArgs(c),m=buildVoxels("tpms",p,a.offset,32,a.mode,a.wt,a.nWeights,a.pipeR,a.phaseShift),n=0;' +
             'for(var i=0;i<m.length;i++)n+=m[i]; return n/m.length;})()');
check('7d solid-fraction targeting on a pair (asked 8 %)', Math.abs(fr - 0.08) < 0.002, 'got ' + (100*fr).toFixed(2) + ' %');

/* 8 — preview field B */
ctx.__r = rFks;
const pv = L('(function(){var p=KERNELS.tpms.parseRecipe(__r),a=resolveBuildArgs(__r),f=buildPairField(p.pair,a.phaseShift,16),' +
             'TP=2*Math.PI,ps=a.phaseShift,H=Math.PI,st=2*H/16,m=0;' +
             'for(var z=0;z<16;z++)for(var y=0;y<16;y++)for(var x=0;x<16;x++){' +
             'var v=tpmsPairB(p.pair,-H+(x+.5)*st,-H+(y+.5)*st,-H+(z+.5)*st,ps.x*TP,ps.y*TP,ps.z*TP);' +
             'm=Math.max(m,Math.abs(v-f.data[(z*16+y)*16+x]));} return m;})()');
check('8  preview field B matches the solver', pv < 1e-5, 'max diff ' + pv.toExponential(1));

console.log(all ? '\nALL PASS' : '\nSOME CHECKS FAILED');
process.exit(all ? 0 : 1);
