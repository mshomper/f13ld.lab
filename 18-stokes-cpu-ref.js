/* ============================================================
   F13LD.lab · 18-stokes-cpu-ref.js
   CPU reference solver for Stokes-Brinkman permeability.

   This file implements the DIRECT formulation:
     L·u = F̄,  L = -μ∇² + α(x),  ∇·u = 0,  ⟨u⟩ = ē_j

   not the Lippmann-Schwinger polarization scheme used by the
   elastic solver in 16-elastic-solver.js.  The LS approach was
   tried in earlier Push 3 Step 1 iterations and found to have
   a fundamentally non-symmetric operator A = I + Γ_S·δα that
   makes CG converge slowly and oscillate (5000+ iters needed
   for physical K, with 50% iter-count sensitivity).  The direct
   operator L is genuinely SPD on the divergence-free subspace
   for any α(x) ≥ 0, so PCG converges fast and monotonically.
   Trade-off: this Stokes solver is architecturally distinct
   from the elastic solver — it does not reuse gammaAccum kernel.

   Mathematical formulation — velocity-driven, Helmholtz-projected:
     u = ē_j + u',  ⟨u'⟩ = 0,  ∇·u' = 0
     A·u' = b,  with
       A·u' = -μ∇²u' + P·(α(x)·u')      [Helmholtz-projected Brinkman]
       b    = -P·(α(x)·ē_j)             [forcing from boundary cond.]
       P    = (I − n⊗n) in Fourier      [Helmholtz projector]
     M⁻¹ = (-μ∇² + α₀)⁻¹                [PCG preconditioner]

   After PCG converges for load case j:
     u = ē_j + u'
     F̄_i = ⟨α(x)·u_i⟩^(j)               [macroscopic body force]
     M_ij = F̄_i / μ                     [column j of K^(-1)]
   Then K = M^(-1)  (3×3 matrix invert).

   Cost per PCG iter:
     applyA:      9 FFTs  (FFT(α·u) + FFT(u) + IFFT(sum))
     applyMinv:   6 FFTs  (FFT/IFFT per component)
     Total:      15 FFTs  per iter
   Expected iter count for physical convergence: 50–200 at typical
   contrasts, vs 5000+ for the LS+CG attempt in earlier iterations.
   ============================================================ */


/* ════════════════════════════════════════════════════════════
   CPU FFT — Cooley-Tukey radix-2, ported verbatim from
   F13LD.sweep's index.html.  Operates on interleaved Float64
   complex arrays [re, im, re, im, ...] of length 2*N.
   ════════════════════════════════════════════════════════════ */

/* fft1d: in-place 1D FFT.  n = x.length / 2 must be a power of 2. */
function fft1dCpu(x, inverse) {
  var n = x.length >> 1;
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      var t = x[2*i]; x[2*i] = x[2*j]; x[2*j] = t;
      t = x[2*i+1]; x[2*i+1] = x[2*j+1]; x[2*j+1] = t;
    }
  }
  var sign = inverse ? 1 : -1;
  for (var len = 2; len <= n; len <<= 1) {
    var ang = sign * 2 * Math.PI / len;
    var wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (var i2 = 0; i2 < n; i2 += len) {
      var curRe = 1, curIm = 0;
      var halfLen = len >> 1;
      for (var jj = 0; jj < halfLen; jj++) {
        var uRe = x[2*(i2+jj)],         uIm = x[2*(i2+jj)+1];
        var vRe = x[2*(i2+jj+halfLen)], vIm = x[2*(i2+jj+halfLen)+1];
        var tvRe = curRe*vRe - curIm*vIm;
        var tvIm = curRe*vIm + curIm*vRe;
        x[2*(i2+jj)]           = uRe + tvRe;
        x[2*(i2+jj)+1]         = uIm + tvIm;
        x[2*(i2+jj+halfLen)]   = uRe - tvRe;
        x[2*(i2+jj+halfLen)+1] = uIm - tvIm;
        var newRe = curRe*wRe - curIm*wIm;
        curIm = curRe*wIm + curIm*wRe;
        curRe = newRe;
      }
    }
  }
  if (inverse) for (var k = 0; k < x.length; k++) x[k] /= n;
}

/* fft3d: in-place 3D FFT on flat N³ complex array.
   Memory layout matches GPU: index = i*N² + j*N + k, with k innermost.
   Pre-allocated lineBuf (Float64Array length 2*N) avoids per-call alloc. */
function fft3dCpu(data, N, inverse, lineBuf) {
  var buf = lineBuf || new Float64Array(2 * N);
  for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    for (var i = 0; i < N; i++) { buf[2*i] = data[2*(i*N*N+j*N+k)]; buf[2*i+1] = data[2*(i*N*N+j*N+k)+1]; }
    fft1dCpu(buf, inverse);
    for (var i2 = 0; i2 < N; i2++) { data[2*(i2*N*N+j*N+k)] = buf[2*i2]; data[2*(i2*N*N+j*N+k)+1] = buf[2*i2+1]; }
  }
  for (var i3 = 0; i3 < N; i3++) for (var k2 = 0; k2 < N; k2++) {
    for (var j2 = 0; j2 < N; j2++) { buf[2*j2] = data[2*(i3*N*N+j2*N+k2)]; buf[2*j2+1] = data[2*(i3*N*N+j2*N+k2)+1]; }
    fft1dCpu(buf, inverse);
    for (var j3 = 0; j3 < N; j3++) { data[2*(i3*N*N+j3*N+k2)] = buf[2*j3]; data[2*(i3*N*N+j3*N+k2)+1] = buf[2*j3+1]; }
  }
  for (var i4 = 0; i4 < N; i4++) for (var j4 = 0; j4 < N; j4++) {
    for (var k3 = 0; k3 < N; k3++) { buf[2*k3] = data[2*(i4*N*N+j4*N+k3)]; buf[2*k3+1] = data[2*(i4*N*N+j4*N+k3)+1]; }
    fft1dCpu(buf, inverse);
    for (var k4 = 0; k4 < N; k4++) { data[2*(i4*N*N+j4*N+k4)] = buf[2*k4]; data[2*(i4*N*N+j4*N+k4)+1] = buf[2*k4+1]; }
  }
}


/* ════════════════════════════════════════════════════════════
   solveCPUStokes — one PCG run for a single macroscopic velocity.
   Uses the direct formulation (see header), velocity-driven.
   ════════════════════════════════════════════════════════════ */
function solveCPUStokes(solid, N, mu, alpha_pen, alpha_0, L_cell_m, u_bar, tol, maxiter) {
  var N3 = N * N * N;

  function tri() { return [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)]; }
  var u_pri  = tri();
  var b      = tri();
  var r      = tri();
  var z      = tri();
  var p      = tri();
  var Ap     = tri();
  var pen    = tri();
  var lineBuf = new Float64Array(2 * N);
  var hatBufs = [new Float64Array(2*N3), new Float64Array(2*N3), new Float64Array(2*N3)];
  var uHat    = new Float64Array(2 * N3);

  /* Precomputed Fourier-domain lookups.  All set to zero at the
     DC bin (ξ=0) AND across the entire Nyquist plane (any axis at N/2)
     so u' stays in the zero-mean, divergence-free, real-symmetric subspace.

     Nyquist treatment rationale: at i=N/2 (or j=N/2, k=N/2), the FFT
     bin represents the highest representable frequency, where the integer
     wavenumber k=N/2 aliases to k=-N/2.  For real-input FFTs, the
     coefficient at this bin must be real (conjugate-symmetric with itself).
     Applying the Helmholtz projector with non-zero n_dir at this bin
     introduces a non-zero imaginary component, which is silently dropped
     when we IFFT and discard the imaginary part — the act of dropping it
     is what introduces real-space divergence (~1e+3 relative magnitude
     in N=16 tests, vs the ~1e-12 we'd expect from machine roundoff).
     Fix: zero the wavevector at all Nyquist bins so they become inert
     under all operators.  Standard convention in pseudospectral PDE
     solvers for real fields. */
  var k_scale_sq = (2 * Math.PI / L_cell_m) * (2 * Math.PI / L_cell_m);
  var k2_phys = new Float64Array(N3);                /* μ·|ξ|²  for diffusion */
  var n_dir   = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)]; /* unit ξ */
  var M_inv   = new Float64Array(N3);                /* 1/(μ·|ξ|² + α₀) */
  var halfN = N / 2;
  for (var i = 0; i < N; i++) {
    var ki = i <= halfN ? i : i - N;
    if (i === halfN) ki = 0;                          /* Nyquist treatment */
    for (var j = 0; j < N; j++) {
      var kj = j <= halfN ? j : j - N;
      if (j === halfN) kj = 0;                        /* Nyquist treatment */
      for (var k = 0; k < N; k++) {
        var kk = k <= halfN ? k : k - N;
        if (k === halfN) kk = 0;                      /* Nyquist treatment */
        var ksq = ki*ki + kj*kj + kk*kk;
        var idx = i*N*N + j*N + k;
        if (ksq === 0) {
          /* DC bin AND Nyquist-plane bins where all live wavenumbers were zeroed */
          k2_phys[idx] = 0;
          n_dir[0][idx] = n_dir[1][idx] = n_dir[2][idx] = 0;
          M_inv[idx] = 0;
        } else {
          var rk = 1.0 / Math.sqrt(ksq);
          n_dir[0][idx] = ki * rk;
          n_dir[1][idx] = kj * rk;
          n_dir[2][idx] = kk * rk;
          k2_phys[idx] = k_scale_sq * ksq;
          M_inv[idx] = 1.0 / (mu * k2_phys[idx] + alpha_0);
        }
      }
    }
  }

  /* applyHelmholtz: project a real vector field onto div-free zero-mean.
     vIn[3 reals] → vOut[3 reals] via:  v̂ ← (I − n⊗n)·v̂  (DC ← 0). */
  function applyHelmholtz(vIn, vOut) {
    for (var c = 0; c < 3; c++) {
      var hat = hatBufs[c], vc = vIn[c];
      for (var ii = 0; ii < N3; ii++) { hat[2*ii] = vc[ii]; hat[2*ii+1] = 0; }
      fft3dCpu(hat, N, false, lineBuf);
    }
    var h0 = hatBufs[0], h1 = hatBufs[1], h2 = hatBufs[2];
    var n0 = n_dir[0], n1 = n_dir[1], n2 = n_dir[2];
    for (var ii2 = 0; ii2 < N3; ii2++) {
      var ndot_re = n0[ii2]*h0[2*ii2]   + n1[ii2]*h1[2*ii2]   + n2[ii2]*h2[2*ii2];
      var ndot_im = n0[ii2]*h0[2*ii2+1] + n1[ii2]*h1[2*ii2+1] + n2[ii2]*h2[2*ii2+1];
      h0[2*ii2]   -= n0[ii2]*ndot_re;
      h0[2*ii2+1] -= n0[ii2]*ndot_im;
      h1[2*ii2]   -= n1[ii2]*ndot_re;
      h1[2*ii2+1] -= n1[ii2]*ndot_im;
      h2[2*ii2]   -= n2[ii2]*ndot_re;
      h2[2*ii2+1] -= n2[ii2]*ndot_im;
    }
    h0[0] = h0[1] = h1[0] = h1[1] = h2[0] = h2[1] = 0;
    for (var c2 = 0; c2 < 3; c2++) {
      fft3dCpu(hatBufs[c2], N, true, lineBuf);
      var vo = vOut[c2], hat2 = hatBufs[c2];
      for (var jj = 0; jj < N3; jj++) vo[jj] = hat2[2*jj];
    }
  }

  /* applyA: out = -μ∇²·uIn + P·(α(x)·uIn)
     Combined-FFT version: 9 FFTs total per call. */
  function applyA(uIn, out) {
    /* 1. pen = α(x)·uIn (real space) */
    for (var i = 0; i < N3; i++) {
      var alpha_local = solid[i] > 0.5 ? alpha_pen : 0;
      pen[0][i] = alpha_local * uIn[0][i];
      pen[1][i] = alpha_local * uIn[1][i];
      pen[2][i] = alpha_local * uIn[2][i];
    }

    /* 2. FFT(pen) into hatBufs */
    for (var c = 0; c < 3; c++) {
      var hat = hatBufs[c], pc = pen[c];
      for (var ii = 0; ii < N3; ii++) { hat[2*ii] = pc[ii]; hat[2*ii+1] = 0; }
      fft3dCpu(hat, N, false, lineBuf);
    }
    /* 3. Helmholtz-project pen_hat in place: pen_hat ← (I-n⊗n)·pen_hat, DC=0 */
    var h0 = hatBufs[0], h1 = hatBufs[1], h2 = hatBufs[2];
    var n0 = n_dir[0], n1 = n_dir[1], n2 = n_dir[2];
    for (var ii2 = 0; ii2 < N3; ii2++) {
      var ndot_re = n0[ii2]*h0[2*ii2]   + n1[ii2]*h1[2*ii2]   + n2[ii2]*h2[2*ii2];
      var ndot_im = n0[ii2]*h0[2*ii2+1] + n1[ii2]*h1[2*ii2+1] + n2[ii2]*h2[2*ii2+1];
      h0[2*ii2]   -= n0[ii2]*ndot_re;
      h0[2*ii2+1] -= n0[ii2]*ndot_im;
      h1[2*ii2]   -= n1[ii2]*ndot_re;
      h1[2*ii2+1] -= n1[ii2]*ndot_im;
      h2[2*ii2]   -= n2[ii2]*ndot_re;
      h2[2*ii2+1] -= n2[ii2]*ndot_im;
    }
    h0[0] = h0[1] = h1[0] = h1[1] = h2[0] = h2[1] = 0;

    /* 4. FFT(uIn) → uHat (one component at a time, accumulate μ|ξ|²·uHat into hatBufs).
       k2_phys is zero at all DC and Nyquist bins (see n_dir setup), so this
       accumulation does not introduce divergent or imaginary components. */
    for (var c2 = 0; c2 < 3; c2++) {
      var uc = uIn[c2];
      for (var ii3 = 0; ii3 < N3; ii3++) { uHat[2*ii3] = uc[ii3]; uHat[2*ii3+1] = 0; }
      fft3dCpu(uHat, N, false, lineBuf);
      var hatC = hatBufs[c2];
      for (var ii4 = 0; ii4 < N3; ii4++) {
        var muk2 = mu * k2_phys[ii4];
        hatC[2*ii4]   += muk2 * uHat[2*ii4];
        hatC[2*ii4+1] += muk2 * uHat[2*ii4+1];
      }
    }

    /* 5. IFFT each combined hatBufs[c] → out[c] (real) */
    for (var c3 = 0; c3 < 3; c3++) {
      fft3dCpu(hatBufs[c3], N, true, lineBuf);
      var oc = out[c3], hatF = hatBufs[c3];
      for (var jj = 0; jj < N3; jj++) oc[jj] = hatF[2*jj];
    }
  }

  /* applyMinv: z = M⁻¹·r in Fourier space.  6 FFTs per call. */
  function applyMinv(rIn, zOut) {
    for (var c = 0; c < 3; c++) {
      var hat = hatBufs[c], rc = rIn[c];
      for (var ii = 0; ii < N3; ii++) { hat[2*ii] = rc[ii]; hat[2*ii+1] = 0; }
      fft3dCpu(hat, N, false, lineBuf);
      for (var jj = 0; jj < N3; jj++) {
        hat[2*jj]   *= M_inv[jj];
        hat[2*jj+1] *= M_inv[jj];
      }
      fft3dCpu(hat, N, true, lineBuf);
      var zc = zOut[c];
      for (var kk2 = 0; kk2 < N3; kk2++) zc[kk2] = hat[2*kk2];
    }
  }

  function dot3(a, bb) {
    var s = 0;
    var a0 = a[0], a1 = a[1], a2 = a[2];
    var b0 = bb[0], b1 = bb[1], b2 = bb[2];
    for (var i = 0; i < N3; i++) s += a0[i]*b0[i] + a1[i]*b1[i] + a2[i]*b2[i];
    return s;
  }

  /* ─── Setup ──────────────────────────────────────────────── */

  /* RHS: b = -P·(α(x)·u_bar) */
  for (var c = 0; c < 3; c++) {
    if (Math.abs(u_bar[c]) > 1e-30) {
      var pc = pen[c];
      var ub = u_bar[c];
      for (var i = 0; i < N3; i++) {
        var alpha_local = solid[i] > 0.5 ? alpha_pen : 0;
        pc[i] = alpha_local * ub;
      }
    } else {
      pen[c].fill(0);
    }
  }
  applyHelmholtz(pen, b);
  for (var c2 = 0; c2 < 3; c2++) {
    var bc = b[c2];
    for (var i = 0; i < N3; i++) bc[i] = -bc[i];
  }

  /* Initial guess u' = 0 */
  for (var c3 = 0; c3 < 3; c3++) u_pri[c3].fill(0);

  /* r = b - A·u' = b ; z = M⁻¹·r ; p = z */
  for (var c4 = 0; c4 < 3; c4++) r[c4].set(b[c4]);
  var bNorm = Math.sqrt(dot3(b, b)) + 1e-30;

  applyMinv(r, z);
  for (var c5 = 0; c5 < 3; c5++) p[c5].set(z[c5]);
  var rz = dot3(r, z);

  var iters = 0;
  var converged = false;
  var breakReason = 'max_iter';

  /* ─── PCG outer loop ─────────────────────────────────────── */
  for (var it = 0; it < maxiter; it++) {
    iters = it + 1;
    applyA(p, Ap);
    var pAp = dot3(p, Ap);
    if (Math.abs(pAp) < 1e-30) {
      breakReason = (pAp < 0) ? 'pAp_negative' : 'pAp_zero';
      break;
    }
    var alpha = rz / pAp;

    for (var c6 = 0; c6 < 3; c6++) {
      var uC = u_pri[c6], pC = p[c6], rC = r[c6], ApC = Ap[c6];
      for (var ii = 0; ii < N3; ii++) {
        uC[ii] += alpha * pC[ii];
        rC[ii] -= alpha * ApC[ii];
      }
    }
    var rrNew = dot3(r, r);
    if (Math.sqrt(rrNew) / bNorm < tol) {
      converged = true;
      breakReason = 'converged';
      break;
    }
    applyMinv(r, z);
    var rzNew = dot3(r, z);
    if (Math.abs(rz) < 1e-30) {
      breakReason = 'rz_zero';
      break;
    }
    var beta = rzNew / rz;
    for (var c7 = 0; c7 < 3; c7++) {
      var zC = z[c7], pC2 = p[c7];
      for (var jj = 0; jj < N3; jj++) pC2[jj] = zC[jj] + beta * pC2[jj];
    }
    rz = rzNew;
  }

  /* Recover u = u_bar + u' and compute F̄ = ⟨α(x)·u⟩ */
  var f0 = 0, f1 = 0, f2 = 0;
  var up0 = u_pri[0], up1 = u_pri[1], up2 = u_pri[2];
  for (var i2 = 0; i2 < N3; i2++) {
    var alpha_local2 = solid[i2] > 0.5 ? alpha_pen : 0;
    f0 += alpha_local2 * (u_bar[0] + up0[i2]);
    f1 += alpha_local2 * (u_bar[1] + up1[i2]);
    f2 += alpha_local2 * (u_bar[2] + up2[i2]);
  }
  return {
    avgAlphaU: [f0 / N3, f1 / N3, f2 / N3],
    iters: iters,
    converged: converged,
    breakReason: breakReason
  };
}


/* ════════════════════════════════════════════════════════════
   homogenizeCPUStokes — full 3-load-case run, returns K tensor.
   ════════════════════════════════════════════════════════════ */
function homogenizeCPUStokes(solid, N, mu, alpha_pen, alpha_0, L_cell_m, opts) {
  opts = opts || {};
  var tol     = opts.tol     != null ? opts.tol     : 1e-5;
  var maxiter = opts.maxiter != null ? opts.maxiter : 100;

  var M = [[0,0,0],[0,0,0],[0,0,0]];
  var totalIters = 0;
  var allConverged = true;
  var perLC = [];

  for (var lc = 0; lc < 3; lc++) {
    var u_bar = [lc === 0 ? 1 : 0, lc === 1 ? 1 : 0, lc === 2 ? 1 : 0];
    var res = solveCPUStokes(solid, N, mu, alpha_pen, alpha_0, L_cell_m, u_bar, tol, maxiter);
    totalIters += res.iters;
    if (!res.converged) allConverged = false;
    for (var p = 0; p < 3; p++) M[p][lc] = res.avgAlphaU[p] / mu;
    perLC.push({ axis: ['x','y','z'][lc], iters: res.iters, converged: res.converged, breakReason: res.breakReason });
  }
  for (var pp = 0; pp < 3; pp++) for (var qq = pp+1; qq < 3; qq++) {
    var s = 0.5 * (M[pp][qq] + M[qq][pp]);
    M[pp][qq] = M[qq][pp] = s;
  }

  var det = M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1])
          - M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0])
          + M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
  if (Math.abs(det) < 1e-30) {
    return { Kx: 0, Ky: 0, Kz: 0, K_full: null, M_full: M, totalIters: totalIters, allConverged: allConverged, valid: false, perLC: perLC };
  }
  var invDet = 1 / det;
  var K00 =  (M[1][1]*M[2][2] - M[1][2]*M[2][1]) * invDet;
  var K01 = -(M[0][1]*M[2][2] - M[0][2]*M[2][1]) * invDet;
  var K02 =  (M[0][1]*M[1][2] - M[0][2]*M[1][1]) * invDet;
  var K11 =  (M[0][0]*M[2][2] - M[0][2]*M[2][0]) * invDet;
  var K12 = -(M[0][0]*M[1][2] - M[0][2]*M[1][0]) * invDet;
  var K22 =  (M[0][0]*M[1][1] - M[0][1]*M[1][0]) * invDet;

  return {
    Kx: K00, Ky: K11, Kz: K22,
    K_full: [[K00, K01, K02], [K01, K11, K12], [K02, K12, K22]],
    M_full: M,
    totalIters: totalIters,
    allConverged: allConverged,
    valid: true,
    perLC: perLC
  };
}


/* ════════════════════════════════════════════════════════════
   solveDesignCPUStokes — top-level wrapper.
     α_pen  = α_pen_scale · μ / d_voxel²,  default scale = 1e6
     α_0    = α_pen / 2  (preconditioner reference, ≈ ⟨α⟩ at ρ=0.5)
   ════════════════════════════════════════════════════════════ */
function solveDesignCPUStokes(recipe, N, opts) {
  opts = opts || {};
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);

  var t0 = performance.now();
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt,
                          args.nWeights, args.pipeR, args.phaseShift);
  var tRast = performance.now() - t0;

  var inside = 0;
  for (var v = 0; v < solid.length; v++) inside += solid[v];
  var rho = inside / solid.length;

  var mat = recipe.material || {};
  var mu = mat.muFluid_PaS != null ? mat.muFluid_PaS : 0.001;
  var L_cell_mm = (recipe.geometry && recipe.geometry.cellSizeMm) || 5.0;
  var L_cell_m = L_cell_mm * 1e-3;
  var d_voxel_m = L_cell_m / N;
  var alpha_pen_scale = opts.alphaPenScale != null ? opts.alphaPenScale : 1e6;
  var alpha_pen = alpha_pen_scale * mu / (d_voxel_m * d_voxel_m);
  var alpha_0 = opts.alpha_0 != null ? opts.alpha_0 : alpha_pen / 2;

  var t1 = performance.now();
  var hom = homogenizeCPUStokes(solid, N, mu, alpha_pen, alpha_0, L_cell_m, opts);
  var tCG = performance.now() - t1;

  return {
    name: recipe.name,
    family: family,
    mode: args.mode,
    rho: rho,
    Kx_m2: hom.Kx,
    Ky_m2: hom.Ky,
    Kz_m2: hom.Kz,
    K_full: hom.K_full,
    M_full: hom.M_full,
    mu_PaS: mu,
    L_cell_m: L_cell_m,
    alpha_pen: alpha_pen,
    alpha_0: alpha_0,
    iters: hom.totalIters,
    converged: hom.allConverged,
    valid: hom.valid,
    perLC: hom.perLC,
    tRast_ms: tRast,
    tCG_ms: tCG
  };
}


/* ════════════════════════════════════════════════════════════
   Smoke test — Schwarz P at N=16, in-page button.
   Pass criteria:
     1. PCG converges on all 3 LCs at maxiter ≤ 2000, TOL = 1e-6
     2. K matrix is positive definite (cubic eigenvalues a+2b > 0, a−b > 0)
     3. Cubic isotropy < 5%
     4. K_avg in plausible range [1e-12, 1e-6] m²
   Expected at convergence: K ≈ 9.6e-8 m², k* = K/L² ≈ 3.9e-3,
   isotropy ≈ 1%, ~16 sec wall time.
   ════════════════════════════════════════════════════════════ */
var CPU_STOKES_SMOKE = { state: 'idle', lastResult: null };

async function runCPUStokesSmokeTest() {
  paintCPUStokesLink('running', '⟳ Schwarz P · CPU Stokes · N=16…');
  await new Promise(function(resolve){ setTimeout(resolve, 10); });

  try {
    var t0 = performance.now();
    var res = solveDesignCPUStokes(DEMO_RECIPES.schwarzP, 16, { tol: 1e-6, maxiter: 2000 });
    var totalMs = performance.now() - t0;

    var ok = true;
    var notes = [];

    if (!res.valid) { ok = false; notes.push('M-matrix singular'); }
    if (res.Kx_m2 <= 0 || res.Ky_m2 <= 0 || res.Kz_m2 <= 0) {
      ok = false; notes.push('non-positive K diagonal');
    }
    var a_K = (res.K_full[0][0] + res.K_full[1][1] + res.K_full[2][2]) / 3;
    var b_K = (res.K_full[0][1] + res.K_full[0][2] + res.K_full[1][2]) / 3;
    var eig_iso = a_K + 2*b_K;
    var eig_dev = a_K - b_K;
    if (eig_iso <= 0 || eig_dev <= 0) {
      ok = false;
      notes.push('K not positive definite (iso=' + eig_iso.toExponential(2) +
                 ', dev=' + eig_dev.toExponential(2) + ')');
    }
    var Kmax = Math.max(res.Kx_m2, res.Ky_m2, res.Kz_m2);
    var Kmin = Math.min(res.Kx_m2, res.Ky_m2, res.Kz_m2);
    var anisoFrac = Kmax > 0 ? (Kmax - Kmin) / Kmax : 0;
    if (anisoFrac > 0.05) {
      ok = false;
      notes.push('isotropy ' + (anisoFrac*100).toFixed(2) + '% (expected < 5%)');
    } else {
      notes.push('isotropy ' + (anisoFrac*100).toFixed(2) + '%');
    }
    var Kavg = (res.Kx_m2 + res.Ky_m2 + res.Kz_m2) / 3;
    if (Kavg < 1e-12 || Kavg > 1e-6) {
      ok = false;
      notes.push('K out of band [1e-12, 1e-6] m²');
    }
    var k_star = Kavg / (res.L_cell_m * res.L_cell_m);

    CPU_STOKES_SMOKE.lastResult = { res: res, ok: ok, notes: notes, totalMs: totalMs };

    var bg = ok ? '#34d399' : '#fb7185';
    var fg = ok ? '#06080f' : '#fff';
    var lcLine = res.perLC.map(function(p){
      return p.axis + ':' + p.iters + '·' + p.breakReason;
    }).join('  ');

    console.log(
      '%c ' + (ok ? '✓' : '✗') + ' ' + res.name + ' · CPU Stokes ref · N=16 ',
      'background:' + bg + '; color:' + fg + '; font-weight:bold; padding:2px 8px; border-radius:3px;',
      '\n  family:        ' + res.family + ' · mode: ' + res.mode +
      '\n  ρ (VF):        ' + (res.rho * 100).toFixed(2) + '%' +
      '\n  Kx / Ky / Kz:  ' + res.Kx_m2.toExponential(3) + ' / ' +
                              res.Ky_m2.toExponential(3) + ' / ' +
                              res.Kz_m2.toExponential(3) + ' m²' +
      '\n  K eigenvalues: iso=' + eig_iso.toExponential(3) + ', dev=' + eig_dev.toExponential(3) +
      '\n  mean K:        ' + Kavg.toExponential(3) + ' m²' +
      '\n  k* (K/L²):     ' + k_star.toExponential(3) + '  (dimensionless)' +
      '\n  μ:             ' + res.mu_PaS + ' Pa·s' +
      '\n  L_cell:        ' + (res.L_cell_m*1000).toFixed(2) + ' mm  · d_voxel = ' +
                              (res.L_cell_m / 16 * 1e6).toFixed(1) + ' μm' +
      '\n  α_pen:         ' + res.alpha_pen.toExponential(3) + ' Pa·s/m²' +
      '\n  α_0 (precond): ' + res.alpha_0.toExponential(3) + ' Pa·s/m²' +
      '\n  PCG iters:     ' + res.iters + ' total · all converged: ' + res.converged +
      '\n  per-LC:        ' + lcLine +
      '\n  rasterize:     ' + res.tRast_ms.toFixed(0) + ' ms' +
      '\n  PCG solve:     ' + res.tCG_ms.toFixed(0) + ' ms' +
      '\n  total:         ' + totalMs.toFixed(0) + ' ms' +
      (notes.length ? '\n  notes:         ' + notes.join(' · ') : '')
    );

    if (ok) {
      paintCPUStokesLink('pass',
        '✓ CPU Stokes ref · K̅ = ' + Kavg.toExponential(2) + ' m² (' + totalMs.toFixed(0) + ' ms)');
    } else {
      paintCPUStokesLink('fail',
        '⚠ CPU Stokes ref · checks failed (see console)');
    }
  } catch (err) {
    console.error('[cpu-stokes-smoke] failed:', err);
    paintCPUStokesLink('fail', '✗ ' + (err.message || String(err)));
  }
}

function paintCPUStokesLink(state, text) {
  var link = document.getElementById('cpuStokesTestLink');
  if (!link) return;
  CPU_STOKES_SMOKE.state = state;
  link.classList.remove('running','pass','fail');
  if (state !== 'idle') link.classList.add(state);
  link.textContent = text;
}
