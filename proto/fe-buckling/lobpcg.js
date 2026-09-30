/* lobpcg.js — verbatim copy of the Sprint-B LOBPCG (implicit AX/BX/AP/BP updates) + dense helpers
   from speed/fastlib.js (lines 302-477, 606) so febuckle is self-contained.  Needs bk_jacobiSym (16c).
   kit contract: { n, N3 (per-component length for the zero-mean projector), applyAB(xa,xb,Aa,Ab,Ba,Bb), applyT2(ra,rb,za,zb) } */
function fl_dot(a, b, n) { var s = 0; for (var i = 0; i < n; i++) s += a[i] * b[i]; return s; }
function fl_zeroMean(x, N3) { for (var c = 0; c < 3; c++) { var b = c * N3, s = 0; for (var i = 0; i < N3; i++) s += x[b + i]; s /= N3; for (var i2 = 0; i2 < N3; i2++) x[b + i2] -= s; } }

/* chunked Gram: SA[i][j] = V_i·AV_j, SB = V_i·BV_j (symmetric, upper computed) */
function fl_gram(V, AV, BV, n) {
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
  for (var i2 = 0; i2 < s; i2++) for (var j2 = i2 + 1; j2 < s; j2++) {
    /* symmetrize like the original (average with lower which we did not compute: use upper) */
    SA[j2 * s + i2] = SA[i2 * s + j2]; SB[j2 * s + i2] = SB[i2 * s + j2];
  }
  return { SA: SA, SB: SB };
}
/* outs[j] = sum_k Y[k*mo + j] * Vs[k]  (k from kStart), chunked */
function fl_combine(Vs, Y, mo, kStart, outs, n) {
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

/* reduced Rayleigh-Ritz, same algebra as bk_lobpcgGen (Jacobi on SB, near-null drop,
   Jacobi on reduced SA).  Returns { thetas[take], Y (s x take, col-major by take) } */
function fl_rr(SA, SB, s, m, dropTol) {
  var eigB = bk_jacobiSym(SB, s, 200, 1e-15);
  var maxB = 0; for (var d = 0; d < s; d++) if (eigB.values[d] > maxB) maxB = eigB.values[d];
  var keep = []; for (var dk = 0; dk < s; dk++) if (eigB.values[dk] > (dropTol || 1e-9) * maxB) keep.push(dk);
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
  return { thetas: th, Y: Y, take: take, sk: sk };
}

/* ============================================================
   lobpcgFast — LOBPCG for the largest theta of (A,B)=(-K_g,K) with
   IMPLICIT updates: per iteration only T·R, A·W, B·W are applied
   (m preconditioner + m fused A/B applies, packed two per pass);
   AX, BX, AP, BP are carried by the Rayleigh–Ritz coefficients.
   opts: iters, tol, nConv, nStable, resTol (same meaning as bk_lobpcgGen),
         X0 (array of warm-start vectors), refresh (explicit AX/BX every k iters, 0=never),
         normW (B-normalize W and P columns before Gram; default true)
   ============================================================ */
function lobpcgFast(kit, m, opts) {
  opts = opts || {};
  var n = kit.n, N3 = kit.N3, iters = opts.iters || 200, tol = opts.tol != null ? opts.tol : 1e-3;
  var nConv = opts.nConv || 1, nStable = opts.nStable || 2, resTol = opts.resTol || 0, refresh = opts.refresh || 0;
  var normW = opts.normW !== false;
  var rng = opts.rng || fl_mulberry(opts.seed != null ? opts.seed : 12345);
  var pool = [];
  function vec() { return pool.length ? pool.pop() : new Float64Array(n); }
  function rel(list) { for (var i = 0; i < list.length; i++) pool.push(list[i]); }
  var X = [];
  var X0 = opts.X0 || [];
  for (var c = 0; c < m; c++) {
    var v = vec();
    if (c < X0.length) v.set(X0[c]); else for (var i = 0; i < n; i++) v[i] = rng() * 2 - 1;
    fl_zeroMean(v, N3); if (opts.project) opts.project(v); X.push(v);
  }
  function applyABlist(Vs) {
    var AV = [], BV = [];
    for (var j = 0; j < Vs.length; j++) { AV.push(vec()); BV.push(vec()); }
    for (var j2 = 0; j2 < Vs.length; j2 += 2) {
      var hasB = (j2 + 1 < Vs.length);
      kit.applyAB(Vs[j2], hasB ? Vs[j2 + 1] : null, AV[j2], hasB ? AV[j2 + 1] : null, BV[j2], hasB ? BV[j2 + 1] : null);
    }
    return { AV: AV, BV: BV };
  }
  function applyTlist(Rs) {
    var Z = []; for (var j = 0; j < Rs.length; j++) Z.push(vec());
    for (var j2 = 0; j2 < Rs.length; j2 += 2) {
      var hasB = (j2 + 1 < Rs.length);
      (opts.applyT2 || kit.applyT2)(Rs[j2], hasB ? Rs[j2 + 1] : null, Z[j2], hasB ? Z[j2 + 1] : null);
    }
    return Z;
  }
  var t0 = performance.now(), tOps = 0, tT = 0;
  var ta = performance.now();
  var r0 = applyABlist(X); var AX = r0.AV, BX = r0.BV;
  tOps += performance.now() - ta;
  /* initial Rayleigh-Ritz inside span(X) */
  (function () {
    var g = fl_gram(X, AX, BX, n), rr = fl_rr(g.SA, g.SB, m, m);
    var nX = [], nAX = [], nBX = []; for (var j = 0; j < rr.take; j++) { nX.push(vec()); nAX.push(vec()); nBX.push(vec()); }
    fl_combine(X, rr.Y, rr.take, 0, nX, n); fl_combine(AX, rr.Y, rr.take, 0, nAX, n); fl_combine(BX, rr.Y, rr.take, 0, nBX, n);
    rel(X); rel(AX); rel(BX); X = nX; AX = nAX; BX = nBX;
  })();
  var P = [], AP = [], BP = [];
  var prevTheta = null, converged = false, lastIters = 0, stable = 0, resLead = Infinity, nApply = m, hist = [];
  for (var it = 0; it < iters; it++) {
    lastIters = it + 1;
    if (refresh && it > 0 && it % refresh === 0) { ta = performance.now(); var rf = applyABlist(X); rel(AX); rel(BX); AX = rf.AV; BX = rf.BV; nApply += X.length; tOps += performance.now() - ta; }
    var mX = X.length, R = [], thetaX = [];
    for (var cc = 0; cc < mX; cc++) {
      var xbx = fl_dot(X[cc], BX[cc], n), th = fl_dot(X[cc], AX[cc], n) / xbx;
      thetaX.push(th);
      var w = vec(), ax = AX[cc], bx = BX[cc];
      for (var i2 = 0; i2 < n; i2++) w[i2] = ax[i2] - th * bx[i2];
      if (cc === 0) resLead = Math.sqrt(fl_dot(w, w, n)) / Math.max(Math.abs(th) * Math.sqrt(fl_dot(bx, bx, n)), 1e-300);
      R.push(w);
    }
    ta = performance.now();
    var W = applyTlist(R);
    tT += performance.now() - ta;
    for (var wz = 0; wz < W.length; wz++) { fl_zeroMean(W[wz], N3); if (opts.project) opts.project(W[wz]); }
    ta = performance.now();
    var rw = applyABlist(W); nApply += W.length;
    tOps += performance.now() - ta;
    var AW = rw.AV, BW = rw.BV;
    if (normW) {
      for (var q = 0; q < W.length; q++) { var sc = 1 / Math.sqrt(Math.max(fl_dot(W[q], BW[q], n), 1e-300)); scal(W[q], sc); scal(AW[q], sc); scal(BW[q], sc); }
      for (var q2 = 0; q2 < P.length; q2++) { var sc2 = 1 / Math.sqrt(Math.max(fl_dot(P[q2], BP[q2], n), 1e-300)); scal(P[q2], sc2); scal(AP[q2], sc2); scal(BP[q2], sc2); }
    }
    var V = X.concat(W, P), AV = AX.concat(AW, AP), BV = BX.concat(BW, BP), s = V.length;
    var g = fl_gram(V, AV, BV, n);
    var rr = fl_rr(g.SA, g.SB, s, m);
    if (!rr) break;
    var take = rr.take, nXv = [], nAXv = [], nBXv = [], nP = [], nAP = [], nBP = [];
    for (var j = 0; j < take; j++) { nXv.push(vec()); nAXv.push(vec()); nBXv.push(vec()); nP.push(vec()); nAP.push(vec()); nBP.push(vec()); }
    fl_combine(V, rr.Y, take, 0, nXv, n); fl_combine(AV, rr.Y, take, 0, nAXv, n); fl_combine(BV, rr.Y, take, 0, nBXv, n);
    fl_combine(V, rr.Y, take, mX, nP, n); fl_combine(AV, rr.Y, take, mX, nAP, n); fl_combine(BV, rr.Y, take, mX, nBP, n);
    rel(V); rel(AV); rel(BV); rel(R);
    X = nXv; AX = nAXv; BX = nBXv; P = nP; AP = nAP; BP = nBP;
    var top = rr.thetas;
    hist.push({ it: it + 1, theta0: top[0], res: resLead });
    if (prevTheta && prevTheta.length === top.length) {
      var nc = Math.min(nConv, top.length), maxd = 0;
      for (var kk = 0; kk < nc; kk++) { var rdl = Math.abs(top[kk] - prevTheta[kk]) / Math.max(Math.abs(top[kk]), 1e-30); if (rdl > maxd) maxd = rdl; }
      stable = (maxd < tol && (!resTol || resLead < resTol)) ? stable + 1 : 0;
      if (stable >= nStable) { converged = true; break; }
    }
    prevTheta = top;
  }
  /* final explicit Rayleigh quotient of the leading vectors (drift-free answer) */
  ta = performance.now();
  var fin = applyABlist(X); nApply += X.length;
  tOps += performance.now() - ta;
  var out = [];
  for (var cf = 0; cf < X.length; cf++) out.push({ theta: fl_dot(X[cf], fin.AV[cf], n) / fl_dot(X[cf], fin.BV[cf], n), vec: X[cf] });
  out.sort(function (p, q) { return q.theta - p.theta; });
  out._iters = lastIters; out._converged = converged; out._resLead = resLead; out._nApply = nApply;
  out._tTotal = (performance.now() - t0) / 1000; out._tOps = tOps / 1000; out._tT = tT / 1000; out._hist = hist;
  return out;
}
function scal(v, s) { for (var i = 0; i < v.length; i++) v[i] *= s; }
function fl_mulberry(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
