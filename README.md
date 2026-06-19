# F13LD.lab

**Status:** v0.6.0 · alpha · Phase 6 in progress · Nonlinear J2 plasticity + adaptive crush + σ–ε comparison live
**License:** All rights reserved · License under review

🔗 **[Launch the tool](https://mshomper.github.io/f13ld.lab)**
📓 **[Per-phase engineering logs](./docs/)** — handoff-quality records of every phase, decision, and bug

GPU-accelerated qualification tool for deep structural evaluation of metamaterial scaffolds. Browser-resident, statically hosted, designed for side-by-side comparison of up to three designs from F13LD.vault.

Part of the [F13LD](https://f13ld.app) computational design suite.

---

## What this is

F13LD's design tools (TPMS, Grain, Noise, Bundle) are fast and exploratory — built around real-time WebGL raymarching with MIL-HS for design-time property estimation. F13LD.lab is the qualification half of the workflow: same browser tab, but compute-deep instead of compute-fast. Linear elastic, linear buckling, nonlinear plasticity, thermal, and Stokes permeability — at solver fidelities the design tools deliberately don't reach for.

Where design tools answer *"what does this look like?"*, lab answers *"is this design actually good for production?"*

## Hardware requirements

- WebGPU-capable browser (Chromium 124+, Safari 18+, Firefox with `dom.webgpu.enabled`)
- Discrete or modern integrated GPU recommended; WASM CPU fallback exists but is 10–20× slower
- 4 GB+ VRAM for default tier (64³ grid · 3-design comparison · full pipeline)
- 8 GB+ VRAM for high-fidelity tier (128³ grid)
- Linear buckling runs on CPU workers (no GPU required for that tab) but the page must be served over **http(s)** — Blob-worker `importScripts` is blocked under `file://`

## Compute envelope

| Mode                            | N=64 · 1 design | N=64 · 3 designs |
| ------------------------------- | --------------- | ---------------- |
| Linear elastic (full Voigt 6×6) | ~4 s †          | ~12 s †          |
| + Nonlinear (J2 + geom)         | ~2.5 min        | ~7.5 min         |
| + Stokes permeability           | ~3 min          | ~9–10 min        |

† Full-Voigt runs ≈2× the Phase 3 normal-only figures (6 load cases vs 3); N=64 timing is predicted, not yet measured — validated at N=16 and N=32. 10-minute ceiling for default tier. F13LD = FAST.

**Linear buckling** runs on a CPU Web Worker pool, independent of the GPU grid above (it does not use the N=64 path). Measured on an 8-core desktop, Schwarz P: **N=8 three-axis ≈ 18 s per design** (vs ~62 s serial); N=16 is opt-in. See [`docs/BUCKLING.md`](./docs/BUCKLING.md).

**Nonlinear crush** runs at its own resolution (the Nonlin pill, default 16³ — not the elastic grid) and to a user strain cap (default 5%). It is the slowest stage (sync-bound CG); per-mode timing and a calibrated estimate are in progress, so the headline estimate currently under-reports it. See [`docs/NONLINEAR.md`](./docs/NONLINEAR.md).

## What's new in v0.6.0

Phase 6 adds **nonlinear crush** (J2 plasticity + geometric NL) behind the σ–ε view tab, and uses its real per-design yield to retire the provisional buckling seam. A from-scratch crush solver — a CPU oracle cross-validated against a GPU solver — produces the effective uniaxial stress–strain response and the 0.2%-offset effective yield σ_y_eff.

### Nonlinear J2 solver

- **A CPU reference oracle** (`16f-nonlinear-cpu-ref.js`) and a **GPU solver** (`16g-nonlinear-solver.js`) that composes the full-Voigt elastic solver, reusing its FFT, Green's operator, and CG path. Validated on the Schwarz P demo: oracle σ_y_eff = 214.3 MPa, E0 = 31.28 GPa at N=8; GPU-vs-oracle cross-check E0 rel 6e-7, σ_y rel 1.06e-3.
- **Adaptive crush.** Steps to a detected 0.2%-offset knee (plus a few steps past it) or to a user strain cap — capturing yield where it exists and stopping early when it doesn't.
- **Honest no-yield reporting.** Compliant low-density designs that stay elastic to the cap report `no yield (> σ_cap)` rather than a fabricated yield.

### σ–ε comparison tab + buckling context

- **Real per-design σ–ε curves** with auto-scaled axes and a 0.2%-offset yield marker (drawn only when a real knee exists).
- **σ_cr cross-reference line.** The buckling critical stress is overlaid on the σ–ε axes; when it sits below yield, the plot flags the design *buckling-limited — collapses at σ_cr before yield*. Material yield and elastic stability now read on one set of axes.

### Real yield retires the provisional seam

- `P_cr/P_y` now divides the real critical stress by the design's own σ_y_eff — the `*` drops when a design yields. For designs that don't yield in range, it shows an honest upper bound `< σ_cr/σ_cap` instead of dividing by solid-Ti yield.

### Crush controls

- **Nonlin grid pill** (default **16³** — the floor for sheet-TPMS; 8³ is too coarse for thin shell walls and reads ~2× too stiff).
- **Crush-ε cap pill** (2 / 5 / 10%, default 5%) — bounds the adaptive crush.
- **Crush-axis dropdown** (ZZ default — physiological compression).
- **Live per-step progress** during the long crush phase.

Full detail in [`docs/PHASE_6.md`](./docs/PHASE_6.md) and [`docs/NONLINEAR.md`](./docs/NONLINEAR.md).

## What's new in v0.5.0

Phase 5 adds **linear (eigenvalue) buckling** as a fifth view tab — the stability question that governs low-density scaffolds, where thin walls buckle long before the material yields.

### Linear buckling solver

- **A matrix-free buckling oracle** (`16c-buckling-cpu-ref.js`) solves the cell-periodic geometric-stiffness eigenproblem per normal axis, returning the critical load factor λ_cr, critical stress p_cr, and the mode shape. Cross-validated against a dense generalized eigensolve at N=4 to machine precision (relative error 2.7e-15).
- **Runs in a Web Worker pool** (`16e-buckling-cpu-worker.js`) — one axis per worker, `min(cores−1, 8)` workers. N=8 three-axis ≈ 18 s per design on an 8-core desktop (N=16 opt-in via the Buckle pill). A Fourier preconditioner cuts the inner CG ≈3.6×.

### Buckling visualization

- **Animated mode-shape tab.** The mode swings full-cycle through the undeformed shape (2.5 s), colored by relative displacement on a turbo ramp — blue nodes, red antinodes — so you can see *where* and *how* the structure buckles. Amplitude is a qualitative exaggeration control (0–30 % of cell); a buckling eigenvector carries no absolute scale.
- **Local-vs-global localization chip.** A single scalar (RMS waves per cell of the mode within the solid) classifies each mode Global / Mixed / Local as a stoplight chip in the viewport corner. Strut-like topologies read local; smooth TPMS shells read global — matching the physics.
- **Provisional strength ratio.** `P_cr / P_y` (flagged `*`) compares p_cr against a fixed Ti-6Al-4V yield, pending the per-design yield from the nonlinear phase.

Full detail in [`docs/BUCKLING.md`](./docs/BUCKLING.md) and [`docs/PHASE_5.md`](./docs/PHASE_5.md).

## What's new in v0.4.0

Phase 4 takes the solver from Phase 3's normal-only 3×3 to the full Voigt 6×6 tensor and builds the visualization layer the new tensor unlocks. All four core view tabs — Geometry, Deformed, Stress field, Stiffness ⊕ — are operational, and shear physics is fully visible.

### Full Voigt 6×6 elastic homogenization

- **The production solver is now full-tensor** (`16b-elastic-solver-full.js`). Six load cases per design — three normal (xx/yy/zz) plus three shear (yz/xz/xy) — return the full 6×6 effective stiffness C_eff, the 6×6 compliance S, the three shear moduli Gxy/Gxz/Gyz, three Poisson ratios, and a real Zener anisotropy ratio. The Phase 3 normal-only solver (`16-elastic-solver.js`) is retained as an unused fast-triage path.
- **Cross-validated against a CPU oracle** (`16a-elastic-cpu-ref-full.js`) at N=16 on Schwarz P: 0.001–0.004 % drift on Ex/Ey/Ez, Gxy/Gxz/Gyz, and the Zener ratio.
- **Full von Mises σ_VM with shear contributions.** Stress on anisotropic structures (spinodoid, hyperuniform) reads 5–15 % higher than the Phase 3 normal-only path — correct, not a regression. Schwarz P is unchanged because shear decouples from normal loading under cubic symmetry.

### Visualization

- **Stiffness ⊕ tab** (`22-stiffness-viz.js`) — a per-design WebGL surface of the directional Young's modulus E(n̂) over an icosphere, colored by E(n̂)/E_max, with a per-tile readout of E_max, E_min, and anisotropy ratio. Verified against Schwarz P's cubic [111] limit (E_max/E_min = 1.70).
- **Six-position load-axis toggle** (xx/yy/zz/yz/xz/xy) exposes σ_VM under shear loading in the Stress tab without re-solving. The Deformed tab renders three of six axes — u'(x) reconstruction is defined only for normal strains.
- **Cividis colormap + sage viewport.** Both the stress raymarcher and the stiffness surface render against a sage (`#6b6e64`) radial-vignette background with the cividis colormap (colorblind-safe, print-friendly): matte navy → khaki → soft amber, tuned to the F13LD palette.

### Connectivity gating

- **Periodic 6-connectivity flood-fill** (`14a-connectivity.js`) runs between rasterization and the CG solve. Warn-only by default; opt-in rejection via `opts.connectivity.minLargestFraction`. Every result now carries a `connectivity` report for future UI surfacing.

## Roadmap

- **Phase 1** · UI shell, hardware detection, design ingest scaffolding ✓
- **Phase 2** · WebGPU foundation, WGSL 3D FFT kernel ✓
- **Phase 3** · SDF rasterizer, linear elastic FFT-CG, field extraction, viz stack ✓
- **Phase 4** · Full Voigt 6×6 with shear cases, stiffness directional surface viz, connectivity gating, six-axis toggle ✓
- **Phase 5** · Linear buckling — CPU oracle + worker pool, animated mode-shape viz, local/global localization ✓ *(GPU LOBPCG solver deferred as a follow-on)*
- **Phase 6** ← *in progress* · Nonlinear (Newton + J2 plasticity) — solver + σ–ε comparison live and supplying the per-design yield for P_cr/P_y; field-viz tab queued
- **Phase 7** · ~~Deformed-geometry domain warp, stress field overlay~~ — landed early in Phase 3
- **Phase 8** · Thermal κ tensor, remaining view modes
- **Phase 9** · Multi-page PDF export
- **Phase 10** · F13LD.vault integration (fetch, push as new property record)

## Architecture summary

Static HTML/CSS/JS. No backend. No build step. WebGPU compute off the main thread, WebGL2 raymarching for visualization, and a CPU Web Worker pool for linear buckling (one axis per worker). Geometry generated from vault parameters at lab-open time using ported family code from F13LD.sweep — no rasters stored anywhere in the suite.

## Development

```bash
git clone https://github.com/mshomper/f13ld.lab.git
cd f13ld.lab
# serve locally with any static server, e.g.
python3 -m http.server 8000
# or just push to gh-pages
```

No dependencies, no package manifest, no build. Open `index.html`.

---

© 2026 Not a Robot Engineering LLC · matt@notarobot-eng.com