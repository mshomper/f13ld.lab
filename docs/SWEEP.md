# F13LD.lab — Parameter Sweep (v0.10.0)

**Open:** ⟳ Sweep in the header. The panel can be closed while a sweep runs; the header button shows progress (e.g. *Sweep 12/41*). Run All is blocked while a sweep is running, and a sweep won't start during a run.

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

### 1.2 Build one from a loaded design

Pick a design, one parameter, a start, an end and a number of steps (linear, up to 200), a grid and a Poisson's ratio.

| Design | Parameters |
|---|---|
| TPMS solid | Level |
| TPMS sheet | Sheet half-thickness (c), level offset |
| PI-TPMS | Wall ratio (tube diameter ÷ cell), shift x / y / z (cycles) |
| Grain, noise | Level, half-width |
| Imported STL cell | Wall offset (mm) — the same control as the import dialog's slider |

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
- **Void stiffness:** 1e-4 × E_s (the lab's standard). Directions a topology can't carry (B6, B7) therefore read about 1e-4, not zero.

## 3. Results

Kept in the browser (localStorage `f13ld.lab.sweep.v1`), so a reload resumes; loading a new run list asks before clearing. *Clear selected* re-queues runs.

**Export CSV** — one row per finished run:

| Group | Columns |
|---|---|
| Run | `run_id tier set purpose grid_N nu_s cg_tol connectivity param_name param_value` |
| Solid fraction | `expected_vf_pct vf_voxel_pct` (before trim) `vf_measured_pct` (solved) `vf_check_rel_pct trim_removed_pct` |
| Stiffness ÷ E_s | `C11 C12 … C66` — the 21 upper-triangle terms. Voigt order 1–6 = xx, yy, zz, yz, xz, xy, engineering shear strain (C44 = G for an isotropic solid) |
| Engineering constants | `Ex Ey Ez Gyz Gxz Gxy` (÷ E_s), `nu_xy nu_xz nu_yz` |
| Solver record | `iters_total iters_xx … iters_xy final_residual_max converged wall_time_s` |
| Reference | `ref_Ex ref_Ey ref_Ez ratio_Ex ratio_Ey ratio_Ez` |
| Other | `notes` (build check, trim, convergence, reference differences over 5 %), `error` |

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

