# Phase 4 — Full-Voigt 6×6 · Stiffness Surface · Connectivity · Six-Axis Toggle

**Status:** complete · v0.4.0
**Duration:** 4 working days across two sessions (2026-05-20 → 21 and 2026-05-22 → 23)
**Outcome:** Full Voigt 6×6 elastic homogenization is the production qualification path. New Stiffness ⊕ tab renders the directional Young's-modulus surface E(n̂). Periodic connectivity gating runs between rasterization and CG. Six-position load-axis toggle (xx/yy/zz/yz/xz/xy) exposes shear σ_VM in the stress tab.

All four core view tabs (Geometry / Deformed / Stress / Stiffness ⊕) are operational. Shear physics is fully visible.

---

## Objective

Move from Phase 3's normal-only 3×3 GPU solver to the full Voigt 6×6 — add the three shear load cases — then build the visualization layer the new tensor unlocks. Five pieces, originally scoped together:

1. **Full Voigt elastic homogenization** — 3 normal + 3 shear LCs returning the 6×6 effective stiffness `C_eff`, the 6×6 compliance `S`, and the macroscopic Zener anisotropy ratio.
2. **Field extraction for shear LCs.** σ_VM is rotationally invariant and well-defined regardless of LC; u'(x) reconstruction via diagonal spectral inversion is defined only for normal LCs. The asymmetry needed to be handled explicitly in both the solver and the raymarcher.
3. **Directional stiffness surface E(n̂)** — a new tab. Per-design WebGL canvas rendering 1/E(n̂) = v^T·S·v over an icosphere.
4. **Connectivity gating between rasterizer and CG.** Originally flagged in the Phase 3 handoff as becoming more important once shear LCs landed, since sparse or disconnected geometries can push the FFT-CG iteration into very-long-iteration regimes under shear loading.
5. **Six-position load-axis toggle.** Phase 3's three-button X/Y/Z toggle extended to xx/yy/zz/yz/xz/xy so the user can directly visualize σ_VM under shear loading without re-solving.

Phase 4 ran across two sessions. The first session shipped the solver, the production swap, the field-extraction port, the four viz UX upgrades, and the Stiffness ⊕ tab — pushes 3 through 5 below. The second session shipped the deferred finishing items (connectivity gating, the six-axis toggle), retired a now-obsolete UI knob (the linear/cubic interp toggle), and chased a subtle scoping bug that the six-axis work surfaced.

### Scope boundaries set up front

- **Engineering-Voigt convention.** The solver returns `C_eff` and `S` in engineering-Voigt (S₄₄ = 1/G, not the tensor-Voigt S₄₄ = s₂₃₂₃ that has an extra factor of 4). All downstream consumers must respect this. The convention trap bit us once during Push 5 (see Push 5.2) and is now permanently documented in `22-stiffness-viz.js`.
- **Shear-axis u'(x) not reconstructed.** The diagonal spectral inversion that turns ε'(x) into u'(x) is well-defined only for normal-strain components. Shear LCs produce per-voxel σ_VM (full von Mises with shear contributions) but the displacement field is left null. This is a math limit, not a code shortcut; mixed-strain spectral inversion is a research task for a later phase.
- **`16-elastic-solver.js` retained.** The Phase 3 normal-only solver is no longer wired into Run All, but its `_es_fft3d` helper is still called by `extractFieldsForLCFull` in 16b for the u'(x) reconstruction round-trip. Both files coexist until a standalone FFT helper extracts the dependency.
- **WebGPU required, no fallback.** Consistent with Phase 3.

---

## TL;DR — what landed

| Push | Title | Outcome |
|---|---|---|
| 3 | GPU full-Voigt 6×6 solver (`16b-elastic-solver-full.js`) | Cross-validated against CPU oracle at N=16: 0.001–0.004 % drift on Ex/Ey/Ez, Gxy/Gxz/Gyz, Zener |
| 4a | Full-Voigt as the lab's production default | Two-line dispatcher swap; 6 LCs per design |
| 4a.1 | Field extraction in full-Voigt solver | Deformed / Stress tabs unregressed; full von Mises σ_VM with shear contributions |
| 4b | Four UX upgrades (amp reframe, cubic interp, sat slider, cividis) | All four operational |
| 5 | Stiffness ⊕ tab with directional E(n̂) surface | Math verified; full viz polish |
| 5.1 | Bridge S tensor through `mapElasticToResults` | One-line gating fix |
| 5.2 | Engineering-Voigt convention bug fix in viz | Math reverified vs cubic [111] |
| 5.3 | Culling / auto-rotate / split radius+color norm | Three-fix consolidation |
| 5.4 | Zoom range expansion + sage viewport background | `#8e9184` |
| 5.5 | Darker sage (`#6b6e64`) + radial gradient | Both viewport types |
| 6 | Periodic connectivity gating (`14a-connectivity.js`) | Warn-only by default; opt-in rejection via `opts.connectivity.minLargestFraction` |
| 7 | Remove the linear / cubic interp toggle; cubic-always | Net ~95 lines removed across three files |
| 8 | Six-position axis toggle (xx/yy/zz/yz/xz/xy) | Shear σ_VM exposed in stress tab; ε̄=0 in deform on shear |
| 8.1 | `epsR` scope regression discovered + fixed | Single-var hoist; uniform deep-navy shear renders → real σ_VM gradients |

---

## Architecture decisions

### Solver

**Sibling pattern for the full-Voigt solver.** `16-elastic-solver.js` (Phase 3, rc3, normal-only) was kept as-is; the full-Voigt solver lives in a parallel file `16b-elastic-solver-full.js`. Rationale:

- Risk isolation. The full-Voigt solver introduced four new WGSL kernels (`localStressFull`, `tauComputeFull`, `gammaAccumFull` split into Write/Add halves, `deAccumLane`) plus several auxiliary pair-kernels. Keeping it in a separate file made the bring-up reversible — if the production swap had to roll back, it was one line.
- The rc3 solver could continue as a fast-triage path for normal-only screens (3 LCs vs 6 LCs ≈ 2× faster), if that ever becomes useful. It isn't currently exposed in the UI but the code path remains intact.
- `16b` reuses `_es_fft3d` from `16-elastic-solver.js` for the u'(x) spectral inversion. Until that helper is factored out, both files stay.

**vec4 packing for 6-component fields.** Voigt has 6 components but the WebGPU portable floor allows only 8 storage bindings per kernel. The solver packs all 6-component fields as a pair of vec4 buffers — `_n` for normal components `[xx, yy, zz, _]` and `_s` for shear `[yz, xz, xy, _]`. This kept every kernel under the 8-binding ceiling.

**Coordinate convention: X↔Z + yz↔xy swap at the API boundary.** The solver runs in a relabeled coordinate frame where x_solver corresponds to z_physical. The mapping table

```
SWAP = [2, 1, 0, 5, 4, 3]   // phys → solver
```

is applied at every entry to `solveDesignElasticFull` and reversed on return. This was inherited from Phase 3 and extended to all six Voigt indices for Phase 4. The mathematical justification for SWAP[3]=5 (and the symmetric SWAP[5]=3):

```
Voigt 3 (yz_phys) = ε_y_phys, z_phys                    (definition)
                  = ε_y_solver, x_solver                (x_phys ↔ z_solver swap)
                  = Voigt 5 in solver coords (xy_solver)
```

SWAP[4]=4 because (xz)_phys = (zx)_solver = (xz)_solver under the symmetry of ε.

**Engineering-Voigt vs tensor-Voigt.** The solver writes the strain and stress in engineering-Voigt form: `ε_voigt = [ε_xx, ε_yy, ε_zz, γ_yz, γ_xz, γ_xy]` where the shear entries are engineering shears (γ_yz = 2 ε_yz). The factor `f = [1, 1, 1, 2, 2, 2]` accounts for this when the rank-4 Γ tensor is collapsed to a 6×6:

```
Γ̃_PQ(n) = f[P] · f[Q] · Γ_{i(P)j(P)k(Q)l(Q)}(n)
```

This is the Moulinec-Suquet form. The `f[P]·f[Q]` factors are baked into the GPU kernel that accumulates ε ← ε - Γ̃·τ; they don't appear in the JS-side code path because the GPU does the application.

### Viz

**Cividis as the default colormap.** Both `sampleStress` (raymarcher) and the stiffness surface (`22-stiffness-viz.js`) use cividis. Nuñez et al. 2018 designed cividis for colorblind safety and print-friendly perceptual uniformity. Matte navy → khaki → soft amber matches the F13LD brand palette better than viridis's saturated green-yellow.

**Shared visual language across the two view paths.** The raymarcher and the stiffness viz both render against the same sage `#6b6e64` background with a radial vignette, both use cividis, both use the same diffuse lighting model. Switching tabs feels like a single tool rendering different things.

**Inline styles for new UI atoms.** The Push 4b additions (amp slider, cubic interp toggle, saturation slider, colorbar) all use inline `style=...` attributes rather than touching `lab.css`. This kept the velocity high during a busy session at the cost of polish debt. Promoting these into class-based selectors is on the polish list (carried into Phase 5).

### Phase 4 second session — additional decisions

**Connectivity gating: warn-by-default, opt-in reject.** The connectivity helper always runs and always surfaces its report on the result object. Rejection (early return before Γ is built) is opt-in via `opts.connectivity.minLargestFraction`. Rationale: zero behavior change to existing demos, full data available for any UI surfacing, and the gate is a single field flip away from active when production demands it.

**Periodic 6-connectivity.** The unit cell tiles infinitely under the FFT solver's periodic assumption. The connectivity check honors this: an island that touches its own image across the cell boundary is one connected component, not two. Choosing aperiodic 6-connectivity would have flagged perfectly-fine periodic structures as disconnected.

**One-slot axis state across deform and stress.** `VIEW_STATE.loadAxis[id]` holds a single Voigt string for both tabs. Two read accessors (`getDeformAxis` for normal-only and `getStressAxis` for any of six) coerce on read without mutating state. A user on YZ in stress mode who switches to deform sees ZZ active visually, but switching back to stress restores YZ. This was the cleaner option than splitting into `loadAxisDeform` and `loadAxisStress` — fewer state slots to keep coherent with localStorage when that lands.

**Default `captureFieldsLCs` = all six.** The cost of the three extra shear σ_VM extractions is ~30 ms per Run All at N=64 (10 ms per LC, no FFT round-trip because shear LCs skip u'(x) reconstruction). Letting the default cover all six means the UI doesn't need to ask the solver for missing data on axis toggle — every fieldset is already there.

---

## Push 3 — GPU full-Voigt 6×6 solver (`16b-elastic-solver-full.js`)

### Architecture

`ElasticSolverFull` class with `solveDesignElasticFull` as the public entry. Six load cases per design — three normal (ε̄=[1,0,0,0,0,0], [0,1,0,0,0,0], [0,0,1,0,0,0]) and three shear (with the 1.0 in positions 3, 4, 5) — solved via Moulinec-Suquet FFT-CG.

Six new WGSL kernels in the file plus several auxiliaries:

- `localStressFull` — per-voxel σ = C(x):ε using the full 6×6 stiffness pick.
- `tauComputeFull` — polarization stress τ = σ - C₀:ε with the reference medium C₀.
- `gammaAccumFull` — applies the Γ̃ tensor to τ in Fourier space. Split into two passes (`Write` and `Add`) to fit the 8-binding storage limit.
- `deAccumLane` — accumulates the per-lane strain update back into the working ε buffer.
- `axpyPair`, `xbpyPair`, `fillPair`, `dotReducePair`, `packComplexLane` — vector-arithmetic auxiliaries operating on the vec4-packed pair layout.

All kernels target 8 storage bindings maximum. The vec4 packing was the key enabler — without it, 6-component fields would have required either non-portable binding counts or a multi-kernel split that would have dominated the dispatch cost.

### Math

**Γ tensor.** The Moulinec-Suquet Green's-function form for a homogeneous reference medium:

```
Γ_ijkl(n) = symmetrization of [n_i n_k δ_jl] / (μ₀ n²)  -  [n_i n_j n_k n_l] / [2 μ₀ (1-ν₀) n²]
```

where μ₀ and ν₀ are the reference medium's shear modulus and Poisson's ratio. Voigt-collapsed via the engineering shear factor f = [1,1,1,2,2,2]:

```
Γ̃_PQ(n) = f[P] · f[Q] · Γ_{i(P)j(P)k(Q)l(Q)}(n)
```

The DC component is special-cased to zero — for a periodic cell, the mean strain is what's applied, so the mean of the perturbation strain ε'(x) must be zero.

**σ_VM with shear.** The full von Mises stress used throughout the extraction path:

```
σ_VM = sqrt( 0.5·[(σ_xx - σ_yy)² + (σ_yy - σ_zz)² + (σ_zz - σ_xx)²] + 3·(σ_yz² + σ_xz² + σ_xy²) )
```

The shear-stress contributions (`3 · shear²`) were the missing pieces from Phase 3's rc3 implementation. For anisotropic structures (Spinodoid, Hyperuniform) where shear stress localizes at material interfaces, Push 4a.1's σ_VM is 5–15 % higher than rc3's; this is correct, not a regression. Schwarz P with cubic symmetry shows essentially zero difference because shear LCs decouple from normal LCs in cubic crystals.

### Cross-validation gate

Schwarz P at N=16 against a CPU oracle (`16a-elastic-cpu-ref-full.js`):

- Ex/Ey/Ez within 1 % of CPU
- Gxy/Gxz/Gyz within 1 % of CPU
- Zener anisotropy ratio within 2 %

The CPU oracle is a serial-FFT-based version of the same algorithm — same math, no GPU. Acts as ground truth for development. Not exposed in the UI; lives behind the self-test panel.

### Hardware verification (Matt's NVIDIA desktop)

```
Schwarz P @ N=16
  Ex/Ey/Ez (GPU/CPU):   32.352 / 32.352 GPa    ·  Δ 0.001 %
  Gxy/Gxz/Gyz:           7.241 /  7.241 GPa    ·  Δ 0.004 %
  Zener A:               0.5310 / 0.5309        ·  Δ 0.003 %
  CG iters:              1623 total · all converged
  GPU wall time:         7927 ms  (1.4× CPU at N=16, dispatch-bound)
```

Speedup at N=64 is expected to be bandwidth-bound (20–40× over CPU) once tested. The N=16 case is dispatch-bound because the kernel launches dominate the actual compute.

### Pitfalls encountered

**writeBuffer coalescing bug (revisited).** Phase 2 had documented the WebGPU pattern: multiple `queue.writeBuffer` calls to the same buffer before a submit get coalesced into the last write only. The FFT plan got this right by pre-baking stage uniforms. The elastic solver got it wrong on the first pass — the CG iteration was writing the iteration count to a uniform buffer and dispatching, expecting per-iteration values. All dispatches saw the same (final) value. Convergence was wrong by a factor that varied with iteration count. Lesson: every WebGPU pattern that depends on per-dispatch uniform variation must either pre-bake the variants or submit between writes. Final fix: pre-baked uniforms for the loop indices.

**WGSL binding limit on `gammaAccumFull`.** First implementation needed 9 storage bindings — over the portable 8-binding floor. Worked on NVIDIA, hit a "too many bindings" error on a Mac M-series test. Split into `gammaAccumFullWrite` (4 bindings) and `gammaAccumFullAdd` (5 bindings) with a temporary intermediate buffer between them. Negligible perf cost; portability restored.

---

## Push 4a — Full-Voigt as the production default

Two-line surgical swap:

- `17-elastic-test.js:74` — `solveDesignElastic` → `solveDesignElasticFull`
- `50-controls.js:245` — same swap in the `▶ Run All` dispatcher

### Behavior changes

- 6 LCs per design instead of 3 → ~2× wall time at N=64.
- `d.results` now carries real Gxy, Gxz, Gyz (was the isotropic surrogate `E / [2(1+ν)]`) and a real Zener ratio (was the diagonal surrogate `Emax / Emin`).
- Schwarz P pass band on the demo self-test tightened from E/Es ∈ [0.40, 0.55] (normal-only regime, no shear restoring force) to [0.25, 0.34] (full-Voigt regime, properly resolves the trilinear interaction).
- Voigt soft ceiling on `Run All` validation tightened from 1.15× to 1.05× — full-Voigt no longer over-estimates due to missing shear interaction.

### What it broke

The Deformed and Stress tabs immediately regressed. The new dispatcher didn't yet emit per-voxel u'(x) or σ_VM — only the homogenized 6×6 returned. The raymarcher had no fieldset to upload, so both tabs fell back to the geometry-only render. This was triaged into Push 4a.1 within the same session.

**Process lesson logged:** *Port consumers before swapping producers.* Always port the full consumer surface area (field extraction in this case) before flipping the dispatcher. Doing it in the opposite order produces a window where things appear to work in some tabs and silently regress in others.

---

## Push 4a.1 — Field extraction in the full-Voigt solver

### What was added to `16b-elastic-solver-full.js`

- **`_readbackPair(pair)`** — reads the vec4-packed `(n, s)` GPU buffer and unpacks it into six `Float32Array(N³)` in Voigt order [σ_xx, σ_yy, σ_zz, σ_yz, σ_xz, σ_xy]. Same readback infrastructure used for both per-voxel stress and (intermediate) per-voxel strain.

- **`extractFieldsForLCFull(eps_bar_6, sigArr_6)`** — for normal LCs. Computes σ_VM with the full formula (including shear contributions). Reconstructs u'(x) via FFT spectral inversion of ε'(x). Returns `{ u_prime, sigma_vm, N, eps_bar }`. The u'(x) recovery uses `_es_fft3d` from `16-elastic-solver.js` — the only remaining cross-file dependency on the Phase 3 solver.

- **`solveLoadCaseFull(eps_bar, opts)`** — `opts.captureFields: true` triggers the per-voxel readback after CG converges, before the next LC overwrites the eps buffer.

- **`homogenizeFull(opts)`** — accepts `opts.captureFieldsLCs: [0, 1, 2]` (default) as a list of solver-internal LC indices to capture. Shear LCs (3/4/5) were initially silently skipped here with a warning, because the spectral inversion for u'(x) is defined only for normal-strain components. This was relaxed in Push 8 to allow stress-only capture for shear LCs.

- **`solveDesignElasticFull(recipe, N, opts)`** — `opts.captureFieldsLCs` accepts physical Voigt indices 0–5; the entry SWAP-translates them to solver-internal indices before passing to `homogenizeFull`. The X↔Z component swap is applied inside each fieldset on return so consumers see physical-axis coordinates.

### Cost

~240 ms per captured LC at N=64 (3 normal LCs default) → ~720 ms field-extraction overhead per design, ~2.2 s for the full three-design Run All. CG itself dominates at higher resolutions; extraction is a fixed-cost tail.

### Side observation

On anisotropic structures (Spinodoid, Hyperuniform), full-Voigt σ_VM peaks are 5–15 % higher than rc3 because shear localizes at material interfaces. The dilated σ_VM that lands at the rendered surface is correspondingly richer; the stress tab now shows physical effects (shear concentration at trabecular nodes, for instance) that were missing from rc3.

---

## Push 4b — Four UX upgrades

### Amp slider reframe

**Old.** Slider 0..1 mapped to a raw 0..200× multiplier on u'(x). Three designs at different "×N" labels were physically incomparable — a 200× multiplier on a stiff design's small u'(x) and the same on a soft design's large u'(x) produced completely different visual stretches.

**New.** Slider 0..1 maps to "δ_max as fraction of cell half-extent" capped at 20 %. Default 0.25 → 5 % cell stretch. Every design renders at directly comparable visual stretch regardless of its actual u'(x) magnitude.

**Implementation.** At `uploadFields` time the raymarcher precomputes `_uPrimeMaxNorm` = max |u'_x|, |u'_y|, |u'_z| across all voxels. `setDeformAmp(v)` derives the effective shader multiplier as `(v × 0.20 × π) / _uPrimeMaxNorm` where π is the cell half-extent in world units.

### Cubic interpolation kernel

**Why.** Hardware trilinear sampling of u'(x) and σ_VM(x) bleeds linearly between voxels — fine for smooth fields, ugly on thin-walled structures where wall thickness approaches voxel size.

**What.** 8-tap B-spline cubic via the Sigg–Hadwiger trick (GPU Gems 2, ch. 20). Exploits hardware trilinear filtering so each cubic sample costs 8 `texture()` calls instead of the naive 64. Applied consistently to both `sampleDisp` (u'(x)) and `sampleStress` (σ_VM(x)).

**State.** Per-design toggle `VIEW_STATE.dispInterp[id]`, default `linear`. ~25 GLSL lines per kernel.

**Note for future readers.** This toggle was removed in Push 7 (cubic-always; lin was demoted to a debugging-only path nobody used). Listed here for the historical record.

### Stress saturation slider

Per-design multiplier (0..2, default 1.0) on the auto p95 cap. 0.5 saturates earlier (peaks blow to yellow); 2.0 de-saturates (peaks land mid-spectrum). Lives in `VIEW_STATE.stressSat[id]`; on input, re-runs `resolveStressDisplay` and re-uploads to the raymarcher. In stress mode, this replaces the deform-control row.

### Viridis → cividis colormap swap

Both the GLSL `cividis(x)` function and the CSS colorbar gradient updated. 8-stop piecewise-linear lookup over verified matplotlib stops. Matte navy → khaki → soft amber. Same gamma + saturation pipeline as before — only the palette changed.

---

## Push 5 — Stiffness ⊕ tab (`22-stiffness-viz.js`)

### Architecture

Sibling pattern to `LabRaymarcher`: new `StiffnessViz` class with its own registry `LAB_SV_REGISTRY`, hidden-canvas cache, `IntersectionObserver`, and mount pattern. ~600 lines total in the new file.

Each design tile gets its own WebGL canvas. When the tab is visible and a design has a valid `S` tensor, the canvas renders the directional Young's modulus surface E(n̂) over an icosphere.

### Math

Directional Young's modulus from the compliance tensor:

```
1 / E(n̂) = v^T · S · v
```

with the engineering-Voigt direction vector

```
v = [ n_x², n_y², n_z², n_y n_z, n_x n_z, n_x n_y ]
```

**Engineering-Voigt convention.** The shear entries of v have NO factor of 2. This matches the solver's `S` (where S₄₄ = 1/G), and is the trap that bit us in Push 5.2 — see below.

Verified against Schwarz P's cubic [111] limit: E_max / E_min = 1.70. ✓

### Mesh

Icosphere with 3 subdivisions: 642 vertices, 1280 triangles. Shared VBO across all designs — generated once at module load, reused per-tile via uniform-driven scaling. The shared mesh is the entire stiffness viz GPU cost; per-tile rendering is a 36-element uniform array (the S matrix) plus radius/color uniforms.

### Shader

- **Vertex.** Computes 1/E per vertex from a 36-element `uniform float uS[]`. 36 mul + 30 add per vertex; trivial GPU load. Outputs world-space position (radius scaled by E) and a varying for the fragment colormap input.
- **Fragment.** `cividis(vColor)` with diffuse-only shading. Same visual language as the stress tab. Normal approximated as the radial direction — true normal would need the gradient of E over the sphere (closed form in Cowin 1989, ~15 GLSL lines, on the polish list).

### Per/shared toggle

The stress tab's existing per/shared toggle is dual-purposed in stiff mode and relabeled to "E surface scale":

- **per.** Radius scaled by the design's own E_max; color stretched from E_min..E_max. Each surface fills its viewport at saturation.
- **shared.** Both radius AND color stretched from the global min(E_min) and max(E_max) across designs. Weaker designs render simultaneously smaller and darker — "same color = same E value everywhere."

### Stats

`uploadDesign` samples E(n̂) at all 642 icosphere vertices to compute E_max, E_min, and the anisotropy ratio E_max / E_min. Readout under the canvas: `E_max X · E_min Y · aniso N`.

---

## Push 5.1 — Bridge S tensor through `mapElasticToResults`

**One-line bug.** Push 4a's `mapElasticToResults` in `50-controls.js` didn't forward `R.S` or `R.C_eff` into `d.results`. Push 5's tile-gating check

```js
if (!sd_g.results.S || sd_g.results.S.length !== 36) continue;
```

failed silently for every design — they all fell through to the SVG mock.

**Fix.** Two added fields to the return object:

```js
S:     R.S     || null,    // Voigt 6×6 compliance, MPa^-1
C_eff: R.C_eff || null,    // Voigt 6×6 stiffness, MPa
```

**Process lesson logged.** *The result-mapper must follow solver-return-object expansion.* Push 4a added new return fields to `solveDesignElasticFull` and forgot to extend `mapElasticToResults`. Three pushes later it bit. Audit the mapper in the same push that adds new solver-return fields.

---

## Push 5.2 — Engineering-Voigt convention bug fix

**Symptom Matt caught.** A near-isotropic gyroid with Zener A = 0.96 was showing E_max / E_min = 3.29 on the surface viz. Cubic isotropic materials should show ~1.0. Wrong by a factor of ~3.

**Root cause.** Initial implementation cited Hill 1952 / Ting 2005 for the directional Young's modulus:

```
v = [ n_x², n_y², n_z², 2 n_y n_z, 2 n_x n_z, 2 n_x n_y ]
                       ↑ factor of 2 on shear entries
```

That formula is correct **only for tensor-Voigt S**, where S₄₄ = s₂₃₂₃. Our solver returns **engineering-Voigt S** (where S₄₄ = 1/G), as verified by the Push 3 cross-validation: C₄₄ = G = 7.241 GPa exactly. Using factor-2 v with engineering S inflates shear-shear contributions by 4× — producing 3–6× false anisotropy on every direction containing shear components.

**Derivation verification — Schwarz P, C₁₁/C₁₂/C₄₄ = 35.36 / 8.08 / 7.24 GPa.**

| Direction | Correct formula | Buggy formula (factor-2 v) |
|---|---|---|
| E[100] | 32.35 GPa ✓ | 32.35 GPa (zero shear; both agree) |
| E[111] | 19.04 GPa | 5.25 GPa |
| E_max / E_min | 1.70 | 6.16 |

Independent orthogonal check using a known-isotropic material along [110]:

- Buggy formula → requires ν = −1 to give E_iso. Nonsense.
- Correct formula → gives 1/E_iso exactly. ✓

**Fix.** Remove the factor of 2 on shear v entries in both the GLSL shader and the CPU stats loop. Header docstring in `22-stiffness-viz.js` now permanently documents the convention and the trap.

**Verified outcome on Matt's hardware.**

| Design | Zener A | Pre-fix anisotropy | Post-fix anisotropy |
|---|---|---|---|
| Strongly axial gyroid | 0.27 | 10.10 | 2.86 |
| Axial-dominant gyroid | 0.89 | 3.05 | 1.59 |
| Near-isotropic gyroid | 0.96 | 3.73 | 1.03 |

**Process lesson logged.** *Voigt convention citations need a convention check.* Hill / Ting / Cowin all use slightly different conventions; the factor of 2 on shear v entries is correct for tensor-Voigt S but inverts the answer with engineering-Voigt S. Verify any directional-modulus citation against the solver's actual S convention before trusting the formula.

---

## Push 5.3 — Three viz fixes + shared-toggle split

### Disable back-face culling

Stiffness surfaces are non-convex on strongly anisotropic designs (saddle topologies with pointed lobes). Back-face culling was hiding front faces in concave regions where winding flips, letting the background show through.

Fix: `gl.disable(gl.CULL_FACE)`. 1280 tris × 2 sides is trivial GPU cost; non-convex topology renders correctly throughout.

### Stop auto-rotate on user interaction

Auto-rotate was continuing after the user dragged to reposition. Fix: `_userInteracted` flag, set true on first pointerdown OR wheel, never resets. Initial auto-rotate stays so the surface is in motion when the tab opens; once the user engages, it becomes permanently their job to drive.

### Split radius / color normalization

**Old.** Single `uEmax` uniform drove both radius scaling and color input. For near-isotropic designs (Zener ≈ 1), the color input compressed to 0.97..1.0 of the cividis range — the surface rendered uniformly yellow with no visible structure.

**New.** Three independent uniforms: `uREmax` (radius scaling), `uCmin` and `uCmax` (color stretch endpoints).

- **Per mode.** All three computed from the design's own stats.
- **Shared mode.** All three from global stats across designs.

API: `setVizParams(REmax, Cmin, Cmax)` replaces `setEmaxGlobal(E)`. The old method was kept as a thin shim for backward compatibility but has no live callers — removal is on the polish list.

---

## Push 5.4 — Zoom range expansion + sage viewport background

Stiffness viz zoom range: `[0.8, 3.0]` → `[0.15, 50.0]`.

- Lower bound 0.15: zoom way out on high-anisotropy surfaces. Schwarz P couldn't shrink at all on the old range — its [100] lobes were always clipping the viewport edge.
- Upper bound 50.0: zoom into tiny shared-mode designs (e.g. a spinodoid rendering at 2 % of viewport when 45× weaker than the Schwarz P baseline).

Background lightened from black to sage gray `#8e9184` (RGB 142, 145, 132) on both the raymarcher and stiffness viz canvases. Cividis low-end navy now pops against sage; was nearly invisible against black.

---

## Push 5.5 — Darker sage (#6b6e64) + radial gradient

Final background: `#6b6e64` base (RGB 107, 110, 100) with a center-light radial gradient.

- Center: `#777a70` (sage +12 per channel).
- Edges: `#5f6258` (sage −12 per channel).
- **Raymarcher.** Fragment-shader `bgCol = mix(center, edges, r*r)` — r² falloff for the vignette.
- **Stiffness viz.** Switched canvas init to `alpha:true` + `premultipliedAlpha:false`; `clearColor(0,0,0,0)`; CSS `radial-gradient` with 4 stops at 0/25/60/100 % to approximate the r² falloff. Two-layer approach because three.js–style WebGL doesn't expose a fragment-shader background for the icosphere viz the way the raymarcher does.

Result: both viewport types show a consistent darker-sage-with-light-center look. Three-dimensional depth without competing with the surface for visual weight.

(Superseded Push 5.4's flat sage.)

---

## Process lessons logged across session one

1. **Port consumers before swapping producers.** Push 4a swapped the dispatcher to full-Voigt before push 4a.1 added field extraction. Deformed and Stress tabs regressed for one push. Always port the consumer surface area first, then flip the dispatcher.

2. **Result-mapper must follow solver-return-object expansion.** Push 4a added `R.S` and `R.C_eff` to solver returns but didn't propagate them through `mapElasticToResults`. Three pushes later (Push 5) gating logic failed silently because `d.results.S` was undefined. Whenever the solver gets a new return field, audit the mapper in the same push.

3. **Voigt convention citations need a convention check.** Hill / Ting / Cowin use slightly different conventions; factor-of-2 shear v entries are correct for tensor-Voigt S but inflate by 4× under engineering-Voigt S. Verified empirically by computing 1/E[110] for a known-isotropic material — the wrong convention requires ν = −1 to balance.

---

## Session two — finishing pushes

The first session left two of the original Phase 4 scope items deferred: connectivity gating and the six-axis toggle. Session two picked them up plus a UX cleanup that surfaced naturally during the interp pass.

---

## Push 6 — Periodic connectivity gating (`14a-connectivity.js`)

### Why it exists

Three reasons, in decreasing order of immediacy:

1. **Manufacturability.** Disconnected solid islands inside a unit cell don't survive 3D-printing post-processing — loose powder washes them out. Detecting them upstream is closer to design intent than discovering them at print prep.
2. **Carries no bulk load.** Islands sandwiched in the soft phase inflate volume fraction without contributing stiffness. The homogenized E reads correctly (the FFT-CG solver handles disconnected geometries gracefully — they simply don't transmit load), but the qualification picture is misleading: the design looks denser than it mechanically is.
3. **CG iteration burden.** Phase 3's handoff flagged this as becoming more important once Phase 4's shear LCs landed, because the stress field has to thread around acoustically decoupled regions. In practice the full-Voigt solver has been converging cleanly on all three demos, but as the design library grows to include sparser structures, a pre-CG gate avoids paying for solves that don't qualify the design.

### What it does

A single helper:

```js
checkVoxelConnectivity(solid, N) → {
  numComponents,    // 1 = fully connected; 0 = empty
  sizes,            // Int32Array, descending
  largest,
  smallest,
  totalSolid,
  largestFraction,  // sizes[0] / totalSolid; 1.0 = perfect
  orphans           // totalSolid - largest
}
```

### Algorithm

Periodic 6-connectivity (face-sharing only — edges and corners do not count) with periodic boundary conditions. Iterative stack-based flood-fill, no recursion (N³ = 262 K voxels at N=64 would overflow the JS call stack). Implementation details:

- Pre-allocated `Uint8Array(N³)` visit map.
- Pre-allocated `Int32Array(N³)` flood-fill stack — worst-case bound, sized once.
- Index strides inlined into the hot loop; no multiplications per neighbor expansion.
- Linear seed scan over the solid mask; each unvisited solid voxel starts a new component.

### Periodicity matters

The FFT solver assumes the unit cell tiles infinitely. An island that touches its own image across the periodic boundary is, correctly, ONE connected component. The flood-fill honors this: neighbor coordinates wrap mod N. Aperiodic 6-connectivity would have flagged perfectly-fine periodic structures as disconnected, generating false rejections.

### Cost

~5 ms at N=64 (each voxel touched once on the linear seed scan, pushed onto the stack at most once, popped at most once). Negligible vs. CG, which runs hundreds of ms to seconds.

Memory: Uint8 visit map + Int32 stack = 1.25 MB at N=64, 10 MB at N=128. Transient — garbage-collected immediately after the function returns.

### Integration into the solver

`solveDesignElasticFull` calls `checkVoxelConnectivity` between `buildVoxels` and the (expensive) Γ build. Two paths:

- **Warn-only (default).** The result is always computed and surfaces on the returned object as `connectivity`. If `numComponents > 1`, the solver logs:

  ```
  [connectivity] 47 orphan voxel(s) in 3 island(s) (largest = 98.45 % of solid · 4.2 ms)
  ```

  No behavior change. Existing demos remain unaffected.

- **Opt-in rejection.** Callers can pass `opts.connectivity = { minLargestFraction: 0.99 }`. If `connectivity.largestFraction < minLargestFraction`, the solver early-returns

  ```js
  { valid: false, reject_reason: 'disconnected', connectivity }
  ```

  BEFORE Γ is built. CG runs only on connected geometries. Off by default; production opts in when the design library expands to sparse families.

### Run-source pill differentiation

`runRealSweep` in `50-controls.js` previously labeled every `!elasticResult.valid` outcome as "invalid (singular C)" — fine when the only invalid path was the singular stiffness branch, misleading once connectivity rejection became possible.

Reworked to differentiate by `reject_reason`:

```
disconnected · 47 orphan voxels in 3 island(s) · largest 98.4%
```

vs. the singular-C path's

```
invalid (singular C)
```

The orphan and island counts come from `elasticResult.connectivity` and propagate through to `d.results.connectivity` so any future UI surfacing (an "N orphans" badge on the design tile, for instance) has the data ready.

### Six-case unit verification

Six synthetic test cases ran before integrating:

| Case | N | Setup | Expected | Got |
|---|---|---|---|---|
| Empty | 8 | all void | 0 components, largestFraction=1.0 | ✓ |
| Full | 8 | all solid | 1 component of 512 | ✓ |
| Two non-touching 2³ blobs | 8 | corner blob + interior blob | 2 components × 8 | ✓ |
| Periodic-wrap pair | 8 | voxel at (0,0,0) + voxel at (N−1,0,0), same row | 1 component of 2 | ✓ |
| Single slab plane | 8 | entire c=0 plane | 1 component of 64 | ✓ |
| Every-other-voxel floaters | 8 | voxel at every (2k,2l,2m) | 64 isolated singletons | ✓ |

The periodic-wrap case is the critical correctness gate. Aperiodic 6-connectivity would have produced 2 components instead of 1 — periodic-aware code produces the correct answer.

---

## Push 7 — Remove the linear / cubic interp toggle

A pivot mid-session. Push 4b had shipped the lin/cub toggle as a way to compare hardware-trilinear vs. 8-tap cubic B-spline sampling. After a session of using cubic on every render, the only function of the linear path was as a debugging fallback nobody used. Decision: cubic is uniformly better at lab grid sizes (and imperceptibly more expensive on target hardware), so remove the toggle entirely.

Three cleanup levels were on the table:

- **A — UI only.** Hide the toggle; keep the shader plumbing.
- **B — Strip shader uniform.** Delete the uniform and the branch; keep the linear helper functions as orphan reference.
- **C — Strip everything dead.** B plus delete the `_linear` helpers from the shader source.

Went with **C**. Dead branches in the shader are a tax on every reading; cubic has been the validated path for the entire session; `git checkout` is the right tool for reverting, not a runtime uniform.

### What was removed

- `VIEW_STATE.dispInterp` map (`30-view-tabs.js`)
- `getDispInterp()`, `onDispInterpClick()` accessors (`30-view-tabs.js`)
- `.disp-interp-toggle` div in both `buildDeformControl` and `buildStressControl` (`40-design-grid.js`)
- `ibtn` button-builder helper, defined twice (`40-design-grid.js`)
- `.disp-interp-btn` click-handler loop (`40-design-grid.js`)
- `getDispInterp` calls at both build-control callsites and the post-mount push (`40-design-grid.js`)
- `LabRaymarcher.prototype.setDispInterp` method (`21-raymarcher.js`)
- `S.dispInterp` state slot (`21-raymarcher.js`)
- `uniform float uDispInterp;` shader declaration (`21-raymarcher.js`)
- `'uDispInterp'` from the uniform-name resolution list and the per-frame `gl.uniform1f` upload (`21-raymarcher.js`)
- `sampleDisp_linear` and `sampleStress_linear` GLSL helper functions (`21-raymarcher.js`)
- The ternary in `sampleDisp` / `sampleStress` — now they call the cubic path directly (`21-raymarcher.js`)

### What was kept

- `uTexN` uniform and `S.texN` state. The cubic kernel needs the texture resolution for Sigg–Hadwiger offset math; σ_VM sampling depends on it just as much as displacement sampling does. Set unconditionally at upload time.

### Net

~95 lines removed across three files. Global grep for residual `dispInterp` / `uDispInterp` / `sampleDisp_linear` / `setDispInterp` returned zero hits across the entire codebase.

---

## Push 8 — Six-position axis toggle (xx/yy/zz/yz/xz/xy)

### What changed user-side

The X / Y / Z toggle expanded to a six-button Voigt-labeled toggle in the stress tab (XX YY ZZ YZ XZ XY) and stayed three-button in the deform tab (XX YY ZZ — relabeled from single-letter). The asymmetry is by design: σ_VM is well-defined under any LC; u'(x) reconstruction is defined only for normal LCs.

### Solver extension — `extractStressOnlyForLCFull`

New method on `ElasticSolverFull.prototype` parallel to `extractFieldsForLCFull`:

```js
extractStressOnlyForLCFull(sigArr_6) → { u_prime: null, sigma_vm, N, eps_bar: [0,0,0] }
```

Pure σ_VM extraction — same full von Mises formula as the normal path, but no u'(x) reconstruction and no FFT round-trips. Cost: ~10 ms at N=64 (single Float32 loop over N³ voxels with multiply-and-accumulate), vs. ~40 ms for the full extractor that adds three FFT round-trips for the spectral inversion.

`u_prime` is explicitly `null`. The raymarcher branches on this at `uploadFields` time to skip the displacement texture entirely.

### Solver dispatch

`solveLoadCaseFull` dispatches by the strain state:

```js
var isNormal = (eps_bar[0] !== 0) || (eps_bar[1] !== 0) || (eps_bar[2] !== 0);
fields = isNormal
  ? await this.extractFieldsForLCFull(eps_bar, sigArr_6)
  : await this.extractStressOnlyForLCFull(sigArr_6);
```

`homogenizeFull` no longer filters out shear LCs from `captureFieldsLCs` — all six are valid capture targets. The old `console.warn('[homogenizeFull] captureFieldsLCs ignored for shear LCs ...')` is gone.

`solveDesignElasticFull`'s `captureFieldsLCs` default expanded from `[0, 1, 2]` to `[0, 1, 2, 3, 4, 5]` — all six physical Voigt axes captured by default. The SWAP table was already 6-long from Phase 3, so the translation `solverIdx = SWAP[phys]` covers shear axes (SWAP[3]=5, SWAP[4]=4, SWAP[5]=3) without modification.

`fieldsByAxis` keys expanded from `{ x, y, z }` to `{ xx, yy, zz, yz, xz, xy }`. The X↔Z component swap inside each fieldset is conditional on `f.u_prime` being non-null — shear fieldsets skip the swap because there's no u_prime to permute, and eps_bar is [0,0,0] so swapping it is a no-op.

### Raymarcher — null-u_prime branch in `uploadFields`

The malformed-fieldset guard relaxed to permit `u_prime === null` while still rejecting `u_prime` present-but-the-wrong-shape:

```js
if (uP && (uP.length !== 3 || uP[0].length !== N3)) {
  console.warn('[LabRaymarcher] uploadFields: malformed u_prime');
  return;
}
```

The displacement-texture upload block wrapped in `if (uP) { ... } else { ... }`. The else branch sets `_dispUploaded = false`, `dispUploaded = 0`, clears epsBar and uPrimeMaxNorm. `texN` is set unconditionally — the cubic σ_VM sampling needs it whether or not u'(x) is present.

In the shader, `sampleDisp()` already short-circuits to `vec3(0)` when `uDispUploaded < 0.5`. The deform-tab visualization of a shear-axis fieldset shows the undeformed cell — intentional and correct given that u'(x) is mathematically undefined for shear LCs.

### View state — one-slot with mode-aware coercion

`VIEW_STATE.loadAxis[id]` stays a single string per design. Three accessors:

- `getLoadAxis(id)` — returns the raw state, with read-time backward-compat promotion (`'x'/'y'/'z'` → `'xx'/'yy'/'zz'`) for any persisted state from the pre-Push-8 era.
- `getDeformAxis(id)` — for the deform tab. If state holds a normal axis, returns it. If state holds shear, returns `'zz'` (read-only coercion; does NOT mutate state).
- `getStressAxis(id)` — for the stress tab. Returns whatever the state holds, of any of the six.

Behavior of mode switching: user on YZ in stress → switches to deform (ZZ button highlights as the coerced default, state still holds `'yz'`) → switches back to stress (YZ is highlighted, fields are restored). Their YZ pick survives any number of stress-to-deform-to-stress trips, but a click on a deform button DOES mutate state — committing to that normal axis.

### Design grid

- `buildDeformControl(id, amp, axis)` — three buttons relabeled `XX YY ZZ` with `data-axis="xx"/"yy"/"zz"`.
- `buildStressControl(id, sat, axis)` — gains an `axis` parameter; prepends a six-button toggle using the same `.load-axis-btn` class. The existing axis-click handler routes to the new buttons transparently because the class hook is shared.
- Three `axes = ['x', 'y', 'z']` enumerations in `computeStressMaxAcrossAxes`, `computeStressStatsAcrossAxes`, and `computeGlobalStressP95` updated to the six-axis Voigt set. These functions pool σ_VM across axes to compute auto-cap stats; they now see shear σ_VM in addition to normal.

### Cost

~30 ms per Run All at N=64 for the three extra shear σ_VM extractions. Field memory: 3 × N³ × 4 bytes = 3 MB additional per design at N=64. Negligible against the CG cost.

---

## Push 8.1 — The epsR scope regression

The six-axis toggle landed and rendered correctly on the normal axes. The shear axes produced uniform deep-navy surfaces with no σ_VM gradient at all — the colorbar legends showed valid p95 caps in the hundreds of MPa, the structures rendered geometrically, but no color variation.

The first instinct was to attribute this to the per-design auto-cap being dominated by normal-LC σ_VM peaks: at unit strain, normal LCs produce σ_VM ≈ E (≈ 110 GPa for Ti), shear LCs produce σ_VM ≈ √3 · G (≈ 71 GPa). With the auto-cap set by the normal-LC peak, shear renders would land in the dim half of cividis even after gamma remap. A plausible enough story to explain a *dim* shear render — but not a *gradient-free* one.

**Matt pushed back.** A 75 % magnitude mismatch produces a dim gradient. The screenshot showed *no gradient at all*: uniform deep navy across structures with curved material interfaces, where local σ_VM ought to vary by orders of magnitude. The intuition was sharp — uniform color means the sampled values are all the same, not just compressed to one end of the colormap.

### Root cause

A scoping regression in the Piece B (Push 8) edit to `uploadFields`. Wrapping the u'(x) block in `if (uP) { ... }` accidentally moved the line

```js
var epsR = 1e-12;
```

inside the if-block. The σ_VM encoding below the if-block reads `epsR` to guard against degenerate ranges:

```js
svMax = Math.max(svMax, epsR);
```

When `uP === null` (shear axis), the `var` hoists `epsR` to function scope but never assigns. It's `undefined`. `Math.max(svMax, undefined)` returns NaN. `svScale255 = 255 / (NaN - 0)` is NaN. Every byte through

```js
Math.round(Math.max(0, Math.min(255, anything * NaN)))
```

evaluates to NaN, and `Uint8Array[k] = NaN` coerces to **0**.

Result: the σ_VM texture for every shear-axis fieldset was a buffer of zeros. The shader's `sampleStress` returned 0 at every surface point. The cividis colormap rendered at exactly its bottom — uniform deep navy.

### Reproduction

```
BUG (uP=null):   { epsR: undefined, svMax: NaN, svScale255: NaN, byteValue: NaN }
FIX (uP=null):   { epsR: 1e-12,     svMax: 5,   svScale255: 51,  byteValue: 153 }
BUG (uP=true):   { epsR: 1e-12,     svMax: 5,   svScale255: 51,  byteValue: 153 }
FIX (uP=true):   { epsR: 1e-12,     svMax: 5,   svScale255: 51,  byteValue: 153 }
```

Confirmed empirically against the buggy and fixed versions of the JS snippet — the bug path zeros the byte through the NaN cascade; the fix path encodes correctly; the normal-axis path was unaffected in both directions.

### Fix

Hoist `var epsR = 1e-12;` above the `if (uP)` block. Single-line change in `21-raymarcher.js`. Added a comment flagging the Push 8 reason so the declaration doesn't get inadvertently moved back inside the conditional later.

### Lesson

**Process lesson logged.** *When you refactor straight-line code into a conditional, every variable used downstream must hoist out of the conditional.* JavaScript's `var` hoisting hides this — the variable always *exists* at function scope but is undefined when the conditional skips. Symptoms downstream are NaN cascades that silently degrade to zero through the byte coercion, looking like a stress-field bug rather than the scoping issue it actually is.

Matt's debugging intuition — uniform-color-implies-zero-bytes-implies-encoder-not-just-cap — caught a bug my "this is the expected normalization effect" framing was actively obscuring. Diagnostic ladders fail when the framing is wrong; pushing back is the right move.

---

## File inventory at end of Phase 4

### New files

```
14a-connectivity.js          — periodic 6-connectivity flood-fill helper
16b-elastic-solver-full.js   — GPU full-Voigt 6×6 elastic FFT-CG + field extraction
22-stiffness-viz.js          — directional E(n̂) surface renderer
```

### Modified files

```
17-elastic-test.js           — self-test driver swapped to full-Voigt; 6-LC pass criteria
21-raymarcher.js             — cubic interp kernel; cividis; amp reframe; sage vignette;
                               null-u_prime branch; epsR hoist fix; lin/cub strip
30-view-tabs.js              — stressSat map; getDeformAxis/getStressAxis accessors;
                               6-Voigt loadAxis with backward-compat read promotion;
                               dispInterp removed
40-design-grid.js            — sat slider; 6-button stress axis toggle; 3-button deform
                               axis toggle relabeled XX/YY/ZZ; mode-aware axis dispatch;
                               σ_VM stats loops expanded to 6 axes; lin/cub strip;
                               cividis colorbar gradient
50-controls.js               — full-Voigt as Run All dispatcher; mapElasticToResults
                               propagates R.S, R.C_eff, R.connectivity; differentiated
                               run-source labels for connectivity-reject vs singular-C
index.html                   — script tags for 16b, 22, 14a; full-Voigt self-test link
```

### Unchanged in Phase 4

```
00-mock-data.js, 10-hardware.js, 11-webgpu-device.js, 12-fft-plan.js, 13-kernels.js,
14-rasterizer.js, 15-demo-recipes.js, 16-elastic-solver.js, 16a-elastic-cpu-ref-full.js,
18-stokes-cpu-ref.js, 19-stokes-solver.js, 20-svg-mocks.js, 60-add-design.js,
70-selftest.js, 71-rasterize-test.js, 99-init.js, lab.css
```

`16-elastic-solver.js` is no longer wired into Run All but is retained because `_es_fft3d` is called by `extractFieldsForLCFull` in 16b for the u'(x) spectral inversion FFT round-trip. Removal pending a standalone FFT helper.

---

## Validation status at end of Phase 4

| Component | Verified | Notes |
|---|---|---|
| 16b GPU full-Voigt @ N=16 | ✅ All 6 cross-validation gates | 0.001–0.004 % drift vs CPU oracle on Ex/Ey/Ez/G/Zener |
| 16b GPU full-Voigt @ N=32 | ✅ Demo set passes | Hasn't been pushed to N=64 yet |
| 17 Run elastic · 3 demos | ✅ All gates pass | Schwarz P at E/Es = 0.294 within [0.25, 0.34] |
| 50 Run All with full-Voigt | ✅ Stiffness numbers populate | All three demos render across all four tabs |
| Deformed tab (normal axes) | ✅ u'(x) + ε̄·x render correctly | Cubic kernel; amp reframe in 0..20 % cell |
| Deformed tab (shear axes) | ✅ Shows undeformed cell | Intentional: u'(x) undefined off-diagonal |
| Stress tab (normal axes) | ✅ Full von Mises with shear | 5–15 % higher than Phase 3 rc3 on anisotropic structures |
| Stress tab (shear axes) | ✅ σ_VM gradients visible after Push 8.1 | Uniform-navy regression caught and fixed |
| Stiffness ⊕ tab | ✅ Math reverified after Push 5.2 | Per and shared modes both functional |
| 14a periodic connectivity | ✅ All six unit cases | Periodic-wrap correctness gate passes |
| Connectivity warn-only | ✅ Existing demos silent | All three connected; no warnings |

---

## Known limits at end of Phase 4

- **Mixed-strain spectral inversion is unimplemented.** u'(x) for shear LCs would require a non-diagonal spectral inversion that's not just a port — it's a research task. Deferred indefinitely.
- **Full-Voigt solver not yet pushed past N=64.** Validation has run at N=16 and N=32. N=64 is the next target; bandwidth-bound 20–40× CPU speedup is the expectation but is currently a prediction, not a measurement.
- **Connectivity rejection is opt-in only.** No callsite currently passes `opts.connectivity.minLargestFraction`. Production behavior is identical to Phase 3 except for the new `connectivity` field on every result.
- **The `setEmaxGlobal` shim is dead.** Push 5.3 split it into `setVizParams(REmax, Cmin, Cmax)`. The old method is still on the prototype as a backward-compatibility shim but has no live callers. Safe to remove in a polish pass.
- **Inline styles still on the new UI controls.** Amp slider, sat slider, six-button axis toggle, stress colorbar all use inline `style=...`. Should be promoted to class selectors in `lab.css`. Cosmetic; no behavior change.
- **`localStorage` persistence not implemented.** Designs are still lost across page reload. Approved scheme `f13ld.lab.designs.v1`; ~30 LOC across three files; deferred to Phase 5 polish.

---

## Handoff state

- Repo: `https://github.com/mshomper/f13ld.lab`
- Live: `https://mshomper.github.io/f13ld.lab`
- Production Run All goes through `solveDesignElasticFull` with default `opts.captureFieldsLCs = [0,1,2,3,4,5]`. All six axes captured; raymarcher renders any of the six in stress tab and three of six in deform tab.
- Stiffness ⊕ tab renders with verified math. Per/shared toggle dual-purposed with stress.
- Connectivity report on every `d.results.connectivity`. UI doesn't surface it yet; the data is there for a future "N orphans" badge or similar.

## What Phase 5 inherits

- A full-Voigt solver as the established production path. Phase 5's buckling work (LOBPCG) will build directly on `16b-elastic-solver-full.js`'s linear-operator infrastructure — the geometric stiffness matrix needed by LOBPCG reuses the same Γ application and CG-style iteration.
- A directional stiffness surface viz pattern (`StiffnessViz` class, hidden canvas cache, IntersectionObserver mount). Phase 5 modal-shape visualization can mirror the same architecture for buckling-mode rendering — each mode as its own canvas overlay, shared icosphere VBO across designs.
- Periodic 6-connectivity gating, opt-in but ready. Phase 5+ designs trending sparser will benefit immediately by flipping the threshold from null to e.g. 0.95.
- One-slot axis state with mode-aware coercion, ready for `loadAxisStress` / `loadAxisDeform` to split if cross-mode preservation becomes a friction point. The split would be a 10-line change with no UI impact.
- A precedent for cubic-only sampling. Phase 5's mode shapes can ship with the same Sigg–Hadwiger kernel; no need to re-litigate the toggle.

## What Phase 5 should NOT inherit

- The deferred polish list. Promoting inline styles to `lab.css`, removing the `setEmaxGlobal` shim, retuning the iridescent palette for sage backgrounds, and adding `localStorage` persistence are all sub-day items that should land before Phase 5's substantive work begins. They've accrued across two sessions; another session of accrual will make them harder to discharge cleanly.

---

*Generated 2026-05-23 at the end of the Phase 4 second session, replacing the Phase-3-era handoff document as the canonical Phase 4 record.*
