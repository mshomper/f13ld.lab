# Session recap — 2026-10-15 · v0.32.0–v0.33.0 · flow in the sweep, Atlas modes

Branch `flow-sweep`. Scope [`FLUIDS_LBM_SCOPE.md`](FLUIDS_LBM_SCOPE.md) §17.

## Decisions (Matt)
- Sweep flow runs on the Configure flow grid (64³ default), not each run's elastic grid.
- Castro et al. 2019 do not say sheet or network: the F12 check builds both.
- F13LD.sweep flow port: 32³ in Fast, 64³ otherwise.

## Built
- Sweep Physics: *stiffness +* **thermal** / **flow** toggles (saved sweeps load as before).
- Flow per run without velocity fields; wall shear kept as a 1,000-point dimensionless summary per open axis, so fluid, shear target and direction can change after a sweep — export and Atlas follow without a re-solve.
- 46 flow CSV columns (only when a run has flow), run notes, Atlas metrics (permeability mean and per axis, k/L², tortuosity, median wall shear, wall at target). Atlas lists only offer metrics with data; non-stiffness values no longer print as MPa.
- Stiffness timing estimate no longer includes thermal / flow time.
- `runFlowCastroCheck()` console check (F12); F13 retired.

## Checks (headless, no GPU)
- Card statistics unchanged by the 19h refactor (288 values vs v0.31.0, 0 differences).
- W5: summary vs every probe — median 0.08 %, 95th 0.14 %, wall at target 0.26 points (card's own tolerance 1 point), same direction 15/15.
- F12 on the CPU reference at 24³: sheets rank gyroid > P > D (P 1.7 %, D 39.5 % below gyroid); networks don't (P network 69 % above). Measured P gap (27 %) is larger — their flow rates put the pore Reynolds number around 3–15, so inertia is in their numbers (HX-1).
- F14: sweep CSV with flow off identical to v0.31.0.

## For Matt
- Click-test: a small sweep with flow on; change the shear target / fluid afterwards and export again; Atlas flow metrics.
- Console: `runFlowCastroCheck()` (64³, about 10 s) — sheets should pass.

## v0.33.0 — Atlas Stiffness | Thermal | Flow
- Matt's GPU Castro check: sheets pass at 64³ (P 2.2 %, D 40.9 % below gyroid), networks don't match (expected).
- Mockup (`atlas-modes-mockup.html`, sent in chat) approved as is: switch prominence, design-space defaults, stacked fillers.
- Built per scope §18. For Matt: open the Atlas on a sweep with thermal and flow, switch modes, focus fillers, toggle the bone band, try the design-space pickers and the surface's auto / linear / log.
