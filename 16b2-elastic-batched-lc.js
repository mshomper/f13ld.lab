/* ============================================================
   F13LD.lab · 16b2-elastic-batched-lc.js   (Step 3a + 3b)
   Lockstep batched elastic homogenization.

   3a: all six Voigt load cases of ONE design in a single CG.
   3b: D designs × 6 load cases in a single CG (shared reference
       material → shared Γ/C0), with a tiling fallback when the
       FFT batch (36·D) exceeds the device's grid / buffer limits.

   Extends ElasticSolverFull.prototype ADDITIVELY.  The serial
   _applyA / solveLoadCaseFull / homogenizeFull are untouched, so
   the nonlinear & buckling borrowers are unaffected.  Load AFTER
   16b-elastic-solver-full.js.

   Slot layout (tile of T designs)
     CG state (eps,b,r,p,Ap,sig,tau)  width  6T   slot = d*6 + LC
     spectral (tauCmplx..depsC)       width 36T   slot = d*36 + LC*6 + Q
   Note  (slot/6) of a spectral index = combined CG slot = d*6+LC,
   so pack/gammaAccum/deAccum/dot are byte-identical to 3a — only
   localStress changes (design-strided solid read, which collapses
   to the 3a single-solid read at T=1).  Γ, C0, Cs, Cv are shared
   across all 36T slots (single reference material).

   Validation (browser console, after load):
     await runFullVoigtGPUTestBatched();   // 3a regression: D=1, bit-exact
     await runMultiDesignGPUTest();        // 3b: 3 designs vs serial
   ============================================================ */

/* ---- batched WGSL kernels --------------------------------------------------
   Bounds come from a small BatchSize/Pidx uniform; per-slot scalars from a
   tiny read-only storage buffer (dynamic slot index).  All kernels are width-
   agnostic: the same body serves T=1 (3a) and T>1 (3b) — only the dispatch
   bound (carried in the uniform) changes.  localStress is the lone exception:
   it strides the solid by design. */

var BATCH_SIZE_STRUCT_WGSL =
'struct BatchSize { total: u32, voxels: u32, nslots: u32, _p: u32 }\n';

/* localStress, batched over (design, LC).  The combined CG slot is i/voxels;
   design = (i/voxels)/6.  solid is shared per design → indexed by
   design*voxels + voxel.  At T=1 design is always 0 → solid[voxel] (== 3a). */
var LOCAL_STRESS_BATCHED_WGSL = ELASTIC_PARAMS_FULL_WGSL + BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       solid: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       eps_n: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       eps_s: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> sig_n: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> sig_s: array<vec4<f32>>;\n' +
'@group(0) @binding(5) var<uniform>             P:  ElasticParamsFull;\n' +
'@group(0) @binding(6) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn local_stress_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= BS.total) { return; }\n' +
'  let voxel  = i % BS.voxels;\n' +
'  let design = (i / BS.voxels) / 6u;\n' +
'  let isSolid = solid[design * BS.voxels + voxel] > 0.5;\n' +
'  let en = eps_n[i].xyz;\n' +
'  let es = eps_s[i].xyz;\n' +
'  let r0n = select(P.Cv_r0n.xyz, P.Cs_r0n.xyz, isSolid);\n' +
'  let r0s = select(P.Cv_r0s.xyz, P.Cs_r0s.xyz, isSolid);\n' +
'  let r1n = select(P.Cv_r1n.xyz, P.Cs_r1n.xyz, isSolid);\n' +
'  let r1s = select(P.Cv_r1s.xyz, P.Cs_r1s.xyz, isSolid);\n' +
'  let r2n = select(P.Cv_r2n.xyz, P.Cs_r2n.xyz, isSolid);\n' +
'  let r2s = select(P.Cv_r2s.xyz, P.Cs_r2s.xyz, isSolid);\n' +
'  let r3n = select(P.Cv_r3n.xyz, P.Cs_r3n.xyz, isSolid);\n' +
'  let r3s = select(P.Cv_r3s.xyz, P.Cs_r3s.xyz, isSolid);\n' +
'  let r4n = select(P.Cv_r4n.xyz, P.Cs_r4n.xyz, isSolid);\n' +
'  let r4s = select(P.Cv_r4s.xyz, P.Cs_r4s.xyz, isSolid);\n' +
'  let r5n = select(P.Cv_r5n.xyz, P.Cs_r5n.xyz, isSolid);\n' +
'  let r5s = select(P.Cv_r5s.xyz, P.Cs_r5s.xyz, isSolid);\n' +
'  sig_n[i] = vec4<f32>(dot(r0n,en)+dot(r0s,es), dot(r1n,en)+dot(r1s,es), dot(r2n,en)+dot(r2s,es), 0.0);\n' +
'  sig_s[i] = vec4<f32>(dot(r3n,en)+dot(r3s,es), dot(r4n,en)+dot(r4s,es), dot(r5n,en)+dot(r5s,es), 0.0);\n' +
'}\n';

/* tau = sig − C0:eps (pure elementwise on wide buffers). */
var TAU_COMPUTE_BATCHED_WGSL = ELASTIC_PARAMS_FULL_WGSL + BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       eps_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       eps_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       sig_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       sig_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> tau_n: array<vec4<f32>>;\n' +
'@group(0) @binding(5) var<storage, read_write> tau_s: array<vec4<f32>>;\n' +
'@group(0) @binding(6) var<uniform>             P:  ElasticParamsFull;\n' +
'@group(0) @binding(7) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn tau_compute_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= BS.total) { return; }\n' +
'  let en = eps_n[i].xyz; let es = eps_s[i].xyz;\n' +
'  let sn = sig_n[i].xyz; let ss = sig_s[i].xyz;\n' +
'  tau_n[i] = vec4<f32>(sn.x-(dot(P.C0_r0n.xyz,en)+dot(P.C0_r0s.xyz,es)), sn.y-(dot(P.C0_r1n.xyz,en)+dot(P.C0_r1s.xyz,es)), sn.z-(dot(P.C0_r2n.xyz,en)+dot(P.C0_r2s.xyz,es)), 0.0);\n' +
'  tau_s[i] = vec4<f32>(ss.x-(dot(P.C0_r3n.xyz,en)+dot(P.C0_r3s.xyz,es)), ss.y-(dot(P.C0_r4n.xyz,en)+dot(P.C0_r4s.xyz,es)), ss.z-(dot(P.C0_r5n.xyz,en)+dot(P.C0_r5s.xyz,es)), 0.0);\n' +
'}\n';

/* pack: tau (6T-wide) → tauCmplx (36T-wide).  combined CG slot CS = (i/voxels)/6;
   Q = (i/voxels)%6; base = CS*voxels+voxel. */
var PACK_BATCHED_WGSL = BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       tau_n:   array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       tau_s:   array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> out_cmpx:array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn pack_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= BS.total) { return; }\n' +              /* total = 36T * voxels */
'  let voxel = i % BS.voxels;\n' +
'  let slot  = i / BS.voxels;\n' +                  /* spectral slot 0..36T-1 */
'  let CS    = slot / 6u;\n' +                      /* combined CG slot d*6+LC */
'  let Q     = slot % 6u;\n' +
'  let base  = CS * BS.voxels + voxel;\n' +
'  var x: f32 = 0.0;\n' +
'  if (Q < 3u) {\n' +
'    let v = tau_n[base];\n' +
'    if (Q == 0u) { x = v.x; } else if (Q == 1u) { x = v.y; } else { x = v.z; }\n' +
'  } else {\n' +
'    let v = tau_s[base]; let q2 = Q - 3u;\n' +
'    if (q2 == 0u) { x = v.x; } else if (q2 == 1u) { x = v.y; } else { x = v.z; }\n' +
'  }\n' +
'  out_cmpx[i] = vec2<f32>(x, 0.0);\n' +
'}\n';

/* gammaAccum, batched over combined CG slot at fixed output row P (6 dispatches).
   depsHat[CS*6+P] = Σ_Q Γ[P][Q]·tauHat[CS*6+Q].  Γ is shared (single material). */
var GAMMA_ACCUM_BATCHED_WGSL =
'struct GP { total: u32, voxels: u32, pidx: u32, _p: u32 }\n' +
'@group(0) @binding(0) var<storage, read> g0: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read> g1: array<f32>;\n' +
'@group(0) @binding(2) var<storage, read> g2: array<f32>;\n' +
'@group(0) @binding(3) var<storage, read> g3: array<f32>;\n' +
'@group(0) @binding(4) var<storage, read> g4: array<f32>;\n' +
'@group(0) @binding(5) var<storage, read> g5: array<f32>;\n' +
'@group(0) @binding(6) var<storage, read>       tauHat:  array<vec2<f32>>;\n' +
'@group(0) @binding(7) var<storage, read_write> depsHat: array<vec2<f32>>;\n' +
'@group(0) @binding(8) var<uniform>             P: GP;\n' +
'@compute @workgroup_size(64)\n' +
'fn gamma_accum_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let j = gid.x;\n' +
'  if (j >= P.total) { return; }\n' +               /* total = 6T * voxels */
'  let CS    = j / P.voxels;\n' +                    /* combined CG slot */
'  let voxel = j % P.voxels;\n' +
'  let row   = CS * 6u;\n' +
'  var acc = g0[voxel] * tauHat[(row + 0u) * P.voxels + voxel];\n' +
'  acc = acc + g1[voxel] * tauHat[(row + 1u) * P.voxels + voxel];\n' +
'  acc = acc + g2[voxel] * tauHat[(row + 2u) * P.voxels + voxel];\n' +
'  acc = acc + g3[voxel] * tauHat[(row + 3u) * P.voxels + voxel];\n' +
'  acc = acc + g4[voxel] * tauHat[(row + 4u) * P.voxels + voxel];\n' +
'  acc = acc + g5[voxel] * tauHat[(row + 5u) * P.voxels + voxel];\n' +
'  depsHat[(row + P.pidx) * P.voxels + voxel] = acc;\n' +
'}\n';

/* deAccum, batched over combined CG slot at fixed row P (6 dispatches).
   out.{n,s}[lane(P)] += Re(depsC[CS*6+P]).  Seed out←eps first. */
var DEACCUM_BATCHED_WGSL =
'struct DP { total: u32, voxels: u32, pidx: u32, _p: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> out_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       deps_c: array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<uniform>             P: DP;\n' +
'@compute @workgroup_size(64)\n' +
'fn de_accum_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let j = gid.x;\n' +
'  if (j >= P.total) { return; }\n' +
'  let CS    = j / P.voxels;\n' +
'  let voxel = j % P.voxels;\n' +
'  let dval  = deps_c[(CS * 6u + P.pidx) * P.voxels + voxel].x;\n' +
'  let base  = CS * P.voxels + voxel;\n' +
'  if (P.pidx < 3u) {\n' +
'    var o = out_n[base];\n' +
'    if (P.pidx == 0u) { o.x = o.x + dval; } else if (P.pidx == 1u) { o.y = o.y + dval; } else { o.z = o.z + dval; }\n' +
'    o.w = 0.0; out_n[base] = o;\n' +
'  } else {\n' +
'    var o = out_s[base]; let p2 = P.pidx - 3u;\n' +
'    if (p2 == 0u) { o.x = o.x + dval; } else if (p2 == 1u) { o.y = o.y + dval; } else { o.z = o.z + dval; }\n' +
'    o.w = 0.0; out_s[base] = o;\n' +
'  }\n' +
'}\n';

/* axpy (both n,s) with per-slot scalar: y += a[CS]·x.  scalar from storage. */
var AXPY_BATCHED_WGSL = BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       x_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       x_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> y_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> y_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read>       sc:  array<f32>;\n' +
'@group(0) @binding(5) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn axpy_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= BS.total) { return; }\n' +
'  let a = sc[i / BS.voxels];\n' +
'  y_n[i] = y_n[i] + a * x_n[i];\n' +
'  y_s[i] = y_s[i] + a * x_s[i];\n' +
'}\n';

/* xbpy (both n,s) with per-slot scalar: y = x + b[CS]·y. */
var XBPY_BATCHED_WGSL = BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       x_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       x_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> y_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> y_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read>       sc:  array<f32>;\n' +
'@group(0) @binding(5) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn xbpy_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= BS.total) { return; }\n' +
'  let b = sc[i / BS.voxels];\n' +
'  y_n[i] = x_n[i] + b * y_n[i];\n' +
'  y_s[i] = x_s[i] + b * y_s[i];\n' +
'}\n';

/* dotReduce, slot-tagged by combined CG slot: workgroup w handles CS = w/partialCount
   over that slot's voxels; partials[w] is that workgroup's partial.  CPU sums per CS. */
var DOT_REDUCE_BATCHED_WGSL =
'struct DB { voxels: u32, partialCount: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       a_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       a_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       b_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       b_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> partials: array<f32>;\n' +
'@group(0) @binding(5) var<uniform>             P: DB;\n' +
'var<workgroup> sdata: array<f32, 256>;\n' +
'@compute @workgroup_size(256)\n' +
'fn reduce_batched(@builtin(local_invocation_id) lid: vec3<u32>,\n' +
'                  @builtin(workgroup_id) wgid: vec3<u32>) {\n' +
'  let wg    = wgid.x;\n' +
'  let CS    = wg / P.partialCount;\n' +
'  let chunk = wg % P.partialCount;\n' +
'  let tid   = lid.x;\n' +
'  let voxel = chunk * 256u + tid;\n' +
'  var s: f32 = 0.0;\n' +
'  if (voxel < P.voxels) {\n' +
'    let base = CS * P.voxels + voxel;\n' +
'    s = dot(a_n[base].xyz, b_n[base].xyz) + dot(a_s[base].xyz, b_s[base].xyz);\n' +
'  }\n' +
'  sdata[tid] = s;\n' +
'  workgroupBarrier();\n' +
'  var stride: u32 = 128u;\n' +
'  loop {\n' +
'    if (tid < stride) { sdata[tid] = sdata[tid] + sdata[tid + stride]; }\n' +
'    workgroupBarrier();\n' +
'    if (stride == 1u) { break; }\n' +
'    stride = stride >> 1u;\n' +
'  }\n' +
'  if (tid == 0u) { partials[wg] = sdata[0]; }\n' +
'}\n';


/* ---- tile-size probe -------------------------------------------------------
   Largest T (≤D) whose batch-36T FFT fits the device: per-buffer byte limit
   AND the FFT's own 2D-grid constructor check (throwaway plan, destroyed). */
ElasticSolverFull.prototype._pickTileSize = function(D) {
  var N3 = this.N3;
  var lim = (this.device.limits && this.device.limits.maxStorageBufferBindingSize) || (128 * 1024 * 1024);
  for (var T = D; T >= 1; T--) {
    var bytes = 36 * T * N3 * 8;            /* one spectral / FFT ping-pong buffer */
    if (bytes > lim) continue;
    try {
      var probe = new FFTPlan(this.N, 36 * T);   /* throws if 2D grid exceeded */
      probe.destroy();
      return T;
    } catch (e) { /* grid limit at this T → try smaller */ }
  }
  return 1;                                  /* T=1 is always feasible (3a) */
};


/* ---- lazy resource allocation, cached per tile size T ---------------------- */
ElasticSolverFull.prototype._ensureBatchedResources = function(T) {
  T = T || 1;
  if (!this.Bcache) this.Bcache = {};
  if (this.Bcache[T]) { this.B = this.Bcache[T]; return; }

  var d = this.device, BU = GPUBufferUsage, N3 = this.N3;
  var nCG = 6 * T, nSP = 36 * T;
  var wideV = nCG * this.v4Size;          /* 6T × (N³ vec4) */
  var wideC = nSP * this.cmplxSize;       /* 36T × (N³ complex) */

  function vb() { return d.createBuffer({ size: wideV, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function cb() { return d.createBuffer({ size: wideC, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function pair() { return { n: vb(), s: vb() }; }
  function ub(bytes) { return d.createBuffer({ size: bytes, usage: BU.UNIFORM | BU.COPY_DST }); }

  var B = { T: T, nCG: nCG, nSP: nSP };
  B.eps = pair(); B.b = pair(); B.r = pair(); B.p = pair(); B.Ap = pair();
  B.sig = pair(); B.tau = pair();
  B.tauCmplx = cb(); B.tauHat = cb(); B.depsHat = cb(); B.depsC = cb();

  B.solidWide = d.createBuffer({ size: T * this.realSize, usage: BU.STORAGE | BU.COPY_DST });
  B.solid = B.solidWide;                  /* default handle; D=1 path repoints to solidBuf */

  B.fft = new FFTPlan(this.N, nSP);       /* batch = 36T */

  B.scalarFloats = Math.max(nCG, 8);
  B.scalarBuf = d.createBuffer({ size: B.scalarFloats * 4, usage: BU.STORAGE | BU.COPY_DST });

  B.partialCount = this.partialCount;
  var nPart = nCG * B.partialCount;
  B.partials = d.createBuffer({ size: Math.max(nPart * 4, 256), usage: BU.STORAGE | BU.COPY_SRC });
  B.readback = d.createBuffer({ size: Math.max(nPart * 4, 256), usage: BU.COPY_DST | BU.MAP_READ });

  B.size6  = ub(16); d.queue.writeBuffer(B.size6,  0, new Uint32Array([nCG * N3, N3, nCG, 0]));
  B.size36 = ub(16); d.queue.writeBuffer(B.size36, 0, new Uint32Array([nSP * N3, N3, nSP, 0]));
  B.dotU   = ub(16); d.queue.writeBuffer(B.dotU,   0, new Uint32Array([N3, B.partialCount, 0, 0]));

  B.gammaPU = []; B.deaccPU = [];
  for (var P = 0; P < 6; P++) {
    var gu = ub(16); d.queue.writeBuffer(gu, 0, new Uint32Array([nCG * N3, N3, P, 0])); B.gammaPU.push(gu);
    var du = ub(16); d.queue.writeBuffer(du, 0, new Uint32Array([nCG * N3, N3, P, 0])); B.deaccPU.push(du);
  }

  function pipe(code, entry) {
    return d.createComputePipeline({ layout: 'auto',
      compute: { module: d.createShaderModule({ code: code }), entryPoint: entry } });
  }
  B.lsPipe = pipe(LOCAL_STRESS_BATCHED_WGSL, 'local_stress_batched');
  B.tcPipe = pipe(TAU_COMPUTE_BATCHED_WGSL,  'tau_compute_batched');
  B.pcPipe = pipe(PACK_BATCHED_WGSL,         'pack_batched');
  B.gaPipe = pipe(GAMMA_ACCUM_BATCHED_WGSL,  'gamma_accum_batched');
  B.daPipe = pipe(DEACCUM_BATCHED_WGSL,      'de_accum_batched');
  B.axPipe = pipe(AXPY_BATCHED_WGSL,         'axpy_batched');
  B.xbPipe = pipe(XBPY_BATCHED_WGSL,         'xbpy_batched');
  B.drPipe = pipe(DOT_REDUCE_BATCHED_WGSL,   'reduce_batched');

  /* constant identity eps_bar pattern — the 6 unit load cases, tiled over T
     designs (eps_bar depends on LC only, not design). */
  var idN = new Float32Array(nCG * N3 * 4);
  var idS = new Float32Array(nCG * N3 * 4);
  for (var CS = 0; CS < nCG; CS++) {
    var LC = CS % 6, off = CS * N3 * 4;
    for (var v = 0; v < N3; v++) {
      var bidx = off + v * 4;
      if (LC < 3) { idN[bidx + LC] = 1.0; } else { idS[bidx + (LC - 3)] = 1.0; }
    }
  }
  B.idN = idN; B.idS = idS;

  this.Bcache[T] = B;
  this.B = B;
};

/* seed eps = b = identity load cases (current tile) */
ElasticSolverFull.prototype._seedBatched = function() {
  var d = this.device, B = this.B;
  d.queue.writeBuffer(B.eps.n, 0, B.idN); d.queue.writeBuffer(B.eps.s, 0, B.idS);
  d.queue.writeBuffer(B.b.n,   0, B.idN); d.queue.writeBuffer(B.b.s,   0, B.idS);
};

/* batched dot: Float64Array(nCG), one Σ((a·b)) per combined CG slot */
ElasticSolverFull.prototype._dotB = async function(a, b) {
  var d = this.device, B = this.B;
  var enc = d.createCommandEncoder();
  var bg = d.createBindGroup({ layout: B.drPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: a.n } }, { binding: 1, resource: { buffer: a.s } },
    { binding: 2, resource: { buffer: b.n } }, { binding: 3, resource: { buffer: b.s } },
    { binding: 4, resource: { buffer: B.partials } }, { binding: 5, resource: { buffer: B.dotU } }
  ]});
  var pass = enc.beginComputePass();
  pass.setPipeline(B.drPipe); pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(B.nCG * B.partialCount, 1, 1);
  pass.end();
  enc.copyBufferToBuffer(B.partials, 0, B.readback, 0, B.nCG * B.partialCount * 4);
  d.queue.submit([enc.finish()]);
  await B.readback.mapAsync(GPUMapMode.READ);
  var view = new Float32Array(B.readback.getMappedRange().slice(0));
  B.readback.unmap();
  var out = new Float64Array(B.nCG);
  for (var CS = 0; CS < B.nCG; CS++) {
    var s = 0;
    for (var k = 0; k < B.partialCount; k++) s += view[CS * B.partialCount + k];
    out[CS] = s;
  }
  return out;
};

ElasticSolverFull.prototype._copyB = function(enc, src, dst) {
  var V = this.B.nCG * this.v4Size;
  enc.copyBufferToBuffer(src.n, 0, dst.n, 0, V);
  enc.copyBufferToBuffer(src.s, 0, dst.s, 0, V);
};

ElasticSolverFull.prototype._writeScalarB = function(scalarArr) {
  var B = this.B;
  var sc = new Float32Array(B.scalarFloats);
  for (var i = 0; i < scalarArr.length && i < B.scalarFloats; i++) sc[i] = scalarArr[i];
  this.device.queue.writeBuffer(B.scalarBuf, 0, sc);
};

ElasticSolverFull.prototype._axpyB = function(enc, scalarArr, x, y) {
  var B = this.B;
  this._writeScalarB(scalarArr);
  var bg = this.device.createBindGroup({ layout: B.axPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: x.n } }, { binding: 1, resource: { buffer: x.s } },
    { binding: 2, resource: { buffer: y.n } }, { binding: 3, resource: { buffer: y.s } },
    { binding: 4, resource: { buffer: B.scalarBuf } }, { binding: 5, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.axPipe, bg, B.nCG * this.N3, 64);
};
ElasticSolverFull.prototype._xbpyB = function(enc, scalarArr, x, y) {
  var B = this.B;
  this._writeScalarB(scalarArr);
  var bg = this.device.createBindGroup({ layout: B.xbPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: x.n } }, { binding: 1, resource: { buffer: x.s } },
    { binding: 2, resource: { buffer: y.n } }, { binding: 3, resource: { buffer: y.s } },
    { binding: 4, resource: { buffer: B.scalarBuf } }, { binding: 5, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.xbPipe, bg, B.nCG * this.N3, 64);
};

/* ---- batched operator: out = epsIn + Γ·(C(x):epsIn − C0:epsIn), all 6T slots --- */
ElasticSolverFull.prototype._applyABatched = function(enc, epsIn, out) {
  var d = this.device, B = this.B;

  var lsBg = d.createBindGroup({ layout: B.lsPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: B.solid } },
    { binding: 1, resource: { buffer: epsIn.n } }, { binding: 2, resource: { buffer: epsIn.s } },
    { binding: 3, resource: { buffer: B.sig.n } }, { binding: 4, resource: { buffer: B.sig.s } },
    { binding: 5, resource: { buffer: this.elasticParamsBuf } }, { binding: 6, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.lsPipe, lsBg, B.nCG * this.N3, 64);

  var tcBg = d.createBindGroup({ layout: B.tcPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: epsIn.n } }, { binding: 1, resource: { buffer: epsIn.s } },
    { binding: 2, resource: { buffer: B.sig.n } }, { binding: 3, resource: { buffer: B.sig.s } },
    { binding: 4, resource: { buffer: B.tau.n } }, { binding: 5, resource: { buffer: B.tau.s } },
    { binding: 6, resource: { buffer: this.elasticParamsBuf } }, { binding: 7, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.tcPipe, tcBg, B.nCG * this.N3, 64);

  var pcBg = d.createBindGroup({ layout: B.pcPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: B.tau.n } }, { binding: 1, resource: { buffer: B.tau.s } },
    { binding: 2, resource: { buffer: B.tauCmplx } }, { binding: 3, resource: { buffer: B.size36 } }
  ]});
  this._dispatchEncoded(enc, B.pcPipe, pcBg, B.nSP * this.N3, 64);
  B.fft.loadFromBuffer(enc, B.tauCmplx);
  B.fft.forwardEncoded(enc);
  B.fft.storeToBuffer(enc, B.tauHat);

  this._copyB(enc, epsIn, out);
  for (var P = 0; P < 6; P++) {
    var g = this.gamma[P];
    var gaBg = d.createBindGroup({ layout: B.gaPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: g[0] } }, { binding: 1, resource: { buffer: g[1] } },
      { binding: 2, resource: { buffer: g[2] } }, { binding: 3, resource: { buffer: g[3] } },
      { binding: 4, resource: { buffer: g[4] } }, { binding: 5, resource: { buffer: g[5] } },
      { binding: 6, resource: { buffer: B.tauHat } }, { binding: 7, resource: { buffer: B.depsHat } },
      { binding: 8, resource: { buffer: B.gammaPU[P] } }
    ]});
    this._dispatchEncoded(enc, B.gaPipe, gaBg, B.nCG * this.N3, 64);
  }

  B.fft.loadFromBuffer(enc, B.depsHat);
  B.fft.inverseEncoded(enc);
  B.fft.storeToBuffer(enc, B.depsC);
  for (var P2 = 0; P2 < 6; P2++) {
    var daBg = d.createBindGroup({ layout: B.daPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: out.n } }, { binding: 1, resource: { buffer: out.s } },
      { binding: 2, resource: { buffer: B.depsC } }, { binding: 3, resource: { buffer: B.deaccPU[P2] } }
    ]});
    this._dispatchEncoded(enc, B.daPipe, daBg, B.nCG * this.N3, 64);
  }
};

/* ---- core lockstep CG over the current tile (this.B sized for T designs) ----
   Assumes resources ensured, B.solid set, design solids uploaded.  Returns
   { perDesign: [{C_eff, Ex..Gxy, perLC}], totalIters }. */
ElasticSolverFull.prototype._runLockstepTile = async function() {
  var d = this.device, B = this.B, nCG = B.nCG, N3 = this.N3;
  var ones = []; for (var z = 0; z < nCG; z++) ones.push(-1);

  this._seedBatched();
  var bb = await this._dotB(B.b, B.b);
  var bNorm = new Float64Array(nCG);
  for (var L = 0; L < nCG; L++) bNorm[L] = Math.sqrt(bb[L]) + 1e-30;

  var enc = d.createCommandEncoder();
  this._applyABatched(enc, B.eps, B.Ap);
  this._copyB(enc, B.b, B.r);
  d.queue.submit([enc.finish()]);
  var encR = d.createCommandEncoder();
  this._axpyB(encR, ones, B.Ap, B.r);          /* r = b - Ap */
  d.queue.submit([encR.finish()]);
  var encP = d.createCommandEncoder();
  this._copyB(encP, B.r, B.p);
  d.queue.submit([encP.finish()]);

  var rr = await this._dotB(B.r, B.r);
  var live = [], iters = [], converged = [];
  for (var q = 0; q < nCG; q++) { live.push(true); iters.push(0); converged.push(false); }
  var nLive = nCG;

  var maxit = (typeof CG_MAXITER_FULL !== 'undefined') ? CG_MAXITER_FULL : 1000;
  var tol   = (typeof CG_TOL_FULL !== 'undefined') ? CG_TOL_FULL : 1e-4;
  var totalIters = 0;

  for (var it = 0; it < maxit && nLive > 0; it++) {
    totalIters = it + 1;

    var encA = d.createCommandEncoder();
    this._applyABatched(encA, B.p, B.Ap);
    d.queue.submit([encA.finish()]);

    var pAp = await this._dotB(B.p, B.Ap);
    var alpha = new Float64Array(nCG);
    for (var L1 = 0; L1 < nCG; L1++)
      alpha[L1] = (live[L1] && Math.abs(pAp[L1]) > 1e-30) ? (rr[L1] / pAp[L1]) : 0;

    var encE = d.createCommandEncoder();
    this._axpyB(encE, Array.prototype.slice.call(alpha), B.p, B.eps);   /* eps += alpha·p */
    d.queue.submit([encE.finish()]);
    var negAlpha = []; for (var L1b = 0; L1b < nCG; L1b++) negAlpha.push(-alpha[L1b]);
    var encRr = d.createCommandEncoder();
    this._axpyB(encRr, negAlpha, B.Ap, B.r);                            /* r -= alpha·Ap */
    d.queue.submit([encRr.finish()]);

    var rrNew = await this._dotB(B.r, B.r);
    for (var L2 = 0; L2 < nCG; L2++) {
      if (!live[L2]) continue;
      if (Math.sqrt(rrNew[L2]) / bNorm[L2] < tol) { live[L2] = false; converged[L2] = true; iters[L2] = it + 1; nLive--; }
    }
    if (nLive === 0) { for (var L3 = 0; L3 < nCG; L3++) if (iters[L3] === 0) iters[L3] = it + 1; break; }

    var beta = []; for (var L4 = 0; L4 < nCG; L4++) beta.push(live[L4] ? (rrNew[L4] / rr[L4]) : 0);
    var encPp = d.createCommandEncoder();
    this._xbpyB(encPp, beta, B.r, B.p);                                 /* p = r + beta·p */
    d.queue.submit([encPp.finish()]);
    rr = rrNew;
  }
  for (var L5 = 0; L5 < nCG; L5++) if (iters[L5] === 0) iters[L5] = totalIters;

  /* stress: sig = localStress(eps); volume-average per combined slot */
  var encS = d.createCommandEncoder();
  var lsBg = d.createBindGroup({ layout: B.lsPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: B.solid } },
    { binding: 1, resource: { buffer: B.eps.n } }, { binding: 2, resource: { buffer: B.eps.s } },
    { binding: 3, resource: { buffer: B.sig.n } }, { binding: 4, resource: { buffer: B.sig.s } },
    { binding: 5, resource: { buffer: this.elasticParamsBuf } }, { binding: 6, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(encS, B.lsPipe, lsBg, B.nCG * this.N3, 64);
  var V = B.nCG * this.v4Size;
  var rbN = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var rbS = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encS.copyBufferToBuffer(B.sig.n, 0, rbN, 0, V);
  encS.copyBufferToBuffer(B.sig.s, 0, rbS, 0, V);
  d.queue.submit([encS.finish()]);
  await Promise.all([rbN.mapAsync(GPUMapMode.READ), rbS.mapAsync(GPUMapMode.READ)]);
  var aN = new Float32Array(rbN.getMappedRange().slice(0));
  var aS = new Float32Array(rbS.getMappedRange().slice(0));
  rbN.unmap(); rbS.unmap(); rbN.destroy(); rbS.destroy();

  var voigtLabels = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  var perDesign = [];
  for (var dgn = 0; dgn < B.T; dgn++) {
    var C_eff = new Float64Array(36);
    for (var LC = 0; LC < 6; LC++) {
      var CS = dgn * 6 + LC;
      var sBar = [0, 0, 0, 0, 0, 0];
      var slotOff = CS * N3 * 4;
      for (var i = 0; i < N3; i++) {
        var bi = slotOff + i * 4;
        sBar[0] += aN[bi]; sBar[1] += aN[bi + 1]; sBar[2] += aN[bi + 2];
        sBar[3] += aS[bi]; sBar[4] += aS[bi + 1]; sBar[5] += aS[bi + 2];
      }
      for (var P3 = 0; P3 < 6; P3++) C_eff[P3 * 6 + LC] = sBar[P3] / N3;
    }
    for (var P4 = 0; P4 < 6; P4++) for (var Q4 = P4 + 1; Q4 < 6; Q4++) {
      var avg = 0.5 * (C_eff[P4 * 6 + Q4] + C_eff[Q4 * 6 + P4]);
      C_eff[P4 * 6 + Q4] = avg; C_eff[Q4 * 6 + P4] = avg;
    }
    var S = invert6x6(C_eff);
    var perLC = [], allConv = true;
    for (var LL = 0; LL < 6; LL++) {
      var CSi = dgn * 6 + LL;
      perLC.push({ axis: voigtLabels[LL], iters: iters[CSi], converged: converged[CSi] });
      if (!converged[CSi]) allConv = false;
    }
    if (S === null) {
      perDesign.push({ valid: false, reject_reason: 'singular_C_eff', C_eff: C_eff, perLC: perLC, allConverged: allConv });
    } else {
      perDesign.push({
        valid: true,
        Ex: 1 / S[0], Ey: 1 / S[7], Ez: 1 / S[14],
        Gyz: 1 / S[21], Gxz: 1 / S[28], Gxy: 1 / S[35],
        C_eff: C_eff, perLC: perLC, allConverged: allConv
      });
    }
  }
  return { perDesign: perDesign, totalIters: totalIters };
};

/* ---- 3a entry: single design (D=1).  Bit-exact regression target. ---------- */
ElasticSolverFull.prototype.homogenizeFullBatched = async function(opts) {
  opts = opts || {};
  var t0 = performance.now();
  this._ensureBatchedResources(1);
  this.B.solid = this.solidBuf;            /* reuse the already-uploaded single design */
  var tile = await this._runLockstepTile();
  var r = tile.perDesign[0];
  r.totalIters = tile.totalIters;
  r.time = performance.now() - t0;
  return r;
};

/* ---- 3b entry: D designs, shared reference material, tiled ----------------- */
ElasticSolverFull.prototype.homogenizeFullBatchedMulti = async function(designGrids, opts) {
  opts = opts || {};
  var d = this.device, N3 = this.N3, D = designGrids.length;
  var t0 = performance.now();

  var T = (opts.forceTile && opts.forceTile >= 1) ? Math.min(opts.forceTile, D) : this._pickTileSize(D);

  var results = new Array(D);
  var totalIters = 0, tilesUsed = 0;

  for (var start = 0; start < D; start += T) {
    var g = Math.min(T, D - start);
    this._ensureBatchedResources(g);
    this.B.solid = this.B.solidWide;

    /* upload this tile's g solids contiguously into solidWide */
    var packed = new Float32Array(g * N3);
    for (var k = 0; k < g; k++) packed.set(designGrids[start + k], k * N3);
    d.queue.writeBuffer(this.B.solidWide, 0, packed);

    var tile = await this._runLockstepTile();
    for (var j = 0; j < g; j++) results[start + j] = tile.perDesign[j];
    totalIters += tile.totalIters;
    tilesUsed++;
  }

  return { perDesign: results, tileSize: T, tilesUsed: tilesUsed, totalIters: totalIters, time: performance.now() - t0 };
};


/* ---- harness 1: 3a regression (D=1, Schwarz P, N=16) — bit-exact ----------- */
async function runFullVoigtGPUTestBatched(N) {
  N = N || 16;
  if (!WGPU.device) await ensureDevice();
  var recipe = DEMO_RECIPES.schwarzP;

  var fftB6 = (window.__sharedFFTBatched && window.__sharedFFTBatched.N === N && window.__sharedFFTBatched.batch === 6)
    ? window.__sharedFFTBatched : new FFTPlan(N, 6);
  if (!window.__sharedFFTBatched) window.__sharedFFTBatched = fftB6;

  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);
  var solid  = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var C_s = isoC(mat.Es_MPa, mat.nu), C_v = isoC(mat.Es_MPa * 1e-4, mat.nu), C_0 = isoC(mat.Es_MPa, mat.nu);
  var Gamma = buildGammaFull(N, C_0[21], C_0[1]);
  var solver = new ElasticSolverFull(N, fftB6);
  solver.uploadDesign(solid, Gamma, C_s, C_v, C_0);

  var tb0 = performance.now();
  var homB = await solver.homogenizeFullBatched();
  var tBatched = performance.now() - tb0;
  var ts0 = performance.now();
  var homS = await solver.homogenizeFull();
  var tSerial = performance.now() - ts0;

  function pct(a, b) { return Math.abs(a - b) / Math.max(1e-12, Math.abs(b)) * 100; }
  var keys = ['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy'], rows = [], worst = 0;
  for (var k = 0; k < keys.length; k++) {
    var dlt = pct(homB[keys[k]], homS[keys[k]]); if (dlt > worst) worst = dlt;
    rows.push({ modulus: keys[k], batched: homB[keys[k]].toFixed(4), serial: homS[keys[k]].toFixed(4), 'Δ%': dlt.toFixed(4) });
  }
  console.log('%c[3a] Batched 6-LC vs serial · N=' + N, 'font-weight:bold');
  if (console.table) console.table(rows);
  console.log('  iters batched:', homB.perLC.map(function (x) { return x.axis + ':' + x.iters; }).join(' '));
  console.log('  iters serial :', homS.perLC.map(function (x) { return x.axis + ':' + x.iters; }).join(' '));
  console.log('  time  batched: ' + tBatched.toFixed(1) + ' ms   serial: ' + tSerial.toFixed(1) + ' ms   (' + (tSerial / tBatched).toFixed(2) + '×)');
  console.log('%c  worst Δ = ' + worst.toFixed(4) + '%  ' + (worst < 0.05 ? '✓ PASS' : '✗ CHECK'),
              'font-weight:bold;color:' + (worst < 0.05 ? '#1D9E75' : '#cc3333'));
  return { ok: worst < 0.05, worst: worst };
}

/* ---- harness 2: 3b multi-design (3 distinct geometries, shared material) ---- */
async function runMultiDesignGPUTest(N, opts) {
  N = N || 16; opts = opts || {};
  if (!WGPU.device) await ensureDevice();
  var recipeKeys = ['schwarzP', 'spinodoid', 'hyperuniform'];
  var recipes = recipeKeys.map(function (k) { return DEMO_RECIPES[k]; });

  /* shared reference material (use the first recipe's material for all) */
  var mat = recipes[0].material || { Es_MPa: 110000, nu: 0.34 };
  var C_s = isoC(mat.Es_MPa, mat.nu), C_v = isoC(mat.Es_MPa * 1e-4, mat.nu), C_0 = isoC(mat.Es_MPa, mat.nu);
  var Gamma = buildGammaFull(N, C_0[21], C_0[1]);

  var solids = recipes.map(function (recipe) {
    var family = recipe.family;
    var params = KERNELS[family].parseRecipe(recipe);
    var args   = resolveBuildArgs(recipe);
    return buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  });

  var fftB6 = (window.__sharedFFTBatched && window.__sharedFFTBatched.N === N && window.__sharedFFTBatched.batch === 6)
    ? window.__sharedFFTBatched : new FFTPlan(N, 6);
  if (!window.__sharedFFTBatched) window.__sharedFFTBatched = fftB6;

  var solver = new ElasticSolverFull(N, fftB6);
  solver.uploadDesign(solids[0], Gamma, C_s, C_v, C_0);   /* placeholder solid; multi overwrites */

  var tm0 = performance.now();
  var homM = await solver.homogenizeFullBatchedMulti(solids, { forceTile: opts.forceTile });
  var tMulti = performance.now() - tm0;

  /* serial per-design reference (same shared material) */
  var serialResults = [], tSerial = 0;
  for (var dgn = 0; dgn < solids.length; dgn++) {
    solver.uploadDesign(solids[dgn], Gamma, C_s, C_v, C_0);
    var ts = performance.now();
    serialResults.push(await solver.homogenizeFull());
    tSerial += performance.now() - ts;
  }

  function pct(a, b) { return Math.abs(a - b) / Math.max(1e-12, Math.abs(b)) * 100; }
  var keys = ['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy'], rows = [], worst = 0;
  for (var i = 0; i < solids.length; i++) {
    var mD = homM.perDesign[i], sD = serialResults[i], wd = 0;
    for (var k = 0; k < keys.length; k++) { var x = pct(mD[keys[k]], sD[keys[k]]); if (x > wd) wd = x; }
    if (wd > worst) worst = wd;
    rows.push({ design: recipeKeys[i], Ex: mD.Ex.toFixed(1), Gxy: mD.Gxy.toFixed(1),
                iters: mD.perLC.map(function (z) { return z.iters; }).join('/'), 'worstΔ%': wd.toFixed(4) });
  }
  console.log('%c[3b] Multi-design vs serial · N=' + N + '  ·  tile=' + homM.tileSize + ' (' + homM.tilesUsed + ' tile(s))', 'font-weight:bold');
  if (console.table) console.table(rows);
  console.log('  time  multi: ' + tMulti.toFixed(1) + ' ms   serial(3×6 LC): ' + tSerial.toFixed(1) + ' ms   (' + (tSerial / tMulti).toFixed(2) + '×)');
  console.log('%c  worst Δ = ' + worst.toFixed(4) + '%  ' + (worst < 0.05 ? '✓ PASS' : '✗ CHECK'),
              'font-weight:bold;color:' + (worst < 0.05 ? '#1D9E75' : '#cc3333'));
  return { ok: worst < 0.05, worst: worst, multi: homM };
}

if (typeof window !== 'undefined') {
  window.runFullVoigtGPUTestBatched = runFullVoigtGPUTestBatched;
  window.runMultiDesignGPUTest = runMultiDesignGPUTest;
}
