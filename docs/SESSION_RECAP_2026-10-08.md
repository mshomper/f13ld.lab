# Session recap — 2026-10-07 / 08

Versions shipped to main: **v0.22.0 → v0.25.0**.

## What changed

| Version | Contents |
|---|---|
| v0.22.0 | Bottom panel replaced by a one-row **dock + Configure drawer** (`51-dock.js`); physics icons in the brand icon style; whole tool re-coloured to the **Lab red** from the F13LD brand guidelines (tile #F6E7E7, stroke #8C2A2E, on-dark accent #E06A6F); purple and cyan removed |
| v0.23.0 | **Thermal Phase 3**: material conductivities revised from the literature (as-built AM where published, else wrought), heat capacity for every entry; Surface Area Density and Diffusivity rows on the Thermal κ cards; sweep *Physics: stiffness + thermal*; geometry columns (porosity, surface area density, hydraulic diameter, open pore axes) — `THERMAL_SCOPE.md` §14 |
| v0.24.0 | No freeze on load or Run: elastic voxel prep and viewer bakes on the worker pool (`17c`, bit-identical, `validate-prep.js`), non-blocking shader compile; startup splash ("Resolve") and status chip with the rippling F13LD mark (`52-status.js`); new defaults; Configure settings saved per browser; fixed grids |
| v0.25.0 | Shear-axis stress display fix; Deformed merged into **Stress**; VIEW tabs renamed with icons; readout chips removed |

## Decisions (Matt)

- Dock + drawer layout; physics icons instead of dots; Lab is red per the brand guidelines; header tool name #E06A6F; red carried across the whole tool.
- Thermal falls back to the wrought conductivity when no AM value is published; surface area density on the cards, other geometry metrics in the sweep CSV and Atlas only.
- Defaults for a new browser: Ti-6Al-4V Grade 5 (HIP), all networks, partial volume, Elastic 64³, Thermal (water) on, Buckling and Crush off. Saved choices win once they exist.
- Hardware-based Auto grid removed.
- Startup animation C ("Resolve"), corner status B ("Field" mark ripple) — animating the mark's waves is acceptable.
- Stress tab icon: contour rings around a hot spot. No horizontal scrolling anywhere in the UI.
- Test builds can be shared before merging with a raw.githack.com link to the branch.

## Open items / next session

1. **Move Buckling and Crush voxel prep onto the worker pool** (they still voxelize on the main thread; both are off by default now).
2. Fluids v1 (`FLUIDS_LBM_SCOPE.md`), then the heat-exchanger phases.
3. Tantalum conductivity: the AM data sheet's 45 W/m·K is used (method not stated); revisit if a measured value appears.
