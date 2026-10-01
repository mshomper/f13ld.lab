# F13LD.lab — Next Steps (session handoff)

**As of:** v0.10.1 · 2026-10-01 · parameter sweep merged (void option, two-grid extrapolation)
**Full history of the last session:** [`SESSION_RECAP_2026-09-30.md`](SESSION_RECAP_2026-09-30.md)
**Owner direction:** Matt Shomper directs implementation. **Analyze and present proposed changes for approval before writing or modifying any code.** Don't over-deliberate.

---

## 0. State

| Version | Contents |
|---|---|
| **v0.7.2** — Sprint A | Axis-convention fix, Voce material, yield-detection fixes, free-sided loading, reliability, hyperuniform wrap, 45-entry material library |
| **v0.8.0** — Sprint B1 | Buckling by matrix-free voxel FE (`16h-buckling-fe.js`: H8I, void removed, multigrid, LOBPCG) on the 16e worker pool. Spectral buckling kept only as `opts.method = 'spectral'`. Cards show yield- vs buckling-limited |
| (follow-ups) | Demo C → hyperuniform trabecular; buckling/yield ratio uses the crush axis; stress–strain plot redesign (collision-aware labels, off-scale buckling strip, MPa / normalized toggle) |
| **v0.8.1** | Nonlinear crush: mean-strain reset (root cause), inexact Newton, early stop, predictor, GPU-resident CG, batched real-pair FFT, cached bind groups |
| **v0.8.2** | PI / shell normalization kept on import (older recipes default OFF); normalized PI and shell rendering in the viewer; connectivity selector (all networks / largest / keep everything); per-network FE buckling |
| **v0.9.0 / v0.9.1** | STL unit-cell import: periodic signed-distance grid, `import` kernel, report card, wall offset, IndexedDB store, export with embedded grid. See `STL_IMPORT_SCOPE.md` §7–8 |
| **v0.10.0 / v0.10.1** | Parameter sweep: run-matrix CSV or one-parameter sweep of a loaded design → elastic stiffness per run, CSV export. Solver records final residual and takes a per-call tolerance. See `SWEEP.md` |
| **v0.11.0** | Sweep builder for every family, two parameters, review before creating (solves, time, solid-fraction map); Sweep Atlas (geometry, directional modulus, matrix, parameter map, charts, data check). See `SWEEP.md` §1.2, §3b |

---

## 1. CURRENT FOCUS — PI-TPMS paper sweep (v0.10.0 → v0.11.0)

Matt's PI-TPMS Paper 1, Section 5: a 41-run matrix (sets A–G: PI-gyroid scaling, junction type / anisotropy, sheet and skeletal gyroid baselines, Poisson check, grid convergence, Fischer–Koch resolution) run through the new Sweep panel. See [`SWEEP.md`](SWEEP.md).

- **Decisions (Matt, 2026-10-01):** keep the lab's island trim (faithful to how cells are built physically) and report trim differences as notes; precision is a toggle (1e-4 / 1e-5); check A6 at N = 128 before changing the solver.
- **v0.11 (Matt, 2026-10-01):** the builder is the main way people will use the sweep, so it must work for every family and show total solves and cost before committing; no run cap beyond a hardware note; Atlas in-lab first (HTML export later — the lab is the one non-MIT tool), F13LD brand colors, no Vixiv reference values in the Atlas; charts written in the lab's own code with a Plotly-like look.
- **Open question for Matt:** re-base the matched-feature comparison on measured PI tube widths (`SWEEP.md` §5)?
- **Accuracy vs Vixiv (A6):** N = 64 is 7–11 % low, N = 128 is 2–5 % low, first-order extrapolation lands within ~3 %. The gap is voxel resolution (stair-stepped tubes), not solver bias. Next decision for Matt: run the matrix at N = 128, extrapolate from N = 64 + 128 pairs, or add partial-volume voxels first (`SWEEP.md` §4).

## 1b. STL unit-cell import (done, v0.9.0–v0.9.1)

Matt redirected the 2026-09-30 evening session from buckling speed to STL import. Full scope, data path and test plan: [`STL_IMPORT_SCOPE.md`](STL_IMPORT_SCOPE.md). Work is on branch `stl-import`.

**Status (2026-09-30):** merged to main as v0.9.0 + v0.9.1. Matt click-tested the preview; his CAD sheet cell was falsely flagged "not periodic", fixed in v0.9.1 (trim-plane cell faces, wrapped overhang, local seam test — scope doc §7–8). Matt also ran a full GPU Run All on an imported cell on his machine: successful.

### 1.1 Decisions (Matt, 2026-09-30)

- **Cell size** defaults to the longest bounding-box side, editable.
- **Near-cubic is cubic.** CAD export settings leave cubic cells ~1 % off between sides. Sides within 2 % of each other are treated as a cube (longest side wins, mismatch shown in the report). Beyond 2 %, version 1 refuses with a clear message; unequal spacing in the solvers is later work.
- **Wall offset slider** ships in version 1.
- **Exports carry the geometry** (compressed grid embedded), so a shared file reloads anywhere.
- **Face match never blocks a run.** Poor matches warn and tag the card "not periodic."
- Matt can supply real CAD STLs for the final check; generated STLs (meshed from native recipes) cover the exact comparisons.

### 1.2 Phases

1. **Core** — STL parse, scanline fill with three-axis majority vote, periodic distance transform, `import` kernel, grid store (page cache + IndexedDB), grid attached to buckling worker jobs.
2. **Interface** — Import STL in Add design, settings, report card, wall offset slider, export with embedded grid.
3. **Validation** — the scope doc's §4 table, headless, then Matt's click-test on the branch preview.

### 1.3 Must stay true

- Native designs rasterize and solve exactly as in v0.8.2 (no change to `buildVoxels` or the solvers).
- **Sign convention:** solid is where the field is below the offset. The import field is the signed distance, **negative inside**, in field units (one cell = 2π), so the existing solid-mode `offset` is the wall offset.
- The grid never rides inside the design record (fingerprint, localStorage, worker messages stay small); the record carries the grid's hash only.

---

## 2. Queued

**Sprint B2 — make buckling faster** (was the planned focus; deferred by Matt for STL import)

Matt's goal: buckling must be **massively** faster at N=32 and N=64, since nothing useful runs at N=16. Start the session with a proposal (measurements, options, expected gains) for approval, then implement.

### B2.1 Where the time goes today (N=32, from the v0.8.0 study)

| Design | Prestress PCG iterations | LOBPCG iterations | Notes |
|---|---|---|---|
| Schwarz P / TPMS sheets | 27–45 (3 solves) | low | Multigrid works well |
| Spinodoid | **1,184** (6 solves) | moderate | Multigrid weak on thin, irregular struts |
| Hyperuniform | **1,865** (6 solves) | **140–190** | Worst case |

Also:
- Each axis worker repeats the same prestress.
- One axis per worker leaves most of an 8-core pool idle for a single design.

### B2.2 Work items, in suggested order

1. **Profile first.** Re-run `F13LD_buckleBench` on Schwarz P, spinodoid, hyperuniform and the two-network PI gyroid at N=32 and N=64. Split wall time into prestress, eigen-solve and mesh / multigrid setup, so each change below has a before/after.
2. **Multigrid on grain designs.** Candidates:
   - a stronger smoother (more Chebyshev sweeps, or an eigenvalue estimate per level instead of a fixed ratio);
   - better coarse operators over thin struts (aggregation-based coarsening, or keeping near-void coarse cells);
   - W-cycles on the worst levels.
   - Target: grain-design prestress within ~3× the TPMS iteration counts.
3. **Share the prestress across axes.** Compute the unit-strain solves once per design and pass the displacement fields to the axis workers, instead of each worker redoing them. Expect about a 3× cut in prestress time.
4. **Eigen-solve.**
   - Warm-start LOBPCG from the neighboring axis's mode or from the coarse-grid mode.
   - Use a multigrid-preconditioned shift-invert on the lowest modes.
   - Revisit block size (4) and the stopping rule on hyperuniform.
5. **Use idle cores.** Split each axis's element loop across 2+ workers with ordinary messages (96–99 % efficient in the speed study; SharedArrayBuffer is not available on GitHub Pages).
6. **Memory cap.**
   - A dense N=64 design peaks near 0.5 GB per worker (level-1 coarse element matrices ≈150 MB).
   - Cap concurrent N=64 tasks by `navigator.deviceMemory`, or store coarse element matrices in f32.
7. **Grid rule.** Replace the spectral-era PRONE/OK predictor pill with an FE rule: H8I resolves 1-voxel walls; flag when N=32 and N=64 disagree by more than 10 %.

### B2.3 Must stay true

- `runFEBucklingSelfTest(32)` passes: 3 zero-energy modes; plate within ~1 %.
- Results within 1 % of the current v0.8.2 values on the benchmark designs, or the difference explained.
- A fixed seed still gives identical results run to run.
- Per-network buckling (v0.8.2) is unchanged in meaning.

### B2.4 After B2

**B3 — WebGPU voxel FE.**
- Gather → constant 24×24 multiply → scatter per element, with a per-node gather (no atomics).
- Multigrid on the GPU.
- The CPU path stays as the reference.

**Speed**

- **Elastic solver (16b), GPU-resident CG.** It still does 2 blocking `mapAsync` per CG iteration. Port the v0.8.1 nonlinear approach: scalars stay on the GPU, convergence is checked every ≤16 iterations, and σ̄ is reduced on the GPU.
- **Real-GPU check of the v0.8.1 cutback / early-stop paths** (hyperuniform N=64 with `NL_TRACE`).

**Physics and fidelity**

- **Grain RVE window.** F13LD.mesh evaluates spinodoid / GRF / noise as one continuous field across the part. Add a 2×2×2 "window cells" option for those families.
- **Fundamental / double-period support (held back by Matt).** Custom equations that repeat every 2 periods need a larger window. This also affects F13LD.tpms's own homogenization (one-period window).
- **Partial-volume voxels** (laminate mixing, Kabel/Merkert/Schneider 2015) for elastic accuracy on thin walls.

**New solvers**

- **Thermal κ** — scalar subset of the elastic FFT-CG; a stub today.
- **Stokes** — wire it in; needs a preconditioner (the default maxiter 100 returns K 2.7× low).

**UI and roadmap**

- **Plot marker synced to the strain scrubber.**
- **Finite strain / damage / densification** (long term) for plateau and energy-absorption curves.
- **Roadmap phases 9–10:** PDF report export, F13LD.vault integration.

**Hygiene**

- Delete from the web root:
  - `16b2-elastic-batched-lc.js` (unloaded; would overwrite 16b if loaded)
  - `patch_16b_*.py` (already applied)
  - `README.txt` (v0.5.0 copy)
  - `mesh-ref.js`
- Move shared kernels out of the dead `16-elastic-solver.js`.
- Seed the random matrices in the 16c E4 self-test (flaky).
- `validate-willot.js` needs a missing `_willot.js` and power-of-two grids.
- Refresh the PHASE docs.

---

## 3. Validation harness

| Tool | Checks |
|---|---|
| `runAxisConventionGPUTest()` | z-laminate: Ez must be the soft axis and match the CPU oracle axis by axis |
| `runFEBucklingSelfTest(32)` | Zero-energy count (must be 3) plus periodic plate vs the exact continuum answer (within ~1 % at N=32) |
| `F13LD_buckleBench(recipe, N)` | Any recipe through the real worker pool (voxel FE by default) |
| `runNonlinearFastOpTest()` | Fast nonlinear operator vs the reference |
| `window.NL_TRACE` / `NL_FAST` / `NL_PREDICT` / `NL_EW` | Nonlinear logging and A/B switches |
| Node harnesses | Load the numbered solver files into one scope with small `window/document/performance` shims (see `proto/fe-buckling/h.js`) |
| Headless WebGPU | SwiftShader in the preinstalled Chromium, `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-features=Vulkan`, served over `http://localhost` |

---

## 4. Conventions (do not violate)

- **Line endings.**
  - `index.html`, `50-controls.js`, `40-design-grid.js`, `21-raymarcher.js`, `16b-elastic-solver-full.js` and `README.md` are CRLF; `14a-connectivity.js` is mixed. Check each with `file`.
  - Patch these with count-guarded Python (`newline=""`, assert the match count).
  - Never normalize endings.
- **Solver frame = physical frame** since v0.7.2 (x is the slowest index in `buildVoxels`).
  - Viewer textures are x-fastest; convert with `solverToTexOrder` in 21-raymarcher.
  - Never reintroduce a solver-side axis swap.
- `node --check` every JS file before delivering. Powers of two only for spectral FFT grids.
- Recipes without normalization flags default to normalization OFF.
- Click-test on the raw.githack branch preview before merging.
- **Never use the words "genuine" / "genuinely."**
- Present proposed diffs for approval before applying.

Repo: `github.com/mshomper/f13ld.lab` · contact: matt@notarobot-eng.com
