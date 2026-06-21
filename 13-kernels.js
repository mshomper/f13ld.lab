/* ============================================================
   F13LD.lab · 13-kernels.js
   Field kernels — TPMS, Noise, Grain.

   Ported VERBATIM from F13LD.sweep so the field math in lab
   matches sweep's hardened implementation byte-for-byte. The
   sweep-only methods (parseRecipe variants for jitter, jitterParams,
   emitGLSLField) are stripped — lab consumes recipes directly and
   evaluates analytically rather than emitting preview shaders.

   Coordinate convention: solver-space (x,y,z) ∈ [-π, π]³.
   Sign convention: evaluate() returns positive-inside for TPMS solid,
   while the family-specific applyMode wrappers handle the rest.
   ============================================================ */


/* ============================================================
   resolveRawPreset — TPMS preset names → term arrays.
   Sweep ships these four; lab inherits the same set so any
   recipe with a `surface.preset` name resolves identically.
   ============================================================ */
function resolveRawPreset(preset) {
  var mk = function (factors, coef) { return { on: true, coef: coef, factors: factors }; };
  var f  = function (trig, fx, fy, fz) {
    return { trig: trig, fx: (fx == null ? 1 : fx), fy: (fy == null ? 1 : fy), fz: (fz == null ? 1 : fz) };
  };
  switch (preset) {
    case 'fks':       // Fischer-Koch S
      return [
        mk([f('cos(x)',2,1,1), f('sin(y)'), f('cos(z)')], 1),
        mk([f('cos(y)',1,2,1), f('sin(z)'), f('cos(x)')], 1),
        mk([f('cos(z)',1,1,2), f('sin(x)'), f('cos(y)')], 1)
      ];
    case 'lidinoid':
      return [
        mk([f('sin(x)',2,1,1), f('cos(y)'), f('sin(z)')],  1.1),
        mk([f('sin(y)',1,2,1), f('cos(z)'), f('sin(x)')],  1.1),
        mk([f('sin(z)',1,1,2), f('cos(x)'), f('sin(y)')],  1.1),
        mk([f('cos(x)',2,1,1), f('cos(y)',1,2,1)],         -0.2),
        mk([f('cos(y)',1,2,1), f('cos(z)',1,1,2)],         -0.2),
        mk([f('cos(z)',1,1,2), f('cos(x)',2,1,1)],         -0.2),
        mk([f('cos(x)',2,1,1)],                            -0.4),
        mk([f('cos(y)',1,2,1)],                            -0.4),
        mk([f('cos(z)',1,1,2)],                            -0.4)
      ];
    case 'splitP':
      return [
        mk([f('sin(x)'), f('sin(y)'), f('cos(z)')], 1),
        mk([f('sin(y)'), f('sin(z)'), f('cos(x)')], 1),
        mk([f('sin(z)'), f('sin(x)'), f('cos(y)')], 1)
      ];
    case 'frd':
      return [
        mk([f('sin(x)',2,1,1), f('cos(y)'), f('sin(z)')],  1),
        mk([f('sin(y)',1,2,1), f('cos(z)'), f('sin(x)')],  1),
        mk([f('sin(z)',1,1,2), f('cos(x)'), f('sin(y)')],  1),
        mk([f('cos(x)',2,1,1), f('cos(y)',1,2,1)],         -1),
        mk([f('cos(y)',1,2,1), f('cos(z)',1,1,2)],         -1),
        mk([f('cos(z)',1,1,2), f('cos(x)',2,1,1)],         -1)
      ];
    default:
      return null;
  }
}

/* ============================================================
   evaluateTpms — TPMS field at a point.
   Verbatim port. Per-term phase shift handled by adding ps to
   each axis before applying the term's trig factors.
   ============================================================ */
function evaluateTpms(terms, x, y, z) {
  var result = 0;
  for (var i = 0; i < terms.length; i++) {
    var term = terms[i];
    if (!term.on) continue;
    var ps = term.phase_shift || { x: 0, y: 0, z: 0 };
    var xs = x + ps.x, ys = y + ps.y, zs = z + ps.z;
    var product = term.coef;
    for (var fi = 0; fi < term.factors.length; fi++) {
      var fac = term.factors[fi];
      var trig = fac.trig;
      if      (trig === 'sin(x)') product *= Math.sin(fac.fx * xs);
      else if (trig === 'cos(x)') product *= Math.cos(fac.fx * xs);
      else if (trig === 'sin(y)') product *= Math.sin(fac.fy * ys);
      else if (trig === 'cos(y)') product *= Math.cos(fac.fy * ys);
      else if (trig === 'sin(z)') product *= Math.sin(fac.fz * zs);
      else if (trig === 'cos(z)') product *= Math.cos(fac.fz * zs);
    }
    result += product;
  }
  return result;
}


/* ════════════════════════════════════════════════════════════
   TpmsKernel
   ════════════════════════════════════════════════════════════ */
var TpmsKernel = {
  family: 'tpms',

  parseRecipe: function (recipe) {
    var terms;
    var s = recipe.surface || {};
    if (s.type === 'raw_preset' || !s.terms) {
      var preset = s.preset || (recipe.meta && recipe.meta.preset);
      terms = resolveRawPreset(preset);
      if (!terms) throw new Error('TpmsKernel: raw preset "' + preset + '" could not be resolved');
    } else {
      terms = s.terms;
    }
    /* Normalization flags (mesh shell_normalize / pi_normalize).
       Per the alignment session: a recipe now carries these in its
       geometry block.  When ABSENT (older recipe), default to OFF —
       no normalization — and respect an explicit true/false otherwise.
       buildVoxels reads these off params (no call-site signature change). */
    var g = recipe.geometry || {};
    return {
      terms:     terms,
      shellNorm: (g.shell_normalize !== undefined) ? !!g.shell_normalize : false,
      piNorm:    (g.pi_normalize    !== undefined) ? !!g.pi_normalize    : false
    };
  },

  evaluate: function (params, x, y, z) {
    return evaluateTpms(params.terms, x, y, z);
  }
};


/* ════════════════════════════════════════════════════════════
   NoiseKernel — seven deterministic noise types from F13LD.noise
   Verbatim port. snoise / cellular / fbm / warp / ridged / billow / curl.
   ════════════════════════════════════════════════════════════ */
var NoiseKernel = {
  family: 'noise',

  _mod289:  function (x) { return x - Math.floor(x / 289.0) * 289.0; },
  _permute: function (x) { return this._mod289(((x * 34.0) + 1.0) * x); },
  _tis:     function (r) { return 1.79284291400159 - 0.85373472095314 * r; },
  _frac:    function (x) { return x - Math.floor(x); },

  /* 3D simplex noise — verbatim from Noise tool DeterministicNoise.snoise */
  _snoise: function (vx, vy, vz) {
    var C0 = 1.0/6.0, C1 = 1.0/3.0;
    var s = (vx+vy+vz)*C1;
    var ix = Math.floor(vx+s), iy = Math.floor(vy+s), iz = Math.floor(vz+s);
    var t = (ix+iy+iz)*C0;
    var x0x = vx-ix+t, x0y = vy-iy+t, x0z = vz-iz+t;
    var gx = x0x>=x0y?1:0, gy = x0y>=x0z?1:0, gz = x0z>=x0x?1:0;
    var lx = 1-gx, ly = 1-gy, lz = 1-gz;
    var i1x = Math.min(gx,lz), i1y = Math.min(gy,lx), i1z = Math.min(gz,ly);
    var i2x = Math.max(gx,lz), i2y = Math.max(gy,lx), i2z = Math.max(gz,ly);
    var x1x = x0x-i1x+C0, x1y = x0y-i1y+C0, x1z = x0z-i1z+C0;
    var x2x = x0x-i2x+C1, x2y = x0y-i2y+C1, x2z = x0z-i2z+C1;
    var x3x = x0x-0.5,    x3y = x0y-0.5,    x3z = x0z-0.5;
    ix = this._mod289(ix); iy = this._mod289(iy); iz = this._mod289(iz);
    var p0 = this._permute(this._permute(this._permute(iz)+iy)+ix);
    var p1 = this._permute(this._permute(this._permute(iz+i1z)+iy+i1y)+ix+i1x);
    var p2 = this._permute(this._permute(this._permute(iz+i2z)+iy+i2y)+ix+i2x);
    var p3 = this._permute(this._permute(this._permute(iz+1)+iy+1)+ix+1);
    var nx = 0.285714285714, ny = -0.928571428571, nz = 0.142857142857;
    var j0 = p0-49*Math.floor(p0*nz*nz);
    var j1 = p1-49*Math.floor(p1*nz*nz);
    var j2 = p2-49*Math.floor(p2*nz*nz);
    var j3 = p3-49*Math.floor(p3*nz*nz);
    var x0_ = Math.floor(j0*nz), y0_ = Math.floor(j0-7*x0_);
    var x1_ = Math.floor(j1*nz), y1_ = Math.floor(j1-7*x1_);
    var x2_ = Math.floor(j2*nz), y2_ = Math.floor(j2-7*x2_);
    var x3_ = Math.floor(j3*nz), y3_ = Math.floor(j3-7*x3_);
    var xs0 = x0_*nx+ny, ys0 = y0_*nx+ny;
    var xs1 = x1_*nx+ny, ys1 = y1_*nx+ny;
    var xs2 = x2_*nx+ny, ys2 = y2_*nx+ny;
    var xs3 = x3_*nx+ny, ys3 = y3_*nx+ny;
    var h0 = 1-Math.abs(xs0)-Math.abs(ys0);
    var h1 = 1-Math.abs(xs1)-Math.abs(ys1);
    var h2 = 1-Math.abs(xs2)-Math.abs(ys2);
    var h3 = 1-Math.abs(xs3)-Math.abs(ys3);
    var sh0 = h0<=0?-1:0, sh1 = h1<=0?-1:0, sh2 = h2<=0?-1:0, sh3 = h3<=0?-1:0;
    var pp0x = xs0+(Math.floor(xs0)*2+1)*sh0, pp0y = ys0+(Math.floor(ys0)*2+1)*sh0, pp0z = h0;
    var pp1x = xs1+(Math.floor(xs1)*2+1)*sh1, pp1y = ys1+(Math.floor(ys1)*2+1)*sh1, pp1z = h1;
    var pp2x = xs2+(Math.floor(xs2)*2+1)*sh2, pp2y = ys2+(Math.floor(ys2)*2+1)*sh2, pp2z = h2;
    var pp3x = xs3+(Math.floor(xs3)*2+1)*sh3, pp3y = ys3+(Math.floor(ys3)*2+1)*sh3, pp3z = h3;
    var n0 = this._tis(pp0x*pp0x+pp0y*pp0y+pp0z*pp0z);
    var n1 = this._tis(pp1x*pp1x+pp1y*pp1y+pp1z*pp1z);
    var n2 = this._tis(pp2x*pp2x+pp2y*pp2y+pp2z*pp2z);
    var n3 = this._tis(pp3x*pp3x+pp3y*pp3y+pp3z*pp3z);
    pp0x*=n0; pp0y*=n0; pp0z*=n0;
    pp1x*=n1; pp1y*=n1; pp1z*=n1;
    pp2x*=n2; pp2y*=n2; pp2z*=n2;
    pp3x*=n3; pp3y*=n3; pp3z*=n3;
    var m0 = Math.max(0.6-(x0x*x0x+x0y*x0y+x0z*x0z),0); m0*=m0;
    var m1 = Math.max(0.6-(x1x*x1x+x1y*x1y+x1z*x1z),0); m1*=m1;
    var m2 = Math.max(0.6-(x2x*x2x+x2y*x2y+x2z*x2z),0); m2*=m2;
    var m3 = Math.max(0.6-(x3x*x3x+x3y*x3y+x3z*x3z),0); m3*=m3;
    return 42*(m0*m0*(pp0x*x0x+pp0y*x0y+pp0z*x0z)+
               m1*m1*(pp1x*x1x+pp1y*x1y+pp1z*x1z)+
               m2*m2*(pp2x*x2x+pp2y*x2y+pp2z*x2z)+
               m3*m3*(pp3x*x3x+pp3y*x3y+pp3z*x3z));
  },

  /* Cellular (Worley F2-F1) */
  _cellular: function (px, py, pz, metric) {
    var pix = Math.floor(px), piy = Math.floor(py), piz = Math.floor(pz);
    var pfx = px-pix, pfy = py-piy, pfz = pz-piz;
    var d1 = 10, d2 = 10;
    for (var oz=-1; oz<=1; oz++) for (var oy=-1; oy<=1; oy++) for (var ox=-1; ox<=1; ox++) {
      var cx = pix+ox, cy = piy+oy, cz = piz+oz;
      var rpx = this._frac(Math.sin(cx*127.1+cy*311.7+cz*74.7)*43758.5453);
      var rpy = this._frac(Math.sin(cx*269.5+cy*183.3+cz*246.1)*43758.5453);
      var rpz = this._frac(Math.sin(cx*113.5+cy*271.9+cz*124.6)*43758.5453);
      var dx = ox+rpx-pfx, dy = oy+rpy-pfy, dz = oz+rpz-pfz;
      var d = metric==='euclidean' ? Math.sqrt(dx*dx+dy*dy+dz*dz) :
              metric==='manhattan' ? Math.abs(dx)+Math.abs(dy)+Math.abs(dz) :
              Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz)));
      if (d<d1) { d2=d1; d1=d; } else if (d<d2) d2=d;
    }
    return Math.max(Math.min((d2-d1)*2-1, 1), -1);
  },

  _fbm: function (px, py, pz, octaves, lacunarity, gain) {
    var v = 0, a = 1, f = 1, mx = 0;
    for (var i = 0; i < octaves; i++) {
      v += this._snoise(px*f, py*f, pz*f) * a;
      mx += a; a *= gain; f *= lacunarity;
    }
    return v / mx;
  },

  _warp: function (px, py, pz, strength, octaves, lacunarity, gain) {
    var qx = this._fbm(px, py, pz, octaves, lacunarity, gain);
    var qy = this._fbm(px+5.2, py+1.3, pz+8.1, octaves, lacunarity, gain);
    var qz = this._fbm(px+3.7, py+9.4, pz+2.8, octaves, lacunarity, gain);
    return this._fbm(px+strength*qx, py+strength*qy, pz+strength*qz, octaves, lacunarity, gain);
  },

  _ridged: function (px, py, pz, octaves, lacunarity, gain) {
    var v = 0, a = 1, f = 1, mx = 0;
    for (var i = 0; i < octaves; i++) {
      v += (1 - Math.abs(this._snoise(px*f, py*f, pz*f))) * a;
      mx += a; a *= gain; f *= lacunarity;
    }
    return (v/mx) * 2.0 - 1.0;
  },

  _billow: function (px, py, pz, octaves, lacunarity, gain) {
    var v = 0, a = 1, f = 1, mx = 0;
    for (var i = 0; i < octaves; i++) {
      v += Math.abs(this._snoise(px*f, py*f, pz*f)) * a;
      mx += a; a *= gain; f *= lacunarity;
    }
    return (v/mx) * 2.0 - 1.0;
  },

  /* Curl noise — magnitude of ∇×Ψ from a simplex vector potential.
     9 snoise calls per evaluation. */
  _curl: function (px, py, pz, curlStep, potScale) {
    var s = potScale, e = curlStep;
    var psi_x = this._snoise(px*s,           py*s,           pz*s);
    var psi_y = this._snoise(px*s+3.7,       py*s+1.5,       pz*s+2.8);
    var psi_z = this._snoise(px*s+1.2,       py*s+4.6,       pz*s+0.9);
    var pzy   = this._snoise(px*s+1.2,       (py+e)*s+4.6,   pz*s+0.9);
    var pyz   = this._snoise(px*s+3.7,       py*s+1.5,       (pz+e)*s+2.8);
    var pxz   = this._snoise(px*s,           py*s,           (pz+e)*s);
    var pzx   = this._snoise((px+e)*s+1.2,   py*s+4.6,       pz*s+0.9);
    var pyx   = this._snoise((px+e)*s+3.7,   py*s+1.5,       pz*s+2.8);
    var pxy   = this._snoise(px*s,           (py+e)*s,       pz*s);
    var cx = (pzy-psi_z)/e - (pyz-psi_y)/e;
    var cy = (pxz-psi_x)/e - (pzx-psi_z)/e;
    var cz = (pyx-psi_y)/e - (pxy-psi_x)/e;
    return Math.sqrt(cx*cx + cy*cy + cz*cz);
  },

  _sampleRaw: function (params, sx, sy, sz) {
    var t = params.noiseType;
    if (t === 'simplex')  return this._snoise(sx, sy, sz);
    if (t === 'cellular') return this._cellular(sx, sy, sz, params.distanceMetric);
    if (t === 'fbm')      return this._fbm(sx, sy, sz, params.octaves, params.lacunarity, params.gain);
    if (t === 'ridged')   return this._ridged(sx, sy, sz, params.octaves, params.lacunarity, params.gain);
    if (t === 'billow')   return this._billow(sx, sy, sz, params.octaves, params.lacunarity, params.gain);
    if (t === 'curl')     return this._curl(sx, sy, sz, params.curlStep || 0.1, params.potentialScale || 1.0);
    return this._warp(sx, sy, sz, params.warpStrength, params.octaves, params.lacunarity, params.gain);
  },

  /* 16³ prepass — finds noiseMin/noiseMax for normalization */
  _prepass: function (params) {
    var N = 16, SCALE = 5.0/Math.PI;
    var sx = params.scaleX || 1, sy = params.scaleY || 1, sz = params.scaleZ || 1;
    var mn = Infinity, mx = -Infinity;
    for (var zi = 0; zi < N; zi++) for (var yi = 0; yi < N; yi++) for (var xi = 0; xi < N; xi++) {
      var px = ((xi/(N-1))*2-1) * Math.PI;
      var py = ((yi/(N-1))*2-1) * Math.PI;
      var pz = ((zi/(N-1))*2-1) * Math.PI;
      var v = this._sampleRaw(params,
        px*SCALE*params.frequency*sx,
        py*SCALE*params.frequency*sy,
        pz*SCALE*params.frequency*sz);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    var range = mx - mn;
    return { noiseMin: mn - range*0.05, noiseMax: mx + range*0.05 };
  },

  parseRecipe: function (recipe) {
    var s = recipe.surface || {};
    if (s.type !== 'noise') {
      throw new Error("NoiseKernel.parseRecipe: expected surface.type='noise', got '" + s.type + "'");
    }
    var params = {
      noiseType:      s.noise_type || 'simplex',
      frequency:      s.frequency || 0.3,
      scaleX:         s.scale_x || 1.0,
      scaleY:         s.scale_y || 1.0,
      scaleZ:         s.scale_z || 1.0,
      isoLevel:       s.center != null ? s.center : 0,
      halfWidth:      s.half_width != null ? s.half_width : 0.15,
      smoothing:      s.smoothing || 0,
      octaves:        s.octaves || 4,
      lacunarity:     s.lacunarity || 2.0,
      gain:           s.gain || 0.5,
      warpStrength:   s.warp_strength != null ? s.warp_strength : 1.0,
      distanceMetric: s.distance_metric || 'euclidean',
      curlStep:       s.curl_step || 0.1,
      potentialScale: s.potential_scale || 1.0,
      halfInvert:     !!(recipe.geometry && recipe.geometry.half_invert)
    };
    if (!recipe.family) recipe.family = 'noise';
    var bounds = this._prepass(params);
    params.noiseMin = bounds.noiseMin;
    params.noiseMax = bounds.noiseMax;
    return params;
  },

  /* CPU field evaluation — solver-space (x,y,z) ∈ [-π, π]³. Returns
     normalized field value in roughly [-1, 1]. */
  evaluate: function (params, x, y, z) {
    var SCALE = 5.0/Math.PI;
    var Sx = SCALE * params.frequency * params.scaleX;
    var Sy = SCALE * params.frequency * params.scaleY;
    var Sz = SCALE * params.frequency * params.scaleZ;
    var raw = this._sampleRaw(params, x*Sx, y*Sy, z*Sz);
    var mid = (params.noiseMin + params.noiseMax) * 0.5;
    var halfR = Math.max((params.noiseMax - params.noiseMin) * 0.5, 0.001);
    return (raw - mid) / halfR;
  }
};


/* ════════════════════════════════════════════════════════════
   GrainKernel — spinodoid + GRF + hyperuniform from F13LD.grain
   Reaction-diffusion is deferred (texture-based, not analytic).
   Verbatim port of the analytic field generators.
   ════════════════════════════════════════════════════════════ */
var GrainKernel = {
  family: 'grain',

  _mulberry32: function (seed) {
    var s = seed | 0;
    return function () {
      s = (s ^ (s << 13)) >>> 0;
      s = (s ^ (s >> 17)) >>> 0;
      s = (s ^ (s << 5))  >>> 0;
      return s / 4294967296;
    };
  },

  /* von Mises-Fisher around the +z pole (caller rotates with _rotateTo) */
  _sampleVMF: function (rng, kappa) {
    if (kappa < 0.05) {
      var z = 2*rng() - 1, phi = 2*Math.PI*rng();
      var sr = Math.sqrt(Math.max(0, 1 - z*z));
      return [sr*Math.cos(phi), sr*Math.sin(phi), z];
    }
    var w, iter = 0;
    do {
      var xi = rng();
      w = 1 + Math.log(Math.max(xi + (1 - xi)*Math.exp(-2*kappa), 1e-30)) / kappa;
      iter++;
    } while ((w < -1 || w > 1) && iter < 2000);
    if (w < -1) w = -1; if (w > 1) w = 1;
    var phi2 = 2*Math.PI*rng(), sr2 = Math.sqrt(Math.max(0, 1 - w*w));
    return [sr2*Math.cos(phi2), sr2*Math.sin(phi2), w];
  },

  _rotateTo: function (v, mux, muy, muz) {
    if (Math.abs(muz + 1) < 1e-6) return [-v[0], -v[1], -v[2]];
    if (Math.abs(muz - 1) < 1e-6) return v.slice();
    var ax = -muy, ay = mux;
    var al = Math.sqrt(ax*ax + ay*ay); ax /= al; ay /= al;
    var angle = Math.acos(Math.min(Math.max(muz, -1), 1));
    var c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    var vx = v[0], vy = v[1], vz = v[2];
    return [
      (t*ax*ax + c)*vx + (t*ax*ay)*vy + ( s*ay)*vz,
      (t*ax*ay)*vx    + (t*ay*ay + c)*vy + (-s*ax)*vz,
      (-s*ay)*vx      + (s*ax)*vy        + c*vz
    ];
  },

  _jitteredGrid3D: function (N, rng) {
    var cells = Math.ceil(Math.pow(N, 1/3));
    var cellSize = 1.0 / cells;
    var pts = [];
    for (var ix = 0; ix < cells; ix++)
      for (var iy = 0; iy < cells; iy++)
        for (var iz = 0; iz < cells; iz++) {
          var px = (ix + 0.5 + (rng() - 0.5) * 0.9) * cellSize;
          var py = (iy + 0.5 + (rng() - 0.5) * 0.9) * cellSize;
          var pz = (iz + 0.5 + (rng() - 0.5) * 0.9) * cellSize;
          pts.push([
            Math.max(0.01, Math.min(0.99, px)),
            Math.max(0.01, Math.min(0.99, py)),
            Math.max(0.01, Math.min(0.99, pz))
          ]);
        }
    for (var i = pts.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = pts[i]; pts[i] = pts[j]; pts[j] = tmp;
    }
    return pts.slice(0, N);
  },

  /* Spinodoid waves: VMF-sampled directions, magnitude 2π·freq ±15% */
  _buildSpinodoidWaves: function (p) {
    var rng = this._mulberry32(p.rngSeed);
    var N = p.nWaves, freq = p.frequency, kappa = p.kappa, mode = p.dirMode;
    var mux = p.principalX, muy = p.principalY, muz = p.principalZ;
    var axes = [[1,0,0],[0,1,0],[0,0,1]];
    var wts  = [p.wX, p.wY, p.wZ];
    var totalW = Math.max(wts[0] + wts[1] + wts[2], 1e-6);
    var waves = [];
    for (var i = 0; i < N; i++) {
      var dir;
      if (mode === 'iso') {
        dir = this._sampleVMF(rng, 0);
      } else if (mode === 'single') {
        dir = this._rotateTo(this._sampleVMF(rng, kappa), mux, muy, muz);
      } else { /* ortho */
        var r = rng() * totalW;
        var cum = 0, chosen = 0;
        for (var a = 0; a < 3; a++) { cum += wts[a]; if (r <= cum) { chosen = a; break; } }
        dir = this._rotateTo(this._sampleVMF(rng, kappa),
                             axes[chosen][0], axes[chosen][1], axes[chosen][2]);
      }
      var mag = 2*Math.PI*freq*(0.85 + 0.3*rng());
      var phase = 2*Math.PI*rng();
      waves.push({ kx: dir[0]*mag, ky: dir[1]*mag, kz: dir[2]*mag, phase: phase });
    }
    return waves;
  },

  /* GRF waves: uniform directions, Gaussian-sampled magnitudes */
  _buildGRFWaves: function (p) {
    var rng = this._mulberry32(p.rngSeed);
    var N = p.nWaves, freq = p.frequency, mode = p.dirMode;
    var sigmafrac = p.grfSigma || 0.45;
    var k0base = 2*Math.PI*freq;
    var mux = p.principalX, muy = p.principalY, muz = p.principalZ;
    var waves = [];
    function randn() {
      var u = Math.max(rng(), 1e-10), v = rng();
      return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v);
    }
    for (var i = 0; i < N; i++) {
      var dir = this._sampleVMF(rng, 0);
      var k0;
      if (mode === 'ortho') {
        var wx = p.wX, wy = p.wY, wz = p.wZ;
        var totalW = Math.max(wx + wy + wz, 1e-6);
        wx /= totalW; wy /= totalW; wz /= totalW;
        var maxW = Math.max(wx, wy, wz);
        var kScale = 1.0 / (Math.max(wx*dir[0]*dir[0] + wy*dir[1]*dir[1] + wz*dir[2]*dir[2], 0.05) / maxW);
        kScale = Math.min(Math.max(kScale, 0.3), 3.0);
        k0 = k0base * kScale;
      } else if (mode === 'single') {
        var alignment = Math.abs(dir[0]*mux + dir[1]*muy + dir[2]*muz);
        k0 = k0base * (1.5 - alignment);
      } else {
        k0 = k0base;
      }
      var sigma = sigmafrac * k0;
      var mag, tries = 0;
      do { mag = k0 + randn()*sigma; tries++; } while (mag <= 0 && tries < 30);
      if (mag <= 0) mag = k0 * 0.1;
      var phase = 2*Math.PI*rng();
      waves.push({ kx: dir[0]*mag, ky: dir[1]*mag, kz: dir[2]*mag, phase: phase });
    }
    return waves;
  },

  /* Hyperuniform: anisotropic Gaussian kernels at jittered grid points */
  _buildHUKernels: function (p) {
    var rng = this._mulberry32(p.rngSeed);
    var N = p.huN || 80, aspect = p.huAspect || 4.0, bw = p.huWidth || 0.04;
    var ell = p.huEll || 1, sq = Math.sqrt(ell);
    var a = bw * aspect * 0.5, b = bw * 0.5, b1 = b / sq, b2 = b * sq;
    var kappa = p.kappa, mode = p.dirMode;
    var pts = this._jitteredGrid3D(N, rng);
    var mux = p.principalX, muy = p.principalY, muz = p.principalZ;
    var axes = [[1,0,0],[0,1,0],[0,0,1]];
    var wts  = [p.wX, p.wY, p.wZ];
    var totalW = Math.max(wts[0] + wts[1] + wts[2], 1e-6);
    function cross3(u, v) {
      return [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
    }
    function norm3(v) {
      var l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
      return [v[0]/l, v[1]/l, v[2]/l];
    }
    var kernels = [];
    var TWO_PI = 2.0 * Math.PI;
    for (var i = 0; i < N; i++) {
      var t;
      if (mode === 'iso') {
        t = this._sampleVMF(rng, 0);
      } else if (mode === 'single') {
        t = this._rotateTo(this._sampleVMF(rng, kappa), mux, muy, muz);
      } else {
        var r = rng() * totalW;
        var cum = 0, chosen = 0;
        for (var ax = 0; ax < 3; ax++) { cum += wts[ax]; if (r <= cum) { chosen = ax; break; } }
        t = this._rotateTo(this._sampleVMF(rng, kappa),
                           axes[chosen][0], axes[chosen][1], axes[chosen][2]);
      }
      var arb = (Math.abs(t[0]) < 0.9) ? [1, 0, 0] : [0, 1, 0];
      var n1 = norm3(cross3(t, arb));
      var n2 = norm3(cross3(t, n1));
      kernels.push({
        px: pts[i][0]*TWO_PI - Math.PI,
        py: pts[i][1]*TWO_PI - Math.PI,
        pz: pts[i][2]*TWO_PI - Math.PI,
        tx: t[0],   ty: t[1],   tz: t[2],
        n1x: n1[0], n1y: n1[1], n1z: n1[2],
        n2x: n2[0], n2y: n2[1], n2z: n2[2],
        a: a * TWO_PI,
        b1: b1 * TWO_PI,
        b2: b2 * TWO_PI
      });
    }
    kernels.cross = p.huCross || 2;
    kernels.sharp = p.huSharp || 1;
    kernels.blend = p.huBlend || 1;
    return kernels;
  },

  parseRecipe: function (recipe) {
    if (!recipe.field) {
      throw new Error("GrainKernel.parseRecipe: recipe missing 'field' block");
    }
    var f = recipe.field;
    var g = recipe.geometry || {};
    var ft = f.type;
    if (ft === 'reactiondiffusion') {
      throw new Error("GrainKernel.parseRecipe: reaction-diffusion is deferred (texture-based; F13LD.lab uses analytic evaluators)");
    }
    if (ft !== 'spinodoid' && ft !== 'gaussian' && ft !== 'hyperuniform') {
      throw new Error("GrainKernel.parseRecipe: unsupported field.type '" + ft + "' (expected spinodoid | gaussian | hyperuniform)");
    }
    var pdir = (Array.isArray(f.principal_direction) && f.principal_direction.length === 3)
      ? f.principal_direction.slice()
      : [0, 0, 1];
    var pn = Math.sqrt(pdir[0]*pdir[0] + pdir[1]*pdir[1] + pdir[2]*pdir[2]) || 1;
    pdir = [pdir[0]/pn, pdir[1]/pn, pdir[2]/pn];
    var ow = (Array.isArray(f.ortho_weights) && f.ortho_weights.length === 3) ? f.ortho_weights : [1, 1, 1];
    var params = {
      fieldType:  ft,
      frequency:  f.frequency != null ? f.frequency : 0.27,
      rngSeed:    f.rng_seed  != null ? f.rng_seed  : 42,
      dirMode:    f.dir_mode  || 'single',
      kappa:      f.kappa     != null ? f.kappa     : 6,
      principalX: pdir[0], principalY: pdir[1], principalZ: pdir[2],
      wX: ow[0], wY: ow[1], wZ: ow[2],
      nWaves:    f.n_waves   != null ? f.n_waves   : 48,
      grfSigma:  f.grf_sigma != null ? f.grf_sigma : 0.45,
      huN:       f.hu_n      != null ? f.hu_n      : 80,
      huAspect:  f.hu_aspect != null ? f.hu_aspect : 4.0,
      huWidth:   f.hu_width  != null ? f.hu_width  : 0.04,
      huCross:   f.hu_cross  != null ? f.hu_cross  : 2,
      huSharp:   f.hu_sharp  != null ? f.hu_sharp  : 1,
      huBlend:   f.hu_blend  != null ? f.hu_blend  : 1,
      huEll:     f.hu_ell    != null ? f.hu_ell    : 1,
      isoLevel:  g.center      != null ? g.center      : 0,
      halfWidth: g.half_width  != null ? g.half_width  : 0.15,
      smoothing: g.smoothing   || 0,
      halfInvert: !!g.half_invert
    };
    if (ft === 'spinodoid')        params.waves   = this._buildSpinodoidWaves(params);
    else if (ft === 'gaussian')    params.waves   = this._buildGRFWaves(params);
    else                           params.kernels = this._buildHUKernels(params);
    if (!recipe.family) recipe.family = 'grain';
    return params;
  },

  /* CPU field evaluation — RAW field value at solver-space (x,y,z) ∈ [-π, π]³.
     Wave families: Σ cos(k·p + φ) / √N — natural range ~[-1, 1].
     HU family:     Σ exp(-Q(p - c)) - 0.3 — natural range ~[-0.3, 1]. */
  evaluate: function (params, x, y, z) {
    if (params.kernels) {
      var ks = params.kernels;
      var pe = ks.cross || 2, me = ks.sharp || 1, Pe = ks.blend || 1;
      var rnd = (pe === 2), shp = (me === 1), bl = (Pe === 1);
      var s = 0;
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        var dx = x - k.px, dy = y - k.py, dz = z - k.pz;
        var dt  = dx*k.tx  + dy*k.ty  + dz*k.tz;
        var dn1 = dx*k.n1x + dy*k.n1y + dz*k.n1z;
        var dn2 = dx*k.n2x + dy*k.n2y + dz*k.n2z;
        var u = dt/k.a, w1 = dn1/k.b1, w2 = dn2/k.b2;
        var R = u*u + (rnd ? (w1*w1 + w2*w2)
                           : (Math.pow(Math.abs(w1), pe) + Math.pow(Math.abs(w2), pe)));
        var Rm = shp ? R : Math.pow(R, me);
        s += bl ? Math.exp(-Rm) : Math.exp(-Pe*Rm);
      }
      if (!bl) s = Math.pow(s, 1/Pe);
      return s - 0.3;
    }
    var ws = params.waves;
    var N = ws.length;
    var s2 = 0;
    for (var i2 = 0; i2 < N; i2++) {
      s2 += Math.cos(ws[i2].kx*x + ws[i2].ky*y + ws[i2].kz*z + ws[i2].phase);
    }
    return s2 / Math.sqrt(N);
  }
};


/* ============================================================
   Family registry — kernel lookup by family name
   ============================================================ */
var KERNELS = { tpms: TpmsKernel, noise: NoiseKernel, grain: GrainKernel };


/* ============================================================
   applyMode / applyModeRaw — scalar field → solid mask threshold
   Family-agnostic. Modes: solid, shell, pi-tpms, noise-{sheet,half,solid},
   grain-{sheet,half,solid}.

   applyMode    returns 0/1 (binary mask)
   applyModeRaw returns signed scalar (raw>0 in void, raw<=0 in solid)
   ============================================================ */
function applyMode(evalFn, x, y, z, mode, modeArgs) {
  if (mode === 'pi-tpms') {
    var phiA = evalFn(x, y, z);
    var phiB = evalFn(x + modeArgs.dx, y + modeArgs.dy, z + modeArgs.dz);
    return Math.max(Math.abs(phiA), Math.abs(phiB)) < modeArgs.pipeR ? 1 : 0;
  }
  if (mode === 'shell')        return Math.abs(evalFn(x, y, z) - modeArgs.offset) < modeArgs.wt ? 1 : 0;
  if (mode === 'noise-sheet')  return Math.abs(evalFn(x, y, z) - modeArgs.isoLevel) < modeArgs.halfWidth ? 1 : 0;
  if (mode === 'noise-half') {
    var v = evalFn(x, y, z);
    return modeArgs.halfInvert ? (v < modeArgs.isoLevel ? 1 : 0) : (v > modeArgs.isoLevel ? 1 : 0);
  }
  if (mode === 'noise-solid')  return Math.abs(evalFn(x, y, z) - modeArgs.isoLevel) > modeArgs.halfWidth ? 1 : 0;
  if (mode === 'grain-sheet')  return Math.abs(evalFn(x, y, z) - modeArgs.isoLevel) < modeArgs.halfWidth ? 1 : 0;
  if (mode === 'grain-half') {
    var v2 = evalFn(x, y, z);
    return modeArgs.halfInvert ? (v2 < modeArgs.isoLevel ? 1 : 0) : (v2 > modeArgs.isoLevel ? 1 : 0);
  }
  if (mode === 'grain-solid')  return Math.abs(evalFn(x, y, z) - modeArgs.isoLevel) > modeArgs.halfWidth ? 1 : 0;
  /* solid (default — TPMS) */
  return (evalFn(x, y, z) - modeArgs.offset) < 0 ? 1 : 0;
}

function applyModeRaw(evalFn, x, y, z, mode, modeArgs) {
  if (mode === 'pi-tpms') {
    var phiA = evalFn(x, y, z);
    var phiB = evalFn(x + modeArgs.dx, y + modeArgs.dy, z + modeArgs.dz);
    return Math.max(Math.abs(phiA), Math.abs(phiB)) - modeArgs.pipeR;
  }
  if (mode === 'shell')        return Math.abs(evalFn(x, y, z) - modeArgs.offset) - modeArgs.wt;
  if (mode === 'noise-sheet')  return Math.abs(evalFn(x, y, z) - modeArgs.isoLevel) - modeArgs.halfWidth;
  if (mode === 'noise-half') {
    var v = evalFn(x, y, z);
    return modeArgs.halfInvert ? (v - modeArgs.isoLevel) : (modeArgs.isoLevel - v);
  }
  if (mode === 'noise-solid')  return modeArgs.halfWidth - Math.abs(evalFn(x, y, z) - modeArgs.isoLevel);
  if (mode === 'grain-sheet')  return Math.abs(evalFn(x, y, z) - modeArgs.isoLevel) - modeArgs.halfWidth;
  if (mode === 'grain-half') {
    var v2 = evalFn(x, y, z);
    return modeArgs.halfInvert ? (v2 - modeArgs.isoLevel) : (modeArgs.isoLevel - v2);
  }
  if (mode === 'grain-solid')  return modeArgs.halfWidth - Math.abs(evalFn(x, y, z) - modeArgs.isoLevel);
  return evalFn(x, y, z) - modeArgs.offset;
}

/* node/test harness export (browser ignores this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TpmsKernel: TpmsKernel, NoiseKernel: NoiseKernel, GrainKernel: GrainKernel,
    KERNELS: KERNELS, applyMode: applyMode, applyModeRaw: applyModeRaw,
    resolveRawPreset: resolveRawPreset, evaluateTpms: evaluateTpms
  };
}
