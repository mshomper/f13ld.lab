/* ════════════════════════════════════════════════════════════
   F13LD.lab · 16d-buckling-solver.js
   GPU buckling solver — PUSH 1: operator + inner-solve layer.

   Roadmap item #3 (GPU buckling port).  This push ports the
   matrix-free operators and the inner CG of the CPU reference
   (16c-buckling-cpu-ref.js) to WebGPU, reusing the elastic GPU
   FFT stack (12-fft-plan.js).  The generalized eigensolver
   driver, the σ⁰ pre-stress front-end, the solveDesignBucklingGPU
   dispatcher and the UI wiring are PUSH 2.

   ── What this file provides ──────────────────────────────────
     BucklingSolverGPU(N, fftPlan)        — GPU solver object
       .uploadDesign(solid_f32, C_s, C_v) — geometry + stiffness
       .uploadSigma0(sigma0)              — per-axis pre-stress field
       ._applyK   (enc, inV4, outV4)      — (K u)_i   = −∂_j C_ijkl ε_kl(u)
       ._applyKg  (enc, inV4, outV4)      — (K_g u)_k = −∂_i σ⁰_ij ∂_j u_k
       ._precondGamma0(enc, inV4, outV4)  — Γ⁰ Christoffel-inverse precond
       .pcgSolveK (bBuf, opts)            — solveB: K x = b, Γ⁰-preconditioned
     runBucklingGPUTest(N)                — in-browser GPU↔CPU parity gates

   ── Displacement field layout ───────────────────────────────
     u is stored ONE vec4 per voxel: (u_x, u_y, u_z, 0).  Strain
     and stress reuse the elastic { n:vec4, s:vec4 } split
     (n = [xx,yy,zz,0], s = [yz,xz,xy,0]).  All spectral scratch
     is array<vec2<f32>> (re,im interleaved) — identical to the
     FFT plan's complex format.

   ── Key correctness invariants ──────────────────────────────
     · Every hot-path uniform (spec-deriv direction, lane index,
       Γ⁰ material constants) is PRE-BAKED at upload time, so the
       operators never call queue.writeBuffer mid-encoder.  This
       sidesteps the writeBuffer-coalescing hazard that forces the
       elastic CG to split α/β axpy into separate submits — the
       operators can batch every pass into one encoder safely.
     · The α/β BLAS-1 ops inside pcgSolveK DO change a uniform per
       call, so they keep the elastic solver's separate-submit
       discipline.
     · GPU is f32; the CPU oracle is f64.  Parity is checked in a
       relative band (~1e-3), not bit-exactly — consistent with the
       elastic GPU↔CPU practice.  See §5 of the 2026-06-22 handoff:
       the node harness cannot exercise GPU paths; these gates run
       in-browser.
   ════════════════════════════════════════════════════════════ */


/* ════════════════════════════════════════════════════════════
   WGSL kernel sources
   ════════════════════════════════════════════════════════════ */

/* BK_STIFF — solid + void Voigt 6×6 (engineering) for the C:ε step.
   24 vec4 (Cs 12 + Cv 12) + 4-u32 trailer = 400 bytes.
   Row P stored as two vec4: _n=[CP0,CP1,CP2,0], _s=[CP3,CP4,CP5,0]. */
var BK_STIFF_WGSL =
'struct BkStiff {\n' +
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
'  total: u32, _p0: u32, _p1: u32, _p2: u32\n' +
'}\n';

/* bk_local_stress: sig = C(x):eps  (full 6×6, per-voxel material select). */
var BK_LOCAL_STRESS_WGSL = BK_STIFF_WGSL +
'@group(0) @binding(0) var<storage, read>       solid: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       eps_n: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       eps_s: array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> sig_n: array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> sig_s: array<vec4<f32>>;\n' +
'@group(0) @binding(5) var<uniform>             P: BkStiff;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_local_stress(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let isSolid = solid[i] > 0.5;\n' +
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

/* bk_extract_lane: copy lane (0/1/2) of a vec4 field into a complex
   buffer (im = 0) for FFT input. */
var BK_EXTRACT_LANE_WGSL =
'struct LaneP { total: u32, lane: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       in_v4:  array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_c:  array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: LaneP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_extract_lane(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let v = in_v4[i];\n' +
'  var x: f32;\n' +
'  switch (P.lane) { case 0u: { x = v.x; } case 1u: { x = v.y; } case 2u: { x = v.z; } default: { x = 0.0; } }\n' +
'  out_c[i] = vec2<f32>(x, 0.0);\n' +
'}\n';

/* bk_write_lane: out_v4[i].lane = scale · Re(src_c[i]).  Read-modify-write
   so writing lanes 0,1,2 sequentially into one buffer doesn't clobber.
   scale folds in the −1 needed for the divergence (out = −∂_j σ_ij). */
var BK_WRITE_LANE_WGSL =
'struct LaneScaleP { scale: f32, total: u32, lane: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> out_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       src_c:  array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: LaneScaleP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_write_lane(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  var o = out_v4[i];\n' +
'  let d = P.scale * src_c[i].x;\n' +
'  switch (P.lane) { case 0u: { o.x = d; } case 1u: { o.y = d; } case 2u: { o.z = d; } default: {} }\n' +
'  o.w = 0.0;\n' +
'  out_v4[i] = o;\n' +
'}\n';

/* Spectral first derivative: out_c = i·κ_dir · in_c  (Nyquist-zeroed).
   κ_dir is the signed integer wavenumber along `dir`; the N/2 bin is
   zeroed (derivative of a real field is ill-defined there).  Mirrors
   specDeriv() in 16c.  i·κ·(re + i·im) = (−κ·im) + i·(κ·re). */
var BK_SPECDERIV_DECODE =
'  let nn = P.N * P.N;\n' +
'  let a = i / nn;\n' +
'  let rem = i - a * nn;\n' +
'  let b = rem / P.N;\n' +
'  let c = rem - b * P.N;\n' +
'  var kd: u32;\n' +
'  switch (P.dir) { case 0u: { kd = a; } case 1u: { kd = b; } default: { kd = c; } }\n' +
'  let nyq = P.N / 2u;\n' +
'  var kk: i32 = select(i32(kd) - i32(P.N), i32(kd), kd <= nyq);\n' +
'  if (kd == nyq) { kk = 0; }\n' +
'  let kf = f32(kk);\n';

var BK_SPECDERIV_WRITE_WGSL =
'struct IkP { N: u32, dir: u32, total: u32, _p: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       in_c:  array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_c: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: IkP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_specderiv_write(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
BK_SPECDERIV_DECODE +
'  let v = in_c[i];\n' +
'  out_c[i] = vec2<f32>(-kf * v.y, kf * v.x);\n' +
'}\n';

var BK_SPECDERIV_ACCUM_WGSL =
'struct IkP { N: u32, dir: u32, total: u32, _p: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       in_c:  array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_c: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: IkP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_specderiv_accum(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
BK_SPECDERIV_DECODE +
'  let v = in_c[i];\n' +
'  out_c[i] = out_c[i] + vec2<f32>(-kf * v.y, kf * v.x);\n' +
'}\n';

/* bk_kg_flux: f_i = σ⁰_ij g_j  (per-voxel).  σ⁰ tensor in Voigt:
   n=[s0,s1,s2], s=[s3,s4,s5] → [[s0,s5,s4],[s5,s1,s3],[s4,s3,s2]]. */
var BK_KG_FLUX_WGSL =
'struct SizeP { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       g_v4:  array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       s0_n:  array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       s0_s:  array<vec4<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> f_v4:  array<vec4<f32>>;\n' +
'@group(0) @binding(4) var<uniform>             P: SizeP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_kg_flux(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let g = g_v4[i].xyz;\n' +
'  let sn = s0_n[i].xyz;\n' +  /* s0,s1,s2 */
'  let ss = s0_s[i].xyz;\n' +  /* s3,s4,s5 */
'  let fx = sn.x * g.x + ss.z * g.y + ss.y * g.z;\n' +
'  let fy = ss.z * g.x + sn.y * g.y + ss.x * g.z;\n' +
'  let fz = ss.y * g.x + ss.x * g.y + sn.z * g.z;\n' +
'  f_v4[i] = vec4<f32>(fx, fy, fz, 0.0);\n' +
'}\n';

/* bk_gamma0_diag: Γ⁰ Christoffel-inverse spectral multiply (3×3 per
   frequency).  Ĝ₀(ξ) = (1/μ₀κ²)[ I − β κ̂⊗κ̂ ], β=(λ₀+μ₀)/(λ₀+2μ₀).
   κ uses the K-matched, per-axis Nyquist-zeroed integer convention
   (NOT Willot-rotated) — mirrors bk_makePrecondGamma0 in 16c. */
var BK_GAMMA0_WGSL =
'struct GammaP { mu0: f32, beta: f32, N: u32, total: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       ux: array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       uy: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       uz: array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<storage, read_write> vx: array<vec2<f32>>;\n' +
'@group(0) @binding(4) var<storage, read_write> vy: array<vec2<f32>>;\n' +
'@group(0) @binding(5) var<storage, read_write> vz: array<vec2<f32>>;\n' +
'@group(0) @binding(6) var<uniform>             P: GammaP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_gamma0_diag(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let N = P.N;\n' +
'  let nn = N * N;\n' +
'  let a = i / nn;\n' +
'  let rem = i - a * nn;\n' +
'  let b = rem / N;\n' +
'  let c = rem - b * N;\n' +
'  let nyq = N / 2u;\n' +
'  var ka: i32 = select(i32(a) - i32(N), i32(a), a <= nyq);\n' +
'  var kb: i32 = select(i32(b) - i32(N), i32(b), b <= nyq);\n' +
'  var kc: i32 = select(i32(c) - i32(N), i32(c), c <= nyq);\n' +
'  if (a == nyq) { ka = 0; }\n' +
'  if (b == nyq) { kb = 0; }\n' +
'  if (c == nyq) { kc = 0; }\n' +
'  let ksq = f32(ka * ka + kb * kb + kc * kc);\n' +
'  if (ksq == 0.0) {\n' +
'    vx[i] = vec2<f32>(0.0, 0.0); vy[i] = vec2<f32>(0.0, 0.0); vz[i] = vec2<f32>(0.0, 0.0);\n' +
'    return;\n' +
'  }\n' +
'  let f = 1.0 / (P.mu0 * ksq);\n' +
'  let inv = 1.0 / sqrt(ksq);\n' +
'  let nx = f32(ka) * inv; let ny = f32(kb) * inv; let nz = f32(kc) * inv;\n' +
'  let ax = ux[i]; let ay = uy[i]; let az = uz[i];\n' +
'  let dotR = nx * ax.x + ny * ay.x + nz * az.x;\n' +
'  let dotI = nx * ax.y + ny * ay.y + nz * az.y;\n' +
'  vx[i] = vec2<f32>(f * (ax.x - P.beta * dotR * nx), f * (ax.y - P.beta * dotI * nx));\n' +
'  vy[i] = vec2<f32>(f * (ay.x - P.beta * dotR * ny), f * (ay.y - P.beta * dotI * ny));\n' +
'  vz[i] = vec2<f32>(f * (az.x - P.beta * dotR * nz), f * (az.y - P.beta * dotI * nz));\n' +
'}\n';

/* BLAS-1 on single vec4 displacement fields (lanes xyz; .w ignored/0). */
var BK_AXPY3_WGSL =
'struct AxP { alpha: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> y_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: AxP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_axpy3(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y_v4[i] = y_v4[i] + P.alpha * x_v4[i];\n' +
'}\n';

var BK_XBPY3_WGSL =
'struct AxP { alpha: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> y_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: AxP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_xbpy3(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y_v4[i] = x_v4[i] + P.alpha * y_v4[i];\n' +
'}\n';

/* bk_dot3_reduce: Σ dot(a.xyz, b.xyz) — one f32 partial per workgroup. */
var BK_DOT3_WGSL =
'struct SizeP { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       a_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       b_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> partials: array<f32>;\n' +
'@group(0) @binding(3) var<uniform>             P: SizeP;\n' +
'var<workgroup> sdata: array<f32, 256>;\n' +
'@compute @workgroup_size(256)\n' +
'fn bk_dot3_reduce(@builtin(global_invocation_id) gid: vec3<u32>,\n' +
'                  @builtin(local_invocation_id) lid: vec3<u32>,\n' +
'                  @builtin(workgroup_id) wgid: vec3<u32>) {\n' +
'  let i = gid.x; let tid = lid.x;\n' +
'  var s: f32 = 0.0;\n' +
'  if (i < P.total) { s = dot(a_v4[i].xyz, b_v4[i].xyz); }\n' +
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

/* bk_sum3_reduce: per-lane Σ a.xyz — one vec4 partial per workgroup
   (lane sums in .xyz).  Used by the zero-mean projection. */
var BK_SUM3_WGSL =
'struct SizeP { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       a_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> partials: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: SizeP;\n' +
'var<workgroup> sdata: array<vec4<f32>, 256>;\n' +
'@compute @workgroup_size(256)\n' +
'fn bk_sum3_reduce(@builtin(global_invocation_id) gid: vec3<u32>,\n' +
'                  @builtin(local_invocation_id) lid: vec3<u32>,\n' +
'                  @builtin(workgroup_id) wgid: vec3<u32>) {\n' +
'  let i = gid.x; let tid = lid.x;\n' +
'  var s: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);\n' +
'  if (i < P.total) { let v = a_v4[i]; s = vec4<f32>(v.x, v.y, v.z, 0.0); }\n' +
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

/* bk_subconst3: x.xyz -= (m0,m1,m2)  (zero-mean projection apply). */
var BK_SUBCONST3_WGSL =
'struct SubP { m0: f32, m1: f32, m2: f32, _pad: f32, total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<uniform>             P: SubP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_subconst3(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let v = x_v4[i];\n' +
'  x_v4[i] = vec4<f32>(v.x - P.m0, v.y - P.m1, v.z - P.m2, 0.0);\n' +
'}\n';


/* ════════════════════════════════════════════════════════════
   BucklingSolverGPU
   ════════════════════════════════════════════════════════════ */
function BucklingSolverGPU(N, fftPlan) {
  this.N = N;
  this.N3 = N * N * N;
  this.v4Size = 16 * this.N3;   /* vec4<f32> per voxel */
  this.realSize = 4 * this.N3;  /* f32 per voxel (solid mask) */
  this.cmplxSize = 8 * this.N3; /* vec2<f32> per voxel (FFT complex) */
  this.fft = fftPlan;
  this.device = WGPU.device;
  if (!this.device) throw new Error('BucklingSolverGPU: WebGPU device not initialized');
  if (this.fft.N !== N) throw new Error('BucklingSolverGPU: FFT plan size mismatch');

  this.WG_REDUCE = 256;
  this.partialCount = Math.ceil(this.N3 / this.WG_REDUCE);

  this._buildPipelines();
  this._allocateBuffers();
  this._allocateUniforms();
}

BucklingSolverGPU.prototype._buildPipelines = function() {
  var d = this.device;
  function ro(b)  { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }; }
  function rw(b)  { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }; }
  function uni(b) { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }; }
  function pipe(layout, code, entry) {
    return d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: d.createShaderModule({ code: code }), entryPoint: entry }
    });
  }

  this.lsLayout  = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), rw(3), rw(4), uni(5)] });
  this.lsPipe    = pipe(this.lsLayout, BK_LOCAL_STRESS_WGSL, 'bk_local_stress');

  this.exLayout  = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.exPipe    = pipe(this.exLayout, BK_EXTRACT_LANE_WGSL, 'bk_extract_lane');

  this.wlLayout  = d.createBindGroupLayout({ entries: [rw(0), ro(1), uni(2)] });
  this.wlPipe    = pipe(this.wlLayout, BK_WRITE_LANE_WGSL, 'bk_write_lane');

  this.ikLayout  = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.ikWPipe   = pipe(this.ikLayout, BK_SPECDERIV_WRITE_WGSL, 'bk_specderiv_write');
  this.ikAPipe   = pipe(this.ikLayout, BK_SPECDERIV_ACCUM_WGSL, 'bk_specderiv_accum');

  this.kgLayout  = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), rw(3), uni(4)] });
  this.kgPipe    = pipe(this.kgLayout, BK_KG_FLUX_WGSL, 'bk_kg_flux');

  this.g0Layout  = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), rw(3), rw(4), rw(5), uni(6)] });
  this.g0Pipe    = pipe(this.g0Layout, BK_GAMMA0_WGSL, 'bk_gamma0_diag');

  this.axLayout  = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.axPipe    = pipe(this.axLayout, BK_AXPY3_WGSL, 'bk_axpy3');
  this.xbPipe    = pipe(this.axLayout, BK_XBPY3_WGSL, 'bk_xbpy3');

  this.dotLayout = d.createBindGroupLayout({ entries: [ro(0), ro(1), rw(2), uni(3)] });
  this.dotPipe   = pipe(this.dotLayout, BK_DOT3_WGSL, 'bk_dot3_reduce');

  this.sumLayout = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.sumPipe   = pipe(this.sumLayout, BK_SUM3_WGSL, 'bk_sum3_reduce');

  this.scLayout  = d.createBindGroupLayout({ entries: [rw(0), uni(1)] });
  this.scPipe    = pipe(this.scLayout, BK_SUBCONST3_WGSL, 'bk_subconst3');
};

BucklingSolverGPU.prototype._allocateBuffers = function() {
  var d = this.device, BU = GPUBufferUsage;
  var V = this.v4Size, R = this.realSize, C = this.cmplxSize;
  var self = this;
  function v4() { return d.createBuffer({ size: V, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function cb() { return d.createBuffer({ size: C, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }

  this.solidBuf = d.createBuffer({ size: R, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });

  /* pre-stress field σ⁰ (uploaded per axis) */
  this.s0n = v4();
  this.s0s = v4();

  /* strain / stress scratch (elastic { n, s } split) */
  this.epsN = v4(); this.epsS = v4();
  this.sigN = v4(); this.sigS = v4();

  /* gradient / flux scratch (vec4 xyz) */
  this.gV4 = v4(); this.fV4 = v4();

  /* complex scratch */
  this.cA = cb();                                   /* generic FFT staging */
  this.uhat = [cb(), cb(), cb()];                   /* FFT of u_x, u_y, u_z */
  this.hat6 = [cb(), cb(), cb(), cb(), cb(), cb()];  /* spectral strain/stress rows */
  this.ohat = cb();                                  /* divergence accumulator */

  /* PCG state */
  this.pcgX  = v4(); this.pcgR = v4(); this.pcgZ = v4();
  this.pcgP  = v4(); this.pcgAp = v4();

  /* reduction partials + staging */
  this.partF = d.createBuffer({ size: Math.max(this.partialCount * 4, 256),  usage: BU.STORAGE | BU.COPY_SRC });
  this.rbF   = d.createBuffer({ size: Math.max(this.partialCount * 4, 256),  usage: BU.COPY_DST | BU.MAP_READ });
  this.part4 = d.createBuffer({ size: Math.max(this.partialCount * 16, 256), usage: BU.STORAGE | BU.COPY_SRC });
  this.rb4   = d.createBuffer({ size: Math.max(this.partialCount * 16, 256), usage: BU.COPY_DST | BU.MAP_READ });
};

BucklingSolverGPU.prototype._allocateUniforms = function() {
  var d = this.device, BU = GPUBufferUsage;
  var N3 = this.N3, N = this.N;

  /* stiffness (Cs + Cv) — 400 bytes */
  this.stiffBuf = d.createBuffer({ size: 400, usage: BU.UNIFORM | BU.COPY_DST });

  /* size params (16 bytes) — dot3 / kg flux */
  this.sizeBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  d.queue.writeBuffer(this.sizeBuf, 0, new Uint32Array([N3, 0, 0, 0]));

  /* Γ⁰ params (16 bytes) — written at uploadDesign (needs mu0, beta) */
  this.gammaBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* extract-lane uniforms (3, pre-baked) */
  this.exBufs = [];
  for (var l = 0; l < 3; l++) {
    var eb = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    d.queue.writeBuffer(eb, 0, new Uint32Array([N3, l, 0, 0]));
    this.exBufs.push(eb);
  }

  /* write-lane uniforms: 3 lanes × {+1, −1} (pre-baked) */
  this.wlPos = []; this.wlNeg = [];
  for (var lp = 0; lp < 3; lp++) {
    var bp = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    var ab = new ArrayBuffer(16);
    new Float32Array(ab, 0, 1)[0] = 1.0;
    new Uint32Array(ab, 4, 2).set([N3, lp]);
    d.queue.writeBuffer(bp, 0, ab);
    this.wlPos.push(bp);

    var bn = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    var an = new ArrayBuffer(16);
    new Float32Array(an, 0, 1)[0] = -1.0;
    new Uint32Array(an, 4, 2).set([N3, lp]);
    d.queue.writeBuffer(bn, 0, an);
    this.wlNeg.push(bn);
  }

  /* spec-deriv direction uniforms (3, pre-baked: {N, dir, total, 0}) */
  this.ikBufs = [];
  for (var dir = 0; dir < 3; dir++) {
    var ib = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    d.queue.writeBuffer(ib, 0, new Uint32Array([N, dir, N3, 0]));
    this.ikBufs.push(ib);
  }

  /* axpy / xbpy uniforms (alpha written per call → separate submits) */
  this.axBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  this.xbBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* subconst uniform (mean written per zero-mean call) */
  this.subBuf = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
};


/* ── Per-design upload (geometry + stiffness + Γ⁰ constants) ─── */
BucklingSolverGPU.prototype.uploadDesign = function(solid_f32, C_s, C_v) {
  var d = this.device;
  d.queue.writeBuffer(this.solidBuf, 0, solid_f32);

  /* stiffness uniform: Cs (12 vec4) then Cv (12 vec4) then trailer */
  var buf = new ArrayBuffer(400);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf, 384, 4);
  function pack(C, off) {
    for (var row = 0; row < 6; row++) {
      var base = off + row * 8;
      f[base + 0] = C[row * 6 + 0]; f[base + 1] = C[row * 6 + 1]; f[base + 2] = C[row * 6 + 2]; f[base + 3] = 0;
      f[base + 4] = C[row * 6 + 3]; f[base + 5] = C[row * 6 + 4]; f[base + 6] = C[row * 6 + 5]; f[base + 7] = 0;
    }
  }
  pack(C_s, 0);    /* floats 0..47  */
  pack(C_v, 48);   /* floats 48..95 */
  u[0] = this.N3;
  d.queue.writeBuffer(this.stiffBuf, 0, buf);

  /* Γ⁰ constants: mu0 = C_s[21], lam0 = C_s[1], β = (λ+μ)/(λ+2μ) */
  var mu0 = C_s[21], lam0 = C_s[1];
  var beta = (lam0 + mu0) / (lam0 + 2 * mu0);
  var gb = new ArrayBuffer(16);
  new Float32Array(gb, 0, 2).set([mu0, beta]);
  new Uint32Array(gb, 8, 2).set([this.N, this.N3]);
  d.queue.writeBuffer(this.gammaBuf, 0, gb);
};

/* ── Per-axis pre-stress upload ──────────────────────────────
   sigma0: [6 × Float32Array(N³)] in Voigt order [xx,yy,zz,yz,xz,xy].
   Packed into s0n=[s0,s1,s2,0], s0s=[s3,s4,s5,0]. */
BucklingSolverGPU.prototype.uploadSigma0 = function(sigma0) {
  var N3 = this.N3;
  var n = new Float32Array(4 * N3), s = new Float32Array(4 * N3);
  for (var i = 0; i < N3; i++) {
    var b = 4 * i;
    n[b + 0] = sigma0[0][i]; n[b + 1] = sigma0[1][i]; n[b + 2] = sigma0[2][i]; n[b + 3] = 0;
    s[b + 0] = sigma0[3][i]; s[b + 1] = sigma0[4][i]; s[b + 2] = sigma0[5][i]; s[b + 3] = 0;
  }
  this.device.queue.writeBuffer(this.s0n, 0, n);
  this.device.queue.writeBuffer(this.s0s, 0, s);
};


/* ── Low-level dispatch + FFT helpers ────────────────────────── */
BucklingSolverGPU.prototype._dispatch = function(enc, pipe, bg, threads, wg) {
  var pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(threads / wg), 1, 1);
  pass.end();
};

BucklingSolverGPU.prototype._fftFwd = function(enc, srcC, dstC) {
  this.fft.loadFromBuffer(enc, srcC);
  this.fft.forwardEncoded(enc);
  this.fft.storeToBuffer(enc, dstC);
};
BucklingSolverGPU.prototype._fftInv = function(enc, srcC, dstC) {
  this.fft.loadFromBuffer(enc, srcC);
  this.fft.inverseEncoded(enc);
  this.fft.storeToBuffer(enc, dstC);
};

BucklingSolverGPU.prototype._extractLane = function(enc, srcV4, lane, dstC) {
  var bg = this.device.createBindGroup({ layout: this.exLayout, entries: [
    { binding: 0, resource: { buffer: srcV4 } },
    { binding: 1, resource: { buffer: dstC } },
    { binding: 2, resource: { buffer: this.exBufs[lane] } }
  ] });
  this._dispatch(enc, this.exPipe, bg, this.N3, 64);
};

BucklingSolverGPU.prototype._writeLane = function(enc, srcC, lane, neg, dstV4) {
  var uni = neg ? this.wlNeg[lane] : this.wlPos[lane];
  var bg = this.device.createBindGroup({ layout: this.wlLayout, entries: [
    { binding: 0, resource: { buffer: dstV4 } },
    { binding: 1, resource: { buffer: srcC } },
    { binding: 2, resource: { buffer: uni } }
  ] });
  this._dispatch(enc, this.wlPipe, bg, this.N3, 64);
};

BucklingSolverGPU.prototype._specIk = function(enc, srcC, dir, dstC, accum) {
  var bg = this.device.createBindGroup({ layout: this.ikLayout, entries: [
    { binding: 0, resource: { buffer: srcC } },
    { binding: 1, resource: { buffer: dstC } },
    { binding: 2, resource: { buffer: this.ikBufs[dir] } }
  ] });
  this._dispatch(enc, accum ? this.ikAPipe : this.ikWPipe, bg, this.N3, 64);
};

BucklingSolverGPU.prototype._localStress = function(enc) {
  var bg = this.device.createBindGroup({ layout: this.lsLayout, entries: [
    { binding: 0, resource: { buffer: this.solidBuf } },
    { binding: 1, resource: { buffer: this.epsN } },
    { binding: 2, resource: { buffer: this.epsS } },
    { binding: 3, resource: { buffer: this.sigN } },
    { binding: 4, resource: { buffer: this.sigS } },
    { binding: 5, resource: { buffer: this.stiffBuf } }
  ] });
  this._dispatch(enc, this.lsPipe, bg, this.N3, 64);
};


/* ════════════════════════════════════════════════════════════
   _applyK — (K u)_i = −∂_j ( C_ijkl(x) ε_kl(u) )

   Spectral path (mirrors applyKcpu in 16c, FFT-efficient form):
     1. û_k = FFT(u_k)  for k = x,y,z               (3 fwd FFT)
     2. ε̂ from û in spectral space (i·κ combos)     (write/accum)
     3. ε = IFFT(ε̂)  packed into eps{n,s}            (6 inv FFT)
     4. σ = C(x):ε                                   (local stress)
     5. σ̂ = FFT(σ)                                   (6 fwd FFT)
     6. out_i = −IFFT(i·κ_j σ̂_ij)                    (3 inv FFT)
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype._applyK = function(enc, inV4, outV4) {
  /* 1. û_k */
  for (var k = 0; k < 3; k++) {
    this._extractLane(enc, inV4, k, this.cA);
    this._fftFwd(enc, this.cA, this.uhat[k]);
  }
  /* 2. spectral strain ê (engineering Voigt) */
  this._specIk(enc, this.uhat[0], 0, this.hat6[0], false);                              /* ε_xx = ∂x u_x */
  this._specIk(enc, this.uhat[1], 1, this.hat6[1], false);                              /* ε_yy = ∂y u_y */
  this._specIk(enc, this.uhat[2], 2, this.hat6[2], false);                              /* ε_zz = ∂z u_z */
  this._specIk(enc, this.uhat[2], 1, this.hat6[3], false);                              /* γ_yz = ∂y u_z + ∂z u_y */
  this._specIk(enc, this.uhat[1], 2, this.hat6[3], true);
  this._specIk(enc, this.uhat[2], 0, this.hat6[4], false);                              /* γ_xz = ∂x u_z + ∂z u_x */
  this._specIk(enc, this.uhat[0], 2, this.hat6[4], true);
  this._specIk(enc, this.uhat[1], 0, this.hat6[5], false);                              /* γ_xy = ∂x u_y + ∂y u_x */
  this._specIk(enc, this.uhat[0], 1, this.hat6[5], true);
  /* 3. ε = IFFT(ê) → eps{n,s} */
  for (var P = 0; P < 6; P++) {
    this._fftInv(enc, this.hat6[P], this.cA);
    var dst = (P < 3) ? this.epsN : this.epsS;
    this._writeLane(enc, this.cA, P % 3, false, dst);
  }
  /* 4. σ = C(x):ε */
  this._localStress(enc);
  /* 5. σ̂ = FFT(σ) */
  for (var Q = 0; Q < 6; Q++) {
    var src = (Q < 3) ? this.sigN : this.sigS;
    this._extractLane(enc, src, Q % 3, this.cA);
    this._fftFwd(enc, this.cA, this.hat6[Q]);
  }
  /* 6. out_i = −∂_j σ_ij.  σ tensor: [[0,5,4],[5,1,3],[4,3,2]] */
  /* out_x = −(∂x ŝ0 + ∂y ŝ5 + ∂z ŝ4) */
  this._specIk(enc, this.hat6[0], 0, this.ohat, false);
  this._specIk(enc, this.hat6[5], 1, this.ohat, true);
  this._specIk(enc, this.hat6[4], 2, this.ohat, true);
  this._fftInv(enc, this.ohat, this.cA);
  this._writeLane(enc, this.cA, 0, true, outV4);
  /* out_y = −(∂x ŝ5 + ∂y ŝ1 + ∂z ŝ3) */
  this._specIk(enc, this.hat6[5], 0, this.ohat, false);
  this._specIk(enc, this.hat6[1], 1, this.ohat, true);
  this._specIk(enc, this.hat6[3], 2, this.ohat, true);
  this._fftInv(enc, this.ohat, this.cA);
  this._writeLane(enc, this.cA, 1, true, outV4);
  /* out_z = −(∂x ŝ4 + ∂y ŝ3 + ∂z ŝ2) */
  this._specIk(enc, this.hat6[4], 0, this.ohat, false);
  this._specIk(enc, this.hat6[3], 1, this.ohat, true);
  this._specIk(enc, this.hat6[2], 2, this.ohat, true);
  this._fftInv(enc, this.ohat, this.cA);
  this._writeLane(enc, this.cA, 2, true, outV4);
};


/* ════════════════════════════════════════════════════════════
   _applyKg — (K_g u)_k = −∂_i ( σ⁰_ij(x) ∂_j u_k )

   Per displacement component k:
     a. û_k = FFT(u_k)                               (1 fwd FFT)
     b. g_j = ∂_j u_k = IFFT(i·κ_j û_k)              (3 inv FFT)
     c. f_i = σ⁰_ij g_j                              (kg flux)
     d. out_k = −∂_i f_i = −IFFT(i·κ_i FFT(f_i))     (3 fwd + 1 inv)
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype._applyKg = function(enc, inV4, outV4) {
  for (var k = 0; k < 3; k++) {
    /* a. û_k */
    this._extractLane(enc, inV4, k, this.cA);
    this._fftFwd(enc, this.cA, this.uhat[0]);
    /* b. gradient → gV4 lanes 0,1,2 */
    for (var j = 0; j < 3; j++) {
      this._specIk(enc, this.uhat[0], j, this.ohat, false);
      this._fftInv(enc, this.ohat, this.cA);
      this._writeLane(enc, this.cA, j, false, this.gV4);
    }
    /* c. flux f = σ⁰ g */
    var fbg = this.device.createBindGroup({ layout: this.kgLayout, entries: [
      { binding: 0, resource: { buffer: this.gV4 } },
      { binding: 1, resource: { buffer: this.s0n } },
      { binding: 2, resource: { buffer: this.s0s } },
      { binding: 3, resource: { buffer: this.fV4 } },
      { binding: 4, resource: { buffer: this.sizeBuf } }
    ] });
    this._dispatch(enc, this.kgPipe, fbg, this.N3, 64);
    /* d. out_k = −div(f) */
    this._extractLane(enc, this.fV4, 0, this.cA); this._fftFwd(enc, this.cA, this.hat6[0]);
    this._extractLane(enc, this.fV4, 1, this.cA); this._fftFwd(enc, this.cA, this.hat6[1]);
    this._extractLane(enc, this.fV4, 2, this.cA); this._fftFwd(enc, this.cA, this.hat6[2]);
    this._specIk(enc, this.hat6[0], 0, this.ohat, false);
    this._specIk(enc, this.hat6[1], 1, this.ohat, true);
    this._specIk(enc, this.hat6[2], 2, this.ohat, true);
    this._fftInv(enc, this.ohat, this.cA);
    this._writeLane(enc, this.cA, k, true, outV4);
  }
};


/* ════════════════════════════════════════════════════════════
   _precondGamma0 — z = Γ⁰ r  (FFT-diagonal Christoffel inverse)
     forward-FFT each component → diagonal 3×3 multiply → inverse-FFT
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype._precondGamma0 = function(enc, inV4, outV4) {
  for (var k = 0; k < 3; k++) {
    this._extractLane(enc, inV4, k, this.cA);
    this._fftFwd(enc, this.cA, this.uhat[k]);
  }
  var bg = this.device.createBindGroup({ layout: this.g0Layout, entries: [
    { binding: 0, resource: { buffer: this.uhat[0] } },
    { binding: 1, resource: { buffer: this.uhat[1] } },
    { binding: 2, resource: { buffer: this.uhat[2] } },
    { binding: 3, resource: { buffer: this.hat6[0] } },
    { binding: 4, resource: { buffer: this.hat6[1] } },
    { binding: 5, resource: { buffer: this.hat6[2] } },
    { binding: 6, resource: { buffer: this.gammaBuf } }
  ] });
  this._dispatch(enc, this.g0Pipe, bg, this.N3, 64);
  for (var k2 = 0; k2 < 3; k2++) {
    this._fftInv(enc, this.hat6[k2], this.cA);
    this._writeLane(enc, this.cA, k2, false, outV4);
  }
};


/* ── BLAS-1 (vec4 xyz) ───────────────────────────────────────── */
BucklingSolverGPU.prototype._axpy3 = function(enc, alpha, xBuf, yBuf) {
  var ab = new ArrayBuffer(16);
  new Float32Array(ab, 0, 1)[0] = alpha;
  new Uint32Array(ab, 4, 1)[0] = this.N3;
  this.device.queue.writeBuffer(this.axBuf, 0, ab);
  var bg = this.device.createBindGroup({ layout: this.axLayout, entries: [
    { binding: 0, resource: { buffer: xBuf } },
    { binding: 1, resource: { buffer: yBuf } },
    { binding: 2, resource: { buffer: this.axBuf } }
  ] });
  this._dispatch(enc, this.axPipe, bg, this.N3, 64);
};

BucklingSolverGPU.prototype._xbpy3 = function(enc, beta, xBuf, yBuf) {
  var ab = new ArrayBuffer(16);
  new Float32Array(ab, 0, 1)[0] = beta;
  new Uint32Array(ab, 4, 1)[0] = this.N3;
  this.device.queue.writeBuffer(this.xbBuf, 0, ab);
  var bg = this.device.createBindGroup({ layout: this.axLayout, entries: [
    { binding: 0, resource: { buffer: xBuf } },
    { binding: 1, resource: { buffer: yBuf } },
    { binding: 2, resource: { buffer: this.xbBuf } }
  ] });
  this._dispatch(enc, this.xbPipe, bg, this.N3, 64);
};

BucklingSolverGPU.prototype._copy3 = function(enc, srcBuf, dstBuf) {
  enc.copyBufferToBuffer(srcBuf, 0, dstBuf, 0, this.v4Size);
};

/* dot3 — Σ (a.xyz · b.xyz).  Own encoder + readback (async). */
BucklingSolverGPU.prototype._dot3 = async function(aBuf, bBuf) {
  var d = this.device;
  var enc = d.createCommandEncoder();
  var bg = d.createBindGroup({ layout: this.dotLayout, entries: [
    { binding: 0, resource: { buffer: aBuf } },
    { binding: 1, resource: { buffer: bBuf } },
    { binding: 2, resource: { buffer: this.partF } },
    { binding: 3, resource: { buffer: this.sizeBuf } }
  ] });
  var pass = enc.beginComputePass();
  pass.setPipeline(this.dotPipe); pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(this.partialCount, 1, 1);
  pass.end();
  enc.copyBufferToBuffer(this.partF, 0, this.rbF, 0, this.partialCount * 4);
  d.queue.submit([enc.finish()]);
  await this.rbF.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(this.rbF.getMappedRange().slice(0));
  this.rbF.unmap();
  var s = 0; for (var i = 0; i < this.partialCount; i++) s += v[i];
  return s;
};

/* zero-mean projection — subtract the per-component mean (matches
   bk_zeroMeanFlat).  Own encoders + one readback. */
BucklingSolverGPU.prototype._zeroMean3 = async function(buf) {
  var d = this.device;
  var enc = d.createCommandEncoder();
  var bg = d.createBindGroup({ layout: this.sumLayout, entries: [
    { binding: 0, resource: { buffer: buf } },
    { binding: 1, resource: { buffer: this.part4 } },
    { binding: 2, resource: { buffer: this.sizeBuf } }
  ] });
  var pass = enc.beginComputePass();
  pass.setPipeline(this.sumPipe); pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(this.partialCount, 1, 1);
  pass.end();
  enc.copyBufferToBuffer(this.part4, 0, this.rb4, 0, this.partialCount * 16);
  d.queue.submit([enc.finish()]);
  await this.rb4.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(this.rb4.getMappedRange().slice(0));
  this.rb4.unmap();
  var s0 = 0, s1 = 0, s2 = 0;
  for (var i = 0; i < this.partialCount; i++) { var b = 4 * i; s0 += v[b]; s1 += v[b + 1]; s2 += v[b + 2]; }
  var m0 = s0 / this.N3, m1 = s1 / this.N3, m2 = s2 / this.N3;

  var sb = new ArrayBuffer(32);
  new Float32Array(sb, 0, 3).set([m0, m1, m2]);
  new Uint32Array(sb, 16, 1)[0] = this.N3;
  d.queue.writeBuffer(this.subBuf, 0, sb);
  var enc2 = d.createCommandEncoder();
  var bg2 = d.createBindGroup({ layout: this.scLayout, entries: [
    { binding: 0, resource: { buffer: buf } },
    { binding: 1, resource: { buffer: this.subBuf } }
  ] });
  this._dispatch(enc2, this.scPipe, bg2, this.N3, 64);
  d.queue.submit([enc2.finish()]);
};


/* ── flat 3·N³ ↔ vec4 buffer transfer (host side) ────────────── */
BucklingSolverGPU.prototype._upload3 = function(flat, dstBuf) {
  var N3 = this.N3, v = new Float32Array(4 * N3);
  for (var i = 0; i < N3; i++) {
    var b = 4 * i;
    v[b + 0] = flat[i]; v[b + 1] = flat[N3 + i]; v[b + 2] = flat[2 * N3 + i]; v[b + 3] = 0;
  }
  this.device.queue.writeBuffer(dstBuf, 0, v);
};

BucklingSolverGPU.prototype._readback3 = async function(srcBuf) {
  var d = this.device, V = this.v4Size;
  var rb = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(srcBuf, 0, rb, 0, V);
  d.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(rb.getMappedRange().slice(0));
  rb.unmap(); rb.destroy();
  var N3 = this.N3, flat = new Float32Array(3 * N3);
  for (var i = 0; i < N3; i++) {
    var b = 4 * i;
    flat[i] = v[b + 0]; flat[N3 + i] = v[b + 1]; flat[2 * N3 + i] = v[b + 2];
  }
  return flat;
};


/* ════════════════════════════════════════════════════════════
   pcgSolveK — solveB: K x = b on the zero-mean subspace, Γ⁰-
   preconditioned.  Mirrors bk_pcgSolveK (16c) step-for-step:
   r,z,Ap,x are zero-mean projected exactly as the CPU reference.

   bBuf: vec4 displacement RHS (already resident on GPU).
   opts: { tol (1e-5 default for f32), maxiter (2000) }
   Returns { iters, relres, converged }; solution left in this.pcgX.
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype.pcgSolveK = async function(bBuf, opts) {
  opts = opts || {};
  var tol = (opts.tol != null) ? opts.tol : 1e-5;   /* relaxed for f32 */
  var maxiter = opts.maxiter || 2000;
  var d = this.device;

  /* x = 0 */
  var encZ = d.createCommandEncoder();
  this._axpy3(encZ, -1.0, this.pcgX, this.pcgX);    /* x -= x  ⇒ x = 0 */
  d.queue.submit([encZ.finish()]);

  /* r = b; zeroMean(r) */
  var encR = d.createCommandEncoder();
  this._copy3(encR, bBuf, this.pcgR);
  d.queue.submit([encR.finish()]);
  await this._zeroMean3(this.pcgR);

  /* z = Minv r; zeroMean(z); p = z */
  var encZ2 = d.createCommandEncoder();
  this._precondGamma0(encZ2, this.pcgR, this.pcgZ);
  d.queue.submit([encZ2.finish()]);
  await this._zeroMean3(this.pcgZ);
  var encP = d.createCommandEncoder();
  this._copy3(encP, this.pcgZ, this.pcgP);
  d.queue.submit([encP.finish()]);

  var rz = await this._dot3(this.pcgR, this.pcgZ);
  var bn = Math.sqrt(await this._dot3(this.pcgR, this.pcgR)) + 1e-30;
  var iters = 0, converged = false, relres = 1;

  for (var it = 0; it < maxiter; it++) {
    iters = it + 1;
    /* Ap = K p; zeroMean(Ap) */
    var encA = d.createCommandEncoder();
    this._applyK(encA, this.pcgP, this.pcgAp);
    d.queue.submit([encA.finish()]);
    await this._zeroMean3(this.pcgAp);

    var pAp = await this._dot3(this.pcgP, this.pcgAp);
    if (Math.abs(pAp) < 1e-30) break;
    var alpha = rz / pAp;

    var encX = d.createCommandEncoder();
    this._axpy3(encX, alpha, this.pcgP, this.pcgX);
    d.queue.submit([encX.finish()]);
    var encRr = d.createCommandEncoder();
    this._axpy3(encRr, -alpha, this.pcgAp, this.pcgR);
    d.queue.submit([encRr.finish()]);

    relres = Math.sqrt(await this._dot3(this.pcgR, this.pcgR)) / bn;
    if (relres < tol) { converged = true; break; }

    var encZ3 = d.createCommandEncoder();
    this._precondGamma0(encZ3, this.pcgR, this.pcgZ);
    d.queue.submit([encZ3.finish()]);
    await this._zeroMean3(this.pcgZ);

    var rzNew = await this._dot3(this.pcgR, this.pcgZ);
    var beta = rzNew / rz;
    var encPp = d.createCommandEncoder();
    this._xbpy3(encPp, beta, this.pcgZ, this.pcgP);   /* p = z + beta·p */
    d.queue.submit([encPp.finish()]);
    rz = rzNew;
  }
  await this._zeroMean3(this.pcgX);
  return { iters: iters, relres: relres, converged: converged };
};


/* ── Cleanup (FFT plan owned externally — not destroyed here) ── */
BucklingSolverGPU.prototype.destroy = function() {
  var bufs = [this.solidBuf, this.s0n, this.s0s, this.epsN, this.epsS, this.sigN, this.sigS,
              this.gV4, this.fV4, this.cA, this.ohat, this.pcgX, this.pcgR, this.pcgZ,
              this.pcgP, this.pcgAp, this.partF, this.rbF, this.part4, this.rb4,
              this.stiffBuf, this.sizeBuf, this.gammaBuf, this.axBuf, this.xbBuf, this.subBuf];
  bufs = bufs.concat(this.uhat, this.hat6, this.exBufs, this.wlPos, this.wlNeg, this.ikBufs);
  for (var i = 0; i < bufs.length; i++) { if (bufs[i] && bufs[i].destroy) bufs[i].destroy(); }
};


/* ════════════════════════════════════════════════════════════
   runBucklingGPUTest — Push 1 in-browser GPU↔CPU parity gates.

   Requires the CPU oracle (16c) + isoC (14) loaded on the page.
   The node harness cannot run this (no WebGPU); it is the in-app
   reconfirmation, mirroring runFullVoigtGPUTest.

     P1. applyK   parity vs applyKcpu              (rel < 1e-3)
     P2. applyKg  parity vs applyKgcpu             (rel < 1e-3)
     P3. Γ⁰ precond parity vs bk_makePrecondGamma0 (rel < 1e-3)
     P4. PCG-K  solveB vs bk_pcgSolveK             (rel < 5e-3,
         comparable iteration count)

   Returns { passed, gates, N }.
   ════════════════════════════════════════════════════════════ */
async function runBucklingGPUTest(N) {
  N = N || 16;
  if (typeof ensureDevice === 'function') { await ensureDevice(); }
  if (!WGPU.device) throw new Error('runBucklingGPUTest: no WebGPU device');

  var N3 = N * N * N;
  var C_s = isoC(110000, 0.34);
  var C_v = isoC(11, 0.34);                 /* Es·1e-4 */
  var ws = getBucklingWorkspaceCPU(N);

  /* deterministic pseudo-random helpers (so CPU & GPU see identical data) */
  function mulberry32(seed) { return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }; }
  function randField3(seed) {
    var r = mulberry32(seed), x = new Float64Array(3 * N3);
    for (var i = 0; i < 3 * N3; i++) x[i] = r() * 2 - 1;
    bk_zeroMeanFlat(x, N3);
    return x;
  }
  function relErr(gpu, cpu) {
    var num = 0, den = 0;
    for (var i = 0; i < cpu.length; i++) { var dd = gpu[i] - cpu[i]; num += dd * dd; den += cpu[i] * cpu[i]; }
    return Math.sqrt(num) / (Math.sqrt(den) + 1e-30);
  }
  function flatToField(x) {
    return [x.subarray(0, N3), x.subarray(N3, 2 * N3), x.subarray(2 * N3, 3 * N3)];
  }

  /* synthetic solid: deterministic ~50% fill (geometry need not be physical
     for operator parity — only that CPU & GPU rasterize identically) */
  var rs = mulberry32(99), solid = new Uint8Array(N3), solidF = new Float32Array(N3);
  for (var i = 0; i < N3; i++) { var v = rs() > 0.5 ? 1 : 0; solid[i] = v; solidF[i] = v; }

  /* shared FFT plan (matches solveDesignElasticFull caching) */
  var fft;
  if (typeof window !== 'undefined' && window.__sharedFFT && window.__sharedFFT.N === N) {
    fft = window.__sharedFFT;
  } else {
    fft = new FFTPlan(N);
    if (typeof window !== 'undefined') { if (window.__sharedFFT) window.__sharedFFT.destroy(); window.__sharedFFT = fft; }
  }
  var solver = new BucklingSolverGPU(N, fft);
  solver.uploadDesign(solidF, C_s, C_v);

  var gates = {};

  /* ── P1: applyK parity ── */
  var uK = randField3(11);
  var uKf = flatToField(uK);
  var oKcpu3 = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  applyKcpu(uKf, oKcpu3, solid, C_s, C_v, N, ws);
  var oKcpu = new Float64Array(3 * N3); bk_fieldToFlat(oKcpu3, N3, oKcpu);
  solver._upload3(uK, solver.pcgP);                  /* reuse pcgP as input scratch */
  var encK = WGPU.device.createCommandEncoder();
  solver._applyK(encK, solver.pcgP, solver.pcgAp);
  WGPU.device.queue.submit([encK.finish()]);
  var oKgpu = await solver._readback3(solver.pcgAp);
  var eK = relErr(oKgpu, oKcpu);
  gates.applyK = { relErr: eK, pass: eK < 1e-3 };

  /* ── P2: applyKg parity (uniform compressive σ⁰_xx = −S) ── */
  var S = 1000;
  var sig0 = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3),
              new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  for (var q = 0; q < N3; q++) sig0[0][q] = -S;       /* σ⁰_xx only */
  var sig0f = sig0.map(function (a) { var f = new Float32Array(N3); f.set(a); return f; });
  var uG = randField3(22), uGf = flatToField(uG);
  var oGcpu3 = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  applyKgcpu(uGf, oGcpu3, sig0, N, ws);
  var oGcpu = new Float64Array(3 * N3); bk_fieldToFlat(oGcpu3, N3, oGcpu);
  solver.uploadSigma0(sig0f);
  solver._upload3(uG, solver.pcgP);
  var encG = WGPU.device.createCommandEncoder();
  solver._applyKg(encG, solver.pcgP, solver.pcgAp);
  WGPU.device.queue.submit([encG.finish()]);
  var oGgpu = await solver._readback3(solver.pcgAp);
  var eG = relErr(oGgpu, oGcpu);
  gates.applyKg = { relErr: eG, pass: eG < 1e-3 };

  /* ── P3: Γ⁰ precond parity ── */
  var rP = randField3(33);
  var minv = bk_makePrecondGamma0(N, C_s[21], C_s[1]);
  var zPcpu = new Float64Array(3 * N3); minv(rP, zPcpu);
  solver._upload3(rP, solver.pcgR);
  var encP = WGPU.device.createCommandEncoder();
  solver._precondGamma0(encP, solver.pcgR, solver.pcgZ);
  WGPU.device.queue.submit([encP.finish()]);
  var zPgpu = await solver._readback3(solver.pcgZ);
  var eP = relErr(zPgpu, zPcpu);
  gates.precondGamma0 = { relErr: eP, pass: eP < 1e-3 };

  /* ── P4: PCG-K solveB parity ── */
  var bV = randField3(44);
  var applyKflat = function (xx, out) {
    var uf = flatToField(xx), of = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
    applyKcpu(uf, of, solid, C_s, C_v, N, ws); bk_fieldToFlat(of, N3, out);
  };
  var solCpu = bk_pcgSolveK(applyKflat, minv, bV, 3 * N3, N3, 1e-9, 2000);
  var bBufGpu = solver.gV4;                            /* reuse gV4 as RHS scratch */
  solver._upload3(bV, bBufGpu);
  var solGpu = await solver.pcgSolveK(bBufGpu, { tol: 1e-5, maxiter: 2000 });
  var xGpu = await solver._readback3(solver.pcgX);
  var eX = relErr(xGpu, solCpu.x);
  gates.pcgSolveK = {
    relErr: eX, itersGPU: solGpu.iters, itersCPU: solCpu.iters,
    relresGPU: solGpu.relres, pass: eX < 5e-3
  };

  solver.destroy();

  var passed = gates.applyK.pass && gates.applyKg.pass && gates.precondGamma0.pass && gates.pcgSolveK.pass;
  var report = { passed: passed, gates: gates, N: N };
  if (typeof console !== 'undefined') {
    console.log('[runBucklingGPUTest] N=' + N + ' → ' + (passed ? 'PASS' : 'FAIL'));
    console.table(gates);
  }
  return report;
}

/* Expose for the in-browser console / Push-2 wiring. */
if (typeof window !== 'undefined') {
  window.BucklingSolverGPU = BucklingSolverGPU;
  window.runBucklingGPUTest = runBucklingGPUTest;
}
