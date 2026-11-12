# 0003 How should the flow solver reach heat-exchanger Reynolds numbers?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: solver, architecture
- In the repo's log: docs/FLUIDS_LBM_SCOPE.md §3.1 TRT with magic parameter 3/16; §11.2 HX-1 lattice limits (speed ≤ 0.1, relaxation time clear of ½, Re near 100 at 64³); docs/FLUIDS_LBM_SCOPE.md §12 check F3: TRT + CLI walls keep permeability to 2 ppm across relaxation times 0.6–2.0
- Settles: lattice Boltzmann collision for inertial flow = D3Q19 TRT with CLI interpolated walls (no new collision operator); Reynolds number reached by lowering the relaxation time per point at a mean pore lattice speed of about 0.03; magic parameter 3/16, or 1/4 if the GPU bench shows it is needed

## Decision

**A: Same kernel, viscosity set per point.** Keep D3Q19, TRT and CLI walls. Each Reynolds point keeps the lattice flow at about 0.03 mean pore speed (peaks near 0.1; compressibility error scales with the speed squared, a few tenths of a percent at the mean speed, checked on a straight channel where the exact answer has no inertia at all) and lowers the relaxation time toward 0.51 to reach its Reynolds number. The magic parameter (3/16 now, or 1/4, which is more stable for fast flow) is settled by a GPU bench before coding.

## Context

HX-1 needs flow at pore Reynolds numbers of about 1–100 (Castro et al. 2019 ran at 29–145; heat exchangers 10–500). The GPU kernel in 19g already solves the full Navier–Stokes equations (its equilibrium keeps the quadratic velocity terms), so no physics is missing: today it simply runs very slowly (lattice speed about 0.01) in a very viscous lattice fluid (relaxation time 1.5), which puts the Reynolds number well below 1. Reaching Re 100 means a faster lattice flow and a much less viscous lattice fluid, and the question is whether the present collision rule (two relaxation times, TRT) holds up there or a new, more stable rule is needed. Either way the creeping-flow path the cards, sweep and Sweep port use stays exactly as it is.

## Options

### A: Same kernel, viscosity set per point (chosen) (recommended)

Keep D3Q19, TRT and CLI walls. Each Reynolds point keeps the lattice flow at about 0.03 mean pore speed (peaks near 0.1; compressibility error scales with the speed squared, a few tenths of a percent at the mean speed, checked on a straight channel where the exact answer has no inertia at all) and lowers the relaxation time toward 0.51 to reach its Reynolds number. The magic parameter (3/16 now, or 1/4, which is more stable for fast flow) is settled by a GPU bench before coding.
- Pro: No new kernel: every check already passed (F1–F11, W1–W5) still describes the code that runs.
- Pro: TRT with CLI walls keeps the wall in place whatever the relaxation time (check F3, 2 ppm), so the answer depends on the Reynolds number alone and changing viscosity per point is safe.
- Pro: The grid, not stability, is the real ceiling: at 64³ a 70 % gyroid has about 29 cells across its pores, and the boundary layers at Re 100 are already only about 3 cells thick. A more stable rule would mostly buy points the grid cannot resolve.
- Pro: A console bench on today's main (no code change) can measure stability, steps and time at Re 1–200 before anything is built.
- Con: Close to a relaxation time of ½, TRT can go unstable at sharp strut edges; the cap (Re about 100 at 64³, about 400 at 128³) is an estimate until the bench runs.
- Con: A less viscous lattice fluid settles more slowly: steps per point grow roughly as one over the viscosity, so the top point costs about 10–40 times what a creeping-flow solve does.
- Con: If the bench shows instability below Re 100 at 64³, this option needs the 1/4 parameter or a cap lower than users want.
- Effort: No extra effort beyond HX-1 itself (about 3 sessions in all); half an hour of Matt's time for the GPU bench.

### B: New, more stable collision rule

Replace TRT for inertial runs with a cumulant or regularized collision rule, which stays stable much closer to zero viscosity and is the usual choice for higher-Reynolds lattice Boltzmann work. Creeping flow keeps TRT.
- Pro: More headroom against blow-ups at sharp edges and thin throats.
- Pro: Opens a path to the top of the heat-exchanger range (Re 200–500) on finer grids later.
- Con: Two kernels to keep: the GPU step, stress and velocity shaders and the Float64 CPU reference all need a second version, and the wall checks (F1–F7, W1–W4) must be re-run and may fail as Bouzidi walls did with TRT.
- Con: The proven property that the wall stays put as viscosity changes is specific to TRT with a fixed magic parameter; a new rule needs its own proof.
- Con: Stability past the grid limit buys little accuracy: under-resolved boundary layers give stable but wrong pressure drop.
- Con: A new collision operator is a larger change than the request needs, before any measurement says TRT is not enough.
- Effort: About 2 extra sessions on top of HX-1, mostly re-validation.

## Recommendation

A (lean). The grid limits accuracy before TRT's stability does, so a new collision rule would mostly buy points the grid cannot resolve. Bench first; move to B only if TRT blows up below Re 100 at 64³.
