/* ============================================================
   F13LD.lab · 16b-elastic-solver-full.js

   GPU full Voigt 6×6 elastic FFT-CG solver.

   Parallel to 16-elastic-solver.js (which is the production
   normal-only solver feeding the Geometry/Deformed/Stress tabs).
   This file adds the full Voigt path for the "Stiffness ⊕" tab
   without touching the existing rc3 solver.

   ── Validation oracle ───────────────────────────────────
   Push 2's homogenizeFullCPU in 16a-elastic-cpu-ref-full.js
   is the bit-exact reference.  The GPU code here must reproduce
   the CPU's Ex/Ey/Ez and Gxy/Gxz/Gyz at N=16 on Schwarz P to
   within ~1% (float32 vs float64 + GPU FFT accumulation).
   runFullVoigtGPUTest() automates that cross-check.

   ── vec4 packing strategy ───────────────────────────────
   Each 6-component field (eps, sig, tau, b, r, p, Ap, …) is
   stored as two array<vec4<f32>> buffers:
     _n: [xx, yy, zz, _]   normal triplet, .w padding
     _s: [yz, xz, xy, _]   shear triplet, .w padding

   This keeps every kernel at ≤8 storage bindings (the WebGPU
   portable floor).  Memory cost: 25% padding waste in the .w
   lane vs 6 packed scalars, but portable across integrated GPUs.

   ── Coordinate convention (carried from existing solver) ─
   buildGamma labels stride-N² as "X" but the rasterizer stores
   physical Z at stride N².  The existing 16-elastic-solver.js
   handles this with an X↔Z relabeling at solveDesignElastic.
   Same pattern here, extended to shear:
     LC 0  ↔  LC 2   (xx ↔ zz)
     LC 1  ↔  LC 1   (yy unchanged)
     LC 2  ↔  LC 0
     LC 3  ↔  LC 5   (yz ↔ xy)
     LC 4  ↔  LC 4   (xz unchanged)
     LC 5  ↔  LC 3
   Schwarz P has cubic symmetry so the swap is invisible there;
   it matters once we hit orthotropic structures (spinodoid etc).

   ── External dependencies (resolved at call time) ───────
   - WGPU.device, ensureDevice  (11-webgpu-device.js)
   - FFTPlan                    (12-fft-plan.js)
   - KERNELS                    (13-kernels.js)
   - isoC, buildVoxels,
     resolveBuildArgs           (14-rasterizer.js)
   - buildGammaFull, invert6x6,
     homogenizeFullCPU          (16a-elastic-cpu-ref-full.js,
                                 for cross-validation harness)
   - DEMO_RECIPES               (15-demo-recipes.js)
   ============================================================ */


/* Mirrors 16-elastic-solver.js's rc3 tuning */
var CG_TOL_FULL     = 1e-4;
var CG_MAXITER_FULL = 300;


/* ════════════════════════════════════════════════════════════
   WGSL kernel sources
   ════════════════════════════════════════════════════════════ */

/* ElasticParamsFull — full Voigt 6×6 stiffness for 3 materials
   (Cs solid, Cv void, C0 reference), laid out as 36 vec4 +
   trailing u32 total + padding.

   Each material has 6 rows × 2 vec4 = 12 vec4 = 192 bytes.
   3 materials = 36 vec4 = 576 bytes.
   Trailer: 4 u32 = 16 bytes.
   Total: 592 bytes (well under the 64KB uniform-buffer limit).

   Row P of C is stored as two vec4 (C_X_rowP_n, C_X_rowP_s)
   where _n = [CP0, CP1, CP2, _] (normal columns) and
         _s = [CP3, CP4, CP5, _] (shear columns).
   .w padding lane is always zero. */
var ELASTIC_PARAMS_FULL_WGSL =
'struct ElasticParamsFull {\n' +
'  Cs_r0n: vec4<f32>, Cs_r0s: vec4<f32>,\n' +
'  Cs_r1n: vec4<f32>, Cs_r1s: vec4<f32>,\n' +
'  Cs_r2n: vec4<f32>, Cs_r2s: vec4<f32>,\n' +
'  Cs_r3n: vec4<f32>, Cs_r3s: vec4<f32>,\n' +
'  Cs_r4n: vec4<f32>, Cs_r4s: vec4<f32>,\n' +
'  Cs_r5n: vec4<f32>, Cs_r5s: vec4<f32>,\n' +
'  Cv_r0n: vec4<f32>, Cv_r0s: vec4<f32>,\n' +
'  Cv_r1n: vec4<f32>, Cv_r1s: vec4<f32>,\n' +
'  Cv_r2n: vec4<f32>, Cv_r2s: vec4<f32>,\n' +
'  Cv_r3n: vec4<f32>, Cv_r3s: vec4<f32>,\n' +
'  Cv_r4n: vec4<f32>, Cv_r4s: vec4<f32>,\n' +
'  Cv_r5n: vec4<f32>, Cv_r5s: vec4<f32>,\n' +
'  C0_r0n: vec4<f32>, C0_r0s: vec4<f32>,\n' +
'  C0_r1n: vec4<f32>, C0_r1s: vec4<f32>,\n' +
'  C0_r2n: vec4<f32>, C0_r2s: vec4<f32>,\n' +
'  C0_r3n: vec4<f32>, C0_r3s: vec4<f32>,\n' +
'  C0_r4n: vec4<f32>, C0_r4s: vec4<f32>,\n' +
'  C0_r5n: vec4<f32>, C0_r5s: vec4<f32>,\n' +
'  total: u32, _p0: u32, _p1: u32, _p2: u32\n' +
'}\n';


/* localStressFull: sig = C(x):eps with full 6×6 multiply.
   Each output row P consumes one (Cn, Cs) pair from the uniform
   and produces one f32 (one component of sig_n or sig_s). */
var LOCAL_STRESS_FULL_WGSL = ELASTIC_PARAMS_FULL_WGSL +
'@group(0) @binding(0) var<storage, read>       solid: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       eps_n: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       eps_s: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> sig_n: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> sig_s: array<vec4<f32>>;\n' +
'@group(0) @binding(5) var<uniform>             P: ElasticParamsFull;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn local_stress_full(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let isSolid = solid[i] > 0.5;\n' +
'  let en = eps_n[i].xyz;\n' +
'  let es = eps_s[i].xyz;\n' +
'\n' +
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
'\n' +
'  sig_n[i] = vec4<f32>(\n' +
'    dot(r0n, en) + dot(r0s, es),\n' +
'    dot(r1n, en) + dot(r1s, es),\n' +
'    dot(r2n, en) + dot(r2s, es),\n' +
'    0.0);\n' +
'  sig_s[i] = vec4<f32>(\n' +
'    dot(r3n, en) + dot(r3s, es),\n' +
'    dot(r4n, en) + dot(r4s, es),\n' +
'    dot(r5n, en) + dot(r5s, es),\n' +
'    0.0);\n' +
'}\n';


/* tauComputeFull: tau = sig − C0:eps  (polarization stress) */
var TAU_COMPUTE_FULL_WGSL = ELASTIC_PARAMS_FULL_WGSL +
'@group(0) @binding(0) var<storage, read>       eps_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       eps_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       sig_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       sig_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> tau_n: array<vec4<f32>>;\n' +
'@group(0) @binding(5) var<storage, read_write> tau_s: array<vec4<f32>>;\n' +
'@group(0) @binding(6) var<uniform>             P: ElasticParamsFull;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn tau_compute_full(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let en = eps_n[i].xyz;\n' +
'  let es = eps_s[i].xyz;\n' +
'  let sn = sig_n[i].xyz;\n' +
'  let ss = sig_s[i].xyz;\n' +
'  tau_n[i] = vec4<f32>(\n' +
'    sn.x - (dot(P.C0_r0n.xyz, en) + dot(P.C0_r0s.xyz, es)),\n' +
'    sn.y - (dot(P.C0_r1n.xyz, en) + dot(P.C0_r1s.xyz, es)),\n' +
'    sn.z - (dot(P.C0_r2n.xyz, en) + dot(P.C0_r2s.xyz, es)),\n' +
'    0.0);\n' +
'  tau_s[i] = vec4<f32>(\n' +
'    ss.x - (dot(P.C0_r3n.xyz, en) + dot(P.C0_r3s.xyz, es)),\n' +
'    ss.y - (dot(P.C0_r4n.xyz, en) + dot(P.C0_r4s.xyz, es)),\n' +
'    ss.z - (dot(P.C0_r5n.xyz, en) + dot(P.C0_r5s.xyz, es)),\n' +
'    0.0);\n' +
'}\n';


/* packComplexLane: extract one component (lane 0,1,2) from a
   vec4 buffer and pack it as complex (im=0) for FFT input.
   Used once per Voigt component (6×) per applyA. */
var PACK_COMPLEX_LANE_WGSL =
'struct LaneParams { total: u32, lane: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       in_v4:    array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_cmpx: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: LaneParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn pack_complex_lane(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let v = in_v4[i];\n' +
'  var x: f32;\n' +
'  switch (P.lane) {\n' +
'    case 0u: { x = v.x; }\n' +
'    case 1u: { x = v.y; }\n' +
'    case 2u: { x = v.z; }\n' +
'    default: { x = 0.0; }\n' +
'  }\n' +
'  out_cmpx[i] = vec2<f32>(x, 0.0);\n' +
'}\n';


/* gammaAccumFullWrite: out_h = g0·tH_a + g1·tH_b + g2·tH_c
   First half of one Γ-row · τ̂ multiply.  Three of the six
   τ̂ components combine into the output spectral row.
   (Sub-dispatched to keep the bind count under 8 storage.) */
var GAMMA_ACCUM_FULL_WRITE_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       th_a:  array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       th_b:  array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       th_c:  array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       g_a:   array<f32>;\n' +
'@group(0) @binding(4) var<storage, read>       g_b:   array<f32>;\n' +
'@group(0) @binding(5) var<storage, read>       g_c:   array<f32>;\n' +
'@group(0) @binding(6) var<storage, read_write> out_h: array<vec2<f32>>;\n' +
'@group(0) @binding(7) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn gamma_accum_full_write(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  out_h[i] = g_a[i] * th_a[i] + g_b[i] * th_b[i] + g_c[i] * th_c[i];\n' +
'}\n';


/* gammaAccumFullAdd: out_h += g0·tH_a + g1·tH_b + g2·tH_c
   Second half — accumulates onto out_h from the write pass. */
var GAMMA_ACCUM_FULL_ADD_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       th_a:  array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       th_b:  array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       th_c:  array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       g_a:   array<f32>;\n' +
'@group(0) @binding(4) var<storage, read>       g_b:   array<f32>;\n' +
'@group(0) @binding(5) var<storage, read>       g_c:   array<f32>;\n' +
'@group(0) @binding(6) var<storage, read_write> out_h: array<vec2<f32>>;\n' +
'@group(0) @binding(7) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn gamma_accum_full_add(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  out_h[i] = out_h[i] + g_a[i] * th_a[i] + g_b[i] * th_b[i] + g_c[i] * th_c[i];\n' +
'}\n';


/* deAccumLane: out_v4[i].lane += Re(deps_c[i])
   Read-modify-write on out_v4 so successive row dispatches don't
   clobber each other's lane writes.  Caller must seed out ← eps
   once before the per-row loop. */
var DEACCUM_LANE_WGSL =
'struct LaneParams { total: u32, lane: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> out_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       deps_c: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: LaneParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn de_accum_lane(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  var o = out_v4[i];\n' +
'  let d = deps_c[i].x;\n' +
'  switch (P.lane) {\n' +
'    case 0u: { o.x = o.x + d; }\n' +
'    case 1u: { o.y = o.y + d; }\n' +
'    case 2u: { o.z = o.z + d; }\n' +
'    default: { /* no-op */ }\n' +
'  }\n' +
'  o.w = 0.0;\n' +
'  out_v4[i] = o;\n' +
'}\n';


/* axpyPair: (y_n, y_s) += alpha · (x_n, x_s) — vec4-packed. */
var AXPY_PAIR_WGSL =
'struct AxpyParams { alpha: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> y_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: AxpyParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn axpy_pair(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y_v4[i] = y_v4[i] + P.alpha * x_v4[i];\n' +
'}\n';


/* xbpyPair: (y_n, y_s) = (x_n, x_s) + beta · (y_n, y_s) — packed. */
var XBPY_PAIR_WGSL =
'struct AxpyParams { alpha: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> y_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: AxpyParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn xbpy_pair(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y_v4[i] = x_v4[i] + P.alpha * y_v4[i];\n' +
'}\n';


/* fillPair: fill one vec4-packed field's three Voigt components
   from a 3-vector value.  .w lane always set to 0. */
var FILL_PAIR_WGSL =
'struct FillParams { v0: f32, v1: f32, v2: f32, total_u32_bits: f32, total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> out_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<uniform>             P: FillParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn fill_pair(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  out_v4[i] = vec4<f32>(P.v0, P.v1, P.v2, 0.0);\n' +
'}\n';


/* dotReducePair: Σ ((a_n·b_n) + (a_s·b_s)) over all voxels,
   ignoring .w lanes.  Tree reduction in shared memory; 256
   threads per workgroup, one partial per workgroup. */
var DOT_REDUCE_PAIR_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       a_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       a_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       b_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       b_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> partials: array<f32>;\n' +
'@group(0) @binding(5) var<uniform>             P: SizeParams;\n' +
'\n' +
'var<workgroup> sdata: array<f32, 256>;\n' +
'\n' +
'@compute @workgroup_size(256)\n' +
'fn reduce_pair(@builtin(global_invocation_id) gid: vec3<u32>,\n' +
'               @builtin(local_invocation_id) lid: vec3<u32>,\n' +
'               @builtin(workgroup_id) wgid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  let tid = lid.x;\n' +
'  var s: f32 = 0.0;\n' +
'  if (i < P.total) {\n' +
'    let an = a_n[i].xyz;\n' +
'    let as_ = a_s[i].xyz;\n' +
'    let bn = b_n[i].xyz;\n' +
'    let bs = b_s[i].xyz;\n' +
'    s = dot(an, bn) + dot(as_, bs);\n' +
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
'  if (tid == 0u) { partials[wgid.x] = sdata[0]; }\n' +
'}\n';


/* ════════════════════════════════════════════════════════════
   ElasticSolverFull — GPU full Voigt 6×6 solver class.
   Mirrors ElasticSolver in 16-elastic-solver.js but with
   vec4-packed 6-component buffers and the 4-pass applyA pipeline.
   ════════════════════════════════════════════════════════════ */

function ElasticSolverFull(N, fftPlan) {
  this.N = N;
  this.N3 = N * N * N;
  this.v4Size = 16 * this.N3;        /* vec4<f32> per voxel */
  this.realSize = 4 * this.N3;        /* scalar f32 per voxel (Γ buffers) */
  this.cmplxSize = 8 * this.N3;       /* vec2<f32> per voxel (FFT complex) */
  this.fft = fftPlan;
  this.device = WGPU.device;
  if (!this.device) throw new Error('ElasticSolverFull: WebGPU device not initialized');
  if (this.fft.N !== N) throw new Error('ElasticSolverFull: FFT plan size mismatch');

  this.WG_SIZE_REDUCE = 256;
  this.partialCount   = Math.ceil(this.N3 / this.WG_SIZE_REDUCE);

  this._buildPipelines();
  this._allocateBuffers();
  this._allocateUniforms();
}


/* ── Pipeline construction ───────────────────────────────────────── */
ElasticSolverFull.prototype._buildPipelines = function() {
  var d = this.device;
  function ro(b)  { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }; }
  function rw(b)  { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }; }
  function uni(b) { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }; }

  /* localStressFull — 1 solid + 2 eps + 2 sig + uniform = 5 storage */
  this.lsLayout = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), rw(3), rw(4), uni(5)] });
  this.lsPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.lsLayout] }),
    compute: { module: d.createShaderModule({ code: LOCAL_STRESS_FULL_WGSL }), entryPoint: 'local_stress_full' }
  });

  /* tauComputeFull — 2 eps + 2 sig + 2 tau + uniform = 6 storage */
  this.tcLayout = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), ro(3), rw(4), rw(5), uni(6)] });
  this.tcPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.tcLayout] }),
    compute: { module: d.createShaderModule({ code: TAU_COMPUTE_FULL_WGSL }), entryPoint: 'tau_compute_full' }
  });

  /* packComplexLane — 1 ro + 1 rw + 1 uni */
  this.pcLayout = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.pcPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.pcLayout] }),
    compute: { module: d.createShaderModule({ code: PACK_COMPLEX_LANE_WGSL }), entryPoint: 'pack_complex_lane' }
  });

  /* gammaAccumFullWrite / gammaAccumFullAdd — 6 ro + 1 rw + 1 uni = 7 storage */
  this.gaLayout = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), ro(3), ro(4), ro(5), rw(6), uni(7)] });
  this.gaWritePipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.gaLayout] }),
    compute: { module: d.createShaderModule({ code: GAMMA_ACCUM_FULL_WRITE_WGSL }), entryPoint: 'gamma_accum_full_write' }
  });
  this.gaAddPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.gaLayout] }),
    compute: { module: d.createShaderModule({ code: GAMMA_ACCUM_FULL_ADD_WGSL }), entryPoint: 'gamma_accum_full_add' }
  });

  /* deAccumLane — 1 rw + 1 ro + 1 uni (read-modify-write on out_v4) */
  this.daLayout = d.createBindGroupLayout({ entries: [rw(0), ro(1), uni(2)] });
  this.daPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.daLayout] }),
    compute: { module: d.createShaderModule({ code: DEACCUM_LANE_WGSL }), entryPoint: 'de_accum_lane' }
  });

  /* axpyPair / xbpyPair — 1 ro + 1 rw + 1 uni (shared layout) */
  this.axLayout = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.axPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.axLayout] }),
    compute: { module: d.createShaderModule({ code: AXPY_PAIR_WGSL }), entryPoint: 'axpy_pair' }
  });
  this.xbpyPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.axLayout] }),
    compute: { module: d.createShaderModule({ code: XBPY_PAIR_WGSL }), entryPoint: 'xbpy_pair' }
  });

  /* fillPair — 1 rw + 1 uni */
  this.fillLayout = d.createBindGroupLayout({ entries: [rw(0), uni(1)] });
  this.fillPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.fillLayout] }),
    compute: { module: d.createShaderModule({ code: FILL_PAIR_WGSL }), entryPoint: 'fill_pair' }
  });

  /* dotReducePair — 4 ro + 1 rw + 1 uni = 5 storage */
  this.drLayout = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), ro(3), rw(4), uni(5)] });
  this.drPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.drLayout] }),
    compute: { module: d.createShaderModule({ code: DOT_REDUCE_PAIR_WGSL }), entryPoint: 'reduce_pair' }
  });
};


/* ── Buffer allocation ────────────────────────────────────────── */
ElasticSolverFull.prototype._allocateBuffers = function() {
  var d = this.device;
  var BU = GPUBufferUsage;
  var V = this.v4Size, R = this.realSize, C = this.cmplxSize;

  function v4buf() { return d.createBuffer({ size: V, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function rbuf()  { return d.createBuffer({ size: R, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function cbuf()  { return d.createBuffer({ size: C, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }

  /* Solid mask (uploaded per design) */
  this.solidBuf = rbuf();

  /* CG state — each field is { n, s } pair of vec4 buffers */
  this.eps    = { n: v4buf(), s: v4buf() };
  this.b      = { n: v4buf(), s: v4buf() };
  this.r      = { n: v4buf(), s: v4buf() };
  this.p      = { n: v4buf(), s: v4buf() };
  this.Ap     = { n: v4buf(), s: v4buf() };

  /* applyA scratch */
  this.sig    = { n: v4buf(), s: v4buf() };
  this.tau    = { n: v4buf(), s: v4buf() };

  /* Spectral scratch — 6 complex buffers per slot (one per Voigt component) */
  this.tauCmplx = [cbuf(), cbuf(), cbuf(), cbuf(), cbuf(), cbuf()];
  this.tauHat   = [cbuf(), cbuf(), cbuf(), cbuf(), cbuf(), cbuf()];
  this.depsHat  = [cbuf(), cbuf(), cbuf(), cbuf(), cbuf(), cbuf()];
  this.depsC    = [cbuf(), cbuf(), cbuf(), cbuf(), cbuf(), cbuf()];

  /* Γ: 6×6 real spatial buffers (uploaded per design) */
  this.gamma = new Array(6);
  for (var P = 0; P < 6; P++) {
    this.gamma[P] = [rbuf(), rbuf(), rbuf(), rbuf(), rbuf(), rbuf()];
  }

  /* Reduction partials + readback staging */
  this.partialsBuf = d.createBuffer({
    size:  Math.max(this.partialCount * 4, 256),
    usage: BU.STORAGE | BU.COPY_SRC
  });
  this.readbackBuf = d.createBuffer({
    size:  Math.max(this.partialCount * 4, 256),
    usage: BU.COPY_DST | BU.MAP_READ
  });
};


/* ── Uniform buffers + parameter writing ─────────────────────── */
ElasticSolverFull.prototype._allocateUniforms = function() {
  var d = this.device;
  var BU = GPUBufferUsage;

  /* ElasticParamsFull — 592 bytes (36 vec4 stiffness + 16 bytes trailer) */
  this.elasticParamsBuf = d.createBuffer({ size: 592, usage: BU.UNIFORM | BU.COPY_DST });

  /* SizeParams (16 bytes) — used by gammaAccum and dotReducePair */
  this.sizeParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  d.queue.writeBuffer(this.sizeParamsBuf, 0, new Uint32Array([this.N3, 0, 0, 0]));

  /* LaneParams (16 bytes) — used by packComplexLane and deAccumLane.
     Six instances cached, one per Voigt component, so multiple
     dispatches in the same encoder can each see their own lane. */
  this.laneParamsBufs = [];
  for (var lane = 0; lane < 6; lane++) {
    var buf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    /* lane field uses local-in-vec4 index (0,1,2); the n/s vec4
       choice is made by the bound buffer at dispatch time */
    var localLane = lane % 3;
    d.queue.writeBuffer(buf, 0, new Uint32Array([this.N3, localLane, 0, 0]));
    this.laneParamsBufs.push(buf);
  }

  /* AXPY / XBPY uniforms */
  this.axpyParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  this.xbpyParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* Fill uniforms — separate buf per (n, s) for one initialization
     sweep to allow filling eps_n and eps_s with different vec3 values */
  this.fillParamsBufN = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
  this.fillParamsBufS = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
};


/* Write the full elastic-params uniform (Cs, Cv, C0 — each a row-major
   Voigt 6×6 of 36 entries).  Called once per design. */
ElasticSolverFull.prototype._writeElasticParams = function(C_s, C_v, C_0) {
  /* Layout: 36 vec4<f32> followed by 4 u32. */
  var buf = new ArrayBuffer(592);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf, 576, 4);
  /* For each material (Cs, Cv, C0), 6 rows × 2 vec4 each = 12 vec4 = 48 floats. */
  function packMatrix(C, offset) {
    for (var row = 0; row < 6; row++) {
      var base = offset + row * 8;
      /* Row P's _n = [C[P,0], C[P,1], C[P,2], 0] */
      f[base + 0] = C[row * 6 + 0];
      f[base + 1] = C[row * 6 + 1];
      f[base + 2] = C[row * 6 + 2];
      f[base + 3] = 0;
      /* Row P's _s = [C[P,3], C[P,4], C[P,5], 0] */
      f[base + 4] = C[row * 6 + 3];
      f[base + 5] = C[row * 6 + 4];
      f[base + 6] = C[row * 6 + 5];
      f[base + 7] = 0;
    }
  }
  packMatrix(C_s,  0);    /* offset 0:   Cs occupies floats 0..47   */
  packMatrix(C_v,  48);   /* offset 48:  Cv occupies floats 48..95  */
  packMatrix(C_0,  96);   /* offset 96:  C0 occupies floats 96..143 */
  u[0] = this.N3; u[1] = 0; u[2] = 0; u[3] = 0;
  this.device.queue.writeBuffer(this.elasticParamsBuf, 0, buf);
};

ElasticSolverFull.prototype._writeAxpy = function(alpha) {
  var buf = new ArrayBuffer(16);
  new Float32Array(buf, 0, 1)[0] = alpha;
  new Uint32Array(buf, 4, 3)[0]  = this.N3;
  this.device.queue.writeBuffer(this.axpyParamsBuf, 0, buf);
};

ElasticSolverFull.prototype._writeXbpy = function(beta) {
  var buf = new ArrayBuffer(16);
  new Float32Array(buf, 0, 1)[0] = beta;
  new Uint32Array(buf, 4, 3)[0]  = this.N3;
  this.device.queue.writeBuffer(this.xbpyParamsBuf, 0, buf);
};

/* Write a 3-vector fill value to one of the fill uniform buffers.
   `which` = 'n' or 's' picks which of (eps_n, eps_s) is being filled. */
ElasticSolverFull.prototype._writeFillVec3 = function(which, v0, v1, v2) {
  var buf = new ArrayBuffer(32);
  var f = new Float32Array(buf, 0, 4);
  f[0] = v0; f[1] = v1; f[2] = v2; f[3] = 0;
  new Uint32Array(buf, 16, 4)[0] = this.N3;
  var target = (which === 'n') ? this.fillParamsBufN : this.fillParamsBufS;
  this.device.queue.writeBuffer(target, 0, buf);
};


/* ── Per-design upload ────────────────────────────────────────── */
ElasticSolverFull.prototype.uploadDesign = function(solid_f32, gammaArr, C_s, C_v, C_0) {
  var d = this.device;
  /* Solid mask */
  d.queue.writeBuffer(this.solidBuf, 0, solid_f32);

  /* Γ: 36 buffers from Float64 → Float32 */
  for (var P = 0; P < 6; P++) {
    for (var Q = 0; Q < 6; Q++) {
      var src = gammaArr[P][Q];
      var f32 = new Float32Array(src.length);
      for (var k = 0; k < src.length; k++) f32[k] = src[k];
      d.queue.writeBuffer(this.gamma[P][Q], 0, f32);
    }
  }

  /* Stiffness uniform */
  this._writeElasticParams(C_s, C_v, C_0);
};


/* ── Kernel dispatch helper ──────────────────────────────────── */
ElasticSolverFull.prototype._dispatchEncoded = function(enc, pipeline, bg, threadCount, wgSize) {
  var pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(threadCount / wgSize), 1, 1);
  pass.end();
};


/* ── applyA: out = eps + Γ·(C(x):eps − C0:eps)
       Inputs and outputs are { n, s } pairs of vec4 buffers.
       All ops appended to `enc`; caller submits. */
ElasticSolverFull.prototype._applyA = function(enc, epsIn, out) {
  var d = this.device;

  /* 1. localStressFull — sig = C(x):eps */
  var lsBg = d.createBindGroup({
    layout: this.lsLayout,
    entries: [
      { binding: 0, resource: { buffer: this.solidBuf } },
      { binding: 1, resource: { buffer: epsIn.n } },
      { binding: 2, resource: { buffer: epsIn.s } },
      { binding: 3, resource: { buffer: this.sig.n } },
      { binding: 4, resource: { buffer: this.sig.s } },
      { binding: 5, resource: { buffer: this.elasticParamsBuf } }
    ]
  });
  this._dispatchEncoded(enc, this.lsPipeline, lsBg, this.N3, 64);

  /* 2. tauComputeFull — tau = sig − C0:eps */
  var tcBg = d.createBindGroup({
    layout: this.tcLayout,
    entries: [
      { binding: 0, resource: { buffer: epsIn.n } },
      { binding: 1, resource: { buffer: epsIn.s } },
      { binding: 2, resource: { buffer: this.sig.n } },
      { binding: 3, resource: { buffer: this.sig.s } },
      { binding: 4, resource: { buffer: this.tau.n } },
      { binding: 5, resource: { buffer: this.tau.s } },
      { binding: 6, resource: { buffer: this.elasticParamsBuf } }
    ]
  });
  this._dispatchEncoded(enc, this.tcPipeline, tcBg, this.N3, 64);

  /* 3. Pack each Voigt component of tau (6 total) and forward-FFT.
        Component Q ∈ {0..2} pulls from tau.n at lane Q;
        component Q ∈ {3..5} pulls from tau.s at lane (Q-3). */
  for (var Q = 0; Q < 6; Q++) {
    var srcBuf = (Q < 3) ? this.tau.n : this.tau.s;
    var laneBuf = this.laneParamsBufs[Q];
    var pcBg = d.createBindGroup({
      layout: this.pcLayout,
      entries: [
        { binding: 0, resource: { buffer: srcBuf } },
        { binding: 1, resource: { buffer: this.tauCmplx[Q] } },
        { binding: 2, resource: { buffer: laneBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.pcPipeline, pcBg, this.N3, 64);

    this.fft.loadFromBuffer(enc, this.tauCmplx[Q]);
    this.fft.forwardEncoded(enc);
    this.fft.storeToBuffer(enc, this.tauHat[Q]);
  }

  /* 4. Seed out ← epsIn so the per-row deAccumLane (read-modify-write
        on out_v4) starts from the input strain on every lane. Without
        this, lanes not touched by a given row P would be undefined,
        and successive row dispatches would clobber each other's writes. */
  enc.copyBufferToBuffer(epsIn.n, 0, out.n, 0, this.v4Size);
  enc.copyBufferToBuffer(epsIn.s, 0, out.s, 0, this.v4Size);

  /* 5. For each output Voigt row P (0..5):
          two sub-dispatches accumulate Σ_Q Γ_PQ · tauHat_Q into depsHat[P],
          IFFT to depsC[P], then deAccumLane writes lane P back into out vec4. */
  for (var P = 0; P < 6; P++) {
    /* Write pass: depsHat[P] = Γ[P][0]·tauHat[0] + Γ[P][1]·tauHat[1] + Γ[P][2]·tauHat[2] */
    var gaWBg = d.createBindGroup({
      layout: this.gaLayout,
      entries: [
        { binding: 0, resource: { buffer: this.tauHat[0] } },
        { binding: 1, resource: { buffer: this.tauHat[1] } },
        { binding: 2, resource: { buffer: this.tauHat[2] } },
        { binding: 3, resource: { buffer: this.gamma[P][0] } },
        { binding: 4, resource: { buffer: this.gamma[P][1] } },
        { binding: 5, resource: { buffer: this.gamma[P][2] } },
        { binding: 6, resource: { buffer: this.depsHat[P] } },
        { binding: 7, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.gaWritePipeline, gaWBg, this.N3, 64);

    /* Add pass: depsHat[P] += Γ[P][3]·tauHat[3] + Γ[P][4]·tauHat[4] + Γ[P][5]·tauHat[5] */
    var gaABg = d.createBindGroup({
      layout: this.gaLayout,
      entries: [
        { binding: 0, resource: { buffer: this.tauHat[3] } },
        { binding: 1, resource: { buffer: this.tauHat[4] } },
        { binding: 2, resource: { buffer: this.tauHat[5] } },
        { binding: 3, resource: { buffer: this.gamma[P][3] } },
        { binding: 4, resource: { buffer: this.gamma[P][4] } },
        { binding: 5, resource: { buffer: this.gamma[P][5] } },
        { binding: 6, resource: { buffer: this.depsHat[P] } },
        { binding: 7, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.gaAddPipeline, gaABg, this.N3, 64);

    /* IFFT depsHat[P] → depsC[P] */
    this.fft.loadFromBuffer(enc, this.depsHat[P]);
    this.fft.inverseEncoded(enc);
    this.fft.storeToBuffer(enc, this.depsC[P]);

    /* deAccumLane: out.{n,s}[lane(P)] += Re(depsC[P]).  Read-modify-write
       on out — out was pre-seeded with epsIn above, so the lane updated
       here lands on top of the input-strain baseline.
       For P < 3 we update lane (P) of {n}; for P >= 3 we update lane (P-3) of {s}. */
    var destBuf = (P < 3) ? out.n : out.s;
    var laneBuf2 = this.laneParamsBufs[P];
    var daBg = d.createBindGroup({
      layout: this.daLayout,
      entries: [
        { binding: 0, resource: { buffer: destBuf } },
        { binding: 1, resource: { buffer: this.depsC[P] } },
        { binding: 2, resource: { buffer: laneBuf2 } }
      ]
    });
    this._dispatchEncoded(enc, this.daPipeline, daBg, this.N3, 64);
  }
};


/* ── Encoded AXPY pair: (y.n, y.s) += alpha · (x.n, x.s) ──
       SAME writeBuffer-coalescing constraint as the existing
       solver: never call this twice on the same encoder with
       different alphas — submit between calls. */
ElasticSolverFull.prototype._axpyPair = function(enc, alpha, x, y) {
  this._writeAxpy(alpha);
  for (var which = 0; which < 2; which++) {
    var xb = which === 0 ? x.n : x.s;
    var yb = which === 0 ? y.n : y.s;
    var bg = this.device.createBindGroup({
      layout: this.axLayout,
      entries: [
        { binding: 0, resource: { buffer: xb } },
        { binding: 1, resource: { buffer: yb } },
        { binding: 2, resource: { buffer: this.axpyParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.axPipeline, bg, this.N3, 64);
  }
};

ElasticSolverFull.prototype._xbpyPair = function(enc, beta, x, y) {
  this._writeXbpy(beta);
  for (var which = 0; which < 2; which++) {
    var xb = which === 0 ? x.n : x.s;
    var yb = which === 0 ? y.n : y.s;
    var bg = this.device.createBindGroup({
      layout: this.axLayout,
      entries: [
        { binding: 0, resource: { buffer: xb } },
        { binding: 1, resource: { buffer: yb } },
        { binding: 2, resource: { buffer: this.xbpyParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.xbpyPipeline, bg, this.N3, 64);
  }
};

/* Fill (n, s) pair from a 6-vector eps_bar (normal 3 → .n, shear 3 → .s).
   Two separate uniform buffers so a single encoder can carry both writes. */
ElasticSolverFull.prototype._fillPair = function(enc, target, eps_bar) {
  this._writeFillVec3('n', eps_bar[0], eps_bar[1], eps_bar[2]);
  this._writeFillVec3('s', eps_bar[3], eps_bar[4], eps_bar[5]);
  var bgN = this.device.createBindGroup({
    layout: this.fillLayout,
    entries: [
      { binding: 0, resource: { buffer: target.n } },
      { binding: 1, resource: { buffer: this.fillParamsBufN } }
    ]
  });
  this._dispatchEncoded(enc, this.fillPipeline, bgN, this.N3, 64);
  var bgS = this.device.createBindGroup({
    layout: this.fillLayout,
    entries: [
      { binding: 0, resource: { buffer: target.s } },
      { binding: 1, resource: { buffer: this.fillParamsBufS } }
    ]
  });
  this._dispatchEncoded(enc, this.fillPipeline, bgS, this.N3, 64);
};


/* ── Dot product of two pairs: Σ ((a.n · b.n) + (a.s · b.s)) ─── */
ElasticSolverFull.prototype._dotPair = async function(a, b) {
  var d = this.device;
  var enc = d.createCommandEncoder();
  var bg = d.createBindGroup({
    layout: this.drLayout,
    entries: [
      { binding: 0, resource: { buffer: a.n } },
      { binding: 1, resource: { buffer: a.s } },
      { binding: 2, resource: { buffer: b.n } },
      { binding: 3, resource: { buffer: b.s } },
      { binding: 4, resource: { buffer: this.partialsBuf } },
      { binding: 5, resource: { buffer: this.sizeParamsBuf } }
    ]
  });
  var pass = enc.beginComputePass();
  pass.setPipeline(this.drPipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(this.partialCount, 1, 1);
  pass.end();
  enc.copyBufferToBuffer(this.partialsBuf, 0, this.readbackBuf, 0, this.partialCount * 4);
  d.queue.submit([enc.finish()]);

  await this.readbackBuf.mapAsync(GPUMapMode.READ);
  var view = new Float32Array(this.readbackBuf.getMappedRange().slice(0));
  this.readbackBuf.unmap();

  var s = 0;
  for (var i = 0; i < this.partialCount; i++) s += view[i];
  return s;
};


/* ── Copy a pair: dst.n ← src.n, dst.s ← src.s (encoded only) ── */
ElasticSolverFull.prototype._copyPair = function(enc, src, dst) {
  enc.copyBufferToBuffer(src.n, 0, dst.n, 0, this.v4Size);
  enc.copyBufferToBuffer(src.s, 0, dst.s, 0, this.v4Size);
};


/* ── Read back the volume-averaged σ_bar (6-vector) ────────────
   Computes sig = localStress(eps), reads back, averages on CPU. */
ElasticSolverFull.prototype._readbackSigmaBar = async function() {
  var d = this.device;
  var rbN = d.createBuffer({ size: this.v4Size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var rbS = d.createBuffer({ size: this.v4Size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(this.sig.n, 0, rbN, 0, this.v4Size);
  enc.copyBufferToBuffer(this.sig.s, 0, rbS, 0, this.v4Size);
  d.queue.submit([enc.finish()]);
  await Promise.all([rbN.mapAsync(GPUMapMode.READ), rbS.mapAsync(GPUMapMode.READ)]);
  var aN = new Float32Array(rbN.getMappedRange().slice(0));
  var aS = new Float32Array(rbS.getMappedRange().slice(0));
  rbN.unmap(); rbS.unmap();
  rbN.destroy(); rbS.destroy();

  var sBar = [0, 0, 0, 0, 0, 0];
  for (var i = 0; i < this.N3; i++) {
    var base = 4 * i;
    sBar[0] += aN[base + 0];
    sBar[1] += aN[base + 1];
    sBar[2] += aN[base + 2];
    sBar[3] += aS[base + 0];
    sBar[4] += aS[base + 1];
    sBar[5] += aS[base + 2];
  }
  for (var p = 0; p < 6; p++) sBar[p] /= this.N3;
  return sBar;
};


/* ════════════════════════════════════════════════════════════
   solveLoadCaseFull — one CG run for a single 6-component eps_bar.
   Returns Promise<{ sigma:6, iters, converged, breakReason }>.
   ════════════════════════════════════════════════════════════ */
ElasticSolverFull.prototype.solveLoadCaseFull = async function(eps_bar) {
  var d = this.device;

  /* 1. eps = b = uniform macroscopic strain.
        IMPORTANT — same writeBuffer-coalescing caution as the
        existing solver.  Each fill writes uniform buffers; we
        submit once before any dispatch reads them. */
  var encInit = d.createCommandEncoder();
  this._fillPair(encInit, this.eps, eps_bar);
  d.queue.submit([encInit.finish()]);
  var encInit2 = d.createCommandEncoder();
  this._fillPair(encInit2, this.b, eps_bar);
  d.queue.submit([encInit2.finish()]);

  var bNorm = Math.sqrt(await this._dotPair(this.b, this.b)) + 1e-30;

  /* 2. r = b - A·eps, then p = r */
  var enc = d.createCommandEncoder();
  this._applyA(enc, this.eps, this.Ap);    /* Ap = A·eps */
  this._copyPair(enc, this.b, this.r);
  this._axpyPair(enc, -1.0, this.Ap, this.r);   /* r -= 1·Ap */
  this._copyPair(enc, this.r, this.p);
  d.queue.submit([enc.finish()]);

  var rr = await this._dotPair(this.r, this.r);
  var iters = 0;
  var converged = false;
  var breakReason = 'max_iter';

  /* 3. CG loop */
  for (var it = 0; it < CG_MAXITER_FULL; it++) {
    iters = it + 1;

    var encA = d.createCommandEncoder();
    this._applyA(encA, this.p, this.Ap);
    d.queue.submit([encA.finish()]);

    var pAp = await this._dotPair(this.p, this.Ap);
    if (Math.abs(pAp) < 1e-30) {
      breakReason = (pAp < 0) ? 'pAp_negative' : 'pAp_zero';
      break;
    }
    var alpha = rr / pAp;

    /* Two separate submits: each axpy writes alpha to the SAME uniform
       buffer, and we need its dispatches to read the correct value
       before the next write changes it. */
    var encE = d.createCommandEncoder();
    this._axpyPair(encE, alpha, this.p, this.eps);
    d.queue.submit([encE.finish()]);

    var encR = d.createCommandEncoder();
    this._axpyPair(encR, -alpha, this.Ap, this.r);
    d.queue.submit([encR.finish()]);

    var rrNew = await this._dotPair(this.r, this.r);
    var relRes = Math.sqrt(rrNew) / bNorm;
    if (relRes < CG_TOL_FULL) {
      converged = true;
      breakReason = 'converged';
      break;
    }

    var beta = rrNew / rr;
    var encP = d.createCommandEncoder();
    this._xbpyPair(encP, beta, this.r, this.p);
    d.queue.submit([encP.finish()]);

    rr = rrNew;
  }

  /* 4. Volume-averaged stress = mean(localStress(eps)) */
  var encS = d.createCommandEncoder();
  var lsBg = d.createBindGroup({
    layout: this.lsLayout,
    entries: [
      { binding: 0, resource: { buffer: this.solidBuf } },
      { binding: 1, resource: { buffer: this.eps.n } },
      { binding: 2, resource: { buffer: this.eps.s } },
      { binding: 3, resource: { buffer: this.sig.n } },
      { binding: 4, resource: { buffer: this.sig.s } },
      { binding: 5, resource: { buffer: this.elasticParamsBuf } }
    ]
  });
  this._dispatchEncoded(encS, this.lsPipeline, lsBg, this.N3, 64);
  d.queue.submit([encS.finish()]);

  var sigma = await this._readbackSigmaBar();
  return { sigma: sigma, iters: iters, converged: converged, breakReason: breakReason };
};


/* ════════════════════════════════════════════════════════════
   homogenizeFull — six load cases, returns full 6×6 C_eff
   plus derived Ex/Ey/Ez/Gxy/Gxz/Gyz/Poisson + Zener A.
   Coordinate convention is SOLVER-INTERNAL — the X↔Z + yz↔xy
   relabeling is applied at the solveDesignElasticFull boundary.
   ════════════════════════════════════════════════════════════ */
ElasticSolverFull.prototype.homogenizeFull = async function() {
  var voigtLabels = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  var C_eff = new Float64Array(36);
  var totalIters = 0;
  var allConverged = true;
  var perLC = [];

  for (var lc = 0; lc < 6; lc++) {
    var eps_bar = [0, 0, 0, 0, 0, 0];
    eps_bar[lc] = 1;
    var res = await this.solveLoadCaseFull(eps_bar);
    totalIters += res.iters;
    if (!res.converged) allConverged = false;
    for (var P = 0; P < 6; P++) C_eff[P * 6 + lc] = res.sigma[P];
    perLC.push({
      axis:        voigtLabels[lc],
      iters:       res.iters,
      converged:   res.converged,
      breakReason: res.breakReason
    });
  }

  /* Symmetrise */
  for (var P2 = 0; P2 < 6; P2++) {
    for (var Q2 = P2 + 1; Q2 < 6; Q2++) {
      var avg = 0.5 * (C_eff[P2 * 6 + Q2] + C_eff[Q2 * 6 + P2]);
      C_eff[P2 * 6 + Q2] = avg;
      C_eff[Q2 * 6 + P2] = avg;
    }
  }

  /* Invert via invert6x6 (from 16a-elastic-cpu-ref-full.js) */
  var S = invert6x6(C_eff);
  if (S === null) {
    return { valid: false, reject_reason: 'singular_C_eff', C_eff: C_eff, perLC: perLC,
             totalIters: totalIters, allConverged: allConverged };
  }

  var Ex  = 1 / S[0 * 6 + 0];
  var Ey  = 1 / S[1 * 6 + 1];
  var Ez  = 1 / S[2 * 6 + 2];
  var Gyz = 1 / S[3 * 6 + 3];
  var Gxz = 1 / S[4 * 6 + 4];
  var Gxy = 1 / S[5 * 6 + 5];
  var nu_xy = -S[0 * 6 + 1] / S[0 * 6 + 0];
  var nu_xz = -S[0 * 6 + 2] / S[0 * 6 + 0];
  var nu_yz = -S[1 * 6 + 2] / S[1 * 6 + 1];

  var C11 = C_eff[0 * 6 + 0];
  var C12 = C_eff[0 * 6 + 1];
  var C44 = C_eff[3 * 6 + 3];
  var zenerA = (C11 - C12) > 1e-30 ? (2 * C44) / (C11 - C12) : NaN;

  return {
    valid: true,
    Ex: Ex, Ey: Ey, Ez: Ez,
    Gxy: Gxy, Gxz: Gxz, Gyz: Gyz,
    nu_xy: nu_xy, nu_xz: nu_xz, nu_yz: nu_yz,
    zenerA: zenerA,
    C_eff: C_eff, S: S,
    perLC: perLC,
    totalIters: totalIters,
    allConverged: allConverged
  };
};


/* ── Cleanup: destroy all GPU buffers + pipelines ────────────── */
ElasticSolverFull.prototype.destroy = function() {
  function destroyMaybe(b) { if (b && b.destroy) b.destroy(); }
  destroyMaybe(this.solidBuf);
  destroyMaybe(this.elasticParamsBuf);
  destroyMaybe(this.sizeParamsBuf);
  destroyMaybe(this.axpyParamsBuf);
  destroyMaybe(this.xbpyParamsBuf);
  destroyMaybe(this.fillParamsBufN);
  destroyMaybe(this.fillParamsBufS);
  destroyMaybe(this.partialsBuf);
  destroyMaybe(this.readbackBuf);
  for (var i = 0; i < this.laneParamsBufs.length; i++) destroyMaybe(this.laneParamsBufs[i]);
  var pairs = [this.eps, this.b, this.r, this.p, this.Ap, this.sig, this.tau];
  for (var k = 0; k < pairs.length; k++) {
    destroyMaybe(pairs[k].n); destroyMaybe(pairs[k].s);
  }
  for (var q = 0; q < 6; q++) {
    destroyMaybe(this.tauCmplx[q]);
    destroyMaybe(this.tauHat[q]);
    destroyMaybe(this.depsHat[q]);
    destroyMaybe(this.depsC[q]);
  }
  for (var P = 0; P < 6; P++) for (var Q = 0; Q < 6; Q++) {
    destroyMaybe(this.gamma[P][Q]);
  }
};


/* ════════════════════════════════════════════════════════════
   solveDesignElasticFull — public API mirror of solveDesignElastic.
   recipe → Ex/Ey/Ez/Gxy/Gxz/Gyz with the X↔Z + yz↔xy relabel
   applied at the boundary so callers see physical-axis coordinates.

   Returns Promise<{
     name, family, mode, rho,
     Ex_MPa, Ey_MPa, Ez_MPa,
     Gxy_MPa, Gxz_MPa, Gyz_MPa,
     nu_xy, nu_xz, nu_yz,
     C_eff (Voigt 6×6, physical axes, MPa),
     S, zenerA,
     Es_MPa, nu (constituent),
     iters, converged, valid,
     perLC,                  // solver-internal labels — diagnostic only
     tRast_ms, tGamma_ms, tCG_ms
   }>
   ════════════════════════════════════════════════════════════ */
async function solveDesignElasticFull(recipe, N, opts) {
  if (!WGPU.device) throw new Error('solveDesignElasticFull: ensureDevice() first');
  opts = opts || {};

  /* Coordinate swap from solver to physical:
     LC 0↔2 (xx↔zz), LC 1 (yy unchanged), LC 3↔5 (yz↔xy), LC 4 (xz unchanged) */
  var SWAP = [2, 1, 0, 5, 4, 3];

  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);

  var t0 = performance.now();
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt,
                          args.nWeights, args.pipeR, args.phaseShift);
  var tRast = performance.now() - t0;

  var inside = 0;
  for (var v = 0; v < solid.length; v++) inside += solid[v];
  var rho = inside / solid.length;

  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var Es = mat.Es_MPa, nu = mat.nu;
  var C_s = isoC(Es, nu);
  var C_v = isoC(Es * 1e-4, nu);
  var C_0 = isoC(Es, nu);

  var t1 = performance.now();
  var Gamma = buildGammaFull(N, C_0[21], C_0[1]);
  var tGamma = performance.now() - t1;

  /* Reuse the global FFT plan (matches solveDesignElastic's pattern) */
  var fft;
  if (window.__sharedFFT && window.__sharedFFT.N === N) {
    fft = window.__sharedFFT;
  } else {
    if (window.__sharedFFT) window.__sharedFFT.destroy();
    fft = new FFTPlan(N);
    window.__sharedFFT = fft;
  }
  var solver = new ElasticSolverFull(N, fft);
  solver.uploadDesign(solid, Gamma, C_s, C_v, C_0);

  var t2 = performance.now();
  var hom = await solver.homogenizeFull();
  var tCG = performance.now() - t2;
  solver.destroy();   /* FFT plan stays alive (cached) */

  if (!hom.valid) {
    return {
      name: recipe.name, family: family, mode: args.mode, rho: rho,
      valid: false, reject_reason: hom.reject_reason,
      Es_MPa: Es, nu: nu,
      perLC: hom.perLC, iters: hom.totalIters, converged: hom.allConverged,
      tRast_ms: tRast, tGamma_ms: tGamma, tCG_ms: tCG
    };
  }

  /* Permute the 6×6 C_eff and S by SWAP at both rows and columns.
     C_phys[i][j] = C_solver[SWAP[i]][SWAP[j]] */
  var C_phys = new Float64Array(36);
  var S_phys = new Float64Array(36);
  for (var i = 0; i < 6; i++) {
    for (var j = 0; j < 6; j++) {
      C_phys[i * 6 + j] = hom.C_eff[SWAP[i] * 6 + SWAP[j]];
      S_phys[i * 6 + j] = hom.S    [SWAP[i] * 6 + SWAP[j]];
    }
  }

  /* Derived moduli in physical axes — 1/S_phys diagonal */
  var Ex  = 1 / S_phys[0 * 6 + 0];
  var Ey  = 1 / S_phys[1 * 6 + 1];
  var Ez  = 1 / S_phys[2 * 6 + 2];
  var Gyz = 1 / S_phys[3 * 6 + 3];
  var Gxz = 1 / S_phys[4 * 6 + 4];
  var Gxy = 1 / S_phys[5 * 6 + 5];
  var nu_xy = -S_phys[0 * 6 + 1] / S_phys[0 * 6 + 0];
  var nu_xz = -S_phys[0 * 6 + 2] / S_phys[0 * 6 + 0];
  var nu_yz = -S_phys[1 * 6 + 2] / S_phys[1 * 6 + 1];

  /* Zener anisotropy is invariant under the cubic swap, but compute
     from C_phys for clarity */
  var C11p = C_phys[0 * 6 + 0];
  var C12p = C_phys[0 * 6 + 1];
  var C44p = C_phys[3 * 6 + 3];
  var zenerA = (C11p - C12p) > 1e-30 ? (2 * C44p) / (C11p - C12p) : NaN;

  return {
    name:     recipe.name,
    family:   family,
    mode:     args.mode,
    rho:      rho,
    valid:    true,
    Es_MPa:   Es,
    nu:       nu,
    Ex_MPa:   Ex,  Ey_MPa:  Ey,  Ez_MPa:  Ez,
    Gxy_MPa:  Gxy, Gxz_MPa: Gxz, Gyz_MPa: Gyz,
    nu_xy:    nu_xy, nu_xz: nu_xz, nu_yz: nu_yz,
    C_eff:    Array.from(C_phys),
    S:        Array.from(S_phys),
    zenerA:   zenerA,
    iters:    hom.totalIters,
    converged: hom.allConverged,
    perLC:    hom.perLC,
    tRast_ms: tRast,
    tGamma_ms: tGamma,
    tCG_ms:   tCG
  };
}


/* ════════════════════════════════════════════════════════════
   runFullVoigtGPUTest — Schwarz P at N=16, cross-validates
   GPU full-Voigt against the CPU reference (push 2).

   Pass criteria (cross-validation against CPU oracle):
     C1. GPU converges on all 6 LCs
     C2. |GPU Ex − CPU Ex| / CPU Ex  <  1%   (and same for Ey, Ez)
     C3. |GPU Gxy − CPU Gxy| / CPU Gxy  <  1%  (and same for Gxz, Gyz)
     C4. |GPU Zener − CPU Zener| / CPU Zener  <  2%  (diagnostic; wider band)
   ════════════════════════════════════════════════════════════ */
var FULL_VOIGT_GPU_TEST = { state: 'idle', lastResult: null };

async function runFullVoigtGPUTest() {
  paintFullVoigtGPULink('running', '⟳ GPU init…');

  try {
    await ensureDevice();
  } catch (err) {
    paintFullVoigtGPULink('fail', '✗ ' + (err.message || 'WebGPU init failed'));
    return;
  }

  paintFullVoigtGPULink('running', '⟳ CPU reference…');
  await new Promise(function(resolve){ setTimeout(resolve, 10); });

  try {
    /* 1. Run CPU reference (used as oracle) */
    var tCPU0 = performance.now();
    var cpuRes = homogenizeFullCPU(DEMO_RECIPES.schwarzP, 16, { tol: 1e-4, maxiter: 300 });
    var tCPUms = performance.now() - tCPU0;

    if (!cpuRes.valid) {
      throw new Error('CPU reference returned invalid: ' + (cpuRes.reject_reason || 'unknown'));
    }

    paintFullVoigtGPULink('running', '⟳ GPU full-Voigt…');
    await new Promise(function(resolve){ setTimeout(resolve, 10); });

    /* 2. Run GPU full-Voigt */
    var tGPU0 = performance.now();
    var gpuRes = await solveDesignElasticFull(DEMO_RECIPES.schwarzP, 16, {});
    var tGPUms = performance.now() - tGPU0;

    if (!gpuRes.valid) {
      throw new Error('GPU returned invalid: ' + (gpuRes.reject_reason || 'unknown'));
    }

    /* 3. Cross-validate */
    var ok = true;
    var notes = [];

    if (!gpuRes.converged) { ok = false; notes.push('GPU CG did not converge on all 6 LCs'); }

    function reldiff(a, b) { return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-30); }

    /* Schwarz P has cubic symmetry, so CPU's Ex/Ey/Ez are equal — compare
       each GPU axis to the CPU value (CPU is the bit-validated oracle). */
    var dEx = reldiff(gpuRes.Ex_MPa, cpuRes.Ex);
    var dEy = reldiff(gpuRes.Ey_MPa, cpuRes.Ey);
    var dEz = reldiff(gpuRes.Ez_MPa, cpuRes.Ez);
    var Etol = 0.01;
    if (dEx > Etol) { ok = false; notes.push('Ex Δ ' + (dEx*100).toFixed(2) + '% (>' + (Etol*100) + '%)'); }
    if (dEy > Etol) { ok = false; notes.push('Ey Δ ' + (dEy*100).toFixed(2) + '% (>' + (Etol*100) + '%)'); }
    if (dEz > Etol) { ok = false; notes.push('Ez Δ ' + (dEz*100).toFixed(2) + '% (>' + (Etol*100) + '%)'); }

    var dGxy = reldiff(gpuRes.Gxy_MPa, cpuRes.Gxy);
    var dGxz = reldiff(gpuRes.Gxz_MPa, cpuRes.Gxz);
    var dGyz = reldiff(gpuRes.Gyz_MPa, cpuRes.Gyz);
    var Gtol = 0.01;
    if (dGxy > Gtol) { ok = false; notes.push('Gxy Δ ' + (dGxy*100).toFixed(2) + '% (>' + (Gtol*100) + '%)'); }
    if (dGxz > Gtol) { ok = false; notes.push('Gxz Δ ' + (dGxz*100).toFixed(2) + '% (>' + (Gtol*100) + '%)'); }
    if (dGyz > Gtol) { ok = false; notes.push('Gyz Δ ' + (dGyz*100).toFixed(2) + '% (>' + (Gtol*100) + '%)'); }

    var dZener = isFinite(gpuRes.zenerA) && isFinite(cpuRes.zenerA)
                 ? reldiff(gpuRes.zenerA, cpuRes.zenerA) : NaN;
    if (isFinite(dZener) && dZener > 0.02) {
      notes.push('Zener Δ ' + (dZener*100).toFixed(2) + '% (diagnostic, >2%)');
    }

    FULL_VOIGT_GPU_TEST.lastResult = { gpuRes: gpuRes, cpuRes: cpuRes, ok: ok, notes: notes };

    var bg = ok ? '#34d399' : '#fb7185';
    var fg = ok ? '#06080f' : '#fff';
    var lcLine = gpuRes.perLC.map(function(p){
      return p.axis + ':' + p.iters + '·' + p.breakReason;
    }).join('  ');

    console.log(
      '%c ' + (ok ? '✓' : '✗') + ' Schwarz P · Full Voigt GPU vs CPU · N=16 ',
      'background:' + bg + '; color:' + fg + '; font-weight:bold; padding:2px 8px; border-radius:3px;',
      '\n  ρ (VF):           ' + (gpuRes.rho * 100).toFixed(2) + '%' +
      '\n  Ex (GPU / CPU):   ' + (gpuRes.Ex_MPa/1000).toFixed(3) + ' / ' + (cpuRes.Ex/1000).toFixed(3) + ' GPa   Δ ' + (dEx*100).toFixed(3) + '%' +
      '\n  Ey (GPU / CPU):   ' + (gpuRes.Ey_MPa/1000).toFixed(3) + ' / ' + (cpuRes.Ey/1000).toFixed(3) + ' GPa   Δ ' + (dEy*100).toFixed(3) + '%' +
      '\n  Ez (GPU / CPU):   ' + (gpuRes.Ez_MPa/1000).toFixed(3) + ' / ' + (cpuRes.Ez/1000).toFixed(3) + ' GPa   Δ ' + (dEz*100).toFixed(3) + '%' +
      '\n  Gxy (GPU / CPU):  ' + (gpuRes.Gxy_MPa/1000).toFixed(3) + ' / ' + (cpuRes.Gxy/1000).toFixed(3) + ' GPa   Δ ' + (dGxy*100).toFixed(3) + '%' +
      '\n  Gxz (GPU / CPU):  ' + (gpuRes.Gxz_MPa/1000).toFixed(3) + ' / ' + (cpuRes.Gxz/1000).toFixed(3) + ' GPa   Δ ' + (dGxz*100).toFixed(3) + '%' +
      '\n  Gyz (GPU / CPU):  ' + (gpuRes.Gyz_MPa/1000).toFixed(3) + ' / ' + (cpuRes.Gyz/1000).toFixed(3) + ' GPa   Δ ' + (dGyz*100).toFixed(3) + '%' +
      '\n  Zener (GPU/CPU):  ' + gpuRes.zenerA.toFixed(4) + ' / ' + cpuRes.zenerA.toFixed(4) + (isFinite(dZener) ? '   Δ ' + (dZener*100).toFixed(3) + '%' : '') +
      '\n  GPU CG iters:     ' + gpuRes.iters + ' total · converged: ' + gpuRes.converged +
      '\n  GPU per-LC:       ' + lcLine +
      '\n  CPU time:         ' + tCPUms.toFixed(0) + ' ms' +
      '\n  GPU time:         ' + tGPUms.toFixed(0) + ' ms   (' + (tCPUms/Math.max(tGPUms,1)).toFixed(1) + '× speedup vs CPU)' +
      (notes.length ? '\n  notes:            ' + notes.join(' · ') : '\n  notes:            all cross-validation gates passed')
    );

    if (ok) {
      paintFullVoigtGPULink('pass',
        '✓ Full Voigt GPU · Ex=' + (gpuRes.Ex_MPa/1000).toFixed(1) + ' G44=' + (gpuRes.Gxy_MPa/1000).toFixed(1) + ' GPa');
    } else {
      paintFullVoigtGPULink('fail',
        '⚠ Full Voigt GPU · ' + notes.length + ' check' + (notes.length === 1 ? '' : 's') + ' failed (see console)');
    }
  } catch (err) {
    console.error('[full-voigt-gpu-smoke] failed:', err);
    paintFullVoigtGPULink('fail', '✗ ' + (err.message || String(err)));
  }
}

function paintFullVoigtGPULink(state, text) {
  var link = document.getElementById('fullVoigtGPUTestLink');
  if (!link) return;
  FULL_VOIGT_GPU_TEST.state = state;
  link.classList.remove('running', 'pass', 'fail');
  if (state !== 'idle') link.classList.add(state);
  link.textContent = text;
}
