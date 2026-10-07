# F13LD.lab — Fluids: Lattice Boltzmann Wall Shear Stress and Permeability (Scope)

**Status:** Approved for planning (Matt, 2026-10-07; decisions in §6). No code written yet.
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
     LBM  D3Q19 · TRT (Λ = 3/16) · body force · interpolated bounce-back
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

- **Wall fraction per link.** For a fluid node x_f whose link along c_i reaches a solid node:

      q = φ(x_f) / (φ(x_f) − φ(x_f + c_i))

  φ is the gradient-normalized signed field from `14e-link-field.js`, shared with thermal (`THERMAL_SCOPE.md` §3.3).
- **Wall rule:** Bouzidi, Firdaouss & Lallemand (2001), linear.
  - q < ½ uses the next fluid node behind; q ≥ ½ uses the node itself.
  - Fallback to halfway bounce-back where the node behind is solid, which happens in very thin throats.
  - **This fits the standard fused pull kernel.** All inputs are post-collision values already in the read buffer, so there is no extra pass.
- **q computed in-kernel from a stored φ** (4 bytes per cell) instead of a per-link table. Every boundary link costs one subtraction and one divide, with no sparse indexing.
- **Thin features.** A wall or strut thinner than one voxel, where both ends of a link are fluid but its midpoint is solid, gets a per-cell "thin link" bit computed once in 14e. Those links are treated as walls with q clamped.
- **Mass correction.** Interpolated bounce-back leaks a tiny amount of mass each step. Every few hundred steps a reduction measures the total, and the deficit is returned to the rest populations (scheme of arXiv 1908.09235). Drift is reported.
- **Halfway bounce-back stays as a switch,** for validation and comparison.

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
2. **Wall mesh:** surface nets on the signed field, so it is smooth and watertight. This is ported from F13LD.pullout, where it was verified to recover radii on analytic shapes.
   - Built on the CPU in a worker.
   - Each vertex carries position, normal n = ∇φ/|∇φ| (exact from the field), and area (its share of adjacent triangles).
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
| `14e-link-field.js` (new, shared) | Normalized signed field, link fractions, thin-link bits, normals |
| `14f-surface-nets.js` (new) | Wall mesh with per-vertex normal and area (ported from F13LD.pullout); worker-capable |
| `14a-connectivity.js` | Run components on the fluid phase (no change to the function, a new caller) |
| `19f-flow-cpu-ref.js` (new) | Float64 D3Q19 TRT reference with identical boundary rules, for N ≤ 32 |
| `19g-flow-lbm.js` (new) | GPU solver: kernels, force calibration, convergence, mass correction, coarse-to-fine start, stress and speed extraction |
| `19h-flow-wss.js` (new) | Wall probes, extrapolation, unit tractions, live rescaling, statistics, orientation scan |
| `15c-materials.js` | Fluid presets (μ, ρ at 37 °C) beside the existing `muFluid_PaS` field; family → default WSS window map |
| `50-controls.js` | `PHYS_STATE.flow`, run phase after thermal, flow settings, timing calibration |
| `40-design-grid.js` | Card rows and flags, Flow view tab, live controls, histogram and flow-rate curve |
| `21-raymarcher.js` | Window-band colour mode, WSS shell texture, section-plane speed view (plane from thermal) |
| `22-stiffness-viz.js` | K(n) surface and the orientation-map sphere |
| `62-sweep.js`, `63-sweep-atlas.js` | Permeability, best flow, in-window % at best flow, usable flow range, window used |
| `index.html` | Flow toggle and view tab |
| `18-stokes-cpu-ref.js`, `19-stokes-solver.js` | **Retired** after validation. The CPU FFT helpers the buckling worker loads from 18 (`fft3dCpu`) move to a small `12b-fft-cpu.js` first, and `BUCKLE_WORKER_FILES` is updated |

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
| **0 — Groundwork** | `buildVoxelField` + `14e` (shared with thermal); CPU reference D3Q19 TRT with both wall rules; F1–F7 on the CPU; **standalone WebGPU benchmark page** in `proto/lbm-bench/` that Matt runs on his RTX to measure updates per second and steps to converge at 64³ and 128³ | 1–2 sessions |
| **1 — GPU solver** | `19g`: fused kernel, interpolated walls, force calibration, convergence, mass correction, coarse-to-fine start; fluid connectivity; permeability tensor; card rows and flags; F8–F11 | 1–2 sessions |
| **2 — Wall shear** | `14f` surface nets, `19h` probes / extrapolation / unit tractions, live rescaling, statistics, window presets, best flow rate, force-balance check | 1 session |
| **3 — Viewer** | Window-band and continuous WSS maps, speed on the section plane, histogram and flow-rate curve, orientation sphere, K(n) surface | 1 session |
| **4 — Sweep and cleanup** | Sweep and Atlas columns; F12–F14; retire the Stokes files (FFT helpers moved first) | ½ session |

Thermal goes first (`THERMAL_SCOPE.md`). It builds the shared signed-field and section-plane pieces this module needs.

Version targets: flow Phase 1 as **v0.20.0**.

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

- Should the default fluid be culture medium with 10 % serum, or water at body temperature?
- Once the new solver validates, can the old Stokes files be deleted outright, or should they move to the proto folder?
- Should nutrient and oxygen transport be planned as the next flow feature after this?

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

**To confirm before coding:**
- the exact Zick–Homsy / Sangani–Acrivos table values for F6 and F7;
- Ginzburg's CLI coefficients, if the linear interpolation option is added alongside Bouzidi;
- the adapter's actual storage-binding limit on Matt's machine (reported by the Phase 0 benchmark page).

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

### 11.7 Open questions for Matt

Listed in the session handoff; the user's answers on fluids and operating ranges set the default presets and Reynolds list.
