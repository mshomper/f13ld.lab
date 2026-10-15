# Session recap — 2026-10-14 / 15 · v0.29.3 → v0.31.0 · permeability units, wall shear, shear views

All merged to main after Matt's click-tests. Design and checks: [`FLUIDS_LBM_SCOPE.md`](FLUIDS_LBM_SCOPE.md) §15 (Phase 2) and §16 (Phase 3).

## Releases

| Version | What | Matt's input |
|---|---|---|
| **v0.29.3** | Permeability on every Flow card in units of 10⁻⁹ m² (k/L² in units of 10⁻³), 3 significant figures, so cards compare without reading exponents. Hover note on the permeability labels with the trabecular-bone range, 0.027–20 ×10⁻⁹ m² (Nauman, Fong & Keaveny 1999, *Ann Biomed Eng* 27:517). | Numbers were ~10⁻⁹ with a different exponent per card. 10⁻⁹ m² is "a good scale". No unit switch (m² is the norm for scaffold and lattice work). Bone range as a hover only: the tool is not only for biomed. |
| **v0.30.0** | Fluids Phase 2, wall shear stress: GPU stress kernel, one wall probe per surface voxel (14e `marginWallProbes`), probe-and-extrapolate with fallbacks, force balance on the exact pore volume (19h). Flow settings: direction (Z / X / Y / All), fluid, shear target (none by default), speed units, chamber diameter — all live, no re-solve. Flow cards: "Flow through the cell" (permeability, tortuosity X / Y / Z on one row each; open porosity; narrowest pore), then "Wall shear" (shear per mm/s, at target, best flow speed, usable range). | Not biomed-first: general flow leads, no "in window" jargon. Target entry and direction live in the configuration. Direction like crush, but "All" means the **best** direction (how to orient the cells). Coarse grids show numbers with a warning. |
| **v0.30.1** | Flow-card warnings behind a drawn amber mark beside the value (hover for the text, tap to show it). | Warnings took too much height. |
| **v0.31.0** | Fluids Phase 3, views: **shear** map on the strut surface (target bands blue / jade / amber at the card's best speed, or log colour per unit speed), **orient** sphere (wall at the target for every flow direction at the card's speed; best direction ringed), **charts** (all designs: wall at target vs speed, shear distribution). Amber warning marks on every tab. | Colours approved. Orientation at the card's speed, hidden with a note until a target is set. No speed slider: speed only rescales shear, the charts show the dependence. Warning marks everywhere. |

## Checks (node, CPU flow fields through the lab's own wall code: `node proto/flow/wss_checks.js`)
- Pipe R 8 / 16: mean wall shear −0.16 % / −0.04 %, force balance 0.03 % / 0.01 %.
- Square duct 28.6 / 44.3 voxels: −0.99 % / −0.38 % (sharp inside corners read low; shrinks with size), force balance −1.6 % / −0.8 %.
- Probe areas equal `marginSurfaceArea` to 3e-9; normals point away from the solid; slab merge exact.
- Sheet gyroid 32³ → 48³: force balance −2.3 % → −1.2 %, median shear per mm/s 12.4 → 13.2 mPa (wall shear converges more slowly than permeability — 64³ is the sensible floor); (1,1,0) superposition 6e-5.
- Generated stress shader = reference formula (transcribed, run in node).
- Orientation map at X / Y / Z = per-axis card statistics to 4 decimals. On an uneven-channel test lattice the best direction was diagonal (58 % at the Ti target vs 45 % for the best axis).

## Things learned
- **Line endings.** `50-controls.js`, `30-view-tabs.js` and `22-stiffness-viz.js` are CRLF (50-controls mixed). Python's text-mode `open()` rewrote them as LF; fixed before the wrap-up by restoring each line's original ending. Edit with `newline=''` (or the Edit tool) to keep endings.
- Thin sheets: the analytic field and the discretized (trilinear) wall can disagree on which side is solid; probe normals follow the discretized wall, which is what the solver sees.
- Matt's own design with a 2.5-voxel narrowest pore at 64³ read "wall force off by 7 %" — expected; it needs 128³ for wall shear.

## Files
- New: `19h-flow-wss.js`, `24-flow-charts.js`, `proto/flow/wss_checks.js`.
- Changed: 14e (probes, solid volume; `FLOW_LINKS_VERSION` fl-3), 17c (probes in `flowlinks` jobs; tv-8), 19f (ρ per node), 19g (stress kernel; `FLOW_GPU_VERSION` fg-3), 21 (shear texture), 22 (scalar sphere mode), 30, 40, 50, 51, lab.css, index.html.
