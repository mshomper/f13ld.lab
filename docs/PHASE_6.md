# Phase 6 — Nonlinear · J2 Plasticity + Geometric NL · CPU Oracle → GPU Solver → Run-All Integration → σ–ε Tab

**Status:** ✅ **complete** · v0.7.0 · solver + σ–ε comparison + Nonlinear α field tab + connectivity prune + plain-language readout pass — all live
**Duration:** multi-session nonlinear sprint (oracle bring-up → GPU port → convergence hardening → Run-All integration → adaptive crush + honest reporting + buckling context)
**Outcome:** Nonlinear crush is live. A from-scratch J2-plasticity + geometric-NL solver — a CPU reference oracle (`16f`) cross-validated against a GPU solver (`16g`) — runs in Run-All as its own physics stage, produces the effective uniaxial σ–ε response per design, and reports a real 0.2%-offset effective yield σ_y_eff. That number **retires the provisional 880 MPa Ti-64 seam** that Phase 5 used for `P_cr/P_y`: the asterisk now drops when a design genuinely yields. The σ–ε view tab renders real per-design curves with an auto-scaled plot, adaptive (knee-seeking) crush to a user strain cap, honest "no yield" reporting when a design stays elastic, and a σ_cr buckling cross-reference line that flags buckling-limited designs. The raymarcher-backed Nonlinear *field* tab (α-localization scrubber) is now **built** — the σ–ε tab was relabeled **Nonlinear** and pairs the merged plot with up to three α-colored crush cubes on a shared timed-then-manual scrubber. A closeout session also landed the run-complete-pill fix, a branded solver spinner, self-calibrating per-mode timing + live ETA, a periodic connectivity prune, and a full plain-language readout pass (see *Closeout session* below).

The Nonlinear tab is the seventh view tab; all of Geometry / Deformed / Stress / Stiffness ⊕ / Thermal / Buckling / Nonlinear are operational with real numbers and plain-language readouts.

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
- `index.html` — Nonlin pill (16³), Crush-ε cap pill, Crush-axis dropdown; **version bump v0.7.0**; solver spinner SVG, Nonlinear-tab containers, Prune-islands toggle
- `99-init.js` — boot banner v0.7.0 / Phase 6

### Closeout session — additional files touched
- `16f-` / `16g-nonlinear-solver.js` — per-accepted-step α capture (`captureAlpha`) for the progression scrubber
- `21-raymarcher.js` — `updateScalarField` (scalar-only R8 swap, no `u'` re-encode) for the α scrubber
- `14a-connectivity.js` — `pruneToLargestComponent` (periodic 6-connected keep-largest)
- `16b` / `16c` / `16e-buckling-cpu-worker.js` — connectivity-prune gate wired through each solve (worker imports `14a`)
- `00-mock-data.js` — slot-stable design identity (`reconcileDesignSlots`), adaptive unit formatters (`fmtEngMPa` / `fmtForceN`), Design A → teal-cyan
- `40-design-grid.js` — Nonlinear field tab (cubes + scrubber + per-design metric strip), plain-language metric blocks (3-axis modulus, Load Capacity, Crush Modulus), collapsible metrics drawer, lit baseline star, amber/red discipline
- `50-controls.js` — run-token + live-activity pill gate, solver spinner, self-calibrating per-mode timing + live ETA, skip-recompute signatures, `GEOM_STATE` prune flag
- `30-view-tabs.js` — Nonlinear-tab relabel/route
- `60-add-design.js` — slot-stable add path
- `22-stiffness-viz.js` — default zoom 1.6 → 0.8
- `lab.css` — spinner, Nonlinear-tab layout, metrics drawer, cyan section labels, baseline-star/state colors
- `README.md` — v0.7.0 / Phase 6 complete

---

## Known limits at end of Phase 6

- **CG is sync-bound.** The crush is the slow phase; a preconditioner (or GPU-resident CG) is the real speed fix, deferred to a follow-on.
- **Validated to ε = 2 %.** Caps of 5–10 % run past the validated envelope; truncations surface as `(partial)` / the salvage path, not silent failures.
- **Buckling seam is single-cell.** The periodic connectivity prune now removes the *floating-island* artifact, but σ_cr still over-softens **wrap-connected** clipped boundary struts under single-cell BCs — periodic/Bloch–Floquet buckling BCs are the real fix (a Buckling-phase follow-on, not a Phase 6 bug).

---

## Tie-up — what closed Phase 6 ✅

All five closing items landed in the closeout session:

1. **Nonlinear field tab (raymarcher).** ✅ The σ–ε tab was relabeled **Nonlinear** and now pairs the merged plot with up to three small α-colored crush cubes. α is captured per accepted step (`captureAlpha`), trilinearly upsampled from the 16³ crush grid to the elastic N, and ridden on the elastic `u'(x)` warp via a scalar-only `updateScalarField` (no `u'` re-encode per step). A **shared scrubber** auto-loops on entry, then latches to manual on first touch; per-design **ε_cr onset ticks** mark where buckling would pre-empt yield.
2. **F13LD spinner.** ✅ A branded hex/arc spinner with a pulsing neon core sits beside the solver pill, on from `startRun` and off on every exit path.
3. **Run-complete pill bug.** ✅ Root-caused and gated. The buckling worker-pool promise was verified to resolve only on true completion, so the durable fix is a **run token** + a **live `activeWorkers` flag**: `finishRun` no-ops on a stale, duplicate, early, or worker-busy call, and `cancelRun` bumps the token to invalidate any in-flight completion.
4. **Per-mode timing + estimates + ETA.** ✅ Each mode is timed and logged; `recomputeEstimate` now scales each mode by **its own grid** (and nonlinear by the crush cap), **self-calibrating** from measured wall-times persisted to `localStorage`; the bottom `progEta` is live (`est × remaining fraction`, m:ss).
5. **Per-step α capture.** ✅ Captured in `crushStress` straight from the committed history at each accepted step; deformation source is the elastic `u'(x)` scaled by the scrubber.

## Closeout session — also landed beyond the tie-up

Three correctness fixes and two readout/UX passes shipped alongside the tie-up:

- **Slot-stable design identity.** Letters/colors were keyed off array length at add-time, so clearing and re-adding produced duplicate letters (two "C"s, no "A"). `reconcileDesignSlots` now gives each design a slot 0/1/2 → A/B/C kept for life; the lowest free slot goes to the next add, so duplicates are impossible.
- **Skip unchanged recomputes.** Each mode stamps its result with a settings signature (elastic `N`; nonlinear `N·axis·cap`; buckling `N`; all including the prune flag) and skips when it matches — clear two of three, leave the third, and only the re-added ones solve.
- **Periodic connectivity prune.** `pruneToLargestComponent` (periodic 6-connected keep-largest) runs after `buildVoxels` in all three solvers, default-on via a **Prune islands** toggle. Removes the floating corner-satellite fragments that seeded spurious buckling/crush modes; ρ and every metric reflect the cleaned geometry.
- **Plain-language readout pass.** Equation-symbol labels became engineering terms — **Modulus X/Y/Z** (all three axes now surfaced, not just E₁₁), **Yield Strength**, **Buckling Strength**, **Buckling-to-Yield Ratio**, **Critical Load Factor**, **Thermal Conductivity**, **Relative Density**, and **Crush Modulus** (the crush E₀, labeled distinctly from the linear moduli). New **Load Capacity** = governing strength × cell footprint (per cell, N/kN). Units are **adaptive** (GPa ≥ 1 GPa, MPa below; N/kN) via `fmtEngMPa` / `fmtForceN`.
- **Small-screen UX.** Metrics moved into a **collapsible drawer** (open on wide screens, collapsed below 880 px, teaser = Load Capacity or Modulus Z) with a viewport `min-height` floor so the raymarcher is never crushed; the **baseline star lights amber**; status descriptors are **amber** (red/green reserved for comparison deltas and completion); section labels went **cyan** (Design A moved to teal-cyan); the stiffness surface default zoom dropped 1.6 → 0.8.

## Cross-phase follow-on (not Phase 6 work)

- **Periodic / Bloch–Floquet buckling BCs** so the eigensolve stops over-softening wrap-connected clipped boundary struts (e.g. hyperuniform ρ=0.50, σ_cr 11.7 vs σ_y 94.2). Buckling-phase scope.
- **CG preconditioner / GPU-resident CG** for crush speed.

## Handoff state

**Phase 6 is complete (v0.7.0).** The nonlinear solver is validated and integrated; `P_cr/P_y` is real for yielding designs and an honest bound otherwise; the Nonlinear tab tells the material *and* the buckling story on one set of axes and animates the α field; the run pipeline is gated, timed, calibrated, and skips unchanged work; geometry is pruned to its largest connected component before solving; and every readout is plain-language with adaptive units behind a small-screen-friendly drawer. The validated solver core was untouched by the closeout. Next up: **Phase 8** (thermal κ tensor + remaining view modes); the periodic-buckling-BC and CG-preconditioner items remain queued cross-phase follow-ons.
