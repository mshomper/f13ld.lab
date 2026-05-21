# F13LD.lab

**Status:** v0.3.1 · alpha · Phase 3 push 3 of 3 · GPU elastic + visualization stack live
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

## Compute envelope

| Mode                          | N=64 · 1 design | N=64 · 3 designs |
| ----------------------------- | --------------- | ---------------- |
| Linear elastic (normal-only)  | ~2 s            | ~6 s             |
| + Linear buckling             | ~35 s           | ~1.7 min         |
| + Nonlinear (J2 + geom)       | ~2.5 min        | ~7.5 min         |
| + Stokes permeability         | ~3 min          | ~9–10 min        |

10-minute ceiling for default tier. F13LD = FAST.

## What's new in v0.3.1

Phase 3 push 3 closes Phase 3 with the physics correctness chain and the visualization stack on top of the elastic solver.

### Physics correctness chain

- **`buildGamma` textbook formula** — ported from F13LD.sweep v0.16.0, replacing the Voigt-biased version. Schwarz P at ρ=0.5 now lands at E11 = **33.16 GPa** (effective ρ exponent ~1.74, inside the skeletal-TPMS ρ¹·⁶⁻²·⁰ band). The rc2 value of 54.09 GPa was a known overestimate from a projector-sign bug; rc3 is correct (`14-rasterizer.js`).
- **Per-LC field extraction** — solver now captures displacement u'(x) (RGBA8 3D texture) and von Mises stress σ_VM(x) (R8 3D texture) per load case via closed-form spectral inversion. Both feed the new visualization tabs (`16-elastic-solver.js`).
- **CG convergence tuned to sweep rigorous** — `CG_TOL` tightened from 1e-5 (cap-hit) to 1e-4 (true convergence); `CG_MAXITER` raised 100 → 300. Schwarz P now converges in 230 iters/LC at ~1.7 s wall (was hitting the cap at 100). Same convergence as F13LD.sweep solver.
- **Multi-axis loading** — all three physical load cases (x, y, z) captured by default. Per-design X/Y/Z toggle in the deformed/stress tabs re-uploads the matching axis without re-solving.

### Visualization stack

- **Deformed view** — backward-warp raymarcher applies `u(x) = ε̄·x + u'(x)` to the SDF lookup, showing both macroscopic stretch and microstructural fluctuation in one render. Amp slider live-scales (0–100%); pointer-drag rotates; wheel zooms. Auto-rotate disabled in this mode so the load direction stays unambiguous (`21-raymarcher.js`).
- **Stress field view** — viridis colormap on σ_VM, with three layered honesty fixes: p95 percentile clipping for the long-tail distribution, one-voxel σ_VM dilation into adjacent void to eliminate interface contamination at thin walls, and per-design auto-gamma so median σ_VM maps to the colormap midpoint regardless of structure type. Diffuse-only shading; per-tile colorbar with `p95 · γ=X.XX` annotation; true σ_VM,max surfaced in the per-tile readout.
- **per/shared normalization toggle** — view-strip segmented control (visible only in stress mode). `per` = auto per-design (default; best for spatial pattern discovery). `shared` = global p95 cap across all designs, linear viridis (best for cross-design absolute comparison — "yellow" everywhere maps to the same σ_VM).

### Known approximation: still normal-strain-only FFT-CG

rc3 ships the same normal-only (xx/yy/zz) load case set as rc2. Effective stiffness is still ~10-20% high in shear-dominated regimes (sheet TPMS, hyperuniform networks at low ρ) relative to full 6-strain literature values. For Schwarz P, which is close to normal-dominated, rc3's 33.16 GPa is within ~5% of full-Voigt literature reports — well inside the rc2 → rc3 correction band of ~20 GPa. **Phase 4 lifts to full Voigt 6×6 (shear LCs yz, xz, xy)** alongside the directional stiffness surface viz; sheet TPMS numbers will shift downward another ~10% when Phase 4 lands.

The visualization stack built in rc3 is designed to receive Phase 4's output unchanged — fields by axis just become fields by LC, with the existing X/Y/Z toggle extended to six positions.

## Roadmap

- **Phase 1** · UI shell, hardware detection, design ingest scaffolding ✓
- **Phase 2** · WebGPU foundation, WGSL 3D FFT kernel ✓
- **Phase 3** · SDF rasterizer, linear elastic FFT-CG, field extraction, viz stack ✓
- **Phase 4** ← *next* · Full Voigt 6×6 with shear cases, stiffness directional surface viz, connectivity gating
- **Phase 5** · Linear buckling (LOBPCG)
- **Phase 6** · Nonlinear (Newton + J2 plasticity)
- **Phase 7** · ~~Deformed-geometry domain warp, stress field overlay~~ — landed early in Phase 3 push 3
- **Phase 8** · Thermal κ tensor, remaining view modes
- **Phase 9** · Multi-page PDF export
- **Phase 10** · F13LD.vault integration (fetch, push as new property record)

## Architecture summary

Static HTML/CSS/JS. No backend. No build step. WebGPU compute off the main thread, WebGL2 raymarching for visualization. Geometry generated from vault parameters at lab-open time using ported family code from F13LD.sweep — no rasters stored anywhere in the suite.

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