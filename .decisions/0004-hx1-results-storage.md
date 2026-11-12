# 0004 How should pressure-drop results be stored next to the creeping-flow results?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model, architecture
- Builds on: 0003
- In the repo's log: docs/FLUIDS_LBM_SCOPE.md §3.10 cache signature excludes fluid and flow settings; §11.4 sweep columns and the long-format CSV (decided 2026-10-07); docs/NEXT_STEPS.md F13LD.sweep flow port copies 19g; HX-1 must not change what it copies
- Settles: inertial flow results storage = own versioned record per design, separate from creeping flow; per axis and point: Reynolds number on the hydraulic diameter with interstitial speed, dimensionless pressure gradient (Darcy-normalised resistance), steps, convergence and unsteady flags; fluid, cell size and units are display-only

## Decision

**A: Own record, stored dimensionless.** A separate pressure-drop record per design, with its own run step after Flow and its own cache (geometry, grid, Reynolds list, version). Per open axis it keeps each point's Reynolds number, dimensionless pressure gradient, steps, converged and unsteady flags, plus the hydraulic diameter. Fluid, cell size and speed units only change the display, live. The creeping-flow record and its code stay byte-identical.

## Context

Today one flow record per design (FLOW_BY_DESIGN) holds permeability, wall shear per unit force and the velocity fields; it is cached on geometry, grid and tolerance only, because in creeping flow speed, fluid and viscosity are pure rescales. That stops being true once inertia matters: every Reynolds number is its own solve. But one thing carries over: for a given geometry the pressure drop in dimensionless form (friction factor against Reynolds number) does not depend on the fluid or the cell size. So the same 'solve once, change the fluid live' behaviour is possible if the results are stored dimensionless. HX-2 (heat transfer) will run on each converged HX-1 flow, so the storage also decides whether HX-2 needs the velocity fields kept or can work while they are still on the GPU.

## Options

### A: Own record, stored dimensionless (chosen) (recommended)

A separate pressure-drop record per design, with its own run step after Flow and its own cache (geometry, grid, Reynolds list, version). Per open axis it keeps each point's Reynolds number, dimensionless pressure gradient, steps, converged and unsteady flags, plus the hydraulic diameter. Fluid, cell size and speed units only change the display, live. The creeping-flow record and its code stay byte-identical.
- Pro: Nothing already validated moves: cards, sweep CSV with HX off, the Sweep port's copy of 19g and every cached flow result stay as they are (an F14-style check proves it).
- Pro: Changing the fluid (air, water, glycol, oil) or cell size never re-solves; only editing the Reynolds list does.
- Pro: Dimensionless points are exactly what a surrogate database trains on, and the long-format CSV (one row per design × axis × Reynolds number, decided 2026-10-07) is a direct dump.
- Pro: A per-point hook after each converged flow lets HX-2 run its heat-transfer lattice on the populations still on the GPU, so no velocity fields need storing now.
- Con: A second record, cache key and run step to keep in step with the first (it reads K and the hydraulic diameter from the creeping-flow run, so Flow must run first).
- Con: Wall shear at speed and the flow view at a chosen Reynolds number are not kept in HX-1; they would need fields stored per point later.
- Effort: Part of HX-1; about half a session of the 3.

### B: Inside the existing flow record

Add the Reynolds points to the present flow record and fold the Reynolds list into its cache key, so one Flow run does both.
- Pro: One run step and one record: less code around the solver.
- Pro: One place to look for everything about a design's flow.
- Con: Editing the Reynolds list re-solves permeability and wall shear too.
- Con: The flow version must change, so every cached flow result re-solves once and the Sweep port copies a moving file.
- Con: Mixes per-unit-force results (rescale freely) with per-Reynolds results (do not), which invites a wrong rescale in the cards.
- Effort: Slightly less than A.

### C: Physical units per fluid

Store pressure drop in Pa/m at chosen speeds for the selected fluid and cell size, as an engineer would read a test report.
- Pro: Numbers read directly as a test report would.
- Con: Every change of fluid or cell size re-solves, although the physics says it need not.
- Con: Surrogate pipelines would have to convert back to dimensionless form.
- Con: Display in Pa/m is available in A anyway, computed live.
- Effort: Similar to A, but slower to use.

## Recommendation

A (strong). It keeps every validated result and the Sweep port untouched, keeps fluid changes live by storing the physics' own dimensionless form, and leaves HX-2 a clean place to attach.
