/* ============================================================
   F13LD.lab · 16h-buckling-fe.js   (Sprint B, v0.8.0)
   Cell-periodic (q = 0) linear buckling by matrix-free voxel
   finite elements.  Replaces the spectral buckling path (16c),
   whose Willot operator has hundreds of zero-energy patterns in
   the solid (510 on an all-solid 8³ cell; 3 are legitimate), so
   its eigen-solve found void-controlled artifacts: the critical
   load tracked the void stiffness (Schwarz P N=16: 4.4 / 43.7 /
   422 / 3270 MPa for void 1e-5 … 1e-2).

   Model
   · Every SOLID voxel is one 8-node hexahedron; void voxels have
     no element and no DOF (no void-stiffness parameter at all).
   · Element: Wilson–Taylor incompatible-modes hex (H8I, the same
     family as Abaqus C3D8I), 2×2×2 Gauss, bubbles condensed once.
     All elements are identical unit cubes of one material, so Ke
     is ONE constant 24×24 matrix.  H8I bends correctly with 1–2
     voxels through a wall (periodic plate benchmark within 1.2 %
     of the exact continuum answer at every wall thickness 1–8
     voxels; the standard H8 brick is 69 % high at 1 voxel).
   · Geometric stiffness per element from the Gauss-point prestress
     with compatible shape-function gradients: Kg_e = I3 ⊗ M_e.
   · Periodic node grid: node (i,j,k) sits at the low corner of voxel
     (i,j,k), wrap-around; same ordering as buildVoxels (x = i
     slowest, z = k fastest).  Only nodes touching a solid element
     are active.  Rigid translations removed by a zero-mean projector.
   · Solver: geometric multigrid (Galerkin coarse elements, Chebyshev
     smoother, dense coarsest solve) preconditions both the prestress
     PCG and LOBPCG; iteration counts stay flat with N.
   · Island pruning is MANDATORY here (a floating piece is a free
     rigid body): the largest periodically-connected component is kept.

   Loading (same convention as 16c 'uniaxial'): unit macro-strain
   basis solves (3, or 6 when normal–shear coupling > 1e-3) give the
   cell's C̄ at this grid; axis a is loaded by ε̄ = −E_a·S·e_a, i.e.
   unit compressive axial strain with traction-free laterals.
   Eigen: (−K_g) φ = θ K φ,  λ_cr = 1/θ_max = critical axial strain,
   p_cr = λ_cr · E_a = critical uniaxial stress (MPa).

   Public:
     homogenizeBucklingFE(recipe, N, opts) → 16c-shaped result
     bucklingFromSolidFE(solid, mat, N, opts)
     runFEBucklingSelfTest([N])            → plate benchmark + null-space
   Depends on 16c (bk_jacobiSym, bk_cholesky, bk_forwardSolve,
   bk_backSolveLt, bk_modeLocalization), 14 (buildVoxels, resolveBuildArgs),
   14a (pruneToLargestComponent, checkVoxelConnectivity), 13 (KERNELS).
   Validation record: proto/fe-buckling/, docs/SPRINT_B_PROPOSAL.md.
   ============================================================ */

var FE_BUCKLE_DEFAULTS = {
  element:   'H8I',   /* 'H8' = standard brick (locks in bending — diagnostic only) */
  block:     4,       /* LOBPCG block; 4 is the smallest that held 0.5 % parity */
  eigIters:  400,
  eigTol:    1e-5,    /* relative θ change of the leading pair … */
  eigNStable: 2,      /* … over this many consecutive sweeps … */
  eigResTol: 0.02,    /* … with the leading residual below this */
  cgTol:     1e-8,    /* prestress PCG (multigrid-preconditioned, ~16–24 iterations) */
  cgMaxiter: 2000,
  shearCouplingTol: 1e-3,
  seed:      12345    /* deterministic start → identical results run to run */
};

/* ---------- small dense helpers ---------- */
function fe_isoC(E, nu) {
  var lam = E * nu / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  var C = new Float64Array(36);
  C[0] = C[7] = C[14] = lam + 2 * mu;
  C[1] = C[2] = C[6] = C[8] = C[12] = C[13] = lam;
  C[21] = C[28] = C[35] = mu;
  return C;
}
function fe_inv(A, n) {             /* Gauss-Jordan with partial pivoting, dense */
  var M = new Float64Array(n * 2 * n);
  for (var i = 0; i < n; i++) { for (var j = 0; j < n; j++) M[i * 2 * n + j] = A[i * n + j]; M[i * 2 * n + n + i] = 1; }
  for (var c = 0; c < n; c++) {
    var p = c, best = Math.abs(M[c * 2 * n + c]);
    for (var r = c + 1; r < n; r++) { var v = Math.abs(M[r * 2 * n + c]); if (v > best) { best = v; p = r; } }
    if (best < 1e-300) return null;
    if (p !== c) for (var k = 0; k < 2 * n; k++) { var t = M[c * 2 * n + k]; M[c * 2 * n + k] = M[p * 2 * n + k]; M[p * 2 * n + k] = t; }
    var piv = M[c * 2 * n + c];
    for (var k2 = 0; k2 < 2 * n; k2++) M[c * 2 * n + k2] /= piv;
    for (var r2 = 0; r2 < n; r2++) {
      if (r2 === c) continue;
      var f = M[r2 * 2 * n + c]; if (f === 0) continue;
      for (var k3 = 0; k3 < 2 * n; k3++) M[r2 * 2 * n + k3] -= f * M[c * 2 * n + k3];
    }
  }
  var out = new Float64Array(n * n);
  for (var i2 = 0; i2 < n; i2++) for (var j2 = 0; j2 < n; j2++) out[i2 * n + j2] = M[i2 * 2 * n + n + j2];
  return out;
}
function fe_mm(A, B, n, k, m) { var o = new Float64Array(n * m); for (var i = 0; i < n; i++) for (var p = 0; p < k; p++) { var a = A[i * k + p]; if (a === 0) continue; for (var j = 0; j < m; j++) o[i * m + j] += a * B[p * m + j]; } return o; }
function fe_tr(A, n, m) { var o = new Float64Array(n * m); for (var i = 0; i < n; i++) for (var j = 0; j < m; j++) o[j * n + i] = A[i * m + j]; return o; }
/* strain-displacement rows for node a with gradient g, engineering Voigt [xx,yy,zz,yz,xz,xy] */
function fe_fillB(B, ncol, a, gx, gy, gz) {
  var c0 = 3 * a, c1 = c0 + 1, c2 = c0 + 2;
  B[0 * ncol + c0] = gx;
  B[1 * ncol + c1] = gy;
  B[2 * ncol + c2] = gz;
  B[3 * ncol + c1] = gz; B[3 * ncol + c2] = gy;
  B[4 * ncol + c0] = gz; B[4 * ncol + c2] = gx;
  B[5 * ncol + c0] = gy; B[5 * ncol + c1] = gx;
}

/* ============================================================
   fe_elementData(E, nu, type) — constant operators for a unit cube.
   Local node n = a·4 + b·2 + c, (a,b,c) ∈ {0,1}³ → corner offset (a,b,c).
   Returns { Ke(576), Beff[8](6×24), G[8](8×3 ∇N at GP), w, ngp, C, type }.
   Voxel size h = 1: λ is dimensionless (K ∝ E·h, K_g ∝ σ·h).
   ============================================================ */
function fe_elementData(E, nu, type) {
  type = type || 'H8I';
  var C = fe_isoC(E, nu), g = 1 / Math.sqrt(3), w = 1 / 8;   /* weight 1 × detJ 1/8 */
  var sgn = [], gps = [];
  for (var n = 0; n < 8; n++) sgn.push([((n >> 2) & 1) * 2 - 1, ((n >> 1) & 1) * 2 - 1, (n & 1) * 2 - 1]);
  for (var q = 0; q < 8; q++) gps.push([sgn[q][0] * g, sgn[q][1] * g, sgn[q][2] * g]);
  var ngp = 8;
  var Kuu = new Float64Array(576), Kaa = new Float64Array(81), Kau = new Float64Array(9 * 24);
  var Bc = [], Ba = [], G = [];
  for (var gi = 0; gi < ngp; gi++) {
    var xi = gps[gi][0], et = gps[gi][1], ze = gps[gi][2];
    var B = new Float64Array(6 * 24), Gg = new Float64Array(24);
    for (var a = 0; a < 8; a++) {
      var sx = sgn[a][0], sy = sgn[a][1], sz = sgn[a][2];
      var gx = 2 * sx * (1 + sy * et) * (1 + sz * ze) / 8;     /* dN/dx = 2·dN/dξ */
      var gy = 2 * sy * (1 + sx * xi) * (1 + sz * ze) / 8;
      var gz = 2 * sz * (1 + sx * xi) * (1 + sy * et) / 8;
      fe_fillB(B, 24, a, gx, gy, gz);
      Gg[a * 3] = gx; Gg[a * 3 + 1] = gy; Gg[a * 3 + 2] = gz;
    }
    Bc.push(B); G.push(Gg);
    var CB = fe_mm(C, B, 6, 6, 24), BtCB = fe_mm(fe_tr(B, 6, 24), CB, 24, 6, 24);
    for (var t = 0; t < 576; t++) Kuu[t] += w * BtCB[t];
    /* incompatible bubble modes M_m = 1 − ξ_m²  → dM/dx_m = −4ξ_m */
    var A = new Float64Array(6 * 9);
    fe_fillB(A, 9, 0, -4 * xi, 0, 0);
    fe_fillB(A, 9, 1, 0, -4 * et, 0);
    fe_fillB(A, 9, 2, 0, 0, -4 * ze);
    Ba.push(A);
    var At = fe_tr(A, 6, 9), CA = fe_mm(C, A, 6, 6, 9);
    var AtCA = fe_mm(At, CA, 9, 6, 9), AtCB = fe_mm(At, CB, 9, 6, 24);
    for (var t2 = 0; t2 < 81; t2++) Kaa[t2] += w * AtCA[t2];
    for (var t3 = 0; t3 < 216; t3++) Kau[t3] += w * AtCB[t3];
  }
  var Ke = Kuu, Beff = Bc;
  if (type === 'H8I') {
    var Kinv = fe_inv(Kaa, 9), R = fe_mm(Kinv, Kau, 9, 9, 24);   /* α = −R·u */
    var corr = fe_mm(fe_tr(Kau, 9, 24), R, 24, 9, 24);
    Ke = new Float64Array(576); for (var t4 = 0; t4 < 576; t4++) Ke[t4] = Kuu[t4] - corr[t4];
    Beff = [];
    for (var gj = 0; gj < 8; gj++) {
      var BaR = fe_mm(Ba[gj], R, 6, 9, 24), Be = new Float64Array(144);
      for (var t5 = 0; t5 < 144; t5++) Be[t5] = Bc[gj][t5] - BaR[t5];
      Beff.push(Be);
    }
  }
  for (var i = 0; i < 24; i++) for (var j = i + 1; j < 24; j++) { var s = 0.5 * (Ke[i * 24 + j] + Ke[j * 24 + i]); Ke[i * 24 + j] = s; Ke[j * 24 + i] = s; }
  return { Ke: Ke, Beff: Beff, G: G, w: w, ngp: ngp, C: C, type: type, E: E, nu: nu };
}

/* ============================================================
   fe_mesh(solid, N) — solid-only element list + active-node compaction.
   ============================================================ */
function fe_mesh(solid, N) {
  var N2 = N * N, N3 = N2 * N, nel = 0;
  for (var v = 0; v < N3; v++) if (solid[v]) nel++;
  var elemVox = new Int32Array(nel), used = new Uint8Array(N3), e = 0;
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    var vid = i * N2 + j * N + k;
    if (!solid[vid]) continue;
    elemVox[e++] = vid;
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var c = 0; c < 2; c++)
      used[((i + a) % N) * N2 + ((j + b) % N) * N + ((k + c) % N)] = 1;
  }
  var act = new Int32Array(N3).fill(-1), nA = 0, actNode = [];
  for (var nd = 0; nd < N3; nd++) if (used[nd]) { act[nd] = nA++; actNode.push(nd); }
  var en = new Int32Array(nel * 8);
  for (var q = 0; q < nel; q++) {
    var vv = elemVox[q], ii = (vv / N2) | 0, rem = vv - ii * N2, jj = (rem / N) | 0, kk = rem - jj * N;
    for (var n = 0; n < 8; n++) {
      var aa = (n >> 2) & 1, bb = (n >> 1) & 1, cc = n & 1;
      en[q * 8 + n] = act[((ii + aa) % N) * N2 + ((jj + bb) % N) * N + ((kk + cc) % N)];
    }
  }
  return { N: N, N3: N3, nel: nel, nA: nA, n: 3 * nA, elemVox: elemVox, en: en, act: act, actNode: Int32Array.from(actNode) };
}

/* ============================================================
   Operators (matrix-free element loop, scatter-add).
   Vector layout: component-major, x[c·nA + a], a = active node.
   ============================================================ */
function fe_makeOps(mesh, ed) {
  var nel = mesh.nel, nA = mesh.nA, n = mesh.n, en = mesh.en, Ke = ed.Ke, ngp = ed.ngp;
  var ue = new Float64Array(24), fe = new Float64Array(24);
  var Mg = null;   /* per-element 8×8 geometric block (Kg_e = I3 ⊗ M_e) */

  function gather(x, base) {
    for (var a = 0; a < 8; a++) { var nd = en[base + a]; ue[3 * a] = x[nd]; ue[3 * a + 1] = x[nA + nd]; ue[3 * a + 2] = x[2 * nA + nd]; }
  }
  function applyK(x, y) {
    y.fill(0);
    for (var e = 0; e < nel; e++) {
      var base = e * 8;
      gather(x, base);
      for (var r = 0; r < 24; r++) { var s = 0, ro = r * 24; for (var c = 0; c < 24; c++) s += Ke[ro + c] * ue[c]; fe[r] = s; }
      for (var a = 0; a < 8; a++) { var nd = en[base + a]; y[nd] += fe[3 * a]; y[nA + nd] += fe[3 * a + 1]; y[2 * nA + nd] += fe[3 * a + 2]; }
    }
  }
  /* A = −K_g and B = K in one element pass */
  function applyAB(x, A, B) {
    A.fill(0); B.fill(0);
    for (var e = 0; e < nel; e++) {
      var base = e * 8, mb = e * 64;
      gather(x, base);
      for (var r = 0; r < 24; r++) { var s = 0, ro = r * 24; for (var c = 0; c < 24; c++) s += Ke[ro + c] * ue[c]; fe[r] = s; }
      for (var a = 0; a < 8; a++) {
        var nd = en[base + a];
        B[nd] += fe[3 * a]; B[nA + nd] += fe[3 * a + 1]; B[2 * nA + nd] += fe[3 * a + 2];
        var gx = 0, gy = 0, gz = 0, mo = mb + a * 8;
        for (var b = 0; b < 8; b++) { var m = Mg[mo + b]; gx += m * ue[3 * b]; gy += m * ue[3 * b + 1]; gz += m * ue[3 * b + 2]; }
        A[nd] -= gx; A[nA + nd] -= gy; A[2 * nA + nd] -= gz;
      }
    }
  }
  function diagK() {
    var d = new Float64Array(n);
    for (var e = 0; e < nel; e++) for (var a = 0; a < 8; a++) {
      var nd = en[e * 8 + a];
      d[nd] += Ke[(3 * a) * 25]; d[nA + nd] += Ke[(3 * a + 1) * 25]; d[2 * nA + nd] += Ke[(3 * a + 2) * 25];
    }
    return d;
  }
  /* ε̄ (engineering Voigt) → local nodal macro displacement (24) */
  function macroLocal(eb) {
    var u = new Float64Array(24);
    var exx = eb[0], eyy = eb[1], ezz = eb[2], eyz = eb[3] / 2, exz = eb[4] / 2, exy = eb[5] / 2;
    for (var a = 0; a < 8; a++) {
      var X = (a >> 2) & 1, Y = (a >> 1) & 1, Z = a & 1;
      u[3 * a] = exx * X + exy * Y + exz * Z;
      u[3 * a + 1] = exy * X + eyy * Y + eyz * Z;
      u[3 * a + 2] = exz * X + eyz * Y + ezz * Z;
    }
    return u;
  }
  /* RHS for macro strain ε̄: f = −Σ_e scatter(Ke·u_mac) (identical per element) */
  function macroRHS(eb) {
    var um = macroLocal(eb), f0 = new Float64Array(24), f = new Float64Array(n);
    for (var r = 0; r < 24; r++) { var s = 0; for (var c = 0; c < 24; c++) s += Ke[r * 24 + c] * um[c]; f0[r] = -s; }
    for (var e = 0; e < nel; e++) for (var a = 0; a < 8; a++) { var nd = en[e * 8 + a]; f[nd] += f0[3 * a]; f[nA + nd] += f0[3 * a + 1]; f[2 * nA + nd] += f0[3 * a + 2]; }
    return f;
  }
  function elemGPStrain(x, e, um, epsOut) {
    gather(x, e * 8);
    for (var t = 0; t < 24; t++) fe[t] = ue[t] + um[t];
    for (var g = 0; g < ngp; g++) {
      var Be = ed.Beff[g];
      for (var P = 0; P < 6; P++) { var s = 0, ro = P * 24; for (var c = 0; c < 24; c++) s += Be[ro + c] * fe[c]; epsOut[g * 6 + P] = s; }
    }
  }
  /* cell-average stress (void contributes zero) */
  function avgStress(x, eb) {
    var um = macroLocal(eb), eps = new Float64Array(48), C = ed.C, sb = [0, 0, 0, 0, 0, 0];
    for (var e = 0; e < nel; e++) {
      elemGPStrain(x, e, um, eps);
      for (var g = 0; g < ngp; g++) for (var P = 0; P < 6; P++) { var s = 0; for (var Q = 0; Q < 6; Q++) s += C[P * 6 + Q] * eps[g * 6 + Q]; sb[P] += ed.w * s; }
    }
    for (var P2 = 0; P2 < 6; P2++) sb[P2] /= mesh.N3;
    return sb;
  }
  /* per-element M_e from the prestress (ũ, ε̄), Gauss-point stress */
  function setPrestress(x, eb) {
    if (!Mg) Mg = new Float64Array(nel * 64);
    var um = macroLocal(eb), eps = new Float64Array(48), C = ed.C, sg = new Float64Array(48);
    for (var e = 0; e < nel; e++) {
      elemGPStrain(x, e, um, eps);
      for (var g = 0; g < ngp; g++) for (var P = 0; P < 6; P++) { var s = 0; for (var Q = 0; Q < 6; Q++) s += C[P * 6 + Q] * eps[g * 6 + Q]; sg[g * 6 + P] = s; }
      var mb = e * 64;
      for (var t = 0; t < 64; t++) Mg[mb + t] = 0;
      for (var g2 = 0; g2 < ngp; g2++) {
        var s0 = sg[g2 * 6], s1 = sg[g2 * 6 + 1], s2 = sg[g2 * 6 + 2], s3 = sg[g2 * 6 + 3], s4 = sg[g2 * 6 + 4], s5 = sg[g2 * 6 + 5];
        var Gg = ed.G[g2];
        for (var a = 0; a < 8; a++) {
          var ax = Gg[3 * a], ay = Gg[3 * a + 1], az = Gg[3 * a + 2];
          var fx = s0 * ax + s5 * ay + s4 * az, fy = s5 * ax + s1 * ay + s3 * az, fz = s4 * ax + s3 * ay + s2 * az;
          for (var b = 0; b < 8; b++) Mg[mb + a * 8 + b] += ed.w * (fx * Gg[3 * b] + fy * Gg[3 * b + 1] + fz * Gg[3 * b + 2]);
        }
      }
    }
  }
  /* voxel-field copy of a nodal vector for the viewer and bk_modeLocalization:
     every voxel = mean of its ACTIVE corner nodes (void voxels next to the
     solid get the surface motion, so the texture warp has no hard zero rim). */
  function toVoxelField(x) {
    var N = mesh.N, N2 = N * N, N3 = mesh.N3, act = mesh.act, out = new Float64Array(3 * N3);
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
      var sx = 0, sy = 0, sz = 0, cnt = 0;
      for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var c = 0; c < 2; c++) {
        var an = act[((i + a) % N) * N2 + ((j + b) % N) * N + ((k + c) % N)];
        if (an < 0) continue;
        sx += x[an]; sy += x[nA + an]; sz += x[2 * nA + an]; cnt++;
      }
      if (!cnt) continue;
      var v = i * N2 + j * N + k;
      out[v] = sx / cnt; out[N3 + v] = sy / cnt; out[2 * N3 + v] = sz / cnt;
    }
    return out;
  }
  return {
    n: n, nA: nA, mesh: mesh, ed: ed,
    applyK: applyK, applyAB: applyAB, diagK: diagK, macroRHS: macroRHS,
    avgStress: avgStress, setPrestress: setPrestress, toVoxelField: toVoxelField
  };
}

/* ---------- vector helpers ---------- */
function fe_dot(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function fe_zeroMean(x, nA) { for (var c = 0; c < 3; c++) { var b = c * nA, s = 0; for (var i = 0; i < nA; i++) s += x[b + i]; s /= nA; for (var i2 = 0; i2 < nA; i2++) x[b + i2] -= s; } }
function fe_scal(v, s) { for (var i = 0; i < v.length; i++) v[i] *= s; }
function fe_mulberry(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* PCG on the zero-mean (translation-free) subspace */
function fe_pcg(applyK, applyM, b, nA, tol, maxit) {
  var n = b.length, x = new Float64Array(n), r = Float64Array.from(b), z = new Float64Array(n), Ap = new Float64Array(n);
  fe_zeroMean(r, nA);
  var bn = Math.sqrt(fe_dot(b, b)) + 1e-300;
  applyM(r, z); fe_zeroMean(z, nA);
  var p = Float64Array.from(z), rz = fe_dot(r, z), it = 0, rel = Math.sqrt(fe_dot(r, r)) / bn;
  for (it = 0; it < maxit && rel > tol; it++) {
    applyK(p, Ap); fe_zeroMean(Ap, nA);
    var al = rz / fe_dot(p, Ap);
    for (var i = 0; i < n; i++) { x[i] += al * p[i]; r[i] -= al * Ap[i]; }
    rel = Math.sqrt(fe_dot(r, r)) / bn;
    if (rel <= tol) { it++; break; }
    applyM(r, z); fe_zeroMean(z, nA);
    var rzN = fe_dot(r, z), be = rzN / rz; rz = rzN;
    for (var i2 = 0; i2 < n; i2++) p[i2] = z[i2] + be * p[i2];
  }
  fe_zeroMean(x, nA);
  return { x: x, iters: it, relres: rel };
}

/* ============================================================
   fe_makeMG — geometric multigrid preconditioner for K.
   Levels N → N/2 → … → 4; coarse element = 2×2×2 block; periodic
   trilinear prolongation, so PᵀKP is exactly an assembly of coarse
   element matrices.  Chebyshev–Jacobi smoother (degree nu), dense
   Cholesky on the coarsest grid with the translations penalised.
   Symmetric V-cycle ⇒ valid PCG / LOBPCG preconditioner.
   ============================================================ */
function fe_makeMG(ops, mesh, ed, o) {
  o = o || {};
  var nuS = o.nu || 3, ratio = o.ratio || 30, Nmin = o.Nc || 4;
  var N0 = mesh.N, rng = fe_mulberry(777);

  var Q = [];   /* child interpolation matrices (24 fine-local × 24 coarse-local) */
  for (var c = 0; c < 8; c++) {
    var ca = (c >> 2) & 1, cb = (c >> 1) & 1, cc = c & 1, M = new Float64Array(576);
    for (var n = 0; n < 8; n++) {
      var px = (ca + ((n >> 2) & 1)) / 2, py = (cb + ((n >> 1) & 1)) / 2, pz = (cc + (n & 1)) / 2;
      for (var m = 0; m < 8; m++) {
        var mx = (m >> 2) & 1, my = (m >> 1) & 1, mz = m & 1;
        var w = (1 - Math.abs(px - mx)) * (1 - Math.abs(py - my)) * (1 - Math.abs(pz - mz));
        if (w === 0) continue;
        for (var d = 0; d < 3; d++) M[(3 * n + d) * 24 + 3 * m + d] = w;
      }
    }
    Q.push(M);
  }
  function galerkinChild(Kc, qc) { return fe_mm(fe_tr(qc, 24, 24), fe_mm(Kc, qc, 24, 24, 24), 24, 24, 24); }

  var levels = [{ N: N0, full: false, nA: mesh.nA, n: mesh.n, applyK: ops.applyK, diag: ops.diagK() }];
  var occ0 = new Uint8Array(N0 * N0 * N0); for (var e = 0; e < mesh.nel; e++) occ0[mesh.elemVox[e]] = 1;
  var prevN = N0, prevKel = null, prevIdx = null, prevOcc = occ0;
  var constChild = []; for (var c2 = 0; c2 < 8; c2++) constChild.push(galerkinChild(ed.Ke, Q[c2]));
  while (prevN / 2 >= Nmin && prevN % 2 === 0) {
    var Nl = prevN / 2, Nl3 = Nl * Nl * Nl, idx = new Int32Array(Nl3).fill(-1), list = [];
    for (var I = 0; I < Nl; I++) for (var J = 0; J < Nl; J++) for (var K = 0; K < Nl; K++) {
      var any = false;
      for (var cc2 = 0; cc2 < 8; cc2++) { var fi = 2 * I + ((cc2 >> 2) & 1), fj = 2 * J + ((cc2 >> 1) & 1), fk = 2 * K + (cc2 & 1); if (prevOcc[fi * prevN * prevN + fj * prevN + fk]) { any = true; break; } }
      if (any) { idx[I * Nl * Nl + J * Nl + K] = list.length; list.push(I * Nl * Nl + J * Nl + K); }
    }
    var ne = list.length, Kel = new Float64Array(ne * 576), occ = new Uint8Array(Nl3);
    for (var q = 0; q < ne; q++) {
      var v = list[q]; occ[v] = 1;
      var I2 = (v / (Nl * Nl)) | 0, r2 = v - I2 * Nl * Nl, J2 = (r2 / Nl) | 0, K2 = r2 - J2 * Nl, base = q * 576;
      for (var c3 = 0; c3 < 8; c3++) {
        var fv = (2 * I2 + ((c3 >> 2) & 1)) * prevN * prevN + (2 * J2 + ((c3 >> 1) & 1)) * prevN + (2 * K2 + (c3 & 1));
        if (!prevOcc[fv]) continue;
        var Gm = prevKel ? galerkinChild(prevKel.subarray(prevIdx[fv] * 576, prevIdx[fv] * 576 + 576), Q[c3]) : constChild[c3];
        for (var t = 0; t < 576; t++) Kel[base + t] += Gm[t];
      }
    }
    var lev = { N: Nl, full: true, n: 3 * Nl3, nA: Nl3, ne: ne, list: Int32Array.from(list), Kel: Kel };
    lev.applyK = mkApplyFull(lev);
    lev.diag = diagFull(lev);
    levels.push(lev);
    prevN = Nl; prevKel = Kel; prevIdx = idx; prevOcc = occ;
  }

  function mkApplyFull(lev) {
    var Nl = lev.N, en = new Int32Array(lev.ne * 8);
    for (var q2 = 0; q2 < lev.ne; q2++) {
      var v2 = lev.list[q2], I3 = (v2 / (Nl * Nl)) | 0, r3 = v2 - I3 * Nl * Nl, J3 = (r3 / Nl) | 0, K3 = r3 - J3 * Nl;
      for (var nn = 0; nn < 8; nn++) en[q2 * 8 + nn] = ((I3 + ((nn >> 2) & 1)) % Nl) * Nl * Nl + ((J3 + ((nn >> 1) & 1)) % Nl) * Nl + ((K3 + (nn & 1)) % Nl);
    }
    lev.en = en;
    var nA = lev.nA, ue = new Float64Array(24), fe = new Float64Array(24), Kel = lev.Kel;
    return function (x, y) {
      y.fill(0);
      for (var e2 = 0; e2 < lev.ne; e2++) {
        var b8 = e2 * 8, kb = e2 * 576;
        for (var a = 0; a < 8; a++) { var nd = en[b8 + a]; ue[3 * a] = x[nd]; ue[3 * a + 1] = x[nA + nd]; ue[3 * a + 2] = x[2 * nA + nd]; }
        for (var r = 0; r < 24; r++) { var s = 0, ro = kb + r * 24; for (var c4 = 0; c4 < 24; c4++) s += Kel[ro + c4] * ue[c4]; fe[r] = s; }
        for (var a2 = 0; a2 < 8; a2++) { var nd2 = en[b8 + a2]; y[nd2] += fe[3 * a2]; y[nA + nd2] += fe[3 * a2 + 1]; y[2 * nA + nd2] += fe[3 * a2 + 2]; }
      }
    };
  }
  function diagFull(lev) {
    var dd = new Float64Array(lev.n), nA = lev.nA;
    for (var e3 = 0; e3 < lev.ne; e3++) for (var a = 0; a < 8; a++) { var nd = lev.en[e3 * 8 + a]; for (var c5 = 0; c5 < 3; c5++) dd[c5 * nA + nd] += lev.Kel[e3 * 576 + (3 * a + c5) * 25]; }
    return dd;
  }
  /* prolongation level l+1 (coarse, full grid) → level l */
  function mkTransfer(fine, coarse) {
    var Nf = fine.N, Nc = coarse.N, nodesF = fine.full ? null : mesh.actNode;
    var nFn = fine.full ? Nf * Nf * Nf : fine.nA;
    var ptr = new Int32Array(nFn + 1), cols = [], wts = [];
    function opt(ii, arr) { if (ii % 2 === 0) arr.push([(ii / 2) % Nc, 1]); else { arr.push([((ii - 1) / 2) % Nc, 0.5]); arr.push([((ii + 1) / 2) % Nc, 0.5]); } }
    for (var f = 0; f < nFn; f++) {
      var g = fine.full ? f : nodesF[f];
      var i = (g / (Nf * Nf)) | 0, r = g - i * Nf * Nf, j = (r / Nf) | 0, k = r - j * Nf;
      var ci = [], cj = [], ck = [];
      opt(i, ci); opt(j, cj); opt(k, ck);
      for (var a = 0; a < ci.length; a++) for (var b = 0; b < cj.length; b++) for (var cz = 0; cz < ck.length; cz++) {
        cols.push(ci[a][0] * Nc * Nc + cj[b][0] * Nc + ck[cz][0]); wts.push(ci[a][1] * cj[b][1] * ck[cz][1]);
      }
      ptr[f + 1] = cols.length;
    }
    var Cc = Int32Array.from(cols), W = Float64Array.from(wts), nAf = nFn, nAc = coarse.nA;
    return {
      prolong: function (xc, xf) {   /* xf += P xc */
        for (var comp = 0; comp < 3; comp++) { var of = comp * nAf, oc = comp * nAc; for (var f2 = 0; f2 < nAf; f2++) { var s = 0; for (var p = ptr[f2]; p < ptr[f2 + 1]; p++) s += W[p] * xc[oc + Cc[p]]; xf[of + f2] += s; } }
      },
      restrict: function (rf, rc) {  /* rc = Pᵀ rf */
        rc.fill(0);
        for (var comp = 0; comp < 3; comp++) { var of = comp * nAf, oc = comp * nAc; for (var f2 = 0; f2 < nAf; f2++) { var vv = rf[of + f2]; if (vv === 0) continue; for (var p = ptr[f2]; p < ptr[f2 + 1]; p++) rc[oc + Cc[p]] += W[p] * vv; } }
      }
    };
  }
  for (var l = 0; l + 1 < levels.length; l++) levels[l].T = mkTransfer(levels[l], levels[l + 1]);

  /* per level: inverse diagonal and λmax(D⁻¹K) by power iteration (seeded) */
  levels.forEach(function (lev) {
    var n2 = lev.n, id = new Float64Array(n2);
    for (var i = 0; i < n2; i++) id[i] = lev.diag[i] > 0 ? 1 / lev.diag[i] : 0;
    lev.idg = id;
    var x = new Float64Array(n2), y = new Float64Array(n2);
    for (var i2 = 0; i2 < n2; i2++) x[i2] = id[i2] > 0 ? rng() - 0.5 : 0;
    var lam = 1;
    for (var it = 0; it < 15; it++) {
      var nx = Math.sqrt(fe_dot(x, x)) || 1; for (var i3 = 0; i3 < n2; i3++) x[i3] /= nx;
      lev.applyK(x, y); for (var i4 = 0; i4 < n2; i4++) y[i4] *= id[i4];
      lam = fe_dot(x, y); var tt = x; x = y; y = tt;
    }
    lev.lmax = Math.max(1.1 * Math.sqrt(fe_dot(x, x)), 1.1 * lam);
    lev.r = new Float64Array(n2); lev.t1 = new Float64Array(n2); lev.t2 = new Float64Array(n2);
    lev.x = new Float64Array(n2); lev.b = new Float64Array(n2);
  });

  var LC = levels[levels.length - 1];
  (function () {
    var n3 = LC.n, A = new Float64Array(n3 * n3), ej = new Float64Array(n3), col = new Float64Array(n3);
    for (var j = 0; j < n3; j++) { ej.fill(0); ej[j] = 1; LC.applyK(ej, col); for (var i = 0; i < n3; i++) A[i * n3 + j] = col[i]; }
    var act = []; for (var i2 = 0; i2 < n3; i2++) act.push(LC.diag[i2] > 0 ? 1 : 0);
    var sc = 0; for (var i3 = 0; i3 < n3; i3++) sc = Math.max(sc, LC.diag[i3]);
    var nAc = LC.nA, cntA = 0; for (var k = 0; k < nAc; k++) if (act[k]) cntA++;
    for (var comp = 0; comp < 3; comp++) for (var p = 0; p < nAc; p++) { if (!act[comp * nAc + p]) continue; for (var q3 = 0; q3 < nAc; q3++) if (act[comp * nAc + q3]) A[(comp * nAc + p) * n3 + comp * nAc + q3] += sc / cntA; }
    for (var i4 = 0; i4 < n3; i4++) if (!act[i4]) A[i4 * n3 + i4] = 1;
    LC.chol = bk_cholesky(A, n3); LC.act = act;
    if (!LC.chol) throw new Error('multigrid coarse solve failed (structure has an unrestrained mechanism)');
  })();
  function coarseSolve(b, x) {
    var n4 = LC.n, y = new Float64Array(n4), bb = new Float64Array(n4);
    for (var i = 0; i < n4; i++) bb[i] = LC.act[i] ? b[i] : 0;
    bk_forwardSolve(LC.chol, bb, n4, y); bk_backSolveLt(LC.chol, y, n4, x);
    for (var i2 = 0; i2 < n4; i2++) if (!LC.act[i2]) x[i2] = 0;
  }
  function cheb(lev, b, x) {
    var n5 = lev.n, r = lev.r, dv = lev.t1, Ad = lev.t2, id = lev.idg;
    var lmax = lev.lmax, lmin = lmax / ratio, th = 0.5 * (lmax + lmin), de = 0.5 * (lmax - lmin);
    lev.applyK(x, Ad); for (var i = 0; i < n5; i++) r[i] = b[i] - Ad[i];
    var sigma = th / de, rho = 1 / sigma;
    for (var i2 = 0; i2 < n5; i2++) dv[i2] = id[i2] * r[i2] / th;
    for (var k = 0; k < nuS; k++) {
      for (var i3 = 0; i3 < n5; i3++) x[i3] += dv[i3];
      if (k === nuS - 1) break;
      lev.applyK(dv, Ad); for (var i4 = 0; i4 < n5; i4++) r[i4] -= Ad[i4];
      var rhoN = 1 / (2 * sigma - rho);
      for (var i5 = 0; i5 < n5; i5++) dv[i5] = rhoN * rho * dv[i5] + 2 * rhoN / de * id[i5] * r[i5];
      rho = rhoN;
    }
  }
  function vcycle(l2, b, x) {
    var lev = levels[l2];
    if (l2 === levels.length - 1) { coarseSolve(b, x); return; }
    x.fill(0);
    cheb(lev, b, x);
    lev.applyK(x, lev.t2); for (var i = 0; i < lev.n; i++) lev.r[i] = b[i] - lev.t2[i];
    var Cl = levels[l2 + 1];
    lev.T.restrict(lev.r, Cl.b);
    vcycle(l2 + 1, Cl.b, Cl.x);
    lev.T.prolong(Cl.x, x);
    cheb(lev, b, x);
  }
  return {
    nLevels: levels.length,
    apply: function (r, z) { vcycle(0, r, z); }
  };
}

/* ============================================================
   LOBPCG for the largest θ of (A, B) = (−K_g, K) with implicit
   AX/BX/AP/BP updates (only T·R, A·W, B·W applied per iteration).
   Convergence: leading pair's relative θ change < tol for nStable
   consecutive sweeps AND its relative residual < resTol.
   ============================================================ */
function fe_gram(V, AV, BV, n) {
  var s = V.length, SA = new Float64Array(s * s), SB = new Float64Array(s * s), CH = 2048;
  for (var c0 = 0; c0 < n; c0 += CH) {
    var c1 = Math.min(n, c0 + CH);
    for (var i = 0; i < s; i++) {
      var vi = V[i];
      for (var j = i; j < s; j++) {
        var a = AV[j], b = BV[j], sa = 0, sb = 0;
        for (var t = c0; t < c1; t++) { var v = vi[t]; sa += v * a[t]; sb += v * b[t]; }
        SA[i * s + j] += sa; SB[i * s + j] += sb;
      }
    }
  }
  for (var i2 = 0; i2 < s; i2++) for (var j2 = i2 + 1; j2 < s; j2++) { SA[j2 * s + i2] = SA[i2 * s + j2]; SB[j2 * s + i2] = SB[i2 * s + j2]; }
  return { SA: SA, SB: SB };
}
function fe_combine(Vs, Y, mo, kStart, outs, n) {   /* outs[j] = Σ_k Y[k·mo + j]·Vs[k] */
  var s = Vs.length, CH = 2048;
  for (var j = 0; j < outs.length; j++) outs[j].fill(0);
  for (var c0 = 0; c0 < n; c0 += CH) {
    var c1 = Math.min(n, c0 + CH);
    for (var j2 = 0; j2 < outs.length; j2++) {
      var o = outs[j2];
      for (var k = kStart; k < s; k++) {
        var y = Y[k * mo + j2]; if (y === 0) continue;
        var v = Vs[k];
        for (var t = c0; t < c1; t++) o[t] += y * v[t];
      }
    }
  }
}
function fe_rr(SA, SB, s, m) {
  var eigB = bk_jacobiSym(SB, s, 200, 1e-15);
  var maxB = 0; for (var d = 0; d < s; d++) if (eigB.values[d] > maxB) maxB = eigB.values[d];
  var keep = []; for (var dk = 0; dk < s; dk++) if (eigB.values[dk] > 1e-9 * maxB) keep.push(dk);
  var sk = keep.length; if (sk === 0) return null;
  var Tr = new Float64Array(s * sk);
  for (var ti = 0; ti < s; ti++) for (var tp = 0; tp < sk; tp++) Tr[ti * sk + tp] = eigB.vectors[ti * s + keep[tp]] / Math.sqrt(eigB.values[keep[tp]]);
  var SAT = new Float64Array(s * sk);
  for (var ri = 0; ri < s; ri++) for (var rp = 0; rp < sk; rp++) { var acc = 0; for (var rj = 0; rj < s; rj++) acc += SA[ri * s + rj] * Tr[rj * sk + rp]; SAT[ri * sk + rp] = acc; }
  var SAr = new Float64Array(sk * sk);
  for (var pp = 0; pp < sk; pp++) for (var qq = 0; qq < sk; qq++) { var a2 = 0; for (var p2 = 0; p2 < s; p2++) a2 += Tr[p2 * sk + pp] * SAT[p2 * sk + qq]; SAr[pp * sk + qq] = a2; }
  for (var sa = 0; sa < sk; sa++) for (var sb = sa + 1; sb < sk; sb++) { var sm = 0.5 * (SAr[sa * sk + sb] + SAr[sb * sk + sa]); SAr[sa * sk + sb] = sm; SAr[sb * sk + sa] = sm; }
  var eigA = bk_jacobiSym(SAr, sk, 200, 1e-15);
  var order = []; for (var o = 0; o < sk; o++) order.push(o);
  order.sort(function (p, q) { return eigA.values[q] - eigA.values[p]; });
  var take = Math.min(m, sk), Y = new Float64Array(s * take), th = [];
  for (var c = 0; c < take; c++) {
    var oc = order[c]; th.push(eigA.values[oc]);
    for (var yi = 0; yi < s; yi++) { var a3 = 0; for (var yp = 0; yp < sk; yp++) a3 += Tr[yi * sk + yp] * eigA.vectors[yp * sk + oc]; Y[yi * take + c] = a3; }
  }
  return { thetas: th, Y: Y, take: take };
}
function fe_lobpcg(applyAB, applyT, n, nA, m, opts) {
  var iters = opts.iters || 400, tol = opts.tol != null ? opts.tol : 1e-5;
  var nStable = opts.nStable || 2, resTol = opts.resTol || 0;
  var rng = fe_mulberry(opts.seed != null ? opts.seed : 12345), pool = [];
  function vec() { return pool.length ? pool.pop() : new Float64Array(n); }
  function rel(list) { for (var i = 0; i < list.length; i++) pool.push(list[i]); }
  function applyABlist(Vs) {
    var AV = [], BV = [];
    for (var j = 0; j < Vs.length; j++) { var a = vec(), b = vec(); applyAB(Vs[j], a, b); AV.push(a); BV.push(b); }
    return { AV: AV, BV: BV };
  }
  var X = [];
  for (var c = 0; c < m; c++) { var v = vec(); for (var i = 0; i < n; i++) v[i] = rng() * 2 - 1; fe_zeroMean(v, nA); X.push(v); }
  var r0 = applyABlist(X), AX = r0.AV, BX = r0.BV;
  (function () {   /* initial Rayleigh–Ritz inside span(X) */
    var g = fe_gram(X, AX, BX, n), rr = fe_rr(g.SA, g.SB, m, m);
    var nX = [], nAX = [], nBX = []; for (var j = 0; j < rr.take; j++) { nX.push(vec()); nAX.push(vec()); nBX.push(vec()); }
    fe_combine(X, rr.Y, rr.take, 0, nX, n); fe_combine(AX, rr.Y, rr.take, 0, nAX, n); fe_combine(BX, rr.Y, rr.take, 0, nBX, n);
    rel(X); rel(AX); rel(BX); X = nX; AX = nAX; BX = nBX;
  })();
  var P = [], AP = [], BP = [], prevTheta = null, converged = false, lastIters = 0, stable = 0, resLead = Infinity;
  for (var it = 0; it < iters; it++) {
    lastIters = it + 1;
    if (opts.onIter) opts.onIter(it);
    var mX = X.length, R = [];
    for (var cc = 0; cc < mX; cc++) {
      var xbx = fe_dot(X[cc], BX[cc]), th = fe_dot(X[cc], AX[cc]) / xbx;
      var w = vec(), ax = AX[cc], bx = BX[cc];
      for (var i2 = 0; i2 < n; i2++) w[i2] = ax[i2] - th * bx[i2];
      if (cc === 0) resLead = Math.sqrt(fe_dot(w, w)) / Math.max(Math.abs(th) * Math.sqrt(fe_dot(bx, bx)), 1e-300);
      R.push(w);
    }
    var W = []; for (var wr = 0; wr < R.length; wr++) { var z = vec(); applyT(R[wr], z); fe_zeroMean(z, nA); W.push(z); }
    var rw = applyABlist(W), AW = rw.AV, BW = rw.BV;
    for (var q = 0; q < W.length; q++) { var sc = 1 / Math.sqrt(Math.max(fe_dot(W[q], BW[q]), 1e-300)); fe_scal(W[q], sc); fe_scal(AW[q], sc); fe_scal(BW[q], sc); }
    for (var q2 = 0; q2 < P.length; q2++) { var sc2 = 1 / Math.sqrt(Math.max(fe_dot(P[q2], BP[q2]), 1e-300)); fe_scal(P[q2], sc2); fe_scal(AP[q2], sc2); fe_scal(BP[q2], sc2); }
    var V = X.concat(W, P), AV = AX.concat(AW, AP), BV = BX.concat(BW, BP), s = V.length;
    var g2 = fe_gram(V, AV, BV, n), rr2 = fe_rr(g2.SA, g2.SB, s, m);
    if (!rr2) break;
    var take = rr2.take, nXv = [], nAXv = [], nBXv = [], nP = [], nAP = [], nBP = [];
    for (var j = 0; j < take; j++) { nXv.push(vec()); nAXv.push(vec()); nBXv.push(vec()); nP.push(vec()); nAP.push(vec()); nBP.push(vec()); }
    fe_combine(V, rr2.Y, take, 0, nXv, n); fe_combine(AV, rr2.Y, take, 0, nAXv, n); fe_combine(BV, rr2.Y, take, 0, nBXv, n);
    fe_combine(V, rr2.Y, take, mX, nP, n); fe_combine(AV, rr2.Y, take, mX, nAP, n); fe_combine(BV, rr2.Y, take, mX, nBP, n);
    rel(V); rel(AV); rel(BV); rel(R);
    X = nXv; AX = nAXv; BX = nBXv; P = nP; AP = nAP; BP = nBP;
    var top = rr2.thetas;
    if (prevTheta) {
      var rdl = Math.abs(top[0] - prevTheta[0]) / Math.max(Math.abs(top[0]), 1e-30);
      stable = (rdl < tol && (!resTol || resLead < resTol)) ? stable + 1 : 0;
      if (stable >= nStable) { converged = true; break; }
    }
    prevTheta = top;
  }
  /* explicit final Rayleigh quotients (drift-free answer) */
  var fin = applyABlist(X), out = [];
  for (var cf = 0; cf < X.length; cf++) out.push({ theta: fe_dot(X[cf], fin.AV[cf]) / fe_dot(X[cf], fin.BV[cf]), vec: X[cf] });
  out.sort(function (p, q) { return q.theta - p.theta; });
  out._iters = lastIters; out._converged = converged; out._resLead = resLead;
  return out;
}

/* ============================================================
   Prestress: unit macro-strain basis solves → C̄ → uniaxial combos.
   ============================================================ */
function fe_prestress(ops, applyM, opts) {
  var tol = opts.cgTol, maxit = opts.cgMaxiter, nA = ops.nA, basis = [], iters = 0;
  function solveBasis(j) {
    var eb = [0, 0, 0, 0, 0, 0]; eb[j] = 1;
    var sol = fe_pcg(ops.applyK, applyM, ops.macroRHS(eb), nA, tol, maxit);
    iters += sol.iters;
    basis[j] = { u: sol.x, eb: eb, sBar: ops.avgStress(sol.x, eb), relres: sol.relres };
  }
  for (var j = 0; j < 3; j++) solveBasis(j);
  /* normal–shear coupling from the normal solves; solve shear bases if significant */
  var Cn = 0, Csn = 0;
  for (var j2 = 0; j2 < 3; j2++) { for (var P = 0; P < 3; P++) Cn = Math.max(Cn, Math.abs(basis[j2].sBar[P])); for (var P2 = 3; P2 < 6; P2++) Csn = Math.max(Csn, Math.abs(basis[j2].sBar[P2])); }
  var coupling = Csn / Math.max(Cn, 1e-300), nb = 3;
  if (coupling > opts.shearCouplingTol) { for (var j3 = 3; j3 < 6; j3++) solveBasis(j3); nb = 6; }
  var C6 = new Float64Array(36);
  for (var jj = 0; jj < nb; jj++) for (var PP = 0; PP < 6; PP++) C6[PP * 6 + jj] = basis[jj].sBar[PP];
  /* live directions (diagonal stiffness above 1e-6 of max); directions with no
     stiffness (no load path) are dropped — any macro strain there is free */
  var dmax = 0; for (var d = 0; d < nb; d++) dmax = Math.max(dmax, C6[d * 7]);
  var live = []; for (var d2 = 0; d2 < nb; d2++) if (C6[d2 * 7] > 1e-6 * dmax) live.push(d2);
  var nl = live.length, Cl = new Float64Array(nl * nl);
  for (var p = 0; p < nl; p++) for (var q = 0; q < nl; q++) Cl[p * nl + q] = C6[live[p] * 6 + live[q]];
  var Sl = nl ? fe_inv(Cl, nl) : null;
  function uni(a) {
    var ia = live.indexOf(a); if (ia < 0 || !Sl) return null;
    var Ea = 1 / Sl[ia * nl + ia], u = new Float64Array(ops.n), eb = [0, 0, 0, 0, 0, 0];
    for (var p2 = 0; p2 < nl; p2++) {
      var wj = -Ea * Sl[p2 * nl + ia], B = basis[live[p2]];
      for (var i = 0; i < u.length; i++) u[i] += wj * B.u[i];
      for (var P3 = 0; P3 < 6; P3++) eb[P3] += wj * B.eb[P3];
    }
    /* check: macro stress of the combination = −1·E_a on axis a, 0 elsewhere */
    var sb = ops.avgStress(u, eb), resid = 0;
    for (var P4 = 0; P4 < 6; P4++) { var target = (P4 === a) ? -Ea : 0; resid = Math.max(resid, Math.abs(sb[P4] - target)); }
    return { u: u, eb: eb, Ea: Ea, resid: resid / Ea };
  }
  return { C6: C6, live: live, uni: uni, iters: iters, nSolves: nb, coupling: coupling, shearCoupled: nb === 6 };
}

/* ============================================================
   bucklingFromSolidFE(solid, mat, N, opts) — solid must already be pruned.
   Returns 16c-shaped: { lambda_cr, pcr, critAxis, loading, perAxis, mode, N,
   eigConverged, prestress, method }.  perAxis[].mode is a 3·N³ voxel field.
   ============================================================ */
var _feBuckleCache = null;   /* per worker: reuse mesh + multigrid + prestress across axes of one design */

function bucklingFromSolidFE(solid, mat, N, opts, cacheKey) {
  var o = {}, k;
  for (k in FE_BUCKLE_DEFAULTS) if (FE_BUCKLE_DEFAULTS.hasOwnProperty(k)) o[k] = FE_BUCKLE_DEFAULTS[k];
  if (opts) for (k in opts) if (opts.hasOwnProperty(k) && opts[k] != null) o[k] = opts[k];
  var now = (typeof performance !== 'undefined') ? function () { return performance.now(); } : Date.now;
  var T0 = now(), S;
  if (cacheKey && _feBuckleCache && _feBuckleCache.key === cacheKey) S = _feBuckleCache;
  else {
    _feBuckleCache = null;   /* release the previous design before building */
    var ed = fe_elementData(mat.Es_MPa, mat.nu, o.element);
    var mesh = fe_mesh(solid, N), ops = fe_makeOps(mesh, ed);
    var mg = fe_makeMG(ops, mesh, ed, {});
    var pre = fe_prestress(ops, mg.apply, o);
    S = { key: cacheKey, ops: ops, mg: mg, pre: pre, tSetup: (now() - T0) / 1000 };
    if (cacheKey) _feBuckleCache = S;
  }
  var axes = o.axes || [0, 1, 2], names = ['xx', 'yy', 'zz'], perAxis = [];
  var lambdaCr = Infinity, critAxis = -1, critMode = null, critSbar = 0, allConv = true;
  for (var ai = 0; ai < axes.length; ai++) {
    var a = axes[ai], U = S.pre.uni(a);
    if (!U) { perAxis.push({ axis: names[a], lambda: Infinity, sBar: 0, Eaxis: 0, cgIters: S.pre.iters, eigIters: 0, eigConverged: true, mode: null, mWave: 0, noLoadPath: true }); continue; }
    S.ops.setPrestress(U.u, U.eb);
    var pairs = fe_lobpcg(S.ops.applyAB, S.mg.apply, S.ops.n, S.ops.nA, o.block,
      { iters: o.eigIters, tol: o.eigTol, nStable: o.eigNStable, resTol: o.eigResTol, seed: o.seed });
    var lam = Infinity, vec = null;
    for (var p = 0; p < pairs.length; p++) if (pairs[p].theta > 1e-12 && 1 / pairs[p].theta < lam) { lam = 1 / pairs[p].theta; vec = pairs[p].vec; }
    var modeVox = vec ? S.ops.toVoxelField(vec) : null;
    var mw = (modeVox && typeof bk_modeLocalization === 'function') ? bk_modeLocalization(modeVox, solid, N) : 0;
    if (!pairs._converged) allConv = false;
    perAxis.push({ axis: names[a], lambda: lam, sBar: -U.Ea, Eaxis: U.Ea, cgIters: S.pre.iters, eigIters: pairs._iters,
                   eigConverged: !!pairs._converged, resLead: pairs._resLead, stressResid: U.resid, mode: modeVox, mWave: mw });
    if (lam < lambdaCr) { lambdaCr = lam; critAxis = a; critMode = modeVox; critSbar = -U.Ea; }
  }
  var pcr = isFinite(lambdaCr) ? lambdaCr * Math.abs(critSbar) : Infinity;
  return {
    lambda_cr: lambdaCr, pcr: pcr, critAxis: critAxis >= 0 ? names[critAxis] : null, loading: 'uniaxial',
    perAxis: perAxis, mode: critMode, N: N, eigConverged: allConv, method: 'fe-' + S.ops.ed.type.toLowerCase(),
    prestress: { shearCoupled: S.pre.shearCoupled, coupling: S.pre.coupling, nSolves: S.pre.nSolves, iters: S.pre.iters },
    nel: S.ops.mesh.nel, nDof: S.ops.n, tSetup: S.tSetup, tTotal: (now() - T0) / 1000
  };
}

/* ============================================================
   homogenizeBucklingFE(recipe, N, opts) — recipe → voxels → prune → FE.
   Pruning to the largest periodically-connected component is always on.
   ============================================================ */
function homogenizeBucklingFE(recipe, N, opts) {
  opts = opts || {};
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args = resolveBuildArgs(recipe);
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  var N3 = N * N * N, before = 0;
  for (var v = 0; v < N3; v++) if (solid[v]) before++;
  var names = ['xx', 'yy', 'zz'], axes = opts.axes || [0, 1, 2];
  function stub(reason, rho) {
    var pa = [];
    for (var i = 0; i < axes.length; i++) pa.push({ axis: names[axes[i]], lambda: Infinity, sBar: 0, Eaxis: NaN, cgIters: 0, eigIters: 0, eigConverged: true, mode: null, mWave: 0 });
    return { lambda_cr: Infinity, pcr: Infinity, critAxis: null, perAxis: pa, loading: 'uniaxial', mode: null, N: N, rho: rho, skip_reason: reason, method: 'fe-h8i' };
  }
  if (!before) return stub('empty at N=' + N, 0);
  if (typeof pruneToLargestComponent === 'function') solid = pruneToLargestComponent(solid, N);
  var after = 0; for (var v2 = 0; v2 < N3; v2++) if (solid[v2]) after++;
  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var key = N + '|' + JSON.stringify(recipe);
  var res;
  try { res = bucklingFromSolidFE(solid, { Es_MPa: mat.Es_MPa, nu: mat.nu }, N, opts, key); }
  catch (e) { return stub((e && e.message) || String(e), after / N3); }
  res.rho = after / N3;
  res.prunedFrac = before ? 1 - after / before : 0;
  if (!isFinite(res.lambda_cr) && !res.skip_reason) {
    var noPath = true; for (var p = 0; p < res.perAxis.length; p++) if (!res.perAxis[p].noLoadPath) noPath = false;
    res.skip_reason = noPath ? 'no load path across the cell at N=' + N : 'no positive critical mode found';
  }
  return res;
}

/* ============================================================
   runFEBucklingSelfTest([N]) — the two gates that caught the spectral
   artifact, runnable in the browser console or Node:
   1. zero-energy count on a uniform solid 4³ cell: must be exactly 3
      (rigid translations; the spectral operator had hundreds);
   2. periodic plate benchmark: plates normal to x, t voxels thick,
      compressed along z, one full sine wave over the cell.  Reference
      = exact continuum answer of the same linearized theory
      (proto/fe-buckling/plate_ref.py, logs/plate_ref.json), σ_cr/E by
      t/L.  Gate: FE within 5 % of exact (≈1 % at N=32), converged.
   ============================================================ */
var FE_PLATE_EXACT = { '1/32': 0.0035818595, '1/16': 0.0137553802, '3/32': 0.0290504440,
                       '1/8': 0.0476436258, '3/16': 0.0883641402, '1/4': 0.1271798539 };
function runFEBucklingSelfTest(N) {
  N = N || 16;
  var E = 110000, nu = 0.34, out = { N: N, plates: [], pass: true };
  (function () {
    var n4 = 4, solid = new Uint8Array(64).fill(1), ed = fe_elementData(E, nu, 'H8I'), mesh = fe_mesh(solid, n4), ops = fe_makeOps(mesh, ed);
    var n = ops.n, A = new Float64Array(n * n), e = new Float64Array(n), y = new Float64Array(n);
    for (var j = 0; j < n; j++) { e.fill(0); e[j] = 1; ops.applyK(e, y); for (var i = 0; i < n; i++) A[i * n + j] = y[i]; }
    var eg = bk_jacobiSym(A, n, 400, 1e-14), mx = 0, zeros = 0;
    for (var k = 0; k < n; k++) mx = Math.max(mx, Math.abs(eg.values[k]));
    for (var k2 = 0; k2 < n; k2++) if (Math.abs(eg.values[k2]) < 1e-9 * mx) zeros++;
    out.zeroEnergyModes = zeros;
    if (zeros !== 3) out.pass = false;
  })();
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  function frac(t) { var g = gcd(t, N); return (t / g) + '/' + (N / g); }
  [N / 8, N / 4].forEach(function (t) {
    var key = frac(t), exact = FE_PLATE_EXACT[key];
    var solid = new Uint8Array(N * N * N);
    for (var i = 0; i < t; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) solid[i * N * N + j * N + k] = 1;
    _feBuckleCache = null;
    var r = bucklingFromSolidFE(solid, { Es_MPa: E, nu: nu }, N, { axes: [2] });
    var sPlate = r.pcr / (t / N);          /* macro stress → stress in the plate */
    var ratio = exact ? sPlate / (exact * E) : NaN;
    out.plates.push({ t: t, tOverL: key, plateStressMPa: +sPlate.toFixed(1), exactMPa: exact ? +(exact * E).toFixed(1) : null, ratio: +ratio.toFixed(4), iters: r.perAxis[0].eigIters, converged: r.eigConverged });
    if (!(Math.abs(ratio - 1) < 0.05) || !r.eigConverged) out.pass = false;   /* N=16: ~4 % (16 elements per wave); N=32: ~1 % */
  });
  _feBuckleCache = null;
  if (typeof console !== 'undefined') console.log('[16h FE buckling self-test] ' + (out.pass ? 'PASS' : 'FAIL'), JSON.stringify(out));
  return out;
}

if (typeof window !== 'undefined') {
  window.homogenizeBucklingFE = homogenizeBucklingFE;
  window.runFEBucklingSelfTest = runFEBucklingSelfTest;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { homogenizeBucklingFE: homogenizeBucklingFE, bucklingFromSolidFE: bucklingFromSolidFE, fe_elementData: fe_elementData, fe_mesh: fe_mesh, fe_makeOps: fe_makeOps };
