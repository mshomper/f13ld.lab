# F13LD.lab — STL Unit-Cell Import (Scope)

**Status:** Implemented as v0.9.0 on branch `stl-import` (2026-09-30). Decisions in §6, what was built in §7, validation results in §8.
**Written against:** v0.8.2 (main `a7eb5b4`), 2026-09-30
**Goal:** Let a user import a unit cell from any CAD program as an STL, and run every lab solver on it (stiffness, crush, buckling) exactly as on a native F13LD recipe.
**Out of scope:** Whole parts and non-repeating specimens. Those need a different test setup (platens and loaded faces), not an import.

---

## 1. Why this is mostly a front-end job

Every solver already runs on a plain voxel cube. The recipe is used only once, when the cube is built:

```
 TODAY
 recipe ──► kernel.evaluate(x,y,z) ──► buildVoxels(N) ──► solid/void cube ──► solvers
                    │                                                        (stiffness,
                    └──► viewer bakes a 3D field texture                      crush, buckling,
                                                                              connectivity,
                                                                              density)
 WITH IMPORT
 STL ──► voxelize ──► signed-distance grid (stored) ─┐
                                                     ▼
                              "import" kernel: evaluate(x,y,z) = sample grid
                                                     │
                     same buildVoxels, same solvers, same viewer path, unchanged
```

The key idea is to turn the STL into a **signed-distance grid** once, at import. A new `import` family sits beside `tpms`, `noise` and `grain`, and its `evaluate()` reads from that grid. Everything downstream stays as it is.

**Unchanged:**
- `buildVoxels` at N = 32, 64 or 128
- stiffness, crush and buckling
- island and network handling
- density
- the viewer's baked field texture
- design cards and the plot

A side benefit: shifting the signed distance up or down thickens or thins every wall evenly. That gives a **wall offset slider** on imported cells for free, useful for density sweeps of a CAD cell without going back to CAD.

---

## 2. What the user sees

1. **Add design → Import STL.** Drop in a file. Binary and ASCII STL are both accepted; OBJ and 3MF could come later.
2. **Import settings** (sensible defaults, all editable):

   | Setting | Default | Notes |
   |---|---|---|
   | Units | mm | inch option; STL files carry no units |
   | Cell size | Largest bounding-box side | Most CAD cells are exported edge-to-edge |
   | Cell origin | Bounding-box minimum corner | Plus the existing phase-shift control to slide the cell |
   | Wall offset | 0 | Thicken or thin all walls |

3. **Import report card**, shown before the design is added:
   - a preview in the existing viewer
   - density
   - **face match** per axis (x, y, z): how closely each pair of opposite faces agrees. Green ≥ 98 %, amber 90–98 %, red < 90 %
   - **spans the cell** per axis: whether the solid forms a continuous network across each direction
   - **thinnest wall**, in voxels at N = 32 and 64, with a recommended grid
   - **mesh health**: triangle count, open edges, a watertight yes/no
4. **Add to lab.** The design card is labeled "Imported · filename" and runs like any other design.

---

## 3. Technical plan

### 3.1 STL → voxels → signed-distance grid (in a worker)

- **Parse:** binary or ASCII STL into a flat triangle array. About 1M triangles is fine in a worker.
- **Inside/outside by scanline fill:**
  - For each column of the grid, intersect the triangles, sort the hits along the column, and fill between pairs.
  - Cost grows with triangles plus columns, not triangles × voxels, so it takes seconds even at 256³.
- **Robustness to imperfect meshes:** run the fill along all three axes and keep the majority vote. This tolerates small gaps and flipped triangles; badly broken meshes are flagged, not guessed.
- **Signed distance:** a periodic Euclidean distance transform of the fine occupancy grid (256³), downsampled to a **128³ master grid**. It is periodic so walls meeting across the cell faces stay continuous.
- **Storage:** the signed-distance grid is quantized to 8 bits, gzip-compressed (typically a few hundred kB), and given a SHA-256 content hash.

### 3.2 Where the grid lives

- **Design list (localStorage):** holds only a small recipe:
  ```
  { family:'import', import:{ hash, name, units, cell_mm, origin, offset, ...report } }
  ```
- **Grid:** stored in **IndexedDB** under its hash. localStorage has a ~5 MB total limit, too small for several imported cells.
- **Exported recipe JSON:** embeds the compressed grid (base64), so a shared file is self-contained. On re-import the grid is restored into IndexedDB.
- **Cache keys:** `recipeFingerprint` already hashes the recipe, and the recipe carries the grid hash, so solver results are cached per geometry automatically.

### 3.3 Code touch points

| File | Change |
|---|---|
| `13-kernels.js` | New `ImportKernel` in `KERNELS`. `parseRecipe` pulls the grid by hash; `evaluate` does periodic trilinear sampling. **Negative inside**: the lab's solid mode keeps voxels where the field is below the offset, so the signed distance is stored negative in solid, in field units (one cell = 2π), and the existing solid-mode `offset` becomes the wall offset |
| `14-rasterizer.js` | None expected. `buildVoxels` calls the kernel as usual; shell and PI modes do not apply to imports |
| New `14c-stl-import.js` (+ worker) | STL parsing, scanline voxelizing, distance transform, face-match / spanning / thinnest-wall report |
| `60-add-design.js` | Import dialog, settings, report card, add-to-lab |
| `00-mock-data.js` | IndexedDB store for grids; export and import of the embedded grid |
| `16e` buckling worker, and any other worker that rebuilds voxels | Workers can't see page memory. Either attach the grid to each job message (transferable buffer) or have the worker read IndexedDB by hash. **Attaching is simpler and recommended** |
| `40-design-grid.js`, `index.html` | "Imported" family label; hide TPMS-only controls (shell, PI, normalization); show the wall offset slider |

### 3.4 Limits for version 1

- **Cubic cells only (2 % tolerance).** CAD export settings typically leave a cubic cell ~1 % off between sides, so sides within 2 % of each other are treated as a cube (longest side is the cell size; the mismatch is shown in the report). Beyond that, version 1 refuses with a clear message. Solvers assume equal spacing on all three axes. A cell with unequal sides (say 4 × 4 × 6 mm) has two options, both later work:
  - stretch it to a cube and warn, which changes the geometry and is not recommended;
  - add unequal voxel spacing to the solvers, which the FFT operator and the finite-element code can both support.
- **Solid/void voxels only.** When partial-volume voxels arrive (queued in NEXT_STEPS), the 2×2×2 sub-samples from the fine grid give each voxel's fill fraction for free.
- **No round trip to F13LD.mesh.** Mesh doesn't know the `import` family. Imported cells stay in the lab unless Mesh later learns to tile a stored grid.

---

## 4. Validation plan

| Test | Pass |
|---|---|
| Export a native Schwarz P and a gyroid sheet from F13LD.tpms / Mesh as fine STLs, import them, and compare with the native recipe at N = 64 | Density within 0.5 %; stiffness within 3 %; buckling within 5 % |
| Simple-cubic strut lattice (three orthogonal cylinders) | Matches the same lattice built natively and the textbook stretch-dominated trend |
| A cell deliberately cut off-period (faces don't match) | Face-match turns amber or red and the warning shows |
| An STL with a hole punched in it | Mesh health reports open edges; the majority vote still gives a sensible solid or refuses clearly |
| Units and origin: the same cell in inches, and offset from the origin | Identical density and stiffness after conversion |
| Two interwoven networks from CAD | The connectivity selector finds 2 networks, and per-network buckling runs |
| 1M-triangle STL | Import finishes in under ~10 s on your machine; the page stays responsive |

---

## 5. Effort and phasing

| Phase | Contents | Rough size |
|---|---|---|
| **1 — Core** | STL parse, voxelize, distance transform, `ImportKernel`, IndexedDB store, workers receive the grid | ~1 focused session |
| **2 — UI and report** | Import dialog, report card (face match, spanning, thinnest wall, mesh health), wall offset slider, export with embedded grid | ~1 session |
| **3 — Validation** | The tests in §4, edge cases, docs | Part of a session |

This can run in parallel with the buckling speed work (Sprint B2); the two don't touch the same code, apart from the buckling worker's job message.

---

## 6. Decisions (Matt, 2026-09-30)

- **Cell size** defaults to the longest bounding-box side and stays editable.
- **Wall offset slider** is in version 1.
- **Unequal sides** wait for a later version. Near-cubic cells (within 2 %, typical of CAD export) are accepted as cubes; anything further off is refused with a message rather than stretched.
- **Exports embed the geometry**, so a shared file reloads anywhere.
- **Face match only warns**, never blocks. Cells below the green band are tagged "not periodic" on their card.
- **Test files:** generated STLs meshed from native recipes for the exact comparisons; Matt supplies a few real CAD STLs for the final check.

---

## 7. As built (v0.9.0)

| File | Role |
|---|---|
| `13c-import-kernel.js` | `IMPORT_GRIDS` registry, `ImportKernel` (`KERNELS.import`), periodic trilinear sampling, `importGridMessage` for workers |
| `14c-stl-import.js` | STL parse, mesh health, cell mapping, three-axis scanline fill with majority vote, face match, periodic exact distance transform (256³), thinnest wall, 128³ master grid; runs in a Blob worker |
| `61-import-stl.js` | Dialog, report card, preview, wall offset slider, IndexedDB store (`f13ld.lab.imports` / `grids`), hydration on load, card pills and buttons, export / re-import with the grid embedded, page-level STL drop |
| `16e-buckling-cpu-worker.js` | Loads 13c; each job for an import design carries the grid (≈2 MB copy); the worker registers it by hash |
| `21-raymarcher.js` | `recipeForDesign` returns null for an import whose grid isn't loaded (SVG fallback, runs skip it) |
| `40-design-grid.js` | Import pills (geometry missing / not periodic / walls ±) and ⚙ ⤓ buttons |
| `60-add-design.js` | `.stl` accepted in the Add Design picker; saved import JSON routed to the async loader |
| `99-init.js` | Restores imported grids from IndexedDB after the first render |

Details that differ from the plan above:
- **Sign:** stored distance is negative inside (the lab's solid mode keeps field < offset). The wall offset is the existing solid-mode `offset`, in field units (`offset = mm × 2π / cell`).
- **Near-cubic cells:** in *fit* mode each axis of the bounding box is mapped to the full cell, so a cell exported 1 % short on one side still meets its periodic neighbor (a gap would have cut every strut crossing that face). The stretch is shown in the report.
- **Cell faces from the trim planes (v0.9.1).** CAD cells trimmed to their box leave many vertices on each trim plane, but walls thickened after trimming overhang the plane slightly (Matt's 5 mm test cell: 0.007 mm, bounding box 5.008–5.014 mm). The importer now takes each face from the most crowded vertex coordinate near each end of the box (falling back to the box when no plane is found), and fills copies of the mesh shifted ±1 cell wherever geometry pokes past a face, keeping the union. The overhang lands on the opposite side, as it would from the neighbouring cell. On Matt's cell this gave exactly 5.000 mm and moved the thinnest wall from a false 0.12 mm (slivers at the faces) to 0.61 mm.
- **Face match (v0.9.1).** Where the solid differs between the two boundary slices (neighbours across the seam), the difference is accepted if the walls at the same spot, within 3 fine voxels (≈ 0.06 mm on 5 mm), also move between neighbouring slices just inside the cell. Score = 1 − (seam differences not explained that way) / solid area at the faces. Bands: green ≥ 95 %, amber 80–95 % (report note only), red < 80 % (card tagged "not periodic"). Clicking a chip shows the two faces overlaid. Versions tried and dropped: v0.9.0 compared slices 3 voxels apart by overlap ratio, which flagged good CAD sheet cells (Matt's: 92–96 %); an exact 2-voxel tolerance band still failed shallow-angle walls (82–92 %); a whole-face change count was too blunt (87 %); and a distance-field continuity score can't see breaks at all, because the periodic distance transform smooths across the seam (the off-period cell scored 100 %).
- **Thinnest wall** is the 5th percentile of 2·d_in − 0.5 over centers of maximal inscribed balls (voxels whose inside distance is at least that of all 26 neighbours, ≥ 2 voxels deep). Simpler ridge tests picked up convex surfaces, the voxel staircase and the diagonal medial sheets at strut junctions. On the wall offset slider it is shifted by 2 × offset (approximate).
- **Storage:** 8-bit grid, clamp ±0.8 field units (13 % of the cell), step ≈ 1/8 of a master voxel. Content hash = SHA-256 of the bytes plus n and R (FNV fallback outside secure contexts). Saved JSON gzips the grid (`CompressionStream`): ~100 kB for a strut lattice, a few hundred kB for TPMS.
- The record in localStorage carries only the hash, settings and a report summary; the recipe carries only `import.hash`.

Not done in v1 (candidates for later):
- `?r=` URL loading of a saved import JSON (file and paste work).
- Pruning old grids from IndexedDB (they are small; nothing deletes them).
- Changing units or cell size after import needs the STL again (it isn't kept).
- The spectral-era "N64 · PRONE" predictor pill also appears on imported cards; the FE grid rule in NEXT_STEPS replaces it.

## 8. Validation (2026-09-30)

Test STLs were meshed from native lab geometries (marching cubes, 160 nodes per cell) with `proto/stl-import/genstl.py`; `proto/stl-import/run_tests.js` reruns everything below.

| Test | Result | Pass |
|---|---|---|
| Schwarz P (444k triangles) vs native, N = 64 | density +0.01 %, 0.09 % of voxels differ; Ex, Ez, Gxy within 0.01 % (CPU reference); buckling zz identical at N = 32 (5,952 MPa) | Yes |
| Gyroid sheet t = 0.3 vs native | density −0.14 %; Ex −0.21 %, Gxy −0.17 % (N = 64); buckling −2.3 % (N = 32) | Yes |
| Simple-cubic strut lattice, r = 0.12 cell | Ez/Es 0.0473 vs strut area fraction πr² = 0.0452 (+5 % from the nodes), Gxy/Es 0.0014 (bending-dominated); thinnest wall 1.16 mm vs 1.20 mm drawn (mesh facets) | Yes |
| Cell cut off-period (80 % of a period) | face match 65 % on every axis → red, card tagged "not periodic" (v0.9.1 test) | Yes |
| Matt's CAD sheet cell (45k triangles, walls overhang the trim planes by 0.007 mm) | v0.9.0: 92.5 / 94.8 / 96.0 % (wrongly flagged). v0.9.1: cell 5.000 mm from the trim planes, overhang wrapped, face match 96.9 / 97.6 / 97.7 % (green, no tag), thinnest wall 0.61 mm | Yes |
| Generated cells after v0.9.1 | Schwarz P, gyroid sheet, lattices, holed mesh, 1 % stretch: 100 % on every axis | Yes |
| 0.25 % of triangles removed | 3,331 open edges reported, not watertight; fill agreement 98 %; density unchanged (0.4998) | Yes |
| Same cell in inches, and moved off the origin | identical density, face match and walls | Yes |
| Two interwoven strut networks | 2 networks, both span x, y and z; per-network FE buckling ran through the browser worker pool | Yes |
| One side 1 % long | accepted, stretched 0.99 %, identical density | Yes |
| One side 3 % long | refused with the sizes shown; *set* cell size then works (part centered) | Yes |
| 1.1M triangles | 10.6 s in a worker (node timing; distance transform ≈ 6.8 s of it) | About at target |
| Browser: import → preview → slider → add → reload → adjust → save JSON → reload JSON | all work; grid restored from IndexedDB after reload; saved JSON 107 kB | Yes |
| GPU elastic run on an imported cell | not verifiable headless (SwiftShader doesn't finish any elastic run, native demos included); the GPU path builds voxels through the same `buildVoxels` | Click-test |

