/* ============================================================
   F13LD.lab · 14a-connectivity.js
   Periodic 6-connectivity flood-fill on the rasterized voxel grid.

   Why this exists
   ---------------
   Disconnected solid islands inside a unit cell:
     · carry no bulk load (sandwiched in the soft phase) — they
       inflate volume fraction without contributing stiffness,
     · do not survive 3D-printing post-processing (loose powder
       washes them out),
     · can push the FFT-CG solver into very-long-iteration regimes
       when the stress field has to thread around acoustically-
       decoupled regions.

   Phase 3's original roadmap flagged connectivity gating as the
   companion to shear LCs: once full-Voigt landed, sparse / low-
   density / disconnected geometries became materially more
   problematic.  This file ships a single helper that the solver
   front-end calls between buildVoxels and the (expensive) Γ build.

   Connectivity definition
   -----------------------
   6-neighbor (face-sharing) with PERIODIC boundary conditions,
   matching the FFT solver's assumption that the unit cell tiles
   infinitely.  An island that touches its own periodic image is,
   correctly, ONE connected component — not two.

   Integration point
   -----------------
   solveDesignElasticFull calls this right after buildVoxels and
   the rho computation, with the following contract:

     · Always runs.  Result surfaces on R.connectivity, propagated
       through mapElasticToResults → d.results.connectivity.
     · Warn-only by default.  Console-logs when largestFraction < 1.
     · Optional rejection: opts.connectivity = { minLargestFraction:
       0.99 } causes the solver to early-return
       { valid: false, reject_reason: 'disconnected', connectivity }
       BEFORE Γ is built.  Off by default — opt in when ready to
       gate production.
   ============================================================ */


/* ────────────────────────────────────────────────────────────
   checkVoxelConnectivity(solid, N)

   Args:
     solid : Float32Array(N3), 0 = void / 1 = solid.  Index
             convention matches buildVoxels: idx = (a*N + b)*N + c.
             Axis labels (xyz vs ijk vs whatever) do not matter
             here — neighbors are computed in index space and the
             topology is the same under any axis relabeling.
     N     : grid resolution (cube voxels per side).

   Returns: {
     numComponents:   int,         // 1 = fully connected; 0 = empty
     sizes:           Int32Array,  // component sizes, sorted desc.
     largest:         int,         // sizes[0], or 0 if empty
     smallest:        int,         // sizes[end], or 0 if empty
     totalSolid:      int,         // sum of all sizes
     largestFraction: float,       // sizes[0] / totalSolid; 1.0 = perfect.
                                   //   Returns 1.0 for empty geometry
                                   //   (no orphans, no components).
     orphans:         int          // totalSolid - largest; voxels NOT
                                   //   in the largest component
   }

   Cost & memory
   -------------
   Time : O(N3) — each voxel pushed onto the stack at most once,
          popped at most once, and decoded only when popped.
   Mem  : Uint8Array(N3) visit map + Int32Array(N3) stack.  Stack
          worst case is total solid count (every voxel queued once);
          in practice frontier is O(N2) for compact components.
          At N=64: ~1 MB total transient.  At N=128: ~8 MB.

   The stack is sized to the worst-case upper bound so a pathological
   geometry (long winding thin filament) cannot overflow.
   ──────────────────────────────────────────────────────────── */
function checkVoxelConnectivity(solid, N) {
  var N3 = N * N * N;
  var visited = new Uint8Array(N3);
  var stack   = new Int32Array(N3);   /* upper bound: every voxel queued once */
  var sizes   = [];

  /* Index decode: idx = (a*N + b)*N + c.
     Strides — a stride = N2, b stride = N, c stride = 1. */
  var SA  = N * N;
  var SB  = N;
  /* c stride is 1 — inlined below */
  var Nm1 = N - 1;

  /* Linear seed scan.  Skipping non-solid or already-visited voxels
     is a single byte read + compare — cheap relative to the BFS
     work.  Solid voxels seen for the first time start a new
     component and trigger a flood-fill. */
  for (var seed = 0; seed < N3; seed++) {
    if (!solid[seed] || visited[seed]) continue;

    /* New component — flood-fill from this seed. */
    var compSize = 0;
    var top      = 0;
    stack[top++] = seed;
    visited[seed] = 1;

    while (top > 0) {
      var idx = stack[--top];
      compSize++;

      /* Decode (a, b, c) from idx.  Only done at expansion time —
         most voxels never decode (they're visited via the cheap
         seed scan and immediately skipped). */
      var a   = (idx / SA) | 0;
      var rem = idx - a * SA;
      var b   = (rem / SB) | 0;
      var c   = rem - b * SB;

      /* Six face neighbors with periodic wrap. */
      var am = (a === 0)   ? Nm1 : (a - 1);
      var ap = (a === Nm1) ? 0   : (a + 1);
      var bm = (b === 0)   ? Nm1 : (b - 1);
      var bp = (b === Nm1) ? 0   : (b + 1);
      var cm = (c === 0)   ? Nm1 : (c - 1);
      var cp = (c === Nm1) ? 0   : (c + 1);

      /* Inlined neighbor indices — no multiplications in the hot
         loop (everything's a stride add). */
      var aRow = a  * SA;
      var bRow = b  * SB;
      var amRow = am * SA;
      var apRow = ap * SA;
      var bmRow = bm * SB;
      var bpRow = bp * SB;

      var n0 = amRow + bRow + c;
      var n1 = apRow + bRow + c;
      var n2 = aRow  + bmRow + c;
      var n3 = aRow  + bpRow + c;
      var n4 = aRow  + bRow + cm;
      var n5 = aRow  + bRow + cp;

      if (solid[n0] && !visited[n0]) { visited[n0] = 1; stack[top++] = n0; }
      if (solid[n1] && !visited[n1]) { visited[n1] = 1; stack[top++] = n1; }
      if (solid[n2] && !visited[n2]) { visited[n2] = 1; stack[top++] = n2; }
      if (solid[n3] && !visited[n3]) { visited[n3] = 1; stack[top++] = n3; }
      if (solid[n4] && !visited[n4]) { visited[n4] = 1; stack[top++] = n4; }
      if (solid[n5] && !visited[n5]) { visited[n5] = 1; stack[top++] = n5; }
    }

    sizes.push(compSize);
  }

  if (sizes.length === 0) {
    /* Empty geometry — no orphans, no components.  Convention: a
       perfectly-fine void.  largestFraction = 1.0 so the threshold
       check doesn't trip on legitimately-empty designs. */
    return {
      numComponents:   0,
      sizes:           new Int32Array(0),
      largest:         0,
      smallest:        0,
      totalSolid:      0,
      largestFraction: 1.0,
      orphans:         0
    };
  }

  /* Sort descending — largest first.  Cheap (typically << 100
     components even on noisy / hyperuniform designs). */
  sizes.sort(function (x, y) { return y - x; });

  var total = 0;
  for (var s = 0; s < sizes.length; s++) total += sizes[s];

  return {
    numComponents:   sizes.length,
    sizes:           new Int32Array(sizes),
    largest:         sizes[0],
    smallest:        sizes[sizes.length - 1],
    totalSolid:      total,
    largestFraction: sizes[0] / total,
    orphans:         total - sizes[0]
  };
}

/* ============================================================
   pruneToLargestComponent(solid, N)
   Keep only the largest periodically-6-connected solid component;
   zero every voxel in smaller islands.  Same periodic flood-fill as
   checkVoxelConnectivity(), but it labels voxels so the largest can be
   isolated.  Returns a pruned copy (same typed-array dtype as `solid`);
   returns the original array unchanged when there is 0 or 1 component.

   Rationale: floating islands (e.g. corner satellites left after trimming
   a cell to a cube) carry no load yet seed spurious low-energy buckling
   modes and Newton divergence in the crush solve.  Pruning them — under
   the SAME periodicity the solvers assume — removes only genuinely
   disconnected material; fragments that wrap-connect into the bulk are
   load-bearing and are kept.
   ============================================================ */
function pruneToLargestComponent(solid, N) {
  var N3 = N * N * N;
  var label = new Int32Array(N3);     /* 0 = unlabeled; component ids start at 1 */
  var stack = new Int32Array(N3);
  var sizes = [0];                    /* sizes[compId]; index 0 unused */
  var SA = N * N, SB = N, Nm1 = N - 1;
  var comp = 0;

  for (var seed = 0; seed < N3; seed++) {
    if (!solid[seed] || label[seed]) continue;
    comp++;
    var compSize = 0, top = 0;
    stack[top++] = seed; label[seed] = comp;
    while (top > 0) {
      var idx = stack[--top]; compSize++;
      var a = (idx / SA) | 0, rem = idx - a * SA, b = (rem / SB) | 0, c = rem - b * SB;
      var am = (a === 0) ? Nm1 : a - 1, ap = (a === Nm1) ? 0 : a + 1;
      var bm = (b === 0) ? Nm1 : b - 1, bp = (b === Nm1) ? 0 : b + 1;
      var cm = (c === 0) ? Nm1 : c - 1, cp = (c === Nm1) ? 0 : c + 1;
      var aRow = a * SA, bRow = b * SB, amRow = am * SA, apRow = ap * SA, bmRow = bm * SB, bpRow = bp * SB;
      var n0 = amRow + bRow + c, n1 = apRow + bRow + c, n2 = aRow + bmRow + c,
          n3 = aRow + bpRow + c, n4 = aRow + bRow + cm, n5 = aRow + bRow + cp;
      if (solid[n0] && !label[n0]) { label[n0] = comp; stack[top++] = n0; }
      if (solid[n1] && !label[n1]) { label[n1] = comp; stack[top++] = n1; }
      if (solid[n2] && !label[n2]) { label[n2] = comp; stack[top++] = n2; }
      if (solid[n3] && !label[n3]) { label[n3] = comp; stack[top++] = n3; }
      if (solid[n4] && !label[n4]) { label[n4] = comp; stack[top++] = n4; }
      if (solid[n5] && !label[n5]) { label[n5] = comp; stack[top++] = n5; }
    }
    sizes.push(compSize);
  }

  if (comp <= 1) return solid;        /* empty or already fully connected */

  var best = 1, bestSize = sizes[1];
  for (var ci = 2; ci <= comp; ci++) { if (sizes[ci] > bestSize) { bestSize = sizes[ci]; best = ci; } }

  var out = solid.slice();            /* preserves Float32Array dtype */
  var removed = 0;
  for (var i = 0; i < N3; i++) { if (out[i] && label[i] !== best) { out[i] = 0; removed++; } }
  if (removed > 0) {
    console.log('[prune] kept largest of ' + comp + ' periodic components (' + bestSize +
                ' voxels); removed ' + removed + ' voxel(s) across ' + (comp - 1) + ' island(s)');
  }
  return out;
}

/* ============================================================
   pruneSmallIslands(solid, N, opts)
   Remove only SMALL floating islands; keep every component at or
   above a size threshold.  Unlike pruneToLargestComponent (which
   keeps a single component), this preserves MULTIPLE large
   load-bearing networks — required for the interwoven SDF
   families:

     · bundle : many disconnected-but-parallel fibers, each of
                which spans the cell periodically and carries load
                along its axis.  Largest-only would delete almost
                the entire structure.
     · wave   : frequently resolves into TWO interwoven networks
                (e.g. the two sides of a cymatic nodal surface);
                both percolate and both are load-bearing.

   Threshold = max(absFloor, keepFrac · largestComponentSize).
   Components below it are rasterization specks / loose chips and
   are zeroed.  Same periodic 6-connectivity the FFT solver assumes.

   opts: { keepFrac=0.05, absFloor=8 }
   ============================================================ */
function pruneSmallIslands(solid, N, opts) {
  opts = opts || {};
  var keepFrac = (typeof opts.keepFrac === 'number') ? opts.keepFrac : 0.05;
  var absFloor = (typeof opts.absFloor === 'number') ? opts.absFloor : 8;

  var N3 = N * N * N;
  var label = new Int32Array(N3);
  var stack = new Int32Array(N3);
  var sizes = [0];                    /* sizes[compId]; index 0 unused */
  var SA = N * N, SB = N, Nm1 = N - 1;
  var comp = 0;

  for (var seed = 0; seed < N3; seed++) {
    if (!solid[seed] || label[seed]) continue;
    comp++;
    var compSize = 0, top = 0;
    stack[top++] = seed; label[seed] = comp;
    while (top > 0) {
      var idx = stack[--top]; compSize++;
      var a = (idx / SA) | 0, rem = idx - a * SA, b = (rem / SB) | 0, c = rem - b * SB;
      var am = (a === 0) ? Nm1 : a - 1, ap = (a === Nm1) ? 0 : a + 1;
      var bm = (b === 0) ? Nm1 : b - 1, bp = (b === Nm1) ? 0 : b + 1;
      var cm = (c === 0) ? Nm1 : c - 1, cp = (c === Nm1) ? 0 : c + 1;
      var aRow = a * SA, bRow = b * SB, amRow = am * SA, apRow = ap * SA, bmRow = bm * SB, bpRow = bp * SB;
      var n0 = amRow + bRow + c, n1 = apRow + bRow + c, n2 = aRow + bmRow + c,
          n3 = aRow + bpRow + c, n4 = aRow + bRow + cm, n5 = aRow + bRow + cp;
      if (solid[n0] && !label[n0]) { label[n0] = comp; stack[top++] = n0; }
      if (solid[n1] && !label[n1]) { label[n1] = comp; stack[top++] = n1; }
      if (solid[n2] && !label[n2]) { label[n2] = comp; stack[top++] = n2; }
      if (solid[n3] && !label[n3]) { label[n3] = comp; stack[top++] = n3; }
      if (solid[n4] && !label[n4]) { label[n4] = comp; stack[top++] = n4; }
      if (solid[n5] && !label[n5]) { label[n5] = comp; stack[top++] = n5; }
    }
    sizes.push(compSize);
  }

  if (comp <= 1) return solid;        /* empty or already one component */

  var largest = 0;
  for (var ci = 1; ci <= comp; ci++) if (sizes[ci] > largest) largest = sizes[ci];
  var threshold = Math.max(absFloor, Math.floor(keepFrac * largest));

  /* Count kept components; if everything clears the bar there is nothing to do. */
  var dropped = 0;
  for (var cj = 1; cj <= comp; cj++) if (sizes[cj] < threshold) dropped++;
  if (dropped === 0) return solid;

  var out = solid.slice();
  var removed = 0;
  for (var i = 0; i < N3; i++) {
    if (out[i] && sizes[label[i]] < threshold) { out[i] = 0; removed++; }
  }
  if (removed > 0) {
    console.log('[prune] removed ' + dropped + ' small island(s) below ' + threshold +
                ' voxels (' + removed + ' voxel(s)); kept ' + (comp - dropped) +
                ' component(s) of ' + comp + ' [largest ' + largest + ']');
  }
  return out;
}

/* ============================================================
   pruneVoxels(solid, N, family, opts)
   Family-aware prune dispatcher.  Called by the solvers in place
   of pruneToLargestComponent so each family gets the right policy:

     · beam            → NONE.  A periodic strut lattice fills the
                         cube and is connected through its own
                         periodic images; mesh's cantilever-trim
                         prune does not apply to a bulk RVE.
     · bundle, wave    → pruneSmallIslands.  Keep all large
                         interwoven networks; drop only specks.
     · tpms/noise/grain→ pruneToLargestComponent (unchanged) so the
                         already-validated effective-property
                         numbers are preserved.

   opts is forwarded to pruneSmallIslands (keepFrac / absFloor).
   ============================================================ */
function pruneVoxels(solid, N, family, opts) {
  if (family === 'beam') return solid;
  if (family === 'bundle' || family === 'wave') return pruneSmallIslands(solid, N, opts);
  if (typeof pruneToLargestComponent === 'function') return pruneToLargestComponent(solid, N);
  return solid;
}

/* node/test harness export (browser ignores this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    checkVoxelConnectivity: checkVoxelConnectivity,
    pruneToLargestComponent: pruneToLargestComponent,
    pruneSmallIslands: pruneSmallIslands,
    pruneVoxels: pruneVoxels
  };
}
