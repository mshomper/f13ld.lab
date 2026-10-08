/* ============================================================
   F13LD.lab · 14e-link-field.js   (v0.19.3 — thermal Phase 0)
   Sub-voxel wall data on the design's own continuous field.

   Walls are located on the margin function m(x) of 14-rasterizer
   buildVoxelMargin (solid ⟺ m > 0), which mirrors every family's solid
   test, so no distance normalization is needed.  Two products:

   1. buildVoxelTensors — for thermal (docs/THERMAL_SCOPE.md §3.3, §11).
      Per voxel: solid fraction phi and wall normal n.  The thermal solver
      turns them into a full 3×3 laminate conductivity
          k = k_par (I − n nᵀ) + k_ser n nᵀ
      (parallel along the wall, series across it; Kabel, Merkert &
      Schneider 2015).  Surface voxels are those whose 8 corners and centre
      do not all agree in sign.  In each, the margin is linearized at the
      centre (value + central-difference gradient) and the plane's sign is
      checked against 4³ sample points:
        · misjudges ≤ LINK_PLANE_MISS (1): flat wall — phi is the exact
          plane–cube volume (Scardovelli & Zaleski 2000), n the gradient
          direction; exact for any flat wall at any angle;
        · misjudges ≤ LINK_NORMAL_MISS (4): gently curved wall — phi is the
          sampled fraction, n the gradient direction (the plane volume
          over-fills convex walls such as struts);
        · more: walls thinner than a voxel, strut junctions, creases — phi
          is the sampled fraction and n = 0, i.e. the isotropic blend the
          stiffness solver uses.  A laminate there was tried and set aside:
          at a junction crease the local "normal" points along the other
          strut and the series term walls it off (BCC beams in Cu/air read
          7 % low at N = 32 against N = 128).
      Island trim: a voxel the trim removed stays 0, and a void voxel next
      to a removed voxel but to no kept one stays 0 (no island comes back
      as partial voxels).

   2. buildLinkField — for the lattice Boltzmann wall (FLUIDS_LBM_SCOPE.md
      §3.2).  For every voxel i and axis a, the link from the centre of i to
      the centre of its +a neighbour (periodic) gets its SOLID LENGTH
      FRACTION s ∈ [0, 1].  Only links that can touch a wall are examined:
      ends that differ, or a corner of the shared face with the other sign
      (that also catches walls thinner than a voxel passing between two
      centres of the same phase).  The margin is sampled at 9 points along
      the link and each sign change refined by 6 bisection steps (1/512
      voxel).  Ends the island trim removed count as filler.

   API
     buildVoxelTensors(recipe, N, opts)
       opts: { connectivity, pruneLargest } (as the elastic solver),
             staircase: true → the 0/1 cube, no sub-voxel data.
       → { N, kept, raw, phi (Float32 N³), n (Float32 3·N³), rho (0/1),
           rhoPhi, nSurf, nPlane, t_ms }
     voxelTensorsFromMargin(mg, N, kept, raw, opts)   the core (any margin)
     buildLinkField(recipe, N, opts)
       → { N, kept, raw, s: [sx, sy, sz] (Float32 N³), rho, rhoLink,
           nExamined, nMulti, t_ms }
     buildLinkFieldFromFn(fn, N, kept, raw, mCorner, opts)
     planeCubeSolidFraction(m0, gx, gy, gz)
     marginSurfaceArea(m, N, kept, raw, iRange)   (v0.23.0) wall area ÷ cell edge²
     voidOpenAxes(kept, N)                        (v0.23.0) pores run through x / y / z
     designGeometryMetrics(recipe, N, opts)       (v0.23.0) both, built from the recipe

   3. Surface area (v0.23.0, thermal Phase 3 — THERMAL_SCOPE.md §3.9, §14).
      Marching tetrahedra on the corner margin grid: each voxel cube is
      split into 6 tetrahedra around its main diagonal and the zero level of
      the linearly interpolated margin is triangulated (watertight across
      faces, no lookup tables).  The same island-trim rules as the wall data
      apply, so floating islands the trim removes add no area (they count as
      pore space).  Area is reported per cell edge²; surface area density =
      area ÷ cell edge, hydraulic diameter = 4 · porosity ÷ that.
   Index order: i·N² + j·N + k with x on i (solver order, as buildVoxels).
   ============================================================ */

var LINK_SAMPLES = 8;      /* intervals along an examined link */
var LINK_BISECT = 6;       /* bisection steps per crossing */
var LINK_CELL_SUB = 4;     /* samples per axis in a surface voxel (4³ = 64, as partial volume) */
var LINK_PLANE_MISS = 1;   /* samples the linearized plane may misjudge and still give the exact volume */
var LINK_NORMAL_MISS = 4;  /* … and still give the wall normal (sampled volume) */

/* raw 0/1 cube, the trimmed cube and the margin, as the elastic solver builds them */
function designMarginSetup(recipe, N, opts) {
  opts = opts || {};
  var family = recipe.family, params = KERNELS[family].parseRecipe(recipe), args = resolveBuildArgs(recipe);
  var raw = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  var kept = raw;
  if (opts.pruneLargest !== false && (opts.connectivity || 'networks') !== 'off' && typeof pruneVoxels === 'function')
    kept = pruneVoxels(raw, N, family, { connectivity: opts.connectivity || 'networks', pruneLargest: true });
  var mg = buildVoxelMargin(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  return { raw: raw, kept: kept, mg: mg };
}
function linkNowMs() { return (typeof performance !== 'undefined') ? performance.now() : Date.now(); }

function buildVoxelTensors(recipe, N, opts) {
  opts = opts || {};
  var t0 = linkNowMs(), d = designMarginSetup(recipe, N, opts);
  var out = voxelTensorsFromMargin(d.mg, N, d.kept, d.raw, opts);
  out.t_ms = linkNowMs() - t0;
  return out;
}

function voxelTensorsFromMargin(mg, N, kept, raw, opts) {
  opts = opts || {};
  var m = mg.m, fn = mg.fn, L = Math.PI, h = 2 * L / N, NN = N * N, N3 = NN * N;
  var phi = Float32Array.from(kept), nrm = new Float32Array(3 * N3);
  var solid = 0;
  for (var p0 = 0; p0 < N3; p0++) if (kept[p0] > 0.5) solid++;
  var res = { N: N, kept: kept, raw: raw, phi: phi, n: nrm, rho: solid / N3, rhoPhi: solid / N3, nSurf: 0, nPlane: 0 };
  if (opts.staircase) return res;
  var planeMiss = opts.planeMiss != null ? opts.planeMiss : LINK_PLANE_MISS;
  var normalMiss = Math.max(planeMiss, opts.normalMiss != null ? opts.normalMiss : LINK_NORMAL_MISS);
  var ns = LINK_CELL_SUB, hs = h / ns, gd = 0.25 * h, cm = new Float64Array(ns * ns * ns), c = new Float64Array(8);
  function isTrimmed(id) { return raw && raw[id] > 0.5 && !(kept[id] > 0.5); }
  var nSurf = 0, nPlane = 0;
  /* v0.20.0 — opts.iRange [i0, i1): only those x-slabs (the thermal voxel
     workers split the grid this way; the caller merges the slabs). */
  var iLo = opts.iRange ? opts.iRange[0] : 0, iHi = opts.iRange ? opts.iRange[1] : N;
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
        var pos = (raw ? raw[id] : kept[id]) > 0.5 ? 1 : 0;
        for (var q = 0; q < 8; q++) if (c[q] > 0) pos++;
        if (pos === 0 || pos === 9) continue;                     /* corners and centre agree */
        if (isTrimmed(id)) continue;                               /* removed by the island trim */
        if (!(kept[id] > 0.5) && raw && raw !== kept) {            /* void next to a removed island only */
          var nearKept = false, nearTrim = false;
          for (var a = -1; a <= 1 && !nearKept; a++) for (var b = -1; b <= 1 && !nearKept; b++) for (var e = -1; e <= 1 && !nearKept; e++) {
            var nb = ((i + a + N) % N) * NN + ((j + b + N) % N) * N + ((k + e + N) % N);
            if (kept[nb] > 0.5) nearKept = true; else if (isTrimmed(nb)) nearTrim = true;
          }
          if (!nearKept && nearTrim) continue;
        }
        nSurf++;
        var x = -L + (i + 0.5) * h, y = -L + (j + 0.5) * h, z = -L + (k + 0.5) * h, nIn = 0;
        for (var u = 0; u < ns; u++) for (var v = 0; v < ns; v++) for (var w = 0; w < ns; w++) {
          var val = fn(x + (u + 0.5) * hs - 0.5 * h, y + (v + 0.5) * hs - 0.5 * h, z + (w + 0.5) * hs - 0.5 * h);
          cm[(u * ns + v) * ns + w] = val; if (val > 0) nIn++;
        }
        var m0 = fn(x, y, z);
        var gx = (fn(x + gd, y, z) - fn(x - gd, y, z)) / (2 * gd) * h;
        var gy = (fn(x, y + gd, z) - fn(x, y - gd, z)) / (2 * gd) * h;
        var gz = (fn(x, y, z + gd) - fn(x, y, z - gd)) / (2 * gd) * h;
        var g2 = gx * gx + gy * gy + gz * gz, miss = 0;
        if (g2 > 1e-24) {
          for (var u2 = 0; u2 < ns && miss <= normalMiss; u2++) for (var v2 = 0; v2 < ns; v2++) for (var w2 = 0; w2 < ns; w2++) {
            var pl = m0 + gx * ((u2 + 0.5) / ns - 0.5) + gy * ((v2 + 0.5) / ns - 0.5) + gz * ((w2 + 0.5) / ns - 0.5);
            if ((pl > 0) !== (cm[(u2 * ns + v2) * ns + w2] > 0)) miss++;
          }
        }
        if (g2 > 1e-24 && miss <= normalMiss) {
          nPlane++;
          var gn = Math.sqrt(g2);
          /* flat: the exact plane–cube volume; gently curved: the sampled fraction */
          phi[id] = miss <= planeMiss ? planeCubeSolidFraction(m0, gx, gy, gz) : nIn / (ns * ns * ns);
          nrm[3 * id] = gx / gn; nrm[3 * id + 1] = gy / gn; nrm[3 * id + 2] = gz / gn;
          continue;
        }
        phi[id] = nIn / (ns * ns * ns);                           /* n stays 0: isotropic blend */
      }
    }
  }
  var ps = 0;
  for (var p1 = 0; p1 < N3; p1++) ps += phi[p1];
  res.rhoPhi = ps / N3; res.nSurf = nSurf; res.nPlane = nPlane;
  /* v0.23.0 — wall area of the same slab range (summed by the worker pool) */
  if (opts.area !== false) res.area = marginSurfaceArea(m, N, kept, raw, [iLo, iHi]);
  return res;
}

/* ── v0.23.0 — surface area, pore connectivity ─────────────────────────── */
/* Tetrahedra around the cube diagonal 0–7, corners indexed x + 2y + 4z. */
var MT_TETS = [[0, 7, 1, 3], [0, 7, 3, 2], [0, 7, 2, 6], [0, 7, 6, 4], [0, 7, 4, 5], [0, 7, 5, 1]];
var MT_CX = [0, 1, 0, 1, 0, 1, 0, 1], MT_CY = [0, 0, 1, 1, 0, 0, 1, 1], MT_CZ = [0, 0, 0, 0, 1, 1, 1, 1];

function _mtTriArea(ax, ay, az, bx, by, bz, cx, cy, cz) {
  var ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  var wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(wx * wx + wy * wy + wz * wz);
}

/* Wall area over x-slabs iRange [i0, i1) (default the whole grid), in units
   of the cell edge², on the corner margin grid m (solid ⟺ m > 0, periodic).
   kept / raw: the island-trimmed and raw 0/1 voxels (raw may be null). */
function marginSurfaceArea(m, N, kept, raw, iRange) {
  var NN = N * N, area = 0, c = new Float64Array(8), P = new Float64Array(12);
  var iLo = iRange ? iRange[0] : 0, iHi = iRange ? iRange[1] : N;
  function isTrimmed(id) { return raw && raw[id] > 0.5 && !(kept[id] > 0.5); }
  for (var i = iLo; i < iHi; i++) {
    var i1 = (i + 1) % N;
    for (var j = 0; j < N; j++) {
      var j1 = (j + 1) % N;
      for (var k = 0; k < N; k++) {
        var k1 = (k + 1) % N, id = i * NN + j * N + k;
        /* corner order x + 2y + 4z, with x on i (solver order) */
        c[0] = m[i * NN + j * N + k];   c[1] = m[i1 * NN + j * N + k];
        c[2] = m[i * NN + j1 * N + k];  c[3] = m[i1 * NN + j1 * N + k];
        c[4] = m[i * NN + j * N + k1];  c[5] = m[i1 * NN + j * N + k1];
        c[6] = m[i * NN + j1 * N + k1]; c[7] = m[i1 * NN + j1 * N + k1];
        var pos = 0;
        for (var q = 0; q < 8; q++) if (c[q] > 0) pos++;
        if (pos === 0 || pos === 8) continue;
        if (isTrimmed(id)) continue;
        if (!(kept[id] > 0.5) && raw && raw !== kept) {            /* void next to a removed island only */
          var nearKept = false, nearTrim = false;
          for (var a = -1; a <= 1 && !nearKept; a++) for (var b = -1; b <= 1 && !nearKept; b++) for (var e = -1; e <= 1 && !nearKept; e++) {
            var nb = ((i + a + N) % N) * NN + ((j + b + N) % N) * N + ((k + e + N) % N);
            if (kept[nb] > 0.5) nearKept = true; else if (isTrimmed(nb)) nearTrim = true;
          }
          if (!nearKept && nearTrim) continue;
        }
        for (var t = 0; t < 6; t++) {
          var T = MT_TETS[t], inn = [], out = [];
          for (var v = 0; v < 4; v++) (c[T[v]] > 0 ? inn : out).push(T[v]);
          if (!inn.length || !out.length) continue;
          var np = 0;
          /* crossing points on every inside–outside edge */
          for (var ia = 0; ia < inn.length; ia++) for (var ob = 0; ob < out.length; ob++) {
            var A = inn[ia], B = out[ob], sa = c[A], sb = c[B], f = sa / (sa - sb);
            P[np++] = MT_CX[A] + f * (MT_CX[B] - MT_CX[A]);
            P[np++] = MT_CY[A] + f * (MT_CY[B] - MT_CY[A]);
            P[np++] = MT_CZ[A] + f * (MT_CZ[B] - MT_CZ[A]);
          }
          if (np === 9) area += _mtTriArea(P[0], P[1], P[2], P[3], P[4], P[5], P[6], P[7], P[8]);
          else {
            /* 2 in, 2 out: points (a,c) (a,d) (b,c) (b,d) → quad a-c, a-d, b-d, b-c */
            area += _mtTriArea(P[0], P[1], P[2], P[3], P[4], P[5], P[9], P[10], P[11]);
            area += _mtTriArea(P[0], P[1], P[2], P[9], P[10], P[11], P[6], P[7], P[8]);
          }
        }
      }
    }
  }
  return area / NN;
}

/* Does the pore space (everything the kept solid does not occupy, trimmed
   islands included) run continuously through the cell along each axis? */
function voidOpenAxes(kept, N) {
  var N3 = N * N * N, v = new Uint8Array(N3), any = false;
  for (var p = 0; p < N3; p++) if (!(kept[p] > 0.5)) { v[p] = 1; any = true; }
  if (!any) return { x: false, y: false, z: false, bits: 0 };
  var pc = periodicComponents(v, N), bits = 0;
  for (var c = 1; c <= pc.count; c++) bits |= pc.wraps[c];
  return { x: !!(bits & 1), y: !!(bits & 2), z: !!(bits & 4), bits: bits };
}

/* Geometry metrics for the sweep (no solver): wall area per cell edge²,
   0/1 solid fraction after the trim, and open pore axes.  Porosity for
   reporting comes from the solve's partial-volume solid fraction. */
function designGeometryMetrics(recipe, N, opts) {
  var t0 = linkNowMs(), d = designMarginSetup(recipe, N, opts || {});
  var N3 = N * N * N, solid = 0;
  for (var p = 0; p < N3; p++) if (d.kept[p] > 0.5) solid++;
  return { N: N, area: marginSurfaceArea(d.mg.m, N, d.kept, d.raw), vfKept: solid / N3,
           open: voidOpenAxes(d.kept, N), t_ms: linkNowMs() - t0 };
}

function buildLinkField(recipe, N, opts) {
  opts = opts || {};
  var t0 = linkNowMs(), d = designMarginSetup(recipe, N, opts);
  var out = buildLinkFieldFromFn(d.mg.fn, N, d.kept, d.raw, d.mg.m, opts);
  out.t_ms = linkNowMs() - t0;
  return out;
}

function buildLinkFieldFromFn(fn, N, kept, raw, mCorner, opts) {
  opts = opts || {};
  var L = Math.PI, h = 2 * L / N, NN = N * N, N3 = NN * N;
  var S = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
  var nEx = 0, nMulti = 0, solidSum = 0;
  var tS = new Float64Array(LINK_SAMPLES + 1), mS = new Float64Array(LINK_SAMPLES + 1);
  for (var q = 0; q <= LINK_SAMPLES; q++) tS[q] = q / LINK_SAMPLES;
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
        S[a][id] = (ka ? 0.5 : 0) + (kb ? 0.5 : 0); continue;
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
      if (!cand) { S[a][id] = ka ? 1 : 0; continue; }
      nEx++;
      /* sample the margin along the link; the kept cube fixes the end signs */
      var dx = a === 0 ? h : 0, dy = a === 1 ? h : 0, dz = a === 2 ? h : 0;
      for (var p = 0; p <= LINK_SAMPLES; p++) {
        if (p === 0) { mS[p] = ka ? 1 : -1; continue; }
        if (p === LINK_SAMPLES) { mS[p] = kb ? 1 : -1; continue; }
        mS[p] = fn(x + tS[p] * dx, y + tS[p] * dy, z + tS[p] * dz);
      }
      /* walk the segments: solid length, with each sign change refined by bisection */
      var sLen = 0, tPrev = 0, sPrev = mS[0] > 0, nCross = 0;
      for (var p2 = 1; p2 <= LINK_SAMPLES; p2++) {
        var sNow = mS[p2] > 0;
        if (sNow !== sPrev) {
          nCross++;
          var lo = tS[p2 - 1], hi = tS[p2];
          for (var bs = 0; bs < LINK_BISECT; bs++) {
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
      if (nCross > 1) nMulti++;
    }
  }
  var linkSum = 0;
  for (var a2 = 0; a2 < 3; a2++) for (var n2 = 0; n2 < N3; n2++) linkSum += S[a2][n2];
  return { N: N, kept: kept, raw: raw, s: S, rho: solidSum / N3, rhoLink: linkSum / (3 * N3), nExamined: nEx, nMulti: nMulti };
}

/* Solid fraction of the unit cube u ∈ [−½, ½]³ where m0 + g·u > 0
   (g in margin units per voxel).  Exact plane–cube volume (Scardovelli &
   Zaleski 2000, J. Comput. Phys. 164): with n = |g| and w = u + ½, the
   void part is {n·w ≤ α}, α = Σn/2 − m0, of volume
     [α³ − Σ(α−n_i)₊³ + Σ(α−n_i−n_j)₊³ − (α−Σn)₊³] / (6 n1 n2 n3). */
function planeCubeSolidFraction(m0, gx, gy, gz) {
  var g = Math.sqrt(gx * gx + gy * gy + gz * gz), eps = 1e-6 * g;
  var n1 = Math.max(Math.abs(gx), eps), n2 = Math.max(Math.abs(gy), eps), n3 = Math.max(Math.abs(gz), eps);
  var sum = n1 + n2 + n3, al = 0.5 * (Math.abs(gx) + Math.abs(gy) + Math.abs(gz)) - m0;
  if (al <= 0) return 1;
  if (al >= sum) return 0;
  function c3(v) { return v > 0 ? v * v * v : 0; }
  var vol = (c3(al) - c3(al - n1) - c3(al - n2) - c3(al - n3) + c3(al - n1 - n2) + c3(al - n1 - n3) + c3(al - n2 - n3) - c3(al - sum)) / (6 * n1 * n2 * n3);
  vol = Math.min(1, Math.max(0, vol));
  return 1 - vol;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildVoxelTensors: buildVoxelTensors, voxelTensorsFromMargin: voxelTensorsFromMargin, buildLinkField: buildLinkField,
    buildLinkFieldFromFn: buildLinkFieldFromFn, planeCubeSolidFraction: planeCubeSolidFraction,
    marginSurfaceArea: marginSurfaceArea, voidOpenAxes: voidOpenAxes, designGeometryMetrics: designGeometryMetrics };
}
