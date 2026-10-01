/* ============================================================
   F13LD.lab · 14d-voxel-stats.js
   Geometry checks for the parameter sweep (62-sweep.js), worker-safe.

   sweepGeometryStats(recipe, N, connectivity)
     Voxelizes a recipe exactly as the elastic solver does (buildVoxels +
     the lab's island trim) and reports, without solving:
       vf_raw, vf_trim      solid fraction before / after island trim
       spans {x,y,z}        does the kept solid run continuously across
                            the cell along each axis (a load path)
       networks, islands    kept networks / floating pieces
       thinVox, medVox      thinnest (5th percentile) and median feature
                            thickness in voxels at this grid, from the
                            centers of maximal inscribed balls of the
                            periodic distance transform (2·d + 0.5;
                            within ~±1 voxel on struts of known size)

   sweepThresholdField(recipe, key, N)
     For parameters where "solid" is a threshold on a per-voxel scalar
     (solid ⟺ s < t), returns { s, toParam } so the parameter value that
     gives an exact voxel solid fraction at grid N is a quantile of s.
     Mirrors buildVoxels' per-mode tests, including the gradient-normalized
     PI-TPMS and shell distances (constants copied from 14-rasterizer.js —
     keep in sync); the sweep then re-voxelizes every result to confirm.

   Requires 13-kernels (KERNELS), 14-rasterizer (buildVoxels,
   resolveBuildArgs), 14a-connectivity (periodicComponents,
   pruneToNetworks, pruneToLargestComponent), 14c-stl-import
   (periodicEdt3d, EDT_INF), and 13c for imported cells.
   ============================================================ */

function sweepGeometryStats(recipe, N, connectivity) {
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args = resolveBuildArgs(recipe);
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  var N3 = N * N * N, raw = 0;
  for (var i = 0; i < N3; i++) raw += solid[i];
  var conn = connectivity || 'networks';
  var kept = solid;
  if (conn === 'networks') kept = pruneToNetworks(solid, N);
  else if (conn === 'largest') kept = pruneToLargestComponent(solid, N);
  var trim = 0;
  for (var j = 0; j < N3; j++) trim += kept[j];
  var out = { N: N, vf_raw: raw / N3, vf_trim: trim / N3, spans: { x: false, y: false, z: false },
              networks: 0, islands: 0, thinVox: null, medVox: null };
  if (!trim) return out;
  var pc = periodicComponents(kept, N), bits = 0;
  for (var c = 1; c <= pc.count; c++) { if (pc.wraps[c]) { out.networks++; bits |= pc.wraps[c]; } else out.islands++; }
  out.spans = { x: !!(bits & 1), y: !!(bits & 2), z: !!(bits & 4) };
  if (trim < N3) {
    var ft = sweepFeatureThickness(kept, N);
    out.thinVox = ft.thin; out.medVox = ft.med;
  }
  return out;
}

/* Thickness at maximal-ball centers of the inside distance transform. */
function sweepFeatureThickness(solid, N) {
  var N3 = N * N * N, NN = N * N, A = new Float32Array(N3);
  for (var i = 0; i < N3; i++) A[i] = solid[i] ? EDT_INF : 0;
  periodicEdt3d(A, N);
  var nb = [];
  for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) for (var c = -1; c <= 1; c++) if (a || b || c) nb.push([a, b, c]);
  var vals = [];
  for (var x = 0; x < N; x++) for (var y = 0; y < N; y++) for (var z = 0; z < N; z++) {
    var id = x * NN + y * N + z, dv = A[id];
    if (!solid[id] || dv < 1) continue;
    var isMax = true;
    for (var q = 0; q < 26 && isMax; q++) {
      var o = nb[q];
      if (A[((x + o[0] + N) % N) * NN + ((y + o[1] + N) % N) * N + ((z + o[2] + N) % N)] > dv) isMax = false;
    }
    if (isMax) vals.push(2 * Math.sqrt(dv) + 0.5);
  }
  if (!vals.length) return { thin: 1, med: 1 };
  vals.sort(function (p, r) { return p - r; });
  return { thin: vals[Math.floor(vals.length * 0.05)], med: vals[Math.floor(vals.length * 0.5)] };
}

/* ── Threshold fields for solid-fraction targeting ────────── */
function sweepThresholdField(recipe, key, N) {
  var family = recipe.family, g = recipe.geometry || {}, mode = g.mode || 'solid';
  var params = KERNELS[family].parseRecipe(recipe);
  var args = resolveBuildArgs(recipe);
  var L = Math.PI, step = 2 * L / N, N3 = N * N * N;
  var kernel = KERNELS[family];
  function ev(x, y, z) { return kernel.evaluate(params, x, y, z); }
  /* same constants as buildVoxels (14-rasterizer.js) */
  var NORM_E = 0.012, NORM_EPS = 0.08, NORM_COSCLAMP = 0.95, INV2E = 1 / (2 * NORM_E);
  function grad(ax, ay, az) {
    var gx = (ev(ax + NORM_E, ay, az) - ev(ax - NORM_E, ay, az)) * INV2E;
    var gy = (ev(ax, ay + NORM_E, az) - ev(ax, ay - NORM_E, az)) * INV2E;
    var gz = (ev(ax, ay, az + NORM_E) - ev(ax, ay, az - NORM_E)) * INV2E;
    return { gx: gx, gy: gy, gz: gz, mag: Math.sqrt(gx * gx + gy * gy + gz * gz) };
  }
  var s = new Float32Array(N3), toParam = null, idx = 0;
  function each(fn) {
    idx = 0;
    for (var i = 0; i < N; i++) { var x = -L + (i + 0.5) * step;
      for (var j = 0; j < N; j++) { var y = -L + (j + 0.5) * step;
        for (var k = 0; k < N; k++) { var z = -L + (k + 0.5) * step; s[idx++] = fn(x, y, z); } } }
  }
  if (family === 'import' && key === 'wallOffsetMm') {
    var cell = g.cellSizeMm || 5;
    each(ev); toParam = function (t) { return t * cell / (2 * Math.PI); };
  } else if (family === 'tpms' && mode === 'solid' && key === 'offset') {
    each(ev); toParam = function (t) { return t; };
  } else if (family === 'tpms' && mode === 'shell' && key === 'wallThickness' && !args.nWeights) {
    var off = args.offset;
    if (params.shellNorm) each(function (x, y, z) { return Math.abs(ev(x, y, z) - off) / Math.max(grad(x, y, z).mag, NORM_EPS); });
    else each(function (x, y, z) { return Math.abs(ev(x, y, z) - off); });
    toParam = function (t) { return t; };
  } else if (family === 'tpms' && mode === 'pi-tpms' && key === 'wall_ratio') {
    var ps = args.phaseShift || {}, TP = 2 * Math.PI;
    var dx = (ps.x || 0) * TP, dy = (ps.y || 0) * TP, dz = (ps.z || 0) * TP;
    if (params.piNorm) {
      each(function (x, y, z) {
        var a = ev(x, y, z), b = ev(x + dx, y + dy, z + dz);
        var gA = grad(x, y, z), gB = grad(x + dx, y + dy, z + dz);
        var mA = Math.max(gA.mag, NORM_EPS), mB = Math.max(gB.mag, NORM_EPS);
        var dA = a / mA, dB = b / mB;
        var cs = (gA.gx * gB.gx + gA.gy * gB.gy + gA.gz * gB.gz) / (mA * mB);
        if (cs > NORM_COSCLAMP) cs = NORM_COSCLAMP; if (cs < -NORM_COSCLAMP) cs = -NORM_COSCLAMP;
        return Math.sqrt(Math.max(dA * dA - 2 * cs * dA * dB + dB * dB, 0) / (1 - cs * cs));
      });
    } else each(function (x, y, z) { return Math.max(Math.abs(ev(x, y, z)), Math.abs(ev(x + dx, y + dy, z + dz))); });
    toParam = function (t) { return t / Math.PI; };   /* pipeR = wall_ratio · π */
  } else if ((family === 'grain' || family === 'noise') && (key === 'half_width' || key === 'center')) {
    var iso = params.isoLevel, hw = params.halfWidth, inv = !!params.halfInvert;
    var sheet = /-sheet$/.test(mode), half = /-half$/.test(mode), anti = /-solid$/.test(mode);
    if (key === 'half_width' && sheet) { each(function (x, y, z) { return Math.abs(ev(x, y, z) - iso); }); toParam = function (t) { return t; }; }
    else if (key === 'half_width' && anti) { each(function (x, y, z) { return -Math.abs(ev(x, y, z) - iso); }); toParam = function (t) { return -t; }; }
    else if (key === 'center' && half) {
      if (inv) { each(ev); toParam = function (t) { return t; }; }
      else { each(function (x, y, z) { return -ev(x, y, z); }); toParam = function (t) { return -t; }; }
    }
  }
  if (!toParam) return null;
  return { s: s, toParam: toParam };
}

/* Parameter values giving each target voxel solid fraction (before trim).
   The threshold sits midway between neighbouring sorted values so exactly
   round(f · N³) voxels are solid. */
function sweepParamsForFractions(recipe, key, N, fractions) {
  var tf = sweepThresholdField(recipe, key, N);
  if (!tf) return null;
  var sorted = Float32Array.from(tf.s).sort(), n = sorted.length;
  return fractions.map(function (f) {
    var k = Math.round(Math.max(0, Math.min(1, f)) * n);
    var t = k <= 0 ? sorted[0] - 1e-6 : (k >= n ? sorted[n - 1] + 1e-6 : 0.5 * (sorted[k - 1] + sorted[k]));
    return tf.toParam(t);
  });
}

function sweepTargetable(recipe, key) {
  var fam = recipe.family, g = recipe.geometry || {}, mode = g.mode || 'solid';
  if (fam === 'import') return key === 'wallOffsetMm';
  if (fam === 'tpms') return (mode === 'solid' && key === 'offset') || (mode === 'shell' && key === 'wallThickness' && !g.nWeights) ||
                             (mode === 'pi-tpms' && key === 'wall_ratio');
  if (fam === 'grain' || fam === 'noise') return (key === 'half_width' && /-(sheet|solid)$/.test(mode)) || (key === 'center' && /-half$/.test(mode));
  return false;
}

/* Worker body for the sweep's geometry worker. */
var SWEEP_WORKER_ONMESSAGE =
  'onmessage = function(e){\n' +
  '  var m = e.data;\n' +
  '  try {\n' +
  '    if (m.importGrid) registerImportGrid(m.importGrid);\n' +
  '    if (m.type === "stats") postMessage({ id: m.id, ok: true, stats: sweepGeometryStats(m.recipe, m.N, m.connectivity) });\n' +
  '    else if (m.type === "target") postMessage({ id: m.id, ok: true, values: sweepParamsForFractions(m.recipe, m.key, m.N, m.fractions) });\n' +
  '  } catch (err){ postMessage({ id: m.id, ok: false, message: (err && err.message) || String(err) }); }\n' +
  '};\n';

/* node/test harness export (browser ignores this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sweepGeometryStats: sweepGeometryStats, sweepFeatureThickness: sweepFeatureThickness,
    sweepThresholdField: sweepThresholdField, sweepParamsForFractions: sweepParamsForFractions, sweepTargetable: sweepTargetable };
}
