# F13LD.lab — Thermal Conductivity and 3-D Temperature Map (Scope)

**Status:** Proposal for Matt's review. No code written yet.
**Written against:** v0.18.0 (main `18ddbae`), 2026-10-07
**Goal:** Fill the existing "Thermal κ" stubs with a working solver: the effective conductivity tensor of any lattice the lab can build (native recipes, foams, imported STL cells), a 3-D temperature map on the cell, and a heat-flux "hot spot" map. It should run in seconds, in the same Run All flow as stiffness.
**Out of scope (this pass):**
- Convection and conjugate heat transfer. That arrives with the fluids module; see `FLUIDS_LBM_SCOPE.md` §9.
- Transient heating. Only the effective diffusivity is reported, as a number.
- Radiation.
- Thermal expansion. A single-material lattice expands exactly like its parent metal, so homogenization adds nothing until there are two solid materials (§9).

---

## 1. Why this is a small job

Every stub is already in the UI and waiting for numbers:
- the Thermal κ physics toggle (`index.html:120`) and view tab (`index.html:68`);
- card rows reading "solver not yet available" (`40-design-grid.js:86–92`, `:214–220`);
- an empty viewport (`40-design-grid.js:478–481`);
- the readout string (`40-design-grid.js:1020`);
- a 1-second placeholder in the time estimate (`50-controls.js:338`);
- the "not wired" notice (`50-controls.js:793–794`).

The materials table already has a solid conductivity column, `ks_WmK`, though it is null on 10 of 45 entries.

The physics is the scalar cousin of the stiffness solve: **one unknown per voxel instead of six, three load cases instead of six.** The same FFT plan and the same "FFT as preconditioner, CG does the work" pattern apply.

```
 STIFFNESS TODAY
 recipe ─► buildVoxels (0/1) ─► Willot Γ, 6 unknowns/voxel ─► CG × 6 load cases ─► C_eff, σ_vm map

 THERMAL (proposed)
 recipe ─► buildVoxelField (signed field) ─► face conductances (sub-voxel walls)
                                                   │
               FFT-preconditioned CG, 1 unknown (temperature) per voxel, × 3 load cases
                                                   │
                       κ_eff (3×3), temperature map, heat-flux hot-spot map
```

**Unchanged:**
- stiffness, crush and buckling;
- `buildVoxels` (the new field builder sits beside it);
- the sweep's elastic columns;
- design cards outside the thermal rows.

---

## 2. What the user sees

1. **Turn on Thermal κ** next to Elastic, Crush and Buckling, then Run All.
2. **The card's thermal rows fill in:**
   - κx, κy and κz in W/m·K;
   - **κ / κ_solid**, the fraction of the parent metal's conductivity, in %;
   - **thermal efficiency**: κ as a percentage of the most any structure at this density can conduct (the Hashin–Shtrikman upper bound, §3.5). A sheet TPMS near 100 % is close to ideal; a strut lattice sits much lower;
   - anisotropy, κmax / κmin;
   - effective diffusivity in mm²/s.
3. **Thermal view tab: the 3-D temperature map.** The cell is coloured by temperature with a hot face and a cold face on the chosen axis, as if ΔT (default 10 K, editable) were applied across one cell. Isotherms bend where the solid is thin or tortuous. Controls:
   - **Axis:** X / Y / Z, the direction of the applied gradient.
   - **Show:**
     - *Temperature*: the full field, hot to cold.
     - *Deviation*: how far each point departs from a uniform ramp. This highlights architecture effects.
     - *Heat flux*: local flux divided by the flux a solid block would carry. It is the thermal counterpart of the stress map, so hot spots are where heat crowds through thin necks.
   - **Section plane:** cut the cell to see inside the struts. This is new to the lab's viewer, and the fluids module will reuse it (§3.7).
   - A colour bar labelled in real units: °C (relative to the cold face) or W/m².
4. **Directional conductivity surface:** κ(n) drawn like the existing stiffness surface (`22-stiffness-viz.js`), from the 3×3 tensor.
5. **Filler phase selector** in the run settings. It sets what fills the pores (§3.4): *vacuum* (solid conduction only, the default), air, water / tissue, bone cement, or powder.
6. **Sweep:** κ columns in the CSV, and κ / κ_solid and efficiency available as Atlas metrics.

---

## 3. Technical plan

### 3.1 Formulation

The temperature is a uniform ramp plus a periodic correction:

    T(x) = E·x + T̃(x),   with T̃ periodic,   ⟨∇T⟩ = E
    div( k(x) ∇T ) = 0   →   −div( k ∇T̃ ) = div( k E )

Solve for the correction T̃ with E = e₁, e₂, e₃ in turn. Column j of the effective tensor is the average flux:

    κ_eff · e_j = −⟨ q ⟩,   q = −k ∇T

**Discretization: a finite-volume "resistor network" on the voxel grid.**
- T̃ lives at voxel centres.
- Each voxel owns three face conductances, on its +x, +y and +z faces.
- The operator is the 7-point stencil:

      (A T̃)_i = − Σ_faces  k_face · (T̃_neighbour − T̃_i) / h²

  It is symmetric and positive semi-definite, with one null mode: the constant.

This is the scalar case of Willot's forward-difference ("resistor network") Green operator (Willot, Abdallah & Pellegrini 2014), which is equivalent to the staggered-grid scheme of Schneider, Ospald & Kabel (2016). Three properties matter:
- **Robust with near-empty pores.** The convergence rate stays bounded as the void conductivity goes to zero, where Moulinec–Suquet's continuous operator degrades.
- **No checkerboard modes.** The rotated (Willot 2015) elastic operator has spurious modes on even grids. The scalar stencil only has the constant mode, which is removed exactly.
- **A temperature unknown, not a gradient unknown.** The temperature map comes straight out of the solve.

### 3.2 Solver

- **Preconditioned CG** on T̃. The preconditioner is the exact inverse of the same stencil with a uniform reference conductivity k₀. On a periodic grid that inverse is diagonal in Fourier space:

      P̂(q) = 1 / ( k₀ Σ_j 4 sin²(q_j / 2) / h² ),   P̂(0) = 0

  Each iteration costs **one stencil apply (no FFT) plus one forward and one inverse FFT**. The elastic fast path needs a batch-3 FFT pair per iteration; thermal needs a single real field.
- **Two load cases per FFT.** Real fields pack two to a complex slot, as `16i-elastic-fast.js` already does. X and Y share one solve, and Z runs alone (or rides with the next design's X).
- **Iterations scale with √(contrast).** With CG, counts grow with the square root of the solid-to-filler conductivity ratio (Zeman et al. 2010). Expected:
  - vacuum filler with a 1e-4 floor: a few hundred iterations;
  - Ti-6Al-4V in air (≈ 260:1): tens of iterations;
  - water: about 10.

  §5 Phase 0 measures this before anything is promised.
- **Everything GPU-resident**, following 16i:
  - CG scalars stay on the GPU, with periodic readbacks;
  - tolerance presets are shared with stiffness (Standard 1e-4, High 1e-5);
  - a "not converged" flag appears on the card, as for moduli.
- **Memory at 128³:**

  | Item | Size |
  |---|---|
  | T̃, residual, search direction, A·p | 4 × 8 MB |
  | Face conductances | 25 MB |
  | One complex FFT slot | 16 MB |
  | **Total** | **≈ 75 MB** |

  This sits well under the 128 MB default binding limit. Unlike the elastic Γ (176 MB at 128³), no special device limits are needed.
- **CPU oracle** `17a-thermal-cpu-ref.js`: the same scheme in Float64, used for N ≤ 32 checks. It mirrors how 16a and 16f back the GPU solvers.

### 3.3 Sub-voxel walls — the part that makes N = 32–64 trustworthy

A 10 % gyroid sheet is only about 2 voxels thick at N = 64. Treated as staircase 0/1 voxels, its conduction path is noticeably wrong. Conductivity is linear in solid fraction for a sheet, so a half-voxel error in wall position is a direct error in κ.

**Fix:** build each face conductance from where the wall crosses the link between two voxel centres.
- The signed field φ at the two centres gives the crossing point by linear interpolation:

      q = φ_a / (φ_a − φ_b)

- The face conductance is then the two phases **in series** along the link:

      k_face = 1 / ( q / k_a + (1 − q) / k_b )

  This is the classic laminate rule along the wall normal (Kabel, Merkert & Schneider 2015, the "composite voxel" idea).
- Links that never cross a wall keep their own phase's k.
- **Thin features:** if both ends of a link sit on one side but the midpoint sits on the other (a wall or neck thinner than a voxel), the link is treated as crossing twice, so the sliver is not lost.

**This needs the signed field, which the rasterizer currently discards.** `buildVoxels` (`14-rasterizer.js:41`) computes it in pass 1 but returns only the 0/1 mask. A sibling, `buildVoxelField(...)`, will return the per-voxel signed value in solver order. The same mode-specific tests are already mirrored in `sweepThresholdField` (`14d-voxel-stats.js:284`).
- TPMS and noise fields are not distances, so they are rescaled by their gradient, φ / |∇φ|, before crossings are taken.
- Beams, foams and STL imports are already true distances.

**Shared with fluids.** The same link-crossing fraction q is exactly what the lattice Boltzmann wall condition needs. Both modules read it from one new file, `14e-link-field.js`, built once per design and grid.

### 3.4 The filler phase (what fills the pores)

| Filler | k (W/m·K) | Ti-6Al-4V : filler | Use |
|---|---|---|---|
| **Vacuum (default)** | 0 → floor 1e-4·k_s | — | Solid-conduction property of the lattice itself |
| Air | 0.026 | ≈ 260 | Lattice in a heat exchanger / heat sink, bench tests |
| Water / soft tissue | 0.6 | ≈ 11 | Implant in vivo |
| PMMA bone cement | ≈ 0.2 (to confirm) | ≈ 35 | Cement-filled cages and augmented screws (exotherm spreading) |
| Metal powder | ≈ 0.1–0.2 | ≈ 35–50 | Lattice inside the powder bed during the build (Bartsch et al. 2022 measured 0.13 for Ti-6Al-4V powder) |
| Custom | user value | — | — |

**The vacuum floor follows the stiffness void rule.** The floor is 1e-4·k_s. When κ comes out within about 50× of the floor, the card shows a "filler-limited" flag, the counterpart of today's "void-limited" flag. Test T11 (§4) checks that the floor moves κ by less than 0.1 % on any connected lattice.

**Percolation check.** `periodicComponents` (`14a-connectivity.js:341`) already reports which axes the solid wraps across, as its `wraps` bits.
- An axis with no continuous solid path gets "no solid path" on the card.
- Its κ is then set entirely by the filler, and with vacuum it is near zero by construction.

### 3.5 Outputs and units

- **Conductivity tensor:** κ_eff, a 3×3 matrix in W/m·K, scaled from the normalized result by k_s.
  - It is symmetrized.
  - The asymmetry |κ_ij − κ_ji| / ‖κ‖ is recorded as a solver-health number.
  - A second health check compares the energy form E·κ·E with ⟨q⟩·E.
- **Card values:** κx, κy and κz (the diagonal), κ / κ_s, anisotropy, and the efficiency below.
- **Efficiency:** κ / κ_HS+, the ratio to the Hashin–Shtrikman upper bound for the solid fraction φ.
  - With a vacuum filler that bound is 2φ / (3 − φ) · k_s. At low density it tends to 2φ/3.
  - TPMS sheets approach this limit at low density (Zhang & Liu 2025). Strut and beam lattices tend to φ/3, about half of it.
  - So efficiency separates sheet-like heat paths from strut-like ones at a glance.
- **Diffusivity:** α_eff = κ_eff / ⟨ρ c_p⟩, in mm²/s. Heat capacity simply averages by volume, so this needs no extra solve, only a `cp_JkgK` column in the materials table (§3.8).
- **Fields kept for the viewer** (solver order, converted with `solverToTexOrder`):
  - T̃ for each axis;
  - |q| on voxel centres (from the face fluxes).

  Total temperature is rebuilt on the fly as ΔT·(x/L) + scaled T̃.

### 3.6 Results and caching

- **Storage:** `THERMAL_BY_DESIGN[id]`, the same pattern as `NONLIN_BY_DESIGN`. Thermal results then survive the elastic pass rebuilding `d.results`, and never reach localStorage.
- **Card values:** a small `d.results.thermal` block. It replaces today's `kappa_z: 0` sentinel in `mapElasticToResults` and `stubResults`.
- **Cache signature:** design fingerprint, grid, filler, k_s, tolerance and field version.

### 3.7 Viewer: temperature map and section plane

The raymarcher already colours the surface from a scalar 3-D texture (mode 2, the stress path). Thermal reuses that path with these changes:

| Change | Why |
|---|---|
| Scalar texture R8 → **R16F** for thermal (and later fluids) | A smooth temperature ramp in 8 bits shows banding. The geometry texture moved to R16F in v0.18.0 for the same reason. |
| Signed-range encoding (offset + scale) | The deviation field is signed. Today's encoding pins the minimum to 0. |
| Skip the one-voxel dilation into void for thermal | That dilation assumes the void value is about 0. Thermal instead extends surface values into the void with nearest-solid copying. |
| Colour maps: a perceptual hot map for temperature, diverging for deviation, cividis for flux | Kept separate from the stress and buckling maps so the tab reads at a glance |
| Isotherm lines (optional): thin bands every ΔT/10 | Shows how the architecture bends the heat path |
| **Section plane**: a clip half-space in the raymarch with a capped cut face coloured by the interior field | Temperature inside thick struts and nodes is otherwise invisible. The other F13LD design tools already have a clip plane; the lab doesn't. Fluids reuses it to show velocity in the pores. |
| `'thermal'` added to `rmModes` / `needsFields` (`40-design-grid.js:398–399`), `hasActiveFields` / `activeFieldsFor` (`:294–307`), `pauseRaymarcherTilesForViewMode` (`21-raymarcher.js:1879`) | Gating, so the tab behaves like Stress |

The shared shading block (`20c-f13-shade.js`) stays byte-identical. Field colour goes in before shading, exactly as stress does today.

### 3.8 Materials

- **Fill the 10 missing `ks_WmK` values,** or mark them "no data" so thermal refuses with a clear message instead of guessing.
- **Add `cp_JkgK`** for diffusivity.
- **Add an `asBuilt` note where it matters.** As-built AM conductivity can sit well below wrought values:
  - LPBF Ti-6Al-4V: 5.4 vs about 6.5–7 W/m·K (Bartsch et al. 2022);
  - AlSi10Mg: about 120–135 as built vs about 170 after stress relief;
  - CuCrZr: about 100 as built vs about 310 after ageing (Candela et al. 2024).

  `docs/MATERIALS.md:224` already warns that conductivity is often a wrought proxy. This makes the gap visible where it is large.
- **Add a filler table** (§3.4) beside the materials, with k, ρ and c_p.

### 3.9 Sweep

- **New CSV columns:** `kx_WmK`, `ky_WmK`, `kz_WmK`, `k_rel` (κ / κ_s, directional mean), `k_eff_hs` (efficiency), `k_filler`, `k_iters`, `k_converged`.
- **Run settings:** a "Physics: stiffness / stiffness + thermal" choice.
- Atlas metrics follow the existing `ATLAS_S3_METRICS` pattern.

### 3.10 Code touch points

| File | Change |
|---|---|
| `14-rasterizer.js` | `buildVoxelField()`, which returns the signed field next to the 0/1 mask; `buildVoxels` itself unchanged |
| `14e-link-field.js` (new, shared with fluids) | Gradient-normalized signed field, per-link crossing fractions, thin-feature detection |
| `17a-thermal-cpu-ref.js` (new) | Float64 reference solver for validation |
| `17b-thermal-solver.js` (new) | GPU solver: face conductances, stencil kernel, FFT preconditioner, CG, flux and field extraction |
| `15c-materials.js`, `docs/MATERIALS.md` | Missing k_s, `cp_JkgK`, as-built notes, filler table |
| `50-controls.js` | Thermal phase block in `runRealSweep` (after Buckling), `doThermal` flag, filler setting, timing calibration (replaces the fixed 1.0 s), remove "Thermal" from `notWired` |
| `40-design-grid.js` | Card rows, readout, flags (filler-limited, no solid path, not converged), viewport gating, thermal controls |
| `21-raymarcher.js` | R16F signed scalar texture option, thermal colour maps, isotherms, section plane |
| `22-stiffness-viz.js` | κ(n) directional surface from the 3×3 tensor |
| `62-sweep.js`, `63-sweep-atlas.js` | Thermal columns and metrics |
| `11-webgpu-device.js` | Add any new GPU caches to `WGPU_DEVICE_CACHE_KEYS` so device loss clears them |
| `index.html`, `99-init.js`, README, `CITATION.cff`, `NEXT_STEPS.md` | Version bump and docs |

---

## 4. Validation plan

Run headless (CPU oracle, plus SwiftShader for the GPU kernels) before Matt's click-test. Timing and the large grids run on Matt's RTX machine.

| # | Test | Pass |
|---|---|---|
| T1 | Laminate aligned with the grid (two phases, any contrast) | Along the layers = volume average; across = harmonic average; to solver tolerance |
| T2 | Laminate offset by a fraction of a voxel | Same exact answers within 0.5 %. **This is the sub-voxel wall test**; staircase voxels fail it |
| T3 | Dilute spheres, φ = 1–5 %, insulating and conducting | Maxwell's formula within 1 % at N = 64 |
| T4 | Random two-phase cells and every demo design | κ inside the Hashin–Shtrikman bounds for its solid fraction |
| T5 | Simple-cubic array of spheres across φ | Rayleigh / McPhedran–McKenzie cubic-array values (exact series to be confirmed before use) |
| T6 | Sheet gyroid and Schwarz P at 5–20 % density | Approaches 2φ/3 · k_s as density falls (Zhang & Liu 2025 thin-shell limit) |
| T7 | Cubic beam lattice at low density | Approaches φ/3 · k_s per axis |
| T8 | Grid convergence, gyroid sheet at N = 32 / 64 / 128 | Monotone. Sub-voxel walls close most of the 32 → 128 gap that staircase voxels leave (both reported) |
| T9 | GPU vs CPU oracle at N = 32, all families incl. foam and STL import | Within 0.1 % |
| T10 | Symmetry and energy checks on anisotropic designs (PI-TPMS, directional grain) | Asymmetry < 0.5 %; the energy form matches ⟨q⟩·E within 0.5 % |
| T11 | Vacuum-floor sensitivity: floor 1e-4 vs 1e-6 | κ changes < 0.1 % on connected designs |
| T12 | Native designs unchanged | Stiffness, crush and buckling numbers identical to v0.18.0 |

---

## 5. Effort and phasing

| Phase | Contents | Rough size |
|---|---|---|
| **0 — Field + oracle** | `buildVoxelField`, `14e-link-field.js`, CPU oracle, T1–T7 on the CPU, iteration-count measurements vs filler | 1 session |
| **1 — GPU solver** | `17b`, packed two-case FFT, card rows, run phase, caching, flags, T9–T12; timing on Matt's GPU | 1 session |
| **2 — Viewer** | R16F signed scalar, three field views, colour bars, isotherms, section plane, κ(n) surface | 1 session |
| **3 — Materials + sweep** | k_s gaps, c_p, as-built notes, filler table, sweep columns and Atlas metrics | ½ session |

Version targets: Phase 1 as **v0.19.0**, Phase 2 as v0.19.x.

---

## 6. Decisions on record (Matt, 2026-10-07)

- Thermal shows a **3-D temperature map**, not only κ numbers.
- Thermal is the next new physics, ahead of fluids. Crush to densification stays parked as later work.

## 7. Open questions for Matt

- Should the default filler be vacuum (the lattice's own solid conduction) or water / tissue (the in-body case)? This scope assumes vacuum.
- Should the temperature map default to one cell with ΔT across it, or would you rather set a physical gradient, such as degrees per millimetre?
- Are the as-built conductivity presets worth adding next to the wrought values for every AM material, or only where the gap is large?
- Is bone cement filling a case you want built in now (it needs a cement material entry), or later?

---

## 8. Limits for version 1

- Steady conduction only: no time-dependent heating and no convection.
- One solid material per cell (multi-material cells come with the multi-material roadmap).
- Isotropic solid conductivity. As-built anisotropy, such as AlSi10Mg through-plane vs in-plane, is not modelled; it can be added as a diagonal k_s later.
- Contact resistance between struts and filler is neglected.

---

## 9. Later (not in this pass)

- **Conjugate heat transfer** (heat carried by flowing fluid) with the fluids module's velocity field: a one-way coupled advection–diffusion solve. See `FLUIDS_LBM_SCOPE.md` §9.
- **Effective electrical conductivity.** The same solver applies with σ in place of k. This is relevant to MRI-related implant questions, though RF heating itself is an electromagnetic problem outside the lab.
- **Thermal expansion of multi-material cells**, via an eigenstrain added to the elastic solve. Levin's two-phase formula is the exact check. It is pointless for single-material lattices, which expand exactly like the parent metal.

---

## 10. Sources

- Willot, Abdallah & Pellegrini (2014), Fourier-based schemes with modified Green operator for computing the electrical response of heterogeneous media with accurate local fields, *Int. J. Numer. Meth. Eng.* — https://arxiv.org/abs/1307.1015
- Willot (2015), Fourier-based schemes for computing the mechanical response of composites with accurate local fields, *C. R. Mécanique* 343 — https://arxiv.org/abs/1412.8398
- Schneider, Ospald & Kabel (2016), Computational homogenization of elasticity on a staggered grid, *Int. J. Numer. Meth. Eng.* 105 — https://publica.fraunhofer.de/handle/publica/243089
- Zeman, Vondřejc, Novák & Marek (2010), Accelerating a FFT-based solver for numerical homogenization of periodic media by conjugate gradients, *J. Comput. Phys.* 229 — https://arxiv.org/abs/1004.1122
- Moulinec, Suquet & Milton (2018), Convergence of iterative methods based on Neumann series for composite materials — https://arxiv.org/abs/1711.05880
- Kabel, Merkert & Schneider (2015), Use of composite voxels in FFT-based homogenization, *CMAME* 294 (already cited in NEXT_STEPS for elastic partial-volume voxels)
- Lendvai & Schneider (2025), level-set composite voxels for FFT thermal conductivity — https://duepublico2.uni-due.de/receive/duepublico_mods_00083357
- Abueidda et al. (2016), Effective conductivities and elastic moduli of novel foams with triply periodic minimal surfaces, *Mech. Mater.* 95 — https://doi.org/10.1016/j.mechmat.2016.01.004
- Zhang & Liu (2025), thin-shell limit of TPMS conductivity — https://arxiv.org/abs/2506.22319
- Torquato & Donev (2004), Minimal surfaces and multifunctionality, *Proc. R. Soc. A* — https://doi.org/10.1098/rspa.2003.1269
- Lu, Stone & Ashby (1998), Heat transfer in open-cell metal foams, *Acta Mater.* 46 — https://collaborate.princeton.edu/en/publications/heat-transfer-in-open-cell-metal-foams/
- Meredith (1959), cubic arrays of spheres, UCRL-8667 — https://escholarship.org/content/qt7ww0z4bc/qt7ww0z4bc.pdf
- Bartsch et al. (2022), LPBF Ti-6Al-4V and powder conductivity, *Front. Mech. Eng.* — https://doi.org/10.3389/fmech.2022.830104
- Candela et al. (2024), LPBF CuCrZr conductivity, *J. Nucl. Mater.* — https://research.unipd.it/retrieve/ebf3d135-9094-42b9-8742-8c7c3fe6b10c/1-s2.0-S002231152400237X-main.pdf
- Van Cauwenbergh et al. (2021), LPBF AlSi10Mg conductivity, *Sci. Rep.* — https://pmc.ncbi.nlm.nih.gov/articles/PMC7979699

**To confirm before coding:**
- the exact Rayleigh / McPhedran coefficients for T5;
- the PMMA cement conductivity;
- the Schneider–Ospald–Kabel equivalence statement (the paper could not be fetched; the equivalence for the scalar case is standard).
