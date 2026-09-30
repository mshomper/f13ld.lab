# Voxel-FE buckling prototype (not loaded by the app)

Research prototype behind `docs/SPRINT_B_PROPOSAL.md`. It replaces the spectral buckling operator — which has hundreds of spurious zero-energy patterns, so its critical load tracks the void stiffness — with matrix-free voxel finite elements: one incompatible-modes hex (H8I) per solid voxel, void removed, multigrid-preconditioned solves, LOBPCG.

| File | Role |
|---|---|
| `fe.js` | Element data (H8, H8I, one-point H8R), periodic solid-only mesh, matrix-free K and K_g, uniaxial prestress |
| `mg.js` | Geometric multigrid preconditioner |
| `lobpcg.js` | Block LOBPCG used by the prototype |
| `h.js` | Harness: loads the app's solver files from the repo root plus the prototype, then runs the scripts given as arguments |
| `run_plate.js`, `plate_ref.py` | Periodic plate benchmark vs the exact continuum answer |
| `run_design.js`, `yieldcheck.js` | Schwarz P / sheet designs, first-yield comparison |
| `nullspace.js`, `t_elem.js` | Zero-energy pattern count; element patch tests |
| `spec_xcheck.js`, `perf.js` | Cross-check against the spectral code; timings |
| `logs/` | Raw results quoted in the proposal |
| `*.png` | Plate benchmark, buckling vs yield, mode slices, wall-time comparison |

Run from this folder, e.g. `node h.js run_plate.js`. Note: `nullspace.js` writes ~18 MB dense matrices into `logs/` — delete them afterwards, don't commit them.
