# F13LD.lab — Next Steps (session handoff)

**As of:** v0.7.2 (branch `sprint-a-v0.7.2`) · 2026-09-30
**Owner direction:** Matt Shomper directs implementation; **analyze and present proposed changes for approval before writing or modifying any code.** Don't over-deliberate.

This file replaces the v0.7.1 handoff. The old plan (warm-start the inner solve, real FFT, build LOBPCG, Bloch–Floquet) is obsolete: LOBPCG already shipped, and the buckling method itself was found to be invalid (below).

---

## 0. State

- **Sprint A shipped** (see README *What's new in v0.7.2*): axis-convention fix, Voce material live, yield-detection fixes, free-sided buckling prestress, converged eigen-solve, density display, run reliability, hyperuniform periodic wrap, 45-entry AM material library (`15c-materials.js`, `docs/MATERIALS.md`).
- **Buckling is invalid as computed.** The spectral (Willot) operator has 510 zero-energy patterns on an all-solid 8³ cell (3 are legitimate); the eigen-solve finds them, and only the soft void resists them, so the critical load scales with the void stiffness (Schwarz P N=16: 4.4 / 43.7 / 422 / 3270 MPa for void 1e-5…1e-2). Elastic homogenization is unaffected (validated).
- **Validated replacement prototype:** `proto/fe-buckling/` — matrix-free voxel FE, incompatible-modes hex (H8I), void removed, multigrid. Plate benchmark within 1.2 % of the exact answer down to 1-voxel walls. Plan and numbers: `docs/SPRINT_B_PROPOSAL.md`.

## 1. Next — Sprint B (awaiting approval)

B1 CPU voxel-FE buckling (`16h`) in the 16e worker pool → B2 split axes across idle cores → B3 WebGPU port. Details, validation targets and UI changes: `docs/SPRINT_B_PROPOSAL.md` §4.

## 2. Queued

- **Sprint C — GPU-resident solvers.** Elastic (16b) and nonlinear (16g) CG are round-trip-bound: 2 blocking `mapAsync` per CG iteration. Keep CG scalars on the GPU, check convergence every 8–16 iterations; use 16b's batched FFT + cached bind groups inside 16g's `_gammaApply` (it runs 12 unbatched FFTs and rebuilds ~26 bind groups per apply); reduce σ̄ on the GPU; consider mixed stress/strain BC inside Newton instead of the outer macro loop.
- **Grain RVE window.** F13LD.mesh evaluates spinodoid / GRF / noise as one continuous field across the part (no tiling), so a single tiled cell is not what is printed. Add a "window cells" (2×2×2) option for those families — affordable with the FE path. Hyperuniform is tiled by Mesh (kernels copied per cell) and is now wrapped to match.
- **Partial-volume voxels** (laminate mixing, Kabel/Merkert/Schneider 2015) for elastic accuracy on thin walls.
- **Thermal κ** (scalar subset of the elastic FFT-CG; stub today). **Stokes** wire-in (needs a preconditioner; default maxiter 100 returns K 2.7× low).
- **Hygiene:** delete `16b2-elastic-batched-lc.js` (unloaded; would overwrite 16b if loaded), `patch_16b_*.py` (applied), `README.txt` (v0.5.0 copy), `mesh-ref.js` from the web root; move shared kernels out of the dead `16-elastic-solver.js`; seed the random matrices in the 16c E4 self-test (flaky); `validate-willot.js` needs a missing `_willot.js` and power-of-two grids.

## 3. Validation harness

- `runAxisConventionGPUTest()` — z-laminate; Ez must be the soft axis and match the CPU oracle axis by axis.
- `F13LD_buckleBench()` — Schwarz P through the CPU worker path (spectral; to be replaced in B1).
- Node harnesses: load the numbered solver files into one scope with small `window/document/performance` shims (see `proto/fe-buckling/h.js`).

## 4. Conventions (do not violate)

- **Line endings:** `index.html`, `50-controls.js`, `40-design-grid.js`, `21-raymarcher.js`, `16b-elastic-solver-full.js`, `README.md` are CRLF (check each with `file`). Patch CRLF files with count-guarded Python (`newline=""`, assert match count). Never normalize endings.
- **Solver frame = physical frame** since v0.7.2 (x = slowest index in `buildVoxels`). Viewer textures are x-fastest; convert with `solverToTexOrder` in 21-raymarcher. Never reintroduce a solver-side axis swap.
- `node --check` every JS file before delivering. Powers of two only for spectral FFT grids.
- **Never use the words "genuine" / "genuinely."**
- Present proposed diffs for approval before applying.

Repo: `github.com/mshomper/f13ld.lab` · contact: matt@notarobot-eng.com
