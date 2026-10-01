# F13LD.lab — Session Recap

**Session:** 2026-09-30 (evening) → 2026-10-01
**Repo:** `github.com/mshomper/f13ld.lab`
**Starting point:** `463454b` (code at **v0.8.2**; docs had just made STL import the focus)
**Now live on main:** `4c26499` (**v0.12.1**)
**Preview any branch:** `https://raw.githack.com/mshomper/f13ld.lab/<branch>/index.html`
**Handoff:** [`NEXT_STEPS.md`](NEXT_STEPS.md) §1 (current focus) and §1a (next dev cycle)

---

## 1. At a glance

| Version | What changed | Why it mattered |
|---|---|---|
| **v0.9.0** | STL unit-cell import | Any CAD unit cell can be solved like a native F13LD design |
| **v0.9.1** | Face-match fix for imported cells | Matt's CAD cells were almost always flagged "not periodic" |
| **v0.10.0** | Parameter sweep (CSV run matrix or one-parameter sweep), geometry check before solving, step by solid fraction | The PI-TPMS paper needed a 41-run computational sweep |
| **v0.10.1** | Void-stiffness option (sweeps 1e-6), two-grid extrapolation, builder keeps its grid | 1e-4 void stiffness was inflating low-density runs; grid error needed a correction path |
| **v0.11.0** | Builder for every family, two parameters, review before creating; Sweep Atlas | The builder is how most people will use the sweep; results needed a visual explorer |
| **v0.12.0** | Atlas: CAD tumble, linked views, 3-D stiffness surface, smooth slider; sweep keeps no-load-axis runs; negative-shear flag; folding notes | Matt's click-test feedback; B6 was being discarded by the solver's physicality check |
| **v0.12.1** | Sweep panel in three sections, ↺ New sweep, ✕ remove CSV, study title, **64 ↔ 128 pair** | The panel was confusing to reset and clear; the paper needs one extrapolation basis |

Analyses that feed the paper: A6 grid check, PI tube width vs wall ratio, the first full §5 run, the void 1e-6 rerun, and the measured-geometry matched-feature comparison (A4m). All are written up in [`SWEEP.md`](SWEEP.md) §4–§8.

---

## 2. What was done, release by release

### 2.1 v0.9.0 — STL unit-cell import
- **Data path:** STL → periodic signed-distance grid (128³, uint8, clamp ±0.8 field units, negative inside, one cell = 2π) → `import` kernel (`13c-import-kernel.js`) → every solver and the viewer, unchanged.
- **Fill:** scanline with winding rule, majority vote over three axes; ±1-cell shifted copies unioned so walls crossing the cell faces wrap; periodic exact distance transform (Felzenszwalb).
- **Dialog (`61-import-stl.js`):** mesh health, cell mapping (near-cubic within 2 % is treated as cubic — CAD exports are often ~1 % off; beyond that it refuses), face-match report, wall-offset slider, IndexedDB store, export with the grid embedded.
- Worker: `14c-stl-import.js` runs in a blob web worker.

### 2.2 v0.9.1 — Face match fixed
- **Cause:** Matt's `testcell.stl` walls overhang the trim planes by 0.007 mm (bounding box 5.008–5.014 mm), so the cell was cut in the wrong place and the overhang dropped.
- **Fix:** cell faces from the trim planes, overhang wrapped, and a **local seam test** (tolerance 3 voxels) instead of whole-face comparisons. Report: green ≥ 0.95, amber ≥ 0.80; "not periodic" shown only below amber.
- Matt ran a full GPU Run All on an imported cell: successful.

### 2.3 v0.10.0 — Parameter sweep
- **CSV run matrix** (`62-sweep.js`): surface, PI / sheet / skeletal mode, shift, wall ratio or level, grid, ν, optional expected solid fraction and reference stiffness. All 41 rows of the §5 matrix rebuild within ~1 % of `expected_vf_pct`.
- **Solver hooks (16b):** per-call CG tolerance and iteration cap, final residual per load case, solid fraction before island trim.
- **Precision toggle:** Standard 1e-4 (300 its) / High 1e-5 (1,000 its).
- **Geometry check before solving** (worker, `14d-voxel-stats.js`): empty, fully solid and no-load-path runs are skipped; partial spanning, < 2 % / > 95 % solid, thinnest feature under **6 voxels** and solid-fraction mismatches are flagged. Thinnest feature = 5th percentile of 2√d + 0.5 over maximal-ball centres.
- **Step by solid fraction:** exact quantiles of a per-voxel threshold field (tie-aware) or bisection for monotone parameters.
- **Export CSV:** 21 Cᵢⱼ ÷ E_s, engineering constants, solid fractions, solver record, reference ratios, checks and notes.

### 2.4 v0.10.1 — Void stiffness and extrapolation
- **Void stiffness** 1e-4 / 1e-6 / 1e-8 × E_s; sweeps default to **1e-6**. Normal lab runs stay at 1e-4.
- **Second grid + extrapolation:** C_ext = C_fine + (C_fine − C_coarse)/(2^p − 1), element by element; order 1 or 2 (default 2).
- **Bug fixed:** builder reset the grid to 64 on "create runs" (settings now persist).

### 2.5 v0.11.0 — Builder for every family, review, Atlas (phase 2)
- **Parameter catalogue** (`sweepParamCatalog`): TPMS level / sheet thickness / offset; PI wall ratio and shifts; beam radius scale, radius x/y/z, node ball, node smoothing (no uniform offset — capsule distance plateaus); bundle per-structure fields, sheet width, offset; wave iso, thickness, phase; grain / noise; imported-cell wall offset; any other numeric field.
- **Two parameters**, ranges or lists (fractions allowed).
- **Review before creating:** runs, total solves, estimated time from this machine's measured speed, solid-fraction map, skipped / partial / thin runs, cost at N = 128, hardware note, storage. No run cap (Matt: long sweeps are the user's call).
- **Storage** moved to IndexedDB (big sweeps), legacy localStorage migrated.
- **Sweep Atlas** (`63-sweep-atlas.js`): geometry, directional-modulus surface, readout + 6×6 heatmap, parameter map, stiffness vs solid fraction (Voigt bound), design space, data check. F13LD brand colours on the dark theme; no Vixiv values.

### 2.6 v0.12.0 — Atlas polish, B6 kept
- **CAD tumble** on all 3-D views (screen-axis tumble, free over the top, right/shift-drag pan, zoom to cursor, double-click home), x/y/z triads, **⛓ linked** geometry ↔ modulus rotation (default on). Viewer hooks in `21-raymarcher.js` / `22-stiffness-viz.js` (`_rotM`, pan uniform, `_extControl`); main lab tiles unchanged.
- **3-D stiffness surface** for two-parameter sweeps (canvas 2-D, no extra WebGL context): metric chooser incl. Ex/Ey/Ez together, log/linear, colour by value or connectivity, floor contours, holes, hover and click-to-select.
- **Smooth run slider** (updated in place; per-frame coalescing; geometry rebuilt when the selection settles).
- **No-load axes:** 16b now returns the full result with a physicality reject; the sweep keeps a converged run whose rejected axes are within 20 × void (≥ 1e-5) of zero, with a note. Other rejects give the reason and values.
- **Negative shear** (C44/C55/C66 < 0) flagged in notes and the Atlas data check. Sweep notes fold away.

### 2.7 v0.12.1 — Sweep panel restructure, grid pairing
- Three sections: **Define runs** (builder / CSV tabs; CSV chip with ✕ remove, Replace CSV…), **Run settings**, **Runs**.
- **↺ New sweep** → defaults (runs, results, builder, run settings; measured timing kept).
- **Study title** readable and renamable; names the exported CSV. "Clear selected" → **Clear results of selected**.
- **Second grid: 64 ↔ 128 pair** — one extrapolation basis for a matrix listed at mixed grids.

---

## 3. Paper findings (details in `SWEEP.md`)

- **§4 A6 at N = 128 (void 1e-4):** gap to Vixiv roughly halves with the grid. Superseded by §7 for absolute numbers.
- **§5 PI tube width:** normalized PI tubes flatten as they thicken — narrowest width 1.00 / 0.94 / 0.87 / 0.73 × nominal at wall ratio 0.05 / 0.126 / 0.19 / 0.35.
- **§6 first full run (void 1e-4):** GPU = CPU reference; F-set convergence order ≈ 2 (PI Ex/Ey), 1.4 (Ez), 1.2 (sheet); B3, B9, B10 directional checks match Vixiv's expectations; Fischer–Koch jump is a topology change (Euler characteristic 25 → 33 → 41 → 57 loops per cell across wall ratio 0.15–0.21); B6's x/z stiffness was the void bridging layers.
- **§7 void 1e-6 rerun:** the void offset was not a flat +1e-4 — it was largest on soft axes of near-contact PI lattices (G1 −19/−20 %, B4/B5 −11/−13 %), under 1 % on sheet and skeletal. A1–A3 went from far above Vixiv to 8–21 % below. Median ratio to Vixiv 0.86 (N = 64), 0.89 (N = 128); A5 three-grid extrapolation 0.95. Iterations up only on contact lattices (G3 +48 %).
- **§8 matched feature on measured geometry:** A4m (wall ratio **0.1364**) builds a 0.126 T narrowest tube (A4 builds 0.117–0.120 T). Matt's results (CG 1e-5, 64 + 128 extrapolated): A4m vs D7 — 1.77× in-plane, 0.43× along z, ≈ equal on the directional mean, at 1.7× the solid; C4 ≈ 40× at 3.6× the solid; D7 2.4× stiffer along [111] than its axes. Voxel and continuous thickness measures disagree by ~3–4 % on flattened PI tubes.

---

## 4. Your decisions this session

- **STL import:** cell size defaults to the bounding box; near-cubic within 2 % is cubic; wall-offset slider in v1; face match only warns; fix then merge (done).
- **Sweep:** keep island trim (faithful to physical builds) and report differences as notes; precision toggle 1e-4 / 1e-5; check A6 at N = 128 before touching the solver; thin-feature threshold 6 voxels; void option with 1e-6 for sweeps; extrapolation optional, user grid default.
- **Builder first:** every family, two parameters, total solves and cost before committing; cap is hardware-based only — 500-run / 5-hour sweeps are the user's call; drop the shift preset (shift was special only because it matched the Vixiv runs).
- **Atlas:** in-lab now, self-contained HTML export later (the lab is not MIT-licensed); F13LD brand colours, dark theme; lab-native charts with a Plotly-like look; no Vixiv reference values; linked views with a toggle; CAD tumble; 3-D stiffness surface.
- **Warnings:** keep B6-type runs with a warning; notes collapsible.
- **Matched feature:** use the measured PI width (A4m); keep C4 and D7 as given and note physical differences in the paper; A4m is a permanent matrix row; E1 moves to A4m's wall ratio.
- **Versioning:** bump the version on every significant change.
- **Thinnest feature in export / step by feature size:** later.

---

## 5. Paper status and the production pass

**Ready now:** sets C, D, E, F and most of A and B at void 1e-6 (standard precision), A4m matched-feature trio at 1e-5 with 64 + 128 extrapolation.

**Not yet final:** 27 runs are extrapolated from grids 32 + 64 (grid 32 under-resolves thin PI tubes); B6 missing (now kept by v0.12); B7 negative shear; B5's coarse second grid unconverged; G3 just missed tolerance on yy.

**Production pass (Matt):** 42-row matrix → High (1e-5) · void 1e-6 · second grid **64 ↔ 128 pair** · order 2 → Run 42 (~15–20 min) → Export CSV. Covers the B5/B6/B7/G3 reruns.

---

## 6. Next dev cycle — pick up (prioritized)

1. **Analyse the production pass:** Figure 6 data, verification table vs Vixiv, fitted density exponents, directional-mean columns; confirm B7 shear and B6 no-load axes at 1e-5.
2. **Thinnest feature, properly:** export column; fix the voxel estimator's low bias on flattened tubes; builder *step by thinnest feature*.
3. **Partial-volume voxels** for elastic accuracy on thin walls (N = 64 reads 11–14 % low on PI/skeletal).
4. **Elastic solver GPU-resident CG** (16b still does 2 blocking reads per CG iteration) — direct sweep speed-up.
5. **Main-lab axis triad check** (tile triad drawn from matrix columns, ray-marcher uses the transpose).
6. **Atlas later items:** self-contained HTML export (results + views only), 3-D surface tick polish, line-chart hover crosshair.
7. **Sprint B2 — buckling speed** (queued in `NEXT_STEPS.md` §2), then B3 WebGPU voxel FE.
8. **Hygiene** (unchanged list in `NEXT_STEPS.md` §2).

---

## 7. Repo state

- **main** `4c26499` — v0.12.1. Branches merged this session: `stl-import`, `sweep`, `sweep-atlas`, `sweep-ui`.
- **New files:** `13c-import-kernel.js`, `14c-stl-import.js`, `14d-voxel-stats.js`, `61-import-stl.js`, `62-sweep.js`, `63-sweep-atlas.js`, `docs/STL_IMPORT_SCOPE.md`, `docs/SWEEP.md`, `proto/stl-import/` (generator + tests), this recap.
- **Touched shared files:** `16b-elastic-solver-full.js` (tolerance / iteration cap / void ratio per call, residuals, `rho_raw`, full result on physicality rejects), `21-raymarcher.js` and `22-stiffness-viz.js` (external camera + pan hooks), `50-controls.js` (Run All blocked during a sweep), `index.html`, `lab.css`, `99-init.js`, `README.md`.
- **Browser storage:** sweeps in IndexedDB `f13ld.lab.sweep` (store `state`, key `current`); imported grids in `f13ld.lab.imports`. Each web address has its own storage — the preview links don't see main's saved sweep.

---

## 8. Deliverables sent this session

- `void_1e-6_report.md` — void 1e-4 vs 1e-6 comparison, per run.
- `PI-TPMS_section5_matched_feature.csv` — A4, A4m, C4, D7.
- `PI-TPMS_section5_run_matrix.csv` (42 rows) and `PI-TPMS_section5_run_matrix.md` — A4m added, E1 moved to A4m's wall ratio. **Master copies are Matt's; not in this repo.**
- Atlas and panel screenshots; sweep panel layout mockup.
- LinkedIn post text for the v0.12 release.

---

## 9. How to check things (browser console)

```js
SWEEP_STATE.runs.length, Object.keys(SWEEP_STATE.results).length   // run list / results
sweepCompanionN(64, 'pair'), sweepCompanionN(128, 'pair')           // → 128, 64
openSweepAtlas()                                                     // Atlas over the current sweep
ATLAS.camGeo.Q, ATLAS.link                                           // tumble orientation, link state
sweepGeometryStats(sweepRecipeForRun(SWEEP_STATE.runs[0]), 64, 'networks')  // solid %, spans, thinnest feature
```

---

## 10. Working conventions (carry forward)

- Proposed changes are presented for approval before code is written; don't over-deliberate.
- Bump the version (header + `99-init.js`) with every significant change.
- The solver frame is the physical frame. Never reintroduce an axis swap.
- Line endings: `index.html`, `50-controls.js`, `40-design-grid.js`, `21-raymarcher.js`, `22-stiffness-viz.js`, `README.md` are CRLF; `14a-connectivity.js` and `16b-elastic-solver-full.js` are mixed. Edit without normalizing.
- Syntax-check every touched script (`node --check`). FFT grids are powers of two.
- Work on a branch, click-test the preview, merge on Matt's approval.
