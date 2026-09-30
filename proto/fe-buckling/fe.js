/* ============================================================
   fe.js — PROTOTYPE matrix-free voxel finite elements for
   cell-periodic (q = 0) linear buckling.  Scratch only.

   Model
   · Periodic N³ voxel grid, voxel size h = 1 (λ is dimensionless, K ∝ E·h and
     K_g ∝ σ·h, so h cancels).  Node (i,j,k) sits at the LOW corner of voxel
     (i,j,k); node id = i·N² + j·N + k with periodic wrap (same order as
     buildVoxels: x = i slowest, z = k fastest).
   · Every SOLID voxel is one 8-node trilinear hex, 2×2×2 Gauss.  Void voxels
     have no element.  Active DOFs = 3 per node touching a solid element.
     No void-stiffness parameter exists.
   · Element types:
       'H8'   full-integration trilinear hex (no hourglass modes, locks in bending)
       'H8I'  Wilson–Taylor incompatible modes (9 bubble DOFs, 1−ξ², 1−η², 1−ζ²
              per component), statically condensed ONCE into a constant 24×24 Ke
              (cube → constant Jacobian → passes the patch test; same element
              family as Abaqus C3D8I).
     All elements are identical cubes of one material, so Ke is ONE constant
     24×24 matrix.  The geometric stiffness uses compatible shape-function
     gradients and the Gauss-point prestress:
       Kg_e = I3 ⊗ M_e,   M_e[a][b] = Σ_g w_g ∇N_a(g)ᵀ σ_g ∇N_b(g)
     stored per element (8×8).
   · Vector layout: COMPONENT-MAJOR, x[c·nA + a], a = active node index.
     Rigid translations are the per-component constants → projector = zero mean.

   Loading (same convention as 16c 'uniaxial'): basis solves for unit macro
   strains ε̄ = e_j (periodic fluctuation ũ, RHS −K·u_macro), C̄[:,j] = σ̄(e_j);
   uniaxial compression on axis a: ε̄ = −E_a·S·e_a, E_a = 1/S_aa  → unit
   compressive axial strain, free laterals.  Directions with no stiffness
   (e.g. across a plate laminate) are dropped from S (any macro strain there
   costs zero stress).
   Eigen: (−K_g) φ = θ K φ, λ_cr = 1/θ_max, p_cr = λ_cr·E_a.
   ============================================================ */

/* ---------- small dense helpers ---------- */
function fe_isoC(E, nu) {
  var lam = E * nu / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  var C = new Float64Array(36);
  C[0] = C[7] = C[14] = lam + 2 * mu;
  C[1] = C[2] = C[6] = C[8] = C[12] = C[13] = lam;
  C[21] = C[28] = C[35] = mu;
  return C;
}
function fe_inv(A, n) {             /* Gauss-Jordan, dense */
  var w = 2 * n, M = new Float64Array(n * w);
  for (var r = 0; r < n; r++) { for (var c = 0; c < n; c++) M[r * w + c] = A[r * n + c]; M[r * w + n + r] = 1; }
  for (var col = 0; col < n; col++) {
    var piv = col, best = Math.abs(M[col * w + col]);
    for (var r2 = col + 1; r2 < n; r2++) if (Math.abs(M[r2 * w + col]) > best) { best = Math.abs(M[r2 * w + col]); piv = r2; }
    if (!(best > 1e-300)) return null;
    if (piv !== col) for (var s = 0; s < w; s++) { var t = M[col * w + s]; M[col * w + s] = M[piv * w + s]; M[piv * w + s] = t; }
    var iv = 1 / M[col * w + col];
    for (var s2 = 0; s2 < w; s2++) M[col * w + s2] *= iv;
    for (var r3 = 0; r3 < n; r3++) { if (r3 === col) continue; var f = M[r3 * w + col]; if (f === 0) continue; for (var s3 = 0; s3 < w; s3++) M[r3 * w + s3] -= f * M[col * w + s3]; }
  }
  var out = new Float64Array(n * n);
  for (var r4 = 0; r4 < n; r4++) for (var c4 = 0; c4 < n; c4++) out[r4 * n + c4] = M[r4 * w + n + c4];
  return out;
}
/* out(n×m) = A(n×k)·B(k×m) */
function fe_mm(A, B, n, k, m) { var o = new Float64Array(n * m); for (var i = 0; i < n; i++) for (var p = 0; p < k; p++) { var a = A[i * k + p]; if (a === 0) continue; for (var j = 0; j < m; j++) o[i * m + j] += a * B[p * m + j]; } return o; }
function fe_tr(A, n, m) { var o = new Float64Array(n * m); for (var i = 0; i < n; i++) for (var j = 0; j < m; j++) o[j * n + i] = A[i * m + j]; return o; }

/* strain-displacement rows for one "node" with gradient g=[gx,gy,gz]:
   fills B (6 × ncol) columns 3a..3a+2, engineering Voigt [xx,yy,zz,yz,xz,xy] */
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
   fe_elementData(E, nu, type) — constant element operators for a unit cube.
   Local node n = a·4 + b·2 + c, (a,b,c) ∈ {0,1}³ → corner offset (a,b,c).
   Returns { Ke(576), Beff[8](6×24), G[8](8×3 ∇N at GP), w (=1/8 GP volume),
             C(36), type }.
   ============================================================ */
function fe_elementData(E, nu, type) {
  var C = fe_isoC(E, nu), g = 1 / Math.sqrt(3), w = 1 / 8;   /* weight 1 × detJ 1/8 */
  var sgn = [], gps = [];
  for (var n = 0; n < 8; n++) sgn.push([((n >> 2) & 1) * 2 - 1, ((n >> 1) & 1) * 2 - 1, (n & 1) * 2 - 1]);
  if (type === 'H8R') { gps.push([0, 0, 0]); w = 1; }      /* one-point (reduced) integration, NO hourglass control — diagnostic only */
  else for (var q = 0; q < 8; q++) gps.push([sgn[q][0] * g, sgn[q][1] * g, sgn[q][2] * g]);
  var ngp = gps.length;
  var Kuu = new Float64Array(576), Kaa = new Float64Array(81), Kau = new Float64Array(9 * 24);
  var Bc = [], Ba = [], G = [];
  for (var gi = 0; gi < ngp; gi++) {
    var xi = gps[gi][0], et = gps[gi][1], ze = gps[gi][2];
    var B = new Float64Array(6 * 24), Gg = new Float64Array(24);
    for (var a = 0; a < 8; a++) {
      var sx = sgn[a][0], sy = sgn[a][1], sz = sgn[a][2];
      /* dN/dx = 2·dN/dξ  (x = (ξ+1)/2) */
      var gx = 2 * sx * (1 + sy * et) * (1 + sz * ze) / 8;
      var gy = 2 * sy * (1 + sx * xi) * (1 + sz * ze) / 8;
      var gz = 2 * sz * (1 + sx * xi) * (1 + sy * et) / 8;
      fe_fillB(B, 24, a, gx, gy, gz);
      Gg[a * 3] = gx; Gg[a * 3 + 1] = gy; Gg[a * 3 + 2] = gz;
    }
    Bc.push(B); G.push(Gg);
    var CB = fe_mm(C, B, 6, 6, 24), BtCB = fe_mm(fe_tr(B, 6, 24), CB, 24, 6, 24);
    for (var t = 0; t < 576; t++) Kuu[t] += w * BtCB[t];
    /* incompatible bubble modes: M_m = 1 − ξ_m²  → dM/dx_m = 2·(−2ξ_m) */
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
  return { Ke: Ke, Beff: Beff, G: G, w: w, ngp: ngp, C: C, type: type || 'H8', E: E, nu: nu };
}

/* ============================================================
   fe_mesh(solid, N) — element list + active-node compaction.
   ============================================================ */
function fe_mesh(solid, N, voidRatio) {
  /* voidRatio > 0 (DIAGNOSTIC ONLY): void voxels also get elements, scaled by voidRatio —
     reproduces the spectral code's soft-void setting inside the FE model. */
  var N2 = N * N, N3 = N2 * N, nel = 0, vr = voidRatio || 0;
  for (var v = 0; v < N3; v++) if (solid[v] || vr > 0) nel++;
  var elemVox = new Int32Array(nel), used = new Uint8Array(N3), e = 0, escale = vr > 0 ? new Float64Array(nel) : null;
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    var vid = i * N2 + j * N + k;
    if (!solid[vid] && !(vr > 0)) continue;
    if (escale) escale[e] = solid[vid] ? 1 : vr;
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
  return { N: N, N3: N3, nel: nel, nA: nA, n: 3 * nA, escale: escale, elemVox: elemVox, en: en, act: act, actNode: Int32Array.from(actNode) };
}

/* ============================================================
   Operators (matrix-free, element loop, scatter-add)
   ============================================================ */
function fe_makeOps(mesh, ed) {
  var nel = mesh.nel, nA = mesh.nA, n = mesh.n, en = mesh.en, Ke = ed.Ke;
  var ue = new Float64Array(24), fe = new Float64Array(24), off = [0, nA, 2 * nA], esc = mesh.escale, ngp = ed.ngp || 8;
  var Mg = null;   /* per-element 8×8 geometric block (Kg_e = I3 ⊗ M_e) */
  var cnt = { K: 0, AB: 0 };

  function gather(x, base) {
    for (var a = 0; a < 8; a++) { var nd = en[base + a]; ue[3 * a] = x[nd]; ue[3 * a + 1] = x[nA + nd]; ue[3 * a + 2] = x[2 * nA + nd]; }
  }
  function applyK(x, y) {
    y.fill(0);
    for (var e = 0; e < nel; e++) {
      var base = e * 8;
      gather(x, base);
      var sc = esc ? esc[e] : 1;
      for (var r = 0; r < 24; r++) { var s = 0, ro = r * 24; for (var c = 0; c < 24; c++) s += Ke[ro + c] * ue[c]; fe[r] = sc * s; }
      for (var a = 0; a < 8; a++) { var nd = en[base + a]; y[nd] += fe[3 * a]; y[nA + nd] += fe[3 * a + 1]; y[2 * nA + nd] += fe[3 * a + 2]; }
    }
    cnt.K++;
  }
  /* A = −K_g and B = K in one element pass */
  function applyAB1(x, A, B) {
    A.fill(0); B.fill(0);
    for (var e = 0; e < nel; e++) {
      var base = e * 8, mb = e * 64, sc = esc ? esc[e] : 1;
      gather(x, base);
      for (var r = 0; r < 24; r++) { var s = 0, ro = r * 24; for (var c = 0; c < 24; c++) s += Ke[ro + c] * ue[c]; fe[r] = sc * s; }
      for (var a = 0; a < 8; a++) {
        var nd = en[base + a];
        B[nd] += fe[3 * a]; B[nA + nd] += fe[3 * a + 1]; B[2 * nA + nd] += fe[3 * a + 2];
        var gx = 0, gy = 0, gz = 0, mo = mb + a * 8;
        for (var b = 0; b < 8; b++) { var m = Mg[mo + b]; gx += m * ue[3 * b]; gy += m * ue[3 * b + 1]; gz += m * ue[3 * b + 2]; }
        A[nd] -= gx; A[nA + nd] -= gy; A[2 * nA + nd] -= gz;
      }
    }
    cnt.AB++;
  }
  function applyA1(x, A) {
    A.fill(0);
    for (var e = 0; e < nel; e++) {
      var base = e * 8, mb = e * 64;
      gather(x, base);
      for (var a = 0; a < 8; a++) {
        var nd = en[base + a], gx = 0, gy = 0, gz = 0, mo = mb + a * 8;
        for (var b = 0; b < 8; b++) { var m = Mg[mo + b]; gx += m * ue[3 * b]; gy += m * ue[3 * b + 1]; gz += m * ue[3 * b + 2]; }
        A[nd] -= gx; A[nA + nd] -= gy; A[2 * nA + nd] -= gz;
      }
    }
  }
  function diagK() {
    var d = new Float64Array(n);
    for (var e = 0; e < nel; e++) for (var a = 0; a < 8; a++) {
      var nd = en[e * 8 + a], sc = esc ? esc[e] : 1;
      d[nd] += sc * Ke[(3 * a) * 25]; d[nA + nd] += sc * Ke[(3 * a + 1) * 25]; d[2 * nA + nd] += sc * Ke[(3 * a + 2) * 25];
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
  /* RHS for macro strain ε̄: f = −Σ_e scatter(Ke·u_mac) (same for every element) */
  function macroRHS(eb) {
    var um = macroLocal(eb), f0 = new Float64Array(24), f = new Float64Array(n);
    for (var r = 0; r < 24; r++) { var s = 0; for (var c = 0; c < 24; c++) s += Ke[r * 24 + c] * um[c]; f0[r] = -s; }
    for (var e = 0; e < nel; e++) { var sc = esc ? esc[e] : 1; for (var a = 0; a < 8; a++) { var nd = en[e * 8 + a]; f[nd] += sc * f0[3 * a]; f[nA + nd] += sc * f0[3 * a + 1]; f[2 * nA + nd] += sc * f0[3 * a + 2]; } }
    return f;
  }
  /* Gauss-point strain of (ũ, ε̄) for element e → eps[8][6]; also volume-average stress */
  function elemGPStrain(x, eb, e, um, epsOut) {
    gather(x, e * 8);
    for (var t = 0; t < 24; t++) fe[t] = ue[t] + um[t];
    for (var g = 0; g < ngp; g++) {
      var Be = ed.Beff[g];
      for (var P = 0; P < 6; P++) { var s = 0, ro = P * 24; for (var c = 0; c < 24; c++) s += Be[ro + c] * fe[c]; epsOut[g * 6 + P] = s; }
    }
  }
  function avgStress(x, eb) {
    var um = macroLocal(eb), eps = new Float64Array(48), C = ed.C, sb = [0, 0, 0, 0, 0, 0];
    for (var e = 0; e < nel; e++) {
      elemGPStrain(x, eb, e, um, eps); var sc = esc ? esc[e] : 1;
      for (var g = 0; g < ngp; g++) for (var P = 0; P < 6; P++) { var s = 0; for (var Q = 0; Q < 6; Q++) s += C[P * 6 + Q] * eps[g * 6 + Q]; sb[P] += sc * ed.w * s; }
    }
    for (var P2 = 0; P2 < 6; P2++) sb[P2] /= mesh.N3;
    return sb;
  }
  /* build per-element M_e from the prestress (ũ, ε̄); opts.avg → element-average stress */
  function setPrestress(x, eb, useAvg) {
    if (!Mg) Mg = new Float64Array(nel * 64);
    var um = macroLocal(eb), eps = new Float64Array(48), C = ed.C, sg = new Float64Array(48);
    var smax = 0;
    for (var e = 0; e < nel; e++) {
      elemGPStrain(x, eb, e, um, eps); var sc = esc ? esc[e] : 1;
      for (var g = 0; g < ngp; g++) for (var P = 0; P < 6; P++) { var s = 0; for (var Q = 0; Q < 6; Q++) s += C[P * 6 + Q] * eps[g * 6 + Q]; sg[g * 6 + P] = sc * s; }
      if (useAvg) { for (var P3 = 0; P3 < 6; P3++) { var av = 0; for (var g3 = 0; g3 < ngp; g3++) av += sg[g3 * 6 + P3]; av /= ngp; for (var g4 = 0; g4 < ngp; g4++) sg[g4 * 6 + P3] = av; } }
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
  /* voxel-field copy of a nodal vector (element-center average) for bk_modeLocalization */
  function toVoxelField(x) {
    var N3 = mesh.N3, out = new Float64Array(3 * N3);
    for (var e = 0; e < nel; e++) { var v = mesh.elemVox[e]; for (var c = 0; c < 3; c++) { var s = 0; for (var a = 0; a < 8; a++) s += x[off[c] + en[e * 8 + a]]; out[c * N3 + v] = s / 8; } }
    return out;
  }
  return {
    n: n, N3: nA, nA: nA, mesh: mesh, ed: ed, cnt: cnt,
    applyK: applyK, applyAB1: applyAB1, applyA1: applyA1, diagK: diagK, macroRHS: macroRHS, macroLocal: macroLocal,
    avgStress: avgStress, setPrestress: setPrestress, toVoxelField: toVoxelField,
    mgBytes: function () { return Mg ? Mg.byteLength : 0; }
  };
}

/* ---------- vector helpers ---------- */
function fe_dot(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function fe_zeroMean(x, nA) { for (var c = 0; c < 3; c++) { var b = c * nA, s = 0; for (var i = 0; i < nA; i++) s += x[b + i]; s /= nA; for (var i2 = 0; i2 < nA; i2++) x[b + i2] -= s; } }

/* PCG on the zero-mean subspace.  applyM(r, z) preconditioner. */
function fe_pcg(applyK, applyM, b, nA, tol, maxit, x0) {
  var n = b.length, x = x0 ? Float64Array.from(x0) : new Float64Array(n), r = Float64Array.from(b), z = new Float64Array(n), Ap = new Float64Array(n);
  fe_zeroMean(r, nA);
  if (x0) { applyK(x, Ap); for (var i0 = 0; i0 < n; i0++) r[i0] -= Ap[i0]; }
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
   fe_prestress(ops, precond, opts) — 3 (or 6) unit macro-strain solves,
   effective C̄ (live directions only), uniaxial combination per axis.
   Returns { C6, live, basis:[{u, eb, sBar}], uni(a) → {u, eb, Ea}, iters[] }.
   ============================================================ */
function fe_prestress(ops, applyM, opts) {
  opts = opts || {};
  var tol = opts.cgTol || 1e-8, maxit = opts.cgMaxiter || 5000, nA = ops.nA;
  var basis = [], iters = [], t0 = performance.now();
  var nb = opts.shear ? 6 : 3;
  for (var j = 0; j < nb; j++) {
    var eb = [0, 0, 0, 0, 0, 0]; eb[j] = 1;
    var f = ops.macroRHS(eb);
    var sol = fe_pcg(ops.applyK, applyM, f, nA, tol, maxit, null);
    iters.push(sol.iters);
    basis.push({ u: sol.x, eb: eb, sBar: ops.avgStress(sol.x, eb), relres: sol.relres });
  }
  /* shear coupling check (normal solves only) */
  var Cn = 0, Csn = 0;
  for (var j2 = 0; j2 < 3; j2++) { for (var P = 0; P < 3; P++) Cn = Math.max(Cn, Math.abs(basis[j2].sBar[P])); for (var P2 = 3; P2 < 6; P2++) Csn = Math.max(Csn, Math.abs(basis[j2].sBar[P2])); }
  var C6 = new Float64Array(36);
  for (var jj = 0; jj < nb; jj++) for (var PP = 0; PP < 6; PP++) C6[PP * 6 + jj] = basis[jj].sBar[PP];
  /* live directions: diagonal stiffness above 1e-6 of the max */
  var dmax = 0; for (var d = 0; d < nb; d++) dmax = Math.max(dmax, C6[d * 7]);
  var live = []; for (var d2 = 0; d2 < nb; d2++) if (C6[d2 * 7] > 1e-6 * dmax) live.push(d2);
  var nl = live.length, Cl = new Float64Array(nl * nl);
  for (var p = 0; p < nl; p++) for (var q = 0; q < nl; q++) Cl[p * nl + q] = C6[live[p] * 6 + live[q]];
  var Sl = fe_inv(Cl, nl);
  function uni(a) {
    var ia = live.indexOf(a); if (ia < 0) return null;
    var Ea = 1 / Sl[ia * nl + ia], u = new Float64Array(ops.n), eb = [0, 0, 0, 0, 0, 0];
    for (var p2 = 0; p2 < nl; p2++) {
      var wj = -Ea * Sl[p2 * nl + ia], B = basis[live[p2]];
      for (var i = 0; i < u.length; i++) u[i] += wj * B.u[i];
      for (var P3 = 0; P3 < 6; P3++) eb[P3] += wj * B.eb[P3];
    }
    return { u: u, eb: eb, Ea: Ea };
  }
  return { C6: C6, live: live, basis: basis, uni: uni, iters: iters, coupling: Csn / Math.max(Cn, 1e-300), t: (performance.now() - t0) / 1000 };
}

/* ============================================================
   fe_buckle(solid, N, opts) — full pipeline.
   opts: type ('H8'|'H8I'), E, nu, axes, block, eigTol, eigIters, resTol,
         cgTol, stressAvg, precond ('jacobi'|'mg'), seed, prune (default true)
   ============================================================ */
function fe_buckle(solid, N, opts) {
  opts = opts || {};
  var T0 = performance.now(), E = opts.E || 110000, nu = opts.nu != null ? opts.nu : 0.34;
  if (opts.prune !== false && typeof pruneToLargestComponent === 'function') solid = pruneToLargestComponent(solid, N);
  var ed = fe_elementData(E, nu, opts.type || 'H8');
  var mesh = fe_mesh(solid, N, opts.voidRatio), ops = fe_makeOps(mesh, ed);
  var diag = ops.diagK(), idg = new Float64Array(diag.length);
  for (var i = 0; i < diag.length; i++) idg[i] = diag[i] > 0 ? 1 / diag[i] : 0;
  var applyM = function (r, z) { for (var i2 = 0; i2 < r.length; i2++) z[i2] = r[i2] * idg[i2]; };
  var precName = 'jacobi';
  if (opts.precond === 'mg' && typeof fe_makeMG === 'function') { var mg = fe_makeMG(ops, mesh, ed, opts.mg || {}); applyM = mg.apply; precName = 'mg'; ops.mg = mg; }
  var tSetup = (performance.now() - T0) / 1000;
  var tp = performance.now();
  var pre = fe_prestress(ops, applyM, { cgTol: opts.cgTol || 1e-8, cgMaxiter: opts.cgMaxiter || 20000, shear: opts.shear });
  var tPre = (performance.now() - tp) / 1000;
  var axes = opts.axes || [0, 1, 2], perAxis = [], best = null;
  var kit = {
    n: ops.n, N3: ops.nA,
    applyAB: function (xa, xb, Aa, Ab, Ba, Bb) { ops.applyAB1(xa, Aa, Ba); if (xb) ops.applyAB1(xb, Ab, Bb); },
    applyT2: function (ra, rb, za, zb) { applyM(ra, za); if (rb) applyM(rb, zb); }
  };
  for (var ai = 0; ai < axes.length; ai++) {
    var a = axes[ai], U = pre.uni(a);
    if (!U) { perAxis.push({ axis: a, skipped: 'no stiffness along axis' }); continue; }
    var ts = performance.now();
    ops.setPrestress(U.u, U.eb, !!opts.stressAvg);
    var tMg = (performance.now() - ts) / 1000;
    var te = performance.now(), c0 = ops.cnt.AB;
    var pairs = lobpcgFast(kit, opts.block || 4, { iters: opts.eigIters || 400, tol: opts.eigTol || 1e-5, nConv: 1, nStable: 2, resTol: opts.resTol || 0.02, seed: opts.seed != null ? opts.seed : 12345 });
    var tEig = (performance.now() - te) / 1000;
    var lam = Infinity, mode = null, thetas = [];
    for (var p = 0; p < pairs.length; p++) { thetas.push(pairs[p].theta); if (pairs[p].theta > 1e-12 && 1 / pairs[p].theta < lam) { lam = 1 / pairs[p].theta; mode = pairs[p].vec; } }
    var mw = (typeof bk_modeLocalization === 'function' && mode) ? bk_modeLocalization(ops.toVoxelField(mode), solid, N) : NaN;
    var rec = { axis: a, lambda: lam, Ea: U.Ea, pcr: lam * U.Ea, lams: thetas.map(function (t) { return 1 / t; }), iters: pairs._iters, conv: pairs._converged, resLead: pairs._resLead, nAB: ops.cnt.AB - c0, tEig: tEig, tMg: tMg, mWave: mw, mode: mode };
    perAxis.push(rec);
    if (!best || lam < best.lambda) best = rec;
  }
  var nS = 0; for (var v = 0; v < mesh.N3; v++) if (solid[v]) nS++;
  return { N: N, type: ed.type, precond: precName, rho: nS / mesh.N3, nel: mesh.nel, nA: mesh.nA, nDof: mesh.n, pre: pre, perAxis: perAxis, best: best,
           tSetup: tSetup, tPre: tPre, tTotal: (performance.now() - T0) / 1000, ops: ops, solid: solid };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { fe_elementData: fe_elementData, fe_mesh: fe_mesh, fe_makeOps: fe_makeOps, fe_buckle: fe_buckle };
