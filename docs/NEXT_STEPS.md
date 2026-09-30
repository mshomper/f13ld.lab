# F13LD.lab — Next Steps (session handoff)

**As of:** v0.8.0 (Sprint B1 — voxel-FE buckling) · 2026-09-30
**Owner direction:** Matt Shomper directs implementation; **analyze and present proposed changes for approval before writing or modifying any code.** Don't over-deliberate.

This file replaces the v0.7.1 handoff. The old plan (warm-start the inner solve, real FFT, build LOBPCG, Bloch–Floquet) is obsolete: LOBPCG already shipped, and the buckling method itself was found to be invalid (below).

---

## 0. State

- **v0.7.2 (Sprint A)** — axis-convention fix, Voce material, yield-detection fixes, free-sided loading, reliability, hyperuniform wrap, 45-entry material library.
- **v0.8.0 (Sprint B1)** — buckling by matrix-free voxel FE (`16h-buckling-fe.js`, H8I, void removed, multigrid, LOBPCG) on the 16e worker pool; spectral buckling kept only as `opts.method = 'spectral'`. Cards show yield- vs buckling-limited. Self-test: `runFEBucklingSelfTest(32)`.

## 1. Next — Sprint B2/B3

- **B2 — idle cores.** One axis per worker leaves most of an 8-core pool idle for a single design. Split the element loop of an axis across 2+ workers (ordinary messages were 96–99 % efficient in the speed study; SharedArrayBuffer is not available on GitHub Pages).
- **B2 — memory.** A dense N=64 design peaks near 0.5 GB per worker (multigrid level-1 element matrices ≈150 MB, LOBPCG vectors); 3 designs × 3 axes on 7 workers can approach 3–4 GB. Cap concurrent N=64 FE tasks by `navigator.deviceMemory`, or store coarse element matrices in f32.
- **B2 — grid choice.** Replace the spectral-era under-resolution guard and the PRONE/OK predictor pill with an FE-appropriate rule (H8I resolves 1-voxel walls; flag when N=32 and N=64 disagree by more than 10 %).
- **B2 — multigrid on stochastic geometry.** Multigrid is strong on TPMS (27–45 prestress PCG iterations for 3 solves at N=32) but weak on grain designs: spinodoid 1,184 and hyperuniform 1,865 iterations for 6 solves at N=32, and 140–190 LOBPCG iterations on hyperuniform. Likely causes: Galerkin coarse elements over thin, irregular struts and a fixed Chebyshev ratio. Try a stronger smoother / more levels' smoothing, or aggregation-based coarsening; and share the prestress across the 3 axis workers (today each worker repeats it).
- **B3 — WebGPU voxel FE.** Gather → constant 24×24 multiply → scatter per element, per-node gather (no atomics), multigrid on GPU; CPU path is the reference.

## 2. Queued

- **Sprint C — GPU-resident solvers.** Elastic (16b) and nonlinear (16g) CG are round-trip-bound: 2 blocking `mapAsync` per CG iteration. Keep CG scalars on the GPU, check convergence every 8–16 iterations; use 16b's batched FFT + cached bind groups inside 16g's `_gammaApply` (it runs 12 unbatched FFTs and rebuilds ~26 bind groups per apply); reduce σ̄ on the GPU; consider mixed stress/strain BC inside Newton instead of the outer macro loop.
- **Grain RVE window.** F13LD.mesh evaluates spinodoid / GRF / noise as one continuous field across the part (no tiling), so a single tiled cell is not what is printed. Add a "window cells" (2×2×2) option for those families — affordable with the FE path. Hyperuniform is tiled by Mesh (kernels copied per cell) and is now wrapped to match.
- **Partial-volume voxels** (laminate mixing, Kabel/Merkert/Schneider 2015) for elastic accuracy on thin walls.
- **Thermal κ** (scalar subset of the elastic FFT-CG; stub today). **Stokes** wire-in (needs a preconditioner; default maxiter 100 returns K 2.7× low).
- **Hygiene:** delete `16b2-elastic-batched-lc.js` (unloaded; would overwrite 16b if loaded), `patch_16b_*.py` (applied), `README.txt` (v0.5.0 copy), `mesh-ref.js` from the web root; move shared kernels out of the dead `16-elastic-solver.js`; seed the random matrices in the 16c E4 self-test (flaky); `validate-willot.js` needs a missing `_willot.js` and power-of-two grids.

## 3. Validation harness

- `runAxisConventionGPUTest()` — z-laminate; Ez must be the soft axis and match the CPU oracle axis by axis.
- `runFEBucklingSelfTest(32)` — zero-energy count (must be 3) + periodic plate benchmark vs the exact continuum answer (within ~1 % at N=32).
- `F13LD_buckleBench(recipe, N)` — any recipe through the real worker pool (voxel FE by default).
- Node harnesses: load the numbered solver files into one scope with small `window/document/performance` shims (see `proto/fe-buckling/h.js`).

## 4. Conventions (do not violate)

- **Line endings:** `index.html`, `50-controls.js`, `40-design-grid.js`, `21-raymarcher.js`, `16b-elastic-solver-full.js`, `README.md` are CRLF (check each with `file`). Patch CRLF files with count-guarded Python (`newline=""`, assert match count). Never normalize endings.
- **Solver frame = physical frame** since v0.7.2 (x = slowest index in `buildVoxels`). Viewer textures are x-fastest; convert with `solverToTexOrder` in 21-raymarcher. Never reintroduce a solver-side axis swap.
- `node --check` every JS file before delivering. Powers of two only for spectral FFT grids.
- **Never use the words "genuine" / "genuinely."**
- Present proposed diffs for approval before applying.

Repo: `github.com/mshomper/f13ld.lab` · contact: matt@notarobot-eng.com
