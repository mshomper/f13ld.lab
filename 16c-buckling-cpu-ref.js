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
   PUSH 2 (next session) — extractPrestressCPU, lobpcgGenCPU,
   homogenizeBucklingCPU, runBucklingCPUTest.  The operators
   above are the validated foundation those build on.
   ════════════════════════════════════════════════════════════ */
