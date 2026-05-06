# F13LD.lab

**Status:** v0.3.0-rc2 · alpha · Phase 3 push 2 · GPU elastic FFT-CG live
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

## What's new in v0.3.0-rc2

Phase 3 push 2 lands the GPU elastic FFT-CG solver.

- **FFTPlan extended** — added `forwardEncoded(encoder)` / `inverseEncoded(encoder)` and GPU-side `loadFromBuffer` / `storeToBuffer` so the elastic solver can batch 6 FFTs plus a dozen small kernels into a single command submit per CG iteration (`12-fft-plan.js`)
- **Elastic solver** — full WGSL kernel set (localStress, tauCompute, packComplex, gammaAccum, deAccum, axpy, xbpy, fill, dotReduce) plus the `ElasticSolver` JS class that orchestrates conjugate-gradient iterations to convergence (`16-elastic-solver.js`)
- **Self-test 3** — solves all three demos via the GPU CG, validates Schwarz P against a CPU reference (cubic isotropy + magnitude in the normal-only band), reports per-design Ex/Ey/Ez, iter counts, and timing breakdowns (`17-elastic-test.js`)

UI gains a new `▸ Run elastic · 3 demos` link below the existing two self-tests. Click it to run the full GPU CG pipeline on Schwarz P, Spinodoid, and Hyperuniform; Ex/Ey/Ez for each design will paint into the design column E11 stat.

### Known approximation: normal-strain-only FFT-CG

Push 2's elastic solver mirrors F13LD.sweep's `cgSolveNormal`: it solves three normal load cases (xx, yy, zz) and pins local shear strains to zero. Exact for the macro response of isotropic constituents under pure normal loading; for heterogeneous microstructures it OVERESTIMATES effective stiffness by roughly 10–20% compared to full 6-strain FFT-CG (because shear DOFs that would localize stress at material boundaries are constrained out).

For Schwarz P solid at ρ=0.5 with Ti-6Al-4V (Es=110 GPa), the normal-only method gives E_eff ≈ 0.49·Es ≈ 54 GPa (CPU reference verified at N=8/16/32). Full 6-strain literature values land closer to 0.30–0.45·Es. The difference is the documented price of the approximation, and sweep ships this knowingly because it's adequate for design *ranking* across thousands of recipes.

Lab inherits the same approximation for Phase 3 and lifts to full 6-strain (with shear cases yz, xz, xy) in Phase 4 alongside the directional stiffness surface viz. Numbers from rc2 will shift downward in Phase 4 as a result — expected and documented.

## Roadmap

- **Phase 1** · UI shell, hardware detection, design ingest scaffolding ✓
- **Phase 2** · WebGPU foundation, WGSL 3D FFT kernel ✓
- **Phase 3** ← *here · push 2 of 3* · SDF rasterizer, linear elastic FFT-CG, Stokes-Brinkman flow
- **Phase 4** · Full Voigt 6×6 with shear cases, stiffness directional surface viz, connectivity gating
- **Phase 5** · Linear buckling (LOBPCG)
- **Phase 6** · Nonlinear (Newton + J2 plasticity)
- **Phase 7** · Deformed-geometry domain warp, stress field overlay
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
