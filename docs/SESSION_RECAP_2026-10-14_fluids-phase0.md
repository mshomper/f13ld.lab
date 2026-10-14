# Session recap — 2026-10-14 · v0.27.1 fluids Phase 0

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

## Next up
- **Matt:** open the bench from the branch, run it (default 32 / 64 / 128, τ⁺ 1.5) and the GPU vs CPU check, and paste the copied results. They decide whether 128³ needs the 3-buffer population split and set the time estimates.
- Phase 1 (v0.28.0): `19g-flow-lbm.js` from the bench kernel — three directions, fluid connectivity (sealed voids, open axes), coarse-to-fine start, force calibration, permeability tensor, Flow toggle and card rows; F8–F11.
