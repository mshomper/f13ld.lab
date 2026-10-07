/* ============================================================
   proto/thermal/faces-tpfa.js — the FIRST Phase 0 scheme, kept for the record.
   Temperature at voxel centres, one conductance per face ("two-point flux"),
   face conductance a laminate composite of the link-centred cell
   (n2·series + (1−n2)·parallel).  Exact for walls aligned with the grid
   (T1/T2) but first-order wrong on inclined walls: a two-point stencil
   can't carry the off-diagonal conductivity of an inclined wall, so a 45°
   wall 2.3 voxels thick reads 19 % low and a sheet gyroid at N = 64 reads
   8–16 % low.  Replaced in 17a by full-tensor composite voxels on the
   rotated grid (docs/THERMAL_SCOPE.md §11).  Needs planeCubeSolidFraction
   (14e) and fft3dCpu (18).
   ============================================================ */
var LINK_SAMPLES_F = 8, LINK_BISECT_F = 6, LINK_CELL_SUB_F = 4, LINK_PLANE_MISS_F = 1;
function linkFieldFacesFromFn(fn, N, kept, raw, mCorner, opts) {
  opts = opts || {};
  var L = Math.PI, h = 2 * L / N, NN = N * N, N3 = NN * N;
  var S = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
  var PHI = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
  var N2 = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
  var gd = 0.25 * h;
  var nEx = 0, nPlane = 0, solidSum = 0, cellM = new Float64Array(LINK_CELL_SUB_F * LINK_CELL_SUB_F * LINK_CELL_SUB_F);
  var tS = new Float64Array(LINK_SAMPLES_F + 1), mS = new Float64Array(LINK_SAMPLES_F + 1);
  for (var q = 0; q <= LINK_SAMPLES_F; q++) tS[q] = q / LINK_SAMPLES_F;
  function isKept(id) { return kept[id] > 0.5; }
  function trimmed(id) { return raw && raw[id] > 0.5 && !(kept[id] > 0.5); }
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    var id = i * NN + j * N + k;
    if (isKept(id)) solidSum++;
    var x = -L + (i + 0.5) * h, y = -L + (j + 0.5) * h, z = -L + (k + 0.5) * h;
    for (var a = 0; a < 3; a++) {
      var i1 = a === 0 ? (i + 1) % N : i, j1 = a === 1 ? (j + 1) % N : j, k1 = a === 2 ? (k + 1) % N : k;
      var nb = i1 * NN + j1 * N + k1, ka = isKept(id), kb = isKept(nb);
      if (opts.staircase || trimmed(id) || trimmed(nb)) {
        S[a][id] = PHI[a][id] = (ka ? 0.5 : 0) + (kb ? 0.5 : 0); N2[a][id] = -1; continue;
      }
      /* candidate test: ends differ, or a corner of the shared face has the other sign */
      var cand = ka !== kb;
      if (!cand && mCorner) {
        /* the shared face is the +a face of voxel i: its 4 corners have index (i+1 along a) */
        var ci = a === 0 ? (i + 1) % N : i, cj = a === 1 ? (j + 1) % N : j, ck = a === 2 ? (k + 1) % N : k;
        var b1 = a === 0 ? [0, 1, 0] : [1, 0, 0], b2 = a === 2 ? [0, 1, 0] : [0, 0, 1];
        for (var c = 0; c < 4 && !cand; c++) {
          var u = c & 1, v = c >> 1;
          var cx = (ci + u * b1[0] + v * b2[0]) % N, cy = (cj + u * b1[1] + v * b2[1]) % N, cz = (ck + u * b1[2] + v * b2[2]) % N;
          if ((mCorner[cx * NN + cy * N + cz] > 0) !== ka) cand = true;
        }
      }
      if (!cand) { S[a][id] = PHI[a][id] = ka ? 1 : 0; N2[a][id] = 1; continue; }
      nEx++;
      /* sample the margin along the link; the kept cube fixes the end signs */
      var dx = a === 0 ? h : 0, dy = a === 1 ? h : 0, dz = a === 2 ? h : 0;
      for (var p = 0; p <= LINK_SAMPLES_F; p++) {
        if (p === 0) { mS[p] = ka ? 1 : -1; continue; }
        if (p === LINK_SAMPLES_F) { mS[p] = kb ? 1 : -1; continue; }
        mS[p] = fn(x + tS[p] * dx, y + tS[p] * dy, z + tS[p] * dz);
      }
      /* walk the segments: solid length, with each sign change refined by bisection */
      var sLen = 0, tPrev = 0, sPrev = mS[0] > 0, nCross = 0;
      for (var p2 = 1; p2 <= LINK_SAMPLES_F; p2++) {
        var sNow = mS[p2] > 0;
        if (sNow !== sPrev) {
          nCross++;
          var lo = tS[p2 - 1], hi = tS[p2];
          for (var bs = 0; bs < LINK_BISECT_F; bs++) {
            var mid = 0.5 * (lo + hi), mm = fn(x + mid * dx, y + mid * dy, z + mid * dz);
            if ((mm > 0) === sPrev) lo = mid; else hi = mid;
          }
          var tc = 0.5 * (lo + hi);
          if (sPrev) sLen += tc - tPrev;
          tPrev = tc; sPrev = sNow;
        }
      }
      if (sPrev) sLen += 1 - tPrev;
      S[a][id] = sLen;
      /* composite cell (voxel-sized, centred on the link midpoint):
         sample the margin at LINK_CELL_SUB_F³ points → sampled solid fraction,
         and the wall direction from the squared differences between
         neighbouring samples (sign-free, so a thin sheet's two faces agree). */
      var mx = x + 0.5 * dx, my = y + 0.5 * dy, mz = z + 0.5 * dz, m0 = mS[LINK_SAMPLES_F >> 1];
      var ns = LINK_CELL_SUB_F, hs = h / ns, nIn = 0;
      for (var si = 0; si < ns; si++) for (var sj = 0; sj < ns; sj++) for (var sk = 0; sk < ns; sk++) {
        var v = fn(mx + (si + 0.5) * hs - 0.5 * h, my + (sj + 0.5) * hs - 0.5 * h, mz + (sk + 0.5) * hs - 0.5 * h);
        cellM[(si * ns + sj) * ns + sk] = v; if (v > 0) nIn++;
      }
      var Gx = 0, Gy = 0, Gz = 0;
      for (var ti = 0; ti < ns; ti++) for (var tj = 0; tj < ns; tj++) for (var tk = 0; tk < ns; tk++) {
        var c0 = cellM[(ti * ns + tj) * ns + tk], dd;
        if (ti + 1 < ns) { dd = cellM[((ti + 1) * ns + tj) * ns + tk] - c0; Gx += dd * dd; }
        if (tj + 1 < ns) { dd = cellM[(ti * ns + tj + 1) * ns + tk] - c0; Gy += dd * dd; }
        if (tk + 1 < ns) { dd = cellM[(ti * ns + tj) * ns + tk + 1] - c0; Gz += dd * dd; }
      }
      var G = Gx + Gy + Gz, phiS = nIn / (ns * ns * ns);
      /* the exact plane–cube fraction when the cell holds one plane-like wall:
         one crossing on the link and the linearized plane predicts the sign
         of (nearly) every sample */
      var gx = (fn(mx + gd, my, mz) - fn(mx - gd, my, mz)) / (2 * gd) * h;
      var gy = (fn(mx, my + gd, mz) - fn(mx, my - gd, mz)) / (2 * gd) * h;
      var gz = (fn(mx, my, mz + gd) - fn(mx, my, mz - gd)) / (2 * gd) * h;
      var g2 = gx * gx + gy * gy + gz * gz, usePlane = nCross <= 1 && g2 > 1e-24;
      if (usePlane) {
        var miss = 0;
        for (var ui = 0; ui < ns && miss <= LINK_PLANE_MISS_F; ui++) for (var uj = 0; uj < ns; uj++) for (var uk = 0; uk < ns; uk++) {
          var pl = m0 + gx * ((ui + 0.5) / ns - 0.5) + gy * ((uj + 0.5) / ns - 0.5) + gz * ((uk + 0.5) / ns - 0.5);
          if ((pl > 0) !== (cellM[(ui * ns + uj) * ns + uk] > 0)) miss++;
        }
        usePlane = miss <= LINK_PLANE_MISS_F;
      }
      if (usePlane) {
        PHI[a][id] = planeCubeSolidFraction(m0, gx, gy, gz);
        N2[a][id] = (a === 0 ? gx * gx : a === 1 ? gy * gy : gz * gz) / g2;
        nPlane++;
      } else if (G > 1e-30) {
        PHI[a][id] = phiS;
        N2[a][id] = (a === 0 ? Gx : a === 1 ? Gy : Gz) / G;
      } else { PHI[a][id] = sLen; N2[a][id] = -1; }
    }
  }
  var linkSum = 0, phiSum = 0;
  for (var a2 = 0; a2 < 3; a2++) for (var n2 = 0; n2 < N3; n2++) { linkSum += S[a2][n2]; phiSum += PHI[a2][n2]; }
  return { N: N, kept: kept, raw: raw, s: S, phi: PHI, n2: N2, rho: solidSum / N3, rhoLink: linkSum / (3 * N3), rhoPhi: phiSum / (3 * N3), nExamined: nEx, nPlane: nPlane };
}


function thermalFaceConductancesTPFA(lf, kS, kF) {
  var N3 = lf.N * lf.N * lf.N, out = [];
  for (var a = 0; a < 3; a++) {
    var s = lf.s[a], ph = lf.phi ? lf.phi[a] : null, n2 = lf.n2 ? lf.n2[a] : null, k = new Float64Array(N3);
    for (var i = 0; i < N3; i++) {
      if (ph && n2[i] >= 0) {
        var p = ph[i];
        if (p >= 1) { k[i] = kS; continue; }
        if (p <= 0) { k[i] = kF; continue; }
        k[i] = n2[i] / (p / kS + (1 - p) / kF) + (1 - n2[i]) * (p * kS + (1 - p) * kF);
        continue;
      }
      var f = s[i];
      k[i] = f >= 1 ? kS : (f <= 0 ? kF : 1 / (f / kS + (1 - f) / kF));
    }
    out.push(k);
  }
  return out;
}

function solveThermalFacesCPU(lf, kS, kF, opts) {
  opts = opts || {};
  var tol = opts.tol || 1e-8, maxit = opts.maxiter || 5000;
  var N = lf.N, NN = N * N, N3 = NN * N;
  var Kf = thermalFaceConductancesTPFA(lf, kS, kF);
  /* neighbour offsets (periodic), forward and backward, per axis */
  var fw = [new Int32Array(N3), new Int32Array(N3), new Int32Array(N3)];
  var bw = [new Int32Array(N3), new Int32Array(N3), new Int32Array(N3)];
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    var id = i * NN + j * N + k;
    fw[0][id] = ((i + 1) % N) * NN + j * N + k;  bw[0][id] = ((i + N - 1) % N) * NN + j * N + k;
    fw[1][id] = i * NN + ((j + 1) % N) * N + k;  bw[1][id] = i * NN + ((j + N - 1) % N) * N + k;
    fw[2][id] = i * NN + j * N + (k + 1) % N;    bw[2][id] = i * NN + j * N + (k + N - 1) % N;
  }
  /* Fourier symbol of the uniform stencil */
  var sym = new Float64Array(N3), s1 = new Float64Array(N);
  for (var n = 0; n < N; n++) { var sn = Math.sin(Math.PI * n / N); s1[n] = 4 * sn * sn; }
  for (var i2 = 0; i2 < N; i2++) for (var j2 = 0; j2 < N; j2++) for (var k2 = 0; k2 < N; k2++) {
    var lam = s1[i2] + s1[j2] + s1[k2], id2 = i2 * NN + j2 * N + k2;
    sym[id2] = lam > 0 ? 1 / (lam * kS) : 0;
  }
  var work = new Float64Array(2 * N3), line = new Float64Array(2 * N);
  function precond(r, z) {
    for (var p = 0; p < N3; p++) { work[2 * p] = r[p]; work[2 * p + 1] = 0; }
    fft3dCpu(work, N, false, line);
    for (var p2 = 0; p2 < N3; p2++) { work[2 * p2] *= sym[p2]; work[2 * p2 + 1] *= sym[p2]; }
    fft3dCpu(work, N, true, line);
    for (var p3 = 0; p3 < N3; p3++) z[p3] = work[2 * p3];
  }
  function applyA(T, out) {
    for (var p = 0; p < N3; p++) {
      var acc = 0;
      for (var a = 0; a < 3; a++) {
        var kf = Kf[a], m = bw[a][p];
        acc -= kf[p] * (T[fw[a][p]] - T[p]) - kf[m] * (T[p] - T[m]);
      }
      out[p] = acc;
    }
  }
  function dot(u, v) { var s = 0; for (var p = 0; p < N3; p++) s += u[p] * v[p]; return s; }
  var K = new Float64Array(9), perLC = [], energyErr = 0, fields = opts.keepFields ? [] : null;
  var T = new Float64Array(N3), r = new Float64Array(N3), z = new Float64Array(N3), pv = new Float64Array(N3), Ap = new Float64Array(N3), b = new Float64Array(N3);
  for (var lc = 0; lc < 3; lc++) {
    /* b = Σ_a (k_a(i) − k_a(i − a)) E_a with E = e_lc */
    var kl = Kf[lc], bl = bw[lc];
    for (var p = 0; p < N3; p++) b[p] = kl[p] - kl[bl[p]];
    T.fill(0); r.set(b);
    var bn = Math.sqrt(dot(b, b)), it = 0, conv = bn === 0, rel = 0;
    if (!conv) {
      precond(r, z); pv.set(z);
      var rz = dot(r, z);
      for (it = 1; it <= maxit; it++) {
        applyA(pv, Ap);
        var pAp = dot(pv, Ap);
        if (!(pAp > 0)) break;
        var al = rz / pAp;
        for (var q = 0; q < N3; q++) { T[q] += al * pv[q]; r[q] -= al * Ap[q]; }
        rel = Math.sqrt(dot(r, r)) / bn;
        if (rel < tol) { conv = true; break; }
        precond(r, z);
        var rzN = dot(r, z), be = rzN / rz; rz = rzN;
        for (var q2 = 0; q2 < N3; q2++) pv[q2] = z[q2] + be * pv[q2];
      }
    }
    /* mean flux per axis, and the energy form */
    var fl = [0, 0, 0], en = 0;
    for (var p4 = 0; p4 < N3; p4++) for (var a3 = 0; a3 < 3; a3++) {
      var g = T[fw[a3][p4]] - T[p4] + (a3 === lc ? 1 : 0), f = Kf[a3][p4] * g;
      fl[a3] += f; en += f * g;
    }
    for (var a4 = 0; a4 < 3; a4++) K[a4 * 3 + lc] = fl[a4] / N3;
    en /= N3;
    energyErr = Math.max(energyErr, Math.abs(en - K[lc * 3 + lc]) / Math.max(Math.abs(K[lc * 3 + lc]), 1e-300));
    perLC.push({ axis: 'xyz'.charAt(lc), iters: it, converged: conv, relRes: rel });
    if (fields) {
      /* |q| at voxel centres: average of the two faces per axis */
      var qm = new Float32Array(N3);
      for (var p5 = 0; p5 < N3; p5++) {
        var sq = 0;
        for (var a5 = 0; a5 < 3; a5++) {
          var m5 = bw[a5][p5], e5 = a5 === lc ? 1 : 0;
          var fA = Kf[a5][p5] * (T[fw[a5][p5]] - T[p5] + e5), fB = Kf[a5][m5] * (T[p5] - T[m5] + e5);
          var fc = 0.5 * (fA + fB); sq += fc * fc;
        }
        qm[p5] = Math.sqrt(sq);
      }
      fields.push({ axis: 'xyz'.charAt(lc), Tt: Float32Array.from(T), qMag: qm });
    }
  }
  var nrm = 0, asym = 0;
  for (var e = 0; e < 9; e++) nrm += K[e] * K[e];
  nrm = Math.sqrt(nrm);
  for (var r1 = 0; r1 < 3; r1++) for (var c1 = r1 + 1; c1 < 3; c1++) asym = Math.max(asym, Math.abs(K[r1 * 3 + c1] - K[c1 * 3 + r1]) / (nrm || 1));
  return { K: K, perLC: perLC, asym: asym, energyErr: energyErr, fields: fields };
}

