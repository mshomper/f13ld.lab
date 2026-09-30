# F13LD.lab — Session Recap

**Session:** 2026-09-29 → 2026-09-30
**Repo:** `github.com/mshomper/f13ld.lab`
**Starting point:** `c2e4fe7` (v0.7.1)
**Now live on main:** `df2fdb2` (**v0.8.2**)
**Preview any branch:** `https://raw.githack.com/mshomper/f13ld.lab/<branch>/index.html`

---

## 1. At a glance

| Version | What changed | Why it mattered |
|---|---|---|
| **v0.7.2** — Sprint A | Axis fix, real material model, yield detection, free-sided buckling, run reliability | Results were landing on the wrong axes, and yield was being misread |
| (same release) | Hyperuniform wrap, 45-material AM library | Hyperuniform now matches what F13LD.mesh builds. Materials are approved AM alloys |
| **v0.8.0** — Sprint B1 | Buckling rebuilt on voxel finite elements. Cards show yield- or buckling-limited | The old spectral buckling was physically invalid |
| (follow-ups) | Demo C → hyperuniform trabecular; ratio uses the crush axis | Removed a placeholder demo; the buckling/yield ratio now uses the right axis |
| (plot) | Stress–strain plot redesigned | Stops high buckling values squashing the plot; no overlapping text; curves look like real σ–ε curves |
| **v0.8.1** | Nonlinear crush made fast and stable | Was 60–80 s per step and hung at times. Now "incredibly fast" |
| **v0.8.2** | PI-TPMS / shell normalization kept on import. Viewer draws them correctly. Connectivity selector. Per-network buckling | PI-TPMS now matches the F13LD.tpms app; interwoven networks are handled properly |

---

## 2. What was done, release by release

### 2.1 v0.7.2 — Sprint A (correctness)

- **Axis convention.** The solver swapped x and z against the physical frame, so a stiff-in-z design reported stiffness in x.
  - The solver frame is now the physical frame (x is the slowest index).
  - The viewer converts at upload (`solverToTexOrder`).
  - Guard test: `runAxisConventionGPUTest()` uses a z-laminate, where z must come out as the soft axis.
- **Material model.** Plasticity uses Voce hardening from the selected material; the old hard-coded fallback is gone.
- **Yield detection.**
  - The 0.2 % offset uses an implicit (0,0) origin.
  - The load step shrinks near the knee so the crossing is resolved.
  - Truncated runs are flagged instead of reported as final.
- **Buckling loading.** Free-sided uniaxial loading, meaning the lateral faces are free to expand (your choice). Under the old all-sides-clamped state, buckling came out ~2× lower.
- **Reliability.**
  - Run tokens with cancel-all.
  - Recipe-fingerprint cache keys.
  - A crash handler.
  - Timing calibration re-keyed.
  - Unconverged eigen-solves are flagged.
  - The iteration cap was raised from 30 to 200. The old cap gave answers 2–9× too high.
- **Hyperuniform wrap.** Kernels wrap across the cell like F13LD.mesh tiles them. Opt out per recipe with `hu_wrap = false`.
- **Grain periodicity.** Shown visually only (the spinodoid and hyperuniform variant images). No change was made. See Next Steps §4.2.
- **Material library.** `15c-materials.js` holds 45 AM alloys: Ti grades, stainless steels, Ni superalloys, Al, Co-Cr, Cu, refractories and more. Each has Voce fits from the Considère condition. Docs are in `docs/MATERIALS.md`. You approved it.

### 2.2 v0.8.0 — Sprint B1 (buckling rebuilt)

**Finding.** The spectral (FFT) buckling operator had **510 zero-energy patterns** on an all-solid 8³ cell; only 3 are legitimate. As a result, critical load tracked the stiffness of the *void*:

| Void stiffness ratio | 1e-5 | 1e-4 | 1e-3 | 1e-2 |
|---|---|---|---|---|
| Reported buckling stress | 4.4 MPa | 43.7 MPa | 422 MPa | 3,270 MPa |

**Replacement.** Voxel finite elements, in `16h-buckling-fe.js`:

- H8I incompatible-modes hex: one element per solid voxel, void removed entirely.
- Matrix-free, with a geometric multigrid preconditioner (Galerkin coarse elements, Chebyshev smoother).
- LOBPCG eigen-solver with a fixed seed, so results repeat exactly.
- Free-sided prestress built by superposing unit-strain solves: 3 solves, or 6 when normal–shear coupling exceeds 1e-3.

**Validation.**
- Zero-energy count is exactly 3.
- Periodic plate benchmark vs the exact continuum answer: **1.0109 / 1.0075 at N=32** (within ~1 %).
- `runFEBucklingSelfTest(32)` → PASS on your machine.

**Measured at N=32:**

| Design | Buckling stress |
|---|---|
| Schwarz P | 5,952 MPa |
| P sheet | 363 MPa (507 at N=64) |
| Gyroid sheet | 403 MPa |
| Spinodoid | 128.5 MPa (xx) |
| Hyperuniform | 7.4 MPa (xx) / 36.8 MPa (zz) |

**UI changes.**
- Design cards carry a **governing-limit pill**: *Yield-limited* or *Buckling-limited*, with "est." or "not converged" when relevant and the axis in the tooltip.
- The ratio uses the crush axis.

**Your runs on v0.8.1:** spinodoid yields at 27.8 MPa along YY and buckles at 5.7× yield. PI gyroid buckles at 8.2× yield. Both are yield-limited.

### 2.3 Demo C and ratio (follow-up)

- Demo C was a placeholder. It is now **"Hyperuniform · trabecular"** (`demo-hu7c`, 5 mm cell). Old saved copies migrate automatically.
- The buckling/yield ratio uses the crush-axis buckling strength.

### 2.4 Plot redesign

- **Scale toggle.** MPa or normalized. Axes fit the curves, not the buckling lines.
- **Off-scale buckling values.** Shown as tags in a strip above the plot instead of stretching the axis.
- **Curves.**
  - Start at the origin.
  - Show the 0.2 % offset lines and yield dots.
  - Have the characteristic σ–ε shape.
- **Labels.**
  - Collision-aware placement; curves and buckling lines count as obstacles.
  - Hints and warnings (critical stress, "small at this scale", buckling-limited) moved to the legend.
- **Checked:** 9 scenarios, zero text–text and zero text–curve overlaps.

### 2.5 v0.8.1 — Nonlinear crush speed

**Root cause.** The mean strain was not reset before each solve. Newton then chased a drifting target, which caused both the slowness and the erratic "N=64 faster than N=32" behavior.

**Fixes.**
- Mean-strain reset.
- Inexact Newton (Eisenstat–Walker).
- Early-stop strikes.
- Field predictor between steps.
- GPU-resident CG: one readback per ≤16 iterations instead of 2 per iteration.
- Batched real-pair FFT and cached bind groups.

**Results.**

| Case | Before | After |
|---|---|---|
| Schwarz P N=16 — CG iterations | 9,300 | 175 |
| Schwarz P N=16 — GPU readbacks | 18,826 | 235 |
| Spinodoid N=32 — CG iterations | ~14,200 | 523 |
| Parity vs CPU reference | — | within 0.3 % |

Debug flags: `window.NL_FAST`, `NL_TRACE`, `NL_PREDICT`, `NL_EW`. Self-check: `runNonlinearFastOpTest()`.

### 2.6 v0.8.2 — PI-TPMS parity and connectivity

- **Finding.** The "fragments" in PI-TPMS were not a period problem. The PI and shell normalization flags were dropped on import, so the lab built un-normalized ribbons.
- **Import.** Normalization flags are kept when explicitly true or false. Older recipes without them default to **OFF** (your rule).
- **Kernels and viewer.**
  - Angle-corrected distance to the surface-intersection curve (|∇| floor 0.08, cosine clamp 0.95), matching F13LD.tpms.
  - Shell walls use |φ−c|/|∇φ|.
  - The raymarcher draws both.
- **Parity check.** Your gyroid recipe gives **ρ 9.84 %**, the same as your app at 48³. It was 8.9 %.
- **Connectivity selector** replaces the on/off island toggle:

  | Option | Meaning |
  |---|---|
  | All networks · remove islands | Default. Keep every network that spans the cell (the interwoven weave) and drop floating bits |
  | Largest network only | One side of the weave |
  | Keep everything | No pruning |

  - Two-network PI gyroid: ρ 2.45 % (all) vs 1.22 % (largest).
- **Buckling per network.** Interwoven networks are solved separately. Buckling strain is the weakest network's, and stiffness is the sum. Two-network example: 19.53 vs 9.77 MPa.
- **Held back (your call):** fundamental / double-period support for custom equations.

---

## 3. Your decisions this session

- Sprint A before anything else. Merge fast; the tool isn't marketed yet.
- Buckling uses **free-sided** loading.
- Grain periodicity: show it before deciding. The material is meant to stay directional.
- Material library: AM-producible alloys. **Approved.**
- Buckling must be massively faster at N=32/64, because nothing useful runs at N=16.
- Cards must show yield- vs buckling-limited.
- Plot: legible, no overlapping text, the characteristic σ–ε look.
- Hyperuniform can be wrapped.
- PI-TPMS: fix normalization; hold back the double period; the connectivity choice is interwoven vs single side; older recipes default normalization OFF.

---

## 4. Next steps (prioritized)

### Tier 1 — Speed and trust (next sprint)

1. **Buckling multigrid on grain designs (B2).**
   - **Problem:** TPMS converges in 27–45 prestress iterations, but spinodoid takes 1,184 and hyperuniform 1,865, with 140–190 eigen-iterations on hyperuniform.
   - **Plan:** try a stronger smoother or aggregation-based coarsening.
   - **Payoff:** the biggest single speed win on the designs you use most.
2. **Share the prestress across axes (B2).** Each axis worker repeats the same unit-strain solves. Compute them once and hand them out, for about a 3× cut in prestress time.
3. **Use idle cores and cap memory (B2).**
   - One axis per worker leaves most of the pool idle on a single design; split each axis across 2+ workers.
   - Cap concurrent N=64 tasks by device memory. A dense N=64 design needs about 0.5 GB per worker.
4. **Elastic solver: GPU-resident CG.** The nonlinear solver got this in v0.8.1; the elastic solver still does 2 GPU readbacks per iteration. Porting the same approach should give a similar jump.
5. **Real-GPU check of the new nonlinear safety paths.** The step-cutback and early-stop paths passed in simulation but haven't been hit on your hardware. Run a hard case (hyperuniform at N=64) with `NL_TRACE` on.
6. **FE-appropriate grid rule.** Replace the spectral-era PRONE/OK predictor pill with a rule that flags when N=32 and N=64 disagree by more than 10 %.

### Tier 2 — Physics and fidelity

7. **Grain RVE window.** F13LD.mesh builds spinodoid, GRF and noise as one continuous field across the part, not a repeating tile. Add a 2×2×2-cell window option for those families so the lab solves what is printed. The FE path makes this affordable.
8. **Fundamental / double-period support (held back).** Custom equations that repeat every 2 periods need a larger solve window. The same issue affects F13LD.tpms's own homogenization, which uses a one-period window.
9. **Partial-volume voxels.** Better elastic accuracy on thin walls.
10. **WebGPU voxel FE (B3).** Move buckling onto the GPU; the CPU path stays as the reference.

### Tier 3 — New capabilities

11. **Thermal conductivity solver.** A scalar subset of the elastic solver; currently a stub.
12. **Stokes permeability wire-in.** Needs a preconditioner; the current default under-reports by 2.7×.
13. **Plot marker synced to the strain scrubber.**
14. **Beyond small strain.** Finite strain, damage and densification, for plateau and energy-absorption curves. Long term.
15. **Roadmap phases 9–10.** PDF report export and F13LD.vault integration.

### Housekeeping (small, anytime)

16. Delete unused files from the web root: `16b2-elastic-batched-lc.js` (would overwrite the solver if ever loaded), `patch_16b_*.py`, `README.txt`, `mesh-ref.js`.
17. Seed the random test matrices in the old buckling E4 self-test (flaky).
18. Move shared kernels out of the dead `16-elastic-solver.js`.
19. Fix `validate-willot.js` (missing helper file; needs power-of-two grids).
20. Refresh `docs/NEXT_STEPS.md` (still says v0.8.0) and the phase docs to match this recap.

---

## 5. How to check things (browser console)

| Command | What it checks | Pass looks like |
|---|---|---|
| `runAxisConventionGPUTest()` | Axis convention | z comes out soft; each axis matches the CPU reference |
| `runFEBucklingSelfTest(32)` | Buckling correctness | 3 zero-energy modes; plate within ~1 % |
| `F13LD_buckleBench(recipe, 32)` | Any recipe through the real worker pool | Timings and buckling per axis |
| `runNonlinearFastOpTest()` | Fast nonlinear operator vs reference | Match within tolerance |
| `window.NL_TRACE = true` | Per-step nonlinear log | Newton and CG counts per step |
| `window.NL_FAST = false` | Falls back to the old nonlinear path | For A/B comparison |

---

## 6. Repo state

- **main = `df2fdb2` (v0.8.2)** — everything below is merged.
- Branches kept for reference: `sprint-a-v0.7.2`, `sprint-b-fe-buckling`, `plot-cleanup`, `nl-speed`, `pi-tpms-fixes`.

**History on main:**

| Commit | Change |
|---|---|
| `df2fdb2` | v0.8.2 — PI/shell normalization, viewer, connectivity selector, per-network buckling |
| `546f580` | v0.8.1 — nonlinear speed |
| `2cc656b`, `9aeeea6` | Plot redesign |
| `216686a` | Demo C swap and crush-axis ratio |
| `5542d57` | v0.8.0 — voxel-FE buckling and limit pill |
| `23a94a9` | Docs and FE prototype |
| `988c2c7` | Material library |
| `b55282e` | Hyperuniform wrap |
| `d88986b` | v0.7.2 — Sprint A |
| `c2e4fe7` | Session start (v0.7.1) |

**Main files added or changed:**

| File | Change |
|---|---|
| `16h-buckling-fe.js` | New: voxel-FE buckling |
| `15c-materials.js` | New: material library |
| `14a-connectivity.js` | Network detection and pruning modes |
| `16g-nonlinear-solver.js`, `16f-nonlinear-cpu-ref.js` | Nonlinear fixes and fast path |
| `16b-elastic-solver-full.js` | Axis fix |
| `16c` / `16d` / `16e` buckling files | Routed to FE and the worker pool |
| `21-raymarcher.js` | Texture ordering; normalized PI and shell rendering |
| `20-svg-mocks.js` | Plot |
| `40-design-grid.js` | Cards, limit pill |
| `50-controls.js` | Material picker, connectivity selector, cache keys, reliability |
| `60-add-design.js` | Import flags |
| `13-kernels.js` | Hyperuniform wrap, normalization parsing |
| `00-mock-data.js` | Demo C |
| `index.html`, `lab.css` | UI |
| `docs/` | `MATERIALS.md`, `SPRINT_B_PROPOSAL.md`, `BUCKLING.md` (superseded), `NEXT_STEPS.md` (stale) |
| `proto/fe-buckling/` | Prototype and benchmark logs |

---

## 7. Deliverables sent this session

- **Analysis and proposals:** `F13LD_lab_solver_analysis_2026-09-29.md`, `F13LD_lab_SprintA_proposal.md`, `F13LD_lab_SprintB_proposal.md`
- **Patch and packages:** `F13LD_lab_sprintA.patch`, `f13ld.lab-v0.7.2-full.zip`, `f13ld.lab-v0.7.2-changed-files.zip`
- **Materials:** `materials.md`, `materials.json`
- **Images:**
  - Periodicity: `spinodoid_variants.png`, `hyperuniform_variants.png`
  - Buckling: `buckling_wall_time.png`, `plate_benchmark.png`, `buckling_vs_yield.png`, `mode_slices_N64.png`
  - Plot: `plot_mpa.png`, `plot_normalized.png`
  - PI-TPMS: `pi_tpms_before_after.png`

---

## 8. Working conventions (carry forward)

- Proposed changes are presented for approval before code is written.
- The solver frame is the physical frame. Never reintroduce an axis swap in the solver.
- `index.html`, `50-controls.js`, `40-design-grid.js`, `21-raymarcher.js`, `16b-elastic-solver-full.js` and `README.md` use Windows line endings (`14a-connectivity.js` is mixed). Edit them without normalizing.
- Syntax-check every touched script. FFT grids are powers of two.
- Click-test on the branch preview before merging.
