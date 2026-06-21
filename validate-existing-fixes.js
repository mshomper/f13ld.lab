/* ============================================================
   F13LD.lab · _validation/validate-existing-fixes.js
   Verifies the alignment fixes to the existing families:

   1. Grain HU shape params are a strict SUPERSET — at defaults
      (cross=2, sharp=1, blend=1, ell=1) the new evaluator must
      reproduce the OLD circular Gaussian field exactly, and
      non-default params must measurably change the field.
   2. TPMS normalization flags default to OFF when absent (per
      the alignment decision) and respect explicit true/false.
   ============================================================ */

const k = require('../13-kernels.js');
let all = true;

/* ── 1a. HU reduction identity ──────────────────────────────── */
const r = { family:'grain',
  field:{ type:'hyperuniform', rng_seed:7, dir_mode:'single', kappa:4,
          principal_direction:[0,0,1], hu_n:50, hu_aspect:3, hu_width:0.08 },
  geometry:{ center:-0.12 } };

const params = k.GrainKernel.parseRecipe(JSON.parse(JSON.stringify(r)));
const ks = params.kernels;

/* old circular formula, evaluated on the SAME kernels (b1==b2 at ell=1) */
function oldEval(x, y, z) {
  let s = 0;
  for (let i = 0; i < ks.length; i++) {
    const kk = ks[i];
    const dx = x-kk.px, dy = y-kk.py, dz = z-kk.pz;
    const dt  = dx*kk.tx  + dy*kk.ty  + dz*kk.tz;
    const dn1 = dx*kk.n1x + dy*kk.n1y + dz*kk.n1z;
    const dn2 = dx*kk.n2x + dy*kk.n2y + dz*kk.n2z;
    const b = kk.b1;                       /* circular radius (b1==b2 at ell=1) */
    s += Math.exp(-(dt*dt)/(kk.a*kk.a) - (dn1*dn1 + dn2*dn2)/(b*b));
  }
  return s - 0.3;
}

let maxDiff = 0;
const M = 24, PI = Math.PI, step = 2*PI/M;
for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) for (let l = 0; l < M; l++) {
  const x = -PI+(i+0.5)*step, y = -PI+(j+0.5)*step, z = -PI+(l+0.5)*step;
  const d = Math.abs(k.GrainKernel.evaluate(params, x, y, z) - oldEval(x, y, z));
  if (d > maxDiff) maxDiff = d;
}
const redOK = maxDiff < 1e-12;
all &= redOK;
console.log(`${redOK ? 'PASS' : 'FAIL'}  grain HU reduction      max|new - old(circular)| = ${maxDiff.toExponential(2)}  (must be ~0)`);

/* ── 1b. HU sensitivity — non-default params must change field ── */
function huField(extra) {
  const rr = JSON.parse(JSON.stringify(r));
  Object.assign(rr.field, extra);
  const pp = k.GrainKernel.parseRecipe(rr);
  let acc = 0;
  for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) for (let l = 0; l < M; l++) {
    acc += k.GrainKernel.evaluate(pp, -PI+(i+0.5)*step, -PI+(j+0.5)*step, -PI+(l+0.5)*step);
  }
  return acc;
}
const base = huField({});
const ell2 = huField({ hu_ell: 2.0 });
const cr4  = huField({ hu_cross: 4 });
const ellSens = Math.abs(ell2 - base) > 1e-6;
const crSens  = Math.abs(cr4  - base) > 1e-6;
all &= ellSens && crSens;
console.log(`${(ellSens && crSens) ? 'PASS' : 'FAIL'}  grain HU sensitivity     ell Δ=${(ell2-base).toFixed(2)}  cross Δ=${(cr4-base).toFixed(2)}  (both must be nonzero)`);

/* ── 2. TPMS normalization flag defaults ────────────────────── */
function tpmsFlags(geom) {
  const rr = { family:'tpms', surface:{ type:'terms',
    terms:[{ on:true, coef:1, factors:[{trig:'cos(x)',fx:1,fy:1,fz:1}] }] }, geometry: geom };
  return k.TpmsKernel.parseRecipe(rr);
}
const absent   = tpmsFlags({ mode:'shell' });                                 /* no flags */
const piAbsent = tpmsFlags({ mode:'pi-tpms' });                               /* no flags */
const onBoth   = tpmsFlags({ mode:'shell', shell_normalize:true, pi_normalize:true });
const offBoth  = tpmsFlags({ mode:'shell', shell_normalize:false, pi_normalize:false });

const defaultsOff = (absent.shellNorm === false && absent.piNorm === false &&
                     piAbsent.shellNorm === false && piAbsent.piNorm === false);
const explicitOk  = (onBoth.shellNorm === true && onBoth.piNorm === true &&
                     offBoth.shellNorm === false && offBoth.piNorm === false);
all &= defaultsOff && explicitOk;
console.log(`${defaultsOff ? 'PASS' : 'FAIL'}  TPMS norm default-OFF    absent → shellNorm=${absent.shellNorm}, piNorm=${absent.piNorm}`);
console.log(`${explicitOk ? 'PASS' : 'FAIL'}  TPMS norm explicit       on→(${onBoth.shellNorm},${onBoth.piNorm}) off→(${offBoth.shellNorm},${offBoth.piNorm})`);

console.log('──────────────────────────────────────────────────────────────────────');
console.log(all ? 'ALL EXISTING-FIX CHECKS PASSED' : 'SOME CHECKS FAILED — see above');
process.exit(all ? 0 : 1);
