# F13LD.lab — Sprint B Proposal: correct and fast buckling

**Date:** 2026-09-30 · **Base:** branch `sprint-a-v0.7.2` (Sprint A + hyperuniform wrap + material library, all applied)
**Status:** proposal for approval — no Sprint B code is in the app. The validated prototype is committed under `proto/fe-buckling/` for reference.
**Figures:** `buckling_wall_time.png`, `plate_benchmark.png`, `buckling_vs_yield.png`, `mode_slices_N64.png`

---

## 1. The finding that reshapes this sprint

While measuring speedups at N=32/64, the buckling answer turned out to be a **numerical artifact, not a structural result**.

- **The critical load follows the void stiffness.** Schwarz P, N=16, same code, only the void ratio changed:

  | Void stiffness / solid | 1e-5 | 1e-4 (shipped) | 1e-3 | 1e-2 |
  |---|---|---|---|---|
  | Buckling strength (MPa) | 4.4 | 43.7 | 422 | 3270 |

  A physical buckling load cannot depend on how stiff empty space is.
- **The mode lives in the void.** 99.97 % of the mode's strain energy is in void voxels; the solid voxels do grid-scale rigid rotations (rotation ≈ 3000× strain) that the prestress rewards and nothing in the solid resists.
- **Root cause, counted directly.** On an all-solid 8³ cell (1,536 DOFs), only 3 zero-energy patterns are legitimate (rigid translations):

  | Stiffness operator | Zero-energy patterns |
  |---|---|
  | Current spectral (Willot) operator | **510** |
  | One-point-integrated brick | 69 |
  | Full-integration brick (H8) | 3 |
  | Incompatible-modes brick (H8I) | 3 |

  The eigen-solve finds those spurious patterns first; the soft void is the only thing holding them up. A second lesson from the prototype: **even a correct element gives void modes if the void is kept as soft material — the void has to be removed, not softened.**
- **What this means for past results.** Every buckling number the tool has produced — including the "buckling-limited" hyperuniform (11.7 MPa at ρ 0.50) that motivated the Bloch–Floquet idea — came from this artifact. The spectral operator is fine for **elastic homogenization** (validated against Backus laminates to 0.0 %), because a macro-strain average doesn't excite those patterns; it is only the eigen-problem that falls into them.

## 2. The fix — matrix-free voxel finite elements (validated prototype)

- Each **solid** voxel is one 8-node brick; void voxels have **no elements and no DOFs**. There is no void parameter left.
- **Incompatible-modes brick (H8I, same family as Abaqus C3D8I).** Because every element is an identical cube of one material, its 24×24 stiffness is **one constant matrix** — cheap, and it bends correctly with only 1–2 voxels through a wall.
- Prestress from the same FE model under **free-sided uniaxial stress** (your Sprint A decision carries over).
- **Multigrid-preconditioned** solves — iteration counts stay flat as N grows (Jacobi alone: 917 eigen iterations on a sheet at N=64; multigrid: 54).

**Plate benchmark** (`plate_benchmark.png`) — periodic plates in compression, FE ÷ exact continuum answer:

| Wall (voxels) | 1 | 2 | 3 | 4 | 6 | 8 |
|---|---|---|---|---|---|---|
| H8 (standard brick), N=64 | **1.69** | **1.17** | 1.08 | 1.05 | 1.02 | 1.01 |
| **H8I (proposed), N=64** | **1.002** | **1.003** | 1.003 | 1.003 | 1.003 | 1.003 |
| Current spectral code (void 1e-2, t=4, N=32) | | | | 1.38 | | |

The standard brick over-predicts thin walls by up to 69 % — the unsafe direction — which is why H8I is the recommendation.

**Designs** (`buckling_vs_yield.png`, `mode_slices_N64.png`; Ti-6Al-4V, z-compression):

| Design | Buckling strength, N = 32 / 48 / 64 / 96 (MPa) | First yield (MPa) | Governs |
|---|---|---|---|
| Schwarz P solid, ρ 0.50 | 5952 / – / 5377 / 4875 | ~238 | Yield, by ~23× |
| Schwarz P sheet, ρ ≈ 0.145 | 363 / 482 / 507 / 486 | ~38 | Yield, by ~13× |
| Gyroid sheet, ρ ≈ 0.13 | 403 / 383 / 371 / 382 | ~43 | Yield, by ~9× |

- Sheets converge to within ±4 % from N=48 up; the modes are wall-panel buckles, as expected.
- The FE static solve's first-yield estimate (238 MPa, 95th-percentile solid stress reaching yield) is close to the crush solver's 0.2 %-offset yield (233 MPa) — different definitions, but independent evidence the elastic/crush path is sound.
- For titanium lattices at these densities, **buckling is not the governing failure** — it becomes relevant at lower density, softer materials (the new library's polymers and aluminium), or slender strut designs.

## 3. Speed (`buckling_wall_time.png`)

One design, all three axes, 8-core desktop (measured single-thread in a slow sandbox, axes in parallel — your desktop will be faster):

| | N = 32 | N = 64 |
|---|---|---|
| Spectral · shipped today (Sprint A) | 8.1 min | 66 min, still unconverged |
| Spectral · every speedup applied | 33 s | 4.3 min |
| **Voxel FE · CPU · dense lattice** | **~15 s** | **~2.2 min** |
| **Voxel FE · CPU · thin sheet** | faster | **~45 s** |
| Voxel FE · GPU (estimate) | — | ~25 s |

- The FE apply is 2.2× faster than even the optimized spectral apply on a dense lattice and ~7.5× faster on a sheet, because **void voxels cost nothing** — sparse designs, your main case, get the biggest win.
- The spectral speedups measured earlier (~11× per iteration) are **not worth porting**: they make a wrong answer faster.
- GPU fit is excellent: one gather → constant 24×24 multiply → scatter per element, no atomics needed (per-node gather), f32-friendly.

## 4. Proposed plan

**B1 — CPU voxel-FE buckling (replaces the spectral buckling path)**
1. New `16h-buckling-fe.js`: H8I element, solid-only mesh, multigrid-preconditioned prestress (3 or 6 unit-strain solves → free-sided uniaxial superposition), LOBPCG with the Sprint A convergence rules, same result shape (Buckling Strength, Critical Strain, mode, per-axis).
2. Run it in the existing 16e worker pool (one axis per worker; axes in parallel).
3. **Island pruning becomes mandatory** for buckling (a floating piece is a free rigid body); a disconnected design reports "multi-component" rather than failing silently.
4. **Grid choice instead of skipping:** replace the "under-resolved → skip" guard with an automatic grid pick from wall thickness (the predictor already exists), and flag when N=32 and N=64 disagree by more than 10 %.
5. **UI:** show buckling strength beside first yield with a *Yield-limited* / *Buckling-limited* badge; above 5× yield show "> 5× yield" rather than a large number that implies precision.
6. **Validation script** in the repo: plate benchmark, patch test, zero-energy count, Schwarz P regression.
7. Retire the spectral buckling code (16c eigen path, 16d GPU port) once B1 is accepted; keep the docs as the record.

**B2 — Use the idle cores.** Split each axis across 2+ workers when cores are free (measured 96–99 % efficiency with ordinary worker messages; no SharedArrayBuffer needed, which GitHub Pages can't enable). ~1.4× for one design.

**B3 — GPU voxel-FE buckling.** Port the element kernels and multigrid to WebGPU with the CPU path as the reference. Target: N=64 in well under a minute, N=128 feasible.

**Also queued (Sprint C, unchanged from the first analysis):** GPU-resident CG and batched FFT for the elastic and nonlinear solvers (they are round-trip-bound, not compute-bound).

**Spinodoid / GRF / noise.** F13LD.mesh evaluates these as one continuous field across the whole part (no tiling), so a single tiled cell is not what gets printed. The right analysis is a multi-cell window. The FE path makes this affordable because void is free; propose a "window cells" setting (2×2×2) for those families once B1 lands.

## 5. v0.7.2 and buckling in the meantime

The v0.7.2 files are ready, but their buckling numbers are artifact-driven. Recommended interim change (small, not yet applied): **Buckling toggle off by default, and an amber "experimental — known artifact, fix in progress" note on the Buckling tab and cards when a user turns it on.** The README already carries a *Known issue* section.
