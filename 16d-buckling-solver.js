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

/* bk_add_lane: x_v4[i].lane += val  (read-modify-write).  Used to build
   the constant macro strain ε̄ = val·e_lane (after clearBuffer) and to add
   ε̄ back into the fluctuation strain ε(u′) during pre-stress. */
var BK_ADDLANE_WGSL =
'struct AddLaneP { val: f32, total: u32, lane: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<uniform>             P: AddLaneP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_add_lane(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  var o = x_v4[i];\n' +
'  switch (P.lane) { case 0u: { o.x = o.x + P.val; } case 1u: { o.y = o.y + P.val; } case 2u: { o.z = o.z + P.val; } default: {} }\n' +
'  x_v4[i] = o;\n' +
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

var BK_SCALE3_WGSL =
'struct AxP { alpha: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> y_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<uniform>             P: AxP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_scale3(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y_v4[i] = P.alpha * y_v4[i];\n' +
'}\n';

/* ─── GPU-resident scalar path (Step 6b) ─────────────────────
   Scalars live in a small GPU buffer `sclr` (slots: 0=rz, 1=pAp,
   2=rr, 3=alpha, 4=-alpha, 5=rzNew, 6=beta).  Dots write a slot,
   a 1-thread kernel does the divisions, and the BLAS reads its
   coefficient from a slot — so a CG iteration enqueues with no
   CPU readback.  Convergence is checked by reading slot 2 only
   every few iterations. */

/* bk_dot3_r: single-workgroup grid-stride dot → sclr[slot]. */
var BK_DOT3_R_WGSL =
'struct DotRP { total: u32, slot: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       a_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       b_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> sclr: array<f32>;\n' +
'@group(0) @binding(3) var<uniform>             P: DotRP;\n' +
'var<workgroup> sdata: array<f32, 256>;\n' +
'@compute @workgroup_size(256)\n' +
'fn bk_dot3_r(@builtin(local_invocation_id) lid: vec3<u32>) {\n' +
'  let tid = lid.x;\n' +
'  var s: f32 = 0.0;\n' +
'  var i: u32 = tid;\n' +
'  loop { if (i >= P.total) { break; } s = s + dot(a_v4[i].xyz, b_v4[i].xyz); i = i + 256u; }\n' +
'  sdata[tid] = s;\n' +
'  workgroupBarrier();\n' +
'  var stride: u32 = 128u;\n' +
'  loop {\n' +
'    if (tid < stride) { sdata[tid] = sdata[tid] + sdata[tid + stride]; }\n' +
'    workgroupBarrier();\n' +
'    if (stride == 1u) { break; }\n' +
'    stride = stride >> 1u;\n' +
'  }\n' +
'  if (tid == 0u) { sclr[P.slot] = sdata[0]; }\n' +
'}\n';

/* bk_scalar_op: 1-thread coefficient arithmetic on sclr.
   op 0: alpha = rz/pAp, negAlpha = −alpha.
   op 1: beta = rzNew/rz, then rz = rzNew. */
var BK_SCALAR_OP_WGSL =
'struct OpP { op: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> sclr: array<f32>;\n' +
'@group(0) @binding(1) var<uniform>             P: OpP;\n' +
'@compute @workgroup_size(1)\n' +
'fn bk_scalar_op() {\n' +
'  if (P.op == 0u) {\n' +
'    let a = sclr[0] / sclr[1];\n' +
'    sclr[3] = a; sclr[4] = -a;\n' +
'  } else {\n' +
'    let b = sclr[5] / sclr[0];\n' +
'    sclr[6] = b; sclr[0] = sclr[5];\n' +
'  }\n' +
'}\n';

/* bk_axpy3_r: y += sclr[slot]·x  (coefficient read from GPU buffer). */
var BK_AXPY3_R_WGSL =
'struct AxrP { slot: u32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> y_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       sclr: array<f32>;\n' +
'@group(0) @binding(3) var<uniform>             P: AxrP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_axpy3_r(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y_v4[i] = y_v4[i] + sclr[P.slot] * x_v4[i];\n' +
'}\n';

/* bk_xbpy3_r: y = x + sclr[slot]·y. */
var BK_XBPY3_R_WGSL =
'struct AxrP { slot: u32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> y_v4: array<vec4<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       sclr: array<f32>;\n' +
'@group(0) @binding(3) var<uniform>             P: AxrP;\n' +
'@compute @workgroup_size(64)\n' +
'fn bk_xbpy3_r(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y_v4[i] = x_v4[i] + sclr[P.slot] * y_v4[i];\n' +
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
  this.alPipe    = pipe(this.scLayout, BK_ADDLANE_WGSL, 'bk_add_lane');
  this.sclPipe   = pipe(this.scLayout, BK_SCALE3_WGSL, 'bk_scale3');

  /* resident scalar path (Step 6b) */
  this.dotRPipe   = pipe(this.dotLayout, BK_DOT3_R_WGSL, 'bk_dot3_r');     /* [ro,ro,rw,uni] */
  this.opPipe     = pipe(this.scLayout, BK_SCALAR_OP_WGSL, 'bk_scalar_op'); /* [rw,uni] */
  this.axrLayout  = d.createBindGroupLayout({ entries: [ro(0), rw(1), ro(2), uni(3)] });
  this.axrPipe    = pipe(this.axrLayout, BK_AXPY3_R_WGSL, 'bk_axpy3_r');
  this.xbrPipe    = pipe(this.axrLayout, BK_XBPY3_R_WGSL, 'bk_xbpy3_r');
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

  /* resident scalar buffer (16 f32 slots) + its readback */
  this.sclr   = d.createBuffer({ size: 64, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });
  this.sclrRB = d.createBuffer({ size: 64, usage: BU.COPY_DST | BU.MAP_READ });
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

  /* add-lane uniform (val/lane written per call — setup-time, not hot path) */
  this.alBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* scale3 uniform (alpha written per call) */
  this.scaleBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* resident-path pre-baked uniforms (no per-iteration writeBuffer):
     dotRBufs[slot] = {total, slot}; arBufs[slot] = {slot, total}; opBufs[op] = {op} */
  this.dotRBufs = []; this.arBufs = [];
  for (var sl = 0; sl < 16; sl++) {
    var drb = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    d.queue.writeBuffer(drb, 0, new Uint32Array([N3, sl, 0, 0]));
    this.dotRBufs.push(drb);
    var arb = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    d.queue.writeBuffer(arb, 0, new Uint32Array([sl, N3, 0, 0]));
    this.arBufs.push(arb);
  }
  this.opBufs = [];
  for (var op = 0; op < 2; op++) {
    var ob = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    d.queue.writeBuffer(ob, 0, new Uint32Array([op, 0, 0, 0]));
    this.opBufs.push(ob);
  }
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
/* _strainFromU — ε(u) → eps{n,s}.  Steps 1–3 of K: forward-FFT each
   displacement component, build the engineering-Voigt strain in spectral
   space (i·κ combos), inverse-FFT into the eps{n,s} split. */
BucklingSolverGPU.prototype._strainFromU = function(enc, inV4) {
  for (var k = 0; k < 3; k++) {
    this._extractLane(enc, inV4, k, this.cA);
    this._fftFwd(enc, this.cA, this.uhat[k]);
  }
  this._specIk(enc, this.uhat[0], 0, this.hat6[0], false);                              /* ε_xx = ∂x u_x */
  this._specIk(enc, this.uhat[1], 1, this.hat6[1], false);                              /* ε_yy = ∂y u_y */
  this._specIk(enc, this.uhat[2], 2, this.hat6[2], false);                              /* ε_zz = ∂z u_z */
  this._specIk(enc, this.uhat[2], 1, this.hat6[3], false);                              /* γ_yz = ∂y u_z + ∂z u_y */
  this._specIk(enc, this.uhat[1], 2, this.hat6[3], true);
  this._specIk(enc, this.uhat[2], 0, this.hat6[4], false);                              /* γ_xz = ∂x u_z + ∂z u_x */
  this._specIk(enc, this.uhat[0], 2, this.hat6[4], true);
  this._specIk(enc, this.uhat[1], 0, this.hat6[5], false);                              /* γ_xy = ∂x u_y + ∂y u_x */
  this._specIk(enc, this.uhat[0], 1, this.hat6[5], true);
  for (var P = 0; P < 6; P++) {
    this._fftInv(enc, this.hat6[P], this.cA);
    var dst = (P < 3) ? this.epsN : this.epsS;
    this._writeLane(enc, this.cA, P % 3, false, dst);
  }
};

/* _divStress — outV4 = −∂_j σ_ij, reading the stress in sig{n,s}.
   Steps 5–6 of K (also the prestress RHS = −div(sb)).  σ tensor index
   map: [[0,5,4],[5,1,3],[4,3,2]]. */
BucklingSolverGPU.prototype._divStress = function(enc, outV4) {
  for (var Q = 0; Q < 6; Q++) {
    var src = (Q < 3) ? this.sigN : this.sigS;
    this._extractLane(enc, src, Q % 3, this.cA);
    this._fftFwd(enc, this.cA, this.hat6[Q]);
  }
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

BucklingSolverGPU.prototype._applyK = function(enc, inV4, outV4) {
  this._strainFromU(enc, inV4);   /* 1–3: ε(u) → eps{n,s} */
  this._localStress(enc);         /* 4:   σ = C(x):ε        */
  this._divStress(enc, outV4);    /* 5–6: out = −div(σ)     */
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

/* ─── resident-path dispatch helpers (enqueue only; no readback) ─── */
BucklingSolverGPU.prototype._dotR = function(enc, aBuf, bBuf, slot) {
  var bg = this.device.createBindGroup({ layout: this.dotLayout, entries: [
    { binding: 0, resource: { buffer: aBuf } },
    { binding: 1, resource: { buffer: bBuf } },
    { binding: 2, resource: { buffer: this.sclr } },
    { binding: 3, resource: { buffer: this.dotRBufs[slot] } }
  ] });
  var pass = enc.beginComputePass();
  pass.setPipeline(this.dotRPipe); pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(1, 1, 1);   /* single workgroup, grid-stride */
  pass.end();
};
BucklingSolverGPU.prototype._scalarOp = function(enc, op) {
  var bg = this.device.createBindGroup({ layout: this.scLayout, entries: [
    { binding: 0, resource: { buffer: this.sclr } },
    { binding: 1, resource: { buffer: this.opBufs[op] } }
  ] });
  var pass = enc.beginComputePass();
  pass.setPipeline(this.opPipe); pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(1, 1, 1);
  pass.end();
};
BucklingSolverGPU.prototype._axpyR = function(enc, slot, xBuf, yBuf) {
  var bg = this.device.createBindGroup({ layout: this.axrLayout, entries: [
    { binding: 0, resource: { buffer: xBuf } },
    { binding: 1, resource: { buffer: yBuf } },
    { binding: 2, resource: { buffer: this.sclr } },
    { binding: 3, resource: { buffer: this.arBufs[slot] } }
  ] });
  this._dispatch(enc, this.axrPipe, bg, this.N3, 64);
};
BucklingSolverGPU.prototype._xbpyR = function(enc, slot, xBuf, yBuf) {
  var bg = this.device.createBindGroup({ layout: this.axrLayout, entries: [
    { binding: 0, resource: { buffer: xBuf } },
    { binding: 1, resource: { buffer: yBuf } },
    { binding: 2, resource: { buffer: this.sclr } },
    { binding: 3, resource: { buffer: this.arBufs[slot] } }
  ] });
  this._dispatch(enc, this.xbrPipe, bg, this.N3, 64);
};
/* read one scalar slot back (the only sync point in the resident PCG). */
BucklingSolverGPU.prototype._readSclr = async function(slot) {
  var d = this.device;
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(this.sclr, 0, this.sclrRB, 0, 64);
  d.queue.submit([enc.finish()]);
  await this.sclrRB.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(this.sclrRB.getMappedRange().slice(0));
  this.sclrRB.unmap();
  return v[slot];
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

/* _laneSums3 — per-component sums [Σx, Σy, Σz] of a vec4 buffer.
   Own encoder + one readback. */
BucklingSolverGPU.prototype._laneSums3 = async function(buf) {
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
  return [s0, s1, s2];
};

/* zero-mean projection — subtract the per-component mean (matches
   bk_zeroMeanFlat). */
BucklingSolverGPU.prototype._zeroMean3 = async function(buf) {
  var d = this.device;
  var sums = await this._laneSums3(buf);
  var m0 = sums[0] / this.N3, m1 = sums[1] / this.N3, m2 = sums[2] / this.N3;
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

/* _addLane — buf[i].lane += val  (own encoder; setup-time op). */
BucklingSolverGPU.prototype._addLane = function(enc, buf, lane, val) {
  var ab = new ArrayBuffer(16);
  new Float32Array(ab, 0, 1)[0] = val;
  new Uint32Array(ab, 4, 2).set([this.N3, lane]);
  this.device.queue.writeBuffer(this.alBuf, 0, ab);
  var bg = this.device.createBindGroup({ layout: this.scLayout, entries: [
    { binding: 0, resource: { buffer: buf } },
    { binding: 1, resource: { buffer: this.alBuf } }
  ] });
  this._dispatch(enc, this.alPipe, bg, this.N3, 64);
};

/* _scale3 — buf.xyz *= s  (own dispatch). */
BucklingSolverGPU.prototype._scale3 = function(enc, buf, s) {
  var ab = new ArrayBuffer(16);
  new Float32Array(ab, 0, 1)[0] = s;
  new Uint32Array(ab, 4, 1)[0] = this.N3;
  this.device.queue.writeBuffer(this.scaleBuf, 0, ab);
  var bg = this.device.createBindGroup({ layout: this.scLayout, entries: [
    { binding: 0, resource: { buffer: buf } },
    { binding: 1, resource: { buffer: this.scaleBuf } }
  ] });
  this._dispatch(enc, this.sclPipe, bg, this.N3, 64);
};

/* _norm3 — ‖buf‖₂ over xyz lanes (async). */
BucklingSolverGPU.prototype._norm3 = async function(buf) {
  return Math.sqrt(await this._dot3(buf, buf));
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
   opts: { tol (1e-5 default for f32), maxiter (2000),
           lightProject (skip per-iter Ap/z zero-mean — safe because
           Γ⁰ annihilates the κ=0 mode and K's output is a divergence;
           used by the eigenloop's inexact inner solve to cut readbacks) }
   Returns { iters, relres, converged }; solution left in this.pcgX.
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype.pcgSolveK = async function(bBuf, opts) {
  opts = opts || {};
  var tol = (opts.tol != null) ? opts.tol : 1e-5;   /* relaxed for f32 */
  var maxiter = opts.maxiter || 2000;
  var light = !!opts.lightProject;
  var d = this.device;

  /* x = 0 — clearBuffer avoids aliasing one buffer as ro+rw in a dispatch */
  var encZ = d.createCommandEncoder();
  encZ.clearBuffer(this.pcgX);
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
    /* Ap = K p; zeroMean(Ap) — skipped in lightProject (Ap is a
       divergence, already zero-mean) */
    var encA = d.createCommandEncoder();
    this._applyK(encA, this.pcgP, this.pcgAp);
    d.queue.submit([encA.finish()]);
    if (!light) await this._zeroMean3(this.pcgAp);

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
    if (!light) await this._zeroMean3(this.pcgZ);

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


/* ════════════════════════════════════════════════════════════
   pcgSolveKResident — Step-6b GPU-resident PCG.  Identical math to
   pcgSolveK, but α/β and the dot products live in the on-GPU scalar
   buffer, so each CG iteration enqueues with NO readback.  A block
   of `checkEvery` iterations is batched into one encoder; only the
   residual (sclr slot 2) is read back, once per block, to test
   convergence.  Uses lightProject (Γ⁰ kills the κ=0 mode, K's output
   is a divergence — per-iter zero-mean is redundant).

   Solution left in this.pcgX.  Returns { iters, relres, converged }.
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype.pcgSolveKResident = async function(bBuf, opts) {
  opts = opts || {};
  var tol = (opts.tol != null) ? opts.tol : 1e-5;
  var maxiter = opts.maxiter || 2000;
  var checkEvery = opts.checkEvery || 16;
  var d = this.device;

  /* setup: x=0; r=b (zero-meaned once); z=Minv r; p=z */
  var encS = d.createCommandEncoder();
  encS.clearBuffer(this.pcgX);
  this._copy3(encS, bBuf, this.pcgR);
  d.queue.submit([encS.finish()]);
  await this._zeroMean3(this.pcgR);

  var encS2 = d.createCommandEncoder();
  this._precondGamma0(encS2, this.pcgR, this.pcgZ);
  this._copy3(encS2, this.pcgZ, this.pcgP);
  this._dotR(encS2, this.pcgR, this.pcgZ, 0);   /* rz  → slot 0 */
  this._dotR(encS2, this.pcgR, this.pcgR, 2);   /* rr0 → slot 2 (= ‖b‖²) */
  d.queue.submit([encS2.finish()]);
  var bn = Math.sqrt(await this._readSclr(2)) + 1e-30;

  var iters = 0, converged = false, relres = 1;

  while (iters < maxiter) {
    var enc = d.createCommandEncoder();
    var blockEnd = Math.min(iters + checkEvery, maxiter);
    for (var it = iters; it < blockEnd; it++) {
      this._applyK(enc, this.pcgP, this.pcgAp);     /* Ap = K p            */
      this._dotR(enc, this.pcgP, this.pcgAp, 1);    /* pAp → slot 1        */
      this._scalarOp(enc, 0);                       /* alpha, -alpha       */
      this._axpyR(enc, 3, this.pcgP, this.pcgX);    /* x += alpha p        */
      this._axpyR(enc, 4, this.pcgAp, this.pcgR);   /* r -= alpha Ap       */
      this._precondGamma0(enc, this.pcgR, this.pcgZ); /* z = Minv r        */
      this._dotR(enc, this.pcgR, this.pcgZ, 5);     /* rzNew → slot 5      */
      this._scalarOp(enc, 1);                       /* beta; rz = rzNew    */
      this._xbpyR(enc, 6, this.pcgZ, this.pcgP);    /* p = z + beta p      */
    }
    this._dotR(enc, this.pcgR, this.pcgR, 2);       /* rr → slot 2         */
    d.queue.submit([enc.finish()]);
    iters = blockEnd;

    var rr = await this._readSclr(2);
    relres = Math.sqrt(rr) / bn;
    if (!isFinite(relres)) break;                   /* breakdown guard     */
    if (relres < tol) { converged = true; break; }
  }

  await this._zeroMean3(this.pcgX);
  return { iters: iters, relres: relres, converged: converged };
};


/* ════════════════════════════════════════════════════════════
   extractPrestressGPU — microscopic pre-stress σ⁰(x) under unit
   compression along Voigt axis `axisVoigt` (0=xx,1=yy,2=zz).
   Mirrors extractPrestressCPU (16c):

     ε̄ = −e_axisVoigt                 (unit compression)
     sb = C(x):ε̄                       (constant-strain stress)
     RHS = −div(sb)                    (zero-meaned)
     K u′ = RHS                        (Γ⁰-preconditioned PCG)
     ε = ε̄ + ε(u′);  σ⁰ = C(x):ε
     σ̄_P = ⟨σ⁰_P⟩                      (volume average)

   On return, σ⁰ lives in sig{n,s} AND is copied into s0{n,s} so the
   Step-6 eigensolver's _applyKg can consume it directly.
   Returns { sBar[6], cgIters, cgConverged }.
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype.extractPrestressGPU = async function(axisVoigt, opts) {
  opts = opts || {};
  var d = this.device;
  var epsBarVal = -1.0;
  var laneBuf = (axisVoigt < 3) ? this.epsN : this.epsS;
  var lane = axisVoigt % 3;

  /* sb = C:ε̄  — build constant macro strain, then local stress */
  var enc1 = d.createCommandEncoder();
  enc1.clearBuffer(this.epsN);
  enc1.clearBuffer(this.epsS);
  this._addLane(enc1, laneBuf, lane, epsBarVal);     /* ε̄ = −e_axisVoigt */
  this._localStress(enc1);                            /* sig{n,s} = sb     */
  /* RHS = −div(sb) → gV4 */
  this._divStress(enc1, this.gV4);
  d.queue.submit([enc1.finish()]);
  await this._zeroMean3(this.gV4);

  /* solve K u′ = RHS */
  var sol = await this.pcgSolveKResident(this.gV4, {
    tol: (opts.cgTol != null) ? opts.cgTol : 1e-5,
    maxiter: opts.cgMaxiter || 3000
  });

  /* ε = ε̄ + ε(u′);  σ⁰ = C:ε */
  var enc2 = d.createCommandEncoder();
  this._strainFromU(enc2, this.pcgX);                 /* eps{n,s} = ε(u′)  */
  this._addLane(enc2, laneBuf, lane, epsBarVal);      /* + ε̄              */
  this._localStress(enc2);                            /* sig{n,s} = σ⁰     */
  /* stash σ⁰ for the eigensolver's K_g */
  this._copy3(enc2, this.sigN, this.s0n);
  this._copy3(enc2, this.sigS, this.s0s);
  d.queue.submit([enc2.finish()]);

  /* σ̄ = ⟨σ⁰⟩ */
  var sn = await this._laneSums3(this.sigN);
  var ss = await this._laneSums3(this.sigS);
  var inv = 1 / this.N3;
  var sBar = [sn[0] * inv, sn[1] * inv, sn[2] * inv, ss[0] * inv, ss[1] * inv, ss[2] * inv];

  return { sBar: sBar, cgIters: sol.iters, cgConverged: sol.converged };
};


/* ════════════════════════════════════════════════════════════
   bucklingEigGPU — block subspace generalized eigensolver for
   (−K_g) φ = θ K φ, mirroring bk_subspaceGen (16c).  Assumes the
   pre-stress σ⁰ for the desired axis is already resident in s0{n,s}
   (call extractPrestressGPU(axis) first).

   GPU-resident: X, Z, V, AV, BV vectors and all matvecs/inner
   products.  CPU: the small s×s SA/SB matrices and the reduced
   generalized eigensolve (bk_jacobiSym, reused verbatim).

     applyA(x) = −K_g x   (_applyKg + negate)
     applyB(x) =  K x     (_applyK)
     solveB(b) =  K⁻¹ b   (pcgSolveK)
     project   =  zero-mean

   Returns [{theta, vecBuf}] sorted by θ descending, plus _iters,
   _converged.  Caller maps θ_max → λ_cr = 1/θ_max.
   Note: one readback per inner product (correctness-first; batching
   is a Step-7 optimization).
   ════════════════════════════════════════════════════════════ */
BucklingSolverGPU.prototype.bucklingEigGPU = async function(m, opts) {
  opts = opts || {};
  var d = this.device, N3 = this.N3, V4 = this.v4Size, BU = GPUBufferUsage;
  var iters = opts.eigIters || 60;
  var tol = (opts.eigTol != null) ? opts.eigTol : 1e-5;
  var cgTol = (opts.cgTol != null) ? opts.cgTol : 1e-5;
  var cgMaxiter = opts.cgMaxiter || 2000;
  var self = this;

  function vbuf() { return d.createBuffer({ size: V4, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  var pool = [];
  function take() { var b = vbuf(); pool.push(b); return b; }
  function freeAll() { for (var i = 0; i < pool.length; i++) pool[i].destroy(); pool = []; }

  /* matvec wrappers (each its own encoder + submit, so results are
     readable by the dot products that follow) */
  async function applyA(inBuf, outBuf) {                 /* −K_g */
    var e = d.createCommandEncoder();
    self._applyKg(e, inBuf, outBuf);
    self._scale3(e, outBuf, -1.0);
    d.queue.submit([e.finish()]);
  }
  async function applyB(inBuf, outBuf) {                 /* K */
    var e = d.createCommandEncoder();
    self._applyK(e, inBuf, outBuf);
    d.queue.submit([e.finish()]);
  }
  async function solveB(bBuf, outBuf) {                  /* K⁻¹ (resident, inexact) */
    await self.pcgSolveKResident(bBuf, { tol: cgTol, maxiter: cgMaxiter, checkEvery: 8 });
    var e = d.createCommandEncoder();
    self._copy3(e, self.pcgX, outBuf);
    d.queue.submit([e.finish()]);
  }

  /* GPU Gram-Schmidt: orthonormalize a list of buffers in place, return
     the surviving subset (mirrors bk_orthonormalize). */
  async function orthonormalize(vecs) {
    var out = [];
    for (var i = 0; i < vecs.length; i++) {
      var v = vecs[i];
      for (var j = 0; j < out.length; j++) {
        var dd = await self._dot3(out[j], v);
        var e = d.createCommandEncoder();
        self._axpy3(e, -dd, out[j], v);                  /* v -= (out_j·v) out_j */
        d.queue.submit([e.finish()]);
      }
      var nrm = await self._norm3(v);
      if (nrm > 1e-10) {
        var e2 = d.createCommandEncoder();
        self._scale3(e2, v, 1.0 / nrm);
        d.queue.submit([e2.finish()]);
        out.push(v);
      }
    }
    return out;
  }

  /* X = m random zero-mean vectors */
  function mulberry32(seed) { return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }; }
  var rng = mulberry32(20260622);
  var X = [];
  for (var c = 0; c < m; c++) {
    var xb = take();
    var flat = new Float64Array(3 * N3);
    for (var fi = 0; fi < 3 * N3; fi++) flat[fi] = rng() * 2 - 1;
    this._upload3(flat, xb);
    await this._zeroMean3(xb);
    X.push(xb);
  }

  var prevTheta = null, converged = false, lastIters = 0;

  for (var it = 0; it < iters; it++) {
    lastIters = it + 1;

    /* power step Z = B⁻¹ A X */
    var Z = [];
    for (var cc = 0; cc < m; cc++) {
      var tmp = take();
      await applyA(X[cc], tmp);
      var z = take();
      await solveB(tmp, z);
      await this._zeroMean3(z);
      Z.push(z);
      tmp.destroy(); pool.splice(pool.indexOf(tmp), 1);
    }

    /* trial subspace V = orthonormalize(X ∪ Z) */
    var V = await orthonormalize(X.concat(Z));
    var s = V.length;

    /* AV, BV and the reduced SA, SB */
    var AV = [], BV = [];
    for (var j = 0; j < s; j++) { var av = take(); var bv = take(); await applyA(V[j], av); await applyB(V[j], bv); AV.push(av); BV.push(bv); }
    var SA = new Float64Array(s * s), SB = new Float64Array(s * s);
    for (var ii = 0; ii < s; ii++) for (var jj = 0; jj < s; jj++) {
      SA[ii * s + jj] = await this._dot3(V[ii], AV[jj]);
      SB[ii * s + jj] = await this._dot3(V[ii], BV[jj]);
    }
    for (var a2 = 0; a2 < s; a2++) for (var b2 = a2 + 1; b2 < s; b2++) {
      var sma = 0.5 * (SA[a2 * s + b2] + SA[b2 * s + a2]); SA[a2 * s + b2] = sma; SA[b2 * s + a2] = sma;
      var smb = 0.5 * (SB[a2 * s + b2] + SB[b2 * s + a2]); SB[a2 * s + b2] = smb; SB[b2 * s + a2] = smb;
    }

    /* reduced generalized eigensolve (CPU, reuses bk_jacobiSym) */
    var eigB = bk_jacobiSym(SB, s, 200, 1e-15);
    var maxB = 0; for (var db = 0; db < s; db++) if (eigB.values[db] > maxB) maxB = eigB.values[db];
    var keep = []; for (var dk = 0; dk < s; dk++) if (eigB.values[dk] > 1e-9 * maxB) keep.push(dk);
    var sk = keep.length;
    if (sk === 0) { /* free iteration buffers */ for (var z0 = 0; z0 < Z.length; z0++) {} break; }
    var T = new Float64Array(s * sk);
    for (var ti = 0; ti < s; ti++) for (var tp = 0; tp < sk; tp++) T[ti * sk + tp] = eigB.vectors[ti * s + keep[tp]] / Math.sqrt(eigB.values[keep[tp]]);
    var SAT = new Float64Array(s * sk);
    for (var ri = 0; ri < s; ri++) for (var rp = 0; rp < sk; rp++) { var acc = 0; for (var rj = 0; rj < s; rj++) acc += SA[ri * s + rj] * T[rj * sk + rp]; SAT[ri * sk + rp] = acc; }
    var SAr = new Float64Array(sk * sk);
    for (var pp = 0; pp < sk; pp++) for (var qq = 0; qq < sk; qq++) { var acc2 = 0; for (var pi2 = 0; pi2 < s; pi2++) acc2 += T[pi2 * sk + pp] * SAT[pi2 * sk + qq]; SAr[pp * sk + qq] = acc2; }
    for (var sa = 0; sa < sk; sa++) for (var sb2 = sa + 1; sb2 < sk; sb2++) { var sm = 0.5 * (SAr[sa * sk + sb2] + SAr[sb2 * sk + sa]); SAr[sa * sk + sb2] = sm; SAr[sb2 * sk + sa] = sm; }
    var eigA = bk_jacobiSym(SAr, sk, 200, 1e-15);
    var order = []; for (var o = 0; o < sk; o++) order.push(o);
    order.sort(function (p, q) { return eigA.values[q] - eigA.values[p]; });

    /* reconstruct top-m Ritz vectors:  xc = Σ_j (T·z)_j V[j] */
    var take2 = Math.min(m, sk);
    var newX = [], topThetas = [];
    for (var c2 = 0; c2 < take2; c2++) {
      var oc = order[c2];
      topThetas.push(eigA.values[oc]);
      var yv = new Float64Array(s);
      for (var yi = 0; yi < s; yi++) { var acc3 = 0; for (var yp = 0; yp < sk; yp++) acc3 += T[yi * sk + yp] * eigA.vectors[yp * sk + oc]; yv[yi] = acc3; }
      var xc = take();
      var ez = d.createCommandEncoder(); ez.clearBuffer(xc); d.queue.submit([ez.finish()]);
      for (var jv = 0; jv < s; jv++) {
        var e3 = d.createCommandEncoder();
        this._axpy3(e3, yv[jv], V[jv], xc);
        d.queue.submit([e3.finish()]);
      }
      await this._zeroMean3(xc);
      newX.push(xc);
    }

    /* recycle all per-iteration buffers except the new X.  V aliases
       X/Z buffers in place (GS is in-place), so sweep the unique pool
       rather than a concatenated list to avoid double-destroy. */
    var keepSet = newX;
    var newPool = [];
    for (var pb = 0; pb < pool.length; pb++) {
      if (keepSet.indexOf(pool[pb]) >= 0) newPool.push(pool[pb]);
      else pool[pb].destroy();
    }
    pool = newPool;
    X = newX;

    if (prevTheta && prevTheta.length === topThetas.length) {
      var maxd = 0;
      for (var kk = 0; kk < topThetas.length; kk++) {
        var rel = Math.abs(topThetas[kk] - prevTheta[kk]) / Math.max(Math.abs(topThetas[kk]), 1e-30);
        if (rel > maxd) maxd = rel;
      }
      if (maxd < tol) { converged = true; prevTheta = topThetas; break; }
    }
    prevTheta = topThetas;
  }

  /* final Rayleigh quotients θ = ⟨x,Ax⟩/⟨x,Bx⟩ */
  var outPairs = [];
  var ta = take(), tb = take();
  for (var cf = 0; cf < X.length; cf++) {
    await applyA(X[cf], ta);
    await applyB(X[cf], tb);
    var num = await this._dot3(X[cf], ta);
    var den = await this._dot3(X[cf], tb);
    var theta = num / den;
    var flatVec = await this._readback3(X[cf]);
    outPairs.push({ theta: theta, vec: flatVec });
  }
  outPairs.sort(function (p, q) { return q.theta - p.theta; });
  outPairs._iters = lastIters; outPairs._converged = converged;

  freeAll();
  return outPairs;
};


/* ── Cleanup (FFT plan owned externally — not destroyed here) ── */
BucklingSolverGPU.prototype.destroy = function() {
  var bufs = [this.solidBuf, this.s0n, this.s0s, this.epsN, this.epsS, this.sigN, this.sigS,
              this.gV4, this.fV4, this.cA, this.ohat, this.pcgX, this.pcgR, this.pcgZ,
              this.pcgP, this.pcgAp, this.partF, this.rbF, this.part4, this.rb4,
              this.stiffBuf, this.sizeBuf, this.gammaBuf, this.axBuf, this.xbBuf, this.subBuf, this.alBuf, this.scaleBuf,
              this.sclr, this.sclrRB];
  bufs = bufs.concat(this.uhat, this.hat6, this.exBufs, this.wlPos, this.wlNeg, this.ikBufs, this.dotRBufs, this.arBufs, this.opBufs);
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
     P4. PCG-K  solveB vs bk_pcgSolveK             (true resid < 1e-3)
     P5. prestress σ⁰ vs extractPrestressCPU       (field & σ̄ < 5e-3)

   The eigensolver wiring is checked separately by
   runBucklingEigGPUTest (small scale) — kept out of this suite
   because its per-readback inner loop is slow pending the Step-6b
   GPU-resident-scalar rewrite.

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

  /* Connected Schwarz-P network at ρ≈0.5 (cos x + cos y + cos z > 0).
     A *connected* microstructure is required for the PCG row to be a
     meaningful convergence test — random-noise geometry is near-singular
     (disconnected solid islands) and neither f32 nor f64 CG converges on
     it.  Operator parity (P1–P3) is geometry-independent.  Storage order
     is i·N²+j·N+k, matching the lab's rasterizer. */
  var solid = new Uint8Array(N3), solidF = new Float32Array(N3);
  var TWO_PI = 2 * Math.PI;
  for (var ix = 0; ix < N; ix++) {
    var cx = Math.cos(TWO_PI * ix / N);
    for (var jy = 0; jy < N; jy++) {
      var cy = Math.cos(TWO_PI * jy / N);
      for (var kz = 0; kz < N; kz++) {
        var cz = Math.cos(TWO_PI * kz / N);
        var idx = ix * N * N + jy * N + kz;
        var v = (cx + cy + cz > 0) ? 1 : 0;
        solid[idx] = v; solidF[idx] = v;
      }
    }
  }

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

  /* ── P4: PCG-K solveB parity ──
     Manufactured RHS: b = K·u_ref for random u_ref.  This guarantees b
     is in the range of K and free of the Nyquist/checkerboard modes that
     specDeriv annihilates — without it, an arbitrary random b leaves a
     permanent un-reducible residual (CG plateaus at the annihilated-mode
     energy fraction, regardless of geometry). */
  var applyKflat = function (xx, out) {
    var uf = flatToField(xx), of = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
    applyKcpu(uf, of, solid, C_s, C_v, N, ws); bk_fieldToFlat(of, N3, out);
  };
  var uRef = randField3(44);
  var bV = new Float64Array(3 * N3);
  applyKflat(uRef, bV);                                /* b = K·u_ref (in range) */
  bk_zeroMeanFlat(bV, N3);
  var bnB = Math.sqrt(bV.reduce(function (s, v) { return s + v * v; }, 0)) + 1e-30;

  /* CPU solved at the SAME f32-reachable tol as the GPU, so both stop at a
     comparable convergence depth (the GPU-vs-CPU solution diff is a
     diagnostic, not the gate). */
  var solCpu = bk_pcgSolveK(applyKflat, minv, bV, 3 * N3, N3, 1e-5, 2000);
  var bBufGpu = solver.gV4;                            /* reuse gV4 as RHS scratch */
  solver._upload3(bV, bBufGpu);
  var solGpu = await solver.pcgSolveK(bBufGpu, { tol: 1e-5, maxiter: 2000 });
  var xGpu = await solver._readback3(solver.pcgX);

  /* Gate: push the GPU solution back through the TRUSTED CPU operator and
     measure the true residual ‖b − K·x_gpu‖/‖b‖.  Conditioning- and
     nullspace-robust — it asks directly whether x_gpu solves the system
     K is defined to solve, rather than comparing two iterates. */
  var kxGpu = new Float64Array(3 * N3);
  applyKflat(xGpu, kxGpu);
  var rchk = new Float64Array(3 * N3);
  for (var ri = 0; ri < 3 * N3; ri++) rchk[ri] = bV[ri] - kxGpu[ri];
  bk_zeroMeanFlat(rchk, N3);
  var trueResid = Math.sqrt(rchk.reduce(function (s, v) { return s + v * v; }, 0)) / bnB;

  var eX = relErr(xGpu, solCpu.x);                     /* diagnostic only */
  gates.pcgSolveK = {
    trueResid: trueResid, relErrVsCPU: eX,
    itersGPU: solGpu.iters, itersCPU: solCpu.iters, relresGPU: solGpu.relres,
    pass: trueResid < 1e-3
  };

  /* ── P5: pre-stress extraction parity (zz unit compression) ──
     σ⁰ = C:(ε̄+ε(u′)) is dominated by the exact macro strain ε̄, so it
     matches CPU well even though u′ converges only to f32 tol. */
  var axisV = 2;
  var preCpu = extractPrestressCPU(solid, C_s, C_v, N, axisV, ws, { cgTol: 1e-9, cgMaxiter: 3000 });
  var preGpu = await solver.extractPrestressGPU(axisV, { cgTol: 1e-5, cgMaxiter: 3000 });
  var sgN = await solver._readback3(solver.sigN);     /* σ⁰_xx, σ⁰_yy, σ⁰_zz */
  var sgS = await solver._readback3(solver.sigS);     /* σ⁰_yz, σ⁰_xz, σ⁰_xy */
  var fnum = 0, fden = 0;
  for (var p = 0; p < 6; p++) {
    var gArr = (p < 3) ? sgN : sgS, off = (p % 3) * N3, cArr = preCpu.sigma0[p];
    for (var fi = 0; fi < N3; fi++) { var dd = gArr[off + fi] - cArr[fi]; fnum += dd * dd; fden += cArr[fi] * cArr[fi]; }
  }
  var preFieldErr = Math.sqrt(fnum) / (Math.sqrt(fden) + 1e-30);
  var snum = 0, sden = 0;
  for (var sp = 0; sp < 6; sp++) { var ds = preGpu.sBar[sp] - preCpu.sBar[sp]; snum += ds * ds; sden += preCpu.sBar[sp] * preCpu.sBar[sp]; }
  var preSbarErr = Math.sqrt(snum) / (Math.sqrt(sden) + 1e-30);
  gates.prestress = {
    fieldErr: preFieldErr, sBarErr: preSbarErr,
    cgItersGPU: preGpu.cgIters, cgItersCPU: preCpu.cgIters,
    pass: preFieldErr < 5e-3 && preSbarErr < 5e-3
  };

  solver.destroy();

  var passed = gates.applyK.pass && gates.applyKg.pass && gates.precondGamma0.pass &&
               gates.pcgSolveK.pass && gates.prestress.pass;
  var report = { passed: passed, gates: gates, N: N };
  if (typeof console !== 'undefined') {
    console.log('[runBucklingGPUTest] N=' + N + ' → ' + (passed ? 'PASS' : 'FAIL'));
    console.table(gates);
  }
  return report;
}

/* ════════════════════════════════════════════════════════════
   runBucklingEigGPUTest — small-scale eigensolver WIRING check.

   Purpose: confirm the GPU orchestration of bucklingEigGPU is correct
   (the −K_g negate, Gram-Schmidt, Ritz recombination, buffer pooling),
   NOT to measure eigenvalue precision.  It runs the GPU eigensolver
   and a manually-driven CPU reference with IDENTICAL split settings —
   a decent one-time pre-stress solve, then deliberately cheap inexact
   power steps — so the two differ only by f32-vs-f64.  λ_cr is compared
   in a loose band (15% default).

   Small by design (N=8, block 3) and reports wall-time.  Tight, full-
   size λ parity comes after the Step-6b GPU-resident-scalar rewrite
   removes the per-readback bottleneck.

   Returns { passed, lambdaGPU, lambdaCPU, relErr, ... }.
   ════════════════════════════════════════════════════════════ */
async function runBucklingEigGPUTest(N, opts) {
  N = N || 8;
  opts = opts || {};
  if (typeof ensureDevice === 'function') { await ensureDevice(); }
  if (!WGPU.device) throw new Error('runBucklingEigGPUTest: no WebGPU device');
  var now = function () { return (typeof performance !== 'undefined') ? performance.now() : Date.now(); };

  var N3 = N * N * N, n = 3 * N3;
  var C_s = isoC(110000, 0.34);
  var C_v = isoC(11, 0.34);
  var ws = getBucklingWorkspaceCPU(N);

  /* Schwarz-P cell at ρ≈0.5 */
  var solid = new Uint8Array(N3), solidF = new Float32Array(N3);
  var TP = 2 * Math.PI;
  for (var ix = 0; ix < N; ix++) { var cx = Math.cos(TP * ix / N);
    for (var jy = 0; jy < N; jy++) { var cy = Math.cos(TP * jy / N);
      for (var kz = 0; kz < N; kz++) { var cz = Math.cos(TP * kz / N);
        var idx = ix * N * N + jy * N + kz; var v = (cx + cy + cz > 0) ? 1 : 0; solid[idx] = v; solidF[idx] = v; } } }

  var axisV   = (opts.axisV != null) ? opts.axisV : 2;
  var mBlk    = opts.block    || 4;
  var preTol  = (opts.preTol != null) ? opts.preTol : 1e-6;     /* accurate σ⁰ (matched both sides) */
  var preMax  = opts.preMax    || 600;
  var band    = (opts.tol != null) ? opts.tol : 0.10;
  /* CPU reference: well-converged → the TRUE dominant λ (init-independent
     once converged, so stable run-to-run despite unseeded random start) */
  var cEigIters = opts.cpuEigIters || 100, cEigTol = opts.cpuEigTol || 1e-10;
  var cCgTol = opts.cpuCgTol || 1e-10, cCgMax = opts.cpuCgMax || 1000;
  /* GPU: converged to the f32 floor (resident PCG makes the inner solve cheap) */
  var gEigIters = opts.eigIters || 50, gEigTol = opts.eigTol || 1e-6;
  var gCgTol = opts.eigCgTol || 1e-5, gCgMax = opts.eigCgMax || 300;

  /* ── CPU reference (well-converged true λ) ── */
  var tC0 = now();
  var uf = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  var of = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  var minv = bk_makePrecondGamma0(N, C_s[21], C_s[1]);
  var preC = extractPrestressCPU(solid, C_s, C_v, N, axisV, ws, { cgTol: preTol, cgMaxiter: preMax });
  var sig0 = preC.sigma0;
  var applyA = function (x, out) { bk_flatToField(x, N3, uf); applyKgcpu(uf, of, sig0, N, ws); bk_fieldToFlatNeg(of, N3, out); };
  var applyB = function (x, out) { bk_flatToField(x, N3, uf); applyKcpu(uf, of, solid, C_s, C_v, N, ws); bk_fieldToFlat(of, N3, out); };
  var solveB = function (b, out) { var r = bk_pcgSolveK(applyB, minv, b, n, N3, cCgTol, cCgMax); out.set(r.x); };
  var cpuPairs = bk_subspaceGen(applyA, applyB, solveB, n, mBlk, { project: function (v) { bk_zeroMeanFlat(v, N3); }, iters: cEigIters, tol: cEigTol });
  var lamCpu = Infinity;
  for (var ci = 0; ci < cpuPairs.length; ci++) { if (cpuPairs[ci].theta > 1e-9) { var lc = 1 / cpuPairs[ci].theta; if (lc < lamCpu) lamCpu = lc; } }
  var secCpu = (now() - tC0) / 1000;

  /* ── GPU ── */
  var fft;
  if (typeof window !== 'undefined' && window.__sharedFFT && window.__sharedFFT.N === N) {
    fft = window.__sharedFFT;
  } else {
    fft = new FFTPlan(N);
    if (typeof window !== 'undefined') { if (window.__sharedFFT) window.__sharedFFT.destroy(); window.__sharedFFT = fft; }
  }
  var solver = new BucklingSolverGPU(N, fft);
  solver.uploadDesign(solidF, C_s, C_v);

  var tG0 = now();
  await solver.extractPrestressGPU(axisV, { cgTol: preTol, cgMaxiter: preMax });
  var pairs = await solver.bucklingEigGPU(mBlk, { eigIters: gEigIters, eigTol: gEigTol, cgTol: gCgTol, cgMaxiter: gCgMax });
  var secGpu = (now() - tG0) / 1000;
  var lamGpu = Infinity;
  for (var gi = 0; gi < pairs.length; gi++) { if (pairs[gi].theta > 1e-9) { var lg = 1 / pairs[gi].theta; if (lg < lamGpu) lamGpu = lg; } }

  solver.destroy();

  var lamErr = Math.abs(lamGpu - lamCpu) / Math.max(Math.abs(lamCpu), 1e-30);
  var passed = isFinite(lamErr) && lamErr < band;
  var report = {
    passed: passed, N: N, block: mBlk,
    lambdaGPU: lamGpu, lambdaCPU: lamCpu, relErr: lamErr,
    eigItersGPU: pairs._iters, convergedGPU: pairs._converged,
    secGPU: +secGpu.toFixed(1), secCPU: +secCpu.toFixed(2)
  };
  if (typeof console !== 'undefined') {
    console.log('[runBucklingEigGPUTest] N=' + N + ' block=' + mBlk + ' → ' + (passed ? 'PASS' : 'FAIL') +
      '   λ_gpu=' + (isFinite(lamGpu) ? lamGpu.toPrecision(5) : 'Inf') +
      '  λ_cpu=' + (isFinite(lamCpu) ? lamCpu.toPrecision(5) : 'Inf') +
      '  relErr=' + (isFinite(lamErr) ? lamErr.toExponential(2) : 'NaN') +
      '   (' + report.secGPU + 's GPU, ' + report.secCPU + 's CPU)');
  }
  return report;
}

/* ════════════════════════════════════════════════════════════
   runBucklingPCGResidentTest — Step-6b gate.  Confirms the GPU-
   resident PCG (pcgSolveKResident) solves K x = b to the same true
   residual as the frozen pcgSolveK, and times both to show the
   readback savings.  Manufactured RHS b = K·u_ref (in-range).
   ════════════════════════════════════════════════════════════ */
async function runBucklingPCGResidentTest(N) {
  N = N || 16;
  if (typeof ensureDevice === 'function') { await ensureDevice(); }
  if (!WGPU.device) throw new Error('runBucklingPCGResidentTest: no WebGPU device');
  var now = function () { return (typeof performance !== 'undefined') ? performance.now() : Date.now(); };

  var N3 = N * N * N;
  var C_s = isoC(110000, 0.34), C_v = isoC(11, 0.34);
  var ws = getBucklingWorkspaceCPU(N);

  var solid = new Uint8Array(N3), solidF = new Float32Array(N3);
  var TP = 2 * Math.PI;
  for (var ix = 0; ix < N; ix++) { var cx = Math.cos(TP * ix / N);
    for (var jy = 0; jy < N; jy++) { var cy = Math.cos(TP * jy / N);
      for (var kz = 0; kz < N; kz++) { var cz = Math.cos(TP * kz / N);
        var idx = ix * N * N + jy * N + kz; var v = (cx + cy + cz > 0) ? 1 : 0; solid[idx] = v; solidF[idx] = v; } } }

  var fft;
  if (typeof window !== 'undefined' && window.__sharedFFT && window.__sharedFFT.N === N) fft = window.__sharedFFT;
  else { fft = new FFTPlan(N); if (typeof window !== 'undefined') { if (window.__sharedFFT) window.__sharedFFT.destroy(); window.__sharedFFT = fft; } }
  var solver = new BucklingSolverGPU(N, fft);
  solver.uploadDesign(solidF, C_s, C_v);

  /* manufactured RHS b = K·u_ref */
  function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  var rng = mulberry32(77), uRef = new Float64Array(3 * N3);
  for (var i = 0; i < 3 * N3; i++) uRef[i] = rng() * 2 - 1;
  bk_zeroMeanFlat(uRef, N3);
  var uf = [uRef.subarray(0, N3), uRef.subarray(N3, 2 * N3), uRef.subarray(2 * N3, 3 * N3)];
  var of = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  applyKcpu(uf, of, solid, C_s, C_v, N, ws);
  var bV = new Float64Array(3 * N3); bk_fieldToFlat(of, N3, bV); bk_zeroMeanFlat(bV, N3);
  var bn = Math.sqrt(bV.reduce(function (s, v) { return s + v * v; }, 0)) + 1e-30;

  function trueResidOf(xFlat) {
    var xf = [xFlat.subarray(0, N3), xFlat.subarray(N3, 2 * N3), xFlat.subarray(2 * N3, 3 * N3)];
    var kf = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
    applyKcpu(xf, kf, solid, C_s, C_v, N, ws);
    var kflat = new Float64Array(3 * N3); bk_fieldToFlat(kf, N3, kflat);
    var r = new Float64Array(3 * N3);
    for (var k = 0; k < 3 * N3; k++) r[k] = bV[k] - kflat[k];
    bk_zeroMeanFlat(r, N3);
    return Math.sqrt(r.reduce(function (s, v) { return s + v * v; }, 0)) / bn;
  }

  /* resident solve (timed) */
  solver._upload3(bV, solver.gV4);
  var tR0 = now();
  var solR = await solver.pcgSolveKResident(solver.gV4, { tol: 1e-5, maxiter: 2000 });
  var secR = (now() - tR0) / 1000;
  var xR = await solver._readback3(solver.pcgX);
  var residR = trueResidOf(xR);

  /* frozen non-resident solve (timed, same RHS) */
  solver._upload3(bV, solver.gV4);
  var tN0 = now();
  var solN = await solver.pcgSolveK(solver.gV4, { tol: 1e-5, maxiter: 2000 });
  var secN = (now() - tN0) / 1000;

  solver.destroy();

  var passed = residR < 1e-3;
  var report = {
    passed: passed,
    trueResidResident: residR,
    itersResident: solR.iters, itersNonResident: solN.iters,
    secResident: +secR.toFixed(2), secNonResident: +secN.toFixed(2),
    speedup: +(secN / Math.max(secR, 1e-6)).toFixed(1)
  };
  if (typeof console !== 'undefined') {
    console.log('[runBucklingPCGResidentTest] N=' + N + ' → ' + (passed ? 'PASS' : 'FAIL') +
      '   trueResid=' + residR.toExponential(2) +
      '   iters R/N=' + solR.iters + '/' + solN.iters +
      '   time R/N=' + report.secResident + 's/' + report.secNonResident + 's  (' + report.speedup + '× faster)');
  }
  return report;
}

/* ════════════════════════════════════════════════════════════
   Step 7 — recipe → buckling dispatch with silent CPU fallback.

   _bucklingFrontEnd : recipe → solid + skip decision (mirrors the
       rasterization/guard front-end of homogenizeBucklingCPU).
   solveDesignBucklingGPU : full GPU solve, returns the same shape as
       computeBucklingCPU (lambda_cr, pcr, critAxis, rho, perAxis,
       modes, skip_reason).
   computeBuckling : GPU-primary IFF window.BUCKLE_GPU (or opts.gpu)
       AND WebGPU is available; otherwise — and on any GPU error —
       silently falls back to computeBucklingCPU.  Default is CPU
       until the Step-6b Gram-batching makes the GPU eigensolver
       faster than the parallel CPU worker pool.
   ════════════════════════════════════════════════════════════ */
function _bucklingFrontEnd(recipe, N, opts) {
  opts = opts || {};
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args = resolveBuildArgs(recipe);
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  if (opts.pruneLargest && typeof pruneVoxels === 'function') solid = pruneVoxels(solid, N, family, opts);

  var N3 = N * N * N, inside = 0;
  for (var vb = 0; vb < N3; vb++) if (solid[vb]) inside++;
  var skipReason = null;
  if (inside === 0) {
    skipReason = 'empty at N=' + N;
  } else if (typeof checkVoxelConnectivity === 'function') {
    var interior = 0, Nm1 = N - 1;
    for (var a = 0; a < N; a++) {
      var am = (a === 0) ? Nm1 : a - 1, ap = (a === Nm1) ? 0 : a + 1;
      for (var b = 0; b < N; b++) {
        var bm = (b === 0) ? Nm1 : b - 1, bp = (b === Nm1) ? 0 : b + 1;
        for (var c = 0; c < N; c++) {
          var idx = (a * N + b) * N + c;
          if (!solid[idx]) continue;
          var cm = (c === 0) ? Nm1 : c - 1, cp = (c === Nm1) ? 0 : c + 1;
          if (solid[(am * N + b) * N + c] && solid[(ap * N + b) * N + c] &&
              solid[(a * N + bm) * N + c] && solid[(a * N + bp) * N + c] &&
              solid[(a * N + b) * N + cm] && solid[(a * N + b) * N + cp]) interior++;
        }
      }
    }
    var conn = checkVoxelConnectivity(solid, N);
    if (interior / inside < 0.04) skipReason = 'under-resolved at N=' + N + ' — raise the buckle grid';
    else if (conn.numComponents > 1) skipReason = 'multi-component (' + conn.numComponents + ' disconnected pieces) — per-component buckling not yet implemented';
  }

  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  return {
    solid: solid, skipReason: skipReason, rho: inside / N3,
    C_s: isoC(mat.Es_MPa, mat.nu), C_v: isoC(mat.Es_MPa * 1e-4, mat.nu)
  };
}

async function solveDesignBucklingGPU(recipe, N, opts, onProgress) {
  opts = opts || {}; N = N || 8;
  var anames = ['xx', 'yy', 'zz'];
  var axes = (opts.axes && opts.axes.length) ? opts.axes : [0, 1, 2];

  var fe = _bucklingFrontEnd(recipe, N, opts);
  if (fe.skipReason) {
    var paStub = [];
    for (var si = 0; si < axes.length; si++) paStub.push({ axis: anames[axes[si]], lambda: Infinity, sBar: 0, cgIters: 0, mWave: 0 });
    return { lambda_cr: Infinity, pcr: Infinity, critAxis: null, rho: fe.rho, perAxis: paStub, modes: {}, skip_reason: fe.skipReason };
  }

  var N3 = N * N * N, solid = fe.solid;
  var solidF = new Float32Array(N3);
  for (var fi = 0; fi < N3; fi++) solidF[fi] = solid[fi] ? 1 : 0;

  var fft;
  if (typeof window !== 'undefined' && window.__sharedFFT && window.__sharedFFT.N === N) fft = window.__sharedFFT;
  else { fft = new FFTPlan(N); if (typeof window !== 'undefined') { if (window.__sharedFFT) window.__sharedFFT.destroy(); window.__sharedFFT = fft; } }
  var solver = new BucklingSolverGPU(N, fft);
  solver.uploadDesign(solidF, fe.C_s, fe.C_v);

  var block   = opts.block     || 6;
  var eigIters = opts.eigIters  || 40;
  var eigTol  = (opts.eigTol != null) ? opts.eigTol : 1e-5;
  var cgTol   = (opts.cgTol  != null) ? opts.cgTol  : 1e-4;
  var cgMax   = opts.cgMaxiter  || 300;
  var preTol  = (opts.preTol != null) ? opts.preTol : 1e-5;
  var preMax  = opts.preMaxiter || 600;

  var perAxis = [], modes = {}, lambdaCr = Infinity, critAxis = null, critSbar = 0;
  try {
    for (var ai = 0; ai < axes.length; ai++) {
      var axis = axes[ai];
      var pre = await solver.extractPrestressGPU(axis, { cgTol: preTol, cgMaxiter: preMax });
      var pairs = await solver.bucklingEigGPU(block, { eigIters: eigIters, eigTol: eigTol, cgTol: cgTol, cgMaxiter: cgMax });
      var lamAxis = Infinity, modeAxis = null;
      for (var pi = 0; pi < pairs.length; pi++) { if (pairs[pi].theta > 1e-9) { var lam = 1 / pairs[pi].theta; if (lam < lamAxis) { lamAxis = lam; modeAxis = pairs[pi].vec; } } }
      var sBarAxis = pre.sBar[axis];
      var mWave = (typeof bk_modeLocalization === 'function' && modeAxis) ? bk_modeLocalization(modeAxis, solid, N) : 0;
      perAxis.push({ axis: anames[axis], lambda: lamAxis, sBar: sBarAxis, cgIters: pre.cgIters, mWave: mWave });
      if (modeAxis) {
        var ux = new Float32Array(N3), uy = new Float32Array(N3), uz = new Float32Array(N3), mag = new Float32Array(N3);
        for (var iv = 0; iv < N3; iv++) { var vx = modeAxis[iv], vy = modeAxis[N3 + iv], vz = modeAxis[2 * N3 + iv]; ux[iv] = vx; uy[iv] = vy; uz[iv] = vz; mag[iv] = Math.sqrt(vx * vx + vy * vy + vz * vz); }
        modes[anames[axis]] = { u_prime: [ux, uy, uz], sigma_vm: mag, N: N, eps_bar: [0, 0, 0] };
      }
      if (isFinite(lamAxis) && lamAxis < lambdaCr) { lambdaCr = lamAxis; critAxis = anames[axis]; critSbar = sBarAxis; }
      if (onProgress) onProgress({ done: ai + 1, total: axes.length, axis: anames[axis], lambda: lamAxis });
    }
  } finally {
    solver.destroy();
  }

  var orderM = { xx: 0, yy: 1, zz: 2 };
  perAxis.sort(function (p, q) { return (orderM[p.axis] || 0) - (orderM[q.axis] || 0); });
  var pcr = isFinite(lambdaCr) ? lambdaCr * Math.abs(critSbar) : Infinity;
  var res = { lambda_cr: lambdaCr, pcr: pcr, critAxis: critAxis, rho: fe.rho, perAxis: perAxis, modes: modes, skip_reason: null };
  if (!isFinite(lambdaCr)) res.skip_reason = 'no positive critical mode found';
  return res;
}

async function computeBuckling(recipe, N, opts, onProgress) {
  opts = opts || {};
  var useGPU = (opts.gpu != null) ? opts.gpu : (typeof window !== 'undefined' && window.BUCKLE_GPU);
  if (useGPU) {
    var ok = false;
    try { if (typeof ensureDevice === 'function') await ensureDevice(); ok = !!(typeof WGPU !== 'undefined' && WGPU.device); } catch (e) { ok = false; }
    if (ok) {
      try { return await solveDesignBucklingGPU(recipe, N, opts, onProgress); }
      catch (e) { if (typeof console !== 'undefined') console.warn('[buckling] GPU path failed; falling back to CPU:', (e && e.message) || e); }
    }
  }
  return computeBucklingCPU(recipe, N, opts, onProgress);
}

/* Expose for the in-browser console / Push-2 wiring. */
if (typeof window !== 'undefined') {
  window.BUCKLE_GPU = true;   /* GPU buckling primary; set false in console to A/B against the CPU worker pool */
  window.BucklingSolverGPU = BucklingSolverGPU;
  window.runBucklingGPUTest = runBucklingGPUTest;
  window.runBucklingEigGPUTest = runBucklingEigGPUTest;
  window.runBucklingPCGResidentTest = runBucklingPCGResidentTest;
  window.solveDesignBucklingGPU = solveDesignBucklingGPU;
  window.computeBuckling = computeBuckling;
}
