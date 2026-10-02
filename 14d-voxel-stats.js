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

/* ── Sweep parameter catalogue (v0.11.0) ─────────────────────
   A parameter is described by data, not code, so the page and the
   geometry worker apply it identically:
     { key, label, unit, apply: [{ p: 'geometry.pipeR', k: π }], def,
       target: 'threshold' | 'monotone' | null, hint: [lo, hi], group }
   Setting value v writes v·k to every path in apply; reading divides
   the first path by its k.  'threshold' = solid is a threshold on a
   per-voxel quantity (exact solid-fraction targeting); 'monotone' =
   solid grows steadily with the value (targeted by bisection); null =
   value only (shifts, twists, pitches …). */
function sweepGetPath(o, path) {
  var parts = path.split('.'), cur = o;
  for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
  return cur;
}
function sweepSetPath(o, path, v) {
  var parts = path.split('.'), cur = o;
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
}
function sweepParamGet(recipe, spec) {
  var a = spec.apply[0], v = sweepGetPath(recipe, a.p);
  if (typeof v !== 'number' || !isFinite(v)) return spec.def != null ? spec.def : 0;
  return v / (a.k || 1);
}
function sweepParamSet(recipe, spec, v) {
  if (spec.integer) v = Math.max(1, Math.round(v));
  for (var i = 0; i < spec.apply.length; i++) sweepSetPath(recipe, spec.apply[i].p, v * (spec.apply[i].k || 1));
}

function sweepParamCatalog(recipe) {
  var fam = recipe.family, g = recipe.geometry || {}, mode = g.mode || 'solid', out = [], TWO_PI = 2 * Math.PI;
  function add(spec) { spec.group = spec.group || 'curated'; out.push(spec); }
  function geo(name, label, unit, def, target, hint) {
    add({ key: 'geometry.' + name, label: label, unit: unit || '', def: def, target: target || null, hint: hint || null,
          apply: [{ p: 'geometry.' + name, k: 1 }] });
  }
  var offsetSpec = { key: 'offset', label: 'Uniform wall offset', unit: '× cell', def: 0, target: 'threshold', hint: [-0.1, 0.1],
                     apply: [{ p: 'geometry.offset', k: TWO_PI }], thresholdPath: 'geometry.offset' };
  if (fam === 'import') {
    var cell = g.cellSizeMm || 5;
    add({ key: 'wallOffsetMm', label: 'Wall offset', unit: 'mm', def: 0, target: 'threshold', hint: [-0.1 * cell, 0.1 * cell],
          apply: [{ p: 'geometry.wallOffsetMm', k: 1 }, { p: 'geometry.offset', k: TWO_PI / cell }], thresholdPath: 'geometry.offset' });
  } else if (fam === 'tpms') {
    if (mode === 'pi-tpms') {
      add({ key: 'wall_ratio', label: 'Wall ratio (tube diameter ÷ cell)', unit: '', def: 0.1 / Math.PI, target: 'threshold', hint: [0.01, 0.6],
            apply: [{ p: 'geometry.pipeR', k: Math.PI }], thresholdPath: 'geometry.pipeR' });
      ['x', 'y', 'z'].forEach(function (a) {
        add({ key: 'shift_' + a, label: 'Shift ' + a, unit: 'cycles', def: 0, target: null, apply: [{ p: 'geometry.phaseShift.' + a, k: 1 }] });
      });
      /* v0.13.0 — field B frequency (whole-number multiple of field A; 1 = classic PI-TPMS).
         integer: values are rounded when applied, builder defaults to 1…4. */
      add({ key: 'fieldBFreq', label: 'Field B frequency (whole multiple of A)', unit: '×', def: 1, target: null, hint: [1, 4],
            integer: true, apply: [{ p: 'geometry.fieldBFreq', k: 1 }] });
    } else if (mode === 'shell') {
      add({ key: 'wallThickness', label: 'Sheet half-thickness (level c)', unit: '', def: 0.3, target: 'threshold', hint: [0.01, 1.5],
            apply: [{ p: 'geometry.wallThickness', k: 1 }], thresholdPath: 'geometry.wallThickness' });
      add({ key: 'offset', label: 'Level offset', unit: '', def: 0, target: null, apply: [{ p: 'geometry.offset', k: 1 }] });
    } else {
      add({ key: 'offset', label: 'Level (solid where field < level)', unit: '', def: 0, target: 'threshold', hint: [-3, 3],
            apply: [{ p: 'geometry.offset', k: 1 }], thresholdPath: 'geometry.offset' });
    }
  } else if (fam === 'grain' || fam === 'noise') {
    var base = fam === 'grain' ? 'geometry.' : 'surface.';
    var half = /-half$/.test(mode), sheet = /-(sheet|solid)$/.test(mode);
    add({ key: base + 'center', label: 'Level', unit: '', def: 0, target: half ? 'threshold' : null, hint: [-1, 1],
          apply: [{ p: base + 'center', k: 1 }], thresholdPath: base + 'center' });
    add({ key: base + 'half_width', label: 'Half-width', unit: '', def: 0.15, target: sheet ? 'threshold' : null, hint: [0.005, 1],
          apply: [{ p: base + 'half_width', k: 1 }], thresholdPath: base + 'half_width' });
  } else if (fam === 'beam') {
    var newSchema = (Array.isArray(g.scale_xyz) || typeof g.cell_scale_x === 'number') && typeof g.cell === 'number';
    if (newSchema && typeof g.radius_x === 'number') {
      var rx = g.radius_x, ry = typeof g.radius_y === 'number' ? g.radius_y : rx, rz = typeof g.radius_z === 'number' ? g.radius_z : rx;
      add({ key: 'radius_scale', label: 'Strut radius scale', unit: '×', def: 1, target: 'monotone', hint: [0.1, 3],
            apply: [{ p: 'geometry.radius_x', k: rx }, { p: 'geometry.radius_y', k: ry }, { p: 'geometry.radius_z', k: rz }] });
      geo('radius_x', 'Strut radius x', 'mm', rx, 'monotone', [0.01 * g.cell, 0.4 * g.cell]);
      geo('radius_y', 'Strut radius y', 'mm', ry, 'monotone', [0.01 * g.cell, 0.4 * g.cell]);
      geo('radius_z', 'Strut radius z', 'mm', rz, 'monotone', [0.01 * g.cell, 0.4 * g.cell]);
      geo('node_ball_radius', 'Node ball radius', 'mm', 0, 'monotone', [0, 0.4 * g.cell]);
      geo('node_smoothing_k', 'Node smoothing', 'mm', 0, null, [0, 0.2 * g.cell]);
    } else {
      geo('radius', 'Strut radius', '× half-cell', 0.1, 'monotone', [0.005, 0.5]);
    }
    /* no uniform offset for beams: the capsule distance is exact only near
       the struts (it plateaus outside the periodic halo), so thickening by
       offset isn't uniform — strut radius is the control */
  } else if (fam === 'bundle') {
    var st = (recipe.surface && recipe.surface.structure) || 'bundle';
    if (st === 'bundle') {
      geo('beam_radius', 'Beam radius', '', 0.09, 'monotone', [0.01, 0.3]); geo('beam_spacing', 'Beam spacing', '', 0.28);
      geo('beams_per_side', 'Beams per side', '', 2); geo('twist_rate', 'Twist rate', '', 1.2); geo('warp_amp', 'Warp amplitude', '', 0.15);
      geo('warp_freq', 'Warp frequency', '', 1.5);
    } else if (st === 'helicoid') {
      geo('thickness', 'Blade thickness', '', 0.05, 'monotone', [0.005, 0.3]); geo('pitch', 'Pitch', '', 1.5);
      geo('inner_radius', 'Inner radius', '', 0); geo('outer_radius', 'Outer radius', '', 0.4); geo('starts', 'Starts', '', 1);
    } else if (st === 'braid') {
      geo('fiber_radius', 'Fiber radius', '', 0.06, 'monotone', [0.005, 0.3]); geo('braid_radius', 'Braid radius', '', 0.12);
      geo('pitch', 'Pitch', '', 1.2); geo('strand_count', 'Strands', '', 3);
    } else {
      geo('fiber_radius', 'Fiber radius', '', 0.06, 'monotone', [0.005, 0.3]); geo('weave_pitch', 'Weave pitch', '', 0.5);
      geo('weave_amplitude', 'Weave amplitude', '', 0.1); geo('weave_layer_gap', 'Layer gap', '', 0);
    }
    geo('column_gap', 'Column gap', '', 0.2); geo('blend_k', 'Blend', '', 0.01);
    if (recipe.surface && recipe.surface.topology === 'sheet')
      add({ key: 'surface.sheet_width', label: 'Sheet width', unit: '', def: 0.025, target: 'monotone', hint: [0.002, 0.3], apply: [{ p: 'surface.sheet_width', k: 1 }] });
    add(offsetSpec);
  } else if (fam === 'foam') {
    /* v0.14.0 — F13LD.foam.  Units are the foam tool's own (one tile = 10).
       Thickness targets solid fraction exactly while organic is 0 (solid ⟺
       field < thickness); with organic on, the junction growth scales with
       thickness too, so it falls back to bisection.  Count, regularity,
       Lloyd iterations and random seed regenerate the seeds (13d header). */
    var fg = recipe.foam || {}, sd = recipe.seeds || {}, fmode = fg.mode || 'plateau', sm = sd.mode || 'poisson';
    var orgOn = typeof fg.organic === 'number' && fg.organic > 0;
    add({ key: 'foam.thickness', label: 'Thickness (wall / strut half-width)', unit: '', def: 0.08,
          target: orgOn ? 'monotone' : 'threshold', hint: [0.005, 1.0],
          apply: [{ p: 'foam.thickness', k: 1 }], thresholdPath: 'foam.thickness' });
    if (fmode === 'plateau')
      add({ key: 'foam.plateau_k', label: 'Plateau k (junction mass)', unit: '', def: 0.05, target: 'monotone', hint: [0, 0.4],
            apply: [{ p: 'foam.plateau_k', k: 1 }] });
    add({ key: 'foam.organic', label: 'Organic', unit: '', def: 0, target: 'monotone', hint: [0, 10], apply: [{ p: 'foam.organic', k: 1 }] });
    ['x', 'y', 'z'].forEach(function (a, i) {
      add({ key: 'stretch_' + a, label: 'Stretch ' + a, unit: '×', def: 1, target: null, hint: [0.3, 3],
            apply: [{ p: 'anisotropy.stretch.' + i, k: 1 }] });
    });
    add({ key: 'seeds.count', label: 'Cells per tile', unit: '', def: sd.count || 50, target: null, hint: [8, 400], integer: true, range: [25, 100, 4],
          apply: [{ p: 'seeds.count', k: 1 }] });
    if (sm === 'poisson' || sm === 'lloyd')
      add({ key: 'seeds.regularity', label: 'Regularity', unit: '', def: 0.9, target: null, hint: [0.45, 1], apply: [{ p: 'seeds.regularity', k: 1 }] });
    if (sm === 'lloyd')
      add({ key: 'seeds.lloyd_iterations', label: 'Lloyd iterations', unit: '', def: 4, target: null, hint: [1, 12], integer: true, range: [1, 8, 4],
            apply: [{ p: 'seeds.lloyd_iterations', k: 1 }] });
    if (sm === 'poisson' || sm === 'lloyd' || sm === 'random')
      add({ key: 'seeds.rng_seed', label: 'Random seed (realization)', unit: '', def: 42, target: null, hint: [1, 10], integer: true, range: [1, 3, 3],
            apply: [{ p: 'seeds.rng_seed', k: 1 }] });
  } else if (fam === 'wave') {
    var f = recipe.field || {};
    add({ key: 'field.iso', label: 'Level', unit: '', def: 0, target: null, apply: [{ p: 'field.iso', k: 1 }] });
    if (f.mode === 'sheet') add({ key: 'field.thickness', label: 'Sheet thickness', unit: '', def: 0.2, target: 'monotone', hint: [0.005, 1], apply: [{ p: 'field.thickness', k: 1 }] });
    add({ key: 'field.phaseTime', label: 'Phase time', unit: '', def: 0, target: null, apply: [{ p: 'field.phaseTime', k: 1 }] });
    add(offsetSpec);
  }
  /* Any other plain number in the geometry / surface / field blocks. */
  var have = {};
  if (fam === 'beam' && !((Array.isArray(g.scale_xyz) || typeof g.cell_scale_x === 'number') && typeof g.cell === 'number')) {
    have['geometry.node_ball_radius'] = have['geometry.node_smoothing_k'] = true;   /* old beam schema ignores these */
  }
  out.forEach(function (s) { s.apply.forEach(function (a) { have[a.p] = true; }); });
  var SKIP = /(^|\.)(cellSizeMm|cellMult|cell_size_mm|cell|cell_scale(_[xyz])?|fieldBScale|field_b_scale|field_b_freq|symmetryId|structure|twist_mode|warp_mode|warp_frame|col_handed|z_handed|braid_col_handed|mode|topology)$/;
  ['geometry', 'surface', 'field'].forEach(function (blk) {
    (function walk(obj, prefix, depth) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 2) return;
      Object.keys(obj).sort().forEach(function (k) {
        var v = obj[k], path = prefix + '.' + k;
        if (typeof v === 'number' && isFinite(v) && !have[path] && !SKIP.test(path)) {
          out.push({ key: path, label: path, unit: '', def: v, target: null, group: 'other', apply: [{ p: path, k: 1 }] });
        } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path, depth + 1);
      });
    })(recipe[blk], blk, 0);
  });
  return out;
}
function sweepSpecByKey(recipe, key) { return sweepParamCatalog(recipe).filter(function (s) { return s.key === key; })[0] || null; }

/* Voxel solid fraction (before island trim) at grid N. */
function sweepVoxelFraction(recipe, N) {
  var params = KERNELS[recipe.family].parseRecipe(recipe), args = resolveBuildArgs(recipe);
  var s = buildVoxels(recipe.family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift), c = 0;
  for (var i = 0; i < s.length; i++) c += s[i];
  return c / s.length;
}

/* ── Threshold fields for solid-fraction targeting ────────── */
/* For specs with target 'threshold': per-voxel quantity s with
   solid ⟺ s < (value written at spec.thresholdPath), returned with the
   map from a threshold back to that path's value. */
function sweepThresholdField(recipe, spec, N) {
  if (!spec || spec.target !== 'threshold') return null;
  var family = recipe.family, g = recipe.geometry || {}, mode = g.mode || 'solid', tp = spec.thresholdPath;
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
  var s = new Float32Array(N3), toPath = null, idx = 0;
  function each(fn) {
    idx = 0;
    for (var i = 0; i < N; i++) { var x = -L + (i + 0.5) * step;
      for (var j = 0; j < N; j++) { var y = -L + (j + 0.5) * step;
        for (var k = 0; k < N; k++) { var z = -L + (k + 0.5) * step; s[idx++] = fn(x, y, z); } } }
  }
  var ident = function (t) { return t; }, neg = function (t) { return -t; };
  if (tp === 'geometry.offset' && mode === 'solid') { each(ev); toPath = ident; }
  else if (tp === 'geometry.wallThickness' && mode === 'shell' && !args.nWeights) {
    var off = args.offset;
    if (params.shellNorm) each(function (x, y, z) { return Math.abs(ev(x, y, z) - off) / Math.max(grad(x, y, z).mag, NORM_EPS); });
    else each(function (x, y, z) { return Math.abs(ev(x, y, z) - off); });
    toPath = ident;
  } else if (tp === 'geometry.pipeR' && mode === 'pi-tpms') {
    var ps = args.phaseShift || {}, TP = 2 * Math.PI;
    var dx = (ps.x || 0) * TP, dy = (ps.y || 0) * TP, dz = (ps.z || 0) * TP;
    /* v0.13.0 — mirrors buildVoxels: φA has the preset constant restored
       (offset), and field-pair recipes take field B from tpmsPairB */
    var off = args.offset || 0, pair = params.pair;
    var evA = function (x, y, z) { return ev(x, y, z) - off; };
    var evB = pair ? function (x, y, z) { return tpmsPairB(pair, x, y, z, dx, dy, dz); }
                   : function (x, y, z) { return ev(x + dx, y + dy, z + dz) - off; };
    var gradB = function (x, y, z) {
      if (!pair) return grad(x + dx, y + dy, z + dz);
      var gx = (evB(x + NORM_E, y, z) - evB(x - NORM_E, y, z)) * INV2E;
      var gy = (evB(x, y + NORM_E, z) - evB(x, y - NORM_E, z)) * INV2E;
      var gz = (evB(x, y, z + NORM_E) - evB(x, y, z - NORM_E)) * INV2E;
      return { gx: gx, gy: gy, gz: gz, mag: Math.sqrt(gx * gx + gy * gy + gz * gz) };
    };
    if (params.piNorm) {
      each(function (x, y, z) {
        var a = evA(x, y, z), b = evB(x, y, z);
        var gA = grad(x, y, z), gB = gradB(x, y, z);
        var mA = Math.max(gA.mag, NORM_EPS), mB = Math.max(gB.mag, NORM_EPS);
        var dA = a / mA, dB = b / mB;
        var cs = (gA.gx * gB.gx + gA.gy * gB.gy + gA.gz * gB.gz) / (mA * mB);
        if (cs > NORM_COSCLAMP) cs = NORM_COSCLAMP; if (cs < -NORM_COSCLAMP) cs = -NORM_COSCLAMP;
        return Math.sqrt(Math.max(dA * dA - 2 * cs * dA * dB + dB * dB, 0) / (1 - cs * cs));
      });
    } else each(function (x, y, z) { return Math.max(Math.abs(evA(x, y, z)), Math.abs(evB(x, y, z))); });
    toPath = ident;
  } else if (tp === 'foam.thickness' && family === 'foam') {
    /* v0.14.0 — foam field at (near) zero thickness, in the tool's units:
       solid ⟺ field₀ < thickness (exact while organic is 0). */
    var r0 = JSON.parse(JSON.stringify(recipe));
    r0.foam = r0.foam || {}; r0.foam.thickness = 1e-9;
    var p0 = kernel.parseRecipe(r0), outK = 5 / Math.PI;
    each(function (x, y, z) { return kernel.evaluate(p0, x, y, z) * outK + 1e-9; });
    toPath = ident;
  } else if (/\.(half_width|center)$/.test(tp) && (family === 'grain' || family === 'noise')) {
    var iso = params.isoLevel, inv = !!params.halfInvert;
    var sheet = /-sheet$/.test(mode), half = /-half$/.test(mode), anti = /-solid$/.test(mode);
    if (/half_width$/.test(tp) && sheet) { each(function (x, y, z) { return Math.abs(ev(x, y, z) - iso); }); toPath = ident; }
    else if (/half_width$/.test(tp) && anti) { each(function (x, y, z) { return -Math.abs(ev(x, y, z) - iso); }); toPath = neg; }
    else if (/center$/.test(tp) && half) {
      if (inv) { each(ev); toPath = ident; } else { each(function (x, y, z) { return -ev(x, y, z); }); toPath = neg; }
    }
  }
  if (!toPath) return null;
  var kk = 1;
  spec.apply.forEach(function (a) { if (a.p === tp) kk = a.k || 1; });
  return { s: s, toParam: function (t) { return toPath(t) / kk; } };
}

/* Parameter values giving each target voxel solid fraction (before trim)
   at grid N: exact quantiles for 'threshold' specs, bisection for
   'monotone' ones.  null entries = target out of reach. */
function sweepParamsForFractions(recipe, spec, N, fractions, onProgress) {
  if (spec.target === 'threshold') {
    var tf = sweepThresholdField(recipe, spec, N);
    if (tf) {
      var sorted = Float32Array.from(tf.s).sort(), n = sorted.length;
      return fractions.map(function (f) {
        var k = Math.round(Math.max(0, Math.min(1, f)) * n);
        if (k > 0 && k < n && sorted[k - 1] === sorted[k]) {
          /* tied values (a plateau in the field): move to the nearer edge of the tie */
          var a = k - 1, b = k;
          while (a > 0 && sorted[a - 1] === sorted[k]) a--;
          while (b < n && sorted[b] === sorted[k]) b++;
          k = (k - a <= b - k) ? a : b;
        }
        var t = k <= 0 ? sorted[0] - 1e-6 : (k >= n ? sorted[n - 1] + 1e-6 : 0.5 * (sorted[k - 1] + sorted[k]));
        return tf.toParam(t);
      });
    }
  }
  if (spec.target !== 'monotone' && spec.target !== 'threshold') return null;
  /* bisection on the voxel solid fraction */
  var lo = spec.hint ? spec.hint[0] : 0, hi = spec.hint ? spec.hint[1] : 2 * Math.abs(sweepParamGet(recipe, spec) || 1);
  var r = JSON.parse(JSON.stringify(recipe)), cache = {};
  function vfAt(v) { var key = v.toPrecision(12); if (cache[key] == null) { sweepParamSet(r, spec, v); cache[key] = sweepVoxelFraction(r, N); } return cache[key]; }
  var fLo = vfAt(lo), fHi = vfAt(hi), up = fHi >= fLo;
  return fractions.map(function (f, idx) {
    if (onProgress) onProgress(idx, fractions.length);
    var a = lo, b = hi;
    if ((up && (f < fLo || f > fHi)) || (!up && (f > fLo || f < fHi))) return null;
    for (var it = 0; it < 22; it++) {
      var m = 0.5 * (a + b), fm = vfAt(m);
      if (Math.abs(fm - f) < 2e-4) return m;
      if ((fm < f) === up) a = m; else b = m;
    }
    return 0.5 * (a + b);
  });
}

/* Review a builder sweep in the worker: resolve every combination's
   parameter values (targeting solid fraction where asked) and check its
   geometry at a coarse grid.  Posts progress through onProgress. */
function sweepReviewCombos(job, onProgress) {
  var base = job.recipe, s1 = job.spec1, s2 = job.spec2, N = job.N, NQ = job.checkN || 32;
  var v2s = s2 ? job.values2 : [null], combos = [];
  var total = v2s.length * (job.byVf ? job.targets.length : job.values1.length), done = 0;
  for (var j = 0; j < v2s.length; j++) {
    var r2 = JSON.parse(JSON.stringify(base));
    if (s2) sweepParamSet(r2, s2, v2s[j]);
    var v1s = job.values1;
    if (job.byVf) {
      onProgress && onProgress({ stage: 'targeting', done: done, total: total });
      v1s = sweepParamsForFractions(r2, s1, N, job.targets);
    }
    for (var i = 0; i < v1s.length; i++) {
      var c = { i: i, j: j, v1: v1s[i], v2: v2s[j], target: job.byVf ? job.targets[i] : null };
      if (v1s[i] == null) { c.unreachable = true; combos.push(c); done++; continue; }
      var r = JSON.parse(JSON.stringify(r2));
      sweepParamSet(r, s1, v1s[i]);
      try { c.stats = sweepGeometryStats(r, NQ, job.connectivity || 'networks'); }
      catch (e) { c.error = (e && e.message) || String(e); }
      combos.push(c);
      done++;
      if (onProgress && (done % 2 === 0 || done === total)) onProgress({ stage: 'checking', done: done, total: total, combo: c });
    }
  }
  return combos;
}

/* Worker body for the sweep's geometry worker. */
var SWEEP_WORKER_ONMESSAGE =
  'onmessage = function(e){\n' +
  '  var m = e.data;\n' +
  '  try {\n' +
  '    if (m.importGrid) registerImportGrid(m.importGrid);\n' +
  '    if (m.type === "stats") postMessage({ id: m.id, ok: true, stats: sweepGeometryStats(m.recipe, m.N, m.connectivity) });\n' +
  '    else if (m.type === "target") postMessage({ id: m.id, ok: true, values: sweepParamsForFractions(m.recipe, m.spec, m.N, m.fractions) });\n' +
  '    else if (m.type === "review") postMessage({ id: m.id, ok: true, combos: sweepReviewCombos(m, function(p){ postMessage({ id: m.id, progress: p }); }) });\n' +
  '  } catch (err){ postMessage({ id: m.id, ok: false, message: (err && err.message) || String(err) }); }\n' +
  '};\n';

/* node/test harness export (browser ignores this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sweepGeometryStats: sweepGeometryStats, sweepFeatureThickness: sweepFeatureThickness,
    sweepThresholdField: sweepThresholdField, sweepParamsForFractions: sweepParamsForFractions,
    sweepParamCatalog: sweepParamCatalog, sweepParamGet: sweepParamGet, sweepParamSet: sweepParamSet, sweepReviewCombos: sweepReviewCombos };
}
