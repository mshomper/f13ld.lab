# F13LD.lab — Session recap, 2026-10-07 (evening)

**Versions shipped:** v0.20.0 (thermal Phase 1) and v0.21.0 (thermal Phase 2), both on main.

## What was built

| Version | What | Where |
|---|---|---|
| v0.20.0 | GPU thermal conductivity solver: all three axes in one CG, batch-2 FFT preconditioner, scalars on the GPU | `17b-thermal-solver.js` |
| v0.20.0 | Wall-voxel data on a CPU worker pool, reusing the elastic run's voxels and margin | `17c-thermal-voxel-pool.js` (+ two stash hooks in 16b) |
| v0.20.0 | Run All Phase 4: air / water / tissue fillers, card rows (κ X/Y/Z, share of solid, efficiency, anisotropy), flags (not converged, no solid path, filler-dominated, under-resolved), "Pores filled with" switch | `50-controls.js`, `40-design-grid.js`, `index.html` |
| v0.21.0 | Thermal map: temperature (ΔT per cell, isotherms), deviation, heat flux, κ(n) surface; section plane matching F13LD.tpms; filler's field on the cut; half-precision fields | `21-raymarcher.js`, `40-design-grid.js`, `30-view-tabs.js`, `lab.css` |
| v0.21.0 | Stokes solver removed; CPU FFT moved | `12b-fft-cpu.js` |

## Results on Matt's RTX

- `runThermalGPUCheck(32)`: PASS (GPU = Float64 reference to rounding, five demos × three fillers); 50–240 ms per filler.
- BCC beams κx at N = 128: Ti/air 0.2105 W/m·K (86 iterations, 1.2 s), Cu/air 10.43 (541 iterations, 5.0 s).
- Worker pool: identical to single thread; hyperuniform N = 32 walls 7.4 s → 1.6 s.

## Decisions (Matt)

- Under-resolved flag: > 5 % of the solid in fragments under 3³ voxels (the trim-loss measure misfired on real islands).
- ΔT across one cell for the map; section plane exactly as F13LD.tpms; filler's field on the cut, dimmed; half-precision fields at every grid; κ surface left as is.
- **GPU checks and timing are Matt's.** Sessions don't run them headless (SwiftShader is far too slow).
- Order: thermal Phase 3 + geometry columns → fluids version 1 → heat-exchanger phases (inertial pressure drop, then convective heat transfer, walls at fixed temperature first, then conduction through the metal) → probably nutrient / oxygen transport.
- Heat-exchanger Reynolds list waits for the user's answer; fluid presets as listed; long-format sweep export too.
- Default scaffold fluid: water at body temperature. As-built conductivities for every AM material with a literature value (search in Phase 3).

## User request

A user building a lattice heat-exchanger database for surrogate models asked for pressure drop, permeability, conductivity and heat-transfer performance. Answered in `FLUIDS_LBM_SCOPE.md` §11; Matt has a short reply drafted.

## Next session

Thermal Phase 3: materials (k_s gaps, c_p, as-built values from literature) and sweep columns per filler, plus porosity, surface area density, hydraulic diameter and open axes. First, confirm on the live site that the Windows freeze is gone and the flux map is smooth.
