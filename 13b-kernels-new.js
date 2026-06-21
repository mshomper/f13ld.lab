/* ============================================================
   F13LD.lab · 13b-kernels-new.js
   Field kernels for the three SDF families added after the
   original TPMS/Noise/Grain trio:  Beam · Bundle · Wave.

   Ported VERBATIM from F13LD.mesh (index_-_mesh.html) so the
   field math in lab matches mesh's hardened implementation
   byte-for-byte.  mesh is the source of truth for recipe
   construction across the whole F13LD suite.

   ── Why these three are different ─────────────────────────────
   TPMS / Noise / Grain are SCALAR FIELDS: evaluate() returns a
   raw scalar that buildVoxels() then thresholds via a topology
   mode (solid / shell / sheet / half).

   Beam / Bundle / Wave are TRUE SDFs: evaluate() returns a
   NEGATIVE-INSIDE signed distance with topology (iso / sheet /
   void / solid) already folded in by the verbatim mesh port.
   The rasterizer therefore needs no new branch — buildVoxels'
   default path (`field - offset < 0 → solid`, offset = 0)
   reduces to `SDF < 0 → solid`, which is exactly right.  These
   kernels are registered as `mode: 'solid'` recipes on import.

   ── Coordinate convention ─────────────────────────────────────
   lab solvers sample the unit cell at solver-space (x,y,z) ∈
   [-π, π]³.  mesh samples world (x,y,z) ∈ [-5, 5]³ and applies
   its own per-family scale.  The bridge is world = solver·(5/π),
   so each evaluate() maps Lab→mesh-world first, then runs the
   verbatim mesh scale.  Net result: one cell == Lab's [-π,π]³
   cube == mesh's [-5,5]³ cube — the homogenization RVE is
   preserved and a recipe analyzed here matches what mesh shows.

   Per-family the two scale factors collapse to:
     wave   : q   = solver           (5/π and π/5 cancel exactly)
     bundle : in  = solver · (5S/π) ;  out = SDF · (π/(5S))
     beam   : lx  = solver · cellScale/π ; out = SDF · L2Wgeo·(π/5)
   The `out` factors are positive constants — they keep the SDF
   magnitude in sane solver units for the raymarcher but never
   affect the sign or the volume fraction.
   ============================================================ */


/* ════════════════════════════════════════════════════════════
   WaveKernel — cymatic standing-wave field (F13LD.wave)
   Sum of cosine modes under one of five symmetry operators.
   Transcribed verbatim from mesh buildWaveSDF / f13ldWaveEvalRaw.
   ════════════════════════════════════════════════════════════ */
var WaveKernel = {
  family: 'wave',

  /* symmetry name → operator id (mesh SYM table) */
  _SYM: { pure: 0, anti: 1, antisym: 1, chladni: 1, cubic: 2, chiral: 3, schoen: 4 },

  parseRecipe: function (recipe) {
    var f = recipe.field || {};
    var sym = (typeof f.symmetryId === 'number') ? f.symmetryId
            : (typeof f.symmetry === 'string' ? (this._SYM[f.symmetry.toLowerCase()] != null
                                                  ? this._SYM[f.symmetry.toLowerCase()] : 0) : 0);
    var params = {
      modes:     Array.isArray(f.modes) ? f.modes : [],
      sym:       sym,
      iso:       (typeof f.iso === 'number') ? f.iso : 0,
      sheet:     (f.mode === 'sheet'),
      thickness: (typeof f.thickness === 'number') ? f.thickness : 0.2,
      signFlip:  !!f.signFlip,
      t:         (typeof f.phaseTime === 'number') ? f.phaseTime : 0
    };
    if (!recipe.family) recipe.family = 'wave';
    return params;
  },

  /* Raw mode sum at q (== Lab solver coord, since q = world·π/5 and
     world = solver·5/π cancel).  Verbatim mesh evalRaw. */
  _evalRaw: function (p, qx, qy, qz) {
    var modes = p.modes, sym = p.sym, t = p.t, acc = 0;
    for (var i = 0; i < modes.length; i++) {
      var mm = modes[i];
      var n = mm.n, m = mm.m, pp = mm.p, A = (mm.A != null ? mm.A : 1);
      var cphi = Math.cos((mm.phi || 0) + t);
      var cnX = Math.cos(n * qx), cmX = Math.cos(m * qx), cpX = Math.cos(pp * qx);
      var cnY = Math.cos(n * qy), cmY = Math.cos(m * qy), cpY = Math.cos(pp * qy);
      var cnZ = Math.cos(n * qz), cmZ = Math.cos(m * qz), cpZ = Math.cos(pp * qz);
      var v;
      if (sym === 1)      { v = cnX*cmY*cpZ + cnY*cmZ*cpX + cnZ*cmX*cpY - cnY*cmX*cpZ - cnX*cmZ*cpY - cnZ*cmY*cpX; }
      else if (sym === 2) { v = cnX*cmY*cpZ + cnY*cmZ*cpX + cnZ*cmX*cpY + cnY*cmX*cpZ + cnX*cmZ*cpY + cnZ*cmY*cpX; }
      else if (sym === 3) { v = cnX*cmY*cpZ + cnY*cmZ*cpX + cnZ*cmX*cpY; }
      else if (sym === 4) { var snX = Math.sin(n*qx), snY = Math.sin(n*qy), snZ = Math.sin(n*qz);
                            v = snX*cmY*cpZ + snY*cmZ*cpX + snZ*cmX*cpY; }
      else                { v = cnX*cmY*cpZ; }
      acc += A * v * cphi;
    }
    return acc;
  },

  /* NEGATIVE-INSIDE SDF in solver space. mesh worldScale (π/5) and
     Lab solver→world (5/π) cancel, so q = solver coord directly. */
  evaluate: function (params, x, y, z) {
    var fr = this._evalRaw(params, x, y, z);
    var cym = params.sheet ? (Math.abs(params.iso - fr) - params.thickness)
                           : (params.iso - fr);
    return params.signFlip ? -cym : cym;
  }
};


/* ════════════════════════════════════════════════════════════
   BSDF — twisted fiber array / helicoid / braid / woven sheet.
   Verbatim port of mesh's BSDF object (F13LD.bundle v0.2.1).
   BSDF.scene returns canonical NEGATIVE-INSIDE with iso offset
   and solid/sheet topology already folded in.
   ════════════════════════════════════════════════════════════ */
var BSDF = {
  PI: Math.PI, TWO_PI: Math.PI * 2,
  smax: function (a, b, k) { if (k < 0.0001) return Math.max(a, b); var h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h*h*k*0.25; },
  smin: function (a, b, k) { if (k < 0.0001) return Math.min(a, b); var h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h*h*k*0.25; },
  ckSign: function (bi, bj) { return (((bi + bj) % 2) + 2) % 2 === 0 ? 1 : -1; },
  beamSDF: function (dx, dy, r, n) {
    if (n >= 14) return r - Math.max(Math.abs(dx), Math.abs(dy));
    if (n <= 2.1) return r - Math.sqrt(dx*dx + dy*dy);
    return r - Math.pow(Math.pow(Math.abs(dx), n) + Math.pow(Math.abs(dy), n), 1/n);
  },
  bundleRaw: function (lx, ly, p) {
    var W = p.nx * p.d, hp = W * 0.5, result = -1e6;
    for (var j = 0; j < p.ny; j++) for (var i = 0; i < p.nx; i++) {
      var x0 = (i - (p.nx-1)*0.5)*p.d, y0 = (j - (p.ny-1)*0.5)*p.d;
      if (Math.abs(x0) + p.r <= hp && Math.abs(y0) + p.r <= hp)
        result = BSDF.smax(result, BSDF.beamSDF(lx - x0, ly - y0, p.r, p.n), p.blend);
    }
    return result;
  },
  applyWarp: function (xm, ym, z, p) {
    if (p.warpMode === 0) return [xm, ym];
    var A = p.warpAmp, w = p.warpFreq;
    if (p.warpMode === 1) { var cx = A*Math.sin(w*z), dC = A*w*Math.cos(w*z), L = Math.sqrt(1 + dC*dC); return [(xm - cx)/L, ym]; }
    var cx = A*Math.sin(w*z), cy = A*Math.cos(w*z), L = Math.sqrt(1 + A*A*w*w);
    return [-(xm - cx)*Math.sin(w*z) - (ym - cy)*Math.cos(w*z), ((xm - cx)*Math.cos(w*z) - (ym - cy)*Math.sin(w*z))/L];
  },
  bundleCell: function (xm, ym, pz, cs, p) {
    var ts = p.twistMode === 0 ? 1 : cs;
    var th = ts*p.twist*pz, cosT = Math.cos(th), sinT = Math.sin(th);
    var lx, ly, w;
    if (p.warpFrame === 0) { w = BSDF.applyWarp(xm, ym, pz, p); lx = w[0]*cosT - w[1]*sinT; ly = w[0]*sinT + w[1]*cosT; }
    else { var tx = xm*cosT - ym*sinT, ty = xm*sinT + ym*cosT; w = BSDF.applyWarp(tx, ty, pz, p); lx = w[0]; ly = w[1]; }
    return -BSDF.bundleRaw(lx, ly, p);
  },
  bundle: function (px, py, pz_in, p) {
    var period = Math.max(p.nx*p.d + p.gap, 0.01);
    var hp = period*0.5, SH = Math.PI;
    var xBase = ((px + SH) % period + period) % period - hp;
    var yBase = ((py + SH) % period + period) % period - hp;
    var biBase = Math.floor((px + SH)/period);
    var bjBase = Math.floor((py + SH)/period);
    var result = 1e6;
    for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
      var xm = xBase - di*period, ym = yBase - dj*period;
      var bi = biBase + di, bj = bjBase + dj;
      var cs = BSDF.ckSign(bi, bj);
      var pz = pz_in + bi*p.zRampX + bj*p.zRampY + cs*p.zChkStep;
      result = BSDF.smin(result, BSDF.bundleCell(xm, ym, pz, cs, p), p.blend);
    }
    return result;
  },
  helicoidCell: function (xm, ym, pz, cs, p) {
    var omega = p.hPitch;
    if (p.hColHand && cs < 0) omega = -omega;
    var twAng, twRate;
    if (p.hZHand) { var hk = Math.abs(omega)*0.5; twRate = omega*Math.cos(hk*pz); twAng = (hk > 1e-6 ? omega/hk : omega*pz)*Math.sin(hk*pz); }
    else { twAng = omega*pz; twRate = omega; }
    var rxy = Math.sqrt(xm*xm + ym*ym);
    var rMask = Math.min(rxy - p.hInner, p.hOuter - rxy);
    var phi = p.hStarts*Math.atan2(ym, xm) - twAng;
    phi -= BSDF.TWO_PI*Math.round(phi/BSDF.TWO_PI);
    var rSafe = Math.max(rxy, 1e-4);
    var gradMag = Math.sqrt(p.hStarts*p.hStarts/(rSafe*rSafe) + twRate*twRate);
    var dSheet = Math.abs(phi)/gradMag - p.hThick;
    return Math.max(dSheet, -rMask);
  },
  helicoid: function (px, py, pz_in, p) {
    var period = Math.max(2*p.hOuter + p.hGap, 0.01);
    var hp = period*0.5, SH = Math.PI;
    var xBase = ((px + SH) % period + period) % period - hp;
    var yBase = ((py + SH) % period + period) % period - hp;
    var biBase = Math.floor((px + SH)/period);
    var bjBase = Math.floor((py + SH)/period);
    var result = 1e6;
    for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
      var xm = xBase - di*period, ym = yBase - dj*period;
      var bi = biBase + di, bj = bjBase + dj;
      var cs = BSDF.ckSign(bi, bj);
      var pz = pz_in + bi*p.zRampX + bj*p.zRampY + cs*p.zChkStep;
      result = BSDF.smin(result, BSDF.helicoidCell(xm, ym, pz, cs, p), p.hBlend);
    }
    return result;
  },
  braidCell: function (xm, ym, pz, cs, p) {
    var omega = p.bPitch;
    if (p.bColHand && cs < 0) omega = -omega;
    var dA2 = p.bRadius*p.bRadius*omega*omega + 1;
    var result = -1e6;
    for (var k = 0; k < p.bN; k++) {
      var phase = BSDF.TWO_PI*k/p.bN, tt = pz;
      for (var iter = 0; iter < 5; iter++) {
        var phi = omega*tt + phase;
        var Ckx = p.bRadius*Math.cos(phi), Cky = p.bRadius*Math.sin(phi);
        var dCkx = -p.bRadius*omega*Math.sin(phi), dCky = p.bRadius*omega*Math.cos(phi);
        var ddCkx = -p.bRadius*omega*omega*Math.cos(phi), ddCky = -p.bRadius*omega*omega*Math.sin(phi);
        var dx = xm - Ckx, dy = ym - Cky, dz = pz - tt;
        var fF = -(dx*dCkx + dy*dCky + dz);
        var fp = dA2 - (dx*ddCkx + dy*ddCky);
        tt -= fF / (Math.abs(fp) > 1e-6 ? fp : 1e-6);
      }
      var phi2 = omega*tt + phase;
      var dist = Math.sqrt((xm - p.bRadius*Math.cos(phi2))*(xm - p.bRadius*Math.cos(phi2)) + (ym - p.bRadius*Math.sin(phi2))*(ym - p.bRadius*Math.sin(phi2)) + (pz - tt)*(pz - tt));
      result = BSDF.smax(result, p.bFiber - dist, p.bBlend);
    }
    return -result;
  },
  braid: function (px, py, pz_in, p) {
    var period = Math.max(2*(p.bRadius + p.bFiber) + p.bGap, 0.01);
    var hp = period*0.5, SH = Math.PI;
    var xBase = ((px + SH) % period + period) % period - hp;
    var yBase = ((py + SH) % period + period) % period - hp;
    var biBase = Math.floor((px + SH)/period);
    var bjBase = Math.floor((py + SH)/period);
    var result = 1e6;
    for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
      var xm = xBase - di*period, ym = yBase - dj*period;
      var bi = biBase + di, bj = bjBase + dj;
      var cs = BSDF.ckSign(bi, bj);
      var pz = pz_in + bi*p.zRampX + bj*p.zRampY + cs*p.zChkStep;
      result = BSDF.smin(result, BSDF.braidCell(xm, ym, pz, cs, p), p.bBlend);
    }
    return result;
  },
  weave: function (px, py, pz, p) {
    var period = Math.max(p.wvP, 0.01), hp = period*0.5;
    var zPeriod = Math.max(2*(p.wvA + p.wvR) + p.wvZGap, 0.01), zHalfP = zPeriod*0.5;
    var zmBase = ((pz + zHalfP) % zPeriod + zPeriod) % zPeriod - zHalfP;
    var xBase = ((px + hp) % period + period) % period - hp;
    var biBase = Math.floor((px + hp)/period);
    var yBase = ((py + hp) % period + period) % period - hp;
    var bjBase = Math.floor((py + hp)/period);
    var result = 1e6;
    for (var dzi = -1; dzi <= 1; dzi++) {
      var zm = zmBase - dzi*zPeriod;
      var warpD = 1e6;
      for (var di = -1; di <= 1; di++) {
        var xm = xBase - di*period;
        var bi = biBase + di;
        var cs = (((bi % 2) + 2) % 2 === 0) ? 1 : -1;
        var zc = cs*p.wvA*Math.cos(Math.PI*py/period);
        warpD = Math.min(warpD, Math.sqrt(xm*xm + (zm - zc)*(zm - zc)) - p.wvR);
      }
      var weftD = 1e6;
      for (var dj = -1; dj <= 1; dj++) {
        var ym = yBase - dj*period;
        var bj = bjBase + dj;
        var cs2 = (((bj % 2) + 2) % 2 === 0) ? 1 : -1;
        var zc2 = -cs2*p.wvA*Math.cos(Math.PI*px/period);
        weftD = Math.min(weftD, Math.sqrt(ym*ym + (zm - zc2)*(zm - zc2)) - p.wvR);
      }
      result = BSDF.smin(result, BSDF.smin(warpD, weftD, p.wvBlend), p.wvBlend);
    }
    return result;
  },
  raw: function (px, py, pz, p) {
    if (p.structure === 0) return BSDF.bundle(px, py, pz, p);
    if (p.structure === 1) return BSDF.helicoid(px, py, pz, p);
    if (p.structure === 2) return BSDF.braid(px, py, pz, p);
    return BSDF.weave(px, py, pz, p);
  },
  scene: function (px, py, pz, p) {
    var raw = BSDF.raw(px, py, pz, p) - p.iso;
    if (p.topoMode === 0) return p.flip ? -raw : raw;
    return Math.abs(raw) - p.sheetW;
  }
};

/* mesh bundleParamsFromJSON — verbatim */
function _bundleParamsFromJSON(json) {
  var surf = json.surface || {}, g = json.geometry || {};
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function int(v, d) { return (typeof v === 'number' && isFinite(v)) ? Math.round(v) : d; }
  var structNames = ['bundle', 'helicoid', 'braid', 'weave'];
  var sName = surf.structure || (json.meta && json.meta.preset) || 'bundle';
  var structure = structNames.indexOf(sName); if (structure < 0) structure = 0;
  function shapeToN(sn) { return sn === 'square' ? 16 : sn === 'rounded' ? 4 : 2; }
  var topoMode = (surf.topology === 'sheet') ? 1 : 0;
  var flip = (surf.topology === 'void') ? 1 : 0;
  return {
    structure: structure,
    r: num(g.beam_radius, 0.09), n: shapeToN(g.beam_shape || 'circle'),
    nx: int(g.beams_per_side, 2), ny: int(g.beams_per_side, 2),
    d: num(g.beam_spacing, 0.28), gap: num(g.column_gap, 0.20),
    blend: num(g.blend_k, 0.01), twist: num(g.twist_rate, 1.20),
    twistMode: int(g.twist_mode, 0),
    warpMode: int(g.warp_mode, 0), warpAmp: num(g.warp_amp, 0.15),
    warpFreq: num(g.warp_freq, 1.50), warpFrame: int(g.warp_frame, 0),
    hPitch: num(g.pitch, 1.5), hThick: num(g.thickness, 0.05),
    hInner: num(g.inner_radius, 0.0), hOuter: num(g.outer_radius, 0.4),
    hStarts: int(g.starts, 1), hBlend: num(g.helicoid_blend, 0.01),
    hGap: num(g.column_gap, 0.20), hColHand: int(g.col_handed, 0), hZHand: int(g.z_handed, 0),
    bN: int(g.strand_count, 3), bRadius: num(g.braid_radius, 0.12),
    bPitch: num(g.pitch, 1.20), bFiber: num(g.fiber_radius, 0.06),
    bBlend: num(g.blend_k, 0.01), bGap: num(g.column_gap, 0.20),
    bColHand: int(g.braid_col_handed, 0),
    wvP: num(g.weave_pitch, 0.5), wvA: num(g.weave_amplitude, 0.1),
    wvR: num(g.fiber_radius, 0.06), wvZGap: num(g.weave_layer_gap, 0.0),
    wvBlend: num(g.blend_k, 0.01),
    iso: num(surf.iso_offset, 0.0), sheetW: num(surf.sheet_width, 0.025),
    topoMode: topoMode, flip: flip,
    zRampX: num(g.z_ramp_x, 0.0), zRampY: num(g.z_ramp_y, 0.0), zChkStep: num(g.z_checker_step, 0.0)
  };
}
function _bundleXYPeriod(p) {
  if (p.structure === 0) return Math.max(p.nx*p.d + p.gap, 0.01);
  if (p.structure === 1) return Math.max(2*p.hOuter + p.hGap, 0.01);
  if (p.structure === 2) return Math.max(2*(p.bRadius + p.bFiber) + p.bGap, 0.01);
  return Math.max(p.wvP, 0.01);
}

/* ════════════════════════════════════════════════════════════
   BundleKernel
   ════════════════════════════════════════════════════════════ */
var BundleKernel = {
  family: 'bundle',

  parseRecipe: function (recipe) {
    var p = _bundleParamsFromJSON(recipe);
    var S = _bundleXYPeriod(p) / 10;        /* mesh world→bundle-domain scale */
    /* Lab solver [-π,π] → bundle-domain: in = solver · (5S/π).
       Distance back to solver units: out = SDF · (π/(5S)). */
    var inScale  = 5 * S / Math.PI;
    var outScale = Math.PI / (5 * S);
    if (!recipe.family) recipe.family = 'bundle';
    return { p: p, inScale: inScale, outScale: outScale };
  },

  evaluate: function (params, x, y, z) {
    var k = params.inScale;
    return BSDF.scene(x * k, y * k, z * k, params.p) * params.outScale;
  }
};


/* ════════════════════════════════════════════════════════════
   BeamKernel — periodic capsule lattice (F13LD.beam)
   Verbatim port of mesh buildBeamSDF (non-pruneCtx path).  The
   mesh export-only super-cell / mask-prune path is intentionally
   omitted: lab homogenizes a single periodic cube (option A) and
   handles island removal via 14a-connectivity.
   ════════════════════════════════════════════════════════════ */
var BeamKernel = {
  family: 'beam',

  /* IQ cubic smooth-min — matches mesh's smin (k<=0 → hard min) */
  _smin: function (a, b, k) {
    if (k <= 0) return a < b ? a : b;
    var diff = a > b ? a - b : b - a;
    var h = (k - diff) > 0 ? (k - diff)/k : 0;
    return (a < b ? a : b) - h*h*h*k*(1/6);
  },

  parseRecipe: function (recipe) {
    var beams = recipe.beams || [];
    var geom = recipe.geometry || {};

    /* Schema detection (mesh rc25): scale_xyz OR cell_scale_x/y/z + cell. */
    var sxyz = null;
    if (Array.isArray(geom.scale_xyz) && geom.scale_xyz.length === 3
        && isFinite(geom.scale_xyz[0]) && isFinite(geom.scale_xyz[1]) && isFinite(geom.scale_xyz[2])
        && geom.scale_xyz[0] > 0 && geom.scale_xyz[1] > 0 && geom.scale_xyz[2] > 0) {
      sxyz = geom.scale_xyz;
    } else if (typeof geom.cell_scale_x === 'number' && geom.cell_scale_x > 0
            && typeof geom.cell_scale_y === 'number' && geom.cell_scale_y > 0
            && typeof geom.cell_scale_z === 'number' && geom.cell_scale_z > 0) {
      sxyz = [geom.cell_scale_x, geom.cell_scale_y, geom.cell_scale_z];
    }
    var cellMm = geom.cell;
    var hasScaleXYZ = sxyz !== null;
    var hasCell = (typeof cellMm === 'number') && isFinite(cellMm) && cellMm > 0;
    var isNew = hasScaleXYZ && hasCell;

    var cellScaleX, cellScaleY, cellScaleZ;
    if (isNew) {
      cellScaleX = cellMm / sxyz[0];
      cellScaleY = cellMm / sxyz[1];
      cellScaleZ = cellMm / sxyz[2];
    } else {
      var cs = (typeof geom.cell_scale === 'number' && geom.cell_scale > 0) ? geom.cell_scale : 1;
      cellScaleX = cellScaleY = cellScaleZ = cs;
    }

    var rLocX, rLocY, rLocZ;
    if (isNew && typeof geom.radius_x === 'number' && geom.radius_x >= 0) {
      var rx = geom.radius_x;
      var ry = (typeof geom.radius_y === 'number' && geom.radius_y >= 0) ? geom.radius_y : rx;
      var rz = (typeof geom.radius_z === 'number' && geom.radius_z >= 0) ? geom.radius_z : rx;
      rLocX = 2*rx / sxyz[0]; rLocY = 2*ry / sxyz[1]; rLocZ = 2*rz / sxyz[2];
    } else {
      var r = (typeof geom.radius === 'number' && geom.radius >= 0) ? geom.radius : 0.1;
      rLocX = rLocY = rLocZ = r;
    }

    var sminLocal = (isNew && typeof geom.node_smoothing_k === 'number' && geom.node_smoothing_k > 0)
      ? (2*geom.node_smoothing_k / cellMm) : 0;
    var ballLocal = (isNew && typeof geom.node_ball_radius === 'number' && geom.node_ball_radius > 0)
      ? (2*geom.node_ball_radius / cellMm) : 0;
    var useSmin = sminLocal > 0;
    var useBalls = ballLocal > 0;

    var N = beams.length;
    var ax = new Float64Array(N), ay = new Float64Array(N), az = new Float64Array(N);
    var bx = new Float64Array(N), by = new Float64Array(N), bz = new Float64Array(N);
    var rStrut = new Float64Array(N);
    var maxR = 0;
    for (var i = 0; i < N; i++) {
      var bb = beams[i];
      ax[i] = bb[0]; ay[i] = bb[1]; az[i] = bb[2];
      bx[i] = bb[3]; by[i] = bb[4]; bz[i] = bb[5];
      var ex = bb[3] - bb[0], ey = bb[4] - bb[1], ez = bb[5] - bb[2];
      var elen = Math.sqrt(ex*ex + ey*ey + ez*ez);
      if (elen > 1e-12) {
        var ux = ex/elen, uy = ey/elen, uz = ez/elen;
        rStrut[i] = Math.sqrt(rLocX*rLocX*ux*ux + rLocY*rLocY*uy*uy + rLocZ*rLocZ*uz*uz);
      } else {
        rStrut[i] = Math.sqrt((rLocX*rLocX + rLocY*rLocY + rLocZ*rLocZ)/3);
      }
      if (rStrut[i] > maxR) maxR = rStrut[i];
    }

    var nodeX = null, nodeY = null, nodeZ = null, nodeCount = 0;
    if (useBalls) {
      var TOL = 1e-5, INV_TOL = 1/TOL, seen = {}, tmpX = [], tmpY = [], tmpZ = [];
      for (var j = 0; j < N; j++) {
        var keyA = Math.round(ax[j]*INV_TOL) + ',' + Math.round(ay[j]*INV_TOL) + ',' + Math.round(az[j]*INV_TOL);
        if (!seen[keyA]) { seen[keyA] = 1; tmpX.push(ax[j]); tmpY.push(ay[j]); tmpZ.push(az[j]); }
        var keyB = Math.round(bx[j]*INV_TOL) + ',' + Math.round(by[j]*INV_TOL) + ',' + Math.round(bz[j]*INV_TOL);
        if (!seen[keyB]) { seen[keyB] = 1; tmpX.push(bx[j]); tmpY.push(by[j]); tmpZ.push(bz[j]); }
      }
      nodeX = new Float64Array(tmpX); nodeY = new Float64Array(tmpY); nodeZ = new Float64Array(tmpZ);
      nodeCount = tmpX.length;
    }

    var halo = maxR + sminLocal + ballLocal + 0.02;

    /* per-axis world↔cell-local and geometric-mean cell-local→world scale */
    var L2Wx = 5/cellScaleX, L2Wy = 5/cellScaleY, L2Wz = 5/cellScaleZ;
    var L2Wgeo = Math.cbrt(L2Wx*L2Wy*L2Wz);
    /* Lab solver→cell-local: lx = solver · cellScale/π. Distance back to
       solver units: out = cellLocalDist · L2Wgeo · (π/5). */
    var inX = cellScaleX/Math.PI, inY = cellScaleY/Math.PI, inZ = cellScaleZ/Math.PI;
    var outScale = L2Wgeo * Math.PI / 5;

    if (!recipe.family) recipe.family = 'beam';
    return {
      N: N, ax: ax, ay: ay, az: az, bx: bx, by: by, bz: bz, rStrut: rStrut,
      useSmin: useSmin, sminLocal: sminLocal, useBalls: useBalls, ballLocal: ballLocal,
      nodeX: nodeX, nodeY: nodeY, nodeZ: nodeZ, nodeCount: nodeCount,
      halo: halo, inX: inX, inY: inY, inZ: inZ, outScale: outScale
    };
  },

  /* capsule + node-ball union at a single cell-local query point */
  _capsuleUnion: function (P, qx, qy, qz) {
    var d = 1e6, N = P.N;
    var ax = P.ax, ay = P.ay, az = P.az, bx = P.bx, by = P.by, bz = P.bz, rStrut = P.rStrut;
    var useSmin = P.useSmin, sminLocal = P.sminLocal;
    for (var i = 0; i < N; i++) {
      var dx = qx - ax[i], dy = qy - ay[i], dz = qz - az[i];
      var ex = bx[i] - ax[i], ey = by[i] - ay[i], ez = bz[i] - az[i];
      var ll = ex*ex + ey*ey + ez*ez;
      var h = ll > 1e-12 ? (dx*ex + dy*ey + dz*ez)/ll : 0;
      if (h < 0) h = 0; else if (h > 1) h = 1;
      var px = dx - ex*h, py = dy - ey*h, pz = dz - ez*h;
      var di = Math.sqrt(px*px + py*py + pz*pz) - rStrut[i];
      d = useSmin ? this._smin(d, di, sminLocal) : (di < d ? di : d);
    }
    if (P.useBalls) {
      var nX = P.nodeX, nY = P.nodeY, nZ = P.nodeZ, ballLocal = P.ballLocal;
      for (var n = 0; n < P.nodeCount; n++) {
        var bdx = qx - nX[n], bdy = qy - nY[n], bdz = qz - nZ[n];
        var bdi = Math.sqrt(bdx*bdx + bdy*bdy + bdz*bdz) - ballLocal;
        d = useSmin ? this._smin(d, bdi, sminLocal) : (bdi < d ? bdi : d);
      }
    }
    return d;
  },

  /* NEGATIVE-INSIDE SDF in solver space. Maps solver→cell-local, wraps to
     the [-1,1] unit cell, unions capsules, and adds the 26-neighbour halo
     so struts crossing a cell face are not clipped (single-cube, option A). */
  evaluate: function (params, x, y, z) {
    var lx = x*params.inX, ly = y*params.inY, lz = z*params.inZ;
    var qx = ((lx + 1) - 2*Math.floor((lx + 1)/2)) - 1;
    var qy = ((ly + 1) - 2*Math.floor((ly + 1)/2)) - 1;
    var qz = ((lz + 1) - 2*Math.floor((lz + 1)/2)) - 1;

    var d = this._capsuleUnion(params, qx, qy, qz);
    var halo = params.halo;
    var nx_ = qx > 1 - halo, px_ = qx < -1 + halo;
    var ny_ = qy > 1 - halo, py_ = qy < -1 + halo;
    var nz_ = qz > 1 - halo, pz_ = qz < -1 + halo;

    if (nx_ || px_ || ny_ || py_ || nz_ || pz_) {
      if (nx_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy,   qz));
      if (px_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy,   qz));
      if (ny_) d = Math.min(d, this._capsuleUnion(params, qx,   qy-2, qz));
      if (py_) d = Math.min(d, this._capsuleUnion(params, qx,   qy+2, qz));
      if (nz_) d = Math.min(d, this._capsuleUnion(params, qx,   qy,   qz-2));
      if (pz_) d = Math.min(d, this._capsuleUnion(params, qx,   qy,   qz+2));
      if (nx_&&ny_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy-2, qz));
      if (nx_&&py_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy+2, qz));
      if (px_&&ny_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy-2, qz));
      if (px_&&py_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy+2, qz));
      if (nx_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy,   qz-2));
      if (nx_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy,   qz+2));
      if (px_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy,   qz-2));
      if (px_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy,   qz+2));
      if (ny_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx,   qy-2, qz-2));
      if (ny_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx,   qy-2, qz+2));
      if (py_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx,   qy+2, qz-2));
      if (py_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx,   qy+2, qz+2));
      if (nx_&&ny_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy-2, qz-2));
      if (nx_&&ny_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy-2, qz+2));
      if (nx_&&py_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy+2, qz-2));
      if (nx_&&py_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx-2, qy+2, qz+2));
      if (px_&&ny_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy-2, qz-2));
      if (px_&&ny_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy-2, qz+2));
      if (px_&&py_&&nz_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy+2, qz-2));
      if (px_&&py_&&pz_) d = Math.min(d, this._capsuleUnion(params, qx+2, qy+2, qz+2));
    }
    return d * params.outScale;
  }
};


/* ============================================================
   Register the three SDF families into the existing KERNELS
   registry built in 13-kernels.js.  Load order (index.html):
   13-kernels.js → 13b-kernels-new.js, so KERNELS exists here.
   ============================================================ */
if (typeof KERNELS !== 'undefined') {
  KERNELS.beam   = BeamKernel;
  KERNELS.bundle = BundleKernel;
  KERNELS.wave   = WaveKernel;
}

/* node/test harness export (browser ignores) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BeamKernel, BundleKernel, WaveKernel, BSDF, _bundleParamsFromJSON, _bundleXYPeriod };
}
