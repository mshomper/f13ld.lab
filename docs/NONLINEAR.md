# Nonlinear Crush (J2 Plasticity + Geometric NL) in F13LD.lab

The specifics, the math, and — mostly — the lessons. This is the topic deep-dive that sits behind [`PHASE_6.md`](./PHASE_6.md); read that for the phase narrative and the tie-up list.

## What it answers

Linear elastic gives you stiffness. Buckling gives you elastic stability. Neither tells you the **effective yield** of the architected material — the macroscopic stress at which the underlying solid starts to plastically flow inside the cell. The nonlinear crush answers:

- *What is the effective uniaxial σ–ε response of this cell?*
- *What is the 0.2 %-offset effective yield σ_y_eff?*

That σ_y_eff is the number that **retires the provisional 880 MPa seam** in `P_cr/P_y`. Before Phase 6, buckling divided the real critical stress by solid-Ti yield (a placeholder). Now it divides by the design's own yield — when the design actually yields in the crushed range.

## Formulation

- **J2 (von Mises) small-strain plasticity** with a radial return map, per voxel of solid material; the void phase carries a small stiffness contrast.
- **Voce + linear hardening:** flow stress `σ_Y(α) = σ_Y0 + (σ_sat − σ_Y0)(1 − e^(−δα)) + H_lin·α`, with α the equivalent plastic strain.
- **Uniaxial-stress macro loop.** The crush prescribes strain on one normal axis and solves the free lateral strains so their macro stress is ~0 (traction-free lateral faces). This is an outer Newton on the free Voigt components, wrapping the inner field Newton (the plastic equilibrium solve over the cell).
- **0.2 %-offset yield.** σ_y_eff is the stress where the curve crosses a line of slope E0 offset by 0.2 % strain. If the curve never crosses it (still elastic at the cap), there is *no* yield in range — and we say so, rather than returning the endpoint.

### Material defaults (Ti-6Al-4V, LPBF)

`Es = 110000 MPa`, `nu = 0.34`; Voce `σ_Y0 = 950`, `σ_sat = 1150`, `δ = 60`, `H_lin = 300 MPa`. Void contrast `1e-3`.

### Why uniaxial-stress, one normal axis

Compression-loaded scaffolds yield under uniaxial stress with free lateral faces — that is the physiological load case for orthopedic lattices. Shear-yield is not the governing path and isn't run. The physical axis maps to the solver frame via `SWAP = [2,1,0,5,4,3]` (so `crush(2)` = physical ZZ).

**Three axes (v0.16.0).** Crush axis = All runs `crush(0)`, `crush(1)`, `crush(2)` in turn — three independent uniaxial crushes, one per normal axis. Results are kept per axis in `NONLIN_AXES[id] = { base, xx, yy, zz }` (`base` = grid | cap | prune | recipe; a different base clears the set). `NONLIN_BY_DESIGN[id]` is the governing axis (lowest 0.2%-offset yield; if no axis yielded, lowest stress at the cap), which the cards, Load Capacity and the buckling seam read. With several axes the buckling-to-yield ratio is min over axes of (that axis's buckling strength / that axis's yield).

## Solver — `16f-nonlinear-cpu-ref.js` (oracle), `16g-nonlinear-solver.js` (GPU)

`16f` is the plain-CPU reference: `nlMakeMaterial`, `nlFlowStress`, `nlReturnMap`, `nlBuildTangent`, `nlNewtonSolveCPU`, `nonlinearCrushCPU` (driver), `nlMacroStressStep` (the uniaxial-stress macro-Newton), and `nlOffsetYield` / `nlOffsetYieldEx`.

`16g` is `new NonlinearSolverFull(N, fft)` **composing** an `ElasticSolverFull` (`16b`): it reuses the FFT plan, the Γ operator, and the CG path, and adds the J2 update (WGSL), the inner Newton, and the macro-stress outer loop. It is validated against `16f` on E0 and σ_y_eff (Schwarz P, N=8: E0 rel 6e-7, σ_y rel 1.06e-3).

## The hard part — lessons learned

This is the section worth keeping. The crush works now; getting there cost most of the session. Do **not** re-walk these dead ends.

### 1. Lateral-strain seeding is the whole ballgame (the hybrid)
The macro-stress loop has to guess the free lateral strains each load step. Two obvious choices both fail:
- **Pure elastic predictor** (seed laterals from the elastic compliance) blows up in **deep plasticity** — the incompressible plastic lateral response is nothing like the elastic one, the field Newton diverges (relRes → ~0.8).
- **Pure warm-start** (reuse last step's converged laterals) blows up **cold at N≥16** — the first confined→free jump diverges the f32 field Newton (relRes → ~10.5).

**Shipped solution — hybrid:** elastic predictor on step 1 (cold), then **linear extrapolation** of the previous converged laterals (`ebFreePrev × trial/eAxisPrev`) on every step after. Physical in deep plasticity, gentle when cold. This is the single most important line in the solver.

### 2. Tolerances are coupled, not independent
- **Void contrast `1e-3`** (not `1e-4`). Raising it costs ~+2 % modulus but cuts CG iterations ~5× (1283 → 242 at N=8). A measured, approved trade.
- **CG tol must be ~10× tighter than the Newton tol** (`1e-4` vs `1e-3`). Loosening CG to `1e-3` broke Newton convergence outright.
- **Macro nesting caps:** `macroMax = 4`, `macroTol = 5e-3`. Cut back **only** on field-Newton divergence; a macro-tolerance miss is benign (lateral stress is already small, f32 floor keeps it above a tight relative tol). Newton accepts an f32-floor stall at `5e-3`.
- **Lowering the reference C0 makes CG worse**, not better — a stiff C0 is best. (Measured; counterintuitive.)

### 3. The CG is sync-bound
Each CG dot-product forces a CPU↔GPU round-trip, so GPU utilization sits around ~20 %. The crush is the slow phase because of these syncs, not the arithmetic. The real fix is a **preconditioner** (or a GPU-resident CG) — deferred. Until then, the strain cap is what bounds wall-time.

### 4. Adaptive crush beats a fixed target
A fixed 2 % target is fine for dense designs and **clips compliant ones**. Yield strain is `ε_y = σ_y_eff / E_eff`; both scale with relative density but at different rates, so for the low-VF, bending-dominated regime these shells occupy, **lower density pushes ε_y up**. A ρ=0.14 gyroid shell (E_eff ≈ 0.24 GPa) yields north of ~2 %, so a 2 % crush draws a straight elastic line and never finds the knee. The crush now steps to a **detected knee (+3 steps)** or to a **user cap** (2/5/10 %, default 5 %), so it captures yield where it exists and stops early where it does.

### 5. Honest reporting — don't fabricate σ_y
`nlOffsetYield` returned the **last curve point** when the offset line was never crossed — i.e., it reported the endpoint stress as if it were yield, for a design that never yielded. `nlOffsetYieldEx` returns `{sigma, yielded}`; the UI reads the flag. No yield in range → `no yield (> σ_cap)` and the seam reverts to a σ_cap-based **bound**, not a confident wrong number.

### 6. Resolution: N=8 is too coarse for shellular
At N=8 a sheet-TPMS wall is 1–2 voxels thick and the discretization can't bend it, so it reads ~2× too stiff (coarse-mesh stiffening). Measured on the gyroid shell: nonlinear E0 ≈ 0.44 GPa at N=8 vs ≈ 0.24 GPa at N=16, the latter matching the elastic E11 (0.22 GPa). **N=16 is the floor for sheet-TPMS** and is the Nonlin pill default. Note this also under-resolves wall-junction stress concentrations, so local *first*-yield can be later than reality — moot when buckling governs, relevant for yield-limited designs.

### 7. The crush does not see buckling — and for buckling-limited designs that matters
The homogenized J2 continuum keeps climbing elastically/plastically; it has no bifurcation. For a **buckling-limited** design (σ_cr < yield), everything on the σ–ε curve past ε_cr is **fictional** — the cell has already collapsed. The tab handles this by drawing the σ_cr line, banner-flagging "collapses at σ_cr before yield," and — when there's no material yield in range — reporting `P_cr/P_y < σ_cr/σ_cap` (an honest upper bound), since σ_cap is a hard lower bound on the true yield.

### 8. Single-cell buckling over-softens clipped features (cross-reference)
Not a crush bug, but it shows up next to crush results: an isolated unit cell makes boundary-clipped struts (e.g. a hyperuniform kernel field) read as cantilevers, buckling at an artificially low σ_cr (ρ=0.50 hyperuniform: σ_cr 11.7 MPa vs σ_y 94.2 MPa, `P_cr/P_y` 0.12 — too soft for a dense solid). The fix is periodic/Bloch–Floquet buckling BCs; tracked in the buckling phase.

### 9. A validation pitfall to remember
An early "curve FAIL" in `runNonlinearStressTest` was a **test artifact** — it compared GPU and CPU curves index-by-index after a cutback left them on different ε grids. The fix was to interpolate both onto a common ε grid before comparing. The solver was correct; the test was wrong. The metrics that matter (E0, σ_y_eff) always agreed.

## Reading the output — what to trust

- **A real knee** (offset-yield dot sitting *on* the curve, not at the corner) → σ_y_eff is real; `yielded = true`.
- **A straight line to the cap** with the dot at the corner used to mean a fabricated σ_y; now it reads `no yield (> σ_cap)` instead.
- **The σ_cr dashed line** below the curve → buckling governs; the curve above ε_cr is informational, not the failure path.
- **`P_cr/P_y` with no `*`** → backed by a real yield. **`< x*`** → a bound (no yield in range), still provisional.

## Limits

- Uniaxial-stress normal axes only; ε ≤ 2 % validated (5–10 % caps run past it, with truncation surfaced).
- Sync-bound CG (no preconditioner yet).
- Single-cell BCs for the buckling cross-reference (periodic BCs pending).
- N=16 floor for shellular; coarse grids under-resolve stress concentrations.

## File map

| File | Role |
|---|---|
| `16f-nonlinear-cpu-ref.js` | CPU oracle — J2 + geom, macro-stress Newton, `nlOffsetYieldEx` |
| `16g-nonlinear-solver.js` | GPU solver composing `16b`; adaptive crush; `onStep`; `readAlphaField` |
| `16b-elastic-solver-full.js` | Reused FFT / Γ / CG substrate |
| `50-controls.js` | Run-All Nonlinear phase, seam swap, pills, per-step progress |
| `40-design-grid.js` | σ_y(z) metric, `P_cr/P_y` bound display |
| `20-svg-mocks.js` | `buildMergedCurvePlot` — real σ–ε curves + σ_cr line + banner |
