/* ============================================================
   F13LD.lab · 17b-thermal-solver.js   (v0.20.0 — thermal Phase 1)
   GPU effective thermal conductivity.  Mirrors 17a-thermal-cpu-ref.js
   (docs/THERMAL_SCOPE.md §11): same rotated grid, same composite-voxel
   conductivity, same Galerkin operator, same FFT preconditioner.

   Grid: temperature correction T̃ at voxel CORNERS (nodes); one gradient
   per voxel, the mean of its 4 edge differences per axis.  Each voxel
   carries a solid fraction phi and wall normal n (17c / 14e); the kernel
   turns them into the laminate conductivity
       k = k_par (I − n nᵀ) + k_ser n nᵀ   (pure voxels: kS or kF).
   Everything is normalized by kS (kS = 1 on the GPU, kF = kF/kS), so the
   f32 arithmetic sees numbers near 1; κ is scaled back by kS at the end.

   All three load cases (E = e_x, e_y, e_z) are solved TOGETHER, one per
   vec4 lane (lane 3 unused).  One CG iteration on the GPU:
     Ap = Dᵀ k D p          th_apply: one thread per node gathers its 8
                            voxels' fluxes (27 node loads, no atomics,
                            no flux buffer)
     α = r·z / p·Ap         per lane, on the GPU (th_scalar)
     T += α p, r −= α Ap
     z = P r                FFT preconditioner: lanes x, y packed as one
                            complex field, lane z as a second — ONE
                            batch-2 forward + inverse FFT for all three
                            load cases.  Symbol of the uniform operator
                            ¼ Σ_a 4 sin²(ξ_a/2) Π_{b≠a} cos²(ξ_b/2), real
                            and even, so packing is exact; its zero set
                            (the constant and the checkerboard modes) is
                            dropped, as in 17a.
     β = r·z_new / r·z,  p = z + β p
   A lane that has converged freezes (α = β = 0) while the others finish.
   The CG scalars stay on the GPU; the page reads 64 floats once per block
   of iterations (block grows 1, 2, … 16), as in 16i.

   Stopping test (as 17a): ‖r‖ ≤ tol · max(‖b‖, 1e-6 ‖k E‖).

   Memory at N = 128: voxel data 32 MB, four CG vectors 4 × 32 MB, the
   batch-2 FFT pair 2 × 32 MB — about 230 MB in all, no buffer over 34 MB.

   API
     thermalGPUSolver(N)                → cached ThermalGPUSolver
     ThermalGPUSolver.upload(vt)          phi + normal from 17c / 14e
     ThermalGPUSolver.solve(kS, kF, opts) → Promise<{ K (9, row-major, W/m·K),
           perLC [{ axis, iters, converged, relRes, reason }], asym, energyErr,
           fields? { x|y|z: { Tn (Float32 N³ node T̃), qMag (Float32 N³) } } }>
         opts: { tol (1e-5), maxiter (3000), capture (false) }
     homogenizeThermalGPU(recipe, N, opts) → Promise (one design, several fillers)
         opts: { kS, fillers: [{ id, k }], tol, maxiter, capture, connectivity,
                 pruneLargest, onProgress }
     thermalGPURelease()
     runThermalGPUCheck(N)        console: GPU vs 17a on the demos (T9–T11)
     runThermalBeamReference()    console: BCC beams at N = 128 (§11.4 †)
   ============================================================ */

var THERMAL_GPU_VERSION = 'tg-1';

/* scalar slots (vec4 each; lanes = load cases x, y, z, —) */
var THS_RZ = 0, THS_RZN = 1, THS_PAP = 2, THS_ALPHA = 3, THS_BETA = 4, THS_RR = 5, THS_THR2 = 6,
    THS_DONE = 7, THS_IT = 8, THS_BN2 = 9, THS_SX = 10, THS_SY = 11, THS_SZ = 12, THS_EN = 13,
    THS_Q2 = 14, THS_CFG = 15, THS_COUNT = 16;
var TH_DOT_WG = 256, TH_STATS_WG = 128, TH_MAX_PARTIALS = 1024;

/* ── WGSL ──────────────────────────────────────────────────────────── */
var TH_COMMON_WGSL = [
'struct TP { N: u32, N3: u32, addE: u32, nwg: u32, kF: f32, sgn: f32, pad0: f32, pad1: f32 }',
'fn tidx(i: u32, j: u32, k: u32, N: u32) -> u32 { return (i * N + j) * N + k; }',
'/* conductivity of a voxel (kS = 1): xx yy zz xy xz yz */',
'struct KT { xx: f32, yy: f32, zz: f32, xy: f32, xz: f32, yz: f32 }',
'fn kten(v: vec4<f32>, kF: f32) -> KT {',
'  let f = v.x;',
'  if (f >= 1.0) { return KT(1.0, 1.0, 1.0, 0.0, 0.0, 0.0); }',
'  if (f <= 0.0) { return KT(kF, kF, kF, 0.0, 0.0, 0.0); }',
'  let kp = f + (1.0 - f) * kF;',
'  let ks = 1.0 / (f + (1.0 - f) / kF);',
'  let dk = ks - kp;',
'  return KT(kp + dk * v.y * v.y, kp + dk * v.z * v.z, kp + dk * v.w * v.w, dk * v.y * v.z, dk * v.y * v.w, dk * v.z * v.w);',
'}',
''
].join('\n');

/* Ap (or the right-hand side) at every node: out = sgn · Dᵀ k (D T + addE·E) */
var TH_APPLY_WGSL = TH_COMMON_WGSL + [
'@group(0) @binding(0) var<storage, read> vox: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read> Tin: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read_write> outv: array<vec4<f32>>;',
'@group(0) @binding(3) var<uniform> P: TP;',
'fn L(a: u32, b: u32, c: u32) -> u32 { return (a * 3u + b) * 3u + c; }',
'@compute @workgroup_size(64)',
'fn th_apply(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {',
'  let n = gid.x + gid.y * nw.x * 64u;',
'  if (n >= P.N3) { return; }',
'  let N = P.N; let NN = N * N;',
'  let i = n / NN; let j = (n / N) % N; let k = n % N;',
'  var t: array<vec4<f32>, 27>;',
'  for (var a = 0u; a < 3u; a++) { for (var b = 0u; b < 3u; b++) { for (var c = 0u; c < 3u; c++) {',
'    t[L(a, b, c)] = Tin[tidx((i + N - 1u + a) % N, (j + N - 1u + b) % N, (k + N - 1u + c) % N, N)];',
'  } } }',
'  let addE = select(0.0, 1.0, P.addE == 1u);',
'  let ex = vec4<f32>(addE, 0.0, 0.0, 0.0); let ey = vec4<f32>(0.0, addE, 0.0, 0.0); let ez = vec4<f32>(0.0, 0.0, addE, 0.0);',
'  var acc = vec4<f32>(0.0);',
'  for (var ox = 0u; ox < 2u; ox++) { for (var oy = 0u; oy < 2u; oy++) { for (var oz = 0u; oz < 2u; oz++) {',
'    let bx = 1u - ox; let by = 1u - oy; let bz = 1u - oz;',
'    let t000 = t[L(bx, by, bz)];           let t100 = t[L(bx + 1u, by, bz)];',
'    let t010 = t[L(bx, by + 1u, bz)];      let t001 = t[L(bx, by, bz + 1u)];',
'    let t110 = t[L(bx + 1u, by + 1u, bz)]; let t101 = t[L(bx + 1u, by, bz + 1u)];',
'    let t011 = t[L(bx, by + 1u, bz + 1u)]; let t111 = t[L(bx + 1u, by + 1u, bz + 1u)];',
'    let gx = 0.25 * (t100 - t000 + t110 - t010 + t101 - t001 + t111 - t011) + ex;',
'    let gy = 0.25 * (t010 - t000 + t110 - t100 + t011 - t001 + t111 - t101) + ey;',
'    let gz = 0.25 * (t001 - t000 + t101 - t100 + t011 - t010 + t111 - t110) + ez;',
'    let K = kten(vox[tidx((i + N - ox) % N, (j + N - oy) % N, (k + N - oz) % N, N)], P.kF);',
'    let qx = K.xx * gx + K.xy * gy + K.xz * gz;',
'    let qy = K.xy * gx + K.yy * gy + K.yz * gz;',
'    let qz = K.xz * gx + K.yz * gy + K.zz * gz;',
'    let sx = select(-1.0, 1.0, ox == 1u); let sy = select(-1.0, 1.0, oy == 1u); let sz = select(-1.0, 1.0, oz == 1u);',
'    acc += 0.25 * (sx * qx + sy * qy + sz * qz);',
'  } } }',
'  outv[n] = P.sgn * acc;',
'}'
].join('\n');

/* per-voxel flux of the converged state (T + E): partial sums of ⟨q⟩, the
   energy ⟨(g+E)·q⟩ and Σ|q|² (stats), or |q| per voxel (qmag) */
var TH_VOXFLUX_WGSL = [
'struct VF { qx: vec4<f32>, qy: vec4<f32>, qz: vec4<f32>, en: vec4<f32> }',
'fn voxFlux(v: u32) -> VF {',
'  let N = P.N; let NN = N * N;',
'  let i = v / NN; let j = (v / N) % N; let k = v % N;',
'  let i1 = (i + 1u) % N; let j1 = (j + 1u) % N; let k1 = (k + 1u) % N;',
'  let t000 = Tin[tidx(i, j, k, N)];   let t100 = Tin[tidx(i1, j, k, N)];',
'  let t010 = Tin[tidx(i, j1, k, N)];  let t001 = Tin[tidx(i, j, k1, N)];',
'  let t110 = Tin[tidx(i1, j1, k, N)]; let t101 = Tin[tidx(i1, j, k1, N)];',
'  let t011 = Tin[tidx(i, j1, k1, N)]; let t111 = Tin[tidx(i1, j1, k1, N)];',
'  let addE = select(0.0, 1.0, P.addE == 1u);',
'  let gx = 0.25 * (t100 - t000 + t110 - t010 + t101 - t001 + t111 - t011) + vec4<f32>(addE, 0.0, 0.0, 0.0);',
'  let gy = 0.25 * (t010 - t000 + t110 - t100 + t011 - t001 + t111 - t101) + vec4<f32>(0.0, addE, 0.0, 0.0);',
'  let gz = 0.25 * (t001 - t000 + t101 - t100 + t011 - t010 + t111 - t110) + vec4<f32>(0.0, 0.0, addE, 0.0);',
'  let K = kten(vox[v], P.kF);',
'  let qx = K.xx * gx + K.xy * gy + K.xz * gz;',
'  let qy = K.xy * gx + K.yy * gy + K.yz * gz;',
'  let qz = K.xz * gx + K.yz * gy + K.zz * gz;',
'  return VF(qx, qy, qz, gx * qx + gy * qy + gz * qz);',
'}',
''
].join('\n');

var TH_STATS_WGSL = TH_COMMON_WGSL + [
'@group(0) @binding(0) var<storage, read> vox: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read> Tin: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read_write> part: array<vec4<f32>>;',
'@group(0) @binding(3) var<uniform> P: TP;',
TH_VOXFLUX_WGSL,
'var<workgroup> sh: array<vec4<f32>, ' + (5 * TH_STATS_WG) + '>;',
'@compute @workgroup_size(' + TH_STATS_WG + ')',
'fn th_stats(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
'  var a0 = vec4<f32>(0.0); var a1 = vec4<f32>(0.0); var a2 = vec4<f32>(0.0); var a3 = vec4<f32>(0.0); var a4 = vec4<f32>(0.0);',
'  let stride = P.nwg * ' + TH_STATS_WG + 'u;',
'  for (var v = wid.x * ' + TH_STATS_WG + 'u + lid.x; v < P.N3; v += stride) {',
'    let f = voxFlux(v);',
'    a0 += f.qx; a1 += f.qy; a2 += f.qz; a3 += f.en; a4 += f.qx * f.qx + f.qy * f.qy + f.qz * f.qz;',
'  }',
'  let b = lid.x * 5u;',
'  sh[b] = a0; sh[b + 1u] = a1; sh[b + 2u] = a2; sh[b + 3u] = a3; sh[b + 4u] = a4;',
'  workgroupBarrier();',
'  for (var s = ' + (TH_STATS_WG / 2) + 'u; s > 0u; s = s >> 1u) {',
'    if (lid.x < s) { for (var q = 0u; q < 5u; q++) { sh[b + q] += sh[(lid.x + s) * 5u + q]; } }',
'    workgroupBarrier();',
'  }',
'  if (lid.x == 0u) { for (var q = 0u; q < 5u; q++) { part[wid.x * 5u + q] = sh[q]; } }',
'}'
].join('\n');

var TH_QMAG_WGSL = TH_COMMON_WGSL + [
'@group(0) @binding(0) var<storage, read> vox: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read> Tin: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read_write> outv: array<vec4<f32>>;',
'@group(0) @binding(3) var<uniform> P: TP;',
TH_VOXFLUX_WGSL,
'@compute @workgroup_size(64)',
'fn th_qmag(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {',
'  let v = gid.x + gid.y * nw.x * 64u;',
'  if (v >= P.N3) { return; }',
'  let f = voxFlux(v);',
'  outv[v] = sqrt(f.qx * f.qx + f.qy * f.qy + f.qz * f.qz);',
'}'
].join('\n');

/* partial dot products a·b per lane */
var TH_DOT_WGSL = [
'struct DP { N3: u32, nwg: u32, pad0: u32, pad1: u32 }',
'@group(0) @binding(0) var<storage, read> A: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read> B: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read_write> part: array<vec4<f32>>;',
'@group(0) @binding(3) var<uniform> D: DP;',
'var<workgroup> sh: array<vec4<f32>, ' + TH_DOT_WG + '>;',
'@compute @workgroup_size(' + TH_DOT_WG + ')',
'fn th_dot(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
'  var acc = vec4<f32>(0.0);',
'  let stride = D.nwg * ' + TH_DOT_WG + 'u;',
'  for (var e = wid.x * ' + TH_DOT_WG + 'u + lid.x; e < D.N3; e += stride) { acc += A[e] * B[e]; }',
'  sh[lid.x] = acc;',
'  workgroupBarrier();',
'  for (var s = ' + (TH_DOT_WG / 2) + 'u; s > 0u; s = s >> 1u) {',
'    if (lid.x < s) { sh[lid.x] += sh[lid.x + s]; }',
'    workgroupBarrier();',
'  }',
'  if (lid.x == 0u) { part[wid.x] = sh[0]; }',
'}'
].join('\n');

/* sum the partials into scalar slots: workgroup o sums output o */
var TH_SUM_WGSL = [
'struct SP { count: u32, slot: u32, nOut: u32, pad: u32 }',
'@group(0) @binding(0) var<storage, read> part: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read_write> S: array<vec4<f32>>;',
'@group(0) @binding(2) var<uniform> U: SP;',
'var<workgroup> sh: array<vec4<f32>, 256>;',
'@compute @workgroup_size(256)',
'fn th_sum(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
'  var acc = vec4<f32>(0.0);',
'  for (var w = lid.x; w < U.count; w += 256u) { acc += part[w * U.nOut + wid.x]; }',
'  sh[lid.x] = acc;',
'  workgroupBarrier();',
'  for (var s = 128u; s > 0u; s = s >> 1u) {',
'    if (lid.x < s) { sh[lid.x] += sh[lid.x + s]; }',
'    workgroupBarrier();',
'  }',
'  if (lid.x == 0u) { S[U.slot + wid.x] = sh[0]; }',
'}'
].join('\n');

/* CG scalars, one thread.  op 0 init · 1 alpha · 2 convergence · 3 beta */
var TH_SCALAR_WGSL = [
'struct OP { op: u32, pad0: u32, pad1: u32, pad2: u32 }',
'@group(0) @binding(0) var<storage, read_write> S: array<vec4<f32>>;',
'@group(0) @binding(1) var<uniform> O: OP;',
'@compute @workgroup_size(1)',
'fn th_scalar() {',
'  var done = S[' + THS_DONE + '];',
'  if (O.op == 0u) {',
'    let rr = S[' + THS_RR + ']; let bn2 = max(rr, 1e-12 * S[' + THS_Q2 + ']);',
'    let thr = S[' + THS_CFG + '].x * bn2;',
'    S[' + THS_BN2 + '] = bn2; S[' + THS_THR2 + '] = thr;',
'    for (var l = 0; l < 3; l++) { done[l] = select(0.0, 1.0, rr[l] <= thr[l] || bn2[l] <= 0.0); }',
'    done[3] = 1.0;',
'    S[' + THS_IT + '] = vec4<f32>(0.0); S[' + THS_ALPHA + '] = vec4<f32>(0.0); S[' + THS_BETA + '] = vec4<f32>(0.0);',
'  } else if (O.op == 1u) {',
'    var al = vec4<f32>(0.0); var it = S[' + THS_IT + ']; let pap = S[' + THS_PAP + ']; let rz = S[' + THS_RZ + '];',
'    for (var l = 0; l < 3; l++) {',
'      if (done[l] == 0.0) {',
'        if (pap[l] > 0.0) { al[l] = rz[l] / pap[l]; it[l] += 1.0; } else { done[l] = 2.0; }',
'      }',
'    }',
'    S[' + THS_ALPHA + '] = al; S[' + THS_IT + '] = it;',
'  } else if (O.op == 2u) {',
'    let rr = S[' + THS_RR + ']; let thr = S[' + THS_THR2 + '];',
'    for (var l = 0; l < 3; l++) {',
'      if (done[l] == 0.0) {',
'        if (!(rr[l] == rr[l]) || rr[l] > 1e30) { done[l] = 3.0; }',
'        else if (rr[l] <= thr[l]) { done[l] = 1.0; }',
'      }',
'    }',
'  } else {',
'    var be = vec4<f32>(0.0); var rz = S[' + THS_RZ + ']; let rzn = S[' + THS_RZN + '];',
'    for (var l = 0; l < 3; l++) {',
'      if (done[l] == 0.0 && rz[l] != 0.0) { be[l] = rzn[l] / rz[l]; rz[l] = rzn[l]; }',
'    }',
'    S[' + THS_BETA + '] = be; S[' + THS_RZ + '] = rz;',
'  }',
'  S[' + THS_DONE + '] = done;',
'}'
].join('\n');

/* T += α p ; r −= α Ap */
var TH_XR_WGSL = [
'struct ZP { N3: u32, pad0: u32, pad1: u32, pad2: u32 }',
'@group(0) @binding(0) var<storage, read> p: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read> Ap: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read_write> T: array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read_write> r: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read> S: array<vec4<f32>>;',
'@group(0) @binding(5) var<uniform> Z: ZP;',
'@compute @workgroup_size(64)',
'fn th_xr(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {',
'  let e = gid.x + gid.y * nw.x * 64u;',
'  if (e >= Z.N3) { return; }',
'  let al = S[' + THS_ALPHA + '];',
'  T[e] = T[e] + al * p[e];',
'  r[e] = r[e] - al * Ap[e];',
'}'
].join('\n');

/* p = z + β p */
var TH_PUPD_WGSL = [
'struct ZP { N3: u32, pad0: u32, pad1: u32, pad2: u32 }',
'@group(0) @binding(0) var<storage, read> z: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read_write> p: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read> S: array<vec4<f32>>;',
'@group(0) @binding(3) var<uniform> Z: ZP;',
'@compute @workgroup_size(64)',
'fn th_pupd(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {',
'  let e = gid.x + gid.y * nw.x * 64u;',
'  if (e >= Z.N3) { return; }',
'  p[e] = z[e] + S[' + THS_BETA + '] * p[e];',
'}'
].join('\n');

/* r (3 lanes) → two complex slots: (r.x, r.y) and (r.z, 0) */
var TH_PACK_WGSL = [
'struct ZP { N3: u32, pad0: u32, pad1: u32, pad2: u32 }',
'@group(0) @binding(0) var<storage, read> r: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read_write> F: array<vec2<f32>>;',
'@group(0) @binding(2) var<uniform> Z: ZP;',
'@compute @workgroup_size(64)',
'fn th_pack(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {',
'  let e = gid.x + gid.y * nw.x * 64u;',
'  if (e >= Z.N3) { return; }',
'  let v = r[e];',
'  F[e] = vec2<f32>(v.x, v.y);',
'  F[Z.N3 + e] = vec2<f32>(v.z, 0.0);',
'}'
].join('\n');
var TH_UNPACK_WGSL = [
'struct ZP { N3: u32, pad0: u32, pad1: u32, pad2: u32 }',
'@group(0) @binding(0) var<storage, read> F: array<vec2<f32>>;',
'@group(0) @binding(1) var<storage, read_write> z: array<vec4<f32>>;',
'@group(0) @binding(2) var<uniform> Z: ZP;',
'@compute @workgroup_size(64)',
'fn th_unpack(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {',
'  let e = gid.x + gid.y * nw.x * 64u;',
'  if (e >= Z.N3) { return; }',
'  let a = F[e]; let b = F[Z.N3 + e];',
'  z[e] = vec4<f32>(a.x, a.y, b.x, 0.0);',
'}'
].join('\n');

/* multiply by the inverse symbol (both slots).  The symbol is symmetric in
   the three axes, so the FFT plan's own index order does not matter. */
function thSymbolWGSL(inPlace) {
  return [
'struct YP { N: u32, N3: u32, pad0: u32, pad1: u32 }',
inPlace ? '@group(0) @binding(0) var<storage, read_write> F: array<vec2<f32>>;'
        : '@group(0) @binding(0) var<storage, read> Fs: array<vec2<f32>>;\n@group(0) @binding(1) var<storage, read_write> F: array<vec2<f32>>;',
inPlace ? '@group(0) @binding(1) var<uniform> Y: YP;' : '@group(0) @binding(2) var<uniform> Y: YP;',
'fn sn2(n: u32, N: u32) -> f32 { let s = sin(3.14159265358979 * f32(n) / f32(N)); return 4.0 * s * s; }',
'fn cs2(n: u32, N: u32) -> f32 { if (2u * n == N) { return 0.0; } let c = cos(3.14159265358979 * f32(n) / f32(N)); return c * c; }',
'@compute @workgroup_size(64)',
'fn th_symbol(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {',
'  let e = gid.x + gid.y * nw.x * 64u;',
'  if (e >= 2u * Y.N3) { return; }',
'  let N = Y.N; let p = e % Y.N3;',
'  let a = p % N; let b = (p / N) % N; let c = p / (N * N);',
'  let ca = cs2(a, N); let cb = cs2(b, N); let cc = cs2(c, N);',
'  let lam = 0.25 * (sn2(a, N) * cb * cc + sn2(b, N) * ca * cc + sn2(c, N) * ca * cb);',
'  let s = select(0.0, 1.0 / lam, lam > 1e-10);',
inPlace ? '  F[e] = F[e] * s;' : '  F[e] = Fs[e] * s;',
'}'
  ].join('\n');
}

/* ── Solver ────────────────────────────────────────────────────────── */
function ThermalGPUSolver(N) {
  var d = WGPU.device, BU = GPUBufferUsage;
  this.N = N; this.N3 = N * N * N; this.device = d;
  var N3 = this.N3, vb = N3 * 16;
  var mk = function (size, usage) { return d.createBuffer({ size: size, usage: usage }); };
  var SB = BU.STORAGE | BU.COPY_SRC | BU.COPY_DST;
  this.vox = mk(vb, SB); this.T = mk(vb, SB); this.r = mk(vb, SB); this.p = mk(vb, SB); this.Ap = mk(vb, SB);
  this.sclr = mk(THS_COUNT * 16, SB);
  this.part = mk(TH_MAX_PARTIALS * 5 * 16, BU.STORAGE);
  this.rb = mk(THS_COUNT * 16, BU.COPY_DST | BU.MAP_READ);
  this.fft = new FFTPlan(N, 2);
  this.inPlace = (this.fft.fwdResultBuf === this.fft.bufA);
  var pipe = function (code, entry) { return d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: code }), entryPoint: entry } }); };
  this.pApply = pipe(TH_APPLY_WGSL, 'th_apply');
  this.pStats = pipe(TH_STATS_WGSL, 'th_stats');
  this.pQmag = pipe(TH_QMAG_WGSL, 'th_qmag');
  this.pDot = pipe(TH_DOT_WGSL, 'th_dot');
  this.pSum = pipe(TH_SUM_WGSL, 'th_sum');
  this.pScalar = pipe(TH_SCALAR_WGSL, 'th_scalar');
  this.pXR = pipe(TH_XR_WGSL, 'th_xr');
  this.pPupd = pipe(TH_PUPD_WGSL, 'th_pupd');
  this.pPack = pipe(TH_PACK_WGSL, 'th_pack');
  this.pUnpack = pipe(TH_UNPACK_WGSL, 'th_unpack');
  this.pSym = pipe(thSymbolWGSL(this.inPlace), 'th_symbol');
  var maxWG = (d.limits && d.limits.maxComputeWorkgroupsPerDimension) || 65535;
  var dims = function (threads) { var wg = Math.ceil(threads / 64), x = Math.min(wg, maxWG); return [x, Math.ceil(wg / x)]; };
  this.wgN = dims(N3); this.wg2N = dims(2 * N3);
  this.nwgDot = Math.min(TH_MAX_PARTIALS, Math.ceil(N3 / TH_DOT_WG));
  this.nwgStats = Math.min(TH_MAX_PARTIALS, Math.ceil(N3 / TH_STATS_WG));
  var u = function (words, floats) {
    var b = mk(32, BU.UNIFORM | BU.COPY_DST), ab = new ArrayBuffer(32);
    new Uint32Array(ab, 0, words.length).set(words);
    if (floats) new Float32Array(ab, 16, floats.length).set(floats);
    d.queue.writeBuffer(b, 0, ab); return b;
  };
  /* TP: N, N3, addE, nwg | kF, sgn — kF is rewritten per filler */
  this.uApply = u([N, N3, 0, 0], [1, 1]);
  this.uRhs = u([N, N3, 1, 0], [1, -1]);
  this.uStats = u([N, N3, 1, this.nwgStats], [1, 1]);
  this.uStats0 = u([N, N3, 1, this.nwgStats], [1, 1]);   /* same as uStats; T = 0 at init (bound to the zero p) */
  this.uDot = u([N3, this.nwgDot, 0, 0]);
  this.uZ = u([N3, 0, 0, 0]);
  this.uY = u([N, N3, 0, 0]);
  this.uOp = [u([0, 0, 0, 0]), u([1, 0, 0, 0]), u([2, 0, 0, 0]), u([3, 0, 0, 0])];
  this.uSum = {};
  this.bg = {};
  this._uniforms = [this.uApply, this.uRhs, this.uStats, this.uStats0, this.uDot, this.uZ, this.uY].concat(this.uOp);
}
ThermalGPUSolver.prototype.destroy = function () {
  var self = this;
  ['vox', 'T', 'r', 'p', 'Ap', 'sclr', 'part', 'rb'].forEach(function (k) { try { self[k].destroy(); } catch (e) {} });
  this._uniforms.forEach(function (b) { try { b.destroy(); } catch (e) {} });
  for (var k in this.uSum) try { this.uSum[k].destroy(); } catch (e) {}
  try { this.fft.destroy(); } catch (e) {}
};
ThermalGPUSolver.prototype._bgc = function (key, pipeline, buffers) {
  if (!this.bg[key]) {
    var entries = [];
    for (var i = 0; i < buffers.length; i++) entries.push({ binding: i, resource: { buffer: buffers[i] } });
    this.bg[key] = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries });
  }
  return this.bg[key];
};
ThermalGPUSolver.prototype._pass = function (enc, list) {
  var pass = enc.beginComputePass();
  for (var i = 0; i < list.length; i++) { pass.setPipeline(list[i][0]); pass.setBindGroup(0, list[i][1]); pass.dispatchWorkgroups(list[i][2], list[i][3] || 1, 1); }
  pass.end();
};
ThermalGPUSolver.prototype._sumU = function (slot, nOut, count) {
  var key = slot + ':' + nOut + ':' + count;
  if (!this.uSum[key]) {
    this.uSum[key] = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.uSum[key], 0, new Uint32Array([count, slot, nOut, 0]));
  }
  return this.uSum[key];
};
/* out = sgn·Dᵀ k (D in + addE E) */
ThermalGPUSolver.prototype._apply = function (enc, inName, outName, rhs) {
  var u = rhs ? this.uRhs : this.uApply;
  this._pass(enc, [[this.pApply, this._bgc('ap:' + inName + '>' + outName + (rhs ? ':b' : ''), this.pApply, [this.vox, this[inName], this[outName], u]), this.wgN[0], this.wgN[1]]]);
};
ThermalGPUSolver.prototype._dot = function (enc, aName, bName, slot) {
  this._pass(enc, [
    [this.pDot, this._bgc('dot:' + aName + '.' + bName, this.pDot, [this[aName], this[bName], this.part, this.uDot]), this.nwgDot],
    [this.pSum, this._bgc('sum:' + slot, this.pSum, [this.part, this.sclr, this._sumU(slot, 1, this.nwgDot)]), 1]
  ]);
};
ThermalGPUSolver.prototype._stats = function (enc, tName) {
  var u = tName === 'T' ? this.uStats : this.uStats0;
  this._pass(enc, [
    [this.pStats, this._bgc('st:' + tName, this.pStats, [this.vox, this[tName], this.part, u]), this.nwgStats],
    [this.pSum, this._bgc('sumst', this.pSum, [this.part, this.sclr, this._sumU(THS_SX, 5, this.nwgStats)]), 5]
  ]);
};
ThermalGPUSolver.prototype._scalar = function (enc, op) {
  this._pass(enc, [[this.pScalar, this._bgc('op' + op, this.pScalar, [this.sclr, this.uOp[op]]), 1]]);
};
/* z (in the Ap buffer) = P r */
ThermalGPUSolver.prototype._precond = function (enc) {
  var F = this.fft;
  this._pass(enc, [[this.pPack, this._bgc('pack', this.pPack, [this.r, F.bufA, this.uZ]), this.wgN[0], this.wgN[1]]]);
  F.forwardEncoded(enc);
  var sbg = this.inPlace ? this._bgc('sym', this.pSym, [F.bufA, this.uY]) : this._bgc('sym', this.pSym, [F.fwdResultBuf, F.bufA, this.uY]);
  this._pass(enc, [[this.pSym, sbg, this.wg2N[0], this.wg2N[1]]]);
  F.inverseEncoded(enc);
  this._pass(enc, [[this.pUnpack, this._bgc('unpack', this.pUnpack, [F.invResultBuf, this.Ap, this.uZ]), this.wgN[0], this.wgN[1]]]);
};
ThermalGPUSolver.prototype._iter = function (enc) {
  this._apply(enc, 'p', 'Ap', false);
  this._dot(enc, 'p', 'Ap', THS_PAP);
  this._scalar(enc, 1);
  this._pass(enc, [[this.pXR, this._bgc('xr', this.pXR, [this.p, this.Ap, this.T, this.r, this.sclr, this.uZ]), this.wgN[0], this.wgN[1]]]);
  this._dot(enc, 'r', 'r', THS_RR);
  this._scalar(enc, 2);
  this._precond(enc);
  this._dot(enc, 'r', 'Ap', THS_RZN);
  this._scalar(enc, 3);
  this._pass(enc, [[this.pPupd, this._bgc('pupd', this.pPupd, [this.Ap, this.p, this.sclr, this.uZ]), this.wgN[0], this.wgN[1]]]);
};
ThermalGPUSolver.prototype._read = async function (enc) {
  enc.copyBufferToBuffer(this.sclr, 0, this.rb, 0, THS_COUNT * 16);
  this.device.queue.submit([enc.finish()]);
  await this.rb.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(this.rb.getMappedRange().slice(0));
  this.rb.unmap();
  return v;
};
ThermalGPUSolver.prototype._readBuf = async function (buf, bytes) {
  var d = this.device, rb = d.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, rb, 0, bytes); d.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  var out = new Float32Array(rb.getMappedRange().slice(0));
  rb.unmap(); rb.destroy();
  return out;
};

/* Upload phi + normal (solver order) as vec4 per voxel. */
ThermalGPUSolver.prototype.upload = function (vt) {
  var N3 = this.N3, a = new Float32Array(4 * N3), phi = vt.phi, n = vt.n;
  for (var p = 0; p < N3; p++) { var o = 4 * p; a[o] = phi[p]; a[o + 1] = n[3 * p]; a[o + 2] = n[3 * p + 1]; a[o + 3] = n[3 * p + 2]; }
  this.device.queue.writeBuffer(this.vox, 0, a);
};

/* One filler: three load cases at once.  K in W/m·K (row-major, column j = load e_j). */
ThermalGPUSolver.prototype.solve = async function (kS, kF, opts) {
  opts = opts || {};
  var d = this.device, N3 = this.N3, tol = opts.tol || 1e-5, maxIt = opts.maxiter || 3000;
  var kr = kF / kS;
  [this.uApply, this.uRhs, this.uStats, this.uStats0].forEach(function (b) { d.queue.writeBuffer(b, 16, new Float32Array([kr])); });
  var cfg = new Float32Array(4 * THS_COUNT); cfg[4 * THS_CFG] = tol * tol;
  d.queue.writeBuffer(this.sclr, 0, cfg);
  var enc = d.createCommandEncoder();
  enc.clearBuffer(this.T); enc.clearBuffer(this.p);
  this._apply(enc, 'T', 'r', true);          /* r = b = −Dᵀ k E  (T = 0) */
  this._stats(enc, 'p');                      /* Σ|kE|² for the residual floor (p = 0 here) */
  this._dot(enc, 'r', 'r', THS_RR);
  this._scalar(enc, 0);
  this._precond(enc);                         /* z = P r (in Ap) */
  enc.copyBufferToBuffer(this.Ap, 0, this.p, 0, N3 * 16);
  this._dot(enc, 'r', 'Ap', THS_RZ);
  /* window.THERMAL_BLOCK0: smallest block (headless SwiftShader resolves each
     readback slowly, so its tests run bigger blocks; extra iterations after
     convergence are no-ops) */
  var b0 = (typeof window !== 'undefined' && window.THERMAL_BLOCK0) || 1;
  var encoded = 0, block = b0, v, checkMax = Math.max(b0, (typeof window !== 'undefined' && window.THERMAL_CHECK_MAX) || 16), reads = 0;
  v = await this._read(enc); reads++;
  while (!(v[4 * THS_DONE] > 0 && v[4 * THS_DONE + 1] > 0 && v[4 * THS_DONE + 2] > 0) && encoded < maxIt) {
    enc = d.createCommandEncoder();
    var nb = Math.min(block, maxIt - encoded);
    for (var k = 0; k < nb; k++) this._iter(enc);
    encoded += nb;
    v = await this._read(enc); reads++;
    block = Math.min(checkMax, Math.max(b0, Math.floor(encoded / 4)));
  }
  enc = d.createCommandEncoder();
  this._stats(enc, 'T');
  var w = await this._read(enc); reads++;
  var K = new Float64Array(9), perLC = [], energyErr = 0, reasons = ['max_iter', 'converged', 'pAp_breakdown', 'non_finite'];
  for (var lc = 0; lc < 3; lc++) {
    for (var a = 0; a < 3; a++) K[a * 3 + lc] = w[4 * (THS_SX + a) + lc] / N3 * kS;
    var en = w[4 * THS_EN + lc] / N3 * kS;
    energyErr = Math.max(energyErr, Math.abs(en - K[lc * 3 + lc]) / Math.max(Math.abs(K[lc * 3 + lc]), 1e-300));
    var dn = w[4 * THS_DONE + lc] | 0, rr = Math.max(w[4 * THS_RR + lc], 0), bn2 = w[4 * THS_BN2 + lc];
    perLC.push({ axis: 'xyz'.charAt(lc), iters: w[4 * THS_IT + lc] | 0, converged: dn === 1, reason: reasons[dn] || 'max_iter',
                 relRes: bn2 > 0 ? Math.sqrt(rr / bn2) : 0 });
  }
  var nrm = 0, asym = 0;
  for (var e = 0; e < 9; e++) nrm += K[e] * K[e];
  nrm = Math.sqrt(nrm);
  for (var r1 = 0; r1 < 3; r1++) for (var c2 = r1 + 1; c2 < 3; c2++) asym = Math.max(asym, Math.abs(K[r1 * 3 + c2] - K[c2 * 3 + r1]) / (nrm || 1));
  var fields = null;
  if (opts.capture) {
    var Tv = await this._readBuf(this.T, N3 * 16);
    var e2 = d.createCommandEncoder();
    this._pass(e2, [[this.pQmag, this._bgc('qmag', this.pQmag, [this.vox, this.T, this.r, this.uStats]), this.wgN[0], this.wgN[1]]]);
    d.queue.submit([e2.finish()]);
    var Qv = await this._readBuf(this.r, N3 * 16);
    /* v0.21.0 — stored for the viewer at half precision (2 bytes / value,
       solver order): Tc = T̃ averaged from each voxel's 8 corners to its
       centre (the geometry texture's sample points; the average also cancels
       the rotated grid's checkerboard modes, §11.5), in voxel units (mean
       gradient 1 per voxel); q = |q| / (flux of a solid block under the same
       mean gradient). */
    fields = {};
    var N = this.N, NN = N * N, Tc = new Float32Array(N3);
    for (var l = 0; l < 3; l++) {
      for (var i = 0; i < N; i++) { var a0 = i * NN, a1 = ((i + 1) % N) * NN;
        for (var j = 0; j < N; j++) { var b0 = j * N, b1 = ((j + 1) % N) * N;
          for (var k = 0; k < N; k++) { var c0 = k, c1 = (k + 1) % N;
            Tc[a0 + b0 + c0] = 0.125 * (Tv[4 * (a0 + b0 + c0) + l] + Tv[4 * (a1 + b0 + c0) + l] + Tv[4 * (a0 + b1 + c0) + l] + Tv[4 * (a0 + b0 + c1) + l] +
                                        Tv[4 * (a1 + b1 + c0) + l] + Tv[4 * (a1 + b0 + c1) + l] + Tv[4 * (a0 + b1 + c1) + l] + Tv[4 * (a1 + b1 + c1) + l]);
          } } }
      var t16 = new Uint16Array(N3), q16 = new Uint16Array(N3);
      for (var q = 0; q < N3; q++) { t16[q] = thermalF32ToF16(Tc[q]); q16[q] = thermalF32ToF16(Qv[4 * q + l]); }
      fields['xyz'.charAt(l)] = { N: N, Tc: t16, q: q16 };
    }
  }
  return { K: K, perLC: perLC, asym: asym, energyErr: energyErr, fields: fields, readbacks: reads };
};

/* ── Half precision (IEEE 754 binary16) for the stored fields ───────── */
var _thF32 = new Float32Array(1), _thU32 = new Uint32Array(_thF32.buffer);
function thermalF32ToF16(v) {
  _thF32[0] = v;
  var x = _thU32[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) {                                   /* subnormal or zero */
    if (e < -10) return s;
    m = (m | 0x800000) >>> (1 - e);
    return s | ((m + 0x1000) >>> 13);
  }
  if (e >= 31) return s | 0x7c00 | (((x >>> 23) & 0xff) === 0xff && m ? 0x200 : 0);   /* overflow → inf, NaN kept */
  var h = s | (e << 10) | (m >>> 13);
  return (m & 0x1000) ? h + 1 : h;                /* round half up; a carry into the exponent is correct */
}
function thermalF16ToF32(h) {
  var s = (h & 0x8000) ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
function thermalHalfToFloat(a) {
  var out = new Float32Array(a.length);
  for (var i = 0; i < a.length; i++) out[i] = thermalF16ToF32(a[i]);
  return out;
}

/* ── Cache (one grid; dropped with the device) ─────────────────────── */
function thermalGPUSolver(N) {
  var c = (typeof window !== 'undefined') ? window.__thermalGPU : null;
  if (c && c.N === N && c.device === WGPU.device) return c;
  if (c) { try { c.destroy(); } catch (e) {} }
  c = new ThermalGPUSolver(N);
  if (typeof window !== 'undefined') window.__thermalGPU = c;
  return c;
}
function thermalGPURelease() {
  if (typeof window === 'undefined' || !window.__thermalGPU) return;
  try { window.__thermalGPU.destroy(); } catch (e) {}
  window.__thermalGPU = null;
}
if (typeof WGPU_DEVICE_CACHE_KEYS !== 'undefined' && WGPU_DEVICE_CACHE_KEYS.indexOf('__thermalGPU') < 0) WGPU_DEVICE_CACHE_KEYS.push('__thermalGPU');

/* Pore fillers (docs/THERMAL_SCOPE.md §3.4).  k in W/m·K at 37 °C. */
var THERMAL_FILLERS = [
  { id: 'air',    label: 'Air',    k: 0.027, rho: 1.14, cp: 1007 },
  { id: 'water',  label: 'Water',  k: 0.63,  rho: 993,  cp: 4178 },
  { id: 'tissue', label: 'Tissue', k: 0.5,   rho: 1050, cp: 3600 }
];
function thermalFillerById(id) {
  for (var i = 0; i < THERMAL_FILLERS.length; i++) if (THERMAL_FILLERS[i].id === id) return THERMAL_FILLERS[i];
  return null;
}

/* One design, several fillers: voxel walls built once, one solve per filler.
   → { N, kS, rho, rhoPhi, rhoRaw, trimLoss, nSurf, t_voxels_ms, t_solve_ms, voxReuse,
       byFiller: { id: { kF, K, kx, ky, kz, kRel, eff, hsUp, hsLo, anis, perLC, converged,
                          asym, energyErr, fields? , t_ms } } } */
async function homogenizeThermalGPU(recipe, N, opts) {
  opts = opts || {};
  if (!WGPU.device) await ensureDevice();
  var kS = opts.kS;
  var fillers = opts.fillers || THERMAL_FILLERS;
  var tV0 = performance.now();
  var vt = await buildVoxelTensorsParallel(recipe, N, opts, opts.onVoxelProgress);
  var tVox = performance.now() - tV0;
  var nRaw = 0, nKept = 0, N3 = N * N * N;
  for (var p = 0; p < N3; p++) { if (vt.raw[p] > 0.5) nRaw++; if (vt.kept[p] > 0.5) nKept++; }
  var S = thermalGPUSolver(N);
  S.upload(vt);
  var out = { N: N, kS: kS, rho: vt.rho, rhoPhi: vt.rhoPhi, rhoRaw: nRaw / N3, trimLoss: nRaw > 0 ? 1 - nKept / nRaw : 0,
              nSurf: vt.nSurf, t_voxels_ms: tVox, voxReuse: vt.reused, voxWorkers: vt.workers, byFiller: {}, t_solve_ms: 0,
              wraps: null, fragLoss: 0, mask: null };
  /* v0.21.0 — solid mask (half the voxel or more solid) for the viewer's
     flux spread into the pores; 1 byte per voxel, solver order */
  if (opts.capture) { var mk = new Uint8Array(N3); for (var pm = 0; pm < N3; pm++) mk[pm] = vt.phi[pm] >= 0.5 ? 1 : 0; out.mask = mk; }
  /* Which axes the kept solid runs across (wrap bits 1 x, 2 y, 4 z), and the
     share of the raw solid in tiny floating fragments (< 27 voxels, a 3³
     block).  Features thinner than a voxel shatter into such fragments on the
     0/1 grid and the island trim then drops them (THERMAL_SCOPE.md §11.5:
     a 0.7-voxel gyroid sheet at N = 32 → 592 fragments, 100 % of the solid);
     real floating islands (hyperuniform, wave demos) are few and large, and
     do not count. */
  if (typeof periodicComponents === 'function') {
    try {
      var pc = periodicComponents(vt.kept, N), bits = 0;
      for (var c = 1; c <= pc.count; c++) if (pc.wraps[c]) bits |= pc.wraps[c];
      out.wraps = bits;
      var pr = periodicComponents(vt.raw, N), frag = 0;
      for (var c2 = 1; c2 <= pr.count; c2++) if (!pr.wraps[c2] && pr.sizes[c2] < 27) frag += pr.sizes[c2];
      out.fragLoss = nRaw > 0 ? frag / nRaw : 0;
    } catch (e) {}
  }
  for (var fi = 0; fi < fillers.length; fi++) {
    var f = fillers[fi], t0 = performance.now();
    if (opts.onProgress) opts.onProgress({ filler: f.id, index: fi, total: fillers.length });
    var R = await S.solve(kS, f.k, { tol: opts.tol, maxiter: opts.maxiter, capture: !!opts.capture });
    var phi = vt.rhoPhi, hsU = thermalHSUpper(phi, kS, f.k), hsL = thermalHSLower(phi, kS, f.k);
    var kx = R.K[0], ky = R.K[4], kz = R.K[8], kmax = Math.max(kx, ky, kz), kmin = Math.min(kx, ky, kz);
    var kMean = (kx + ky + kz) / 3;
    out.byFiller[f.id] = {
      kF: f.k, K: Array.from(R.K), kx: kx, ky: ky, kz: kz, kRel: kMean / kS, eff: kMean / hsU, hsUp: hsU, hsLo: hsL,
      anis: kmin > 0 ? kmax / kmin : Infinity, perLC: R.perLC, converged: R.perLC.every(function (q) { return q.converged; }),
      asym: R.asym, energyErr: R.energyErr, fields: R.fields, t_ms: performance.now() - t0
    };
    out.t_solve_ms += performance.now() - t0;
  }
  return out;
}

/* ── Console checks ────────────────────────────────────────────────── */
/* T9 / T10 / T11: GPU vs 17a (Float64) on the demo designs, Ti-6Al-4V in
   air / water / tissue.  await runThermalGPUCheck(32) */
async function runThermalGPUCheck(N, recipes) {
  N = N || 32;
  if (!WGPU.device) await ensureDevice();
  var names = recipes ? Object.keys(recipes) : ['schwarzP', 'beamBCC', 'hyperuniform', 'spinodoid', 'waveCubic'];
  var src = recipes || DEMO_RECIPES, rows = [], allPass = true, kS = 6.7;
  for (var i = 0; i < names.length; i++) {
    var rec = src[names[i]];
    if (!rec) continue;
    var G = await homogenizeThermalGPU(rec, N, { kS: kS, tol: 1e-6, connectivity: 'networks', pruneLargest: true });
    var vt = buildVoxelTensors(rec, N, { connectivity: 'networks' });
    for (var fi = 0; fi < THERMAL_FILLERS.length; fi++) {
      var f = THERMAL_FILLERS[fi], g = G.byFiller[f.id];
      var C = solveThermalCPU(vt, kS, f.k, { tol: 1e-9 });
      var err = 0, nrm = Math.max(Math.abs(C.K[0]), Math.abs(C.K[4]), Math.abs(C.K[8]));
      for (var e = 0; e < 9; e++) err = Math.max(err, Math.abs(g.K[e] - C.K[e]) / nrm);
      /* bounds: the direction-averaged κ inside Hashin–Shtrikman (the trace
         bound holds for anisotropic cells too); each axis inside the plain
         series / parallel (Wiener) limits — a directional cell (bundle) can
         beat the isotropic HS bound along its fibres, never the volume average */
      var phi = G.rhoPhi, wLo = 1 / (phi / kS + (1 - phi) / f.k), wHi = phi * kS + (1 - phi) * f.k, mean = (g.K[0] + g.K[4] + g.K[8]) / 3;
      var inside = mean >= g.hsLo * 0.999 && mean <= g.hsUp * 1.001 &&
                   [0, 4, 8].every(function (q) { return g.K[q] >= wLo * 0.999 && g.K[q] <= wHi * 1.001; });
      var pass = err < 1e-3 && g.asym < 5e-3 && g.energyErr < 5e-3 && inside && g.converged;
      if (!pass) allPass = false;
      rows.push({ design: names[i], filler: f.id, kx: +g.kx.toFixed(4), ky: +g.ky.toFixed(4), kz: +g.kz.toFixed(4),
                  cpu_kx: +C.K[0].toFixed(4), max_diff_pct: +(err * 100).toFixed(3), asym: g.asym.toExponential(1),
                  energy: g.energyErr.toExponential(1), in_HS: inside, iters: g.perLC.map(function (q) { return q.iters; }).join('/'),
                  ms: Math.round(g.t_ms), pass: pass });
    }
    /* T11: air < tissue < water on every axis */
    var bf = G.byFiller, ok11 = [0, 4, 8].every(function (q) { return bf.air.K[q] < bf.tissue.K[q] && bf.tissue.K[q] < bf.water.K[q]; });
    if (!ok11) allPass = false;
    rows.push({ design: names[i], filler: 'order air<tissue<water', pass: ok11, ms: Math.round(G.t_voxels_ms), iters: 'voxels ' + G.voxReuse });
  }
  console.table(rows);
  console.log('[thermal GPU] N=' + N + ' ' + (allPass ? 'PASS' : 'FAIL'));
  return { pass: allPass, rows: rows };
}

/* §11.4 † — BCC beams at N = 128 with the shipped three-tier walls, on the
   GPU (Phase 0 needed ~16 min of CPU; matches 17a at N = 32 by T9).
   await runThermalBeamReference()  → κ_x for Ti/air and Cu/air */
async function runThermalBeamReference(N) {
  N = N || 128;
  if (!WGPU.device) await ensureDevice();
  var rec = DEMO_RECIPES.beamBCC, t0 = performance.now();
  var vt = await buildVoxelTensorsParallel(rec, N, { connectivity: 'networks', pruneLargest: true });
  var tV = performance.now() - t0, S = thermalGPUSolver(N);
  S.upload(vt);
  var t1 = performance.now(), a = await S.solve(6.7, 0.027, { tol: 1e-6, maxiter: 5000 }), t2 = performance.now();
  var b = await S.solve(400, 0.027, { tol: 1e-6, maxiter: 5000 }), t3 = performance.now();
  var its = function (R) { return R.perLC.map(function (q) { return q.iters + (q.converged ? '' : '!'); }).join('/'); };
  var out = { N: N, solid_pct: +(vt.rhoPhi * 100).toFixed(2), Ti_air_kx: +a.K[0].toFixed(4), Ti_air_iters: its(a), Ti_air_s: +((t2 - t1) / 1000).toFixed(1),
              Cu_air_kx: +b.K[0].toFixed(3), Cu_air_iters: its(b), Cu_air_s: +((t3 - t2) / 1000).toFixed(1),
              walls_s: +(tV / 1000).toFixed(1), phase0_N64: { Ti_air: 0.2098, Cu_air: 10.61 }, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
  console.log('[thermal] BCC beam reference', out);
  return out;
}
