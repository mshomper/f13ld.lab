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
