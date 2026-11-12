# 0012 Which measure should 'thinnest wall' and 'tightest gap' use, now that the sweep's measure reads the thickest place on smooth TPMS?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: solver, data-model
- Builds on: 0010
- Settles: thinnest wall measure = local thickness (largest inscribed ball containing each solid voxel, Hildebrand–Rüegsegger / BoneJ Tb.Th style), 5th percentile by volume; tightest gap = the same on the pore space

## Decision

**A: Local thickness, in Lab and the sweep.** Every solid voxel gets the diameter of the largest ball that fits in the solid and covers it (the trabecular-thickness method used by BoneJ). Report the 5th percentile by volume. Pore space the same way for the tightest gap. Replace the sweep's thinnest feature with it.

## Context

Building decision 0010 showed that the sweep's thinnest-feature measure (14d) keeps only local peaks of the distance map. On smooth shapes like Schwarz P those are just the node centres (8 points), so it reports 82.5 of 96 voxels (4.3 mm in a 5 mm cell) instead of the neck. It works on even struts and plates and on rough fields (spinodoid 2.5 voxels). The textbook maximal-ball test overshoots the other way (387,000 points, 5th percentile 3.3 voxels from surface noise). The sweep CSV column thinnest_feature and the sweep builder's 'by thinnest feature' already use the flawed number.

## Options

### A: Local thickness, in Lab and the sweep (chosen) (recommended)

Every solid voxel gets the diameter of the largest ball that fits in the solid and covers it (the trabecular-thickness method used by BoneJ). Report the 5th percentile by volume. Pore space the same way for the tightest gap. Replace the sweep's thinnest feature with it.
- Pro: The standard measure for bone and scaffolds; reads the neck on Schwarz P.
- Pro: Lab and Sweep keep one definition, as decision 0010 intended.
- Con: Sweep CSV thinnest-feature values change for smooth designs (they were wrong); 'by thinnest feature' sweeps step differently.
- Con: Heavier: about 1 to 3 s per design at 96³, in the background on the pool.
- Effort: About one session more: new function in 14d, a check against plates, struts and a Schwarz P neck measured analytically, sweep columns re-labelled in the notes.

### B: Local thickness in Lab only

Same measure as A on the Geometry tiles; the sweep keeps its current number until a separate round.
- Pro: No change to sweep results in this release.
- Con: Two different 'thinnest' numbers in Lab until the sweep is fixed; the sweep keeps a known-wrong value.
- Effort: About one session.

### C: Straight-through chord, matching the colour map

Report the 5th percentile of the along-the-normal thickness the Wall thickness and Pore size views draw (option B of 0010).
- Pro: Matches the reddest spot on screen.
- Con: Not a standard measure; reads thin at grazing angles; sweep still unfixed.
- Effort: About 1.5 sessions.

## Recommendation

A (lean). It is the established thickness measure, it fixes a wrong number already in sweep results, and it keeps the one-definition promise of 0010.
