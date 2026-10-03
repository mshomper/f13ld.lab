# F13LD.lab

**Status:** v0.10.0 · alpha · **parameter sweep** · **STL unit-cell import** · PI-TPMS parity · connectivity selector · fast nonlinear crush · **Sprint B — voxel-FE buckling** · buckling now by matrix-free voxel finite elements (void removed) · yield- vs buckling-limited on every card · AM material library · axis-convention fix
**License:** [PolyForm Noncommercial 1.0.0](./LICENSE.md): free for research and non-commercial use; anyone may run it to reproduce published results (see [NOTICE](./NOTICE)). Commercial licences: matt@notarobot-eng.com

🔗 **[Launch the tool](https://mshomper.github.io/f13ld.lab)**
📓 **[Per-phase engineering logs](./docs/)** — handoff-quality records of every phase, decision, and bug

GPU-accelerated qualification tool for deep structural evaluation of metamaterial scaffolds. Browser-resident, statically hosted, designed for side-by-side comparison of up to three designs from F13LD.vault.

Part of the [F13LD](https://f13ld.app) computational design suite.

---

## What this is

F13LD's design tools (TPMS, Grain, Noise, Bundle) are fast and exploratory — built around real-time WebGL raymarching with MIL-HS for design-time property estimation. F13LD.lab is the qualification half of the workflow: same browser tab, but compute-deep instead of compute-fast. Linear elastic, linear buckling, nonlinear plasticity, thermal, and Stokes permeability — at solver fidelities the design tools deliberately don't reach for.

Where design tools answer *"what does this look like?"*, lab answers *"is this design actually good for production?"*

## Hardware requirements

- WebGPU-capable browser (Chromium 124+, Safari 18+, Firefox with `dom.webgpu.enabled`)
- Discrete or modern integrated GPU recommended; WASM CPU fallback exists but is 10–20× slower
- 4 GB+ VRAM for default tier (64³ grid · 3-design comparison · full pipeline)
- 8 GB+ VRAM for high-fidelity tier (128³ grid)
- Linear buckling runs on CPU workers (no GPU required for that tab) but the page must be served over **http(s)** — Blob-worker `importScripts` is blocked under `file://`

## Compute envelope

| Mode                            | N=64 · 1 design | N=64 · 3 designs |
| ------------------------------- | --------------- | ---------------- |
| Linear elastic (full Voigt 6×6) | ~4 s †          | ~12 s †          |
| + Nonlinear (J2 + geom)         | ~2.5 min        | ~7.5 min         |
| + Stokes permeability           | ~3 min          | ~9–10 min        |

† Full-Voigt runs ≈2× the Phase 3 normal-only figures (6 load cases vs 3); N=64 timing is predicted, not yet measured — validated at N=16 and N=32. 10-minute ceiling for default tier. F13LD = FAST.

**Linear buckling** runs on a CPU Web Worker pool, independent of the GPU grid above. The Buckle pill now offers **16³ / 32³ / 64³** — 8³ was dropped (too coarse for thin-wall shells) and all options are powers of two because the radix-2 FFT requires it (48³ is not available). Cost scales steeply with grid: Schwarz P three-axis is seconds at N=16 and minutes at N=64 on an 8-core desktop, one axis per worker. A complete GPU buckling solver (`16d`) exists and is numerically validated, but is **off by default** — see *What's new in v0.7.1*. See [`docs/BUCKLING.md`](./docs/BUCKLING.md).

**Nonlinear crush** runs at its own resolution (the Nonlin pill, default 16³ — not the elastic grid) and to a user strain cap (default 5%). It is the slowest stage (sync-bound CG); per-mode timing and a self-calibrating estimate now scale each mode by its own grid (and nonlinear by the crush cap), with a live ETA. See [`docs/NONLINEAR.md`](./docs/NONLINEAR.md).

## What's new in v0.17.0

**Interactive stress–strain plot.** The Nonlinear tab's comparison plot is now drawn with Plotly (basic bundle vendored in `vendor/`, MIT, loaded only when the tab first shows a curve; the previous SVG plot stays as the fallback). Hover reads every curve at that strain (σ and × own yield); drag to zoom, range slider underneath, double-click to reset, PNG export at 3×. **Stress** switch: MPa / log / ÷ own yield (opens on ÷ own yield when strengths differ more than 20×). **Focus** switch: X / Y / Z drive the preview cubes too, All shows every axis bold with each design's weakest yield and lowest buckling ratio labelled. Legend chips hide a design or one axis. Curves are spline-smoothed through the solver points. Off-scale buckling lines become tags above the plot.

**Scrubber ↔ plot.** The crush scrubber is now one strain timeline for every cube, and an amber cursor on the plot follows it (and the auto-play). Hovering the plot scrubs the cubes to that strain; clicking pins it; Play resumes. Crush metric cards are now KPI cards (modulus and yield on the preview axis, weakest axis, buckling-to-yield, load capacity, warnings).

## What's new in v0.16.3

**Crush: side-stress limit follows each design's precision.** For very compliant designs (around 1/3,000 of the solid's stiffness) the crush cannot resolve the side stress to 2 % at the GPU's single precision — a foam's first, purely elastic step stayed at 22.6 % after 8 corrections — and v0.16.1–2 then halved every step four times (~40 solves a step). Now the first step measures the design's own floor; later steps use max(2 %, 1.5 × floor), with at most one retry per step before the best attempt is accepted. v0.16.2's size cap and overshoot rule are removed (they stalled the foam). The console logs the floor; above 5 % the Nonlinear tab marks the curve **post-yield approximate** (metric card and legend). The elastic slope and yield onset hold either way.

## What's new in v0.16.2

**Crush: safer side-stress corrections.** On a very compliant design (a pi-TPMS at about 1/3,500 of the solid's stiffness) the cell's average stress is tiny next to the stresses inside its sheets, so single-precision noise is visible in the side stress, and the stiffness v0.16.1 learned from it could go bad — one Z crush reused a bad estimate on every retry and stalled in five failed solves. Now: every retry starts again from the elastic stiffness; a correction that at least doubles the side stress is half taken back and not learned from; no single correction moves the sides by more than the step's axial strain; and the attempt with the lowest side stress is kept (if it is within 2 %).

## What's new in v0.16.1

**Crush: side stress now settles after yield.** The crush holds the sides of the cell stress-free while it squeezes one axis. That correction used the cell's elastic stiffness and allowed 4 tries; once a compliant design yields it is far softer sideways, the correction fell short, and steps were accepted with up to 19 % side stress left — partly confined, so the curve climbed faster than the elastic slope after yield (a pi-TPMS at the new soft void; the old stiff void had hidden it). Now the sideways stiffness is learned from each correction (Broyden secant update, carried from step to step), up to 8 corrections are allowed, and a step whose side stress is still above 2 % of the axial stress is cut back and retried. The console reports cut-back steps and warns if a step had to be accepted above 2 %.

## What's new in v0.16.0

**Crush on all three axes.** The Crush axis selector has **All (XX·YY·ZZ)**: each design is crushed along X, Y and Z in turn (about 3× the crush time; the estimate accounts for it). Axes already solved with the same grid, strain cap and design are reused, so running X, Y and Z one at a time builds the same set. The stress–strain plot draws every crushed axis on one chart — colour is the design, line style is the axis (X solid, Y dashed, Z dotted). An **X / Y / Z switch** next to the scrubber picks the preview axis: its cubes, metric cards (with the other axes' modulus and yield listed), and its curves drawn bold with the 0.2% offset line, yield label and buckling line. Design cards use the **weakest axis** for Yield Strength and Load Capacity, and the buckling-to-yield ratio is the lowest of the per-axis ratios (each axis's buckling over that axis's yield).

**Void scaled to the design.** Empty space is modelled as a very soft material. At the old fixed values (1/10,000 of the solid for linear runs, 1/1,000 for the crush) that filler carried a large share of the load in ultra-compliant designs: a gyroid × Fischer-Koch S pi-TPMS read 44 MPa on the card and 166 MPa as the crush modulus, against 30.4 MPa with a void of 1/1,000,000 — at the same iteration count. Now the void is 1 % of the design's own stiffness (rounded down, floor 1/1,000,000; never stiffer than the old values): a linear run whose softest axis is under ~0.5 % of the solid is re-solved once with the scaled void, and each crush axis uses 1 % of that axis's linear modulus (1/10,000 when Elastic did not run). The stress–strain header shows the void used; cards and crush metric cards say **void-limited** when a stiffness is within 50× of the void.

**Sweep Standard preset: 300 → 1000 iterations** (tolerance unchanged); the export adds `cg_maxiter`. Re-run list for the foam calibration: `docs/foam-calibration/foam_rerun_1000_runs.csv` (`FOAM_CALIBRATION.md` §10).

**Elastic iteration cap 300 → 1000.** The normal (non-sweep) elastic solve allowed 300 iterations per load case; disordered designs (foams, spinodoids) often stopped there, and because the solve starts from a uniform strain a stopped solve reads stiff. The cap is now 1000, and a card shows **not converged · N it** on its modulus rows when a load case still stops at the cap.

## What's new in v0.15.1

**Sweep export (v0.15.1)** adds the second grid's own solid fraction (`grid2_vf_voxel_pct`, `grid2_vf_measured_pct`), its convergence and per-load-case iterations. **Foam fit page:** `docs/foam-calibration/foam-fit.html` — drop in sweep exports to fit and chart F13LD.foam's stiffness laws (see `docs/FOAM_CALIBRATION.md`).

## What's new in v0.15.0

**Faster sweeps (v0.15.0).** Sweep solves (no per-voxel fields) run on a new elastic path, `16i-elastic-fast.js`: the CG loop stays on the GPU (one small readback per block of iterations instead of two blocking readbacks every iteration), the spectral operator packs two real fields per complex FFT (one batch-3 transform pair per iteration instead of twelve transforms), Γ is built once per grid and kept on the GPU instead of rebuilt in double precision for every solve, and the solver allocates only the buffers it uses. Same operator, same conjugate gradient and the same stopping test, so results match the previous path to float precision. The sweep CSV gains `solver` (fast / legacy) and `gamma_build_s`. `window.LAB_FAST_ELASTIC = false` switches back; `await runElasticFastTest(64)` in the console compares the two paths.

## What's new in v0.14.0

**F13LD.foam family (v0.14.0).** Voronoi foams from F13LD.foam v0.3.0+ — open (struts on cell edges), closed (walls on cell faces) and plateau (open with swollen junctions), with organic node growth and per-axis stretch — load like any other design: drop or pick the JSON, or use **⚗ Open in F13LD.lab** in F13LD.foam v0.4.0 (an inline `#r=` link, which the lab now reads). The field is a byte-for-byte port of F13LD.mesh's foam builder (`13d-foam-kernel.js`), so the lab homogenizes exactly the geometry mesh exports; `validate-foam.js` checks the copies in lab, mesh and foam match. Only periodic foams are accepted (a non-periodic cube isn't a valid unit cell). The sweep builder steps foam thickness (exact solid-fraction targeting), plateau k, organic, stretch x/y/z, and — by regenerating the seeds with the tool's own generator — cells per tile, regularity, Lloyd iterations and the random seed (realizations). Run-matrix CSVs take `family = foam` rows. A 48-run calibration study for F13LD.foam's stiffness estimate is ready to run: [`docs/FOAM_CALIBRATION.md`](./docs/FOAM_CALIBRATION.md).

## What's new in v0.13.0

**PI-TPMS field pairs (v0.13.0).** Recipes from F13LD.tpms v1.1.0 can cut PI-TPMS pipes from two different fields: field A crossed with an independent field B (any preset or custom terms) at a whole-number multiple of A's frequency. Lab reads `surface_b`, `geometry.field_b_freq` and `geometry.field_b_scale` (field B is matched to A's amplitude; recomputed on the same 16³ grid as F13LD.tpms / F13LD.mesh when absent). The solvers, the sweep's solid-fraction targeting and the 3-D view (field B on its own texture) all use the pair; plain self-pairs take exactly the old path. Pair designs are titled "A × B (k×) · pi-tpms".
- **Fix:** PI-TPMS designs on split-P or F-RD now include the preset's built-in constant (−0.3 / +0.3) in the solve, as F13LD.tpms, F13LD.mesh and the Lab viewer already did. Results for those two presets in PI-TPMS mode change; nothing else does.

## What's new in v0.10.0

**Parameter sweep** (⟳ Sweep). Run a list of elastic homogenizations and export the stiffness of each: the 21 upper-triangle terms ÷ solid modulus, Ex…Gxy, solid fraction before and after island trim, iterations, final residual and wall time. Make the list from a run-matrix CSV (surface, PI / sheet / skeletal mode, shift, wall ratio or level, grid, Poisson's ratio, optional expected solid fraction and reference stiffness) or by sweeping one parameter of a loaded design (level, sheet thickness, PI wall ratio or shift, grain/noise level or half-width, wall offset of an imported STL cell). Precision toggle: CG tolerance 1e-4 or 1e-5. Before solving, every run's geometry is checked in a background worker: empty, fully solid and no-load-path runs are skipped; partial spanning, under 2 % or over 95 % solid, thinnest feature under 6 voxels and solid-fraction mismatches are flagged. Parameters can also be stepped by solid fraction (exact at the chosen grid). Void stiffness is selectable (sweeps default to 1e-6 of the solid), and each run can be paired with a coarser or finer grid and extrapolated. Results persist across reloads. **v0.11:** the builder sweeps one or two parameters of any family (beam, bundle, wave, foam, grain, noise, TPMS, PI-TPMS, imported cells) and reviews every combination before creating runs — total solves, estimated time on this machine, solid-fraction map, skipped and thin-feature runs. **◈ Atlas** explores the results: cell geometry, directional-modulus surface, stiffness matrix, parameter map, stiffness vs solid fraction, design space and a data check. **v0.12:** CAD tumble on every 3-D view with linked geometry ↔ stiffness rotation, a 3-D stiffness surface over two swept parameters, a smooth run slider; runs whose unloaded axes read ≈ 0 are kept with a warning; sweep notes fold away. **v0.12.1:** the sweep panel is three sections (define runs: builder or CSV tabs · run settings · runs), with ↺ New sweep, ✕ remove for a loaded CSV, a renamable study title and a 64 ↔ 128 second-grid pairing for one extrapolation basis across a matrix. **v0.13:** sweeps can step field B's frequency multiple (whole numbers) on PI-TPMS designs. **v0.14:** foam designs and `family = foam` CSV rows. See [`docs/SWEEP.md`](./docs/SWEEP.md).

## What's new in v0.9.1

**STL import: fewer false "not periodic" flags.** Cell faces are now found from the CAD trim planes instead of the bounding box, and geometry that pokes slightly past a face (walls thickened after trimming) is wrapped to the opposite side, as the neighbouring cell would place it. Face match now judges each spot against how the walls move just inside the cell, so walls meeting a face at a shallow angle no longer count against it. Green ≥ 95 %, amber 80–95 % (a note in the report), red < 80 % (card tagged). Click a face-match chip to see the two faces overlaid.

## What's new in v0.9.0

**Import a unit cell from any CAD program as an STL** (*+ Import STL*, drop an `.stl` on the page, or pick one in *+ Add Design*). The cell is turned once into a periodic signed-distance grid (128³, stored in the browser by content hash), and a new `import` kernel family samples it, so stiffness, crush, buckling, connectivity, density and the viewer all run on it unchanged.
- **Import report before adding:** density, face match per axis (do opposite faces line up — is this one full period?), whether the solid spans the cell on each axis and how many networks it forms, thinnest wall with voxels at N = 32 / 64 / 128 and a recommended grid, and mesh health (open / non-manifold edges, watertight).
- **Units and cell size:** mm or inch. *Fit to part* uses the bounding box; sides within 2 % of each other (typical CAD export) are accepted as a cube. *Set* takes a cell size and centers the part. Cells with unequal sides are refused for now.
- **Wall offset slider** thickens or thins every wall evenly (live preview and density), also adjustable later from the card (⚙).
- **Save with geometry** (⤓ on the card): a JSON with the grid embedded (~100–300 kB) that reloads anywhere through *+ Add Design*.
- **Robust fill:** inside/outside is decided by scanlines along x, y and z with a majority vote, so small gaps and flipped triangles are tolerated; broken meshes are flagged.
- Validated against native recipes meshed to STL: Schwarz P density / stiffness / buckling within 0.01 %; gyroid sheet density −0.1 %, stiffness −0.2 %, buckling −2.3 % (N = 32). See [`docs/STL_IMPORT_SCOPE.md`](./docs/STL_IMPORT_SCOPE.md).

## What's new in v0.8.2

**PI-TPMS and shell parity with F13LD.tpms.**
- **Normalization now survives import.** `pi_normalize` and `shell_normalize` from F13LD.tpms / F13LD.mesh recipes were dropped on import, so imported PI-TPMS and shell designs were analyzed un-normalized (your gyroid PI-TPMS: 8.9 % instead of 9.84 % volume fraction — Lab now matches the tpms app's 9.84 % exactly at 48³). Recipes without the flags stay un-normalized, so older results do not change.
- **The viewer draws what the solver analyzes:** normalized PI-TPMS pipes (angle-corrected distance to the surface intersection, same constants as F13LD.tpms) and normalized shell walls.

**Connectivity selector** (replaces *Prune islands*): *All networks · remove islands* (default — keeps every network that runs continuously through the tiled structure, e.g. both sides of an interwoven PI-TPMS), *Largest network only* (one side of the weave), or *Keep everything*. Buckling always removes floating islands (free bodies) and solves interwoven networks separately: they share the applied strain, so the weakest network sets the critical strain and their stiffnesses add.

## What's new in v0.8.1

**Nonlinear crush: correct and fast.**
- **Root cause of the slow, erratic crush:** after every change of the applied macro strain, the Newton residual kept a uniform (mean-strain) part the operator cannot remove, so CG ran on an effectively non-symmetric system — hundreds to 1,000+ iterations per solve, occasional divergence, cutbacks, and run times that did not track grid size. The strain field's mean is now reset to the applied strain before each solve.
- **Less over-solving:** the CG tolerance follows the Newton residual (inexact Newton); failing attempts stop after three strikes instead of 12 Newton iterations; each load step starts from an extrapolated strain field.
- **GPU-resident CG:** scalars stay on the GPU, one small readback per block of up to 16 iterations (was 2 per iteration), cached bind groups, batched real-pair FFTs.
- **Measured (software WebGPU, counts):** Schwarz P N=16 — CG iterations 9,300 → 175, GPU readbacks 18,826 → 235; spinodoid N=32 — CG 14,200 → 523. Results match the previous solver (σ_y within 0.3 %; the old solver's capped steps were up to 1.5 % off). Legacy path: `window.NL_FAST = false`; per-solve trace: `window.NL_TRACE = true`.

**Stress–strain plot:** axes fit the curves; buckling far above a curve becomes a tag instead of squashing the plot; curves start at the origin with 0.2 %-offset lines; MPa / ÷ own-yield toggle; collision-aware labels; values on hover.

## What's new in v0.8.0

**Buckling rebuilt on voxel finite elements.** The spectral buckling operator had hundreds of zero-energy patterns in the solid (510 on an all-solid 8³ cell; 3 are legitimate rigid translations), so its eigen-solve found void-controlled artifacts: the critical load tracked the stiffness assigned to empty space (Schwarz P, N=16: 4.4 / 43.7 / 422 / 3270 MPa for void ratios 1e-5 … 1e-2). Every buckling number before v0.8.0 came from that artifact.

- **Method (`16h-buckling-fe.js`).** One incompatible-modes hex (H8I, the Abaqus C3D8I family) per solid voxel; void voxels have no elements. Constant 24×24 element matrix, matrix-free, multigrid-preconditioned prestress and LOBPCG, free-sided uniaxial loading, largest connected component always kept.
- **Validated.** Periodic plate benchmark within 1.1 % of the exact continuum answer at N=32 (≈4 % at N=16), accurate down to 1-voxel walls; exactly 3 zero-energy modes; results identical to the Sprint B prototype (`proto/fe-buckling/`). Console: `runFEBucklingSelfTest(32)`.
- **Fast, and fastest on sparse designs** (void costs nothing): Schwarz P at N=32 ≈ 34 s per axis in a slow single-thread sandbox; P and gyroid sheets ≈ 12 s. Axes run in parallel on the worker pool.
- **What it says about typical Ti lattices:** Schwarz P solid (ρ 0.50), P sheet (ρ 0.14) and gyroid sheet (ρ 0.13) all yield first — buckling strength 9–25× the yield strength.
- **Cards.** Every design card now shows its governing failure: *Yield-limited* (jade) or *Buckling-limited* (amber), with the buckling-to-yield factor; *est.* when the yield comes from the solid material rather than a crush run; *Limit undetermined* when the crush never reached yield.
- The spectral path remains for comparison only (`opts.method = 'spectral'`); the spectral GPU port (16d) is disabled for the FE default.

## What's new in v0.7.2

**Numbers you can trust (Sprint A).**
- **Axis convention fixed.** The elastic solver relabeled X↔Z (`SWAP = [2,1,0,5,4,3]`) to hide a viewer transposition; on anisotropic designs Ex/Ez, Gyz/Gxy, the Poisson ratios, the stiffness surface and the "ZZ" crush axis were mislabeled, and stress / mode / α overlays sat on the wrong voxels. The solver frame is now the physical frame, the viewer transposes solver fields at upload, and `runAxisConventionGPUTest()` (z-laminate) guards it.
- **Voce hardening now runs.** Recipe materials replaced the Ti-6Al-4V default instead of overriding it field by field, so every crush used 880 MPa + linear hardening. Yield on Schwarz P N=8: 201.8 → 233.2 MPa.
- **Yield detection.** Implicit (0,0) origin for the 0.2 % offset, knee step refinement, honest step-budget truncation, lateral-stress miss recorded, CPU oracle now runs the GPU's macro loop.
- **Buckling.** Free-sided (uniaxial-stress) prestress by superposition of the axis solves (6 when shear-coupled); eigen-solve cap 30 → 200 with a leading-mode residual guard and a "not converged" flag (the 30-iteration cap had been stopping 2–9× high). The λ tile is now **Critical Strain**. (Superseded by voxel-FE buckling in v0.8.0.)
- **Labels.** "J2 + geom" → "J2 plasticity (small strain)" — there is no geometric nonlinearity in the crush.

**Materials.** A **Material** pill applies one of 45 AM materials (Ti-6Al-4V Grades 5/23 in as-built, stress-relieved, annealed, HIP and EBM conditions; CP-Ti; Ti-6Al-7Nb; β-Ti; 316L; 17-4PH; 15-5PH; maraging; IN718; IN625; Hastelloy X; Haynes 282; AlSi10Mg; Scalmalloy; A20X; 6061-RAM2; CoCrMo; Ta; Nb; GRCop-42; CuCrZr; PA12; PEEK; PEKK; NiTi) to every design, with fitted Voce hardening. Materials without a usable yield model (most polymers, NiTi) skip the crush with a reason. Values and sources: `docs/MATERIALS.md`.

**Geometry.** Hyperuniform kernels are wrapped periodically, matching how F13LD.mesh exports them (the design cell's kernels copied into every cell). Face starvation and the island loss it caused are gone (ρ 0.172 → 0.190 on the demo). `field.hu_wrap = false` restores the old behavior.

**Reliability.** Per-run tokens (Cancel → Run can no longer run two sweeps), worker-pool cancel, crash recovery, cache keys that include the recipe and material, GPU device-lost recovery, voxel density on the cards, no invented numbers before a run, unique import ids, `?r=` import on first visit, timing estimate that ignores cached designs.

## What's new in v0.7.1

Buckling resolution raised, and a full GPU buckling port built, validated end-to-end, and then deliberately shelved.

### Buckle + Nonlinear grids → 16 / 32 / 64

- Both the Buckle and Nonlin pills now cycle **16³ → 32³ → 64³** (8³ removed). 8³ under-resolves thin-wall shells; N=64 resolves a 0.3 mm wall in a 5 mm cell (~3.8 voxels). All options are powers of two — the radix-2 FFT (`fft3dCpu`) hard-requires it, so 48³ is intentionally not offered.

### Under-resolved designs now say so

- When the cell-periodic buckling guard skips a design (sub-voxel features → too few interior voxels, or a disconnected/multi-component solid), the design card turns **amber with the reason** ("under-resolved at N=… — raise grid") and the run-complete banner names the skipped designs, instead of rendering a silent blank that read as "buckling didn't run."

### GPU buckling solver — validated, not shipped

- A complete WebGPU buckling solver (`16d-buckling-solver.js`) was built and validated against the CPU oracle: operators (applyK, applyKg, Γ⁰ preconditioner) to ~1e-7, a GPU-resident PCG at 6.8× the per-readback path, prestress extraction, and a block subspace eigensolver with **batched Gram reductions** (2·s² readbacks/sweep → 1). A recipe→λ_cr dispatcher (`computeBuckling`) routes GPU-or-CPU with automatic CPU fallback.
- **It is off by default** (`window.BUCKLE_GPU = false`). At the grids the tool actually uses (N ≤ 64) the eigensolver is latency-bound: thousands of small `mapAsync` readbacks dominate and the problem is too small for GPU compute to amortize that overhead, so it runs slower than the CPU worker pool (which parallelizes designs/axes across cores). The path is retained and console-toggleable (`window.BUCKLE_GPU = true`); it is worth revisiting only at N ≥ 128 with a batched-resident rearchitecture. See [`NEXT_STEPS.md`](./NEXT_STEPS.md).

## What's new in v0.7.0

Phase 6 closes out. The σ–ε tab becomes the **Nonlinear** tab — pairing the comparison plot with an animated plastic-strain field — and a closeout pass adds a connectivity prune, plain-language readouts, and small-screen UX.

### Nonlinear α field tab

- **Up to three α-colored crush cubes** beside the merged σ–ε plot, animating the plastic-strain (α) field on the crush deformation. α is captured per accepted crush step, upsampled to the elastic grid, and ridden on the elastic displacement warp.
- **Shared strain scrubber** that auto-loops on entry then hands control to the user on first touch, with per-design ε_cr onset ticks marking where buckling pre-empts yield.

### Connectivity prune

- **`pruneToLargestComponent`** (periodic 6-connected, keep-largest) runs before every solve, default-on via a **Prune islands** toggle. Floating corner-satellite fragments — which seeded spurious buckling/crush modes — are removed; relative density and every metric reflect the cleaned geometry.

### Plain-language readouts + Load Capacity

- Equation symbols became engineering terms: **Modulus X/Y/Z** (all three axes now shown), **Yield Strength**, **Buckling Strength**, **Buckling-to-Yield Ratio**, **Critical Load Factor**, **Thermal Conductivity**, **Relative Density**, and **Crush Modulus** (the crush E₀, distinct from the linear moduli).
- New **Load Capacity** — governing strength (yield vs buckling) over one cell footprint, in N/kN — answers "how much can this withstand."
- **Adaptive units** (GPa ≥ 1 GPa, MPa below) so a 0.05 GPa modulus reads as 50 MPa.

### Pipeline + UX

- **Run-complete pill** can no longer fire mid-run (run-token + live-activity gate); a **branded solver spinner**; **self-calibrating per-mode timing** + live ETA; **skip-recompute** of unchanged designs; **slot-stable** design letters (no more duplicate "C"s).
- **Collapsible metrics drawer** (open on wide screens, collapsed on small) with a viewport floor so the raymarcher is never crushed; **lit baseline star**; amber for status vs red/green for comparisons; cyan section labels.

Full detail in [`docs/PHASE_6.md`](./docs/PHASE_6.md).

## What's new in v0.6.0

Phase 6 adds **nonlinear crush** (J2 plasticity + geometric NL) behind the σ–ε view tab, and uses its real per-design yield to retire the provisional buckling seam. A from-scratch crush solver — a CPU oracle cross-validated against a GPU solver — produces the effective uniaxial stress–strain response and the 0.2%-offset effective yield σ_y_eff.

### Nonlinear J2 solver

- **A CPU reference oracle** (`16f-nonlinear-cpu-ref.js`) and a **GPU solver** (`16g-nonlinear-solver.js`) that composes the full-Voigt elastic solver, reusing its FFT, Green's operator, and CG path. Validated on the Schwarz P demo: oracle σ_y_eff = 214.3 MPa, E0 = 31.28 GPa at N=8; GPU-vs-oracle cross-check E0 rel 6e-7, σ_y rel 1.06e-3.
- **Adaptive crush.** Steps to a detected 0.2%-offset knee (plus a few steps past it) or to a user strain cap — capturing yield where it exists and stopping early when it doesn't.
- **Honest no-yield reporting.** Compliant low-density designs that stay elastic to the cap report `no yield (> σ_cap)` rather than a fabricated yield.

### σ–ε comparison tab + buckling context

- **Real per-design σ–ε curves** with auto-scaled axes and a 0.2%-offset yield marker (drawn only when a real knee exists).
- **σ_cr cross-reference line.** The buckling critical stress is overlaid on the σ–ε axes; when it sits below yield, the plot flags the design *buckling-limited — collapses at σ_cr before yield*. Material yield and elastic stability now read on one set of axes.

### Real yield retires the provisional seam

- `P_cr/P_y` now divides the real critical stress by the design's own σ_y_eff — the `*` drops when a design yields. For designs that don't yield in range, it shows an honest upper bound `< σ_cr/σ_cap` instead of dividing by solid-Ti yield.

### Crush controls

- **Nonlin grid pill** (default **16³** — the floor for sheet-TPMS; 8³ is too coarse for thin shell walls and reads ~2× too stiff).
- **Crush-ε cap pill** (2 / 5 / 10%, default 5%) — bounds the adaptive crush.
- **Crush-axis dropdown** (ZZ default — physiological compression).
- **Live per-step progress** during the long crush phase.

Full detail in [`docs/PHASE_6.md`](./docs/PHASE_6.md) and [`docs/NONLINEAR.md`](./docs/NONLINEAR.md).

## What's new in v0.5.0

Phase 5 adds **linear (eigenvalue) buckling** as a fifth view tab — the stability question that governs low-density scaffolds, where thin walls buckle long before the material yields.

### Linear buckling solver

- **A matrix-free buckling oracle** (`16c-buckling-cpu-ref.js`) solves the cell-periodic geometric-stiffness eigenproblem per normal axis, returning the critical load factor λ_cr, critical stress p_cr, and the mode shape. Cross-validated against a dense generalized eigensolve at N=4 to machine precision (relative error 2.7e-15).
- **Runs in a Web Worker pool** (`16e-buckling-cpu-worker.js`) — one axis per worker, `min(cores−1, 8)` workers. N=8 three-axis ≈ 18 s per design on an 8-core desktop (N=16 opt-in via the Buckle pill). A Fourier preconditioner cuts the inner CG ≈3.6×.

### Buckling visualization

- **Animated mode-shape tab.** The mode swings full-cycle through the undeformed shape (2.5 s), colored by relative displacement on a turbo ramp — blue nodes, red antinodes — so you can see *where* and *how* the structure buckles. Amplitude is a qualitative exaggeration control (0–30 % of cell); a buckling eigenvector carries no absolute scale.
- **Local-vs-global localization chip.** A single scalar (RMS waves per cell of the mode within the solid) classifies each mode Global / Mixed / Local as a stoplight chip in the viewport corner. Strut-like topologies read local; smooth TPMS shells read global — matching the physics.
- **Provisional strength ratio.** `P_cr / P_y` (flagged `*`) compares p_cr against a fixed Ti-6Al-4V yield, pending the per-design yield from the nonlinear phase.

Full detail in [`docs/BUCKLING.md`](./docs/BUCKLING.md) and [`docs/PHASE_5.md`](./docs/PHASE_5.md).

## What's new in v0.4.0

Phase 4 takes the solver from Phase 3's normal-only 3×3 to the full Voigt 6×6 tensor and builds the visualization layer the new tensor unlocks. All four core view tabs — Geometry, Deformed, Stress field, Stiffness ⊕ — are operational, and shear physics is fully visible.

### Full Voigt 6×6 elastic homogenization

- **The production solver is now full-tensor** (`16b-elastic-solver-full.js`). Six load cases per design — three normal (xx/yy/zz) plus three shear (yz/xz/xy) — return the full 6×6 effective stiffness C_eff, the 6×6 compliance S, the three shear moduli Gxy/Gxz/Gyz, three Poisson ratios, and a real Zener anisotropy ratio. The Phase 3 normal-only solver (`16-elastic-solver.js`) is retained as an unused fast-triage path.
- **Cross-validated against a CPU oracle** (`16a-elastic-cpu-ref-full.js`) at N=16 on Schwarz P: 0.001–0.004 % drift on Ex/Ey/Ez, Gxy/Gxz/Gyz, and the Zener ratio.
- **Full von Mises σ_VM with shear contributions.** Stress on anisotropic structures (spinodoid, hyperuniform) reads 5–15 % higher than the Phase 3 normal-only path — correct, not a regression. Schwarz P is unchanged because shear decouples from normal loading under cubic symmetry.

### Visualization

- **Stiffness ⊕ tab** (`22-stiffness-viz.js`) — a per-design WebGL surface of the directional Young's modulus E(n̂) over an icosphere, colored by E(n̂)/E_max, with a per-tile readout of E_max, E_min, and anisotropy ratio. Verified against Schwarz P's cubic [111] limit (E_max/E_min = 1.70).
- **Six-position load-axis toggle** (xx/yy/zz/yz/xz/xy) exposes σ_VM under shear loading in the Stress tab without re-solving. The Deformed tab renders three of six axes — u'(x) reconstruction is defined only for normal strains.
- **Cividis colormap + sage viewport.** Both the stress raymarcher and the stiffness surface render against a sage (`#6b6e64`) radial-vignette background with the cividis colormap (colorblind-safe, print-friendly): matte navy → khaki → soft amber, tuned to the F13LD palette.

### Connectivity gating

- **Periodic 6-connectivity flood-fill** (`14a-connectivity.js`) runs between rasterization and the CG solve. Warn-only by default; opt-in rejection via `opts.connectivity.minLargestFraction`. Every result now carries a `connectivity` report for future UI surfacing.

## Roadmap

- **Phase 1** · UI shell, hardware detection, design ingest scaffolding ✓
- **Phase 2** · WebGPU foundation, WGSL 3D FFT kernel ✓
- **Phase 3** · SDF rasterizer, linear elastic FFT-CG, field extraction, viz stack ✓
- **Phase 4** · Full Voigt 6×6 with shear cases, stiffness directional surface viz, connectivity gating, six-axis toggle ✓
- **Phase 5** · Linear buckling — CPU oracle + worker pool, animated mode-shape viz, local/global localization ✓ *(GPU port built + validated (`16d`) but shelved — latency-bound, slower than the CPU pool at N≤64; CPU LOBPCG is the planned acceleration path, see [`NEXT_STEPS.md`](./NEXT_STEPS.md))*
- **Phase 6** · Nonlinear (Newton + J2 plasticity) — solver + σ–ε comparison, α field tab, connectivity prune, plain-language readouts ✓
- **Phase 7** · ~~Deformed-geometry domain warp, stress field overlay~~ — landed early in Phase 3
- **Phase 8** ← *next* · Thermal κ tensor, remaining view modes
- **Phase 9** · Multi-page PDF export
- **Phase 10** · F13LD.vault integration (fetch, push as new property record)

## Architecture summary

Static HTML/CSS/JS. No backend. No build step. WebGPU compute off the main thread, WebGL2 raymarching for visualization, and a CPU Web Worker pool for linear buckling (one axis per worker). Geometry generated from vault parameters at lab-open time using ported family code from F13LD.sweep. The one exception is an STL-imported cell, stored once as a 128³ signed-distance grid in the browser's IndexedDB (keyed by content hash) and embedded in its saved JSON.

## Development

```bash
git clone https://github.com/mshomper/f13ld.lab.git
cd f13ld.lab
# serve locally with any static server, e.g.
python3 -m http.server 8000
# or just push to gh-pages
```

No dependencies, no package manifest, no build. Open `index.html`.

---

© 2026 Not a Robot Engineering LLC · matt@notarobot-eng.com