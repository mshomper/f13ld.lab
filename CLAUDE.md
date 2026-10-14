# F13LD.lab — instructions for Claude

## Commits and pull requests
- Do not add session links (e.g. `Claude-Session: https://claude.ai/...`) to commit messages, pull request descriptions or any file in this repo.
- `Co-Authored-By: Claude …` trailers are fine.

## Notes
- 2026-10-14 v0.29.2 (branch `hu-speed-vault-titles`): hyperuniform speed — `GrainKernel._indexHUKernels` (shared `F13LD-GEOM-GRAIN`, synced to F13LD.sweep v0.33.1) bins kernels; terms below e^-40 after the blend root are skipped at every point, so the field is unchanged to the last bit or one rounding step (cut judged after the root: blend > 1 magnifies tiny sums). Viewer bake is z-slabs over the pool (`rawslab`, 17c; worker parse cache), `THERMAL_VOXEL_VERSION` tv-7, `BUCKLE_SOLVER_VERSION` fe-h8i-9. Vault names "Vault <hex id> · x" show as "X · Vault" (`vault_id`, `source_name` kept on the design); titles ellipsize. F13LD.mesh v0.9.10 has the same index.
- 2026-10-14 v0.29.1 (merged to main): particle trails sampled in flow time (`FlowParticles.setLength`, 0.25–2), so animation speed no longer sets streak length; size scales `uWidth`; play/speed/length/size/count shared in the view strip (`#flowAnimToggle`).
- Changed files load with `?v=` tags in index.html (0.29.2: lab.css, 13, 16e, 17c, 40, 60; 0.29.1: 21, 23, 30) — bump the tag when they change. Matt click-tests pushed branches himself; don't run headless browser checks.
- 2026-10-14 v0.29.0: Flow view — `23-flow-viz.js` (field combine, FlowParticles), raymarcher view mode 4 + depth output + streak pass, 19g keeps velocity fields (`flowVizAddAxis`, ≤ 64³). Scope §14.
- 2026-10-14 v0.28.1 (merged to main): Flow guards — 14e `FLOW_LINKS_VERSION` checked on every worker slab (bump it whenever buildFlowLinksFromFn's output changes, with `THERMAL_VOXEL_VERSION` in 17c); errors name their step.
- 2026-10-14 v0.28.0: fluids Phase 1 — `19g-flow-lbm.js` GPU solver, Flow mode (`PHYS_STATE.flow`, `FLOW_STATE`, `FLOW_BY_DESIGN`, Run All Phase 5), Flow cards and tab; console `runFlowGPUCheck()`. Scope §13.
- 2026-10-14 v0.27.1 (branch `fluids-phase0`): fluids Phase 0 — `buildFlowLinks` in 14e, CPU reference `19f-flow-cpu-ref.js`, checks `node proto/flow/run_checks.js`, GPU bench `proto/lbm-bench/index.html`. Walls are CLI, not Bouzidi (scope §3.2, §12). Recap: `docs/SESSION_RECAP_2026-10-14_fluids-phase0.md`.
- 2026-10-12 v0.27.0: `periodicComponents` returns `axial` (straight reach — load) beside `wraps` (any reach — heat, fluid, island trim); load-path checks use `axial` / `loadBearingAxes`. Latest recap and next up: `docs/SESSION_RECAP_2026-10-12_axial-connect.md`. F13LD.sweep copies 14a / 16b byte-for-byte (`solver/lab/`).
- Previous session recap: `docs/SESSION_RECAP_2026-10-11.md` (v0.26.2 noise revision 2 in the shared `F13LD-GEOM-NOISE` block; spec in F13LD.noise `docs/NOISE_REV2.md`). Revision 1 recipes must keep building exactly as before; check with F13LD.sweep `node tests/parity/noise-legacy.js`.
