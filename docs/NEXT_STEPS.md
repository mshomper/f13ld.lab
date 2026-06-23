# F13LD.lab — Next Steps (session handoff)

**As of:** v0.7.1 · roadmap item #3 (GPU buckling port) closed out
**Owner direction:** Matt Shomper directs implementation; **analyze and present proposed
changes for approval before writing or modifying any code.** Do not over-deliberate, but
do not apply edits unilaterally.

This document is the plan for the **next** session. It is ordered by what to do first.
The headline goal: **make the CPU linear-buckling solve appreciably faster at N=16/32/64**,
because that is the shipped path and it is currently slow on thin-wall shell designs.

---

## 0. Current state (what's already true)

- **Buckling ships on CPU.** `window.BUCKLE_GPU = false` in `16d-buckling-solver.js`. The
  CPU Web Worker pool (`16e-buckling-cpu-worker.js` → `computeBucklingCPU` →
  `homogenizeBucklingCPU`/`bucklingFromSolid` in `16c-buckling-cpu-ref.js`) is primary.
- **GPU buckling (`16d`) is built, numerically validated, and shelved.** Operators,
  Γ⁰ preconditioner, resident PCG (6.8×), prestress, and a Gram-batched block subspace
  eigensolver all validate against the CPU oracle. It is **off by default** because at
  N ≤ 64 the eigensolver is *latency-bound* — thousands of small `mapAsync` readbacks
  dominate and the problem is too small for GPU compute to amortize them, so it loses to
  the CPU pool (which batches designs/axes across cores). Revisit only at N ≥ 128, and
  only with the rearchitecture in §4. Toggle on via `window.BUCKLE_GPU = true`.
- **Buckle + Nonlin grids are 16 / 32 / 64** (8 removed). Powers of two only — the
  radix-2 FFT (`fft3dCpu`) hard-throws on non-pow2 N, so **48³ is not an option**.
- **Under-resolved/disconnected designs surface a warning** (amber card + run-complete
  banner) instead of a silent blank.

### Why the CPU solve is slow (the cost model)

Per axis, `bucklingFromSolid` runs `bk_subspaceGen` (block subspace iteration). Each
**outer sweep** does, for each of `block` vectors, a **power step** `Z = K⁻¹(−K_g)X` — and
that `K⁻¹` is an **inner FFT-CG solve** (`bk_pcgSolveK`, ~30–60 inner iterations), each
inner iteration being ~6 FFTs of N³. So a single axis is roughly
`eigIters(≤30) × block(4) × innerCG(~50) ≈ 6,000` inner solves' worth of FFTs.
**The inner `K⁻¹` solve is where essentially all the time goes.**

Production tolerances are **already at screening levels** (`BUCKLE_CPU_DEFAULTS` in
`16e`: `block 4, eigIters 30, eigTol 1e-3, cgTol 3e-3, cgMaxiter 250`; prestress inherits
`cgTol 3e-3`). So **loosening tolerance is mostly spent** — maybe 1.5–2× more before σ_cr
stops being trustworthy. Do **not** lead with tolerance loosening.

---

## 1. PRIORITY 1 — Warm-start the inner solves  *(free accuracy, ~1.3–2×)*

**Idea.** In subspace iteration the inner RHS (`−K_g·X`) changes only slowly as `X`
converges, and `K` is identical across all sweeps and is the **same operator across all
three axes**. Feeding the previous solution as the PCG initial guess `x₀` (instead of
zero) cuts inner-CG iteration counts substantially as the outer iteration settles.

**Where.**
- `bk_pcgSolveK(applyB, applyMinv, b, n, N3, tol, maxiter)` in `16c-buckling-cpu-ref.js`
  currently starts from `x = 0`. Add an optional `x0` argument (default zero-init for
  back-compat).
- `solveB` closure inside `bucklingFromSolid` (≈ line 1108) should keep a persistent
  per-vector previous-solution buffer and pass it as `x0`.

**Care.** Zero-mean projection must still hold on the warm-started `x₀`
(`bk_zeroMeanFlat`). Warm-start changes *iteration count only*, never the converged
answer — so parity must be exact (to solver tol) against the current path.

**Validate.** `F13LD_buckleBench()` (Schwarz P, N=8, CPU) before/after: identical
`λ_cr` (within tol), lower wall-time. Then bench at N=16.

---

## 2. PRIORITY 2 — Real-valued FFT  *(~2×, stacks with everything)*

**Idea.** The displacement/strain/stress fields are **real**. The current `fft3dCpu`
(radix-2, complex, defined in `18-stokes-cpu-ref.js`, shared by elastic/buckling/Stokes)
transforms real data through a full complex FFT. A real-input FFT (pack two real arrays
into one complex transform, or a dedicated split-radix rfft) roughly **halves** the FFT
work, and FFTs are the inner-loop bottleneck.

**Where.**
- `fft3dCpu` in `18-stokes-cpu-ref.js` (line ~89; note the pow2 guard at ~92).
- It is shared — any change must preserve the spectral conventions the **Green operators**
  rely on (`applyKcpu`/`applyKgcpu` in `16c`, and the elastic `16a`/`16b`).

**Care.** This is the riskiest of the "cheap" wins because the spectral-space layout
changes: Hermitian symmetry, Nyquist handling, and the `i·κ` derivative / Γ⁰ Christoffel
operators all index frequency bins. Two safe routes:
  (a) keep `fft3dCpu`'s external contract identical and internally pack two real
      transforms per complex pass (lowest blast radius); or
  (b) a true rfft with a half-spectrum layout (more work, more speed, touches the
      operators).
Recommend (a) first.

**Validate.** Elastic + buckling parity against the CPU oracles at N=16 (the elastic
oracle `16a-elastic-cpu-ref-full.js` drifts 0.001–0.004% today — hold that), and
`F13LD_buckleBench()` λ_cr unchanged.

> Combined, §1 + §2 should land ~3–4× with **zero** accuracy cost. Ship that, re-measure
> N=16/32, and decide whether §3 is still needed.

---

## 3. PRIORITY 3 (step change) — CPU LOBPCG  *(5–20×, no accuracy loss)*

**Idea.** Eliminate the inner `K⁻¹` solve entirely. Preconditioned **LOBPCG** for the
generalized problem `(A, B) = (−K_g, K)` finds the largest θ (→ smallest λ_cr = 1/θ_max)
using only **one `A·x`, one `B·x`, and one preconditioner apply per iteration**, plus a
small Rayleigh-Ritz on a `3·block` subspace — **no inner linear solve at all**. That is
the structural reason it can be an order of magnitude cheaper than inner-solve subspace
iteration, and it converges to the *true* eigenpair (no accuracy trade).

**Pieces that already exist.**
- Operators: `applyKgcpu` (A), `applyKcpu` (B), both matrix-free in `16c`.
- Preconditioner: `bk_makePrecondGamma0(N, C_s[21], C_s[1])` — the Γ⁰ Christoffel-inverse,
  applied directly to the residual (this is exactly what LOBPCG wants).
- Reduced eigensolve: `bk_jacobiSym` (dense symmetric) for the `3·block` Rayleigh-Ritz.
- Zero-mean projector: `bk_zeroMeanFlat`.
- An oracle to validate against: the current `bk_subspaceGen` path (trusted).

**Status note.** `lobpcgGenCPU` is *named in comments* in `16c` (the current method is
called "LOBPCG-flavoured") but the real inner-solve-free LOBPCG was a planned "Push 2"
that **was never built**. This is that build.

**Care.** LOBPCG's known failure mode is the **B-orthonormalization** of the
`[X, R, P]` block — it goes ill-conditioned as vectors align. Implement with explicit
B-orthonormalization (Cholesky of the `3m×3m` Gram, with a fallback/soft-locking when
near-singular), and guard the `P` (conjugate) direction. Reference: Knyazev's LOBPCG,
generalized form. Keep `block` small (3–4) — only the dominant mode governs λ_cr.

**Validate.** λ_cr and critical axis must match `bk_subspaceGen` on Schwarz P, spinodoid,
and hyperuniform at N=8 and N=16 (the eigenvalue is the invariant; mode sign/phase is
free). Then `F13LD_buckleBench()` wall-time should drop sharply.

**Wire-in.** Once validated, switch `bucklingFromSolid`'s eigensolve from `bk_subspaceGen`
to `lobpcgGenCPU` behind a flag (e.g. `opts.method`), defaulting to LOBPCG once trusted,
keeping subspace iteration as the oracle.

---

## 4. SHELVED — GPU buckling rearchitecture  *(only at N ≥ 128)*

Do **not** pursue unless the tool is pushing past N=64, where GPU compute finally
dominates and the CPU pool bogs down. `16d` is validated but latency-bound at small N.
To make it win it must become **sync-bound → compute-bound**:

1. **~1 readback per sweep.** Fixed-iteration resident inner PCG (no per-iter
   convergence-check readback), **batched Cholesky-QR orthonormalization** (fold the
   sequential Gram-Schmidt's ~`s²/2` readbacks/sweep into one batched Gram + CPU Cholesky,
   the same trick already used for the SA/SB Gram via `gramAB`), and a resident zero-mean.
2. **Fill the GPU's lanes.** Solve **all three axes (and ideally all designs)
   simultaneously** in wide buffers, so one readback/sweep covers every problem at once
   instead of one tiny axis serially. This is the GPU analog of the CPU's cross-core
   batching.

Done together: "2 min/axis serial" → "a few seconds for all axes of all designs." Done
halfway: still slower than CPU. The Gram-batching (`gramAB`) is already in `16d` as a
template for the resident-reduction pattern.

---

## 5. Related backlog (buckling-adjacent)

- **Thin-wall σ_cr accuracy — periodic / Bloch–Floquet BCs.** The q=0 cell-periodic
  buckling clips thin-wall/strut features at the cell boundary, giving an artificially low
  σ_cr (the documented cantilever/boundary artifact; hyperuniform's 11.7 MPa was this).
  Proper fix is periodic/Bloch–Floquet boundary conditions. Relative ranking at fixed N is
  still meaningful today; absolute σ_cr carries boundary error. This is the *correctness*
  companion to the *speed* work above.
- **Under-resolution guard for thin walls.** `homogenizeBucklingCPU` skips when
  `interiorFrac < 0.04`. This correctly catches sub-voxel features but also catches valid
  *connected thin walls*. If thin-wall support matters, consider a connectivity-based gate
  (single component + no orphan voxels, let the eigensolve report whether a positive mode
  exists) instead of a blunt interior-fraction cutoff. Don't loosen it blindly — it exists
  to stop reporting boundary-artifact garbage.

---

## 6. Validation harness (use these, don't reinvent)

- **`F13LD_buckleBench()`** — runs Schwarz P through the real CPU worker path (N=8 by
  default), independent of UI state. The go-to parity/timing check.
- **`runBucklingEigGPUTest(N)`** — GPU eig vs converged CPU reference; prints `secGPU`,
  `secCPU`, `relErr`. (GPU path only.)
- **Node rasterization probe** — to measure `interiorFrac`/ρ for a recipe at any N without
  a browser: shim `window/document/performance`, concatenate
  `13-kernels.js` + `14-rasterizer.js` + `14a-connectivity.js` in one scope, then
  `KERNELS[family].parseRecipe(recipe)` → `resolveBuildArgs` → `buildVoxels`. (Used this
  session to confirm the thin-shell under-resolution at N=32.)

---

## 7. Conventions (do not violate)

- **CRLF files** — `index.html`, `50-controls.js`, `40-design-grid.js`, and most non-`16*`
  files use CRLF. **Patch them with count-guarded Python** (read `newline="",
  encoding="utf-8"`, assert match count, replace, write). **Never `str_replace` a CRLF
  file**, and never edit `index.html`/`lab.css` from a stale snapshot.
- **LF files** — the `16*.js` solver files are LF; `str_replace` is fine.
- **`node --check`** every JS file before delivering.
- **Powers of two only** for any FFT grid (radix-2 `fft3dCpu`).
- **Never use the words "genuine" / "genuinely."**
- Present proposed diffs for approval **before** applying. Deliver files to
  `/mnt/user-data/outputs` via `present_files`.

---

## 8. Key files

| File | Role |
| --- | --- |
| `16c-buckling-cpu-ref.js` | CPU oracle: `homogenizeBucklingCPU`, `bucklingFromSolid`, `bk_subspaceGen`, `bk_pcgSolveK`, `bk_makePrecondGamma0`, `extractPrestressCPU`, the under-resolution guard. **§1 and §3 land here.** |
| `18-stokes-cpu-ref.js` | `fft3dCpu` (radix-2, pow2 guard). **§2 lands here.** Shared across solvers. |
| `16e-buckling-cpu-worker.js` | Worker pool, `computeBucklingCPU`, `BUCKLE_CPU_DEFAULTS`, `F13LD_buckleBench`. |
| `16d-buckling-solver.js` | GPU solver (`BUCKLE_GPU=false`), `solveDesignBucklingGPU`, `computeBuckling` dispatcher, `gramAB` (resident-reduction template). **§4 only.** |
| `50-controls.js` | Run pipeline `runRealSweep`, pills (`onBucklePillClick`/`onNonlinPillClick`, 16/32/64), `PHYS_STATE`/`BUCKLE_STATE`/`NONLIN_STATE`, under-resolved banner. CRLF. |
| `40-design-grid.js` | Grid render incl. buckling card + `skip_reason` warn styling. LF. |
| `14-rasterizer.js` / `13-kernels.js` | `buildVoxels`, `resolveBuildArgs`, `KERNELS`. |

Repo: `github.com/mshomper/f13ld.lab` · contact: matt@notarobot-eng.com
