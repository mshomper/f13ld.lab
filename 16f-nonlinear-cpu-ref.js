/* ============================================================
   F13LD.lab · 16f-nonlinear-cpu-ref.js

   CPU reference oracle for small-strain J2 (von Mises) plasticity.
   Phase 6, Push 1 (math + self-tests). This is the correctness
   anchor the GPU production solver (16g) validates against, exactly
   as 16a anchored 16b and 16c anchored the dense buckling check.

   ── What this computes ──────────────────────────────────
   A single-axis uniaxial crush of a periodic unit cell, past
   yield, returning:
     - the effective stress-strain curve (sigma_bar vs eps_bar
       along the driven axis),
     - the per-design effective yield via 0.2% offset (sigma_y_eff)
       — this is the number that retires the provisional 880 MPa
       Ti-64 seam in 50-controls (P_cr/P_y),
     - the per-voxel accumulated equivalent plastic strain field
       (alpha) for the "where it crushes" visualization.

   ── Reuses (loaded earlier in index.html) ───────────────
     16a : buildGammaFull, applyGammaRowFull,
           getSolverWorkspaceFullCPU, invert6x6, cgSolveFullCPU
     14  : isoC, buildVoxels, resolveBuildArgs
     13  : KERNELS
     18  : fft3dCpu   (via 16a's applyGammaRowFull)
     15  : DEMO_RECIPES  (self-test only)

   The Lippmann-Schwinger operator, Green tensor, and inner CG are
   not re-implemented — the nonlinear layer freezes a per-voxel
   consistent tangent each Newton iteration and feeds it through
   the existing operator.

   ── Voigt convention (matches 16a / isoC) ───────────────
     P in {0=xx,1=yy,2=zz,3=yz,4=xz,5=xy}; engineering shear
     strain (eV[3]=2*e23); natural shear stress (sV[3]=s23).
     Tensor<->Voigt: with engineering shear + natural stress,
     Cvoigt[P][Q] = C_tensor[a,b,c,d], (a,b)=VOIGT_IJ[P],
     (c,d)=VOIGT_IJ[Q] — the factor-2 cancels the symmetric
     double-count, so no extra shear factors appear.

   ── Validation status (Node, this push) ─────────────────
     elastic-limit  : C_alg == isoC exactly; sigma == C:e to 6e-14
     FD tangent     : worst rel err 8e-10 vs analytic consistent
                      tangent (incl. normal-shear coupling)
     uniaxial-stress: elastic slope == E; post-yield == E*H/(E+H)
     Field-level (Newton + load-step) self-test runs in the browser
     console via runNonlinearCPUTest() — needs the FFT/rasterizer
     stack, same pattern as runFullVoigtCPUTest in 16a.
   ============================================================ */


/* Voigt index -> tensor (i,j), 0-indexed. Mirrors 16a. */
var NL_VOIGT_IJ = [[0,0],[1,1],[2,2],[1,2],[0,2],[0,1]];

/* Default material — Ti-6Al-4V. sigY0 matches SIGMA_Y_TI64_MPA (880).
   H_MPa is the linear isotropic hardening modulus. The placeholder
   below gives a post-yield tangent Et = E*H/(E+H) ~ 1.96 GPa, a
   reasonable Ti-64 figure; CONFIRM the production value. Voce
   parameters are optional and override linear hardening when present. */
var NL_MAT_DEFAULT = {
  Es_MPa: 110000,   /* LPBF Ti-64 lit. modulus ~104-114 GPa; per-recipe material overrides this */
  nu:     0.34,
  sigY0_MPa: 950,   /* initial flow stress (proportional limit) */
  H_MPa:     2000,  /* linear-hardening fallback, used only if voce is set null */
  /* Voce isotropic hardening — ACTIVE by default:
       sigY(a) = sigY0 + (sigSat - sigY0)(1 - exp(-delta*a)) + Hlin*a
     Calibrated to room-temperature, stress-relieved LPBF Ti-6Al-4V:
       - quasi-static 0.2% offset yield ~920 MPa (wrought baseline)
       - optimized LPBF yield/UTS ~1160 / 1260 MPa
       - 0.2%-offset of THIS curve lands ~975 MPa; true stress saturates ~1150 MPa
     PLACEHOLDER pending Matt's preferred per-design Ti-64 curve — swap freely. */
  voce: { sigSat_MPa: 1150, delta: 60, Hlin_MPa: 300 }
};


/* ════════════════════════════════════════════════════════════
   CONSTITUTIVE CORE  (validated in Node — see header)
   ════════════════════════════════════════════════════════════ */

/* Derive Lame / bulk constants from a material spec. */
function nlMakeMaterial(mat) {
  mat = mat || NL_MAT_DEFAULT;
  var E  = mat.Es_MPa != null ? mat.Es_MPa : 110000;
  var nu = mat.nu     != null ? mat.nu     : 0.34;
  var mu  = E / (2 * (1 + nu));
  var lam = E * nu / ((1 + nu) * (1 - 2 * nu));
  var K   = lam + 2 * mu / 3;
  return {
    E: E, nu: nu, mu: mu, lam: lam, K: K,
    sigY0: mat.sigY0_MPa != null ? mat.sigY0_MPa : 880,
    H:     mat.H_MPa     != null ? mat.H_MPa     : 2000,
    voce:  mat.voce || null
  };
}

/* Flow stress sigY(alpha) and its slope H'(alpha). Linear by default;
   Voce (saturating) when m.voce is present. Returns [sigY, Hprime]. */
function nlFlowStress(m, alpha) {
  if (m.voce) {
    var ss = m.voce.sigSat_MPa, dl = m.voce.delta, hl = m.voce.Hlin_MPa || 0;
    var ex = Math.exp(-dl * alpha);
    var sigY = m.sigY0 + (ss - m.sigY0) * (1 - ex) + hl * alpha;
    var Hp   = (ss - m.sigY0) * dl * ex + hl;
    return [sigY, Hp];
  }
  return [m.sigY0 + m.H * alpha, m.H];
}

/* Build the Voigt-36 consistent tangent from (K, mu, theta, thetabar, nhat).
   nhatTen is the unit deviatoric flow direction in tensor-strain order
   [00,11,22,yz,xz,xy]. Writes into C36 (Float64Array length 36). */
function nlBuildTangent(C36, K, mu, theta, thetabar, nhatTen) {
  var n = [[nhatTen[0], nhatTen[5], nhatTen[4]],
           [nhatTen[5], nhatTen[1], nhatTen[3]],
           [nhatTen[4], nhatTen[3], nhatTen[2]]];
  for (var P = 0; P < 6; P++) {
    var a = NL_VOIGT_IJ[P][0], b = NL_VOIGT_IJ[P][1];
    for (var Q = 0; Q < 6; Q++) {
      var c = NL_VOIGT_IJ[Q][0], d = NL_VOIGT_IJ[Q][1];
      var da_c = (a === c) ? 1 : 0, db_d = (b === d) ? 1 : 0;
      var da_d = (a === d) ? 1 : 0, db_c = (b === c) ? 1 : 0;
      var da_b = (a === b) ? 1 : 0, dc_d = (c === d) ? 1 : 0;
      var Idev = 0.5 * (da_c * db_d + da_d * db_c) - (1 / 3) * da_b * dc_d;
      C36[P * 6 + Q] = K * da_b * dc_d
                     + 2 * mu * theta * Idev
                     - 2 * mu * thetabar * n[a][b] * n[c][d];
    }
  }
}

/* Radial-return mapping for one voxel.
   eV     : total Voigt strain (engineering shear)
   epTen  : previous converged plastic strain, tensor order [00,11,22,yz,xz,xy]
   alpha  : previous converged accumulated equivalent plastic strain
   m      : nlMakeMaterial output
   outC36 : optional Float64Array(36) to receive consistent tangent
   Returns { sV:[6], epTen:[6], alpha, plastic, dgamma }. */
function nlReturnMap(eV, epTen, alpha, m, outC36) {
  var mu = m.mu, lam = m.lam, K = m.K;
  /* total tensor strain (shear halved) */
  var et = [eV[0], eV[1], eV[2], eV[3] * 0.5, eV[4] * 0.5, eV[5] * 0.5];
  /* elastic trial tensor strain = total - plastic */
  var ee0 = et[0] - epTen[0], ee1 = et[1] - epTen[1], ee2 = et[2] - epTen[2];
  var ee3 = et[3] - epTen[3], ee4 = et[4] - epTen[4], ee5 = et[5] - epTen[5];
  var trE = ee0 + ee1 + ee2;
  /* trial stress tensor [00,11,22,yz,xz,xy] */
  var s00 = lam * trE + 2 * mu * ee0, s11 = lam * trE + 2 * mu * ee1, s22 = lam * trE + 2 * mu * ee2;
  var s23 = 2 * mu * ee3, s13 = 2 * mu * ee4, s12 = 2 * mu * ee5;
  var pmean = (s00 + s11 + s22) / 3;
  /* deviatoric trial */
  var d00 = s00 - pmean, d11 = s11 - pmean, d22 = s22 - pmean;
  var snorm = Math.sqrt(d00 * d00 + d11 * d11 + d22 * d22 + 2 * (s23 * s23 + s13 * s13 + s12 * s12));
  var fs = nlFlowStress(m, alpha);
  var sigY = fs[0];
  var fTrial = snorm - Math.sqrt(2 / 3) * sigY;

  if (fTrial <= 0 || snorm < 1e-300) {
    if (outC36) nlBuildTangent(outC36, K, mu, 1.0, 0.0, [0, 0, 0, 0, 0, 0]);
    return { sV: [s00, s11, s22, s23, s13, s12], epTen: epTen.slice(), alpha: alpha, plastic: false, dgamma: 0 };
  }

  /* Plastic. Linear hardening: closed-form dgamma. Voce: local scalar Newton. */
  var dgamma, Hp;
  if (!m.voce) {
    dgamma = fTrial / (2 * mu + (2 / 3) * m.H);
    Hp = m.H;
  } else {
    dgamma = fTrial / (2 * mu + (2 / 3) * nlFlowStress(m, alpha)[1]); /* predictor */
    for (var it = 0; it < 20; it++) {
      var aTrial = alpha + Math.sqrt(2 / 3) * dgamma;
      var f2 = nlFlowStress(m, aTrial);
      var r = snorm - 2 * mu * dgamma - Math.sqrt(2 / 3) * f2[0];
      var dr = -2 * mu - (2 / 3) * f2[1];
      var step = r / dr;
      dgamma -= step;
      if (Math.abs(step) < 1e-12) break;
    }
    Hp = nlFlowStress(m, alpha + Math.sqrt(2 / 3) * dgamma)[1];
  }

  var inv = 1 / snorm;
  var n00 = d00 * inv, n11 = d11 * inv, n22 = d22 * inv;
  var n23 = s23 * inv, n13 = s13 * inv, n12 = s12 * inv;
  var nhat = [n00, n11, n22, n23, n13, n12];

  var sV = [ s00 - 2 * mu * dgamma * n00, s11 - 2 * mu * dgamma * n11, s22 - 2 * mu * dgamma * n22,
             s23 - 2 * mu * dgamma * n23, s13 - 2 * mu * dgamma * n13, s12 - 2 * mu * dgamma * n12 ];
  var epN = [ epTen[0] + dgamma * n00, epTen[1] + dgamma * n11, epTen[2] + dgamma * n22,
              epTen[3] + dgamma * n23, epTen[4] + dgamma * n13, epTen[5] + dgamma * n12 ];
  var alphaN = alpha + Math.sqrt(2 / 3) * dgamma;

  if (outC36) {
    var theta    = 1 - 2 * mu * dgamma * inv;
    var thetabar = 1 / (1 + Hp / (3 * mu)) - (1 - theta);
    nlBuildTangent(outC36, K, mu, theta, thetabar, nhat);
  }
  return { sV: sV, epTen: epN, alpha: alphaN, plastic: true, dgamma: dgamma };
}


/* ════════════════════════════════════════════════════════════
   FIELD LAYER — Newton equilibrium + load stepping
   Reuses 16a's buildGammaFull / applyGammaRowFull / workspace.
   ════════════════════════════════════════════════════════════ */

/* Per-design nonlinear workspace: history (plastic strain + alpha) that
   persists across load steps, the frozen per-voxel tangent + stress fields
   rebuilt each Newton iteration, and CG buffers. Cached by N. */
var _nlWorkspace = null, _nlWorkspaceN = 0;
function getNonlinWorkspaceCPU(N) {
  if (_nlWorkspaceN === N && _nlWorkspace) return _nlWorkspace;
  var N3 = N * N * N;
  var make6 = function () {
    return [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3),
            new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  };
  _nlWorkspace = {
    N: N, N3: N3,
    epTen: make6(),                 /* converged plastic strain (tensor order) */
    alpha: new Float64Array(N3),    /* converged accumulated equiv plastic strain */
    epTrial: make6(),               /* tentative plastic strain this Newton iter */
    alphaTrial: new Float64Array(N3),
    Calg: new Float64Array(36 * N3),/* frozen per-voxel consistent tangent */
    sigma: make6(),                 /* per-voxel stress at current eps */
    eps: make6(), r: make6(), p: make6(), Ap: make6(), dEps: make6(), tmp: make6()
  };
  _nlWorkspaceN = N;
  return _nlWorkspace;
}

/* Sweep the return map over all voxels at the current total strain field.
   Solid voxels use J2; void voxels stay linear-elastic-soft (C_v).
   Fills ws.sigma (stress), ws.Calg (tangent), ws.epTrial / ws.alphaTrial
   (tentative history from the converged ws.epTen / ws.alpha).
   Returns nothing; reads ws.eps. */
function nlSweepReturnMap(ws, solid, m, C_v, N3) {
  var eps = ws.eps, sig = ws.sigma, Calg = ws.Calg;
  var ep = ws.epTen, al = ws.alpha, epT = ws.epTrial, alT = ws.alphaTrial;
  var eV = [0, 0, 0, 0, 0, 0], epPrev = [0, 0, 0, 0, 0, 0];
  var c36 = new Float64Array(36);
  for (var idx = 0; idx < N3; idx++) {
    if (solid[idx]) {
      eV[0] = eps[0][idx]; eV[1] = eps[1][idx]; eV[2] = eps[2][idx];
      eV[3] = eps[3][idx]; eV[4] = eps[4][idx]; eV[5] = eps[5][idx];
      epPrev[0] = ep[0][idx]; epPrev[1] = ep[1][idx]; epPrev[2] = ep[2][idx];
      epPrev[3] = ep[3][idx]; epPrev[4] = ep[4][idx]; epPrev[5] = ep[5][idx];
      var R = nlReturnMap(eV, epPrev, al[idx], m, c36);
      for (var q = 0; q < 6; q++) { sig[q][idx] = R.sV[q]; epT[q][idx] = R.epTen[q]; }
      alT[idx] = R.alpha;
      var base = idx * 36;
      for (var c = 0; c < 36; c++) Calg[base + c] = c36[c];
    } else {
      /* void: linear elastic soft, no history */
      var b2 = idx * 36;
      for (var c2 = 0; c2 < 36; c2++) Calg[b2 + c2] = C_v[c2];
      var e0 = eps[0][idx], e1 = eps[1][idx], e2 = eps[2][idx];
      var e3 = eps[3][idx], e4 = eps[4][idx], e5 = eps[5][idx];
      sig[0][idx] = C_v[0]*e0+C_v[1]*e1+C_v[2]*e2+C_v[3]*e3+C_v[4]*e4+C_v[5]*e5;
      sig[1][idx] = C_v[6]*e0+C_v[7]*e1+C_v[8]*e2+C_v[9]*e3+C_v[10]*e4+C_v[11]*e5;
      sig[2][idx] = C_v[12]*e0+C_v[13]*e1+C_v[14]*e2+C_v[15]*e3+C_v[16]*e4+C_v[17]*e5;
      sig[3][idx] = C_v[18]*e0+C_v[19]*e1+C_v[20]*e2+C_v[21]*e3+C_v[22]*e4+C_v[23]*e5;
      sig[4][idx] = C_v[24]*e0+C_v[25]*e1+C_v[26]*e2+C_v[27]*e3+C_v[28]*e4+C_v[29]*e5;
      sig[5][idx] = C_v[30]*e0+C_v[31]*e1+C_v[32]*e2+C_v[33]*e3+C_v[34]*e4+C_v[35]*e5;
    }
  }
}

/* Newton solve for cell equilibrium at a prescribed macro strain eps_bar.
   Residual R(eps) = eps + Gamma:(sigma(eps) - C0:eps) - eps_bar.
   Inner linear solve [I + Gamma:(Calg - C0)] dEps = -R via CG, reusing
   applyGammaRowFull. On convergence, commits the tentative plastic history.
   Returns { sigma_bar:[6], converged, newtonIters, totalCgIters }. */
function nlNewtonSolveCPU(ws, solid, m, C_v, C0, Gamma, N, eps_bar, opts) {
  var N3 = ws.N3;
  var newtonTol  = opts.newtonTol  != null ? opts.newtonTol  : 1e-5;
  var newtonMax  = opts.newtonMax  != null ? opts.newtonMax  : 20;
  var cgTol      = opts.cgTol      != null ? opts.cgTol      : 1e-4;
  var cgMax      = opts.cgMax      != null ? opts.cgMax      : 400;
  var sw = getSolverWorkspaceFullCPU(N);   /* reuse 16a FFT/spectral scratch */

  var eps = ws.eps, sig = ws.sigma, Calg = ws.Calg;
  var Rr = ws.r, dEps = ws.dEps;

  /* warm start: keep eps from the previous load step (already in ws.eps);
     seed the macro part toward eps_bar by adding the macro increment uniformly. */
  /* (caller has set ws.eps to the previous converged field) */

  var P, i, idx, q;
  function residual() {
    nlSweepReturnMap(ws, solid, m, C_v, N3);
    /* tau = sigma - C0:eps ; deps = Gamma:tau ; R = eps + deps - eps_bar */
    var tau = ws.tmp;
    for (idx = 0; idx < N3; idx++) {
      var e0 = eps[0][idx], e1 = eps[1][idx], e2 = eps[2][idx];
      var e3 = eps[3][idx], e4 = eps[4][idx], e5 = eps[5][idx];
      tau[0][idx] = sig[0][idx] - (C0[0]*e0+C0[1]*e1+C0[2]*e2+C0[3]*e3+C0[4]*e4+C0[5]*e5);
      tau[1][idx] = sig[1][idx] - (C0[6]*e0+C0[7]*e1+C0[8]*e2+C0[9]*e3+C0[10]*e4+C0[11]*e5);
      tau[2][idx] = sig[2][idx] - (C0[12]*e0+C0[13]*e1+C0[14]*e2+C0[15]*e3+C0[16]*e4+C0[17]*e5);
      tau[3][idx] = sig[3][idx] - (C0[18]*e0+C0[19]*e1+C0[20]*e2+C0[21]*e3+C0[22]*e4+C0[23]*e5);
      tau[4][idx] = sig[4][idx] - (C0[24]*e0+C0[25]*e1+C0[26]*e2+C0[27]*e3+C0[28]*e4+C0[29]*e5);
      tau[5][idx] = sig[5][idx] - (C0[30]*e0+C0[31]*e1+C0[32]*e2+C0[33]*e3+C0[34]*e4+C0[35]*e5);
    }
    for (P = 0; P < 6; P++) applyGammaRowFull(tau, Gamma[P], N, dEps[P], sw);
    for (P = 0; P < 6; P++) {
      var Rp = Rr[P], epP = eps[P], dpP = dEps[P];
      for (i = 0; i < N3; i++) Rp[i] = epP[i] + dpP[i] - eps_bar[P];
    }
  }

  /* matrix-free A v = v + Gamma:((Calg - C0):v) using frozen Calg */
  function applyA(vIn, out) {
    var tau = ws.tmp;
    for (idx = 0; idx < N3; idx++) {
      var b36 = idx * 36;
      var v0 = vIn[0][idx], v1 = vIn[1][idx], v2 = vIn[2][idx];
      var v3 = vIn[3][idx], v4 = vIn[4][idx], v5 = vIn[5][idx];
      for (var P2 = 0; P2 < 6; P2++) {
        var rB = b36 + P2 * 6;
        var cv = (Calg[rB]-C0[P2*6])*v0 + (Calg[rB+1]-C0[P2*6+1])*v1 + (Calg[rB+2]-C0[P2*6+2])*v2
               + (Calg[rB+3]-C0[P2*6+3])*v3 + (Calg[rB+4]-C0[P2*6+4])*v4 + (Calg[rB+5]-C0[P2*6+5])*v5;
        tau[P2][idx] = cv;
      }
    }
    for (P = 0; P < 6; P++) applyGammaRowFull(tau, Gamma[P], N, out[P], sw);
    for (P = 0; P < 6; P++) { var oP = out[P], vP = vIn[P]; for (i = 0; i < N3; i++) oP[i] += vP[i]; }
  }

  function dot6(a, bb) { var s = 0; for (var P3 = 0; P3 < 6; P3++){ var aP=a[P3], bP=bb[P3]; for (var ii=0; ii<N3; ii++) s += aP[ii]*bP[ii]; } return s; }
  function norm6(a) { return Math.sqrt(dot6(a, a)); }

  var pcg = ws.p, Apc = ws.Ap;
  var newtonIters = 0, totalCg = 0, converged = false;
  var ebNorm = 0; for (P = 0; P < 6; P++) ebNorm += eps_bar[P]*eps_bar[P]; ebNorm = Math.sqrt(ebNorm) + 1e-30;

  for (var nit = 0; nit < newtonMax; nit++) {
    newtonIters = nit + 1;
    residual();
    var rNorm = norm6(Rr) / (N3 * ebNorm) * Math.sqrt(N3); /* relative-ish */
    if (rNorm < newtonTol) { converged = true; break; }

    /* CG solve A dEps = -R */
    /* Standard CG on A dEps = -R, with x0 = 0 so r0 = p0 = b = -R.
       cgR holds the linear residual; pcg (ws.p) holds the search direction.
       ws.tmp is left intact — applyA uses it as scratch each iteration. */
    for (P = 0; P < 6; P++) dEps[P].fill(0);
    var cgR = [ new Float64Array(N3), new Float64Array(N3), new Float64Array(N3),
               new Float64Array(N3), new Float64Array(N3), new Float64Array(N3) ];
    var bnorm2 = 0;
    for (P=0;P<6;P++) { var rr0 = ws.r[P]; var cR = cgR[P]; for (i=0;i<N3;i++) { cR[i] = -rr0[i]; bnorm2 += cR[i]*cR[i]; } }
    var bnorm = Math.sqrt(bnorm2) + 1e-30;
    for (P=0;P<6;P++) pcg[P].set(cgR[P]);
    var rsold = bnorm2;
    var cgIters = 0;
    for (var kit = 0; kit < cgMax; kit++) {
      cgIters = kit + 1;
      applyA(pcg, Apc);
      var pAp = 0; for (P=0;P<6;P++){ var pP=pcg[P], aP=Apc[P]; for(i=0;i<N3;i++) pAp += pP[i]*aP[i]; }
      if (Math.abs(pAp) < 1e-30) break;
      var alphaCg = rsold / pAp;
      for (P=0;P<6;P++){ var dP=dEps[P], pP2=pcg[P]; for(i=0;i<N3;i++) dP[i] += alphaCg*pP2[i]; }
      for (P=0;P<6;P++){ var cR3=cgR[P], aP2=Apc[P]; for(i=0;i<N3;i++) cR3[i] -= alphaCg*aP2[i]; }
      var rsnew = 0; for (P=0;P<6;P++){ var cR4=cgR[P]; for(i=0;i<N3;i++) rsnew += cR4[i]*cR4[i]; }
      if (Math.sqrt(rsnew)/bnorm < cgTol) break;
      var betaCg = rsnew/rsold;
      for (P=0;P<6;P++){ var cR5=cgR[P], pP3=pcg[P]; for(i=0;i<N3;i++) pP3[i] = cR5[i] + betaCg*pP3[i]; }
      rsold = rsnew;
    }
    totalCg += cgIters;
    /* eps += dEps */
    for (P=0;P<6;P++){ var eP=eps[P], dP2=dEps[P]; for(i=0;i<N3;i++) eP[i] += dP2[i]; }
  }

  /* commit history (tentative -> converged) and macro stress */
  for (P=0;P<6;P++) ws.epTen[P].set(ws.epTrial[P]);
  ws.alpha.set(ws.alphaTrial);
  var sBar = [0,0,0,0,0,0];
  for (P=0;P<6;P++){ var sgP=sig[P]; var acc=0; for(i=0;i<N3;i++) acc+=sgP[i]; sBar[P]=acc/N3; }
  return { sigma_bar: sBar, converged: converged, newtonIters: newtonIters, totalCgIters: totalCg };
}


/* Top-level driver: uniaxial crush of one recipe along one axis.
   axisV in {0,1,2} (xx/yy/zz). control: 'stress' (unconfined, lateral
   free — the physical "press" case, DEFAULT) or 'strain' (confined,
   lateral fixed — simpler, used as a validation anchor).
   Returns { rho, axis, curve:[{eps,sigma}], sigma_y_eff, E0, alphaField, ... }. */
function nonlinearCrushCPU(recipe, N, axisV, opts) {
  opts = opts || {};
  var control   = opts.control || 'stress';
  var epsTarget = opts.epsTarget != null ? opts.epsTarget : 0.02;
  var nSteps    = opts.nSteps    != null ? opts.nSteps    : 20;
  var cutbackMax= opts.cutbackMax!= null ? opts.cutbackMax: 4;

  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);
  var solid  = buildVoxels(family, params, args.offset, N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  var N3 = N * N * N;
  var inside = 0; for (var v = 0; v < N3; v++) inside += solid[v];
  var rho = inside / N3;

  var matSpec = recipe.material || NL_MAT_DEFAULT;
  var m   = nlMakeMaterial(matSpec);
  var Es  = m.E, nu = m.nu;
  var C_s = isoC(Es, nu);
  var C_v = isoC(Es * 1e-4, nu);
  var C0  = isoC(Es, nu);
  var Gamma = buildGammaFull(N, C0[21], C0[1]);

  /* elastic macro stiffness at step 0 (for stress-control macro-Newton + E0) */
  var Cbar_e = null;
  if (control === 'stress') {
    var Ce = new Float64Array(36);
    for (var lc = 0; lc < 6; lc++) {
      var eb = [0,0,0,0,0,0]; eb[lc] = 1;
      var rE = cgSolveFullCPU(solid, C_s, C_v, C0, Gamma, N, eb, 1e-4, 300);
      for (var Pe = 0; Pe < 6; Pe++) Ce[Pe*6+lc] = rE.sigma[Pe];
    }
    for (var Ps=0;Ps<6;Ps++) for (var Qs=Ps+1;Qs<6;Qs++){ var av=0.5*(Ce[Ps*6+Qs]+Ce[Qs*6+Ps]); Ce[Ps*6+Qs]=av; Ce[Qs*6+Ps]=av; }
    Cbar_e = Ce;
  }

  var ws = getNonlinWorkspaceCPU(N);
  for (var P0=0;P0<6;P0++){ ws.epTen[P0].fill(0); ws.eps[P0].fill(0); }
  ws.alpha.fill(0);

  var curve = [];
  var E0 = null;
  var epsBarFull = [0,0,0,0,0,0];   /* current macro strain (all 6) */
  var freeIdx = [];                  /* free (zero-stress) axes for stress control */
  for (var ii=0; ii<6; ii++) if (ii !== axisV) freeIdx.push(ii);

  var dStep = epsTarget / nSteps;
  var step = 0, eAxis = 0;
  while (step < nSteps) {
    var trialAxis = eAxis + dStep;
    epsBarFull[axisV] = trialAxis;

    var res;
    var cut = 0, ok = false;
    while (cut <= cutbackMax) {
      /* snapshot history so a failed step can roll back */
      var snapEp = [], snapAl = ws.alpha.slice(), snapEps = [];
      for (var sp=0;sp<6;sp++){ snapEp.push(ws.epTen[sp].slice()); snapEps.push(ws.eps[sp].slice()); }

      if (control === 'strain') {
        res = nlNewtonSolveCPU(ws, solid, m, C_v, C0, Gamma, N, epsBarFull, opts);
      } else {
        /* uniaxial stress: modified macro-Newton on free strains so sigma_free = 0.
           Fixed macro Jacobian = elastic Cbar_e free-free block (modified Newton). */
        res = nlMacroStressStep(ws, solid, m, C_v, C0, Gamma, N, epsBarFull, axisV, freeIdx, Cbar_e, opts);
      }

      if (res.converged) { ok = true; break; }
      /* cutback: restore history, halve the increment */
      for (var rs=0;rs<6;rs++){ ws.epTen[rs].set(snapEp[rs]); ws.eps[rs].set(snapEps[rs]); }
      ws.alpha.set(snapAl);
      dStep *= 0.5; trialAxis = eAxis + dStep; epsBarFull[axisV] = trialAxis; cut++;
    }
    if (!ok) { return { error: 'newton_diverged', rho: rho, axis: axisV, curve: curve }; }

    eAxis = trialAxis;
    var sAxis = res.sigma_bar[axisV];
    curve.push({ eps: eAxis, sigma: sAxis });
    if (E0 === null && eAxis > 0) E0 = sAxis / eAxis;  /* first-step secant ~ effective modulus */
    step++;
  }

  /* effective modulus: prefer elastic macro stiffness if available */
  var Eeff = E0;
  if (control === 'stress' && Cbar_e) {
    var Sbar = invert6x6(Cbar_e);
    if (Sbar) Eeff = 1 / Sbar[axisV*6 + axisV];
  }
  var sigmaY = nlOffsetYield(curve, Eeff, 0.002);

  /* equivalent plastic strain field (alpha) snapshot for viz */
  var alphaField = ws.alpha.slice();

  return {
    rho: rho, axis: axisV, control: control,
    curve: curve, sigma_y_eff: sigmaY, E0: Eeff,
    alphaField: alphaField, N: N,
    sigma_y_provisional: false
  };
}

/* Uniaxial-stress macro step (modified Newton). Solves the free macro
   strain components so their averaged stress is ~0, holding eps_bar[axis]. */
function nlMacroStressStep(ws, solid, m, C_v, C0, Gamma, N, epsBarFull, axisV, freeIdx, Cbar_e, opts) {
  var macroTol = opts.macroTol != null ? opts.macroTol : 1e-3;
  var macroMax = opts.macroMax != null ? opts.macroMax : 8;
  /* free-free compliance from elastic Cbar_e (modified-Newton Jacobian) */
  var nf = freeIdx.length;
  var Kff = new Float64Array(nf*nf);
  for (var a=0;a<nf;a++) for (var b=0;b<nf;b++) Kff[a*nf+b] = Cbar_e[freeIdx[a]*6 + freeIdx[b]];
  var Sff = invertSmall(Kff, nf);

  var last = null;
  for (var mit=0; mit<macroMax; mit++) {
    var res = nlNewtonSolveCPU(ws, solid, m, C_v, C0, Gamma, N, epsBarFull, opts);
    last = res;
    if (!res.converged) return res;
    var sFree = []; var snorm = 0, sref = Math.abs(res.sigma_bar[axisV]) + 1e-9;
    for (var f=0; f<nf; f++){ var sv = res.sigma_bar[freeIdx[f]]; sFree.push(sv); snorm += sv*sv; }
    if (Math.sqrt(snorm)/sref < macroTol) return res;
    /* delta eps_free = -Sff * sFree */
    for (var r=0;r<nf;r++){ var dd=0; for (var c=0;c<nf;c++) dd += Sff[r*nf+c]*sFree[c]; epsBarFull[freeIdx[r]] -= dd; }
  }
  return last;
}

/* small dense inverse (Gauss-Jordan) for the macro free-free block */
function invertSmall(A, n) {
  var M = new Float64Array(n*2*n);
  for (var i=0;i<n;i++){ for (var j=0;j<n;j++) M[i*2*n+j]=A[i*n+j]; M[i*2*n+n+i]=1; }
  for (var col=0; col<n; col++){
    var piv=M[col*2*n+col], pr=col;
    for (var rr=col+1; rr<n; rr++) if (Math.abs(M[rr*2*n+col])>Math.abs(piv)){ piv=M[rr*2*n+col]; pr=rr; }
    if (Math.abs(piv)<1e-30) return null;
    if (pr!==col) for (var k=0;k<2*n;k++){ var t=M[col*2*n+k]; M[col*2*n+k]=M[pr*2*n+k]; M[pr*2*n+k]=t; }
    var inv=1/M[col*2*n+col];
    for (var k2=0;k2<2*n;k2++) M[col*2*n+k2]*=inv;
    for (var r2=0;r2<n;r2++){ if (r2===col) continue; var fac=M[r2*2*n+col]; for (var k3=0;k3<2*n;k3++) M[r2*2*n+k3]-=fac*M[col*2*n+k3]; }
  }
  var out=new Float64Array(n*n);
  for (var i2=0;i2<n;i2++) for (var j2=0;j2<n;j2++) out[i2*n+j2]=M[i2*2*n+n+j2];
  return out;
}

/* 0.2% offset yield: intersect the curve with the line sigma = E0*(eps - off).
   Returns the stress at intersection, or the curve max if no crossing. */
function nlOffsetYield(curve, E0, off) {
  if (!curve.length || !E0) return null;
  for (var i = 1; i < curve.length; i++) {
    var e1 = curve[i-1].eps, s1 = curve[i-1].sigma;
    var e2 = curve[i].eps,   s2 = curve[i].sigma;
    /* offset line value at e1, e2 */
    var l1 = E0 * (e1 - off), l2 = E0 * (e2 - off);
    var g1 = s1 - l1, g2 = s2 - l2;
    if (g1 >= 0 && g2 < 0) {
      var t = g1 / (g1 - g2);
      return s1 + t * (s2 - s1);
    }
  }
  return curve[curve.length-1].sigma;
}


/* ════════════════════════════════════════════════════════════
   SELF-TESTS  (constitutive: Node-safe; field: browser console)
   ════════════════════════════════════════════════════════════ */

/* Constitutive gates — no FFT, runnable anywhere. */
function runNonlinConstitutiveTest() {
  var pass = true;
  var m = nlMakeMaterial(NL_MAT_DEFAULT);

  /* elastic limit */
  var mBig = nlMakeMaterial({ Es_MPa: 110000, nu: 0.34, sigY0_MPa: 1e15, H_MPa: 2000 });
  var Cref = isoC(110000, 0.34);
  var eV = [0.003,-0.001,0.0007,0.0015,-0.0009,0.0021];
  var c36 = new Float64Array(36);
  var rE = nlReturnMap(eV, [0,0,0,0,0,0], 0, mBig, c36);
  var maxd = 0; for (var i=0;i<36;i++){ var d=Math.abs(c36[i]-Cref[i]); if(d>maxd)maxd=d; }
  console.log('[nl] elastic-limit max|C-isoC| = ' + maxd.toExponential(3) + (maxd<1e-6?'  PASS':'  FAIL'));
  if (maxd >= 1e-6) pass = false;

  /* FD consistent tangent */
  var worst = 0;
  var st = { eV:[0.02,-0.005,0.003,0.004,-0.002,0.006], ep:[0.001,-0.0003,0,0.0005,0,0.0002], al:0.0008 };
  var base = new Float64Array(36);
  var b0 = nlReturnMap(st.eV, st.ep, st.al, m, base);
  var h = 1e-7;
  for (var Q=0;Q<6;Q++){
    var ep1=st.eV.slice(); ep1[Q]+=h; var em1=st.eV.slice(); em1[Q]-=h;
    var rp=nlReturnMap(ep1, st.ep, st.al, m, null);
    var rm=nlReturnMap(em1, st.ep, st.al, m, null);
    for (var Pp=0;Pp<6;Pp++){
      var fd=(rp.sV[Pp]-rm.sV[Pp])/(2*h); var an=base[Pp*6+Q];
      var rel=Math.abs(fd-an)/Math.max(1,Math.abs(an)); if(rel>worst)worst=rel;
    }
  }
  console.log('[nl] FD-tangent worst rel = ' + worst.toExponential(3) + (worst<1e-5?'  PASS':'  FAIL'));
  if (worst >= 1e-5) pass = false;

  console.log('[nl] constitutive: ' + (pass ? 'ALL PASS' : 'FAIL'));
  return pass;
}

/* Field-level smoke test — browser console (needs FFT + rasterizer). */
function runNonlinearCPUTest(N, axis) {
  N = N || 16; axis = axis != null ? axis : 2;  /* default zz */
  if (typeof DEMO_RECIPES === 'undefined') { console.warn('[nl] DEMO_RECIPES not loaded'); return; }
  var recipe = DEMO_RECIPES.schwarzP || DEMO_RECIPES[Object.keys(DEMO_RECIPES)[0]];
  console.log('[nl] crush ' + (recipe.family) + ' axis=' + ['xx','yy','zz'][axis] + ' N=' + N + ' (uniaxial stress)...');
  var t0 = performance.now();
  var out = nonlinearCrushCPU(recipe, N, axis, { control: 'stress', epsTarget: 0.02, nSteps: 16 });
  var dt = performance.now() - t0;
  if (out.error) { console.error('[nl] ' + out.error); return out; }
  console.log('  rho=' + out.rho.toFixed(3) + '  E_eff=' + (out.E0/1000).toFixed(2) + ' GPa'
            + '  sigma_y_eff=' + out.sigma_y_eff.toFixed(1) + ' MPa  (' + dt.toFixed(0) + ' ms)');
  console.log('  curve points: ' + out.curve.length + '  final sigma=' + out.curve[out.curve.length-1].sigma.toFixed(1) + ' MPa');
  return out;
}
