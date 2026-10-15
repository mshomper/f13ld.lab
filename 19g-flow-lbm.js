/* ============================================================
   F13LD.lab · 19g-flow-lbm.js   (v0.28.0 — fluids Phase 1)
   GPU lattice Boltzmann solver for steady creeping flow through the
   periodic unit cell: permeability tensor, hydraulic tortuosity, open and
   sealed porosity (docs/FLUIDS_LBM_SCOPE.md §3, §12).

   The kernel is the one proto/lbm-bench measured on Matt's RTX 4070 Ti
   Super (2026-10-14: 5,000 M node updates/s at 64³, 2,000 M at 128³) and
   checked against the Float64 reference 19f-flow-cpu-ref.js (populations
   within 7e-7 after 600 steps):
   · D3Q19, TRT with Λ = 3/16 (τ⁺ = 1.5 — the steady answer does not depend
     on τ⁺ with CLI walls, check F3), Guo body force, shifted populations
     (f − w) in FP32, fused pull-stream-collide, A/B buffers.
   · Walls: central linear interpolation (CLI) on the sub-voxel wall
     fraction of each link from 14e buildFlowLinks, halfway bounce-back where
     the node behind is not free.  Tables: a flag word per cell (bit 0
     solid, bits 1–18 walled incoming directions) and, for wall cells only,
     a slot into a table of 18 q values.
   · Mass: the wall leak is summed each step (workgroup partial sums, then
     one reduce dispatch) and taken off the rest populations in the next
     step, all on the GPU.  The same reduce gives the mean velocity and the
     mean speed; they are read back every 500 steps for the convergence test.

   Domain: the fluid phase (cells the island-trimmed solid leaves empty,
   trimmed islands included) minus sealed pores — fluid components that do
   not reach their own periodic copy (14a periodicComponents on 1 − solid,
   6-connected) carry no flow and are treated as solid.  An axis no open
   pore network reaches along reads zero permeability and is not solved.

   One solve per open axis, force g along it from rest, until the mean
   velocity changes by less than tol over 500 steps (Standard 1e-6, High
   1e-7; at least 1,000 steps).  Darcy: K e_j = ν ⟨u⟩ / g in cells²
   (superficial mean, ρ₀ = 1); k / L² = K / N²; hydraulic tortuosity
   τ_h = ⟨|u|⟩ / ⟨u · e_j⟩.

   API
     homogenizeFlowGPU(recipe, N, opts) → result (below)
       opts: { connectivity, pruneLargest, tol (1e-6), tauPlus (1.5),
               maxSteps (200000), isStale(), onVoxelProgress(p),
               onProgress({ axis, index, total, step, rel }) }
     result: { N, K[9] (cells², column j = force along j), Ksym[9], asym,
               kL2 [x, y, z], tort [x, y, z], perAxis [{ open, converged,
               steps, t_ms, U }], porosity, openPorosity, sealedPorosity,
               openBits, axialBits, throatVox, medPoreVox, nWall, nThin,
               t_links_ms, t_solve_ms, workers, reused, tauPlus, tol, g,
               wss (v0.30.0) { n, pos, nrm, area, nSplit, axes [x, y, z] (19h flowWallTractions or null), t_ms }, wssKey }
     flowGPUTables(links, mask)         wall tables for the kernel
     flowGPUSolver(N) / flowGPURelease() the cached solver (WGPU_DEVICE_CACHE_KEYS)
   ============================================================ */

var FLOW_GPU_VERSION = 'fg-3';   /* v0.30.0 — runs keep wall shear per probe (19h); fg-2 v0.29.0 velocity fields for the flow view */
var FLOW_TAU_PLUS = 1.5;
var FLOW_CHECK_EVERY = 500;
var FLOW_MIN_STEPS = 1000;

var FLOW_CX = [0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
var FLOW_CY = [0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1];
var FLOW_CZ = [0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1];

/* Wall tables — the rules of 19f prepareFlowDomain with CLI walls.  mask
   (Uint8 N³, 1 = in the flow domain) removes sealed pores. */
function flowGPUTables(links, mask) {
  var N = links.N, NN = N * N, N3 = NN * N, solid = links.solid, Q = 19;
  var flags = new Uint32Array(N3), wslot = new Uint32Array(N3), nWall = 0, nFallback = 0, nFluid = 0, nWallCells = 0;
  function blocked(p) { return solid[p] || (mask && !mask[p]); }
  function nbr(p, cx, cy, cz) {
    var i = (p / NN) | 0, j = ((p / N) | 0) % N, k = p % N;
    return ((i + cx + N) % N) * NN + ((j + cy + N) % N) * N + ((k + cz + N) % N);
  }
  /* q of the link leaving p along lattice direction dir (1..18) */
  function qOut(p, dir) {
    var d = (dir - 1) >> 1;
    if (dir & 1) return links.qa[d][p];
    var v = FLOW_DIRS[d];
    return links.qb[d][nbr(p, -v[0], -v[1], -v[2])];
  }
  var qrows = [], qrow = new Float32Array(18);
  for (var x = 0; x < N3; x++) {
    if (blocked(x)) { flags[x] = 1; continue; }
    nFluid++;
    var f = 0;
    for (var i = 1; i < Q; i++) {
      var j = (i & 1) ? i + 1 : i - 1;
      var q = qOut(x, j), src = nbr(x, -FLOW_CX[i], -FLOW_CY[i], -FLOW_CZ[i]);
      qrow[i - 1] = 0;
      if (!(q > 0) && !blocked(src)) continue;
      if (!(q > 0)) q = 0.5;
      if (q !== 0.5) {
        var behind = nbr(x, FLOW_CX[i], FLOW_CY[i], FLOW_CZ[i]);
        if (blocked(behind) || qOut(x, i) > 0) { q = 0.5; nFallback++; }
      }
      f |= (1 << i); qrow[i - 1] = q; nWall++;
    }
    if (f) { flags[x] = f >>> 0; wslot[x] = nWallCells++; qrows.push(Float32Array.from(qrow)); }
  }
  var qtab = new Float32Array(Math.max(18, 18 * nWallCells));
  for (var r = 0; r < qrows.length; r++) qtab.set(qrows[r], 18 * r);
  return { N: N, N3: N3, flags: flags, wslot: wslot, qtab: qtab, nWall: nWall, nFallback: nFallback, nFluid: nFluid, nWallCells: nWallCells };
}

/* ---------- WGSL ---------- */
/* Pull streaming with the CLI wall rule into f0 … f18 (shared by the step
   and the v0.30.0 stress kernel, so both read the same populations). */
function flowGatherWGSL(L, at) {
  L.push('    var f0 = fin[c] - red[0];');
  for (var i = 1; i < 19; i++) L.push('    var f' + i + ' = fin[' + i + 'u * N3 + ' + at(-FLOW_CX[i], -FLOW_CY[i], -FLOW_CZ[i]) + '];');
  L.push('    if (fl > 1u) { let ws = wslot[c] * 18u;');
  for (var i2 = 1; i2 < 19; i2++) {
    var j = (i2 & 1) ? i2 + 1 : i2 - 1;
    L.push('      if ((fl & ' + (1 << i2) + 'u) != 0u) { let q = qtab[ws + ' + (i2 - 1) + 'u]; let kap = (1.0 - 2.0 * q) / (1.0 + 2.0 * q);');
    L.push('        f' + i2 + ' = fin[' + j + 'u * N3 + c] + kap * (fin[' + j + 'u * N3 + ' + at(FLOW_CX[i2], FLOW_CY[i2], FLOW_CZ[i2]) + '] - fin[' + i2 + 'u * N3 + c]); }');
  }
  L.push('    }');
}
/* v0.30.0 — viscous stress and ρ − 1 at every fluid cell, from the
   populations the next step would collide (19f fields, Krüger, Varnik &
   Raabe 2009): σ' = −(1 − ω⁺/2)[Σ f^neq c c + ½(F u + u F)].  7 floats
   per cell: σxx σyy σzz σxy σxz σyz, ρ − 1; solid cells 0. */
function flowStressWGSL() {
  var ax = ['xm', 'x0', 'xp'], ay = ['ym', 'y0', 'yp'], az = ['zm', 'z0', 'zp'], L = [];
  function at(dx, dy, dz) { return '((' + ax[dx + 1] + ' * N + ' + ay[dy + 1] + ') * N + ' + az[dz + 1] + ')'; }
  L.push('struct Params { N: u32, N3: u32, invFluid: f32, invN3: f32, Fx: f32, Fy: f32, Fz: f32, wP: f32, wM: f32, p0: f32, p1: f32, p2: f32 };');
  L.push('@group(0) @binding(0) var<storage, read> fin: array<f32>;');
  L.push('@group(0) @binding(1) var<storage, read> flags: array<u32>;');
  L.push('@group(0) @binding(2) var<storage, read> wslot: array<u32>;');
  L.push('@group(0) @binding(3) var<storage, read> qtab: array<f32>;');
  L.push('@group(0) @binding(4) var<storage, read> red: array<f32>;');
  L.push('@group(0) @binding(5) var<storage, read_write> sout: array<f32>;');
  L.push('@group(0) @binding(6) var<uniform> P: Params;');
  L.push('@compute @workgroup_size(256)');
  L.push('fn main(@builtin(global_invocation_id) gid: vec3<u32>) {');
  L.push('  let c = gid.x; if (c >= P.N3) { return; }');
  L.push('  let fl = flags[c]; let o = 7u * c;');
  L.push('  if ((fl & 1u) != 0u) { for (var m = 0u; m < 7u; m = m + 1u) { sout[o + m] = 0.0; } return; }');
  L.push('  let N = P.N; let N3 = P.N3; let z0 = c % N; let y0 = (c / N) % N; let x0 = c / (N * N);');
  L.push('  let xm = select(x0 - 1u, N - 1u, x0 == 0u); let xp = select(x0 + 1u, 0u, x0 + 1u == N);');
  L.push('  let ym = select(y0 - 1u, N - 1u, y0 == 0u); let yp = select(y0 + 1u, 0u, y0 + 1u == N);');
  L.push('  let zm = select(z0 - 1u, N - 1u, z0 == 0u); let zp = select(z0 + 1u, 0u, z0 + 1u == N);');
  flowGatherWGSL(L, at);
  L.push('  let dr = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9 + f10 + f11 + f12 + f13 + f14 + f15 + f16 + f17 + f18;');
  L.push('  let jx = f1 - f2 + f7 - f8 + f9 - f10 + f11 - f12 + f13 - f14;');
  L.push('  let jy = f3 - f4 + f7 - f8 - f9 + f10 + f15 - f16 + f17 - f18;');
  L.push('  let jz = f5 - f6 + f11 - f12 - f13 + f14 + f15 - f16 - f17 + f18;');
  L.push('  let rho = 1.0 + dr; let ir = 1.0 / rho; let Fx = P.Fx; let Fy = P.Fy; let Fz = P.Fz;');
  L.push('  let ux = (jx + 0.5 * Fx) * ir; let uy = (jy + 0.5 * Fy) * ir; let uz = (jz + 0.5 * Fz) * ir;');
  L.push('  let u2 = ux * ux + uy * uy + uz * uz;');
  L.push('  var pxx = 0.0; var pyy = 0.0; var pzz = 0.0; var pxy = 0.0; var pxz = 0.0; var pyz = 0.0; var cu: f32; var nq: f32;');
  for (var i = 1; i < 19; i++) {
    var cx = FLOW_CX[i], cy = FLOW_CY[i], cz = FLOW_CZ[i], W = (Math.abs(cx) + Math.abs(cy) + Math.abs(cz)) === 1 ? '(1.0 / 18.0)' : '(1.0 / 36.0)';
    var terms = [];
    if (cx) terms.push((cx > 0 ? '' : '-') + 'ux'); if (cy) terms.push((cy > 0 ? '' : '-') + 'uy'); if (cz) terms.push((cz > 0 ? '' : '-') + 'uz');
    L.push('  cu = ' + terms.join(' + ').replace(/\+ -/g, '- ') + '; nq = f' + i + ' - ' + W + ' * (dr + rho * (3.0 * cu + 4.5 * cu * cu - 1.5 * u2));');
    var acc = [];
    if (cx) acc.push('pxx = pxx + nq;'); if (cy) acc.push('pyy = pyy + nq;'); if (cz) acc.push('pzz = pzz + nq;');
    if (cx && cy) acc.push('pxy = pxy ' + (cx * cy > 0 ? '+' : '-') + ' nq;');
    if (cx && cz) acc.push('pxz = pxz ' + (cx * cz > 0 ? '+' : '-') + ' nq;');
    if (cy && cz) acc.push('pyz = pyz ' + (cy * cz > 0 ? '+' : '-') + ' nq;');
    L.push('  ' + acc.join(' '));
  }
  L.push('  let pre = -(1.0 - 0.5 * P.wP);');
  L.push('  sout[o] = pre * (pxx + Fx * ux); sout[o + 1u] = pre * (pyy + Fy * uy); sout[o + 2u] = pre * (pzz + Fz * uz);');
  L.push('  sout[o + 3u] = pre * (pxy + 0.5 * (Fx * uy + Fy * ux)); sout[o + 4u] = pre * (pxz + 0.5 * (Fx * uz + Fz * ux)); sout[o + 5u] = pre * (pyz + 0.5 * (Fy * uz + Fz * uy));');
  L.push('  sout[o + 6u] = dr;');
  L.push('}');
  return L.join('\n');
}
function flowStepWGSL() {
  var ax = ['xm', 'x0', 'xp'], ay = ['ym', 'y0', 'yp'], az = ['zm', 'z0', 'zp'], L = [];
  function at(dx, dy, dz) { return '((' + ax[dx + 1] + ' * N + ' + ay[dy + 1] + ') * N + ' + az[dz + 1] + ')'; }
  L.push('struct Params { N: u32, N3: u32, invFluid: f32, invN3: f32, Fx: f32, Fy: f32, Fz: f32, wP: f32, wM: f32, p0: f32, p1: f32, p2: f32 };');
  L.push('@group(0) @binding(0) var<storage, read> fin: array<f32>;');
  L.push('@group(0) @binding(1) var<storage, read_write> fout: array<f32>;');
  L.push('@group(0) @binding(2) var<storage, read> flags: array<u32>;');
  L.push('@group(0) @binding(3) var<storage, read> wslot: array<u32>;');
  L.push('@group(0) @binding(4) var<storage, read> qtab: array<f32>;');
  L.push('@group(0) @binding(5) var<storage, read_write> partial: array<vec4<f32>>;');
  L.push('@group(0) @binding(6) var<storage, read> red: array<f32>;');
  L.push('@group(0) @binding(7) var<uniform> P: Params;');
  L.push('var<workgroup> shA: array<vec4<f32>, 256>;');
  L.push('var<workgroup> shB: array<f32, 256>;');
  L.push('@compute @workgroup_size(256)');
  L.push('fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>) {');
  L.push('  let c = gid.x; var acc = vec4<f32>(0.0); var spd = 0.0;');
  L.push('  if (c < P.N3) { let fl = flags[c]; if ((fl & 1u) == 0u) {');
  L.push('    let N = P.N; let N3 = P.N3; let z0 = c % N; let y0 = (c / N) % N; let x0 = c / (N * N);');
  L.push('    let xm = select(x0 - 1u, N - 1u, x0 == 0u); let xp = select(x0 + 1u, 0u, x0 + 1u == N);');
  L.push('    let ym = select(y0 - 1u, N - 1u, y0 == 0u); let yp = select(y0 + 1u, 0u, y0 + 1u == N);');
  L.push('    let zm = select(z0 - 1u, N - 1u, z0 == 0u); let zp = select(z0 + 1u, 0u, z0 + 1u == N);');
  flowGatherWGSL(L, at);
  L.push('    let dr = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9 + f10 + f11 + f12 + f13 + f14 + f15 + f16 + f17 + f18;');
  L.push('    let jx = f1 - f2 + f7 - f8 + f9 - f10 + f11 - f12 + f13 - f14;');
  L.push('    let jy = f3 - f4 + f7 - f8 - f9 + f10 + f15 - f16 + f17 - f18;');
  L.push('    let jz = f5 - f6 + f11 - f12 - f13 + f14 + f15 - f16 - f17 + f18;');
  L.push('    let rho = 1.0 + dr; let ir = 1.0 / rho;');
  L.push('    let Fx = P.Fx; let Fy = P.Fy; let Fz = P.Fz; let wP = P.wP; let wM = P.wM; let hP = 1.0 - 0.5 * wP; let hM = 1.0 - 0.5 * wM;');
  L.push('    let ux = (jx + 0.5 * Fx) * ir; let uy = (jy + 0.5 * Fy) * ir; let uz = (jz + 0.5 * Fz) * ir;');
  L.push('    let u2 = ux * ux + uy * uy + uz * uz; let uFd = ux * Fx + uy * Fy + uz * Fz;');
  L.push('    let b15 = dr - 1.5 * rho * u2; let s3 = -3.0 * uFd;');
  L.push('    let W0 = 1.0 / 3.0; let WA = 1.0 / 18.0; let WD = 1.0 / 36.0;');
  L.push('    fout[c] = f0 - wP * (f0 - W0 * b15) + hP * W0 * s3;');
  L.push('    var cu: f32; var cf: f32; var fp: f32; var fm: f32; var ev: f32; var od: f32;');
  var cu = ['ux', 'uy', 'uz', 'ux + uy', 'ux - uy', 'ux + uz', 'ux - uz', 'uy + uz', 'uy - uz'];
  var cf = ['Fx', 'Fy', 'Fz', 'Fx + Fy', 'Fx - Fy', 'Fx + Fz', 'Fx - Fz', 'Fy + Fz', 'Fy - Fz'];
  for (var d = 0; d < 9; d++) {
    var ip = 1 + 2 * d, im = ip + 1, W = d < 3 ? 'WA' : 'WD';
    L.push('    cu = ' + cu[d] + '; cf = ' + cf[d] + '; fp = 0.5 * (f' + ip + ' + f' + im + '); fm = 0.5 * (f' + ip + ' - f' + im + ');');
    L.push('    ev = -wP * (fp - ' + W + ' * (b15 + 4.5 * rho * cu * cu)) + hP * ' + W + ' * (9.0 * cu * cf + s3);');
    L.push('    od = -wM * (fm - ' + W + ' * 3.0 * rho * cu) + hM * ' + W + ' * 3.0 * cf;');
    L.push('    fout[' + ip + 'u * N3 + c] = f' + ip + ' + ev + od; fout[' + im + 'u * N3 + c] = f' + im + ' + ev - od;');
  }
  L.push('    acc = vec4<f32>(dr, ux, uy, uz); spd = sqrt(u2);');
  L.push('  } }');
  L.push('  shA[li] = acc; shB[li] = spd; workgroupBarrier();');
  L.push('  for (var s = 128u; s > 0u; s = s >> 1u) { if (li < s) { shA[li] = shA[li] + shA[li + s]; shB[li] = shB[li] + shB[li + s]; } workgroupBarrier(); }');
  L.push('  if (li == 0u) { partial[2u * wg.x] = shA[0]; partial[2u * wg.x + 1u] = vec4<f32>(shB[0], 0.0, 0.0, 0.0); }');
  L.push('}');
  return L.join('\n');
}
var FLOW_REDUCE_WGSL = [
  'struct R { nPart: u32, invFluid: f32, invN3: f32, pad: f32 };',
  '@group(0) @binding(0) var<storage, read> partial: array<vec4<f32>>;',
  '@group(0) @binding(1) var<storage, read_write> red: array<f32>;',
  '@group(0) @binding(2) var<uniform> Rp: R;',
  'var<workgroup> shA: array<vec4<f32>, 256>;',
  'var<workgroup> shB: array<f32, 256>;',
  '@compute @workgroup_size(256)',
  'fn main(@builtin(local_invocation_index) li: u32) {',
  '  var a = vec4<f32>(0.0); var b = 0.0; var p = li;',
  '  loop { if (p >= Rp.nPart) { break; } a = a + partial[2u * p]; b = b + partial[2u * p + 1u].x; p = p + 256u; }',
  '  shA[li] = a; shB[li] = b; workgroupBarrier();',
  '  for (var s = 128u; s > 0u; s = s >> 1u) { if (li < s) { shA[li] = shA[li] + shA[li + s]; shB[li] = shB[li] + shB[li + s]; } workgroupBarrier(); }',
  '  if (li == 0u) { red[0] = shA[0].x * Rp.invFluid; red[1] = shA[0].y * Rp.invN3; red[2] = shA[0].z * Rp.invN3; red[3] = shA[0].w * Rp.invN3; red[4] = shB[0] * Rp.invN3; }',
  '}'].join('\n');

/* v0.29.0 — velocity at every fluid cell from the post-collision populations
   (the Guo force adds F to the momentum in collision, so the half-force
   velocity is (Σ f* c − F/2) / ρ), for the flow viewer. */
var FLOW_VELOCITY_WGSL = [
  'struct Params { N: u32, N3: u32, invFluid: f32, invN3: f32, Fx: f32, Fy: f32, Fz: f32, wP: f32, wM: f32, p0: f32, p1: f32, p2: f32 };',
  '@group(0) @binding(0) var<storage, read> fin: array<f32>;',
  '@group(0) @binding(1) var<storage, read> flags: array<u32>;',
  '@group(0) @binding(2) var<storage, read_write> uout: array<f32>;',
  '@group(0) @binding(3) var<uniform> P: Params;',
  '@compute @workgroup_size(256)',
  'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
  '  let c = gid.x; if (c >= P.N3) { return; }',
  '  if ((flags[c] & 1u) != 0u) { uout[3u * c] = 0.0; uout[3u * c + 1u] = 0.0; uout[3u * c + 2u] = 0.0; return; }',
  '  let N3 = P.N3; var f: array<f32, 19>;',
  '  for (var i = 0u; i < 19u; i = i + 1u) { f[i] = fin[i * N3 + c]; }',
  '  var dr = 0.0; for (var i = 0u; i < 19u; i = i + 1u) { dr = dr + f[i]; }',
  '  let jx = f[1] - f[2] + f[7] - f[8] + f[9] - f[10] + f[11] - f[12] + f[13] - f[14];',
  '  let jy = f[3] - f[4] + f[7] - f[8] - f[9] + f[10] + f[15] - f[16] + f[17] - f[18];',
  '  let jz = f[5] - f[6] + f[11] - f[12] - f[13] + f[14] + f[15] - f[16] - f[17] + f[18];',
  '  let ir = 1.0 / (1.0 + dr);',
  '  uout[3u * c] = (jx - 0.5 * P.Fx) * ir; uout[3u * c + 1u] = (jy - 0.5 * P.Fy) * ir; uout[3u * c + 2u] = (jz - 0.5 * P.Fz) * ir;',
  '}'].join('\n');

/* ---------- solver (one per grid, cached per device) ---------- */
function FlowGPUSolver(N) {
  var dev = WGPU.device;
  if (!dev) throw new Error('WebGPU device not ready');
  var N3 = N * N * N, popBytes = 19 * N3 * 4, lim = dev.limits || {};
  var maxBind = lim.maxStorageBufferBindingSize || 134217728, maxBuf = lim.maxBufferSize || 268435456;
  if (popBytes > maxBind || popBytes > maxBuf) {
    var mb = function (b) { return Math.round(b / 1048576) + ' MB'; };
    throw new Error('flow at ' + N + '³ needs ' + mb(popBytes) + ' in one GPU buffer; this GPU allows ' + mb(Math.min(maxBind, maxBuf)) + ' · choose a smaller flow grid');
  }
  this.N = N; this.N3 = N3; this.device = dev; this.popBytes = popBytes;
  var S = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
  function buf(size, usage) { return dev.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage: usage }); }
  this._buf = buf;
  this.A = buf(popBytes, S | CD | CS); this.B = buf(popBytes, S | CD | CS);
  this.flags = buf(N3 * 4, S | CD); this.wslot = buf(N3 * 4, S | CD);
  this.qtab = null; this.qtabLen = 0;
  this.nWG = Math.ceil(N3 / 256);
  this.part = buf(this.nWG * 32, S);
  this.red = buf(32, S | CD | CS);
  this.stage = dev.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | CD });
  this.ub = buf(48, GPUBufferUsage.UNIFORM | CD);
  this.rb = buf(16, GPUBufferUsage.UNIFORM | CD);
  this.pStep = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: flowStepWGSL() }), entryPoint: 'main' } });
  this.pRed = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: FLOW_REDUCE_WGSL }), entryPoint: 'main' } });
  this.pVel = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: FLOW_VELOCITY_WGSL }), entryPoint: 'main' } });
  this.pStress = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: flowStressWGSL() }), entryPoint: 'main' } });
  this.ubuf = null;   /* 3·N³ velocity, made on the first readVelocity */
  this.sbuf = null;   /* v0.30.0 — 7·N³ stress, made on the first readStress */
  this.bytes = 2 * popBytes + 2 * N3 * 4 + this.nWG * 32;
}
FlowGPUSolver.prototype.upload = function (T) {
  var dev = this.device;
  if (T.N !== this.N) throw new Error('flow tables are for ' + T.N + '³, solver is ' + this.N + '³');
  dev.queue.writeBuffer(this.flags, 0, T.flags);
  dev.queue.writeBuffer(this.wslot, 0, T.wslot);
  if (!this.qtab || this.qtabLen < T.qtab.length) {
    if (this.qtab) this.qtab.destroy();
    this.qtabLen = T.qtab.length;
    this.qtab = this._buf(this.qtabLen * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  }
  dev.queue.writeBuffer(this.qtab, 0, T.qtab);
  this.nFluid = T.nFluid;
  var self = this;
  function bg(a, b) {
    return dev.createBindGroup({ layout: self.pStep.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: a } }, { binding: 1, resource: { buffer: b } }, { binding: 2, resource: { buffer: self.flags } },
      { binding: 3, resource: { buffer: self.wslot } }, { binding: 4, resource: { buffer: self.qtab } }, { binding: 5, resource: { buffer: self.part } },
      { binding: 6, resource: { buffer: self.red } }, { binding: 7, resource: { buffer: self.ub } }] });
  }
  this.bgAB = bg(this.A, this.B); this.bgBA = bg(this.B, this.A);
  this.bgR = dev.createBindGroup({ layout: this.pRed.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: this.part } }, { binding: 1, resource: { buffer: this.red } }, { binding: 2, resource: { buffer: this.rb } }] });
  this.bytes = 2 * this.popBytes + 2 * this.N3 * 4 + this.qtabLen * 4 + this.nWG * 32;
};
FlowGPUSolver.prototype._readRed = async function () {
  var dev = this.device, enc = dev.createCommandEncoder();
  enc.copyBufferToBuffer(this.red, 0, this.stage, 0, 32); dev.queue.submit([enc.finish()]);
  await this.stage.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(this.stage.getMappedRange().slice(0)); this.stage.unmap(); return v;
};
/* One steady solve from rest with body force F (lattice units). */
FlowGPUSolver.prototype.solve = async function (F, opts) {
  opts = opts || {};
  var dev = this.device, tauP = opts.tauPlus || FLOW_TAU_PLUS, tol = opts.tol || 1e-6;
  var every = opts.checkEvery || FLOW_CHECK_EVERY, maxSteps = opts.maxSteps || 200000, minSteps = opts.minSteps || FLOW_MIN_STEPS;
  var tauM = 0.5 + (3 / 16) / (tauP - 0.5), wP = 1 / tauP, wM = 1 / tauM;
  var u = new ArrayBuffer(48), uu = new Uint32Array(u), uf = new Float32Array(u);
  uu[0] = this.N; uu[1] = this.N3; uf[2] = 1 / this.nFluid; uf[3] = 1 / this.N3; uf[4] = F[0]; uf[5] = F[1]; uf[6] = F[2]; uf[7] = wP; uf[8] = wM;
  dev.queue.writeBuffer(this.ub, 0, u);
  var ru = new ArrayBuffer(16), ruu = new Uint32Array(ru), ruf = new Float32Array(ru);
  ruu[0] = this.nWG; ruf[1] = 1 / this.nFluid; ruf[2] = 1 / this.N3;
  dev.queue.writeBuffer(this.rb, 0, ru);
  var enc0 = dev.createCommandEncoder();
  enc0.clearBuffer(this.A); enc0.clearBuffer(this.B); enc0.clearBuffer(this.red);
  dev.queue.submit([enc0.finish()]);
  var parity = 0, steps = 0, prev = null, rel = 1, R = null, t0 = performance.now(), history = [];
  while (steps < maxSteps) {
    var enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
    for (var s = 0; s < every; s++) {
      pass.setPipeline(this.pStep); pass.setBindGroup(0, parity ? this.bgBA : this.bgAB); pass.dispatchWorkgroups(this.nWG);
      pass.setPipeline(this.pRed); pass.setBindGroup(0, this.bgR); pass.dispatchWorkgroups(1);
      parity ^= 1;
    }
    pass.end(); dev.queue.submit([enc.finish()]); steps += every;
    R = await this._readRed();
    if (opts.isStale && opts.isStale()) return null;
    var Um = Math.hypot(R[1], R[2], R[3]);
    rel = prev ? Math.hypot(R[1] - prev[0], R[2] - prev[1], R[3] - prev[2]) / Math.max(Um, 1e-30) : 1;
    prev = [R[1], R[2], R[3]];
    history.push(rel);
    if (opts.onStep) opts.onStep({ step: steps, rel: rel });
    if (!isFinite(Um)) break;
    if (steps >= minSteps && rel < tol) break;
  }
  this._last = parity ? this.B : this.A;
  return { U: [R[1], R[2], R[3]], Uabs: R[4], massCorr: R[0], steps: steps, rel: rel, converged: rel < tol,
           history: history, t_ms: performance.now() - t0, nu: (tauP - 0.5) / 3 };
};
/* Current populations (after the last solve), solver order i·N³ + cell. */
/* v0.29.0 — the converged velocity field of the last solve, 3 floats per
   cell in solver order (lattice units).  Uses that solve's force. */
FlowGPUSolver.prototype.readVelocity = async function () {
  var dev = this.device, bytes = 3 * this.N3 * 4;
  if (!this.ubuf) this.ubuf = this._buf(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  var bg = dev.createBindGroup({ layout: this.pVel.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: this._last || this.A } }, { binding: 1, resource: { buffer: this.flags } },
    { binding: 2, resource: { buffer: this.ubuf } }, { binding: 3, resource: { buffer: this.ub } }] });
  var rd = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  var enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
  pass.setPipeline(this.pVel); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(this.nWG); pass.end();
  enc.copyBufferToBuffer(this.ubuf, 0, rd, 0, bytes); dev.queue.submit([enc.finish()]);
  await rd.mapAsync(GPUMapMode.READ); var v = new Float32Array(rd.getMappedRange().slice(0)); rd.unmap(); rd.destroy(); return v;
};
/* v0.30.0 — stress and ρ − 1 of the last solve, 7 floats per cell (flowStressWGSL). */
FlowGPUSolver.prototype.readStress = async function () {
  var dev = this.device, bytes = 7 * this.N3 * 4;
  if (!this.sbuf) this.sbuf = this._buf(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  var bg = dev.createBindGroup({ layout: this.pStress.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: this._last || this.A } }, { binding: 1, resource: { buffer: this.flags } },
    { binding: 2, resource: { buffer: this.wslot } }, { binding: 3, resource: { buffer: this.qtab } },
    { binding: 4, resource: { buffer: this.red } }, { binding: 5, resource: { buffer: this.sbuf } }, { binding: 6, resource: { buffer: this.ub } }] });
  var rd = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  var enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
  pass.setPipeline(this.pStress); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(this.nWG); pass.end();
  enc.copyBufferToBuffer(this.sbuf, 0, rd, 0, bytes); dev.queue.submit([enc.finish()]);
  await rd.mapAsync(GPUMapMode.READ); var v = new Float32Array(rd.getMappedRange().slice(0)); rd.unmap(); rd.destroy(); return v;
};
FlowGPUSolver.prototype.readState = async function () {
  var dev = this.device, rd = dev.createBuffer({ size: this.popBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  var enc = dev.createCommandEncoder(); enc.copyBufferToBuffer(this._last || this.A, 0, rd, 0, this.popBytes); dev.queue.submit([enc.finish()]);
  await rd.mapAsync(GPUMapMode.READ); var v = new Float32Array(rd.getMappedRange().slice(0)); rd.unmap(); rd.destroy(); return v;
};
FlowGPUSolver.prototype.destroy = function () {
  ['A', 'B', 'flags', 'wslot', 'qtab', 'part', 'red', 'stage', 'ub', 'rb', 'ubuf', 'sbuf'].forEach(function (k) { if (this[k]) { try { this[k].destroy(); } catch (e) {} this[k] = null; } }, this);
};

function flowGPUSolver(N) {
  var c = window.__flowGPU;
  if (c && c.N === N && c.device === WGPU.device) return c;
  if (c) { try { c.destroy(); } catch (e) {} }
  c = new FlowGPUSolver(N);
  window.__flowGPU = c;
  return c;
}
function flowGPURelease() {
  if (window.__flowGPU) { try { window.__flowGPU.destroy(); } catch (e) {} window.__flowGPU = null; }
}
if (typeof WGPU_DEVICE_CACHE_KEYS !== 'undefined' && WGPU_DEVICE_CACHE_KEYS.indexOf('__flowGPU') < 0) WGPU_DEVICE_CACHE_KEYS.push('__flowGPU');

/* ---------- v0.29.0 — velocity fields for the viewer ----------
   Kept at M = min(N, 64) per axis (128³ averaged over 2×2×2 blocks), half
   precision, as the velocity for a unit body force along that axis divided
   by N² — a scale-free field: any flow direction is Σ_j G_j ũ_j (flow is
   linear at these speeds).  mask: open-pore cells at M (a block counts as
   pore when at least half of it is).  About 4.7 MB per design. */
var FLOW_VIZ_MAX = 64;
function flowVizInit(mask, N) {
  var M = Math.min(N, FLOW_VIZ_MAX), f = N / M, M3 = M * M * M, mk = new Uint8Array(M3), NN = N * N, MM = M * M;
  for (var I = 0; I < M; I++) for (var J = 0; J < M; J++) for (var K = 0; K < M; K++) {
    var n = 0;
    for (var a = 0; a < f; a++) for (var b = 0; b < f; b++) for (var c = 0; c < f; c++) n += mask[(I * f + a) * NN + (J * f + b) * N + (K * f + c)];
    mk[I * MM + J * M + K] = (2 * n >= f * f * f) ? 1 : 0;
  }
  return { M: M, N: N, mask: mk, u: [null, null, null], mean: [0, 0, 0], version: 1 };
}
function flowVizAddAxis(viz, ax, vel, N, g) {
  var M = viz.M, f = N / M, M3 = M * M * M, NN = N * N, MM = M * M, s = 1 / (g * N * N * f * f * f);
  var h = new Uint16Array(3 * M3), sum = 0, nf = 0;
  for (var I = 0; I < M; I++) for (var J = 0; J < M; J++) for (var K = 0; K < M; K++) {
    var vx = 0, vy = 0, vz = 0;
    for (var a = 0; a < f; a++) for (var b = 0; b < f; b++) for (var c = 0; c < f; c++) {
      var q = 3 * ((I * f + a) * NN + (J * f + b) * N + (K * f + c));
      vx += vel[q]; vy += vel[q + 1]; vz += vel[q + 2];
    }
    vx *= s; vy *= s; vz *= s;
    var o = I * MM + J * M + K;
    h[3 * o] = thermalF32ToF16(vx); h[3 * o + 1] = thermalF32ToF16(vy); h[3 * o + 2] = thermalF32ToF16(vz);
    if (viz.mask[o]) { sum += Math.sqrt(vx * vx + vy * vy + vz * vz); nf++; }
  }
  viz.u[ax] = h; viz.mean[ax] = nf ? sum / nf : 0;
}

/* ---------- fluid connectivity ---------- */
function flowFluidDomain(solid, N) {
  var N3 = N * N * N, fluid = new Uint8Array(N3), nFluid = 0;
  for (var p = 0; p < N3; p++) if (!solid[p]) { fluid[p] = 1; nFluid++; }
  var mask = new Uint8Array(N3), openBits = 0, axialBits = 0, nOpen = 0;
  if (!nFluid) return { mask: mask, nFluid: 0, nOpen: 0, openBits: 0, axialBits: 0 };
  var pc = periodicComponents(fluid, N), open = new Uint8Array(pc.count + 1);
  for (var c = 1; c <= pc.count; c++) if (pc.wraps[c]) { open[c] = 1; openBits |= pc.wraps[c]; axialBits |= pc.axial[c]; }
  for (var q = 0; q < N3; q++) { var l = pc.label[q]; if (l > 0 && open[l]) { mask[q] = 1; nOpen++; } }
  return { mask: mask, nFluid: nFluid, nOpen: nOpen, openBits: openBits, axialBits: axialBits };
}

/* ---------- one design ---------- */
/* v0.28.1 — a failure names the step it happened in ("wall links: …"),
   keeping the original error (with its stack) as the cause. */
async function homogenizeFlowGPU(recipe, N, opts) {
  var st = { step: 'wall links' };
  try { return await _homogenizeFlowGPU(recipe, N, opts || {}, st); }
  catch (err) {
    var e = new Error(st.step + ': ' + ((err && err.message) || err));
    e.cause = err; if (err && err.stack) e.stack = st.step + ' · ' + err.stack;
    throw e;
  }
}
async function _homogenizeFlowGPU(recipe, N, opts, st) {
  var t0 = performance.now(), N3 = N * N * N, tol = opts.tol || 1e-6, tauP = opts.tauPlus || FLOW_TAU_PLUS;
  var links = await buildFlowLinksParallel(recipe, N, { connectivity: opts.connectivity, pruneLargest: opts.pruneLargest }, opts.onVoxelProgress);
  if (opts.isStale && opts.isStale()) return null;
  st.step = 'pore check';
  var dom = flowFluidDomain(links.solid, N);
  var out = { N: N, porosity: dom.nFluid / N3, openPorosity: dom.nOpen / N3, sealedPorosity: (dom.nFluid - dom.nOpen) / N3,
              openBits: dom.openBits, axialBits: dom.axialBits, nWall: 0, nThin: links.nThin, t_links_ms: links.t_ms,
              workers: links.workers, reused: links.reused, tauPlus: tauP, tol: tol,
              K: new Float64Array(9), Ksym: new Float64Array(9), asym: 0, kL2: [0, 0, 0], tort: [NaN, NaN, NaN], perAxis: [] };
  /* narrowest pore (5th percentile of maximal inscribed balls in the open pores), in cells */
  out.throatVox = null; out.medPoreVox = null;
  if (dom.nOpen && dom.nOpen < N3 && typeof sweepFeatureThickness === 'function') {
    var ft = sweepFeatureThickness(dom.mask, N); out.throatVox = ft.thin; out.medPoreVox = ft.med;
  }
  var nOpenAxes = (dom.openBits & 1 ? 1 : 0) + (dom.openBits & 2 ? 1 : 0) + (dom.openBits & 4 ? 1 : 0);
  if (!dom.nOpen || !nOpenAxes) {
    for (var a0 = 0; a0 < 3; a0++) out.perAxis.push({ open: false });
    out.t_solve_ms = 0; out.t_ms = performance.now() - t0; return out;
  }
  st.step = 'GPU tables';
  var T = flowGPUTables(links, dom.mask), probes = links.probes || null;
  links = null;
  out.nWall = T.nWall; out.nFallback = T.nFallback;
  st.step = 'GPU setup';
  var S = flowGPUSolver(N);
  S.upload(T);
  out.gpuBytes = S.bytes;
  /* force scaled so ⟨u⟩ lands near the same lattice speed at every grid */
  var g = 1e-5 * (64 / N) * (64 / N), tS = performance.now(), idx = 0;
  out.g = g;
  var viz = null, fluidMask = null;
  for (var ax = 0; ax < 3; ax++) {
    if (!(dom.openBits & (1 << ax))) { out.perAxis.push({ open: false }); continue; }
    if (opts.onProgress) opts.onProgress({ axis: 'xyz'[ax], index: idx, total: nOpenAxes, step: 0, rel: 1 });
    st.step = 'GPU solve along ' + 'XYZ'[ax];
    var F = [0, 0, 0]; F[ax] = g;
    var r = await S.solve(F, { tol: tol, tauPlus: tauP, maxSteps: opts.maxSteps, isStale: opts.isStale,
      onStep: function (st) { if (opts.onProgress) opts.onProgress({ axis: 'xyz'[ax], index: idx, total: nOpenAxes, step: st.step, rel: st.rel }); } });
    if (!r) return null;
    for (var i = 0; i < 3; i++) out.K[i * 3 + ax] = r.nu * r.U[i] / g;
    out.tort[ax] = r.U[ax] > 0 ? r.Uabs / r.U[ax] : NaN;
    out.perAxis.push({ open: true, converged: r.converged, steps: r.steps, t_ms: r.t_ms, U: r.U, rel: r.rel, massCorr: r.massCorr });
    if (opts.keepFields !== false) {
      st.step = 'velocity field along ' + 'XYZ'[ax];
      var vel = await S.readVelocity();
      if (opts.isStale && opts.isStale()) return null;
      if (!viz) viz = flowVizInit(dom.mask, N);
      flowVizAddAxis(viz, ax, vel, N, g);
    }
    /* v0.30.0 — wall shear per probe for unit force along this axis (19h) */
    if (probes && probes.n && opts.keepWss !== false && typeof flowWallTractions === 'function') {
      st.step = 'wall shear along ' + 'XYZ'[ax];
      var sig = await S.readStress();
      if (opts.isStale && opts.isStale()) return null;
      if (!fluidMask) { fluidMask = new Uint8Array(N3); for (var c0 = 0; c0 < N3; c0++) fluidMask[c0] = (T.flags[c0] & 1) ? 0 : 1; }
      var vOpen = (probes.solidVol > 0) ? N3 - probes.solidVol - (dom.nFluid - dom.nOpen) : 0;
      var tW = performance.now(), tr = flowWallTractions(probes, sig, fluidMask, N, g, ax, vOpen);
      sig = null;
      if (!out.wss) out.wss = { n: probes.n, pos: probes.pos, nrm: probes.nrm, area: probes.area, nSplit: probes.nSplit, axes: [null, null, null], t_ms: 0 };
      out.wss.axes[ax] = tr; out.wss.t_ms += performance.now() - tW;
    }
    idx++;
  }
  if (viz) out.viz = viz;
  if (out.wss) out.wssKey = FLOW_WSS_VERSION + '|' + Date.now().toString(36) + '|' + Math.random().toString(36).slice(2, 8);
  /* symmetrize over solved columns (an unsolved axis has no column) */
  var dia = 0, offd = 0;
  for (var p = 0; p < 3; p++) for (var q = 0; q < 3; q++) {
    var op = !!(dom.openBits & (1 << p)), oq = !!(dom.openBits & (1 << q));
    var v = (op && oq) ? 0.5 * (out.K[p * 3 + q] + out.K[q * 3 + p]) : (p === q && op ? out.K[p * 3 + p] : 0);
    out.Ksym[p * 3 + q] = v;
    if (p === q) dia = Math.max(dia, Math.abs(v));
    else if (op && oq) offd = Math.max(offd, Math.abs(out.K[p * 3 + q] - out.K[q * 3 + p]));
  }
  out.asym = dia > 0 ? offd / dia : 0;
  for (var a1 = 0; a1 < 3; a1++) out.kL2[a1] = out.Ksym[a1 * 4] / (N * N);
  out.t_solve_ms = performance.now() - tS;
  out.t_ms = performance.now() - t0;
  return out;
}

/* ---------- console check (F10): GPU vs the Float64 CPU reference ----------
   runFlowGPUCheck()            design A at 32³, 600 steps, force along x
   runFlowGPUCheck(1, 32, 600)  design B …
   Needs 19f-flow-cpu-ref.js, which index.html does not load; the check
   loads it on demand.  Pass: mean velocity and every population within
   1e-4 relative (the bench measured 1e-6). */
async function runFlowGPUCheck(designIndex, N, steps) {
  designIndex = designIndex || 0; N = N || 32; steps = steps || 600;
  if (typeof prepareFlowDomain !== 'function') {
    await new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = '19f-flow-cpu-ref.js?v=' + FLOW_GPU_VERSION; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  }
  if (typeof ensureDevice === 'function') await ensureDevice();
  var d = LAB_STATE.designs[designIndex], rcp = d && applySelectedMaterial(recipeForDesign(d));
  if (!rcp) { console.warn('[flow check] no recipe for design ' + designIndex); return null; }
  var links = await buildFlowLinksParallel(rcp, N, connOpts()), dom = flowFluidDomain(links.solid, N);
  var T = flowGPUTables(links, dom.mask), cpuDom = prepareFlowDomain(links, { wall: 'cli', mask: dom.mask });
  var g = 1e-5 * (64 / N) * (64 / N), t0 = performance.now();
  var cpu = solveFlowCPU(cpuDom, { force: [g, 0, 0], tauPlus: FLOW_TAU_PLUS, tol: 0, maxSteps: steps, checkEvery: steps });
  var cpuMs = performance.now() - t0, S = flowGPUSolver(N);
  S.upload(T);
  var gpu = await S.solve([g, 0, 0], { tol: 0, maxSteps: steps, minSteps: steps, checkEvery: steps });
  var st = await S.readState(), N3 = N * N * N, maxAbs = 0, maxF = 0;
  for (var a = 0; a < cpuDom.n; a++) { var x = cpuDom.nodes[a]; for (var i = 0; i < 19; i++) {
    var c = cpu.state[a * 19 + i]; maxAbs = Math.max(maxAbs, Math.abs(c - st[i * N3 + x])); maxF = Math.max(maxF, Math.abs(c)); } }
  var relU = Math.abs(gpu.U[0] - cpu.U[0]) / Math.max(Math.abs(cpu.U[0]), 1e-30), relF = maxF > 0 ? maxAbs / maxF : 0;
  var res = { design: d.label || d.id, family: rcp.family, N: N, steps: steps, relU: relU, relPop: relF,
              wallLinksCPU: cpuDom.nWallLinks, wallLinksGPU: T.nWall, sealedCells: dom.nFluid - dom.nOpen, cpuMs: Math.round(cpuMs),
              pass: relU < 1e-4 && relF < 1e-4 && cpuDom.nWallLinks === T.nWall };
  console.log('[flow check] ' + JSON.stringify(res));
  return res;
}
