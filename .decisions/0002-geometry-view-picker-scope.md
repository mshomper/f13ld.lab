# 0002 Which views should the Geometry tab's picker offer first?

- Status: decided
- Date: 2026-11-06, decided 2026-11-06
- Lenses: ui, solver
- Builds on: 0001
- Settles: curvature sign = positive = convex solid, outward normal out of the solid

## Decision

**A: Four-view picker.** Shaded plus Curvature, Overhang, Wall thickness and Pore size, sharing one colour bar and control row. About 1–2 sessions.

## Context

The Geometry tab only shows the shaded view. A scratch test showed curvature can be read from the viewer's stored field to 1–2 % at 48³ with a two-voxel sampling step, so geometry readouts need no solver or re-bake.

## Options

### A: Four-view picker (chosen) (recommended)

Shaded plus Curvature, Overhang, Wall thickness and Pore size, sharing one colour bar and control row. About 1–2 sessions.
- Pro: All four concern printability and pore geometry and are built the same way.
- Con: Thickness and pore size add a shader loop, which needs a compile check on Windows.

### B: Curvature only

The smallest version, under a session.
- Pro: Quickest answer to a curvature question.
- Con: The picker work gets revisited as soon as a second view arrives.

### C: All seven views

Also Surface direction, X-ray and Networks. About 3–4 sessions.
- Pro: Most complete.
- Con: X-ray and Networks each need their own mechanism.

## Recommendation

A (lean). All four share one purpose and one mechanism.
