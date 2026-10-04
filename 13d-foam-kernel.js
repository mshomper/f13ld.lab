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
  const VERSION = 1;
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

  const MODES = ['poisson', 'lloyd', 'random', 'weairePhelan', 'kelvin'];
  const LATTICE_MODES = ['weairePhelan', 'kelvin'];

  // One entry point. opts: {mode, count, regularity, lloydIter, rngSeed,
  // periodic, maxSeeds}. Returns {seeds, minSpacing} (minSpacing 0 when the
  // mode has no enforced gap). Output is capped at maxSeeds (default 1024).
  function generate(opts){
    const rng = mulberry32(opts.rngSeed | 0);
    const periodic = !!opts.periodic;
    const count = Math.max(1, opts.count | 0);
    let seeds = [], minSpacing = 0;
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
      case 'weairePhelan': seeds = genLattice(WP_BASIS, count); break;
      case 'kelvin':       seeds = genLattice(KELVIN_BASIS, count); break;
      default: throw new Error('Unknown foam seed mode "' + opts.mode + '"');
    }
    return {seeds: seeds.slice(0, opts.maxSeeds || 1024), minSpacing};
  }

  return {VERSION, MODES, LATTICE_MODES, meanSpacing, generate};
})();
// ==== END FoamSeeds ===========================================================

// ==== BEGIN verbatim mesh port (m25-sdf-foam.js foamSeedsFromRecipe + buildFoamSDF) ====
function foamSeedsFromRecipe(json){
  const sd=json.seeds||{};
  if(Array.isArray(sd.positions) && sd.positions.length>=3){
    const out=[];
    for(let i=0;i+2<sd.positions.length;i+=3) out.push([sd.positions[i],sd.positions[i+1],sd.positions[i+2]]);
    return out;
  }
  return FoamSeeds.generate({
    mode: sd.mode, count: sd.count, regularity: sd.regularity!=null?sd.regularity:0.9,
    lloydIter: sd.lloyd_iterations||0, rngSeed: sd.rng_seed||0, periodic: true
  }).seeds;
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
// field above unchanged. For a point p in the cell of its nearest seed s₁:
//   wall distance  = min over neighbours j of the distance to the bisector
//                    plane of s₁, sⱼ:  (|p−sⱼ|²ₘ − |p−s₁|²ₘ) / (2|M(sⱼ−s₁)|)
//   strut distance = distance to the cell's edges: the nearest point on a line
//                    where two planes meet, or a vertex where three meet,
//                    kept only if it lies inside every other plane.
// |·|ₘ is the stretched metric M = diag(1/stretch²); its bisectors are still
// planes in real space, so both distances are true Euclidean millimetres.
// The 8 nearest seeds are searched over the seeds and their periodic copies,
// so a cell may border its own copy (few seeds, single-cube lattices).
// Solid where < 0:  closed: wall − t − E   open/plateau: strut − t − E
// E (plateau swell, organic bulge) is the same as above, from metric dᵢ.
function buildFoamSDF2(json){
  const seeds=foamSeedsFromRecipe(json);
  const N=seeds.length;
  const g=json.geometry||{};
  const an=json.anisotropy||{};
  const st=(an.enabled&&Array.isArray(an.stretch)&&an.stretch.length===3)?an.stretch.map(v=>(isFinite(v)&&v>0)?v:1):[1,1,1];
  const mx=1/(st[0]*st[0]), my=1/(st[1]*st[1]), mz=1/(st[2]*st[2]);
  const mode=g.mode==='open'||g.mode==='closed'?g.mode:'plateau';
  const T=(typeof g.thickness==='number'&&g.thickness>0)?g.thickness:0.08;
  const Kp=(mode==='plateau'&&typeof g.plateau_k==='number')?g.plateau_k:0;
  const O=(typeof g.organic==='number'&&g.organic>0)?g.organic:0;
  const oAmp=O*2.0, oReach=0.10+Math.pow(O,0.6)*0.25;
  const L=10, H=5, K=8;

  // Seeds plus every periodic copy within `pad` of the tile, binned on a
  // plain (non-wrapping) grid over the padded box.
  const s0=FoamSeeds.meanSpacing(N), smax=Math.max(st[0],st[1],st[2]);
  const pad=Math.min(L,3*s0*smax), B=H+pad;
  const PX=[], PY=[], PZ=[];
  for(let a=-1;a<=1;a++) for(let b=-1;b<=1;b++) for(let c=-1;c<=1;c++)
    for(let i=0;i<N;i++){
      const x=seeds[i][0]+a*L, y=seeds[i][1]+b*L, z=seeds[i][2]+c*L;
      if(x>=-B&&x<=B&&y>=-B&&y<=B&&z>=-B&&z<=B){PX.push(x);PY.push(y);PZ.push(z);}
    }
  const M=PX.length;
  const G=Math.max(1,Math.min(48,Math.round(2*B/s0))), cs=2*B/G, nC=G*G*G;
  const cI=v=>Math.min(G-1,Math.max(0,Math.floor((v+B)/cs)));
  const cellOf=new Int32Array(M), start=new Int32Array(nC+1);
  for(let i=0;i<M;i++){const c=cI(PX[i])+G*(cI(PY[i])+G*cI(PZ[i]));cellOf[i]=c;start[c+1]++;}
  for(let c=0;c<nC;c++) start[c+1]+=start[c];
  const fill=start.slice(0,nC), SX=new Float64Array(M), SY=new Float64Array(M), SZ=new Float64Array(M);
  for(let i=0;i<M;i++){const k=fill[cellOf[i]]++;SX[k]=PX[i];SY[k]=PY[i];SZ[k]=PZ[i];}
  const rm=cs/smax;   // metric radius a ring of R cells is guaranteed to cover, per R

  // 8 nearest: squared metric distance + real displacement p − s of each.
  const D=new Float64Array(K), VX=new Float64Array(K), VY=new Float64Array(K), VZ=new Float64Array(K);
  function consider(k,px,py,pz){
    const vx=px-SX[k], vy=py-SY[k], vz=pz-SZ[k];
    const d=vx*vx*mx+vy*vy*my+vz*vz*mz;
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
      if(Math.sqrt(D[K-1])<=R*rm) return;
    }
  }

  // Cell planes in a frame centred on p: inside where n·x ≤ c (c ≥ 0 = distance).
  const NX=new Float64Array(K), NY=new Float64Array(K), NZ=new Float64Array(K), C=new Float64Array(K), ord=new Int32Array(K);
  function planes(){
    for(let j=1;j<K;j++){
      const ax=(VX[0]-VX[j])*mx, ay=(VY[0]-VY[j])*my, az=(VZ[0]-VZ[j])*mz;
      const l=Math.sqrt(ax*ax+ay*ay+az*az)||1e-12;
      NX[j]=ax/l; NY[j]=ay/l; NZ[j]=az/l; C[j]=(D[j]-D[0])/(2*l);
    }
  }
  function inside(x,y,z,s0,s1,s2){
    for(let j=1;j<K;j++){
      if(j===s0||j===s1||j===s2) continue;
      if(NX[j]*x+NY[j]*y+NZ[j]*z>C[j]+1e-9) return false;
    }
    return true;
  }
  function wallDist(){let m=Infinity;for(let j=1;j<K;j++) if(C[j]<m) m=C[j];return m;}
  function vertexDist(a,b,c){
    const bx=NY[b]*NZ[c]-NZ[b]*NY[c], by=NZ[b]*NX[c]-NX[b]*NZ[c], bz=NX[b]*NY[c]-NY[b]*NX[c];
    const det=NX[a]*bx+NY[a]*by+NZ[a]*bz;
    if(Math.abs(det)<1e-12) return Infinity;
    const cx=NY[c]*NZ[a]-NZ[c]*NY[a], cy=NZ[c]*NX[a]-NX[c]*NZ[a], cz=NX[c]*NY[a]-NY[c]*NX[a];
    const ax=NY[a]*NZ[b]-NZ[a]*NY[b], ay=NZ[a]*NX[b]-NX[a]*NZ[b], az=NX[a]*NY[b]-NY[a]*NX[b];
    const x=(C[a]*bx+C[b]*cx+C[c]*ax)/det, y=(C[a]*by+C[b]*cy+C[c]*ay)/det, z=(C[a]*bz+C[b]*cz+C[c]*az)/det;
    return inside(x,y,z,a,b,c)?Math.sqrt(x*x+y*y+z*z):Infinity;
  }
  // Planes sorted by distance prune the search: a line on planes a, b is at
  // least max(c_a, c_b) away, a vertex at least the largest of its three.
  function strutDist(cap){
    for(let j=1;j<K;j++) ord[j]=j;
    for(let i=2;i<K;i++){const v=ord[i];let j=i;while(j>1&&C[ord[j-1]]>C[v]){ord[j]=ord[j-1];j--;}ord[j]=v;}
    let best=cap;
    for(let ib=2;ib<K;ib++){const b=ord[ib]; if(C[b]>=best) break;
      for(let ia=1;ia<ib;ia++){const a=ord[ia];
        const cab=NX[a]*NX[b]+NY[a]*NY[b]+NZ[a]*NZ[b], det=1-cab*cab;
        if(det<1e-12) continue;
        const al=(C[a]-C[b]*cab)/det, be=(C[b]-C[a]*cab)/det, d2=al*C[a]+be*C[b];
        if(d2<best*best&&inside(al*NX[a]+be*NX[b],al*NY[a]+be*NY[b],al*NZ[a]+be*NZ[b],a,b,-1)) best=Math.sqrt(d2);
      }}
    for(let ic=3;ic<K;ic++){const c=ord[ic]; if(C[c]>=best) break;
      for(let ib=2;ib<ic;ib++) for(let ia=1;ia<ib;ia++){const v=vertexDist(ord[ia],ord[ib],c); if(v<best) best=v;}}
    return best;
  }
  const smooth=(e0,e1,x)=>{const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return t*t*(3-2*t);};
  // Far from the struts only the sign matters: past `cap` the strut distance
  // is clamped, which keeps it a safe under-estimate (still 1-Lipschitz).
  const cap=T*(1+oAmp)+Kp+0.5;

  return p=>{
    const px=((p[0]+H)%L+L)%L-H, py=((p[1]+H)%L+L)%L-H, pz=((p[2]+H)%L+L)%L-H;
    nearestK(px,py,pz);
    planes();
    let E=0;
    if(Kp>0||oAmp>0){
      const d1=Math.sqrt(D[0]), d3=Math.sqrt(D[2]), d4=Math.sqrt(D[3]);
      if(Kp>0) E+=Kp*(1-smooth(0,0.35,d3-d1));
      if(oAmp>0) E+=oAmp*T*Math.pow(1-smooth(0,oReach,d4-d1),1.4);
    }
    return (mode==='closed'?wallDist():strutDist(cap))-T-E;
  };
}

// ==== END verbatim mesh port ==================================================


/* ════════════════════════════════════════════════════════════
   Lab wrapper
   ════════════════════════════════════════════════════════════ */

/* Generator settings that decide the seed layout (positions_for stamp). */
function foamSeedKey(sd) {
  sd = sd || {};
  return JSON.stringify([sd.mode || null, sd.count != null ? +sd.count : null,
    sd.regularity != null ? +sd.regularity : null, sd.lloyd_iterations != null ? +sd.lloyd_iterations : null,
    sd.rng_seed != null ? +sd.rng_seed : null]);
}

/* The foam tool's recipe → the json buildFoamSDF expects.  Stored
   positions ride along only while the settings match their stamp. */
function foamMeshJson(recipe) {
  var sd = recipe.seeds || {}, seeds = {};
  for (var k in sd) if (k !== 'positions' && k !== 'positions_for') seeds[k] = sd[k];
  var stampOk = (sd.positions_for == null) || (sd.positions_for === foamSeedKey(sd));
  if (stampOk && Array.isArray(sd.positions)) seeds.positions = sd.positions;
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
