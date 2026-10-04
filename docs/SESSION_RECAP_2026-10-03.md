# F13LD.lab — Session Recap

**Session:** 2026-10-02 → 2026-10-03
**Repos:** `github.com/mshomper/f13ld.lab` · `github.com/mshomper/f13ld.foam`
**Starting point:** lab `664242b` (code at **v0.13.0**; the foam calibration handoff doc had just landed) · foam **v0.3.0**
**Now live on main:** lab (**v0.17.2**) · foam `c80b382` (**v0.5.0**)
**Handoff:** [`NEXT_STEPS.md`](NEXT_STEPS.md) §1 (pick up here) and §1a (next dev cycle)

---

## 1. At a glance

| Version | What changed | Why it mattered |
|---|---|---|
| **lab v0.14.0** | F13LD.foam family in the lab, foam sweep parameters, 48-run calibration study | Foam needed a stiffness estimate fitted to the lab's own solver |
| **foam v0.4.0** | Open in F13LD.lab, live solid-fraction readout | One-click handoff foam → lab |
| **lab v0.15.0** | Fast elastic path for sweeps (`16i-elastic-fast.js`) | Foam runs took 2–4 min each; now ~16–30 s |
| **lab v0.15.1** | Second-grid export columns, foam fit page, first-pass foam laws | Fits run on Matt's machine, not the VM |
| **foam v0.5.0** | Calibrated stiffness estimate in F13LD.foam | Instant E, G, ν with a likely range, before any FFT run |
| **lab v0.16.0** | Three-axis crush; elastic CG cap 300 → 1000; void scaled to the design; sweep Standard cap 1000 | Card and crush stiffness disagreed; void and truncation were the causes |
| **lab v0.16.1–0.16.3** | Crush side-stress (lateral) loop rebuilt | Compliant designs read stiff after yield; one Z crush stalled |
| **lab v0.17.0** | Interactive Plotly stress–strain plot, scrubber linked to it | Matt wanted a far better plot |
| **lab v0.17.1** | Tighter crush solve when a design needs it; elastic setup shared across axes | Disordered compliant foams could not resolve side stress at the default tolerance |
| **lab v0.17.2** | Tight solve = tighter steps only, setup reused; cubes pause during runs | v0.17.1's tight setup took 85.5 s on Matt's GPU |

---

## 2. What was done, release by release

### 2.1 lab v0.14.0 — F13LD.foam in the lab
- `13d-foam-kernel.js`: a verbatim port of F13LD.mesh's foam field (FoamSeeds + buildFoamSDF are byte-identical across lab 13d, mesh m25 and the foam tool — `validate-foam.js` checks this). World = solver·5/π.
- Import by file, by `meta.tool === 'f13ld.foam'`, or by `#r=` inline link (`ingestHandoffJson`). Non-periodic foam is refused with an explanation.
- Sweep: foam thickness (exact by solid fraction), plateau k, organic, stretch x/y/z, seed count / regularity / Lloyd / random seed (seeds regenerated); `family = foam` CSV rows.
- Calibration study: [`FOAM_CALIBRATION.md`](FOAM_CALIBRATION.md), 48 runs in `docs/foam-calibration/foam_calibration_runs.csv`.

### 2.2 foam v0.4.0
- **⚗ Open in F13LD.lab** (recipe after `#r=`), live 48³ solid-fraction readout in the equation bar.

### 2.3 lab v0.15.0 — fast elastic path for sweeps
- `16i-elastic-fast.js`: GPU-resident CG (scalars stay on the GPU, one readback per block), packed batch-3 spectral operator (the nonlinear kernels), Γ built once per grid and cached, lean buffers. Same operator and stopping test as 16b.
- Sweeps (no field capture) take it automatically; `window.LAB_FAST_ELASTIC = false` turns it off. CSV records `solver` and `gamma_build_s`.
- **Matt's GPU, `runElasticFastTest(64)`: ALL PASS.** Schwarz P 1.35 → 0.40 s · spinodoid 51.8 → 8.9 s (not converged on either path) · beam BCC 2.03 → 0.59 s · foam 9.84 → 2.31 s. Foam calibration rows went from 2–4 min to ~16–30 s.

### 2.4 lab v0.15.1 + foam laws
- Export adds the second grid's own solid fraction (`grid2_vf_voxel_pct`, `grid2_vf_measured_pct`), its convergence and per-load-case iterations.
- `docs/foam-calibration/foam-fit.html` (self-contained; drop result CSVs in, get charts, a per-run table, fit JSON and Markdown) and `fit_foam.py` (same fit in Python).
- First-pass laws (FOAM_CALIBRATION §6): open E/Es = 0.724 ρ^1.93, ν = 0.433 − 0.468ρ; closed E/Es = 0.304ρ + 0.456ρ², ν = 0.294; G = E/2(1+ν); Poisson-seed factor 0.956 / 0.985; stretch exponent 2.49 / 1.63; shear split exponent 0.574 / 0.835. Resolution error E_h = E∞(1 − a·w^−p) with p ≈ 2 for both topologies; closed foams with 64³ walls under 2 voxels use 128³ plus a model correction.
- Plateau pass (19 runs, §7): plateau factor 1 + 0.118(1 − e^(−k/0.111)), read from paired 128³ runs (2t understates a Plateau-border strut).
- Cell-count pass (6 runs, §8): CSV delivered, **not run yet**.

### 2.5 foam v0.5.0 — stiffness estimate
- **Estimate stiffness** panel: ρ from the exact field point-sampled at 64³ in workers, laws above, likely range per axis (fit rms, seed scatter at this cell count, ±7 % cell-count band, extra width outside calibration with a "not calibrated" note — Kelvin / Weaire–Phelan, uniform-random seeds, organic > 0, normalize off, stretch > 2:1, density out of range). Exports a `homogenization` block with F13LD.tpms field names.

### 2.6 lab v0.16.0 — three-axis crush, iteration cap, void scaling
- **Crush axis = All (XX·YY·ZZ)**: per-axis results in `NONLIN_AXES[id] = { base, xx, yy, zz }`; `NONLIN_BY_DESIGN[id]` = governing (weakest-yield) axis. Cards: yield and Load Capacity from the weakest axis; buckling-to-yield = lowest per-axis ratio. Time estimate ×3.
- **Elastic CG cap 300 → 1000** for normal runs; card moduli say "not converged · N it" when a load case still hits it.
- **Void scaled to the design** (see §3.1): linear runs re-solve once with void = 1 % of the softest axis (floor 1e-6) when the design is under ~0.5 % of the solid; each crush uses 1 % of its linear modulus (cap 1e-3). "Void-limited" flags.
- **Sweep Standard preset 300 → 1000 iterations**, `cg_maxiter` column; `foam_rerun_1000_runs.csv` = the 27 calibration runs that hit 300.

### 2.7 lab v0.16.1 → v0.16.3 — crush side-stress loop
- v0.16.1: Broyden secant update of the lateral compliance (carried across steps), up to 8 corrections, cut back when lateral stress > 2 % of axial. Fixed pi-TPMS X/Y (curves now bend below the elastic slope after yield).
- v0.16.2: guards — elastic compliance restored on every cutback (fixed a Z crush trapped in five field divergences), best attempt kept, plus a per-correction size cap and overshoot rule.
- v0.16.3: the cap and overshoot rule stalled a compliant foam (~40 solves per step), so they were removed; the limit became max(2 %, 1.5 × the floor measured on step 1), one lateral retry per step, and a "post-yield approximate" flag above 5 %.

### 2.8 lab v0.17.0 — interactive stress–strain plot
- `20b-curve-plotly.js` on Plotly's basic bundle, vendored in `vendor/` (MIT, ~1 MB, lazy-loaded on the Nonlinear tab; SVG plot kept as fallback).
- Stress: MPa / log / ÷ own yield (auto ÷ own yield when strengths differ > 20×). Focus: X / Y / Z (also drives the cubes) / All. Legend chips hide designs or axes. Unified hover, zoom box that dims the cut-away area, range slider, PNG export at 3×, spline-smoothed curves, off-scale buckling tags above the plot.
- Scrubber = one strain timeline for every cube; amber cursor on the plot follows it; hover scrubs the cubes, click pins, Play resumes. KPI-style crush cards.
- Prototype first (sent as `stress-strain-prototype.html`); Matt: right direction, zoom highlight was backwards (fixed), link the scrubber, keep smoothing.

### 2.9 lab v0.17.1 — tighter solve when needed
- A crush whose step-1 side-stress floor is above 5 % stops and re-runs at `NL_TIGHT_NEWTON_TOL` = `NL_TIGHT_CG_TOL` = 1e-5; later axes of that design start tight.
- Crush void now from the design's softest axis, so all axes share one void and the elastic macro stiffness is computed once per design (`axStore._macro`).
- Messages say "side stress not resolved at the solver's tolerance".

### 2.10 lab v0.17.2 — cheaper tight solve (after the first GPU check of v0.17.1)
- Matt's GPU, foam X: floor 27.5 % → restart → tight setup **85.5 s**, floor 0.1 %. His follow-up test with only `NL_NEWTON_TOL = 1e-5`: setup 9.5 s, floor 0.3 %, crush 35 s.
- So the tight mode now tightens only the Newton tolerance, and the re-run reuses the first attempt's elastic setup. Expected foam All ≈ 2 min.
- Nonlinear-tab cubes pause while a run is solving (they were rendering every frame next to the solver; the normal setup took 19.7 s with the tab open vs 9.5 s without).

---

## 3. Findings (carry forward)

### 3.1 Linear vs crush stiffness — the void, not the grid
Gyroid × Fischer-Koch S pi-TPMS (E/Es ≈ 3e-4), same grid:

| Solve | Void (× Es) | E_z (MPa) | CG iters |
|---|---|---|---|
| Card (linear) | 1e-4 | 44.03 | 342 |
| Card | 1e-5 | 31.63 | 348 |
| Card | 1e-6 | 30.37 | 351 |
| Crush E0 | 1e-3 | 166 | — |
| Crush E0 | 1e-5 | 31.64 | — |

The void (empty space) was stiffer than, or comparable to, the structure. Rule now in the lab: void = 1 % of the design's own stiffness. Iteration counts barely change.

### 3.2 CG truncation in the foam calibration
The calibration ran on the sweep's Standard preset, then capped at 300 iterations per load case. **27 of 48 runs stopped at the cap**: every open and plateau foam at 18–35 % on both grids, closed 12–18 % at 64³ (their 128³ runs, which the fit uses, mostly converged), and the stretched set D. A stopped solve starts from uniform strain and reads stiff, so **the open law above 18 % may be high**. Re-run list: `docs/foam-calibration/foam_rerun_1000_runs.csv` (FOAM_CALIBRATION §10).

### 3.3 Crush side stress
- Modified Newton with the elastic lateral compliance fails after yield on compliant designs (pi-TPMS: 9–19 % lateral stress left on every post-yield step → curves above the elastic slope). The old stiff void had hidden this.
- The remaining floor is a **field-tolerance** effect, not f32: pi-TPMS and a 50-cell Poisson-disk foam at the same E/Es and relRes had floors of 0.4 % vs 23–28 %. Disordered foams keep drifting as the residual falls (seen earlier in the calibration CPU traces too).
- Foam, one axis: default tolerance → floor 23–28 %, ~8–16 s; **1e-5 → 0.0 %, setup 16.5 s + crush 37 s**; 1e-6 → 0.2 %, setup 62 s + 67 s (every CG solve at its 1000 cap).

### 3.4 Other
- Stopping on "stiffness settled" was tried and disproved (stiffness creeps with the residual on disordered foam).
- Plotly 2.35 throws when a `fillgradient` trace is drawn under a layout transition — the plot uses no transitions.
- Headless SwiftShader cannot run the crush pipeline (invalid compute pipeline); crush logic is tested with stubbed solvers, real crushes on Matt's RTX 4070 Ti Super.

---

## 4. Matt's decisions this session

- Foam handoff: proceed with the proposed defaults; Kelvin / Weaire–Phelan get a "Not calibrated" note; cell-count pass built with the wider range, fit later.
- Workflow: merge PRs when approved and test on main; **run analyses on his machine** (tools like the fit page), not long VM computations.
- Three-axis crush: all axes on **one plot**, plus an axis switch for the preview; elastic iteration cap 1000.
- Void: scale to the design (the four changes of v0.16.0).
- Crush side stress: keep the 2 % limit in the console; show "post-yield approximate" in the UI; tighter solve when needed (v0.17.1).
- Plot: Plotly-style direction approved; scrubber linked to the plot; keep the smoothing.

---

## 5. Not verified yet on the RTX machine

1. v0.17.2 foam three-axis crush (expect X: short probe, then tight with the setup reused; Y, Z start tight; no "post-yield approximate"; ~2 min total). v0.17.1's X axis was checked: floor 27.5 % → 0.1 % after the restart.
2. The Plotly plot with real runs (scales, focus, hover-scrub, zoom, PNG).
3. pi-TPMS three-axis crush after v0.16.3 / v0.17.1 (expected: floor 0.4 %, ~1.2 s per axis).
4. The 16f CPU oracle changes (Broyden / floor / one retry) — syntax-checked only; too slow on the VM.

---

## 6. Repo state

> **Update 2026-10-04:** lab main is v0.17.3 (`c509d4f`: v0.17.2 from this session, then F13LD.foam's exact field from a separate session); foam main is v0.6.0 (`d565cfa`); mesh main is v0.9.3 (`bc72aee`). The foam re-run plan moved to `FOAM_CALIBRATION.md` §11; current pick-up list: `NEXT_STEPS.md` §1.

- lab main = `6e35e85` (v0.17.1); PRs #1–#10 merged this session. Branches left on GitHub from this session: `foam-plateau-cellcount`, `v0.14.0-foam` … `v0.17.1-crush-tight` (all merged; safe to delete).
- foam main = `c80b382` (v0.5.0).
- New lab files: `13d-foam-kernel.js`, `16i-elastic-fast.js`, `20b-curve-plotly.js`, `validate-foam.js`, `vendor/plotly-basic-2.35.2.min.js` + `vendor/plotly-LICENSE.txt`, `docs/foam-calibration/*`, `docs/FOAM_CALIBRATION.md`.

## 7. Deliverables sent this session

`foam_calibration_runs.csv` · `foam_plateau_runs.csv` · `foam_cellcount_runs.csv` · `foam-fit.html` · `foam_rerun_1000_runs.csv` · `stress-strain-prototype.html` · this recap.

## 8. How to check things (browser console)

| Command | What it does |
|---|---|
| `await runElasticFastTest(64)` | Fast elastic path vs 16b on demo recipes |
| `NL_LATERAL_ACCEPT`, `NL_LATERAL_FLOOR_MULT`, `NL_LATERAL_RETRIES`, `NL_LATERAL_FLAG` | Crush side-stress limits (2 %, 1.5×, 1, 5 %) |
| `NL_TIGHT_NEWTON_TOL`, `NL_TIGHT_CG_TOL` | Tighter crush solve: Newton 1e-5; CG unchanged (`null`) since v0.17.2 |
| `NL_NEWTON_TOL = 3e-6` | Tighten every crush step for a test (reload to undo); avoid `NL_CG_TOL = 1e-6` — the elastic setup grinds at the CG cap |
| `for (const k in NONLIN_BY_DESIGN) delete NONLIN_BY_DESIGN[k]; for (const k in NONLIN_AXES) delete NONLIN_AXES[k];` | Clear cached crush results (they are keyed by grid, cap, void and design, not by solver settings) |
| `VOID_FLOOR`, `VOID_SCALE_FRAC` | Void rule (1e-6 floor, 1 % of the design) |
| `window.LAB_FAST_ELASTIC = false` | Sweeps back on the 16b path |
| `[crush-timing]` / `[crush]` console lines | Per-step macro corrections, cutbacks, the step-1 lateral floor, tight restarts |

## 9. Working conventions (carry forward)

- Analyze and present proposed changes for approval before writing code; don't over-deliberate; questions as a plain-language bullet list.
- Never use the words "genuine" / "genuinely".
- Bump the lab version on significant changes (header in `index.html`, console banner in `99-init.js`, README "What's new", NEXT_STEPS §0).
- Commits: `Co-Authored-By: Claude …` is fine; **no claude.ai session links** in commits, PRs or files.
- Line endings: patch with a line-ending-aware helper; never normalize. `40-design-grid.js` is CRLF, `50-controls.js` and `16b-elastic-solver-full.js` are mixed.
- Deliver files (Markdown, self-contained HTML) Matt can open on his machine.
