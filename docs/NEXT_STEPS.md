# F13LD.lab — Next Steps (session handoff)

**As of:** v0.17.2 · 2026-10-03 · three-axis crush, design-scaled void, rebuilt crush side-stress loop, Plotly stress–strain plot; foam laws provisional (27 calibration runs to re-run at the 1000-iteration cap)
**Full history of the last session:** [`SESSION_RECAP_2026-10-03.md`](SESSION_RECAP_2026-10-03.md) (previous: [`SESSION_RECAP_2026-10-01.md`](SESSION_RECAP_2026-10-01.md), [`SESSION_RECAP_2026-09-30.md`](SESSION_RECAP_2026-09-30.md))
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
| **v0.13.0** | Field-pair PI-TPMS (F13LD.tpms v1.1.0 / mesh v0.7.1): field B any preset or terms at a whole-number frequency multiple; sweep steps field B frequency |
| **v0.14.0** | F13LD.foam family: verbatim mesh foam kernel (`13d-foam-kernel.js`), import + `#r=` inline links, periodic-only, foam sweep parameters (thickness exact by solid fraction, seeds regenerated for count / regularity / Lloyd / random seed), `family = foam` CSV rows, `validate-foam.js`. Calibration study ready: `FOAM_CALIBRATION.md` |
| **v0.15.0** | Fast elastic path for sweeps (`16i-elastic-fast.js`): GPU-resident CG, packed operator, cached Γ, lean buffers; sweep CSV records `solver` and `gamma_build_s`; foam study moved to Standard (1e-4) |
| **v0.15.1** | Sweep export adds the second grid's solid fraction, convergence and per-load-case iterations. Foam fit page (`docs/foam-calibration/foam-fit.html`); first-pass foam laws (`FOAM_CALIBRATION.md` §6); plateau pass ready (§7) |
| **v0.16.0** | Three-axis crush (Crush axis = All; per-axis cache; all axes on one stress–strain plot; preview axis switch; cards use the weakest axis; buckling ratio = lowest per-axis ratio). Elastic CG cap 300 → 1000 with a "not converged" flag on card moduli. Void scaled to the design (1 % of its own stiffness, floor 1e-6) for linear runs (one re-solve when compliant) and per crush axis; "void-limited" flags. Sweep Standard cap 1000 + `cg_maxiter` column; foam re-run list (`FOAM_CALIBRATION.md` §10) |
| **v0.16.1** | Crush lateral (uniaxial-stress) loop: Broyden secant lateral compliance carried across steps, up to 8 corrections, cut back when lateral stress > 2 % of axial (was: elastic compliance, 4 tries, always accepted). Same in the 16f oracle |
| **v0.16.2** | Guarded lateral loop (`nlLateralStep`): elastic compliance restored on every cutback, half-step back on a ≥2× rise (no Broyden update), per-correction cap = axial increment, best attempt kept within 2 %. Fixes a pi-TPMS Z crush stalled in five field divergences |
| **v0.16.3** | Lateral limit = max(2 %, 1.5 × precision floor measured on step 1), one lateral retry per step, best attempt kept; v0.16.2 cap/backtrack removed (stalled a compliant foam at ~40 solves/step); "post-yield approximate" flag when floor > 5 %. Open: tighter f32 field tolerance for compliant designs (floor ∝ relRes × Es/E) |
| **v0.17.0** | Plotly stress–strain plot (`20b-curve-plotly.js`, vendored basic bundle, SVG fallback): MPa / log / ÷ own yield, focus X/Y/Z/All, legend toggles, unified hover, zoom + range slider, PNG export; scrubber = shared strain timeline, linked both ways with the plot; KPI crush cards |
| **v0.17.1** | Crush restarts at NL_TIGHT_NEWTON_TOL / NL_TIGHT_CG_TOL (1e-5) when the step-1 side-stress floor > 5 %, later axes of that design start tight; crush void from the softest axis; elastic macro stiffness reused across axes (`axStore._macro`) |
| **v0.17.2** | Tight crush = Newton tolerance only (NL_TIGHT_CG_TOL = null), retry reuses the first attempt's elastic setup (cache keyed by void + cgTol); foam: floor 0.3 %, ~45 s per axis (was setup 85.5 s). Nonlinear-tab cubes pause while a run is solving |

---

## 1. PICK UP HERE (2026-10-03)

Do these in order; 1–3 are on Matt's GPU, the rest are dev work to propose first.

1. **Verify v0.17.2 on the RTX machine** (nothing below has run on real hardware yet — recap §5). Reload, check the header says v0.17.2, clear cached crushes (`for (const k in NONLIN_BY_DESIGN) delete NONLIN_BY_DESIGN[k]; for (const k in NONLIN_AXES) delete NONLIN_AXES[k];`), then:
   - **Poisson-disk foam, Crush axis = All.** Expect X: `[crush] lateral precision floor ~27 % … restarting at the tighter tolerance`, then `[run] … reusing the elastic setup` and a tight run (floor ~0.3 %); Y and Z start tight with `elastic-macro setup` near 0 ms; no "post-yield approximate"; ~2 min total (X ~47 s, Y and Z ~35 s each). The cubes should hold still while it solves. Report the floor lines and the total time.
   - **pi-TPMS (gyroid × Fischer-Koch S), All.** Expect floor ~0.4 %, ~1.2 s per axis, curves bending below the elastic slope after yield, card E ≈ crush E0 (~30–32 MPa).
   - **The new plot**: scales, Focus X/Y/Z/All, legend chips, hover-scrub of the cubes, click-to-pin, zoom box, PNG export. Note anything to push further or pull back.
2. **Foam calibration re-run at the 1000-iteration cap** ([`FOAM_CALIBRATION.md`](FOAM_CALIBRATION.md) §10). Sweep → CSV → `docs/foam-calibration/foam_rerun_1000_runs.csv` (27 runs) with the §1 settings (Standard, void 1e-6, 64 ↔ 128 pair, order 2). Also run `foam_cellcount_runs.csv` (6) and, if time allows, re-run `foam_plateau_runs.csv` (19). Load results into `foam-fit.html` **old file first, re-runs after** (later run ids replace earlier ones) and export the fit JSON + summary.
3. **Refit and decide** (with Claude, from the fit page output): updated open / plateau laws; whether the open law needs a cell-count term or the ±7 % cell-count band can go. Then **F13LD.foam v0.5.1**: paste the new constants into its `FOAM_CAL` block, update its README numbers.
4. **PI-TPMS paper** (§1c) — Figure 6, verification table, Section 5 text. The v0.16–v0.17 changes do not touch sweep numbers (sweeps keep their own void 1e-6 and precision preset; the production pass ran at High, 1000 iterations).
5. **Dev cycle** — §1a.

## 1-foam. Foam stiffness calibration — laws provisional until the re-run

Laws (open 0.724 ρ^1.93, closed 0.304 ρ + 0.456 ρ², plateau factor 1 + 0.118(1 − e^(−k/0.111)), G = E/2(1+ν), stretch and Poisson-seed factors) are in [`FOAM_CALIBRATION.md`](FOAM_CALIBRATION.md) §6–7 and live in F13LD.foam v0.5.0 (§9). **27 of the 48 runs stopped at the old 300-iteration cap** (open / plateau 18–35 % on both grids, closed 12–18 % at 64³, set D), and a stopped solve reads stiff, so the open law above 18 % may be high. Re-run, refit and update F13LD.foam per §1 items 2–3.

## 1a. Next dev cycle — pick up (in suggested order; propose before building)

1. **Crush on real hardware, follow-ups** (after §1 item 1):
   - If the foam's tight run is too slow, options: tighten only the steps after yield; or cache the tight elastic setup across runs of the same design (today it is per run, shared across axes).
   - The 16f CPU oracle now mirrors 16g's lateral loop (Broyden, floor, one retry) but has only been syntax-checked — run a small CPU crush on Matt's machine against 16g.
   - Real-GPU check of the v0.8.1 cutback / early-stop paths (hyperuniform N=64 with `NL_TRACE`).
2. **Deferred crush items (not yet approved):** a quasi-elastic gradient readout (ISO 13314 style) on the Nonlinear tab; grid labels on cards and a warning when the elastic and crush grids differ.
3. **Plot follow-ups:** use `Plotly.toImage` for the future PDF report; reuse `20b-curve-plotly.js` patterns for the Sweep Atlas line chart (Plotly-style hover was already on its wish list); retire the SVG plot once the Plotly one has been used for a while (keep it as the offline fallback until then).
4. **Normal (non-sweep) elastic runs on the fast path.** Runs that capture fields still use 16b (2 blocking readbacks per CG iteration). Port field capture to `16i-elastic-fast.js`; the compliant-design void re-solve (v0.16.0) makes this more valuable — those designs now solve twice.
5. **Thinnest feature, properly** — (a) `thinnest_feature_T` export column; (b) fix the voxel estimator's low bias on flattened tubes (`SWEEP.md` §8); (c) builder "step by thinnest feature".
6. **Partial-volume voxels** (laminate mixing, Kabel/Merkert/Schneider 2015): N = 64 is 11–14 % low on thin PI / skeletal walls.
7. **Foam preview at 96³** in the lab (deferred by Matt until his foam testing is done); spinodoid demo does not converge on either elastic path — look at it.
8. **Main-lab axis triad check** (triad from rotation-matrix columns vs the ray-marcher's transpose).
9. **Sprint B2 — buckling speed** (§2).

## 1c. PI-TPMS paper — production pass done; write-up open

Matt's PI-TPMS Paper 1, Section 5: the run matrix is now **42 rows** (A4m added; E1 moved to A4m's wall ratio). Everything needed to produce the paper numbers is on main. See [`SWEEP.md`](SWEEP.md) §4–§8.

**Status:** the 42-row production pass (High 1e-5 · void 1e-6 · 64 ↔ 128 pair · order 2) ran on Matt's GPU on 2026-10-01 and was checked ([`SWEEP.md`](SWEEP.md) §9). **Next:** build Figure 6, the verification table vs Vixiv, fitted density exponents and directional-mean columns, and the Section 5 text with Matt; check B7's shear and B6's no-load axes at 1e-5.

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

- **Elastic solver (16b), GPU-resident CG.** Done for sweeps (v0.15.0, `16i-elastic-fast.js`); normal runs with field capture still use 16b — §1a item 4.
- **Real-GPU check of the v0.8.1 cutback / early-stop paths** (hyperuniform N=64 with `NL_TRACE`).

**Physics and fidelity**

- **Grain RVE window.** F13LD.mesh evaluates spinodoid / GRF / noise as one continuous field across the part. Add a 2×2×2 "window cells" option for those families.
- **Fundamental / double-period support (held back by Matt).** Custom equations that repeat every 2 periods need a larger window. This also affects F13LD.tpms's own homogenization (one-period window).
- **Partial-volume voxels** (laminate mixing, Kabel/Merkert/Schneider 2015) for elastic accuracy on thin walls.

**New solvers**

- **Thermal κ** — scalar subset of the elastic FFT-CG; a stub today.
- **Stokes** — wire it in; needs a preconditioner (the default maxiter 100 returns K 2.7× low).

**UI and roadmap**

- ~~Plot marker synced to the strain scrubber~~ — done in v0.17.0 (amber strain cursor, hover-scrub).
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
| `await runElasticFastTest(64)` | Fast elastic path (16i) vs 16b on demo recipes |
| `node validate-foam.js` | Foam kernel byte-match across lab / mesh / foam, field parity, import, sweep |
| `NL_LATERAL_*`, `NL_TIGHT_*`, `VOID_FLOOR`, `VOID_SCALE_FRAC` | Crush side-stress limits, tight-solve tolerances, void rule (recap §8) |
| `[crush-timing]` / `[crush]` console lines | Per-step macro corrections, cutbacks, step-1 lateral floor, tight restarts |
| Stubbed-solver page tests | Swap `NonlinearSolverFull` / `solveDesignElasticFull` for stubs in a headless page to test the run loop, caching and UI (SwiftShader cannot run the crush pipeline) |
| Node harnesses | Load the numbered solver files into one scope with small `window/document/performance` shims (see `proto/fe-buckling/h.js`) |
| Headless WebGPU | SwiftShader in the preinstalled Chromium, `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-features=Vulkan`, served over `http://localhost` |

---

## 4. Conventions (do not violate)

- **Line endings.**
  - `40-design-grid.js`, `21-raymarcher.js` and `22-stiffness-viz.js` are CRLF; `50-controls.js`, `14a-connectivity.js` and `16b-elastic-solver-full.js` are mixed (match the lines around an edit); `index.html`, `README.md` and the docs are currently LF. Check each with `file` before editing.
  - Patch these with count-guarded Python (`newline=""`, assert the match count).
  - Never normalize endings.
- **Solver frame = physical frame** since v0.7.2 (x is the slowest index in `buildVoxels`).
  - Viewer textures are x-fastest; convert with `solverToTexOrder` in 21-raymarcher.
  - Never reintroduce a solver-side axis swap.
- `node --check` every JS file before delivering. Powers of two only for spectral FFT grids.
- Recipes without normalization flags default to normalization OFF.
- Click-test on the raw.githack branch preview before merging.
- **Never use the words "genuine" / "genuinely."**
- **Version bump** on significant changes: `index.html` header, `99-init.js` banner, README "What's new", §0 table here.
- **Commits / PRs:** `Co-Authored-By: Claude …` is fine; no claude.ai session links anywhere in the repo. GitHub GraphQL is blocked from Claude sessions — open and merge PRs with `gh api` (REST).
- **Vendored code** lives in `vendor/` with its licence file (Plotly basic 2.35.2, MIT). Plotly 2.35: no layout transitions with `fillgradient` traces (throws).
- **Heavy analyses run on Matt's machine** (give him a tool or a page), not on the VM.
- Present proposed diffs for approval before applying.

Repo: `github.com/mshomper/f13ld.lab` · contact: matt@notarobot-eng.com
