# 0010 How should Lab measure and show each design's thinnest wall, tightest gap and tightest radius?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: ui, solver
- Builds on: 0002

## Decision

**A: Inscribed-ball numbers, on each Geometry tile.** Reuse the sweep's existing measure (largest ball that fits, 5th percentile) for wall and gap, plus the 5th-percentile tightest radius from the baked curvature; run once per design on the worker pool and show one line on each tile for the active view, red under the slider limit.

## Context

The v0.35.0 Geometry views colour the surface but give no single number per design. Lab already measures 'thinnest feature' for the sweep with inscribed balls on the 0/1 voxels (14d, 5th percentile), while the Wall thickness and Pore size views measure straight through along the surface normal. The two definitions read differently on the same design, so the choice decides which one users trust.

## Options

### A: Inscribed-ball numbers, on each Geometry tile (chosen) (recommended)

Reuse the sweep's existing measure (largest ball that fits, 5th percentile) for wall and gap, plus the 5th-percentile tightest radius from the baked curvature; run once per design on the worker pool and show one line on each tile for the active view, red under the slider limit.
- Pro: Same number as the sweep CSV and Atlas, so Lab and Sweep agree.
- Pro: Reuses tested code (periodic distance transform in 14c/14d); about one session.
- Con: Can read thicker than the colour map shows on oblique sheets, because the view measures along the normal.
- Effort: About one session: one new pool job in 17c, a tile readout in 31, lab.css.

### B: Along-the-normal numbers, matching the colour map

Compute the same straight-through chord the Wall thickness and Pore size views draw, on the CPU over surface points, and report its 5th percentile on each tile.
- Pro: The number always matches the reddest spot the user sees.
- Con: New CPU code that differs from the sweep's 'thinnest feature', so two thinnest-wall numbers exist in Lab.
- Con: Pore size along the normal is not a true pore diameter (noted in v0.35.0).
- Effort: About 1.5 sessions: new chord march on the pool plus the same tile readout.

### C: Inscribed-ball numbers as card rows

Same measure as A, but shown as rows on the design cards (Geometry section) instead of on the tiles.
- Pro: Visible on every tab and exportable with the cards later.
- Con: Cards are already dense; the number sits away from the view it explains.
- Effort: About one session; touches 40-design-grid card rows.

## Recommendation

A (lean). One definition across Lab and Sweep is worth more than an exact match to the colour map; the tile line puts the number where the eye already is.
