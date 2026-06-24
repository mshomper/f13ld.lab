/* ============================================================
   F13LD.lab · 16b-elastic-solver-full.js

   GPU full Voigt 6×6 elastic FFT-CG solver.

   Parallel to 16-elastic-solver.js (the rc3 normal-only solver,
   now kept as an unused fast-triage path).  This file is the
   production qualification path for lab as of push 4a: provides
   the full 6×6 effective stiffness tensor (Ex/Ey/Ez/Gxy/Gxz/Gyz,
   three Poisson ratios, real Zener anisotropy) plus per-voxel
   u'(x) and σ_VM(x) field capture for the Deformed and Stress
   field tabs (push 4a.1).

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

   ── Field extraction (push 4a.1) ────────────────────────
   solveDesignElasticFull captures per-voxel u'(x) and σ_VM(x)
   for the three normal physical axes by default
   (opts.captureFieldsLCs = [0, 1, 2]).  σ_VM uses the full
   von Mises formula including shear stress contributions
   (which are non-zero under full-Voigt, unlike the normal-only
   path where shears are pinned to zero).  Cost: ~30 ms at
   N=32, ~240 ms at N=64 per captured LC.  Capture for shear
   LCs (3/4/5) is not supported — the diagonal spectral
   inversion for u'(x) is defined only for normal components.

   ── External dependencies (resolved at call time) ───────
   - WGPU.device, ensureDevice  (11-webgpu-device.js)
   - FFTPlan                    (12-fft-plan.js)
   - KERNELS                    (13-kernels.js)
   - isoC, buildVoxels,
     resolveBuildArgs           (14-rasterizer.js)
   - _es_fft3d                  (16-elastic-solver.js — CPU FFT
                                 reused for u'(x) spectral inversion)
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

  /* Plan-batch-aware: the elastic standalone hands _applyA a batched plan
     (batch >= 6) -> collapsed 6->1 FFT path.  Consumers that borrow
     ElasticSolverFull with a single-transform plan (e.g. the nonlinear
     solver's es) -> original per-component path.  Identical math. */
  var batched = (this.fft.batch >= 6);

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
  if (batched) {
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
    }

    /* Batched forward FFT — all 6 Voigt components in ONE stage-set (6 FFTs
       -> 1).  Packs above filled tauCmplx[0..5]; gather, transform, scatter. */
    this.fft.loadFromBuffers(enc, this.tauCmplx);
    this.fft.forwardEncoded(enc);
    this.fft.storeToBuffers(enc, this.tauHat);
  } else {
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
  if (batched) {
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
    }

    /* Batched inverse FFT — all 6 rows of depsHat in ONE stage-set (12 IFFTs
       -> 1).  Every row's gammaAccum is finished above (rows are independent),
       so the single batched IFFT is order-safe; deAccum then runs per row. */
    this.fft.loadFromBuffers(enc, this.depsHat);
    this.fft.inverseEncoded(enc);
    this.fft.storeToBuffers(enc, this.depsC);

    for (var P2 = 0; P2 < 6; P2++) {
      /* deAccumLane: out.{n,s}[lane(P2)] += Re(depsC[P2]).  Read-modify-write
         on out (pre-seeded with epsIn above).  P2 < 3 -> lane P2 of {n};
         P2 >= 3 -> lane (P2-3) of {s}.  Rows write distinct lanes -> order-free. */
      var destBuf = (P2 < 3) ? out.n : out.s;
      var laneBuf2 = this.laneParamsBufs[P2];
      var daBg = d.createBindGroup({
        layout: this.daLayout,
        entries: [
          { binding: 0, resource: { buffer: destBuf } },
          { binding: 1, resource: { buffer: this.depsC[P2] } },
          { binding: 2, resource: { buffer: laneBuf2 } }
        ]
      });
      this._dispatchEncoded(enc, this.daPipeline, daBg, this.N3, 64);
    }
  } else {
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
   _readbackPair — read back a vec4-packed (n, s) field pair and
   unpack the 6 Voigt components as separate Float32Array(N³)s.

   Returns Promise<[xx, yy, zz, yz, xz, xy]>, each a Float32Array(N³)
   in the lab's i*N²+j*N+k storage order.  Used after CG converges
   to extract per-voxel strain or stress for field visualization.

   Cost: 2× v4Size readback ≈ 2 MB at N=32, 16 MB at N=64.  Plus an
   N³ unpack loop.  ~5-30 ms typical depending on N.
   ════════════════════════════════════════════════════════════ */
ElasticSolverFull.prototype._readbackPair = async function(pair) {
  var d = this.device;
  var V = this.v4Size;
  var rbN = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var rbS = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(pair.n, 0, rbN, 0, V);
  enc.copyBufferToBuffer(pair.s, 0, rbS, 0, V);
  d.queue.submit([enc.finish()]);
  await Promise.all([rbN.mapAsync(GPUMapMode.READ), rbS.mapAsync(GPUMapMode.READ)]);
  var aN = new Float32Array(rbN.getMappedRange().slice(0));
  var aS = new Float32Array(rbS.getMappedRange().slice(0));
  rbN.unmap(); rbS.unmap();
  rbN.destroy(); rbS.destroy();

  /* Unpack vec4 lanes 0/1/2 from each of the two buffers.
     n: [xx, yy, zz, _]  ·  s: [yz, xz, xy, _] */
  var N3 = this.N3;
  var xx = new Float32Array(N3), yy = new Float32Array(N3), zz = new Float32Array(N3);
  var yz = new Float32Array(N3), xz = new Float32Array(N3), xy = new Float32Array(N3);
  for (var i = 0; i < N3; i++) {
    var b = 4 * i;
    xx[i] = aN[b + 0];
    yy[i] = aN[b + 1];
    zz[i] = aN[b + 2];
    yz[i] = aS[b + 0];
    xz[i] = aS[b + 1];
    xy[i] = aS[b + 2];
  }
  return [xx, yy, zz, yz, xz, xy];
};


/* ════════════════════════════════════════════════════════════
   extractFieldsForLCFull — port of extractFieldsForLC from the
   normal-only solver, adapted for the full-Voigt 6-component
   stress and strain.

   Differences from the normal-only version:

   (1) σ_VM includes shear terms (full von Mises stress).  The
       normal-only solver pins shears to zero, so its σ_VM uses
       only the deviatoric normal differences.  Full-Voigt
       computes shears explicitly, so they enter the σ_VM norm:

         σ_VM = sqrt( 0.5 · ( (σxx−σyy)² + (σyy−σzz)² + (σzz−σxx)²
                              + 6·(σyz² + σxz² + σxy²) ) )

       Practical effect: stress hot-spots at material interfaces
       are slightly more pronounced under full-Voigt because shear
       localization at boundaries is now captured.

   (2) u'(x) reconstruction uses only the 3 normal strain components.
       For the 3 normal LCs (eps_bar with one of exx/eyy/ezz set to 1),
       u'_c is reconstructed from ε'_cc via the same spectral
       inversion as normal-only (ε'_cc / (i·ξ_c) → u'_c).  For the 3
       shear LCs this method is not called (homogenizeFull skips
       capture for solver-internal LCs 3/4/5).

   Inputs:
     eps_bar_6: [exx, eyy, ezz, eyz, exz, exy]  — full 6-component LC
     sigArr_6:  [σxx, σyy, σzz, σyz, σxz, σxy]  — per-voxel stress arrays
                (Float32Array(N³) each), already on CPU.

   Returns Promise<{ u_prime: [Fx, Fy, Fz], sigma_vm: F, N, eps_bar }>
     where eps_bar is the 3-vector of NORMAL components [exx, eyy, ezz]
     for backward compatibility with the existing raymarcher consumer.
   ════════════════════════════════════════════════════════════ */
ElasticSolverFull.prototype.extractFieldsForLCFull = async function(eps_bar_6, sigArr_6) {
  var N  = this.N;
  var N3 = this.N3;

  /* 1. Read back per-voxel strain ε (all 6 components). */
  var epsArr = await this._readbackPair(this.eps);

  /* 2. σ_VM from sigArr (already CPU-side, 6-component) — full von Mises
        formula including shear terms. */
  var sigma_vm = new Float32Array(N3);
  var sxx = sigArr_6[0], syy = sigArr_6[1], szz = sigArr_6[2];
  var syz = sigArr_6[3], sxz = sigArr_6[4], sxy = sigArr_6[5];
  for (var i = 0; i < N3; i++) {
    var d01 = sxx[i] - syy[i];
    var d12 = syy[i] - szz[i];
    var d20 = szz[i] - sxx[i];
    var shear2 = syz[i]*syz[i] + sxz[i]*sxz[i] + sxy[i]*sxy[i];
    sigma_vm[i] = Math.sqrt(0.5 * (d01*d01 + d12*d12 + d20*d20) + 3 * shear2);
  }

  /* 3. u'(x) per normal component via spectral inversion.  Identical math
        to the normal-only solver — operates on the 3 normal strain
        components only (Voigt indices 0, 1, 2). */
  var u_prime = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
  var lineBuf = new Float64Array(2 * N);
  var halfN = N >> 1;

  for (var c = 0; c < 3; c++) {
    var ebar = eps_bar_6[c];
    var src  = epsArr[c];

    /* Pack ε'_cc as complex (real input, imag=0). */
    var work = new Float64Array(2 * N3);
    for (var p = 0; p < N3; p++) {
      work[2*p]     = src[p] - ebar;
      work[2*p + 1] = 0;
    }

    _es_fft3d(work, N, false, lineBuf);

    /* Spectral divide by 1/(i·ξ_c).
       (re + i·im) / (i·ξ) = (im - i·re) / ξ  for real ξ. */
    for (var iX = 0; iX < N; iX++) {
      var kx   = (iX < halfN) ? iX : iX - N;
      var nyqX = (iX === halfN);
      for (var iY = 0; iY < N; iY++) {
        var ky   = (iY < halfN) ? iY : iY - N;
        var nyqY = (iY === halfN);
        for (var iZ = 0; iZ < N; iZ++) {
          var kz   = (iZ < halfN) ? iZ : iZ - N;
          var nyqZ = (iZ === halfN);

          var idx = (iX*N + iY)*N + iZ;
          var ti  = 2 * idx;

          var k_d = (c === 0) ? kx : (c === 1 ? ky : kz);

          if (k_d === 0 || nyqX || nyqY || nyqZ) {
            work[ti] = 0; work[ti+1] = 0;
          } else {
            var re = work[ti], im = work[ti+1];
            var inv = 1 / k_d;
            work[ti]   =  im * inv;
            work[ti+1] = -re * inv;
          }
        }
      }
    }

    _es_fft3d(work, N, true, lineBuf);

    /* Pack real part into output. */
    var dst = u_prime[c];
    for (var q = 0; q < N3; q++) dst[q] = work[2*q];
  }

  return {
    u_prime:  u_prime,
    sigma_vm: sigma_vm,
    N:        N,
    eps_bar:  [eps_bar_6[0], eps_bar_6[1], eps_bar_6[2]]   /* normal components only */
  };
};


/* ════════════════════════════════════════════════════════════
   Piece B — extractStressOnlyForLCFull — σ_VM-only field
   extraction for shear LCs (yz/xz/xy).

   Why a separate method
   ---------------------
   The full extractFieldsForLCFull does TWO things: builds
   σ_VM(x), and reconstructs u'(x) from ε'(x) via per-component
   spectral inversion (FFT round-trip × 3 components).  The
   spectral inversion is only defined for the three NORMAL
   strain components — applying it to ε_yz / ε_xz / ε_xy yields
   non-physical displacement fields.

   For shear LCs we still want σ_VM(x) (it's a useful, well-defined
   scalar — full von Mises with shear terms, same formula as the
   normal case).  This method extracts ONLY that, skipping the
   three FFT round-trips entirely.

   Inputs:
     sigArr_6: [σxx, σyy, σzz, σyz, σxz, σxy]  — Float32Array(N³) each,
               already CPU-side (from _readbackPair on the sig pair).

   Returns Promise<{ u_prime: null, sigma_vm: F, N, eps_bar:[0,0,0] }>
     u_prime is null — uploadFields() in the raymarcher checks for
     this and skips the displacement texture upload (the deform
     visualization isn't meaningful for shear-LC fieldsets anyway).

   Cost: ~10 ms at N=64 (one Float32 loop over N³).  Compare to
   ~40 ms for the full extractor (FFT round-trips dominate).
   ════════════════════════════════════════════════════════════ */
ElasticSolverFull.prototype.extractStressOnlyForLCFull = async function(sigArr_6) {
  var N3 = this.N3;
  var sigma_vm = new Float32Array(N3);
  var sxx = sigArr_6[0], syy = sigArr_6[1], szz = sigArr_6[2];
  var syz = sigArr_6[3], sxz = sigArr_6[4], sxy = sigArr_6[5];
  for (var i = 0; i < N3; i++) {
    var d01 = sxx[i] - syy[i];
    var d12 = syy[i] - szz[i];
    var d20 = szz[i] - sxx[i];
    var shear2 = syz[i]*syz[i] + sxz[i]*sxz[i] + sxy[i]*sxy[i];
    sigma_vm[i] = Math.sqrt(0.5 * (d01*d01 + d12*d12 + d20*d20) + 3 * shear2);
  }
  return {
    u_prime:  null,             /* shear LC — no displacement field */
    sigma_vm: sigma_vm,
    N:        this.N,
    eps_bar:  [0, 0, 0]         /* shear strain — normal components are zero */
  };
};


/* ════════════════════════════════════════════════════════════
   solveLoadCaseFull — one CG run for a single 6-component eps_bar.

   opts (optional):
     { captureFields: true } — after CG converges, also extract
        per-voxel field data by reading back the converged stress
        (and, for normal LCs, the strain).  Dispatch:
          · normal LC (eps_bar normal-component nonzero) →
              extractFieldsForLCFull (σ_VM + u'(x) via FFT)
          · shear  LC (eps_bar shear-component nonzero)  →
              extractStressOnlyForLCFull (σ_VM only — u'(x) is null)

   Returns Promise<{ sigma:6, iters, converged, breakReason, fields }>.
     fields: null unless opts.captureFields, then either
             { u_prime: [Fx,Fy,Fz], sigma_vm, N, eps_bar }   (normal LC)
       or    { u_prime: null,       sigma_vm, N, eps_bar }   (shear  LC)
   ════════════════════════════════════════════════════════════ */
ElasticSolverFull.prototype.solveLoadCaseFull = async function(eps_bar, opts) {
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

  /* Optional per-voxel field extraction.  Done here, before any subsequent
     LC overwrites the eps buffer.  Reads back the full 6-component stress
     field via _readbackPair, then dispatches:
       · normal LC (eps_bar[0..2] nonzero) → extractFieldsForLCFull
         (full σ_VM + u'(x) via FFT spectral inversion)
       · shear  LC (eps_bar[3..5] nonzero) → extractStressOnlyForLCFull
         (σ_VM only — u'(x) is null since spectral inversion is undefined
         for off-diagonal strain components) */
  var fields = null;
  if (opts && opts.captureFields) {
    var sigArr_6 = await this._readbackPair(this.sig);
    var isNormal = (eps_bar[0] !== 0) || (eps_bar[1] !== 0) || (eps_bar[2] !== 0);
    fields = isNormal
      ? await this.extractFieldsForLCFull(eps_bar, sigArr_6)
      : await this.extractStressOnlyForLCFull(sigArr_6);
  }

  return { sigma: sigma, iters: iters, converged: converged, breakReason: breakReason, fields: fields };
};


/* ════════════════════════════════════════════════════════════
   homogenizeFull — six load cases, returns full 6×6 C_eff
   plus derived Ex/Ey/Ez/Gxy/Gxz/Gyz/Poisson + Zener A.
   Coordinate convention is SOLVER-INTERNAL — the X↔Z + yz↔xy
   relabeling is applied at the solveDesignElasticFull boundary.

   opts (optional):
     { captureFieldsLCs: [0, 1, 2, 3, 4, 5] } — array of SOLVER-internal
        LC indices to capture per-voxel fields for.  All six are valid:
        normal LCs (0=xx, 1=yy, 2=zz) produce { u_prime, sigma_vm };
        shear LCs (3=yz, 4=xz, 5=xy) produce { u_prime: null, sigma_vm }
        because u'(x) reconstruction requires the diagonal spectral
        inversion which is not defined for off-diagonal strain
        components.  Default [] (no capture).  Piece B (May 2026)
        extended this from normal-only to full-Voigt.
   ════════════════════════════════════════════════════════════ */
ElasticSolverFull.prototype.homogenizeFull = async function(opts) {
  opts = opts || {};

  /* Normalize captureFieldsLCs to an array of valid Voigt indices (0..5).
     Piece B — shear LCs (3/4/5) are now valid capture targets; they
     return σ_VM only (no u'(x)).  See solveLoadCaseFull dispatch. */
  var captureLCs = opts.captureFieldsLCs;
  if (captureLCs == null) captureLCs = [];
  if (typeof captureLCs === 'number') captureLCs = (captureLCs >= 0) ? [captureLCs] : [];
  var filteredCapture = [];
  for (var ci = 0; ci < captureLCs.length; ci++) {
    var lcIdx = captureLCs[ci];
    if (lcIdx >= 0 && lcIdx <= 5) filteredCapture.push(lcIdx);
  }

  var voigtLabels = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  var C_eff = new Float64Array(36);
  var totalIters = 0;
  var allConverged = true;
  var perLC = [];
  var capturedByLC = {};   /* solver-LC-index → fields */

  for (var lc = 0; lc < 6; lc++) {
    var eps_bar = [0, 0, 0, 0, 0, 0];
    eps_bar[lc] = 1;
    var lcOpts = (filteredCapture.indexOf(lc) >= 0) ? { captureFields: true } : null;
    var res = await this.solveLoadCaseFull(eps_bar, lcOpts);
    if (res.fields) capturedByLC[lc] = res.fields;
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
             totalIters: totalIters, allConverged: allConverged, fieldsByLC: capturedByLC };
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
    allConverged: allConverged,
    fieldsByLC: capturedByLC
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

   opts (optional):
     { captureFieldsLCs: [0, 1, 2, 3, 4, 5] }  — physical Voigt indices
        to capture per-voxel fields for:
          0=xx, 1=yy, 2=zz, 3=yz, 4=xz, 5=xy
        Default [0, 1, 2, 3, 4, 5] — captures all six so the lab
        raymarcher can toggle load direction across all of {normal,
        shear} without re-solving.  Pass [] to skip field extraction
        entirely for solver-only workflows.

        Normal axes return { u_prime, sigma_vm }; shear axes return
        { u_prime: null, sigma_vm } since u'(x) reconstruction
        requires the diagonal spectral inversion which is undefined
        off-diagonal.  Piece B (May 2026) extended this from
        normal-only (3 axes) to full-Voigt (6 axes).

     { connectivity: { minLargestFraction: 0.99 } } — optional
        pre-CG gating threshold.  If the rasterized voxel mask has
        disconnected components and the largest component represents
        less than `minLargestFraction` of total solid voxels, the
        solver early-returns { valid: false, reject_reason:
        'disconnected', connectivity } BEFORE building Γ.  Omit (or
        pass undefined) to keep the default warn-only behavior — the
        connectivity report is always computed and surfaced on the
        return object regardless of whether rejection is enabled.

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
     fieldsByAxis,           // { xx, yy, zz, yz, xz, xy } in PHYSICAL
                             //   coords; each { u_prime, sigma_vm, N,
                             //   eps_bar } or null.  Shear axes have
                             //   u_prime === null.
     connectivity,           // { numComponents, sizes, largest, smallest,
                             //   totalSolid, largestFraction, orphans } —
                             //   from 14a-connectivity.js, or null if
                             //   that file isn't loaded
     tRast_ms, tGamma_ms, tCG_ms
   }>
   ════════════════════════════════════════════════════════════ */
async function solveDesignElasticFull(recipe, N, opts) {
  if (!WGPU.device) throw new Error('solveDesignElasticFull: ensureDevice() first');
  opts = opts || {};

  /* Coordinate swap from solver to physical:
     LC 0↔2 (xx↔zz), LC 1 (yy unchanged), LC 3↔5 (yz↔xy), LC 4 (xz unchanged) */
  var SWAP = [2, 1, 0, 5, 4, 3];

  /* Normalize captureFieldsLCs to physical Voigt indices (0..5), then
     translate to solver-internal LC indices via SWAP[phys] for the
     homogenizeFull call.  Piece B (May 2026) — was [0,1,2] (normal-only),
     now [0,1,2,3,4,5] (full Voigt).  Shear axes capture σ_VM only;
     u'(x) is null on the returned fieldset (see extractStressOnlyForLCFull). */
  var captureLCs_phys = opts.captureFieldsLCs;
  if (captureLCs_phys == null) captureLCs_phys = [0, 1, 2, 3, 4, 5];
  if (typeof captureLCs_phys === 'number') {
    captureLCs_phys = (captureLCs_phys >= 0) ? [captureLCs_phys] : [];
  }
  var captureLCs_solver = [];
  for (var ci = 0; ci < captureLCs_phys.length; ci++) {
    var p = captureLCs_phys[ci];
    if (p >= 0 && p <= 5) captureLCs_solver.push(SWAP[p]);   /* solver LC = SWAP[phys] */
  }

  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);

  var t0 = performance.now();
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt,
                          args.nWeights, args.pipeR, args.phaseShift);
  /* Connectivity gate — keep only the largest periodic solid component so
     floating islands don't seed spurious modes (default-on from the run). */
  if (opts.pruneLargest && typeof pruneVoxels === 'function') {
    solid = pruneVoxels(solid, N, family, opts);
  }
  var tRast = performance.now() - t0;

  var inside = 0;
  for (var v = 0; v < solid.length; v++) inside += solid[v];
  var rho = inside / solid.length;

  /* Periodic 6-connectivity check (14a-connectivity.js).  Runs between
     rasterization and the (expensive) Γ build / CG solve.  Always
     computes; surfaces on the returned object as `connectivity`.
     Warn-only by default; rejects pre-CG if a threshold is provided.

     opts.connectivity (optional):
       { minLargestFraction: 0.99 } — if largest component < threshold,
         return { valid: false, reject_reason: 'disconnected', connectivity }
         BEFORE Γ is built.  Skips CG entirely on disconnected geometries.
       Omit to keep the warn-only behavior (default — no rejections). */
  var connectivity = null;
  if (typeof checkVoxelConnectivity === 'function') {
    var tConn0 = performance.now();
    connectivity = checkVoxelConnectivity(solid, N);
    var tConn  = performance.now() - tConn0;
    if (connectivity.numComponents > 1) {
      console.warn('[connectivity] ' + connectivity.orphans + ' orphan voxel(s) in ' +
                   (connectivity.numComponents - 1) + ' island(s) (largest = ' +
                   (connectivity.largestFraction * 100).toFixed(2) + '% of solid · ' +
                   tConn.toFixed(1) + ' ms)');
    }
    var connOpts = opts.connectivity || null;
    if (connOpts && typeof connOpts.minLargestFraction === 'number' &&
        connectivity.numComponents > 0 &&
        connectivity.largestFraction < connOpts.minLargestFraction) {
      return {
        name: recipe.name, family: family, mode: args.mode, rho: rho,
        valid: false, reject_reason: 'disconnected',
        connectivity: connectivity,
        Es_MPa: (recipe.material && recipe.material.Es_MPa) || 110000,
        nu:     (recipe.material && recipe.material.nu)     || 0.34,
        tRast_ms: tRast, tGamma_ms: 0, tCG_ms: 0
      };
    }
  }

  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var Es = mat.Es_MPa, nu = mat.nu;
  var C_s = isoC(Es, nu);
  var C_v = isoC(Es * 1e-4, nu);
  var C_0 = isoC(Es, nu);

  var t1 = performance.now();
  var Gamma = buildGammaFull(N, C_0[21], C_0[1]);
  var tGamma = performance.now() - t1;

  /* Batched FFT plan (batch = 6 Voigt components) — cached separately
     from the single-transform __sharedFFT that the buckling / Stokes
     solvers share, so neither path clobbers the other. */
  var fft;
  if (window.__sharedFFTBatched && window.__sharedFFTBatched.N === N && window.__sharedFFTBatched.batch === 6) {
    fft = window.__sharedFFTBatched;
  } else {
    if (window.__sharedFFTBatched) window.__sharedFFTBatched.destroy();
    fft = new FFTPlan(N, 6);
    window.__sharedFFTBatched = fft;
  }
  var solver = new ElasticSolverFull(N, fft);
  solver.uploadDesign(solid, Gamma, C_s, C_v, C_0);

  var t2 = performance.now();
  var hom = await solver.homogenizeFull({ captureFieldsLCs: captureLCs_solver });
  var tCG = performance.now() - t2;
  solver.destroy();   /* FFT plan stays alive (cached) */

  if (!hom.valid) {
    return {
      name: recipe.name, family: family, mode: args.mode, rho: rho,
      valid: false, reject_reason: hom.reject_reason,
      connectivity: connectivity,
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

  /* Voigt-bound + physicality gate.  A porous solid+void composite can never
     be stiffer than the solid phase, so any normal modulus that is non-finite,
     non-positive, or exceeds Es is unphysical — the signature of a load case
     that did not converge (a disconnected or non-periodic axis).  Report it
     honestly instead of surfacing ~1e23 GPa. */
  var EsCap = Es * 1.05;
  var badAxes = [];
  if (!(isFinite(Ex) && Ex > 0 && Ex <= EsCap)) badAxes.push('xx');
  if (!(isFinite(Ey) && Ey > 0 && Ey <= EsCap)) badAxes.push('yy');
  if (!(isFinite(Ez) && Ez > 0 && Ez <= EsCap)) badAxes.push('zz');
  if (badAxes.length > 0) {
    return {
      name: recipe.name, family: family, mode: args.mode, rho: rho,
      valid: false, reject_reason: 'nonconvergent', badAxes: badAxes,
      Es_MPa: Es, nu: nu, Ex_MPa: Ex, Ey_MPa: Ey, Ez_MPa: Ez,
      converged: hom.allConverged, perLC: hom.perLC, connectivity: connectivity
    };
  }

  /* Zener anisotropy is invariant under the cubic swap, but compute
     from C_phys for clarity */
  var C11p = C_phys[0 * 6 + 0];
  var C12p = C_phys[0 * 6 + 1];
  var C44p = C_phys[3 * 6 + 3];
  var zenerA = (C11p - C12p) > 1e-30 ? (2 * C44p) / (C11p - C12p) : NaN;

  /* Build fieldsByAxis from fieldsByLC.  Piece B (May 2026) extended
     this from 3 normal axes to all 6 Voigt axes.

     hom.fieldsByLC is keyed by solver-internal LC indices (0..5).  For
     each captured physical Voigt axis (0=xx, 1=yy, 2=zz, 3=yz, 4=xz,
     5=xy) we look up the corresponding solver LC via SWAP, then for
     NORMAL axes apply the X↔Z component swap inside u_prime + eps_bar
     so the fieldset is in physical-axis coordinates.

     SWAP table covers all 6 indices:
       phys=0(xx)→solver=2, phys=1(yy)→1, phys=2(zz)→0,
       phys=3(yz)→5,        phys=4(xz)→4, phys=5(xy)→3.

     For SHEAR axes, u_prime is null (extractStressOnlyForLCFull returns
     it as null) so the swap is a no-op.  eps_bar on shear fieldsets is
     [0,0,0] (no normal strain), so swapping it is also a no-op.  We
     guard the swap behind the u_prime null check for clarity. */
  var fieldsByAxis = { xx: null, yy: null, zz: null, yz: null, xz: null, xy: null };
  var axisName = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  if (hom.fieldsByLC) {
    for (var phys = 0; phys < 6; phys++) {
      var solverIdx = SWAP[phys];
      var f = hom.fieldsByLC[solverIdx];
      if (!f) continue;
      if (f.u_prime) {
        /* Normal LC — swap u_prime[0] ↔ u_prime[2] and eps_bar[0] ↔
           eps_bar[2] so the returned fieldset is in physical-axis
           coordinates (solver internal had X↔Z relabeling). */
        var tmpU = f.u_prime[0];
        f.u_prime[0] = f.u_prime[2];
        f.u_prime[2] = tmpU;
        var tmpE = f.eps_bar[0];
        f.eps_bar[0] = f.eps_bar[2];
        f.eps_bar[2] = tmpE;
      }
      fieldsByAxis[axisName[phys]] = f;
    }
  }

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
    fieldsByAxis: fieldsByAxis,    /* Piece B — { xx, yy, zz, yz, xz, xy }; each { u_prime, sigma_vm, N, eps_bar } in PHYSICAL coords, or null.  Shear axes have u_prime === null. */
    connectivity: connectivity,    /* Push 6.1 — { numComponents, sizes, largest, smallest, totalSolid, largestFraction, orphans } or null if helper not loaded */
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


/* ============================================================
   APPENDED: Step 3a + 3b batched lockstep homogenization
   (2D-native dispatch).  Additive only — serial path &
   borrowers untouched.
   ============================================================ */
/* ============================================================
   F13LD.lab · Step 3a + 3b · batched lockstep elastic homogenization
   (appended into 16b-elastic-solver-full.js)

   3a: all six Voigt load cases of ONE design in a single CG.
   3b: D designs × 6 load cases in a single CG (shared reference
       material → shared Γ/C0), with a tiling fallback when the
       FFT batch (36·D) exceeds device grid / buffer limits.

   Additive only — the serial _applyA / solveLoadCaseFull /
   homogenizeFull are untouched; nonlinear & buckling borrowers
   are unaffected.

   DISPATCH: all batched kernels dispatch 2D-NATIVELY —
     X = voxel  (workgroups of 64 over N³)
     Y = slot   (combined CG slot 0..6T-1, or spectral slot 0..36T-1)
   so the per-dimension workgroup count stays under the device cap
   (X = ceil(N³/64): 32768 at N=128).  Above N≈160 the X dimension
   itself would exceed the cap and needs X-tiling (a future 3c);
   _ensureBatchedResources throws a clear error past that point.

   Slot layout (tile of T designs)
     CG state (eps,b,r,p,Ap,sig,tau)  width  6T   slot = d*6 + LC
     spectral (tauCmplx..depsC)       width 36T   slot = d*36 + LC*6 + Q
   Γ, C0, Cs, Cv shared across all slots (single reference material).

   Validation (console, functions are loaded with 16b — no paste):
     await runFullVoigtGPUTestBatched();      // 3a regression, bit-exact
     await runFullVoigtGPUTestBatched(64);    // high-N parity + speed
     await runMultiDesignGPUTest();           // 3b, 3 designs
   ============================================================ */

/* ---- batched WGSL kernels (2D-native: gid.x = voxel, gid.y = slot) -------- */

var BATCH_SIZE_STRUCT_WGSL =
'struct BatchSize { voxels: u32, nslots: u32, _p0: u32, _p1: u32 }\n';

/* localStress: solid is shared per design → design = slot/6. */
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
'  let voxel = gid.x;\n' +
'  if (voxel >= BS.voxels) { return; }\n' +
'  let slot = gid.y;\n' +                          /* combined CG slot 0..6T-1 */
'  let i = slot * BS.voxels + voxel;\n' +
'  let design = slot / 6u;\n' +
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

/* tau = sig − C0:eps (elementwise per slot). */
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
'  let voxel = gid.x;\n' +
'  if (voxel >= BS.voxels) { return; }\n' +
'  let i = gid.y * BS.voxels + voxel;\n' +
'  let en = eps_n[i].xyz; let es = eps_s[i].xyz;\n' +
'  let sn = sig_n[i].xyz; let ss = sig_s[i].xyz;\n' +
'  tau_n[i] = vec4<f32>(sn.x-(dot(P.C0_r0n.xyz,en)+dot(P.C0_r0s.xyz,es)), sn.y-(dot(P.C0_r1n.xyz,en)+dot(P.C0_r1s.xyz,es)), sn.z-(dot(P.C0_r2n.xyz,en)+dot(P.C0_r2s.xyz,es)), 0.0);\n' +
'  tau_s[i] = vec4<f32>(ss.x-(dot(P.C0_r3n.xyz,en)+dot(P.C0_r3s.xyz,es)), ss.y-(dot(P.C0_r4n.xyz,en)+dot(P.C0_r4s.xyz,es)), ss.z-(dot(P.C0_r5n.xyz,en)+dot(P.C0_r5s.xyz,es)), 0.0);\n' +
'}\n';

/* pack: tau (6T-wide) → tauCmplx (36T-wide).  slot = spectral slot; CS=slot/6. */
var PACK_BATCHED_WGSL = BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       tau_n:   array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       tau_s:   array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> out_cmpx:array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn pack_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let voxel = gid.x;\n' +
'  if (voxel >= BS.voxels) { return; }\n' +
'  let slot = gid.y;\n' +                          /* spectral slot 0..36T-1 */
'  let CS   = slot / 6u;\n' +                       /* combined CG slot d*6+LC */
'  let Q    = slot % 6u;\n' +
'  let base = CS * BS.voxels + voxel;\n' +
'  var x: f32 = 0.0;\n' +
'  if (Q < 3u) {\n' +
'    let v = tau_n[base];\n' +
'    if (Q == 0u) { x = v.x; } else if (Q == 1u) { x = v.y; } else { x = v.z; }\n' +
'  } else {\n' +
'    let v = tau_s[base]; let q2 = Q - 3u;\n' +
'    if (q2 == 0u) { x = v.x; } else if (q2 == 1u) { x = v.y; } else { x = v.z; }\n' +
'  }\n' +
'  out_cmpx[slot * BS.voxels + voxel] = vec2<f32>(x, 0.0);\n' +
'}\n';

/* gammaAccum, fixed row P (pidx), all combined slots: depsHat[CS*6+P] = Σ_Q Γ[P][Q]·tauHat[CS*6+Q]. */
var GAMMA_ACCUM_BATCHED_WGSL =
'struct GP { voxels: u32, pidx: u32, _p0: u32, _p1: u32 }\n' +
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
'  let voxel = gid.x;\n' +
'  if (voxel >= P.voxels) { return; }\n' +
'  let CS  = gid.y;\n' +                            /* combined CG slot */
'  let row = CS * 6u;\n' +
'  var acc = g0[voxel] * tauHat[(row + 0u) * P.voxels + voxel];\n' +
'  acc = acc + g1[voxel] * tauHat[(row + 1u) * P.voxels + voxel];\n' +
'  acc = acc + g2[voxel] * tauHat[(row + 2u) * P.voxels + voxel];\n' +
'  acc = acc + g3[voxel] * tauHat[(row + 3u) * P.voxels + voxel];\n' +
'  acc = acc + g4[voxel] * tauHat[(row + 4u) * P.voxels + voxel];\n' +
'  acc = acc + g5[voxel] * tauHat[(row + 5u) * P.voxels + voxel];\n' +
'  depsHat[(row + P.pidx) * P.voxels + voxel] = acc;\n' +
'}\n';

/* deAccum, fixed row P: out.{n,s}[lane(P)] += Re(depsC[CS*6+P]).  Seed out←eps first. */
var DEACCUM_BATCHED_WGSL =
'struct DP { voxels: u32, pidx: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> out_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       deps_c: array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<uniform>             P: DP;\n' +
'@compute @workgroup_size(64)\n' +
'fn de_accum_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let voxel = gid.x;\n' +
'  if (voxel >= P.voxels) { return; }\n' +
'  let CS   = gid.y;\n' +
'  let dval = deps_c[(CS * 6u + P.pidx) * P.voxels + voxel].x;\n' +
'  let base = CS * P.voxels + voxel;\n' +
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

/* axpy (both n,s) per-slot scalar: y += a[slot]·x. */
var AXPY_BATCHED_WGSL = BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       x_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       x_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> y_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> y_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read>       sc:  array<f32>;\n' +
'@group(0) @binding(5) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn axpy_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let voxel = gid.x;\n' +
'  if (voxel >= BS.voxels) { return; }\n' +
'  let slot = gid.y;\n' +
'  let i = slot * BS.voxels + voxel;\n' +
'  let a = sc[slot];\n' +
'  y_n[i] = y_n[i] + a * x_n[i];\n' +
'  y_s[i] = y_s[i] + a * x_s[i];\n' +
'}\n';

/* xbpy (both n,s) per-slot scalar: y = x + b[slot]·y. */
var XBPY_BATCHED_WGSL = BATCH_SIZE_STRUCT_WGSL +
'@group(0) @binding(0) var<storage, read>       x_n: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       x_s: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> y_n: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> y_s: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read>       sc:  array<f32>;\n' +
'@group(0) @binding(5) var<uniform>             BS: BatchSize;\n' +
'@compute @workgroup_size(64)\n' +
'fn xbpy_batched(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let voxel = gid.x;\n' +
'  if (voxel >= BS.voxels) { return; }\n' +
'  let slot = gid.y;\n' +
'  let i = slot * BS.voxels + voxel;\n' +
'  let b = sc[slot];\n' +
'  y_n[i] = x_n[i] + b * y_n[i];\n' +
'  y_s[i] = x_s[i] + b * y_s[i];\n' +
'}\n';

/* dotReduce, 2D-native: workgroup (chunk = wgid.x, CS = wgid.y).  One partial per
   (CS, chunk) at partials[CS*partialCount + chunk].  CPU sums per CS. */
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
'  let chunk = wgid.x;\n' +
'  let CS    = wgid.y;\n' +
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
'  if (tid == 0u) { partials[CS * P.partialCount + chunk] = sdata[0]; }\n' +
'}\n';


/* ---- 2D dispatch helper ---------------------------------------------------- */
ElasticSolverFull.prototype._dispatchGrid2 = function(enc, pipe, bg, xWG, yWG) {
  var pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(xWG, yWG, 1);
  pass.end();
};


/* ---- tile-size probe (largest T whose batch-36T FFT fits) ------------------ */
ElasticSolverFull.prototype._pickTileSize = function(D) {
  var N3 = this.N3;
  var lim = (this.device.limits && this.device.limits.maxStorageBufferBindingSize) || (128 * 1024 * 1024);
  for (var T = D; T >= 1; T--) {
    if (36 * T * N3 * 8 > lim) continue;       /* one spectral / FFT ping-pong buffer */
    try { var probe = new FFTPlan(this.N, 36 * T); probe.destroy(); return T; }
    catch (e) { /* grid limit at this T → smaller */ }
  }
  return 1;
};


/* ---- lazy resource allocation, cached per tile size T ---------------------- */
ElasticSolverFull.prototype._ensureBatchedResources = function(T) {
  T = T || 1;
  if (!this.Bcache) this.Bcache = {};
  if (this.Bcache[T]) { this.B = this.Bcache[T]; return; }

  var d = this.device, BU = GPUBufferUsage, N3 = this.N3;
  var nCG = 6 * T, nSP = 36 * T;
  var maxDim = (d.limits && d.limits.maxComputeWorkgroupsPerDimension) || 65535;
  var voxWGx = Math.ceil(N3 / 64);
  if (voxWGx > maxDim) {
    throw new Error('batched homogenize: N=' + this.N + ' needs X-tiling (voxel-WG ' +
      voxWGx + ' > device cap ' + maxDim + '); not supported yet (3c).');
  }
  var dotWGx = Math.ceil(N3 / 256);
  if (dotWGx > maxDim) throw new Error('batched dot: N too large for X dim (' + dotWGx + ' > ' + maxDim + ')');

  var wideV = nCG * this.v4Size, wideC = nSP * this.cmplxSize;
  function vb() { return d.createBuffer({ size: wideV, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function cb() { return d.createBuffer({ size: wideC, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function pair() { return { n: vb(), s: vb() }; }
  function ub(b) { return d.createBuffer({ size: b, usage: BU.UNIFORM | BU.COPY_DST }); }

  var B = { T: T, nCG: nCG, nSP: nSP, voxWGx: voxWGx, dotWGx: dotWGx };
  B.eps = pair(); B.b = pair(); B.r = pair(); B.p = pair(); B.Ap = pair();
  B.sig = pair(); B.tau = pair();
  B.tauCmplx = cb(); B.tauHat = cb(); B.depsHat = cb(); B.depsC = cb();

  B.solidWide = d.createBuffer({ size: T * this.realSize, usage: BU.STORAGE | BU.COPY_DST });
  B.solid = B.solidWide;

  B.fft = new FFTPlan(this.N, nSP);
  B.scalarFloats = Math.max(nCG, 8);
  B.scalarBuf = d.createBuffer({ size: B.scalarFloats * 4, usage: BU.STORAGE | BU.COPY_DST });

  B.partialCount = this.partialCount;
  var nPart = nCG * B.partialCount;
  B.partials = d.createBuffer({ size: Math.max(nPart * 4, 256), usage: BU.STORAGE | BU.COPY_SRC });
  B.readback = d.createBuffer({ size: Math.max(nPart * 4, 256), usage: BU.COPY_DST | BU.MAP_READ });

  B.size6  = ub(16); d.queue.writeBuffer(B.size6,  0, new Uint32Array([N3, nCG, 0, 0]));
  B.size36 = ub(16); d.queue.writeBuffer(B.size36, 0, new Uint32Array([N3, nSP, 0, 0]));
  B.dotU   = ub(16); d.queue.writeBuffer(B.dotU,   0, new Uint32Array([N3, B.partialCount, 0, 0]));
  B.gammaPU = []; B.deaccPU = [];
  for (var P = 0; P < 6; P++) {
    var gu = ub(16); d.queue.writeBuffer(gu, 0, new Uint32Array([N3, P, 0, 0])); B.gammaPU.push(gu);
    var du = ub(16); d.queue.writeBuffer(du, 0, new Uint32Array([N3, P, 0, 0])); B.deaccPU.push(du);
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

  var idN = new Float32Array(nCG * N3 * 4), idS = new Float32Array(nCG * N3 * 4);
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
  pass.dispatchWorkgroups(B.dotWGx, B.nCG, 1);    /* X = chunk, Y = combined slot */
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
  var B = this.B, sc = new Float32Array(B.scalarFloats);
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
  this._dispatchGrid2(enc, B.axPipe, bg, B.voxWGx, B.nCG);
};
ElasticSolverFull.prototype._xbpyB = function(enc, scalarArr, x, y) {
  var B = this.B;
  this._writeScalarB(scalarArr);
  var bg = this.device.createBindGroup({ layout: B.xbPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: x.n } }, { binding: 1, resource: { buffer: x.s } },
    { binding: 2, resource: { buffer: y.n } }, { binding: 3, resource: { buffer: y.s } },
    { binding: 4, resource: { buffer: B.scalarBuf } }, { binding: 5, resource: { buffer: B.size6 } }
  ]});
  this._dispatchGrid2(enc, B.xbPipe, bg, B.voxWGx, B.nCG);
};

/* ---- batched operator: out = epsIn + Γ·(C(x):epsIn − C0:epsIn), all slots ---- */
ElasticSolverFull.prototype._applyABatched = function(enc, epsIn, out) {
  var d = this.device, B = this.B;

  var lsBg = d.createBindGroup({ layout: B.lsPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: B.solid } },
    { binding: 1, resource: { buffer: epsIn.n } }, { binding: 2, resource: { buffer: epsIn.s } },
    { binding: 3, resource: { buffer: B.sig.n } }, { binding: 4, resource: { buffer: B.sig.s } },
    { binding: 5, resource: { buffer: this.elasticParamsBuf } }, { binding: 6, resource: { buffer: B.size6 } }
  ]});
  this._dispatchGrid2(enc, B.lsPipe, lsBg, B.voxWGx, B.nCG);

  var tcBg = d.createBindGroup({ layout: B.tcPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: epsIn.n } }, { binding: 1, resource: { buffer: epsIn.s } },
    { binding: 2, resource: { buffer: B.sig.n } }, { binding: 3, resource: { buffer: B.sig.s } },
    { binding: 4, resource: { buffer: B.tau.n } }, { binding: 5, resource: { buffer: B.tau.s } },
    { binding: 6, resource: { buffer: this.elasticParamsBuf } }, { binding: 7, resource: { buffer: B.size6 } }
  ]});
  this._dispatchGrid2(enc, B.tcPipe, tcBg, B.voxWGx, B.nCG);

  var pcBg = d.createBindGroup({ layout: B.pcPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: B.tau.n } }, { binding: 1, resource: { buffer: B.tau.s } },
    { binding: 2, resource: { buffer: B.tauCmplx } }, { binding: 3, resource: { buffer: B.size36 } }
  ]});
  this._dispatchGrid2(enc, B.pcPipe, pcBg, B.voxWGx, B.nSP);
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
    this._dispatchGrid2(enc, B.gaPipe, gaBg, B.voxWGx, B.nCG);
  }

  B.fft.loadFromBuffer(enc, B.depsHat);
  B.fft.inverseEncoded(enc);
  B.fft.storeToBuffer(enc, B.depsC);
  for (var P2 = 0; P2 < 6; P2++) {
    var daBg = d.createBindGroup({ layout: B.daPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: out.n } }, { binding: 1, resource: { buffer: out.s } },
      { binding: 2, resource: { buffer: B.depsC } }, { binding: 3, resource: { buffer: B.deaccPU[P2] } }
    ]});
    this._dispatchGrid2(enc, B.daPipe, daBg, B.voxWGx, B.nCG);
  }
};

/* ---- core lockstep CG over the current tile -------------------------------- */
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
  this._axpyB(encR, ones, B.Ap, B.r);
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
    this._axpyB(encE, Array.prototype.slice.call(alpha), B.p, B.eps);
    d.queue.submit([encE.finish()]);
    var negAlpha = []; for (var L1b = 0; L1b < nCG; L1b++) negAlpha.push(-alpha[L1b]);
    var encRr = d.createCommandEncoder();
    this._axpyB(encRr, negAlpha, B.Ap, B.r);
    d.queue.submit([encRr.finish()]);

    var rrNew = await this._dotB(B.r, B.r);
    for (var L2 = 0; L2 < nCG; L2++) {
      if (!live[L2]) continue;
      if (Math.sqrt(rrNew[L2]) / bNorm[L2] < tol) { live[L2] = false; converged[L2] = true; iters[L2] = it + 1; nLive--; }
    }
    if (nLive === 0) { for (var L3 = 0; L3 < nCG; L3++) if (iters[L3] === 0) iters[L3] = it + 1; break; }

    var beta = []; for (var L4 = 0; L4 < nCG; L4++) beta.push(live[L4] ? (rrNew[L4] / rr[L4]) : 0);
    var encPp = d.createCommandEncoder();
    this._xbpyB(encPp, beta, B.r, B.p);
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
  this._dispatchGrid2(encS, B.lsPipe, lsBg, B.voxWGx, B.nCG);
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
      var CS = dgn * 6 + LC, sBar = [0, 0, 0, 0, 0, 0], slotOff = CS * N3 * 4;
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
      perDesign.push({ valid: false, reject_reason: 'singular_C_eff', C_eff: C_eff, S: null, perLC: perLC, allConverged: allConv });
    } else {
      perDesign.push({
        valid: true,
        Ex: 1 / S[0], Ey: 1 / S[7], Ez: 1 / S[14],
        Gyz: 1 / S[21], Gxz: 1 / S[28], Gxy: 1 / S[35],
        C_eff: C_eff, S: S, perLC: perLC, allConverged: allConv
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
  this.B.solid = this.solidBuf;
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

  var results = new Array(D), totalIters = 0, tilesUsed = 0;
  for (var start = 0; start < D; start += T) {
    var g = Math.min(T, D - start);
    this._ensureBatchedResources(g);
    this.B.solid = this.B.solidWide;
    var packed = new Float32Array(g * N3);
    for (var k = 0; k < g; k++) packed.set(designGrids[start + k], k * N3);
    d.queue.writeBuffer(this.B.solidWide, 0, packed);
    var tile = await this._runLockstepTile();
    for (var j = 0; j < g; j++) results[start + j] = tile.perDesign[j];
    totalIters += tile.totalIters; tilesUsed++;
  }
  return { perDesign: results, tileSize: T, tilesUsed: tilesUsed, totalIters: totalIters, time: performance.now() - t0 };
};


/* ---- harness 1: 3a regression / high-N parity (single design) -------------- */
async function runFullVoigtGPUTestBatched(N) {
  N = N || 16;
  if (!WGPU.device) await ensureDevice();
  var recipe = DEMO_RECIPES.schwarzP;
  var fftB6 = (window.__sharedFFTBatched && window.__sharedFFTBatched.N === N && window.__sharedFFTBatched.batch === 6)
    ? window.__sharedFFTBatched : new FFTPlan(N, 6);
  if (!window.__sharedFFTBatched) window.__sharedFFTBatched = fftB6;

  var family = recipe.family, params = KERNELS[family].parseRecipe(recipe), args = resolveBuildArgs(recipe);
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var C_s = isoC(mat.Es_MPa, mat.nu), C_v = isoC(mat.Es_MPa * 1e-4, mat.nu), C_0 = isoC(mat.Es_MPa, mat.nu);
  var Gamma = buildGammaFull(N, C_0[21], C_0[1]);
  var solver = new ElasticSolverFull(N, fftB6);
  solver.uploadDesign(solid, Gamma, C_s, C_v, C_0);

  var tb0 = performance.now(); var homB = await solver.homogenizeFullBatched(); var tBatched = performance.now() - tb0;
  var ts0 = performance.now(); var homS = await solver.homogenizeFull();        var tSerial = performance.now() - ts0;

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
  var mat = recipes[0].material || { Es_MPa: 110000, nu: 0.34 };
  var C_s = isoC(mat.Es_MPa, mat.nu), C_v = isoC(mat.Es_MPa * 1e-4, mat.nu), C_0 = isoC(mat.Es_MPa, mat.nu);
  var Gamma = buildGammaFull(N, C_0[21], C_0[1]);
  var solids = recipes.map(function (recipe) {
    var family = recipe.family, params = KERNELS[family].parseRecipe(recipe), args = resolveBuildArgs(recipe);
    return buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  });
  var fftB6 = (window.__sharedFFTBatched && window.__sharedFFTBatched.N === N && window.__sharedFFTBatched.batch === 6)
    ? window.__sharedFFTBatched : new FFTPlan(N, 6);
  if (!window.__sharedFFTBatched) window.__sharedFFTBatched = fftB6;
  var solver = new ElasticSolverFull(N, fftB6);
  solver.uploadDesign(solids[0], Gamma, C_s, C_v, C_0);

  var tm0 = performance.now();
  var homM = await solver.homogenizeFullBatchedMulti(solids, { forceTile: opts.forceTile });
  var tMulti = performance.now() - tm0;

  var serialResults = [], tSerial = 0;
  for (var dgn = 0; dgn < solids.length; dgn++) {
    solver.uploadDesign(solids[dgn], Gamma, C_s, C_v, C_0);
    var ts = performance.now(); serialResults.push(await solver.homogenizeFull()); tSerial += performance.now() - ts;
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
