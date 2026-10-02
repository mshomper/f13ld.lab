# Handoff — F13LD.foam stiffness estimate via F13LD.lab calibration

**Date:** 2026-10-02 · **For:** a fresh session · **Status:** steps 1–3 approved with defaults and built in v0.14.0 — see [`FOAM_CALIBRATION.md`](FOAM_CALIBRATION.md) · **Owner direction:** analyze and present proposed changes for approval before writing or modifying code; don't over-deliberate.

## Where things stand (all merged to main and live)

| Repo | Version | What shipped |
|---|---|---|
| f13ld.foam | v0.3.0 | Single-file tool aligned with F13LD.tpms; recipe carries `family: "foam"` + every seed position; Open in F13LD.mesh uses `#r=`; non-periodic foams refused with a warning + one-click fix. Live at mshomper.github.io/f13ld.foam |
| f13ld.mesh | v0.9.0 → v0.9.1 | Family/worker/loader registries (byte-identical to v0.8.3 on all 14 harness cases); foam family (`families/fam-foam.js`, `worker/m25-sdf-foam.js`), `#r=` loader, `tests/foamseeds.js` |
| f13ld.queue | — | Foam family label/colour |

Click-tested by Matt: warning, handoff to mesh, and large-seed recipes all work.

## Goal of the next session

Add a stiffness estimate to F13LD.foam, **calibrated against F13LD.lab's validated solver** rather than borrowed literature fits.

## Why not copy F13LD.tpms's estimate

TPMS uses a Hashin–Shtrikman upper bound split by MIL fabric. For foams:

| ρ | HS+ (ν 0.3) | Open-cell Voronoi fit 0.93·ρ^2.04 | Closed-cell Voronoi fit 0.563·ρ^1.19 |
|---|---|---|---|
| 5 % | 0.0256 | 0.0021 (bound 12× high) | 0.0159 (1.6×) |
| 10 % | 0.0525 | 0.0085 (6×) | 0.0364 (1.4×) |
| 20 % | 0.1109 | 0.0349 (3×) | 0.0829 (1.3×) |
| 30 % | 0.1761 | 0.0798 (2×) | 0.1344 (1.3×) |

Fits: Roberts & Garboczi (closed-cell Voronoi, arXiv cond-mat/0009004, which also quotes their open-cell fit). Gibson–Ashby: G ≈ (3/8)E, ν ≈ 1/3. These are the sanity check for the lab results, not the final model.

## Proposed plan (awaiting Matt's approval of the details)

1. **F13LD.lab v0.13.0 — foam kernel.** Lab already ports mesh field code verbatim and maps one lab cell `[-π, π]³` to mesh's `[-5, 5]³` (see `13b-kernels-new.js` header). Add:
   - Foam kernel: verbatim port of mesh `worker/m25-sdf-foam.js` `buildFoamSDF` (+ the `FoamSeeds` block — third byte-identical copy; extend mesh `tests/foamseeds.js` or add a lab `validate-foam.js` to check all three match). Solver coord → world = solver·5/π; output scaled by π/5. Negative-inside SDF, registered as `mode: 'solid'` like beam/bundle/wave.
   - Import: `60-add-design.js` family inference for `family: "foam"` (and `meta.tool: "f13ld.foam"`).
   - Sweep builder (`62-sweep.js`): foam parameters — thickness, cell count, regularity, stretch X/Y/Z, plateau k, organic.
   - Optional: Open in F13LD.lab button in F13LD.foam.
   - Bump the lab version (required on significant changes).
2. **Spot-check here before Matt runs anything.** Volume fraction in lab = foam = mesh exactly; a few CPU solves (`homogenizeFullCPU`, 32³ ≈ 36 s each on the session container) show open ≈ ρ², closed ≈ ρ^1.2 trends. CPU ref uses void 1e-4 (GPU sweeps use 1e-6) — fine for trends only.
3. **Calibration study (Matt's GPU, ~30 min).** Run-matrix CSV, ~50 runs:
   - Topology: open, closed, plateau
   - Volume fraction ~5–35 % (5 levels, set via thickness)
   - Seeds: Poisson + Lloyd, 2 realizations each; Kelvin and Weaire–Phelan at a subset
   - Stretch series 1, 1.25, 1.5, 2 (open + closed)
   - Settings as the PI-TPMS paper: 64 ↔ 128 grid pair, 1e-5, void 1e-6
   - **Use ~30–60 cells per tile**, not hundreds: at 64³ a strut in a 200-cell tile is only 1–1.5 voxels across. Stiffness depends on ρ, not cell count, so the fitted law transfers.
4. **Fit → estimator.** Per topology E/Es = C·ρ^n (directional mean), G, ν; stretch → axis-ratio relation to calibrate the MIL per-axis split; scatter across realizations/fit → "likely range" bands. Implement in F13LD.foam using the **measured** ρ from the shared foam field (exact, same geometry mesh exports). Results banner: "calibrated against F13LD.lab (n runs, date)". Store CSV + fit in a lab doc (e.g. `docs/FOAM_CALIBRATION.md`).
5. **Foam estimator panel:** same layout as F13LD.tpms (grid, Es, ν, Run; ρ, Ex/Ey/Ez, Gxy, Zener, ν; directional stiffness glyph; per-axis range rows; surface complexity; mm row), ivory accents. Export a `homogenization` block with TPMS's field names so mesh's summary shows it with no mesh change. Optional live ρ readout at 32³ in the equation bar.

## Open questions for Matt

- Approve adding foam to F13LD.lab (kernel, import, sweep parameters) as a new version, plus an Open in F13LD.lab button in foam?
- Is ~50 runs at the 64 ↔ 128 pair acceptable, or start smaller?
- First study on the three base topologies only, or include plateau k and organic now (~20 more runs)?
- Plateau / organic: use total volume fraction with a warning when junctions add a lot of mass, or leave junction mass out of the stiffness law?
- Live volume-fraction readout in the foam tool: yes or no?

## Useful facts

- Foam field (mesh `m25-sdf-foam.js`): base = (d₂−d₁)/2 closed or (d₃−d₁)/2 open/plateau; normalize on → base/|∇base| − t − E (exact gradient); E = plateau k·(1−smoothstep(0,0.35,d₃−d₁)) + 2·organic·t·(1−smoothstep(0,reach,d₄−d₁))^1.4, reach = 0.10 + organic^0.6·0.25. Verified against brute force to ~1e-15; closed half-wall median 0.0798 for t = 0.080.
- Foam tile = mesh cell = 10 world units; `geometry.tile_mm` = cube edge at the tool's cell size.
- Lab notes: `docs/NEXT_STEPS.md` (v0.12.1), `SWEEP.md` (sweep + run-matrix CSV format). Lab N = 128 is the voxel limit; FFT is radix-2 (power-of-two grids).
- Lab licence is PolyForm Noncommercial; all other F13LD tools are MIT.
