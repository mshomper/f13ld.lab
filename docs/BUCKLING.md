# Linear Buckling in F13LD.lab

**Module status:** live · CPU oracle + Web Worker pool · GPU solver deferred
**Files:** `16c-buckling-cpu-ref.js` (solver), `16e-buckling-cpu-worker.js` (execution), `40-design-grid.js` + `21-raymarcher.js` + `30-view-tabs.js` + `lab.css` (visualization)

This document is the standing reference for what the buckling tab computes, how it computes it, what's quantitative versus qualitative, and where the limits are. The chronological build record lives in `PHASE_5.md`; this is the "how it works and how to read it" companion.

---

## What it answers

Elastic homogenization (Phase 4) tells you how stiff a unit cell is. It says nothing about *stability* — whether the thin walls and struts will collapse sideways under compression long before the material yields. For low-density scaffolds that distinction is often the one that governs: a gyroid at ρ ≈ 0.3 can be plenty stiff and still fail by wall buckling at a fraction of its yield load.

The buckling tab answers three questions, in decreasing order of how much you should trust the number:

1. **When** — the critical load factor λ_cr and critical macroscopic stress p_cr (quantitative, the headline result).
2. **Where + how** — the mode shape: which walls buckle and in what pattern (qualitative; the colormap and animation).
3. **What kind** — local (individual wall/strut) versus global (whole-cell) buckling, as a single localization scalar with a band label (qualitative; the corner chip).

---

## Formulation

This is **linear (eigenvalue) buckling**, the analogue of a modal analysis for stability. The cell is loaded with a unit macroscopic strain along one axis; the resulting prestress field σ₀(x) builds a geometric stiffness operator K_g that *subtracts* from the elastic stiffness K as the load scales up. Instability is the load multiplier at which the total stiffness loses positive-definiteness.

Restricting to **cell-periodic modes (Bloch wavevector q = 0)** — i.e. modes with the unit cell's own periodicity — this becomes a generalized eigenproblem, solved independently for each normal axis (xx / yy / zz):

```
(−K_g) φ = θ K φ ,   λ = 1/θ ,   λ_cr = 1 / θ_max  (smallest positive λ)
p_cr = λ_cr · |σ̄_axis|
```

- **λ_cr** is the factor the applied load must be multiplied by to reach instability. λ_cr ≫ 1 is comfortable; λ_cr near 1 means the structure buckles at roughly its operating load.
- **p_cr** is that factor times the macroscopic stress the unit strain produced — the critical compressive stress in MPa.
- **critAxis** is whichever of xx/yy/zz gives the smallest λ_cr (the weakest direction).
- **φ** is the buckling eigenvector — the mode shape. Its amplitude is arbitrary (eigenvectors carry no absolute scale); only its *shape* is meaningful.

`P_cr / P_y` on the tiles compares p_cr against a yield stress. It is flagged provisional (`*`) because the yield value is currently a fixed Ti-6Al-4V constant (`SIGMA_Y_TI64_MPA = 880`), not a per-design computed yield — that arrives with the nonlinear phase. `buckling-limited` means p_cr < p_y (it buckles before it yields); `yield-limited` means the reverse.

### Why only normal axes, and why q = 0

Shear load cases are not run: a cell-periodic buckling mode under shear prestress is not the dominant failure path for the compression-governed scaffolds this tool targets, and the prestress extraction is set up for the three normal cases. The q = 0 restriction means we capture buckling at the unit-cell scale but **not** long-wavelength (super-cell, q ≠ 0) microflexural modes, which would require a Bloch sweep over wavevectors. Both are noted in the limits below.

---

## Solver — `16c-buckling-cpu-ref.js`

A from-scratch matrix-free eigensolver, written first as a reference oracle and validated to machine precision, then run in production (the GPU path is still pending — see limits).

**Operators.** `applyKcpu` (elastic stiffness), `applyKgcpu` (geometric stiffness from the prestress), and the spectral derivative `specDeriv`, all matrix-free on the N³ grid. Validated by `runBucklingOperatorSelfTest` to ~1e-15.

**Prestress.** `extractPrestressCPU` solves the displacement-form elastic cell problem under a unit macro strain (via `applyKcpu` + preconditioned CG) and returns the prestress σ₀ and the macroscopic stress σ̄ that feed K_g and p_cr.

**Eigensolver.** `bk_subspaceGen` — block subspace iteration with a rank-revealing, B-orthonormalized Rayleigh–Ritz step. The elastic operator K has a nullspace (the constant/rigid-translation mode, plus the spectral Nyquist mode); the Rayleigh–Ritz step detects and projects these out so the reduced problem stays symmetric-positive-definite. Modes are kept zero-mean throughout. The driver `bucklingFromSolid` loops the three axes and returns per-axis λ, σ̄, mode φ, and the localization scalar; `homogenizeBucklingCPU` wraps it with the recipe → rasterize front-end.

**Preconditioner.** Inner K-solves use `bk_pcgSolveK` with a scalar reference-Laplacian Fourier preconditioner `bk_makePrecondScalar` = 1/(μ₀·|κ|²) per component (DC and Nyquist zeroed, μ₀ = solid shear modulus = `C_s[21]`). It is solution-preserving — it changes iteration count, not the answer — and cut the prestress CG from 899 to 248 iterations at N=8.

**Validation.** Beyond the operator gates, a dense N=4 cross-check confirmed the matrix-free generalized eigensolve matches a dense reference to a relative error of 2.7e-15 — machine-exact. `runBucklingEigSelfTest` and `runBucklingCPUTest` are the in-console regression entry points.

---

## Execution — `16e-buckling-cpu-worker.js`

The solve is CPU-bound and embarrassingly parallel across the three axes, so it runs off the main thread in a persistent Web Worker pool.

- **Pool size** = `min(navigator.hardwareConcurrency − 1, 8)`, leaving a core for the UI (7 workers on an 8-core machine).
- Each worker is a Blob that `importScripts` the dependency closure `[18, 14, 13, 16c]` and solves **one axis** per task. `computeBucklingCPU(recipe, N, opts, onProgress)` fans the three axes across the pool and aggregates a single result.
- **In-browser defaults** (`BUCKLE_CPU_DEFAULTS`) trade a little eigenvalue precision for speed: `block 4, eigIters 30, eigTol 1e-3, cgTol 3e-3, cgMaxiter 250`. The oracle's tighter defaults (block 8, eigTol 1e-8) remain available for validation runs.
- **Console helpers:** `F13LD_buckleBench(recipe, N)` and `F13LD_bucklePoolInfo()`.

> **Origin requirement.** Blob-worker `importScripts` is blocked under `file://`. The buckling tab only works when the page is served over http(s) — a local static server or the GitHub Pages deployment. Opening `index.html` directly will silently produce no modes.

**Measured cost** (8-core desktop, Schwarz P, N=8, three axes): **17.6 s** pooled versus 61.5 s serial. Result on that case: λ_cr ≈ 3.19e-4, p_cr ≈ 43.9 MPa, ρ = 0.50. N=8 is the comfortable default; N=16 is opt-in via the Buckle pill and is where the localization metric becomes fully meaningful (below).

**Result shape:**

```
{ lambda_cr, pcr, critAxis, rho,
  perAxis: [ { axis, lambda, sBar, cgIters, mWave } ],   // mWave = localization, waves/cell
  modes:   { xx|yy|zz: { u_prime:[Fx,Fy,Fz], sigma_vm:|φ|, N, eps_bar:[0,0,0] } } }
```

The Run-All integration (`50-controls.js`) stores this per design in `BUCKLE_BY_DESIGN` (a transient map, deliberately not persisted with the design definitions) and decorates it with `pcr_py`, `failure_mode`, and `provisional`.

---

## Visualization

The buckling tab reuses the stress-field rendering path rather than introducing a parallel one. A buckling mode field carries the eigenvector in the displacement slot (`u_prime`) and the displacement magnitude |φ| in the stress slot (`sigma_vm`), so the existing raymarcher warps the geometry by φ *and* contours it by |φ| in a single pass.

**Mode-shape warp.** The cell is displaced by the eigenvector. Because an eigenmode carries no macroscopic strain, `eps_bar` is `[0,0,0]` — the cube does not stretch the way the Deformed tab does; it warps in place. An isotropic fit margin (`uWarpExpand`, sized to the exaggeration) grows the render envelope just enough that the swinging mode never clips the cube faces. The box itself does not pulse.

**Animation.** The mode swings full-cycle — `amplitude · sin(2πt / 2.5s)` — through the undeformed shape to the mirror image and back, on by default. This is the single most legible way to read a mode shape; a static warp of an arbitrary-amplitude eigenvector is what people find confusing. The pulse plumbing (`setPulse`) is in place if a play/pause toggle is ever wanted.

**Colormap.** A vivid turbo ramp (blue node → cyan → green → yellow → red antinode), gated by `uBuckleMap` so the Stress tab keeps its cividis map. The cap is the **90th percentile** of |φ|, not the max — a single peak voxel pinning the scale washed the whole surface blue; p90 lets the buckling zones saturate at the hot end. An ambient floor (`0.4 + 0.6·diffuse`) keeps the color saturated on faces angled away from the light. The legend in the corner reads "rel. disp · qualitative," node → antinode, no units, because the magnitude is arbitrary.

**Exaggeration.** The buckle slider is a qualitative amplitude control, 0–30 % of the cell, default 10 %, independent of the eigenvector's scale (the warp peak is normalized by the field's own max so "10 %" always means the worst-displaced voxel moves 10 % of a cell).

---

## Localization metric — the corner chip

The headline qualitative result is whether the critical mode is **local** (individual walls/struts buckling, short wavelength) or **global** (the whole cell swaying, long wavelength). Smooth TPMS shells suppress local buckling; strut-like topologies go locally first. The chip puts a number on what the colormap already hints at.

The metric is the RMS spatial frequency of the mode *within the solid*, in waves per cell — the gradient Rayleigh quotient:

```
m̄ = (N / 2π) · asin( min(1, √( Σ_solid |∇φ|² / Σ_solid |φ|² )) )
```

By Parseval this is the square root of the energy-weighted mean-square wavenumber — "how many waves does the displacement make across the cell." Computing it in real space (rather than via FFT) lets the sum run over material voxels only, so the soft-void displacement doesn't skew it. The `asin` corrects the centered-difference gradient's high-frequency compression so the value reads the true wavenumber (verified exact on pure sine fields: m = 1, 2, 3, 4 → m̄ = 1.0, 2.0, 3.0, 4.0).

**Bands:** `m̄ < 1.5` → **Global**, `1.5 ≤ m̄ < 3.0` → **Mixed**, `m̄ ≥ 3.0` → **Local**. The chip is a stoplight — green / amber / red — with red aligned to the turbo hot end so "red chip ↔ red antinodes" reads consistently. It reflects the currently displayed axis (each axis has its own mode and its own m̄) and updates on the XX/YY/ZZ toggle.

> **Resolution caveat.** A centered-difference gradient on an N³ grid can only resolve up to ~N/4 waves per cell. At the default **N=8** the metric tops out near 2, so the Local band effectively cannot fire — an 8³ grid genuinely cannot resolve wall-scale buckling. Run **N=16** when the local/global distinction matters. A coarse run showing "Mixed" on something you suspect is local is the cue to bump N.

---

## Reading the output — what to trust

| Quantity | Trust | Why |
|---|---|---|
| λ_cr, p_cr, critAxis | Quantitative | The eigenvalue is the real result of a linear buckling analysis. |
| P_cr / P_y | Provisional | p_cr is real; the yield it's divided by is a fixed Ti-6Al-4V constant pending the nonlinear phase. |
| Mode shape (color, animation) | Qualitative | Eigenvector amplitude is arbitrary; the *pattern* is meaningful, the magnitude is not. |
| Localization label / m̄ | Qualitative | A robust spatial-frequency read, but resolution-limited by N and band thresholds are tunable. |

Linear buckling says nothing about post-buckling behavior — whether the structure collapses or finds a new stable configuration after the instability. That is a nonlinear question.

---

## Limits

- **Linear eigenvalue analysis.** No post-buckling, no imperfection sensitivity, no large-deflection path. The mode amplitude and any stress derived from it are meaningless in absolute terms.
- **q = 0 only.** Long-wavelength (super-cell) buckling modes are not captured; that needs a Bloch sweep over wavevectors.
- **Provisional yield.** `P_cr / P_y` uses a fixed 880 MPa Ti-6Al-4V yield. A per-design computed yield arrives with the nonlinear phase.
- **Localization resolution scales with N.** Local detection needs N=16; N=8 caps the metric near the Mixed band.
- **CPU-only for now.** The validated path is the worker pool. A GPU LOBPCG solver (`16d`) is scoped but not built; it would cut the N=16 cost substantially.
- **Served-origin requirement.** No `file://`.

---

## File map

| File | Role |
|---|---|
| `16c-buckling-cpu-ref.js` | Matrix-free solver: operators, prestress, subspace eigensolver, Fourier preconditioner, localization metric, self-tests |
| `16e-buckling-cpu-worker.js` | Web Worker pool, axis fan-out, aggregation, console helpers |
| `50-controls.js` | Run-All Phase 2 integration, `BUCKLE_BY_DESIGN`, provisional P_cr/P_y, Buckle N pill |
| `30-view-tabs.js` | Buckle view-mode state, exaggeration state |
| `40-design-grid.js` | Buckle tab render: colormap upload, mode accessors, exaggeration control, localization chip, stat tiles |
| `21-raymarcher.js` | Warp + turbo colormap + animation pulse + fit envelope (`setPulse` / `setBuckleAmp` / `setWarpExpand` / `setBuckleMap`) |
| `lab.css` | `.vp-buckle-chip` stoplight styling |

---

*© 2026 Not a Robot Engineering LLC · matt@notarobot-eng.com*
