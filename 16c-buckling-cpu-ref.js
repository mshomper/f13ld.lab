/* ============================================================
   F13LD.lab · 16c-buckling-cpu-ref.js

   CPU reference oracle for periodic linear-buckling
   homogenization (Phase 5).  Mirrors the 16a → 16b pattern:
   math validated on CPU first, ported to GPU (16d) after.

   ── Physics ─────────────────────────────────────────────
   Cell-periodic (q = 0) linear buckling.  Under a reference
   macroscopic strain ε̄ along a normal axis, the elastic
   homogenization (16a) produces a microscopic pre-stress
   field σ⁰(x).  Linearized stability seeks the load multiplier
   λ and a periodic, zero-mean displacement mode φ(x) with

       K·φ  +  λ·K_g·φ  =  0          (buckling pencil)

   rearranged for the smallest positive λ as the generalized
   eigenproblem  (−K_g)·φ = (1/λ)·K·φ  with K the SPD operand.

     · K   — tangent (elastic) stiffness operator on a periodic
             displacement field:  (K u)_i = −∂_j( C_ijkl(x) ε_kl(u) ).
     · K_g — geometric (initial-stress) stiffness from σ⁰(x):
             (K_g u)_k = −∂_i( σ⁰_ij(x) ∂_j u_k ).

   λ_cr is reported as the minimum positive λ over the three
   normal compression axes (xx / yy / zz).

   ── Derivative convention (scale-invariant) ─────────────
   Spectral derivatives use the SIGNED integer wavenumber κ
   (κ = k for k ≤ N/2, else k − N), Nyquist component zeroed:
       ∂_dir f  =  IFFT( i·κ_dir · FFT(f) ).
   The physical factor 2π/L is intentionally omitted.  Both K
   and K_g are second order in κ, so the omitted (2π/L)² cancels
   in the eigenvalue ratio λ = (φ·Kφ)/(φ·(−K_g)φ).  λ is therefore
   the correct dimensionless load multiplier independent of cell
   size, and the analytic operator checks below use integer-κ
   eigenvalues (longitudinal (λ+2μ)κ², transverse μκ², geometric
   σ⁰_xx κ²) directly.

   ── Field layout (matches 16a) ──────────────────────────
   Displacement u: array of 3 Float64Array(N³) — [u_x, u_y, u_z].
   Stress / strain: array of 6 Float64Array(N³) in engineering
   Voigt order [xx, yy, zz, yz, xz, xy]; strain shears are
   engineering (γ = 2ε).  idx = i·N² + j·N + k, i outermost.

   ── Build status ────────────────────────────────────────
   Push 1 (this file, math + regression):
     - specDeriv                spectral ∂_dir on a real field
     - applyKcpu                K·u  (displacement-form stiffness)
     - applyKgcpu               K_g·u (geometric stiffness)
     - runBucklingOperatorSelfTest
                                analytic + symmetry + dense gates
   Push 2 (next session, solver + validation):
     - extractPrestressCPU      σ⁰(x) from the 16a elastic solve
     - lobpcgGenCPU             block LOBPCG for largest (−K_g, K)
                                eigenpairs (= smallest λ), K-SPD
     - homogenizeBucklingCPU    recipe → { lambda_cr, p_cr, modes }
     - runBucklingCPUTest       Schwarz P N=16 + dense N=4 oracle

   ── External dependencies (resolved at call time) ───────
   - fft3dCpu          (18-stokes-cpu-ref.js — radix-2, in-place
                        on interleaved [re,im], unnormalized fwd,
                        1/N per-axis on inverse)
   - isoC              (14-rasterizer.js — Voigt 6×6 isotropic C;
                        C[0]=λ+2μ, C[1]=λ, C[21]=μ)
   - buildVoxels, KERNELS, resolveBuildArgs, cgSolveFullCPU
                        (used by Push 2 only)
   ============================================================ */


/* Buckling CPU workspace (singleton, cached by N).  Holds the FFT
   complex buffer, a line buffer, real scratch, and the 6-component
   strain/stress arrays used by applyKcpu, plus per-component
   gradient/flux scratch used by applyKgcpu. */
var _buckWsCpu = null;
var _buckWsCpuN = 0;

function getBucklingWorkspaceCPU(N) {
  if (_buckWsCpuN === N && _buckWsCpu) return _buckWsCpu;
  var N3 = N * N * N;
  var make6 = function () {
    return [
      new Float64Array(N3), new Float64Array(N3), new Float64Array(N3),
      new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)
    ];
  };
  var make3 = function () {
    return [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  };
  _buckWsCpu = {
    N: N, N3: N3,
    cbuf:    new Float64Array(2 * N3),   /* complex FFT scratch */
    lineBuf: new Float64Array(2 * N),
    d:       new Float64Array(N3),       /* one derivative result */
    eps:     make6(),                    /* engineering Voigt strain */
    sig:     make6(),                    /* Voigt stress */
    gk:      make3(),                    /* ∂_j u_k for fixed k */
    fk:      make3()                     /* flux σ⁰_ij ∂_j u_k for fixed k */
  };
  _buckWsCpuN = N;
  return _buckWsCpu;
}


/* ============================================================
   specDeriv — spectral first derivative of a real field.

   out(x) = ∂_dir fin(x) = IFFT( i·κ_dir · FFT(fin) )

   dir ∈ {0,1,2} selects ∂/∂x, ∂/∂y, ∂/∂z.  κ is the signed
   integer wavenumber along that axis; the Nyquist bin (k = N/2)
   is zeroed — the derivative of a real field is ill-defined
   there and leaving it in seeds checkerboard oscillation.

   fin: Float64Array(N³)  real input
   out: Float64Array(N³)  real output (may not alias fin)
   ws:  workspace from getBucklingWorkspaceCPU
   ============================================================ */
function specDeriv(fin, dir, N, out, ws) {
  var N3 = N * N * N;
  var cb = ws.cbuf, lb = ws.lineBuf;
  var nyq = N >> 1;

  for (var i = 0; i < N3; i++) { cb[2 * i] = fin[i]; cb[2 * i + 1] = 0; }
  fft3dCpu(cb, N, false, lb);

  for (var a = 0; a < N; a++) {
    var ka = (a <= N / 2) ? a : a - N;
    for (var b = 0; b < N; b++) {
      var kb = (b <= N / 2) ? b : b - N;
      for (var c = 0; c < N; c++) {
        var kc = (c <= N / 2) ? c : c - N;
        var kappa = (dir === 0) ? ka : (dir === 1) ? kb : kc;
        /* Nyquist: zero the derivative of a real field */
        if ((dir === 0 && a === nyq) ||
            (dir === 1 && b === nyq) ||
            (dir === 2 && c === nyq)) kappa = 0;
        var idx = (a * N * N + b * N + c) * 2;
        var re = cb[idx], im = cb[idx + 1];
        /* i·κ·(re + i·im) = (−κ·im) + i·(κ·re) */
        cb[idx]     = -kappa * im;
        cb[idx + 1] =  kappa * re;
      }
    }
  }

  fft3dCpu(cb, N, true, lb);
  for (var i2 = 0; i2 < N3; i2++) out[i2] = cb[2 * i2];
}


/* ============================================================
   applyKcpu — tangent (elastic) stiffness operator.

       (K u)_i = −∂_j( C_ijkl(x) ε_kl(u) )

   Steps: engineering Voigt strain ε(u) from spectral gradients,
   per-voxel Voigt stress σ = C(x):ε, then −divergence of σ.

   u:     [u_x, u_y, u_z]   (3 × Float64Array(N³))
   out:   [o_x, o_y, o_z]   destination (must not alias u)
   solid: Uint8/array(N³)   1 = solid voxel, 0 = void
   C_s:   Float64Array(36)  solid stiffness (engineering Voigt)
   C_v:   Float64Array(36)  void stiffness
   ============================================================ */
function applyKcpu(u, out, solid, C_s, C_v, N, ws) {
  var N3 = N * N * N;
  var eps = ws.eps, sig = ws.sig, d = ws.d;

  /* ε (engineering Voigt) from u */
  specDeriv(u[0], 0, N, eps[0], ws);                 /* ε_xx = ∂x u_x */
  specDeriv(u[1], 1, N, eps[1], ws);                 /* ε_yy = ∂y u_y */
  specDeriv(u[2], 2, N, eps[2], ws);                 /* ε_zz = ∂z u_z */
  /* γ_yz = ∂y u_z + ∂z u_y */
  specDeriv(u[2], 1, N, eps[3], ws);
  specDeriv(u[1], 2, N, d, ws);
  for (var i = 0; i < N3; i++) eps[3][i] += d[i];
  /* γ_xz = ∂x u_z + ∂z u_x */
  specDeriv(u[2], 0, N, eps[4], ws);
  specDeriv(u[0], 2, N, d, ws);
  for (var i2 = 0; i2 < N3; i2++) eps[4][i2] += d[i2];
  /* γ_xy = ∂x u_y + ∂y u_x */
  specDeriv(u[1], 0, N, eps[5], ws);
  specDeriv(u[0], 1, N, d, ws);
  for (var i3 = 0; i3 < N3; i3++) eps[5][i3] += d[i3];

  /* σ = C(x):ε  (per-voxel full 6×6 multiply) */
  for (var idx = 0; idx < N3; idx++) {
    var C = solid[idx] ? C_s : C_v;
    var e0 = eps[0][idx], e1 = eps[1][idx], e2 = eps[2][idx];
    var e3 = eps[3][idx], e4 = eps[4][idx], e5 = eps[5][idx];
    sig[0][idx] = C[0]*e0  + C[1]*e1  + C[2]*e2  + C[3]*e3  + C[4]*e4  + C[5]*e5;
    sig[1][idx] = C[6]*e0  + C[7]*e1  + C[8]*e2  + C[9]*e3  + C[10]*e4 + C[11]*e5;
    sig[2][idx] = C[12]*e0 + C[13]*e1 + C[14]*e2 + C[15]*e3 + C[16]*e4 + C[17]*e5;
    sig[3][idx] = C[18]*e0 + C[19]*e1 + C[20]*e2 + C[21]*e3 + C[22]*e4 + C[23]*e5;
    sig[4][idx] = C[24]*e0 + C[25]*e1 + C[26]*e2 + C[27]*e3 + C[28]*e4 + C[29]*e5;
    sig[5][idx] = C[30]*e0 + C[31]*e1 + C[32]*e2 + C[33]*e3 + C[34]*e4 + C[35]*e5;
  }

  /* out_i = −∂_j σ_ij.   σ tensor = [[s0,s5,s4],[s5,s1,s3],[s4,s3,s2]] */
  /* out_x = −(∂x s0 + ∂y s5 + ∂z s4) */
  specDeriv(sig[0], 0, N, out[0], ws);
  specDeriv(sig[5], 1, N, d, ws); for (var ix = 0; ix < N3; ix++) out[0][ix] += d[ix];
  specDeriv(sig[4], 2, N, d, ws); for (var ix2 = 0; ix2 < N3; ix2++) { out[0][ix2] += d[ix2]; out[0][ix2] = -out[0][ix2]; }
  /* out_y = −(∂x s5 + ∂y s1 + ∂z s3) */
  specDeriv(sig[5], 0, N, out[1], ws);
  specDeriv(sig[1], 1, N, d, ws); for (var iy = 0; iy < N3; iy++) out[1][iy] += d[iy];
  specDeriv(sig[3], 2, N, d, ws); for (var iy2 = 0; iy2 < N3; iy2++) { out[1][iy2] += d[iy2]; out[1][iy2] = -out[1][iy2]; }
  /* out_z = −(∂x s4 + ∂y s3 + ∂z s2) */
  specDeriv(sig[4], 0, N, out[2], ws);
  specDeriv(sig[3], 1, N, d, ws); for (var iz = 0; iz < N3; iz++) out[2][iz] += d[iz];
  specDeriv(sig[2], 2, N, d, ws); for (var iz2 = 0; iz2 < N3; iz2++) { out[2][iz2] += d[iz2]; out[2][iz2] = -out[2][iz2]; }
}


/* ============================================================
   applyKgcpu — geometric (initial-stress) stiffness operator.

       (K_g u)_k = −∂_i( σ⁰_ij(x) ∂_j u_k )      for k = x,y,z

   sig0: [s0..s5] per-voxel pre-stress in Voigt order
         (σ⁰ tensor = [[s0,s5,s4],[s5,s1,s3],[s4,s3,s2]]).
   u, out: 3-component displacement fields (out must not alias u).
   ============================================================ */
function applyKgcpu(u, out, sig0, N, ws) {
  var N3 = N * N * N;
  var gk = ws.gk, fk = ws.fk, d = ws.d;
  var s0 = sig0[0], s1 = sig0[1], s2 = sig0[2], s3 = sig0[3], s4 = sig0[4], s5 = sig0[5];

  for (var k = 0; k < 3; k++) {
    /* gradient g_j = ∂_j u_k */
    specDeriv(u[k], 0, N, gk[0], ws);
    specDeriv(u[k], 1, N, gk[1], ws);
    specDeriv(u[k], 2, N, gk[2], ws);

    /* flux f_i = σ⁰_ij g_j */
    for (var idx = 0; idx < N3; idx++) {
      var gx = gk[0][idx], gy = gk[1][idx], gz = gk[2][idx];
      fk[0][idx] = s0[idx] * gx + s5[idx] * gy + s4[idx] * gz;
      fk[1][idx] = s5[idx] * gx + s1[idx] * gy + s3[idx] * gz;
      fk[2][idx] = s4[idx] * gx + s3[idx] * gy + s2[idx] * gz;
    }

    /* out_k = −(∂x f_x + ∂y f_y + ∂z f_z) */
    var ok = out[k];
    specDeriv(fk[0], 0, N, ok, ws);
    specDeriv(fk[1], 1, N, d, ws); for (var a = 0; a < N3; a++) ok[a] += d[a];
    specDeriv(fk[2], 2, N, d, ws); for (var a2 = 0; a2 < N3; a2++) { ok[a2] += d[a2]; ok[a2] = -ok[a2]; }
  }
}


/* ════════════════════════════════════════════════════════════
   runBucklingOperatorSelfTest — Push 1 validation gates.

   All checks are analytic or algebraic (no geometry pipeline,
   no eigensolver yet), so they pin the operators to closed-form
   truth before Push 2 builds LOBPCG on top.

     G1. specDeriv: ∂²/∂x²[cos(2π κ i/N)] = −κ²·cos   (rel < 1e-9)
     G2. K longitudinal plane wave (uniform solid, κ=(m,0,0),
         u∥κ):   K u = (λ+2μ)·m²·u                    (rel < 1e-8)
     G3. K transverse plane wave (u⊥κ):
                  K u = μ·m²·u                          (rel < 1e-8)
     G4. K symmetric: ⟨u,Kv⟩ = ⟨Ku,v⟩                  (rel < 1e-8)
     G5. K nullspace: K·(constant u) = 0               (abs small)
     G6. K_g uniform pre-stress σ⁰_xx=S, κ=(m,0,0):
                  K_g u = S·m²·u                        (rel < 1e-8)
     G7. K_g symmetric: ⟨u,K_g v⟩ = ⟨K_g u,v⟩          (rel < 1e-8)
     G8. dense assembly at N=4: max|K−Kᵀ|, max|K_g−K_gᵀ| tiny

   Returns { passed, gates:{...}, N }.
   ════════════════════════════════════════════════════════════ */
function runBucklingOperatorSelfTest(N) {
  N = N || 8;
  var N3 = N * N * N;
  var ws = getBucklingWorkspaceCPU(N);

  var Es = 110000, nu = 0.30;
  var C_s = isoC(Es, nu);
  var C_v = isoC(Es * 1e-4, nu);
  var lam = C_s[1], mu = C_s[21];      /* λ = C12, μ = C44 */
  var solidAll = new Uint8Array(N3); solidAll.fill(1);

  var make3 = function () { return [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)]; };
  function dot3(a, b) { var s = 0; for (var c = 0; c < 3; c++){ var ac=a[c], bc=b[c]; for (var i=0;i<N3;i++) s += ac[i]*bc[i]; } return s; }
  function norm3(a){ return Math.sqrt(dot3(a,a)); }
  function relErr(a, b){ return Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b),1e-30); }

  /* cos plane wave along x with integer wavenumber m, polarization pol */
  function planeWave(m, pol) {
    var u = make3();
    for (var i=0;i<N;i++){ var ph = Math.cos(2*Math.PI*m*i/N);
      for (var j=0;j<N;j++) for (var k=0;k<N;k++){ var idx=i*N*N+j*N+k;
        u[0][idx]=pol[0]*ph; u[1][idx]=pol[1]*ph; u[2][idx]=pol[2]*ph; } }
    return u;
  }
  /* max pointwise relative error between vector field f and c·u */
  function fieldVsScaled(f, c, u){
    var maxRel=0;
    for (var comp=0;comp<3;comp++){ var fc=f[comp], uc=u[comp];
      for (var i=0;i<N3;i++){ var want=c*uc[i]; var d=Math.abs(fc[i]-want);
        var sc=Math.max(Math.abs(want),Math.abs(fc[i]),1e-12);
        if (Math.abs(want)>1e-9 || Math.abs(fc[i])>1e-9){ var r=d/sc; if (r>maxRel) maxRel=r; } } }
    return maxRel;
  }
  function randZeroMean(){ var u=make3();
    for (var c=0;c<3;c++){ var uc=u[c], m=0; for (var i=0;i<N3;i++){ uc[i]=Math.random()*2-1; m+=uc[i]; } m/=N3; for (var i2=0;i2<N3;i2++) uc[i2]-=m; }
    return u; }

  var gates = {};
  var m = 2;

  /* G1 — second spectral derivative of a cosine mode */
  var f = new Float64Array(N3), df = new Float64Array(N3), d2f = new Float64Array(N3);
  for (var i=0;i<N;i++){ var ph=Math.cos(2*Math.PI*m*i/N); for (var j=0;j<N;j++) for (var k=0;k<N;k++) f[i*N*N+j*N+k]=ph; }
  specDeriv(f, 0, N, df, ws);
  specDeriv(df, 0, N, d2f, ws);
  var g1max=0; for (var q=0;q<N3;q++){ var want=-(m*m)*f[q]; var sc=Math.max(Math.abs(want),Math.abs(d2f[q]),1e-12); if (Math.abs(want)>1e-9){ var r=Math.abs(d2f[q]-want)/sc; if (r>g1max) r=r, g1max=Math.max(g1max,r); } }
  gates.G1_specDeriv = { maxRel: g1max, pass: g1max < 1e-9 };

  /* G2 — longitudinal: K u = (λ+2μ) m² u */
  var uL = planeWave(m, [1,0,0]); var KuL = make3();
  applyKcpu(uL, KuL, solidAll, C_s, C_v, N, ws);
  var g2 = fieldVsScaled(KuL, (lam+2*mu)*m*m, uL);
  gates.G2_K_longitudinal = { expected: (lam+2*mu)*m*m, maxRel: g2, pass: g2 < 1e-8 };

  /* G3 — transverse: K u = μ m² u */
  var uT = planeWave(m, [0,1,0]); var KuT = make3();
  applyKcpu(uT, KuT, solidAll, C_s, C_v, N, ws);
  var g3 = fieldVsScaled(KuT, mu*m*m, uT);
  gates.G3_K_transverse = { expected: mu*m*m, maxRel: g3, pass: g3 < 1e-8 };

  /* G4 — K symmetry */
  var ua = randZeroMean(), va = randZeroMean(); var Kv = make3(), Ku = make3();
  applyKcpu(va, Kv, solidAll, C_s, C_v, N, ws);
  applyKcpu(ua, Ku, solidAll, C_s, C_v, N, ws);
  var uKv = dot3(ua, Kv), Kuv = dot3(Ku, va);
  gates.G4_K_symmetry = { uKv: uKv, Kuv: Kuv, rel: relErr(uKv, Kuv), pass: relErr(uKv, Kuv) < 1e-8 };

  /* G5 — K nullspace on a constant displacement */
  var uc = make3(); uc[0].fill(0.7); uc[1].fill(-0.3); uc[2].fill(0.5);
  var Kc = make3(); applyKcpu(uc, Kc, solidAll, C_s, C_v, N, ws);
  var g5 = norm3(Kc) / (norm3(uc) * (lam+2*mu) * m * m + 1e-30);
  gates.G5_K_nullspace = { residNorm: norm3(Kc), relToTypical: g5, pass: g5 < 1e-9 };

  /* G6 — geometric stiffness, uniform σ⁰_xx = S */
  var S = -250.0;   /* compressive */
  var sig0u = [new Float64Array(N3), new Float64Array(N3), new Float64Array(N3),
               new Float64Array(N3), new Float64Array(N3), new Float64Array(N3)];
  sig0u[0].fill(S);
  var uG = planeWave(m, [0,0,1]); var KgU = make3();
  applyKgcpu(uG, KgU, sig0u, N, ws);
  var g6 = fieldVsScaled(KgU, S*m*m, uG);
  gates.G6_Kg_uniform = { expected: S*m*m, maxRel: g6, pass: g6 < 1e-8 };

  /* G7 — K_g symmetry with a random symmetric pre-stress field */
  var sig0r = [];
  for (var c2=0;c2<6;c2++){ var arr=new Float64Array(N3); for (var i4=0;i4<N3;i4++) arr[i4]=Math.random()*2-1; sig0r.push(arr); }
  var ub = randZeroMean(), vb = randZeroMean(); var Kgv = make3(), Kgu = make3();
  applyKgcpu(vb, Kgv, sig0r, N, ws);
  applyKgcpu(ub, Kgu, sig0r, N, ws);
  var uKgv = dot3(ub, Kgv), Kguv = dot3(Kgu, vb);
  gates.G7_Kg_symmetry = { uKgv: uKgv, Kguv: Kguv, rel: relErr(uKgv, Kguv), pass: relErr(uKgv, Kguv) < 1e-8 };

  /* G8 — dense assembly symmetry at small N */
  var Nd = 4, Nd3 = Nd*Nd*Nd, dof = 3*Nd3;
  var wsd = getBucklingWorkspaceCPU(Nd);
  var solidD = new Uint8Array(Nd3); solidD.fill(1);
  var sig0d = []; for (var c3=0;c3<6;c3++){ var a=new Float64Array(Nd3); for (var i5=0;i5<Nd3;i5++) a[i5]=Math.sin(i5*0.7+c3)*100; sig0d.push(a); }
  function assemble(applyFn){
    var Kmat = new Array(dof);
    var e = [new Float64Array(Nd3), new Float64Array(Nd3), new Float64Array(Nd3)];
    var o = [new Float64Array(Nd3), new Float64Array(Nd3), new Float64Array(Nd3)];
    for (var col=0; col<dof; col++){
      e[0].fill(0); e[1].fill(0); e[2].fill(0);
      e[(col/Nd3)|0][col%Nd3] = 1;
      applyFn(e, o);
      var c = new Float64Array(dof);
      for (var comp=0;comp<3;comp++) for (var p=0;p<Nd3;p++) c[comp*Nd3+p]=o[comp][p];
      Kmat[col] = c;   /* column col */
    }
    return Kmat;
  }
  var Kdense  = assemble(function(e,o){ applyKcpu(e, o, solidD, C_s, C_v, Nd, wsd); });
  var Kgdense = assemble(function(e,o){ applyKgcpu(e, o, sig0d, Nd, wsd); });
  function maxAsym(M){ var mx=0; for (var r=0;r<dof;r++) for (var cc=0;cc<dof;cc++){ var d=Math.abs(M[cc][r]-M[r][cc]); var sc=Math.max(Math.abs(M[cc][r]),Math.abs(M[r][cc]),1e-12); if (sc>1e-6){ var rr=d/sc; if (rr>mx) mx=rr; } } return mx; }
  var asymK = maxAsym(Kdense), asymKg = maxAsym(Kgdense);
  gates.G8_dense_symmetry = { dof: dof, maxRelAsymK: asymK, maxRelAsymKg: asymKg, pass: asymK < 1e-7 && asymKg < 1e-7 };

  var passed = true;
  var names = Object.keys(gates);
  for (var gi=0; gi<names.length; gi++) if (!gates[names[gi]].pass) passed = false;

  if (typeof console !== 'undefined') {
    console.log('[16c buckling operators · self-test] N=' + N);
    for (var gj=0; gj<names.length; gj++){
      var g = gates[names[gj]];
      console.log('  ' + (g.pass ? '\u2713' : '\u2717') + ' ' + names[gj] + '  ' + JSON.stringify(g));
    }
    console.log('  verdict: ' + (passed ? '\u2713 PASS' : '\u2717 FAIL'));
  }
  return { passed: passed, N: N, gates: gates };
}


/* ════════════════════════════════════════════════════════════
   PUSH 2a — generalized eigensolver engine.

   The buckling pencil (−K_g)·φ = θ·K·φ (θ = 1/λ, K SPD on the
   zero-mean subspace) is solved matrix-free at N=16 by block
   subspace iteration with Rayleigh-Ritz.  The Rayleigh-Ritz step
   reduces to a small dense symmetric-definite generalized eigen-
   problem SA·z = θ·SB·z, handled here by Cholesky + cyclic Jacobi.

   These kernels are validated in isolation (runBucklingEigSelfTest)
   against a dense reference before being wired to the K / K_g
   operators and the pre-stress field in Push 2b.
   ════════════════════════════════════════════════════════════ */

/* Dense row-major helpers.  Matrices are Float64Array(n·n), A[r·n+c].
   Sizes are small: Rayleigh-Ritz blocks ≤ ~16; the dense N=4 ground
   truth in Push 2b is ≤ 192. */

function bk_dot(a, b, n) { var s = 0; for (var i = 0; i < n; i++) s += a[i] * b[i]; return s; }

/* Cholesky A = L·Lᵀ (L lower).  Returns L (flat) or null if A is not
   numerically SPD. */
function bk_cholesky(A, n) {
  var L = new Float64Array(n * n);
  for (var i = 0; i < n; i++) {
    for (var j = 0; j <= i; j++) {
      var sum = A[i * n + j];
      for (var k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (sum <= 0) return null; L[i * n + j] = Math.sqrt(sum); }
      else L[i * n + j] = sum / L[j * n + j];
    }
  }
  return L;
}

function bk_forwardSolve(L, b, n, out) {       /* solve L·y = b */
  for (var i = 0; i < n; i++) {
    var s = b[i];
    for (var k = 0; k < i; k++) s -= L[i * n + k] * out[k];
    out[i] = s / L[i * n + i];
  }
}

function bk_backSolveLt(L, b, n, out) {        /* solve Lᵀ·x = b */
  for (var i = n - 1; i >= 0; i--) {
    var s = b[i];
    for (var k = i + 1; k < n; k++) s -= L[k * n + i] * out[k];
    out[i] = s / L[i * n + i];
  }
}

/* Cyclic Jacobi eigensolver for symmetric A (Numerical-Recipes-style
   rotation that zeros the off-diagonal).  Returns
   { values: Float64Array(n), vectors: Float64Array(n·n) } with
   eigenvector j in column j: V[r·n + j]. */
function bk_jacobiSym(Ain, n, maxSweeps, tol) {
  maxSweeps = maxSweeps || 100; tol = tol || 1e-15;
  var A = Float64Array.from(Ain);
  var V = new Float64Array(n * n);
  for (var d = 0; d < n; d++) V[d * n + d] = 1;
  for (var sweep = 0; sweep < maxSweeps; sweep++) {
    var off = 0;
    for (var p = 0; p < n; p++) for (var q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
    if (off < tol * tol) break;
    for (var p2 = 0; p2 < n; p2++) {
      for (var q2 = p2 + 1; q2 < n; q2++) {
        var apq = A[p2 * n + q2];
        if (apq === 0) continue;
        var app = A[p2 * n + p2], aqq = A[q2 * n + q2];
        var theta = (aqq - app) / (2 * apq);
        var tn = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        var c = 1 / Math.sqrt(tn * tn + 1), s = tn * c;
        for (var k = 0; k < n; k++) {                 /* A ← Jᵀ A J: columns p,q */
          var akp = A[k * n + p2], akq = A[k * n + q2];
          A[k * n + p2] = c * akp - s * akq;
          A[k * n + q2] = s * akp + c * akq;
        }
        for (var k2 = 0; k2 < n; k2++) {              /* rows p,q */
          var apk = A[p2 * n + k2], aqk = A[q2 * n + k2];
          A[p2 * n + k2] = c * apk - s * aqk;
          A[q2 * n + k2] = s * apk + c * aqk;
        }
        for (var k3 = 0; k3 < n; k3++) {              /* accumulate V */
          var vkp = V[k3 * n + p2], vkq = V[k3 * n + q2];
          V[k3 * n + p2] = c * vkp - s * vkq;
          V[k3 * n + q2] = s * vkp + c * vkq;
        }
      }
    }
  }
  var values = new Float64Array(n);
  for (var i = 0; i < n; i++) values[i] = A[i * n + i];
  return { values: values, vectors: V };
}

/* Symmetric-definite generalized eigenproblem SA·z = θ·SB·z with SB SPD.
   SA may be indefinite (the buckling A = −K_g is).  Reduces via
   SB = L·Lᵀ to the standard symmetric problem C = L⁻¹·SA·L⁻ᵀ, Jacobi
   on C, then z = L⁻ᵀ·q.  Returns { values, vectors } (vectors in
   columns) or null if SB is not SPD. */
function bk_genEigSPD(SA, SB, n) {
  var L = bk_cholesky(SB, n);
  if (!L) return null;
  var col = new Float64Array(n), sol = new Float64Array(n);
  var U = new Float64Array(n * n);                 /* U = L⁻¹·SA */
  for (var c = 0; c < n; c++) {
    for (var r = 0; r < n; r++) col[r] = SA[r * n + c];
    bk_forwardSolve(L, col, n, sol);
    for (var r2 = 0; r2 < n; r2++) U[r2 * n + c] = sol[r2];
  }
  var C = new Float64Array(n * n);                 /* C = L⁻¹·Uᵀ = L⁻¹·SA·L⁻ᵀ */
  for (var c2 = 0; c2 < n; c2++) {
    for (var r3 = 0; r3 < n; r3++) col[r3] = U[c2 * n + r3];   /* (Uᵀ)[r3][c2] */
    bk_forwardSolve(L, col, n, sol);
    for (var r4 = 0; r4 < n; r4++) C[r4 * n + c2] = sol[r4];
  }
  for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) {
    var mm = 0.5 * (C[a * n + b] + C[b * n + a]); C[a * n + b] = mm; C[b * n + a] = mm;
  }
  var eig = bk_jacobiSym(C, n, 200, 1e-15);
  var vectors = new Float64Array(n * n);
  var q = new Float64Array(n), z = new Float64Array(n);
  for (var j = 0; j < n; j++) {
    for (var r5 = 0; r5 < n; r5++) q[r5] = eig.vectors[r5 * n + j];
    bk_backSolveLt(L, q, n, z);
    for (var r6 = 0; r6 < n; r6++) vectors[r6 * n + j] = z[r6];
  }
  return { values: eig.values, vectors: vectors };
}

/* Modified Gram-Schmidt L2 orthonormalization of a set of length-n
   vectors; drops linearly-dependent directions. */
function bk_orthonormalize(vecs, n) {
  var out = [];
  for (var i = 0; i < vecs.length; i++) {
    var v = Float64Array.from(vecs[i]);
    for (var j = 0; j < out.length; j++) {
      var dd = bk_dot(out[j], v, n), oj = out[j];
      for (var k = 0; k < n; k++) v[k] -= dd * oj[k];
    }
    var nrm = Math.sqrt(bk_dot(v, v, n));
    if (nrm > 1e-10) { for (var k2 = 0; k2 < n; k2++) v[k2] /= nrm; out.push(v); }
  }
  return out;
}

/* ============================================================
   bk_subspaceGen — matrix-free block subspace iteration with
   Rayleigh-Ritz for the dominant (largest |θ|) eigenpairs of the
   generalized pencil A·x = θ·B·x, B SPD.

   applyA(x, out)  — out ← A·x        (length-n field/vector)
   applyB(x, out)  — out ← B·x
   solveB(b, out)  — out ← B⁻¹·b      (inner solve; e.g. CG on K)
   n               — vector length
   m               — block size (number of eigenpairs tracked)
   opts.iters      — max outer iterations (default 80)
   opts.tol        — relative convergence on the tracked θ (1e-8)
   opts.project    — optional in-place projector applied to every
                     iterate (e.g. zero-mean, to stay in K's
                     non-singular subspace)

   Returns [{ theta, vec }, ...] sorted by θ descending, where θ is
   the Rayleigh quotient (xᵀA x)/(xᵀB x) of the converged Ritz vector.
   The buckling driver (Push 2b) selects the smallest positive
   λ = 1/θ across the returned pairs.
   ============================================================ */
function bk_subspaceGen(applyA, applyB, solveB, n, m, opts) {
  opts = opts || {};
  var iters = opts.iters || 80;
  var tol   = opts.tol != null ? opts.tol : 1e-8;
  var proj  = opts.project || null;

  var X = [];
  for (var c = 0; c < m; c++) {
    var v = new Float64Array(n);
    for (var i = 0; i < n; i++) v[i] = Math.random() * 2 - 1;
    if (proj) proj(v);
    X.push(v);
  }

  var tmp = new Float64Array(n);
  var prevTheta = null;
  var converged = false;
  var lastIters = 0;

  for (var it = 0; it < iters; it++) {
    lastIters = it + 1;
    /* power step Z = B⁻¹·A·X */
    var Z = [];
    for (var cc = 0; cc < m; cc++) {
      applyA(X[cc], tmp);
      var z = new Float64Array(n);
      solveB(tmp, z);
      if (proj) proj(z);
      Z.push(z);
    }
    /* trial subspace = span(X ∪ Z), orthonormalized (keeps history,
       LOBPCG-flavoured — accelerates and stabilizes convergence) */
    var V = bk_orthonormalize(X.concat(Z), n);
    var s = V.length;
    var AV = [], BV = [];
    for (var j = 0; j < s; j++) { var av = new Float64Array(n), bv = new Float64Array(n); applyA(V[j], av); applyB(V[j], bv); AV.push(av); BV.push(bv); }
    var SA = new Float64Array(s * s), SB = new Float64Array(s * s);
    for (var ii = 0; ii < s; ii++) for (var jj = 0; jj < s; jj++) {
      SA[ii * s + jj] = bk_dot(V[ii], AV[jj], n);
      SB[ii * s + jj] = bk_dot(V[ii], BV[jj], n);
    }
    for (var a2 = 0; a2 < s; a2++) for (var b2 = a2 + 1; b2 < s; b2++) {
      var sma = 0.5 * (SA[a2 * s + b2] + SA[b2 * s + a2]); SA[a2 * s + b2] = sma; SA[b2 * s + a2] = sma;
      var smb = 0.5 * (SB[a2 * s + b2] + SB[b2 * s + a2]); SB[a2 * s + b2] = smb; SB[b2 * s + a2] = smb;
    }
    var ge = bk_genEigSPD(SA, SB, s);
    if (!ge) break;
    var order = []; for (var o = 0; o < s; o++) order.push(o);
    order.sort(function (p, q) { return ge.values[q] - ge.values[p]; });

    var take = Math.min(m, s);
    var newX = [], topThetas = [];
    for (var c2 = 0; c2 < take; c2++) {
      var oc = order[c2];
      topThetas.push(ge.values[oc]);
      var xc = new Float64Array(n);
      for (var jv = 0; jv < s; jv++) { var coef = ge.vectors[jv * s + oc], Vj = V[jv]; for (var iv = 0; iv < n; iv++) xc[iv] += coef * Vj[iv]; }
      if (proj) proj(xc);
      newX.push(xc);
    }
    X = newX;

    if (prevTheta && prevTheta.length === topThetas.length) {
      var maxd = 0;
      for (var kk = 0; kk < topThetas.length; kk++) {
        var rel = Math.abs(topThetas[kk] - prevTheta[kk]) / Math.max(Math.abs(topThetas[kk]), 1e-30);
        if (rel > maxd) maxd = rel;
      }
      if (maxd < tol) { converged = true; break; }
    }
    prevTheta = topThetas;
  }

  var out = [];
  var tb = new Float64Array(n);
  for (var cf = 0; cf < X.length; cf++) {
    applyA(X[cf], tmp); applyB(X[cf], tb);
    var num = bk_dot(X[cf], tmp, n), den = bk_dot(X[cf], tb, n);
    out.push({ theta: num / den, vec: X[cf] });
  }
  out.sort(function (p, q) { return q.theta - p.theta; });
  out._iters = lastIters; out._converged = converged;
  return out;
}


/* ════════════════════════════════════════════════════════════
   runBucklingEigSelfTest — Push 2a validation (no physics yet).

     E1. Cholesky: ‖L·Lᵀ − A‖∞ on a random SPD A           (< 1e-10)
     E2. Jacobi: ‖A·v − λ·v‖ per pair on random symmetric A (< 1e-9)
     E3. genEigSPD: ‖SA·z − θ·SB·z‖/‖SA·z‖ per pair,
         SA indefinite, SB SPD                              (< 1e-9)
     E4. subspaceGen recovers the top-m θ of an SPD pencil,
         matching the dense genEigSPD reference             (rel < 1e-6)

   Returns { passed, gates }.
   ════════════════════════════════════════════════════════════ */
function runBucklingEigSelfTest() {
  var gates = {};
  function randMat(n) { var A = new Float64Array(n * n); for (var i = 0; i < n * n; i++) A[i] = Math.random() * 2 - 1; return A; }
  function symFrom(R, n) { var A = new Float64Array(n * n); for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) A[i * n + j] = 0.5 * (R[i * n + j] + R[j * n + i]); return A; }
  function spdFrom(R, n) { var A = new Float64Array(n * n); for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) { var s = 0; for (var k = 0; k < n; k++) s += R[k * n + i] * R[k * n + j]; A[i * n + j] = s + (i === j ? n : 0); } return A; }
  function matvec(M, x, n, out) { for (var i = 0; i < n; i++) { var s = 0; for (var j = 0; j < n; j++) s += M[i * n + j] * x[j]; out[i] = s; } }

  var n = 30;
  var R = randMat(n);
  var B = spdFrom(R, n);
  var Asym = symFrom(randMat(n), n);           /* indefinite symmetric */
  var Aspd = spdFrom(randMat(n), n);           /* SPD (dominant θ = largest θ) */

  /* E1 — Cholesky */
  var L = bk_cholesky(B, n);
  var e1 = 0;
  for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
    var s = 0; for (var k = 0; k <= Math.min(i, j); k++) s += L[i * n + k] * L[j * n + k];
    var d = Math.abs(s - B[i * n + j]); if (d > e1) e1 = d;
  }
  gates.E1_cholesky = { maxAbs: e1, pass: e1 < 1e-10 };

  /* E2 — Jacobi residual */
  var je = bk_jacobiSym(Asym, n, 200, 1e-15);
  var e2 = 0, av = new Float64Array(n);
  for (var p = 0; p < n; p++) {
    var vv = new Float64Array(n); for (var r = 0; r < n; r++) vv[r] = je.vectors[r * n + p];
    matvec(Asym, vv, n, av);
    var res = 0; for (var r2 = 0; r2 < n; r2++) { var dlt = av[r2] - je.values[p] * vv[r2]; res += dlt * dlt; }
    res = Math.sqrt(res); if (res > e2) e2 = res;
  }
  gates.E2_jacobi = { maxResid: e2, pass: e2 < 1e-9 };

  /* E3 — generalized eig residual (indefinite SA, SPD SB) */
  var ge = bk_genEigSPD(Asym, B, n);
  var e3 = 0, Az = new Float64Array(n), Bz = new Float64Array(n);
  for (var pp = 0; pp < n; pp++) {
    var z = new Float64Array(n); for (var r3 = 0; r3 < n; r3++) z[r3] = ge.vectors[r3 * n + pp];
    matvec(Asym, z, n, Az); matvec(B, z, n, Bz);
    var num = 0, den = 0;
    for (var r4 = 0; r4 < n; r4++) { var dl = Az[r4] - ge.values[pp] * Bz[r4]; num += dl * dl; den += Az[r4] * Az[r4]; }
    var rel = Math.sqrt(num) / Math.max(Math.sqrt(den), 1e-30); if (rel > e3) e3 = rel;
  }
  gates.E3_genEigSPD = { maxRelResid: e3, pass: e3 < 1e-9 };

  /* E4 — subspaceGen vs dense reference (SPD A: dominant θ = largest θ) */
  var refAll = bk_genEigSPD(Aspd, B, n);
  var refVals = Array.prototype.slice.call(refAll.values).sort(function (a, b) { return b - a; });
  var Lb = bk_cholesky(B, n);
  var fwd = new Float64Array(n);
  var pairs = bk_subspaceGen(
    function (x, out) { matvec(Aspd, x, n, out); },
    function (x, out) { matvec(B, x, n, out); },
    function (b, out) { bk_forwardSolve(Lb, b, n, fwd); bk_backSolveLt(Lb, fwd, n, out); },
    n, 5, { iters: 120, tol: 1e-10 }
  );
  var e4 = 0;
  for (var t = 0; t < 5; t++) {
    var rel = Math.abs(pairs[t].theta - refVals[t]) / Math.max(Math.abs(refVals[t]), 1e-30);
    if (rel > e4) e4 = rel;
  }
  gates.E4_subspaceGen = { topRef: refVals.slice(0, 5), topGot: pairs.slice(0, 5).map(function (p) { return p.theta; }), iters: pairs._iters, converged: pairs._converged, maxRel: e4, pass: e4 < 1e-6 };

  var passed = true, names = Object.keys(gates);
  for (var gi = 0; gi < names.length; gi++) if (!gates[names[gi]].pass) passed = false;
  if (typeof console !== 'undefined') {
    console.log('[16c eigensolver engine · self-test]');
    for (var gj = 0; gj < names.length; gj++) console.log('  ' + (gates[names[gj]].pass ? '\u2713' : '\u2717') + ' ' + names[gj] + '  ' + JSON.stringify(gates[names[gj]]));
    console.log('  verdict: ' + (passed ? '\u2713 PASS' : '\u2717 FAIL'));
  }
  return { passed: passed, gates: gates };
}


/* ════════════════════════════════════════════════════════════
   PUSH 2b (next) — extractPrestressCPU (σ⁰ from the displacement-
   form elastic cell solve via applyKcpu), bucklingFromSolid /
   homogenizeBucklingCPU (wire K, K_g, bk_subspaceGen; λ_cr = min
   positive λ over xx/yy/zz), and runBucklingCPUTest cross-checking
   the matrix-free result against a dense generalized eigensolve at
   N=4 plus a Schwarz P sanity at N=16.
   ════════════════════════════════════════════════════════════ */
