# F13LD.lab — Parameter Sweep (v0.12.1)

**Open:** ⟳ Sweep in the header. The panel can be closed while a sweep runs; the header button shows progress (e.g. *Sweep 12/41*). Run All is blocked while a sweep is running, and a sweep won't start during a run.

**Panel layout (v0.12.1).** Three sections, top to bottom:
1. **Define runs** — two tabs, *Build from a design* (§1.2) and *Load a CSV run matrix* (§1.1). A loaded CSV shows as a chip with **✕ remove** and *Replace CSV…*. Only one run list is active; replacing one that has results asks first.
2. **Run settings** — precision, void stiffness, second grid and order (§2), plus the islands setting from the run controls.
3. **Runs** — the study title (CSV file name or "Design · Parameter 1 × Parameter 2", **✎ rename**; the exported CSV is named after it), counts, selection links, **◈ Atlas**, **Clear results of selected** (deletes results of the ticked runs so they run again; the runs stay), **Export CSV**, **▶ Run**, the table, and the folding *Notes and warnings*.

**↺ New sweep** (panel header) returns everything to defaults: no runs, empty builder, Standard precision, void 1e-6, second grid off, order 2. It asks first. This machine's measured solve times are kept.

**What each run does:** elastic homogenization only, on the GPU, one periodic unit cell, the full 6 × 6 stiffness from six load cases. Fields are not captured, so runs are faster than a normal Run All.

---

## 1. Two ways to make a run list

### 1.1 Load a run-matrix CSV

One row per run. Columns read (others are ignored, `purpose` / `note` / `set` / `tier` are carried through to the export):

| Column | Meaning |
|---|---|
| `run_id` | Required, unique |
| `surface` | `Gyroid`, `Fischer-Koch S`, `Lidinoid`, `Schwarz P` |
| `mode` | Contains `PI` → PI-TPMS; `Sheet` → sheet; `Skeletal` → skeletal |
| `shift` | PI phase shift in cycles, e.g. `"(0, 1/8, 1/2)"`; fractions allowed |
| `tube_radius_over_T` or `wall_ratio` | PI tube radius ÷ cell, or tube diameter ÷ cell |
| `level_c` | Sheet: solid where \|φ\| ≤ c. Skeletal: solid where φ ≥ c |
| `grid_N` | 32, 64 or 128 |
| `nu_s` | Solid Poisson's ratio |
| `expected_vf_pct` | Optional build check (flagged when the voxel solid differs by more than 1 % relative) |
| `vixiv_Ex`, `vixiv_Ey`, `vixiv_Ez` | Optional reference values; the table and export show result ÷ reference |
| `tier` | Optional; the panel can select by tier |

**How rows become lab recipes** (validated on all 41 rows of the PI-TPMS §5 matrix — every run within ~1 % of `expected_vf_pct` at its own grid; B3 is −2.2 % at N = 64 and +0.1 % at 128; F1 is the intentionally coarse case):

| Mode | Lab geometry |
|---|---|
| PI-TPMS round | `pi-tpms`, gradient-normalized (`pi_normalize`), pipe radius = `tube_radius_over_T` × 2π, phase shift in cycles |
| Sheet | `shell`, offset 0, wall thickness = c (no field rescaling; the lab uses the raw gyroid, range ±1.5) |
| Skeletal | `solid` on −φ with offset −c |

### 1.2 Build one from a loaded design (the main way, v0.11)

The builder sits at the top of the Sweep panel; loading a CSV is the second row. Pick a design, **parameter 1**, optionally **parameter 2**, a grid and a Poisson's ratio. Each parameter takes either a start, an end and a number of steps, or a list of values (`0, 1/8, 1/4` — fractions allowed). Two parameters make the full grid (parameter 1 × parameter 2). Parameter 1 can be stepped by value or by solid fraction (§1.4) when it is a threshold-type parameter.

Parameters come from the design's own recipe, so every family works (catalogue in `14d-voxel-stats.js`, `sweepParamCatalog`):

| Design | Parameters |
|---|---|
| TPMS solid | Level |
| TPMS sheet | Sheet half-thickness, level offset |
| PI-TPMS | Wall ratio (tube diameter ÷ cell), shift x / y / z (cycles) |
| Beam (new schema) | Radius scale, radius x / y / z, node ball radius, node smoothing; old schema: radius. No uniform offset — the capsule distance plateaus outside the strut halo, so an offset is not uniform |
| Bundle | Each structure's own numeric fields, sheet width, offset |
| Wave | Iso level, thickness, phase/time, offset |
| Grain, noise | Level / center, half-width |
| Imported STL cell | Wall offset (mm) — the same control as the import dialog's slider |
| Any family | Any other numeric field of the recipe (listed under *Other*) |

**Review before creating.** *Review* voxelizes every combination at N = 32 in a background worker (no solves) and shows, before anything is committed:

- runs (n₁ × n₂), total solves (doubled when a second grid is on), estimated time and the solid-fraction range;
- a parameter-1 × parameter-2 map of solid fraction, with skipped combinations hatched (empty, fully solid, no load path, or a solid-fraction target out of reach);
- notes: how many runs carry load on only some axes, how many will have features under 6 voxels at the chosen grid (and what the sweep would cost at N = 128), a hardware note, and storage.

Time estimates use this machine's measured seconds per solve at each grid (kept across sweeps); before the first run they fall back to rough guesses (2 / 3 / 20 s at N = 32 / 64 / 128). There is no run cap: the hardware note says when a grid is above what the GPU tier handles comfortably, and long sweeps are the user's call (Matt, 2026-10-01). *Create* writes the runs (ids `S{i}-{j}`) and unticks the skipped ones; the builder keeps its settings, including the grid.

### 1.3 Geometry check before solving

Every run is voxelized at its own grid in a background worker as soon as the list is made (the §5 matrix: 41 runs in about 90 s). No solve. The table shows each run's solid % (after island trim) and a **Checks** column:

| Check | Level | Meaning |
|---|---|---|
| empty · fully solid · no load path | **skip** (unticked automatically, reason shown) | Nothing to solve: no solid, a solid cube, or no piece runs across the cell on any axis |
| spans x, z only | warn | Carries load on those axes only; the others will read near the void level (~1e-4). Layers and strands (B6, B7) are meant to — they stay ticked |
| < 2 % solid · > 95 % solid | warn | Extreme solid fraction |
| thin N vox | warn | Thinnest feature under **6 voxels** at this grid (Matt, 2026-10-01); stiffness will read low |
| vf ±x % | warn | Voxel solid differs from `expected_vf_pct` by more than 1 % |
| trim x % | info | Island trim removes solid |

Spanning is a connectivity test, not a stiffness guarantee: a mechanism-like topology can span an axis and still be nearly zero-stiffness along it.

**Thinnest feature** = 5th percentile of 2·d + 0.5 over the centers of maximal inscribed balls (voxels whose inside distance is at least that of all 26 neighbours), where d is the periodic Euclidean distance to the nearest void voxel. Checked on struts of known diameter (7.7, 15.4, 30.7 voxels → 7.7, 14.6, 30.0) and against the matrix's `voxels_across_feature` for sheet and skeletal runs (within about ±7 %).

### 1.4 Step by solid fraction

For parameters where solid is a threshold on a per-voxel quantity (TPMS level, sheet thickness, PI wall ratio, grain/noise level or half-width in the matching mode, imported-cell wall offset), *Step by → solid fraction* takes a range in % and finds the parameter value that gives each fraction **exactly at the chosen grid** (before island trim): the per-voxel quantity is computed once and each value is a quantile of it. Checked: A6 target 19.81 % → wall ratio 0.1897 (matrix 0.19), C3 32.5 % → c 0.5025 (0.5006), D4 20 % → c 0.918 (0.9138), each rebuilding to the target within 0.03 points.

## 2. Settings

- **Precision:** *Standard* — CG tolerance 1e-4, up to 300 iterations per load case (same as a normal run). *High* — 1e-5, up to 1,000 iterations. A6 at N = 64 on the CPU reference took ~60 iterations per load case at 1e-5.
- **Islands:** follows the Connectivity selector in the run controls (default *all networks · islands removed*, Matt's choice for the paper: faithful to how the cells are built). Each run records the voxel solid fraction before and after the trim; any run where the trim removed solid gets a note. On the §5 matrix the trim removes nothing on any run, B10 included.
- **Normalization:** solved with E_s = 110,000 MPa and divided out, so every stiffness is ÷ E_s.
- **Void stiffness (v0.10.1):** 1e-4, 1e-6 or 1e-8 × E_s; **sweeps default to 1e-6** (Matt, 2026-10-01). Normal lab runs keep 1e-4. At 1e-4 the void adds roughly 1e-4 to every direction, which inflated A1–A3 and the unloaded axes of B7 (§6). Lowering it doesn't change the iteration count. Recorded per run (`void_ratio`).
- **Second grid and extrapolation (v0.10.1):** *Second grid → one coarser / one finer* also solves each run one grid step away (within 32–128) and extrapolates element by element, C_ext = C_fine + (C_fine − C_coarse) / (2^p − 1), with engineering constants from C_ext. Order p is 1 or 2 (default 2: the F set measured ≈ 2 for PI-gyroid Ex and Ey, 1.4 for Ez, 1.2 for the sheet gyroid). The table shows extrapolated values (marked e; hover for both grids); the export keeps the run-grid values in the main columns and adds `grid2_*` and `ext_*` columns (21 C_ij, constants, ratios to the reference). *Off* (default) runs only the selected grid. **64 ↔ 128 pair (v0.12.1)** pairs every run with the other of grids 64 and 128 (grid 32 pairs with 64), so a whole matrix listed at mixed grids is extrapolated from one basis in one pass (Matt, 2026-10-01; recommended for the §5 production pass).

## 3. Results

Kept in the browser (IndexedDB `f13ld.lab.sweep`, migrated from the old localStorage key on first load), so a reload resumes; loading a new run list asks before clearing. *Clear selected* re-queues runs. Builder sweeps also export `param2_name param2_value`.

**Export CSV** — one row per finished run:

| Group | Columns |
|---|---|
| Run | `run_id tier set purpose grid_N nu_s cg_tol connectivity param_name param_value` |
| Solid fraction | `expected_vf_pct vf_voxel_pct` (before trim) `vf_measured_pct` (solved) `vf_check_rel_pct trim_removed_pct` |
| Stiffness ÷ E_s | `C11 C12 … C66` — the 21 upper-triangle terms. Voigt order 1–6 = xx, yy, zz, yz, xz, xy, engineering shear strain (C44 = G for an isotropic solid) |
| Engineering constants | `Ex Ey Ez Gyz Gxz Gxy` (÷ E_s), `nu_xy nu_xz nu_yz` |
| Solver record | `iters_total iters_xx … iters_xy final_residual_max converged wall_time_s` |
| Reference | `ref_Ex ref_Ey ref_Ez ratio_Ex ratio_Ey ratio_Ez` |
| Other | `notes` (build check, trim, convergence, no-load axes, negative shear terms, reference differences over 5 %), `error` |

**Axes with no load (v0.12).** The solver rejects a result when any axis modulus reads ≤ 0 or above the solid. Layers and strands have unloaded axes that read zero within solver noise — sometimes a hair negative (B6: Ex = Ez ≈ −6e-6 at void 1e-6). The sweep now keeps such a run, with a *no load on x, z* note, when the solve converged and every rejected axis is within 20 × the void stiffness of zero (at least 1e-5 ÷ E solid). Anything else is still an error, now with the reason and the values (*modulus outside 0 … E solid* or *did not converge*). A negative shear term (C44, C55, C66) gets its own note: not physical, rerun at high precision.

**Notes and warnings** under the run table fold into one line (*Notes and warnings (67) on 41 runs*); click to open. The open/closed state is kept while the sweep runs.

## 3b. Sweep Atlas (v0.11, v0.12)

**◈ Atlas** in the sweep bar opens an explorer over the current sweep's results (enabled once one run has finished; it also works mid-sweep and refreshes after each run). Everything is in-lab; F13LD brand colors on the dark theme. A self-contained HTML export is a later option — the lab is not MIT-licensed, so an export would carry results and views only.

| View | What it shows |
|---|---|
| Controls | Series (parameter-2 value for builder sweeps, CSV set otherwise), a slider through the series, run-grid vs extrapolated values (when a second grid was run), stiffness ÷ E solid or in MPa (material picked in the run controls, else the design's own) |
| Cell geometry | The lab's ray-marcher on the selected run's recipe, 1 cell or 2×2×2. Rebuilt once the selection settles, so the slider stays smooth |
| Directional Young's modulus | The lab's stiffness surface, E(n) = 1 / (vᵀ S v); readout of E max and its direction (dense sphere probe), E min, max / min, and a *strand-like* note when stiffness sits only in a narrow cone |
| Readout | Connectivity class, flags from the geometry check, solid %, Ex Ey Ez, Gyz Gxz Gxy, max / min E, and the 6 × 6 stiffness matrix as a heatmap (numerical zeros shown as 0) |
| Parameter map | Builder sweeps: parameter 1 × parameter 2 colored by connectivity, solid fraction, stiffest or softest axis, or Ez; unsolved and skipped cells marked; click to select. CSV sweeps: a table of the series |
| Stiffness vs solid fraction | Ex, Ey, Ez of the selected series on a log axis, with the Voigt bound; hollow points show the other grid when a second grid was run |
| Stiffness surface (v0.12) | Two-parameter builder sweeps: parameter 1 across, parameter 2 in depth, stiffness up — stiffest or softest axis, Ex, Ey, Ez, all three together (see-through, axis colors), the mean, a shear modulus or solid fraction; log or linear; colored by value or connectivity; contour lines on the floor; unsolved or skipped runs are holes. Hover for values, click to select. Drawn in lab code on a plain canvas (no extra WebGL context) |
| Design space | Every run; color = connectivity, shape = series; y = stiffest axis, softest axis, Ez or the mean |
| Data check | Runs solved, convergence, positive semi-definite matrices, shear terms positive, axes with no load, Voigt bound, stiffness rising with solid fraction within a series (drops over 3 % listed), connectivity counts, resolution and island-trim flags, any runs at void 1e-4 |

**3-D views (v0.12).** Geometry, stiffness surface and the stiffness-vs-parameters surface share a CAD tumble: drag to tumble about the screen axes (the part follows the cursor and can roll over the top), right- or shift-drag to pan, scroll to zoom toward the cursor, double-click or ⌂ for the isometric home view. An x/y/z triad sits in the corner of the geometry and modulus views. **⛓ linked** (default on) turns the geometry and the modulus surface together, so a stiff lobe lines up with the struts that carry it; click to unlink. The run slider moves in place while dragging; the readout, matrix, surface and charts follow live.

**Connectivity class** = number of eigenvalues of C above 1 % of the largest: 6 → connected 3-D lattice, 1 → strands only, otherwise partially connected. Directional moduli use the compliance of C with 1e-6 × max(Cᵢᵢ) added on the diagonal, so disconnected directions read near zero instead of failing.

---

## 4. Accuracy check against Vixiv (A6, before the sweep)

A6 — PI-gyroid (0, ⅛, ½), wall ratio 0.19, 19.83 % solid (no islands), ν = 0.403, CPU reference, tolerance 1e-5:

| Grid | Ex | Ey | Ez | vs Vixiv (Ex / Ey / Ez) |
|---|---|---|---|---|
| Vixiv | 1.637e-2 | 1.647e-2 | 4.066e-3 | — |
| N = 64 (12 voxels across the tube) | 1.456e-2 | 1.506e-2 | 3.791e-3 | −11 % / −9 % / −7 % |
| N = 128 (24 voxels across the tube) | 1.556e-2 | 1.575e-2 | 3.985e-3 | −4.9 % / −4.4 % / −2.0 % |
| Extrapolated (2 × N128 − N64) | 1.656e-2 | 1.644e-2 | 4.179e-3 | +1.2 % / −0.2 % / +2.8 % |

Doubling the grid roughly halves the gap, which is the first-order convergence expected from a stair-stepped voxel surface, and the extrapolated values land within ~3 % of Vixiv. So the gap is resolution, not a solver bias: lab stiffness approaches Vixiv's from below as the tube gets more voxels. The extrapolation assumes first-order convergence (two grids can't confirm the order). Solver record at N = 128: 329 CG iterations over six load cases (34–81 each), 2,539 s on the CPU reference; the GPU solve is much faster.

Consequence for the §5 matrix: runs at N = 64 with 8–13 voxels across the thinnest feature will read roughly 5–12 % low, runs at N = 128 roughly 2–5 % low. Partial-volume voxels (queued) should cut this error at a given grid.

## 5. PI tube width vs wall ratio

Gradient-normalized PI-TPMS tubes are round when thin but narrower than the nominal wall ratio in their thinnest direction as they thicken. Measured on the continuous field (25 tube-axis points refined to the local minimum of the PI distance, narrowest of 500 random chords each, step 0.002 T), PI-gyroid (0, ⅛, ½):

| Run | Wall ratio (nominal) | Narrowest width | Ratio |
|---|---|---|---|
| A1 | 0.05 | 0.050 T | 1.00 |
| A4 | 0.126 | 0.118 T | 0.94 |
| A6 | 0.19 | 0.166 T | 0.87 |
| A8 | 0.35 | 0.254 T | 0.73 |

The normalized distance is a first-order estimate (φ/|∇φ| and the angle between the surfaces at the point), so tubes flatten as the radius approaches the surfaces' curvature radius. F13LD.tpms uses the same formula, so this is the geometry both tools build — relevant wherever a paper quotes the thinnest feature of a PI structure from its wall ratio (e.g. the matched-feature comparison at 0.126 T: A4's narrowest width is 0.118 T).


## 6. First full run of the §5 matrix (Matt, GPU, 2026-10-01) — solver findings

All 41 runs converged (CG 1e-4, island trim on; it removed nothing). Whole matrix: 300 s; N = 128 runs ~19 s each.

- **GPU = CPU reference.** A6 at N = 64: GPU Ex / Ey / Ez 1.4564e-2 / 1.5051e-2 / 3.7866e-3, CPU 1.456e-2 / 1.506e-2 / 3.791e-3.
- **Void stiffness (1e-4 × E_s) inflates low-density runs.** A1–A3 read 1.0–1.4e-4 above Vixiv on every axis — a constant offset the size of the void stiffness — and B7's unloaded axes sit at ~1.9e-4. Test, A3 at N = 64 (CPU reference): void 1e-4 → 1e-6 drops Ex 1.115e-3 → 0.919e-3 (−18 %), Ey −22 %, Ez 3.43e-4 → 2.18e-4 (−36 %), with the same iteration count (326 vs 330). A3's apparent +6 % agreement with Vixiv at N = 128 is the void stiffening cancelling the stair-step softening. The offset matters wherever E is within ~100× of the void value (roughly under 20 % solid for these PI lattices).
- **Grid convergence (F set).** A5 PI at N = 32 / 64 / 128: observed order ≈ 1.9–2.0 for Ex and Ey; extrapolated Ex 4.570e-3, Ey 4.622e-3 vs Vixiv 4.579e-3, 4.625e-3 (−0.2 %, −0.1 %). Ez order ≈ 1.4, extrapolated +10 % above Vixiv (N = 128 alone is +5 %). C3 sheet: order ≈ 1.2, N = 128 is 1.6 % below the extrapolated 0.1271. (N = 32 is under-resolved, so the observed orders are indicative.)
- **Directional checks.** B3: E across [111] identical in every direction (spread < 0.01 %), 7.4× stiffer than along [111] (E[111] 1.18e-3; Vixiv ~8×, 0.0012). B9: within 2.4 % around [111] at every tilt (criterion 3 %), axis 4.27e-2, transverse 4.07e-2. B10: 19.6× stiffer along [111] than across (Vixiv ~23×). A-set and B1: Ez/Ex 0.23–0.29.
- **B8 vs B4:** B4 is 11.7× stiffer than B8 in their stiff directions (Vixiv 16.7×).
- **Fischer–Koch jump (G set) is a topology change.** Euler characteristic of the voxel solid at N = 128, (0, ⅛, ½): loops per cell 25 (wall ratio 0.15–0.16) → 33 (0.17) → 41 (0.175–0.19) → 57 (0.20–0.21). New tube-to-tube contacts form between 0.16 and 0.175 and again between 0.19 and 0.20. At fixed grid the lab's Ez rises 7× and Ey 2× from 0.17 to 0.19. G1 (0.17) sits mid-transition, which is why it disagrees most with Vixiv (Ez 0.46×): stiffness at a contact onset is very sensitive to resolution.
- **B6 (⅛, ¼, ⅜) — resolved: void stiffness.** At void 1e-4 the lab found Ex = Ez = 3.5e-4 where Vixiv reports ~0 (Ey matched, +4 %). The voxel solid is one network spanning x, y and z (N = 64 and 128, wall ratio 0.11–0.15), but at void 1e-6 (N = 64, CPU reference) Ex = Ez = −6.4e-6 — zero to solver accuracy — and Ey = 7.52e-4: the x/z stiffness was the void bridging the layers, not CG precision. Ey also dropped 23 % (it carried void stiffness too) and now sits 20 % below Vixiv at N = 64, the usual under-resolution, which the finer grid / extrapolation recovers.
- **Void 1e-6 is low enough.** A3 at N = 64: void 1e-8 vs 1e-6 changes Ex by −0.2 % and Ez by −0.6 %, same 330 iterations.

**Correction (§7):** the F-set agreement with Vixiv above (−0.2 %, −0.1 %) and the A3 match were at void 1e-4; at void 1e-6 the same extrapolation sits 5–6 % below Vixiv.

## 7. Void 1e-6 rerun of the §5 matrix (Matt, GPU, 2026-10-01)

Same matrix, void 1e-6 throughout, second grid one coarser (order 2). 40 of 41 solved; B6 was rejected by the solver's physicality check (*nonconvergent* label; its x/z read ≈ −6e-6) — v0.12 keeps such runs with a warning (§3).

- **The void offset was not a flat +1e-4.** In units of the void modulus it added 1.2–1.6× on sheet and skeletal runs, 1.1–4× on the A set and 4.5–8× on Fischer–Koch and near-contact PI lattices (B4, B8, B10, G). What decides the size is how soft the axis is (≲ 1e-2 ÷ E solid), not the solid fraction: G1 at 33 % solid lost 19–20 % on Ex and Ez, B4 / B5 11–13 % on Ex, B10 25 % on shear. Sheet and skeletal runs moved under 1 %.
- **Vixiv ratios, now consistent.** A1–A3 went from +6…+364 % high to 8–21 % low. Median run-grid ratio: 0.86 at N = 64, 0.89 at N = 128 (not the 2–5 % low read from the void-1e-4 A6 check). Extrapolated columns: median 0.93.
- **Grid convergence orders unchanged** (A5: Ex 1.84, Ey 1.95, Ez 1.35; C3 sheet 1.23), but the three-grid extrapolation of A5 now sits at 0.950 / 0.941 of Vixiv on Ex / Ey (Ez 0.975). A5's solid fraction matches Vixiv, so the remaining ~5 % is not resolution or solid fraction. One plausible reason: displacement-based finite elements on a finite mesh read slightly stiff, voxel FFT reads soft, so the true value lies between — unconfirmed.
- **B7 has a negative shear term:** C44 = C55 = −7.0e-6 (0.18 % of its largest eigenvalue, above solver noise), same sign on both grids. Rerun at 1e-5 to see whether it is tolerance (Matt rerunning B6 and B7 on his GPU).
- **Fischer–Koch jump persists and sharpens:** Ez × 8.5 from wall ratio 0.17 to 0.19 (was × 7.0; Vixiv × 3.5).
- **Iterations:** median +1.6 %; contact lattices rose more (G3 +48 %, hitting the 300 cap on yy at residual 1.003e-4; B5 +20 %; B10 +14 %). The main solves were no slower (N = 128 median 17.1 s vs 19.0 s).
- Full tables: the analysis report kept with the session (`void_1e-6_report.md`).

## 8. Matched-feature comparison on measured geometry (Matt, 2026-10-01)

Decision: compare at the feature size the lab actually builds, not the prescribed wall ratio. The sheet (C4) and skeletal (D7) baselines stay as given in the matrix; physical differences go in a comparison note in the paper.

**Matched PI run: A4m, wall ratio 0.1364** (pipe radius 0.0682 T), solid 11.63 % at N = 64. Its narrowest tube width is 0.126 T on the continuous field, matching the 0.126 T thinnest feature the matrix gives C4 and D7. A4 (wall ratio 0.126) builds 0.117–0.120 T.

| Run | Setting | Solid % (N = 64) | Narrowest tube width, continuous field: min / median / max | Voxel thinnest (5th pct, N = 256) | Voxel median (N = 256) | Matrix says |
|---|---|---|---|---|---|---|
| A4 | PI wall ratio 0.126 | 10.29 | 0.117 / 0.118 / 0.120 T | 0.113 T | 0.119 T | thinnest 0.126 T |
| **A4m** | PI wall ratio 0.1364 | 11.63 | 0.124 / **0.126** / 0.129 T | 0.122 T | 0.127 T | — |
| C4 | sheet, c = 0.6453 | 42.03 | — | 0.124 T | 0.146 T | thinnest 0.126 T, mean wall 0.14 T |
| D7 | skeletal, c = 1.2786 | 6.92 | — | 0.130 T | 0.151 T | thinnest neck 0.126 T, median strut 0.138 T |

**Methods.** *Continuous field* (PI only): 60 tube-axis points (local minima of the PI distance), at each the narrowest of 600 chords through the point, step 0.001 T, same field formula as the lab and F13LD.tpms. Bisection on wall ratio for a median of 0.126 T gave 0.1364 (the 5th percentile is 0.126 T as well). *Voxel*: the lab's thinnest-feature measure (maximal inscribed balls of the periodic distance transform, 2√d + 0.5), at N = 256 for resolution, after island trim. The two disagree for PI: voxel bisection to 0.126 T would give wall ratio 0.143. The likely cause is that a flattened tube's medial axis widens into a ribbon whose edge balls are smaller than the tube's true minor width, pulling the voxel 5th percentile ~3–4 % low; the continuous chord measures the minor width directly, so it sets A4m. For skeletal struts the voxel median includes node balls and reads high. Under the one voxel measure the trio reads C4 0.124, D7 0.130, A4m 0.122 T — within about ±4 % of 0.126 T, which is the size of difference to state in the comparison note.

**To run:** `PI-TPMS_section5_matched_feature.csv` (A4, A4m, C4, D7; same columns as the §5 matrix). Loading it replaces the current sweep in the browser, so export the 41-run results first (the panel asks).

**Results (Matt, GPU, CG 1e-5, void 1e-6, N = 64 + 128, extrapolated order 2; ÷ E solid):**

| Run | Solid % | Ex | Ey | Ez | E[111] | Directional mean E | E max (direction) | Mean E ÷ solid fraction |
|---|---|---|---|---|---|---|---|---|
| A4 (prescribed 0.126) | 10.29 | 0.00383 | 0.00392 | 0.00094 | 0.00390 | 0.00330 | 0.00573 (0, 0.88, 0.48) | 0.032 |
| **A4m (measured 0.126)** | 11.63 | 0.00513 | 0.00512 | 0.00124 | 0.00532 | 0.00444 | 0.00763 (0, 0.88, 0.48) | 0.038 |
| C4 sheet | 42.03 | 0.185 | 0.185 | 0.185 | 0.212 | 0.201 | 0.212 [111] | 0.477 |
| D7 skeletal | 6.92 | 0.00290 | 0.00290 | 0.00290 | 0.00689 | 0.00468 | 0.00689 [111] | 0.068 |

- Re-basing on measured width adds 13 % solid and 31–34 % stiffness on every axis; the anisotropy is unchanged (Ez / Ex 0.24).
- At a matched 0.126 T feature, A4m is 1.77× stiffer than D7 along x and y, 0.43× along z, and about equal on the directional mean (−5 %), with 1.7× the solid. C4 is ~40× stiffer at 3.6× the solid.
- D7 is strongly cubic-anisotropic (E[111] = 2.4 × E axis), so axis-only comparisons understate it; report the directional mean or E max / E min alongside the axis values.
- Grid: N = 128 is 2.5–3.2 % below the extrapolated value for PI and skeletal (0.6 % for the sheet); N = 64 is 11–14 % low. Use the extrapolated columns.

**Matrix update (Matt, 2026-10-01):** A4m is now a permanent row of the §5 matrix (42 rows; A4 kept as the prescribed-width reference), and E1 — the ν = 0.34 Poisson check of the matched PI point — moved to A4m's wall ratio (0.1364, expected 11.63 % solid). The matrix CSV and its write-up live with Matt (not in this repo).

**Production pass for the paper (next):** the 42-row matrix at High precision (1e-5), void 1e-6, second grid **64 ↔ 128 pair**, order 2 — about 15–20 min on Matt's GPU. It also reruns B5, B6, B7 and G3 at the tighter tolerance.

## 9. Production pass — 42-row matrix (Matt, GPU, 2026-10-01)

High precision (CG 1e-5), void 1e-6, second grid **64 ↔ 128 pair**, order 2. 42 of 42 solved (F1 / F3 pair 32 + 64), 23 min total. Every matrix (run grid and extrapolated) is positive semi-definite. Only G3 is flagged: its N = 128 solve converged, its N = 64 partner stopped at 1,000 iterations (residual 3.8e-5).

**Against Vixiv** (63 axis values with a reference; extrapolated unless stated): median **0.945** (IQR 0.92–0.96). N = 128 alone 0.917, N = 64 alone 0.80. The ratio rises with solid fraction (A1 ≈ 0.93 → A8 ≈ 0.97), the resolution signature. Low outliers: G1 (Ez 0.40, Ey 0.75 — contact onset), A2 Ey 0.88, G3 Ey 0.87, B5 0.90, B10 0.91.

| Check | Lab | Vixiv / expectation |
|---|---|---|
| A-set density exponent (power-law fit, Ex / Ez) | **2.08 / 2.12** (local 2.03–2.12) | Vixiv at the same points 2.07 / 2.11 |
| Sheet (C) / skeletal (D) exponent | 1.42 / 2.20 | — |
| A-set Ez / Ex | 0.24–0.25 (B1 0.22) | ≈ ¼ |
| B3 across / along [111] | 8.2×, identical in every direction across | ~8× |
| B9 transverse isotropy | spread < 0.01 % around [111]; axis 0.0437, transverse 0.0407 | within 3 %; 0.046 / 0.042 |
| B10 along / across [111] | 23.9× | ~23× |
| B4 / B8 on their stiff axes | 17.0× | 16.7× |
| B6 | Ex, Ez ≈ +3e-6 (zero), Ey 0.97 of Vixiv | stiffness along y only |
| B7 | shear terms now positive (8e-7) | strands — the v0.12 negative shear was CG tolerance |
| G set Ez, wall ratio 0.17 → 0.19 | × 8.1 | × 3.5 |
| Poisson check E1–E3 vs A4m / C4 / D7 (directional mean) | +0.2 % / −0.1 % / +1.1 % | ranking holds at ν = 0.34 |

**Grid convergence (F set, three grids):** A5 Ex / Ey / Ez order 1.82 / 1.95 / 1.41; the 64 + 128 order-2 extrapolation agrees with the three-grid value within 0.5 % on Ex / Ey and 2 % on Ez. Shear converges at order ≈ 0.8, so order-2 extrapolated shear moduli read ~6 % low — quote shear with that caveat. C3 sheet order 1.23.

**B8 nuance:** on its axes B8 is 17× softer than B4 (matching Vixiv), but it has a needle-like lobe along the face diagonal [011] (E max 0.068, above B4's 0.052); only 1 % of directions reach 20 % of that. It is stiff only along strands — relevant to the "crossing junctions don't make a lattice stiff" point.

**Lower-confidence points:** A1 (3.2 voxels across at N = 64; its extrapolation adds ~12 % over N = 128), G3 (partner grid unconverged; extrapolation +3–4 % over N = 128 — quote N = 128 or note it), F1 (intentionally coarse). Build checks within 3 %: B3 −2.2 %, F1 −2.9 %, A2 −1.2 %, D7 / E3 −1.1 %.

