/* ============================================================
   mg.js — geometric multigrid preconditioner for the voxel-FE K.

   · Levels: fine voxel grid N → N/2 → … → Nc (default 4).  Coarse element =
     2×2×2 block of the level below.
   · Prolongation: periodic trilinear interpolation (element-local and
     conforming, so the Galerkin operator Pᵀ K P is EXACTLY an assembly of
     coarse element matrices).  Coarse element matrix
         K_l[E] = Σ_{children c present} Q_cᵀ · K_{l−1}[c] · Q_c
     with 8 constant 24×24 child-interpolation matrices Q_c.  Void blocks give
     no coarse element; a thin wall still produces a coarse element (it is a
     true Galerkin coarse space, not a density-averaged re-discretisation).
   · Smoother: Chebyshev–Jacobi (degree `nu`, interval [λmax/ratio, 1.1·λmax]
     of D⁻¹K, λmax by power iteration).  Symmetric V-cycle ⇒ usable in PCG.
   · Coarsest: dense Cholesky with the 3 translations fixed by a rank-3
     penalty.
   Level vectors: level 0 uses the compact active-node layout of fe_makeOps;
   levels ≥1 use full-grid nodes (inactive rows have zero diagonal → zero).
   ============================================================ */
function fe_makeMG(ops, mesh, ed, o) {
  o = o || {};
  var nuS = o.nu || 3, ratio = o.ratio || 30, Nmin = o.Nc || 4;
  var N0 = mesh.N;

  /* child interpolation matrices Q_c (24 fine-local × 24 coarse-local) */
  var Q = [];
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
  function galerkinChild(Kc, qc) {   /* Qᵀ K Q */
    var KQ = fe_mm(Kc, qc, 24, 24, 24);
    return fe_mm(fe_tr(qc, 24, 24), KQ, 24, 24, 24);
  }

  /* ---- level 0 data ---- */
  var levels = [];
  var L0 = { N: N0, full: false, nA: mesh.nA, n: mesh.n, applyK: ops.applyK, diag: ops.diagK() };
  levels.push(L0);
  /* level-0 "element matrices" live as (voxel → Ke) implicitly; for building level 1 we
     need, per level-1 element, the child mask.  Represent each level by a map
     elemId(i,j,k at that level) → index into Kel (Float64 576 each). */
  var occ0 = new Uint8Array(N0 * N0 * N0); for (var e = 0; e < mesh.nel; e++) occ0[mesh.elemVox[e]] = 1;

  var prevN = N0, prevKel = null, prevIdx = null, prevOcc = occ0;
  var constChild = []; for (var c2 = 0; c2 < 8; c2++) constChild.push(galerkinChild(ed.Ke, Q[c2]));
  var memBytes = 0;
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
        var fi2 = 2 * I2 + ((c3 >> 2) & 1), fj2 = 2 * J2 + ((c3 >> 1) & 1), fk2 = 2 * K2 + (c3 & 1), fv = fi2 * prevN * prevN + fj2 * prevN + fk2;
        if (!prevOcc[fv]) continue;
        var G;
        if (!prevKel) G = constChild[c3];
        else G = galerkinChild(prevKel.subarray(prevIdx[fv] * 576, prevIdx[fv] * 576 + 576), Q[c3]);
        for (var t = 0; t < 576; t++) Kel[base + t] += G[t];
      }
    }
    memBytes += Kel.byteLength;
    var lev = { N: Nl, full: true, n: 3 * Nl3, nA: Nl3, ne: ne, list: Int32Array.from(list), Kel: Kel, idx: idx };
    lev.applyK = mkApplyFull(lev);
    lev.diag = diagFull(lev);
    levels.push(lev);
    prevN = Nl; prevKel = Kel; prevIdx = idx; prevOcc = occ;
  }

  function nodesOf(lev, v) {           /* 8 full-grid node ids of element voxel v at level lev */
    var Nl = lev.N, I = (v / (Nl * Nl)) | 0, r = v - I * Nl * Nl, J = (r / Nl) | 0, K = r - J * Nl, out = new Int32Array(8);
    for (var n = 0; n < 8; n++) out[n] = ((I + ((n >> 2) & 1)) % Nl) * Nl * Nl + ((J + ((n >> 1) & 1)) % Nl) * Nl + ((K + (n & 1)) % Nl);
    return out;
  }
  function mkApplyFull(lev) {
    var en = new Int32Array(lev.ne * 8);
    for (var q = 0; q < lev.ne; q++) en.set(nodesOf(lev, lev.list[q]), q * 8);
    lev.en = en;
    var nA = lev.nA, ue = new Float64Array(24), fe = new Float64Array(24), Kel = lev.Kel;
    return function (x, y) {
      y.fill(0);
      for (var e = 0; e < lev.ne; e++) {
        var b8 = e * 8, kb = e * 576;
        for (var a = 0; a < 8; a++) { var nd = en[b8 + a]; ue[3 * a] = x[nd]; ue[3 * a + 1] = x[nA + nd]; ue[3 * a + 2] = x[2 * nA + nd]; }
        for (var r = 0; r < 24; r++) { var s = 0, ro = kb + r * 24; for (var c = 0; c < 24; c++) s += Kel[ro + c] * ue[c]; fe[r] = s; }
        for (var a2 = 0; a2 < 8; a2++) { var nd2 = en[b8 + a2]; y[nd2] += fe[3 * a2]; y[nA + nd2] += fe[3 * a2 + 1]; y[2 * nA + nd2] += fe[3 * a2 + 2]; }
      }
    };
  }
  function diagFull(lev) {
    var d = new Float64Array(lev.n), nA = lev.nA;
    for (var e = 0; e < lev.ne; e++) for (var a = 0; a < 8; a++) { var nd = lev.en[e * 8 + a]; for (var c = 0; c < 3; c++) d[c * nA + nd] += lev.Kel[e * 576 + (3 * a + c) * 25]; }
    return d;
  }

  /* prolongation level l+1 (coarse, full grid) → level l */
  function mkTransfer(fine, coarse) {
    /* list of (fineDof-node, coarse node, weight) per fine node; ≤ 8 entries */
    var Nf = fine.N, Nc = coarse.N, nodesF = fine.full ? null : mesh.actNode;
    var nFn = fine.full ? Nf * Nf * Nf : fine.nA;
    var ptr = new Int32Array(nFn + 1), cols = [], wts = [];
    for (var f = 0; f < nFn; f++) {
      var g = fine.full ? f : nodesF[f];
      var i = (g / (Nf * Nf)) | 0, r = g - i * Nf * Nf, j = (r / Nf) | 0, k = r - j * Nf;
      var ci = [], cj = [], ck = [];
      function opts(ii, arr) { if (ii % 2 === 0) arr.push([(ii / 2) % Nc, 1]); else { arr.push([((ii - 1) / 2) % Nc, 0.5]); arr.push([((ii + 1) / 2) % Nc, 0.5]); } }
      opts(i, ci); opts(j, cj); opts(k, ck);
      for (var a = 0; a < ci.length; a++) for (var b = 0; b < cj.length; b++) for (var cz = 0; cz < ck.length; cz++) {
        cols.push(ci[a][0] * Nc * Nc + cj[b][0] * Nc + ck[cz][0]); wts.push(ci[a][1] * cj[b][1] * ck[cz][1]);
      }
      ptr[f + 1] = cols.length;
    }
    var C = Int32Array.from(cols), W = Float64Array.from(wts), nAf = nFn, nAc = coarse.nA;
    return {
      prolong: function (xc, xf) {   /* xf += P xc */
        for (var comp = 0; comp < 3; comp++) { var of = comp * nAf, oc = comp * nAc; for (var f2 = 0; f2 < nAf; f2++) { var s = 0; for (var p = ptr[f2]; p < ptr[f2 + 1]; p++) s += W[p] * xc[oc + C[p]]; xf[of + f2] += s; } }
      },
      restrict: function (rf, rc) {   /* rc = Pᵀ rf */
        rc.fill(0);
        for (var comp = 0; comp < 3; comp++) { var of = comp * nAf, oc = comp * nAc; for (var f2 = 0; f2 < nAf; f2++) { var v = rf[of + f2]; if (v === 0) continue; for (var p = ptr[f2]; p < ptr[f2 + 1]; p++) rc[oc + C[p]] += W[p] * v; } }
      }
    };
  }
  for (var l = 0; l + 1 < levels.length; l++) levels[l].T = mkTransfer(levels[l], levels[l + 1]);

  /* per level: inverse diagonal, λmax of D⁻¹K by power iteration */
  levels.forEach(function (lev) {
    var n = lev.n, id = new Float64Array(n);
    for (var i = 0; i < n; i++) id[i] = lev.diag[i] > 0 ? 1 / lev.diag[i] : 0;
    lev.idg = id;
    var x = new Float64Array(n), y = new Float64Array(n);
    for (var i2 = 0; i2 < n; i2++) x[i2] = id[i2] > 0 ? Math.random() - 0.5 : 0;
    var lam = 1;
    for (var it = 0; it < 15; it++) {
      var nx = Math.sqrt(fe_dot(x, x)); for (var i3 = 0; i3 < n; i3++) x[i3] /= nx;
      lev.applyK(x, y); for (var i4 = 0; i4 < n; i4++) y[i4] *= id[i4];
      lam = fe_dot(x, y); var t = x; x = y; y = t;
    }
    lev.lmax = 1.1 * Math.sqrt(fe_dot(x, x)) ;   /* ‖D⁻¹K x̂‖ after last step ≈ λmax */
    lev.lmax = Math.max(lev.lmax, 1.1 * lam);
    lev.r = new Float64Array(n); lev.z = new Float64Array(n); lev.t1 = new Float64Array(n); lev.t2 = new Float64Array(n);
    lev.x = new Float64Array(n); lev.b = new Float64Array(n);
  });

  /* coarsest: dense Cholesky of K + penalty on translations (over active nodes) */
  var LC = levels[levels.length - 1];
  (function () {
    var n = LC.n, A = new Float64Array(n * n), e = new Float64Array(n), col = new Float64Array(n);
    for (var j = 0; j < n; j++) { e.fill(0); e[j] = 1; LC.applyK(e, col); for (var i = 0; i < n; i++) A[i * n + j] = col[i]; }
    var act = []; for (var i2 = 0; i2 < n; i2++) act.push(LC.diag[i2] > 0 ? 1 : 0);
    var sc = 0; for (var i3 = 0; i3 < n; i3++) sc = Math.max(sc, LC.diag[i3]);
    var nAc = LC.nA, cntA = 0; for (var k = 0; k < nAc; k++) if (act[k]) cntA++;
    for (var comp = 0; comp < 3; comp++) for (var p = 0; p < nAc; p++) { if (!act[comp * nAc + p]) continue; for (var q = 0; q < nAc; q++) if (act[comp * nAc + q]) A[(comp * nAc + p) * n + comp * nAc + q] += sc / cntA; }
    for (var i4 = 0; i4 < n; i4++) if (!act[i4]) A[i4 * n + i4] = 1;
    LC.chol = bk_cholesky(A, n); LC.act = act;
    if (!LC.chol) throw new Error('MG coarsest Cholesky failed (disconnected coarse structure?)');
  })();
  function coarseSolve(b, x) {
    var n = LC.n, y = new Float64Array(n), bb = new Float64Array(n);
    for (var i = 0; i < n; i++) bb[i] = LC.act[i] ? b[i] : 0;
    bk_forwardSolve(LC.chol, bb, n, y); bk_backSolveLt(LC.chol, y, n, x);
    for (var i2 = 0; i2 < n; i2++) if (!LC.act[i2]) x[i2] = 0;
  }

  /* Chebyshev smoother: x ← x + p(D⁻¹A)·D⁻¹(b − A x), degree nuS */
  function cheb(lev, b, x) {
    var n = lev.n, r = lev.r, d = lev.t1, Ad = lev.t2, id = lev.idg;
    var lmax = lev.lmax, lmin = lmax / ratio, th = 0.5 * (lmax + lmin), de = 0.5 * (lmax - lmin);
    lev.applyK(x, Ad); for (var i = 0; i < n; i++) r[i] = b[i] - Ad[i];
    var sigma = th / de, rho = 1 / sigma;
    for (var i2 = 0; i2 < n; i2++) d[i2] = id[i2] * r[i2] / th;
    for (var k = 0; k < nuS; k++) {
      for (var i3 = 0; i3 < n; i3++) x[i3] += d[i3];
      if (k === nuS - 1) break;
      lev.applyK(d, Ad); for (var i4 = 0; i4 < n; i4++) r[i4] -= Ad[i4];
      var rhoN = 1 / (2 * sigma - rho);
      for (var i5 = 0; i5 < n; i5++) d[i5] = rhoN * rho * d[i5] + 2 * rhoN / de * id[i5] * r[i5];
      rho = rhoN;
    }
  }
  var cnt = { v: 0 };
  function vcycle(l, b, x) {
    var lev = levels[l];
    if (l === levels.length - 1) { coarseSolve(b, x); return; }
    x.fill(0);
    cheb(lev, b, x);
    lev.applyK(x, lev.t2); for (var i = 0; i < lev.n; i++) lev.r[i] = b[i] - lev.t2[i];
    var C = levels[l + 1];
    lev.T.restrict(lev.r, C.b);
    vcycle(l + 1, C.b, C.x);
    lev.T.prolong(C.x, x);
    cheb(lev, b, x);
  }
  var L0x = levels[0].x;
  return {
    levels: levels.map(function (lv) { return { N: lv.N, n: lv.n, ne: lv.ne || mesh.nel, lmax: +lv.lmax.toFixed(3) }; }),
    memBytes: memBytes, cnt: cnt,
    apply: function (r, z) { vcycle(0, r, z); cnt.v++; }
  };
}
