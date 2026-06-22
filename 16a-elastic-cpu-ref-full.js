/* ============================================================
   F13LD.lab · 16a-elastic-cpu-ref-full.js

   CPU reference for full Voigt 6×6 elastic homogenization.
   This is the qualification-stage tensor math: full 6-LC FFT-CG
   homogenization returning Ex / Ey / Ez / Gxy / Gxz / Gyz.

   F13LD.sweep stays normal-only (fast vault feed cadence).
   F13LD.lab is the home for full tensor math (deep compute on
   3 short-listed designs, not throughput across thousands).

   Mirrors the 18-stokes-cpu-ref.js → 19-stokes-solver.js pattern:
   math validated on CPU first, ported verbatim to GPU after.

   ── Push 1 (math) ───────────────────────────────────────
   - VOIGT_IJ, VOIGT_F           (index + engineering-shear tables)
   - buildGammaFull              (full 6×6 Γ̃ tensor)
   - runBuildGammaFullSelfTest   (algebraic regression vs the
                                  existing normal-only buildGamma
                                  in 14-rasterizer.js — agrees
                                  to float64 epsilon at every mode)

   ── Push 2 (solver + validation) ────────────────────────
   - getSolverWorkspaceFullCPU   (cached 6-component CG buffers)
   - applyGammaRowFull           (6-q-component spectral op)
   - cgSolveFullCPU              (one CG LC with full Voigt strain)
   - invert6x6                   (partial-pivoting Gauss-Jordan)
   - homogenizeFullCPU           (top-level driver: recipe → moduli)
   - runFullVoigtCPUTest         (Schwarz P at N=16 · 6 gates + Zener diagnostic)

   ── Deferred to a separate session ──────────────────────
   - GPU port to vec4-packed WGSL kernels in 16-elastic-solver.js
   - "Stiffness ⊕" tab with directional E(n̂) surface viz
   - 6-position axis toggle in 40-design-grid.js
   - localStorage piggyback for imported designs

   ── Voigt convention used throughout ────────────────────
   - Voigt index P ∈ {0=xx, 1=yy, 2=zz, 3=yz, 4=xz, 5=xy}
   - Engineering shear strain (ε_V[3] = 2·ε_23, etc.)
   - Natural shear stress      (σ_V[3] = σ_23, no factor of 2)
   - Voigt index → tensor      P=0:(0,0), 1:(1,1), 2:(2,2),
                                3:(1,2), 4:(0,2), 5:(0,1)
   - Matches isoC()'s existing 6×6 storage in 14-rasterizer.js
     and the sweep production code.

   ── External dependencies (resolved at call time) ──────
   - buildGamma           (14-rasterizer.js, regression test)
   - isoC, buildVoxels,
     resolveBuildArgs     (14-rasterizer.js)
   - KERNELS              (13-kernels.js)
   - DEMO_RECIPES         (15-demo-recipes.js)
   - fft3dCpu             (18-stokes-cpu-ref.js — Cooley-Tukey
                           radix-2 ported from sweep)
   ============================================================ */


/* Voigt index → underlying tensor (i,j) mapping, 0-indexed.
   For symmetric tensors only the i ≤ j entries are stored. */
var VOIGT_IJ = [
  [0, 0], [1, 1], [2, 2],   /* normal: xx, yy, zz */
  [1, 2], [0, 2], [0, 1]    /* shear:  yz, xz, xy */
];

/* Engineering-shear factor pattern for Voigt collapse:
   f = 1 for normal Voigt indices, 2 for shear.
   Γ̃_PQ(n) = f[P] · f[Q] · Γ_ij(P)kl(Q)(n)
   accounts for ε_V[3] = 2·ε_23 etc. on the strain side. */
var VOIGT_F = [1, 1, 1, 2, 2, 2];


/* ════════════════════════════════════════════════════════════
   PUSH 1 — Γ tensor + regression test
   ════════════════════════════════════════════════════════════ */


/* ============================================================
   buildGammaFull — full Voigt 6×6 Moulinec-Suquet Green operator.

   Returns Gamma[P][Q] for P,Q ∈ {0..5}, each a real Float64Array
   of N³ values indexed by (i,j,k) with i outermost.

   ── Underlying rank-4 tensor (textbook MS 1998) ─────────
   For an isotropic reference (μ₀, λ₀), at Fourier mode
   n = ξ/|ξ| (with ξ = 0 → all zero):

     Γ_ijkl(n) = (1/(4μ₀)) · [δ_ik·n_l·n_j + δ_il·n_k·n_j
                              + δ_jk·n_l·n_i + δ_jl·n_k·n_i]
              + b · n_i · n_j · n_k · n_l

   where b = −(λ₀+μ₀) / (μ₀·(λ₀+2μ₀)).  M₀ = λ₀+2μ₀ is the
   P-wave / constrained modulus of the reference material.

   ── Voigt collapse ──────────────────────────────────────
     Γ̃_PQ(n) = f[P] · f[Q] · Γ_ij(P)kl(Q)(n)

   ── Self-consistency property ───────────────────────────
   For P,Q ∈ {0,1,2} (normal sub-block, f = 1 on both sides):
     Γ̃_PQ = (a·δ_PQ + b·n_P·n_Q) · n_P · n_Q

   which is the existing buildGamma formula in 14-rasterizer.js.
   runBuildGammaFullSelfTest() asserts numerical agreement to
   1e-10 relative at every Fourier mode, well under CG_TOL=1e-4.

   ── Storage and memory ──────────────────────────────────
   Allocates the full 6×6 = 36 spatial arrays of Float64.
   Γ̃ is symmetric (Γ̃_PQ = Γ̃_QP) so only 21 are unique, but
   storing 36 simplifies the inner loops in cgSolveFullCPU
   — no per-row symmetry-aware unpacking needed.
   At N=16: 36 · 16³ · 8 bytes = ~1.2 MB.  Trivial.
   At N=64: 36 · 64³ · 8 bytes = ~75 MB.   Acceptable on CPU.

   At ξ = 0 (DC bin) Γ̃ is left at zero — no macroscopic
   strain correction to the constant mode.
   ============================================================ */
function buildGammaFull(N, mu0, lam0, scheme) {
  var N3 = N * N * N;

  /* Allocate 6×6 of N³ Float64 spatial arrays */
  var Gamma = new Array(6);
  for (var P0 = 0; P0 < 6; P0++) {
    Gamma[P0] = new Array(6);
    for (var Q0 = 0; Q0 < 6; Q0++) {
      Gamma[P0][Q0] = new Float64Array(N3);
    }
  }

  var a = 1.0 / mu0;
  var b = -(lam0 + mu0) / (mu0 * (lam0 + 2 * mu0));
  var WILLOT = (scheme !== 'continuous');   /* default operator is Willot's rotated scheme */
  var PI_N = Math.PI / N;

  /* Walk Fourier modes via signed-wraparound (standard DFT) */
  for (var i = 0; i < N; i++) {
    var ki = i <= N / 2 ? i : i - N;
    for (var j = 0; j < N; j++) {
      var kj = j <= N / 2 ? j : j - N;
      for (var k = 0; k < N; k++) {
        var kk = k <= N / 2 ? k : k - N;
        var ksq = ki * ki + kj * kj + kk * kk;
        var idx = i * N * N + j * N + k;
        if (ksq === 0) continue;   /* DC bin: leave zero */

        var rk = 1.0 / Math.sqrt(ksq);
        var n0 = ki * rk;
        var n1 = kj * rk;
        var n2 = kk * rk;
        var n = [n0, n1, n2];
        if (WILLOT) {
          /* Willot (2015) rotated finite-difference frequency:
             ξ̃_α = sin(πk_α/N)·∏_{β≠α}cos(πk_β/N) (a common 1/h phase cancels
             in the unit direction).  Annihilates the Nyquist/checkerboard
             modes that make the continuous operator ring at high phase
             contrast → far more accurate fields & moduli at the same grid. */
          var sx = Math.sin(PI_N * ki), cx = Math.cos(PI_N * ki);
          var sy = Math.sin(PI_N * kj), cy = Math.cos(PI_N * kj);
          var sz = Math.sin(PI_N * kk), cz = Math.cos(PI_N * kk);
          var wx = sx * cy * cz, wy = cx * sy * cz, wz = cx * cy * sz;
          var wsq = wx * wx + wy * wy + wz * wz;
          if (wsq < 1e-30) continue;   /* Willot-annihilated mode → leave Γ̃ zero */
          var rw = 1.0 / Math.sqrt(wsq);
          n[0] = wx * rw; n[1] = wy * rw; n[2] = wz * rw;
        }

        /* Build the 6×6 Γ̃ at this Fourier mode */
        for (var P = 0; P < 6; P++) {
          var iP = VOIGT_IJ[P][0];
          var jP = VOIGT_IJ[P][1];
          var fP = VOIGT_F[P];

          for (var Q = 0; Q < 6; Q++) {
            var kQ = VOIGT_IJ[Q][0];
            var lQ = VOIGT_IJ[Q][1];
            var fQ = VOIGT_F[Q];

            /* part1 — Kronecker-delta term, prefactor 1/(4μ₀) */
            var part1 = (a * 0.25) * (
              (iP === kQ ? n[lQ] * n[jP] : 0) +
              (iP === lQ ? n[kQ] * n[jP] : 0) +
              (jP === kQ ? n[lQ] * n[iP] : 0) +
              (jP === lQ ? n[kQ] * n[iP] : 0)
            );

            /* part2 — quartic-n rank-1 projector outer product */
            var part2 = b * n[iP] * n[jP] * n[kQ] * n[lQ];

            Gamma[P][Q][idx] = fP * fQ * (part1 + part2);
          }
        }
      }
    }
  }

  return Gamma;
}


/* ============================================================
   runBuildGammaFullSelfTest — regression test against the
   existing normal-only buildGamma in 14-rasterizer.js.

   For P,Q ∈ {0,1,2} (the normal-normal sub-block), the new
   full-tensor formula reduces algebraically to the existing
   formula:

     (a·δ_PQ + b·n_P·n_Q) · n_P · n_Q

   Floating-point operation order differs between the two
   implementations (the new code sums 4 partial terms then
   applies a 0.25 factor; the existing code never does a /4
   step), so we tolerate ULPs rather than asserting bit-identity.

   Tolerance: 1e-10 relative.  CG_TOL is 1e-4, so anything well
   below that means the algebra is correct.

   ── Usage from devtools console ─────────────────────────
     runBuildGammaFullSelfTest()              // defaults: N=16, Ti-6Al-4V
     runBuildGammaFullSelfTest(8)             // smaller N for speed
     runBuildGammaFullSelfTest(16, 1.0, 1.0)  // clean unit params

   Returns: { passed, N, mu0, lam0, maxAbsDiff, maxRelDiff,
              worstP, worstQ, worstIdx, worstIJK,
              normalA, normalB, tFullMs, tNormMs }
   ============================================================ */
function runBuildGammaFullSelfTest(N, mu0, lam0) {
  N = N || 16;

  /* Default to Ti-6Al-4V realistic values (Es = 110 GPa, ν = 0.30) */
  if (mu0 == null) {
    var Es = 110000;          /* MPa */
    var nu = 0.30;
    mu0 = Es / (2 * (1 + nu));                       /* ≈ 42307.6923 */
    lam0 = Es * nu / ((1 + nu) * (1 - 2 * nu));      /* ≈ 63461.5385 */
  }

  console.log('[buildGammaFull self-test] N=' + N
              + ', μ₀=' + mu0.toFixed(4)
              + ', λ₀=' + lam0.toFixed(4));

  var t0 = performance.now();
  var Gfull = buildGammaFull(N, mu0, lam0);
  var tFull = performance.now() - t0;

  var t1 = performance.now();
  var Gnorm = buildGamma(N, mu0, lam0);
  var tNorm = performance.now() - t1;

  console.log('  buildGammaFull built in ' + tFull.toFixed(1) + ' ms');
  console.log('  buildGamma     built in ' + tNorm.toFixed(1) + ' ms');

  /* Compare the 3×3 normal sub-block of the full Γ̃ to the
     existing buildGamma at every voxel of every entry. */
  var N3 = N * N * N;
  var maxAbsDiff = 0;
  var maxRelDiff = 0;
  var worstP = -1, worstQ = -1, worstIdx = -1;
  var worstA = 0, worstB = 0;

  for (var P = 0; P < 3; P++) {
    for (var Q = 0; Q < 3; Q++) {
      var Afull = Gfull[P][Q];
      var Anorm = Gnorm[P][Q];
      for (var ii = 0; ii < N3; ii++) {
        var av = Afull[ii];
        var bv = Anorm[ii];
        var d = Math.abs(av - bv);
        if (d > maxAbsDiff) {
          maxAbsDiff = d;
          worstP = P; worstQ = Q; worstIdx = ii;
          worstA = av; worstB = bv;
        }
        var scale = Math.max(Math.abs(av), Math.abs(bv), 1e-30);
        var rd = d / scale;
        if (rd > maxRelDiff) maxRelDiff = rd;
      }
    }
  }

  var tol = 1e-10;
  var passed = maxRelDiff < tol;

  console.log('  max |Γ̃_full[P][Q] − Γ̃_norm[P][Q]| over normal sub-block:');
  console.log('    absolute: ' + maxAbsDiff.toExponential(3));
  console.log('    relative: ' + maxRelDiff.toExponential(3));

  /* Pretty-print the worst-case voxel coordinates */
  var worstIJK = null;
  if (worstIdx >= 0) {
    var iw = Math.floor(worstIdx / (N * N));
    var jw = Math.floor((worstIdx - iw * N * N) / N);
    var kw = worstIdx - iw * N * N - jw * N;
    worstIJK = [iw, jw, kw];
    console.log('    worst entry: P=' + worstP + ' Q=' + worstQ
                + ' at (i,j,k) = (' + iw + ',' + jw + ',' + kw + ')');
    console.log('      full: ' + worstA);
    console.log('      norm: ' + worstB);
  }

  console.log('  verdict: ' + (passed ? '✓ PASS' : '✗ FAIL')
              + ' (tolerance ' + tol.toExponential(0) + ')');

  return {
    passed: passed,
    N: N, mu0: mu0, lam0: lam0,
    maxAbsDiff: maxAbsDiff, maxRelDiff: maxRelDiff,
    worstP: worstP, worstQ: worstQ, worstIdx: worstIdx,
    worstIJK: worstIJK,
    normalA: worstA, normalB: worstB,
    tFullMs: tFull, tNormMs: tNorm
  };
}


/* ════════════════════════════════════════════════════════════
   PUSH 2 — solver, homogenizer, validation harness
   ════════════════════════════════════════════════════════════ */


/* CPU full-Voigt solver workspace (singleton, cached by N).
   Killing per-LC allocation churn is meaningful at N=32+. */
var _solverWorkspaceFullCpu = null;
var _solverWorkspaceFullCpuN = 0;

function getSolverWorkspaceFullCPU(N) {
  if (_solverWorkspaceFullCpuN === N && _solverWorkspaceFullCpu) return _solverWorkspaceFullCpu;
  var N3 = N * N * N;
  var make6 = function() {
    return [
      new Float64Array(N3), new Float64Array(N3), new Float64Array(N3),
      new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)
    ];
  };
  _solverWorkspaceFullCpu = {
    N: N, N3: N3,
    /* CG state — 6 components (xx, yy, zz, yz, xz, xy) */
    eps:    make6(),
    b:      make6(),
    r:      make6(),
    p:      make6(),
    Ap:     make6(),
    epsNew: make6(),
    rNew:   make6(),
    /* applyA scratch */
    sig:    make6(),
    tau:    make6(),
    deps:   make6(),
    /* applyGammaRowFull scratch — complex spectra */
    fftOut:     new Float64Array(2 * N3),
    tauHat:     new Float64Array(2 * N3),
    fftLineBuf: new Float64Array(2 * N)
  };
  _solverWorkspaceFullCpuN = N;
  return _solverWorkspaceFullCpu;
}


/* ============================================================
   applyGammaRowFull — apply one row of the full Γ̃ to a 6-comp τ.

   For Voigt output row P (0..5):
     out[P](x) = IFFT( Σ_Q Γ̃_PQ(ξ) · τ̂_Q(ξ) )

   Same FFT pattern as sweep's applyGammaRow but loops q=0..5
   instead of 0..2.  Uses fft3dCpu from 18-stokes-cpu-ref.js
   (Cooley-Tukey radix-2, in-place on interleaved [re,im] arrays).

   tauFields: array of 6 Float64Array(N³) — input τ in real space
   GammaRow:  array of 6 Float64Array(N³) — Γ̃[P][0..5] real-valued
   N:         grid resolution (must be power of 2 for radix-2 FFT)
   out:       Float64Array(N³) — destination for δε[P] real space
   ws:        workspace from getSolverWorkspaceFullCPU
   ============================================================ */
function applyGammaRowFull(tauFields, GammaRow, N, out, ws) {
  var N3 = N * N * N;
  var fftOut  = ws.fftOut;
  var tauHat  = ws.tauHat;
  var lineBuf = ws.fftLineBuf;

  /* Zero the spectral accumulator */
  fftOut.fill(0);

  for (var q = 0; q < 6; q++) {
    /* Pack real tau[q] → complex tauHat (imag = 0) */
    tauHat.fill(0);
    var tq = tauFields[q];
    for (var i = 0; i < N3; i++) tauHat[2 * i] = tq[i];

    /* Forward FFT in place */
    fft3dCpu(tauHat, N, false, lineBuf);

    /* Multiply by Γ̃[P][q] (real-valued; broadcast to re + im) and accumulate */
    var G = GammaRow[q];
    for (var i2 = 0; i2 < N3; i2++) {
      fftOut[2 * i2]     += G[i2] * tauHat[2 * i2];
      fftOut[2 * i2 + 1] += G[i2] * tauHat[2 * i2 + 1];
    }
  }

  /* IFFT in place; extract real part to out */
  fft3dCpu(fftOut, N, true, lineBuf);
  for (var i3 = 0; i3 < N3; i3++) out[i3] = fftOut[2 * i3];
}


/* ============================================================
   cgSolveFullCPU — one CG load case with full Voigt 6-comp strain.

   Solves the Lippmann-Schwinger fixed point
     ε(x) = ε̄ − Γ · (C(x) − C₀) : ε(x)
   via CG on the symmetric operator
     A·ε ≡ ε + Γ·(C(x) − C₀)·ε
   with right-hand side b = ε̄ (uniform).

   eps_bar: 6-vector uniform macroscopic strain (xx,yy,zz,yz,xz,xy)
   Returns: { sigma:    6-vector volume-averaged stress,
              iters:    CG iteration count,
              converged: bool,
              breakReason: 'tol_reached' | 'maxiter' | 'pAp_underflow' }
   ============================================================ */
function cgSolveFullCPU(solid, C_s, C_v, C0, Gamma, N, eps_bar, tol, maxiter) {
  var ws = getSolverWorkspaceFullCPU(N);
  var N3 = ws.N3;
  var eps = ws.eps, b = ws.b, r = ws.r, p = ws.p, Ap = ws.Ap;
  var epsNew = ws.epsNew, rNew = ws.rNew;
  var sig = ws.sig, tau = ws.tau, deps = ws.deps;

  /* localStress: per-voxel σ = C(x):ε with the full 6×6 multiply.
     For isotropic per-voxel C this is over-general (off-diagonal
     normal-shear entries are 0), but keeping the generic form
     means this same kernel works if we later allow anisotropic
     per-voxel materials. */
  function localStress(epsIn, sigOut) {
    var s = solid;
    for (var idx = 0; idx < N3; idx++) {
      var C = s[idx] ? C_s : C_v;
      var e0 = epsIn[0][idx], e1 = epsIn[1][idx], e2 = epsIn[2][idx];
      var e3 = epsIn[3][idx], e4 = epsIn[4][idx], e5 = epsIn[5][idx];
      sigOut[0][idx] = C[0]*e0  + C[1]*e1  + C[2]*e2  + C[3]*e3  + C[4]*e4  + C[5]*e5;
      sigOut[1][idx] = C[6]*e0  + C[7]*e1  + C[8]*e2  + C[9]*e3  + C[10]*e4 + C[11]*e5;
      sigOut[2][idx] = C[12]*e0 + C[13]*e1 + C[14]*e2 + C[15]*e3 + C[16]*e4 + C[17]*e5;
      sigOut[3][idx] = C[18]*e0 + C[19]*e1 + C[20]*e2 + C[21]*e3 + C[22]*e4 + C[23]*e5;
      sigOut[4][idx] = C[24]*e0 + C[25]*e1 + C[26]*e2 + C[27]*e3 + C[28]*e4 + C[29]*e5;
      sigOut[5][idx] = C[30]*e0 + C[31]*e1 + C[32]*e2 + C[33]*e3 + C[34]*e4 + C[35]*e5;
    }
  }

  /* applyA: out = ε + Γ·(σ(ε) − C₀·ε) */
  function applyA(epsIn, out) {
    localStress(epsIn, sig);
    /* tau = sig − C₀·eps (C₀ is uniform; full 6×6 multiply) */
    for (var idx = 0; idx < N3; idx++) {
      var e0 = epsIn[0][idx], e1 = epsIn[1][idx], e2 = epsIn[2][idx];
      var e3 = epsIn[3][idx], e4 = epsIn[4][idx], e5 = epsIn[5][idx];
      tau[0][idx] = sig[0][idx] - (C0[0]*e0  + C0[1]*e1  + C0[2]*e2  + C0[3]*e3  + C0[4]*e4  + C0[5]*e5);
      tau[1][idx] = sig[1][idx] - (C0[6]*e0  + C0[7]*e1  + C0[8]*e2  + C0[9]*e3  + C0[10]*e4 + C0[11]*e5);
      tau[2][idx] = sig[2][idx] - (C0[12]*e0 + C0[13]*e1 + C0[14]*e2 + C0[15]*e3 + C0[16]*e4 + C0[17]*e5);
      tau[3][idx] = sig[3][idx] - (C0[18]*e0 + C0[19]*e1 + C0[20]*e2 + C0[21]*e3 + C0[22]*e4 + C0[23]*e5);
      tau[4][idx] = sig[4][idx] - (C0[24]*e0 + C0[25]*e1 + C0[26]*e2 + C0[27]*e3 + C0[28]*e4 + C0[29]*e5);
      tau[5][idx] = sig[5][idx] - (C0[30]*e0 + C0[31]*e1 + C0[32]*e2 + C0[33]*e3 + C0[34]*e4 + C0[35]*e5);
    }
    /* deps[P] = Σ_Q Γ̃[P][Q] · τ[Q] via spectral op */
    for (var P = 0; P < 6; P++) applyGammaRowFull(tau, Gamma[P], N, deps[P], ws);
    /* out = eps + deps */
    for (var P2 = 0; P2 < 6; P2++) {
      var outP = out[P2], einP = epsIn[P2], dpP = deps[P2];
      for (var i = 0; i < N3; i++) outP[i] = einP[i] + dpP[i];
    }
  }

  /* 6-component inner product over the full N³ grid */
  function dot(a, b_) {
    var sAcc = 0;
    for (var P = 0; P < 6; P++) {
      var aP = a[P], bP = b_[P];
      for (var i = 0; i < N3; i++) sAcc += aP[i] * bP[i];
    }
    return sAcc;
  }

  /* Initialise: eps = b = uniform macroscopic strain */
  for (var P = 0; P < 6; P++) {
    eps[P].fill(eps_bar[P]);
    b[P].fill(eps_bar[P]);
  }
  var bNorm = Math.sqrt(dot(b, b)) + 1e-30;

  /* r = b − A·eps   (Ap reused as scratch since not yet needed) */
  applyA(eps, Ap);
  for (var P3 = 0; P3 < 6; P3++) {
    var rP = r[P3], bP = b[P3], ApP = Ap[P3];
    for (var i = 0; i < N3; i++) rP[i] = bP[i] - ApP[i];
  }

  /* p = r  (initial search direction) */
  for (var P4 = 0; P4 < 6; P4++) p[P4].set(r[P4]);

  var rr = dot(r, r);
  var iters = 0;
  var converged = false;
  var breakReason = 'maxiter';

  for (var it = 0; it < maxiter; it++) {
    iters = it + 1;
    applyA(p, Ap);
    var pAp = dot(p, Ap);
    if (Math.abs(pAp) < 1e-30) { breakReason = 'pAp_underflow'; break; }
    var alpha = rr / pAp;

    /* Fused update: epsNew = eps + α·p ; rNew = r − α·Ap */
    for (var P5 = 0; P5 < 6; P5++) {
      var epsP = eps[P5], pP = p[P5], epsNewP = epsNew[P5];
      var rP2 = r[P5], ApP2 = Ap[P5], rNewP = rNew[P5];
      for (var i2 = 0; i2 < N3; i2++) {
        epsNewP[i2] = epsP[i2] + alpha * pP[i2];
        rNewP[i2]   = rP2[i2] - alpha * ApP2[i2];
      }
    }

    var rrNew = dot(rNew, rNew);
    var relRes = Math.sqrt(rrNew) / bNorm;

    /* Commit: eps ← epsNew, r ← rNew */
    for (var P6 = 0; P6 < 6; P6++) {
      eps[P6].set(epsNew[P6]);
      r[P6].set(rNew[P6]);
    }

    if (relRes < tol) { converged = true; breakReason = 'tol_reached'; break; }

    var beta = rrNew / rr;
    /* p = r + β·p (in place; old p no longer needed) */
    for (var P7 = 0; P7 < 6; P7++) {
      var rP3 = r[P7], pP2 = p[P7];
      for (var i3 = 0; i3 < N3; i3++) pP2[i3] = rP3[i3] + beta * pP2[i3];
    }
    rr = rrNew;
  }

  /* Volume-averaged stress (mean of localStress at the converged ε) */
  localStress(eps, sig);
  var sBar = [0, 0, 0, 0, 0, 0];
  for (var P8 = 0; P8 < 6; P8++) {
    var sgP = sig[P8];
    var s_ = 0;
    for (var i4 = 0; i4 < N3; i4++) s_ += sgP[i4];
    sBar[P8] = s_ / N3;
  }

  return { sigma: sBar, iters: iters, converged: converged, breakReason: breakReason };
}


/* ============================================================
   invert6x6 — partial-pivoting Gauss-Jordan inverse.

   M:       Float64Array of length 36, row-major (M[6·r + c])
   Returns: Float64Array(36) with the inverse, or null if singular.

   Singular detection: |pivot| < 1e-30 at any column.
   For C_eff of a well-connected lattice this never triggers;
   for disconnected structures it returns null and the homogenizer
   reports valid=false with reject_reason='singular_C_eff'.
   ============================================================ */
function invert6x6(M) {
  var n = 6;
  /* Build augmented [M | I] as an array of 6 rows of length 12 */
  var A = new Array(n);
  for (var i = 0; i < n; i++) {
    A[i] = new Float64Array(2 * n);
    for (var j = 0; j < n; j++) A[i][j] = M[i * n + j];
    A[i][n + i] = 1;
  }

  for (var k = 0; k < n; k++) {
    /* Partial pivot — find row with largest |A[i][k]| for i ≥ k */
    var maxAbs = Math.abs(A[k][k]);
    var pivot = k;
    for (var i2 = k + 1; i2 < n; i2++) {
      var av = Math.abs(A[i2][k]);
      if (av > maxAbs) { maxAbs = av; pivot = i2; }
    }
    if (maxAbs < 1e-30) return null;   /* singular */
    if (pivot !== k) { var tmp = A[k]; A[k] = A[pivot]; A[pivot] = tmp; }

    /* Normalise pivot row */
    var pv = A[k][k];
    for (var j2 = 0; j2 < 2 * n; j2++) A[k][j2] /= pv;

    /* Eliminate column k in all other rows */
    for (var i3 = 0; i3 < n; i3++) {
      if (i3 === k) continue;
      var f = A[i3][k];
      if (f === 0) continue;
      for (var j3 = 0; j3 < 2 * n; j3++) A[i3][j3] -= f * A[k][j3];
    }
  }

  /* Extract inverse from the right half */
  var Inv = new Float64Array(n * n);
  for (var i4 = 0; i4 < n; i4++) {
    for (var j4 = 0; j4 < n; j4++) {
      Inv[i4 * n + j4] = A[i4][n + j4];
    }
  }
  return Inv;
}


/* ============================================================
   homogenizeFullCPU — top-level: take a recipe, return full
   Voigt elastic moduli.

   recipe: F13LD recipe object (same shape as DEMO_RECIPES.schwarzP)
   N:      grid resolution (cube voxels per side; power of 2)
   opts:   { tol, maxiter }   (optional; default tol=1e-4, maxiter=300
            — matching the GPU normal-only solver's rc3 tuning)

   Returns:
     { rho, valid,
       Ex, Ey, Ez, Gxy, Gxz, Gyz,                  [MPa]
       nu_xy, nu_xz, nu_yz,
       zenerA,
       C_eff:   Array(36)    [row-major Voigt 6×6 stiffness, MPa]
       S:       Array(36)    [compliance, C⁻¹]
       perLC:   [{ axis, iters, converged, breakReason }, ...]
       totalIters, allConverged,
       timing:  { tRast_ms, tGamma_ms, tSolve_ms, total_ms } }
   ============================================================ */
function homogenizeFullCPU(recipe, N, opts) {
  opts = opts || {};
  var tol     = opts.tol     != null ? opts.tol     : 1e-4;
  var maxiter = opts.maxiter != null ? opts.maxiter : 300;

  /* Rasterize geometry via the existing lab pipeline */
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);

  var t0 = performance.now();
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt,
                          args.nWeights, args.pipeR, args.phaseShift);
  var tRast = performance.now() - t0;

  /* Volume fraction */
  var N3 = N * N * N;
  var inside = 0;
  for (var v = 0; v < N3; v++) inside += solid[v];
  var rho = inside / N3;

  /* Material — same defaults / treatment as the GPU normal solver */
  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var Es = mat.Es_MPa, nu = mat.nu;
  var C_s = isoC(Es, nu);
  var C_v = isoC(Es * 1e-4, nu);   /* small but nonzero void stiffness */
  var C_0 = isoC(Es, nu);          /* solid reference (NOT Voigt-avg) */

  /* Build full Γ̃ — μ₀ = C[21] (C44), λ₀ = C[1] (C12) per isoC layout */
  var t1 = performance.now();
  var Gamma = buildGammaFull(N, C_0[21], C_0[1], opts.scheme);
  var tGamma = performance.now() - t1;

  /* Six load cases: eps_bar = unit vector along Voigt axis lc */
  var C_eff = new Float64Array(36);
  var totalIters = 0;
  var allConverged = true;
  var perLC = [];
  var voigtLabels = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];

  var t2 = performance.now();
  for (var lc = 0; lc < 6; lc++) {
    var eps_bar = [0, 0, 0, 0, 0, 0];
    eps_bar[lc] = 1;
    var res = cgSolveFullCPU(solid, C_s, C_v, C_0, Gamma, N, eps_bar, tol, maxiter);
    totalIters += res.iters;
    if (!res.converged) allConverged = false;
    /* C_eff[P][lc] = sigma_P (column index = applied-strain LC) */
    for (var P = 0; P < 6; P++) C_eff[P * 6 + lc] = res.sigma[P];
    perLC.push({
      axis:        voigtLabels[lc],
      iters:       res.iters,
      converged:   res.converged,
      breakReason: res.breakReason
    });
  }
  var tSolve = performance.now() - t2;

  /* Symmetrise (C must be exactly symmetric; rounding from CG breaks it slightly) */
  for (var P2 = 0; P2 < 6; P2++) {
    for (var Q2 = P2 + 1; Q2 < 6; Q2++) {
      var avg = 0.5 * (C_eff[P2 * 6 + Q2] + C_eff[Q2 * 6 + P2]);
      C_eff[P2 * 6 + Q2] = avg;
      C_eff[Q2 * 6 + P2] = avg;
    }
  }

  /* Invert C_eff → S (compliance) */
  var S = invert6x6(C_eff);
  if (S === null) {
    return {
      rho:           rho,
      valid:         false,
      reject_reason: 'singular_C_eff',
      C_eff:         Array.from(C_eff),
      perLC:         perLC,
      totalIters:    totalIters,
      allConverged:  allConverged,
      timing: { tRast_ms: tRast, tGamma_ms: tGamma, tSolve_ms: tSolve,
                total_ms: tRast + tGamma + tSolve }
    };
  }

  /* Extract moduli from compliance diagonal */
  var Ex  = 1 / S[0 * 6 + 0];
  var Ey  = 1 / S[1 * 6 + 1];
  var Ez  = 1 / S[2 * 6 + 2];
  var Gyz = 1 / S[3 * 6 + 3];
  var Gxz = 1 / S[4 * 6 + 4];
  var Gxy = 1 / S[5 * 6 + 5];

  /* Poisson ratios from off-diagonal compliance.
     ν_ij = −S_ij / S_ii  (strain in j when stressed in i) */
  var nu_xy = -S[0 * 6 + 1] / S[0 * 6 + 0];
  var nu_xz = -S[0 * 6 + 2] / S[0 * 6 + 0];
  var nu_yz = -S[1 * 6 + 2] / S[1 * 6 + 1];

  /* Zener anisotropy ratio — meaningful for cubic-symmetric structures.
     A = 2·C44 / (C11 − C12).  A = 1 is isotropic.
     A > 1: stiffest along [111] body diagonal (e.g. octet truss, bcc-like).
     A < 1: stiffest along [100] face normal (e.g. skeletal Schwarz P at
            ρ=0.5 lands at A ≈ 0.5 — tubes run along the cubic axes).
     Reported as diagnostic only — bands vary too widely across the
     F13LD topology space (skeletal TPMS, sheet TPMS, spinodoid,
     hyperuniform, beam lattices) to gate on a single literature range. */
  var C11 = C_eff[0 * 6 + 0];
  var C12 = C_eff[0 * 6 + 1];
  var C44 = C_eff[3 * 6 + 3];
  var zenerA = (C11 - C12) > 1e-30 ? (2 * C44) / (C11 - C12) : NaN;

  return {
    rho:          rho,
    valid:        true,
    Ex: Ex, Ey: Ey, Ez: Ez,
    Gxy: Gxy, Gxz: Gxz, Gyz: Gyz,
    nu_xy: nu_xy, nu_xz: nu_xz, nu_yz: nu_yz,
    zenerA:       zenerA,
    C_eff:        Array.from(C_eff),
    S:            Array.from(S),
    perLC:        perLC,
    totalIters:   totalIters,
    allConverged: allConverged,
    timing: { tRast_ms: tRast, tGamma_ms: tGamma, tSolve_ms: tSolve,
              total_ms: tRast + tGamma + tSolve }
  };
}


/* ============================================================
   runFullVoigtCPUTest — Schwarz P at N=16, validation gates.

   Validation criteria for Schwarz P solid at ρ ≈ 0.5,
   Ti-6Al-4V (Es=110 GPa, ν=0.30):

     G1. CG converges on all 6 LCs (allConverged && iters < maxiter)
     G2. Cubic symmetry of normal block:
           max relative spread of {Ex, Ey, Ez}  <  2%
     G3. Cubic symmetry of shear block:
           max relative spread of {Gxy, Gxz, Gyz}  <  2%
     G4. Normal-shear decoupling:
           max |C_eff[P][Q]| over P∈{0..2}, Q∈{3..5}  <  2% of C11
     G5. Ex in literature band [27.5, 55] GPa  (E/Es ∈ [0.25, 0.50])
     G6. Gxy in literature band [6, 14] GPa    (G/Gs ∈ [0.15, 0.34])

   Zener anisotropy A is reported in the console for inspection
   but NOT gated — anisotropy bands vary widely across the F13LD
   topology space and a single literature range is fragile.
   For Schwarz P solid expect A ≈ 0.5 (skeletal, tubes along axes).

   Literature anchors:
     - Maskery et al. 2018 (Addit. Manuf.): Schwarz P E/Es ≈ 0.30
       at ρ=0.5, mild cubic anisotropy
     - rc3 GPU normal-only solver: Ex = 33.16 GPa at ρ=0.5
       (this run uses N=16; rc3 was N=32, so expect ~5-10% spread)
   ============================================================ */
var FULL_VOIGT_TEST = { state: 'idle', lastResult: null };

async function runFullVoigtCPUTest() {
  paintFullVoigtCPULink('running', '⟳ Schwarz P · Full Voigt CPU · N=16…');
  /* Yield so the running paint shows before the blocking CG solve */
  await new Promise(function(resolve){ setTimeout(resolve, 10); });

  try {
    var t0 = performance.now();
    var res = homogenizeFullCPU(DEMO_RECIPES.schwarzP, 16, { tol: 1e-4, maxiter: 300 });
    var totalMs = performance.now() - t0;

    if (!res.valid) {
      console.error('[full-voigt-smoke] homogenizeFullCPU returned invalid:', res);
      paintFullVoigtCPULink('fail', '✗ Full Voigt CPU · ' + (res.reject_reason || 'invalid'));
      return;
    }

    var ok = true;
    var notes = [];

    /* G1 — convergence */
    if (!res.allConverged) {
      ok = false;
      notes.push('CG did not converge on all LCs');
    }

    /* G2 — cubic symmetry of E */
    var Eavg = (res.Ex + res.Ey + res.Ez) / 3;
    var Eanisotropy = Math.max(
      Math.abs(res.Ex - res.Ey),
      Math.abs(res.Ey - res.Ez),
      Math.abs(res.Ez - res.Ex)
    ) / Eavg;
    if (Eanisotropy > 0.02) {
      ok = false;
      notes.push('E cubic symmetry: ' + (Eanisotropy * 100).toFixed(2) + '% spread (>2%)');
    }

    /* G3 — cubic symmetry of G */
    var Gavg = (res.Gxy + res.Gxz + res.Gyz) / 3;
    var Ganisotropy = Math.max(
      Math.abs(res.Gxy - res.Gyz),
      Math.abs(res.Gyz - res.Gxz),
      Math.abs(res.Gxz - res.Gxy)
    ) / Gavg;
    if (Ganisotropy > 0.02) {
      ok = false;
      notes.push('G cubic symmetry: ' + (Ganisotropy * 100).toFixed(2) + '% spread (>2%)');
    }

    /* G4 — normal-shear decoupling */
    var crossMax = 0;
    for (var P = 0; P < 3; P++) {
      for (var Q = 3; Q < 6; Q++) {
        var v = Math.abs(res.C_eff[P * 6 + Q]);
        if (v > crossMax) crossMax = v;
      }
    }
    var C11 = Math.abs(res.C_eff[0]);
    var crossFrac = C11 > 0 ? crossMax / C11 : 0;
    if (crossFrac > 0.02) {
      ok = false;
      notes.push('normal-shear coupling ' + (crossFrac * 100).toFixed(2) + '% of C11 (>2%)');
    }

    /* G5 — Ex literature band */
    if (res.Ex < 27500 || res.Ex > 55000) {
      ok = false;
      notes.push('Ex out of band [27.5, 55] GPa: ' + (res.Ex / 1000).toFixed(2));
    }

    /* G6 — Gxy literature band */
    if (res.Gxy < 6000 || res.Gxy > 14000) {
      ok = false;
      notes.push('Gxy out of band [6, 14] GPa: ' + (res.Gxy / 1000).toFixed(2));
    }

    /* Zener anisotropy A — diagnostic only, no hard gate (see header). */

    FULL_VOIGT_TEST.lastResult = { res: res, ok: ok, notes: notes, totalMs: totalMs };

    var bg = ok ? '#34d399' : '#fb7185';
    var fg = ok ? '#06080f' : '#fff';
    var lcLine = res.perLC.map(function(p){
      return p.axis + ':' + p.iters + '·' + p.breakReason;
    }).join('  ');

    console.log(
      '%c ' + (ok ? '✓' : '✗') + ' Schwarz P · Full Voigt CPU · N=16 ',
      'background:' + bg + '; color:' + fg + '; font-weight:bold; padding:2px 8px; border-radius:3px;',
      '\n  ρ (VF):       ' + (res.rho * 100).toFixed(2) + '%' +
      '\n  Ex/Ey/Ez:     ' + (res.Ex/1000).toFixed(2) + ' / ' + (res.Ey/1000).toFixed(2) + ' / ' + (res.Ez/1000).toFixed(2) + ' GPa' +
      '\n  Gxy/Gxz/Gyz:  ' + (res.Gxy/1000).toFixed(2) + ' / ' + (res.Gxz/1000).toFixed(2) + ' / ' + (res.Gyz/1000).toFixed(2) + ' GPa' +
      '\n  ν_xy/xz/yz:   ' + res.nu_xy.toFixed(3) + ' / ' + res.nu_xz.toFixed(3) + ' / ' + res.nu_yz.toFixed(3) +
      '\n  Zener A:      ' + res.zenerA.toFixed(3) + '   (diagnostic; A=1 isotropic, A<1 stiff along [100], A>1 stiff along [111])' +
      '\n  C11/C12/C44:  ' + (res.C_eff[0]/1000).toFixed(2) + ' / ' + (res.C_eff[1]/1000).toFixed(2) + ' / ' + (res.C_eff[21]/1000).toFixed(2) + ' GPa' +
      '\n  E spread:     ' + (Eanisotropy*100).toFixed(3) + '%   (cubic gate < 2%)' +
      '\n  G spread:     ' + (Ganisotropy*100).toFixed(3) + '%   (cubic gate < 2%)' +
      '\n  N-S coupling: ' + (crossFrac*100).toFixed(3) + '% of C11   (gate < 2%)' +
      '\n  CG iters:     ' + res.totalIters + ' total · all converged: ' + res.allConverged +
      '\n  per-LC:       ' + lcLine +
      '\n  rasterize:    ' + res.timing.tRast_ms.toFixed(0) + ' ms' +
      '\n  Γ̃ build:      ' + res.timing.tGamma_ms.toFixed(0) + ' ms' +
      '\n  CG solve:     ' + res.timing.tSolve_ms.toFixed(0) + ' ms' +
      '\n  total:        ' + totalMs.toFixed(0) + ' ms' +
      (notes.length ? '\n  notes:        ' + notes.join(' · ') : '\n  notes:        all 6 gates passed')
    );

    if (ok) {
      paintFullVoigtCPULink('pass',
        '✓ Full Voigt CPU · Ex=' + (res.Ex/1000).toFixed(1) + ' G44=' + (res.Gxy/1000).toFixed(1) + ' GPa');
    } else {
      paintFullVoigtCPULink('fail',
        '⚠ Full Voigt CPU · ' + notes.length + ' check' + (notes.length === 1 ? '' : 's') + ' failed (see console)');
    }
  } catch (err) {
    console.error('[full-voigt-smoke] failed:', err);
    paintFullVoigtCPULink('fail', '✗ ' + (err.message || String(err)));
  }
}

function paintFullVoigtCPULink(state, text) {
  var link = document.getElementById('fullVoigtTestLink');
  if (!link) return;
  FULL_VOIGT_TEST.state = state;
  link.classList.remove('running', 'pass', 'fail');
  if (state !== 'idle') link.classList.add(state);
  link.textContent = text;
}
