/* ============================================================
   F13LD.lab · _validation/validate-willot.js
   Validates the Willot rotated-scheme Green operator against the
   prior continuous (Moulinec–Suquet) operator.

   Gate (Matt's baselines 1–6):
     1. Backus laminate (analytic, 10:1) — correctness anchor.
     2. Solid block ρ=1 — exactness floor (C_eff == C_solid).
     3. Schwarz P ρ≈0.5 — self-consistency vs a fine continuous grid.
     4. Iteration counts — Willot vs continuous (the speed metric).
     5. Sheet gyroid ≈30% VF — anisotropy + high-contrast behavior.
     6. The attached f13ld_wave recipe — cross-checked vs MIL-HS card.

   Willot is a different discretization, so the test is accuracy +
   iteration count, NOT equality with the old numbers.
   ============================================================ */

const fs = require('fs');
const L = require('./_willot.js');

const Es = 110000, nu = 0.34;   /* Ti-6Al-4V default */
const C = (x) => (x / 1000).toFixed(2);   /* MPa → GPa string */

/* ---- analytic Backus average for an isotropic two-phase laminate (⊥ z) ---- */
function lame(E, n) { return { lam: E*n/((1+n)*(1-2*n)), mu: E/(2*(1+n)) }; }
function backus(E1, n1, f1, E2, n2, f2) {
  const A = lame(E1, n1), B = lame(E2, n2);
  const av = (x1, x2) => f1*x1 + f2*x2;
  const L1=A.lam,M1=A.mu,L2=B.lam,M2=B.mu;
  const C33 = 1 / av(1/(L1+2*M1), 1/(L2+2*M2));
  const lo  = av(L1/(L1+2*M1), L2/(L2+2*M2));
  const C13 = lo*C33;
  const C11 = av(4*M1*(L1+M1)/(L1+2*M1), 4*M2*(L2+M2)/(L2+2*M2)) + lo*lo*C33;
  return { C11, C13, C33 };
}

/* ---- raw-solid homogenize so we can feed laminate / block arrays ---- */
function homogSolid(solid, N, scheme, contrast) {
  contrast = contrast || 1e-4;
  const C_s = L.isoC(Es, nu), C_v = L.isoC(Es*contrast, nu), C_0 = L.isoC(Es, nu);
  const Gamma = L.buildGammaFull(N, C_0[21], C_0[1], scheme);
  const C_eff = new Float64Array(36); let iters = 0, conv = true;
  for (let lc = 0; lc < 6; lc++) {
    const eb = [0,0,0,0,0,0]; eb[lc] = 1;
    const r = L.cgSolveFullCPU(solid, C_s, C_v, C_0, Gamma, N, eb, 1e-5, 400);
    iters += r.iters; if (!r.converged) conv = false;
    for (let P = 0; P < 6; P++) C_eff[P*6+lc] = r.sigma[P];
  }
  return { C_eff, iters, conv };
}

/* ════ 1 · Backus laminate (10:1 contrast → clean correctness anchor) ════ */
console.log('── 1 · Backus laminate (10:1, f=0.5, ⊥z) — correctness anchor ──');
{
  const N = 24, f = 0.5;
  const sol = new Float32Array(N*N*N);
  for (let i=0;i<N;i++) for (let j=0;j<N;j++) for (let k=0;k<N;k++)
    sol[(i*N+j)*N+k] = (k < N*f) ? 1 : 0;
  const an = backus(Es, nu, f, Es*0.1, nu, 1-f);
  for (const sch of ['continuous','willot']) {
    const r = homogSolid(sol, N, sch, 0.1);
    const C11 = r.C_eff[0], C33 = r.C_eff[2*6+2];
    const e11 = 100*Math.abs(C11-an.C11)/an.C11, e33 = 100*Math.abs(C33-an.C33)/an.C33;
    console.log(`   ${sch.padEnd(10)} C11 ${C(C11)} (exact ${C(an.C11)}, ${e11.toFixed(1)}%)  C33 ${C(C33)} (exact ${C(an.C33)}, ${e33.toFixed(1)}%)`);
  }
}

/* ════ 2 · Solid block ρ=1 (C_eff must equal C_solid) ════ */
console.log('── 2 · Solid block ρ=1 — exactness floor ──');
{
  const N = 12; const sol = new Float32Array(N*N*N).fill(1);
  const Cs = L.isoC(Es, nu);
  for (const sch of ['continuous','willot']) {
    const r = homogSolid(sol, N, sch, 1.0);
    console.log(`   ${sch.padEnd(10)} C11 ${C(r.C_eff[0])} (solid ${C(Cs[0])})  C12 ${C(r.C_eff[1])} (solid ${C(Cs[1])})`);
  }
}

/* ---- recipe runner ---- */
function runRecipe(label, recipe, Ngrid, scheme) {
  const t0 = Date.now();
  const res = L.homogenizeFullCPU(JSON.parse(JSON.stringify(recipe)), Ngrid, { scheme, tol: 1e-4, maxiter: 300 });
  const dt = ((Date.now()-t0)/1000).toFixed(0);
  if (!res.valid) { console.log(`   ${label} N=${Ngrid} ${scheme}: INVALID (${res.reject_reason})`); return null; }
  console.log(`   ${(scheme+'@'+Ngrid).padEnd(14)} ρ=${res.rho.toFixed(3)}  Ex ${C(res.Ex)}  Ez ${C(res.Ez)}  A=${res.zenerA.toFixed(2)}  iters ${res.totalIters}  conv ${res.allConverged}  [${dt}s]`);
  return res;
}

/* ════ 3 + 4 · Schwarz P — self-consistency + iteration count ════ */
console.log('── 3+4 · Schwarz P ρ≈0.5 — Willot vs continuous, + fine-grid self-consistency ──');
runRecipe('schwarzP', L.DEMO_SCHWARZ_P, 20, 'continuous');
runRecipe('schwarzP', L.DEMO_SCHWARZ_P, 20, 'willot');
runRecipe('schwarzP', L.DEMO_SCHWARZ_P, 32, 'continuous');   /* fine reference */

/* ════ 5 · Sheet gyroid ≈30% VF ════ */
console.log('── 5 · Sheet gyroid ≈30% VF ──');
function gyroid(wt) {
  return { family:'tpms',
    surface:{ type:'terms', terms:[
      {on:true,coef:1,factors:[{trig:'sin(x)',fx:1,fy:1,fz:1},{trig:'cos(y)',fx:1,fy:1,fz:1}]},
      {on:true,coef:1,factors:[{trig:'sin(y)',fx:1,fy:1,fz:1},{trig:'cos(z)',fx:1,fy:1,fz:1}]},
      {on:true,coef:1,factors:[{trig:'sin(z)',fx:1,fy:1,fz:1},{trig:'cos(x)',fx:1,fy:1,fz:1}]}
    ]},
    geometry:{ mode:'shell', wall_thickness: wt },
    material:{ Es_MPa: Es, nu: nu } };
}
/* tune wt → ~30% VF at a cheap grid */
let bestWt = 0.3;
{
  let best = 1e9;
  for (const wt of [0.15,0.2,0.25,0.3,0.35,0.4,0.5]) {
    const r = L.homogenizeFullCPU(gyroid(wt), 16, { scheme:'willot', tol:1e-3, maxiter:120 });
    if (r.valid && Math.abs(r.rho-0.30) < best) { best = Math.abs(r.rho-0.30); bestWt = wt; }
  }
  console.log(`   tuned wall_thickness=${bestWt} → ~30% VF`);
}
runRecipe('gyroid', gyroid(bestWt), 20, 'continuous');
runRecipe('gyroid', gyroid(bestWt), 20, 'willot');

/* ════ 6 · Attached wave recipe — vs MIL-HS card (45.18 GPa @ Es=100, E/Es≈0.452) ════ */
console.log('── 6 · f13ld_wave recipe — vs MIL-HS card (E/Es≈0.452) & Lab card (E/Es≈0.135) ──');
{
  const wave = JSON.parse(fs.readFileSync('/mnt/user-data/uploads/f13ld_wave_2026-06-21T18-03-15.json','utf8'));
  wave.geometry = { mode: 'solid' };
  wave.material = { Es_MPa: 100000, nu: 0.3 };   /* match the MIL-HS card */
  for (const cfg of [['continuous',20],['willot',20],['willot',32]]) {
    const res = L.homogenizeFullCPU(JSON.parse(JSON.stringify(wave)), cfg[1], { scheme: cfg[0], tol: 1e-4, maxiter: 300 });
    if (!res.valid) { console.log(`   ${cfg[0]}@${cfg[1]}: INVALID`); continue; }
    console.log(`   ${(cfg[0]+'@'+cfg[1]).padEnd(14)} ρ=${res.rho.toFixed(3)}  Ex ${C(res.Ex)}  E/Es ${(res.Ex/100000).toFixed(3)}  A=${res.zenerA.toFixed(2)}  iters ${res.totalIters}`);
  }
  console.log('   reference: MIL-HS 45.18 GPa (E/Es 0.452) · Lab card 14.81 GPa@Es110 (E/Es 0.135)');
}

console.log('── done ──');
