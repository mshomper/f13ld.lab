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

   ── Scope this push (push 1 of 2) ───────────────────────
   - VOIGT_IJ, VOIGT_F           (index + engineering-shear tables)
   - buildGammaFull              (full 6×6 Γ̃ tensor)
   - runBuildGammaFullSelfTest   (algebraic regression vs the
                                  existing normal-only buildGamma
                                  in 14-rasterizer.js — should
                                  agree to float64 epsilon)

   ── Deferred to push 2 ──────────────────────────────────
   - applyGammaRowFull, cgSolveFullCPU, homogenizeFullCPU
   - invert6x6 (full 6×6 compliance inversion for moduli)
   - runFullVoigtCPUTest (Schwarz P at N=16, full physics)
   - UI self-test link in index.html controls panel
   - GPU port to vec4-packed WGSL kernels (separate session)

   ── Voigt convention used throughout ────────────────────
   - Voigt index P ∈ {0=xx, 1=yy, 2=zz, 3=yz, 4=xz, 5=xy}
   - Engineering shear strain (ε_V[3] = 2·ε_23, etc.)
   - Natural shear stress      (σ_V[3] = σ_23, no factor of 2)
   - Voigt index → tensor      P=0:(0,0), 1:(1,1), 2:(2,2),
                                3:(1,2), 4:(0,2), 5:(0,1)
   - Matches isoC()'s existing 6×6 storage in 14-rasterizer.js
     and the sweep production code.
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
   (push 2) — no per-row symmetry-aware unpacking needed.
   At N=64: 36 · 64³ · 8 bytes = ~75 MB. Acceptable on CPU.

   At ξ = 0 (DC bin) Γ̃ is left at zero — no macroscopic
   strain correction to the constant mode.
   ============================================================ */
function buildGammaFull(N, mu0, lam0) {
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
