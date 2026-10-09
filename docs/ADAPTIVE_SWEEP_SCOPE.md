# F13LD.lab — Adaptive sweep and surface equations

**Status:** Approved (Matt, 2026-10-09; decisions in the log at the end). Phase 0 not started.
**Written against:** v0.26.0 (main `0a5fa1c`), 2026-10-09

## Goal

1. Cut the solve count for two-parameter sweeps by roughly 60–75% by solving a coarse grid and interpolating the rest.
2. Fit a readable closed-form equation to each sweep's results surface, starting with stiffness and then yield, shown inside F13LD.lab beside the 3D surface plot.
3. Back both claims with a validation study that can become a metamaterials paper.

## Accuracy targets

| Where | Interpolation error vs full solve |
|---|---|
| Whole surface (median) | 2% or less |
| Peaks and valleys | 5% or less (proposed; editable) |
| Location of a peak or valley | Within one original grid step |

A family that meets these targets is marked "safe to sweep coarsely." One that misses them always runs the full grid.

---

## Phase 0 — Validation study (ground truth)

Run full-resolution grids first, then pretend most of the points were never solved and check the estimates against them.

- **Grid:** 17 × 17 per family (289 solves). 17 is one more than a power of two (16 + 1), so every coarse level keeps both ends of each parameter range: every other point gives 9 × 9 (81 solves), every fourth point gives 5 × 5 (25 solves). An even count would leave the far edge off the coarse grid, forcing extrapolation there instead of interpolation.
- **Families and parameter pairs (decided):** each family sweeps one axis that mainly drives density and one that mainly changes shape, so the fit can separate "how much material" from "where it goes."

  | Family | Density axis | Shape axis | Why this pairing | In the sweep builder today? |
  |---|---|---|---|---|
  | TPMS sheet (gyroid) | Sheet half-thickness (`wallThickness`) | Level offset (`offset`; sheet shifted off the minimal surface, making the two channels unequal) | Classic stretch-leaning family; the offset is the main shape knob a designer actually uses | Yes, both |
  | TPMS skeletal (gyroid) | Level (`offset`) | Blend weight toward diamond | Same base surface as the sheet, so sheet vs skeletal is a clean comparison; the blend tests a smooth change in topology | **No shape axis.** Skeletal exposes only its level. A blend needs a new recipe field in both F13LD.tpms and the lab (recipe parity), so this waits on Matt's call |
  | Custom beam (BCC) | Strut radius scale (`radius_scale`) | Node ball radius (`node_ball_radius`; extra material at the nodes) | Classic bending-dominated family; thickening the nodes stiffens them and shifts the exponent. Replaces "node taper," which the beam recipe does not have | Yes, both (new beam schema) |
  | Spinodoid (single direction) | Half-width (`half_width`, sheet mode) | Direction concentration (`field.kappa`; low = isotropic, high = strongly aligned) | The spinodoid generator uses a von Mises–Fisher spread around one principal direction, so concentration plays the role of the cone angle. One principal direction gives transversely isotropic results, which exercises the symmetry detection | Half-width yes; **concentration needs a catalog entry** (the recipe field already exists, so recipe parity is unaffected) |

  All four use cubic cells. Density axes span roughly 10–40% volume fraction, run at the 64 grid with partial-volume voxels on.
- **Why no cell-size axis:** uniformly scaling cell size does not change homogenized stiffness, so it would only add a flat direction to the surface.
- **Spinodoid seed (decided):** one fixed seed (`field.rng_seed`) for the whole sweep. The seed changes the surface itself, so it is held constant and not studied here.
- **Run order (yield is the long pole):**
  1. Elastic stiffness, full 17 × 17, all four families (about 50–100 minutes each). Validates the stiffness interpolation and the anisotropy-aware fit.
  2. Time the three-axis crush on one design per family.
  3. Yield ground truth on two families first, TPMS sheet and spinodoid (cubic vs transversely isotropic, the widest contrast). The other two follow if time allows.
- **Interpolation methods compared:**
  - Bilinear (straight lines between points)
  - Bicubic (smooth curves through points)
  - Density-guided: volume fraction is known exactly at every point from the voxels, so stiffness is interpolated against volume fraction on log scales. Expected to win, because most of the stiffness change follows density.
- **Reported for each family and method:** median, 95th-percentile and maximum error; error at each peak and valley; how far each peak or valley moved.
- **In the lab:** an error heat map view of the surface (solved minus estimated), plus the numbers in the sweep CSV.

## Phase 1 — Adaptive sweep mode

A toggle in the sweep builder, off by default until Phase 0 passes.

1. **Geometry pre-pass on the full grid.** Voxelize every design and record volume fraction, island count and thinnest feature. No solves. Voxelization time at 64 and 128 needs a quick timing check on your GPU, since this pass touches every design.
2. **Pass 1:** solve every other point on both axes.
3. **Flag cells for refinement** when any of these is true between neighbors:
   - Any independent stiffness constant, or yield on any axis, changes direction (a peak or valley sits between them)
   - A solved point sits off the curve its neighbors predict by more than the target
   - The design switches between yield-limited and buckling-limited
   - Geometry jumps: island count changes, or thinnest feature drops below the grid's reliable size
4. **Pass 2:** solve the in-between points in flagged cells only.
5. **Pass 3** (ships in Phase 1, toggle in the sweep builder): go finer than the original step size around a peak or valley to pin down its location.

**Stiffness-guided yield sampling.** Because yield is the expensive solve, the adaptive mode runs stiffness first (cheap) and uses it to decide where yield needs refining. Yield is solved only on the coarse grid, plus cells where stiffness, geometry, or the yield-to-buckling switch flagged something. This is where the adaptive mode saves the most time, and it is worth testing as its own claim in Phase 0: how well does a stiffness-driven refinement map predict where yield interpolation fails?

**Pre-commit summary:** "Pass 1: 81 solves. Refinement: up to N more. Full grid would be 289."

**Results handling:**
- Every row carries a source column, solved or estimated, added at the end of the CSV so existing readers do not break.
- In the Atlas and the 3D surface, estimated points are drawn hollow and solved points solid.
- Version bump on merge.

## Phase 2 — Surface equations

Lives in F13LD.lab, under the 3D surface plot.

**Two-stage fit:**

1. **Geometry:** volume fraction as a smooth function of the two parameters. The data is exact, so this fit should be near-perfect.
2. **Mechanics, anisotropy-aware.** The fit targets the stiffness matrix, not a single modulus.
   - **Detect the symmetry** from the solved matrices: cubic (3 independent constants), transversely isotropic (5) or orthotropic (9). Only the independent constants are fitted. TPMS sheet and skeletal on cubic cells should come out cubic; spinodoid and custom beam will usually be orthotropic or transversely isotropic.
   - **Each constant gets its own Gibson–Ashby-style law:**

     constant / solid stiffness = C × (volume fraction)^n

     with C and n varying smoothly with the second parameter.
   - **Directional stiffness anywhere:** the lab's directional stiffness surface is rebuilt from the fitted constants, so it can be drawn for designs that were never solved.
   - **Anisotropy map:** for cubic families, the Zener ratio (1 means isotropic) as its own surface over the two parameters. Other families get the ratio of stiffest to softest direction.

**Why this form:** each exponent has physical meaning. Near 1 means stretch-dominated; near 2 means bending-dominated. With one exponent per constant, a family can show up as stretch-dominated in compression but bending-dominated in shear, and a map of that across the design space is a result on its own. A plain polynomial fit cannot give that.

**Yield (second):** v1 fits uniaxial yield along each of the three principal axes, from the crush run on all three axes, each with its own density law. A full multiaxial yield surface is a later step.

**Piecewise where needed:** if the surface crosses a yield-to-buckling switch or a disconnection boundary, fit each side separately and report the boundary line.

**Shown in the lab:**
- The equation, typeset, with fitted constants and the parameter range it is valid for
- Median and maximum fit error
- A residual overlay on the 3D surface (where the equation misses)
- Copy buttons: plain text, spreadsheet formula, Python
- A warning that the equation is not valid outside the swept range

## Phase 3 — Paper material

Figures the lab should be able to export directly:
- Error heat maps per family and method
- Solves saved vs error (one curve per family)
- Map of exponent n across each family's design space
- Table of fitted equations, constants and errors
- Reproducibility: the existing permission to run F13LD.lab to verify published results covers this.

A proper literature search comes before any novelty claim in the abstract. The individual pieces (density power laws, design-of-experiments maps of TPMS parameters) exist; the combination of validated adaptive sampling, an error budget, and interpretable per-family equations in an open tool is the likely gap.

---

## Open questions

- TPMS skeletal shape axis: add a gyroid-to-diamond blend to both F13LD.tpms and the lab, or pick a different second family with two knobs already exposed?
- Add the spinodoid direction concentration to the sweep builder's parameter list (small change, no recipe change)?

## Decisions log

- 2026-10-09: families are TPMS sheet, TPMS skeletal, custom beam, spinodoid; 17 × 17 ground truth; pass 3 ships in Phase 1; equations are anisotropy-aware.
- 2026-10-09: parameter pairs left to Claude (table in Phase 0); spinodoid seed held constant, since it changes the surface itself; yield is the long pole, so stiffness runs first on all four families and yield ground truth starts with two.
- 2026-10-09: scope approved and filed in the repo. Checked against the v0.26.0 sweep builder: beam taper replaced with node ball radius; spinodoid cone angle mapped to direction concentration; skeletal blend and spinodoid concentration are not exposed yet (open questions above).
