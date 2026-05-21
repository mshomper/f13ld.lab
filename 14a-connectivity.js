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
