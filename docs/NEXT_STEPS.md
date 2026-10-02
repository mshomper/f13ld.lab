# F13LD.lab — Next Steps (session handoff)

**As of:** v0.12.1 · 2026-10-01 · STL import, parameter sweep, sweep builder, Sweep Atlas all on main
**Full history of the last session:** [`SESSION_RECAP_2026-10-01.md`](SESSION_RECAP_2026-10-01.md) (previous: [`SESSION_RECAP_2026-09-30.md`](SESSION_RECAP_2026-09-30.md))
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
| **v0.12.0** | Atlas: CAD tumble + linked rotation, 3-D stiffness surface, smooth slider. Sweep keeps no-load-axis runs (B6) with a warning, flags negative shear, collapsible notes. Void 1e-6 rerun analysed (`SWEEP.md` §7) |
| **v0.12.1** | Sweep panel in three sections (define runs: builder / CSV tabs · run settings · runs); ↺ New sweep; ✕ remove CSV; renamable study title; second grid **64 ↔ 128 pair**. Matched-feature A4m (`SWEEP.md` §8) |

---

## 1. CURRENT FOCUS — PI-TPMS paper, production pass (v0.12.1)

Matt's PI-TPMS Paper 1, Section 5: the run matrix is now **42 rows** (A4m added; E1 moved to A4m's wall ratio). Everything needed to produce the paper numbers is on main. See [`SWEEP.md`](SWEEP.md) §4–§8.

**Next action (Matt, on his GPU):** load the 42-row matrix → High (1e-5) · void 1e-6 · second grid **64 ↔ 128 pair** · order 2 → Run 42 (~15–20 min) → Export CSV. This replaces the planned B6 / B7 reruns and also redoes B5 and G3. Then analyse (Figure 6, verification table, Section 5 text).

**Decisions on record (Matt, 2026-10-01):**
- Keep the lab's island trim (faithful to how cells are built physically); report trim differences as notes.
- Precision is a toggle (1e-4 / 1e-5); void stiffness 1e-6 for sweeps.
- Extrapolation is an option; the user-selected grid is the default. For the paper, one 64 + 128 basis.
- The builder is the main way people use the sweep: every family, two parameters, cost shown before committing; no run cap beyond a hardware note.
- Atlas in-lab first (self-contained HTML export later — the lab is the one non-MIT tool); F13LD brand colors, dark theme; no Vixiv reference values in the Atlas; charts in the lab's own code with a Plotly-like look; geometry and stiffness views linked by default with a toggle; CAD tumble.
- Matched-feature comparison uses the **measured** PI tube width (A4m, wall ratio 0.1364); sheet (C4) and skeletal (D7) stay as given; physical differences go in a comparison note.
- Thinnest-feature export column and "step by feature size" in the builder: **later**.

**Findings to carry into the paper text:**
- At void 1e-6 the lab reads ~10 % below Vixiv at the run grid and ~5–7 % below after extrapolation (A5 three-grid: 0.95). The earlier near-perfect matches were the void stiffness. Plausible reason for the residual gap: voxel FFT converges from below, displacement FE from above — unconfirmed.
- Matched feature (0.126 T): A4m is 1.77× D7 in-plane, 0.43× along z, ≈ equal on the directional mean, at 1.7× the solid; D7 is 2.4× stiffer along [111] than its axes — report directional mean or E max / E min, not axes only (`SWEEP.md` §8).
- Fischer–Koch G set: Ez × 8.5 from wall ratio 0.17 → 0.19 (contacts forming; Euler characteristic 25 → 33 → 41 → 57 loops per cell). G1 sits at contact onset and is the most grid-sensitive run.

## 1-foam. Queued: foam stiffness calibration (from the 2026-10-02 foam/mesh session)

F13LD.foam v0.3.0 and F13LD.mesh v0.9.1 (foam family) are live. Next for foam: add a foam kernel to the lab, run a ~50-run calibration sweep on Matt's GPU, and fit the in-tool stiffness estimate to it. Plan, numbers and open questions: [`FOAM_CALIBRATION_HANDOFF.md`](FOAM_CALIBRATION_HANDOFF.md). Nothing has been built yet; the plan needs Matt's approval first.

## 1a. Next dev cycle — pick up (in suggested order)

1. **Production pass done and checked (`SWEEP.md` §9).** Next: build Figure 6, the verification table and the Section 5 text from it with Matt — Figure 6 data, verification table vs Vixiv, fitted density exponents, directional-mean columns. Check B7's shear and B6's no-load axes at 1e-5.
2. **Thinnest feature, properly** (Matt: "later" — this is the next lab feature). (a) A `thinnest_feature_T` export column. (b) Fix the voxel estimator's low bias on flattened tubes (the medial ribbon's edge balls — ~3–4 % low on PI; see `SWEEP.md` §8), e.g. keep only ridge points whose ball is a local maximum along the ridge, or measure minor width by chords at ridge points. (c) Builder: *step by thinnest feature*, like step by solid fraction.
3. **Partial-volume voxels** (laminate mixing, Kabel/Merkert/Schneider 2015) — the lab's N = 64 numbers are 11–14 % low on thin PI/skeletal walls; this would shrink the grid gap and the need for extrapolation.
4. **Elastic solver speed (16b GPU-resident CG):** still 2 blocking `mapAsync` per CG iteration. Port the v0.8.1 nonlinear approach. Directly speeds up sweeps.
5. **Main-lab axis triad check:** the geometry tiles' triad is drawn from the rotation matrix columns while the ray-marcher shows the transpose — verify, fix if wrong (the Atlas computes its own and is consistent).
6. **Atlas, later:** self-contained HTML export (results + views only, licence-safe); per-axis tick formatting polish on the 3-D surface; optional Plotly-style hover crosshair on the line chart.
7. **Sprint B2 — buckling speed** (still queued, §2).

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
  - `index.html`, `50-controls.js`, `40-design-grid.js`, `21-raymarcher.js`, `22-stiffness-viz.js` and `README.md` are CRLF; `14a-connectivity.js` and `16b-elastic-solver-full.js` are mixed (mostly CRLF, some LF blocks — match the lines around an edit). Check each with `file`.
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
