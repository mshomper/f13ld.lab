/* ============================================================
   F13LD.lab · 13d-foam-kernel.js  (v0.14.0)
   Field kernel for F13LD.foam — Voronoi / Laguerre-style foams
   (closed cell faces, open cell edges, plateau junctions).

   Ported VERBATIM from F13LD.mesh worker/m25-sdf-foam.js (mesh
   v0.9.2): the FoamSeeds block, buildFoamSDF and buildFoamSDF2 below
   are byte-for-byte copies.  v0.17.3: recipes with geometry.field === 2
   (F13LD.foam v0.6.0+) build with buildFoamSDF2, the exact distance to
   the cell walls / edges; recipes without it build exactly as before.  FoamSeeds is now in THREE places — F13LD.foam
   (index.html), F13LD.mesh and here — and validate-foam.js checks the
   three match.  Edit all three together and bump FoamSeeds.VERSION.

   ── Same family shape as Beam / Bundle / Wave ────────────────
   buildFoamSDF returns a NEGATIVE-INSIDE signed distance in mesh world
   units with the foam topology already folded in, so this kernel is
   registered with rasterizer mode 'solid' (SDF < 0 → solid) and needs
   no new rasterizer or solver branch.

   ── Coordinate convention ─────────────────────────────────────
   One foam tile = mesh's [-5, 5]³ = one lab cell [-π, π]³.
     world = solver · 5/π ;   out = SDF · π/5
   Only periodic foams are valid unit cells; the import refuses the
   others (60-add-design.js), exactly as mesh does.

   ── Lab recipe layout ─────────────────────────────────────────
   The foam tool's own `geometry` block (mode open|closed|plateau,
   thickness, plateau_k, organic, normalize, tile_mm) is kept verbatim
   under recipe.foam, because recipe.geometry.mode must stay 'solid'
   for the rasterizer.  recipe.seeds and recipe.anisotropy are the
   foam tool's blocks unchanged.

   ── Stored seeds vs regenerated seeds ─────────────────────────
   A foam recipe carries every seed position.  Those are used only
   while the generator settings still match the ones that produced
   them (recipe.seeds.positions_for, stamped on import).  When a sweep
   changes cell count, regularity, Lloyd iterations or the random seed,
   the positions are set aside and FoamSeeds regenerates the layout —
   the same code F13LD.foam runs, so the lab builds the foam the tool
   would show for those settings.
   ============================================================ */

// ==== BEGIN FoamSeeds — shared seed generator ================================
// Identical copy in F13LD.foam (index.html) and F13LD.mesh
// (worker/m25-sdf-foam.js). F13LD.mesh tests/foamseeds.js checks the two match
// byte for byte; edit both together and bump FoamSeeds.VERSION.
// Domain is the cube [-5, 5]³. Seeds are [x, y, z] arrays.
const FoamSeeds = (function(){
  'use strict';
  const VERSION = 2;
  const DMIN = -5, DMAX = 5, DSIZE = 10;

  // Mean seed spacing (≈ mean cell diameter) for N cells in the 10³ cube.
  function meanSpacing(N){ return DSIZE / Math.cbrt(Math.max(1, N)); }

  // Deterministic 32-bit RNG so a seed number gives a reproducible layout.
  function mulberry32(seedInt){
    let s = seedInt | 0;
    return function(){
      s = (s + 0x6D2B79F5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function wrap1(v){ return ((v - DMIN) % DSIZE + DSIZE) % DSIZE + DMIN; }
  function minImg(d){ return d - DSIZE * Math.round(d / DSIZE); }

  function genRandom(N, rng){
    const out = [];
    for(let i = 0; i < N; i++) out.push([DMIN + rng() * DSIZE, DMIN + rng() * DSIZE, DMIN + rng() * DSIZE]);
    return out;
  }

  // Bridson Poisson-disk sampling in 3D, run to saturation (maxN is only a
  // safety cap). Background grid cell r/√3 → at most one sample per cell, so
  // the rejection test walks a 5×5×5 block. Periodic: grid wraps, toroidal distance.
  function genPoisson(rmin, maxN, rng, periodic){
    const r2 = rmin * rmin;
    const cellSize = rmin / Math.sqrt(3);
    const gridSize = Math.max(1, Math.ceil(DSIZE / cellSize));
    const grid = new Int32Array(gridSize * gridSize * gridSize).fill(-1);
    const samples = [], active = [];
    const gridLin = (ix, iy, iz) => (ix * gridSize + iy) * gridSize + iz;
    const cellIdx = v => Math.min(gridSize - 1, Math.max(0, Math.floor((v - DMIN) / cellSize)));
    const inDomain = p => p[0] >= DMIN && p[0] <= DMAX && p[1] >= DMIN && p[1] <= DMAX && p[2] >= DMIN && p[2] <= DMAX;
    function tooClose(p){
      const ix = cellIdx(p[0]), iy = cellIdx(p[1]), iz = cellIdx(p[2]);
      for(let dx = -2; dx <= 2; dx++){
        let nx = ix + dx;
        if(periodic) nx = (nx + gridSize * 2) % gridSize; else if(nx < 0 || nx >= gridSize) continue;
        for(let dy = -2; dy <= 2; dy++){
          let ny = iy + dy;
          if(periodic) ny = (ny + gridSize * 2) % gridSize; else if(ny < 0 || ny >= gridSize) continue;
          for(let dz = -2; dz <= 2; dz++){
            let nz = iz + dz;
            if(periodic) nz = (nz + gridSize * 2) % gridSize; else if(nz < 0 || nz >= gridSize) continue;
            const idx = grid[gridLin(nx, ny, nz)];
            if(idx < 0) continue;
            const q = samples[idx];
            let ddx = p[0] - q[0], ddy = p[1] - q[1], ddz = p[2] - q[2];
            if(periodic){ ddx = minImg(ddx); ddy = minImg(ddy); ddz = minImg(ddz); }
            if(ddx*ddx + ddy*ddy + ddz*ddz < r2) return true;
          }
        }
      }
      return false;
    }
    function addSample(p){
      samples.push(p);
      grid[gridLin(cellIdx(p[0]), cellIdx(p[1]), cellIdx(p[2]))] = samples.length - 1;
      active.push(samples.length - 1);
    }
    // Start fronts from all 8 octants so growth isn't biased to one corner.
    const half = DSIZE / 2;
    for(let oi = 0; oi < 2; oi++) for(let oj = 0; oj < 2; oj++) for(let ok = 0; ok < 2; ok++){
      const cand = [
        DMIN + (oi + 0.25 + rng() * 0.5) * half,
        DMIN + (oj + 0.25 + rng() * 0.5) * half,
        DMIN + (ok + 0.25 + rng() * 0.5) * half
      ];
      if(!tooClose(cand)) addSample(cand);
    }
    const K = 30;
    while(active.length > 0 && samples.length < maxN){
      const ai = Math.floor(rng() * active.length);
      const ctr = samples[active[ai]];
      let found = false;
      for(let attempt = 0; attempt < K; attempt++){
        const theta = rng() * 2 * Math.PI;
        const phi = Math.acos(2 * rng() - 1);
        const radius = rmin * (1 + rng());
        const sp = Math.sin(phi);
        let cand = [ctr[0] + radius * sp * Math.cos(theta), ctr[1] + radius * sp * Math.sin(theta), ctr[2] + radius * Math.cos(phi)];
        if(periodic) cand = [wrap1(cand[0]), wrap1(cand[1]), wrap1(cand[2])];
        else if(!inDomain(cand)) continue;
        if(!tooClose(cand)){ addSample(cand); found = true; break; }
      }
      if(!found){ active[ai] = active[active.length - 1]; active.pop(); }
    }
    return samples;
  }

  // Saturated Poisson-disk packing in 3D holds ≈ 0.6 samples per r³ (measured:
  // 0.58 periodic, 0.63–0.68 bounded), so r = 0.84·s0 saturates at ≈ N seeds.
  // Regularity scales that spacing down. Sampling runs to saturation over the
  // whole cube, then is thinned at random to exactly N (thinning never reduces
  // spacing), or topped up by best-candidate insertion if it fell short.
  const POISSON_SAT = 0.84;
  function genPoissonCount(N, regularity, rng, periodic){
    const rmin = regularity * POISSON_SAT * meanSpacing(N);
    const pts = genPoisson(rmin, 60000, rng, periodic);
    if(pts.length > N){
      for(let i = 0; i < N; i++){
        const j = i + Math.floor(rng() * (pts.length - i));
        const t = pts[i]; pts[i] = pts[j]; pts[j] = t;
      }
      pts.length = N;
    } else if(pts.length < N){
      bestCandidateFill(pts, N, rng, periodic);
    }
    return {pts, rmin};
  }

  // Mitchell best-candidate: each new seed is the farthest of 24 random tries.
  function bestCandidateFill(pts, N, rng, periodic){
    while(pts.length < N){
      let best = null, bestD = -1;
      for(let c = 0; c < 24; c++){
        const q = [DMIN + rng() * DSIZE, DMIN + rng() * DSIZE, DMIN + rng() * DSIZE];
        let dmin = Infinity;
        for(let i = 0; i < pts.length; i++){
          let dx = q[0] - pts[i][0], dy = q[1] - pts[i][1], dz = q[2] - pts[i][2];
          if(periodic){ dx = minImg(dx); dy = minImg(dy); dz = minImg(dz); }
          const d = dx*dx + dy*dy + dz*dz;
          if(d < dmin){ dmin = d; if(dmin < bestD) break; }
        }
        if(dmin > bestD){ bestD = dmin; best = q; }
      }
      pts.push(best);
    }
    return pts;
  }

  // Uniform grid over the seeds for fast nearest-seed queries.
  function buildSeedGrid(seeds){
    const N = seeds.length;
    const G = Math.max(1, Math.min(48, Math.floor(DSIZE / meanSpacing(N))));
    const cs = DSIZE / G;
    const cellIdx = v => Math.min(G - 1, Math.max(0, Math.floor((v - DMIN) / cs)));
    const cellOf = new Int32Array(N);
    const start = new Int32Array(G * G * G + 1);
    for(let i = 0; i < N; i++){
      const c = (cellIdx(seeds[i][0]) * G + cellIdx(seeds[i][1])) * G + cellIdx(seeds[i][2]);
      cellOf[i] = c; start[c + 1]++;
    }
    for(let c = 0; c < G * G * G; c++) start[c + 1] += start[c];
    const fill = start.slice(0, G * G * G);
    const items = new Int32Array(N);
    for(let i = 0; i < N; i++) items[fill[cellOf[i]]++] = i;
    return {G, cs, start, items, cellIdx};
  }

  // Nearest seed with an expanding search. A seed outside the (2R+1)³ block is
  // farther than R·cs, so once the best distance is ≤ R·cs the answer is exact.
  const nn = {i: 0, dx: 0, dy: 0, dz: 0};
  function nearestSeed(g, seeds, x, y, z, periodic){
    const {G, cs, start, items} = g;
    const cx = g.cellIdx(x), cy = g.cellIdx(y), cz = g.cellIdx(z);
    const maxR = periodic ? Math.ceil(G / 2) : G;
    let best = Infinity;
    for(let R = 1; ; R++){
      for(let a = -R; a <= R; a++){
        let ix = cx + a; if(periodic) ix = (ix + G * 4) % G; else if(ix < 0 || ix >= G) continue;
        for(let b = -R; b <= R; b++){
          let iy = cy + b; if(periodic) iy = (iy + G * 4) % G; else if(iy < 0 || iy >= G) continue;
          for(let c = -R; c <= R; c++){
            let iz = cz + c; if(periodic) iz = (iz + G * 4) % G; else if(iz < 0 || iz >= G) continue;
            const cell = (ix * G + iy) * G + iz;
            for(let k = start[cell]; k < start[cell + 1]; k++){
              const s = items[k], sp = seeds[s];
              let dx = x - sp[0], dy = y - sp[1], dz = z - sp[2];
              if(periodic){ dx = minImg(dx); dy = minImg(dy); dz = minImg(dz); }
              const d = dx*dx + dy*dy + dz*dz;
              if(d < best){ best = d; nn.i = s; nn.dx = dx; nn.dy = dy; nn.dz = dz; }
            }
          }
        }
      }
      if(Math.sqrt(best) <= R * cs || R >= maxR) return nn;
    }
  }

  // Lloyd relaxation by sampled k-means: every sample point pulls its nearest
  // seed toward the centroid of its cell. ~40 samples per cell, with the sample
  // lattice jittered each iteration so it can't alias. Displacement form keeps
  // the periodic case correct across the wrap.
  function lloydRelax(seeds, iterations, periodic, rng){
    const N = seeds.length;
    if(N === 0 || iterations === 0) return seeds;
    const sampleRes = Math.min(40, Math.max(16, Math.ceil(Math.cbrt(40 * N))));
    const step = DSIZE / sampleRes;
    for(let iter = 0; iter < iterations; iter++){
      const g = buildSeedGrid(seeds);
      const sx = new Float64Array(N), sy = new Float64Array(N), sz = new Float64Array(N);
      const cnt = new Int32Array(N);
      const jx = (rng() - 0.5) * step, jy = (rng() - 0.5) * step, jz = (rng() - 0.5) * step;
      for(let ix = 0; ix < sampleRes; ix++){
        const x = DMIN + (ix + 0.5) * step + jx;
        for(let iy = 0; iy < sampleRes; iy++){
          const y = DMIN + (iy + 0.5) * step + jy;
          for(let iz = 0; iz < sampleRes; iz++){
            const z = DMIN + (iz + 0.5) * step + jz;
            const r = nearestSeed(g, seeds, x, y, z, periodic);
            sx[r.i] += r.dx; sy[r.i] += r.dy; sz[r.i] += r.dz; cnt[r.i]++;
          }
        }
      }
      for(let s = 0; s < N; s++){
        if(cnt[s] === 0) continue;
        let nx = seeds[s][0] + sx[s] / cnt[s];
        let ny = seeds[s][1] + sy[s] / cnt[s];
        let nz = seeds[s][2] + sz[s] / cnt[s];
        if(periodic){ nx = wrap1(nx); ny = wrap1(ny); nz = wrap1(nz); }
        else {
          nx = Math.min(DMAX, Math.max(DMIN, nx));
          ny = Math.min(DMAX, Math.max(DMIN, ny));
          nz = Math.min(DMAX, Math.max(DMIN, nz));
        }
        seeds[s][0] = nx; seeds[s][1] = ny; seeds[s][2] = nz;
      }
    }
    return seeds;
  }

  // Weaire–Phelan (A15 / Cr3Si positions): 8 seeds per lattice cube.
  // Kelvin: BCC, 2 per cube → truncated octahedra.
  const WP_BASIS = [
    [0, 0, 0], [0.5, 0.5, 0.5],
    [0.25, 0, 0.5], [0.75, 0, 0.5],
    [0.5, 0.25, 0], [0.5, 0.75, 0],
    [0, 0.5, 0.25], [0, 0.5, 0.75]
  ];
  const KELVIN_BASIS = [[0, 0, 0], [0.5, 0.5, 0.5]];
  function genLattice(basis, count){
    const across = Math.max(1, Math.round(Math.cbrt(count / basis.length)));
    const cs = DSIZE / across;
    const out = [];
    for(let i = 0; i < across; i++) for(let j = 0; j < across; j++) for(let k = 0; k < across; k++)
      for(const b of basis) out.push([DMIN + (i + b[0]) * cs, DMIN + (j + b[1]) * cs, DMIN + (k + b[2]) * cs]);
    return out;
  }


  // ── v2 (F13LD.foam v0.6.0): exact periodic power cells ──────────────────────
  // Cell i = points where |p − sᵢ|² − wᵢ is smallest (w = null: plain Voronoi),
  // built by clipping a cube around sᵢ with the bisector plane of every nearby
  // periodic copy, nearest first, until no farther copy can cut it. Returns
  // per-seed volume, centroid (unwrapped, near sᵢ) and Σ face area / (2|sⱼ − sᵢ|)
  // (how fast the volume grows with wᵢ — the Newton step for the weights).
  function clipPoly(faces, nx, ny, nz, c, nb, dist){
    const out = [], cut = [], E = 1e-10;
    for(const f of faces){
      const P = f.p, np = [];
      for(let k = 0; k < P.length; k++){
        const a = P[k], b = P[(k + 1) % P.length];
        const da = nx*a[0] + ny*a[1] + nz*a[2] - c, db = nx*b[0] + ny*b[1] + nz*b[2] - c;
        const sa = da > E ? 1 : (da < -E ? -1 : 0), sb = db > E ? 1 : (db < -E ? -1 : 0);
        if(sa <= 0) np.push(a);
        if(sa === 0) cut.push(a);
        if(sa*sb < 0){
          const t = da/(da - db), q = [a[0] + t*(b[0] - a[0]), a[1] + t*(b[1] - a[1]), a[2] + t*(b[2] - a[2])];
          np.push(q); cut.push(q);
        }
      }
      if(np.length >= 3) out.push({p: np, nb: f.nb, d: f.d});
    }
    if(cut.length >= 3){
      let cx = 0, cy = 0, cz = 0;
      for(const q of cut){ cx += q[0]; cy += q[1]; cz += q[2]; }
      cx /= cut.length; cy /= cut.length; cz /= cut.length;
      const t0 = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let u = [ny*t0[2] - nz*t0[1], nz*t0[0] - nx*t0[2], nx*t0[1] - ny*t0[0]];
      const ul = Math.hypot(u[0], u[1], u[2]); u = [u[0]/ul, u[1]/ul, u[2]/ul];
      const v = [ny*u[2] - nz*u[1], nz*u[0] - nx*u[2], nx*u[1] - ny*u[0]];
      const ang = cut.map(q => Math.atan2((q[0]-cx)*v[0] + (q[1]-cy)*v[1] + (q[2]-cz)*v[2], (q[0]-cx)*u[0] + (q[1]-cy)*u[1] + (q[2]-cz)*u[2]));
      const idx = cut.map((_, i) => i).sort((i, j) => ang[i] - ang[j]);
      const cap = [];
      for(const i of idx){
        const q = cut[i], l = cap[cap.length - 1];
        if(!l || Math.abs(q[0]-l[0]) + Math.abs(q[1]-l[1]) + Math.abs(q[2]-l[2]) > 1e-9) cap.push(q);
      }
      while(cap.length > 1){
        const q = cap[0], l = cap[cap.length - 1];
        if(Math.abs(q[0]-l[0]) + Math.abs(q[1]-l[1]) + Math.abs(q[2]-l[2]) > 1e-9) break;
        cap.pop();
      }
      if(cap.length >= 3) out.push({p: cap, nb, d: dist});
    }
    return out;
  }
  // Power cells of every seed in the periodic cube. Returns per-seed volume,
  // centroid (unwrapped, near the seed) and the shared faces as
  // {i, j, c = area / (2·distance)} — how fast volume moves between i and j
  // as their weights differ (the Newton matrix for the weights).
  function powerCells(seeds, w){
    const N = seeds.length, s0 = meanSpacing(N);
    let wmin = 0, wmax = 0;
    if(w){ wmin = Infinity; wmax = -Infinity; for(const x of w){ wmin = Math.min(wmin, x); wmax = Math.max(wmax, x); } }
    const dw = wmax - wmin;
    const pad = Math.min(DSIZE, 2.5*s0 + Math.sqrt(dw)), B = DSIZE/2 + pad;
    const IX = [], IY = [], IZ = [], ID = [];
    for(let a = -1; a <= 1; a++) for(let b = -1; b <= 1; b++) for(let c = -1; c <= 1; c++)
      for(let i = 0; i < N; i++){
        const x = seeds[i][0] + a*DSIZE, y = seeds[i][1] + b*DSIZE, z = seeds[i][2] + c*DSIZE;
        if(x >= -B && x <= B && y >= -B && y <= B && z >= -B && z <= B){ IX.push(x); IY.push(y); IZ.push(z); ID.push(i); }
      }
    const M = IX.length, G = Math.max(1, Math.min(40, Math.round(2*B/s0))), cs = 2*B/G;
    const cI = v => Math.min(G - 1, Math.max(0, Math.floor((v + B)/cs)));
    const start = new Int32Array(G*G*G + 1), cellOf = new Int32Array(M);
    for(let k = 0; k < M; k++){ const c = cI(IX[k]) + G*(cI(IY[k]) + G*cI(IZ[k])); cellOf[k] = c; start[c + 1]++; }
    for(let c = 0; c < G*G*G; c++) start[c + 1] += start[c];
    const fill = start.slice(0, G*G*G), items = new Int32Array(M);
    for(let k = 0; k < M; k++) items[fill[cellOf[k]]++] = k;
    const vol = new Float64Array(N), cen = [], links = [];
    const h = DSIZE;   // starting cube half-size: a cell never reaches past its periodic copies
    for(let i = 0; i < N; i++){
      const sx = seeds[i][0], sy = seeds[i][1], sz = seeds[i][2], wi = w ? w[i] : 0;
      const c0 = cI(sx), c1 = cI(sy), c2 = cI(sz), Rr = Math.ceil(pad/cs);
      let faces = [
        [[-h,-h,-h],[-h,h,-h],[h,h,-h],[h,-h,-h]], [[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]],
        [[-h,-h,-h],[h,-h,-h],[h,-h,h],[-h,-h,h]], [[-h,h,-h],[-h,h,h],[h,h,h],[h,h,-h]],
        [[-h,-h,-h],[-h,-h,h],[-h,h,h],[-h,h,-h]], [[h,-h,-h],[h,h,-h],[h,h,h],[h,-h,h]]
      ].map(p => ({p, nb: -1, d: 0}));
      let rmax = Math.sqrt(3)*h;
      // Copies ring by ring outward (a copy in ring R is at least (R − 1)·cs
      // away); stop once no farther copy's plane can reach the cell.
      for(let R = 0; R <= Rr && faces.length; R++){
        const cand = [];
        for(let a = -R; a <= R; a++){ const qx = c0 + a; if(qx < 0 || qx >= G) continue;
          for(let b = -R; b <= R; b++){ const qy = c1 + b; if(qy < 0 || qy >= G) continue;
            const side = a === -R || a === R || b === -R || b === R, de = (side || R === 0) ? 1 : 2*R;
            for(let e = -R; e <= R; e += de){ const qz = c2 + e; if(qz < 0 || qz >= G) continue;
              const c = qx + G*(qy + G*qz);
              for(let k = start[c]; k < start[c + 1]; k++){
                const m = items[k], dx = IX[m] - sx, dy = IY[m] - sy, dz = IZ[m] - sz, d2 = dx*dx + dy*dy + dz*dz;
                if(d2 > 1e-18) cand.push([d2, dx, dy, dz, ID[m]]);
              }}}}
        cand.sort((p, q) => p[0] - q[0]);
        for(const [d2, dx, dy, dz, j] of cand){
          const d = Math.sqrt(d2);
          if((d2 - dw)/(2*d) > rmax) break;   // this copy's plane, and every later one in the ring, misses the cell
          const nx = dx/d, ny = dy/d, nz = dz/d, c = (d2 + wi - (w ? w[j] : 0))/(2*d);
          let reach = -Infinity;
          for(const f of faces) for(const q of f.p) reach = Math.max(reach, nx*q[0] + ny*q[1] + nz*q[2]);
          if(reach <= c + 1e-10) continue;     // misses the current cell
          faces = clipPoly(faces, nx, ny, nz, c, j, d);
          if(!faces.length) break;
          rmax = 0;
          for(const f of faces) for(const q of f.p) rmax = Math.max(rmax, q[0]*q[0] + q[1]*q[1] + q[2]*q[2]);
          rmax = Math.sqrt(rmax);
        }
        const dmin = R*cs;
        if(dmin > 0 && (dmin*dmin - dw)/(2*dmin) > rmax) break;
      }
      let V = 0, cx = 0, cy = 0, cz = 0;
      for(const f of faces){
        const P = f.p, a = P[0];
        let fx = 0, fy = 0, fz = 0;
        for(let k = 1; k + 1 < P.length; k++){
          const b = P[k], c = P[k + 1];
          const tv = (a[0]*(b[1]*c[2] - b[2]*c[1]) - a[1]*(b[0]*c[2] - b[2]*c[0]) + a[2]*(b[0]*c[1] - b[1]*c[0]))/6;
          V += tv; cx += tv*(a[0] + b[0] + c[0])/4; cy += tv*(a[1] + b[1] + c[1])/4; cz += tv*(a[2] + b[2] + c[2])/4;
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
          fx += uy*vz - uz*vy; fy += uz*vx - ux*vz; fz += ux*vy - uy*vx;
        }
        if(f.nb >= 0 && f.nb !== i) links.push(i, f.nb, 0.5*Math.hypot(fx, fy, fz)/(2*f.d));
      }
      vol[i] = Math.max(0, V);
      cen.push(V > 1e-12 ? [sx + cx/V, sy + cy/V, sz + cz/V] : [sx, sy, sz]);
    }
    return {vol, cen, links};
  }

  // Power weights that give every cell its target volume: semi-discrete
  // optimal transport by damped Newton (Kitagawa–Mérigot–Thibert), the Newton
  // step from conjugate gradients on the face-coupling matrix.
  function solveWeights(seeds, target, w, tol){
    const N = seeds.length, s0 = meanSpacing(N), minV = 1e-4*s0*s0*s0;
    let pc = powerCells(seeds, w);
    // Newton needs every cell non-empty to start; plain Voronoi always is.
    if(pc.vol.some(v => v < minV)){ w.fill(0); pc = powerCells(seeds, w); }
    const err = p => { let e = 0; for(let i = 0; i < N; i++) e += (p.vol[i] - target[i])**2; return Math.sqrt(e); };
    const rel = p => { let e = 0; for(let i = 0; i < N; i++) e = Math.max(e, Math.abs(p.vol[i] - target[i])/target[i]); return e; };
    let e0 = err(pc);
    for(let it = 0; it < 40 && rel(pc) > tol; it++){
      const L = pc.links, r = new Float64Array(N);
      for(let i = 0; i < N; i++) r[i] = target[i] - pc.vol[i];
      const Ax = x => { const y = new Float64Array(N); for(let k = 0; k < L.length; k += 3){ const i = L[k], j = L[k+1], c = L[k+2]; y[i] += c*(x[i] - x[j]); } for(let i = 0; i < N; i++) y[i] += 1e-9*x[i]; return y; };
      const x = new Float64Array(N), res = r.slice(), p = r.slice();
      let rr = 0; for(let i = 0; i < N; i++) rr += res[i]*res[i];
      for(let k = 0; k < 200 && rr > 1e-20; k++){
        const Ap = Ax(p); let pAp = 0; for(let i = 0; i < N; i++) pAp += p[i]*Ap[i];
        if(pAp <= 0) break;
        const al = rr/pAp; let rn = 0;
        for(let i = 0; i < N; i++){ x[i] += al*p[i]; res[i] -= al*Ap[i]; rn += res[i]*res[i]; }
        const be = rn/rr; rr = rn;
        for(let i = 0; i < N; i++) p[i] = res[i] + be*p[i];
      }
      let a = 1, done = false;
      for(let tries = 0; tries < 12 && !done; tries++, a *= 0.5){
        const wt = w.map((v, i) => v + a*x[i]);
        const pt = powerCells(seeds, wt), et = err(pt);
        let ok = true; for(let i = 0; i < N; i++) if(pt.vol[i] < minV){ ok = false; break; }
        if(ok && et < (1 - a/2)*e0 + 1e-12){ for(let i = 0; i < N; i++) w[i] = wt[i]; pc = pt; e0 = et; done = true; }
      }
      if(!done) break;
    }
    let m = 0; for(const v of w) m += v; m /= N;
    for(let i = 0; i < N; i++) w[i] -= m;
    return pc;   // cells for these weights (shifting all weights changes nothing)
  }

  // Two cell sizes: a share of the seeds get cells `ratio` times wider (by
  // diameter; volume ratio³). Poisson-disk start, then rounds of exact weights
  // + move each seed to its cell's centroid; weights solved last so the cell
  // volumes are exact for the final positions.
  function genBimodal(N, ratio, frac, regularity, rounds, rng){
    const pts = genPoissonCount(N, regularity, rng, true).pts;
    const order = pts.map((_, i) => i);
    for(let i = N - 1; i > 0; i--){ const j = Math.floor(rng()*(i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    const nL = Math.round(frac*N), r3 = ratio*ratio*ratio;
    const vS = DSIZE*DSIZE*DSIZE/(nL*r3 + (N - nL));
    const target = new Float64Array(N);
    for(let k = 0; k < N; k++) target[order[k]] = k < nL ? vS*r3 : vS;
    const w = new Array(N).fill(0);
    for(let r = 0; r <= rounds; r++){
      const pc = solveWeights(pts, target, w, r === rounds ? 2e-3 : 2e-2);
      if(r === rounds) break;
      for(let i = 0; i < N; i++) pts[i] = pc.cen[i].map(wrap1);
    }
    return {pts, weights: w.map(v => parseFloat(v.toFixed(6)))};
  }

  // Symmetric seeds: Poisson-disk darts in one fundamental region, each kept
  // only if its whole orbit clears the spacing. 'mirror' reflects in the
  // x, y, z mid-planes (8 copies → orthotropic stiffness); 'cubic' adds every
  // swap of axes (48 copies → cubic stiffness). Mirrors at 0 and the period
  // put mirrors at ±5 too, so the tile stays periodic.
  function orbit(p, cubic){
    const out = [];
    const perms = cubic ? [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]] : [[0,1,2]];
    for(const pm of perms) for(let s = 0; s < 8; s++){
      const q = [0, 1, 2].map(a => wrap1(((s >> a) & 1 ? -1 : 1)*p[pm[a]]));
      if(!out.some(o => Math.abs(minImg(o[0]-q[0])) + Math.abs(minImg(o[1]-q[1])) + Math.abs(minImg(o[2]-q[2])) < 1e-9)) out.push(q);
    }
    return out;
  }
  // A seed relaxed to within `tol` of a mirror plane goes onto it, so it and its
  // image merge into one seed instead of a near-duplicate pair (a sliver cell).
  function snapToMirrors(p, cubic, tol){
    let q = p.map(Math.abs);
    if(cubic) q.sort((a, b) => b - a);
    const snap = v => (v < tol ? 0 : (v > 5 - tol ? 5 : v));
    q = q.map(snap);
    if(cubic){
      if(q[0] - q[1] < tol){ const m = (q[0] + q[1])/2; q[0] = q[1] = m; }
      if(q[1] - q[2] < tol){ const m = (q[1] + q[2])/2; q[1] = q[2] = m; }
      if(q[0] - q[1] < tol){ const m = (q[0] + q[1])/2; q[0] = q[1] = m; }
    }
    return q;
  }
  function genSymmetric(N, regularity, rounds, cubic, rng){
    const gsize = cubic ? 48 : 8, reps = Math.max(1, Math.round(N/gsize));
    const rmin = regularity*POISSON_SAT*meanSpacing(reps*gsize);
    const GC = Math.max(1, Math.floor(DSIZE/rmin)), gcs = DSIZE/GC, grid = new Map();
    const key = (x, y, z) => ((x + GC) % GC) + GC*(((y + GC) % GC) + GC*((z + GC) % GC));
    const cIdx = v => Math.min(GC - 1, Math.floor((v - DMIN)/gcs));
    const all = [], R = [];
    const clear = q => {
      const ix = cIdx(q[0]), iy = cIdx(q[1]), iz = cIdx(q[2]), rr = Math.ceil(rmin/gcs);
      for(let a = -rr; a <= rr; a++) for(let b = -rr; b <= rr; b++) for(let c = -rr; c <= rr; c++){
        const l = grid.get(key(ix + a, iy + b, iz + c)); if(!l) continue;
        for(const o of l){ const dx = minImg(o[0]-q[0]), dy = minImg(o[1]-q[1]), dz = minImg(o[2]-q[2]); if(dx*dx + dy*dy + dz*dz < rcur*rcur) return false; }
      }
      return true;
    };
    let fails = 0, rcur = rmin;
    while(R.length < reps){
      if(fails >= 2000){   // the orbit won't fit at this spacing: loosen it and keep going
        if(rcur < 0.25*rmin) break;
        rcur *= 0.9; fails = 0;
      }
      const rc2 = rcur*rcur;
      let x = rng()*5, y = rng()*5, z = rng()*5;
      if(cubic){ const s = [x, y, z].sort((a, b) => b - a); x = s[0]; y = s[1]; z = s[2]; }
      const orb = orbit([x, y, z], cubic);
      let ok = orb.every(clear);
      for(let i = 0; ok && i < orb.length; i++) for(let j = i + 1; j < orb.length; j++){
        const dx = minImg(orb[i][0]-orb[j][0]), dy = minImg(orb[i][1]-orb[j][1]), dz = minImg(orb[i][2]-orb[j][2]);
        if(dx*dx + dy*dy + dz*dz < rc2){ ok = false; break; }
      }
      if(!ok){ fails++; continue; }
      fails = 0; R.push([x, y, z]);
      for(const q of orb){ all.push(q); const k = key(cIdx(q[0]), cIdx(q[1]), cIdx(q[2])); if(!grid.has(k)) grid.set(k, []); grid.get(k).push(q); }
    }
    // Lloyd rounds on exact cells: a symmetric layout has symmetric centroids,
    // so moving each representative and rebuilding its orbit keeps the symmetry.
    let pts = all;
    for(let r = 0; r < rounds; r++){
      const idx = [];
      pts = [];
      for(let k = 0; k < R.length; k++){ const o = orbit(R[k], cubic); idx.push(pts.length); for(const q of o) pts.push(q); }
      const pc = powerCells(pts, null);
      for(let k = 0; k < R.length; k++) R[k] = snapToMirrors(pc.cen[idx[k]].map(wrap1), cubic, 0.2*rcur);
      pts = [];
      for(const rp of R) for(const q of orbit(rp, cubic)) pts.push(q);
    }
    return {pts, rmin: rcur};
  }

  // Extra lattices: FCC (rhombic dodecahedra, 4 per cube) and C15 Laves
  // (MgCu₂ / Frank–Kasper: 16- and 12-faced cells, 24 per cube).
  const FCC_BASIS = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
  const C15_BASIS = (function(){
    const out = [];
    for(const t of FCC_BASIS){
      for(const a of [[0, 0, 0], [0.25, 0.25, 0.25]]) out.push(a.map((v, i) => (v + t[i]) % 1));
      for(const b of [[0.625, 0.625, 0.625], [0.625, 0.875, 0.875], [0.875, 0.625, 0.875], [0.875, 0.875, 0.625]]) out.push(b.map((v, i) => (v + t[i]) % 1));
    }
    return out;
  })();
  // Disorder: Gaussian nudge of each lattice seed, σ = jitter × mean spacing.
  function jitterSeeds(pts, jitter, rng){
    if(!(jitter > 0)) return pts;
    const sd = jitter*meanSpacing(pts.length);
    const gauss = () => Math.sqrt(-2*Math.log(1 - rng()))*Math.cos(2*Math.PI*rng());
    return pts.map(p => [wrap1(p[0] + sd*gauss()), wrap1(p[1] + sd*gauss()), wrap1(p[2] + sd*gauss())]);
  }

  const MODES = ['poisson', 'lloyd', 'random', 'weairePhelan', 'kelvin', 'bimodal', 'mirror', 'cubic', 'fcc', 'c15'];
  const LATTICE_MODES = ['weairePhelan', 'kelvin', 'fcc', 'c15'];

  // One entry point. opts: {mode, count, regularity, lloydIter, rngSeed,
  // periodic, maxSeeds, sizeRatio, largeFraction, jitter}. Returns {seeds,
  // minSpacing, weights} (minSpacing 0 when the mode has no enforced gap;
  // weights only for 'bimodal'). Output is capped at maxSeeds (default 1024).
  // v2 modes are periodic by construction; lattices with no jitter, and every
  // v1 mode, give exactly the v1 layout.
  function generate(opts){
    const rng = mulberry32(opts.rngSeed | 0);
    const periodic = !!opts.periodic;
    const count = Math.max(1, opts.count | 0);
    let seeds = [], minSpacing = 0, weights = null;
    switch(opts.mode){
      case 'poisson': {
        const r = genPoissonCount(count, opts.regularity, rng, periodic);
        seeds = r.pts; minSpacing = r.rmin;
        break;
      }
      case 'lloyd': {
        const r = genPoissonCount(count, opts.regularity, rng, periodic);
        seeds = lloydRelax(r.pts, opts.lloydIter | 0, periodic, rng);
        break;
      }
      case 'random':       seeds = genRandom(count, rng); break;
      case 'weairePhelan': seeds = jitterSeeds(genLattice(WP_BASIS, count), opts.jitter, rng); break;
      case 'kelvin':       seeds = jitterSeeds(genLattice(KELVIN_BASIS, count), opts.jitter, rng); break;
      case 'fcc':          seeds = jitterSeeds(genLattice(FCC_BASIS, count), opts.jitter, rng); break;
      case 'c15':          seeds = jitterSeeds(genLattice(C15_BASIS, count), opts.jitter, rng); break;
      case 'bimodal': {
        const ratio = Math.min(4, Math.max(1, +opts.sizeRatio || 2));
        const frac = Math.min(1, Math.max(0, opts.largeFraction != null ? +opts.largeFraction : 0.3));
        const r = genBimodal(count, ratio, frac, opts.regularity != null ? opts.regularity : 0.9, opts.lloydIter != null ? opts.lloydIter | 0 : 3, rng);
        seeds = r.pts; weights = r.weights;
        break;
      }
      case 'mirror': case 'cubic': {
        const r = genSymmetric(count, opts.regularity != null ? opts.regularity : 0.9, opts.lloydIter | 0, opts.mode === 'cubic', rng);
        seeds = r.pts; minSpacing = r.rmin;
        break;
      }
      default: throw new Error('Unknown foam seed mode "' + opts.mode + '"');
    }
    const cap = opts.maxSeeds || 1024;
    return {seeds: seeds.slice(0, cap), minSpacing, weights: weights ? weights.slice(0, cap) : null};
  }

  return {VERSION, MODES, LATTICE_MODES, meanSpacing, generate, powerCells};
})();
// ==== END FoamSeeds ===========================================================

// ==== BEGIN verbatim mesh port (m25-sdf-foam.js foamSeedsFromRecipe + buildFoamSDF) ====
function foamSeedsFromRecipe(json){
  const sd=json.seeds||{};
  if(Array.isArray(sd.positions) && sd.positions.length>=3){
    const out=[];
    for(let i=0;i+2<sd.positions.length;i+=3) out.push([sd.positions[i],sd.positions[i+1],sd.positions[i+2]]);
    if(Array.isArray(sd.weights)&&sd.weights.length===out.length) out.weights=sd.weights.slice();   // power cells (v2 field)
    return out;
  }
  const r=FoamSeeds.generate({
    mode: sd.mode, count: sd.count, regularity: sd.regularity!=null?sd.regularity:0.9,
    lloydIter: sd.lloyd_iterations||0, rngSeed: sd.rng_seed||0, periodic: true,
    sizeRatio: sd.size_ratio, largeFraction: sd.large_fraction, jitter: sd.jitter
  });
  if(r.weights) r.seeds.weights=r.weights;
  return r.seeds;
}

function buildFoamSDF(json){
  if(json.geometry&&json.geometry.field===2) return buildFoamSDF2(json);
  const seeds=foamSeedsFromRecipe(json);
  const N=seeds.length;
  const g=json.geometry||{};
  const an=json.anisotropy||{};
  const st=(an.enabled&&Array.isArray(an.stretch)&&an.stretch.length===3)?an.stretch.map(v=>(isFinite(v)&&v>0)?v:1):[1,1,1];
  const ix=1/st[0], iy=1/st[1], iz=1/st[2];
  const ix2=ix*ix, iy2=iy*iy, iz2=iz*iz;
  const mode=g.mode==='open'||g.mode==='closed'?g.mode:'plateau';
  const T=(typeof g.thickness==='number'&&g.thickness>0)?g.thickness:0.08;
  const K=(mode==='plateau'&&typeof g.plateau_k==='number')?g.plateau_k:0;
  const O=(typeof g.organic==='number'&&g.organic>0)?g.organic:0;
  const oAmp=O*2.0, oReach=0.10+Math.pow(O,0.6)*0.25;
  const normalize=g.normalize!==false;
  const L=10, H=5;

  // Seed grid: cell edge ≈ mean spacing × stretch per axis (same layout as
  // the preview bake), seeds sorted by cell into flat arrays.
  const s0=FoamSeeds.meanSpacing(N);
  const G=[0,1,2].map(a=>Math.max(1,Math.min(40,Math.round(L/(s0*st[a])))));
  const cs=G.map(n=>L/n);
  const nC=G[0]*G[1]*G[2];
  const cIdx=(v,a)=>Math.min(G[a]-1,Math.max(0,Math.floor((v+H)/cs[a])));
  const cellOf=new Int32Array(N), start=new Int32Array(nC+1);
  for(let i=0;i<N;i++){const c=cIdx(seeds[i][0],0)+G[0]*(cIdx(seeds[i][1],1)+G[1]*cIdx(seeds[i][2],2));cellOf[i]=c;start[c+1]++;}
  for(let c=0;c<nC;c++) start[c+1]+=start[c];
  const fill=start.slice(0,nC), SX=new Float64Array(N), SY=new Float64Array(N), SZ=new Float64Array(N);
  for(let i=0;i<N;i++){const k=fill[cellOf[i]]++;SX[k]=seeds[i][0];SY[k]=seeds[i][1];SZ[k]=seeds[i][2];}
  // Ring R is exact once the 4th-nearest metric distance ≤ R·min(cs/stretch);
  // a periodic ring must not wrap onto itself (2R+1 ≤ G on every axis).
  const rm=Math.min(cs[0]*ix,cs[1]*iy,cs[2]*iz);
  const maxRing=Math.min(2,Math.floor((Math.min(G[0],G[1],G[2])-1)/2));

  // Top-4 nearest: squared metric distance + real displacement of each.
  const D=new Float64Array(4), RX=new Float64Array(4), RY=new Float64Array(4), RZ=new Float64Array(4);
  function consider(k,px,py,pz){
    let rx=px-SX[k], ry=py-SY[k], rz=pz-SZ[k];
    rx-=L*Math.round(rx/L); ry-=L*Math.round(ry/L); rz-=L*Math.round(rz/L);
    const d=rx*rx*ix2+ry*ry*iy2+rz*rz*iz2;
    if(d>=D[3]) return;
    let j=3;
    while(j>0&&D[j-1]>d){D[j]=D[j-1];RX[j]=RX[j-1];RY[j]=RY[j-1];RZ[j]=RZ[j-1];j--;}
    D[j]=d;RX[j]=rx;RY[j]=ry;RZ[j]=rz;
  }
  function nearest4(px,py,pz){
    const c0=cIdx(px,0), c1=cIdx(py,1), c2=cIdx(pz,2);
    for(let R=1;R<=maxRing;R++){
      D.fill(Infinity);
      for(let a=-R;a<=R;a++){const qx=(c0+a+2*G[0])%G[0];
        for(let b=-R;b<=R;b++){const qy=(c1+b+2*G[1])%G[1];
          for(let e=-R;e<=R;e++){const qz=(c2+e+2*G[2])%G[2];
            const c=qx+G[0]*(qy+G[1]*qz);
            for(let k=start[c];k<start[c+1];k++) consider(k,px,py,pz);
          }}}
      if(Math.sqrt(D[3])<=R*rm) return;
    }
    D.fill(Infinity);
    for(let k=0;k<N;k++) consider(k,px,py,pz);
  }
  const smooth=(e0,e1,x)=>{const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return t*t*(3-2*t);};
  const j2=mode==='closed'?1:2;   // index of d₂ (closed) or d₃ (open/plateau)

  return p=>{
    // Wrap into the periodic tile [-5, 5).
    const px=((p[0]+H)%L+L)%L-H, py=((p[1]+H)%L+L)%L-H, pz=((p[2]+H)%L+L)%L-H;
    nearest4(px,py,pz);
    const d1=Math.sqrt(D[0]), dj=Math.sqrt(D[j2]), d3=Math.sqrt(D[2]), d4=Math.sqrt(D[3]);
    const base=(dj-d1)*0.5;
    let E=0;
    if(K>0) E+=K*(1-smooth(0,0.35,d3-d1));
    if(oAmp>0) E+=oAmp*T*Math.pow(1-smooth(0,oReach,d4-d1),1.4);
    if(!normalize) return base-T-E;
    // ∇base = (∇dⱼ − ∇d₁)/2 with ∇dᵢ = (rᵢ ⊙ 1/stretch²)/dᵢ
    const a1=d1>1e-9?1/d1:0, aj=dj>1e-9?1/dj:0;
    const gx=(RX[j2]*ix2*aj-RX[0]*ix2*a1)*0.5;
    const gy=(RY[j2]*iy2*aj-RY[0]*iy2*a1)*0.5;
    const gz=(RZ[j2]*iz2*aj-RZ[0]*iz2*a1)*0.5;
    const gm=Math.sqrt(gx*gx+gy*gy+gz*gz);
    return base/Math.max(gm,0.05)-T-E;
  };
}

// ── FoamField/2 (F13LD.foam v0.6.0) — exact distance to the cell walls/edges ─
// Recipes with geometry.field === 2 build here; every other recipe keeps the
// field above unchanged. Cells are power (Laguerre) cells: seed i owns the
// points where |p−sᵢ|²ₘ − wᵢ is smallest (wᵢ = seeds.weights, 0 if absent;
// |·|ₘ is the stretched metric M = diag(1/stretch²)). For p in the cell of s₁,
// each neighbour sⱼ gives a bisector plane at real-space distance
//   cⱼ = (|p−sⱼ|²ₘ − wⱼ − |p−s₁|²ₘ + w₁) / (2|M(sⱼ−s₁)|)
// and the members of the cell boundary are, exactly:
//   wall  j  — the plane, nearest point inside the cell (else its edges)
//   edge a,b — the line where two planes meet, inside the cell (else its ends)
//   node     — a vertex where three planes meet, inside the cell
// The 8 nearest seeds are searched over the seeds and their periodic copies.
// Solid where < 0:
//   closed : wall − t          open : edge − t          plateau : edge − t − E
//   wet    : border − dist(p, cell shrunk by border) + 0.02·border
//            (Plateau borders: the space left between rounded cells)
// fillet k blends neighbouring walls / edges with a circular fillet of radius
// k; node n adds a sphere of radius t + n at every vertex, blended the same way.
// E (plateau swell) = k_p·(1 − smoothstep(0, 0.35, d₃ − d₁)), dᵢ = power distance.
function buildFoamSDF2(json){
  const seeds=foamSeedsFromRecipe(json);
  const N=seeds.length;
  const g=json.geometry||{};
  const an=json.anisotropy||{};
  const st=(an.enabled&&Array.isArray(an.stretch)&&an.stretch.length===3)?an.stretch.map(v=>(isFinite(v)&&v>0)?v:1):[1,1,1];
  const mx=1/(st[0]*st[0]), my=1/(st[1]*st[1]), mz=1/(st[2]*st[2]);
  const mode=['open','closed','plateau','wet'].includes(g.mode)?g.mode:'plateau';
  const T=(typeof g.thickness==='number'&&g.thickness>0)?g.thickness:0.08;
  const Kp=(mode==='plateau'&&typeof g.plateau_k==='number')?g.plateau_k:0;
  const FK=(mode!=='wet'&&typeof g.fillet==='number'&&g.fillet>0)?g.fillet:0;
  const NR=(mode!=='wet'&&typeof g.node==='number'&&g.node>0)?g.node:0;
  const BR=(typeof g.border==='number'&&g.border>0)?g.border:0.3;
  const L=10, H=5, K=8;
  // Weights → a non-negative offset per seed (wmax − wᵢ), which leaves the
  // cells unchanged and keeps every power distance ≥ the metric distance.
  const W=seeds.weights;
  let wmax=0;
  if(W) for(let i=0;i<N;i++) wmax=Math.max(wmax,W[i]||0);
  const off=i=>W?wmax-(W[i]||0):0;

  // Seeds plus every periodic copy within `pad` of the tile, binned on a
  // plain (non-wrapping) grid over the padded box.
  const s0=FoamSeeds.meanSpacing(N), smax=Math.max(st[0],st[1],st[2]);
  const pad=Math.min(L,3*s0*smax+Math.sqrt(wmax-(W?Math.min(...W):0))), B=H+pad;
  const PX=[], PY=[], PZ=[], PO=[];
  for(let a=-1;a<=1;a++) for(let b=-1;b<=1;b++) for(let c=-1;c<=1;c++)
    for(let i=0;i<N;i++){
      const x=seeds[i][0]+a*L, y=seeds[i][1]+b*L, z=seeds[i][2]+c*L;
      if(x>=-B&&x<=B&&y>=-B&&y<=B&&z>=-B&&z<=B){PX.push(x);PY.push(y);PZ.push(z);PO.push(off(i));}
    }
  const M=PX.length;
  const G=Math.max(1,Math.min(48,Math.round(2*B/s0))), cs=2*B/G, nC=G*G*G;
  const cI=v=>Math.min(G-1,Math.max(0,Math.floor((v+B)/cs)));
  const cellOf=new Int32Array(M), start=new Int32Array(nC+1);
  for(let i=0;i<M;i++){const c=cI(PX[i])+G*(cI(PY[i])+G*cI(PZ[i]));cellOf[i]=c;start[c+1]++;}
  for(let c=0;c<nC;c++) start[c+1]+=start[c];
  const fill=start.slice(0,nC), SX=new Float64Array(M), SY=new Float64Array(M), SZ=new Float64Array(M), SO=new Float64Array(M);
  for(let i=0;i<M;i++){const k=fill[cellOf[i]]++;SX[k]=PX[i];SY[k]=PY[i];SZ[k]=PZ[i];SO[k]=PO[i];}
  const rm=cs/smax;   // metric radius a ring of R cells is guaranteed to cover, per R

  // 8 nearest by power distance (+ offset): value + real displacement p − s.
  const D=new Float64Array(K), VX=new Float64Array(K), VY=new Float64Array(K), VZ=new Float64Array(K);
  function consider(k,px,py,pz){
    const vx=px-SX[k], vy=py-SY[k], vz=pz-SZ[k];
    const d=vx*vx*mx+vy*vy*my+vz*vz*mz+SO[k];
    if(d>=D[K-1]) return;
    let j=K-1;
    while(j>0&&D[j-1]>d){D[j]=D[j-1];VX[j]=VX[j-1];VY[j]=VY[j-1];VZ[j]=VZ[j-1];j--;}
    D[j]=d;VX[j]=vx;VY[j]=vy;VZ[j]=vz;
  }
  function nearestK(px,py,pz){
    const c0=cI(px), c1=cI(py), c2=cI(pz);
    D.fill(Infinity);
    for(let R=0;R<G;R++){   // add the shell of cells at ring R
      for(let a=-R;a<=R;a++){const qx=c0+a; if(qx<0||qx>=G) continue;
        for(let b=-R;b<=R;b++){const qy=c1+b; if(qy<0||qy>=G) continue;
          const side=a===-R||a===R||b===-R||b===R, de=(side||R===0)?1:2*R;
          for(let e=-R;e<=R;e+=de){const qz=c2+e; if(qz<0||qz>=G) continue;
            const c=qx+G*(qy+G*qz);
            for(let k=start[c];k<start[c+1];k++) consider(k,px,py,pz);
          }}}
      if(Math.sqrt(D[K-1])<=R*rm) return;   // offsets ≥ 0, so later seeds can't be nearer
    }
  }

  // Cell planes in a frame centred on p: inside where n·x ≤ c (c ≥ 0 = distance).
  const NX=new Float64Array(K), NY=new Float64Array(K), NZ=new Float64Array(K), C=new Float64Array(K), ord=new Int32Array(K);
  function planes(shift){
    for(let j=1;j<K;j++){
      const ax=(VX[0]-VX[j])*mx, ay=(VY[0]-VY[j])*my, az=(VZ[0]-VZ[j])*mz;
      const l=Math.sqrt(ax*ax+ay*ay+az*az)||1e-12;
      NX[j]=ax/l; NY[j]=ay/l; NZ[j]=az/l; C[j]=(D[j]-D[0])/(2*l)-shift;
    }
  }
  function inside(x,y,z,s0,s1,s2){
    for(let j=1;j<K;j++){
      if(j===s0||j===s1||j===s2) continue;
      if(NX[j]*x+NY[j]*y+NZ[j]*z>C[j]+1e-9) return false;
    }
    return true;
  }
  function sortPlanes(){
    for(let j=1;j<K;j++) ord[j]=j;
    for(let i=2;i<K;i++){const v=ord[i];let j=i;while(j>1&&C[ord[j-1]]>C[v]){ord[j]=ord[j-1];j--;}ord[j]=v;}
  }
  // Point where planes a, b, c meet (x,y,z into VT), false if they don't.
  const VT=[0,0,0];
  function vertexAt(a,b,c){
    const bx=NY[b]*NZ[c]-NZ[b]*NY[c], by=NZ[b]*NX[c]-NX[b]*NZ[c], bz=NX[b]*NY[c]-NY[b]*NX[c];
    const det=NX[a]*bx+NY[a]*by+NZ[a]*bz;
    if(Math.abs(det)<1e-12) return false;
    const cx=NY[c]*NZ[a]-NZ[c]*NY[a], cy=NZ[c]*NX[a]-NX[c]*NZ[a], cz=NX[c]*NY[a]-NY[c]*NX[a];
    const ax=NY[a]*NZ[b]-NZ[a]*NY[b], ay=NZ[a]*NX[b]-NX[a]*NZ[b], az=NX[a]*NY[b]-NY[a]*NX[b];
    VT[0]=(C[a]*bx+C[b]*cx+C[c]*ax)/det; VT[1]=(C[a]*by+C[b]*cy+C[c]*ay)/det; VT[2]=(C[a]*bz+C[b]*cz+C[c]*az)/det;
    return true;
  }
  function vertexDist(a,b,c){
    return vertexAt(a,b,c)&&inside(VT[0],VT[1],VT[2],a,b,c)?Math.sqrt(VT[0]*VT[0]+VT[1]*VT[1]+VT[2]*VT[2]):Infinity;
  }
  // Nearest point of the line where planes a, b meet: squared distance, or
  // −1 when that point lies outside the cell (then the edge ends nearer).
  function lineDist2(a,b){
    const cab=NX[a]*NX[b]+NY[a]*NY[b]+NZ[a]*NZ[b], det=1-cab*cab;
    if(det<1e-12) return -1;
    const al=(C[a]-C[b]*cab)/det, be=(C[b]-C[a]*cab)/det;
    return inside(al*NX[a]+be*NX[b],al*NY[a]+be*NY[b],al*NZ[a]+be*NZ[b],a,b,-1)?Math.max(0,al*C[a]+be*C[b]):-1;
  }
  function wallDist(){let m=Infinity;for(let j=1;j<K;j++) if(C[j]<m) m=C[j];return m;}
  // Planes sorted by distance prune the search: a line on planes a, b is at
  // least max(c_a, c_b) away, a vertex at least the largest of its three.
  function strutDist(cap){
    sortPlanes();
    let best=cap;
    for(let ib=2;ib<K;ib++){const b=ord[ib]; if(C[b]>=best) break;
      for(let ia=1;ia<ib;ia++){const d2=lineDist2(ord[ia],b); if(d2>=0&&d2<best*best) best=Math.sqrt(d2);}}
    for(let ic=3;ic<K;ic++){const c=ord[ic]; if(C[c]>=best) break;
      for(let ib=2;ib<ic;ib++) for(let ia=1;ia<ib;ia++){const v=vertexDist(ord[ia],ord[ib],c); if(v<best) best=v;}}
    return best;
  }
  // Every member within `lim`: edge (or wall) distances and vertex distances,
  // then folded with the circular smooth minimum.
  const ED=new Float64Array(K*K), VD=[], MEM=[];
  function members(lim, walls){
    sortPlanes();
    ED.fill(Infinity); VD.length=0;
    for(let ic=3;ic<K;ic++){const c=ord[ic]; if(C[c]>=lim) break;
      for(let ib=2;ib<ic;ib++) for(let ia=1;ia<ib;ia++){
        const a=ord[ia], b=ord[ib], v=vertexDist(a,b,c);
        if(v===Infinity) continue;
        VD.push(v);
        const ab=a*K+b, ac=a*K+c, bc=b*K+c, ba=b*K+a, ca=c*K+a, cb=c*K+b;
        if(v<ED[ab]){ED[ab]=v;ED[ba]=v;} if(v<ED[ac]){ED[ac]=v;ED[ca]=v;} if(v<ED[bc]){ED[bc]=v;ED[cb]=v;}
      }}
    for(let ib=2;ib<K;ib++){const b=ord[ib]; if(C[b]>=lim) break;
      for(let ia=1;ia<ib;ia++){const a=ord[ia], d2=lineDist2(a,b);
        if(d2>=0){const d=Math.sqrt(d2);ED[a*K+b]=d;ED[b*K+a]=d;}}}
    MEM.length=0;
    if(walls){
      for(let j=1;j<K;j++){
        if(C[j]>=lim) continue;
        let d=inside(C[j]*NX[j],C[j]*NY[j],C[j]*NZ[j],j,-1,-1)?C[j]:Infinity;
        if(d===Infinity) for(let i=1;i<K;i++) if(i!==j&&ED[i*K+j]<d) d=ED[i*K+j];
        if(d<Infinity) MEM.push(d);
      }
    } else {
      for(let a=1;a<K;a++) for(let b=a+1;b<K;b++) if(ED[a*K+b]<Infinity) MEM.push(ED[a*K+b]);
    }
    if(NR>0) for(const v of VD) MEM.push(v-NR);
    return MEM;
  }
  // Circular smooth minimum, folded over ascending values: each pair meets in a
  // circular fillet of radius k; values more than k above the running minimum
  // change nothing.
  function smin(list,k){
    list.sort((a,b)=>a-b);
    let m=list.length?list[0]:Infinity;
    if(k<=0) return m;
    for(let i=1;i<list.length&&list[i]<m+k;i++){
      const h=Math.max(k-Math.abs(m-list[i]),0)/k;
      m=Math.min(m,list[i])-k*0.5*(1+h-Math.sqrt(1-h*(h-2)));
    }
    return m;
  }
  // Wet: distance from p to the cell shrunk by the border radius (0 inside it),
  // over its faces, edges and vertices.
  function shrunkDist(){
    let out=false;
    for(let j=1;j<K;j++) if(C[j]<0){out=true;break;}
    if(!out) return 0;
    let best=Infinity;
    for(let j=1;j<K;j++){
      const d=Math.abs(C[j]);
      if(d<best&&inside(C[j]*NX[j],C[j]*NY[j],C[j]*NZ[j],j,-1,-1)) best=d;
    }
    for(let a=1;a<K;a++) for(let b=a+1;b<K;b++){
      const d2=lineDist2(a,b); if(d2>=0&&d2<best*best) best=Math.sqrt(d2);
    }
    for(let a=1;a<K;a++) for(let b=a+1;b<K;b++) for(let c=b+1;c<K;c++){
      const v=vertexDist(a,b,c); if(v<best) best=v;
    }
    return best;
  }
  const smooth=(e0,e1,x)=>{const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return t*t*(3-2*t);};
  // Far from the foam only the sign matters: past `cap` the distance is
  // clamped, which keeps it a safe under-estimate (still 1-Lipschitz).
  const cap=2+Kp+FK+NR;   // not tied to thickness, so field + t is thickness-free (lab threshold sweeps)

  return p=>{
    const px=((p[0]+H)%L+L)%L-H, py=((p[1]+H)%L+L)%L-H, pz=((p[2]+H)%L+L)%L-H;
    nearestK(px,py,pz);
    if(mode==='wet'){
      planes(BR);
      return BR-Math.min(shrunkDist(),BR+1)+0.02*BR;
    }
    planes(0);
    let E=0;
    if(Kp>0) E=Kp*(1-smooth(0,0.35,Math.sqrt(D[2])-Math.sqrt(D[0])));
    const walls=mode==='closed';
    let base;
    if(FK>0||NR>0){
      const m0=walls?wallDist():strutDist(cap);
      base=m0<cap?smin(members(m0+FK+NR+1e-9,walls),FK):cap;
      base=Math.min(base,cap);
    } else base=walls?wallDist():strutDist(cap);
    return base-T-E;
  };
}

// ==== END verbatim mesh port ==================================================


/* ════════════════════════════════════════════════════════════
   Lab wrapper
   ════════════════════════════════════════════════════════════ */

/* Generator settings that decide the seed layout (positions_for stamp). */
function foamSeedKey(sd) {
  sd = sd || {};
  var k = [sd.mode || null, sd.count != null ? +sd.count : null,
    sd.regularity != null ? +sd.regularity : null, sd.lloyd_iterations != null ? +sd.lloyd_iterations : null,
    sd.rng_seed != null ? +sd.rng_seed : null];
  /* v0.17.3 — generator settings of the newer seed modes (left off when unset,
     so stamps on older recipes are unchanged) */
  if (sd.size_ratio != null || sd.large_fraction != null || sd.jitter != null)
    k.push(sd.size_ratio != null ? +sd.size_ratio : null, sd.large_fraction != null ? +sd.large_fraction : null, sd.jitter != null ? +sd.jitter : null);
  return JSON.stringify(k);
}

/* The foam tool's recipe → the json buildFoamSDF expects.  Stored
   positions ride along only while the settings match their stamp. */
function foamMeshJson(recipe) {
  var sd = recipe.seeds || {}, seeds = {};
  for (var k in sd) if (k !== 'positions' && k !== 'positions_for' && k !== 'weights') seeds[k] = sd[k];
  var stampOk = (sd.positions_for == null) || (sd.positions_for === foamSeedKey(sd));
  if (stampOk && Array.isArray(sd.positions)) { seeds.positions = sd.positions; if (Array.isArray(sd.weights)) seeds.weights = sd.weights; }
  return { seeds: seeds, anisotropy: recipe.anisotropy || {}, geometry: recipe.foam || {} };
}

/* Small cache: the viewer, sweep and solvers each parse the same recipe. */
var _foamSdfCache = [];
function foamSdfFor(recipe) {
  var json = foamMeshJson(recipe);
  var key = JSON.stringify(json);
  for (var i = 0; i < _foamSdfCache.length; i++) if (_foamSdfCache[i].key === key) return _foamSdfCache[i].sdf;
  var sdf = buildFoamSDF(json);
  _foamSdfCache.unshift({ key: key, sdf: sdf });
  if (_foamSdfCache.length > 6) _foamSdfCache.length = 6;
  return sdf;
}

var FOAM_W = 5 / Math.PI, FOAM_OUT = Math.PI / 5;

var FoamKernel = {
  family: 'foam',
  FoamSeeds: FoamSeeds,

  parseRecipe: function (recipe) {
    if (!recipe.family) recipe.family = 'foam';
    return { sdf: foamSdfFor(recipe), p: [0, 0, 0] };
  },

  /* NEGATIVE-INSIDE SDF in solver space. */
  evaluate: function (params, x, y, z) {
    var p = params.p;
    p[0] = x * FOAM_W; p[1] = y * FOAM_W; p[2] = z * FOAM_W;
    return params.sdf(p) * FOAM_OUT;
  }
};

if (typeof KERNELS !== 'undefined') KERNELS.foam = FoamKernel;

/* node/test harness export (browser ignores) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FoamKernel: FoamKernel, FoamSeeds: FoamSeeds, buildFoamSDF: buildFoamSDF,
                     foamSeedsFromRecipe: foamSeedsFromRecipe, foamMeshJson: foamMeshJson, foamSeedKey: foamSeedKey };
}
