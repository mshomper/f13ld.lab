# Session recap — 2026-10-14 · v0.27.1 fluids Phase 0 · v0.28.0 fluids Phase 1

Branch `fluids-phase0`. Nothing user-visible; the app only gains a function in 14e.

- `14e-link-field.js`: `buildFlowLinks` / `buildFlowLinksFromFn` — wall fraction from each fluid end of all 18 D3Q19 links (9 positive directions), thin walls between two fluid centres walled from both sides, island-trimmed voxels treated as pore. `opts.dims` builds a box of NX × NY × NZ voxels (used by the checks; also the shape stretched cells will need).
- `19f-flow-cpu-ref.js` (new, not loaded by `index.html`): Float64 D3Q19 TRT reference — Guo body force, shifted populations, CLI / Bouzidi / halfway walls, mass correction every step, permeability tensor, stress at nodes, trilinear wall-shear probes.
- `proto/flow/`: harness and checks F1–F7 (`node proto/flow/run_checks.js`), results in `docs/FLUIDS_LBM_SCOPE.md` §12. All pass within the resolution the grid rule asks for.
- `proto/lbm-bench/index.html`: WebGPU benchmark (fused pull kernel, CLI walls, TRT, Guo force, GPU-resident mass correction and mean-velocity reduction). Reports adapter limits, throughput at 32³ / 64³ / 128³, steps and seconds to converge, and permeability; "GPU vs CPU check" compares the GPU state with 19f after 600 steps at 32³. Software WebGPU in the VM: 9.8e-7 (velocity), 7.4e-7 (populations).

**Decisions (Matt, 2026-10-14):** wall shear uses the marching-tetrahedra surface 14e already builds for surface area, not a surface-nets port from F13LD.pullout; carry on past Phase 0 unless something hangs.

**Changes to the scope found by the checks:**
- Wall rule is CLI (Ginzburg 2008), not Bouzidi: with TRT, Bouzidi's permeability moved −2.4 % / +4.9 % across τ⁺ 0.6 → 2.0; CLI holds to 2 ppm.
- Mass correction every step: every 200 steps left a ρ sawtooth that stalled convergence at 1e-7.
- q is precomputed per link by bisection on the margin, not interpolated from end values in the kernel (the margin is not a distance).

**Bench on Matt's RTX 4070 Ti Super:** 2 GB binding limit, 16 storage buffers; 64³ 5,050 M node updates/s (fits in L2), 128³ 2,048 M/s (320 GB/s); one direction converges in 0.09 s at 64³ and 2.9 s at 128³; GPU vs CPU 1e-6. Scope §12.

## Phase 1 — v0.28.0 (same branch)
Decisions (Matt): flow grid 64³ default; Standard tolerance with High as an option; small-GPU message, no buffer split yet; go ahead with Phase 1. Coarse-to-fine dropped (not needed at these step counts).
- `19g-flow-lbm.js` (new, loaded after 17c): GPU solver, wall tables with sealed pores masked, one solve per open axis, permeability tensor, tortuosity, narrowest pore; `runFlowGPUCheck()` console check.
- `17c`: `buildFlowLinksParallel` + `flowlinks` slab job (`tv-5`); `14e`: `iRange` slabs (bit-identical to the full build).
- `50-controls` (CRLF kept): `PHYS_STATE.flow` (off), `FLOW_STATE {N: 64, tol: 1e-6}`, `FLOW_BY_DESIGN`, Run All Phase 5, estimate and calibration, summary warnings.
- `51-dock` / `index.html`: Flow drawer tab and pane (grid, tolerance), dock tag, saved settings (`flowN`, `flowTol`), Flow view tab; `30-view-tabs`: K surface scale toggle.
- `40-design-grid`: Flow cards and K(n) surface (thermal κ(n) code).
- Checks F8 (linearity 7e-6, superposition 1.5e-6), F9 (mass), F10 (TPMS demo, software GPU: 1e-6), F11 (grid convergence) — scope §13. Headless Run All exercised end to end (status, cards, flags, settings).
- Found, not fixed: on a 390 px phone screen the page is about 840 px wide because the header buttons overflow. Main does the same, so it predates Flow.

## v0.28.1 — merged to main (Matt approved)
- Click-test passed after a reload; one transient foam failure ("offset is out of bounds") traced to mixed file versions in the workers right after the push. Added the worker version check (`FLOW_LINKS_VERSION`, `_tvResetPool`, `tv-6`), slab size check and step-tagged errors.

## Next up
- Flow view: speed in the pores on the section plane (needs the converged velocity field read back) — see the scope §5 Phase 3; Phase 2 wall shear stress is the planned order.
- ~~**Matt:** click-test the branch~~ done. Was: click-test the branch (`https://raw.githack.com/mshomper/f13ld.lab/fluids-phase0/index.html`): turn on Flow, Run, open the Flow tab; then `runFlowGPUCheck(0)`, `(1)`, `(2)` in the console — each should print `pass: true`. Try foam and an STL import too. Approve before merging to main.
- Phase 2 (v0.29.0): wall shear stress — triangle list from 14e's marching tetrahedra, probes and extrapolation (velocity-gradient fallback near sharp corners, check F5), unit tractions per axis, live flow-rate / direction rescaling, window presets by material, best flow, force-balance residual (F9 proper).
- Later (Matt): flow at 32³ / 64³ in F13LD.sweep and then F13LD.vault as a comparison metric.

## v0.29.0 — Flow view (merged to main with v0.29.1)
Matt asked for something like a CFD flow-trajectory GIF. Built: velocity fields kept per axis (≤ 64³, half precision), `23-flow-viz.js` (direction combine, CPU tracer particles), raymarcher flow mode with depth output, speed on the section plane and a ribbon streak pass; Flow tab switch (flow / speed / K(n)), direction, play / pause, speed, count. Decisions: turbo, streaks with bright heads, section-plane cut-away, 128³ averaged to 64³. Scope §14.

## v0.29.1 — streak length and size, shared controls (merged to main, Matt approved)
- Matt's click-test of v0.29.0: the view works on his foam, gyroid shell and chiral designs; streak length was tied to animation speed. He liked fast flow drawing longer streaks, but wanted a length multiplier and larger traces.
- Trails now keep a point every `length` units of flow time (1 unit = one 60 Hz frame at speed 1), 12 points; the tail slides between its last two points so streaks hold a steady length. Animation speed and frame rate no longer change streak length (checked in node on a uniform field); faster fluid still draws longer streaks.
- Size scales the ribbon width (`uWidth`). Play / speed / length / size / count moved from each tile to one group in the view strip (`#flowAnimToggle`), shown on the Flow tab in the flow view; the strip wraps instead of scrolling. Sliders drawn in the strip's style (thin track, neon thumb, values in the lab accent).
- First strip build rendered unstyled for Matt (stale cached `lab.css`): the stylesheet and changed scripts now load with `?v=0.29.1`, and each slider group is `flex:none` so it holds one line even without the stylesheet. Bump those tags when the files change.
- Process note (Matt): push branches for him to click-test instead of running headless browser checks here — they are too slow. Syntax-check, push, send the link.

## Next up
1. Phase 2 wall shear stress (scope §5): triangle list from 14e's marching tetrahedra, probes and extrapolation, unit tractions per axis, live flow-rate / direction rescaling, window presets by material, force-balance residual (F9 proper). Wall-shear grid ≥ 15 voxels across the narrowest pore.
2. Flow-rate units (mm/s) on the colour bar; WSS map on the strut surface.
3. Flow at 32³ / 64³ in F13LD.sweep, then F13LD.vault (comparison metric, not a final solve).
4. Open: header overflow at phone width (pre-existing).
