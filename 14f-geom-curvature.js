/* ============================================================
   F13LD.lab · 14f-geom-curvature.js
   v0.36.0 — curvature of the viewer's field, worker-safe (no WebGL, no DOM), so the page (21, the
   Curvature view) and the geometry pool (17c, the per-design tightest radius) use the same code.
   Moved here unchanged from 21-raymarcher.js (v0.35.0 / v0.35.1):
     labBakeCurvature(d, N)                  mean and Gaussian curvature per voxel
     labBakeCompDistance(d, dB, N, u)        PI-TPMS / normalized-shell distance on the grid
     labBakeCompCurvature(d, dB, N, u)       the c-variant curvature texture
   New in v0.36.0:
     geomTightestRadius(d, dB, N, u)         tightest bend radius over the drawn surface
   u is a tile's uniforms (topoMode, isoLevel, thickness, halfInvert, pipeR, pipeOffset, normMode,
   pairMode).  Checks: node proto/geom-views/curvature_check.js, node proto/geom-views/numbers_check.js
   ============================================================ */

/* Mean and Gaussian curvature of the level set through each voxel (world units), from the 32-bit
   field, with one-texel periodic differences.  Differencing the stored texture in the shader speckles:
   a filtered R16F sample is off by about 0.0006 field units (measured, Matt's GPU) and a second
   difference magnifies that to about 5 % of a ±0.5 /mm scale.  Not smoothed: one texel is the sharpest
   stencil the grid has.  Clamped at what the grid can show, so a saddle of the field (zero gradient)
   does not bleed into its neighbours.  proto/geom-views/curvature_check.js */
function labBakeCurvature(d, N) {
  var out = new Float32Array(2 * N * N * N), h = 2 * Math.PI / N, N2 = N * N;
  var i2 = 1 / (h * h), i4 = 0.25 * i2, i1 = 0.5 / h, capH = 1 / h, capK = 1 / (h * h);
  var ip = new Int32Array(N), im = new Int32Array(N), o = 0;
  for (var a = 0; a < N; a++) { ip[a] = (a + 1) % N; im[a] = (a + N - 1) % N; }
  for (var k = 0; k < N; k++) {
    var kp = ip[k] * N2, km = im[k] * N2, k0 = k * N2;
    for (var j = 0; j < N; j++) {
      var jp = ip[j] * N, jm = im[j] * N, j0 = j * N;
      for (var i = 0; i < N; i++, o += 2) {
        var xp = ip[i], xm = im[i], f0 = d[i + j0 + k0];
        var vxp = d[xp + j0 + k0], vxm = d[xm + j0 + k0], vyp = d[i + jp + k0], vym = d[i + jm + k0], vzp = d[i + j0 + kp], vzm = d[i + j0 + km];
        var gx = (vxp - vxm) * i1, gy = (vyp - vym) * i1, gz = (vzp - vzm) * i1;
        var xx = (vxp - 2 * f0 + vxm) * i2, yy = (vyp - 2 * f0 + vym) * i2, zz = (vzp - 2 * f0 + vzm) * i2;
        var xy = (d[xp + jp + k0] - d[xp + jm + k0] - d[xm + jp + k0] + d[xm + jm + k0]) * i4;
        var xz = (d[xp + j0 + kp] - d[xp + j0 + km] - d[xm + j0 + kp] + d[xm + j0 + km]) * i4;
        var yz = (d[i + jp + kp] - d[i + jp + km] - d[i + jm + kp] + d[i + jm + km]) * i4;
        var g2 = Math.max(gx * gx + gy * gy + gz * gz, 1e-6), g = Math.sqrt(g2);
        var gHg = gx * gx * xx + gy * gy * yy + gz * gz * zz + 2 * (gx * gy * xy + gx * gz * xz + gy * gz * yz);
        var Hm = (g2 * (xx + yy + zz) - gHg) / (2 * g2 * g);
        var K = (gx * gx * (yy * zz - yz * yz) + gy * gy * (xx * zz - xz * xz) + gz * gz * (xx * yy - xy * xy) + 2 * (gx * gy * (xz * yz - xy * zz) + gy * gz * (xy * xz - yz * xx) + gx * gz * (xy * yz - xz * yy))) / (g2 * g2);
        out[o] = Math.max(-capH, Math.min(capH, Hm));
        out[o + 1] = Math.max(-capK, Math.min(capK, K));
      }
    }
  }
  return out;
}

/* v0.35.1 — the distance the small shader's implicit0 draws for PI-TPMS and normalized shells (the
   c variants), on the field's own grid, from the 32-bit field(s) instead of the R16F texture.  Same
   formulas and clamps as implicit0; the gradient is the one-texel periodic difference of the field.
   The PI partner (field sampled at p + pipe offset) is a periodic trilinear resample at a constant
   offset, so its weights are the same at every voxel.  PI: negative inside the solid and growing out
   of it, so labBakeCurvature's outward normal already points out of the solid.  Normalized shells: see
   below.  Plain PI returns field B on this grid instead.  dB: field B (pair mode). */
function labBakeCompDistance(d, dB, N, u) {
  var N2 = N * N, N3 = N2 * N, h = 2 * Math.PI / N, i1 = 0.5 / h, a, o;
  var ip = new Int32Array(N), im = new Int32Array(N);
  for (a = 0; a < N; a++) { ip[a] = (a + 1) % N; im[a] = (a + N - 1) % N; }
  function grad(src) {
    var g = new Float32Array(3 * N3), q = 0;
    for (var k = 0; k < N; k++) for (var j = 0; j < N; j++) for (var i = 0; i < N; i++, q += 3) {
      var c = i + j * N + k * N2;
      g[q]     = (src[ip[i] + j * N + k * N2] - src[im[i] + j * N + k * N2]) * i1;
      g[q + 1] = (src[i + ip[j] * N + k * N2] - src[i + im[j] * N + k * N2]) * i1;
      g[q + 2] = (src[c - k * N2 + ip[k] * N2] - src[c - k * N2 + im[k] * N2]) * i1;
    }
    return g;
  }
  /* src (ch channels per voxel) read at every voxel centre + off (world units), trilinear, periodic */
  function shifted(src, ch, off) {
    var out = new Float32Array(ch * N3), s = [], w = [], q = 0;
    for (var ax = 0; ax < 3; ax++) { var t = off[ax] / h, f = Math.floor(t); s.push(((f % N) + N) % N); w.push(t - f); }
    for (var k = 0; k < N; k++) {
      var k0 = ((k + s[2]) % N) * N2, k1 = ((k + s[2] + 1) % N) * N2;
      for (var j = 0; j < N; j++) {
        var j0 = ((j + s[1]) % N) * N, j1 = ((j + s[1] + 1) % N) * N;
        for (var i = 0; i < N; i++, q += ch) {
          var i0 = (i + s[0]) % N, i1b = (i + s[0] + 1) % N;
          var p000 = ch * (i0 + j0 + k0), p100 = ch * (i1b + j0 + k0), p010 = ch * (i0 + j1 + k0), p110 = ch * (i1b + j1 + k0);
          var p001 = ch * (i0 + j0 + k1), p101 = ch * (i1b + j0 + k1), p011 = ch * (i0 + j1 + k1), p111 = ch * (i1b + j1 + k1);
          for (var c = 0; c < ch; c++) {
            var x00 = src[p000 + c] + (src[p100 + c] - src[p000 + c]) * w[0], x10 = src[p010 + c] + (src[p110 + c] - src[p010 + c]) * w[0];
            var x01 = src[p001 + c] + (src[p101 + c] - src[p001 + c]) * w[0], x11 = src[p011 + c] + (src[p111 + c] - src[p011 + c]) * w[0];
            var y0 = x00 + (x10 - x00) * w[1], y1 = x01 + (x11 - x01) * w[1];
            out[q + c] = y0 + (y1 - y0) * w[2];
          }
        }
      }
    }
    return out;
  }
  var out = new Float32Array(N3), iso = u.isoLevel || 0, gA = grad(d), q3;
  if (u.topoMode > 2.5) {
    var pair = u.pairMode > 0.5 && dB, off = u.pipeOffset || [0, 0, 0], R = u.pipeR || 0;
    var fB = pair ? dB : shifted(d, 1, off), norm = u.normMode > 1.5;
    if (!norm) return fB;   /* plain PI: field B on this grid (labBakeCompCurvature bakes each face) */
    var gB = pair ? grad(dB) : shifted(gA, 3, off);
    for (o = 0, q3 = 0; o < N3; o++, q3 += 3) {
      var A = d[o] - iso, B = pair ? fB[o] : fB[o] - iso;
      var ax_ = gA[q3], ay = gA[q3 + 1], az = gA[q3 + 2], bx = gB[q3], by = gB[q3 + 1], bz = gB[q3 + 2];
      var mA = Math.max(Math.sqrt(ax_ * ax_ + ay * ay + az * az), 0.08), mB = Math.max(Math.sqrt(bx * bx + by * by + bz * bz), 0.08);
      var dA = A / mA, dB2 = B / mB, ca = Math.max(-0.95, Math.min(0.95, (ax_ * bx + ay * by + az * bz) / (mA * mB)));
      out[o] = Math.sqrt(Math.max(dA * dA - 2 * ca * dA * dB2 + dB2 * dB2, 0) / (1 - ca * ca)) - R;
    }
  } else {
    /* Normalized shell: the signed distance from the mid-surface, without the fold that |…| - thickness
       puts at the mid-surface (a one-texel stencil crosses it on thin shells).  Both skins are level
       sets of it; the shader flips the sign on the negative side, as for plain shells. */
    for (o = 0, q3 = 0; o < N3; o++, q3 += 3) {
      var gx = gA[q3], gy = gA[q3 + 1], gz = gA[q3 + 2];
      out[o] = (d[o] - iso) / Math.max(Math.sqrt(gx * gx + gy * gy + gz * gz), 0.08);
    }
  }
  return out;
}

/* v0.35.1 — the curvature texture for the c variants.  Normalized PI and normalized shells: curvature
   of labBakeCompDistance, two channels.  Plain PI: its pipe is square in section, each face a level set
   of field A or field B, and the edges between faces are real creases; a stencil across an edge reads
   nonsense, so bake each field on its own (A in rg, B in ba) and let the shader read the face it is on. */
function labBakeCompCurvature(d, dB, N, u) {
  if (u.topoMode > 2.5 && !(u.normMode > 1.5)) {
    var cA = labBakeCurvature(d, N), cB = labBakeCurvature(labBakeCompDistance(d, dB, N, u), N), N3 = N * N * N, out = new Float32Array(4 * N3);
    for (var o = 0; o < N3; o++) { out[4 * o] = cA[2 * o]; out[4 * o + 1] = cA[2 * o + 1]; out[4 * o + 2] = cB[2 * o]; out[4 * o + 3] = cB[2 * o + 1]; }
    return { data: out, rgba: true };
  }
  return { data: labBakeCurvature(labBakeCompDistance(d, dB, N, u), N), rgba: false };
}

/* True when a tile draws with the c variants (PI-TPMS, normalized shells): the test in 21 _viewSet. */
function labGeomIsComp(u) {
  return !(u.topoMode < 2.5 && !(u.topoMode < 0.5 && u.normMode > 0.5 && u.normMode < 1.5));
}

/* v0.36.0 — tightest bend radius of the drawn surface (decision 0010: the 5th percentile, so one
   stray voxel does not set it).  The surface is where the shader's implicit0 changes sign between two
   neighbouring voxels; at each crossing the largest principal curvature |H| + √(H² − K) is
   interpolated along that edge from the same bake the Curvature view shows.  Returns radii in world
   units (× cell mm / 2π for mm): r5 = the 5th-percentile radius, r0 = the smallest, n = crossings.
   Limited by the grid: radii under about one voxel read as one voxel. */
function geomTightestRadius(d, dB, N, u) {
  var N2 = N * N, N3 = N2 * N, iso = u.isoLevel || 0, T = u.thickness || 0, o;
  var comp = labGeomIsComp(u), plainPI = u.topoMode > 2.5 && !(u.normMode > 1.5);
  var bk = comp ? labBakeCompCurvature(d, dB, N, u) : { data: labBakeCurvature(d, N), rgba: false };
  var C = bk.data, st = bk.rgba ? 4 : 2, imp = new Float32Array(N3), km = new Float32Array(N3);
  var aux = comp ? labBakeCompDistance(d, dB, N, u) : null, pair = u.pairMode > 0.5 && dB;
  for (o = 0; o < N3; o++) {
    var ch = 0, adj = d[o] - iso;
    if (!comp) {
      imp[o] = u.topoMode < 0.5 ? Math.abs(adj) - T : (u.topoMode < 1.5 ? (u.halfInvert < 0.5 ? -adj : adj) : T - Math.abs(adj));
    } else if (plainPI) {
      var b = pair ? aux[o] : aux[o] - iso;
      imp[o] = Math.max(Math.abs(adj), Math.abs(b)) - (u.pipeR || 0);
      if (Math.abs(b) > Math.abs(adj)) ch = 2;   /* on a B face: read B's curvature */
    } else if (u.topoMode > 2.5) {
      imp[o] = aux[o];                           /* normalized PI: tube distance − r */
    } else {
      imp[o] = Math.abs(aux[o]) - T;             /* normalized shell */
    }
    var H = C[st * o + ch], K = C[st * o + ch + 1];
    km[o] = Math.abs(H) + Math.sqrt(Math.max(H * H - K, 0));
  }
  var ks = [];
  for (var k = 0; k < N; k++) for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) {
    o = i + j * N + k * N2;
    var v0 = imp[o];
    for (var q = 0; q < 3; q++) {
      var p = q === 0 ? ((i + 1) % N) + j * N + k * N2 : (q === 1 ? i + ((j + 1) % N) * N + k * N2 : i + j * N + ((k + 1) % N) * N2);
      var v1 = imp[p];
      if ((v0 < 0) !== (v1 < 0)) { var t = v0 / (v0 - v1); ks.push(km[o] + (km[p] - km[o]) * t); }
    }
  }
  if (!ks.length) return { r5: null, r0: null, n: 0 };
  ks.sort(function (p, r) { return r - p; });   /* largest curvature first */
  var k5 = ks[Math.floor(ks.length * 0.05)], k0 = ks[0];
  return { r5: k5 > 1e-9 ? 1 / k5 : Infinity, r0: k0 > 1e-9 ? 1 / k0 : Infinity, n: ks.length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { labBakeCurvature: labBakeCurvature, labBakeCompDistance: labBakeCompDistance, labBakeCompCurvature: labBakeCompCurvature,
                     labGeomIsComp: labGeomIsComp, geomTightestRadius: geomTightestRadius };
}
