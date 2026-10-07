# F13LD.lab — Partial-Volume Voxels (v0.19.0)

**Status:** Shipped, **on by default** (Matt, 2026-10-07, after the GPU check in §2). Stiffness only; crush, buckling and connectivity always use the 0/1 cube. The 0/1 cube stays selectable for reproducing earlier results, including the PI-TPMS paper.
**Written:** 2026-10-07
**Goal:** Cut the staircase error that makes thin walls and struts read low at N = 32–64 (11–14 % at N = 64 on the PI-TPMS paper runs, `SWEEP.md` §8).

---

## 1. What it does

Each voxel the surface passes through gets its **true solid fraction**, and the stiffness solve blends void and solid stiffness by that fraction (simple Voigt mixing).

- **Finding surface voxels.** `buildVoxelMargin` (`14-rasterizer.js`) evaluates, at the N³ voxel corners, the same continuous quantity `buildVoxels` thresholds (a margin m, with solid where m > 0). Every mode is mirrored: solid, shell, anisotropic shell, PI-TPMS (normalized or raw), noise and grain. A voxel whose 8 corners disagree in sign is a surface voxel.
- **Measuring the fraction.** `voxelFractionsFromMargin` evaluates the margin exactly at 4³ points inside each surface voxel (3³ at N ≥ 128) and counts the solid ones.
  - Voxels whose corners all agree keep their 0/1 value, so features thinner than a voxel are never lost.
  - The island trim is respected: a trimmed voxel stays 0, and a void voxel with no kept solid neighbour stays 0.
- **Stiffness.** The GPU stiffness kernel (`LOCAL_STRESS_FULL_WGSL`, helper `pvC`) and the CPU reference (`16a`) use solid stiffness at 1, void at 0, and blend linearly between. Binary designs are unchanged bit for bit.
- **Density.** `rho` becomes the fraction-weighted solid; `rho_binary` keeps the 0/1 count.

Settings: **Surface voxels** pill in the run controls, and **Surface voxels** in the sweep run settings. Sweep CSV columns: `partial_volume`, `vf_partial_pct`.

---

## 2. Results

### 2.1 GPU, N = 32 / 64 / 128 (Matt's RTX, 2026-10-07 — the deciding check)

`runPartialVolumeCheck()`: ν 0.3, void 1e-6, tolerance 1e-5, island trim on. Ex ÷ E solid, with the change from the previous grid in brackets.

| Design | 0/1 cube: 32 → 64 → 128 | Partial volume: 32 → 64 → 128 |
|---|---|---|
| A4m (PI) | 0.00341 → 0.00457 → 0.00498 (+9 %) | 0.00559 → 0.00534 → 0.00532 (−0.5 %) |
| C4 (sheet) | 0.1607 → 0.1826 → 0.1859 (+1.8 %) | 0.1927 → 0.1893 → 0.1890 (−0.2 %) |
| D7 (skeletal) | 0.00217 → 0.00261 → 0.00289 (+11 %) | 0.00311 → 0.00307 → 0.00305 (−0.5 %) |

**What it shows:**
- **Partial volume is grid-converged by N = 64**: within 0.5 % of its N = 128 value on all three designs. The 0/1 cube is still climbing 2–11 % between 64 and 128.
- As the grid refines, partial voxels shrink to a small share of the grid (1.4–4.7 % at 128), so both methods head to the same limit. Partial volume is simply there already.
- Taking partial volume at 128 as the reference, the 0/1 cube reads **−6 / −2 / −5 %** at 128 and **−14 / −3 / −15 %** at 64 (A4m / C4 / D7).
- Ez behaves the same (A4m: partial volume 0.001358 → 0.001346, −0.9 %).

**Correction of §2.2.** The CPU comparison below judged partial volume against an order-2 extrapolation of the cube, and so concluded it "reads high". The cube converges more slowly than order 2 on these designs: D7's measured order from 32 / 64 / 128 is about 0.6. That put the reference low. The extrapolated stiffnesses in `SWEEP.md` §8–§9 are therefore probably a few percent low, most on the skeletal designs. Matt decided to leave the paper as is.

### 2.2 CPU reference, N = 32 / 64 (first look)

**Solid fraction** (vs the 0/1 count at N = 256):

| Design | 0/1 cube, N = 32 | Partial volume, N = 32 | 0/1 cube, N = 64 | Partial volume, N = 64 |
|---|---|---|---|---|
| A4m (PI) | −1.2 % | −0.2 % | −0.7 % | 0.0 % |
| C4 (sheet) | −4.0 % | +0.3 % | +0.3 % | 0.0 % |
| D7 (skeletal) | −0.6 % | +0.1 % | −0.8 % | 0.0 % |
| A1 (thin PI) | +15.2 % | +0.1 % | +2.8 % | 0.0 % |

The CPU stiffness values match the GPU table in §2.1 (same designs and settings).

**Cost:** the extra rasterization is one more pass over the voxel corners plus 64 samples per surface voxel (3–10 % of the grid at N = 64; 27 samples at 128). On Matt's machine it is under 1 s at N = 64 except PI-TPMS (2.7 s), and 0.5–8 s at 128 (PI-TPMS 7.7 s), on the main thread. Moving it into the geometry worker is a follow-up. CG iterations roughly double (about 450–740 vs 210–320 over six load cases at N = 64), because partial voxels add intermediate stiffnesses.

---

## 3. What was tried and set aside

- **Trilinear fractions from the corners only.** Fast, but read tubes and struts 4–5 % light at N = 32. A tube's margin is cone-shaped, and interpolating it between corners under-fills the tube. Replaced by exact sampling.
- **Laminate composite voxels** (Kabel, Merkert & Schneider 2015). Each partial voxel was treated as a two-layer solid / void laminate across the local wall normal: stiff along the wall, nearly free across it. This is the standard refinement of simple mixing.
  - It **does not converge with the lab's CG**: normal load cases hit the 3000-iteration cap at N = 16, where the plain cube needs 69.
  - The CG used here (Zeman et al. 2010) relies on every voxel's stiffness being a scaled copy of the reference medium. The 0/1 cube and the Voigt blend both satisfy that; an anisotropic laminate voxel doesn't, which makes the operator non-symmetric.
  - Projecting the laminate to the nearest isotropic stiffness converges, but reads as low as the plain cube (−27 % / −31 % / −15 % at N = 32), because it throws away the along-the-wall stiffness that matters.
- **If ever needed:** a non-symmetric Krylov solver (BiCGSTAB or GMRES) on the same operator, then the laminate voxels. The laminate formulas are standard: in-plane strains and out-of-plane stresses continuous across the layers, giving a transversely isotropic 6×6 built from the layer averages of 1/M, λ/M, M − λ²/M (M = λ + 2μ), 1/μ and μ.

---

## 4. Checking it on your GPU

In the browser console, run `await runPartialVolumeCheck()`. It takes about 2 minutes and covers A4m, C4 and D7 at N = 32, 64 and 128, with the cube and with partial volume. The reference is partial volume at 128. The check passes when partial volume changes by less than 1 % between 64 and 128.

---

## 5. Sources

- Kabel, Merkert & Schneider (2015), Use of composite voxels in FFT-based homogenization, *CMAME* 294:168–188.
- Lucarini, Cobian, Voitus & Segurado (2021), Adaptation and validation of FFT methods for homogenization of lattice based materials — https://arxiv.org/abs/2110.00733
- Zeman, Vondřejc, Novák & Marek (2010), Accelerating a FFT-based solver for numerical homogenization of periodic media by conjugate gradients, *J. Comput. Phys.* 229 — https://arxiv.org/abs/1004.1122
