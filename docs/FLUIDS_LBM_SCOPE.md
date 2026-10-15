# F13LD.lab — Fluids: Lattice Boltzmann Wall Shear Stress and Permeability (Scope)

**Status:** Approved (Matt, 2026-10-07; decisions in §6). **Phase 0 done 2026-10-14 (v0.27.1): CPU reference, checks F1–F7, GPU benchmark (§12). Phase 1 built 2026-10-14 (v0.28.0, branch `fluids-phase0`): GPU solver `19g`, Flow mode, permeability cards (§13).**
**Written against:** v0.18.0 (main `18ddbae`), 2026-10-07
**Goal:** Tell a designer whether a lattice will give cells the right mechanical cue under perfusion. The module computes the wall shear stress (WSS) on every strut surface, how much of the surface falls inside an osteogenic target window, and the permeability tensor. It works for any lattice the lab can build, built from scratch inside F13LD.lab on a lattice Boltzmann (LBM) solver running on the GPU.
**Out of scope (this pass):**
- Whole scaffolds in a bioreactor chamber (inlet jets, wall channelling).
- Turbulence.
- Non-Newtonian fluids. Culture medium is Newtonian to within a few percent (Poon 2020).
- Cell growth or remodelling.

  Extensions are listed in §9.

---

## 1. Why LBM, and why from scratch

The lab already contains an FFT Stokes–Brinkman permeability solver (`18-stokes-cpu-ref.js`, `19-stokes-solver.js`). Matt is not confident in its accuracy, and it has three gaps:
- The GPU version drifts in single precision after about 200 iterations.
- It has **no velocity field and no wall shear output**.
- Nothing in the app calls it.

It also models walls as a penalty "sponge", which smears exactly the near-wall velocity gradient that WSS depends on. **This module replaces it.** The old files are retired once the new solver passes validation (§5 Phase 4).

**Why lattice Boltzmann suits this job:**
- **It runs on the same voxel cube as every other lab solver.** No meshing.
- **Explicit, local and bandwidth-bound,** which is the ideal shape for WebGPU compute.
- **Works in single precision.** Lehmann et al. (2022) found FP32 indistinguishable from FP64 for LBM in almost all cases, which is exactly where the old Stokes solver failed.
- **The local stress comes free.** The viscous stress tensor at every fluid node is read directly from the distribution functions, with no finite differencing of velocity (Krüger, Varnik & Raabe 2009). That is what makes WSS accurate.
- **Room to grow.** The same machinery handles nutrient and oxygen transport, heat carried by flow, and higher-speed (inertial) flow later.

### What makes this one special

Most scaffold CFD studies mesh one geometry, run one flow rate in one direction, and report a mean WSS. This module does four things they usually don't:

1. **Walls at their true sub-voxel position.** Every F13LD design is a signed field, so each wall link knows exactly where the wall crosses it. The wall condition uses that fraction (interpolated bounce-back), and the wall normal comes from the field gradient. Normals are exact rather than estimated from the staircase or the flow. Matyka et al. showed geometric normals beat flow-derived ones; Pires et al. (2022) found voxel-staircase scaffold meshes under-read WSS by about 35 % against smoothed ones.
2. **Every flow rate and every flow direction, live, from three solves.** At scaffold Reynolds numbers (well below 1) the flow is linear in the driving force. Solving once along x, y and z gives the wall traction for *any* flow direction and *any* flow rate by superposition. The flow-rate and direction controls then update the WSS map instantly, with no re-solve.
3. **Biology-facing outputs:**
   - the percentage of surface area inside a chosen WSS window;
   - stagnant surface (too little stimulus);
   - surface above the cell-detachment level;
   - the flow rate that maximizes in-window surface;
   - an orientation map showing which way to mount the scaffold in the bioreactor.
4. **Self-checking.** At steady state the shear on all walls must balance the driving force exactly. Every run reports that residual, so a bad wall sample or a leaking boundary shows up as a number, not a hidden error.

```
 recipe ─► buildVoxelField (signed field) ─► 14e link fractions + normals ─┐
                                                                            │
   fluid connectivity (open pores, dead ends, sealed voids) ◄── 1 − solid   │
                                                                            ▼
     LBM  D3Q19 · TRT (Λ = 3/16) · body force · CLI interpolated bounce-back
       three steady solves: force along x, y, z      (GPU, FP32)
                │                                   │
        stress tensor at fluid nodes        mean velocity → K (3×3)
                │
  wall mesh (surface nets on the signed field) ─► probe stress off each wall
  point, extrapolate to the wall ─► unit traction vectors t̂x, t̂y, t̂z per point
                │
     live:  flow rate Q, direction d̂, fluid μ  ─►  WSS map, window %,
            best flow rate, orientation map, force-balance check
```

---

## 2. What the user sees

1. **Turn on the "Flow" physics toggle** and Run All. Flow runs after the others because it is the slowest.
2. **Card rows:**
   - Permeability κx, κy, κz in m², plus k / L² (dimensionless, independent of cell size)
   - Porosity and specific surface (mm² of wall per mm³)
   - Hydraulic tortuosity
   - **Best flow:** the flow rate that puts the most surface inside the target window, in mm/s and in mL/min for the chosen chamber
   - **% of surface in the window at that best flow:** the headline biocompatibility number
   - **Usable flow range:** the span of flow rates over which in-window surface stays at least half of its best. A wide range means the design forgives an imprecise pump
   - At the best flow: area-weighted median and 95th-percentile WSS in mPa, % stagnant (below the stimulation floor) and % above the detachment limit
   - Flags: "no open path along Z", "grid too coarse for WSS" (§3.8), "best flow outside the usual bioreactor range" (§3.7), "Re > 1: inertia not modelled", "force balance off by X %"
3. **Flow view tab:**
   - **WSS on the surface**, in one of two styles:
     - *Window mode* (default): three colour bands, below / inside / above the target window, so in-window surface reads at a glance.
     - *Continuous*: log colour scale in mPa.
   - **Velocity in the pores** on the section plane (shared with thermal, `THERMAL_SCOPE.md` §3.7), as speed / mean speed.
   - **Flow rate slider:** mL/min with a chamber diameter, or superficial velocity in mm/s. The map rescales live.
   - **Flow direction:** X / Y / Z, or a free direction picked on a small sphere, also live.
   - **WSS histogram** on log bins with the window shaded, plus **in-window % vs flow rate**, a curve with the optimum marked.
   - **Orientation map:** a sphere coloured by in-window % for each flow direction at the current flow rate, drawn like the stiffness surface. It shows which way to mount the part.
   - **Directional permeability surface** K(n) from the 3×3 tensor (`22-stiffness-viz.js` pattern).
4. **Run settings:** fluid (culture medium, water at 37 °C, or custom viscosity and density), target window (defaults from the design's material, §3.7, always editable), chamber diameter for mL/min, and quality (grid, tolerance).
5. **Sweep:** permeability, best flow, in-window % at best flow and the usable flow range per run, plus Atlas metrics.

---

## 3. Technical plan

### 3.1 Lattice Boltzmann method

| Choice | Decision | Why |
|---|---|---|
| Lattice | **D3Q19** | Standard for low-Reynolds porous flow. D3Q27's extra isotropy matters at high Re; it costs 1.4× the memory and bandwidth for no gain here |
| Collision | **TRT** (two relaxation times) with magic parameter **Λ = 3/16** | BGK makes permeability depend on viscosity, because the effective wall moves with τ. TRT at fixed Λ makes the steady answer viscosity-independent for any wall scheme, and Λ = 3/16 puts bounce-back walls exactly halfway for Poiseuille flow (Ginzburg, d'Humières & Kuzmin 2008; Khirevich et al. 2015). Λ = 1/4 is an option for stability tests |
| Relaxation | τ+ ≈ 1.0 (ν = 1/6), up to about 1.5 to converge faster | With fixed Λ the steady answer does not change, so τ+ is purely a speed knob |
| Driving | **Uniform body force** on the periodic cell (Guo, Zheng & Shi 2002, split into even and odd parts for TRT), with the half-force velocity shift | Equivalent to a mean pressure gradient with no density gradient; the cleanest route to the permeability tensor. Inlet/outlet pressure boundaries are only needed for whole-chamber models (§9) |
| Speed | Force set so the peak lattice velocity is about 0.01–0.02 | Compressibility error scales as Mach², under 0.1 % at these speeds. The flow is linear, so the force is rescaled exactly after a short trial |
| Precision | FP32, **shifted populations** (store f − w) | Keeps significant digits in the small non-equilibrium part that carries the stress. FP16 storage is too coarse for low-speed stress (§3.6) |

### 3.2 Walls: interpolated bounce-back from the signed field

*Revised in Phase 0 (2026-10-14); the original plan is kept in the notes below.*

- **Wall fraction per link, precomputed.** `buildFlowLinks` in `14e-link-field.js` walks all 18 D3Q19 links (9 positive directions, one walk serving both ends) on the design's own margin, 9 samples plus 6 bisection steps per crossing (1/512 of a link), and stores the fraction from each fluid end to the first wall. The margin is not a distance, so interpolating q from the field values at the two ends (the original plan) would misplace walls on TPMS fields.
- **Wall rule: central linear interpolation (CLI), Ginzburg (2008).** For incoming direction i at fluid node x, with the wall on the link x → x + c_j (j opposite i) at fraction q:

      f_i(x) = f*_j(x) + (1 − 2q)/(1 + 2q) · [ f*_j(x + c_i) − f*_i(x) ]

  - q = ½ reduces to halfway bounce-back.
  - Every input is a post-collision value in the read buffer, so it fits the fused pull kernel.
  - The node behind (x + c_i) must be fluid with an open link; where it is not (very thin throats), the link falls back to halfway.
  - **Bouzidi linear was the original plan and failed check F3:** with TRT its permeability still moves with τ⁺ (−2.4 % at 0.6, +4.9 % at 2.0). CLI holds to 2 ppm. Bouzidi stays as a switch (`wall: 'bouzidi'`) for comparison, as does halfway.
- **Thin features.** A wall thinner than a voxel that passes between two fluid centres gets a q at each end, so it is walled off from both sides. Links are examined whenever either end is a surface voxel (centre disagrees with a corner or a face neighbour).
- **Mass correction every step.** The steady wall leak is summed as each step reads the nodes and taken off the rest populations in the next read. Correcting every few hundred steps (the original plan) left a sawtooth in ρ that showed in the mean velocity at 1e-7 and stalled convergence.
- **GPU wall tables** (benchmark page, then 19g): a flag word per cell (bit 0 solid, bits 1–18 walled incoming directions) and, for wall cells only, a slot into a table of 18 float q values. Interior fluid cells read nothing extra. Fallback links store q = ½.

### 3.3 Fluid connectivity

`periodicComponents` (`14a-connectivity.js:341`) is run on the fluid phase (1 − solid):
- **Sealed voids** (fluid with no connection to the main pore network) are treated as solid for flow. They are excluded from WSS statistics and reported as "sealed porosity %".
- **Open axes.** The `wraps` bits say which axes have a through-path. Permeability along an axis without one is reported as zero with a "no open path" flag, not solved.
- **Dead-end pockets** stay in the domain. They are where stagnant, under-stimulated surface lives, so they count in the statistics.

### 3.4 Steady state and acceleration

- **Initial state:** rest. Each direction runs until both of these hold:
  - the relative change in mean velocity over 500 steps is below 1e-6 (Standard) or 1e-7 (High);
  - the force balance (§3.5) closes within 0.1 %.
- **Coarse-to-fine start:** the same design solved at N/2 (rebuilt exactly from the field, not downsampled), then interpolated up as the starting state at N. Viscous settling time grows as N², so this removes most of the slow part.
- **Large τ+** where stable (§3.1).
- **Expected step counts:**
  - roughly 10⁴ at N = 64;
  - several 10⁴ at N = 128.

  Measured in Phase 0 before any time estimate is shown.

### 3.5 Outputs from the flow field

- **Permeability.** Darcy's law per load case gives a column of the mobility. For force density g along e_j:

      K e_j = ν_lat ⟨u⟩ / g_j · Δx²

  ⟨u⟩ is the *superficial* mean, with solid cells counted as zero. Then:
  - symmetrize, and record the asymmetry as a health number;
  - report K in m² for the design's cell size, and k / L².
- **Porosity**, sealed porosity, and **specific surface** (wall area per volume, from the mesh in §3.6).
- **Hydraulic tortuosity:** ⟨|u|⟩ / ⟨u · d̂⟩.
- **Force balance:** the sum of wall traction × area over the mesh (§3.6) must equal the driving force × fluid volume. This is reported as a residual.
- **Fields kept for the viewer:** speed on voxel centres for the section plane (solver order, through `solverToTexOrder`), per direction.

### 3.6 Wall shear stress pipeline

1. **Stress at fluid nodes** (post-processing kernel, once per direction at convergence):

       σ'_αβ = −(1 − 1/(2τ+)) Σ_i (f_i − f_i^eq) c_iα c_iβ

   Krüger, Varnik & Raabe 2009, with the force correction included. Six values per fluid node.
2. **Wall mesh:** the marching-tetrahedra surface `14e` already builds for the surface-area metric (Matt, 2026-10-14), so the WSS statistics, the force-balance check and the specific surface on the cards all use one surface.
   - Built on the CPU in a worker.
   - Marching tetrahedra makes many small triangles, so probes sit at triangle centres, each with its area and the normal n = ∇m/|∇m| from the field.
3. **Probe and extrapolate.** At each vertex, sample the stress at two points off the wall, about 1.25Δx and 2.25Δx along n.
   - Sampling is trilinear and uses only fluid nodes.
   - The values are extrapolated linearly to the wall. Wall stress is exactly linear in wall distance for Poiseuille flow, and nearly so in any smooth gap.
   - This keeps WSS clear of the first-node error that Stahl, Chopard & Latt (2010) found directly at the wall.
   - A velocity-gradient estimate, with no-slip at the wall, is computed alongside as a cross-check.
4. **Traction and shear per vertex, per direction:**

       t = σ'·n,   τ_w = t − (t·n) n

   Stored as **unit traction vectors** t̂x, t̂y, t̂z for unit force along each axis. That is 9 floats per vertex, a few MB even at N = 128.
5. **Live rescaling (the key trick).** For a superficial velocity vector U (from flow rate Q, chamber area A and direction d̂, so U = (Q/A) d̂):
   - the force needed is G = μ K⁻¹ U;
   - the wall shear is τ_w(x) = Σ_j G_j t̂_j(x).

   It is linear in G, so any flow rate, direction or viscosity is one small matrix-vector product per vertex. That runs in milliseconds on the CPU, so the sliders are live.
6. **Statistics (area-weighted, per setting):**
   - median, mean, 95th percentile and maximum;
   - a log-bin histogram;
   - % of area in the window, below the stimulation floor, and above the detachment limit;
   - in-window % vs flow rate as a 1-D scan;
   - in-window % vs direction, over about 500 points on the sphere, for the orientation map.
7. **Display:** per-vertex WSS is splatted into a thin shell of voxels just inside the wall. The raymarcher's surface lookup (stress mode 2) then reads it directly. This uses the R16F signed-scalar path from thermal, with no new mesh renderer.

### 3.7 Physical inputs and target windows

**Fluid presets** (37 °C; Newtonian):
- culture medium with 10 % serum: μ ≈ 0.93 mPa·s, ρ = 1007 kg/m³ (Poon 2020);
- water: 0.69 mPa·s;
- custom.

Viscosity only scales WSS. Permeability does not depend on it.

**Flow presets:**
- perfusion bioreactor: flow rate in mL/min plus chamber diameter in mm;
- or superficial velocity directly in mm/s.

**No arbitrary reference flow: results are reported at each design's own best flow.** What a designer wants to know is:
1. how much surface this lattice can put in the osteogenic window;
2. at what flow;
3. how forgiving it is if the pump is off;
4. whether that flow is one a lab can actually run.

All four come free from the live-rescaling trick (§3.6, step 5). The card reports the best flow, in-window % at it, and the usable range (in-window ≥ ½ of its best). Sweeps record the same, so designs compare on what each can achieve, not on one flow that suits some of them.

**Practical operating range.** Perfusion studies typically run at superficial velocities of about 0.1–1 mm/s (Pires et al. 2022 used 0.1 and 1 mm/s). Zhao et al. (2018) found mineralization-optimal flows of 0.5–5 mL/min, or 0.17–1.7 mm/s, depending on pore shape and size. When a design's best flow falls outside roughly 0.05–2 mm/s, the card flags it as hard to reach in a standard bioreactor.

**Chamber diameter** only converts mm/s to mL/min for display: Q = U·A. It defaults to 10 mm and is editable.

**Target window, chosen by material.** The window defaults from the design's material family (the `family` field in `15c-materials.js`). It is always editable, and every preset is selectable for any material.

| Material family | Default window | Basis |
|---|---|---|
| Titanium, cobalt-chrome, stainless steel, refractory (Ta, Nb), shape memory (NiTi) | **10–30 mPa** | Mineralizing shear measured on titanium fibre mesh, compiled in Zhao et al. 2018. The closest evidence for metal scaffolds |
| Polymer (PA12, PEEK, PEKK) | **0.1–10 mPa** | The window most scaffold CFD studies use (Pires et al. 2022, citing Zhao et al. 2015 and Ali et al. 2019) |
| Ceramic (none in the library yet) | **5–15 mPa** | β-TCP, Zhao et al. 2018. Ready for when ceramics are added |
| Aluminium, copper, nickel superalloys | **0.1–10 mPa**, with a "not an implant material" note | No implant evidence; the general window is used |

**Selectable presets:**

| Preset | Window | Source |
|---|---|---|

| Preset | Window | Source |
|---|---|---|
| General scaffold CFD | 0.1–10 mPa | Pires et al. 2022, citing Zhao et al. 2015 and Ali et al. 2019 |
| Titanium fibre mesh | 10–30 mPa | Compiled in Zhao et al. 2018 |
| Ceramic (β-TCP) | 5–15 mPa | Zhao et al. 2018 |
| Silk fibroin | 1.47–24 mPa | Zhao et al. 2018 |
| Custom | user values | — |
| Floor and ceiling (always on) | below 0.11 mPa: insufficient stimulus; above 60 mPa: cell death or detachment | Zhao et al. 2018 |

**Reynolds check.** Re = ρ U d / μ, with d the mean pore size.
- Above about 0.5 the card warns that inertia starts to matter and the linear rescaling becomes approximate. At 1 mm/s and 500 µm pores, Re ≈ 0.5.
- Inertial runs are a later option (§9).

**Cell size** comes from the design (`recipe.geometry.cellSizeMm` / `design.cell_mm`), as the other solvers use it.

### 3.8 Is the grid fine enough? (a grid rule for flow)

Permeability needs about **8–10 cells across the narrowest throats**. WSS with interpolated walls and extrapolation needs about **15–20** (Khirevich et al. 2015; Stahl et al. 2010).

**Rule:** the lab already has an exact periodic distance transform (`periodicEdt3d`, `14c-stl-import.js:261`). Run on the fluid phase, it gives the local pore diameter.
- The card reports the 10th-percentile throat diameter in cells.
- It flags "coarse for WSS" or "coarse for permeability" against those thresholds.
- For a 70 % gyroid, channels are roughly 0.4–0.5 of the cell edge: about 13–16 cells at N = 32, 26–32 at N = 64, and reference quality at N = 128.

**Thin solid walls.** TPMS sheets below about two voxels rely on the thin-link bits (§3.2) to stay watertight. Flow must not leak through a sheet the solver can't see.

### 3.9 GPU layout and memory

- **Populations:** structure-of-arrays, A-B buffers, fused pull-stream-collide kernel.
- **Per-cell data:** φ (f32) and a flag word (solid bit, thin-link bits).
- **Reductions** (mean velocity, mass, force) use workgroup tree reductions, because WGSL has no float atomics.
- **Device limits:**
  - The device request already asks for the adapter's own binding and buffer limits (`11-webgpu-device.js:59–68`). Desktop GPUs normally allow far more than the 128 MB default.
  - If a single binding is too small, the 19 directions split across 3 buffers per copy. That still fits the 8-buffers-per-stage cap.
  - Any new cached GPU buffers join `WGPU_DEVICE_CACHE_KEYS`.

| Grid | Cells | Populations (A + B, FP32) | Stress scratch | φ + flags | Total ≈ |
|---|---|---|---|---|---|
| 32³ | 33 k | 5 MB | 1 MB | 0.3 MB | **7 MB** |
| 64³ | 262 k | 40 MB | 6 MB | 2 MB | **50 MB** |
| 128³ | 2.1 M | 320 MB | 50 MB | 17 MB | **≈ 390 MB** |

**Speed (estimate, to be measured).** LBM speed is set by memory bandwidth: about 160 bytes per cell per step here.
- Matt's RTX 4070 Ti Super has about 670 GB/s, so roughly 4 billion cell-updates per second natively at best. WebGPU should reach a good fraction of that.
- If it reaches half:
  - **64³:** a few seconds per direction, about 10–20 s per design;
  - **128³:** one to a few minutes per design.
- Phase 0 measures this on Matt's machine with a standalone benchmark page before any estimate goes into the UI.

**Single-buffer streaming** (Esoteric Pull, Lehmann 2022) halves population memory. It is only worth it beyond N = 128, and it makes interpolated walls awkward, so it is not planned.

### 3.10 Results and caching

- **Storage:** `FLOW_BY_DESIGN[id]` (the `NONLIN_BY_DESIGN` pattern). It holds K, flags, the wall mesh, unit tractions and the speed fields.
- **Card values:** a small `d.results.flow` summary.
- **Cache signature:** design fingerprint, grid, Λ, tolerance and field version. Fluid and flow settings are deliberately excluded: they only rescale, so changing them never re-solves.

### 3.11 Code touch points

| File | Change |
|---|---|
| `14-rasterizer.js` | `buildVoxelField()` (shared with thermal) |
| `14e-link-field.js` (shared) | **Done (v0.27.1):** `buildFlowLinks` — all 18 links, both ends, thin walls. Phase 2: triangle list from the marching tetrahedra (centre, area, normal) |
| `14a-connectivity.js` | Run components on the fluid phase (no change to the function, a new caller) |
| `19f-flow-cpu-ref.js` (new) | **Done (v0.27.1):** Float64 D3Q19 TRT reference, CLI / Bouzidi / halfway walls, permeability, stress and wall-shear probes; boxes of any NX × NY × NZ |
| `19g-flow-lbm.js` (new) | GPU solver: kernels, force calibration, convergence, mass correction, coarse-to-fine start, stress and speed extraction |
| `19h-flow-wss.js` (new) | Wall probes, extrapolation, unit tractions, live rescaling, statistics, orientation scan |
| `15c-materials.js` | Fluid presets (μ, ρ at 37 °C) beside the existing `muFluid_PaS` field; family → default WSS window map |
| `50-controls.js` | `PHYS_STATE.flow`, run phase after thermal, flow settings, timing calibration |
| `40-design-grid.js` | Card rows and flags, Flow view tab, live controls, histogram and flow-rate curve |
| `21-raymarcher.js` | Window-band colour mode, WSS shell texture, section-plane speed view (plane from thermal) |
| `22-stiffness-viz.js` | K(n) surface and the orientation-map sphere |
| `62-sweep.js`, `63-sweep-atlas.js` | Permeability, best flow, in-window % at best flow, usable flow range, window used |
| `index.html` | Flow toggle and view tab |
| `18-stokes-cpu-ref.js`, `19-stokes-solver.js` | **Done:** removed in v0.21.0, CPU FFT in `12b-fft-cpu.js` |

---

## 4. Validation plan

Exact answers first, then published data, then self-consistency. The CPU reference runs headless. GPU timing and the 128³ runs happen on Matt's machine.

| # | Test | Pass |
|---|---|---|
| F1 | Plane Poiseuille, walls on the grid, halfway bounce-back, TRT Λ = 3/16 | Velocity profile and WSS = G·H/2 exact to float precision |
| F2 | Plane Poiseuille with walls at fractional positions (q = 0.1–0.9), interpolated bounce-back | Flow rate and WSS within 1 % |
| F3 | Viscosity independence: same geometry at τ+ = 0.6 / 1.0 / 2.0, fixed Λ | Permeability changes < 0.1 %; plain BGK shown failing for contrast |
| F4 | Circular pipe embedded along (1,0,0), (1,1,0), (1,1,1) and an irrational direction, radius 8 and 16 cells | Mean WSS = G·R/2 within 2 %; point-to-point scatter < 5 % at R = 16 (orientation independence, after Matyka et al.) |
| F5 | Square duct | Mean wall shear = G·a/4 exactly (force balance); flow rate vs the series solution within 1 % |
| F6 | Simple-cubic array of spheres, solid fraction 1–50 % | Sangani & Acrivos / Zick & Homsy drag within 2 % at sphere radius ≥ 8 cells. An LBM reproduction reached 0.3–2 % (arXiv 1401.2025). Exact table values confirmed before use |
| F7 | Square array of cylinders, transverse flow | Sangani & Acrivos / Drummond & Tahir within 2 % |
| F8 | Linearity and superposition | Doubling the force doubles every field; a run along (1,1,0) matches the x + y combination within 0.5 % |
| F9 | Force balance and mass | Wall traction × area equals the driving force within 0.1 %; mass drift < 1e-6 |
| F10 | GPU vs CPU reference, N = 16–32, every family including foam and STL import | Within 1e-5 relative |
| F11 | Grid convergence, gyroid / Schwarz P / foam at 32 / 64 / 128 | K and median WSS monotone; the grid rule (§3.8) flags the coarse cases |
| F12 | Published TPMS permeability (Castro et al. 2019: gyroid vs Schwarz P vs Schwarz D at matched porosity) | Within the scatter between their CFD and experiment; same ranking |
| F13 | Old FFT Stokes CPU reference at N = 32 (informational only) | Differences explained; not a pass/fail gate |
| F14 | Native designs unchanged | Stiffness, crush, buckling and thermal identical to before |

---

## 5. Effort and phasing

| Phase | Contents | Rough size |
|---|---|---|
| **0 — Groundwork** ✓ | `14e` flow links; CPU reference D3Q19 TRT with three wall rules; F1–F7 on the CPU (§12); **WebGPU benchmark page** in `proto/lbm-bench/` that Matt runs on his RTX to measure updates per second and steps to converge at 64³ and 128³ | done 2026-10-14 |
| **1 — GPU solver** ✓ | `19g`: fused kernel, CLI walls, convergence, mass correction; fluid connectivity; permeability tensor; card rows and flags; F8–F11 (§13). Coarse-to-fine start dropped (Matt, 2026-10-14) | built 2026-10-14 |
| **2 — Wall shear** | `14e` triangle list, `19h` probes / extrapolation / unit tractions, live rescaling, statistics, window presets, best flow rate, force-balance check | 1 session |
| **3 — Viewer** | Window-band and continuous WSS maps, speed on the section plane, histogram and flow-rate curve, orientation sphere, K(n) surface | 1 session |
| **4 — Sweep and cleanup** | Sweep and Atlas columns; F12–F14 | ½ session |

Thermal goes first (`THERMAL_SCOPE.md`). It builds the shared signed-field and section-plane pieces this module needs.

Version targets: Phase 0 is **v0.27.1** (nothing user-visible); flow Phase 1 as **v0.28.0**.

---

## 6. Decisions on record (Matt, 2026-10-07)

- The purpose of fluids is **wall shear stress, to judge lattices for biocompatibility**. Permeability is a by-product.
- **Fluids lives inside F13LD.lab.** The lab is the one-stop shop for lattice computation.
- **Start from scratch** rather than building on the existing Stokes solver, whose accuracy is uncertain.
- Crush to densification is parked until after thermal and fluids.
- **The WSS window is selectable and defaults from the material chosen** (§3.7).
- **No fixed reference flow.** Results are grounded in what users care about: each design's best flow, in-window surface there, how forgiving it is, and whether a lab can run it (§3.7).
- **Solve time accepted:** about 10–20 s per design at 64, one to a few minutes at 128.
- **Heat exchangers added as a second purpose** (Matt, 2026-10-07, after a request from a user building a lattice heat-exchanger database for surrogate models). Two phases follow version 1: inertial pressure drop, then convective heat transfer (§11). Order: thermal Phase 3 with the new geometry columns (`THERMAL_SCOPE.md` §3.9) → fluids version 1 (this scope) → §11.2 → §11.3.

## 7. Open questions for Matt

Answered (Matt, 2026-10-07):
- Default scaffold fluid: **water at body temperature**.
- The old Stokes files: **delete** (they can go now). `18-stokes-cpu-ref.js` also holds the CPU FFT (`fft1dCpu` / `fft3dCpu`) that 16a, 16c, 17a, the buckling workers and the node harnesses use, so the FFT moves to its own file first.
- Nutrient and oxygen transport: **probably** the next flow feature after the heat-exchanger phases.

---

## 8. Limits for version 1

- **Periodic unit cell:** results describe the scaffold interior, away from chamber walls and the inlet face. This is the region the mechanobiology papers average.
- **Steady flow.** Pulsatile perfusion at 1 Hz or below is quasi-steady at these pore sizes (Womersley number under 1), so the steady map scaled by the instantaneous flow rate applies.
- **Newtonian, incompressible, isothermal.**
- **Rigid walls.** Strut deformation under flow is negligible at mPa stresses.
- **Inertia neglected.** Flagged when Re > 0.5.

---

## 9. Later (not in this pass)

- **Oxygen and nutrient transport:** an advection–diffusion lattice (D3Q7, TRT) driven by the converged velocity field, one-way coupled, with uptake on cell-covered walls. Flow through scaffold pores is advection-dominated (pore Péclet number in the hundreds at 1 mm/s), so it needs care with resolution.
- ~~Conjugate heat transfer~~ and ~~inertial runs~~ — now planned phases, §11 (Matt, 2026-10-07).
- **Whole construct in a chamber:** pressure inlet and outlet, entrance effects, wall channelling. This needs a multi-cell domain and connects to the multi-cell work for buckling and crush.
- **Streamlines and particle paths** in the viewer.

---

## 10. Sources

**Method**
- Ginzburg, d'Humières & Kuzmin (2008), Optimal stability of advection-diffusion lattice Boltzmann models with two relaxation times, *Commun. Comput. Phys.* — https://ojs.global-sci.org/index.php/cicp/article/view/5523
- Ginzburg & d'Humières, TRT simple hydrodynamic solutions, *Commun. Comput. Phys.* — https://ojs.global-sci.org/index.php/cicp/article/view/5526
- Khirevich, Ginzburg & Tallarek (2015), Coarse- and fine-grid numerical behavior of MRT/TRT lattice-Boltzmann schemes in regular and random sphere packings, *J. Comput. Phys.* — https://arxiv.org/abs/1508.02960
- Bouzidi, Firdaouss & Lallemand (2001), Momentum transfer of a Boltzmann-lattice fluid with boundaries, *Phys. Fluids* 13:3452
- Guo, Zheng & Shi (2002), Discrete lattice effects on the forcing term in the lattice Boltzmann method, *Phys. Rev. E* 65:046308
- Mass-conservative curved-boundary treatment — https://arxiv.org/abs/1908.09235
- Single-node interpolated boundaries (ELIBB) — https://arxiv.org/abs/2009.04604
- LBM on micro-tomographic pore spaces (resolution, BGK vs TRT) — https://arxiv.org/abs/1902.11193
- Lehmann et al. (2022), Accuracy and performance of the lattice Boltzmann method with 64-bit, 32-bit and customized 16-bit number formats, *Phys. Rev. E* 106:015308 — https://arxiv.org/abs/2112.08926
- Lehmann (2022), Esoteric Pull and Esoteric Push, *Computation* 10:92 — https://www.mdpi.com/2079-3197/10/6/92
- lbmpy code generator (reference kernels to diff against) — https://arxiv.org/abs/2001.11806

**Wall shear stress**
- Krüger, Varnik & Raabe (2009), Shear stress in lattice Boltzmann simulations, *Phys. Rev. E* — https://arxiv.org/abs/0812.3242
- Stahl, Chopard & Latt (2010), Measurements of wall shear stress with the lattice Boltzmann method and staircase approximation of boundaries, *Computers & Fluids* 39:1625 — https://infoscience.epfl.ch/record/172172
- Matyka, Koza & Mirosław, Wall orientation and shear stress in the lattice Boltzmann model, *Computers & Fluids* — https://arxiv.org/abs/1203.3078
- Krüger et al. (2017), *The Lattice Boltzmann Method: Principles and Practice*, Springer

**Scaffolds, WSS targets and permeability**
- Zhao, van Rietbergen, Ito & Hofmann (2018), Flow rates in perfusion bioreactors to maximise mineralisation in bone tissue engineering in vitro, *J. Biomech.* — https://cronfa.swansea.ac.uk/Record/cronfa51681/Download/0051681-07092019011038.pdf
- Pires et al. (2022), gyroid and Schwarz D scaffold CFD, *Materials* 15:7375 — https://www.mdpi.com/1996-1944/15/20/7375
- Melchels et al. (2011), gyroid scaffold perfusion, *Biomaterials* 32:2878 — https://edoc.unibas.ch/30982/
- Ali & Şen (2017), gyroid vs lattice scaffolds: permeability and WSS, *J. Mech. Behav. Biomed. Mater.* 75:262
- Castro et al. (2019), permeability vs design in TPMS scaffolds, *Materials* — https://pmc.ncbi.nlm.nih.gov/articles/PMC6515433
- McCoy & O'Brien (2010), shear stress in perfusion bioreactor cultures: a review, *Tissue Eng. Part B* — https://repository.rcsi.com/articles/Influence_of_shear_stress_in_perfusion_bioreactor_cultures_for_the_development_of_three-dimensional_bone_tissue_constructs_a_review_/10765514/1
- Lipowiecki et al. (2014), permeability of rapid-prototyped scaffolds and trabecular bone (trabecular bone ≈ 10⁻¹¹ to 10⁻⁸ m²), *J. Biomed. Mater. Res. A* — https://dcu-test.eprints-hosting.org/20549/1/_Liopwiecki_JBM_A_2014_Permeability_of_RP_bone_scaffolds.pdf
- Poon (2020), density and viscosity of cell culture media, bioRxiv — https://www.biorxiv.org/content/10.1101/2020.08.25.266221v3
- Porter et al. (2005), LBM of scaffold perfusion, *J. Biomech.* 38:543 (context; numbers not used)
- LBM of a full perfusion bioreactor scaffold — https://arxiv.org/abs/1101.2103

**Benchmarks**
- Zick & Homsy (1982), *J. Fluid Mech.* 115:13; Sangani & Acrivos (1982), *Int. J. Multiphase Flow* 8:343
- LBM drag in sphere arrays vs Sangani–Acrivos — https://arxiv.org/abs/1401.2025
- Cylinder arrays (Drummond–Tahir form) — https://arxiv.org/abs/2301.12774

**Confirmed in Phase 0 (2026-10-14):**
- Zick–Homsy and Sangani–Acrivos table values: taken from the Basilisk test-case transcriptions and cross-checked against the dilute Hasimoto forms (§12).
- CLI coefficients: written from Ginzburg, Verhaeghe & d'Humières (2008), *Two-relaxation-time lattice Boltzmann scheme: about parametrization, velocity, pressure and mixed boundary conditions*, Commun. Comput. Phys. 3:427 (https://www.researchgate.net/publication/230703724). The paper text could not be fetched in-session, so the form in §3.2 rests on checks F2 and F3: it reduces to halfway at q = ½, is second order on Poiseuille, and holds viscosity independence to 2 ppm.

**Measured on Matt's machine (2026-10-14):** storage-binding limit 2 GB and 16 storage buffers per stage; throughput in §12.

---

## 11. Heat-exchanger extension (planned, Matt 2026-10-07)

### 11.1 Why

A user building a database of lattice responses for heat exchangers, to train reduced-order and surrogate models, asked for pressure drop, permeability, thermal conductivity and heat-transfer performance. Version 1 covers permeability, and pressure drop only in the viscous limit. Heat exchangers run at Reynolds numbers of roughly 10–500, where inertia carries most of the pressure drop, and their key number is the heat-transfer coefficient between fluid and solid. The LBM core of §3 serves both. These two phases add the heat-exchanger regime and outputs. Every result also goes to the sweep CSV, because surrogate training is built from it.

### 11.2 Phase HX-1: inertial pressure drop

- **Runs:** each principal axis at a list of Reynolds numbers (default 1, 10, 50, 100, 200; editable), at the true Reynolds number. Superposition (§1) no longer holds, so every point is its own solve.
- **Driving:** the body force is adjusted during the run (a simple controller on the mean velocity) until the superficial velocity hits the target Reynolds number.
- **Reynolds number:** defined on the hydraulic diameter, d_h = 4ε / a (porosity ε, surface area density a), with the interstitial velocity U/ε. The card also reports it on the cell size, since papers use both.
- **Lattice limits:**
  - Mach number: lattice velocity ≤ 0.1.
  - Relaxation time no closer to ½ than the TRT stability margin.
  - At N = 64 that likely caps the Reynolds number near 100. Higher points need N = 128, and the run warns.
- **Unsteady flow.** Above some Reynolds number the steady solution stops existing (wake shedding behind struts). When the residual stops falling, the run averages over a time window and flags "unsteady: time-averaged".
- **Outputs per axis:**
  - mean pressure gradient against superficial velocity;
  - a Darcy–Forchheimer fit −dp/dx = μU/K + βρU², with K from the version 1 run, giving the Forchheimer coefficient β (1/m) and the dimensionless F = β√K;
  - Fanning friction factor f(Re) on the hydraulic diameter;
  - the Reynolds number where inertia reaches 10 % of the pressure drop.
- **Fluids** (presets, editable):
  - air at 25 and 80 °C;
  - water at 25 and 60 °C;
  - 50/50 ethylene glycol–water;
  - a light oil;
  - custom.

  Each preset carries ρ, μ, k and c_p.

### 11.3 Phase HX-2: convective heat transfer

- **Method:** an advection–diffusion lattice (D3Q7, TRT), one-way coupled to the converged velocity field of each HX-1 point.
- **Periodic thermal condition:** the temperature is a part that rises linearly along the flow plus a periodic correction, as the thermal module splits a uniform ramp from a periodic correction. This is the fully developed periodic-cell formulation. The exact variant, uniform wall flux or uniform wall temperature (the latter needs an exponential-decay scaling), is to be confirmed against the sources in §11.6 before coding.
- **Step 1, walls at uniform temperature** (no conduction in the metal). Gives the interstitial Nusselt number.
- **Step 2, conjugate.** Heat also conducts through the solid, using the thermal module's wall voxels (`14e` `buildVoxelTensors`) and solid conductivity. Metal conduction matters at heat-exchanger scales; the thermal module already measures how much.
- **Outputs per axis and Reynolds point:**
  - interstitial heat-transfer coefficient h_sf (W/m²·K) and its Nusselt number on d_h. This is the input that two-equation porous-media models and surrogate models take;
  - volumetric coefficient h_v = h_sf · a (W/m³·K);
  - Colburn j = Nu / (Re · Pr^⅓);
  - the area-goodness ratio j/f;
  - the Prandtl number used.
- **Viewer:** the fluid temperature on the section plane (the thermal map's section plane carries over), and the wall heat flux on the strut surface, as the WSS map draws wall traction.

### 11.4 New sweep columns (per axis, per Reynolds point where it applies)

`porosity`, `surface_area_density_m2m3`, `hydraulic_diameter_mm`, `open_x/y/z` (fluid percolates), `K_xx/yy/zz_m2`, `forchheimer_beta_1m`, `forchheimer_F`, `Re`, `dpdx_Pa_m`, `fanning_f`, `Nu_sf`, `h_sf_WmK`, `h_v_Wm3K`, `colburn_j`, `j_over_f`, `fluid`, `Pr`, plus convergence and "unsteady" flags. Also a long-format CSV, one row per design × axis × Reynolds number, since surrogate pipelines usually want that shape.

### 11.5 Limits

- Periodic unit cell: the fully developed interior of a core. No entrance region, no headers, no maldistribution.
- Laminar and early-transitional flow only, with no turbulence model. The upper Reynolds limit is set by the grid and flagged.
- Constant fluid properties: no temperature-dependent viscosity, no buoyancy.
- Single-phase flow.

### 11.6 Validation targets (to confirm before use)

- Hydraulic diameter, surface area and porosity against analytic values for simple cubic and BCC beams and for Schwarz P.
- Darcy–Forchheimer on simple sphere and cylinder arrays against published periodic-cell data.
- Interstitial heat transfer: the periodic-cell study of Kuwahara, Shirota & Nakayama (2001, *Int. J. Heat Mass Transfer*) on square-rod arrays.
- TPMS heat exchangers: published CFD and experiment comparing gyroid, Schwarz P and diamond pressure drop and Nusselt number at matched porosity.
- Metal foams: published forced-convection and pressure-drop correlations.

The specific papers and their numbers are to be confirmed before they are used as pass/fail tests, as Castro et al. 2019 is for permeability (§4).

### 11.7 Decisions (Matt, 2026-10-07)

- **Reynolds list: wait for the user's answer** on his operating range before fixing defaults.
- **Fluid presets as listed** in §11.2.
- **Heat transfer: walls at uniform temperature first, conduction through the metal second.**
- **Sweep export: also a long format**, one row per design × axis × Reynolds number.

---

## 12. Phase 0 results (2026-10-14, v0.27.1)

Float64 CPU reference (`19f-flow-cpu-ref.js`) on geometry built through `14e buildFlowLinksFromFn`, so the walls are the lab's own. TRT, Λ = 3/16, CLI walls unless stated. Run: `node proto/flow/run_checks.js [F1 …]`; rows in `proto/flow/results-F*.jsonl`.

| # | Case | Result | Pass |
|---|---|---|---|
| F1 | Plane Poiseuille, walls on the grid, halfway | Profile and WSS exact to 1e-14 | ✓ |
| F2 | Plane Poiseuille, walls at q = 0.1–0.95, gap ≈ 30 cells | Flow within 0.47 %, WSS within 0.07 %. Gap ≈ 14: within 2.0 %. Halfway: 0.9–8.5 % off | ✓ |
| F3 | Viscosity independence, sphere array φ 0.216, τ⁺ 0.6 / 1.0 / 2.0 | TRT + CLI: K identical to 2 ppm. TRT + halfway: also independent. TRT + Bouzidi: −2.4 % / +4.9 %. BGK + CLI: −9 % / +38 % | ✓ |
| F4 | Circular pipe along (1,0,0), (1,1,0), (1,1,1), (1,2,3); R = 8 and 16 | Mean WSS within 0.21 % in every case; point-to-point scatter (sd) ≤ 0.72 % at R = 8, ≤ 0.41 % at R = 16; flow within 1.2 % | ✓ |
| F5 | Square duct, walls off the grid, side 20.6 / 28.6 / 44.3 cells | Flow within 0.18 % at every size. Mean WSS from wall probes −3.3 / −2.0 / −0.8 %: the probes read low within about two cells of the duct's sharp corners, and the error falls as 1 / side | flow ✓; WSS at 44 cells |
| F6 | Simple-cubic spheres vs Zick & Homsy (1982), radius ≈ 8 cells | Within 0.95 % for φ = 0.027–0.45. Touching spheres (φ 0.5236, zero-width throats): +2.6 % | ✓ except touching |
| F7 | Square cylinder arrays, transverse, vs Sangani & Acrivos (1982) | Radius 16: within 0.13 % where the gap between cylinders is ≥ 19 cells, 0.6 % at 13, 1.2 % at 8, 7 % at 4.7. Radius 8: 0.4 % at gap 10, 1.8 % at 6.3, 3.2 % at 4 | ✓ where gap ≥ 8 |
| F10 (preview) | GPU kernel (benchmark page, software WebGPU) vs CPU, 32³ sheet gyroid, 600 steps | Mean velocity 9.8e-7, every population 7.4e-7 relative | ✓ |

**What it settles**
- **CLI replaces Bouzidi** as the wall rule (§3.2). It is the only interpolated rule here that keeps TRT's viscosity independence, so τ⁺ really is only a speed knob. τ⁺ = 1.5 converges about twice as fast as 1.0 with the same answer.
- **The grid rule in §3.8 holds:** permeability lands within 1–2 % once the narrowest gap spans about 8 cells, and within a few tenths of a percent above 12.
- **Two things for Phase 2 (wall shear):**
  - Wall probes near sharp concave corners read low (F5). Lattices have filleted junctions rather than 90° corners, but the force-balance residual will show it on real designs. A velocity-gradient fallback where the probe stencil touches solid is the likely fix.
  - Touching contacts (F6 at φ 0.5236) need the grid flag rather than a solver change.
- **Speed:** the CPU reference runs about 7.6 M node updates per second on the 2-core VM, so it stays a check tool at N ≤ 48.

**GPU benchmark (Matt's RTX 4070 Ti Super, Chrome, 2026-10-14):** sheet gyroid t 0.4 (74 % pore), τ⁺ 1.5, tolerance 1e-6, one flow direction from rest.

| Grid | Throughput (fluid nodes) | Est. bandwidth | Steps | Time, one direction | Geometry build (JS) | k / L² |
|---|---|---|---|---|---|---|
| 32³ | 249 M/s (too small to time) | — | 1,000 | 0.02 s | 0.11 s | 2.0104e-3 |
| 64³ | 5,050 M/s | 790 GB/s (44 MB fits in the 48 MB L2 cache) | 2,000 | 0.09 s | 0.49 s | 2.0221e-3 |
| 128³ | 2,048 M/s | 320 GB/s (about half the card's 672 GB/s) | 5,000 | 2.9 s | 2.8 s | 2.0267e-3 |

- GPU vs CPU check at 32³ after 600 steps: mean velocity 9.8e-7, populations 7.4e-7 (F10 preview passes on real hardware).
- k / L² is monotone with grid and changes 0.58 % from 32 to 64 and 0.23 % from 64 to 128.
- A full design (three directions) at 128³ is about 9 s of solving, against the one to a few minutes budgeted in §6. The 2.8 s geometry build is single-threaded JS on the page and should move to the worker pool.
- 128³ needs 160 MB per population copy, well inside this card's 2 GB binding limit.

**Sources for the reference tables:** Zick & Homsy (1982) Table 2 and Sangani & Acrivos (1982) Table 1, as transcribed in the Basilisk test cases (basilisk.fr `src/test/spheres.c`, `src/test/cylinders.c`). Checked against the dilute Hasimoto forms: spheres φ 0.027 → 2.009 (table 2.008); cylinders φ 0.05 → 15.55 (table 15.56). Drag is the force per cell over 6πμaU (spheres) or μU per unit length (cylinders), with U the superficial velocity and force = G × cell volume.

---

## 13. Phase 1 (2026-10-14, v0.28.0)

**Decisions (Matt, 2026-10-14):**
- Flow grid defaults to **64³** (32 / 64 / 128 selectable).
- Tolerance **Standard (1e-6)**, with **High (1e-7)** as the option.
- A GPU whose buffer limit is too small for the chosen grid gets a clear message; the three-buffer split waits until a user needs it.
- Coarse-to-fine start dropped: from rest, 64³ converges in about 2,000 steps.
- Flow is off by default for new browsers.

**What was built**
- `19g-flow-lbm.js`: the bench kernel as the lab's solver.
  - Wall tables include fluid connectivity. Sealed pores (6-connected fluid components that never reach their own periodic copy) are treated as solid and reported.
  - An axis no open pore network reaches reads zero and is not solved.
  - One solve per open axis from rest, force g = 1e-5 · (64 / N)², τ⁺ 1.5.
  - The reduce kernel sums the mean speed as well as the mean velocity, which gives hydraulic tortuosity.
  - The narrowest pore is the 5th percentile of maximal inscribed balls in the open pores (`sweepFeatureThickness` on the pore phase).
- `17c`: `buildFlowLinksParallel`, x-slab `flowlinks` jobs (14e `iRange`), reusing the elastic run's voxels and margin when the grids match. Worker cache-buster `tv-5`.
- `50-controls`: `PHYS_STATE.flow`, `FLOW_STATE`, `FLOW_BY_DESIGN`, Run All Phase 5 after thermal with cache signature, time estimate (~N⁴) and calibration, run summary warnings.
- `51-dock`, `index.html`: Flow tab and pane (grid, tolerance), dock tag, saved settings; Flow view tab.
- `40-design-grid`: Flow cards — permeability X / Y / Z (m² for the design's cell; k / L² in the note), anisotropy, tortuosity, open porosity (sealed share flagged), narrowest pore (flag below 8 voxels; note below 15 for wall shear), relative density. The viewport draws K(n) from k / L² with the thermal κ(n) code (closed axes → message instead).
- Console check `runFlowGPUCheck(designIndex, N, steps)`: GPU vs Float64 CPU on any loaded design, with the same mask.

**Checks**

| # | Result |
|---|---|
| F8 | Skeletal gyroid 24³: doubling the force doubles the flow to 7e-6; flow along (1,1,0) equals the x and y flows added to 1.5e-6 |
| F9 | Mass correction per node ≤ 8e-11 per step (2e-7 of the mean speed) on sheet gyroid and Schwarz P at 32³. Force balance on the wall mesh comes with Phase 2 |
| F10 | `runFlowGPUCheck` on the TPMS demo design, 16³ (software WebGPU in the VM): velocity 3e-7, populations 1e-6, wall links identical |
| F11 | Sheet gyroid k / L² 1.994e-3 → 2.001e-3 → 2.010e-3 → 2.021e-3 at 16 / 24 / 32 / 48 (CPU), 2.022e-3 / 2.027e-3 at 64 / 128 (Matt's GPU). Schwarz P skeletal 9.10e-3 → 9.03e-3 → 9.03e-3 → 9.04e-3. Within 0.6 % per step from 24³ up |

**v0.28.1 (2026-10-14):** Matt's first click-test failed once on a wet C15 foam ("offset is out of bounds") and never again after a reload; his file runs cleanly here at every step. Most likely a worker loaded the previous 14e (whole-grid output) right after the push. Now: `FLOW_LINKS_VERSION` in 14e, reported by every `flowlinks` reply and checked with each slab's size; a mismatch restarts the pool once with a fresh query string (`_tvResetPool`), then fails with "the page loaded mixed file versions · reload the page". Errors name their step. Matt's own timings at 64³: links 0.7–1.7 s, solve 0.35–0.41 s per design.

**For Matt to check on his GPU:** a Flow run on his own designs, including foam and STL imports. Then `runFlowGPUCheck(0)`, `runFlowGPUCheck(1)` and so on in the console; each should print `pass: true`.

**Later (Matt, 2026-10-14):** flow is cheap enough at 32³ and 64³ to go into F13LD.sweep and then F13LD.vault as a comparison metric, like the Sweep stiffness, not a final solve. That needs `14e`, `17c`'s flow job and `19g` copied into Sweep the way it copies 14a and 16b, plus Vault columns.

---

## 14. Flow view (2026-10-14, v0.29.0)

**Decisions (Matt, 2026-10-14):** speed in the pores first (before wall shear), and something like a CFD flow-trajectory animation. Turbo colour scale (rainbow engineers read at a glance; smoother and kinder to colour-blind viewers than the classic jet). Streaks with a bright head, not arrows. Section-plane cut-away rather than see-through solid (lighter on the GPU with three tiles side by side). 128³ fields averaged down to 64³.

**Built**
- `19g`: a velocity kernel after each axis converges, ((Σ f* c − F/2) / ρ from the post-collision populations), read back and stored by `flowVizAddAxis` at M = min(N, 64), half precision, as velocity per unit force ÷ N² (scale-free). Open-pore mask at M. `FLOW_GPU_VERSION` `fg-2`.
- `23-flow-viz.js` (new): `flowVizField(fr, dir)` combines the axes for a mean flow along d (force ∝ K⁻¹ d; closed axes dropped) and normalizes to mean speed 1; `FlowParticles` — CPU tracers, RK2 with sub-steps (≤ 0.7 cell), periodic wrap (trail restarts), respawn in solid / after their life / when still; trails of 10 points; `flowTurbo`.
- `21-raymarcher.js`: view mode 4 (flow). Every pixel writes its depth (ray distance ÷ 64). Speed map: fluid crossed by the section plane painted turbo(speed / top). Streak pass in the same GL context: camera-facing ribbons (4 vertices per segment, own VAO), the camera model of the march (ro = R·(pan, zoom), rd = R·(uv, −1.6)), depth-tested against the march, alpha-blended, head brightened and wider.
- `40-design-grid.js` / `30-view-tabs.js`: Flow tab view switch (flow, speed, K(n)), direction X / Y / Z / XYZ, play / pause (drawn icons), speed and count sliders, colour bar, section-plane pills at the top-left; Speed scale per / shared; the first visit turns the section plane on (Z, middle) if none is set.

**Checks:** GPU velocity field vs the solver's mean flow, 16³ (software WebGPU): 1e-7, solid cells zero. Block averaging vs a hand sum: exact. Rendered headless on all three demo designs with fields from the CPU reference (screenshots in the session); controls fit a 360 px tile.

**v0.29.1 (Matt's click-test):** streak length was tied to animation speed. Trails now keep a point every `length` units of flow time (12 points, length 0.25–2×, 1 unit = one 60 Hz frame at speed 1), with the tail sliding between its last two points, so speed and frame rate do not change streak length and faster fluid still draws longer streaks. Size scales the ribbon width. Play / speed / length / size / count moved to one shared group in the view strip (`#flowAnimToggle`).

**Next:** Phase 2 wall shear stress; then flow-rate units (mm/s) on the colour bar and the WSS map on the strut surface.


---

## 15. Phase 2 — wall shear stress (2026-10-14, v0.30.0)

**Decisions (Matt, 2026-10-14)**
- The flow tool is not only for biomedical work. The cards lead with general flow (permeability, tortuosity, open porosity, narrowest pore), then wall shear. No "in window" wording: the rows say what they measure.
- X / Y / Z on one row each (permeability, tortuosity). Anisotropy, k/L² and relative density move into the notes.
- Wall shear is reported **per unit flow speed** (median / 95th percentile), which is exact at every speed in creeping flow and needs no reference flow.
- The **shear target** is a Flow setting (presets from §3.7, "From the material", custom), **none by default**. With a target the cards add the share of wall at the target, the best flow speed (with mL/min for a chamber diameter) and the usable speed range (at least half the best share).
- **Flow direction** is a setting like crush's load axis: Z / X / Y / All. All reports the best direction — the most wall at the target, or the most permeable with no target — so the card says how to orient the cells. It costs nothing: all three directions already run.
- Speed units are a setting (mm/s or m/s; shear per mm/s reads in mPa, per m/s in Pa — the same number).
- Coarse grids still show their numbers, with a warning (narrowest pore under 15 voxels).
- Permeability labels carry a hover note with the trabecular range (Nauman, Fong & Keaveny 1999: 0.027–20 ×10⁻⁹ m²), kept off the card itself.

**Built**
- `14e marginWallProbes`: the marching-tetrahedra wall of the surface-area metric, one probe per surface voxel (area-weighted centre, summed area, summed area vector as the normal into the fluid); voxels whose triangles face opposite ways (walls thinner than a voxel) keep one probe per triangle. It also returns the exact solid volume under the same linear margin (`solidVol`) for the force balance. Built in the `flowlinks` worker jobs (17c, `tv-8`; `FLOW_LINKS_VERSION` `fl-3`).
- `19g`: `flowStressWGSL` (the same gather as the step kernel, then σ' and ρ − 1 per cell) and `readStress`; after each open axis the stress is read back and `flowWallTractions` runs. `FLOW_GPU_VERSION` `fg-3`, so older cached flow results re-solve.
- `19h-flow-wss.js` (new): sampling and extrapolation (pair 1.25 / 2.25 voxels, then 0.75 / 1.5, then a single value at 1.0 where stencils are mostly solid; walls of sealed pores drop), unit shear vectors per probe per axis, force balance, statistics (`flowShearStats`: area-weighted median / 95th per m/s; with a target the widest window over the sorted shears — exact — centred on the plateau within 1 % of wall, share in / under / over, usable range, Reynolds number on the median pore), direction pick (`flowShearPick`), settings (`flowShearConfig`).
- Flow pane: Flow direction, Fluid (water 37 °C, culture medium, custom viscosity), Shear target, Speed units, Chamber diameter. All rescale the cards live — no re-solve.
- Cards: two labelled sections, wide value column.

**Checks** (`node proto/flow/wss_checks.js`, Float64 CPU fields through the lab's own probe code)

| # | Case | Result |
|---|---|---|
| W1 | Circular pipe along x, R = 8 / 16 | Mean wall shear −0.16 % / −0.04 %; scatter 0.86 % / 0.40 %; force balance 0.03 % / 0.01 % |
| W2 | Square duct, side 28.6 / 44.3 (sharp inside corners) | Mean wall shear −0.99 % / −0.38 %; force balance −1.6 % / −0.8 % (the F5 corner effect, falling with size) |
| W3 | Probe areas vs `marginSurfaceArea` (sheet gyroid 24³, 32³); slabs merged | Equal to 3e-9; normals all point away from the discretized solid |
| W4 | Sheet gyroid (t 0.4), three axes, 32³ → 48³ | Force balance −2.3 % → −1.2 %; median shear per mm/s (water, 2 mm cell) 12.4 → 13.2 mPa; a (1,1,0) solve equals the x + y shears to 6e-5; k/L² 2.010e-3 → 2.021e-3. Wall shear converges more slowly than permeability, as §3.8 expects (15–20 voxels across throats) |
| — | Generated stress shader vs the reference formula | identical (transcribed and run in node) |

The card warns when the force balance is off by more than 5 % (`FLOW_FORCE_WARN`). The run log prints probes, the force balance per axis and how many probes used the fallbacks.

**For Matt to check on his GPU:** a Flow run on his designs (the log line now ends with the wall probe summary), then the Flow settings: direction, target presets, custom target, units. `runFlowGPUCheck(i)` should still print `pass: true`.

**Next (Phase 3, viewer):** the wall shear map on the strut surface (the probes keep their positions and normals for the splat), histogram and in-target vs speed curve, orientation sphere.
