# F13LD.lab — session recap, 2026-10-11 · v0.26.2 noise revision 2

**Main:** v0.26.2. One release across F13LD.noise v0.12.0, F13LD.mesh v0.9.9, F13LD.sweep v0.29.4, F13LD.vault v0.8.1 and F13LD.ingest v0.11.0. The spec and the checks: `f13ld.noise/docs/NOISE_REV2.md`.

## Why
The `F13LD-GEOM-NOISE` block (`13-kernels.js`, shared byte-for-byte with Sweep and Vault) was a copy of F13LD.noise's CPU code. That code had a simplex lattice error: the gradient index used a truncated 1/7, and the fold test `h <= 0` flips with rounding on 7 of the 49 gradients. As a result, Lab solved a different field from the one the tool previewed: 9–23 % of voxels differed for every simplex-based type at default settings, and the raw range came out ±4.5 instead of ±1.

## What shipped (v0.26.2)
- `NoiseKernel._readField` reads `surface.noise_rev` into `params.noiseRev` (1 when absent). `_sampleRaw` sets `_rev2`, and the revision decides:
  - gradient index — rev 1 truncated 1/7; rev 2 exact integer mod 49 / 7;
  - gradient fold — rev 1 `h <= 0`; rev 2 `|4x−13| + |4y−13| ≥ 14`;
  - Worley cell seed — rev 1 float `hash33`; rev 2 `_pcg3` (PCG3D integer hash, top 24 bits);
  - warp displacement — rev 1 all octaves; rev 2 min(octaves, 2).
- A revision other than 1 or 2 throws (`NOISE_REV_LATEST = 2`).
- `noiseFieldKey` appends the revision only for rev 2, so `norm_for` stamps written before this release still match.
- The import note says when a recipe is legacy revision 1 (it builds as before; F13LD.vault takes revision 2 only).

## Checks
- F13LD.sweep `tests/parity/geomsync.js`: the block is identical in Lab, Sweep and Vault.
- F13LD.sweep `tests/parity/noise-legacy.js`: 19 F13LD.noise v0.11.0 recipes build the same voxels as before; revision 2 agrees Sweep ≡ Lab exactly and Mesh within 0.09 %.
- F13LD.sweep `tests/parity/parity.js` (all families): PASS.

## Notes
- Lab results for revision-1 noise designs can't be pushed to Vault: Ingest refuses the design, and its Lab rows are dropped with it.
- Any future change to the noise field is a revision 3, made in this block, in F13LD.mesh's `worker/m10-noise.js` and in F13LD.noise in one release.
