# F13LD.lab — STL Unit-Cell Import (Scope)

**Status:** Scoped, not started. Work on it as time permits.
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
| `13-kernels.js` | New `ImportKernel` in `KERNELS`. `parseRecipe` pulls the grid by hash; `evaluate` does periodic trilinear sampling, positive inside to match the TPMS sign convention |
| `14-rasterizer.js` | None expected. `buildVoxels` calls the kernel as usual; shell and PI modes do not apply to imports |
| New `14c-stl-import.js` (+ worker) | STL parsing, scanline voxelizing, distance transform, face-match / spanning / thinnest-wall report |
| `60-add-design.js` | Import dialog, settings, report card, add-to-lab |
| `00-mock-data.js` | IndexedDB store for grids; export and import of the embedded grid |
| `16e` buckling worker, and any other worker that rebuilds voxels | Workers can't see page memory. Either attach the grid to each job message (transferable buffer) or have the worker read IndexedDB by hash. **Attaching is simpler and recommended** |
| `40-design-grid.js`, `index.html` | "Imported" family label; hide TPMS-only controls (shell, PI, normalization); show the wall offset slider |

### 3.4 Limits for version 1

- **Cubic cells only.** Solvers assume equal spacing on all three axes. A cell with unequal sides (say 4 × 4 × 6 mm) has two options, both later work:
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

## 6. Decisions to make before starting

- Should cell size default to the largest bounding-box side, or should the user always type it in?
- Is a wall-thickening/thinning slider on imported cells worth having in version 1?
- Do you expect cells with unequal sides (for example stretched cells for directional stiffness) often enough to plan for them in version 1, or can they wait?
- Should an exported imported design carry its geometry inside the file, so it can be shared and reloaded anywhere?
- What face-match threshold should block a run outright, if any, rather than just warn?
