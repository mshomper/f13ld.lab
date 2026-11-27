# F13LD.lab UI refresh: independent verification

Branch `ui-refresh` at 5b3508d, baseline origin/main 52174e1. Verifier did not build it. Headless Chrome on the real GPU (D3D11, no SwiftShader), one browser at a time, http. Scripts: scratchpad `lab-verify2-*.js`. Screenshots: `docs/ui-audit/verify-*.png`.

Verdict: **READY**, with one small layout fix recommended (row 6) and two cosmetic clips noted below.

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | 0 page errors at 390 / 1024 / 1440 (Model, Physics all folds open, 7 VIEW tabs, phone Results, menu, Sweep, Atlas after a 2-run sweep, Import) | PASS | Also 700. Import run with `box50.stl` (mesh fixture, cell size set to 50 mm, Build): preview drew. |
| 2 | No horizontal scroll at 390 / 700 / 1024 / 1440 | PASS | Document, body and viewer 0. At 390 / 700 `#ctrlPane` scrollWidth is 16 px over its box, from the kit's glow canvases (`.lq-canvas`); `#ctrlScroll` is `overflow:hidden`, so nothing scrolls. |
| 3 | One section at a time; rail and tab bar in sync | PASS | One `.sec` visible each time; `F13UI.active`, rail and tab bar agree; resizes 1024 / 700 to 390 and back keep one section. |
| 4 | No visible native control the map replaces; widget to app and app to widget | PASS | 0 visible natives on Model, Physics, 7 tabs, Sweep. Segmented (grid), toggle (buckling), dropdown (material), slider (curvature range, by keys) both ways at 1440 and 390; card axis segmented after 3 card rebuilds both ways; 9 card widgets before and after rebuilds. |
| 5 | Help "show" on about 15 cards | PASS | 26 cards at 1440 and 390: every one lands or notes except `fmu` (see notes). Section switch and fold open work (Flow, Readout). |
| 6 | OVERLAP: 0 stolen taps at 390 peek, 390 full, 1440 | FAIL (minor) | 1440: 0. 390 full: 0. 390 peek: 0 on Model / Physics / Results and 6 of 7 tabs; **Flow tab: 1** (see defects). |
| 7 | Render | PASS | Idle 1 s after a grab: 0 rAF, 0 draws (ungrabbed Shaded spins at 31 fps by design). Elastic 32^3 solve (4.1 s): 2 tile draws. 0 compiles over a 30-step orbit and 30 curvature-range steps. Context loss: redrawn in 285 ms, `getError` 0, idle 0 / 0 after. Atlas (cell geometry + directional modulus) and Import previews draw. |
| 8 | Results clearing | PASS | Elastic 32^3, grid to 64: chip "settings changed · Run", 21 stale rows, Export PDF and Mesh disabled, Stress tile "Run to update". Back to 32: restored, same result objects, re-run 8 ms. Buckling at 16^3 solved (2.3 s): grid 32 hides it (9 stale), back to 16 shows it. Thermal and Flow not solved. |
| 9 | One progress bar with Cancel / Stop | PASS | Run all (1440): 1 busy bar, Cancel shown, no progress row or chip bar in 13 samples. Run sweep at 1440 / 1024 / 390: 1 bar, Stop shown, native Run hidden. |
| 10 | No-WebGL fallback | PASS | 13 of 13 at 1440 and 390 (view tabs, grid, switch, Run all, material menu, help (i) after rebuild, axis buttons). |
| 11 | Node validators | PASS | `validate-geometry`, `validate-prep`, `validate-existing-fixes`, `validate-new-families`, `validate-buckling-predict`, `proto/geom-views/curvature_check.js` all pass. `validate-ui-fixes.js` in the page: 10 pass, 4 fail (uDeformSign, uTint, uMacroAmp, SV registry), the same 4 as before the refresh; no new ones. |
| 12 | Sweep parity | PASS (no regression) | See below. |

## Defects

1. **Flow tab on phone, 390 peek** (`ui-lab.css`, particle rows in `#flowAnimToggle`): the `◐ view` button (350-382 x, 224-256 y) overlaps the right 2 px of the count slider's value button (306-352), so OVERLAP reports one theft (visible share 0.93). The same bar is 221 px tall there (four stacked sliders), against 77 px elsewhere. Fix idea: give the particle rows a right margin of 36 px on phone, or put the sliders in two columns. Not blocking.

## Cosmetic, not blocking

- Flow Readout, Fluid row at 1440: "Culture medium" is clipped inside its segment ("Water 37 °C | ulture mediur | Custom").
- Atlas at 390: the "Stiffness as" segmented runs past the right edge (clipped, no scroll) and the run label reads "v1 · v1 · le…".
- Help "show" for viscosity (`fmu`): the row is hidden unless the fluid is Custom; it opens the Readout fold and flashes the fold body instead of showing the note. `65-help.js` line 381 expects a note.
- `UI_REFRESH.md` says Flow tab on phone was not in the checked tab list; it is the one that fails.

## Sweep parity (f13ld.sweep dee804f, lab `ui-refresh` as sibling)

- Lab does not break Sweep. Files Sweep copies (`10`, `11`, `12b`, `14a`, `16a`, `16b`, `16g`, `16i`, `17b`) are byte-identical to Sweep's `solver/lab/`, and none changed on the branch. `13`, `13b`, `14`, `60` (geometry marker blocks) are untouched. `12-fft-plan.js` differs from Sweep's copy, but it is unchanged on the branch, so it also differs on origin/main (Sweep's copy is stale).
- `#hardwarePill`, `#hardwarePillVal` and `#solverPill` exist in `index.html` and `10-hardware.js` still writes them.
- `node tests/parity/parity.js --quick --jobs 2` (quick subset, 14 s): 6 failures, **identical with `LAB_DIR` set to an origin/main export**, so none come from the refresh. Failures: geomsync reports "TPMS-PRESETS block not found" in Lab's `60-add-design.js` (both markers are present at lines 8 and 129, so the checker or marker format is out of step), and 5 `cellSizeMM is not defined` exceptions in `buildExportJSON` from the sibling tool checkouts. The other rows (noise, grain, beam, wave) show 0 differing voxels.
- `node tests/loadorder.js` could not run (`acorn` not installed in Sweep). Full parity (without `--quick`) not run.

## Not covered

- Thermal and Flow results clearing by a real solve (Buckling only); Crush clearing.
- Export JSON byte-identity against main; help (i) count against main; Reduce Motion; stall stress.
- Run all on phone was not re-run here (the builder's phone run check stands); Cancel was not clicked.
- Atlas and Import previews were checked by screenshot and canvas size, not by pixel readback.

## Tree note

`index.html` had an uncommitted one-line edit while I verified (`#w-clip` gets `hidden`; not mine). The runs above mostly used the tree before it; a re-check with it in place gave 0 page errors at 390 and 1440 and the same single Flow-tab overlap at 390. The section-plane radio with it (shown only after a Thermal / Flow run) was not re-tested. Commit or discard it deliberately.
