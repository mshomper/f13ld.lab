/* ============================================================
   F13LD.lab · 14-rasterizer.js
   CPU rasterizer + isotropic Voigt stiffness + Green operator.

   buildVoxels is the workhorse: takes (family, params, mode, ...)
   and returns a Float32Array(N³) of 0/1 voxel mask. Verbatim port
   from F13LD.sweep — same family dispatch, same mode wrapper,
   same anisotropic shell gradient stencil.

   isoC and buildGamma are CPU-only utilities the WGSL elastic
   solver will consume in Push 2. Included here so the math layer
   ships intact before any GPU code lands on top.
   ============================================================ */


/* ============================================================
   isoC — isotropic 6×6 Voigt stiffness tensor (flat row-major)
   Voigt order: xx yy zz yz xz xy
   ============================================================ */
function isoC(E, nu) {
  var lam = E * nu / ((1 + nu) * (1 - 2 * nu));
  var mu  = E / (2 * (1 + nu));
  var C = new Float64Array(36);
  C[0] = C[7] = C[14] = lam + 2*mu;
  C[1] = C[2] = C[6] = C[8] = C[12] = C[13] = lam;
  C[21] = C[28] = C[35] = mu;
  return C;
}


/* ==== F13LD-GEOM-VOXELS v1 · shared geometry (Lab ↔ Sweep). Keep byte-identical; check with f13ld.sweep tests/parity/geomsync.js ==== */
/* ============================================================
   shellWeightFactor — anisotropic shell wall (geometry.normal_weights).
   Local wall = wt · (wx|nx| + wy|ny| + wz|nz|), n the unit WORLD-space
   surface normal, exactly as F13LD.mesh builds it (m20 shellNormalAbs):
   1e-3 central difference of the raw field in field coordinates, scaled
   per axis by π·cellScale/5; a degenerate normal (|∇| < 1e-9) leaves the
   wall at its nominal thickness.  cellScale [x,y,z] or null (cubic).
   ============================================================ */
function shellWeightFactor(evalFn, x, y, z, nw, cellScale) {
  var e = 1e-3, fs = Math.PI / 5.0;
  var sx = fs * (cellScale ? cellScale[0] : 1), sy = fs * (cellScale ? cellScale[1] : 1), sz = fs * (cellScale ? cellScale[2] : 1);
  var dx = (evalFn(x + e, y, z) - evalFn(x - e, y, z)) * sx;
  var dy = (evalFn(x, y + e, z) - evalFn(x, y - e, z)) * sy;
  var dz = (evalFn(x, y, z + e) - evalFn(x, y, z - e)) * sz;
  var len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return 1;
  return nw.wx * Math.abs(dx / len) + nw.wy * Math.abs(dy / len) + nw.wz * Math.abs(dz / len);
}


/* ============================================================
   buildVoxels — rasterize a recipe to an N³ binary mask.

   Args:
     family     : 'tpms' | 'noise' | 'grain'
     params     : opaque, from KERNELS[family].parseRecipe(recipe)
     offset     : iso level for 'solid' / 'shell' modes (TPMS)
     N          : grid resolution (cube voxels per side)
     mode       : 'solid' | 'shell' | 'pi-tpms' | 'noise-*' | 'grain-*'
     wt         : wall thickness for 'shell' mode
     nWeights   : { wx, wy, wz } for anisotropic shell — null otherwise
     pipeR      : pipe radius for 'pi-tpms' mode
     phaseShift : { x, y, z } in cycles (multiplied by 2π internally) — pi-tpms

   Returns: Float32Array(N³), 0=void / 1=solid, indexed as i*N² + j*N + k.

   iRange (v0.24.0, optional) [i0, i1): fill only those x-slabs (the rest
   stays 0) — the geometry worker pool (17c) splits a grid this way.  The
   field is evaluated on the slabs plus one periodic neighbour slab each
   side (the anisotropic-shell gradient stencil), so every voxel in range
   is bit-identical to the full build.

   Domain: [-π, +π]³ in solver coords, sampled at voxel centers.
   ============================================================ */
function buildVoxels(family, params, offset, N, mode, wt, nWeights, pipeR, phaseShift, iRange) {
  var L    = Math.PI;
  var step = (2 * L) / N;
  var N3   = N * N * N;
  var kernel = KERNELS[family || 'tpms'];
  if (!kernel) throw new Error('buildVoxels: unknown family "' + family + '"');

  /* Cache evaluate as a local closure — V8 keeps the tight loop monomorphic */
  var evalFn = function (x, y, z) { return kernel.evaluate(params, x, y, z); };

  /* ── TPMS gradient normalization (mesh parity) ─────────────────────────
     Flags ride on params (stashed by TpmsKernel.parseRecipe) and default
     OFF when the recipe omits them, so older flag-less recipes rasterize
     exactly as before.  Constants/finite-difference step match mesh's
     gradPhiFieldCoord / piDistance verbatim (field-coord radians). */
  var shellNorm = !!(params && params.shellNorm);
  var piNorm    = !!(params && params.piNorm);
  var NORM_E = 0.012, NORM_EPS = 0.08, NORM_COSCLAMP = 0.95, NORM_CLIP_MULT = 5;
  var NORM_INV_2E = 1 / (2 * NORM_E);
  function gradFC(ax, ay, az) {
    var gx = (evalFn(ax+NORM_E,ay,az) - evalFn(ax-NORM_E,ay,az)) * NORM_INV_2E;
    var gy = (evalFn(ax,ay+NORM_E,az) - evalFn(ax,ay-NORM_E,az)) * NORM_INV_2E;
    var gz = (evalFn(ax,ay,az+NORM_E) - evalFn(ax,ay,az-NORM_E)) * NORM_INV_2E;
    return { gx:gx, gy:gy, gz:gz, mag:Math.sqrt(gx*gx+gy*gy+gz*gz) };
  }
  function piDistanceN(phiA_, phiB_, grA, grB) {
    var magA = Math.max(grA.mag, NORM_EPS), magB = Math.max(grB.mag, NORM_EPS);
    var dA = phiA_/magA, dB = phiB_/magB;
    var cosA = (grA.gx*grB.gx + grA.gy*grB.gy + grA.gz*grB.gz)/(magA*magB);
    if (cosA > NORM_COSCLAMP) cosA = NORM_COSCLAMP;
    if (cosA < -NORM_COSCLAMP) cosA = -NORM_COSCLAMP;
    var sin2 = 1 - cosA*cosA;
    var num = dA*dA - 2*cosA*dA*dB + dB*dB;
    return Math.sqrt(Math.max(num,0)/sin2);
  }
  /* Field-coord gradient of a field-pair's φB_eff (same NORM_E step). */
  function gradPairB(pair, x, y, z, dx, dy, dz) {
    var gx = (tpmsPairB(pair,x+NORM_E,y,z,dx,dy,dz) - tpmsPairB(pair,x-NORM_E,y,z,dx,dy,dz)) * NORM_INV_2E;
    var gy = (tpmsPairB(pair,x,y+NORM_E,z,dx,dy,dz) - tpmsPairB(pair,x,y-NORM_E,z,dx,dy,dz)) * NORM_INV_2E;
    var gz = (tpmsPairB(pair,x,y,z+NORM_E,dx,dy,dz) - tpmsPairB(pair,x,y,z-NORM_E,dx,dy,dz)) * NORM_INV_2E;
    return { gx:gx, gy:gy, gz:gz, mag:Math.sqrt(gx*gx+gy*gy+gz*gz) };
  }

  /* Pass 1 — full field cache. Needed for shell+nWeights gradient stencil
     and reused below for all single-eval-per-point modes. */
  var V = new Float32Array(N3);
  var iLo = iRange ? iRange[0] : 0, iHi = iRange ? iRange[1] : N, NNs = N * N;
  var full = (iLo === 0 && iHi === N);
  /* field slabs: the range, plus one neighbour each side when partial */
  var fieldRows = [];
  if (full) { for (var fr0 = 0; fr0 < N; fr0++) fieldRows.push(fr0); }
  else {
    fieldRows.push((iLo - 1 + N) % N);
    for (var fr1 = iLo; fr1 < iHi; fr1++) fieldRows.push(fr1);
    if (fieldRows.indexOf(iHi % N) < 0) fieldRows.push(iHi % N);
  }
  for (var fri = 0; fri < fieldRows.length; fri++) {
    var i = fieldRows[fri];
    var x = -L + (i + 0.5) * step;
    for (var j = 0; j < N; j++) {
      var y = -L + (j + 0.5) * step;
      for (var k = 0; k < N; k++) {
        var z = -L + (k + 0.5) * step;
        V[i*N*N + j*N + k] = evalFn(x, y, z);
      }
    }
  }

  var solid = new Float32Array(N3);

  /* ── PI-TPMS — needs a second eval at the phase-shifted point ───────── */
  if (mode === 'pi-tpms') {
    var TWO_PI = 2 * Math.PI;
    var dx = (phaseShift && phaseShift.x ? phaseShift.x : 0) * TWO_PI;
    var dy = (phaseShift && phaseShift.y ? phaseShift.y : 0) * TWO_PI;
    var dz = (phaseShift && phaseShift.z ? phaseShift.z : 0) * TWO_PI;
    var pr = pipeR || 0.1;
    /* v0.13.0 — PI uses φ itself (no offset threshold), so a raw preset's
       constant that 60-add-design moved into `offset` (split-P −0.3, F-RD +0.3)
       is subtracted back here.  Matches F13LD.tpms / F13LD.mesh and the lab
       preview (which already subtracted it).  offset is 0 for every other recipe. */
    var off = offset || 0;
    var pair = params && params.pair;          /* field-pair PI-TPMS, null for self-pairs */
    for (var i2 = iLo; i2 < iHi; i2++) {
      var x2 = -L + (i2 + 0.5) * step;
      for (var j2 = 0; j2 < N; j2++) {
        var y2 = -L + (j2 + 0.5) * step;
        for (var k2 = 0; k2 < N; k2++) {
          var vA = V[i2*N*N + j2*N + k2] - off;
          var zc = -L + (k2 + 0.5)*step;
          var vB = pair ? tpmsPairB(pair, x2, y2, zc, dx, dy, dz)
                        : evalFn(x2 + dx, y2 + dy, zc + dz) - off;
          var insidePi;
          if (piNorm) {
            var grA = gradFC(x2, y2, zc);
            var grB = pair ? gradPairB(pair, x2, y2, zc, dx, dy, dz)
                           : gradFC(x2 + dx, y2 + dy, zc + dz);
            var dPi = piDistanceN(vA, vB, grA, grB);
            if (dPi > NORM_CLIP_MULT*pr) dPi = NORM_CLIP_MULT*pr;
            insidePi = dPi < pr;
          } else {
            insidePi = Math.max(Math.abs(vA), Math.abs(vB)) < pr;
          }
          solid[i2*N*N + j2*N + k2] = insidePi ? 1 : 0;
        }
      }
    }

  /* ── Anisotropic shell — local wall from the world-space surface normal ── */
  } else if (mode === 'shell' && nWeights) {
    /* v0.26.0 — local wall from the surface normal exactly as F13LD.mesh
       builds it (shellWeightFactor); was a central difference of the cached
       grid, which at N = 16–32 bent the normal and ignored the cell scale. */
    var cellS = params && params.cellScale;
    for (var i3 = iLo; i3 < iHi; i3++) {
      var xc3 = -L + (i3 + 0.5) * step;
      for (var j3 = 0; j3 < N; j3++) {
        var yc3 = -L + (j3 + 0.5) * step;
        for (var k3 = 0; k3 < N; k3++) {
          var localWt = wt * shellWeightFactor(evalFn, xc3, yc3, -L + (k3 + 0.5) * step, nWeights, cellS);
          var idx = i3*N*N + j3*N + k3;
          if (shellNorm) {
            var grS = gradFC(-L+(i3+0.5)*step, -L+(j3+0.5)*step, -L+(k3+0.5)*step);
            var gmS = Math.max(grS.mag, NORM_EPS);
            var distS = Math.abs(V[idx] - offset) / gmS;
            if (distS > NORM_CLIP_MULT*localWt) distS = NORM_CLIP_MULT*localWt;
            solid[idx] = distS < localWt ? 1 : 0;
          } else {
            solid[idx] = Math.abs(V[idx] - offset) < localWt ? 1 : 0;
          }
        }
      }
    }

  /* ── Noise modes — V is already the normalized field ──────────────── */
  } else if (mode === 'noise-sheet' || mode === 'noise-half' || mode === 'noise-solid') {
    var iso = params.isoLevel;
    var hw  = params.halfWidth;
    var inv = !!params.halfInvert;
    if (mode === 'noise-sheet') {
      for (var n1 = iLo * NNs; n1 < iHi * NNs; n1++) solid[n1] = Math.abs(V[n1] - iso) < hw ? 1 : 0;
    } else if (mode === 'noise-half') {
      for (var n2 = iLo * NNs; n2 < iHi * NNs; n2++) solid[n2] = inv ? (V[n2] < iso ? 1 : 0) : (V[n2] > iso ? 1 : 0);
    } else {
      for (var n3 = iLo * NNs; n3 < iHi * NNs; n3++) solid[n3] = Math.abs(V[n3] - iso) > hw ? 1 : 0;
    }

  /* ── Grain modes — V is RAW (NOT normalized to [-1,1] like noise) ─── */
  } else if (mode === 'grain-sheet' || mode === 'grain-half' || mode === 'grain-solid') {
    var giso = params.isoLevel;
    var ghw  = params.halfWidth;
    var ginv = !!params.halfInvert;
    if (mode === 'grain-sheet') {
      for (var g1 = iLo * NNs; g1 < iHi * NNs; g1++) solid[g1] = Math.abs(V[g1] - giso) < ghw ? 1 : 0;
    } else if (mode === 'grain-half') {
      for (var g2 = iLo * NNs; g2 < iHi * NNs; g2++) solid[g2] = ginv ? (V[g2] < giso ? 1 : 0) : (V[g2] > giso ? 1 : 0);
    } else {
      for (var g3 = iLo * NNs; g3 < iHi * NNs; g3++) solid[g3] = Math.abs(V[g3] - giso) > ghw ? 1 : 0;
    }

  /* ── Solid (TPMS, default) or isotropic shell ──────────────────────── */
  } else {
    for (var idx2 = iLo * NNs; idx2 < iHi * NNs; idx2++) {
      if (mode === 'shell') {
        if (shellNorm) {
          var ia = (idx2/(N*N))|0, rem = idx2 - ia*N*N, ja = (rem/N)|0, ka = rem - ja*N;
          var grS2 = gradFC(-L+(ia+0.5)*step, -L+(ja+0.5)*step, -L+(ka+0.5)*step);
          var gmS2 = Math.max(grS2.mag, NORM_EPS);
          var distS2 = Math.abs(V[idx2] - offset) / gmS2;
          if (distS2 > NORM_CLIP_MULT*wt) distS2 = NORM_CLIP_MULT*wt;
          solid[idx2] = distS2 < wt ? 1 : 0;
        } else {
          solid[idx2] = Math.abs(V[idx2] - offset) < wt ? 1 : 0;
        }
      } else {
        solid[idx2] = (V[idx2] - offset < 0) ? 1 : 0;
      }
    }
  }

  return solid;
}


/* ============================================================
   v0.19.0 — partial-volume voxels (stiffness only)

   buildVoxelMargin(family, params, offset, N, mode, wt, nWeights, pipeR, phaseShift)
     The continuous quantity behind buildVoxels' solid test, as a margin m
     with solid ⟺ m > 0, sampled at the N³ voxel CORNERS (corner (i,j,k)
     at −π + (i,j,k)·step; periodic, so corner N is corner 0).  Each mode
     mirrors buildVoxels' own test — keep the two in sync:
       solid           offset − V                (every distance family too)
       shell           wt − |V − offset|         (÷|∇φ|, clipped, when normalized)
       shell + weights local width from the field gradient direction
       pi-tpms         pipeR − PI distance       (or − max(|φA|,|φB|) raw)
       noise / grain   sheet hw − |V − iso| · half ±(V − iso) · solid |V − iso| − hw

   voxelFractionsFromMargin(mg, N, kept, raw, sub)
     mg = buildVoxelMargin's result.  Solid fraction of every voxel whose
     corners straddle the surface: the margin is evaluated EXACTLY at a sub³
     grid of points inside the voxel (default 4³) and the solid points are
     counted.  (Trilinear interpolation from the corners was tried first and
     read thin tubes and struts 4–5 % low at N = 32: the margin of a tube is
     cone-shaped, so interpolating it between corners under-fills the tube.)
     Voxels whose corners all agree keep their 0/1 value, so
     features thinner than a voxel are never lost, and the lab's island
     trim is respected: a voxel the trim removed stays 0, and a void voxel
     with no kept solid among its 26 neighbours stays 0.

   The elastic solve blends void and solid stiffness by this fraction
   (Voigt-type mixing — Lucarini et al. 2021 found it the best smoothing
   for FFT lattice homogenization).  Crush, buckling and connectivity keep
   the plain 0/1 cube.
   ============================================================ */
function buildVoxelMargin(family, params, offset, N, mode, wt, nWeights, pipeR, phaseShift, fnOnly) {
  var L = Math.PI, step = (2 * L) / N, N3 = N * N * N;
  var kernel = KERNELS[family || 'tpms'];
  if (!kernel) throw new Error('buildVoxelMargin: unknown family "' + family + '"');
  var evalFn = function (x, y, z) { return kernel.evaluate(params, x, y, z); };
  var shellNorm = !!(params && params.shellNorm), piNorm = !!(params && params.piNorm);
  var NORM_E = 0.012, NORM_EPS = 0.08, NORM_COSCLAMP = 0.95, NORM_CLIP_MULT = 5, NORM_INV_2E = 1 / (2 * NORM_E);
  function gradFC(ax, ay, az) {
    var gx = (evalFn(ax + NORM_E, ay, az) - evalFn(ax - NORM_E, ay, az)) * NORM_INV_2E;
    var gy = (evalFn(ax, ay + NORM_E, az) - evalFn(ax, ay - NORM_E, az)) * NORM_INV_2E;
    var gz = (evalFn(ax, ay, az + NORM_E) - evalFn(ax, ay, az - NORM_E)) * NORM_INV_2E;
    return { gx: gx, gy: gy, gz: gz, mag: Math.sqrt(gx * gx + gy * gy + gz * gz) };
  }
  function gradPairB(pair, x, y, z, dx, dy, dz) {
    var gx = (tpmsPairB(pair, x + NORM_E, y, z, dx, dy, dz) - tpmsPairB(pair, x - NORM_E, y, z, dx, dy, dz)) * NORM_INV_2E;
    var gy = (tpmsPairB(pair, x, y + NORM_E, z, dx, dy, dz) - tpmsPairB(pair, x, y - NORM_E, z, dx, dy, dz)) * NORM_INV_2E;
    var gz = (tpmsPairB(pair, x, y, z + NORM_E, dx, dy, dz) - tpmsPairB(pair, x, y, z - NORM_E, dx, dy, dz)) * NORM_INV_2E;
    return { gx: gx, gy: gy, gz: gz, mag: Math.sqrt(gx * gx + gy * gy + gz * gz) };
  }
  function piDistanceN(phiA_, phiB_, grA, grB) {
    var magA = Math.max(grA.mag, NORM_EPS), magB = Math.max(grB.mag, NORM_EPS);
    var dA = phiA_ / magA, dB = phiB_ / magB;
    var cosA = (grA.gx * grB.gx + grA.gy * grB.gy + grA.gz * grB.gz) / (magA * magB);
    if (cosA > NORM_COSCLAMP) cosA = NORM_COSCLAMP;
    if (cosA < -NORM_COSCLAMP) cosA = -NORM_COSCLAMP;
    var sin2 = 1 - cosA * cosA, num = dA * dA - 2 * cosA * dA * dB + dB * dB;
    return Math.sqrt(Math.max(num, 0) / sin2);
  }
  var TWO_PI = 2 * Math.PI, ps = phaseShift || {};
  var pdx = (ps.x || 0) * TWO_PI, pdy = (ps.y || 0) * TWO_PI, pdz = (ps.z || 0) * TWO_PI;
  var pr = pipeR || 0.1, off = offset || 0, pair = params && params.pair;
  var iso = params ? params.isoLevel : 0, hw = params ? params.halfWidth : 0, inv = !!(params && params.halfInvert);
  function margin(x, y, z) {
    var v;
    if (mode === 'pi-tpms') {
      var vA = evalFn(x, y, z) - off;
      var vB = pair ? tpmsPairB(pair, x, y, z, pdx, pdy, pdz) : evalFn(x + pdx, y + pdy, z + pdz) - off;
      if (piNorm) {
        var grA = gradFC(x, y, z), grB = pair ? gradPairB(pair, x, y, z, pdx, pdy, pdz) : gradFC(x + pdx, y + pdy, z + pdz);
        var dPi = piDistanceN(vA, vB, grA, grB);
        if (dPi > NORM_CLIP_MULT * pr) dPi = NORM_CLIP_MULT * pr;
        return pr - dPi;
      }
      return pr - Math.max(Math.abs(vA), Math.abs(vB));
    }
    v = evalFn(x, y, z);
    if (mode === 'shell') {
      var w = wt;
      if (nWeights) w = wt * shellWeightFactor(evalFn, x, y, z, nWeights, params && params.cellScale);
      if (shellNorm) {
        var gs = gradFC(x, y, z), d = Math.abs(v - offset) / Math.max(gs.mag, NORM_EPS);
        if (d > NORM_CLIP_MULT * w) d = NORM_CLIP_MULT * w;
        return w - d;
      }
      return w - Math.abs(v - offset);
    }
    if (mode === 'noise-sheet' || mode === 'grain-sheet') return hw - Math.abs(v - iso);
    if (mode === 'noise-half' || mode === 'grain-half') return inv ? iso - v : v - iso;
    if (mode === 'noise-solid' || mode === 'grain-solid') return Math.abs(v - iso) - hw;
    return offset - v;
  }
  /* v0.20.0 — fnOnly: the margin function without the corner grid (the
     thermal voxel workers evaluate it on their own slab). */
  if (fnOnly) return { m: null, fn: margin, step: step, L: L, N: N };
  var m = new Float32Array(N3);
  for (var i = 0; i < N; i++) {
    var x = -L + i * step;
    for (var j = 0; j < N; j++) {
      var y = -L + j * step;
      for (var k = 0; k < N; k++) m[i * N * N + j * N + k] = margin(x, y, -L + k * step);
    }
  }
  return { m: m, fn: margin, step: step, L: L, N: N };
}

function voxelFractionsFromMargin(mg, N, kept, raw, sub, iRange) {
  sub = sub || 4;
  var m = mg.m, fn = mg.fn, step = mg.step, L = mg.L;
  var NN = N * N, N3 = NN * N, out = Float32Array.from(kept);
  var w = new Float64Array(sub);
  for (var s0 = 0; s0 < sub; s0++) w[s0] = (s0 + 0.5) / sub * step;
  var c = new Float64Array(8), inv = 1 / (sub * sub * sub);
  /* v0.24.0 — iRange [i0, i1): only those x-slabs (geometry worker pool) */
  var iLo = iRange ? iRange[0] : 0, iHi = iRange ? iRange[1] : N;
  for (var i = iLo; i < iHi; i++) {
    var i1 = (i + 1) % N;
    for (var j = 0; j < N; j++) {
      var j1 = (j + 1) % N;
      for (var k = 0; k < N; k++) {
        var k1 = (k + 1) % N, id = i * NN + j * N + k;
        c[0] = m[i * NN + j * N + k];   c[1] = m[i * NN + j * N + k1];
        c[2] = m[i * NN + j1 * N + k];  c[3] = m[i * NN + j1 * N + k1];
        c[4] = m[i1 * NN + j * N + k];  c[5] = m[i1 * NN + j * N + k1];
        c[6] = m[i1 * NN + j1 * N + k]; c[7] = m[i1 * NN + j1 * N + k1];
        var pos = 0;
        for (var q = 0; q < 8; q++) if (c[q] > 0) pos++;
        if (pos === 0 || pos === 8) continue;                 /* corners agree: keep 0/1 */
        if (raw && raw[id] > 0.5 && !(kept[id] > 0.5)) continue; /* removed by the island trim */
        if (!(kept[id] > 0.5)) {                               /* void voxel: only next to kept solid */
          var near = false;
          for (var a = -1; a <= 1 && !near; a++) for (var b = -1; b <= 1 && !near; b++) for (var e = -1; e <= 1 && !near; e++)
            if (kept[((i + a + N) % N) * NN + ((j + b + N) % N) * N + ((k + e + N) % N)] > 0.5) near = true;
          if (!near) continue;
        }
        var n = 0, x0 = -L + i * step, y0 = -L + j * step, z0 = -L + k * step;
        for (var u = 0; u < sub; u++) for (var v = 0; v < sub; v++) for (var z = 0; z < sub; z++)
          if (fn(x0 + w[u], y0 + w[v], z0 + w[z]) > 0) n++;
        out[id] = n * inv;
      }
    }
  }
  return out;
}

/* ============================================================
   buildRawField — produce the raw scalar field (pre-topology)
   for shader-side display. Mirrors buildVoxels' Pass 1 but
   returns the Float32Array of kernel.evaluate values plus
   min/max for R8 texture normalization.

   The shader (LabRaymarcher) applies isoLevel / thickness /
   topology via uniforms, so changing topology does not require
   a re-bake — only the raw field needs to be present.

   Domain: [-π, π]³, matching the kernel's internal coordinate
   convention. Lab kernels (TpmsKernel, GrainKernel, NoiseKernel)
   all consume coordinates in this domain regardless of the
   recipe's cellSizeMm — physical scaling is a downstream concern.

   Returns: { data: Float32Array(N³), fieldMin: number, fieldMax: number }
   ============================================================ */
function buildRawField(family, params, N) {
  var L    = Math.PI;
  var step = (2 * L) / N;
  var N3   = N * N * N;
  var kernel = KERNELS[family || 'tpms'];
  if (!kernel) throw new Error('buildRawField: unknown family "' + family + '"');

  /* Storage order: WebGL's texImage3D expects width-fastest, depth-slowest
     (bytes[(z*H + y)*W + x]).  We loop x in the innermost position so the
     write stride into `data` matches that.  This keeps the texture-space
     mapping consistent with shader sampling, and makes the gradient stencil
     in 21-raymarcher.js (which assumes idx+1 ↔ x, idx+N*N ↔ z) correct. */
  var data = new Float32Array(N3);
  var minV = Infinity, maxV = -Infinity;

  for (var iz = 0; iz < N; iz++) {
    var z = -L + (iz + 0.5) * step;
    for (var iy = 0; iy < N; iy++) {
      var y = -L + (iy + 0.5) * step;
      for (var ix = 0; ix < N; ix++) {
        var x = -L + (ix + 0.5) * step;
        var v = kernel.evaluate(params, x, y, z);
        data[(iz * N + iy) * N + ix] = v;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  return { data: data, fieldMin: minV, fieldMax: maxV };
}

/* ============================================================
   buildPairField — field B of a field-pair PI-TPMS recipe, baked for the
   preview (v0.13.0).  Same storage order as buildRawField.  The phase
   shift is baked in, so the shader samples B at p with no offset.
   ============================================================ */
function buildPairField(pair, phaseShift, N) {
  var L = Math.PI, step = (2 * L) / N, TWO_PI = 2 * Math.PI;
  var ps = phaseShift || {};
  var dx = (ps.x || 0) * TWO_PI, dy = (ps.y || 0) * TWO_PI, dz = (ps.z || 0) * TWO_PI;
  var data = new Float32Array(N * N * N), minV = Infinity, maxV = -Infinity;
  for (var iz = 0; iz < N; iz++) {
    var z = -L + (iz + 0.5) * step;
    for (var iy = 0; iy < N; iy++) {
      var y = -L + (iy + 0.5) * step;
      for (var ix = 0; ix < N; ix++) {
        var x = -L + (ix + 0.5) * step;
        var v = tpmsPairB(pair, x, y, z, dx, dy, dz);
        data[(iz * N + iy) * N + ix] = v;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  return { data: data, fieldMin: minV, fieldMax: maxV };
}
/* ==== /F13LD-GEOM-VOXELS ==== */


/* ============================================================
   buildGamma — discrete Green operator for the elastic Lippmann-
   Schwinger iteration.

   Returns Gamma[p][q] for p,q in {0=xx, 1=yy, 2=zz}, each as a
   real Float64Array(N³) indexed by (i,j,k) with i=outermost.

   Textbook Moulinec-Suquet 1998 normal-normal block reduction
   for an isotropic reference (μ₀, λ₀):

     Γ_iikk(n) = G_ik(n) · n_i · n_k

   where G_ik is the standard isotropic displacement Green tensor:

     G_pq(n) = (1/μ₀)·δ_pq + b·n_p·n_q,
        b = -(λ₀ + μ₀) / (μ₀ · (λ₀ + 2μ₀))

   At ξ=0 (DC bin) Γ is left at zero — no macroscopic strain
   correction in the constant mode.

   ── A.1.7 (2026-05) — Γ-formula correctness fix ────────────────
   Pre-A.1.7 used  -0.25·[G_pp n_q² + G_qq n_p² + 2 G_pq n_p n_q],
   which gave the wrong sign and a spurious off-diagonal coupling.
   The bug self-cancelled into a consistent-but-wrong fixed point
   for cubic-isotropic structures (Schwarz P came back near the
   right cubic-symmetric pattern at a biased absolute magnitude),
   biasing the solver toward the Voigt upper bound — Schwarz P
   E/Es scaled ∝ ρ^1.02 instead of the literature-expected
   ρ^1.3 (sheet) / ρ^1.6–2.0 (skeletal).  Identified during
   F13LD.sweep v0.16.0 literature validation; CG / WGSL solver
   code is byte-identical to the pre-fix path — only this Γ
   tensor changes.
   ============================================================ */
function buildGamma(N, mu0, lam0, scheme) {
  var N3 = N * N * N;
  var Gamma = [
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)],
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)],
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)]
  ];
  var a =  1.0 / mu0;
  var WILLOT = (scheme !== 'continuous');   /* default operator is Willot's rotated scheme */
  var PI_N = Math.PI / N;
  var b = -(lam0 + mu0) / (mu0 * (lam0 + 2 * mu0));
  for (var i = 0; i < N; i++) {
    var ki = i <= N/2 ? i : i - N;
    for (var j = 0; j < N; j++) {
      var kj = j <= N/2 ? j : j - N;
      for (var k = 0; k < N; k++) {
        var kk = k <= N/2 ? k : k - N;
        var ksq = ki*ki + kj*kj + kk*kk;
        var idx = i*N*N + j*N + k;
        if (ksq === 0) continue;
        var rk = 1.0 / Math.sqrt(ksq);
        var n0 = ki*rk, n1 = kj*rk, n2 = kk*rk;
        var nv = [n0, n1, n2];
        if (WILLOT) {
          /* Willot (2015) rotated finite-difference frequency (see buildGammaFull). */
          var sx = Math.sin(PI_N*ki), cx = Math.cos(PI_N*ki);
          var sy = Math.sin(PI_N*kj), cy = Math.cos(PI_N*kj);
          var sz = Math.sin(PI_N*kk), cz = Math.cos(PI_N*kk);
          var wx = sx*cy*cz, wy = cx*sy*cz, wz = cx*cy*sz;
          var wsq = wx*wx + wy*wy + wz*wz;
          if (wsq < 1e-30) continue;
          var rw = 1.0 / Math.sqrt(wsq);
          nv[0] = wx*rw; nv[1] = wy*rw; nv[2] = wz*rw;
        }
        for (var p = 0; p < 3; p++) {
          for (var q = 0; q < 3; q++) {
            var Gpq = a*(p===q?1:0) + b*nv[p]*nv[q];
            Gamma[p][q][idx] = Gpq * nv[p] * nv[q];
          }
        }
      }
    }
  }
  return Gamma;
}


/* ==== F13LD-GEOM-BUILDARGS v1 · shared geometry (Lab ↔ Sweep). Keep byte-identical; check with f13ld.sweep tests/parity/geomsync.js ==== */
/* ============================================================
   resolveMode — pulls the lab geometry mode from a recipe.

   Recipe schema convention for lab (matches sweep where stable):
     recipe.geometry.mode  — string mode identifier
     recipe.geometry.offset / wallThickness / pipeR / phaseShift
        — mode-specific args

   For grain recipes, geometry.center & geometry.half_width go
   onto params during parseRecipe (so they don't need to be
   passed as buildVoxels args) — only `mode` is read here.
   ============================================================ */
function resolveBuildArgs(recipe) {
  var g = recipe.geometry || {};
  return {
    mode:       g.mode || 'solid',
    offset:     g.offset != null ? g.offset : 0,
    wt:         g.wallThickness != null ? g.wallThickness : 0.3,
    pipeR:      g.pipeR != null ? g.pipeR : 0.1,
    phaseShift: g.phaseShift || { x: 0, y: 0, z: 0 },
    nWeights:   g.nWeights || null
  };
}
/* ==== /F13LD-GEOM-BUILDARGS ==== */
