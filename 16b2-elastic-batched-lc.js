/* ============================================================
   F13LD.lab · 16b2-elastic-batched-lc.js   (Step 3a)
   Lockstep 6-load-case elastic homogenization.

   Runs all six Voigt load cases of ONE design in a single CG,
   in slot-major wide buffers, so the operator and reductions
   process all six at once.  Extends ElasticSolverFull.prototype
   ADDITIVELY — the serial _applyA / solveLoadCaseFull /
   homogenizeFull are untouched, so the nonlinear & buckling
   solvers that borrow ElasticSolverFull are unaffected.

   Load this AFTER 16b-elastic-solver-full.js.

   Slot layout
     CG state (eps,b,r,p,Ap,sig,tau)  width  6   slot = LC
     spectral (tauCmplx..depsC)       width 36   slot = LC*6 + Q
   The Green operator Γ and C0 are shared across the 6 LCs
   (single design), so gammaAccum reads the 6 component-slots of
   one LC and the shared Γ[P][·].

   Validation (browser console, after load):
     await runFullVoigtGPUTestBatched();   // batched vs serial vs CPU, N=16
   ============================================================ */

/* ---- batched WGSL kernels (slot-aware variants) ----------------------------
   All bounds come from a small BatchSize/Pidx uniform; per-slot scalars come
   from a tiny read-only storage buffer (dynamic slot indexing — the WGSL-clean
   alternative to a uniform array's 16-byte element stride). */

var BATCH_SIZE_STRUCT_WGSL =
'struct BatchSize { total: u32, voxels: u32, nslots: u32, _p: u32 }\n';

/* localStress, batched over LC.  solid is shared → indexed by voxel = i % voxels.
   C-data comes from the existing ElasticParamsFull uniform (its .total is ignored;
   the BatchSize uniform carries the dispatch bound). */
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
'  let isSolid = solid[i % BS.voxels] > 0.5;\n' +
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

/* tau = sig − C0:eps, batched over LC (pure elementwise on wide buffers). */
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

/* pack: tau (6-wide) → tauCmplx (36-wide).  slot = LC*6+Q; voxel = i % voxels. */
var PACK_BATCHED_WGSL = BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       tau_n:   array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       tau_s:   array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> out_cmpx:array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn pack_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= BS.total) { return; }\n' +              /* total = 36 * voxels */
'  let voxel = i % BS.voxels;\n' +
'  let slot  = i / BS.voxels;\n' +
'  let LC    = slot / 6u;\n' +
'  let Q     = slot % 6u;\n' +
'  let base  = LC * BS.voxels + voxel;\n' +
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

/* gammaAccum, batched over LC at fixed output row P (pidx).  One dispatch per P
   (6 total).  depsHat[LC*6+P] = Σ_Q Γ[P][Q]·tauHat[LC*6+Q].  16-storage budget
   lets all 6 Γ terms run in one kernel (no write/add split). */
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
'  if (j >= P.total) { return; }\n' +               /* total = 6 * voxels */
'  let LC    = j / P.voxels;\n' +
'  let voxel = j % P.voxels;\n' +
'  let row   = LC * 6u;\n' +
'  var acc = g0[voxel] * tauHat[(row + 0u) * P.voxels + voxel];\n' +
'  acc = acc + g1[voxel] * tauHat[(row + 1u) * P.voxels + voxel];\n' +
'  acc = acc + g2[voxel] * tauHat[(row + 2u) * P.voxels + voxel];\n' +
'  acc = acc + g3[voxel] * tauHat[(row + 3u) * P.voxels + voxel];\n' +
'  acc = acc + g4[voxel] * tauHat[(row + 4u) * P.voxels + voxel];\n' +
'  acc = acc + g5[voxel] * tauHat[(row + 5u) * P.voxels + voxel];\n' +
'  depsHat[(row + P.pidx) * P.voxels + voxel] = acc;\n' +
'}\n';

/* deAccum, batched over LC at fixed row P.  out.{n,s}[lane(P)] += Re(depsC[LC*6+P]).
   One dispatch per P writes a distinct lane → no cross-P race; seed out←eps first. */
var DEACCUM_BATCHED_WGSL =
'struct DP { total: u32, voxels: u32, pidx: u32, _p: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> out_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       deps_c: array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<uniform>             P: DP;\n' +
'@compute @workgroup_size(64)\n' +
'fn de_accum_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let j = gid.x;\n' +
'  if (j >= P.total) { return; }\n' +               /* total = 6 * voxels */
'  let LC    = j / P.voxels;\n' +
'  let voxel = j % P.voxels;\n' +
'  let dval  = deps_c[(LC * 6u + P.pidx) * P.voxels + voxel].x;\n' +
'  let base  = LC * P.voxels + voxel;\n' +
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

/* axpy (both n,s) with per-slot scalar: y += a[slot]·x.  scalar from storage. */
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

/* xbpy (both n,s) with per-slot scalar: y = x + b[slot]·y. */
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

/* dotReduce, slot-tagged: workgroup w handles LC = w/partialCount over that LC's
   voxels; partials[w] is that workgroup's partial.  CPU sums per LC afterward. */
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
'  let LC    = wg / P.partialCount;\n' +
'  let chunk = wg % P.partialCount;\n' +
'  let tid   = lid.x;\n' +
'  let voxel = chunk * 256u + tid;\n' +
'  var s: f32 = 0.0;\n' +
'  if (voxel < P.voxels) {\n' +
'    let base = LC * P.voxels + voxel;\n' +
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


/* ---- lazy resource allocation ---------------------------------------------- */
ElasticSolverFull.prototype._ensureBatchedResources = function() {
  if (this.B) { return; }
  var d = this.device;
  var BU = GPUBufferUsage;
  var N3 = this.N3;
  var NSLOT_CG = 6, NSLOT_SP = 36;
  var wideV = NSLOT_CG * this.v4Size;        /* 6 × (N³ vec4) */
  var wideC = NSLOT_SP * this.cmplxSize;     /* 36 × (N³ complex) */

  function vb() { return d.createBuffer({ size: wideV, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function cb() { return d.createBuffer({ size: wideC, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function pair() { return { n: vb(), s: vb() }; }
  function ub(bytes) { return d.createBuffer({ size: bytes, usage: BU.UNIFORM | BU.COPY_DST }); }

  var B = {};
  B.eps = pair(); B.b = pair(); B.r = pair(); B.p = pair(); B.Ap = pair();
  B.sig = pair(); B.tau = pair();
  B.tauCmplx = cb(); B.tauHat = cb(); B.depsHat = cb(); B.depsC = cb();

  B.fft = new FFTPlan(this.N, NSLOT_SP);    /* batch = 36 (validated primitive) */

  /* per-slot scalar storage (alpha / beta), 8 floats rewritten each iter */
  B.scalarBuf = d.createBuffer({ size: 32, usage: BU.STORAGE | BU.COPY_DST });

  /* partials: 6 LCs × partialCount, plus readback staging */
  B.partialCount = this.partialCount;
  var nPart = NSLOT_CG * B.partialCount;
  B.partials = d.createBuffer({ size: Math.max(nPart * 4, 256), usage: BU.STORAGE | BU.COPY_SRC });
  B.readback = d.createBuffer({ size: Math.max(nPart * 4, 256), usage: BU.COPY_DST | BU.MAP_READ });

  /* size uniforms */
  B.size6  = ub(16); d.queue.writeBuffer(B.size6,  0, new Uint32Array([NSLOT_CG * N3, N3, NSLOT_CG, 0]));
  B.size36 = ub(16); d.queue.writeBuffer(B.size36, 0, new Uint32Array([NSLOT_SP * N3, N3, NSLOT_SP, 0]));
  B.dotU   = ub(16); d.queue.writeBuffer(B.dotU,   0, new Uint32Array([N3, B.partialCount, 0, 0]));

  /* per-P uniforms for gammaAccum / deAccum (pidx baked, avoids per-dispatch writes) */
  B.gammaPU = []; B.deaccPU = [];
  for (var P = 0; P < 6; P++) {
    var gu = ub(16); d.queue.writeBuffer(gu, 0, new Uint32Array([NSLOT_CG * N3, N3, P, 0])); B.gammaPU.push(gu);
    var du = ub(16); d.queue.writeBuffer(du, 0, new Uint32Array([NSLOT_CG * N3, N3, P, 0])); B.deaccPU.push(du);
  }

  /* pipelines (layout:'auto') */
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

  /* constant identity eps_bar pattern (6 unit load cases) for the seed */
  var idN = new Float32Array(NSLOT_CG * N3 * 4);
  var idS = new Float32Array(NSLOT_CG * N3 * 4);
  for (var L = 0; L < 6; L++) {
    var off = L * N3 * 4;
    for (var v = 0; v < N3; v++) {
      var bidx = off + v * 4;
      if (L < 3) { idN[bidx + L] = 1.0; } else { idS[bidx + (L - 3)] = 1.0; }
    }
  }
  B.idN = idN; B.idS = idS;

  this.B = B;
};

/* seed eps = b = identity eps_bar pattern (the 6 unit load cases) */
ElasticSolverFull.prototype._seedBatched = function() {
  var d = this.device, B = this.B;
  d.queue.writeBuffer(B.eps.n, 0, B.idN); d.queue.writeBuffer(B.eps.s, 0, B.idS);
  d.queue.writeBuffer(B.b.n,   0, B.idN); d.queue.writeBuffer(B.b.s,   0, B.idS);
};

/* batched dot: returns Float64Array(6), one Σ((a·b)) per LC */
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
  pass.dispatchWorkgroups(6 * B.partialCount, 1, 1);
  pass.end();
  enc.copyBufferToBuffer(B.partials, 0, B.readback, 0, 6 * B.partialCount * 4);
  d.queue.submit([enc.finish()]);
  await B.readback.mapAsync(GPUMapMode.READ);
  var view = new Float32Array(B.readback.getMappedRange().slice(0));
  B.readback.unmap();
  var out = new Float64Array(6);
  for (var L = 0; L < 6; L++) {
    var s = 0;
    for (var k = 0; k < B.partialCount; k++) s += view[L * B.partialCount + k];
    out[L] = s;
  }
  return out;
};

ElasticSolverFull.prototype._copyB = function(enc, src, dst) {
  var V = 6 * this.v4Size;
  enc.copyBufferToBuffer(src.n, 0, dst.n, 0, V);
  enc.copyBufferToBuffer(src.s, 0, dst.s, 0, V);
};

/* axpy/xbpy: scalar6 is a length-6 (or 8) array uploaded to scalarBuf first */
ElasticSolverFull.prototype._axpyB = function(enc, scalar6, x, y) {
  var B = this.B;
  this.device.queue.writeBuffer(B.scalarBuf, 0, new Float32Array([scalar6[0], scalar6[1], scalar6[2], scalar6[3], scalar6[4], scalar6[5], 0, 0]));
  var bg = this.device.createBindGroup({ layout: B.axPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: x.n } }, { binding: 1, resource: { buffer: x.s } },
    { binding: 2, resource: { buffer: y.n } }, { binding: 3, resource: { buffer: y.s } },
    { binding: 4, resource: { buffer: B.scalarBuf } }, { binding: 5, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.axPipe, bg, 6 * this.N3, 64);
};
ElasticSolverFull.prototype._xbpyB = function(enc, scalar6, x, y) {
  var B = this.B;
  this.device.queue.writeBuffer(B.scalarBuf, 0, new Float32Array([scalar6[0], scalar6[1], scalar6[2], scalar6[3], scalar6[4], scalar6[5], 0, 0]));
  var bg = this.device.createBindGroup({ layout: B.xbPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: x.n } }, { binding: 1, resource: { buffer: x.s } },
    { binding: 2, resource: { buffer: y.n } }, { binding: 3, resource: { buffer: y.s } },
    { binding: 4, resource: { buffer: B.scalarBuf } }, { binding: 5, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.xbPipe, bg, 6 * this.N3, 64);
};

/* ---- batched operator: out = epsIn + Γ·(C(x):epsIn − C0:epsIn), all 6 LCs --- */
ElasticSolverFull.prototype._applyABatched = function(enc, epsIn, out) {
  var d = this.device, B = this.B;

  /* 1. localStress (6-wide) */
  var lsBg = d.createBindGroup({ layout: B.lsPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: this.solidBuf } },
    { binding: 1, resource: { buffer: epsIn.n } }, { binding: 2, resource: { buffer: epsIn.s } },
    { binding: 3, resource: { buffer: B.sig.n } }, { binding: 4, resource: { buffer: B.sig.s } },
    { binding: 5, resource: { buffer: this.elasticParamsBuf } }, { binding: 6, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.lsPipe, lsBg, 6 * this.N3, 64);

  /* 2. tau = sig − C0:eps (6-wide) */
  var tcBg = d.createBindGroup({ layout: B.tcPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: epsIn.n } }, { binding: 1, resource: { buffer: epsIn.s } },
    { binding: 2, resource: { buffer: B.sig.n } }, { binding: 3, resource: { buffer: B.sig.s } },
    { binding: 4, resource: { buffer: B.tau.n } }, { binding: 5, resource: { buffer: B.tau.s } },
    { binding: 6, resource: { buffer: this.elasticParamsBuf } }, { binding: 7, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(enc, B.tcPipe, tcBg, 6 * this.N3, 64);

  /* 3. pack 36 component-slots, one batched forward FFT */
  var pcBg = d.createBindGroup({ layout: B.pcPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: B.tau.n } }, { binding: 1, resource: { buffer: B.tau.s } },
    { binding: 2, resource: { buffer: B.tauCmplx } }, { binding: 3, resource: { buffer: B.size36 } }
  ]});
  this._dispatchEncoded(enc, B.pcPipe, pcBg, 36 * this.N3, 64);
  B.fft.loadFromBuffer(enc, B.tauCmplx);   /* whole 36-wide buffer == bufferSize */
  B.fft.forwardEncoded(enc);
  B.fft.storeToBuffer(enc, B.tauHat);

  /* 4. seed out ← epsIn, then Γ-accumulate each output row P over all LCs */
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
    this._dispatchEncoded(enc, B.gaPipe, gaBg, 6 * this.N3, 64);
  }

  /* 5. one batched inverse FFT, then deAccum each row into out lanes */
  B.fft.loadFromBuffer(enc, B.depsHat);
  B.fft.inverseEncoded(enc);
  B.fft.storeToBuffer(enc, B.depsC);
  for (var P2 = 0; P2 < 6; P2++) {
    var daBg = d.createBindGroup({ layout: B.daPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: out.n } }, { binding: 1, resource: { buffer: out.s } },
      { binding: 2, resource: { buffer: B.depsC } }, { binding: 3, resource: { buffer: B.deaccPU[P2] } }
    ]});
    this._dispatchEncoded(enc, B.daPipe, daBg, 6 * this.N3, 64);
  }
};

/* ---- lockstep 6-LC homogenization ------------------------------------------ */
ElasticSolverFull.prototype.homogenizeFullBatched = async function(opts) {
  opts = opts || {};
  var d = this.device;
  this._ensureBatchedResources();
  var B = this.B;
  var t0 = performance.now();

  /* seed eps = b = identity load cases */
  this._seedBatched();

  var bb = await this._dotB(B.b, B.b);
  var bNorm = new Float64Array(6);
  for (var L = 0; L < 6; L++) bNorm[L] = Math.sqrt(bb[L]) + 1e-30;

  /* r = b - A·eps ; p = r */
  var enc = d.createCommandEncoder();
  this._applyABatched(enc, B.eps, B.Ap);
  this._copyB(enc, B.b, B.r);
  d.queue.submit([enc.finish()]);
  var encR = d.createCommandEncoder();
  this._axpyB(encR, [-1, -1, -1, -1, -1, -1], B.Ap, B.r);   /* r -= Ap */
  d.queue.submit([encR.finish()]);
  var encP = d.createCommandEncoder();
  this._copyB(encP, B.r, B.p);
  d.queue.submit([encP.finish()]);

  var rr = await this._dotB(B.r, B.r);
  var live = [true, true, true, true, true, true];
  var iters = [0, 0, 0, 0, 0, 0];
  var converged = [false, false, false, false, false, false];
  var nLive = 6;

  var maxit = (typeof CG_MAXITER_FULL !== 'undefined') ? CG_MAXITER_FULL : 1000;
  var tol   = (typeof CG_TOL_FULL !== 'undefined') ? CG_TOL_FULL : 1e-4;
  var totalIters = 0;

  for (var it = 0; it < maxit && nLive > 0; it++) {
    totalIters = it + 1;

    var encA = d.createCommandEncoder();
    this._applyABatched(encA, B.p, B.Ap);
    d.queue.submit([encA.finish()]);

    var pAp = await this._dotB(B.p, B.Ap);
    var alpha = new Float64Array(6);
    for (var L1 = 0; L1 < 6; L1++) {
      alpha[L1] = (live[L1] && Math.abs(pAp[L1]) > 1e-30) ? (rr[L1] / pAp[L1]) : 0;
    }

    var encE = d.createCommandEncoder();
    this._axpyB(encE, alpha, B.p, B.eps);     /* eps += alpha·p */
    d.queue.submit([encE.finish()]);
    var negAlpha = [-alpha[0], -alpha[1], -alpha[2], -alpha[3], -alpha[4], -alpha[5]];
    var encRr = d.createCommandEncoder();
    this._axpyB(encRr, negAlpha, B.Ap, B.r);  /* r -= alpha·Ap */
    d.queue.submit([encRr.finish()]);

    var rrNew = await this._dotB(B.r, B.r);
    for (var L2 = 0; L2 < 6; L2++) {
      if (!live[L2]) continue;
      var relRes = Math.sqrt(rrNew[L2]) / bNorm[L2];
      if (relRes < tol) { live[L2] = false; converged[L2] = true; iters[L2] = it + 1; nLive--; }
    }
    if (nLive === 0) { for (var L3 = 0; L3 < 6; L3++) if (iters[L3] === 0) iters[L3] = it + 1; break; }

    var beta = new Float64Array(6);
    for (var L4 = 0; L4 < 6; L4++) beta[L4] = live[L4] ? (rrNew[L4] / rr[L4]) : 0;
    var encPp = d.createCommandEncoder();
    this._xbpyB(encPp, beta, B.r, B.p);       /* p = r + beta·p */
    d.queue.submit([encPp.finish()]);

    rr = rrNew;
  }
  for (var L5 = 0; L5 < 6; L5++) if (iters[L5] === 0) iters[L5] = totalIters;

  /* stress: sig = localStress(eps); volume-average per LC → C_eff columns */
  var encS = d.createCommandEncoder();
  var lsBg = d.createBindGroup({ layout: B.lsPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: this.solidBuf } },
    { binding: 1, resource: { buffer: B.eps.n } }, { binding: 2, resource: { buffer: B.eps.s } },
    { binding: 3, resource: { buffer: B.sig.n } }, { binding: 4, resource: { buffer: B.sig.s } },
    { binding: 5, resource: { buffer: this.elasticParamsBuf } }, { binding: 6, resource: { buffer: B.size6 } }
  ]});
  this._dispatchEncoded(encS, B.lsPipe, lsBg, 6 * this.N3, 64);
  var V = 6 * this.v4Size;
  var rbN = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var rbS = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encS.copyBufferToBuffer(B.sig.n, 0, rbN, 0, V);
  encS.copyBufferToBuffer(B.sig.s, 0, rbS, 0, V);
  d.queue.submit([encS.finish()]);
  await Promise.all([rbN.mapAsync(GPUMapMode.READ), rbS.mapAsync(GPUMapMode.READ)]);
  var aN = new Float32Array(rbN.getMappedRange().slice(0));
  var aS = new Float32Array(rbS.getMappedRange().slice(0));
  rbN.unmap(); rbS.unmap(); rbN.destroy(); rbS.destroy();

  var N3 = this.N3;
  var C_eff = new Float64Array(36);
  for (var LC = 0; LC < 6; LC++) {
    var sBar = [0, 0, 0, 0, 0, 0];
    var slotOff = LC * N3 * 4;
    for (var i = 0; i < N3; i++) {
      var bi = slotOff + i * 4;
      sBar[0] += aN[bi]; sBar[1] += aN[bi + 1]; sBar[2] += aN[bi + 2];
      sBar[3] += aS[bi]; sBar[4] += aS[bi + 1]; sBar[5] += aS[bi + 2];
    }
    for (var P3 = 0; P3 < 6; P3++) C_eff[P3 * 6 + LC] = sBar[P3] / N3;
  }

  /* symmetrise + invert + extract — identical to homogenizeFull */
  for (var P4 = 0; P4 < 6; P4++) {
    for (var Q4 = P4 + 1; Q4 < 6; Q4++) {
      var avg = 0.5 * (C_eff[P4 * 6 + Q4] + C_eff[Q4 * 6 + P4]);
      C_eff[P4 * 6 + Q4] = avg; C_eff[Q4 * 6 + P4] = avg;
    }
  }
  var S = invert6x6(C_eff);
  var voigtLabels = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  var perLC = [];
  var allConverged = true;
  for (var L6 = 0; L6 < 6; L6++) {
    perLC.push({ axis: voigtLabels[L6], iters: iters[L6], converged: converged[L6] });
    if (!converged[L6]) allConverged = false;
  }
  if (S === null) {
    return { valid: false, reject_reason: 'singular_C_eff', C_eff: C_eff, perLC: perLC,
             totalIters: totalIters, allConverged: allConverged, time: performance.now() - t0 };
  }
  return {
    valid: true,
    Ex: 1 / S[0], Ey: 1 / S[7], Ez: 1 / S[14],
    Gyz: 1 / S[21], Gxz: 1 / S[28], Gxy: 1 / S[35],
    C_eff: C_eff, perLC: perLC, totalIters: totalIters, allConverged: allConverged,
    time: performance.now() - t0
  };
};


/* ---- validation harness: batched vs serial vs CPU (Schwarz P, N=16) -------- */
async function runFullVoigtGPUTestBatched(N) {
  N = N || 16;
  if (!WGPU.device) await ensureDevice();
  var recipe = DEMO_RECIPES.schwarzP;

  /* batched */
  var fftB = (window.__sharedFFTBatched && window.__sharedFFTBatched.N === N && window.__sharedFFTBatched.batch === 6)
    ? window.__sharedFFTBatched : new FFTPlan(N, 6);
  if (!window.__sharedFFTBatched) window.__sharedFFTBatched = fftB;
  /* identical setup to solveDesignElasticFull */
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);
  var solid  = buildVoxels(family, params, args.offset, N, args.mode, args.wt,
                           args.nWeights, args.pipeR, args.phaseShift);
  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var Es = mat.Es_MPa, nu = mat.nu;
  var C_s = isoC(Es, nu);
  var C_v = isoC(Es * 1e-4, nu);
  var C_0 = isoC(Es, nu);
  var Gamma = buildGammaFull(N, C_0[21], C_0[1]);
  var solver = new ElasticSolverFull(N, fftB);
  solver.uploadDesign(solid, Gamma, C_s, C_v, C_0);

  var tb0 = performance.now();
  var homB = await solver.homogenizeFullBatched();
  var tBatched = performance.now() - tb0;

  /* serial reference (the validated path) */
  var ts0 = performance.now();
  var homS = await solver.homogenizeFull();
  var tSerial = performance.now() - ts0;

  function pct(a, b) { return (Math.abs(a - b) / Math.max(1e-12, Math.abs(b)) * 100); }
  var rows = [];
  var keys = ['Ex', 'Ey', 'Ez', 'Gyz', 'Gxz', 'Gxy'];
  var worst = 0;
  for (var k = 0; k < keys.length; k++) {
    var kk = keys[k];
    var dlt = pct(homB[kk], homS[kk]);
    if (dlt > worst) worst = dlt;
    rows.push({ modulus: kk, batched: homB[kk].toFixed(4), serial: homS[kk].toFixed(4), 'Δ%': dlt.toFixed(4) });
  }
  console.log('%c[3a] Batched 6-LC vs serial homogenizeFull · N=' + N, 'font-weight:bold');
  if (console.table) console.table(rows);
  console.log('  per-LC iters  batched:', homB.perLC.map(function (x) { return x.axis + ':' + x.iters; }).join(' '));
  console.log('  per-LC iters  serial :', homS.perLC.map(function (x) { return x.axis + ':' + x.iters; }).join(' '));
  console.log('  batched total iters: ' + homB.totalIters + '   serial total: ' + homS.totalIters);
  console.log('  time  batched: ' + tBatched.toFixed(1) + ' ms   serial: ' + tSerial.toFixed(1) + ' ms   (' + (tSerial / tBatched).toFixed(2) + '× )');
  console.log('%c  worst Δ = ' + worst.toFixed(4) + '%  ' + (worst < 0.05 ? '✓ PASS' : '✗ CHECK'),
              'font-weight:bold;color:' + (worst < 0.05 ? '#1D9E75' : '#cc3333'));
  return { ok: worst < 0.05, worst: worst, batched: homB, serial: homS };
}

if (typeof window !== 'undefined') {
  window.runFullVoigtGPUTestBatched = runFullVoigtGPUTestBatched;
}
