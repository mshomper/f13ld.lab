/* ============================================================
   F13LD.lab · 14c-stl-import.js
   STL unit cell → periodic signed-distance grid + import report.

   Pipeline (runs in a worker; also callable on the main thread or
   in node for tests):
     1. parseStl          binary or ASCII → flat triangle array
     2. meshHealth        triangles, open / non-manifold edges, watertight
     3. cell mapping      'fit' — each axis of the bounding box fills the
                          cell (CAD export leaves cubic cells ~1 % off, so
                          sides within 2 % are accepted and stretched);
                          'set' — user cell size, part centered
     4. voxelizeVotes     scanline fill along x, y and z (winding rule),
                          majority vote of the three → solid/void at M³
     5. face match        per axis: how well opposite faces line up
     6. periodic EDT      exact squared Euclidean distance (Felzenszwalb),
                          wrapped — inside and outside
     7. thinnest wall     5th percentile of ridge thickness (2·d_in)
     8. master grid       2×2×2 average of the fine signed distance →
                          n³ (n = M/2), field units, quantized to 8 bits

   Output storage format is described in 13c-import-kernel.js.
   Worker-safe: no DOM access.
   ============================================================ */

var STL_IMPORT_DEFAULTS = {
  units:    'mm',     /* 'mm' | 'in' — STL carries no units */
  cellMode: 'fit',    /* 'fit' | 'set' */
  cellMm:   null,     /* used when cellMode = 'set' */
  M:        256,      /* fine voxelization grid */
  n:        128,      /* stored master grid (M / 2) */
  R:        0.8,      /* signed-distance clamp, field units (cell = 2π) */
  cubicTol: 0.02      /* max side mismatch accepted as a cube in 'fit' mode */
};

/* ── 1. Parse ─────────────────────────────────────────────── */
function parseStl(buffer) {
  var bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
  var len = bytes.byteLength;
  if (len >= 84) {
    var dv = new DataView(bytes);
    var count = dv.getUint32(80, true);
    if (84 + count * 50 === len) {
      var tris = new Float32Array(count * 9);
      for (var t = 0; t < count; t++) {
        var o = 84 + t * 50 + 12;   /* skip the stored normal */
        for (var q = 0; q < 9; q++) tris[t * 9 + q] = dv.getFloat32(o + q * 4, true);
      }
      return { tris: tris, count: count, format: 'binary' };
    }
  }
  var text = (typeof TextDecoder !== 'undefined')
    ? new TextDecoder('utf-8').decode(new Uint8Array(bytes))
    : String.fromCharCode.apply(null, new Uint8Array(bytes));
  if (!/^\s*solid/i.test(text) || !/vertex/i.test(text)) {
    throw new Error('Not a readable STL (neither binary with a matching triangle count nor ASCII with vertices)');
  }
  var re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g, m, vals = [];
  while ((m = re.exec(text)) !== null) vals.push(+m[1], +m[2], +m[3]);
  if (vals.length % 9 !== 0) throw new Error('ASCII STL: vertex count is not a multiple of 3');
  return { tris: new Float32Array(vals), count: vals.length / 9, format: 'ascii' };
}

function stlBounds(tris) {
  var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < tris.length; i += 3) {
    for (var a = 0; a < 3; a++) {
      var v = tris[i + a];
      if (v < mn[a]) mn[a] = v;
      if (v > mx[a]) mx[a] = v;
    }
  }
  return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}

/* ── 2. Mesh health ───────────────────────────────────────── */
/* Vertices are welded on a 2^17 lattice over the bounding box (≈ 40 nm on a
   5 mm cell); edges counted by their welded endpoints. */
function meshHealth(tris, count, bounds) {
  var Q = 131071, mn = bounds.min, sz = bounds.size;
  var inv = [0, 1, 2].map(function (a) { return sz[a] > 0 ? Q / sz[a] : 0; });
  var vid = new Map(), nV = 0, ids = new Int32Array(count * 3), degenerate = 0;
  for (var t = 0; t < count; t++) {
    for (var c = 0; c < 3; c++) {
      var b = t * 9 + c * 3;
      var qx = Math.round((tris[b] - mn[0]) * inv[0]);
      var qy = Math.round((tris[b + 1] - mn[1]) * inv[1]);
      var qz = Math.round((tris[b + 2] - mn[2]) * inv[2]);
      var key = (qx * 131072 + qy) * 131072 + qz;
      var id = vid.get(key);
      if (id === undefined) { id = nV++; vid.set(key, id); }
      ids[t * 3 + c] = id;
    }
    var i0 = ids[t * 3], i1 = ids[t * 3 + 1], i2 = ids[t * 3 + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) degenerate++;
  }
  var edges = new Map();
  for (var t2 = 0; t2 < count; t2++) {
    var e = [ids[t2 * 3], ids[t2 * 3 + 1], ids[t2 * 3 + 2]];
    if (e[0] === e[1] || e[1] === e[2] || e[0] === e[2]) continue;
    for (var k = 0; k < 3; k++) {
      var a0 = e[k], a1 = e[(k + 1) % 3];
      var ek = a0 < a1 ? a0 * 67108864 + a1 : a1 * 67108864 + a0;
      edges.set(ek, (edges.get(ek) || 0) + 1);
    }
  }
  var open = 0, nonManifold = 0;
  edges.forEach(function (n) { if (n === 1) open++; else if (n > 2) nonManifold++; });
  return { triangles: count, vertices: nV, edges: edges.size, openEdges: open,
           nonManifoldEdges: nonManifold, degenerate: degenerate,
           watertight: open === 0 && nonManifold === 0 };
}

/* ── 3. Cell mapping ──────────────────────────────────────── */
/* Where are the cell's faces?  A CAD cell trimmed to its box leaves many
   vertices on each trim plane, but thickening after trimming (or untrimmed
   end-caps) can push some geometry slightly past those planes, so the
   bounding box overstates the cell.  Per axis, the face is the most crowded
   coordinate among vertices within 3 % of each end of the box, when it is
   crowded enough to be a plane; otherwise the box edge is used. */
function stlCellPlanes(tris, bounds) {
  var nV = tris.length / 3, need = Math.max(12, Math.round(nV * 0.001));
  var lo = [], hi = [], found = [[false, false], [false, false], [false, false]];
  for (var a = 0; a < 3; a++) {
    var mn = bounds.min[a], sz = bounds.size[a], band = 0.03 * sz, q = sz > 0 ? 1e5 / sz : 0;
    var cLo = new Map(), cHi = new Map();
    for (var t = a; t < tris.length; t += 3) {
      var v = tris[t];
      if (v < mn + band) { var k = Math.round((v - mn) * q); cLo.set(k, (cLo.get(k) || 0) + 1); }
      else if (v > mn + sz - band) { var k2 = Math.round((v - mn) * q); cHi.set(k2, (cHi.get(k2) || 0) + 1); }
    }
    function best(m) { var bk = null, bn = 0; m.forEach(function (n, k) { if (n > bn) { bn = n; bk = k; } }); return { k: bk, n: bn }; }
    var bl = best(cLo), bh = best(cHi);
    found[a][0] = bl.n >= need; found[a][1] = bh.n >= need;
    lo.push(found[a][0] ? mn + bl.k / q : mn);
    hi.push(found[a][1] ? mn + bh.k / q : bounds.max[a]);
  }
  var overhang = 0;
  for (var a2 = 0; a2 < 3; a2++) overhang = Math.max(overhang, lo[a2] - bounds.min[a2], bounds.max[a2] - hi[a2]);
  return { lo: lo, hi: hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], found: found, overhang: overhang };
}

/* Returns per-axis { off, size } in mm so u = (p − off) / size ∈ [0, 1]. */
function stlCellMapping(cell, s) {
  var sz = cell.size, mx = Math.max(sz[0], sz[1], sz[2]), mnS = Math.min(sz[0], sz[1], sz[2]);
  if (!(mx > 0)) throw new Error('STL has zero size');
  if (s.cellMode === 'set') {
    var L = +s.cellMm;
    if (!(L > 0)) throw new Error('Enter a cell size greater than zero');
    for (var a = 0; a < 3; a++) if (sz[a] > L * 1.01) {
      return { error: 'cellTooSmall', message: 'The part is ' + sz[a].toFixed(3) + ' mm along ' + 'xyz'[a] +
               ', larger than the ' + L.toFixed(3) + ' mm cell.' };
    }
    var center = [0, 1, 2].map(function (a2) { return cell.lo[a2] + sz[a2] / 2; });
    return { off: center.map(function (c) { return c - L / 2; }), size: [L, L, L], cellMm: L,
             mismatch: 0, stretched: false };
  }
  var mismatch = (mx - mnS) / mx;
  if (mismatch > s.cubicTol) {
    return { error: 'notCubic', mismatch: mismatch, sides: sz.slice(),
             message: 'The cell is ' + sz.map(function (v) { return v.toFixed(3); }).join(' × ') +
                      ' mm — sides differ by ' + (mismatch * 100).toFixed(1) + ' %, more than the ' +
                      (s.cubicTol * 100).toFixed(0) + ' % accepted as a cube. Cells with unequal sides are not ' +
                      'supported yet. If the part does not reach every face of its cell, enter the cell size instead.' };
  }
  return { off: cell.lo.slice(), size: sz.slice(), cellMm: mx, mismatch: mismatch, stretched: mismatch > 0 };
}

/* ── 4. Scanline voxelization with three-axis majority vote ─ */
/* Fills votes[idx] += 1 for every voxel center the ray along axis `a` finds
   inside (non-zero winding, so either triangle orientation works and
   overlapping shells union).  U holds normalized coords (cell = [0,1]³). */
function scanAxisVotes(U, nTri, M, a, votes, shift) {
  var b = (a + 1) % 3, c = (a + 2) % 3;
  var sa0 = shift ? shift[a] : 0, sb0 = shift ? shift[b] : 0, sc0 = shift ? shift[c] : 0;
  /* tiny, axis-specific column offsets — keeps rays off shared edges and
     vertices of meshes generated on regular lattices */
  var jitB = [2.137e-6, 3.091e-6, 1.733e-6][a], jitC = [1.451e-6, 2.617e-6, 3.307e-6][a];
  var MM = M * M;
  var counts = new Int32Array(MM + 1);
  function forEachHit(cb) {
    for (var t = 0; t < nTri; t++) {
      var o = t * 9;
      var a0 = U[o + a] + sa0, b0 = U[o + b] + sb0, c0 = U[o + c] + sc0;
      var a1 = U[o + 3 + a] + sa0, b1 = U[o + 3 + b] + sb0, c1 = U[o + 3 + c] + sc0;
      var a2 = U[o + 6 + a] + sa0, b2 = U[o + 6 + b] + sb0, c2 = U[o + 6 + c] + sc0;
      var area = (b1 - b0) * (c2 - c0) - (c1 - c0) * (b2 - b0);   /* = n_a (cyclic a,b,c) */
      if (area === 0) continue;
      var bmin = Math.min(b0, b1, b2), bmax = Math.max(b0, b1, b2);
      var cmin = Math.min(c0, c1, c2), cmax = Math.max(c0, c1, c2);
      var jb0 = Math.max(0, Math.ceil((bmin - jitB) * M - 0.5)), jb1 = Math.min(M - 1, Math.floor((bmax - jitB) * M - 0.5));
      var jc0 = Math.max(0, Math.ceil((cmin - jitC) * M - 0.5)), jc1 = Math.min(M - 1, Math.floor((cmax - jitC) * M - 0.5));
      if (jb0 > jb1 || jc0 > jc1) continue;
      var invA = 1 / area, sgn = area < 0 ? 1 : -1;   /* n_a < 0 → ray enters the solid */
      for (var jb = jb0; jb <= jb1; jb++) {
        var pb = (jb + 0.5) / M + jitB;
        for (var jc = jc0; jc <= jc1; jc++) {
          var pc = (jc + 0.5) / M + jitC;
          var w0 = ((b1 - pb) * (c2 - pc) - (c1 - pc) * (b2 - pb)) * invA;
          if (w0 < 0) continue;
          var w1 = ((b2 - pb) * (c0 - pc) - (c2 - pc) * (b0 - pb)) * invA;
          if (w1 < 0) continue;
          var w2 = 1 - w0 - w1;
          if (w2 < 0) continue;
          cb(jb * M + jc, w0 * a0 + w1 * a1 + w2 * a2, sgn);
        }
      }
    }
  }
  forEachHit(function (col) { counts[col + 1]++; });
  for (var i = 0; i < MM; i++) counts[i + 1] += counts[i];
  var total = counts[MM];
  var pos = new Float32Array(total), sg = new Int8Array(total), fill = counts.slice(0, MM);
  forEachHit(function (col, p, s) { var h = fill[col]++; pos[h] = p; sg[h] = s; });

  var strideOf = [MM, M, 1];
  var sa = strideOf[a], sb = strideOf[b], sc = strideOf[c];
  for (var jb2 = 0; jb2 < M; jb2++) {
    for (var jc2 = 0; jc2 < M; jc2++) {
      var col2 = jb2 * M + jc2, h0 = counts[col2], h1 = counts[col2 + 1];
      if (h0 === h1) continue;
      for (var x = h0 + 1; x < h1; x++) {          /* insertion sort — short lists */
        var pv = pos[x], sv = sg[x], y = x - 1;
        while (y >= h0 && pos[y] > pv) { pos[y + 1] = pos[y]; sg[y + 1] = sg[y]; y--; }
        pos[y + 1] = pv; sg[y + 1] = sv;
      }
      var base = jb2 * sb + jc2 * sc, wind = 0, h = h0;
      /* outside before the first hit and after the last: sweep only between */
      var ia0 = Math.max(0, Math.ceil(pos[h0] * M - 0.5)), ia1 = Math.min(M - 1, Math.floor(pos[h1 - 1] * M - 0.5));
      for (var ia = ia0; ia <= ia1; ia++) {
        var tc = (ia + 0.5) / M;
        while (h < h1 && pos[h] < tc) { wind += sg[h]; h++; }
        if (wind !== 0) votes[base + ia * sa]++;
      }
    }
  }
  return total;
}

/* ── 6. Periodic exact EDT (squared, voxel units) ─────────── */
var EDT_INF = 1e20;

function edt1dInto(f, n, d, v, z) {
  var k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (var q = 1; q < n; q++) {
    var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (var q2 = 0; q2 < n; q2++) {
    while (z[k + 1] < q2) k++;
    var dq = q2 - v[k];
    d[q2] = dq * dq + f[v[k]];
  }
}

/* In place on A (Float32Array M³, 0 at features, EDT_INF elsewhere).
   Each 1D pass runs on the line padded by M/2 wrapped samples per side,
   enough because the periodic distance along an axis never exceeds M/2. */
function periodicEdt3d(A, M) {
  var h = M >> 1, E = 2 * M;
  var f = new Float64Array(E), d = new Float64Array(E), v = new Int32Array(E), z = new Float64Array(E + 1);
  var MM = M * M;
  var wrap = new Int32Array(E);
  for (var t0 = 0; t0 < E; t0++) wrap[t0] = ((t0 - h) % M + M) % M;
  var off = new Int32Array(E);
  function pass(stride, bases) {
    for (var t1 = 0; t1 < E; t1++) off[t1] = wrap[t1] * stride;
    for (var bi = 0; bi < bases.length; bi++) {
      var base = bases[bi], any = false;
      for (var t = 0; t < E; t++) {
        var val = A[base + off[t]];
        f[t] = val; if (val < EDT_INF) any = true;
      }
      if (!any) continue;
      edt1dInto(f, E, d, v, z);
      for (var q = 0; q < M; q++) A[base + q * stride] = Math.min(d[q + h], EDT_INF);
    }
  }
  var bk = [], bj = [], bi2 = [];
  for (var i = 0; i < M; i++) for (var j = 0; j < M; j++) bk.push(i * MM + j * M);
  for (var i2 = 0; i2 < M; i2++) for (var k = 0; k < M; k++) bj.push(i2 * MM + k);
  for (var j2 = 0; j2 < M; j2++) for (var k2 = 0; k2 < M; k2++) bi2.push(j2 * M + k2);
  pass(1, bk); pass(M, bj); pass(MM, bi2);
}

/* ── 5. Face match ────────────────────────────────────────── */
/* Do opposite faces line up?  Across the periodic seam the boundary slices
   M − 1 and 0 are neighbours.  Where the solid differs between them, that is
   expected if the walls at the same spot also move between neighbouring
   slices just inside the cell (a wall meeting the face at a shallow angle
   moves a lot from slice to slice) — and suspicious where they don't.
     seamDiff   = voxels that differ between slices M − 1 and 0
     insideMove = voxels that differ in any of (0,1), (1,2), (M−3,M−2),
                  (M−2,M−1), grown by FACE_TOL voxels
     score      = 1 − |seamDiff outside insideMove| / solid area at the faces
   An off-period cell breaks where the inside is steady, so it scores low.
   (Two earlier versions flagged good CAD sheet cells: a 1-voxel overlap test
   and a whole-face change count; a distance-field version can't see breaks
   because the periodic distance transform smooths across the seam.)
   Also returns the two boundary slices per axis for the report's face view:
   maps[a·M² + p·M + q] bit 0 = solid at face −, bit 1 = solid at face +. */
var FACE_TOL = 3;   /* voxels at 256³ ≈ 0.06 mm on a 5 mm cell — see STL_IMPORT_SCOPE §7 */
function faceMatch(occ, M) {
  var MM = M * M, scores = [], maps = new Uint8Array(3 * MM);
  var r = FACE_TOL, offs = [];
  for (var dp = -r; dp <= r; dp++) for (var dq = -r; dq <= r; dq++) if (dp * dp + dq * dq <= r * r) offs.push(dp, dq);
  function idx(a, s0, p, q) { return a === 0 ? s0 * MM + p * M + q : (a === 1 ? p * MM + s0 * M + q : p * MM + q * M + s0); }
  var pairs = [[0, 1], [1, 2], [M - 3, M - 2], [M - 2, M - 1]];
  for (var a = 0; a < 3; a++) {
    var moved = new Uint8Array(MM), area = 0, base = a * MM;
    for (var p = 0; p < M; p++) for (var q = 0; q < M; q++) {
      var k = p * M + q, x = occ[idx(a, 0, p, q)], y = occ[idx(a, M - 1, p, q)];
      maps[base + k] = (x ? 1 : 0) | (y ? 2 : 0);
      area += x + y;
      for (var pi = 0; pi < pairs.length; pi++) {
        if (occ[idx(a, pairs[pi][0], p, q)] !== occ[idx(a, pairs[pi][1], p, q)]) { moved[k] = 1; break; }
      }
    }
    area /= 2;
    var bad = 0;
    for (var p2 = 0; p2 < M; p2++) for (var q2 = 0; q2 < M; q2++) {
      var m = maps[base + p2 * M + q2];
      if (m !== 1 && m !== 2) continue;            /* same on both faces */
      var ok = false;
      for (var o = 0; o < offs.length && !ok; o += 2) {
        if (moved[((p2 + offs[o] + M) % M) * M + ((q2 + offs[o + 1] + M) % M)]) ok = true;
      }
      if (!ok) bad++;
    }
    scores.push(area > 0 ? Math.max(0, 1 - bad / area) : 1);
  }
  return { scores: scores, maps: maps };
}

/* ── Main entry ───────────────────────────────────────────── */
/* buildImportGridFromStl(buffer, settings, onProgress) →
     { ok:true, bytes, n, R, cellMm, mapping, report }  or  { ok:false, error, message } */
function buildImportGridFromStl(buffer, settings, onProgress) {
  var s = {}, k;
  for (k in STL_IMPORT_DEFAULTS) s[k] = STL_IMPORT_DEFAULTS[k];
  for (k in (settings || {})) if (settings[k] != null) s[k] = settings[k];
  var progUser = onProgress || function () {};
  var T0 = Date.now(), stages = [], _last = T0, _lastName = null;
  function prog(name, frac) {
    var now = Date.now();
    if (_lastName) stages.push([_lastName, now - _last]);
    _last = now; _lastName = name;
    progUser(name, frac);
  }

  prog('Reading STL', 0.02);
  var stl = parseStl(buffer);
  if (!stl.count) return { ok: false, error: 'empty', message: 'The STL contains no triangles.' };
  var scale = s.units === 'in' ? 25.4 : 1;
  var tris = stl.tris;
  if (scale !== 1) { tris = new Float32Array(stl.tris.length); for (var i = 0; i < tris.length; i++) tris[i] = stl.tris[i] * scale; }
  var bounds = stlBounds(tris);

  prog('Checking mesh', 0.06);
  var health = meshHealth(tris, stl.count, bounds);

  var planes = stlCellPlanes(tris, bounds);
  var map = stlCellMapping(planes, s);
  if (map.error) return { ok: false, error: map.error, message: map.message, sides: bounds.size.slice(), mismatch: map.mismatch, bounds: bounds, health: health };

  var nTri = stl.count, U = new Float64Array(nTri * 9);
  for (var t = 0; t < nTri * 9; t += 3) {
    for (var a = 0; a < 3; a++) U[t + a] = (tris[t + a] - map.off[a]) / map.size[a];
  }

  var M = s.M, MM = M * M, M3 = MM * M;
  /* Geometry past a face belongs to the neighbouring cell's side of the seam:
     wrap it periodically by also filling copies shifted ±1 cell along every
     axis where the part pokes out, and keep the union. */
  var umin = [Infinity, Infinity, Infinity], umax = [-Infinity, -Infinity, -Infinity];
  for (var t2 = 0; t2 < nTri * 9; t2 += 3) for (var a3 = 0; a3 < 3; a3++) {
    var uv = U[t2 + a3]; if (uv < umin[a3]) umin[a3] = uv; if (uv > umax[a3]) umax[a3] = uv;
  }
  var EPS = 0.5 / M / 8, shiftsPerAxis = [];
  for (var a4 = 0; a4 < 3; a4++) {
    var sh = [0];
    if (umin[a4] < -EPS) sh.push(1);
    if (umax[a4] > 1 + EPS) sh.push(-1);
    shiftsPerAxis.push(sh);
  }
  var shifts = [];
  shiftsPerAxis[0].forEach(function (x) { shiftsPerAxis[1].forEach(function (y) { shiftsPerAxis[2].forEach(function (z) { shifts.push([x, y, z]); }); }); });
  var occ = new Uint8Array(M3), votes = new Uint8Array(M3);
  var solidCount = 0, touched = 0, split = 0;
  for (var si = 0; si < shifts.length; si++) {
    if (si) votes.fill(0);
    for (var ax = 0; ax < 3; ax++) {
      prog('Filling solid' + (shifts.length > 1 ? ' (' + (si + 1) + '/' + shifts.length + ')' : ' (' + 'xyz'[ax] + ')'),
           0.1 + 0.3 * (si * 3 + ax) / (shifts.length * 3));
      scanAxisVotes(U, nTri, M, ax, votes, shifts[si]);
    }
    for (var v = 0; v < M3; v++) {
      var c = votes[v];
      if (!c) continue;
      touched++; if (c < 3) split++;
      if (c >= 2) occ[v] = 1;
    }
  }
  votes = null; U = null;
  for (var v2 = 0; v2 < M3; v2++) solidCount += occ[v2];
  var density = solidCount / M3;
  if (solidCount === 0) return { ok: false, error: 'empty', message: 'No solid found inside the cell — check the units and that the mesh is closed.', health: health };
  if (solidCount === M3) return { ok: false, error: 'full', message: 'The whole cell came out solid — the mesh may be inverted or open.', health: health };


  /* distance outside (to nearest solid voxel center) */
  prog('Distance field (outside)', 0.48);
  var A = new Float32Array(M3);
  for (var p = 0; p < M3; p++) A[p] = occ[p] ? 0 : EDT_INF;
  periodicEdt3d(A, M);
  var sd = new Float32Array(M3);
  for (var p2 = 0; p2 < M3; p2++) if (!occ[p2]) sd[p2] = Math.sqrt(A[p2]) - 0.5;

  /* distance inside (to nearest void voxel center) */
  prog('Distance field (inside)', 0.66);
  for (var p3 = 0; p3 < M3; p3++) A[p3] = occ[p3] ? EDT_INF : 0;
  periodicEdt3d(A, M);
  for (var p4 = 0; p4 < M3; p4++) if (occ[p4]) sd[p4] = -(Math.sqrt(A[p4]) - 0.5);

  prog('Matching faces', 0.8);
  var fmr = faceMatch(occ, M), fm = fmr.scores;

  /* thinnest wall: centres of maximal inscribed balls — voxels whose d_in is
     at least that of all 26 neighbours (so convex surfaces, voxel staircase
     and the diagonal medial sheets at concave junctions don't count), at
     least 2 fine voxels deep.  Thickness ≈ 2·d_in − 0.5 voxels. */
  prog('Measuring walls', 0.82);
  var ridge = [], nb = [];
  for (var ddi = -1; ddi <= 1; ddi++) for (var ddj = -1; ddj <= 1; ddj++) for (var ddk = -1; ddk <= 1; ddk++)
    if (ddi || ddj || ddk) nb.push([ddi, ddj, ddk]);
  for (var i1 = 0; i1 < M; i1++) {
    for (var j1 = 0; j1 < M; j1++) {
      for (var k1 = 0; k1 < M; k1++) {
        var id = i1 * MM + j1 * M + k1, dv = A[id];
        if (dv < 4 || !occ[id]) continue;
        var isMax = true;
        for (var q = 0; q < 26 && isMax; q++) {
          var o3 = nb[q];
          var ni = (i1 + o3[0] + M) % M, nj = (j1 + o3[1] + M) % M, nk = (k1 + o3[2] + M) % M;
          if (A[ni * MM + nj * M + nk] > dv) isMax = false;
        }
        if (isMax) ridge.push(2 * Math.sqrt(dv) - 0.5);
      }
    }
  }
  ridge.sort(function (x, y) { return x - y; });
  var thinVox = ridge.length ? ridge[Math.floor(ridge.length * 0.05)] : 3.5;   /* none ≥ 2 voxels deep → walls under ~3.5 fine voxels */
  var medVox = ridge.length ? ridge[Math.floor(ridge.length * 0.5)] : 0;
  var thinMm = thinVox * map.cellMm / M, medMm = medVox * map.cellMm / M;
  A = null;

  /* master grid: 2×2×2 (or f×f×f) average of the fine signed distance */
  prog('Packing grid', 0.92);
  var n = s.n, f = M / n;
  if (f !== Math.floor(f)) throw new Error('fine grid must be a multiple of the stored grid');
  var toField = 2 * Math.PI / M, R = s.R, nn = n * n;
  var bytes = new Uint8Array(n * n * n), inv = 1 / (f * f * f);
  for (var I = 0; I < n; I++) for (var J = 0; J < n; J++) for (var K = 0; K < n; K++) {
    var acc = 0;
    for (var di = 0; di < f; di++) for (var dj = 0; dj < f; dj++) for (var dk = 0; dk < f; dk++) {
      acc += sd[(I * f + di) * MM + (J * f + dj) * M + (K * f + dk)];
    }
    var dfield = acc * inv * toField;
    if (dfield > R) dfield = R; else if (dfield < -R) dfield = -R;
    bytes[I * nn + J * n + K] = Math.round(dfield / R * 127.5 + 127.5);
  }

  prog('Done', 1);
  return {
    ok: true, bytes: bytes, n: n, R: R, cellMm: map.cellMm, faceMaps: fmr.maps, fineM: M,
    mapping: { off: map.off, size: map.size, mode: s.cellMode },
    report: {
      format: stl.format, units: s.units,
      bounds: { min: bounds.min, max: bounds.max, size: bounds.size },
      cellMm: map.cellMm, cellMode: s.cellMode,
      facesFromPlanes: planes.found.every(function (f) { return f[0] && f[1]; }), overhangMm: planes.overhang,
      mismatch: map.mismatch, stretched: map.stretched,
      density: density,
      faceMatch: fm,
      fillAgreement: touched ? 1 - split / touched : 1,
      thinnestWallMm: thinMm, medianWallMm: medMm,
      health: health,
      fineM: M, ms: Date.now() - T0, stages: stages
    }
  };
}

/* Worker message body (string; the page wraps it in a Blob worker that
   importScripts this file). */
var STL_IMPORT_WORKER_ONMESSAGE =
  'onmessage = function(e){\n' +
  '  var job = e.data;\n' +
  '  try {\n' +
  '    var r = buildImportGridFromStl(job.buffer, job.settings, function(stage, frac){ postMessage({ type:"progress", stage:stage, frac:frac }); });\n' +
  '    if (r.ok) postMessage({ type:"done", result:r }, [r.bytes.buffer, r.faceMaps.buffer]);\n' +
  '    else postMessage({ type:"done", result:r });\n' +
  '  } catch (err){ postMessage({ type:"error", message:(err && err.message) || String(err) }); }\n' +
  '};\n';

/* node/test harness export (browser ignores this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STL_IMPORT_DEFAULTS: STL_IMPORT_DEFAULTS, parseStl: parseStl, stlBounds: stlBounds,
    meshHealth: meshHealth, stlCellPlanes: stlCellPlanes, stlCellMapping: stlCellMapping, scanAxisVotes: scanAxisVotes,
    periodicEdt3d: periodicEdt3d, faceMatch: faceMatch, buildImportGridFromStl: buildImportGridFromStl
  };
}
