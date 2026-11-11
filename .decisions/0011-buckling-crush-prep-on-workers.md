# 0011 When and how should Buckling and Crush voxel prep move off the main thread?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, solver

## Decision

**A: Crush first, as its own small release.** Make the crush solver's setup wait on the pool's 0/1 grid (shared cache with elastic), keep a main-thread fallback, extend validate-prep.js. Buckling follows later.

## Context

Turning on Crush or Buckling still freezes the page while voxels are built on the main thread (both are off by default). Moving it to the 17c worker pool as v0.24.0 did for elastic touches six files (16g, 16c, 16e, 16h, 17c and 50-controls) and needs bit-identical checks, so it is bigger than a tidy-up.

## Options

### A: Crush first, as its own small release (chosen) (recommended)

Make the crush solver's setup wait on the pool's 0/1 grid (shared cache with elastic), keep a main-thread fallback, extend validate-prep.js. Buckling follows later.
- Pro: Removes the bigger freeze with about half the risk.
- Pro: Five call sites, one solver file plus 50-controls.
- Con: Buckling still voxelizes once per axis in each worker until the second step.
- Effort: About one session.

### B: Both together, one release

Crush as in A, plus buckling builds its grid once on the pool and sends it to the axis workers, and the buckling-size probe moves to the pool if it takes over 50 ms.
- Pro: Closes the item in one go; one click-test round.
- Con: Larger change across both solvers; harder to bisect if a factor shifts.
- Effort: About two sessions.

### C: Keep it queued

Leave it behind the Sweep flow port and HX-1; both features stay off by default.
- Pro: No solver files touched while HX-1 is planned.
- Con: The freeze stays for anyone who turns them on.
- Effort: None now.

## Recommendation

A (lean). Crush is the longer freeze and the cleaner change; doing it alone keeps the check simple and the release small.
