# Phase 6 — Nonlinear · J2 Plasticity + Geometric NL · CPU Oracle → GPU Solver → Run-All Integration → σ–ε Tab

**Status:** in progress · v0.6.0 · solver + σ–ε comparison live · Nonlinear field tab queued
**Duration:** multi-session nonlinear sprint (oracle bring-up → GPU port → convergence hardening → Run-All integration → adaptive crush + honest reporting + buckling context)
**Outcome:** Nonlinear crush is live. A from-scratch J2-plasticity + geometric-NL solver — a CPU reference oracle (`16f`) cross-validated against a GPU solver (`16g`) — runs in Run-All as its own physics stage, produces the effective uniaxial σ–ε response per design, and reports a real 0.2%-offset effective yield σ_y_eff. That number **retires the provisional 880 MPa Ti-64 seam** that Phase 5 used for `P_cr/P_y`: the asterisk now drops when a design genuinely yields. The σ–ε view tab renders real per-design curves with an auto-scaled plot, adaptive (knee-seeking) crush to a user strain cap, honest "no yield" reporting when a design stays elastic, and a σ_cr buckling cross-reference line that flags buckling-limited designs. The raymarcher-backed Nonlinear *field* tab (α-localization scrubber) is scoped and queued.

The σ–ε curve tab is the seventh view tab; all of Geometry / Deformed / Stress / Stiffness ⊕ / Buckling / σ–ε are operational with real numbers.

---

## Objective

Phase 5 shipped buckling with a deliberately **provisional** strength ratio — `P_cr/P_y` divided the real critical stress by a fixed solid-Ti yield (`SIGMA_Y_TI64_MPA = 880`), flagged with a `*`. Phase 6's mandate:

1. **Write the nonlinear crush as a CPU oracle first** (`16f`), exact and slow, before the GPU solver — same de-risking discipline as the Phase 5 buckling oracle.
2. **Port to GPU** (`16g`) by *composing* the existing full-Voigt elastic solver (`16b`) rather than duplicating the FFT/Γ/CG machinery.
3. **Supply a real per-design σ_y_eff** so the buckling seam stops being provisional.
4. **Render the σ–ε comparison** in the existing curve tab, replacing the mock.
5. **Make the result honest** — adaptive crush so compliant low-density designs actually reach yield, and explicit "no yield" reporting when they don't, rather than fabricating a number.

### Scope boundaries set up front

- **Uniaxial-stress crush, one normal axis at a time** (xx/yy/zz). The lateral faces are traction-free (the free lateral strains are solved by an outer macro-Newton). Shear crush is not run.
- **Small-strain J2 with a geometric-NL framing**; the validated envelope is ε ≤ 2 %. Higher caps (5–10 %) are exposed but run past the validated range — truncation is surfaced, not hidden.
- **σ_y_eff is the 0.2 %-offset effective yield** of the homogenized continuum. It models *material* plasticity; it does **not** see unit-cell buckling (that is the separate Phase 5 eigenproblem). For buckling-limited designs the crush curve past ε_cr is fictional, and the tab says so.
- **CPU oracle is the source of truth; GPU is the production path.** No preconditioner yet — the CG is sync-bound (see NONLINEAR.md).
- **Field viz deferred.** α is read back, but the raymarcher Nonlinear tab is queued, not built.

---

## TL;DR — what landed

| Area | Title | Outcome |
|---|---|---|
| Solver | J2 + geom CPU oracle (`16f`) | Validated; Schwarz P at N=8: σ_y_eff = 214.3 MPa, E0 = 31.28 GPa, smooth 39→250 MPa curve |
| Solver | GPU solver (`16g`) composing `16b` | Cross-check vs `16f` at N=8: E0 rel 6e-7, σ_y rel 1.06e-3 (214.4 vs 214.6) — PASS |
| Solver | Adaptive crush + user strain cap | Knee-seeking: steps to a detected 0.2 %-offset crossing (+3 steps) or to the cap; avoids grinding long elastic runs |
| Solver | Honest no-yield reporting (`nlOffsetYieldEx`) | Distinguishes a real knee from the no-crossing fallback; no more endpoint-as-σ_y |
| Integration | Run-All Phase 2 Nonlinear (`50`) | Per-design crush → `NONLIN_BY_DESIGN`; order Elastic → **Nonlinear** → Buckling so buckling consumes real σ_y |
| Integration | Seam swap (`50`, `40`) | `P_cr/P_y` uses real σ_y_eff; `*` drops when yielded; reverts to a σ_cap-based **bound** (`< x`) when not |
| UI | σ–ε comparison plot (`20`) | Real auto-scaled curves, offset-yield dot (only when real), σ_cr dashed line + "buckling-limited" banner |
| UI | Controls | Nonlin grid pill (default **16³**), Crush-ε cap pill (2/5/10 %, default **5 %**), Crush-axis dropdown (ZZ default) |
| UX | Per-step progress (`16g`/`50`) | `onStep` hook ticks the bar + status each accepted crush step — the long phase no longer looks hung |

---

## Architecture decisions

### CPU oracle before GPU
`16f` is the reference: J2 return mapping, Voce hardening, the outer uniaxial-stress macro-Newton, and the 0.2 %-offset extraction, all in plain CPU JS. `16g` is validated against it on the metrics that matter (E0, σ_y_eff) before being trusted. The full debugging arc lives in [`NONLINEAR.md`](./NONLINEAR.md).

### Compose, don't duplicate
`16g` is `new NonlinearSolverFull(N, fft)` wrapping an `ElasticSolverFull` (`16b`): it reuses the FFT plan, the Green's-operator (Γ) buffers, and the CG path. The nonlinear layer adds the J2 material update (WGSL), the Newton loop, and the macro-stress outer loop on top.

### Stress control with hybrid lateral seeding
The crush is uniaxial-*stress*: the loaded axis strain is prescribed, the free lateral strains are solved so their macro stress is ~0. Seeding those lateral strains correctly was the hard part — a pure elastic predictor blows up in deep plasticity, a pure warm-start blows up cold at N≥16. The shipped solution is a hybrid (elastic predictor on step 1, linear extrapolation thereafter). Details in NONLINEAR.md.

### Adaptive crush + user cap, not a fixed target
A fixed 2 % target catches dense designs but clips compliant ones (their yield strain is higher — see NONLINEAR.md). The crush now steps to either a detected knee (+3 steps to draw past it) or a user-set cap (2/5/10 %), so it captures yield where it exists and stops early when it does — bounding solve time without missing the knee.

### Honest reporting over a fabricated number
`nlOffsetYield` returned the *endpoint* stress when the curve never crossed the 0.2 %-offset line — a fabricated σ_y for elastic-only crushes. `nlOffsetYieldEx` now returns `{sigma, yielded}`; the UI shows `no yield (> σ_cap)` and the seam reverts to a σ_cap-based bound rather than a confident wrong value.

### Pipeline order: Elastic → Nonlinear → Buckling
Nonlinear runs before buckling so the buckling `.then()` can divide `p_cr` by the design's real σ_y_eff in the same run. No yield → the ratio falls back to a σ_cap bound and stays flagged.

---

## Solver — `16f-nonlinear-cpu-ref.js`, `16g-nonlinear-solver.js`

Public contract (GPU):

```
var s = new NonlinearSolverFull(N, fft);      // composes ElasticSolverFull (16b)
s.upload(recipe);
var out = await s.crush(physicalAxis,         // 0=xx, 1=yy, 2=zz  (SWAP=[2,1,0,5,4,3])
  { control: 'stress', nSteps: 16, epsTarget: cap, onStep: cb });
// out = { curve:[{eps,sigma}], sigma_y_eff, yielded, E0, rho, N, epsCap, eAxisMax, truncated? }
var alpha = await s.readAlphaField();          // Float32Array(N³), equivalent plastic strain α
s.destroy();
```

Material defaults (Ti-6Al-4V LPBF): `Es = 110000 MPa`, `nu = 0.34`, Voce `sigY0 = 950`, `sigSat = 1150`, `delta = 60`, `Hlin = 300`. Void contrast `1e-3` (a deliberate +2 % modulus for ~5× faster CG — see NONLINEAR.md).

Math, tolerances, seeding, and the full debugging history: [`NONLINEAR.md`](./NONLINEAR.md).

## Run-All integration — `50-controls.js`

- `NONLIN_STATE = { N: 16, axis: 'zz', cap: 0.05 }`; `NONLIN_BY_DESIGN` (transient, kept out of `localStorage`).
- **Phase 2 · Nonlinear crush** loops designs over the shared FFT (`window.__sharedFFT`), runs `crush(axis, {control:'stress', epsTarget: cap, onStep})`, and stores `{ sigma_y_eff, yielded, E0, curve, axis, N, epsCap, sigmaCap, truncated }`.
- **Seam swap** in the Phase 3 buckling `.then()`: `sigY = yielded ? sigma_y_eff : (sigmaCap ?? 880)`; sets `provisional = !yielded` and `yieldBound = (!yielded && sigmaCap)` so the display can render `< x*`.
- Pills/handlers: `onNonlinPillClick` (8⇄16), `onNonlinCapPillClick` (2→5→10 %), `onNonlinAxisChange`.
- `onStep` callback bumps the progress bar fractionally and updates the status line per accepted step.

## σ–ε tab — `20-svg-mocks.js` (`buildMergedCurvePlot`)

Real per-design curves from `NONLIN_BY_DESIGN`, auto-scaled axes (nice-rounded ε% and σ caps, σ_cr included so the buckling line is always on-canvas). Offset-yield dot drawn **only** when `yielded`. A dashed σ_cr line per design (from `BUCKLE_BY_DESIGN.pcr`) plus a `⚠ buckling-limited — collapses at σ_cr before yield` banner when σ_cr sits below yield. Empty state nudges the user to enable Nonlinear.

## Metric / display — `40-design-grid.js`

`σ_y (z)` shows the real value, or `> σ_cap MPa · no yield · ≤ cap% ε` when elastic. `P_cr/P_y` shows the real ratio, or `< x*` (the honest upper bound, σ_cr / σ_cap) for no-yield / buckling-limited designs — replacing the meaningless `0.00` that dividing by 880 produced.

---

## Validation status at end of this session

| Case | Result | Reading |
|---|---|---|
| Schwarz P · N=8 (oracle `16f`) | σ_y_eff 214.3 MPa · E0 31.28 GPa · smooth knee | reference |
| Schwarz P · GPU `16g` vs `16f` (N=8) | E0 rel 6e-7 · σ_y rel 1.06e-3 | PASS on the metrics that matter |
| Schwarz P · GPU N=16 | σ_y_eff 219.9 MPa · E0 ≈ 32.6 GPa | N-refinement + void-1e-3 vs the N=8 oracle |
| Gyroid shell · ρ=0.14 · N=16 | E11 0.22 GPa · **no yield ≤ 10 %** · σ_cr 1.6 MPa | correctly buckling-limited; honest "no yield (> 24 MPa)" |
| Hyperuniform · ρ=0.50 · N=16 | E11 6.22 GPa · **σ_y 94.2 MPa (real knee)** · σ_cr 11.7 · P_cr/P_y 0.12 | full chain confirmed on a yielding design |

Key lessons surfaced by these cases (full treatment in NONLINEAR.md): **N=8 coarse-mesh stiffening** roughly doubles E0 for thin shellular walls (N=16 is the floor for sheet-TPMS); **yield strain scales with relative density**, so compliant low-VF designs need a higher crush cap to reach the knee; and **single-cell buckling over-softens** clipped boundary features (the hyperuniform σ_cr 11.7 vs σ_y 94.2 is a cantilever artifact — periodic/Bloch BCs are the fix).

## File inventory at end of this session

### New files
- `16f-nonlinear-cpu-ref.js` — CPU oracle (J2 + geom, macro-stress Newton, 0.2 %-offset, `nlOffsetYieldEx`)
- `16g-nonlinear-solver.js` — GPU solver composing `16b`; adaptive crush; `onStep`; `readAlphaField`
- `docs/PHASE_6.md`, `docs/NONLINEAR.md`

### Modified files
- `50-controls.js` — Nonlinear phase, seam swap, Nonlin/cap pills + axis dropdown, per-step progress, σ_cap capture
- `40-design-grid.js` — real σ_y(z) metric, P_cr/P_y bound display
- `20-svg-mocks.js` — `buildMergedCurvePlot` real curves + σ_cr line + buckling banner
- `index.html` — Nonlin pill (16³), Crush-ε cap pill, Crush-axis dropdown; **version bump v0.6.0**
- `99-init.js` — boot banner v0.6.0 / Phase 6

---

## Known limits at end of this session

- **No field viz yet.** α is read back but not shown; the Nonlinear raymarcher tab is queued.
- **CG is sync-bound.** The crush is the slow phase; a preconditioner (or GPU-resident CG) is the real speed fix, deferred.
- **Validated to ε = 2 %.** Caps of 5–10 % run past the validated envelope; truncations surface as `(partial)` / the salvage path, not silent failures.
- **Buckling seam is single-cell.** σ_cr (and therefore `P_cr/P_y`) over-softens clipped boundary features — a cross-phase method limit, not a Phase 6 bug.
- **Run-time estimate is wrong.** `recomputeEstimate` scales every mode by the elastic grid pill; buckling/nonlinear run at their own grids, so the headline number under-reports badly.

---

## Tie-up — what closes Phase 6

Phase 6 is "solver + σ–ε comparison live." To call it **complete**:

1. **Nonlinear field tab (raymarcher).** New view that colors the α (plastic-strain) field — turbo — on the crush deformation, with a **strain scrubber** and an **ε_cr onset tick**, reusing the buckle-tile render path (`uploadFields` with α as the scalar + `setBuckleMap(true)`; deformation from the elastic `u_prime`). Wrinkles: α is at the 16³ crush grid vs 32³ deformation grid (upsample needed), and the scrubber→deform-amplitude mapping. Validate on a yield-limited design (the α field is ~zero on buckling-limited ones).
2. **F13LD spinner.** A branded "still working" indicator by the solving pill (the F13LD wave/hex mark, arcs sweeping, neon core pulsing). Fold into the field-tab pass.
3. **Run-complete pill bug.** The pill can read "run complete" mid-run on tab switch. Traced: `finishRun` is the sole writer at the true pipeline end, so it is being *reached* early — most likely the buckling worker-pool promise resolving before workers finish. Fix the buckling promise resolution and/or gate the pill on a live activity flag.
4. **Per-mode timing + estimates + ETA.** Log real wall-time per physics mode and surface it; rebuild `recomputeEstimate` to scale each mode by its own grid (and nonlinear by the crush cap), ideally calibrated by the logged actuals; wire the inert bottom `progEta`.
5. **Deformed-shape α + per-step capture.** Capture α per accepted step for a true progression scrubber (the `onStep` hook is already the place to do it), and resolve the deformation source (reuse elastic `u_prime` scaled, exact while elastic).

## Cross-phase follow-on (not Phase 6 work)

- **Periodic / Bloch–Floquet buckling BCs** so the buckling eigensolve stops over-softening clipped boundary struts. This is the right fix for the suspicious low σ_cr on isolated cells (e.g. hyperuniform ρ=0.50, σ_cr 11.7 vs σ_y 94.2). Buckling-phase scope.
- **CG preconditioner / GPU-resident CG** for the crush speed.

## Handoff state

The nonlinear solver is validated and integrated; `P_cr/P_y` is real for yielding designs and an honest bound otherwise; the σ–ε tab tells the material *and* the buckling story on one set of axes. The remaining Phase 6 work is the field-tab UX layer (raymarcher α scrubber + spinner), the run-complete pill fix, and the timing/estimate cluster — none of which touch the validated solver core.
