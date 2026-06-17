# Phase 5 — Linear Buckling · CPU Oracle · Worker Pool · Mode-Shape Viz · Localization

**Status:** complete (CPU path) · v0.5.0
**Duration:** multi-session buckling sprint (solver bring-up → worker pool → UI → visualization polish)
**Outcome:** Linear (eigenvalue) buckling is live as a fifth view tab. A from-scratch matrix-free eigensolver, validated to machine precision against a dense reference, runs in a persistent Web Worker pool fast enough to ship in-browser. The tab renders the buckling mode as an animated, turbo-colored relative-displacement field and classifies each mode local-vs-global with a single scalar. The GPU LOBPCG solver originally pencilled in for Phase 5 was deferred — the CPU oracle proved fast enough to release without it.

All five view tabs (Geometry / Deformed / Stress / Stiffness ⊕ / Buckling) are operational.

---

## Objective

Phase 4's handoff scoped Phase 5 as "linear buckling (LOBPCG)" building on the full-Voigt linear-operator infrastructure. The phase delivered the buckling *capability* but pivoted the implementation:

1. **Write the eigensolver as a CPU reference oracle first** (`16c`), validated to machine precision, rather than going straight to GPU LOBPCG. This de-risked the hard part — getting the geometric-stiffness eigenproblem and its nullspace handling exactly right — before optimizing.
2. **Run it off the main thread in a Web Worker pool** (`16e`), one axis per worker. This turned the "slow CPU fallback" into a shippable production path: the three-axis solve parallelizes cleanly and lands in ~18 s at N=8.
3. **Build the Buckling view tab** by reusing the Deformed/Stress rendering path rather than a parallel one.
4. **Make the mode shape legible** — the central UX problem, since a linear buckling mode has arbitrary amplitude and reads as confusing if shown statically. Solved with an animated full-cycle pulse and a relative-displacement colormap.
5. **Add a local-vs-global localization read** — the metamaterial-specific value-add, computed from the eigenvector already in hand.

### Scope boundaries set up front

- **Linear eigenvalue buckling, q = 0.** Cell-periodic modes only; no Bloch sweep, no post-buckling, no imperfection sensitivity. Mode amplitude is qualitative.
- **Normal axes only.** xx/yy/zz uniaxial prestress. Shear buckling is not the governing path for compression-loaded scaffolds and isn't run.
- **Provisional strength ratio.** `P_cr / P_y` divides the real p_cr by a fixed Ti-6Al-4V yield (`SIGMA_Y_TI64_MPA = 880`). A per-design yield is a nonlinear-phase deliverable. The `*` and "provisional" labels are load-bearing — they prevent the number being read as final.
- **CPU-first, GPU deferred.** The worker pool is the production path. `16d` (GPU LOBPCG) is scoped but unbuilt.
- **Served origin required.** Blob-worker `importScripts` is blocked under `file://`; the tab needs http(s).

---

## TL;DR — what landed

| Area | Title | Outcome |
|---|---|---|
| Solver | Matrix-free buckling oracle (`16c`) | Operators validated ~1e-15; dense N=4 generalized-eigen cross-check exact (rel 2.7e-15) |
| Solver | Fourier preconditioner for inner K-solves | Prestress CG 899 → 248 iters at N=8; solution-preserving |
| Execution | Web Worker pool (`16e`) | 3 axes fanned across `min(cores−1, 8)` workers; N=8 3-axis 17.6 s vs 61.5 s serial |
| Integration | Run-All Phase 2 buckling (`50`) | All buckle-enabled designs batched; `BUCKLE_BY_DESIGN`; provisional P_cr/P_y; Buckle N pill (8³⇄16³) |
| View tab | Buckling tab via mode accessors | Reuses Deformed/Stress raymarcher path; per-axis mode selection defaulting to critical axis |
| Viz | Relative-displacement colormap + animation | Turbo ramp, p90 cap, ambient floor, full-cycle 2.5 s pulse on by default, 0–30 % exaggeration |
| Viz | Fit envelope, not strain stretch | `uWarpExpand` isotropic margin so the swinging mode doesn't clip; Deformed tab untouched |
| Localization | m̄ metric + corner chip | Gradient Rayleigh quotient (asin-corrected, solid-masked); Global/Mixed/Local stoplight; exact on sine fields |

---

## Architecture decisions

### CPU oracle before GPU

The Phase 4 handoff assumed LOBPCG on the GPU. We inverted that. The genuinely hard part of buckling is not throughput — it's correctness: the geometric-stiffness eigenproblem, the nullspace of the elastic operator (constant + Nyquist modes), and the B-orthonormalized Rayleigh–Ritz that keeps the reduced problem SPD. Getting that wrong on the GPU would be near-impossible to debug. So `16c` was written as a matrix-free reference, cross-validated against a dense generalized eigensolve at N=4 to machine precision, and only then considered for production. Once the worker pool made it fast enough to ship (18 s at N=8), the GPU solver became an optimization rather than a blocker, and was deferred. `16d` will validate against `16c` exactly as `16b` validated against `16a` in Phase 4.

### Worker pool, not a single background thread

The three normal-axis solves are independent, so the natural unit of parallelism is one axis per worker. A persistent pool (`min(hardwareConcurrency − 1, 8)`) keeps a core free for the UI and saturates on multi-design batches. Each worker `importScripts` the closure `[18, 14, 13, 16c]`; the pool routes tasks by id and aggregates. This is what turns "CPU reference" into "production CPU path."

### Visualization reuses the stress pipeline

Rather than a parallel mode-shape renderer, a buckling mode field carries φ in the `u_prime` slot and |φ| in the `sigma_vm` slot. The raymarcher's stress view mode already warps by `u_prime` and contours by `sigma_vm` in one pass, so the buckling tab is "Stress tab, fed a different field, with a different palette." This kept the new shader surface tiny: one colormap function, one flag, one lighting tweak. Mode accessors (`buckleDataFor` / `hasActiveFields` / `activeFieldsFor` / `getBuckleAxis` / `activeAxisFor`) let the Deformed-tab machinery serve the Buckling tab unchanged by routing the active fieldset through the view mode.

### Fit, not strain

An early misstep was trying to make the buckling cube "expand" like the Deformed tab. The Deformed expansion comes from the macroscopic strain `eps_bar`; a buckling eigenmode has none, and the eigenvector's arbitrary scale makes reusing that path produce an uncontrolled box size. The resolution: `eps_bar = [0,0,0]` (true to the mode), and a separate isotropic fit margin (`uWarpExpand`) sized to the exaggeration so the swinging mode never clips the faces. The box is a fixed fitted frame; the mode oscillates inside it. The Deformed tab is byte-for-byte unchanged (the margin term is zero there).

---

## Solver — `16c-buckling-cpu-ref.js`

Cell-periodic q = 0 generalized eigenproblem `(−K_g)φ = θ K φ`, λ_cr = 1/θ_max, p_cr = λ_cr·|σ̄|, per normal axis.

- **Operators** `applyKcpu`, `applyKgcpu`, `specDeriv` — matrix-free; `runBucklingOperatorSelfTest` gates them at ~1e-15.
- **Prestress** `extractPrestressCPU` — displacement-form elastic cell solve under unit macro strain via `applyKcpu` + PCG, returns σ₀ and σ̄.
- **Eigensolver** `bk_subspaceGen` — block subspace iteration with rank-revealing B-orthonormalized Rayleigh–Ritz dropping K's constant + Nyquist nullspace; zero-mean projection throughout. Driver `bucklingFromSolid`; recipe wrapper `homogenizeBucklingCPU`.
- **Preconditioner** `bk_makePrecondScalar` = 1/(μ₀·|κ|²), μ₀ = `C_s[21]`, DC + Nyquist zeroed; `bk_pcgSolveK`. Solution-preserving; 899 → 248 prestress CG iters at N=8.
- **Localization** `bk_modeLocalization` — see below.

**FFT / index conventions** (mirror for any related work): interleaved complex cbuf; wavenumber `k = (a ≤ N/2 ? a : a − N)`; Nyquist (`a == N/2`) zeroed; isotropic-C layout `C[0] = λ+2μ`, `C[1] = λ = C12`, `C[21] = μ = C44`.

**Validation.** Operator gates ~1e-15. Dense N=4 cross-check: matrix-free generalized eigensolve == dense reference, rel 2.7e-15 (machine-exact). The preconditioner was re-validated against the plain-CG path to confirm it changes only iteration count.

---

## Execution — `16e-buckling-cpu-worker.js`

`computeBucklingCPU(recipe, N, opts, onProgress)` fans the three axes across the pool and aggregates `{ lambda_cr, pcr, critAxis, rho, perAxis:[{axis,lambda,sBar,cgIters,mWave}], modes:{xx|yy|zz:{u_prime,sigma_vm,N,eps_bar}} }`. In-browser defaults `BUCKLE_CPU_DEFAULTS = {block 4, eigIters 30, eigTol 1e-3, cgTol 3e-3, cgMaxiter 250}` trade precision for speed. Console: `F13LD_buckleBench`, `F13LD_bucklePoolInfo`. The mode field sets `eps_bar:[0,0,0]` (pure perturbation) and computes `sigma_vm = |φ|` on aggregation for the colormap.

**Benchmark** (8-core desktop, Schwarz P): N=8 three-axis 17.6 s pooled vs 61.5 s serial; λ_cr ≈ 3.19e-4, p_cr ≈ 43.9 MPa, ρ = 0.50.

---

## Run-All integration — `50-controls.js`

Two phases: **Phase 1 Elastic** (GPU full-Voigt, gated on the Elastic toggle) and **Phase 2 Buckling** (CPU worker pool, gated on the Buckle toggle; every buckle-enabled design batched through the pool at `BUCKLE_STATE.N`). Results land in `BUCKLE_BY_DESIGN` — a transient map kept off the design objects so an elastic re-run doesn't wipe modes and so the heavy mode arrays aren't persisted with saved definitions. Each result is decorated with `pcr_py = pcr / 880`, `failure_mode` (buckling- vs yield-limited), and `provisional = true`. The Buckle pill toggles N between 8³ and 16³. Progress is unit-based (1 unit per elastic design, 3 per buckled design).

---

## Visualization — `40-design-grid.js`, `21-raymarcher.js`, `30-view-tabs.js`, `lab.css`

- **Mode accessors** route the active fieldset/axis through the view mode; buckle defaults to the critical axis until the user picks one.
- **Colormap** (`buckleMagCap` p90 cap → `uploadFields`; turbo `uBuckleMap` palette; ambient floor `0.4 + 0.6·diff`). Stress tab keeps cividis.
- **Animation** full-cycle `A·sin(2πt/2.5s)` in the render loop, on by default (`setPulse`).
- **Exaggeration** 0–30 % cell, default 10 % (`setBuckleAmp`, normalized by the field's own max so it's scale-independent); fit envelope `uWarpExpand` (`setWarpExpand`).
- **Stat tiles** λ_cr, p_cr, P_cr/P_y* (provisional), E11; viewport readout `mode <axis> · λ_cr=…`; P_cr/P_y now also populates the non-buckle tabs from `BUCKLE_BY_DESIGN`.
- **Localization chip** top-left, stoplight-styled (`.vp-buckle-chip`).

---

## Localization metric — `bk_modeLocalization` (`16c`)

```
m̄ = (N / 2π) · asin( min(1, √( Σ_solid |∇φ|² / Σ_solid |φ|² )) )   [waves per cell]
```

Gradient Rayleigh quotient = √(energy-weighted mean-square wavenumber), computed in real space so the sum can be masked to material voxels (the soft void would otherwise skew an FFT). The `asin` undoes the centered-difference high-frequency compression — without it the raw value saturates near N/4 and the Local band can't fire. Bands: Global < 1.5 ≤ Mixed < 3.0 ≤ Local. Verified exact on pure sine fields (m = 1,2,3,4 → m̄ = 1.0,2.0,3.0,4.0) and banding on synthetic per-axis values. Resolution-limited to ~N/4 waves/cell — meaningful at N=16, capped near Mixed at N=8.

---

## File inventory at end of Phase 5

### New files
- `16c-buckling-cpu-ref.js` — buckling oracle (operators, prestress, subspace eigensolver, Fourier preconditioner, localization, self-tests)
- `16e-buckling-cpu-worker.js` — Web Worker pool + aggregation + console helpers
- `docs/BUCKLING.md` — standing buckling reference (formulation, solver, viz, localization, limits)

### Modified files
- `50-controls.js` — Run-All Phase 2, `BUCKLE_BY_DESIGN`, provisional P_cr/P_y, Buckle N pill
- `30-view-tabs.js` — buckle view-mode + exaggeration state, `getBuckleExag`/`setBuckleExag`
- `40-design-grid.js` — Buckling tab render, mode accessors, colormap upload, exaggeration control, localization chip, stat/readout branches
- `21-raymarcher.js` — turbo palette + `uBuckleMap`, full-cycle pulse, `uWarpExpand` fit envelope, `setPulse`/`setBuckleAmp`/`setWarpExpand`/`setBuckleMap`; pause guard allows buckle
- `lab.css` — `.vp-buckle-chip` stoplight styling

---

## Validation status at end of Phase 5

| Component | Verified | Notes |
|---|---|---|
| 16c operators | ✅ ~1e-15 | `runBucklingOperatorSelfTest` |
| 16c eigensolve vs dense (N=4) | ✅ rel 2.7e-15 | Machine-exact generalized-eigen cross-check |
| 16c Fourier preconditioner | ✅ | Solution-preserving; 899 → 248 prestress CG iters at N=8 |
| 16e worker pool | ✅ | Axis fan-out + aggregation correct; saturates on multi-design batches |
| N=8 production benchmark | ✅ | 17.6 s pooled (Schwarz P); λ_cr/p_cr/ρ consistent with reference |
| Localization metric | ✅ | Exact on sine fields m=1..4; banding correct |
| Buckling tab render | ✅ visual | Colormap + animation + chip verified on pi-tpms and shell gyroid (live) |

---

## Known limits at end of Phase 5

- **No GPU solver.** `16d` (LOBPCG) is scoped, not built. N=16 is workable on the pool but a GPU path would cut it substantially.
- **Linear eigenvalue only.** No post-buckling, imperfection sensitivity, or large-deflection path; mode amplitude and any derived stress are qualitative.
- **q = 0 only.** Long-wavelength super-cell buckling not captured (needs a Bloch sweep).
- **Provisional P_cr/P_y.** Fixed 880 MPa Ti-6Al-4V yield until the nonlinear phase computes a per-design yield.
- **Localization resolution scales with N.** Local needs N=16; N=8 caps near Mixed.
- **Served origin required.** No `file://`.

---

## Alpha-cleanup carried into the next session (not Phase 5 work)

These predate Phase 5 and were deliberately left for a dedicated cleanup pass rather than threaded through feature work:

- Dead test files/includes still wired: `70-selftest.js`, `71-rasterize-test.js`, `17-elastic-test.js` and their entry functions.
- The orphaned `fluid` physics toggle with no `PHYS_STATE` key.
- The **stale `99-init.js` boot banner** — still prints "v0.4.0 · Phase 3 · push 2 of 3," now two phases out of date.
- The mock `recomputeEstimate` formula.
- Inline styles on the newer controls (buckle exaggeration slider et al.) pending promotion to `lab.css`.

---

## Handoff state

- Repo: `https://github.com/mshomper/f13ld.lab`
- Live: `https://mshomper.github.io/f13ld.lab`
- Buckling runs through `computeBucklingCPU` in the worker pool; results in `BUCKLE_BY_DESIGN`. The tab renders the animated mode with the turbo relative-displacement colormap and a local/global chip. Served-origin requirement applies.
- All five view tabs operational. P_cr/P_y surfaces on every tab once buckling has run.

## What Phase 6 inherits

- A machine-exact buckling oracle (`16c`) to validate a GPU LOBPCG solver (`16d`) against, exactly as `16a` anchored `16b`.
- A worker-pool pattern for any future CPU-side parallel solve (one axis/load-case per worker, persistent pool, id-routed aggregation).
- A visualization pattern for arbitrary-amplitude fields: warp + relative-magnitude colormap + full-cycle animation, fed through the stress path with a palette flag.
- The provisional-yield seam (`SIGMA_Y_TI64_MPA`, `provisional` flag, `failure_mode`) ready to swap for a per-design computed yield the moment the nonlinear phase produces one.

## What Phase 6 should NOT inherit

- The alpha-cleanup list above. The stale boot banner especially should go before more features land on top of it — it now misreports the build by two phases. The dead test includes are pure deletion. These are sub-day items and the next session opens with them.

---

*Generated at the end of the Phase 5 buckling sprint as the canonical Phase 5 record.*
