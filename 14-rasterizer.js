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

   Domain: [-π, +π]³ in solver coords, sampled at voxel centers.
   ============================================================ */
function buildVoxels(family, params, offset, N, mode, wt, nWeights, pipeR, phaseShift) {
  var L    = Math.PI;
  var step = (2 * L) / N;
  var N3   = N * N * N;
  var kernel = KERNELS[family || 'tpms'];
  if (!kernel) throw new Error('buildVoxels: unknown family "' + family + '"');

  /* Cache evaluate as a local closure — V8 keeps the tight loop monomorphic */
  var evalFn = function (x, y, z) { return kernel.evaluate(params, x, y, z); };

  /* Pass 1 — full field cache. Needed for shell+nWeights gradient stencil
     and reused below for all single-eval-per-point modes. */
  var V = new Float32Array(N3);
  for (var i = 0; i < N; i++) {
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
    for (var i2 = 0; i2 < N; i2++) {
      var x2 = -L + (i2 + 0.5) * step;
      for (var j2 = 0; j2 < N; j2++) {
        var y2 = -L + (j2 + 0.5) * step;
        for (var k2 = 0; k2 < N; k2++) {
          var vA = V[i2*N*N + j2*N + k2];
          var vB = evalFn(x2 + dx, y2 + dy, -L + (k2 + 0.5)*step + dz);
          solid[i2*N*N + j2*N + k2] = Math.max(Math.abs(vA), Math.abs(vB)) < pr ? 1 : 0;
        }
      }
    }

  /* ── Anisotropic shell — gradient from periodic central differences ── */
  } else if (mode === 'shell' && nWeights) {
    var wx = nWeights.wx, wy = nWeights.wy, wz = nWeights.wz;
    for (var i3 = 0; i3 < N; i3++) {
      var ip = (i3 + 1) % N, im = (i3 + N - 1) % N;
      for (var j3 = 0; j3 < N; j3++) {
        var jp = (j3 + 1) % N, jm = (j3 + N - 1) % N;
        for (var k3 = 0; k3 < N; k3++) {
          var kp = (k3 + 1) % N, km = (k3 + N - 1) % N;
          var gx = (V[ip*N*N + j3*N + k3] - V[im*N*N + j3*N + k3]) / (2*step);
          var gy = (V[i3*N*N + jp*N + k3] - V[i3*N*N + jm*N + k3]) / (2*step);
          var gz = (V[i3*N*N + j3*N + kp] - V[i3*N*N + j3*N + km]) / (2*step);
          var gLen = Math.sqrt(gx*gx + gy*gy + gz*gz) || 1;
          var localWt = wt * (wx*Math.abs(gx/gLen) + wy*Math.abs(gy/gLen) + wz*Math.abs(gz/gLen));
          var idx = i3*N*N + j3*N + k3;
          solid[idx] = Math.abs(V[idx] - offset) < localWt ? 1 : 0;
        }
      }
    }

  /* ── Noise modes — V is already the normalized field ──────────────── */
  } else if (mode === 'noise-sheet' || mode === 'noise-half' || mode === 'noise-solid') {
    var iso = params.isoLevel;
    var hw  = params.halfWidth;
    var inv = !!params.halfInvert;
    if (mode === 'noise-sheet') {
      for (var n1 = 0; n1 < N3; n1++) solid[n1] = Math.abs(V[n1] - iso) < hw ? 1 : 0;
    } else if (mode === 'noise-half') {
      for (var n2 = 0; n2 < N3; n2++) solid[n2] = inv ? (V[n2] < iso ? 1 : 0) : (V[n2] > iso ? 1 : 0);
    } else {
      for (var n3 = 0; n3 < N3; n3++) solid[n3] = Math.abs(V[n3] - iso) > hw ? 1 : 0;
    }

  /* ── Grain modes — V is RAW (NOT normalized to [-1,1] like noise) ─── */
  } else if (mode === 'grain-sheet' || mode === 'grain-half' || mode === 'grain-solid') {
    var giso = params.isoLevel;
    var ghw  = params.halfWidth;
    var ginv = !!params.halfInvert;
    if (mode === 'grain-sheet') {
      for (var g1 = 0; g1 < N3; g1++) solid[g1] = Math.abs(V[g1] - giso) < ghw ? 1 : 0;
    } else if (mode === 'grain-half') {
      for (var g2 = 0; g2 < N3; g2++) solid[g2] = ginv ? (V[g2] < giso ? 1 : 0) : (V[g2] > giso ? 1 : 0);
    } else {
      for (var g3 = 0; g3 < N3; g3++) solid[g3] = Math.abs(V[g3] - giso) > ghw ? 1 : 0;
    }

  /* ── Solid (TPMS, default) or isotropic shell ──────────────────────── */
  } else {
    for (var idx2 = 0; idx2 < N3; idx2++) {
      solid[idx2] = mode === 'shell'
        ? (Math.abs(V[idx2] - offset) < wt ? 1 : 0)
        : (V[idx2] - offset < 0 ? 1 : 0);
    }
  }

  return solid;
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
   buildGamma — discrete Green operator for the elastic Lippmann-
   Schwinger iteration.

   Returns Gamma[p][q] for p,q in {0=xx, 1=yy, 2=zz}, each as a
   real Float64Array(N³) indexed by (i,j,k) with i=outermost.

   The expression is the standard Mura/Suquet form for an
   isotropic reference C0:
     G_pq(ξ) = a·δ_pq + b·n_p·n_q       (compliance kernel)
     Γ_pq    = -¼·(G_pp·n_q² + G_qq·n_p² + G_pq·n_p·n_q + G_qp·n_q·n_p)
   with a = 1/μ₀, b = -(λ₀+μ₀)/(μ₀(λ₀+2μ₀)).

   At ξ=0 (DC bin) Γ is left at zero — no macroscopic strain
   correction in the constant mode.
   ============================================================ */
function buildGamma(N, mu0, lam0) {
  var N3 = N * N * N;
  var Gamma = [
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)],
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)],
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)]
  ];
  var a =  1.0 / mu0;
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
        for (var p = 0; p < 3; p++) {
          for (var q = 0; q < 3; q++) {
            var Gpq = a*(p===q?1:0) + b*nv[p]*nv[q];
            var Gpp = a + b*nv[p]*nv[p];
            var Gqq = a + b*nv[q]*nv[q];
            Gamma[p][q][idx] = -0.25*(
              Gpp*nv[q]*nv[q] + Gqq*nv[p]*nv[p] + Gpq*nv[p]*nv[q] + Gpq*nv[q]*nv[p]
            );
          }
        }
      }
    }
  }
  return Gamma;
}


/* ============================================================
   buildStokesGamma — discrete Green operator for the Stokes-
   Brinkman Lippmann-Schwinger iteration. (See full doc above.)
   ============================================================ */
function buildStokesGamma(N, mu, alpha0, L_cell_m) {
  var N3 = N * N * N;
  var Gamma = [
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)],
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)],
    [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)]
  ];
  var k_scale = 2 * Math.PI / L_cell_m;
  var k_scale_sq = k_scale * k_scale;
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
        var inv_denom = 1.0 / (mu * k_scale_sq * ksq + alpha0);
        for (var p = 0; p < 3; p++) {
          for (var q = 0; q < 3; q++) {
            var kron = (p === q) ? 1 : 0;
            Gamma[p][q][idx] = (kron - nv[p]*nv[q]) * inv_denom;
          }
        }
      }
    }
  }
  return Gamma;
}


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
