# F13LD.lab — UI audit (stage 1, wave 3)

Branch `ui-refresh` from `origin/main` 52174e1 (v0.35.1), 2026-11-26. Read-only: no app code changed.

Screenshots are in `docs/ui-audit/`. They were taken with Playwright and local Chrome, **headless on the real GPU**: ANGLE D3D11 on the RTX 4070 Ti SUPER, no SwiftShader, DPR 1, served over http.
- WebGPU came up headless (`requestAdapter()` gave nvidia / lovelace), so headed mode was not needed.
- Scene: the three built-in demo designs (Schwarz P, spinodoid, hyperuniform).
- Result screenshots come from one quick run: Elastic 32³ only, 4.7 s.
- `CLAUDE.md` says "don't run headless browser checks". This audit ran them because the lead's brief asked for them. Later stages need the same OK.

| File | What |
|---|---|
| `desktop-geometry.png` | 1440×900, Geometry tab, Shaded, no results |
| `desktop-geom-curvature.png` | Geometry view picker on Curvature (Measure + range slider + legend) |
| `desktop-viewmenu.png` | shared `◐ view` menu open |
| `desktop-tab-{stress,stiff,thermal,flow,buckle,curve}.png` | every VIEW tab before a run (Flow shows the Particles strip) |
| `desktop-drawer-{model,elastic,buckle,nonlin,thermal,flow}.png` | Configure drawer, every tab |
| `desktop-running.png` | during a run: status chip bar + progress row + ETA + Cancel |
| `desktop-results-{geometry,stress,stiffness}.png` | after the run: cards, stress tile controls |
| `desktop-results-after-grid-change.png` | Elastic grid switched to 64³ after the run: the cards still show the N=32 numbers, "run complete" |
| `desktop-sweep.png` | Sweep panel (builder, run settings, runs) |
| `desktop-import.png` | Import STL dialog |
| `w1024.png`, `w700.png` | breakpoint checks |
| `phone.png`, `phone-drawer.png`, `phone-tab-flow.png`, `phone-sweep.png` | 390×844 |

Atlas is not shown: it needs a finished sweep, and running one was out of scope. Its controls are mapped from code (§5).

## 1. Current state

- **Version:** v0.35.1, multi-file:
  - `index.html` (302 lines) loads `lab.css` (1,520 lines) and 50 numbered classic scripts, about 43.7k lines with the validators.
  - Worker code is in `16e` and `17c`.
  - There is no `tests/` folder and no `loadorder.js`. Node checks are the `validate-*.js` files and `proto/*/`.
  - No help system, no liquid-ui, no queue client.
- **Layout today:**
  - **Header:** brand, LAB, then Add Design, Import STL, Sweep, Atlas, Export PDF, ⬡ Open in F13LD.mesh, version and tool tile.
  - **VIEW strip (`30-view-tabs.js`):**
    - 7 tabs (Geometry, Stress, Stiffness, Thermal κ, Flow, Buckling, Crush).
    - Per-tab controls: σ scale per/shared, Pores filled with, Particles play and 4 sliders.
    - Status chip (`52-status.js`) and `◐ view` (shared F13LD-SHADE block, `20c`).
  - **Geometry row (`31-geom-views.js`):** View picker (5), then per-view Measure / Build pickers, sliders and legend.
  - **Comparison area (`40-design-grid.js`):** up to 3 design cards. Each card has:
    - a header: label, title, source, status dot, ★ baseline, ×, plus ⚙ ⤓ for imports;
    - a viewer tile (`LabRaymarcher`, one WebGL2 context each);
    - per-tab tile overlays: stress axes / sat / deform, buckling axes / exag, thermal T Δ q κ + grad + clip, flow view + direction + clip;
    - a Metrics fold with metric rows and amber warning marks.
    - The Crush tab replaces the cards with one merged view (`#mergedView`): Plotly stress–strain plot, looped cubes, metrics and scrubber. Flow charts also use this merged area.
  - **Bottom dock (`51-dock.js`):**
    - Configure opens the drawer.
    - 6 dock tags (material + 5 physics with on/off).
    - Designs · estimate · hardware line, and Run all.
    - A progress row (bar, stage text, ETA) sits above the dock during a run.
  - **Configure drawer:**
    - Slides up over the cards and never resizes them (v0.22.0 rule).
    - Left: a tab list (Model, Elastic, Buckling, Crush, Thermal κ, Flow), each physics tab with its own on/off switch.
    - Right: one pane per tab with a header switch, settings and hint paragraphs.
  - **Overlays:** Sweep panel (`62`, sections 1 Define runs · 2 Run settings · 3 Runs), Atlas (`63`, full screen), Import STL dialog (`61`).
- **Built at runtime by `innerHTML`:**
  - cards and tile overlays: `renderDesignGrid`, called on every view switch, resize (150 ms debounce), add/remove and each run stage;
  - geometry row (`geomViewRowBuild`);
  - drawer dropdowns (`renderDropdown`) and dock tags (`paintDock`);
  - crush plot header and legend (`20b`), scrubber (`renderNonlinearViz`);
  - flow charts switch (`24`);
  - the whole Sweep panel, Atlas and Import dialog;
  - `◐ view` (`20c`, createElement).
- **Physics on run:**
  - Elastic: WebGPU FFT.
  - Buckling: CPU worker pool.
  - Crush: WebGPU.
  - Thermal: WebGPU, wall voxels on the 17c pool.
  - Flow: WebGPU lattice Boltzmann.
  - Each mode keeps a cache signature (§8).

**Runtime (Playwright, one browser, real GPU):**

| | 1440 | 1024 | 700 | 390 |
|---|---|---|---|---|
| Horizontal scroll (page) | 0 | 0 | 0 | **9 px**: layout viewport grows to 399; geometry row and dock tags overflow |
| Cards | 3 across, 460 px | 2 + 1, metrics clipped to one row | stacked, tiles cut to ~100 px | stacked, tiles cut to ~55 px, metrics hidden |
| Visible text < 11 px | 68 | 60 | 52 | 46 (9 / 9.5 / 10 / 10.5 px; card group label 8.5 px) |
| Visible controls < 44 px (default / drawer open / sweep open) | 36 / 52 / 57 | 36 | 36 | 33 / 53 / 55 |
| Help (i) | 0 (no help system) | 0 | 0 | 0 |
| Page errors | 0 | 0 | 0 | 0 |

- **Console:** one 404 for a missing static resource (not a script).
- **DOM counts (3 designs, Geometry tab):** 0 `<select>` (9 with the Sweep panel open), 4 ranges, 5 checkboxes (view menu), 4 number fields, 89 buttons, 10 `role=switch`, 1 `role=button` per warning mark, 3 canvases.
- **Idle cost** (counted by wrapping `requestAnimationFrame` / `drawArrays` for 1 s, see §7):
  - 381 rAF and 381 draws per second in every state tested: Shaded spinning, held after a grab, Curvature view, Stress with fields, Stiffness.
  - 0 shader compiles in all of them.
- **Results after a settings change:** after the 32³ run, switching Elastic to 64³ left all three cards on their N=32 values (`_elasticSig` still `N32|…`), the chip on "✓ run complete", and Export PDF and Mesh enabled.

## 2. Findings

Severity: H = blocks the standard or gives wrong output, M = visible defect / rule break, L = polish.

| # | Issue | Where | Sev | Rule |
|---|---|---|---|---|
| F1 | No liquid widgets. Native ranges, custom `.dd` dropdowns (buttons, no `<select>`), native selects in Sweep / Atlas / Import, pill segmented buttons in four styles (`.seg`, `.cp-seg`, `.th-btn`, `.load-axis-btn`), `.stress-norm-btn`, chips | `51-dock.js` 280–336, `40` 650–1720, `62` 1090–1450, `63`, `61` 255–274 | H | Goal: controls; lesson 5 |
| F2 | **Results outlive the settings that made them.** Changing the grid, material, connectivity, surface voxels, crush cap or flow tolerance leaves the old numbers on the cards, the "run complete" chip, the baseline deltas, the winner for Mesh, and Export PDF. Only the material change prints a status line. Run reuses the cache by signature, but display never checks it | `50-controls.js` 651, 733, 878, 934, 995; `51-dock.js` 195–245; `desktop-results-after-grid-change.png` | H | Matt: results clear when the design changes |
| F3 | Controls live in four places: dock tags, the drawer (covers the lower cards and their metrics), the VIEW strip and the tile overlays. On phone the drawer covers everything. Configure + 6 dock tags + 10 switches (5 in tabs, 5 in pane headers) all set the same state | `51-dock.js`, `index.html` 113–200; `desktop-drawer-*.png`, `phone-drawer.png` | H | One focus per screen; lesson 6 |
| F4 | Render loop never sleeps. Each tile runs its own rAF and draws every frame, `_dirty` is set in ~40 places but never read by `_render`. Idle 381 draws/s with 3 tiles, also while a solve runs on the same GPU | `21-raymarcher.js` 2442–2560; `22-stiffness-viz.js` 645 | H | Lesson 2: loop sleeps; Matt's CPU complaint |
| F5 | Phone and narrow: cards are squeezed into the space between strip and dock, so tiles are cut to 55–100 px and metrics are hidden. The page overflows by 9 px at 390. No sheet, no section bar. The view tabs wrap to 3 rows and the status chip and `◐ view` take 2 more | `lab.css` 568–1520 (12 breakpoints: 1280, 1100, 880, 820, 760, 720, 640, 600, 520, 480, 420, 400); `phone.png`, `w700.png` | H | Phone sheet; no horizontal scroll |
| F6 | One run shows three progress readouts: status chip bar (33 %), the progress row (bar, stage, ETA) and the Run button spinner. Sweep adds a fourth on the header button (`.fh-prog`) | `50-controls.js` 1326–1345, `52-status.js`, `62` | M | Matt: one bar per long job |
| F7 | No help system: 0 (i). Explanations live in drawer hint paragraphs (19, some 4 lines), in `title` tooltips (27 in `index.html`, many more in JS) that touch can't reach, and in Atlas's own guide | `index.html`, `51-dock.js`, `40` | M | Matt: add missing help cards; lesson 7 |
| F8 | Targets < 44 px: header actions 27, view tabs 30, geometry picker 24, card icon buttons 24, segmented 22, drawer tabs 34, switches 14, dropdown 28, Configure 30, dock tags 28, Run 32, Sweep fields 24–26 | `lab.css` 80–200, 1296 | M | 44 px hit areas |
| F9 | Text below 11 px everywhere: mono uppercase labels 9 px (`.lbl`, `.label`, `.rl`, `.rd`, `.fa-l`), `.hint` 10.5, drawer labels 9.5, `.dc-grp` 8.5, version 10 | `lab.css` | M | Type scale 11 / 13 / 15 / 20 / 28 |
| F10 | Hex tokens (`--lab:#E06A6F`, `--lab-deep:#8C2A2E`, `--ink-dim:#555` = 2.6:1 on `--panel`, `--ink-mute:#888`), inline hex in JS (brand SVG, warn icon, colour bars). Fonts are Exo 2 + JetBrains Mono from Google, not the template's system-ui + Plex Mono | `lab.css` 16–50 | M | OKLCH tokens; contrast |
| F11 | Shared view controls repeat in every tile. Thermal T/Δ/q/κ + grad X/Y/Z, flow view (6) + direction (4) and section X/Y/Z all write one global state (`VIEW_STATE`, `LAB_CLIP`) but are drawn 3 times. The flow-charts header draws the flow switch a 4th time | `40` 650–840, `24` 34 | M | Fewer choices; chunking |
| F12 | Dead UI. The Deformed-tab control (`buildDeformControl`, mode `deform` has had no tab since v0.25.0). **Export PDF** is a stub (`alert('PDF export — coming in Phase 9…')`). `onBrowseVaultClick` and `#loadedPill` have no element. `#solverSpinner` is missing (null-checked) | `40` 1166, 1276; `60-add-design.js` 803–860 | L | Housekeeping |
| F13 | 31 `alert` / `prompt` / `confirm` calls. Paste a recipe = Shift-click + `prompt()`. The 3-design limit, PDF stub and Mesh hand-off all use `alert` | `60` (12), `61` (7), `62` (11), `63` (1) | M | Shared header message |
| F14 | Glyph icons: ★ × ⚙ ⤓ ↺ ✎ ✕ ❚❚ ▾ ⚠ ◐ ⬡. ⬡ and ◐ are suite stamps (Mesh button, shared view block), so keep them | `40`, `61`, `62`, `63`, `20c` | L | Drawn icons only |
| F15 | Tile `antialias:true` (no effect on a full-screen ray-march quad). No adaptive interactive scale, no strip rest frame | `21` 1129 | M | render-quality.md §2–3 |
| F16 | The Flow pane mixes solver settings (grid, tolerance) with readout settings that never re-solve (direction, fluid, viscosity, shear target, units, chamber), with no grouping. The pane is ~520 px tall | `index.html` 166–176 | L | Chunking; compact panels |
| F17 | At 1024 the cards wrap 2 + 1 and their metrics clip to one row. At 1280 the dock tags crowd the estimate line | `w1024.png` | M | One focus; no clipping |

## 3. How the template maps onto lab's layout

Lab already has most of the parts. The Configure drawer is already a section pane: a tab list with icons and an on/off state per mode, plus one pane per mode. That is the template's section rail plus one `.sec` at a time. The same is true of mesh's left rail. The change is the host, not the content.

| Template | Lab today | Proposal |
|---|---|---|
| `#viewPane` with viewer overlays | VIEW strip + geometry row + comparison area (cards / merged view) | **Keep.** The comparison area is the viewer pane. VIEW tabs and the per-tab row become viewer overlays at its top (one row, two on phone). Shared tile controls (F11) move into that row once. Per-design controls (stress / buckling axis, sat, deform, exag) stay on their tile |
| `#ctrlPane`: `#sectionsRail` + one `.sec` at a time | Dock + slide-up Configure drawer (tab list + panes) | The drawer **becomes** the control pane, docked on the right at ≥ 900 px. Its tab list becomes the rail (56 px icons), its panes become sections. Configure, the 6 dock tags and the 5 tab switches go (F3). Lab sets `--pane-w: clamp(340px, 26vw, 400px)` so three cards keep ~335 px each at 1440 |
| Run button with progress | `#runBtn` + progress row + chip bar | **Footer** at the bottom of the control pane: estimate line, Run all as a liquid progress button (stage + time left on it), Cancel beside it (F6) |
| Analyze section with results | Card Metrics folds | Desktop: keep the cards with their metrics (the comparison is the point). Phone: the metrics move into a **Results** section, one row per metric with A / B / C columns, as mesh moved its inspector below 1280 |
| Phone bottom sheet + `#sectionsBar` | Drawer over the whole screen | Viewer on top (one design at a time, A / B / C switch), control pane as the sheet (peek 45 dvh / full 88 dvh), tab bar Results / Model / Physics, Run all in the sheet footer |
| `layout.js`, `F13UI` | none | Add as numbered files (§11) |
| Recipe menu / recipe import | Add Design (file picker, Shift-click `prompt`), page drop of `.stl` | Not a design tool: no Recipe menu, no `recipe-import.js`. Keep Add Design / Import STL in the header. Paste and drop of `.json` go through the existing `ingestDesignFile` → `normalizeDesignJson` (§11, recipe routing) |
| Dialogs | Sweep panel, Atlas, Import STL | **Keep as overlays.** Sweep already has workflow sections (1 · 2 · 3), and its runs table and the Atlas need the full width. Restyle to tokens, widgets inside, 44 px targets, full screen on phone |

**What stays as is:**
- cards and their header actions, the metric rows and warning marks, colour bars, gimbal;
- the section-plane handle drag, orbit / zoom / pan, the linked Geometry pose and Turn again;
- the merged crush view (Plotly plot, cubes, scrubber logic) and the flow charts;
- the Sweep and Atlas logic, the Import dialog flow;
- the run pipeline, cache signatures and worker pools;
- the startup splash, the status chip (state text only, §9), and `◐ view` (the shared block is untouched).

## 4. Proposed section map

### Desktop (≥ 900 px)

Two sections, in workflow order. Icons are lab's own (`LAB_ICONS.model`, `elastic` as the Physics mark).

| Section (icon) | Group | Controls |
|---|---|---|
| **01 Model** (model) | Material | Material (dropdown, optgroups from the AM library, "From design" first) |
| | Voxels | Connectivity, Surface voxels |
| | (fold, closed) Defaults | Reset run settings |
| **02 Physics** (elastic) | Elastic fold | header: run toggle + summary "64³". Body: Grid |
| | Buckling fold | header: toggle + "32³" / "off". Body: Grid |
| | Crush fold | header: toggle + "32³ · 5 % · ZZ". Body: Grid, Strain cap, Load axis |
| | Thermal κ fold | header: toggle + "water". Body: Pores filled with (multi-select) |
| | Flow fold | header: toggle + "64³ · standard". Body: Grid, Tolerance. Sub-group **Readout (no re-run)**: Direction, Fluid, Viscosity (custom only), Shear target, Custom target lo – hi on one row (custom only), Speed units, Chamber diameter |

- **Footer (both sections):** designs · estimate · hardware line, Run all (progress), Cancel while running.
- **Viewer overlays, top row:** VIEW tabs (segmented), status chip, `◐ view`.
- **Viewer overlays, second row (per tab):**
  - Geometry: View, Measure / Build, sliders, legend.
  - Stress: σ scale.
  - Thermal: Pores filled with, view T Δ q κ, grad, section.
  - Flow: view, direction, section, Particles.
  - Crush: the plot header stays in the merged view.
- **On the tiles:** stress axis + sat + deform; buckling axis + exag.
- **Header:** Add Design, Import STL, Sweep, Atlas, Mesh, help trigger (new), version, tool tile.

**Why folds, not five sections:**
- The five modes are a set of on/off switches with one to three settings each, changed rarely.
- One Physics section with folds keeps the on/off state and summary of every mode in view: what the dock tags show today, without the tags.
- It is the pattern Matt liked in mesh's Transform fold: real 44 px header, one-line summary, drawn chevron, open state remembered.
- An off mode's fold header dims, and its body still opens.
- Five sections would need five rail items for a few controls each, and the on/off state would have to live on the rail.

**Cards:**
- 3 across when the viewer pane is ≥ 960 px wide; 2 + 1 below that.
- The pane scrolls vertically with each card at its natural height, never squeezed (F5, F17).

### Phone (< 900 px)

- **Viewer (top):**
  - VIEW tabs as an icon-only segmented row (7 × 48 px fits 358).
  - The per-tab row (wraps to two rows at most).
  - One design's tile at a time with an A / B / C switch (segmented, top-left of the tile). The card header shrinks to label + title + ★ ×.
  - Crush: the merged plot.
- **Sheet tab bar:** **Results** · **Model** · **Physics**.
  - **Results** is new on phone: the card metrics as one table, metric | A | B | C, with the same warning marks. On Crush and Flow charts it shows that tab's metrics. It also gets the results badge after a run, which clears with the results (§8).
  - Model and Physics are as on desktop.
- **Sheet footer:** Run all + Cancel.
- **Sweep / Atlas / Import:** full-screen overlays with a close button. Sweep's three numbered sections stack; its runs table keeps the condensed columns it already has (`.hN` / `.hS`).

## 5. Control → widget map

**Sources:**
- every `<select`, `type="range"`, `type="checkbox"`, `type="number"`, `<button`, `role=` and `onclick` in `index.html` and the JS builders (`20`, `20b`, `20c`, `24`, `31`, `40`, `51`, `60`, `61`, `62`, `63`);
- checked against the runtime DOM counts in §1 and the Sweep / Import DOM read at runtime.

Repeated rows (one per design, run, filler, table row) count once. Buttons inside a group count one by one.

**Totals: 278 controls.**
- **Widgets, 186 controls:**

  | Widget | Controls |
  |---|---|
  | Sliders | 17 |
  | Segmented | 36 widgets, 115 buttons |
  | Radio (section plane) | 1 widget, 3 buttons |
  | Toggles | 23 |
  | Dropdowns | 20 |
  | Progress buttons (Run all, Run sweep) | 2 |
  | Drawer tabs → sections | 6 |

- **Removed:** 23.
- **Native** (restyled to tokens and 44 px hit areas, reason given): 69.

### Header

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 1 | `#addDesignBtn` | button | native | Header action. Icon-only under 760 px (as now); 44 px |
| 2 | `#importStlBtn` | button | native | As above |
| 3 | `#sweepBtn` | button | native | Its `.fh-prog` progress goes; the sweep's one bar is on its Run button (§9) |
| 4 | `#atlasBtn` | button | native | Keeps `aria-disabled` + hover note (`labPaintAtlasBtn`) |
| 5 | `#exportPdfBtn` | button | **removed** | F12: stub. Back when the PDF exists (decision) |
| 6 | `#meshHandoffBtn` | button | native | Suite stamp: markup unchanged (CLAUDE.md) |
| 7 | Add Design file input | file, JS-created | native, hidden | |

### VIEW strip and per-tab row

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 8–14 | `.view-tab` ×7 | tab buttons | `segmented` sm, one widget | Clicks the native tabs (`onViewModeClick`). `syncOn:['class']`. Icon-only on phone |
| 15–16 | `.stress-norm-btn` per / shared | buttons | `segmented` | `onStressNormToggleClick` |
| 17–19 | Pores filled with air / water / tissue | buttons | `segmented` | `onThermalFillerView`. An unsolved filler is `disabled` (kit wave 5 per-option disabled) |
| 20 | `.flow-play` | button | `toggle` sm | Gets `aria-pressed` |
| 21–24 | Particles speed, length, size, count | range | `slider` inline ×4 | One 36 px row each (`inline:true`); `fa-v` text as the format |
| 25 | `◐ view` | button | native | Shared F13LD-SHADE block, byte-identical across the suite. `F13UI.viewMenuSelector` points at it |
| 26–30 | view menu checkboxes ×5 | checkbox | `toggle` sm ×5 | `viewMenu:true` with the selector above |
| 31 | view menu reset | button | native | Needs a `checked` mirror on the five boxes |

### Geometry row

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 32–36 | View: Shaded / Curvature / Overhang / Wall thickness / Pore size | `.cp-seg` buttons (`aria-pressed`) | `segmented` | Row rebuilt by `geomViewRowBuild`: mount with `F13UI.mount.segmented` from a wrapper |
| 37 | Turn again | icon button | native | Drawn icon already. 44 px; sits after the segmented, not inside it |
| 38–40 | Measure: mean / Gaussian / tightest | buttons | `segmented` | Curvature only |
| 41–43 | Build: X / Y / Z | buttons | `segmented` | Overhang only |
| 44–50 | `tightest`, `curvRange`, `overhang`, `wallMin`, `wallScale`, `poreMin`, `poreScale` | range | `slider` inline ×7 | At most 2 shown. `geomFmt` as format. Drag = uniforms only (0 compiles, measured) |

### Cards (once per design)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 51 | ★ baseline | button | native | Drawn star icon; 44 px hit |
| 52 | × remove | button | native | Drawn icon |
| 53 | ⚙ adjust wall offset (imports) | button | native | Drawn icon |
| 54 | ⤓ save JSON (imports) | button | native | Drawn icon |
| 55 | warning mark `.rwm` | `role=button` span | native | Tap shows the text; becomes a `<button>` |
| 56 | `.dc-drawer-bar` Metrics | div onclick | native button (fold) | Real 44 px button, chevron drawn. Phone: replaced by the Results section |

### Tile overlays

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 57–62 | Stress load axis XX … XY | `.load-axis-btn` ×6 | `segmented` compact | Per design (`onLoadAxisClick`); grid rebuilt: mount from a `renderDesignGrid` wrapper |
| 63 | `.sat-slider` | range 0–2 | `slider` compact | detent 1 |
| 64 | `.amp-slider` (stress deform) | range 0–1 | `slider` compact | `disabled` on shear axes: the slider follows the native `disabled` |
| 65–67 | Buckling axis XX / YY / ZZ | buttons | `segmented` compact | |
| 68 | `.buckle-exag-slider` | range 0–30 | `slider` compact | |
| 69–72 | Deformed-tab control (XX / YY / ZZ + amp) | buttons + range | **removed** (4) | F12, unreachable since v0.25.0 |
| 73–76 | Thermal view T / Δ / q / κ | `.th-btn` | `segmented` | Global (`VIEW_STATE.thermalView`): one widget in the Thermal row, not per tile (F11) |
| 77–79 | Thermal grad X / Y / Z | `.th-btn` | `segmented` | Same; hidden on κ |
| 80–82 | Section X / Y / Z `.lab-clip-pill` | buttons | `radio` sm (`CONFIG.clip`) | Global `LAB_CLIP`. `get:()=>LAB_CLIP.axis`, `set:n=>onLabClipPill(n)`; tapping the active axis clears it. One radio in the Thermal / Flow row |
| 83–88 | Flow view: flow / speed / shear / K(n) / orient / charts | `.th-btn` | `segmented` | Global; one widget in the Flow row |
| 89–92 | Flow direction X / Y / Z / XYZ | `.th-btn` | `segmented` | Global; flow and speed views only |
| 93–98 | Flow-charts switch (`24 _fcSwitch`) | `.th-btn` ×6 | **removed** (6) | Duplicate of 83–88; the Flow row stays visible over the charts |

### Crush (merged view)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 99–101 | Stress MPa / log / ÷ own σy | `.cp-seg` | `segmented` | Header rebuilt per draw: `mount.segmented` in a `_cpHeaderHtml` wrapper |
| 102–105 | Focus XX / YY / ZZ / All | `.cp-seg` | `segmented` | `disabled` for unseen axes |
| 106–108 | chips 0.2 % offset / buckling / labels | `span[data-c]` | `toggle` ×3 | Become buttons with `aria-pressed` |
| 109 | legend design name (show / hide) | span | native | Legend entry with the design colour; a button, 44 px |
| 110 | legend axis buttons (line style) | button | native | Draws the dash pattern; a toggle would hide it |
| 111 | ⚠ flag | span `title` | native | Text moves into a tap note (touch can't read `title`) |
| 112 | Plotly modebar | Plotly buttons | native | Plotly's own |
| 113–115 | crush axis X / Y / Z (no-Plotly path) | `.nl-axis-btn` | `segmented` | |
| 116 | `#nlPlayBtn` | button ❚❚ | `toggle` | Drawn play / pause |
| 117 | `#nlScrub` | range 0–1000 | `slider` | Ticks row stays under it |
| 118–119 | SVG fallback MPa / ÷ own yield | `.mp-scale-btn` | `segmented` | Only when Plotly fails |
| 120 | fallback "switch to…" hint button | button | native | |

### Dock and Configure drawer → control pane

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 121 | `#cfgBtn` Configure | button | **removed** | The pane is always there (F3). `toggleDrawer` kept as a no-op shim |
| 122–127 | `.dock-tag` ×6 | buttons | **removed** (6) | Fold headers carry the summaries |
| 128 | `#runBtn` Run all | button | `progress` (`CONFIG.run`) | `F13UI.run.progress / label / done` from `paintRunProgress` / `paintRunStatus`; Cancel (new, native) beside it. The sweep lock (`labPaintRunLock`, aria-disabled + note) stays |
| 129–134 | `.dr-tab` ×6 | div tabs | `sections` | Model → section 01. The five physics tabs become the folds of section 02 |
| 135–139 | tab switches `role=switch` ×5 | switch | **removed** (5) | Duplicates of 140–144 |
| 140–144 | pane-header switches ×5 | switch (`aria-checked`) | `toggle` ×5 | Move into the fold headers; `onPhysSwitch` |
| 145 | Material `.dd` | custom dropdown (button + listbox) | `dropdown` | Stage 3 adds a hidden native `<select id="materialSel">` with optgroups as state (the wire mounts on selects). `relabel` keeps name + condition |
| 146 | Connectivity `.dd` | custom dropdown | `dropdown` | Same, `connSel` |
| 147–148 | Surface voxels | `.seg` ×2 | `segmented` | |
| 149 | Reset run settings | button | native | In a closed fold |
| 150–152 | Elastic grid 32 / 64 / 128 | `.seg` | `segmented` | Solver setting: stays (Matt) |
| 153–155 | Buckling grid 16 / 32 / 64 | `.seg` | `segmented` | |
| 156–158 | Crush grid 16 / 32 / 64 | `.seg` | `segmented` | |
| 159–161 | Strain cap 2 / 5 / 10 % | `.seg` | `segmented` | |
| 162–165 | Crush load axis ZZ / XX / YY / All | `.seg` | `segmented` | |
| 166–168 | Thermal fillers air / water / tissue | `.chip` multi-select | `toggle` ×3 | At least one stays on (`onFillerChip`): the last one ignores taps |
| 169–171 | Flow grid 32 / 64 / 128 | `.seg` | `segmented` | |
| 172–173 | Flow tolerance | `.seg` | `segmented` | |
| 174–177 | Flow direction Z / X / Y / All | `.seg` | `segmented` | Readout group |
| 178–180 | Fluid | `.seg` | `segmented` | Readout group |
| 181 | `muCustom` | number | native | Typed from a data sheet; shown for Custom only |
| 182 | Shear target `.dd` | custom dropdown | `dropdown` | Hidden native select as state, as 145 |
| 183–184 | `tLo`, `tHi` | number ×2 | native | One row "lo – hi mPa"; shown for Custom target only |
| 185–186 | Speed units | `.seg` | `segmented` | Readout group |
| 187 | `chamberMm` | number | native | Readout group |

### Sweep panel (overlay)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 188 | ↺ New sweep | button | native | Drawn icon |
| 189 | × close | button | native | |
| 190–191 | Build from a design / Load a CSV | `aria-pressed` buttons | `segmented` | |
| 192 | `#swb_design` | select | `dropdown` compact | Builder rebuilt by `sweepRenderBuilder`: wrap and remount |
| 193 | `#swb_p1` | select (optgroups) | `dropdown` | `relabel` groups |
| 194 | `#swb_by` | select | `dropdown` compact | |
| 195–198 | from / to / steps / or values (1) | text | native | Typed values, lists like "0.05, 0.1" |
| 199 | `#swb_p2` | select | `dropdown` | |
| 200–203 | from / to / steps / or values (2) | text | native | |
| 204 | `#swb_N` | select | `dropdown` compact | A select-backed segmented isn't in the kit |
| 205 | `#swb_nu` | text | native | |
| 206 | Review | button | native | |
| 207 | review Back | button | native | |
| 208 | Create N runs | button | native, accent | |
| 209 | Load / Replace CSV… | button | native | |
| 210 | ✕ remove CSV | button | native | Drawn icon |
| 211–212 | Physics thermal / flow | `aria-pressed` buttons | `toggle` ×2 | |
| 213 | `#swPrec` Precision | select | `dropdown` compact | |
| 214 | Void | select | `dropdown` compact | |
| 215 | Second grid | select | `dropdown` compact | |
| 216 | order | select | `dropdown` compact | Second grid ≠ off only |
| 217 | Surface voxels | select | `dropdown` compact | |
| 218 | ✎ rename | button | native | Drawn icon |
| 219 | Select: all · tier n · not run · none | `<a>` links | native | Text links → 44 px buttons |
| 220 | Stop | button | native | Beside the Run sweep progress button |
| 221 | Clear results of selected | button | native | |
| 222 | Export CSV | button | native | |
| 223 | Run sweep | button | `progress` | Second long job (§9) |
| 224 | per-run checkbox | checkbox | native | Table row selection, many rows; 44 px hit on the cell |
| 225 | done-strip dismiss | button | native | |
| 226 | Explore results in Atlas | button | native, accent | The one filled button (v0.34.0) |

### Atlas (overlay)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 227–229 | Stiffness / Thermal / Flow | `role=tab` buttons | `segmented` | `disabled` without data (per-option disabled) |
| 230 | help | button | native | Reopens the guide |
| 231 | close | button | native | |
| 232–233 | guide: Show again next time / Got it | buttons | native | |
| 234–235 | 1 cell / 2×2×2 | buttons | `segmented` | |
| 236–237 | linked (geometry, surface) | `aria-pressed` buttons | `toggle` ×2 | |
| 238–239 | home view ×2 | buttons | native | |
| 240 | Series | select | `dropdown` | |
| 241 | Run in series | range | `slider` | |
| 242–243 | run grid / extrapolated | buttons | `segmented` | |
| 244–245 | ÷ E solid / material | buttons | `segmented` | |
| 246–248 | focus filler (≤ 3) | buttons | `segmented` | |
| 249 | filler table rows | `tr` onclick | native | Table rows |
| 250 | runs table rows | `tr` onclick | native | |
| 251 | map by | select | `dropdown` | |
| 252 | heat-map cells | `td` onclick | native | Grid cells |
| 253–255 | line-chart filler legend (≤ 3) | buttons | `segmented` | Same state as 246–248 |
| 256 | trabecular bone band | `aria-pressed` button | `toggle` | |
| 257–258 | scatter X / Y | select ×2 | `dropdown` ×2 | |
| 259 | scatter reset | button | native | |
| 260 | 3-D surface metric | select | `dropdown` | |
| 261–263 | scale auto / linear / log | buttons | `segmented` | |
| 264–265 | colour by value / connectivity | buttons | `segmented` | |
| 266 | 3-D home | button | native | |

### Import STL dialog

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 267 | × close | button | native | |
| 268 | "choose a file" link | `<a>` | native | Becomes a button |
| 269 | file input | file, JS-created | native, hidden | |
| 270 | `#impUnits` mm / inch | select | `dropdown` compact | |
| 271 | `#impCellMode` fit / set | select | `dropdown` compact | |
| 272 | `#impCellMm` | number | native | |
| 273 | `#impBuildBtn` Build | button | native | |
| 274 | `#impOffset` wall offset | range −1…1 | `slider` | detent 0 |
| 275 | ↺ offset reset | button | native | Drawn icon |
| 276 | face-view pair toggles | clickable cells | native | |
| 277 | Cancel | button | native | |
| 278 | `#impAddBtn` Add to lab / Apply | button | native, accent | |

**Counts by area:**

| Area | Controls | Widget | Native | Removed |
|---|---|---|---|---|
| Header | 7 | 0 | 6 | 1 |
| VIEW strip | 24 | 22 | 2 | 0 |
| Geometry row | 19 | 18 | 1 | 0 |
| Cards | 6 | 0 | 6 | 0 |
| Tile overlays | 42 | 32 | 0 | 10 |
| Crush | 22 | 17 | 5 | 0 |
| Dock / drawer | 67 | 50 | 5 | 12 |
| Sweep | 39 | 15 | 24 | 0 |
| Atlas | 40 | 29 | 11 | 0 |
| Import | 12 | 3 | 9 | 0 |
| **Total** | **278** | **186** | **69** | **23** |

**New controls from this plan:**
- help trigger;
- one (i) per row and per metric;
- Cancel beside Run all;
- A / B / C design switch (phone);
- fold headers: 5 physics, Model defaults, Flow readout;
- the hidden native selects for material, connectivity and shear target (state only).

## 6. Accent

Brand guidelines "Tool color system", Lab row: tile `#F6E7E7`, stroke `#8C2A2E`.

| | Hex | OKLCH |
|---|---|---|
| Brand stroke | `#8C2A2E` | 0.436 0.132 22.3 |
| Current on-dark accent `--lab` | `#E06A6F` | 0.667 0.147 19.3 |
| Stroke hue lifted to L 0.80 (the brief's rule) | `#fda19d` | 0.80 0.110 22.3 (gamut max 0.114) |
| **Proposed accent** (stroke hue, L 0.74) | **`#fb817f`** | **0.74 0.15 22.3** |

**L 0.80 collides with Noise.**
- Noise's wave-1 accent is `oklch(0.80 0.115 39)` = `#fda486`. At L 0.80 the lab hue can only reach C 0.11, so it lands ΔE(OK) **0.033** from Noise: nearly the same coral.
- The closest pair already in the suite is noise / wave at 0.080 (grain / foam 0.085, bundle / mesh 0.084).
- Dropping to L 0.74 keeps the brand hue and allows C 0.15, a clear Lab red:

  | Accent | ΔE(OK) to `#fb817f` |
  |---|---|
  | Noise | 0.079 |
  | Mesh `#f99ad0` | 0.108 |
  | Wave | 0.137 |
  | TPMS, beam, bundle, grain, foam | > 0.13 |

**`#fb817f` contrast:**
- 7.8:1 on `--panel`, 7.1:1 on `--card`.
- Dark text `oklch(0.22 0.06 22.3)` (`#310c0d`) on the accent: 7.2:1.

**Other notes:**
- It replaces `--lab` (`#E06A6F`) as the action / bead / flood / focus colour, the same family lifted.
- `--lab-deep` `#8C2A2E` stays only for the brand tool tile and the splash.
- CLAUDE.md's ".cp-seg selected = `--lab-deep`" rule becomes "selected = accent".
- **Watch:** the template's `--danger oklch(0.68 0.19 25)` is ΔE 0.073 from this accent, and lab's `--bad #fb7185` is close too.
  - Lab already shows warnings with the drawn amber mark; keep it that way.
  - Errors carry the mark plus words, never red alone.
  - Data colours (overhang "needs support" `#d94040`, stress / turbo maps) are not chrome and stay.
- Lime stays the brand mark and the shared "Lime edges" option.

## 7. Render cost (against `render-quality.md`)

**What lab already does:**
- **No manual preview quality.** There is no Low / Med / High switch. `◐ view` holds shading options (shadows, occlusion, warm / cool, cut faces, lime edges), not quality: it is the shared block and stays.
- **Uniforms, not recompiles, for drags.**
  - Geometry view sliders: 30 inputs, **0 compiles** (measured).
  - Stress saturation: 30 inputs, **0 compiles** (measured).
  - Deform / exag / particles / clip / orbit are uniforms (`_render` sets ~50 uniforms per frame).
- **Compiles only on structure:**
  - Main shader: one per tile, `STEPS` = 192 literal, compiled in the background one tile at a time (`labMainPump`).
  - Geometry views: one small program per variant (shade / over / curv / chord ± c), 0.1–2.5 s (v0.35.0).
- **Fixed DPR tier:** buffer = tile × min(DPR, 1.5). It resizes only when the tile's CSS size changes (checked per frame, cheap).
- **Bakes off the main thread:** viewer field bakes as z-slabs on the 17c pool. 48³ preview first, then 96³ / 80³ refine for foam / noise / grain (display only; the solver voxelizes separately). Curvature is baked from the 32-bit field (14 ms at 96³).
- **Bake resolution is fixed per family** (Matt: fixed, errs precise). Keep the refine sizes as they are.
  - The 48³ first bake is a load-time step, not a quality control.
  - Lab has no geometry drags (designs are fixed), so "low-res while dragging" does not apply; nothing to add.
- **Solver settings stay** (Matt): elastic / buckling / crush / flow grids, flow tolerance, strain cap, load axis, fillers, sweep precision, void, second grid.

**Changes (stage 4):**
1. **On-demand loop (F4, the big one).** Today every tile draws every frame (381 draws/s idle for 3 tiles), including during solves that share the GPU.
   - Make `_render` draw only when `_dirty` (already set in ~40 places), or while a tile animates: Shaded spin before the first grab, buckling pulse, flow particles playing, crush loop playing.
   - Use one shared rAF for all tiles instead of one per tile, and stop it when nothing is dirty or animating.
   - Apply the same to `22-stiffness-viz.js` (its `_tick` loop).
   - Assert 0 draws / 0 rAF in 1 s idle on a held Geometry tile, a Curvature view, Stress and Stiffness.
2. **Animations by design** (spin, pulse, particles, crush loop):
   - cap at 30 fps;
   - pause while the tile is off screen (IntersectionObserver), while another tile is being orbited, and while a solve runs;
   - stop under Reduce Motion (show the still frame; Turn again and play stay usable).
3. **`antialias:false`** on tile contexts. It does nothing for the full-screen quad and costs a multisampled buffer per tile. Check that Shaded still matches the main shader (CLAUDE.md: to 1/255) and test by drawing + `gl.getError` (Direct3D rule).
4. **Adaptive interactive scale + strip rest frame:** only after 1–2, and only if the timing table shows a gain.
   - Tiles are ~460×285 CSS (690×427 px at DPR 1.5), and the main march is already a single 192-step tier.
   - Measure the orbit frame time on the RTX first. If a moving frame is > ~8 ms, add `lowFB` at 0.4–0.85 + LINEAR blit while orbiting and one rest frame at full size after 150 ms (strips only if a rest frame exceeds ~16 ms).
   - Steps become a uniform (constant bound 192, `i>=uSteps` break) only if the interactive tier uses fewer.
   - Never put view code in the main shader (CLAUDE.md: 12–66 s on Direct3D).
5. **Count compiles** (`drawStats.compile`) and keep the 0-per-drag assertion for every slider in §5.

## 8. Analysis results: what clears, and when

**Rule:**
- A result is shown only while it matches the current design and run settings.
- Lab already computes the exact keys at run time (cache signatures in `startRun`). Stage 4 lifts them into one function, `labResultSig(mode, design)`, used by both the run (cache hit) and the display.
- When a key no longer matches, that mode's numbers, fields and views **hide**. The card row shows "— · settings changed · Run" and the tile shows "Run to update".
- The data stays in memory, so changing the setting back shows them again, and Run is then a cache hit (no re-solve). Nothing is deleted except on design removal, as today.

| Result | Shown on | Key (clears when any of these change) |
|---|---|---|
| **Elastic**: E / G / ν, Cᵢⱼ, anisotropy, solved density, stress and displacement fields (Stress tab), stiffness surface E(n) (Stiffness tab) | cards, Stress, Stiffness | Elastic grid, connectivity, surface voxels, solver constants (`full6`, `CG_MAXITER_FULL`, `vs1`), design fingerprint (recipe + material) |
| **Crush**: σ–ε curves, yield, crush modulus, cubes, scrubber | Crush tab, cards | Crush grid, strain cap, connectivity, design fingerprint. Load axis: axes already solved stay valid; an axis not yet solved shows "Run". The void is derived from the elastic result at run time, so an elastic key change also clears crush |
| **Buckling**: P_cr, mode shapes, Buckling tab | cards, Buckling | Buckling grid, connectivity, GPU / CPU path, design fingerprint |
| **Derived**: buckling-to-yield ratio, failure mode, Load Capacity | cards | Shown only while every input result is shown (buckling + crush yield, or elastic yield fallback) |
| **Thermal**: κ per filler, temperature / deviation / flux maps, κ(n), surface area density, diffusivity | cards, Thermal | Elastic grid (thermal runs on it), connectivity, tolerance, solid conductivity (material), `THERMAL_GPU_VERSION`, design fingerprint. A filler ticked but not yet solved shows "Run"; solved fillers stay valid when unticked |
| **Flow**: permeability, k/L², tortuosity, open / sealed porosity, narrowest pore, wall shear, velocity fields (particles, speed, shear, orient, charts) | cards, Flow | Flow grid, connectivity, tolerance, `FLOW_GPU_VERSION`, design fingerprint |
| **Comparison**: baseline deltas ("+297 % vs B"), winner, "run complete" chip, Mesh hand-off | cards, chip, header | A delta shows only when both designs' values are shown. Winner and Mesh need every elastic result shown. The chip says "settings changed · Run" instead of "run complete" |
| Phone Results badge | tab bar | Clears with the results it counts |

**Never clears:**
- Readout settings that never re-solve (`onSegClick` returns early for them today): flow direction, fluid, viscosity, shear target, custom target, speed units, chamber.
- Thermal "Pores filled with" view, σ scale, view tabs, geometry views (computed live from the field), view menu, section plane, particles.
- **Sweep runs and the Atlas.** Each run is stamped with its own settings (grid, precision, void, connectivity in the CSV). If Configure's material, connectivity, fillers or flow grid change while a sweep has results, the Sweep panel says which settings differ from the finished runs; it does not clear them.

**What counts as a design change in Lab:**
- Replacing or removing a design.
- Applying a new wall offset in the Import dialog (changes the fingerprint).
- A `?r=` load.
- Lab never edits recipes otherwise.

## 9. Long jobs and compact panels

**One progress bar per long job, stage and time left on the button, Cancel beside it** (Matt liked this in mesh):

| Job | Today | Proposal |
|---|---|---|
| **Run all** (Elastic → Crush → Buckling → Thermal → Flow, per design) | chip bar + progress row (bar, stage, ETA) + Run button spinner, Run toggles to Cancel | Footer **Run all** progress button. Label "Elastic · B · 0:42 left": stage from `paintRunStatus`, time from the existing calibrated ETA (`RUN_STATE.estTotalSec`, `RUN_CALIB`). Native **Cancel** beside it (`cancelRun`). The progress row and the chip's bar go. The chip keeps its state text and ripple ("solving", "preparing view", "run complete") |
| **Sweep** (N runs) | header `.fh-prog` + table row states | **Run sweep** progress button in the Runs section: "Run 12 / 40 · 6:10 left". **Stop** beside it (exists). Header `.fh-prog` goes; the Sweep button can keep a small count |
| **Import STL build** (worker) | Build button + text | Build becomes busy (`null` progress = slosh) while the worker meshes; Cancel closes the worker (exists) |
| Sweep preview checks, viewer bakes, main shader compile | status text, chip "preparing view" | Not user-started jobs: chip state only, no bar |

**Compact panels** (folds with summaries for rarely changed groups; one-line rows):
- **Physics:** five folds, closed by default, open state remembered (`localStorage f13ld.lab.physOpen`). Header = 44 px button: icon, name, run toggle, summary ("64³", "32³ · 5 % · ZZ", "water, tissue", "64³ · standard", "off").
- **Flow:** solver settings in the fold body; the Readout sub-group as a nested fold with its own summary ("All · water 37 °C · no target · mm/s · 10 mm"). Custom target lo – hi on one row. Viscosity and target rows only when Custom is picked.
- **Model:** Material, Connectivity, Surface voxels open. Reset in a closed "Defaults" fold.
- **Hints:** the 19 drawer hint paragraphs move into help cards; one short line stays only where a setting has a cost ("128³ needs 160 MB in one buffer").
- **Particles** (speed, length, size, count): inline sliders (36 px rows, kit `inline:true`) in the Flow row.
- **Geometry sliders:** inline, at most two.
- **Tile overlays:** stress axis XX … XY as one compact segmented row, then sat and deform as two inline slider rows (today's 2-row block, at 44 px targets).
- **No X / Y / Z slider triples in Lab.** Axis choices are segmented rows already.

**Estimated height** of the Physics section with one fold open: ~5 × 52 px headers + ~150 px body ≈ 410 px. It fits at 900 px tall with the footer and needs no scroll. Today the drawer pane is 300 px tall over the cards, and the Flow pane is ~520 px.

## 10. Help

- Lab has no help system. Add the shared help drop-in as numbered files (mesh's `59-help.js` pattern: `refresh([ids])` re-places (i) after `innerHTML` renders).
- **(i) count goes from 0 to about 45:**
  - one per Model / Physics row;
  - one per fold header;
  - one per VIEW tab row group;
  - one per metric row on the cards: definition, units, and the hover notes that touch can't reach today, such as the permeability bone range `FLOW_K_BONE_TIP`.
- **Cards:**
  - Material, Connectivity, Surface voxels;
  - Elastic, grid; Buckling, grid; Crush, grid, strain cap, load axis;
  - Thermal κ, pores filled with; Flow, grid, tolerance, direction, fluid, viscosity, shear target, speed units, chamber;
  - Run all (time estimate, cache);
  - Results clearing ("settings changed");
  - every metric family: modulus, anisotropy, yield, buckling-to-yield, Load Capacity, κ, surface area density, diffusivity, permeability, k/L², tortuosity, porosity, narrowest pore, wall shear, best speed, usable range;
  - each VIEW tab;
  - Geometry views (curvature, overhang, wall, pore), σ scale, section plane, particles, `◐ view`;
  - Render quality (automatic);
  - Sweep (builder, precision, void, second grid);
  - Import STL (units, cell size, wall offset).
- **Atlas keeps its four-step guide** (it is a guide, not a card set). Its help button opens it.
- **Rows rebuilt by `renderDesignGrid`, `geomViewRowBuild` and the sweep renders** must keep a `.sc-group` + `<label>` (or an anchor list) so the engine re-anchors.
- **"Show"** for a control:
  - inside a closed fold: opens the fold first (mesh `railXformOpen` pattern);
  - on a tab that isn't active (e.g. stress saturation from Geometry): says so through the `helpTargets` note.
- **`title` tooltips** stay for mouse users but stop being the only place a fact lives.

## 11. Risks

- **Load order (numbered classic scripts, no `tests/loadorder.js`):**
  - Vendor the bundle as `03-liquid-ui.js`. It has no dependencies, and nothing below `10` touches the DOM.
  - Add `53-layout.js` (template + `F13UI.headerSelector` / `onResize` / `viewMenuSelector` options) after `52-status.js`.
  - Add `54-f13ui-wire.js` as a `defer` script (mesh lesson: the wire waits for DOMContentLoaded properly when deferred), then `55-lab-widgets.js` (wrappers + `F13UI.mount.*`) and `56-help.js`.
  - `99-init.js` renders the cards before DOMContentLoaded, and `renderDesignGrid` re-renders them on every view switch, resize and run stage. Every card / geometry-row / dock / sweep / atlas widget must mount from a wrapper of its render function and destroy the old widgets: watch canvas and listener leaks over many re-renders.
  - Every new or changed file needs a `?v=` tag in `index.html` (CLAUDE.md rule; GitHub Pages caches).
  - Worth adding a 20-line `tests/loadorder.js` (as mesh and sweep have) in stage 2.
- **WebGPU and workers:**
  - Solvers run on the shared WebGPU device (`11`) and two worker pools (`16e` buckling, `17c` voxel / flow-link pool, which `importScripts` named files). Sweep's geometry worker loads a fixed file list (`62` 672).
  - No UI file may join those lists or be loaded by a worker. Don't rename `13*–17c`, `19g`, `19h`.
  - Solver files must not gain DOM access at load: the node validators eval `13`–`17c` with `document.getElementById → null`.
  - Liquid widgets share one WebGL context. Lab already holds 3 tile contexts plus the stiffness surface, crush cubes and Atlas views (Chrome caps live contexts at 16). The Atlas opening over the cards with all of them alive is the case to test.
  - Widget animations run on rAF beside GPU submission. The on-demand loop (§7) is what frees the GPU during solves; check solve time vs `main` once on the RTX (one 64³ elastic run, Matt's machine).
  - `labPaintRunLock` (Run all greyed during a sweep) must survive the progress button.
- **Tests and checks that read the UI or slice files:**
  - `validate-ui-fixes.js` (console paste) reads `.vp-gimbal`, `LAB_RM_REGISTRY`, `GRID_STATE.N`, `DESIGN_PALETTE`. Keep them.
  - `proto/geom-views/curvature_check.js` slices `21-raymarcher.js` by `function <name>` up to `\n}\n` (`labBakeCurvature`, `labBakeCompDistance`, `labBakeCompCurvature`). Render-cost edits to `21` must keep those as top-level functions.
  - CRLF files: `50-controls.js`, `30-view-tabs.js`, `22-stiffness-viz.js`, `16b`. Keep their line endings.
- **Parity harnesses with Sweep** (F13LD.sweep `tests/parity/`):
  - `solversync.js` requires `10-hardware.js`, `11`, `12`, `12b`, `14a`, `16a`, `16b`, `16g`, `16i`, `17b` byte-identical to `solver/lab/`. `10-hardware.js` writes `#hardwarePill`, `#hardwarePillVal` and `#solverPill`. **Keep those three ids** in the new footer and chip: the file can't change without re-syncing Sweep.
  - `geomsync.js` slices `F13LD-GEOM-*` blocks between markers in `60-add-design.js` (TPMS-PRESETS, RECIPE), `13-kernels.js`, `13b-kernels-new.js` and `14-rasterizer.js`, and copies `13d-foam-kernel.js` whole. UI edits in `60` stay outside the markers.
  - Run `node tests/parity/geomsync.js ../f13ld.lab` and `solversync.js` from a Sweep checkout before shipping. Sweep is not cloned on this machine.
- **Recipe routing:**
  - `labRecipeInfo` / `labRecipeFromJson` sit inside `F13LD-GEOM-RECIPE` (`60` 218–533) and route on `meta.tool` (`noise-scaffold-explorer`, `grain`, `beam`, `beam-builder`, `f13ld.foam`) and on structure. Nothing in this plan touches them.
  - New paste / drop of `.json` must call the existing `ingestDesignFile` → `normalizeDesignJson`, and `isImportDesignJson` for saved STL cells. The page drop handler in `61` already takes `.stl`; extend it, don't add a second one.
  - Replacing `alert` / `prompt` (F13) must keep the same refusals (3-design limit, unknown noise type).
- **Shared blocks:**
  - `◐ view` (`20c-f13-shade.js`) is byte-identical across the suite: style it from outside, mount its checkboxes via `viewMenu`.
  - The ⬡ Mesh button markup is stamped across the suite.
  - The splash script is inline in `index.html`.
- **Layout:**
  - Moving the drawer into a docked pane changes the card width (460 → ~335 px at 1440).
  - Cards re-render on resize (150 ms debounce) and tiles resize their buffers. The breakpoint change must not fire `renderDesignGrid` on every sheet drag: hook `F13UI.onResize` to mark tiles dirty, not to rebuild the grid.
  - Twelve existing breakpoints need folding into the template's 899 px plus the card-column rule.
  - The Crush merged view and Flow charts (Plotly) need `Plots.resize` on section / sheet changes.
- **Accent near red data:** see §6. Errors never by red alone.
- **CPU:** the help drop-in and widgets must add no idle loops (`Liquid.animator` only). The idle target after stage 4 is 0 rAF; today it is 381 / s.
- **Headless checks:** CLAUDE.md asks for none; the stage checklists need them. Each stage should run them only on the lead's or Matt's instruction, one browser, real GPU, no long solves.

## Decisions for Matt

- **Accent:** L 0.80 at the Lab hue is almost Noise's coral (ΔE 0.03). Use `oklch(0.74 0.15 22.3)` (`#fb817f`), same hue, as far from Noise as Noise is from Wave? *Recommended: yes.*
- **Layout:** replace the slide-up Configure drawer and the dock tags with the docked control pane on the right (Model, Physics), cards 3 across in the remaining width? *Recommended: yes (mesh precedent; ends the drawer covering the metrics).*
- **Physics:** one Physics section with five folds (toggle + summary in each header) instead of one section per mode? *Recommended: folds.*
- **Phone:** one design's tile at a time (A / B / C switch) with all metrics in a Results table in the sheet? *Recommended: yes.*
- **Export PDF** is a stub that opens an alert. Hide it until the report exists? *Recommended: hide.*
