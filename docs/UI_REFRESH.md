# F13LD.lab — UI refresh log

| Stage | Date | Branch | Commit | Checks | Open decisions |
|---|---|---|---|---|---|
| 1. Audit | 2026-11-26 | `ui-refresh` (from origin/main 52174e1) | see `git log` ("stage 1 audit") | 28 screenshots 1440/1024/700/390 on the real GPU (WebGPU headless, D3D11); 278 controls mapped; idle draws 381/s; 9 px horizontal scroll at 390 | none, all answered below. See `docs/UI_AUDIT.md` |

## Decisions (Matt, 2026-11-26)

Shared with waves 1–2 (answered once for all tools): render quality automatic, with no manual preview quality; bake fixed and erring precise; low-res preview while dragging only if it doesn't slow things down; clear analysis results when the design changes; add missing help cards; hit areas never overlap; slider-head value and (i) stay ~28 px. From the mesh click test: one progress bar per long job (stage and time left on the button, Cancel beside it), and compact panels (folds with summaries, one-line X/Y/Z rows).

This tool:
- **Accent:** `oklch(0.74 0.15 22.3)` = `#fb817f`, brand stroke `#8C2A2E` hue at L 0.74. L 0.80 (`#fda19d`) collides with Noise's coral. Errors always carry the amber mark plus words, never red alone.
- **Layout as proposed:**
  - The Configure drawer becomes a docked control pane on the right with sections 01 Model and 02 Physics. Physics has five folds (Elastic, Buckling, Crush, Thermal κ, Flow), each with its run toggle and a one-line summary.
  - Run all sits in the footer as one progress bar with Cancel. The dock tags and duplicate switches go.
  - Cards, Sweep, Atlas and Import stay as they are and get tokens, widgets and 44 px targets.
  - On phone, one design at a time (A / B / C switch) with a Results table in the sheet.
- **Export PDF stays visible** (Matt), even though it is still a stub.
- **Checks:** Matt allows short headless checks on his real GPU (D3D11, WebGPU) for this refresh, despite the CLAUDE.md rule. No SwiftShader, no long solver runs.
- **Results clearing:** as in the audit. A result hides when its per-mode signature no longer matches the settings; the data stays cached, so switching back shows it again.
