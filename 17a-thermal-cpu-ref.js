/* ============================================================
   F13LD.lab · 17a-thermal-cpu-ref.js   (v0.19.3 — thermal Phase 0)
   Float64 CPU reference for effective thermal conductivity.
   docs/THERMAL_SCOPE.md §3 and §11 · the GPU solver (Phase 1) mirrors it.

   Grid: the "rotated" scheme the stiffness solver uses (Willot 2015).
   Temperature correction T̃ at voxel CORNERS (nodes); in each voxel the
   gradient is constant, per axis the mean of the voxel's 4 edge
   differences (grid spacing 1):
       g_x = ¼ Σ_{4 x-edges} (T̃(+x end) − T̃(−x end)),  likewise y, z.
   Each voxel carries a full 3×3 conductivity, the laminate composite of
   14e buildVoxelTensors (solid fraction phi, wall normal n):
       k = k_par (I − n nᵀ) + k_ser n nᵀ,
       k_par = phi kS + (1 − phi) kF,   k_ser = 1 / (phi/kS + (1 − phi)/kF)
   (Kabel, Merkert & Schneider 2015).  Pure voxels: k = kS or kF.

   Galerkin form: minimize ⟨(g + E)·k·(g + E)⟩ over periodic T̃, i.e.
       Dᵀ k D T̃ = − Dᵀ k E,
   symmetric positive semi-definite for ANY symmetric k, so CG applies with
   anisotropic composite voxels (the 16b stiffness CG cannot take them:
   PARTIAL_VOLUME.md §3).  Null space: constants and the checkerboard
   modes of the rotated gradient — the right-hand side never excites them.
   Preconditioner: the same operator with uniform k, diagonal in Fourier
   space, symbol ¼ Σ_a 4 sin²(ξ_a/2) Π_{b≠a} cos²(ξ_b/2), its zero set dropped.

   Why not one conductance per face (the first Phase 0 scheme, kept in
   proto/thermal/faces-tpfa.js): a two-point stencil can't carry the
   off-diagonal conductivity of an inclined wall, so walls at an angle to
   the grid read low by roughly 0.35 / (wall thickness in voxels) — 8–16 %
   on a sheet gyroid at N = 64.  This scheme is exact for flat walls at
   any angle (T2b) and within 3 % of N = 128 at N = 64 on a 6 % gyroid sheet.

   Effective conductivity, column j from load case E = e_j:
       K_ij = ⟨ q_i ⟩,   q = k (g + E)   (mean over voxels)
   (physical flux = −K ∇T; the mean temperature gradient is E).
   Health: asymmetry |K_ij − K_ji| / ‖K‖ and the energy form
       E·K·E = ⟨ (g + E)·q ⟩  vs  K_jj.

   API
     thermalVoxelConductivity(vt, kS, kF, opts) → Float64Array 6·N³ (xx yy zz xy xz yz)
         opts.voigt: isotropic k_par in surface voxels (the elastic blend; comparison only)
     solveThermalCPU(vt, kS, kF, opts)  → { K (9, row-major), perLC, asym, energyErr, fields }
         opts: { tol (1e-8), maxiter (5000), keepFields, voigt }
         fields (keepFields): per load case { axis, Tn (node T̃, Float32 N³), qMag (per voxel) }
     homogenizeThermalCPU(recipe, N, opts) → the above + { rho, rhoPhi, kS, kF, N, tensors }
         opts: connectivity / pruneLargest (as elastic), kS, kF, staircase, voigt
   Needs fft3dCpu (18-stokes-cpu-ref.js) and 14e-link-field.js.
   ============================================================ */

function thermalVoxelConductivity(vt, kS, kF, opts) {
  opts = opts || {};
  var N3 = vt.N * vt.N * vt.N, Kt = new Float64Array(6 * N3);
  for (var p = 0; p < N3; p++) {
    var f = vt.phi[p], o = 6 * p;
    if (f >= 1 || f <= 0) { var kk = f >= 1 ? kS : kF; Kt[o] = Kt[o + 1] = Kt[o + 2] = kk; continue; }
    var kp = f * kS + (1 - f) * kF, ks = opts.voigt ? kp : 1 / (f / kS + (1 - f) / kF), dk = ks - kp;
    var nx = vt.n[3 * p], ny = vt.n[3 * p + 1], nz = vt.n[3 * p + 2];
    Kt[o] = kp + dk * nx * nx; Kt[o + 1] = kp + dk * ny * ny; Kt[o + 2] = kp + dk * nz * nz;
    Kt[o + 3] = dk * nx * ny;  Kt[o + 4] = dk * nx * nz;      Kt[o + 5] = dk * ny * nz;
  }
  return Kt;
}

function solveThermalCPU(vt, kS, kF, opts) {
  opts = opts || {};
  var tol = opts.tol || 1e-8, maxit = opts.maxiter || 5000;
  var N = vt.N, NN = N * N, N3 = NN * N, PI = Math.PI;
  var Kt = thermalVoxelConductivity(vt, kS, kF, opts);
  /* the 8 corner nodes of each voxel, periodic: node (i..i+1, j..j+1, k..k+1) */
  var I1 = new Int32Array(N);
  for (var n0 = 0; n0 < N; n0++) I1[n0] = (n0 + 1) % N;
  var g = new Float64Array(3 * N3), q = new Float64Array(3 * N3);
  function grad(T) {
    for (var i = 0; i < N; i++) { var a0 = i * NN, a1 = I1[i] * NN;
      for (var j = 0; j < N; j++) { var b0 = j * N, b1 = I1[j] * N;
        for (var k = 0; k < N; k++) { var c0 = k, c1 = I1[k];
          var t000 = T[a0 + b0 + c0], t100 = T[a1 + b0 + c0], t010 = T[a0 + b1 + c0], t001 = T[a0 + b0 + c1];
          var t110 = T[a1 + b1 + c0], t101 = T[a1 + b0 + c1], t011 = T[a0 + b1 + c1], t111 = T[a1 + b1 + c1];
          var c = 3 * (a0 + b0 + c0);
          g[c]     = 0.25 * (t100 - t000 + t110 - t010 + t101 - t001 + t111 - t011);
          g[c + 1] = 0.25 * (t010 - t000 + t110 - t100 + t011 - t001 + t111 - t101);
          g[c + 2] = 0.25 * (t001 - t000 + t101 - t100 + t011 - t010 + t111 - t110);
        } } }
  }
  function flux(E) {
    for (var p = 0; p < N3; p++) {
      var a = g[3 * p] + E[0], b = g[3 * p + 1] + E[1], c = g[3 * p + 2] + E[2], o = 6 * p;
      q[3 * p]     = Kt[o] * a + Kt[o + 3] * b + Kt[o + 4] * c;
      q[3 * p + 1] = Kt[o + 3] * a + Kt[o + 1] * b + Kt[o + 5] * c;
      q[3 * p + 2] = Kt[o + 4] * a + Kt[o + 5] * b + Kt[o + 2] * c;
    }
  }
  function divT(out) {   /* out = Dᵀ q, scattered to the nodes */
    out.fill(0);
    for (var i = 0; i < N; i++) { var a0 = i * NN, a1 = I1[i] * NN;
      for (var j = 0; j < N; j++) { var b0 = j * N, b1 = I1[j] * N;
        for (var k = 0; k < N; k++) { var c0 = k, c1 = I1[k], c = 3 * (a0 + b0 + c0);
          var qx = 0.25 * q[c], qy = 0.25 * q[c + 1], qz = 0.25 * q[c + 2];
          out[a0 + b0 + c0] += -qx - qy - qz; out[a1 + b0 + c0] += qx - qy - qz;
          out[a0 + b1 + c0] += -qx + qy - qz; out[a0 + b0 + c1] += -qx - qy + qz;
          out[a1 + b1 + c0] += qx + qy - qz;  out[a1 + b0 + c1] += qx - qy + qz;
          out[a0 + b1 + c1] += -qx + qy + qz; out[a1 + b1 + c1] += qx + qy + qz;
        } } }
  }
  var Z = [0, 0, 0];
  function applyA(T, out) { grad(T); flux(Z); divT(out); }
  /* Fourier symbol of the uniform operator (scale irrelevant for PCG) */
  var sym = new Float64Array(N3), sn2 = new Float64Array(N), cs2 = new Float64Array(N);
  for (var n = 0; n < N; n++) { var sn = Math.sin(PI * n / N), cn = Math.cos(PI * n / N); sn2[n] = 4 * sn * sn; cs2[n] = cn * cn; }
  for (var a1 = 0; a1 < N; a1++) for (var b1 = 0; b1 < N; b1++) for (var c1 = 0; c1 < N; c1++) {
    var lam = 0.25 * (sn2[a1] * cs2[b1] * cs2[c1] + sn2[b1] * cs2[a1] * cs2[c1] + sn2[c1] * cs2[a1] * cs2[b1]);
    sym[a1 * NN + b1 * N + c1] = lam > 1e-12 ? 1 / (lam * kS) : 0;
  }
  var work = new Float64Array(2 * N3), line = new Float64Array(2 * N);
  function precond(r, z) {
    for (var p = 0; p < N3; p++) { work[2 * p] = r[p]; work[2 * p + 1] = 0; }
    fft3dCpu(work, N, false, line);
    for (var p2 = 0; p2 < N3; p2++) { work[2 * p2] *= sym[p2]; work[2 * p2 + 1] *= sym[p2]; }
    fft3dCpu(work, N, true, line);
    for (var p3 = 0; p3 < N3; p3++) z[p3] = work[2 * p3];
  }
  function dot(u, v) { var s = 0; for (var p = 0; p < N3; p++) s += u[p] * v[p]; return s; }
  var K = new Float64Array(9), perLC = [], energyErr = 0, fields = opts.keepFields ? [] : null;
  var T = new Float64Array(N3), r = new Float64Array(N3), z = new Float64Array(N3), pv = new Float64Array(N3), Ap = new Float64Array(N3), b = new Float64Array(N3);
  for (var lc = 0; lc < 3; lc++) {
    var E = [0, 0, 0]; E[lc] = 1;
    g.fill(0); flux(E);
    var qn = 0; for (var p6 = 0; p6 < 3 * N3; p6++) qn += q[p6] * q[p6]; qn = Math.sqrt(qn);
    divT(b); for (var p4 = 0; p4 < N3; p4++) b[p4] = -b[p4];
    T.fill(0); r.set(b);
    /* residual measured against the load's own size, so a load the geometry
       doesn't disturb (b ≈ 0 up to rounding, e.g. along a laminate) is done at once */
    var bn = Math.max(Math.sqrt(dot(b, b)), 1e-6 * qn), it = 0, rel = Math.sqrt(dot(b, b)) / (bn || 1), conv = !(rel >= tol);
    if (!conv) {
      precond(r, z); pv.set(z);
      var rz = dot(r, z);
      for (it = 1; it <= maxit; it++) {
        applyA(pv, Ap);
        var pAp = dot(pv, Ap);
        if (!(pAp > 0)) break;
        var al = rz / pAp;
        for (var q1 = 0; q1 < N3; q1++) { T[q1] += al * pv[q1]; r[q1] -= al * Ap[q1]; }
        rel = Math.sqrt(dot(r, r)) / bn;
        if (rel < tol) { conv = true; break; }
        precond(r, z);
        var rzN = dot(r, z), be = rzN / rz; rz = rzN;
        for (var q2 = 0; q2 < N3; q2++) pv[q2] = z[q2] + be * pv[q2];
      }
    }
    grad(T); flux(E);
    var fl = [0, 0, 0], en = 0;
    for (var p5 = 0; p5 < N3; p5++) {
      var qx = q[3 * p5], qy = q[3 * p5 + 1], qz = q[3 * p5 + 2];
      fl[0] += qx; fl[1] += qy; fl[2] += qz;
      en += (g[3 * p5] + E[0]) * qx + (g[3 * p5 + 1] + E[1]) * qy + (g[3 * p5 + 2] + E[2]) * qz;
    }
    for (var a4 = 0; a4 < 3; a4++) K[a4 * 3 + lc] = fl[a4] / N3;
    en /= N3;
    energyErr = Math.max(energyErr, Math.abs(en - K[lc * 3 + lc]) / Math.max(Math.abs(K[lc * 3 + lc]), 1e-300));
    perLC.push({ axis: 'xyz'.charAt(lc), iters: it, converged: conv, relRes: rel });
    if (fields) {
      var qm = new Float32Array(N3);
      for (var p7 = 0; p7 < N3; p7++) qm[p7] = Math.sqrt(q[3 * p7] * q[3 * p7] + q[3 * p7 + 1] * q[3 * p7 + 1] + q[3 * p7 + 2] * q[3 * p7 + 2]);
      fields.push({ axis: 'xyz'.charAt(lc), Tn: Float32Array.from(T), qMag: qm });
    }
  }
  var nrm = 0, asym = 0;
  for (var e = 0; e < 9; e++) nrm += K[e] * K[e];
  nrm = Math.sqrt(nrm);
  for (var r1 = 0; r1 < 3; r1++) for (var c2 = r1 + 1; c2 < 3; c2++) asym = Math.max(asym, Math.abs(K[r1 * 3 + c2] - K[c2 * 3 + r1]) / (nrm || 1));
  return { K: K, perLC: perLC, asym: asym, energyErr: energyErr, fields: fields };
}

function homogenizeThermalCPU(recipe, N, opts) {
  opts = opts || {};
  var kS = opts.kS > 0 ? opts.kS : ((recipe.material && recipe.material.ks_WmK) || 6.7);
  var kF = opts.kF > 0 ? opts.kF : 0.027;
  var vt = buildVoxelTensors(recipe, N, opts);
  var R = solveThermalCPU(vt, kS, kF, opts);
  R.rho = vt.rho; R.rhoPhi = vt.rhoPhi; R.kS = kS; R.kF = kF; R.N = N;
  R.tensors = { nSurf: vt.nSurf, nPlane: vt.nPlane, t_ms: vt.t_ms };
  return R;
}

/* Hashin–Shtrikman upper bound for solid fraction phi of kS in kF. */
function thermalHSUpper(phi, kS, kF) {
  if (phi >= 1) return kS;
  return kS + (1 - phi) / (1 / (kF - kS) + phi / (3 * kS));
}
function thermalHSLower(phi, kS, kF) {
  if (phi <= 0) return kF;
  return kF + phi / (1 / (kS - kF) + (1 - phi) / (3 * kF));
}

/* Console check (browser or node): demo designs, Ti-6Al-4V in air / water /
   tissue at N (default 32) — κ, Hashin–Shtrikman envelope, iterations. */
function runThermalCPUCheck(N) {
  N = N || 32;
  var fillers = [['air', 0.027], ['water', 0.63], ['tissue', 0.5]], rows = [];
  ['schwarzP', 'beamBCC', 'hyperuniform'].forEach(function (nm) {
    var rec = (typeof DEMO_RECIPES !== 'undefined') ? DEMO_RECIPES[nm] : null;
    if (!rec) return;
    fillers.forEach(function (f) {
      var t0 = Date.now(), R = homogenizeThermalCPU(rec, N, { kS: 6.7, kF: f[1] });
      var phi = R.rhoPhi, lo = thermalHSLower(phi, 6.7, f[1]), hi = thermalHSUpper(phi, 6.7, f[1]);
      rows.push({ design: nm, filler: f[0], solid_pct: +(phi * 100).toFixed(2), kx: +R.K[0].toFixed(4), ky: +R.K[4].toFixed(4), kz: +R.K[8].toFixed(4),
                  HS_low: +lo.toFixed(4), HS_high: +hi.toFixed(4), inside: R.K[0] >= lo * 0.999 && R.K[0] <= hi * 1.001,
                  iters: R.perLC.map(function (p) { return p.iters; }).join('/'), asym: R.asym.toExponential(1), energy: R.energyErr.toExponential(1), s: ((Date.now() - t0) / 1000).toFixed(1) });
    });
  });
  if (typeof console.table === 'function') console.table(rows); else console.log(rows);
  return rows;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { thermalVoxelConductivity: thermalVoxelConductivity, solveThermalCPU: solveThermalCPU,
    homogenizeThermalCPU: homogenizeThermalCPU, thermalHSUpper: thermalHSUpper, thermalHSLower: thermalHSLower, runThermalCPUCheck: runThermalCPUCheck };
}
