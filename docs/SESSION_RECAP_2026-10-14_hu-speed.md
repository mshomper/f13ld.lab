# Session recap — 2026-10-14 · v0.29.2 hyperuniform speed, viewer bake, Vault titles

Merged to main after Matt's click-test ("way better"). Companion releases: F13LD.sweep v0.33.1, F13LD.mesh v0.9.10.

## What Matt reported
1. Building voxels on a hyperuniform Grain recipe (205 kernels, aspect 5, cross 3.4, blend 1.36) took ~50× longer than foam / TPMS; the splash sat on "preparing viewers · 1 to go".
2. The raymarcher stalled on the splash, then the hyperuniform tile stayed blank for 20–30 s.
3. Vault imports showed "Vault ‹64-hex id› · lidinoid" as the card title.

## Root causes
- `GrainKernel.evaluate` looped over every kernel at every point. The periodic wrap (v0.7.2) turns 205 design kernels into 3,149, while only ~7 contribute at any point. With cross ≠ 2 each kernel also costs two `Math.pow`. One core: 48³ took 54.9 s vs 0.05 s for the gyroid. Every geometry path goes through `evaluate` (solver voxels, margin / partial volume, thermal and flow walls, viewer bake).
- `labBakeFieldAsync` sent the whole viewer bake as ONE `rawfield` job to one worker; the splash gives up at `LAB_SPLASH_MAX_MS` (15 s), then the tile stayed black until that job finished, and the 80³ refine ran on one worker too.
- The Vault name was used verbatim as the title.

## Changes
- **13-kernels.js (shared `F13LD-GEOM-GRAIN`)** — `GrainKernel._indexHUKernels`: uniform 24³ bin grid over the cell + 0.5 margin; each bin lists, in kernel order, every kernel whose cut-off shape can reach it (oriented box dilated by the bin half-diagonal — conservative). Built lazily on the first `evaluate` (`params.huIndex = null` from `parseRecipe`, so parsing stays ~6 ms). `evaluate` skips a term when R^m ≥ 40·max(1, 1/P), i.e. below e^-40 *after* the blend root, at every point — with or without the index, so the result never depends on it. Points outside the grid fall back to the full loop.
  - First version cut at e^-27 *before* the root; Sweep's `tests/density.js` caught it: with blend > 1 the root magnifies tiny sums, so dropping them moved the empty-space plateau of a thick HU sheet (`HU ortho shaped sheet` could no longer reach 25 %). Judging the cut after the root fixed it.
  - Result: field identical to the old code to the last bit or one rounding step (max 2.2e-16) on Matt's recipe and the three Sweep HU fixtures; zero voxel changes; Matt's recipe ~45× faster per point (Lab demo ~10×, ortho shaped ~30×). Finer bins (32³, 40³) gave no extra speed.
- **17c-thermal-voxel-pool.js** — `labBakeFieldAsync` now sends `rawslab` z-slab jobs over the whole pool (`_tvSlabs`), same values and min/max as `buildRawField` (checked in node with the real worker source). Workers keep the last parsed recipe (`parsedRecipe`, keyed by the recipe JSON; not for STL imports); `voxels` jobs use it too. `THERMAL_VOXEL_VERSION` tv-7.
- **16e-buckling-cpu-worker.js** — `BUCKLE_SOLVER_VERSION` fe-h8i-9 (worker loads 13-kernels).
- **60-add-design.js** — "Vault ‹hex› · x" → "X · Vault"; the hex id and original name stay on the design (`vault_id`, `source_name`) for the Lab → Vault push. Any other ≥ 24-char hex run is dropped from titles.
- **40-design-grid.js / lab.css** — card titles escaped (`_dcEsc`), one line with ellipsis, full name on hover.
- index.html `?v=0.29.2` on lab.css, 13, 16e, 17c, 40, 60; header and console v0.29.2.

## Checks run
- Old vs new `evaluate` on Matt's recipe, the Lab demo, an ortho/odd-shape recipe, a no-wrap recipe: max difference ≤ 2.2e-16, no voxel flips, binned = full loop at 30,000 random points inside and outside the cell; spinodoid untouched.
- `validate-existing-fixes.js` (from a `_validation/` copy), `validate-geometry.js`, `validate-prep.js`: pass.
- Sweep harness `grain-hyperuniform` + `grain-spinodoid` identical; Mesh harness `grain-hyperuniform` + `shape-hyperuniform` exports byte-identical.
