# F13LD.lab

**Status:** v0.1.0-shell · alpha · UI shell only, no compute yet
**License:** All rights reserved · License under review

GPU-accelerated qualification tool for deep structural evaluation of metamaterial scaffolds. Browser-resident, statically hosted, designed for side-by-side comparison of up to three designs from F13LD.vault.

Part of the [F13LD](https://f13ld.app) computational design suite.

---

## What this is

F13LD's design tools (TPMS, Grain, Noise, Bundle) are fast and exploratory — built around real-time WebGL raymarching with MIL-HS for design-time property estimation. F13LD.lab is the qualification half of the workflow: same browser tab, but compute-deep instead of compute-fast. Linear elastic, linear buckling, nonlinear plasticity, thermal — at solver fidelities the design tools deliberately don't reach for.

Where design tools answer *"what does this look like?"*, lab answers *"is this design actually good for production?"*

## Hardware requirements

- WebGPU-capable browser (Chromium 124+, Safari 18+, Firefox with `dom.webgpu.enabled`)
- Discrete or modern integrated GPU recommended; WASM CPU fallback exists but is 10–20× slower
- 4 GB+ VRAM for default tier (64³ grid · 3-design comparison · full pipeline)
- 8 GB+ VRAM for high-fidelity tier (128³ grid)

## Compute envelope

| Mode                          | N=64 · 1 design | N=64 · 3 designs |
| ----------------------------- | --------------- | ---------------- |
| Linear elastic                | ~2 s            | ~6 s             |
| + Linear buckling             | ~35 s           | ~1.7 min         |
| + Nonlinear (J2 + geom)       | ~2.5 min        | ~7.5 min         |

10-minute ceiling for default tier. F13LD = FAST.

## Roadmap

This is Phase 1 of a 10-phase build. Current state: UI shell, mock data, no compute.

- **Phase 1** ← *here* · UI shell, hardware detection, design ingest scaffolding
- **Phase 2** · WebGPU foundation, WGSL FFT kernel
- **Phase 3** · SDF rasterizer (ports F13LD.sweep family code), linear elastic FFT-CG
- **Phase 4** · Stiffness directional surface viz, 3-design comparison
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
