# F13LD.lab — instructions for Claude

## Commits and pull requests
- Do not add session links (e.g. `Claude-Session: https://claude.ai/...`) to commit messages, pull request descriptions or any file in this repo.
- `Co-Authored-By: Claude …` trailers are fine.

## Notes
- 2026-10-14 v0.28.0 (branch `fluids-phase0`, not merged): fluids Phase 1 — `19g-flow-lbm.js` GPU solver, Flow mode (`PHYS_STATE.flow`, `FLOW_STATE`, `FLOW_BY_DESIGN`, Run All Phase 5), Flow cards and tab; console `runFlowGPUCheck()`. Scope §13.
- 2026-10-14 v0.27.1 (branch `fluids-phase0`): fluids Phase 0 — `buildFlowLinks` in 14e, CPU reference `19f-flow-cpu-ref.js`, checks `node proto/flow/run_checks.js`, GPU bench `proto/lbm-bench/index.html`. Walls are CLI, not Bouzidi (scope §3.2, §12). Recap: `docs/SESSION_RECAP_2026-10-14_fluids-phase0.md`.
- 2026-10-12 v0.27.0: `periodicComponents` returns `axial` (straight reach — load) beside `wraps` (any reach — heat, fluid, island trim); load-path checks use `axial` / `loadBearingAxes`. Latest recap and next up: `docs/SESSION_RECAP_2026-10-12_axial-connect.md`. F13LD.sweep copies 14a / 16b byte-for-byte (`solver/lab/`).
- Previous session recap: `docs/SESSION_RECAP_2026-10-11.md` (v0.26.2 noise revision 2 in the shared `F13LD-GEOM-NOISE` block; spec in F13LD.noise `docs/NOISE_REV2.md`). Revision 1 recipes must keep building exactly as before; check with F13LD.sweep `node tests/parity/noise-legacy.js`.
