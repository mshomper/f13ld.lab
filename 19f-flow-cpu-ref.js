/* ============================================================
   F13LD.lab · 19f-flow-cpu-ref.js   (v0.27.1 — fluids Phase 0)
   Float64 lattice Boltzmann reference for steady creeping flow through a
   periodic unit cell (docs/FLUIDS_LBM_SCOPE.md §3).  The GPU solver (19g,
   Phase 1) must match it to single-precision rounding.

   Method
   · D3Q19, two-relaxation-time collision (TRT).  τ⁺ sets the viscosity
     ν = (τ⁺ − ½)/3; τ⁻ follows from the magic parameter
         Λ = (τ⁺ − ½)(τ⁻ − ½) = 3/16
     which makes the steady answer independent of τ⁺ and puts halfway
     bounce-back walls exactly halfway for Poiseuille flow (Ginzburg,
     d'Humières & Kuzmin 2008).  collision: 'bgk' (τ⁻ = τ⁺) is kept only to
     show the viscosity dependence it suffers from (check F3).
   · Uniform body force on the fluid, Guo, Zheng & Shi (2002), split into
     even and odd parts for TRT; velocity u = (Σ f c + F/2) / ρ.
   · Shifted populations: f̃ = f − w is stored, so the small
     non-equilibrium part that carries the stress keeps its digits in FP32
     on the GPU.  Here in Float64 it only keeps the two codes identical.
   · Walls from 14e buildFlowLinks: linear interpolated bounce-back
     (Bouzidi, Firdaouss & Lallemand 2001) using the true sub-voxel wall
     fraction q of each link, with halfway bounce-back as a fallback where
     the node behind is solid or walled off (thin throats) and as a switch
     (wall: 'halfway') for comparison.
   · Interpolated walls leak a little mass every step (a steady source at
     the walls under flow).  The total is summed as each step reads the
     nodes and the excess taken off the rest populations in the next read,
     every step — correcting every few hundred steps leaves a sawtooth in ρ
     that shows up in the mean velocity at the 1e-7 level.
   · Pull streaming fused with collision: the buffer holds post-collision
     populations, every node gathers from its neighbours and collides.

   Lattice indexing: direction 0 at rest, then for each of the 9 positive
   directions d of FLOW_DIRS (14e) index 1 + 2d = +c_d and 2 + 2d = −c_d.
   Node index i·N² + j·N + k (x on i), as every lab solver; a box of
   NX × NY × NZ voxels (links.dims, from 14e opts.dims) indexes
   i·NY·NZ + j·NZ + k — used by the checks for 2-D and thin geometries.

   API
     flowLattice()                                  → { c, w, opp }
     prepareFlowDomain(links, opts)                 → domain (fluid node list + wall rules)
       opts: { wall: 'bouzidi' | 'halfway', mask: Uint8 N³ (1 = take part; sealed voids 0) }
     solveFlowCPU(domain, opts)
       opts: { force: [gx, gy, gz] (lattice units), tauPlus (1.0), lambda (3/16),
               collision: 'trt' | 'bgk', tol (1e-7), checkEvery (500), maxSteps, minSteps, fields: true → u and stress per node }
       → { U: superficial mean velocity [3], Ui: interstitial mean [3], steps,
           converged, nu, porosity, massDrift, uMax, history, u?, sigma? }
     flowPermeabilityCPU(links, opts)  three solves (x, y, z) → K (3×3, cells²),
           Ksym, asym, porosity, runs
     sampleStressAt(domain, sol, px, py, pz)  trilinear stress at a point
           (lattice units, node centres at integer + ½) over fluid nodes only
     wallShearAt(domain, sol, wx, wy, wz, nx, ny, nz)  probe 1.25 and 2.25
           voxels along the unit normal n (into the fluid), extrapolate to
           the wall, return { tau: [3] (wall shear vector), t: traction }
   ============================================================ */

var FLOW_W_REST = 1 / 3, FLOW_W_AXIS = 1 / 18, FLOW_W_DIAG = 1 / 36;

function flowLattice() {
  var dirs = (typeof FLOW_DIRS !== 'undefined') ? FLOW_DIRS :
    [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1]];
  var c = [[0, 0, 0]], w = [FLOW_W_REST], opp = [0];
  for (var d = 0; d < dirs.length; d++) {
    var v = dirs[d], wd = d < 3 ? FLOW_W_AXIS : FLOW_W_DIAG;
    c.push([v[0], v[1], v[2]]); w.push(wd); opp.push(2 + 2 * d);
    c.push([-v[0], -v[1], -v[2]]); w.push(wd); opp.push(1 + 2 * d);
  }
  return { c: c, w: w, opp: opp, dirs: dirs };
}

/* Wall rules per (direction, node).  For fluid node x and incoming
   direction i (population travelling along c_i, normally pulled from
   x − c_i), the link x → x − c_i = x + c_j (j = opposite of i) is checked:
     open                 kind 0, src = node at x − c_i
     wall at q < ½        kind 1, behind = node at x + c_i  (Bouzidi)
     wall at q ≥ ½        kind 2                              (Bouzidi)
     no node behind       kind 3 (halfway)                                  */
function prepareFlowDomain(links, opts) {
  opts = opts || {};
  var N = links.N, dims = links.dims || [N, N, N], NX = dims[0], NY = dims[1], NZ = dims[2];
  var SI = NY * NZ, N3 = NX * SI, lat = flowLattice(), Q = 19;
  var halfway = opts.wall === 'halfway', cli = !opts.wall || opts.wall === 'cli', mask = opts.mask || null;
  var idx = new Int32Array(N3).fill(-1), nodes = [];
  for (var p = 0; p < N3; p++) if (!links.solid[p] && (!mask || mask[p])) { idx[p] = nodes.length; nodes.push(p); }
  var n = nodes.length;
  /* AoS populations: node a, direction i at a·19 + i.  off[a·19 + i] is the
     offset to pull from for an open link; wall links are listed per node
     (CSR wStart) and overwrite their slot after the plain gather. */
  var off = new Int32Array(Q * n), wStart = new Int32Array(n + 1);
  var wI = [], wK = [], wQ = [], wB = [];
  function nbr(p, cx, cy, cz) {
    var i = (p / SI) | 0, j = ((p / NZ) | 0) % NY, k = p % NZ;
    return ((i + cx + NX) % NX) * SI + ((j + cy + NY) % NY) * NZ + ((k + cz + NZ) % NZ);
  }
  /* q of the link leaving voxel p along lattice direction dir (1..18) */
  function qOut(p, dir) {
    var d = (dir - 1) >> 1, plus = (dir & 1) === 1, v = lat.dirs[d];
    if (plus) return links.qa[d][p];
    return links.qb[d][nbr(p, -v[0], -v[1], -v[2])];
  }
  var nWallLinks = 0, nFallback = 0, nLow = 0, nHigh = 0;
  for (var a = 0; a < n; a++) {
    var x = nodes[a];
    wStart[a] = wI.length;
    off[a * Q] = a * Q;
    for (var i = 1; i < Q; i++) {
      var ci = lat.c[i], jdir = lat.opp[i];
      var q = qOut(x, jdir);                     /* wall on x → x + c_j = x − c_i ? */
      var src = nbr(x, -ci[0], -ci[1], -ci[2]);
      off[a * Q + i] = a * Q + i;
      if (!(q > 0) && idx[src] >= 0) { off[a * Q + i] = idx[src] * Q + i; continue; }
      nWallLinks++;
      if (!(q > 0)) q = 0.5;                     /* solid or masked neighbour without a recorded wall */
      if (halfway) q = 0.5;
      var kd = 2, bo = 0;
      var behind = nbr(x, ci[0], ci[1], ci[2]);
      var qBehind = qOut(x, i);                  /* link x → x + c_i must be open too */
      var haveBehind = idx[behind] >= 0 && !(qBehind > 0);
      if (halfway || q === 0.5) kd = 3;
      else if (cli) {
        if (haveBehind) { kd = 4; bo = idx[behind] * Q + jdir; nLow++; }
        else { kd = 3; nFallback++; }
      } else if (q < 0.5) {
        if (haveBehind) { kd = 1; bo = idx[behind] * Q + jdir; nLow++; }
        else { kd = 3; nFallback++; }
      } else nHigh++;
      wI.push(i); wK.push(kd); wQ.push(q); wB.push(bo);
    }
  }
  wStart[n] = wI.length;
  return { N: N, dims: [NX, NY, NZ], cells: N3, n: n, nodes: nodes, idx: idx, off: off, wStart: wStart, wI: Int8Array.from(wI), wK: Int8Array.from(wK),
           wQ: Float64Array.from(wQ), wB: Int32Array.from(wB), lat: lat,
           wall: halfway ? 'halfway' : (cli ? 'cli' : 'bouzidi'), nWallLinks: nWallLinks, nFallback: nFallback, nLow: nLow, nHigh: nHigh, links: links };
}

/* Pull node a into fl (post-collision buffer A), walls applied. */
function flowGather(dom, A, a, fl) {
  var Q = 19, base = a * Q, off = dom.off;
  for (var i = 0; i < Q; i++) fl[i] = A[off[base + i]];
  for (var w = dom.wStart[a], e = dom.wStart[a + 1]; w < e; w++) {
    var i2 = dom.wI[w], j = (i2 & 1) ? i2 + 1 : i2 - 1, kd = dom.wK[w], q = dom.wQ[w];
    if (kd === 4) fl[i2] = A[base + j] + (1 - 2 * q) / (1 + 2 * q) * (A[dom.wB[w]] - A[base + i2]);
    else if (kd === 1) fl[i2] = 2 * q * A[base + j] + (1 - 2 * q) * A[dom.wB[w]];
    else if (kd === 2) fl[i2] = (A[base + j] + (2 * q - 1) * A[base + i2]) / (2 * q);
    else fl[i2] = A[base + j];
  }
}

function solveFlowCPU(dom, opts) {
  opts = opts || {};
  var N = dom.N, n = dom.n, N3 = dom.cells, Q = 19, lat = dom.lat, c = lat.c, w = lat.w;
  var tauP = opts.tauPlus || 1.0, Lam = opts.lambda != null ? opts.lambda : 3 / 16;
  var tauM = opts.collision === 'bgk' ? tauP : 0.5 + Lam / (tauP - 0.5);
  var wP = 1 / tauP, wM = 1 / tauM, nu = (tauP - 0.5) / 3;
  var F = opts.force || [1e-5, 0, 0], Fx = F[0], Fy = F[1], Fz = F[2];
  var tol = opts.tol || 1e-7, every = opts.checkEvery || 500;
  var maxSteps = opts.maxSteps || 400000, minSteps = opts.minSteps || 2 * every;
  var A = opts.init ? Float64Array.from(opts.init) : new Float64Array(Q * n), B = new Float64Array(Q * n);
  var cx = new Float64Array(Q), cy = new Float64Array(Q), cz = new Float64Array(Q), ww = new Float64Array(Q);
  for (var i = 0; i < Q; i++) { cx[i] = c[i][0]; cy[i] = c[i][1]; cz[i] = c[i][2]; ww[i] = w[i]; }
  var fl = new Float64Array(Q);
  /* source terms that do not depend on u: odd part 3 w c·F */
  var cF = new Float64Array(Q);
  for (var i2 = 0; i2 < Q; i2++) cF[i2] = cx[i2] * Fx + cy[i2] * Fy + cz[i2] * Fz;
  var hP = 1 - 0.5 * wP, hM = 1 - 0.5 * wM;
  var Ux = 0, Uy = 0, Uz = 0, prev = null, steps = 0, converged = false, history = [], uMax = 0;
  var wantFields = !!opts.fields, uF = null, sF = null;
  var off = dom.off, wStart = dom.wStart, wI = dom.wI, wK = dom.wK, wQ = dom.wQ, wB = dom.wB;
  var corr = 0, maxDrift = 0;
  var W0 = FLOW_W_REST, WA = FLOW_W_AXIS, WD = FLOW_W_DIAG, hFx = 0.5 * Fx, hFy = 0.5 * Fy, hFz = 0.5 * Fz;
  function step(record) {
    var sdr = 0, sx = 0, sy = 0, sz = 0, um = 0, cu = 0, cf = 0, fp = 0, fm = 0, ev = 0, od = 0;
    for (var a = 0; a < n; a++) {
      /* gather (pull) with walls */
      var base = a * Q;
      for (var i = 0; i < Q; i++) fl[i] = A[off[base + i]];
      fl[0] -= corr;
      for (var w = wStart[a], e = wStart[a + 1]; w < e; w++) {
        var iw = wI[w], j = (iw & 1) ? iw + 1 : iw - 1, kd = wK[w], q = wQ[w];
        if (kd === 4) fl[iw] = A[base + j] + (1 - 2 * q) / (1 + 2 * q) * (A[wB[w]] - A[base + iw]);
        else if (kd === 1) fl[iw] = 2 * q * A[base + j] + (1 - 2 * q) * A[wB[w]];
        else if (kd === 2) fl[iw] = (A[base + j] + (2 * q - 1) * A[base + iw]) / (2 * q);
        else fl[iw] = A[base + j];
      }
      /* moments (shifted: ρ = 1 + Σ f̃), D3Q19 unrolled */
      var f0 = fl[0], f1 = fl[1], f2 = fl[2], f3 = fl[3], f4 = fl[4], f5 = fl[5], f6 = fl[6], f7 = fl[7], f8 = fl[8], f9 = fl[9],
          f10 = fl[10], f11 = fl[11], f12 = fl[12], f13 = fl[13], f14 = fl[14], f15 = fl[15], f16 = fl[16], f17 = fl[17], f18 = fl[18];
      var dr = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9 + f10 + f11 + f12 + f13 + f14 + f15 + f16 + f17 + f18;
      var jx = f1 - f2 + f7 - f8 + f9 - f10 + f11 - f12 + f13 - f14;
      var jy = f3 - f4 + f7 - f8 - f9 + f10 + f15 - f16 + f17 - f18;
      var jz = f5 - f6 + f11 - f12 - f13 + f14 + f15 - f16 - f17 + f18;
      sdr += dr;
      var rho = 1 + dr, ir = 1 / rho;
      var ux = (jx + hFx) * ir, uy = (jy + hFy) * ir, uz = (jz + hFz) * ir;
      sx += ux; sy += uy; sz += uz;
      var u2 = ux * ux + uy * uy + uz * uz, uFd = ux * Fx + uy * Fy + uz * Fz;
      if (record && u2 > um) um = u2;
      var base15 = dr - 1.5 * rho * u2, s3 = -3 * uFd;
      B[base] = f0 - wP * (f0 - W0 * base15) + hP * W0 * s3;
      cu = ux; cf = Fx; fp = 0.5 * (f1 + f2); fm = 0.5 * (f1 - f2);
      ev = -wP * (fp - WA * (base15 + 4.5 * rho * cu * cu)) + hP * WA * (9 * cu * cf + s3);
      od = -wM * (fm - WA * 3 * rho * cu) + hM * WA * 3 * cf;
      B[base + 1] = f1 + ev + od; B[base + 2] = f2 + ev - od;
      cu = uy; cf = Fy; fp = 0.5 * (f3 + f4); fm = 0.5 * (f3 - f4);
      ev = -wP * (fp - WA * (base15 + 4.5 * rho * cu * cu)) + hP * WA * (9 * cu * cf + s3);
      od = -wM * (fm - WA * 3 * rho * cu) + hM * WA * 3 * cf;
      B[base + 3] = f3 + ev + od; B[base + 4] = f4 + ev - od;
      cu = uz; cf = Fz; fp = 0.5 * (f5 + f6); fm = 0.5 * (f5 - f6);
      ev = -wP * (fp - WA * (base15 + 4.5 * rho * cu * cu)) + hP * WA * (9 * cu * cf + s3);
      od = -wM * (fm - WA * 3 * rho * cu) + hM * WA * 3 * cf;
      B[base + 5] = f5 + ev + od; B[base + 6] = f6 + ev - od;
      cu = ux + uy; cf = Fx + Fy; fp = 0.5 * (f7 + f8); fm = 0.5 * (f7 - f8);
      ev = -wP * (fp - WD * (base15 + 4.5 * rho * cu * cu)) + hP * WD * (9 * cu * cf + s3);
      od = -wM * (fm - WD * 3 * rho * cu) + hM * WD * 3 * cf;
      B[base + 7] = f7 + ev + od; B[base + 8] = f8 + ev - od;
      cu = ux - uy; cf = Fx - Fy; fp = 0.5 * (f9 + f10); fm = 0.5 * (f9 - f10);
      ev = -wP * (fp - WD * (base15 + 4.5 * rho * cu * cu)) + hP * WD * (9 * cu * cf + s3);
      od = -wM * (fm - WD * 3 * rho * cu) + hM * WD * 3 * cf;
      B[base + 9] = f9 + ev + od; B[base + 10] = f10 + ev - od;
      cu = ux + uz; cf = Fx + Fz; fp = 0.5 * (f11 + f12); fm = 0.5 * (f11 - f12);
      ev = -wP * (fp - WD * (base15 + 4.5 * rho * cu * cu)) + hP * WD * (9 * cu * cf + s3);
      od = -wM * (fm - WD * 3 * rho * cu) + hM * WD * 3 * cf;
      B[base + 11] = f11 + ev + od; B[base + 12] = f12 + ev - od;
      cu = ux - uz; cf = Fx - Fz; fp = 0.5 * (f13 + f14); fm = 0.5 * (f13 - f14);
      ev = -wP * (fp - WD * (base15 + 4.5 * rho * cu * cu)) + hP * WD * (9 * cu * cf + s3);
      od = -wM * (fm - WD * 3 * rho * cu) + hM * WD * 3 * cf;
      B[base + 13] = f13 + ev + od; B[base + 14] = f14 + ev - od;
      cu = uy + uz; cf = Fy + Fz; fp = 0.5 * (f15 + f16); fm = 0.5 * (f15 - f16);
      ev = -wP * (fp - WD * (base15 + 4.5 * rho * cu * cu)) + hP * WD * (9 * cu * cf + s3);
      od = -wM * (fm - WD * 3 * rho * cu) + hM * WD * 3 * cf;
      B[base + 15] = f15 + ev + od; B[base + 16] = f16 + ev - od;
      cu = uy - uz; cf = Fy - Fz; fp = 0.5 * (f17 + f18); fm = 0.5 * (f17 - f18);
      ev = -wP * (fp - WD * (base15 + 4.5 * rho * cu * cu)) + hP * WD * (9 * cu * cf + s3);
      od = -wM * (fm - WD * 3 * rho * cu) + hM * WD * 3 * cf;
      B[base + 17] = f17 + ev + od; B[base + 18] = f18 + ev - od;
    }
    var T = A; A = B; B = T;
    /* mass: collision conserves it, so the total read this step is the
       total now in A; the excess is taken off the rest populations as the
       next step reads them (every step, so no sawtooth in ρ) */
    corr = sdr / n; if (Math.abs(corr) > maxDrift) maxDrift = Math.abs(corr);
    Ux = sx / N3; Uy = sy / N3; Uz = sz / N3;
    if (record) uMax = Math.sqrt(um);
  }
  while (steps < maxSteps) {
    var rec = ((steps + 1) % every) === 0;
    step(rec);
    steps++;
    if (rec) {
      var Um = Math.sqrt(Ux * Ux + Uy * Uy + Uz * Uz);
      var rel = prev ? Math.sqrt((Ux - prev[0]) * (Ux - prev[0]) + (Uy - prev[1]) * (Uy - prev[1]) + (Uz - prev[2]) * (Uz - prev[2])) / Math.max(Um, 1e-300) : 1;
      history.push({ step: steps, U: Um, rel: rel });
      prev = [Ux, Uy, Uz];
      if (steps >= minSteps && rel < tol) { converged = true; break; }
      if (!isFinite(Um)) break;
    }
  }
  var out = { U: [Ux, Uy, Uz], steps: steps, converged: converged, nu: nu, tauPlus: tauP, tauMinus: tauM,
              porosity: n / N3, massDrift: maxDrift, uMax: uMax, history: history, force: [Fx, Fy, Fz] };
  out.Ui = [Ux * N3 / n, Uy * N3 / n, Uz * N3 / n];
  if (wantFields) {
    /* one more gather at the converged state: velocity and viscous stress per node
       σ' = −(1 − 1/2τ⁺) [ Σ f^neq c c + ½ (F u + u F) ]   (Krüger, Varnik & Raabe 2009) */
    uF = new Float64Array(3 * n); sF = new Float64Array(6 * n); var dF = new Float64Array(n);
    var pre = -(1 - 0.5 * wP);
    for (var a = 0; a < n; a++) {
      flowGather(dom, A, a, fl);
      var dr = 0, jx = 0, jy = 0, jz = 0;
      for (var i3 = 0; i3 < Q; i3++) { var f = fl[i3]; dr += f; jx += f * cx[i3]; jy += f * cy[i3]; jz += f * cz[i3]; }
      var rho = 1 + dr, ux = (jx + 0.5 * Fx) / rho, uy = (jy + 0.5 * Fy) / rho, uz = (jz + 0.5 * Fz) / rho;
      var u2 = ux * ux + uy * uy + uz * uz;
      dF[a] = dr;
      uF[3 * a] = ux; uF[3 * a + 1] = uy; uF[3 * a + 2] = uz;
      var pxx = 0, pyy = 0, pzz = 0, pxy = 0, pxz = 0, pyz = 0;
      for (var i4 = 1; i4 < Q; i4++) {
        var cu = cx[i4] * ux + cy[i4] * uy + cz[i4] * uz;
        var neq = fl[i4] - ww[i4] * (dr + rho * (3 * cu + 4.5 * cu * cu - 1.5 * u2));
        pxx += neq * cx[i4] * cx[i4]; pyy += neq * cy[i4] * cy[i4]; pzz += neq * cz[i4] * cz[i4];
        pxy += neq * cx[i4] * cy[i4]; pxz += neq * cx[i4] * cz[i4]; pyz += neq * cy[i4] * cz[i4];
      }
      sF[6 * a]     = pre * (pxx + Fx * ux);
      sF[6 * a + 1] = pre * (pyy + Fy * uy);
      sF[6 * a + 2] = pre * (pzz + Fz * uz);
      sF[6 * a + 3] = pre * (pxy + 0.5 * (Fx * uy + Fy * ux));
      sF[6 * a + 4] = pre * (pxz + 0.5 * (Fx * uz + Fz * ux));
      sF[6 * a + 5] = pre * (pyz + 0.5 * (Fy * uz + Fz * uy));
    }
    out.u = uF; out.sigma = sF; out.dr = dF;   /* v0.30.0 — ρ − 1 per node (pressure for the force balance) */
  }
  out.state = A;
  return out;
}

/* Permeability tensor from three solves (force along x, y, z).
   Darcy: K e_j = ν ⟨u⟩ / g  (superficial mean, ρ₀ = 1), in cells². */
function flowPermeabilityCPU(links, opts) {
  opts = opts || {};
  var dom = opts.domain || prepareFlowDomain(links, opts), g = opts.g || 1e-5, K = new Float64Array(9), runs = [];
  for (var jx = 0; jx < 3; jx++) {
    var Fv = [0, 0, 0]; Fv[jx] = g;
    var o = {}; for (var key in opts) o[key] = opts[key];
    o.force = Fv;
    var r = solveFlowCPU(dom, o);
    for (var ix = 0; ix < 3; ix++) K[ix * 3 + jx] = r.nu * r.U[ix] / g;
    r.state = null; runs.push(r);
  }
  var Ks = new Float64Array(9), off = 0, dia = 0;
  for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) {
    Ks[a * 3 + b] = 0.5 * (K[a * 3 + b] + K[b * 3 + a]);
    if (a !== b) off = Math.max(off, Math.abs(K[a * 3 + b] - K[b * 3 + a]));
    else dia = Math.max(dia, Math.abs(K[a * 3 + b]));
  }
  return { K: K, Ksym: Ks, asym: dia > 0 ? off / dia : 0, porosity: dom.n / dom.cells, runs: runs, domain: dom };
}

/* Trilinear stress at a point (lattice units; node (i, j, k) sits at
   (i + ½, j + ½, k + ½)), weights renormalized over fluid nodes only. */
function sampleStressAt(dom, sol, px, py, pz) {
  var d3 = dom.dims, NX = d3[0], NY = d3[1], NZ = d3[2], S = sol.sigma, out = [0, 0, 0, 0, 0, 0], wsum = 0;
  var fx = px - 0.5, fy = py - 0.5, fz = pz - 0.5;
  var i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz), tx = fx - i0, ty = fy - j0, tz = fz - k0;
  for (var c = 0; c < 8; c++) {
    var di = c & 1, dj = (c >> 1) & 1, dk = c >> 2;
    var i = ((i0 + di) % NX + NX) % NX, j = ((j0 + dj) % NY + NY) % NY, k = ((k0 + dk) % NZ + NZ) % NZ;
    var a = dom.idx[i * NY * NZ + j * NZ + k];
    if (a < 0) continue;
    var wt = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
    if (wt <= 0) continue;
    for (var m = 0; m < 6; m++) out[m] += wt * S[6 * a + m];
    wsum += wt;
  }
  if (wsum <= 0) return null;
  for (var m2 = 0; m2 < 6; m2++) out[m2] /= wsum;
  return out;
}

/* Wall shear at wall point W with unit normal n pointing into the fluid:
   stress probed at 1.25 and 2.25 voxels along n, extrapolated linearly to
   the wall (FLUIDS_LBM_SCOPE.md §3.6 step 3); t = σ·n, τ_w = t − (t·n) n. */
function wallShearAt(dom, sol, wx, wy, wz, nx, ny, nz, d1, d2) {
  d1 = d1 || 1.25; d2 = d2 || 2.25;
  var s1 = sampleStressAt(dom, sol, wx + d1 * nx, wy + d1 * ny, wz + d1 * nz);
  var s2 = sampleStressAt(dom, sol, wx + d2 * nx, wy + d2 * ny, wz + d2 * nz);
  if (!s1 || !s2) return null;
  var s = [], r = d1 / (d2 - d1);
  for (var m = 0; m < 6; m++) s.push(s1[m] + r * (s1[m] - s2[m]));
  var t = [s[0] * nx + s[3] * ny + s[4] * nz, s[3] * nx + s[1] * ny + s[5] * nz, s[4] * nx + s[5] * ny + s[2] * nz];
  var tn = t[0] * nx + t[1] * ny + t[2] * nz;
  return { t: t, tau: [t[0] - tn * nx, t[1] - tn * ny, t[2] - tn * nz] };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { flowLattice: flowLattice, prepareFlowDomain: prepareFlowDomain, solveFlowCPU: solveFlowCPU,
    flowPermeabilityCPU: flowPermeabilityCPU, sampleStressAt: sampleStressAt, wallShearAt: wallShearAt };
}
