# 0005 What should one pressure-drop run cover by default?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: research, solver, ui
- Builds on: 0003, 0004
- In the repo's log: docs/FLUIDS_LBM_SCOPE.md §11.2 default list 1, 10, 50, 100, 200; §11.7 Reynolds list waits for the user's answer; docs/FLUIDS_LBM_SCOPE.md §15 Flow direction setting: Z / X / Y / All
- Settles: default Reynolds points for pressure drop = 2, 5, 10, 20, 50, 100 (hydraulic diameter, interstitial speed), editable, along the chosen flow direction (All = three axes), 64³ flow grid; higher points only at 128³ with a time warning

## Decision

**A: Six points to Re 100, chosen direction, 64³.** Reynolds numbers 2, 5, 10, 20, 50 and 100 (editable list), solved along the Flow direction setting (All = the three axes), on the flow grid. Points above what the grid resolves are skipped with a note; 128³ is allowed with a time warning.

## Context

Run time is set by how many Reynolds points, how many flow directions and which grid. Low points are cheap (the lattice fluid stays viscous and settles in a few thousand steps); the top point dominates, because a less viscous lattice fluid settles slowly. Rough figures at 64³ on Matt's RTX (about 27,000 steps a second from the 2026-10-14 bench): Re up to 10 well under 0.2 s a point, Re 20–50 about 1 s, Re 100 about 1.5–3 s with a warm start from the previous point. At 128³ the same top point is one to two minutes. These are estimates for the bench to confirm. The scope (§11.7, 2026-10-07) said to wait for the database user's operating range before fixing defaults; this sets a provisional, editable default and needs no answer from him to start.

## Options

### A: Six points to Re 100, chosen direction, 64³ (chosen) (recommended)

Reynolds numbers 2, 5, 10, 20, 50 and 100 (editable list), solved along the Flow direction setting (All = the three axes), on the flow grid. Points above what the grid resolves are skipped with a note; 128³ is allowed with a time warning.
- Pro: Fits the 10–20 s budget: about 3–6 s per direction, 10–20 s with All, plus the wall links Flow already builds.
- Pro: Dense where inertia switches on (Re about 2–20), which is where the inertia-onset number and the fit's quality are decided.
- Pro: Covers Castro et al.'s 29–145 except its top, and the bottom half of the heat-exchanger range.
- Pro: A heat exchanger has a known flow direction, so one axis is often all a user needs (3× faster).
- Con: Stops at Re 100: the upper heat-exchanger range (200–500) needs 128³ and minutes per design.
- Con: Six points, not the scope's five; the list differs from the 2026-10-07 draft.
- Effort: Same build as the others.

### B: Scope list on all three axes

Reynolds numbers 1, 10, 50, 100 and 200 as written in the scope, on every open axis, with Re 200 on a 128³ grid.
- Pro: Matches the scope as written in 2026-10-07.
- Pro: Reaches Re 200, further into the heat-exchanger range.
- Con: Re 200 on all three axes at 128³ is several minutes per design: outside the 10–20 s budget.
- Con: Only one point (Re 1–10) where inertia switches on, so the onset number is poorly placed.
- Con: Re 1 adds nothing the creeping-flow run does not already give.
- Effort: Same build; much longer runs.

### C: Automatic to what the grid resolves

No list: points spaced evenly on a log scale from Re 1 up to the highest Reynolds number the chosen grid resolves for that design (about 100 at 64³, about 400 at 128³), on every open axis.
- Pro: Nothing to set: every design gets the widest range its grid supports.
- Pro: The top point is always one the grid can resolve.
- Con: Designs in a sweep end up on different Reynolds points, so columns at a fixed Re need interpolation.
- Con: All axes at 128³ runs into minutes per design.
- Con: Less predictable for a user who wants a specific operating point.
- Effort: Same build plus a grid-cap estimate per design.

## Recommendation

A (lean). It keeps a normal Lab run inside the 10–20 s budget, puts its points where inertia switches on, and leaves Re 200 and above as a deliberate, slower 128³ choice. Confirm with the bench numbers before building.
