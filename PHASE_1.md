# Phase 1 — UI Shell & Hardware Detection

**Status:** complete · v0.1.0-shell
**Duration:** 1 working day
**Outcome:** Static HTML/CSS/JS shell with mocked compute, ready for real solvers to drop in behind the existing UI surface.

---

## Objective

Stand up the F13LD.lab application skeleton: header (matching Grain), 3-design comparison grid, view-mode tabs, controls panel, hardware detection, ?r= URL ingest. No real compute — just a credible mock-data path so subsequent phases can replace mocks with real solvers without touching the UI layer.

Treat lab as a sibling of the existing F13LD design tools (TPMS, Grain, Noise, Bundle), not a refactored extension. Its job is *qualification*, not *exploration*. Where design tools answer "what does this look like?", lab answers "is this design good for production?"

## Architecture decisions

- **Static deployment.** No backend, no build step. GitHub Pages from `mshomper/f13ld.lab`. Same operational pattern as every other F13LD tool — deploy is a git push.
- **Flat repo.** No `js/` or `css/` subdirectories. Numbered prefixes on JS files (`00-mock-data.js`, `10-hardware.js`, ...) drive load order via plain `<script>` tags. No module system, no bundler. Files load lower-numbered first.
- **Tool accent: amber `#fbbf24`.** Distinct from Grain's cyan to keep the suite legible at a glance. Header pattern is bit-identical to Grain (logo + wordmark + divider + tool name) — ensures lab feels native to the suite.
- **3-design comparison cap.** Rationale: at 64³ × 3 designs × full physics pipeline we just fit under a 10-minute ceiling. 4+ designs blow that budget. UI design (responsive grid, side-by-side property cards) anchored on this.
- **WebGPU required, no WebGL2 fallback.** Push 2's elastic solver assumes WebGPU compute. WASM CPU fallback was scoped out — sweep already provides a CPU path for users without WebGPU.
- **Geometry from params, not from stored rasters.** Vault stores recipe JSON; lab regenerates geometry on open via the family kernels. Confirmed in conversation with Matt: no raster storage tier in the suite.

## File inventory at end of phase

```
index.html        — header, view tabs, comparison grid shell, controls panel
lab.css           — F13LD design tokens (matching Grain), lab amber accent
00-mock-data.js   — 3 preloaded mock designs with realistic-looking property values
10-hardware.js    — WebGPU adapter detection (eager, no device yet); tier classification
20-svg-mocks.js   — SVG generators for all 7 view modes (geom, deform, stress, etc.)
30-view-tabs.js   — global view-mode state, per-design deformation amplitude
40-design-grid.js — renders 3-design columns OR merged σ-ε plot, baseline-relative deltas
50-controls.js    — physics toggles, grid pill (Auto cycle), mock run progress walkthrough
60-add-design.js  — file picker, ?r= URL param, vault stub, action button gating
99-init.js        — boot sequence
README.md         — status, hardware reqs, compute envelope, roadmap, license
```

## What worked

- **Header pattern matching Grain.** Cost: 30 minutes of CSS porting. Benefit: lab feels native to the suite from the first frame, no "is this part of F13LD?" friction.
- **Mock data driving the same grid renderer real data will use.** Turned out to be the right move — every subsequent phase replaces a piece of mock content (ρ in Push 1, Ex in Push 2) without touching `40-design-grid.js`. The grid is content-agnostic by design.
- **Hardware tier auto-pick.** Detects adapter, classifies into Low/Mid/High/Ultra tiers, sets initial grid resolution. User can override via the Auto-cycle pill. Auto-detection has been correct for both Matt's NVIDIA desktop and the headless containers I've tested in.
- **Numbered file prefixes.** Originally a stopgap to avoid module configuration. Has scaled cleanly across 14+ files in subsequent phases. Naming convention: 00-09 = data, 10-19 = compute infrastructure, 20-29 = visualization, 30-39 = state, 40-49 = layout, 50-59 = controls, 60-69 = ingest, 70-79 = self-tests, 99 = init.

## Pitfalls encountered

- **Initial deploy showed an unstyled page.** Looked like a CSS load failure but was actually GitHub Pages caching — a fresh deploy needed a forced refresh / wait. Diagnosed via "rendering properly after reload, looks like Git hadn't committed the changes yet." No code fix needed, but worth flagging for future deploys: GH Pages can take 30-60 seconds to rebuild after push.
- **Folder vs flat upload confusion.** First upload preserved the original development folder structure (`js/`, `css/`); GitHub Pages couldn't resolve the unversioned paths in `index.html`. Fixed by re-uploading flat. Going forward, all bundles ship flat to match repo layout.

## Validation

No self-tests yet — Phase 1 is pure UI. Validation was visual: open the URL, confirm three demo cards render with mock data, confirm view tabs switch, confirm controls toggle, confirm hardware pill populates with detected GPU.

## Handoff state

- Repo: `https://github.com/mshomper/f13ld.lab`
- Live: `https://mshomper.github.io/f13ld.lab`
- All UI plumbing in place. Mock data flows through the same code paths real data will. No subsequent phase needs to modify the UI layout layer.

## What Phase 2 inherits

- `WGPU` global (defined later in Phase 2's `11-webgpu-device.js`) — Phase 1 only does adapter detection, leaves device init for lazy creation when a self-test or solver actually needs the device.
- `LAB_STATE.designs[]` — array of 3 design objects, populated from mocks. Phase 2 doesn't touch this; Phase 3 replaces mock entries with real recipes.
- `paintHardwarePill / paintGridPill / paintSolverPill / updateLoadedPill / updateActionButtons / recomputeEstimate` — UI atoms exposed for downstream phases to call.
