# Session recap — 2026-10-12 · v0.27.0 straight-reach load axes

Found from F13LD.sweep (designs disconnected on an axis scoring anisotropy 99; Sweep v0.32.0 recap has the full story).

- `14a-connectivity.js`: `periodicComponents` also returns `axial` per component — the axes a piece meets its own periodic copy STRAIGHT along (the axis lies in the span of its wrap vectors). `wraps` stays any reach: a sheet tilted 45° wraps x and y, but pulled along x tilted sheets slide past each other. New `loadBearingAxes(solid, N)` → `{ x, y, z, reach }`.
- `14d-voxel-stats.js`: the sweep's `spans` are the straight reach; `reach` keeps any wrap.
- `62-sweep.js`: nothing spans on any reach → skip (as before); reaches only diagonally → solved with a "no straight load path" warning (thermal still applies); `SWEEP_GEOM_VERSION` → `swg-7` so the geometry worker reloads.
- `61-import-stl.js`: spanning uses the straight reach (networks still count any wrap).
- `16b-elastic-solver-full.js`: `connectivity.loadAxes` on every elastic result.
- `40-design-grid.js`: when fewer than three axes carry load, the Anisotropy card shows "—" with "carries load on z only" (or "no straight load path"), and the Stiffness ⊕ readout's aniso reads the same note instead of E_max ÷ void.
- Island trim, thermal and void checks unchanged (they read `wraps`).
