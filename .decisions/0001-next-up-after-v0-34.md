# 0001 What should the next Lab session build after v0.34.0?

- Status: decided
- Date: 2026-11-02, decided 2026-11-06
- Lenses: research, solver, architecture
- In the repo's log: docs/NEXT_STEPS.md PICK UP HERE (2026-10-15): (2) Sweep flow port, (3) HX-1; docs/FLUIDS_LBM_SCOPE.md §11.7 Reynolds list waits for the user's answer; §17 Next: HX-1, then Sweep port; docs/NEXT_STEPS.md §1 (2026-10-08): Buckling and Crush prep onto background workers

## Decision

**E: Viewer modes on the Geometry tab.** Look into a curvature view, and other views to swap to on the main page beyond the shaded one.

Reason: neither, I actually want to look into a curvature visualization toggle for the lab. Which made me think of other visualization toggles we could swap into for the main page of the lab rather than just the "shader" view

## Context

v0.32.0–v0.34.0 (flow in the sweep, Atlas modes, Atlas entry points) merged to main on 2026-10-15. NEXT_STEPS.md names the F13LD.sweep flow port next, then HX-1 inertial pressure drop; scope §17 lists them the other way round. Two older items are still open in the code: buckling and crush voxel prep on the main thread (the 2026-10-08 goal), and a handful of small follow-ups. Nothing has moved in Lab or Sweep since 2026-10-15.

## Options

### A: F13LD.sweep flow port (recommended)

Copy 14e, 19g and 19h into Sweep's solver/lab/, flow at 32³ in Fast and 64³ otherwise, append flow columns after the existing ones so F13LD.ingest's validator keeps passing. Vault columns in a later pass.
- Pro: It is the order Matt set on 2026-10-15 and has been queued since 2026-10-14.
- Pro: Puts permeability and wall shear into the database that Vault and surrogate work read from, at sweep scale.
- Pro: 14e, 19g and 19h are close to clean copies: 19g needs only WGPU.device (already in Sweep) and 19h's summary code has no UI ties.
- Pro: Porting the Stokes-only solver now gives Sweep a fixed copy before HX-1 changes 19g.
- Con: 17c's flow job does not copy cleanly: it pulls in the whole worker pool and kernels 13–14 that Sweep lacks. Use the existing no-worker path (buildFlowLinks) or copy 17c and its imports.
- Con: Work happens in another repo that is not checked out here; Lab itself gains nothing user-visible.
- Con: Once HX-1 lands, 19g changes and Sweep's copy must be re-synced.
- Effort: About 1–2 sessions, mostly in the Sweep repo.
- Assumes: Sweep's single-thread link build is fast enough at 32³ and 64³ (it runs once per design, before a solve of under a second).
- Assumes: F13LD.ingest's validator accepts columns appended after the existing ones.
- Risk: The 17c dependency grows into copying 13, 13b, 13c, 13d and 14 too, widening the byte-copy contract between the repos.
- Risk: Flow at 32³ in Fast may fall below the grid rule (scope §3.8) on thin-pore designs; the coarse flag must travel with the port.
- Estimate, Effort: 1–2 sessions (basis: 14e, 19g, 19h copy with small guards; Lab's 62-sweep.js:537-554 is a ready template for the caller)
- Estimate, Flow time per design in Sweep: about 0.1–0.4 s solve at 64³ on an RTX, plus link build (basis: scope §12–13: 64³ about 0.09 s per direction bench, 0.35–0.41 s per design measured by Matt)

### B: HX-1 inertial pressure drop

Per-axis flow at a list of Reynolds numbers with a mean-velocity force controller, Darcy–Forchheimer fit, Fanning friction factor, unsteady flag, heat-exchanger fluid presets and a long-format CSV (scope §11.2).
- Pro: The kernel is already fully nonlinear (quadratic equilibrium, Guo forcing); only the driver, cache key and outputs are new.
- Pro: A ready pass/fail check now exists: Tupin and Ohta refit Castro's measurements with Forchheimer (k and β for gyroid, P and D), which would close the F12 P-gap question.
- Pro: Serves the heat-exchanger database user directly and is the gate for HX-2 convective heat transfer.
- Pro: The Reynolds-list blocker is softer than it looks: Castro's experiments span Re 29–145, inside the scope's default 1–200.
- Con: Largest of the options: controller, warm start, per-Re cache and results, presets, cards, sweep and long CSV.
- Con: Breaks the linear-flow assumptions the cards rely on (fields stored per unit force, wall shear rescaled linearly, cache without fluid), so the Stokes path must be kept separate and unchanged.
- Con: 64³ is marginal: published TRT runs at Re up to about 200 used about 38 cells per sphere diameter; higher points need 128³ and averaging if unsteady.
- Effort: About 3–4 sessions.
- Assumes: Matt accepts the scope defaults (1, 10, 50, 100, 200) without the user's operating range, editable later.
- Assumes: The Stokes path stays byte-identical, so cards, sweep and the Sweep port are unaffected.
- Risk: Compressibility error at higher Re (Mach) and τ near ½ make the top Re points noisy at 64³; results need a resolution flag.
- Risk: Unsteady onset (Re about 110–250 in periodic packs) forces long time-averaged runs at 128³, tens of seconds per point.
- Estimate, Effort: 3–4 sessions (basis: earlier fluids phases took about one session each; no kernel rewrite, but four layers (driver, results, UI and CSV, validation))
- Estimate, Run time per design: about 5 Re × 3 axes = 15 solves; seconds at 64³, 10–60 s per unsteady point at 128³ (basis: 64³ bench 0.09 s per direction from rest; 128³ 2.9 s per 5,000 steps; unsteady averaging about 10⁵ steps (extrapolated))

### C: Buckling and crush prep off the main thread

The 2026-10-08 goal: crush upload async on the 17c pool (0/1 cube), buckling voxelized once and sent to the axis workers, predict probe timed and moved if slow. Bit-identical checks in validate-prep.js.
- Pro: Smallest self-contained piece, entirely in Lab; the pattern and pieces already exist (labPrepElasticParallel, _TV_PREP_CACHE, 16b's fallback).
- Pro: Removes the last page freeze; buckling stops voxelizing once per axis worker.
- Pro: Easy to verify: bit-identical grids, buckling factors unchanged.
- Con: Both features are off by default, so few runs hit the freeze today.
- Con: Moves no research question forward and does not touch the fluids track Matt has been driving.
- Effort: About 1 session.
- Assumes: Prep, not the solve, is the bulk of the freeze (to profile first, as §1 asks).
- Risk: 16g's upload has five call sites; making it async can reorder state in the crush run loop.
- Estimate, Effort: about 1 session (basis: same pattern v0.24.0 used for elastic, with the checks already written)

### D: Small follow-ups pass

Validators runnable from the repo root, the phone-width header overflow, and Lab → Vault push matching on vault_id (Phase 4 of the round-trip scope).
- Pro: Clears known debt; every validator running from the root makes later sessions' checks cheaper.
- Pro: Each item is low risk and independently reversible.
- Con: The Vault push is not small: no push code exists yet, so it is really its own phase.
- Con: Little user-visible value apart from the phone header.
- Effort: Under 1 session without the Vault push; 1–2 with it.
- Assumes: The Vault push is scoped out or done as a separate phase.
- Risk: Scope creep into the round trip, which needs Ingest and Vault changes too.
- Estimate, Effort: half a session for validators and header (basis: two require-path fixes and one CSS breakpoint)

### E: Viewer modes on the Geometry tab (chosen)

Look into a curvature view, and other views to swap to on the main page beyond the shaded one.

## Evidence

- Sweep's solver/lab/ has no flow files (14e, 17c, 19g, 19h absent) and no commits since 2026-10-14, so the port has not started. [A] ([GitHub API, mshomper/f13ld.sweep contents and commits](https://github.com/mshomper/f13ld.sweep))
- 17c's flow job depends on the whole worker pool and kernels Sweep lacks; 14e, 19g and 19h copy with small guards, and a no-worker path already exists. [A] (Claude's judgment)
- Lab's flow kernel is D3Q19 TRT with Guo forcing and a full quadratic equilibrium; it runs in the Stokes limit only because the force is tiny (g = 1e-5·(64/N)²). [B] (Claude's judgment)
- Castro's measurements span Re 29–145; a Forchheimer refit gives k and β for D (8.68e-8 m², 5390 /m), gyroid (2.40e-7 m², 3044 /m) and P (1.31e-7 m², 4035 /m), and Darcy underestimated k by 36–85 %. [B] ([Tupin & Ohta, comment on Castro et al. 2019 (Materials)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7321472))
- TRT with CLI walls on a periodic sphere pack: departs from Darcy at Re_p about 20, unsteady at about 180, and used about 38 cells per diameter with Λ = 3/16 up to Re_p about 200. [B] ([Fattahi et al., Pore-scale lattice Boltzmann simulation of laminar and turbulent flow through a sphere pack (arXiv 1508.02960)](https://arxiv.org/abs/1508.02960))
- TPMS lattices leave the Darcy regime early: Re about 4 for Primitive, about 20 for Diamond. [B] ([Rathore et al., Flow Characterization in TPMS based Porous Geometries: Part 1 (arXiv 2205.03591)](https://arxiv.org/abs/2205.03591))
- Buckling and crush prep are still synchronous (16g upload, per-worker voxelization in 16h and 16c); labPrepElasticParallel and _TV_PREP_CACHE exist to reuse. [C] (Claude's judgment)

## Recommendation

A (lean). Port first, as Matt ordered: it is one to two sessions, it lands flow in the comparison database before HX-1 changes 19g, and its one snag (17c) has a ready workaround. Then HX-1, which now has a real validation target in the Tupin and Ohta refit of Castro.

What would change this: If the heat-exchanger user is waiting, or Matt wants the Castro P-gap closed before more data goes to Vault, B goes first: the kernel is ready and the Tupin and Ohta β values make it testable now.
