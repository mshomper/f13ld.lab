# F13LD.lab — Next Steps (session handoff)


> **2026-10-07 · v0.19.3** — thermal Phase 0: Float64 CPU reference (`17a-thermal-cpu-ref.js`) on the rotated grid with full-tensor laminate composite voxels (`14e-link-field.js` `buildVoxelTensors`; per-link crossings kept there for fluids); exact on flat walls at any angle, sheet gyroid within 1.1–2.6 % and BCC beams within 0.4–1.7 % of N = 128 at N = 64; the planned face-based scheme was built, read inclined walls 8–16 % low, and is kept in `proto/thermal/faces-tpfa.js`. Validation `proto/thermal/run_tests.js`, results [`THERMAL_SCOPE.md`](THERMAL_SCOPE.md) §11. Nothing user-visible.
>
> **2026-10-07 · v0.19.2** — crush: two side-stress cutbacks on a normal-tolerance crush trigger the tight restart immediately (`NL_TIGHT_AFTER_CUTBACKS = 2` in 16g); verified on Matt's compliant design in v0.19.1 that the tight run finishes clean (13 steps to 5.94 %, 23 s, no cutbacks).
>
> **2026-10-07 · v0.19.1** — crush: a field-solve divergence before yield is retried once at the tight step tolerance (reusing the elastic setup), and if it still diverges the accepted steps are kept as a partial curve (`truncReason: 'diverged'`, no yield) instead of an error that dropped the design from the plot (Matt's compliant design, N = 64, Z, diverged at ε 3.83 %).
>
> **2026-10-07 · v0.19.0** — normal runs (with fields) on the fast elastic path; thinnest feature in cell units and mm in the sweep CSV; sweep builder steps by thinnest feature (mm); partial-volume voxels, on by default — grid-converged by N = 64 on the GPU check ([`PARTIAL_VOLUME.md`](PARTIAL_VOLUME.md)); fast-path Γ rebind fix. Scopes for the next physics: [`THERMAL_SCOPE.md`](THERMAL_SCOPE.md), [`FLUIDS_LBM_SCOPE.md`](FLUIDS_LBM_SCOPE.md).
>
> **2026-10-06 · v0.18.0** — viewer: design cards use the shared F13LD shading (`20c-f13-shade.js`, same block as every F13LD tool) in each design's family color, with a shared "◐ view" menu in the VIEW strip; stress/buckling colormaps keep neutral lighting. Geometry texture is now R16F (was R8) and foam/noise/grain refine to 96³/96³/80³ in the background after the 48³ preview (display only — the solver voxelizes separately).
>
> **2026-10-05 · v0.17.4** — wet foam field changed with F13LD.foam v0.7.0: it now includes the neighbouring bubbles (no jumps across cell faces) and honours `foam.edge_min` (cusp trim; sweepable, CSV column `edge_min`). Wet-foam lab results from before v0.17.4 were computed on the old field; re-run them if they feed a fit.

**As of:** v0.19.3 · 2026-10-07 · thermal Phase 0 (CPU reference, sub-voxel walls) done; fields on the fast elastic path, feature size in mm (CSV + builder), partial-volume voxels (default on); crush verified on hardware; fluids scoped; foam laws still provisional (re-run moved down)
**Suite on main (2026-10-04):** lab v0.17.3 · F13LD.foam v0.6.0 · F13LD.mesh v0.9.3 (fast weld export — see mesh `docs/SESSION_RECAP_2026-10-04.md`; no lab impact)
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
| **v0.19.3** | Thermal Phase 0: CPU reference `17a` (rotated grid, full-tensor laminate composite voxels, PCG with FFT preconditioner), `14e-link-field.js` (`buildVoxelTensors` for thermal, `buildLinkField` for fluids), `proto/thermal/` (validation, face-based scheme kept for the record). `THERMAL_SCOPE.md` §11 |
| **v0.19.1 / v0.19.2** | Crush: pre-yield divergence retried at the tight tolerance, partial curve kept; tight restart after 2 side-stress cutbacks |
| **v0.19.0** | Field capture on the fast path (16i): normal runs use GPU-resident CG too, legacy 16b only as fallback; `runElasticFastTest` compares fields. Sweep CSV `thinnest_feature_T / _mm`, `median_feature_T / _mm`, `cell_mm`; builder "by thinnest feature" (bisection at the run grid, `sweepParamsForFeatures` in 14d). Partial-volume voxels (`buildVoxelMargin` / `voxelFractionsFromMargin` in 14-rasterizer, `pvC` blend in the stiffness kernel), **on by default** (Matt, after the GPU check), Surface voxels pill + sweep setting (0/1 cube reproduces pre-v0.19.0 results), CSV `partial_volume`, `vf_partial_pct`; `runPartialVolumeCheck()`. Fixed: 16i rebinds Γ by buffer, not key (a third grid evicted and rebuilt Γ under the same key). Local thickness tried for the flattened-tube bias and set aside (no gain, §1a item 5) |
| **v0.18.0** | Shared F13LD viewer shading (`20c-f13-shade.js`), R16F geometry texture, 96³ background refine for foam / noise / grain |
| **v0.17.3** | F13LD.foam v0.6.0 exact field (`geometry.field: 2`, `buildFoamSDF2`, byte-identical in lab / mesh / foam); v0.6.0 foams (wet Plateau borders, fillet / node, two-size mix, mirror / cubic symmetric seeds, FCC / C15 + disorder); sweep CSV `field`, `fillet`, `node`, `border`, `size_ratio`, `large_fraction`, `jitter`; calibration generators write `_field2` run lists; `validate-foam.js` §8. Older foam recipes build exactly as before. (Built in a separate session; `FOAM_CALIBRATION.md` §11) |

---

## 1. PICK UP HERE (2026-10-07)

1. **Click-test v0.19.0** on the branch preview (or main once merged):
   - a normal Run All: stress and deformation views as before, run source reads "· partial volume"; `await runElasticFastTest(32)` passes (moduli and fields, fast vs legacy; spinodoid still unconverged on both paths, as before);
   - `await runPartialVolumeCheck()` on the RTX after the Γ fix: no "destroyed buffer" errors, no legacy fallback at 128, PASS (`PARTIAL_VOLUME.md` §4);
   - sweep builder → "by thinnest feature", and the new CSV columns.
2. **Thermal, Phase 1 (GPU)** — [`THERMAL_SCOPE.md`](THERMAL_SCOPE.md) §11.6: `17b-thermal-solver.js` mirroring 17a (rotated-grid gather kernel with per-voxel phi + normal, scalar FFT preconditioner, two load cases per complex FFT), card rows, run phase, T9–T12, and the "under-resolved" card flag (thinnest feature under a voxel; island trim stays on — Matt, 2026-10-07). Matt runs the BCC beam N = 128 reference first: `node --max-old-space-size=8000 proto/thermal/beam_reference.js` (§11.4 †).
3. **Dev cycle** — §1a.

**Done 2026-10-07 (Matt):** v0.17.x crush changes verified on the RTX machine — foam and PI-TPMS unblocked; some sparse foams still make several cutbacks, manageable. The Plotly stress–strain plot is good. **PI-TPMS paper finished** (other session) — removed from this list.
**Moved down (Matt, 2026-10-07):** foam calibration re-run on the exact field and the refit (old §1 items 2–3) — the foam tool carries estimates and that is fine for now; kept in §2 Queued.

## 1-foam. Foam stiffness calibration — laws provisional until the re-run

Laws (open 0.724 ρ^1.93, closed 0.304 ρ + 0.456 ρ², plateau factor 1 + 0.118(1 − e^(−k/0.111)), G = E/2(1+ν), stretch and Poisson-seed factors) are in [`FOAM_CALIBRATION.md`](FOAM_CALIBRATION.md) §6–7 and live in F13LD.foam (§9). Two reasons they're provisional:
- **27 of the 48 runs stopped at the old 300-iteration cap** (open / plateau 18–35 % on both grids, closed 12–18 % at 64³, set D), and a stopped solve reads stiff, so the open law above 18 % may be high.
- **They were fitted on the original field.** F13LD.foam v0.6.0 builds new foams on the exact field, which makes open / plateau struts thinner near the nodes: about 13–17 % less solid at the same thickness (§11).

Re-run on the exact field, refit and update F13LD.foam per §1 items 2–3. The v0.6.0 foams (wet, fillet / node, two-size, symmetric seeds, FCC / C15, disorder) are not calibrated yet. A pass for them is a later decision; the sweep CSV already takes their columns.

## 1a. Next dev cycle — pick up (in suggested order; propose before building)

1. **Crush on real hardware, follow-ups** (hardware check done 2026-10-07; sparse foams still cut back several times — manageable):
   - If the foam's tight run is too slow, options: tighten only the steps after yield; or cache the tight elastic setup across runs of the same design (today it is per run, shared across axes).
   - The 16f CPU oracle now mirrors 16g's lateral loop (Broyden, floor, one retry) but has only been syntax-checked — run a small CPU crush on Matt's machine against 16g.
   - Real-GPU check of the v0.8.1 cutback / early-stop paths (hyperuniform N=64 with `NL_TRACE`).
2. **Deferred crush items (not yet approved):** a quasi-elastic gradient readout (ISO 13314 style) on the Nonlinear tab; grid labels on cards and a warning when the elastic and crush grids differ.
3. **Plot follow-ups:** use `Plotly.toImage` for the future PDF report; reuse `20b-curve-plotly.js` patterns for the Sweep Atlas line chart (Plotly-style hover was already on its wish list); retire the SVG plot once the Plotly one has been used for a while (keep it as the offline fallback until then).
4. ~~Normal (non-sweep) elastic runs on the fast path~~ — done v0.19.0. Compliant designs still capture fields on their first solve too (the void decision needs all six load cases); fields are only discarded on those designs.
5. **Thinnest feature** — (a) and (c) done v0.19.0. (b) the PI flattened-tube low bias: **local thickness** (Hildebrand & Rüegsegger, BoneJ) was built and tested — A4 0.114 vs 0.113 T at N = 128 (truth 0.117–0.120), C4 reads *thicker* (0.139 vs 0.131; volume weighting favours nodes), 1.5–3× slower — set aside. The real fix is a width measured on the continuous field (Matt's chord method), cheap once the shared signed field exists (thermal Phase 0).
6. **Partial-volume voxels** — done v0.19.0, on by default ([`PARTIAL_VOLUME.md`](PARTIAL_VOLUME.md)): grid-converged by N = 64 (within 0.5 % of 128 on A4m / C4 / D7; the cube still moves 2–11 %). Follow-up: move the partial-volume rasterization (up to ~8 s for PI-TPMS at 128, main thread) into the geometry worker. Laminate voxels would need a non-symmetric Krylov solver and are not needed now. Note: `SWEEP.md` §8–§9's cube extrapolations are probably a few percent low (D7 measured convergence order ≈ 0.6, not 2); the paper is left as is (Matt).
7. **Foam preview at 96³** in the lab (deferred by Matt until his foam testing is done); spinodoid demo does not converge on either elastic path — look at it.
8. **Main-lab axis triad check** (triad from rotation-matrix columns vs the ray-marcher's transpose).
9. **Sprint B2 — buckling speed** (§2).

## 1c. PI-TPMS paper — finished (2026-10-07)

Written up in another session. The numbers and methods stay in [`SWEEP.md`](SWEEP.md) §4–§9. To reproduce them with v0.19.0+, set **Surface voxels = 0/1 cube** (partial volume is the default from v0.19.0).

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

**Foam calibration on the exact field (moved down, Matt 2026-10-07).** The re-run at the 1000-iteration cap and the refit into F13LD.foam v0.6.1 — see [`FOAM_CALIBRATION.md`](FOAM_CALIBRATION.md) §11 and the §1-foam notes above. The foam tool's estimates stand until then.

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

- **Thermal κ** — scalar subset of the elastic FFT-CG; a stub today. Scoped in [`THERMAL_SCOPE.md`](THERMAL_SCOPE.md) (2026-10-07): conductivity tensor, 3-D temperature map, sub-voxel walls.
- **Fluids (LBM)** — replaces the Stokes solver, which Matt does not trust and nothing calls. Scoped in [`FLUIDS_LBM_SCOPE.md`](FLUIDS_LBM_SCOPE.md) (2026-10-07): wall shear stress for biocompatibility, permeability, live flow-rate and direction rescaling. Thermal goes first (shared signed-field and section-plane work).

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
- **Old branches on GitHub: Matt approved deleting all of them (2026-10-04).** Claude sessions can't delete branches (the proxy blocks it), so Matt deletes them himself.
  - Every branch except `main` is merged. `release/v0.12.1` is an older draft of the licence files; main has the newer version.
  - Settings → General → Pull Requests → "Automatically delete head branches" keeps future merges clean.

---

## 3. Validation harness

| Tool | Checks |
|---|---|
| `runAxisConventionGPUTest()` | z-laminate: Ez must be the soft axis and match the CPU oracle axis by axis |
| `runFEBucklingSelfTest(32)` | Zero-energy count (must be 3) plus periodic plate vs the exact continuum answer (within ~1 % at N=32) |
| `F13LD_buckleBench(recipe, N)` | Any recipe through the real worker pool (voxel FE by default) |
| `runNonlinearFastOpTest()` | Fast nonlinear operator vs the reference |
| `window.NL_TRACE` / `NL_FAST` / `NL_PREDICT` / `NL_EW` | Nonlinear logging and A/B switches |
| `await runElasticFastTest(64)` | Fast elastic path (16i) vs 16b on demo recipes — moduli, and (v0.19.0) captured von Mises and u′ fields |
| `await runPartialVolumeCheck()` | v0.19.0 — A4m / C4 / D7 at 32 / 64 / 128, 0/1 cube vs partial volume; pass = partial volume within 1 % between 64 and 128 (`PARTIAL_VOLUME.md` §4) |
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
- **Version bump** on significant changes: `index.html` header, `99-init.js` banner, README "What's new", §0 table here, and `CITATION.cff` (`version` + `date-released`; Matt, 2026-10-04).
- **Commits / PRs:** `Co-Authored-By: Claude …` is fine; no claude.ai session links anywhere in the repo. GitHub GraphQL is blocked from Claude sessions — open and merge PRs with `gh api` (REST).
- **Vendored code** lives in `vendor/` with its licence file (Plotly basic 2.35.2, MIT). Plotly 2.35: no layout transitions with `fillgradient` traces (throws).
- **Heavy analyses run on Matt's machine** (give him a tool or a page), not on the VM.
- Present proposed diffs for approval before applying.

Repo: `github.com/mshomper/f13ld.lab` · contact: matt@notarobot-eng.com
