/* ============================================================
   F13LD.lab · 19h-flow-wss.js   (v0.30.0 — fluids Phase 2)
   Wall shear stress from the lattice Boltzmann flow (docs/FLUIDS_LBM_SCOPE.md
   §3.6, §15).

   Pipeline, per open flow axis j (19g calls flowWallTractions after each
   axis converges):
   1. Stress at every fluid node, from the GPU (19g readStress): the viscous
      stress σ' = −(1 − 1/2τ⁺)[Σ f^neq c c + ½(F u + u F)] (Krüger, Varnik &
      Raabe 2009) and ρ − 1 (pressure p = (ρ − 1)/3).  7 values per cell.
   2. Probe points on the wall (14e marginWallProbes): one per surface
      voxel, at the area-weighted centre of its marching-tetrahedra
      triangles, normal into the fluid, carrying the voxel's wall area.
   3. Probe and extrapolate: stress sampled at 1.25 and 2.25 voxels along
      the normal (trilinear over fluid cells only) and extrapolated linearly
      to the wall.  Where a stencil is mostly solid (narrow gaps, inside
      corners) the pair 0.75 / 1.5 is tried, then the single value at 1.0.
      A probe whose stencils find no fluid (walls of sealed pores) drops.
   4. Wall shear vector τ_w = t − (t·n) n, t = σ'·n, stored per probe as
      τ / g (the shear for unit body force, in voxels), so any flow speed,
      direction and viscosity is a rescale (§3.6 step 5):
          τ_w(U along d) = (μ U / Δx) Σ_j (K⁻¹ d)_j τ̂_j       (K in voxels²)
   5. Force balance: Σ a (σ'·n − p n) over the probes must equal the
      driving force g × open pore volume along j (the volume under the same
      wall, 14e solidVol, not the node count).  The residual is reported.

   Statistics (flowShearStats) are area-weighted over the probes, at a
   superficial speed of 1 m/s (shear is proportional to speed in creeping
   flow): median and 95th percentile; with a shear target [lo, hi], the
   speed that puts the most wall area inside it (exact: the widest window
   over the sorted shear values), the share of wall in / under / over at
   that speed, and the usable range of speeds keeping at least half of it.

   API
     flowWallTractions(probes, F7, fluid, N, g, axis, vFluid) → { tau (Float32 3n), ok (Uint8 n), force, target, residual, nPair, nNear, nSingle, nDrop }
     flowShearStats(fr, axis, cfg)  cfg: { mu (Pa·s), rho, cellMm, target: [lo, hi] Pa | null, chamberMm }
     flowShearPick(fr, cfg)          the axis the cards report (Flow direction setting)
     flowShearConfig(d)              the cfg for a design from FLOW_STATE (+ material)
     flowProbeShears(fr, axis, cfg)  (v0.31.0) shear per probe, Pa per m/s
     flowShareIn(stats, a, b)        (v0.31.0) wall share with shear per m/s in [a, b]
     flowShearVoxelField(fr, axis, cfg) (v0.31.0) log10 shear per m/s on a voxel grid for the surface map
     flowOrientMap(fr, cfg, U, dirs) (v0.31.0) wall share in the target for every flow direction at speed U
   ============================================================ */

var FLOW_WSS_VERSION = 'wss-1';   /* the stored result format (19g); v0.31.0 adds views only */
var FLOW_PROBE_PAIRS = [[1.25, 2.25], [0.75, 1.5]];
var FLOW_PROBE_SINGLE = 1.0;
var FLOW_PROBE_MINW = 0.25;      /* least fluid share of a trilinear stencil */
var FLOW_FORCE_WARN = 0.05;      /* force balance off by more than this → the card warns */

/* ── shear targets, fluids (FLUIDS_LBM_SCOPE.md §3.7) ── */
var FLOW_SHEAR_TARGETS = [
  { id: 'none',     name: 'No target',            sub: 'Shear is reported per unit flow speed only' },
  { id: 'material', name: 'From the material',    sub: 'Titanium, Co-Cr, steel, Ta / Nb, NiTi 10–30 mPa · polymers and others 0.1–10 mPa' },
  { id: 'general',  name: 'General scaffold',     sub: '0.1–10 mPa · Pires et al. 2022, citing Zhao et al. 2015 and Ali et al. 2019', lo: 0.1, hi: 10 },
  { id: 'ti',       name: 'Titanium fibre mesh',  sub: '10–30 mPa · compiled in Zhao et al. 2018', lo: 10, hi: 30 },
  { id: 'ceramic',  name: 'Ceramic (β-TCP)',      sub: '5–15 mPa · Zhao et al. 2018', lo: 5, hi: 15 },
  { id: 'silk',     name: 'Silk fibroin',         sub: '1.47–24 mPa · Zhao et al. 2018', lo: 1.47, hi: 24 },
  { id: 'custom',   name: 'Custom',               sub: 'Your own range' }
];
var FLOW_METAL_IMPLANT = { 'Titanium': 1, 'Cobalt-chrome': 1, 'Stainless steel': 1, 'Refractory': 1, 'Shape memory': 1 };
var FLOW_FLUIDS = {
  water:  { name: 'Water, 37 °C',               mu: 0.69e-3, rho: 993 },
  medium: { name: 'Culture medium, 10 % serum', mu: 0.93e-3, rho: 1007 },   /* Poon 2020 */
  custom: { name: 'Custom',                     mu: null,    rho: 1000 }
};
function flowShearTargetDef(id) {
  for (var i = 0; i < FLOW_SHEAR_TARGETS.length; i++) if (FLOW_SHEAR_TARGETS[i].id === id) return FLOW_SHEAR_TARGETS[i];
  return FLOW_SHEAR_TARGETS[0];
}

/* ── sampling ── */
/* Trilinear sample of a C-component cell field (solver order, cell (i, j, k)
   centred at (i + ½, j + ½, k + ½), periodic) over fluid cells only.
   Writes the renormalized value into out and returns the fluid weight. */
function flowSampleCells(F, C, fluid, N, px, py, pz, out) {
  var NN = N * N, fx = px - 0.5, fy = py - 0.5, fz = pz - 0.5;
  var i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz), tx = fx - i0, ty = fy - j0, tz = fz - k0, ws = 0;
  for (var m = 0; m < C; m++) out[m] = 0;
  for (var c = 0; c < 8; c++) {
    var di = c & 1, dj = (c >> 1) & 1, dk = c >> 2;
    var wt = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
    if (wt <= 0) continue;
    var i = ((i0 + di) % N + N) % N, j = ((j0 + dj) % N + N) % N, k = ((k0 + dk) % N + N) % N, p = i * NN + j * N + k;
    if (!fluid[p]) continue;
    var b = C * p;
    for (var m2 = 0; m2 < C; m2++) out[m2] += wt * F[b + m2];
    ws += wt;
  }
  if (ws > 0) for (var m3 = 0; m3 < C; m3++) out[m3] /= ws;
  return ws;
}

/* Wall shear per probe for one solved axis.  F7: 7 values per cell
   (σxx, σyy, σzz, σxy, σxz, σyz, ρ − 1), lattice units, at body force g
   along axis.  fluid: Uint8 N³, 1 = in the flow domain. */
function flowWallTractions(probes, F7, fluid, N, g, axis, vFluid) {
  var n = probes.n, P = probes.pos, Nr = probes.nrm, A = probes.area;
  var tau = new Float32Array(3 * n), ok = new Uint8Array(n), s1 = new Float64Array(7), s2 = new Float64Array(7), s = new Float64Array(7);
  var fx = 0, fy = 0, fz = 0, nPair = 0, nNear = 0, nSingle = 0, nDrop = 0, aDrop = 0, aAll = 0;
  for (var p = 0; p < n; p++) {
    var wx = P[3 * p], wy = P[3 * p + 1], wz = P[3 * p + 2], nx = Nr[3 * p], ny = Nr[3 * p + 1], nz = Nr[3 * p + 2], a = A[p], got = 0;
    aAll += a;
    for (var q = 0; q < FLOW_PROBE_PAIRS.length && !got; q++) {
      var d1 = FLOW_PROBE_PAIRS[q][0], d2 = FLOW_PROBE_PAIRS[q][1];
      if (flowSampleCells(F7, 7, fluid, N, wx + d1 * nx, wy + d1 * ny, wz + d1 * nz, s1) < FLOW_PROBE_MINW) continue;
      if (flowSampleCells(F7, 7, fluid, N, wx + d2 * nx, wy + d2 * ny, wz + d2 * nz, s2) < FLOW_PROBE_MINW) continue;
      var r = d1 / (d2 - d1);
      for (var m = 0; m < 7; m++) s[m] = s1[m] + r * (s1[m] - s2[m]);
      got = 1; if (q === 0) nPair++; else nNear++;
    }
    if (!got && flowSampleCells(F7, 7, fluid, N, wx + FLOW_PROBE_SINGLE * nx, wy + FLOW_PROBE_SINGLE * ny, wz + FLOW_PROBE_SINGLE * nz, s) >= FLOW_PROBE_MINW) { got = 1; nSingle++; }
    if (!got) { nDrop++; aDrop += a; continue; }
    ok[p] = 1;
    var tx = s[0] * nx + s[3] * ny + s[4] * nz, ty = s[3] * nx + s[1] * ny + s[5] * nz, tz = s[4] * nx + s[5] * ny + s[2] * nz;
    var tn = tx * nx + ty * ny + tz * nz, pr = s[6] / 3;
    tau[3 * p] = (tx - tn * nx) / g; tau[3 * p + 1] = (ty - tn * ny) / g; tau[3 * p + 2] = (tz - tn * nz) / g;
    fx += a * (tx - pr * nx); fy += a * (ty - pr * ny); fz += a * (tz - pr * nz);
  }
  /* vFluid: the open pore volume in voxels (19g: N³ − solidVol − sealed cells); default the fluid cell count */
  var nF = 0, N3 = N * N * N;
  if (vFluid > 0) nF = vFluid; else for (var c = 0; c < N3; c++) if (fluid[c]) nF++;
  var target = g * nF, along = axis === 0 ? fx : axis === 1 ? fy : fz;
  return { tau: tau, ok: ok, force: [fx, fy, fz], target: target, residual: target > 0 ? along / target - 1 : NaN,
           nPair: nPair, nNear: nNear, nSingle: nSingle, nDrop: nDrop, dropArea: aAll > 0 ? aDrop / aAll : 0 };
}

/* ── statistics ── */
/* K⁻¹ restricted to the solved (open) axes, voxels⁻² (Ksym in voxels²). */
function flowKinvOpen(fr) {
  var open = [], K = fr.Ksym;
  for (var a = 0; a < 3; a++) if (fr.perAxis[a] && fr.perAxis[a].open && K[4 * a] > 0) open.push(a);
  var n = open.length, M = [], I = [];
  for (var r = 0; r < n; r++) { M.push([]); I.push([]); for (var c = 0; c < n; c++) { M[r].push(K[open[r] * 3 + open[c]]); I[r].push(r === c ? 1 : 0); } }
  for (var p = 0; p < n; p++) {
    var piv = p;
    for (var r2 = p + 1; r2 < n; r2++) if (Math.abs(M[r2][p]) > Math.abs(M[piv][p])) piv = r2;
    var t = M[p]; M[p] = M[piv]; M[piv] = t; t = I[p]; I[p] = I[piv]; I[piv] = t;
    var d = M[p][p]; if (!(Math.abs(d) > 0)) return null;
    for (var c2 = 0; c2 < n; c2++) { M[p][c2] /= d; I[p][c2] /= d; }
    for (var r3 = 0; r3 < n; r3++) if (r3 !== p) {
      var f = M[r3][p];
      if (f) for (var c3 = 0; c3 < n; c3++) { M[r3][c3] -= f * M[p][c3]; I[r3][c3] -= f * I[p][c3]; }
    }
  }
  var out = new Float64Array(9);
  for (var r4 = 0; r4 < n; r4++) for (var c4 = 0; c4 < n; c4++) out[open[r4] * 3 + open[c4]] = I[r4][c4];
  return { Kinv: out, open: open };
}

var _FLOW_STATS_CACHE = {};
/* Area-weighted wall shear for a mean flow along axis (0, 1, 2) at 1 m/s
   superficial speed.  Returns null when the axis has no wall shear data. */
function flowShearStats(fr, axis, cfg) {
  var W = fr && fr.wss;
  if (!W || !W.axes || !W.axes[axis] || !(cfg.mu > 0) || !(cfg.cellMm > 0)) return null;
  var tg = cfg.target;
  var key = (fr.wssKey || '') + '|' + axis + '|' + cfg.mu + '|' + cfg.rho + '|' + cfg.cellMm + '|' + (tg ? tg[0] + ',' + tg[1] : '-') + '|' + cfg.chamberMm;
  if (_FLOW_STATS_CACHE[key]) return _FLOW_STATS_CACHE[key];
  var ps = flowProbeShears(fr, axis, cfg);
  if (!ps) return null;
  var dx = ps.dx, n = W.n, area = W.area;
  var sv = [], av = [], total = 0;
  for (var p = 0; p < n; p++) {
    if (!(ps.s[p] >= 0)) continue;
    sv.push(ps.s[p]); av.push(area[p]); total += area[p];
  }
  if (!sv.length || !(total > 0)) return null;
  var order = sv.map(function (_, i) { return i; }).sort(function (a, b) { return sv[a] - sv[b]; });
  var S = new Float64Array(sv.length), C = new Float64Array(sv.length + 1);
  for (var q = 0; q < order.length; q++) { S[q] = sv[order[q]]; C[q + 1] = C[q] + av[order[q]] / total; }
  function quant(f) { for (var q2 = 0; q2 < S.length; q2++) if (C[q2 + 1] >= f) return S[q2]; return S[S.length - 1]; }
  /* share of area with shear (per m/s) in [a, b] — binary search on S */
  function idxGE(v) { var lo = 0, hi = S.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (S[mid] < v) lo = mid + 1; else hi = mid; } return lo; }
  function idxGT(v) { var lo = 0, hi = S.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (S[mid] <= v) lo = mid + 1; else hi = mid; } return lo; }
  function share(a, b) { return C[idxGT(b)] - C[idxGE(a)]; }
  var res = { axis: axis, nProbes: S.length, median: quant(0.5), p95: quant(0.95), mean: 0, residual: W.axes[axis].residual,
              S: S, C: C };   /* v0.31.0 — sorted shears (per m/s) and cumulative wall share, for the charts */
  for (var q3 = 0; q3 < order.length; q3++) res.mean += S[q3] * (av[order[q3]] / total);
  if (tg && tg[1] > tg[0] && tg[0] > 0) {
    var lo = tg[0], hi = tg[1], ratio = hi / lo, best = -1, bi = 0, bj = 0, wins = [];
    /* widest window [s_i, s_i·hi/lo] over the sorted shears: at speed U the
       wall in target is the shear set inside [lo/U, hi/U] */
    for (var i = 0, jj = 0; i < S.length; i++) {
      if (!(S[i] > 0)) continue;
      if (jj < i) jj = i;
      while (jj + 1 < S.length && S[jj + 1] <= S[i] * ratio) jj++;
      var w = C[jj + 1] - C[i];
      wins.push([i, jj, w]);
      if (w > best) best = w;
    }
    /* a broad shear spread gives a plateau of near-equal windows: take the
       middle of the run (within 1 % of wall) holding the best one, so the
       speed sits centred rather than at the plateau's edge */
    if (best > 0) {
      var tol = 0.01, top = -1;
      for (var wi = 0; wi < wins.length; wi++) if (wins[wi][2] === best) { top = wi; break; }
      var w0 = top, w1 = top;
      while (w0 > 0 && wins[w0 - 1][2] >= best - tol) w0--;
      while (w1 + 1 < wins.length && wins[w1 + 1][2] >= best - tol) w1++;
      var mid = wins[(w0 + w1) >> 1];
      bi = mid[0]; bj = mid[1];
    }
    if (best > 0) {
      /* any U in [lo/S_i, hi/S_j] holds the window; take its geometric middle */
      var U = Math.sqrt((lo / S[bi]) * (hi / S[bj]));
      res.bestU = U; res.inTarget = share(lo / U, hi / U);
      res.under = C[idxGE(lo / U)]; res.over = 1 - C[idxGT(hi / U)];
      /* usable range: speeds around U keeping at least half the best share */
      var half = 0.5 * res.inTarget, f = Math.pow(10, 1 / 120);
      var F = function (u) { return share(lo / u, hi / u); };
      var edge = function (a, b) { for (var it = 0; it < 30; it++) { var m = Math.sqrt(a * b); if (F(m) >= half) a = m; else b = m; } return a; };
      var uL = U, uH = U, guard = 0;
      while (F(uL / f) >= half && guard++ < 1500) uL /= f;
      res.rangeLo = edge(uL, uL / f);
      guard = 0;
      while (F(uH * f) >= half && guard++ < 1500) uH *= f;
      res.rangeHi = edge(uH, uH * f);
      if (cfg.chamberMm > 0) res.mlMin = U * Math.PI * Math.pow(cfg.chamberMm / 2000, 2) * 6e7;
      if (fr.medPoreVox > 0 && cfg.rho > 0) { res.poreM = fr.medPoreVox * dx; res.Re = cfg.rho * U * res.poreM / cfg.mu; }
    } else res.inTarget = 0;
  }
  _FLOW_STATS_CACHE[key] = res;
  return res;
}

/* v0.31.0 — wall shear per probe (Pa per m/s of superficial speed) for a
   mean flow along axis; NaN where a probe has no value.  Cached. */
var _FLOW_PROBE_CACHE = {};
function flowProbeShears(fr, axis, cfg) {
  var W = fr && fr.wss;
  if (!W || !W.axes || !(cfg.mu > 0) || !(cfg.cellMm > 0)) return null;
  var key = (fr.wssKey || '') + '|' + axis + '|' + cfg.mu + '|' + cfg.cellMm;
  if (_FLOW_PROBE_CACHE[key]) return _FLOW_PROBE_CACHE[key];
  var ki = flowKinvOpen(fr);
  if (!ki || ki.open.indexOf(axis) < 0) return null;
  var coef = [ki.Kinv[0 * 3 + axis], ki.Kinv[1 * 3 + axis], ki.Kinv[2 * 3 + axis]];
  var dx = cfg.cellMm / 1000 / fr.N, scale = cfg.mu / dx, n = W.n, out = new Float64Array(n);
  for (var p = 0; p < n; p++) {
    var good = 1, vx = 0, vy = 0, vz = 0;
    for (var j = 0; j < 3; j++) {
      if (!coef[j]) continue;
      var Aj = W.axes[j];
      if (!Aj || !Aj.ok[p]) { good = 0; break; }
      vx += coef[j] * Aj.tau[3 * p]; vy += coef[j] * Aj.tau[3 * p + 1]; vz += coef[j] * Aj.tau[3 * p + 2];
    }
    out[p] = good ? scale * Math.sqrt(vx * vx + vy * vy + vz * vz) : NaN;
  }
  var r = { s: out, dx: dx };
  _FLOW_PROBE_CACHE[key] = r;
  return r;
}
/* Share of wall with shear (per m/s) in [a, b], from a stats result. */
function flowShareIn(st, a, b) {
  var S = st.S, C = st.C;
  function idx(v, strict) { var lo = 0, hi = S.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (strict ? S[mid] <= v : S[mid] < v) lo = mid + 1; else hi = mid; } return lo; }
  return C[idx(b, true)] - C[idx(a, false)];
}

/* v0.31.0 — wall shear on a voxel grid for the surface map (21 view mode 4).
   Each probe's shear goes into its voxel (area-weighted mean of log10 of the
   shear per m/s), then two dilation passes spread values into neighbouring
   empty voxels so the linearly sampled texture reads only real values at the
   surface.  M = min(N, 64) (128³ probes binned 2×).  Empty voxels hold
   FLOW_SHEAR_EMPTY.  Solver order (i·M² + j·M + k).  Cached. */
var FLOW_SHEAR_EMPTY = -30;
var _FLOW_SHEAR_VOX = {};
function flowShearVoxelField(fr, axis, cfg) {
  var ps = flowProbeShears(fr, axis, cfg);
  if (!ps) return null;
  var key = (fr.wssKey || '') + '|' + axis + '|' + cfg.mu + '|' + cfg.cellMm;
  if (_FLOW_SHEAR_VOX[key]) return _FLOW_SHEAR_VOX[key];
  var N = fr.N, M = Math.min(N, 64), f = N / M, M3 = M * M * M, MM = M * M, W = fr.wss;
  var sum = new Float64Array(M3), wsum = new Float64Array(M3), lo = Infinity, hi = -Infinity;
  for (var p = 0; p < W.n; p++) {
    var v = ps.s[p];
    if (!(v > 0)) continue;
    var i = ((Math.floor(W.pos[3 * p] / f) % M) + M) % M, j = ((Math.floor(W.pos[3 * p + 1] / f) % M) + M) % M, k = ((Math.floor(W.pos[3 * p + 2] / f) % M) + M) % M;
    var c = i * MM + j * M + k, a = W.area[p], lv = Math.log(v) / Math.LN10;
    sum[c] += a * lv; wsum[c] += a;
  }
  var out = new Float32Array(M3);
  for (var c0 = 0; c0 < M3; c0++) {
    if (wsum[c0] > 0) { var lv0 = sum[c0] / wsum[c0]; out[c0] = lv0; if (lv0 < lo) lo = lv0; if (lv0 > hi) hi = lv0; }
    else out[c0] = FLOW_SHEAR_EMPTY;
  }
  for (var pass = 0; pass < 2; pass++) {
    var nxt = Float32Array.from(out);
    for (var I = 0; I < M; I++) for (var J = 0; J < M; J++) for (var K = 0; K < M; K++) {
      var cc = I * MM + J * M + K;
      if (out[cc] > FLOW_SHEAR_EMPTY + 1) continue;
      var t = 0, nn = 0;
      for (var a2 = -1; a2 <= 1; a2++) for (var b2 = -1; b2 <= 1; b2++) for (var e2 = -1; e2 <= 1; e2++) {
        if (!a2 && !b2 && !e2) continue;
        var q = out[((I + a2 + M) % M) * MM + ((J + b2 + M) % M) * M + ((K + e2 + M) % M)];
        if (q > FLOW_SHEAR_EMPTY + 1) { t += q; nn++; }
      }
      if (nn) nxt[cc] = t / nn;
    }
    out = nxt;
  }
  var r = { M: M, v: out, lo: lo, hi: hi };
  _FLOW_SHEAR_VOX[key] = r;
  return r;
}

/* v0.31.0 — orientation map: share of wall inside the target for a mean
   flow along every direction d at superficial speed U (the card's speed).
   The shear vector of probe p is Σ_j (K⁻¹d)_j τ̂_jp, so |τ|² = dᵀ Q_p d with
   Q_p = (T_p K⁻¹)ᵀ(T_p K⁻¹) — six numbers per probe, built once.  Needs all
   three axes open.  dirs: Float32 3·n unit vectors.  → { val (Float32 n), best, axes [x, y, z] } */
var _FLOW_ORIENT = {};
function flowOrientMap(fr, cfg, U, dirs) {
  var W = fr && fr.wss;
  if (!W || !cfg.target || !(U > 0) || !(cfg.mu > 0) || !(cfg.cellMm > 0)) return null;
  for (var a0 = 0; a0 < 3; a0++) if (!(fr.perAxis[a0] && fr.perAxis[a0].open && W.axes[a0])) return null;
  var key = (fr.wssKey || '') + '|' + cfg.mu + '|' + cfg.cellMm + '|' + cfg.target[0] + ',' + cfg.target[1] + '|' + U + '|' + dirs.length;
  if (_FLOW_ORIENT[key]) return _FLOW_ORIENT[key];
  var ki = flowKinvOpen(fr);
  if (!ki || ki.open.length < 3) return null;
  var Ki = ki.Kinv, dx = cfg.cellMm / 1000 / fr.N, sc = cfg.mu / dx * U, n = W.n;
  var lo2 = Math.pow(cfg.target[0] / sc, 2), hi2 = Math.pow(cfg.target[1] / sc, 2);
  /* Q per probe (only probes with all three axes) */
  var Q = new Float64Array(6 * n), A = new Float64Array(n), tot = 0, B = new Float64Array(9);
  for (var p = 0; p < n; p++) {
    if (!W.axes[0].ok[p] || !W.axes[1].ok[p] || !W.axes[2].ok[p]) continue;
    /* B = T_p K⁻¹ (T_p columns: τ̂_x, τ̂_y, τ̂_z) */
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) {
      var v = 0;
      for (var j = 0; j < 3; j++) v += W.axes[j].tau[3 * p + r] * Ki[j * 3 + c];
      B[r * 3 + c] = v;
    }
    var o = 6 * p;
    Q[o] = B[0] * B[0] + B[3] * B[3] + B[6] * B[6];
    Q[o + 1] = B[1] * B[1] + B[4] * B[4] + B[7] * B[7];
    Q[o + 2] = B[2] * B[2] + B[5] * B[5] + B[8] * B[8];
    Q[o + 3] = 2 * (B[0] * B[1] + B[3] * B[4] + B[6] * B[7]);
    Q[o + 4] = 2 * (B[0] * B[2] + B[3] * B[5] + B[6] * B[8]);
    Q[o + 5] = 2 * (B[1] * B[2] + B[4] * B[5] + B[7] * B[8]);
    A[p] = W.area[p]; tot += A[p];
  }
  if (!(tot > 0)) return null;
  function cover(dx0, dy0, dz0) {
    var xx = dx0 * dx0, yy = dy0 * dy0, zz = dz0 * dz0, xy = dx0 * dy0, xz = dx0 * dz0, yz = dy0 * dz0, in0 = 0;
    for (var p2 = 0; p2 < n; p2++) {
      var a = A[p2]; if (!a) continue;
      var o2 = 6 * p2, s2 = Q[o2] * xx + Q[o2 + 1] * yy + Q[o2 + 2] * zz + Q[o2 + 3] * xy + Q[o2 + 4] * xz + Q[o2 + 5] * yz;
      if (s2 >= lo2 && s2 <= hi2) in0 += a;
    }
    return in0 / tot;
  }
  var nd = dirs.length / 3, val = new Float32Array(nd), best = { v: -1, d: null };
  for (var di = 0; di < nd; di++) {
    var x = dirs[3 * di], y = dirs[3 * di + 1], z = dirs[3 * di + 2];
    val[di] = cover(x, y, z);
    if (val[di] > best.v) best = { v: val[di], d: [x, y, z] };
  }
  var out = { val: val, best: best, axes: [cover(1, 0, 0), cover(0, 1, 0), cover(0, 0, 1)], U: U };
  _FLOW_ORIENT[key] = out;
  return out;
}

/* The axis the cards report: the Flow direction setting, or under "All"
   the axis with the most wall in the target (no target: the most
   permeable).  null when no open axis has wall shear data. */
function flowShearPick(fr, cfg) {
  if (!fr || !fr.wss || !fr.perAxis) return null;
  var want = { xx: 0, yy: 1, zz: 2 }[cfg.dir];
  var cand = [];
  for (var a = 0; a < 3; a++) if (fr.perAxis[a] && fr.perAxis[a].open && fr.wss.axes[a]) cand.push(a);
  if (!cand.length) return null;
  if (want != null) {
    if (cand.indexOf(want) < 0) return { axis: want, stats: null, closed: !(fr.perAxis[want] && fr.perAxis[want].open) };
    return { axis: want, stats: flowShearStats(fr, want, cfg) };
  }
  var best = null;
  cand.forEach(function (ax) {
    var st = flowShearStats(fr, ax, cfg);
    if (!st) return;
    var score = cfg.target ? (st.inTarget || 0) : 0, k = fr.Ksym[4 * ax];
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && k > best.k)) best = { axis: ax, stats: st, score: score, k: k };
  });
  return best ? { axis: best.axis, stats: best.stats, best: true } : null;
}

/* Settings → cfg for one design (FLOW_STATE in 50-controls). */
function flowMaterialFamily(d) {
  var id = (typeof MATERIAL_STATE !== 'undefined') ? MATERIAL_STATE.id : null, m = null;
  if (id && typeof findMaterial === 'function') m = findMaterial(id);
  if (!m && d && typeof recipeForDesign === 'function') {
    try { var rc = recipeForDesign(d); if (rc && rc.material && rc.material.id && typeof findMaterial === 'function') m = findMaterial(rc.material.id); } catch (e) {}
  }
  return m ? m.family : 'Titanium';   /* the lab's default material is Ti-6Al-4V */
}
function flowShearTarget(d) {
  var S = (typeof FLOW_STATE !== 'undefined') ? FLOW_STATE : {}, id = S.target || 'none';
  if (id === 'none') return null;
  if (id === 'custom') {
    var lo = +S.tLo, hi = +S.tHi;
    return (lo > 0 && hi > lo) ? { lo: lo, hi: hi, label: lo + '–' + hi + ' mPa', note: 'custom target', custom: true } : null;
  }
  if (id === 'material') {
    var fam = flowMaterialFamily(d), ti = !!FLOW_METAL_IMPLANT[fam], def = flowShearTargetDef(ti ? 'ti' : 'general');
    var note = (ti ? fam.toLowerCase() + ' default' : (fam === 'Polymer' ? 'polymer default' : 'general window · not an implant material'));
    return { lo: def.lo, hi: def.hi, label: def.lo + '–' + def.hi + ' mPa', note: note };
  }
  var t = flowShearTargetDef(id);
  return t.lo ? { lo: t.lo, hi: t.hi, label: t.lo + '–' + t.hi + ' mPa', note: t.name.toLowerCase() } : null;
}
function flowFluid() {
  var S = (typeof FLOW_STATE !== 'undefined') ? FLOW_STATE : {}, f = FLOW_FLUIDS[S.fluid] || FLOW_FLUIDS.water;
  var mu = S.fluid === 'custom' ? (+S.muCustom > 0 ? +S.muCustom / 1000 : null) : f.mu;
  return { mu: mu, rho: f.rho, name: f.name };
}
function flowShearConfig(d) {
  var S = (typeof FLOW_STATE !== 'undefined') ? FLOW_STATE : {}, fl = flowFluid(), t = flowShearTarget(d);
  return { dir: S.dir || 'all', mu: fl.mu, rho: fl.rho, cellMm: (typeof labCellMm === 'function') ? labCellMm(d) : null,
           target: t ? [t.lo / 1000, t.hi / 1000] : null, targetInfo: t, chamberMm: S.chamberMm > 0 ? +S.chamberMm : 10,
           unit: S.speedUnit === 'm' ? 'm' : 'mm' };
}

/* ── formatting ── */
function fmt3(v) {
  if (!isFinite(v)) return '—';
  var a = Math.abs(v);
  if (a >= 100) return Math.round(v).toLocaleString('en-US');
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (a >= 1e-6) return String(+v.toPrecision(3));
  return v.toExponential(1);
}
/* speed in m/s → the chosen unit */
function fmtFlowSpeed(mps, unit) { return unit === 'm' ? fmt3(mps) + ' m/s' : fmt3(mps * 1000) + ' mm/s'; }
function fmtFlowSpeedPair(a, b, unit) { return unit === 'm' ? fmt3(a) + '–' + fmt3(b) + ' m/s' : fmt3(a * 1000) + '–' + fmt3(b * 1000) + ' mm/s'; }
/* shear per unit speed: Pa per m/s equals mPa per mm/s */
function fmtShear(v) { return v >= 10 ? Math.round(v).toLocaleString('en-US') : String(+v.toPrecision(2)); }
function flowShearUnit(unit) { return unit === 'm' ? 'Pa' : 'mPa'; }
function flowSpeedUnit(unit) { return unit === 'm' ? 'm/s' : 'mm/s'; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { flowSampleCells: flowSampleCells, flowWallTractions: flowWallTractions, flowKinvOpen: flowKinvOpen,
    flowShearStats: flowShearStats, flowShearPick: flowShearPick, FLOW_SHEAR_TARGETS: FLOW_SHEAR_TARGETS };
}
