# Session recap — 2026-10-08 · v0.26.0 (recipe parity, from the F13LD.sweep session)

Lab work done as part of the F13LD.sweep refactor session, separate from the UI / thermal session recapped in [`SESSION_RECAP_2026-10-08.md`](SESSION_RECAP_2026-10-08.md). Both are on `main`. Sweep's side: `f13ld.sweep/docs/SESSION_RECAP_2026-10-08.md`.

## Why

A cross-check of Sweep, Lab and Mesh on 47 recipes built with each design tool's own export code (F13LD.tpms, .noise, .grain, .beam) found Lab off from what the design tools design and Mesh prints in two places:

- **Noise:** 10–67 % of voxels off on 12 of 13 noise-tool recipes. Foam, strut and veined noise were silently built as warp.
- **Anisotropic shell walls** (`normal_weights`, written by Sweep): ignored on import, 11 % off.

Matt's call (2026-10-08): the noise fixes and TPMS shell weights go into Lab too, before any solver work, and Sweep shares Lab's geometry code.

## What shipped

| Commit | Change |
|---|---|
| `a77975a` NoiseKernel | Uses the recipe's stored range (`norm_min` / `norm_max`); without one, computes it the noise tool's way (32³ corner-inclusive scan, ±5 % pad). Seed → coordinate offset (`seedToOffset`). Cellular noise uses the tool's `hash33` + `jitter`. Foam, strut and veined ported verbatim. An unknown noise type is refused instead of becoming warp. Zero values (warp strength, jitter, seed) stay zero. A Lab sweep that changes the raw field recomputes the range (`norm_for` stamp, cached). |
| `d5cbf13` v0.26.0 | Noise `'shell'` (the noise tool's sheet) runs as noise-sheet. `normal_weights` read and built with Mesh's world-space normal (`shellWeightFactor`, `14-rasterizer.js`). `normalizeDesignJson`'s recipe translation split out as pure `labRecipeInfo` / `labRecipeFromJson` (same behaviour) so Sweep uses the same code. The recipe → voxel code is marked `F13LD-GEOM-*` and kept byte-identical in Sweep's `geom/`. Worker cache keys bumped. README licence note: the `F13LD-GEOM` blocks are MIT; the solvers stay PolyForm. |

## Checks

| Check | Result |
|---|---|
| Lab vs noise tool, 24 recipes, all 10 types and modes, 48³ | identical voxel for voxel |
| Lab vs Mesh, per family, 48³ | TPMS and beam 0 %, grain 0.000 % (after Mesh v0.9.7's generator fix), noise ≤ 0.40 % (same as the noise tool vs Mesh) |
| Lab old vs new, 57 recipes | only noise and anisotropic shells change (intended) |
| Lab's validation scripts | pass (same pre-existing environment failures as `main` before) |
| Sweep `tests/parity/parity.js --quick` (Sweep, Lab, Mesh, 17 recipes and designs) | Sweep = Lab 0 voxels wherever comparable; Sweep vs Mesh 0.00 % |

**Result change for users:** noise designs and anisotropic shells solved before v0.26.0 were solved on different geometry from what Mesh prints. Re-run them if the numbers matter.

## How it fits together now

- **Shared geometry.** The code between `F13LD-GEOM-*` markers (TPMS + presets, noise, grain, beam, voxels, build args, recipe translation) is copied byte for byte into `f13ld.sweep/geom/`. After any change inside those markers, refresh Sweep: in the Sweep repo, `node tests/parity/geomsync.js ../f13ld.lab --write`, then `node tests/parity/parity.js --quick`.
- **Sweep → Lab handoff.** Sweep v0.23.0 (on `main` since 2026-10-08) has a Lab button on every result row. It opens `https://mshomper.github.io/f13ld.lab/#r=<recipe JSON>`, read by `ingestUrlParam`. It's the same recipe Sweep solved, plus `geometry.cell_size_mm` (non-beam, from Sweep's analysis context), `homogenization.E_solid_GPa` / `poisson`, and a `title` like "Sweep #6 · rank 1 · gyroid".

## Open Lab items found on the way

| Item | Notes |
|---|---|
| Stretched beams | Lab samples a beam with a per-axis cell scale over Mesh's world cube instead of one periodic cell, so its solver grid isn't one periodic cell when the scale isn't a whole number of cells. Sweep samples one cell; the parity script marks these rows "n/a" for Lab. |
| Stretched-cell solver | Sweep's GPU session adds non-cubic voxel spacing to the full-Voigt solver (Matt: Lab takes it up later). The batched solver comes from Lab, so the change can come back. |
| `normal_weights` vs Mesh | Built with Mesh's normal and matched in the parity rows; not swept widely against Mesh. |
| Grain seed 0 | The grain tool's generator sticks at 0 for seed 0. A fix has to land in grain, Lab, Mesh and Sweep together. |
