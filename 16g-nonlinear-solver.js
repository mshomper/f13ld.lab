/* ============================================================
   F13LD.lab · 16g-nonlinear-solver.js

   GPU production solver for small-strain J2 plasticity.
   Validates against the 16f CPU oracle, exactly as 16b validated
   against 16a.

   ── PUSH 1 (this file): the two NEW GPU kernels + validator ──
   The novel, correctness-critical GPU surface is the per-voxel
   J2 math. Everything else (FFT, Green operator, CG vector ops)
   is reused from 16b in Push 2. Since WGSL can't be unit-tested
   outside the browser, this push proves the new kernels in
   isolation against 16f before the FFT-CG Newton loop is built
   on top of them.

     - RETURN_MAP_FULL_WGSL   per-voxel radial return -> stress,
                              consistent-tangent scalars {theta,
                              thetabar, n_hat}, updated history
     - APPLY_TANGENT_FULL_WGSL matrix-free C_alg : v using the
                              stored {theta, thetabar, n_hat}
                              (the no-store tangent scheme)
     - NonlinearKernels       minimal device/pipeline/buffer host
                              for the two kernels (Push 2 folds
                              these into NonlinearSolverFull)
     - runNonlinearKernelTest browser console: GPU vs 16f per
                              voxel, ~1% f32 tolerance

   ── PUSH 2 (next): the solver proper ────────────────────────
     - NonlinearSolverFull : reuse 16b's pack/FFT/gamma/de_accum/
       axpy/dot chain; Newton equilibrium with the frozen tangent;
       load stepping; uniaxial-stress macro-Newton (warm-started);
       runNonlinearGPUTest vs 16f at N=16.

   ── Packing (matches 16b) ───────────────────────────────────
     strain / stress: two vec4 arrays, _n = (xx,yy,zz,_),
     _s = (yz,xz,xy,_); engineering shear strain, natural shear
     stress; .w padding.
     plastic history: epp_n = (e00,e11,e22, alpha) tensor + alpha
     in .w; epp_s = (e_yz,e_xz,e_xy, _) tensor shear.
     tangent: tan_n = (n00,n11,n22, theta),
     tan_s = (n_yz,n_xz,n_xy, thetabar); n_hat is the unit
     deviatoric flow direction in TENSOR components.

   ── Dependencies (loaded earlier in index.html) ─────────────
     11 : WGPU, ensureDevice
     16f: nlMakeMaterial, nlReturnMap, NL_MAT_DEFAULT  (validator)
     14 : isoC                                          (validator)
   ============================================================ */


/* J2 material params uniform — 4 vec4 = 64 bytes.
   row0: mu_s, lam_s, K_s, sigY0
   row1: mu_v, lam_v, K_v, useVoce (0/1 as f32)
   row2: H,    sigSat, delta, Hlin
   row3: total (u32), theta_min (f32), pad, pad */
var J2_PARAMS_WGSL = [
'struct J2Params {',
'  mu_s: f32, lam_s: f32, K_s: f32, sigY0: f32,',
'  mu_v: f32, lam_v: f32, K_v: f32, useVoce: f32,',
'  H: f32, sigSat: f32, delta: f32, Hlin: f32,',
'  total: u32, theta_min: f32, _p1: u32, _p2: u32,',
'}',
''
].join('\n');

/* shared flow-stress helpers (linear or Voce) */
var J2_FLOW_WGSL = [
'fn flow_sigY(P: J2Params, a: f32) -> f32 {',
'  if (P.useVoce > 0.5) {',
'    let ex = exp(-P.delta * a);',
'    return P.sigY0 + (P.sigSat - P.sigY0) * (1.0 - ex) + P.Hlin * a;',
'  }',
'  return P.sigY0 + P.H * a;',
'}',
'fn flow_Hp(P: J2Params, a: f32) -> f32 {',
'  if (P.useVoce > 0.5) {',
'    return (P.sigSat - P.sigY0) * P.delta * exp(-P.delta * a) + P.Hlin;',
'  }',
'  return P.H;',
'}',
''
].join('\n');


/* ── return_map_full ─────────────────────────────────────────
   Per-voxel radial-return mapping. Mirrors 16f nlReturnMap. */
var RETURN_MAP_FULL_WGSL = J2_PARAMS_WGSL + J2_FLOW_WGSL + [
'@group(0) @binding(0)  var<storage, read>       solid:    array<f32>;',
'@group(0) @binding(1)  var<storage, read>       eps_n:    array<vec4<f32>>;',
'@group(0) @binding(2)  var<storage, read>       eps_s:    array<vec4<f32>>;',
'@group(0) @binding(3)  var<storage, read>       epp_n:    array<vec4<f32>>;',
'@group(0) @binding(4)  var<storage, read>       epp_s:    array<vec4<f32>>;',
'@group(0) @binding(5)  var<storage, read_write> sig_n:    array<vec4<f32>>;',
'@group(0) @binding(6)  var<storage, read_write> sig_s:    array<vec4<f32>>;',
'@group(0) @binding(7)  var<storage, read_write> tan_n:    array<vec4<f32>>;',
'@group(0) @binding(8)  var<storage, read_write> tan_s:    array<vec4<f32>>;',
'@group(0) @binding(9)  var<storage, read_write> epp_n_out:array<vec4<f32>>;',
'@group(0) @binding(10) var<storage, read_write> epp_s_out:array<vec4<f32>>;',
'@group(0) @binding(11) var<uniform>             P: J2Params;',
'',
'const SQRT23: f32 = 0.8164965809277260;',  /* sqrt(2/3) */
'',
'@compute @workgroup_size(64)',
'fn return_map_full(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let i = gid.x;',
'  if (i >= P.total) { return; }',
'  let isSolid = solid[i] > 0.5;',
'  let en = eps_n[i].xyz;',          /* total normal strain */
'  let es = eps_s[i].xyz;',          /* total engineering shear */
'  let ets = es * 0.5;',             /* tensor shear */
'',
'  if (!isSolid) {',
'    let trv = en.x + en.y + en.z;',
'    sig_n[i] = vec4<f32>(P.lam_v*trv + 2.0*P.mu_v*en.x,',
'                         P.lam_v*trv + 2.0*P.mu_v*en.y,',
'                         P.lam_v*trv + 2.0*P.mu_v*en.z, 0.0);',
'    sig_s[i] = vec4<f32>(P.mu_v*es.x, P.mu_v*es.y, P.mu_v*es.z, 0.0);',
'    tan_n[i] = vec4<f32>(0.0, 0.0, 0.0, 1.0);',   /* theta = 1 */
'    tan_s[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);',   /* thetabar = 0 */
'    epp_n_out[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
'    epp_s_out[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
'    return;',
'  }',
'',
'  let ep_n = epp_n[i].xyz;',        /* committed plastic strain (tensor) */
'  let ep_s = epp_s[i].xyz;',
'  let al   = epp_n[i].w;',          /* committed accumulated plastic strain */
'',
'  let ee  = en - ep_n;',
'  let ees = ets - ep_s;',
'  let trE = ee.x + ee.y + ee.z;',
'  let s00 = P.lam_s*trE + 2.0*P.mu_s*ee.x;',
'  let s11 = P.lam_s*trE + 2.0*P.mu_s*ee.y;',
'  let s22 = P.lam_s*trE + 2.0*P.mu_s*ee.z;',
'  let s23 = 2.0*P.mu_s*ees.x;',
'  let s13 = 2.0*P.mu_s*ees.y;',
'  let s12 = 2.0*P.mu_s*ees.z;',
'  let pmean = (s00 + s11 + s22) / 3.0;',
'  let d00 = s00 - pmean;',
'  let d11 = s11 - pmean;',
'  let d22 = s22 - pmean;',
'  let devNorm = sqrt(d00*d00 + d11*d11 + d22*d22 + 2.0*(s23*s23 + s13*s13 + s12*s12));',
'  let fTrial = devNorm - SQRT23 * flow_sigY(P, al);',
'',
'  if (fTrial <= 0.0 || devNorm < 1e-30) {',
'    sig_n[i] = vec4<f32>(s00, s11, s22, 0.0);',
'    sig_s[i] = vec4<f32>(s23, s13, s12, 0.0);',
'    tan_n[i] = vec4<f32>(0.0, 0.0, 0.0, 1.0);',
'    tan_s[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
'    epp_n_out[i] = vec4<f32>(ep_n, al);',
'    epp_s_out[i] = vec4<f32>(ep_s, 0.0);',
'    return;',
'  }',
'',
'  var dgamma: f32;',
'  if (P.useVoce > 0.5) {',
'    dgamma = fTrial / (2.0*P.mu_s + (2.0/3.0)*flow_Hp(P, al));',
'    for (var it: i32 = 0; it < 20; it = it + 1) {',
'      let aT = al + SQRT23 * dgamma;',
'      let r  = devNorm - 2.0*P.mu_s*dgamma - SQRT23 * flow_sigY(P, aT);',
'      let dr = -2.0*P.mu_s - (2.0/3.0) * flow_Hp(P, aT);',
'      dgamma = dgamma - r/dr;',
'    }',
'  } else {',
'    dgamma = fTrial / (2.0*P.mu_s + (2.0/3.0)*P.H);',
'  }',
'  let Hp = flow_Hp(P, al + SQRT23 * dgamma);',
'',
'  let inv = 1.0 / devNorm;',
'  let n00 = d00*inv; let n11 = d11*inv; let n22 = d22*inv;',
'  let n23 = s23*inv; let n13 = s13*inv; let n12 = s12*inv;',
'  let twomudg = 2.0*P.mu_s*dgamma;',
'  sig_n[i] = vec4<f32>(s00 - twomudg*n00, s11 - twomudg*n11, s22 - twomudg*n22, 0.0);',
'  sig_s[i] = vec4<f32>(s23 - twomudg*n23, s13 - twomudg*n13, s12 - twomudg*n12, 0.0);',
'',
'  let theta    = max(1.0 - twomudg*inv, P.theta_min);',
'  let thetabar = 1.0/(1.0 + Hp/(3.0*P.mu_s)) - (1.0 - theta);',
'  tan_n[i] = vec4<f32>(n00, n11, n22, theta);',
'  tan_s[i] = vec4<f32>(n23, n13, n12, thetabar);',
'',
'  epp_n_out[i] = vec4<f32>(ep_n.x + dgamma*n00, ep_n.y + dgamma*n11, ep_n.z + dgamma*n22, al + SQRT23*dgamma);',
'  epp_s_out[i] = vec4<f32>(ep_s.x + dgamma*n23, ep_s.y + dgamma*n13, ep_s.z + dgamma*n12, 0.0);',
'}'
].join('\n');


/* ── apply_tangent_full ──────────────────────────────────────
   Matrix-free C_alg : v from the stored tangent scalars.
   C_alg = K(1x1) + 2mu*theta*Idev - 2mu*thetabar*(n_hat x n_hat).
   No 6x6 is ever assembled (the no-store tangent scheme). */
var APPLY_TANGENT_FULL_WGSL = J2_PARAMS_WGSL + [
'@group(0) @binding(0) var<storage, read>       solid: array<f32>;',
'@group(0) @binding(1) var<storage, read>       v_n:   array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read>       v_s:   array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read>       tan_n: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read>       tan_s: array<vec4<f32>>;',
'@group(0) @binding(5) var<storage, read_write> out_n: array<vec4<f32>>;',
'@group(0) @binding(6) var<storage, read_write> out_s: array<vec4<f32>>;',
'@group(0) @binding(7) var<uniform>             P: J2Params;',
'',
'@compute @workgroup_size(64)',
'fn apply_tangent_full(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let i = gid.x;',
'  if (i >= P.total) { return; }',
'  let isSolid = solid[i] > 0.5;',
'  let vn = v_n[i].xyz;',          /* normal */
'  let vs = v_s[i].xyz;',          /* engineering shear */
'  let trv = vn.x + vn.y + vn.z;',
'',
'  if (!isSolid) {',
'    out_n[i] = vec4<f32>(P.lam_v*trv + 2.0*P.mu_v*vn.x,',
'                         P.lam_v*trv + 2.0*P.mu_v*vn.y,',
'                         P.lam_v*trv + 2.0*P.mu_v*vn.z, 0.0);',
'    out_s[i] = vec4<f32>(P.mu_v*vs.x, P.mu_v*vs.y, P.mu_v*vs.z, 0.0);',
'    return;',
'  }',
'',
'  let nN = tan_n[i].xyz; let theta    = tan_n[i].w;',
'  let nS = tan_s[i].xyz; let thetabar = tan_s[i].w;',
'  let twomu = 2.0*P.mu_s;',
'  let nv = dot(nN, vn) + dot(nS, vs);',  /* n_hat : vt (eng-shear folds the factor 2) */
'  let c  = twomu * thetabar * nv;',
'  out_n[i] = vec4<f32>(',
'    P.K_s*trv + twomu*theta*(vn.x - trv/3.0) - c*nN.x,',
'    P.K_s*trv + twomu*theta*(vn.y - trv/3.0) - c*nN.y,',
'    P.K_s*trv + twomu*theta*(vn.z - trv/3.0) - c*nN.z, 0.0);',
'  out_s[i] = vec4<f32>(',
'    P.mu_s*theta*vs.x - c*nS.x,',     /* 2mu*theta*(vs/2) = mu*theta*vs */
'    P.mu_s*theta*vs.y - c*nS.y,',
'    P.mu_s*theta*vs.z - c*nS.z, 0.0);',
'}'
].join('\n');


/* ════════════════════════════════════════════════════════════
   NonlinearKernels — minimal host for the two kernels (Push 1).
   Push 2 absorbs these pipelines into NonlinearSolverFull.
   ════════════════════════════════════════════════════════════ */
function NonlinearKernels(count) {
  this.count = count;
  this.device = WGPU.device;
  if (!this.device) throw new Error('NonlinearKernels: WebGPU device not initialized');
  var d = this.device;
  var BU = GPUBufferUsage;
  var V = 16 * count;   /* vec4<f32> array */
  var R = 4 * count;    /* f32 array */

  this.rmModule = d.createShaderModule({ code: RETURN_MAP_FULL_WGSL });
  this.atModule = d.createShaderModule({ code: APPLY_TANGENT_FULL_WGSL });
  this.rmPipeline = d.createComputePipeline({
    layout: 'auto',
    compute: { module: this.rmModule, entryPoint: 'return_map_full' }
  });
  this.atPipeline = d.createComputePipeline({
    layout: 'auto',
    compute: { module: this.atModule, entryPoint: 'apply_tangent_full' }
  });

  var sb = function () { return d.createBuffer({ size: V, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); };
  var rb = function () { return d.createBuffer({ size: R, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); };
  this.solid = rb();
  this.eps_n = sb(); this.eps_s = sb();
  this.epp_n = sb(); this.epp_s = sb();
  this.sig_n = sb(); this.sig_s = sb();
  this.tan_n = sb(); this.tan_s = sb();
  this.eppo_n = sb(); this.eppo_s = sb();
  this.v_n = sb(); this.v_s = sb();
  this.out_n = sb(); this.out_s = sb();
  this.paramsBuf = d.createBuffer({ size: 64, usage: BU.UNIFORM | BU.COPY_DST });
}

NonlinearKernels.prototype.setParams = function (m) {
  /* m from nlMakeMaterial; void moduli from Es*NL_VOID_CONTRAST */
  var Ev = m.E * NL_VOID_CONTRAST;
  var mu_v = Ev / (2 * (1 + m.nu));
  var lam_v = Ev * m.nu / ((1 + m.nu) * (1 - 2 * m.nu));
  var K_v = lam_v + 2 * mu_v / 3;
  var useVoce = m.voce ? 1 : 0;
  var sigSat = m.voce ? m.voce.sigSat_MPa : 0;
  var delta = m.voce ? m.voce.delta : 0;
  var Hlin = m.voce ? (m.voce.Hlin_MPa || 0) : 0;
  var buf = new ArrayBuffer(64);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf);
  f[0] = m.mu;  f[1] = m.lam; f[2] = m.K;   f[3] = m.sigY0;
  f[4] = mu_v;  f[5] = lam_v; f[6] = K_v;   f[7] = useVoce;
  f[8] = m.H;   f[9] = sigSat; f[10] = delta; f[11] = Hlin;
  u[12] = this.count;
  this.device.queue.writeBuffer(this.paramsBuf, 0, buf);
};

NonlinearKernels.prototype.runReturnMap = function () {
  var d = this.device;
  var bg = d.createBindGroup({
    layout: this.rmPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0,  resource: { buffer: this.solid } },
      { binding: 1,  resource: { buffer: this.eps_n } },
      { binding: 2,  resource: { buffer: this.eps_s } },
      { binding: 3,  resource: { buffer: this.epp_n } },
      { binding: 4,  resource: { buffer: this.epp_s } },
      { binding: 5,  resource: { buffer: this.sig_n } },
      { binding: 6,  resource: { buffer: this.sig_s } },
      { binding: 7,  resource: { buffer: this.tan_n } },
      { binding: 8,  resource: { buffer: this.tan_s } },
      { binding: 9,  resource: { buffer: this.eppo_n } },
      { binding: 10, resource: { buffer: this.eppo_s } },
      { binding: 11, resource: { buffer: this.paramsBuf } }
    ]
  });
  var enc = d.createCommandEncoder();
  var pass = enc.beginComputePass();
  pass.setPipeline(this.rmPipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(this.count / 64), 1, 1);
  pass.end();
  d.queue.submit([enc.finish()]);
};

NonlinearKernels.prototype.runApplyTangent = function () {
  var d = this.device;
  var bg = d.createBindGroup({
    layout: this.atPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: this.solid } },
      { binding: 1, resource: { buffer: this.v_n } },
      { binding: 2, resource: { buffer: this.v_s } },
      { binding: 3, resource: { buffer: this.tan_n } },
      { binding: 4, resource: { buffer: this.tan_s } },
      { binding: 5, resource: { buffer: this.out_n } },
      { binding: 6, resource: { buffer: this.out_s } },
      { binding: 7, resource: { buffer: this.paramsBuf } }
    ]
  });
  var enc = d.createCommandEncoder();
  var pass = enc.beginComputePass();
  pass.setPipeline(this.atPipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(this.count / 64), 1, 1);
  pass.end();
  d.queue.submit([enc.finish()]);
};

/* read a vec4 storage buffer back to a Float32Array(4*count) */
NonlinearKernels.prototype.readV4 = async function (buf) {
  var d = this.device;
  var V = 16 * this.count;
  var rbuf = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(buf, 0, rbuf, 0, V);
  d.queue.submit([enc.finish()]);
  await rbuf.mapAsync(GPUMapMode.READ);
  var out = new Float32Array(rbuf.getMappedRange().slice(0));
  rbuf.unmap(); rbuf.destroy();
  return out;
};

NonlinearKernels.prototype.upload = function (name, arr) {
  this.device.queue.writeBuffer(this[name], 0, arr);
};


/* ════════════════════════════════════════════════════════════
   runNonlinearKernelTest — GPU kernels vs 16f oracle, per voxel.
   Browser console:  await runNonlinearKernelTest()
   ════════════════════════════════════════════════════════════ */
async function runNonlinearKernelTest(mat) {
  if (typeof WGPU === 'undefined') { console.warn('[16g] WGPU missing'); return; }
  if (!WGPU.device) { await ensureDevice(); }
  if (typeof nlReturnMap === 'undefined') { console.warn('[16g] 16f not loaded'); return; }

  var m = nlMakeMaterial(mat || NL_MAT_DEFAULT);

  /* test voxels: [solid, epsVoigt(6), eppTensor(6), alpha] */
  var V = [
    { solid: 0, eps: [0.003, -0.001, 0.0007, 0.0015, -0.0009, 0.0021], epp: [0,0,0,0,0,0], al: 0 },         /* void */
    { solid: 1, eps: [0.0006, 0.0001, -0.0002, 0.0001, 0, 0],          epp: [0,0,0,0,0,0], al: 0 },         /* solid elastic */
    { solid: 1, eps: [0.02, -0.005, 0.003, 0.004, -0.002, 0.006],      epp: [0.001,-0.0003,0,0.0005,0,0.0002], al: 0.0008 }, /* plastic */
    { solid: 1, eps: [0.05, 0.01, -0.02, 0, 0, 0],                     epp: [0.005,-0.002,-0.001,0,0,0], al: 0.004 },        /* plastic, larger */
    { solid: 1, eps: [-0.01, 0.012, 0.002, -0.003, 0.004, -0.001],     epp: [0,0,0,0,0,0], al: 0 },         /* plastic onset */
    { solid: 1, eps: [0.0, 0.0, 0.0, 0.0, 0.0, 0.008],                 epp: [0,0,0,0,0,0], al: 0 }          /* pure shear */
  ];
  var n = V.length;
  var k = new NonlinearKernels(n);
  k.setParams(m);

  /* pack inputs */
  var solid = new Float32Array(n);
  var eps_n = new Float32Array(4*n), eps_s = new Float32Array(4*n);
  var epp_n = new Float32Array(4*n), epp_s = new Float32Array(4*n);
  for (var i = 0; i < n; i++) {
    solid[i] = V[i].solid;
    eps_n[4*i]=V[i].eps[0]; eps_n[4*i+1]=V[i].eps[1]; eps_n[4*i+2]=V[i].eps[2];
    eps_s[4*i]=V[i].eps[3]; eps_s[4*i+1]=V[i].eps[4]; eps_s[4*i+2]=V[i].eps[5];
    epp_n[4*i]=V[i].epp[0]; epp_n[4*i+1]=V[i].epp[1]; epp_n[4*i+2]=V[i].epp[2]; epp_n[4*i+3]=V[i].al;
    epp_s[4*i]=V[i].epp[3]; epp_s[4*i+1]=V[i].epp[4]; epp_s[4*i+2]=V[i].epp[5];
  }
  k.upload('solid', solid);
  k.upload('eps_n', eps_n); k.upload('eps_s', eps_s);
  k.upload('epp_n', epp_n); k.upload('epp_s', epp_s);

  /* GPU return map */
  k.runReturnMap();
  var gSigN = await k.readV4(k.sig_n), gSigS = await k.readV4(k.sig_s);

  /* CPU oracle stress + tangent (C36) per voxel */
  var worstSig = 0, worstTan = 0;
  var C36ref = [];
  for (var v = 0; v < n; v++) {
    var c36 = new Float64Array(36);
    var eppTen = V[v].epp.slice();
    var r;
    if (V[v].solid) {
      r = nlReturnMap(V[v].eps, eppTen, V[v].al, m, c36);
    } else {
      /* void: linear elastic Cv */
      var Cv = isoC(m.E * NL_VOID_CONTRAST, m.nu);
      var sV = [0,0,0,0,0,0];
      for (var P = 0; P < 6; P++){ var s=0; for (var Q=0;Q<6;Q++) s += Cv[P*6+Q]*V[v].eps[Q]; sV[P]=s; }
      r = { sV: sV }; c36 = Cv;
    }
    C36ref.push(c36);
    var gs = [gSigN[4*v], gSigN[4*v+1], gSigN[4*v+2], gSigS[4*v], gSigS[4*v+1], gSigS[4*v+2]];
    for (var p = 0; p < 6; p++) {
      var ref = r.sV[p], scale = Math.max(1, Math.abs(ref));
      var rel = Math.abs(gs[p] - ref) / scale;
      if (rel > worstSig) worstSig = rel;
    }
  }

  /* tangent action: apply C_alg to a few directions, compare to C36ref * v */
  var dirs = [
    [1, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0],
    [0.3, -0.2, 0.5, 0.4, -0.1, 0.25],
    [-0.6, 0.1, 0.2, 0.0, 0.7, -0.3]
  ];
  for (var di = 0; di < dirs.length; di++) {
    var dv = dirs[di];
    var v_n = new Float32Array(4*n), v_s = new Float32Array(4*n);
    for (var j = 0; j < n; j++) {
      v_n[4*j]=dv[0]; v_n[4*j+1]=dv[1]; v_n[4*j+2]=dv[2];
      v_s[4*j]=dv[3]; v_s[4*j+1]=dv[4]; v_s[4*j+2]=dv[5];
    }
    k.upload('v_n', v_n); k.upload('v_s', v_s);
    k.runApplyTangent();
    var oN = await k.readV4(k.out_n), oS = await k.readV4(k.out_s);
    for (var w = 0; w < n; w++) {
      var C = C36ref[w];
      for (var P2 = 0; P2 < 6; P2++) {
        var ref2 = 0; for (var Q2 = 0; Q2 < 6; Q2++) ref2 += C[P2*6+Q2]*dv[Q2];
        var got = (P2 < 3) ? oN[4*w + P2] : oS[4*w + (P2-3)];
        var sc = Math.max(1, Math.abs(ref2));
        var rel2 = Math.abs(got - ref2) / sc;
        if (rel2 > worstTan) worstTan = rel2;
      }
    }
  }

  var TOL = 2e-3;  /* f32 GPU vs f64 oracle */
  var passSig = worstSig < TOL, passTan = worstTan < TOL;
  console.log('[16g] return_map  stress  worst rel = ' + worstSig.toExponential(3) + (passSig ? '  PASS' : '  FAIL'));
  console.log('[16g] apply_tangent C:v   worst rel = ' + worstTan.toExponential(3) + (passTan ? '  PASS' : '  FAIL'));
  console.log('[16g] kernel validation: ' + (passSig && passTan ? 'ALL PASS' : 'FAIL') + '  (tol ' + TOL + ', f32)');
  return { worstSig: worstSig, worstTan: worstTan, pass: passSig && passTan };
}


/* ════════════════════════════════════════════════════════════
   PUSH 2 · NonlinearSolverFull — full GPU solver
   ────────────────────────────────────────────────────────────
   Composes an ElasticSolverFull (es) and reuses its FFT / Green
   operator / CG primitives wholesale. The ONLY change to the
   operator is local_stress -> apply_tangent (frozen per-voxel
   consistent tangent). Adds the Newton equilibrium loop, load
   stepping, and (this push) uniaxial-STRAIN control. The
   uniaxial-stress macro-Newton + warm-start arrive in Push 2b.

   Frame note: es and 16f both work in the un-swapped solver
   frame (SWAP is applied only at solveDesignElasticFull's
   reporting boundary), so GPU vs 16f cross-checks use the same
   axis index directly. Physical-axis (SWAP) mapping is an
   integration concern handled later.

   Validation (browser console):
     await runNonlinearGPUTest(8, 2)
       (a) elastic-limit : Newton(elastic) vs es elastic LC
       (b) plastic       : strain-mode crush vs 16f at N=8
   ════════════════════════════════════════════════════════════ */

var NL_VOID_CONTRAST = 1e-3;   /* default / cap: void stiffness = this * solid.  v0.16.0 — the lab passes a
                                  per-design value (1 % of the design's linear stiffness); 1e-3 inflated ultra-
                                  compliant designs several-fold (pi-TPMS at E/Es ~3e-4: crush E0 166 vs 31.6 MPa) */
var NL_NEWTON_TOL    = 1e-3;   /* f32-appropriate outer tol (inner CG floor ~1e-4) */
var NL_NEWTON_ACCEPT = 5e-3;   /* accept a stalled field solve below this (f32-floor guard) */
var NL_NEWTON_MAX    = 12;   /* cap failed-attempt cost; successful solves use ~3 */
var NL_CG_TOL        = 1e-4;   /* inner ~10x tighter than newtonTol(1e-3); required for Newton to converge (matches 16f) */
var NL_CG_MAX        = 1000;

function NonlinearSolverFull(N, fftPlan) {
  this.N = N;
  this.N3 = N * N * N;
  this.es = new ElasticSolverFull(N, fftPlan);   /* borrow all FFT/Gamma/CG machinery */
  var d = this.es.device;
  this.device = d;
  var BU = GPUBufferUsage;
  var V = this.es.v4Size;
  var sb = function () { return d.createBuffer({ size: V, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); };

  this.rmPipeline = d.createComputePipeline({ layout: 'auto',
    compute: { module: d.createShaderModule({ code: RETURN_MAP_FULL_WGSL }), entryPoint: 'return_map_full' } });
  this.atPipeline = d.createComputePipeline({ layout: 'auto',
    compute: { module: d.createShaderModule({ code: APPLY_TANGENT_FULL_WGSL }), entryPoint: 'apply_tangent_full' } });

  this.tan_n = sb(); this.tan_s = sb();
  this.epp_n = sb(); this.epp_s = sb();     /* committed plastic history (alpha in epp_n.w) */
  this.eppT_n = sb(); this.eppT_s = sb();   /* trial history from current return_map */
  this.deps_n = sb(); this.deps_s = sb();   /* Newton correction (CG solution) */
  this.warmDeps_n = sb(); this.warmDeps_s = sb();   /* retained first-Newton-iter increment for cross-step CG warm-start (zero-init = cold on first solve) */
  this.snap_n = sb(); this.snap_s = sb();   /* strain snapshot for load-step cutback */
  this.snapEpp_n = sb(); this.snapEpp_s = sb(); /* committed-history baseline for macro-Newton */
  this.j2ParamsBuf = d.createBuffer({ size: 64, usage: BU.UNIFORM | BU.COPY_DST });

  this.newtonTol = NL_NEWTON_TOL; this.newtonMax = NL_NEWTON_MAX;
  this.cgTol = NL_CG_TOL; this.cgMax = NL_CG_MAX;
  /* v0.16.0 — per-solve void contrast (upload opts.voidContrast); the lab
     scales it to the design's own linear stiffness (50-controls voidForStiffness). */
  this.voidContrast = NL_VOID_CONTRAST;
  this.acceptRel = NL_NEWTON_ACCEPT;
}

NonlinearSolverFull.prototype.setMaterial = function (m) {
  var Ev = m.E * (this.voidContrast > 0 ? this.voidContrast : NL_VOID_CONTRAST);
  var mu_v = Ev / (2 * (1 + m.nu));
  var lam_v = Ev * m.nu / ((1 + m.nu) * (1 - 2 * m.nu));
  var K_v = lam_v + 2 * mu_v / 3;
  var useVoce = m.voce ? 1 : 0;
  var buf = new ArrayBuffer(64), f = new Float32Array(buf), u = new Uint32Array(buf);
  f[0]=m.mu; f[1]=m.lam; f[2]=m.K; f[3]=m.sigY0;
  f[4]=mu_v; f[5]=lam_v; f[6]=K_v; f[7]=useVoce;
  f[8]=m.H; f[9]=m.voce?m.voce.sigSat_MPa:0; f[10]=m.voce?m.voce.delta:0; f[11]=m.voce?(m.voce.Hlin_MPa||0):0;
  u[12]=this.N3;
  /* Consistent-tangent floor (Newton Jacobian ONLY — never enters the residual,
     so the converged stress and sigma_y are unchanged). Bounds the plastic-front
     stiffness contrast that caps the CG. Override live from the console:
         window.NL_THETA_MIN = 0.1   (then re-run a solve).  0 = exact tangent. */
  var thMin = (typeof window !== 'undefined' && typeof window.NL_THETA_MIN === 'number') ? window.NL_THETA_MIN : 0;
  this._thetaMin = thMin;
  f[13] = thMin;
  this.device.queue.writeBuffer(this.j2ParamsBuf, 0, buf);
};

/* rasterize + Gamma + upload (mirrors solveDesignElasticFull setup) */
NonlinearSolverFull.prototype.upload = function (recipe, opts) {
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args = resolveBuildArgs(recipe);
  var solid = buildVoxels(family, params, args.offset, this.N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  /* Connectivity gate (default-on) — prune floating islands before the crush
     so isolated satellites don't diverge the field Newton. */
  if (opts && opts.pruneLargest && typeof pruneVoxels === 'function') {
    solid = pruneVoxels(solid, this.N, family, opts);
  }
  var inside = 0; for (var v = 0; v < solid.length; v++) inside += solid[v];
  this.rho = inside / solid.length;
  var mat = nlResolveMaterial(recipe.material);   /* 16f: merge over NL_MAT_DEFAULT so plasticity keys (sigY0, Voce) are never dropped */
  var m = nlMakeMaterial(mat);
  this.material = m;
  if (opts && opts.voidContrast > 0) this.voidContrast = opts.voidContrast;
  var C_s = isoC(m.E, m.nu), C_v = isoC(m.E * this.voidContrast, m.nu), C_0 = isoC(m.E, m.nu);
  var Gamma = buildGammaFull(this.N, C_0[21], C_0[1]);
  this.es.uploadDesign(solid, Gamma, C_s, C_v, C_0);
  this.setMaterial(m);
  this.resetHistory();
  /* PERF fast path (see the section at the end of this file): packed
     batched operator + GPU-resident CG.  window.NL_FAST = false -> legacy. */
  this._fastDestroy();
  if (nlFlag('NL_FAST', true)) {
    try { this._fastInit(Gamma); } catch (eF) { console.warn('[16g-fast] init failed -> legacy path', eF); this._fast = null; }
  }
  return this.rho;
};

NonlinearSolverFull.prototype.resetHistory = function () {
  var d = this.device, enc = d.createCommandEncoder();
  this.es._fillPair(enc, { n: this.epp_n, s: this.epp_s }, [0,0,0,0,0,0]);
  this.es._fillPair(enc, { n: this.eppT_n, s: this.eppT_s }, [0,0,0,0,0,0]);
  this.es._fillPair(enc, this.es.eps, [0,0,0,0,0,0]);
  d.queue.submit([enc.finish()]);
};

/* return_map sweep at current es.eps -> es.sig (stress), tan, trial history */
NonlinearSolverFull.prototype._sweepReturnMap = function (enc) {
  var es = this.es, d = es.device;
  var bg = d.createBindGroup({ layout: this.rmPipeline.getBindGroupLayout(0), entries: [
    { binding: 0,  resource: { buffer: es.solidBuf } },
    { binding: 1,  resource: { buffer: es.eps.n } },
    { binding: 2,  resource: { buffer: es.eps.s } },
    { binding: 3,  resource: { buffer: this.epp_n } },
    { binding: 4,  resource: { buffer: this.epp_s } },
    { binding: 5,  resource: { buffer: es.sig.n } },
    { binding: 6,  resource: { buffer: es.sig.s } },
    { binding: 7,  resource: { buffer: this.tan_n } },
    { binding: 8,  resource: { buffer: this.tan_s } },
    { binding: 9,  resource: { buffer: this.eppT_n } },
    { binding: 10, resource: { buffer: this.eppT_s } },
    { binding: 11, resource: { buffer: this.j2ParamsBuf } }
  ]});
  es._dispatchEncoded(enc, this.rmPipeline, bg, es.N3, 64);
};

/* out = epsPair + Gamma:(sigPair - C0:epsPair) — copy of es._applyA steps 2-5 */
NonlinearSolverFull.prototype._gammaApply = function (enc, sigPair, epsPair, out) {
  var es = this.es, d = es.device;
  var tcBg = d.createBindGroup({ layout: es.tcLayout, entries: [
    { binding: 0, resource: { buffer: epsPair.n } },
    { binding: 1, resource: { buffer: epsPair.s } },
    { binding: 2, resource: { buffer: sigPair.n } },
    { binding: 3, resource: { buffer: sigPair.s } },
    { binding: 4, resource: { buffer: es.tau.n } },
    { binding: 5, resource: { buffer: es.tau.s } },
    { binding: 6, resource: { buffer: es.elasticParamsBuf } }
  ]});
  es._dispatchEncoded(enc, es.tcPipeline, tcBg, es.N3, 64);
  for (var Q = 0; Q < 6; Q++) {
    var srcBuf = (Q < 3) ? es.tau.n : es.tau.s;
    var pcBg = d.createBindGroup({ layout: es.pcLayout, entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: es.tauCmplx[Q] } },
      { binding: 2, resource: { buffer: es.laneParamsBufs[Q] } }
    ]});
    es._dispatchEncoded(enc, es.pcPipeline, pcBg, es.N3, 64);
    es.fft.loadFromBuffer(enc, es.tauCmplx[Q]);
    es.fft.forwardEncoded(enc);
    es.fft.storeToBuffer(enc, es.tauHat[Q]);
  }
  enc.copyBufferToBuffer(epsPair.n, 0, out.n, 0, es.v4Size);
  enc.copyBufferToBuffer(epsPair.s, 0, out.s, 0, es.v4Size);
  for (var P = 0; P < 6; P++) {
    var gaWBg = d.createBindGroup({ layout: es.gaLayout, entries: [
      { binding: 0, resource: { buffer: es.tauHat[0] } },
      { binding: 1, resource: { buffer: es.tauHat[1] } },
      { binding: 2, resource: { buffer: es.tauHat[2] } },
      { binding: 3, resource: { buffer: es.gamma[P][0] } },
      { binding: 4, resource: { buffer: es.gamma[P][1] } },
      { binding: 5, resource: { buffer: es.gamma[P][2] } },
      { binding: 6, resource: { buffer: es.depsHat[P] } },
      { binding: 7, resource: { buffer: es.sizeParamsBuf } }
    ]});
    es._dispatchEncoded(enc, es.gaWritePipeline, gaWBg, es.N3, 64);
    var gaABg = d.createBindGroup({ layout: es.gaLayout, entries: [
      { binding: 0, resource: { buffer: es.tauHat[3] } },
      { binding: 1, resource: { buffer: es.tauHat[4] } },
      { binding: 2, resource: { buffer: es.tauHat[5] } },
      { binding: 3, resource: { buffer: es.gamma[P][3] } },
      { binding: 4, resource: { buffer: es.gamma[P][4] } },
      { binding: 5, resource: { buffer: es.gamma[P][5] } },
      { binding: 6, resource: { buffer: es.depsHat[P] } },
      { binding: 7, resource: { buffer: es.sizeParamsBuf } }
    ]});
    es._dispatchEncoded(enc, es.gaAddPipeline, gaABg, es.N3, 64);
    es.fft.loadFromBuffer(enc, es.depsHat[P]);
    es.fft.inverseEncoded(enc);
    es.fft.storeToBuffer(enc, es.depsC[P]);
    var destBuf = (P < 3) ? out.n : out.s;
    var daBg = d.createBindGroup({ layout: es.daLayout, entries: [
      { binding: 0, resource: { buffer: destBuf } },
      { binding: 1, resource: { buffer: es.depsC[P] } },
      { binding: 2, resource: { buffer: es.laneParamsBufs[P] } }
    ]});
    es._dispatchEncoded(enc, es.daPipeline, daBg, es.N3, 64);
  }
};

/* A_nl : v = v + Gamma:(C_alg:v - C0:v), frozen tangent in tan_{n,s} */
NonlinearSolverFull.prototype._applyA_nl = function (enc, vPair, out) {
  var es = this.es, d = es.device;
  var atBg = d.createBindGroup({ layout: this.atPipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: es.solidBuf } },
    { binding: 1, resource: { buffer: vPair.n } },
    { binding: 2, resource: { buffer: vPair.s } },
    { binding: 3, resource: { buffer: this.tan_n } },
    { binding: 4, resource: { buffer: this.tan_s } },
    { binding: 5, resource: { buffer: es.sig.n } },
    { binding: 6, resource: { buffer: es.sig.s } },
    { binding: 7, resource: { buffer: this.j2ParamsBuf } }
  ]});
  es._dispatchEncoded(enc, this.atPipeline, atBg, es.N3, 64);
  this._gammaApply(enc, es.sig, vPair, out);
};

/* Newton solve at prescribed macro strain eps_bar. Warm-starts from es.eps.
   On convergence, commits trial history -> committed. Returns sigma_bar(6). */
NonlinearSolverFull.prototype.newtonSolve = async function (eps_bar) {
  if (this._fast && nlFlag('NL_FAST', true)) return await this._newtonSolveFast(eps_bar);
  var es = this.es, d = es.device;
  var encB = d.createCommandEncoder(); es._fillPair(encB, es.b, eps_bar); d.queue.submit([encB.finish()]);
  var ebNorm = Math.sqrt(await es._dotPair(es.b, es.b)) + 1e-30;
  var converged = false, nit = 0, totalCg = 0, lastRel = Infinity;

  for (var n = 0; n < this.newtonMax; n++) {
    nit = n + 1;
    /* residual R = eps + Gamma:(sigma - C0:eps) - eps_bar  -> es.r */
    var encR = d.createCommandEncoder();
    this._sweepReturnMap(encR);
    this._gammaApply(encR, es.sig, es.eps, es.r);
    es._axpyPair(encR, -1.0, es.b, es.r);
    d.queue.submit([encR.finish()]);
    var rr = await es._dotPair(es.r, es.r);
    lastRel = Math.sqrt(rr) / ebNorm;
    if (lastRel < this.newtonTol) { converged = true; break; }

    /* CG: solve A_nl * deps = R (= es.r); then eps -= deps.
       Warm-start the FIRST Newton iter from the previous step's first-iter
       increment (near-constant per step in the elastic regime); cold-start
       (x0=0) later iters, where the increment shrinks toward zero and a stale
       guess would only add work. Result-preserving: only x0 changes, and the
       relative-tolerance denominator stays ||R|| (the RHS norm). */
    var dpair = { n: this.deps_n, s: this.deps_s };
    var rrcg, bnorm;
    if (n === 0) {
      bnorm = Math.sqrt(await es._dotPair(es.r, es.r)) + 1e-30;   /* ||R|| from the RHS, before warm subtract */
      var encW = d.createCommandEncoder();
      es._copyPair(encW, { n: this.warmDeps_n, s: this.warmDeps_s }, dpair);   /* x0 = warmDeps */
      d.queue.submit([encW.finish()]);
      var encAx = d.createCommandEncoder(); this._applyA_nl(encAx, dpair, es.Ap); d.queue.submit([encAx.finish()]);
      var encR0 = d.createCommandEncoder();
      es._axpyPair(encR0, -1.0, es.Ap, es.r);   /* r0 = R - A*x0 */
      es._copyPair(encR0, es.r, es.p);           /* p0 = r0 */
      d.queue.submit([encR0.finish()]);
      rrcg = await es._dotPair(es.r, es.r);      /* ||r0||^2 */
    } else {
      var encZ = d.createCommandEncoder();
      es._fillPair(encZ, dpair, [0,0,0,0,0,0]);  /* x0 = 0 */
      es._copyPair(encZ, es.r, es.p);            /* p0 = r0 = R */
      d.queue.submit([encZ.finish()]);
      rrcg = await es._dotPair(es.r, es.r);      /* ||R||^2 */
      bnorm = Math.sqrt(rrcg) + 1e-30;
    }

    for (var k = 0; k < this.cgMax; k++) {
      totalCg += 1;
      var encA = d.createCommandEncoder(); this._applyA_nl(encA, es.p, es.Ap); d.queue.submit([encA.finish()]);
      var pAp = await es._dotPair(es.p, es.Ap);
      if (Math.abs(pAp) < 1e-30) break;
      var al = rrcg / pAp;
      var encE = d.createCommandEncoder(); es._axpyPair(encE, al, es.p, dpair); d.queue.submit([encE.finish()]);
      var encRr = d.createCommandEncoder(); es._axpyPair(encRr, -al, es.Ap, es.r); d.queue.submit([encRr.finish()]);
      var rrNew = await es._dotPair(es.r, es.r);
      if (Math.sqrt(rrNew) / bnorm < this.cgTol) break;
      var beta = rrNew / rrcg;
      var encP = d.createCommandEncoder(); es._xbpyPair(encP, beta, es.r, es.p); d.queue.submit([encP.finish()]);
      rrcg = rrNew;
    }
    var encU = d.createCommandEncoder(); es._axpyPair(encU, -1.0, dpair, es.eps); d.queue.submit([encU.finish()]);
    if (n === 0) {   /* retain the first-iter increment to warm-start the next step's first solve */
      var encSv = d.createCommandEncoder();
      es._copyPair(encSv, dpair, { n: this.warmDeps_n, s: this.warmDeps_s });
      d.queue.submit([encSv.finish()]);
    }
  }

  /* final stress + commit history */
  var encF = d.createCommandEncoder(); this._sweepReturnMap(encF); d.queue.submit([encF.finish()]);
  var encC = d.createCommandEncoder();
  es._copyPair(encC, { n: this.eppT_n, s: this.eppT_s }, { n: this.epp_n, s: this.epp_s });
  d.queue.submit([encC.finish()]);

  var sig6 = await es._readbackPair(es.sig);
  var sBar = [0,0,0,0,0,0], N3 = this.N3;
  for (var c = 0; c < 6; c++) { var acc = 0, a = sig6[c]; for (var i = 0; i < N3; i++) acc += a[i]; sBar[c] = acc / N3; }
  if (!converged && lastRel < this.acceptRel) converged = true;   /* f32-floor stall acceptance */
  if (this.stats) { this.stats.newton += nit; this.stats.solves++; this.stats.cg += totalCg; }
  return { sigma_bar: sBar, converged: converged, newtonIters: nit, totalCgIters: totalCg, relRes: lastRel };
};

/* Uniaxial-STRAIN crush along solver-frame axis (0/1/2). Push 2b adds stress. */
NonlinearSolverFull.prototype.crushStrain = async function (axis, opts) {
  opts = opts || {};
  var epsTarget = opts.epsTarget != null ? opts.epsTarget : 0.02;
  var nSteps = opts.nSteps != null ? opts.nSteps : 16;
  var cutbackMax = opts.cutbackMax != null ? opts.cutbackMax : 4;
  var es = this.es, d = es.device;
  this._predictOn = false;   /* strain control: no field predictor (fast path keeps the CG warm start) */
  var capEps = epsTarget, nominalStep = capEps / nSteps, maxSteps = Math.ceil(nSteps * 1.5);
  var curve = [], eAxis = 0, step = 0, E0 = null;
  var eb = [0,0,0,0,0,0];

  while (eAxis < capEps - 1e-9 && step < maxSteps) {
    var dStep = Math.min(nominalStep, capEps - eAxis);   /* nominal stride, clamped to the cap */
    /* snapshot strain for cutback */
    var encS = d.createCommandEncoder(); es._copyPair(encS, es.eps, { n: this.snap_n, s: this.snap_s }); d.queue.submit([encS.finish()]);
    var trial = eAxis + dStep, ok = false, res = null, cut = 0;
    while (cut <= cutbackMax) {
      eb[axis] = trial;
      res = await this.newtonSolve(eb);
      if (res.converged) { ok = true; break; }
      var encR = d.createCommandEncoder(); es._copyPair(encR, { n: this.snap_n, s: this.snap_s }, es.eps); d.queue.submit([encR.finish()]);
      dStep *= 0.5; trial = eAxis + dStep; cut++;
    }
    if (!ok) return { error: 'newton_diverged', rho: this.rho, curve: curve, axis: axis };
    eAxis = trial;
    var sAxis = res.sigma_bar[axis];
    curve.push({ eps: eAxis, sigma: sAxis });
    if (E0 === null && eAxis > 0) E0 = sAxis / eAxis;
    step++;
  }
  var sigmaY = nlOffsetYield(curve, E0, 0.002);
  return { rho: this.rho, axis: axis, control: 'strain', curve: curve, sigma_y_eff: sigmaY, E0: E0, N: this.N };
};

NonlinearSolverFull.prototype.destroy = function () { this._fastDestroy(); this.es.destroy(); };


/* ════════════════════════════════════════════════════════════
   runNonlinearGPUTest — layered validation (browser console)
     await runNonlinearGPUTest(8, 2)
   ════════════════════════════════════════════════════════════ */
async function runNonlinearGPUTest(N, axis) {
  N = N || 8; axis = axis != null ? axis : 2;
  if (!WGPU.device) await ensureDevice();
  if (typeof nonlinearCrushCPU === 'undefined') { console.warn('[16g] 16f not loaded'); return; }
  var recipe = DEMO_RECIPES.schwarzP;

  /* shared FFT plan */
  var fft;
  if (window.__sharedFFT && window.__sharedFFT.N === N) fft = window.__sharedFFT;
  else { if (window.__sharedFFT) window.__sharedFFT.destroy(); fft = new FFTPlan(N); window.__sharedFFT = fft; }

  /* (a) ELASTIC LIMIT — Newton(elastic) vs es elastic LC, same design */
  var matHuge = { Es_MPa: 110000, nu: 0.34, sigY0_MPa: 1e15, H_MPa: 2000, voce: null };
  var rH = JSON.parse(JSON.stringify(recipe)); rH.material = matHuge;
  var solverH = new NonlinearSolverFull(N, fft);
  solverH.upload(rH);
  var eb = [0,0,0,0,0,0]; eb[axis] = 0.001;
  var elastRef = await solverH.es.solveLoadCaseFull(eb, {});   /* borrowed elastic oracle */
  var encZ = solverH.device.createCommandEncoder();
  solverH.es._fillPair(encZ, solverH.es.eps, [0,0,0,0,0,0]); solverH.device.queue.submit([encZ.finish()]);
  var nlElast = await solverH.newtonSolve(eb);
  var worstE = 0;
  for (var p = 0; p < 6; p++) {
    var sc = Math.max(1, Math.abs(elastRef.sigma[p]));
    var rel = Math.abs(nlElast.sigma_bar[p] - elastRef.sigma[p]) / sc;
    if (rel > worstE) worstE = rel;
  }
  var passE = worstE < 5e-3;
  console.log('[16g] elastic-limit  Newton vs es  worst rel = ' + worstE.toExponential(3) + (passE ? '  PASS' : '  FAIL') + '  (Newton iters=' + nlElast.newtonIters + ')');
  solverH.destroy();

  /* (b) PLASTIC strain-mode crush vs 16f at N */
  var solver = new NonlinearSolverFull(N, fft);
  solver.upload(recipe);
  var t0 = performance.now();
  var g = await solver.crushStrain(axis, { epsTarget: 0.02, nSteps: 10 });
  var dt = performance.now() - t0;
  solver.destroy();
  if (g.error) { console.error('[16g] plastic crush: ' + g.error); return g; }

  var c = nonlinearCrushCPU(recipe, N, axis, { control: 'strain', epsTarget: 0.02, nSteps: 10, kneeRefine: false });   /* crushStrain has no knee refinement: keep the step grids identical */
  var relSy = Math.abs(g.sigma_y_eff - c.sigma_y_eff) / Math.max(1, Math.abs(c.sigma_y_eff));
  var relE0 = Math.abs(g.E0 - c.E0) / Math.max(1, Math.abs(c.E0));
  var worstC = 0;
  var nC = Math.min(g.curve.length, c.curve.length);
  for (var i = 0; i < nC; i++) {
    var sc2 = Math.max(1, Math.abs(c.curve[i].sigma));
    var r2 = Math.abs(g.curve[i].sigma - c.curve[i].sigma) / sc2;
    if (r2 > worstC) worstC = r2;
  }
  var passP = relSy < 0.02 && worstC < 0.02;
  console.log('[16g] plastic crush  GPU vs 16f (strain, N=' + N + ', ' + dt.toFixed(0) + ' ms)');
  console.log('       E0:        GPU ' + (g.E0/1000).toFixed(2) + '  16f ' + (c.E0/1000).toFixed(2) + ' GPa   rel ' + relE0.toExponential(2));
  console.log('       sigma_y:   GPU ' + g.sigma_y_eff.toFixed(1) + '  16f ' + c.sigma_y_eff.toFixed(1) + ' MPa   rel ' + relSy.toExponential(2));
  console.log('       curve worst rel = ' + worstC.toExponential(3) + (passP ? '  PASS' : '  FAIL'));
  console.log('[16g] GPU solver validation: ' + (passE && passP ? 'ALL PASS' : 'FAIL'));
  return { elasticLimit: worstE, plasticCurve: worstC, sigmaYrel: relSy, pass: passE && passP, gpu: g, cpu: c };
}

/* ════════════════════════════════════════════════════════════
   PUSH 2b · uniaxial-STRESS macro-Newton + physical-axis mapping
   The unconfined "cube in a press" case: drive one axis, iterate
   the other five macro strains so their averaged stress -> 0,
   using the elastic macro stiffness (computed once via the
   borrowed homogenizeFull) as the fixed macro Jacobian. Committed
   plastic history is held at the previous LOAD STEP value through
   the whole macro loop (restored before each field solve) and
   only advances when the load step is accepted.
   ════════════════════════════════════════════════════════════ */

/* elastic macro stiffness C_eff (solver-internal frame), cached */
NonlinearSolverFull.prototype._ensureElasticMacro = async function () {
  if (this._Cmacro) return this._Cmacro;
  if (this._fast && nlFlag('NL_FAST', true) && nlFlag('NL_FAST_MACRO', true)) return await this._ensureElasticMacroFast();
  var hom = await this.es.homogenizeFull({});
  this._Cmacro = hom.C_eff;        /* Float64Array(36), internal frame */
  this.resetHistory();             /* homogenize dirtied eps/sig — zero state */
  return this._Cmacro;
};

/* Uniaxial-stress crush along solver-frame axis (0/1/2). */
NonlinearSolverFull.prototype.crushStress = async function (axis, opts) {
  opts = opts || {};
  var epsTarget = opts.epsTarget != null ? opts.epsTarget : 0.02;
  var nSteps = opts.nSteps != null ? opts.nSteps : 16;
  var cutbackMax = opts.cutbackMax != null ? opts.cutbackMax : 4;
  var macroTol = opts.macroTol != null ? opts.macroTol : 5e-3;
  var macroMax = opts.macroMax != null ? opts.macroMax : 4;
  var verbose = !!opts.verbose;
  /* (opts.macroRelax was declared here but never applied: the macro update is
     a plain modified-Newton step with the elastic free-free compliance.
     Removed as dead code; the algorithm is unchanged.) */
  var kneeRefine = opts.kneeRefine !== false;   /* default ON: half steps through the 0.2% knee (16f nlKneeStepFactor) */
  var es = this.es, d = es.device;

  var _nlNow = (typeof performance !== 'undefined') ? function(){ return performance.now(); } : function(){ return Date.now(); };
  var _nlSetup0 = _nlNow();
  var C = await this._ensureElasticMacro();
  var _nlRun0 = _nlNow(), _nlPrev = _nlRun0, _nlCgTotal = 0;
  console.log('[crush-timing] N=' + this.N + ' axis=' + axis + '  thetaMin=' + (this._thetaMin != null ? this._thetaMin : 0) + '  elastic-macro setup ' + (_nlRun0 - _nlSetup0).toFixed(0) + ' ms');
  var freeIdx = []; for (var i = 0; i < 6; i++) if (i !== axis) freeIdx.push(i);
  var nf = freeIdx.length;
  var Kff = new Float64Array(nf * nf);
  for (var a = 0; a < nf; a++) for (var b = 0; b < nf; b++) Kff[a * nf + b] = C[freeIdx[a] * 6 + freeIdx[b]];
  var Sff = invertSmall(Kff, nf);
  var Cfa = new Float64Array(nf);
  for (var ci = 0; ci < nf; ci++) Cfa[ci] = C[freeIdx[ci] * 6 + axis];
  var S6 = invert6x6(C);
  var E0 = S6 ? 1 / S6[axis * 6 + axis] : null;

  var capEps = epsTarget;                 /* user strain cap; adaptive crush stops here */
  var nominalStep = capEps / nSteps;      /* reset each step so a cutback never permanently shrinks the march */
  var curve = [], eAxis = 0, step = 0;
  /* Phase-6 tie-up #5 — per-accepted-step plastic-strain (alpha) capture for the
     Nonlinear-tab progression scrubber.  Read straight from the committed history
     (epp_n) right after each step commits, before the next step's snapshot. */
  var alphaSteps = [], alphaMax = 0;
  var maxSteps = Math.ceil(nSteps * 1.5);  /* guard: dStep recovers each step, so a tight cap suffices */
  if (kneeRefine) maxSteps += NL_KNEE_REFINE_TAIL + 2 * NL_KNEE_LOOKAHEAD;   /* the refined knee window gets its own budget */
  var kneeStep = -1;                      /* step at which the 0.2%-offset knee first appears */
  var lateralResMax = 0;                  /* worst accepted |sigma_lateral| / |sigma_axial| (macro-tol misses are accepted) */
  var eb = [0, 0, 0, 0, 0, 0];
  var ebFreePrev = null, eAxisPrev = 0;
  /* PERF: per-crush counters (all solves, incl. failed attempts and
     non-final macro iterations) + optional per-solve trace. */
  this.stats = { solves: 0, newton: 0, cg: 0, cgCap: 0, cgSolves: 0, readbacks: 0, failedAttempts: 0 };
  this._cgMark = 0; this._solveMark = 0;
  this._trace = nlFlag('NL_TRACE', false) ? [] : null; this.trace = this._trace;
  /* PERF (NL_PREDICT, fast path only): affine predictor for the total-strain
     field and the lateral macro strains from the last two converged steps.
     The field one step back (pp) starts as the zero field at eAxis = 0. */
  this._predictOn = !!(this._fast && nlFlag('NL_FAST', true) && nlFlag('NL_PREDICT', true));
  var ebFreePP = null, eAxisPP = 0;
  if (this._predictOn) {
    var encPP = d.createCommandEncoder();
    encPP.clearBuffer(this._fast.pp.n); encPP.clearBuffer(this._fast.pp.s);
    d.queue.submit([encPP.finish()]);
  }

  while (eAxis < capEps - 1e-9 && step < maxSteps) {
    var dNom = nominalStep;
    if (kneeRefine) dNom *= nlKneeStepFactor(curve, E0, 0.002, nominalStep, step, kneeStep);
    var dStep = Math.min(dNom, capEps - eAxis);   /* nominal (or knee-refined) stride, clamped to land exactly on the cap */
    /* snapshot strain + committed history for cutback and macro-loop baseline */
    var encS = d.createCommandEncoder();
    es._copyPair(encS, es.eps, { n: this.snap_n, s: this.snap_s });
    es._copyPair(encS, { n: this.epp_n, s: this.epp_s }, { n: this.snapEpp_n, s: this.snapEpp_s });
    d.queue.submit([encS.finish()]);

    var trial = eAxis + dStep, ok = false, res = null, cut = 0;
    while (cut <= cutbackMax) {
      eb[axis] = trial;
      /* Seed the free lateral strains. First step (cold): elastic predictor, so
         mit=0 already starts near the free-surface answer and the macro loop
         makes no large confined->free jump (that jump diverges the f32 field
         Newton at N>=16). Later steps: linear extrapolation of the previous
         converged lateral strains, which stays physical in deep plasticity
         (a pure elastic predictor does not, and blows up late). */
      if (step === 0 || ebFreePrev === null) {
        for (var ps = 0; ps < nf; ps++) {
          var pred = 0; for (var pc = 0; pc < nf; pc++) pred += Sff[ps * nf + pc] * Cfa[pc];
          eb[freeIdx[ps]] = -pred * trial;
        }
      } else if (this._predictOn && ebFreePP !== null && eAxisPrev > eAxisPP) {
        var fr = (trial - eAxisPrev) / (eAxisPrev - eAxisPP);   /* affine; = the proportional rule when PP is the origin */
        for (var ea = 0; ea < nf; ea++) eb[freeIdx[ea]] = ebFreePrev[ea] + (ebFreePrev[ea] - ebFreePP[ea]) * fr;
      } else {
        var esc = trial / eAxisPrev;
        for (var ex = 0; ex < nf; ex++) eb[freeIdx[ex]] = ebFreePrev[ex] * esc;
      }
      /* field predictor from the last two converged fields (snap = this step's start) */
      if (this._predictOn && step > 0 && eAxis > eAxisPP) this._fPredict((trial - eAxis) / (eAxis - eAxisPP));
      var fieldDiverged = false, latRel = 0;
      for (var mit = 0; mit < macroMax; mit++) {
        /* hold committed history at the previous load step through the macro loop */
        var encB = d.createCommandEncoder();
        es._copyPair(encB, { n: this.snapEpp_n, s: this.snapEpp_s }, { n: this.epp_n, s: this.epp_s });
        d.queue.submit([encB.finish()]);
        res = await this.newtonSolve(eb);
        if (!res.converged) { fieldDiverged = true; break; }
        var sn = 0, sref = Math.max(Math.abs(res.sigma_bar[axis]), 1e-6);
        for (var f = 0; f < nf; f++) { var sv = res.sigma_bar[freeIdx[f]]; sn += sv * sv; }
        latRel = Math.sqrt(sn) / sref;
        if (latRel < macroTol) break;   /* lateral stress ~ 0: macro converged */
        for (var r = 0; r < nf; r++) {
          var dd = 0; for (var c = 0; c < nf; c++) dd += Sff[r * nf + c] * res.sigma_bar[freeIdx[c]];
          eb[freeIdx[r]] -= dd;
        }
      }
      /* Accept whenever the FIELD Newton converged. A macro-tolerance miss is
         benign (lateral stress is already small; f32 + low axial stress can keep
         it above a tight relative tol). Cut back ONLY on field divergence —
         matches the 16f oracle. The residual is recorded (lateralResMax). */
      if (!fieldDiverged) { ok = true; break; }
      var encR = d.createCommandEncoder();
      es._copyPair(encR, { n: this.snap_n, s: this.snap_s }, es.eps);
      es._copyPair(encR, { n: this.snapEpp_n, s: this.snapEpp_s }, { n: this.epp_n, s: this.epp_s });
      d.queue.submit([encR.finish()]);
      this.stats.failedAttempts++;
      if (verbose) console.log('  [cutback] attempt ' + cut + ' failed; dStep ' + dStep.toFixed(6) + ' -> ' + (dStep * 0.5).toFixed(6));
      dStep *= 0.5; trial = eAxis + dStep; cut++;
    }
    if (!ok) {
      console.warn('[crush] field Newton diverged @ step ' + (step + 1) + ' eAxis=' + eAxis.toFixed(5) + ' trial=' + trial.toFixed(5) +
                   ' relRes=' + (res ? res.relRes.toExponential(2) : 'n/a') + ' newt=' + (res ? res.newtonIters : 0) + ' cg=' + (res ? res.totalCgIters : 0));
      /* salvage: if the curve already passed the 0.2% offset knee, the yield is
         determined — return it rather than discarding a usable result. */
      var ySalv = nlOffsetYieldEx(curve, E0, 0.002);
      if (ySalv.yielded && curve.length >= 2) {
        console.warn('[crush] salvaged sigma_y_eff=' + ySalv.sigma.toFixed(1) + ' MPa from ' + curve.length + ' steps (truncated at eps=' + eAxis.toFixed(4) + ')');
        return { rho: this.rho, axis: axis, control: 'stress', curve: curve, sigma_y_eff: ySalv.sigma, yielded: true, E0: E0, N: this.N, truncated: true, truncReason: 'diverged', atStep: step + 1, eAxisMax: eAxis, epsCap: capEps, alphaSteps: alphaSteps, alphaMax: alphaMax, lateralResMax: lateralResMax };
      }
      return { error: 'newton_diverged', rho: this.rho, curve: curve, axis: axis, atStep: step + 1, eAxis: eAxis, lastRelRes: res ? res.relRes : null };
    }
    if (this._predictOn) {   /* shift the predictor history: pp <- field at this step's start */
      var encH = d.createCommandEncoder();
      es._copyPair(encH, { n: this.snap_n, s: this.snap_s }, this._fast.pp);
      d.queue.submit([encH.finish()]);
    }
    ebFreePP = ebFreePrev ? ebFreePrev : freeIdx.map(function () { return 0; });
    eAxisPP = eAxisPrev;           /* == this step's start strain */
    eAxis = trial;
    curve.push({ eps: eAxis, sigma: res.sigma_bar[axis] });
    if (latRel > lateralResMax) lateralResMax = latRel;
    ebFreePrev = freeIdx.map(function (fi) { return eb[fi]; });
    eAxisPrev = eAxis;
    var _nlTstep = _nlNow(); _nlCgTotal += res.totalCgIters;
    /* cgAll/solves: every CG iteration / field solve this step, incl. failed attempts and earlier macro iterations */
    var _nlCgAll = this.stats.cg - (this._cgMark || 0), _nlSolves = this.stats.solves - (this._solveMark || 0);
    this._cgMark = this.stats.cg; this._solveMark = this.stats.solves;
    console.log('[crush-timing] step ' + (step + 1) + '  t=' + (_nlTstep - _nlPrev).toFixed(0) + 'ms' +
                '  cg=' + res.totalCgIters + '  cgAll=' + _nlCgAll + '  solves=' + _nlSolves + '  newt=' + res.newtonIters + '  macro=' + (mit + 1) + '  cut=' + cut +
                '  eps=' + (eAxis * 100).toFixed(2) + '%  sig=' + res.sigma_bar[axis].toFixed(1) + 'MPa  relRes=' + res.relRes.toExponential(2));
    _nlPrev = _nlTstep;
    if (verbose) console.log('[crush] step ' + (step + 1) + '/' + nSteps + '  eps=' + eAxis.toFixed(5) + '  sig=' + res.sigma_bar[axis].toFixed(1) +
                             ' MPa  macro=' + (mit + 1) + '  newt=' + res.newtonIters + '  cg=' + res.totalCgIters + '  relRes=' + res.relRes.toExponential(2));
    step++;
    if (opts.onStep) opts.onStep(step, eAxis, res.sigma_bar[axis]);
    if (opts.captureAlpha){
      var aF = await this.readAlphaField();         /* Float32Array(N^3), i*N^2+j*N+k order */
      for (var ai = 0; ai < aF.length; ai++){ if (aF[ai] > alphaMax) alphaMax = aF[ai]; }
      alphaSteps.push({ eps: eAxis, alpha: aF });
    }
    /* adaptive early-stop: once the 0.2%-offset knee appears, take 3 more steps
       (NL_KNEE_REFINE_TAIL half steps when knee refinement is on — same strain
       extent) to draw cleanly past it, then stop — no need to grind to the cap. */
    if (kneeStep < 0 && nlOffsetYieldEx(curve, E0, 0.002).yielded) kneeStep = step;
    if (kneeStep >= 0 && step >= kneeStep + (kneeRefine ? NL_KNEE_REFINE_TAIL : 3)) break;
  }
  /* Step-budget truncation: cutbacks exhausted maxSteps before the curve
     reached the cap (and no knee early-stop fired). Without this flag the UI
     reported "no yield (> sigma_cap)" at a strain that never reached the cap. */
  var budgetHit = (kneeStep < 0) && (eAxis < capEps - 1e-9);
  if (budgetHit) console.warn('[crush] step budget (' + maxSteps + ') exhausted at eps=' + (eAxis * 100).toFixed(2) + '% < cap ' + (capEps * 100).toFixed(0) + '% (cutbacks)');
  if (lateralResMax > 0.02) console.warn('[crush] macro lateral stress residual up to ' + (lateralResMax * 100).toFixed(1) + '% of axial (steps accepted on field convergence)');
  console.log('[crush-timing] DONE N=' + this.N + '  steps=' + step + '  total=' + (_nlNow() - _nlRun0).toFixed(0) + 'ms  (' +
              ((_nlNow() - _nlRun0) / Math.max(1, step)).toFixed(0) + ' ms/step avg)  cg(sum of accepted-solve iters)=' + _nlCgTotal);
  var yEx = nlOffsetYieldEx(curve, E0, 0.002);
  return { rho: this.rho, axis: axis, control: 'stress', curve: curve, sigma_y_eff: yEx.sigma, yielded: yEx.yielded, E0: E0, N: this.N, epsCap: capEps, eAxisMax: eAxis, alphaSteps: alphaSteps, alphaMax: alphaMax,
           truncated: budgetHit, truncReason: budgetHit ? 'step-budget' : null, lateralResMax: lateralResMax };
};


/* Public crush entry — physical axis (0=xx,1=yy,2=zz).  Since v0.7.2 the
   solver frame is the physical frame (see the SWAP note in 16b
   solveDesignElasticFull), so the axis passes straight through.  Before the
   fix, selecting ZZ crushed along physical X. */
NonlinearSolverFull.prototype.crush = async function (physicalAxis, opts) {
  opts = opts || {};
  var axInternal = physicalAxis;
  if ((opts.control || 'stress') === 'strain') return await this.crushStrain(axInternal, opts);
  return await this.crushStress(axInternal, opts);
};

/* Equivalent-plastic-strain field (alpha) for the viz, in i*N²+j*N+k order. */
NonlinearSolverFull.prototype.readAlphaField = async function () {
  var es = this.es, d = es.device, V = es.v4Size;
  var rb = d.createBuffer({ size: V, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder(); enc.copyBufferToBuffer(this.epp_n, 0, rb, 0, V); d.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  var arr = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
  var N3 = this.N3, out = new Float32Array(N3);
  for (var i = 0; i < N3; i++) out[i] = arr[4 * i + 3];   /* alpha in .w */
  return out;
};


/* ════════════════════════════════════════════════════════════
   runNonlinearStressTest — uniaxial-STRESS GPU vs 16f at N
     await runNonlinearStressTest(8)
   The 16f CPU stress path is slow (macro-Newton on CPU) — expect
   the tab to chug a couple minutes at N=8. GPU half is fast.
   ════════════════════════════════════════════════════════════ */
async function runNonlinearStressTest(N) {
  N = N || 8;
  if (!WGPU.device) await ensureDevice();
  if (typeof nonlinearCrushCPU === 'undefined') { console.warn('[16g] 16f not loaded'); return; }
  var recipe = DEMO_RECIPES.schwarzP;
  var axInternal = 2;   /* compare same internal axis on both sides */

  var fft;
  if (window.__sharedFFT && window.__sharedFFT.N === N) fft = window.__sharedFFT;
  else { if (window.__sharedFFT) window.__sharedFFT.destroy(); fft = new FFTPlan(N); window.__sharedFFT = fft; }

  var solver = new NonlinearSolverFull(N, fft);
  solver.upload(recipe);
  var t0 = performance.now();
  var g = await solver.crushStress(axInternal, { epsTarget: 0.02, nSteps: 10 });
  var dtG = performance.now() - t0;
  solver.destroy();
  if (g.error) { console.error('[16g] stress crush: ' + g.error); return g; }
  console.log('[16g] stress crush GPU done (' + dtG.toFixed(0) + ' ms) — running 16f CPU stress (slow)...');

  var c = nonlinearCrushCPU(recipe, N, axInternal, { control: 'stress', epsTarget: 0.02, nSteps: 10 });
  var relSy = Math.abs(g.sigma_y_eff - c.sigma_y_eff) / Math.max(1, Math.abs(c.sigma_y_eff));
  var relE0 = Math.abs(g.E0 - c.E0) / Math.max(1, Math.abs(c.E0));
  var worstC = 0, nC = Math.min(g.curve.length, c.curve.length);
  for (var i = 0; i < nC; i++) {
    /* both sides knee-refine with the same predictor, but f32 vs f64 can flip a
       marginal half-step decision; compare only points on the same strain grid. */
    if (Math.abs(g.curve[i].eps - c.curve[i].eps) > 1e-7) break;
    var sc = Math.max(1, Math.abs(c.curve[i].sigma));
    var r = Math.abs(g.curve[i].sigma - c.curve[i].sigma) / sc;
    if (r > worstC) worstC = r;
  }
  var pass = relSy < 0.02 && worstC < 0.05;   /* stress-mode: macro-Newton tol looser */
  console.log('[16g] stress crush  GPU vs 16f (N=' + N + ')');
  console.log('       E0:       GPU ' + (g.E0/1000).toFixed(2) + '  16f ' + (c.E0/1000).toFixed(2) + ' GPa   rel ' + relE0.toExponential(2));
  console.log('       sigma_y:  GPU ' + g.sigma_y_eff.toFixed(1) + '  16f ' + c.sigma_y_eff.toFixed(1) + ' MPa   rel ' + relSy.toExponential(2));
  console.log('       curve worst rel = ' + worstC.toExponential(3) + (pass ? '  PASS' : '  FAIL'));
  return { sigmaYrel: relSy, curveWorst: worstC, pass: pass, gpu: g, cpu: c };
}


/* ════════════════════════════════════════════════════════════
   PERF · GPU-resident fast path for the nonlinear crush
   ────────────────────────────────────────────────────────────
   Why: the legacy Newton/CG loop above is sync-bound, not
   FLOP-bound.  Per CG iteration it does ~6 queue submits, 2
   blocking mapAsync dot readbacks, ~34 createBindGroup calls and
   12 unbatched N^3 FFTs (+24 buffer copies), so the GPU idles
   between tiny command buffers (owner: ~35% util vs 85% elastic).

   What changes (math is the same operator and the same CG):
     1. Operator A_nl = I + Gamma:(C_alg - C0) in 5 fused passes:
          pack_at  : tau = C_alg:v - C0:v, packed two-real-per-complex
          FFT      : ONE batched (batch=3) forward transform
          gamma_pk : Gamma(k):tau_hat on the packed spectra (in place)
          IFFT     : ONE batched (batch=3) inverse transform
          deacc_pk : out = v + Re/Im of the packed result
        Packing is exact because Gamma(k) is real, even and
        symmetric (checked on the CPU at upload; else legacy
        path): FFT(a + i b) carries both real fields, and
        Gamma*a, Gamma*b stay real.  12 FFTs -> 2 half-size-batch
        transforms of 3 slots = half the FFT data, 0 copies.
     2. CG scalars (alpha, beta, rr, pAp, converged flag, iteration
        count) live in a small GPU storage buffer; axpy kernels read
        their coefficient from it.  One command buffer per BLOCK of
        iterations, one 32-float readback per block (block grows
        1,2,..16 so a 1-iteration warm-started solve is not
        over-run).  After convergence the flag zeroes alpha/beta, so
        the rest of a block is a harmless no-op.
     3. Every bind group is created once per solver and reused.
     4. Algorithmic fixes (flags, default ON):
          NL_MEANFIX  mean-exact start: eps += eps_bar - <eps> before each
                      field solve.  ROOT CAUSE of the slow/erratic CG:
                      A_nl keeps the mean (<A x> = <x>) but feeds it into
                      the fluctuation, so the Newton residual after a
                      macro-strain change (uniform part) puts CG on a
                      non-symmetric block — 400-1100 iterations, cap hits,
                      at times divergence.  Zero-mean residuals: ~10-100.
          NL_EW       inexact Newton: CG tol per Newton iteration
                      = max(cgTol, min(0.1, NL_EW_ETA(0.1)*newtonTol/relRes))
                      (the CG only has to beat the Newton target, not
                      1e-4 of every residual).  A stalled/growing Newton
                      iteration re-solves 10x tighter (NL_EW_TIGHT);
                      the 3rd strike stops the attempt (accept below
                      acceptRel, as the legacy loop did after 12
                      iterations; else fail fast -> cutback).
          NL_PREDICT  total-strain field predictor
                      eps0 = eps_n + (eps_n - eps_{n-1})*dStep/dPrev
                      and the same affine extrapolation for the lateral
                      macro strains; CG x0 = 0 then.  Linear-regime steps
                      converge with zero CG iterations.
     5. NL_FAST_MACRO: the elastic macro stiffness (6 load cases, used
        for E0 and the lateral macro-Newton) runs on this fast solver
        instead of the legacy es.homogenizeFull (same CG iteration count,
        ~9x fewer submits, ~4x fewer readbacks; C within 0.07%).
     Flags (window.*, read per solve/crush):  NL_FAST=false -> legacy
     path (read at upload too);  NL_MEANFIX / NL_EW / NL_PREDICT /
     NL_FAST_MACRO = false -> that fix off;  NL_CHECK_MAX (16) max CG
     block between readbacks;
     NL_TRACE=true -> per-solve trace (solver.trace + [nl-trace] log);
     NL_DIAG_TRUE=true -> also measure each CG's TRUE residual
     ||R - A x|| / ||R|| (one extra operator apply per CG).
     Validation:  await runNonlinearFastOpTest(16)  (packed operator vs
     legacy), then the usual runNonlinearGPUTest / runNonlinearStressTest.
   ════════════════════════════════════════════════════════════ */

function nlFlag(name, dflt) {
  if (typeof window !== 'undefined' && window[name] !== undefined && window[name] !== null) return window[name];
  return dflt;
}

/* scalar-buffer slots (f32) */
var NLS_RR = 0, NLS_PAP = 1, NLS_AL = 2, NLS_NAL = 3, NLS_RRN = 4, NLS_BETA = 5,
    NLS_DONE = 6, NLS_IT = 7, NLS_THR = 8, NLS_TOL2 = 9, NLS_B2 = 10, NLS_M1 = 11,
    NLS_C1 = 13, NLS_C2 = 14, NLS_RES = 15, NLS_TRUE = 16, NLS_COUNT = 32;

/* v -> tau = C_alg:v - C0:v, written as 3 packed complex slots:
   z0 = (xx, yy), z1 = (zz, yz), z2 = (xz, xy)   [Voigt, eng. shear] */
var NL_PACK_AT_WGSL = J2_PARAMS_WGSL + ELASTIC_PARAMS_FULL_WGSL + [
'@group(0) @binding(0) var<storage, read>       solid: array<f32>;',
'@group(0) @binding(1) var<storage, read>       v_n:   array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read>       v_s:   array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read>       tan_n: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read>       tan_s: array<vec4<f32>>;',
'@group(0) @binding(5) var<storage, read_write> spec:  array<vec2<f32>>;',
'@group(0) @binding(6) var<uniform>             P: J2Params;',
'@group(0) @binding(7) var<uniform>             E: ElasticParamsFull;',
'@compute @workgroup_size(64)',
'fn nl_pack_at(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let i = gid.x;',
'  if (i >= P.total) { return; }',
'  let vn = v_n[i].xyz;',
'  let vs = v_s[i].xyz;',
'  let trv = vn.x + vn.y + vn.z;',
'  var on: vec3<f32>;',
'  var os: vec3<f32>;',
'  if (!(solid[i] > 0.5)) {',        /* same math as apply_tangent_full */
'    on = vec3<f32>(P.lam_v*trv + 2.0*P.mu_v*vn.x, P.lam_v*trv + 2.0*P.mu_v*vn.y, P.lam_v*trv + 2.0*P.mu_v*vn.z);',
'    os = vec3<f32>(P.mu_v*vs.x, P.mu_v*vs.y, P.mu_v*vs.z);',
'  } else {',
'    let nN = tan_n[i].xyz; let theta    = tan_n[i].w;',
'    let nS = tan_s[i].xyz; let thetabar = tan_s[i].w;',
'    let twomu = 2.0*P.mu_s;',
'    let c = twomu * thetabar * (dot(nN, vn) + dot(nS, vs));',
'    on = vec3<f32>(P.K_s*trv + twomu*theta*(vn.x - trv/3.0) - c*nN.x,',
'                   P.K_s*trv + twomu*theta*(vn.y - trv/3.0) - c*nN.y,',
'                   P.K_s*trv + twomu*theta*(vn.z - trv/3.0) - c*nN.z);',
'    os = vec3<f32>(P.mu_s*theta*vs.x - c*nS.x, P.mu_s*theta*vs.y - c*nS.y, P.mu_s*theta*vs.z - c*nS.z);',
'  }',
'  let tn = on - vec3<f32>(dot(E.C0_r0n.xyz, vn) + dot(E.C0_r0s.xyz, vs),',
'                          dot(E.C0_r1n.xyz, vn) + dot(E.C0_r1s.xyz, vs),',
'                          dot(E.C0_r2n.xyz, vn) + dot(E.C0_r2s.xyz, vs));',
'  let ts = os - vec3<f32>(dot(E.C0_r3n.xyz, vn) + dot(E.C0_r3s.xyz, vs),',
'                          dot(E.C0_r4n.xyz, vn) + dot(E.C0_r4s.xyz, vs),',
'                          dot(E.C0_r5n.xyz, vn) + dot(E.C0_r5s.xyz, vs));',
'  spec[i]               = vec2<f32>(tn.x, tn.y);',
'  spec[i + P.total]     = vec2<f32>(tn.z, ts.x);',
'  spec[i + 2u*P.total]  = vec2<f32>(ts.y, ts.z);',
'}'
].join('\n');

/* residual input: tau = sig - C0:eps, same packing */
var NL_PACK_TAU_WGSL = ELASTIC_PARAMS_FULL_WGSL + [
'@group(0) @binding(0) var<storage, read>       eps_n: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read>       eps_s: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read>       sig_n: array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read>       sig_s: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read_write> spec:  array<vec2<f32>>;',
'@group(0) @binding(5) var<uniform>             E: ElasticParamsFull;',
'@compute @workgroup_size(64)',
'fn nl_pack_tau(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let i = gid.x;',
'  if (i >= E.total) { return; }',
'  let en = eps_n[i].xyz; let es = eps_s[i].xyz;',
'  let tn = sig_n[i].xyz - vec3<f32>(dot(E.C0_r0n.xyz, en) + dot(E.C0_r0s.xyz, es),',
'                                    dot(E.C0_r1n.xyz, en) + dot(E.C0_r1s.xyz, es),',
'                                    dot(E.C0_r2n.xyz, en) + dot(E.C0_r2s.xyz, es));',
'  let ts = sig_s[i].xyz - vec3<f32>(dot(E.C0_r3n.xyz, en) + dot(E.C0_r3s.xyz, es),',
'                                    dot(E.C0_r4n.xyz, en) + dot(E.C0_r4s.xyz, es),',
'                                    dot(E.C0_r5n.xyz, en) + dot(E.C0_r5s.xyz, es));',
'  spec[i]               = vec2<f32>(tn.x, tn.y);',
'  spec[i + E.total]     = vec2<f32>(tn.z, ts.x);',
'  spec[i + 2u*E.total]  = vec2<f32>(ts.y, ts.z);',
'}'
].join('\n');

/* Gamma:tau_hat on the packed spectra.  One thread owns the mode pair
   {k, -k} (reads Z(k), Z(-k), writes W(k), W(-k)), so the in-place
   variant is race-free.  Unpack:  T_2b(k) = (Z_b(k) + conj Z_b(-k))/2,
   T_2b+1(k) = (Z_b(k) - conj Z_b(-k))/(2i),  T(-k) = conj T(k).
   D_P = sum_Q Gamma_PQ T_Q;  repack W_a = D_2a + i D_2a+1.
   Gamma is stored symmetric-packed: 21 real N^3 planes. */
function nlGammaSymIdx(P, Q) { if (P > Q) { var t = P; P = Q; Q = t; } return 6 * P - (P * (P - 1)) / 2 + (Q - P); }
function nlGammaPkWGSL(inPlace) {
  var L = [];
  L.push('struct GP { total: u32, n: u32, _p0: u32, _p1: u32 }');
  L.push('@group(0) @binding(0) var<storage, read>       G: array<f32>;');
  if (inPlace) {
    L.push('@group(0) @binding(1) var<storage, read_write> S: array<vec2<f32>>;');
    L.push('@group(0) @binding(2) var<uniform>             U: GP;');
  } else {
    L.push('@group(0) @binding(1) var<storage, read>       S:  array<vec2<f32>>;');
    L.push('@group(0) @binding(2) var<storage, read_write> SO: array<vec2<f32>>;');
    L.push('@group(0) @binding(3) var<uniform>             U: GP;');
  }
  var OUT = inPlace ? 'S' : 'SO';
  L.push('fn ue(zl: vec2<f32>, zm: vec2<f32>) -> vec2<f32> { return 0.5 * vec2<f32>(zl.x + zm.x, zl.y - zm.y); }');
  L.push('fn uo(zl: vec2<f32>, zm: vec2<f32>) -> vec2<f32> { return 0.5 * vec2<f32>(zl.y + zm.y, zm.x - zl.x); }');
  L.push('fn cj(z: vec2<f32>) -> vec2<f32> { return vec2<f32>(z.x, -z.y); }');
  L.push('fn pk(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return vec2<f32>(a.x - b.y, a.y + b.x); }');
  L.push('@compute @workgroup_size(64)');
  L.push('fn nl_gamma_pk(@builtin(global_invocation_id) gid: vec3<u32>) {');
  L.push('  let k = gid.x;');
  L.push('  let T = U.total;');
  L.push('  if (k >= T) { return; }');
  L.push('  let n = U.n;');
  L.push('  let x = k % n; let y = (k / n) % n; let z = k / (n * n);');
  L.push('  let m = ((n - x) % n) + n * (((n - y) % n) + n * ((n - z) % n));');
  L.push('  if (m < k) { return; }');
  L.push('  let zl0 = S[k]; let zl1 = S[k + T]; let zl2 = S[k + 2u*T];');
  L.push('  let zm0 = S[m]; let zm1 = S[m + T]; let zm2 = S[m + 2u*T];');
  L.push('  let t0 = ue(zl0, zm0); let t1 = uo(zl0, zm0);');
  L.push('  let t2 = ue(zl1, zm1); let t3 = uo(zl1, zm1);');
  L.push('  let t4 = ue(zl2, zm2); let t5 = uo(zl2, zm2);');
  for (var P = 0; P < 6; P++) {
    var sk = [], sm = [];
    for (var Q = 0; Q < 6; Q++) {
      var s = nlGammaSymIdx(P, Q);
      sk.push('G[' + s + 'u*T + k] * t' + Q);
      sm.push('G[' + s + 'u*T + m] * cj(t' + Q + ')');
    }
    L.push('  let dk' + P + ' = ' + sk.join(' + ') + ';');
    L.push('  let dm' + P + ' = ' + sm.join(' + ') + ';');
  }
  L.push('  ' + OUT + '[k] = pk(dk0, dk1); ' + OUT + '[k + T] = pk(dk2, dk3); ' + OUT + '[k + 2u*T] = pk(dk4, dk5);');
  L.push('  if (m != k) {');
  L.push('    ' + OUT + '[m] = pk(dm0, dm1); ' + OUT + '[m + T] = pk(dm2, dm3); ' + OUT + '[m + 2u*T] = pk(dm4, dm5);');
  L.push('  }');
  L.push('}');
  return L.join('\n');
}

/* out = v + unpacked real fields (IFFT of W_a = d_2a + i d_2a+1) */
var NL_DEACC_PK_WGSL = [
'struct SZ { total: u32, _p0: u32, _p1: u32, _p2: u32 }',
'@group(0) @binding(0) var<storage, read>       W:     array<vec2<f32>>;',
'@group(0) @binding(1) var<storage, read>       in_n:  array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read>       in_s:  array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read_write> out_n: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read_write> out_s: array<vec4<f32>>;',
'@group(0) @binding(5) var<uniform>             U: SZ;',
'@compute @workgroup_size(64)',
'fn nl_deacc_pk(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let i = gid.x; let T = U.total;',
'  if (i >= T) { return; }',
'  let w0 = W[i]; let w1 = W[i + T]; let w2 = W[i + 2u*T];',
'  out_n[i] = vec4<f32>(in_n[i].xyz + vec3<f32>(w0.x, w0.y, w1.x), 0.0);',
'  out_s[i] = vec4<f32>(in_s[i].xyz + vec3<f32>(w1.y, w2.x, w2.y), 0.0);',
'}'
].join('\n');

/* partials -> sclr[slot] (single workgroup, grid-stride) */
var NL_SUM_SLOT_WGSL = [
'struct SP { count: u32, slot: u32, _p0: u32, _p1: u32 }',
'@group(0) @binding(0) var<storage, read>       partials: array<f32>;',
'@group(0) @binding(1) var<storage, read_write> sclr: array<f32>;',
'@group(0) @binding(2) var<uniform>             U: SP;',
'var<workgroup> sd: array<f32, 256>;',
'@compute @workgroup_size(256)',
'fn nl_sum_slot(@builtin(local_invocation_id) lid: vec3<u32>) {',
'  let t = lid.x;',
'  var s: f32 = 0.0;',
'  var i: u32 = t;',
'  loop { if (i >= U.count) { break; } s = s + partials[i]; i = i + 256u; }',
'  sd[t] = s;',
'  workgroupBarrier();',
'  var st: u32 = 128u;',
'  loop {',
'    if (t < st) { sd[t] = sd[t] + sd[t + st]; }',
'    workgroupBarrier();',
'    if (st == 1u) { break; }',
'    st = st >> 1u;',
'  }',
'  if (t == 0u) { sclr[U.slot] = sd[0]; }',
'}'
].join('\n');

/* CG coefficient arithmetic (1 thread).
   op 0 init : thr = tol2*b2; done = rr <= thr; it = 0
   op 1 alpha: alpha = done ? 0 : rr/pAp  (|pAp|<1e-30 -> breakdown -> done)
   op 2 beta : if !done { it++; beta = rrNew/rr; rr = rrNew; if rrNew <= thr {done; beta = 0} } else beta = 0 */
var NL_SCALAR_WGSL = [
'struct OP { op: u32, _p0: u32, _p1: u32, _p2: u32 }',
'@group(0) @binding(0) var<storage, read_write> s: array<f32>;',
'@group(0) @binding(1) var<uniform>             U: OP;',
'@compute @workgroup_size(1)',
'fn nl_scalar() {',
'  if (U.op == 0u) {',
'    s[' + NLS_THR + '] = s[' + NLS_TOL2 + '] * s[' + NLS_B2 + '];',
'    s[' + NLS_DONE + '] = select(0.0, 1.0, s[' + NLS_RR + '] <= s[' + NLS_THR + ']);',
'    s[' + NLS_IT + '] = 0.0;',
'  } else if (U.op == 1u) {',
'    var a: f32 = 0.0;',
'    if (s[' + NLS_DONE + '] < 0.5) {',
'      if (abs(s[' + NLS_PAP + ']) < 1e-30) { s[' + NLS_DONE + '] = 1.0; }',
'      else { a = s[' + NLS_RR + '] / s[' + NLS_PAP + ']; }',
'    }',
'    s[' + NLS_AL + '] = a; s[' + NLS_NAL + '] = -a;',
'  } else {',
'    var b: f32 = 0.0;',
'    if (s[' + NLS_DONE + '] < 0.5) {',
'      s[' + NLS_IT + '] = s[' + NLS_IT + '] + 1.0;',
'      let rn = s[' + NLS_RRN + '];',
'      b = rn / s[' + NLS_RR + '];',
'      s[' + NLS_RR + '] = rn;',
'      if (rn <= s[' + NLS_THR + ']) { s[' + NLS_DONE + '] = 1.0; b = 0.0; }',
'    }',
'    s[' + NLS_BETA + '] = b;',
'  }',
'}'
].join('\n');

/* fused CG update: x += alpha p; r -= alpha Ap; partial r.r per workgroup */
var NL_CG_XR_WGSL = [
'struct SZ { total: u32, _p0: u32, _p1: u32, _p2: u32 }',
'@group(0) @binding(0) var<storage, read>       p_n:  array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read>       p_s:  array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read>       ap_n: array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read>       ap_s: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read_write> x_n:  array<vec4<f32>>;',
'@group(0) @binding(5) var<storage, read_write> x_s:  array<vec4<f32>>;',
'@group(0) @binding(6) var<storage, read_write> r_n:  array<vec4<f32>>;',
'@group(0) @binding(7) var<storage, read_write> r_s:  array<vec4<f32>>;',
'@group(0) @binding(8) var<storage, read>       sclr: array<f32>;',
'@group(0) @binding(9) var<storage, read_write> partials: array<f32>;',
'@group(0) @binding(10) var<uniform>            U: SZ;',
'var<workgroup> sd: array<f32, 256>;',
'@compute @workgroup_size(256)',
'fn nl_cg_xr(@builtin(global_invocation_id) gid: vec3<u32>,',
'            @builtin(local_invocation_id) lid: vec3<u32>,',
'            @builtin(workgroup_id) wid: vec3<u32>) {',
'  let i = gid.x; let t = lid.x;',
'  var q: f32 = 0.0;',
'  if (i < U.total) {',
'    let a = sclr[' + NLS_AL + '];',
'    x_n[i] = x_n[i] + a * p_n[i];',
'    x_s[i] = x_s[i] + a * p_s[i];',
'    let rn = r_n[i] - a * ap_n[i];',
'    let rs = r_s[i] - a * ap_s[i];',
'    r_n[i] = rn; r_s[i] = rs;',
'    q = dot(rn.xyz, rn.xyz) + dot(rs.xyz, rs.xyz);',
'  }',
'  sd[t] = q;',
'  workgroupBarrier();',
'  var st: u32 = 128u;',
'  loop {',
'    if (t < st) { sd[t] = sd[t] + sd[t + st]; }',
'    workgroupBarrier();',
'    if (st == 1u) { break; }',
'    st = st >> 1u;',
'  }',
'  if (t == 0u) { partials[wid.x] = sd[0]; }',
'}'
].join('\n');

/* pair BLAS with the coefficient read from sclr[slot]:
   mode 0: y += c*x      mode 1: y = x + c*y */
var NL_AXPY_S_WGSL = [
'struct AP { total: u32, slot: u32, mode: u32, _p0: u32 }',
'@group(0) @binding(0) var<storage, read>       x_n: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read>       x_s: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read_write> y_n: array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read_write> y_s: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read>       sclr: array<f32>;',
'@group(0) @binding(5) var<uniform>             U: AP;',
'@compute @workgroup_size(64)',
'fn nl_axpy_s(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let i = gid.x;',
'  if (i >= U.total) { return; }',
'  let c = sclr[U.slot];',
'  if (U.mode == 0u) { y_n[i] = y_n[i] + c * x_n[i]; y_s[i] = y_s[i] + c * x_s[i]; }',
'  else              { y_n[i] = x_n[i] + c * y_n[i]; y_s[i] = x_s[i] + c * y_s[i]; }',
'}'
].join('\n');


/* Mean-exact start (NL_MEANFIX): eps += (eps_bar - <eps>) before a field
   solve.  A_nl preserves the mean (Gamma(0) = 0: <A x> = <x>) but couples
   the mean INTO the fluctuation (Gamma:(C-C0):u != 0 for uniform u), so a
   residual with a uniform part (every new load step / macro iteration:
   R ~ -(change of eps_bar)) makes CG run on a non-symmetric block — slow,
   erratic, and at times divergent in f32 (measured: residual x3.5 after
   the 1000-iteration cap).  With <eps> = eps_bar the residual and all
   Krylov vectors stay zero-mean, where plain CG is well behaved (the
   elastic 16b solve gets this for free by starting from eps = eps_bar).
   The converged solution is unchanged (it satisfies <eps> = eps_bar).
   Stage 1: per-workgroup partial sums of the 6 components. */
var NL_MEAN6_WGSL = [
'struct SZ { total: u32, _p0: u32, _p1: u32, _p2: u32 }',
'@group(0) @binding(0) var<storage, read>       e_n: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read>       e_s: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read_write> part: array<vec4<f32>>;',
'@group(0) @binding(3) var<uniform>             U: SZ;',
'var<workgroup> sn: array<vec4<f32>, 256>;',
'var<workgroup> ss: array<vec4<f32>, 256>;',
'@compute @workgroup_size(256)',
'fn nl_mean6(@builtin(global_invocation_id) gid: vec3<u32>,',
'            @builtin(local_invocation_id) lid: vec3<u32>,',
'            @builtin(workgroup_id) wid: vec3<u32>) {',
'  let i = gid.x; let t = lid.x;',
'  var a = vec4<f32>(0.0); var b = vec4<f32>(0.0);',
'  if (i < U.total) { a = vec4<f32>(e_n[i].xyz, 0.0); b = vec4<f32>(e_s[i].xyz, 0.0); }',
'  sn[t] = a; ss[t] = b;',
'  workgroupBarrier();',
'  var st: u32 = 128u;',
'  loop {',
'    if (t < st) { sn[t] = sn[t] + sn[t + st]; ss[t] = ss[t] + ss[t + st]; }',
'    workgroupBarrier();',
'    if (st == 1u) { break; }',
'    st = st >> 1u;',
'  }',
'  if (t == 0u) { part[2u * wid.x] = sn[0]; part[2u * wid.x + 1u] = ss[0]; }',
'}'
].join('\n');
/* Stage 2 (1 workgroup): sum the partials -> mean.  Stage 3: shift eps by
   (b - mean).  All on the GPU, no readback. */
var NL_MEANSUM_WGSL = [
'struct SP { count: u32, total: u32, _p0: u32, _p1: u32 }',
'@group(0) @binding(0) var<storage, read>       part: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read_write> mean: array<vec4<f32>>;',
'@group(0) @binding(2) var<uniform>             U: SP;',
'var<workgroup> sn: array<vec4<f32>, 256>;',
'var<workgroup> ss: array<vec4<f32>, 256>;',
'@compute @workgroup_size(256)',
'fn nl_meansum(@builtin(local_invocation_id) lid: vec3<u32>) {',
'  let t = lid.x;',
'  var a = vec4<f32>(0.0); var b = vec4<f32>(0.0);',
'  var i: u32 = t;',
'  loop { if (i >= U.count) { break; } a = a + part[2u * i]; b = b + part[2u * i + 1u]; i = i + 256u; }',
'  sn[t] = a; ss[t] = b;',
'  workgroupBarrier();',
'  var st: u32 = 128u;',
'  loop {',
'    if (t < st) { sn[t] = sn[t] + sn[t + st]; ss[t] = ss[t] + ss[t + st]; }',
'    workgroupBarrier();',
'    if (st == 1u) { break; }',
'    st = st >> 1u;',
'  }',
'  if (t == 0u) { let inv = 1.0 / f32(U.total); mean[0] = sn[0] * inv; mean[1] = ss[0] * inv; }',
'}'
].join('\n');
var NL_MEANSHIFT_WGSL = [
'struct SZ { total: u32, _p0: u32, _p1: u32, _p2: u32 }',
'@group(0) @binding(0) var<storage, read_write> e_n: array<vec4<f32>>;',
'@group(0) @binding(1) var<storage, read_write> e_s: array<vec4<f32>>;',
'@group(0) @binding(2) var<storage, read>       b_n: array<vec4<f32>>;',
'@group(0) @binding(3) var<storage, read>       b_s: array<vec4<f32>>;',
'@group(0) @binding(4) var<storage, read>       mean: array<vec4<f32>>;',
'@group(0) @binding(5) var<uniform>             U: SZ;',
'@compute @workgroup_size(64)',
'fn nl_meanshift(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let i = gid.x;',
'  if (i >= U.total) { return; }',
'  e_n[i] = vec4<f32>(e_n[i].xyz + b_n[i].xyz - mean[0].xyz, 0.0);',
'  e_s[i] = vec4<f32>(e_s[i].xyz + b_s[i].xyz - mean[1].xyz, 0.0);',
'}'
].join('\n');

/* Build (once per solver, at upload) the fast-path resources.  Returns
   false — and the solver stays on the legacy path — if Gamma is not
   real-even-symmetric or a buffer would exceed the device limits. */
NonlinearSolverFull.prototype._fastInit = function (Gamma) {
  this._fast = null;
  var es = this.es, d = this.device, N = this.N, N3 = this.N3;
  var lim = d.limits || {};
  var maxBind = lim.maxStorageBufferBindingSize || 134217728;
  var maxSt = lim.maxStorageBuffersPerShaderStage || 8;
  if (21 * N3 * 4 > maxBind || 3 * N3 * 8 > maxBind || maxSt < 10) return false;
  /* exactness checks for the packed operator (cheap, CPU, float64): Gamma
     must be symmetric (P,Q) and even in k, up to f64 roundoff (far below
     the f32 the GPU stores). */
  var gMax = 0;
  for (var P0 = 0; P0 < 6; P0++) for (var Q0 = 0; Q0 < 6; Q0++) { var G0 = Gamma[P0][Q0]; for (var i0 = 0; i0 < N3; i0++) { var a0 = Math.abs(G0[i0]); if (a0 > gMax) gMax = a0; } }
  var gTol = 1e-10 * gMax;
  for (var P = 0; P < 6; P++) for (var Q = P + 1; Q < 6; Q++) {
    var A = Gamma[P][Q], B = Gamma[Q][P];
    for (var i = 0; i < N3; i++) if (Math.abs(A[i] - B[i]) > gTol) { console.warn('[16g-fast] Gamma not symmetric -> legacy path'); return false; }
  }
  for (var P2 = 0; P2 < 6; P2++) for (var Q2 = P2; Q2 < 6; Q2++) {
    var G = Gamma[P2][Q2];
    for (var k = 0; k < N3; k++) {
      var x = k % N, y = ((k / N) | 0) % N, z = (k / (N * N)) | 0;
      var m = ((N - x) % N) + N * (((N - y) % N) + N * ((N - z) % N));
      if (Math.abs(G[k] - G[m]) > gTol) { console.warn('[16g-fast] Gamma not even -> legacy path'); return false; }
    }
  }

  var BU = GPUBufferUsage;
  var F = {};
  F.fft = new FFTPlan(N, 3);
  F.inPlace = (F.fft.fwdResultBuf === F.fft.bufA);   /* even stage count: forward result already in the IFFT input */
  F.G = d.createBuffer({ size: 21 * N3 * 4, usage: BU.STORAGE | BU.COPY_DST });
  var enc = d.createCommandEncoder();
  for (var p = 0; p < 6; p++) for (var q = p; q < 6; q++)
    enc.copyBufferToBuffer(es.gamma[p][q], 0, F.G, nlGammaSymIdx(p, q) * N3 * 4, N3 * 4);
  d.queue.submit([enc.finish()]);
  var sb = function () { return d.createBuffer({ size: es.v4Size, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); };
  F.pp = { n: sb(), s: sb() };               /* converged field one step back (predictor) */
  F.sclr = d.createBuffer({ size: NLS_COUNT * 4, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });
  F.sclrRB = d.createBuffer({ size: NLS_COUNT * 4, usage: BU.COPY_DST | BU.MAP_READ });
  var init = new Float32Array(NLS_COUNT); init[NLS_M1] = -1;
  d.queue.writeBuffer(F.sclr, 0, init);
  var u = function (arr) { var b = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST }); d.queue.writeBuffer(b, 0, new Uint32Array(arr)); return b; };
  var pipe = function (code, entry) { return d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: code }), entryPoint: entry } }); };
  F.pPackAt = pipe(NL_PACK_AT_WGSL, 'nl_pack_at');
  F.pPackTau = pipe(NL_PACK_TAU_WGSL, 'nl_pack_tau');
  F.pGamma = pipe(nlGammaPkWGSL(F.inPlace), 'nl_gamma_pk');
  F.pDeacc = pipe(NL_DEACC_PK_WGSL, 'nl_deacc_pk');
  F.pSum = pipe(NL_SUM_SLOT_WGSL, 'nl_sum_slot');
  F.pScalar = pipe(NL_SCALAR_WGSL, 'nl_scalar');
  F.pXR = pipe(NL_CG_XR_WGSL, 'nl_cg_xr');
  F.pAxpy = pipe(NL_AXPY_S_WGSL, 'nl_axpy_s');
  F.pMean6 = pipe(NL_MEAN6_WGSL, 'nl_mean6');
  F.pMeanSum = pipe(NL_MEANSUM_WGSL, 'nl_meansum');
  F.pMeanShift = pipe(NL_MEANSHIFT_WGSL, 'nl_meanshift');
  F.part6 = d.createBuffer({ size: Math.max(es.partialCount * 32, 256), usage: BU.STORAGE });
  F.mean6 = d.createBuffer({ size: 32, usage: BU.STORAGE | BU.COPY_SRC });
  F.uMean = u([es.partialCount, N3, 0, 0]);
  F.uSize = u([N3, 0, 0, 0]);
  F.uGamma = u([N3, N, 0, 0]);
  F.uSum = {}; F.uOp = [u([0, 0, 0, 0]), u([1, 0, 0, 0]), u([2, 0, 0, 0])];
  F.uAx = {};
  F.bg = {};                                 /* bind-group cache, keyed by role */
  this._fast = F;
  return true;
};

NonlinearSolverFull.prototype._fastDestroy = function () {
  var F = this._fast; if (!F) return;
  try { F.fft.destroy(); F.G.destroy(); F.pp.n.destroy(); F.pp.s.destroy(); F.sclr.destroy(); F.sclrRB.destroy(); F.part6.destroy(); F.mean6.destroy(); } catch (e) {}
  this._fast = null;
};

/* cached bind group helper */
NonlinearSolverFull.prototype._fbg = function (key, pipeline, buffers) {
  var F = this._fast;
  if (!F.bg[key]) {
    var entries = [];
    for (var i = 0; i < buffers.length; i++) entries.push({ binding: i, resource: { buffer: buffers[i] } });
    F.bg[key] = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries });
  }
  return F.bg[key];
};

/* one compute pass for a list of [pipeline, bindGroup, x, y] dispatches */
function nlPass(enc, list) {
  var pass = enc.beginComputePass();
  for (var i = 0; i < list.length; i++) {
    pass.setPipeline(list[i][0]); pass.setBindGroup(0, list[i][1]); pass.dispatchWorkgroups(list[i][2], list[i][3] || 1, 1);
  }
  pass.end();
}

/* role -> buffer pair */
NonlinearSolverFull.prototype._fpair = function (name) {
  var es = this.es;
  switch (name) {
    case 'eps': return es.eps; case 'r': return es.r; case 'p': return es.p; case 'Ap': return es.Ap;
    case 'b': return es.b; case 'sig': return es.sig; case 'tau': return es.tau;
    case 'x': return { n: this.deps_n, s: this.deps_s };
    case 'warm': return { n: this.warmDeps_n, s: this.warmDeps_s };
    case 'snap': return { n: this.snap_n, s: this.snap_s };
    case 'pp': return this._fast.pp;
    case 'rsv': return this._fast.rsv;
  }
  throw new Error('_fpair: ' + name);
};

/* spectral half of the operator: FFT -> Gamma -> IFFT, then out = in + field */
NonlinearSolverFull.prototype._fSpectral = function (enc, inName, outName) {
  var F = this._fast, N3 = this.N3, wg = Math.ceil(N3 / 64);
  F.fft.forwardEncoded(enc);
  var gbg = F.inPlace ? this._fbg('gamma', F.pGamma, [F.G, F.fft.bufA, F.uGamma])
                      : this._fbg('gamma', F.pGamma, [F.G, F.fft.fwdResultBuf, F.fft.bufA, F.uGamma]);
  nlPass(enc, [[F.pGamma, gbg, wg]]);
  F.fft.inverseEncoded(enc);
  var I = this._fpair(inName), O = this._fpair(outName);
  nlPass(enc, [[F.pDeacc, this._fbg('deacc:' + inName + '>' + outName, F.pDeacc, [F.fft.invResultBuf, I.n, I.s, O.n, O.s, F.uSize]), wg]]);
};

/* out = A_nl v  (frozen tangent) */
NonlinearSolverFull.prototype._fApplyA = function (enc, vName, outName) {
  var F = this._fast, es = this.es, v = this._fpair(vName);
  nlPass(enc, [[F.pPackAt, this._fbg('packat:' + vName, F.pPackAt,
    [es.solidBuf, v.n, v.s, this.tan_n, this.tan_s, F.fft.bufA, this.j2ParamsBuf, es.elasticParamsBuf]), Math.ceil(this.N3 / 64)]]);
  this._fSpectral(enc, vName, outName);
};

NonlinearSolverFull.prototype._fSweepReturnMap = function (enc) {
  var es = this.es;
  var bg = this._fbg('rm', this.rmPipeline, [es.solidBuf, es.eps.n, es.eps.s, this.epp_n, this.epp_s, es.sig.n, es.sig.s,
                                             this.tan_n, this.tan_s, this.eppT_n, this.eppT_s, this.j2ParamsBuf]);
  nlPass(enc, [[this.rmPipeline, bg, Math.ceil(this.N3 / 64)]]);
};

/* sclr[slot] = a . b   (multi-workgroup partials + 1-workgroup sum) */
NonlinearSolverFull.prototype._fDot = function (enc, aName, bName, slot) {
  var F = this._fast, es = this.es, a = this._fpair(aName), b = this._fpair(bName);
  nlPass(enc, [
    [es.drPipeline, this._fbg('dot:' + aName + '.' + bName, es.drPipeline, [a.n, a.s, b.n, b.s, es.partialsBuf, es.sizeParamsBuf]), es.partialCount],
    [F.pSum, this._fbg('sum:' + slot, F.pSum, [es.partialsBuf, F.sclr, this._fSumU(slot)]), 1]
  ]);
};

/* y += sclr[slot]*x (mode 0)  |  y = x + sclr[slot]*y (mode 1) */
NonlinearSolverFull.prototype._fAxpy = function (enc, xName, yName, slot, mode) {
  var F = this._fast, key = slot + ':' + (mode || 0);
  if (!F.uAx[key]) {
    F.uAx[key] = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(F.uAx[key], 0, new Uint32Array([this.N3, slot, mode || 0, 0]));
  }
  var x = this._fpair(xName), y = this._fpair(yName);
  nlPass(enc, [[F.pAxpy, this._fbg('ax:' + xName + '>' + yName + ':' + key, F.pAxpy, [x.n, x.s, y.n, y.s, F.sclr, F.uAx[key]]), Math.ceil(this.N3 / 64)]]);
};

/* eps += (b - <eps>)  (resident; see NL_MEAN6_WGSL) */
NonlinearSolverFull.prototype._fMeanShift = function (enc) {
  var F = this._fast, es = this.es;
  nlPass(enc, [
    [F.pMean6, this._fbg('mean6', F.pMean6, [es.eps.n, es.eps.s, F.part6, F.uSize]), es.partialCount],
    [F.pMeanSum, this._fbg('meansum', F.pMeanSum, [F.part6, F.mean6, F.uMean]), 1],
    [F.pMeanShift, this._fbg('meanshift', F.pMeanShift, [es.eps.n, es.eps.s, es.b.n, es.b.s, F.mean6, F.uSize]), Math.ceil(this.N3 / 64)]
  ]);
};

NonlinearSolverFull.prototype._fScalar = function (enc, op) {
  var F = this._fast;
  nlPass(enc, [[F.pScalar, this._fbg('op' + op, F.pScalar, [F.sclr, F.uOp[op]]), 1]]);
};

NonlinearSolverFull.prototype._fReadSclr = async function (enc) {
  var F = this._fast, d = this.device;
  enc.copyBufferToBuffer(F.sclr, 0, F.sclrRB, 0, NLS_COUNT * 4);
  d.queue.submit([enc.finish()]);
  await F.sclrRB.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(F.sclrRB.getMappedRange().slice(0));
  F.sclrRB.unmap();
  return v;
};

NonlinearSolverFull.prototype._fWriteSclr = function (slot, val) {
  this.device.queue.writeBuffer(this._fast.sclr, slot * 4, new Float32Array([val]));
};

/* one resident CG iteration (no readback) */
NonlinearSolverFull.prototype._fCgIter = function (enc) {
  var F = this._fast, es = this.es;
  this._fApplyA(enc, 'p', 'Ap');                 /* Ap = A p            */
  this._fDot(enc, 'p', 'Ap', NLS_PAP);           /* pAp                 */
  this._fScalar(enc, 1);                         /* alpha               */
  var x = this._fpair('x');
  nlPass(enc, [
    [F.pXR, this._fbg('xr', F.pXR, [es.p.n, es.p.s, es.Ap.n, es.Ap.s, x.n, x.s, es.r.n, es.r.s, F.sclr, es.partialsBuf, F.uSize]), es.partialCount],
    [F.pSum, this._fbg('sum:' + NLS_RRN, F.pSum, [es.partialsBuf, F.sclr, this._fSumU(NLS_RRN)]), 1]
  ]);
  this._fScalar(enc, 2);                         /* beta, convergence   */
  this._fAxpy(enc, 'r', 'p', NLS_BETA, 1);       /* p = r + beta p      */
};
NonlinearSolverFull.prototype._fSumU = function (slot) {
  var F = this._fast;
  if (!F.uSum[slot]) {
    F.uSum[slot] = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(F.uSum[slot], 0, new Uint32Array([this.es.partialCount, slot, 0, 0]));
  }
  return F.uSum[slot];
};

/* Resident CG on A_nl x = R (R in es.r, ||R||^2 = rrR known).  x in deps.
   Returns { iters, rel, cap, readbacks, encoded }. */
NonlinearSolverFull.prototype._fCg = async function (rrR, tol, maxIt, warm) {
  var d = this.device, es = this.es;
  var checkMax = nlFlag('NL_CHECK_MAX', 16);
  var diagTrue = !!nlFlag('NL_DIAG_TRUE', false);
  this._fWriteSclr(NLS_TOL2, tol * tol);
  this._fWriteSclr(NLS_B2, rrR);
  var enc = d.createCommandEncoder();
  if (diagTrue) {
    if (!this._fast.rsv) {
      var BU = GPUBufferUsage, V = es.v4Size;
      this._fast.rsv = { n: d.createBuffer({ size: V, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }),
                         s: d.createBuffer({ size: V, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }) };
    }
    es._copyPair(enc, es.r, this._fast.rsv);       /* keep R for the true-residual check */
  }
  var x = this._fpair('x');
  if (warm) {
    es._copyPair(enc, this._fpair('warm'), x);     /* x0 = previous first-iter increment */
    this._fApplyA(enc, 'x', 'Ap');
    this._fAxpy(enc, 'Ap', 'r', NLS_M1, 0);        /* r0 = R - A x0 */
  } else {
    enc.clearBuffer(x.n); enc.clearBuffer(x.s);    /* x0 = 0, r0 = R */
  }
  es._copyPair(enc, es.r, es.p);                   /* p0 = r0 */
  this._fDot(enc, 'r', 'r', NLS_RR);
  this._fScalar(enc, 0);
  var encoded = 0, block = 1, reads = 0, v;
  while (true) {
    var nb = Math.min(block, maxIt - encoded);
    for (var b = 0; b < nb; b++) this._fCgIter(enc);
    encoded += nb;
    v = await this._fReadSclr(enc); reads++;
    if (v[NLS_DONE] > 0.5 || encoded >= maxIt || !isFinite(v[NLS_RR])) break;
    block = Math.min(checkMax, Math.max(1, Math.floor(encoded / 4)));
    enc = d.createCommandEncoder();
  }
  var iters = v[NLS_IT] | 0;
  var rel = Math.sqrt(Math.max(v[NLS_RR], 0) / Math.max(rrR, 1e-60));
  var out = { iters: iters, rel: rel, cap: !(v[NLS_DONE] > 0.5), readbacks: reads, encoded: encoded };
  if (diagTrue) {
    var e2 = d.createCommandEncoder();
    this._fApplyA(e2, 'x', 'Ap');
    es._copyPair(e2, this._fast.rsv, es.tau);
    this._fAxpy(e2, 'Ap', 'tau', NLS_M1, 0);       /* tau = R - A x */
    this._fDot(e2, 'tau', 'tau', NLS_TRUE);
    var vt = await this._fReadSclr(e2);
    out.trueRel = Math.sqrt(Math.max(vt[NLS_TRUE], 0) / Math.max(rrR, 1e-60));
  }
  return out;
};

/* Fast Newton solve — same contract as newtonSolve. */
NonlinearSolverFull.prototype._newtonSolveFast = async function (eps_bar) {
  var es = this.es, d = es.device, N3 = this.N3;
  var useEW = !!nlFlag('NL_EW', true);
  var warmOK = !this._predictOn;                    /* the field predictor supersedes the CG warm start */
  var encB = d.createCommandEncoder(); es._fillPair(encB, es.b, eps_bar);
  if (nlFlag('NL_MEANFIX', true)) this._fMeanShift(encB);   /* <eps> = eps_bar -> zero-mean residuals */
  d.queue.submit([encB.finish()]);
  var s2 = 0; for (var c0 = 0; c0 < 6; c0++) s2 += eps_bar[c0] * eps_bar[c0];
  var ebNorm = Math.sqrt(N3 * s2) + 1e-30;          /* ||eps_bar field|| exactly (was a GPU dot) */
  var converged = false, nit = 0, totalCg = 0, lastRel = Infinity, prevRel = Infinity, strikes = 0, reads = 0;
  var tr = this._trace ? { rel: [], cg: [], cgRel: [], cap: [], tol: [], trueRel: [] } : null;

  for (var n = 0; n < this.newtonMax; n++) {
    nit = n + 1;
    var enc = d.createCommandEncoder();
    this._fSweepReturnMap(enc);
    var F = this._fast;
    nlPass(enc, [[F.pPackTau, this._fbg('packtau', F.pPackTau, [es.eps.n, es.eps.s, es.sig.n, es.sig.s, F.fft.bufA, es.elasticParamsBuf]), Math.ceil(N3 / 64)]]);
    this._fSpectral(enc, 'eps', 'r');               /* r = eps + Gamma:(sig - C0:eps) */
    this._fAxpy(enc, 'b', 'r', NLS_M1, 0);          /* r -= eps_bar */
    this._fDot(enc, 'r', 'r', NLS_RES);
    var v = await this._fReadSclr(enc); reads++;
    var rr = v[NLS_RES];
    prevRel = lastRel;
    lastRel = Math.sqrt(Math.max(rr, 0)) / ebNorm;
    if (tr) tr.rel.push(lastRel);
    if (!isFinite(lastRel)) break;
    /* at least one Newton correction per solve (as the legacy loop always
       did): a predicted field whose residual is already just under
       newtonTol would otherwise be accepted as is, which cost up to 0.4%
       in sigma at plastic steps of a low-density lattice (spinodoid N=32).
       With EW that correction is a short CG (tol 0.1 of the residual). */
    if (lastRel < this.newtonTol && n >= nlFlag('NL_MIN_CORR', 1)) { converged = true; break; }
    var tight = false;
    if (useEW && n > 0 && !(lastRel < 0.9 * prevRel)) {
      /* Stalled or growing.  First two strikes: re-solve with a 10x tighter
         CG tol (NL_EW_TIGHT; floor = legacy cgTol) — a loose inexact step
         at yield onset can overshoot.  Third strike: stop — accept below
         acceptRel (f32-floor stall, the same outcome the legacy loop
         reached after grinding to newtonMax=12), else fail fast so the
         cutback starts ~9 Newton solves earlier. */
      strikes++;
      if (strikes >= 3) { if (lastRel < this.acceptRel) converged = true; break; }
      tight = true;
    }
    var tolK = this.cgTol;
    if (useEW) {
      /* absolute target: eta*newtonTol of ||eps_bar||.  Relative cap 0.1 (>=10x
         per Newton step); 0.5 for the forced first correction of an already
         converged-looking predictor (relRes < newtonTol), so it does not
         chase the f32 floor. */
      tolK = Math.max(this.cgTol, Math.min(lastRel < this.newtonTol ? 0.5 : 0.1, nlFlag('NL_EW_ETA', 0.1) * this.newtonTol / lastRel));
      if (tight) tolK = Math.max(this.cgTol, tolK * nlFlag('NL_EW_TIGHT', 0.1));
    }
    var cg = await this._fCg(rr, tolK, this.cgMax, warmOK && n === 0);
    totalCg += cg.iters; reads += cg.readbacks;
    if (tr) { tr.cg.push(cg.iters); tr.cgRel.push(cg.rel); tr.cap.push(cg.cap); tr.tol.push(tolK); if (cg.trueRel != null) tr.trueRel.push(cg.trueRel); }
    if (this.stats) { this.stats.cg += cg.iters; this.stats.cgCap += cg.cap ? 1 : 0; this.stats.cgSolves++; }
    var encU = d.createCommandEncoder();
    this._fAxpy(encU, 'x', 'eps', NLS_M1, 0);       /* eps -= deps */
    if (warmOK && n === 0) es._copyPair(encU, this._fpair('x'), this._fpair('warm'));
    d.queue.submit([encU.finish()]);
  }

  var encF = d.createCommandEncoder();
  this._fSweepReturnMap(encF);
  es._copyPair(encF, { n: this.eppT_n, s: this.eppT_s }, { n: this.epp_n, s: this.epp_s });
  d.queue.submit([encF.finish()]);
  var sig6 = await es._readbackPair(es.sig); reads++;
  var sBar = [0, 0, 0, 0, 0, 0];
  for (var c = 0; c < 6; c++) { var acc = 0, a = sig6[c]; for (var i = 0; i < N3; i++) acc += a[i]; sBar[c] = acc / N3; }
  if (!converged && lastRel < this.acceptRel) converged = true;   /* f32-floor stall acceptance */
  if (this.stats) { this.stats.newton += nit; this.stats.solves++; this.stats.readbacks += reads; }
  if (tr) {
    tr.converged = converged; this._trace.push(tr);
    console.log('[nl-trace] conv=' + converged + ' rel=' + tr.rel.map(function (x) { return x.toExponential(2); }).join(',') +
                ' cg=' + tr.cg.join(',') + ' cgRel=' + tr.cgRel.map(function (x) { return x.toExponential(1); }).join(',') +
                ' tol=' + tr.tol.map(function (x) { return x.toExponential(1); }).join(',') +
                (tr.trueRel.length ? ' true=' + tr.trueRel.map(function (x) { return x.toExponential(1); }).join(',') : '') +
                (tr.cap.indexOf(true) >= 0 ? ' CAP' : ''));
  }
  return { sigma_bar: sBar, converged: converged, newtonIters: nit, totalCgIters: totalCg, relRes: lastRel };
};

/* PERF (NL_FAST_MACRO): the 6 elastic load cases of the macro stiffness
   through the fast field solve instead of es.homogenizeFull (legacy,
   sync-bound CG, 12 FFTs/iteration).  A tiny strain (1e-6) keeps every
   voxel elastic (the J2 return map is then exactly C_s / C_v), the
   Newton tolerance is tightened to cgTol (1e-4, the elastic solver's CG
   tol), x0 = 0, and C is symmetrised as homogenizeFull does. */
NonlinearSolverFull.prototype._ensureElasticMacroFast = async function () {
  var h = 1e-6, C = new Float64Array(36), d = this.device;
  var tolSave = this.newtonTol, predSave = this._predictOn, statsSave = this.stats, traceSave = this._trace;
  this.newtonTol = this.cgTol; this._predictOn = false; this.stats = null; this._trace = nlFlag('NL_TRACE', false) ? [] : null;
  try {
    for (var lc = 0; lc < 6; lc++) {
      this.resetHistory();
      var enc = d.createCommandEncoder();
      enc.clearBuffer(this.warmDeps_n); enc.clearBuffer(this.warmDeps_s);   /* x0 = 0: no cross-LC warm start */
      d.queue.submit([enc.finish()]);
      var eb = [0, 0, 0, 0, 0, 0]; eb[lc] = h;
      var res = await this.newtonSolve(eb);
      for (var P = 0; P < 6; P++) C[P * 6 + lc] = res.sigma_bar[P] / h;
    }
  } finally {
    this.newtonTol = tolSave; this._predictOn = predSave; this.stats = statsSave; this._trace = traceSave;
  }
  for (var P2 = 0; P2 < 6; P2++) for (var Q2 = P2 + 1; Q2 < 6; Q2++) {
    var avg = 0.5 * (C[P2 * 6 + Q2] + C[Q2 * 6 + P2]); C[P2 * 6 + Q2] = avg; C[Q2 * 6 + P2] = avg;
  }
  var encW = d.createCommandEncoder(); encW.clearBuffer(this.warmDeps_n); encW.clearBuffer(this.warmDeps_s); d.queue.submit([encW.finish()]);
  this._Cmacro = C;
  this.resetHistory();
  return C;
};

/* predictor: eps = snap + ratio*(snap - pp) */
NonlinearSolverFull.prototype._fPredict = function (ratio) {
  var es = this.es, d = this.device;
  this._fWriteSclr(NLS_C1, ratio);
  this._fWriteSclr(NLS_C2, -ratio);
  var enc = d.createCommandEncoder();
  es._copyPair(enc, this._fpair('snap'), es.eps);
  this._fAxpy(enc, 'snap', 'eps', NLS_C1, 0);
  this._fAxpy(enc, 'pp', 'eps', NLS_C2, 0);
  d.queue.submit([enc.finish()]);
};

/* ════════════════════════════════════════════════════════════
   runNonlinearFastOpTest — fast packed operator vs legacy
   _applyA_nl / residual on the same state (browser console):
     await runNonlinearFastOpTest(16)
   ════════════════════════════════════════════════════════════ */
async function runNonlinearFastOpTest(N, recipeKey) {
  N = N || 16;
  if (!WGPU.device) await ensureDevice();
  var fft = new FFTPlan(N);
  var s = new NonlinearSolverFull(N, fft);
  s.upload(DEMO_RECIPES[recipeKey || 'schwarzP'], { pruneLargest: true });
  if (!s._fast) { console.warn('[16g-fast] fast path unavailable'); return null; }
  var es = s.es, d = s.device, N3 = s.N3;
  /* a plastic state: macro strain big enough to yield, random field on top */
  var rnd = function () { var a = new Float32Array(4 * N3); for (var i = 0; i < N3; i++) { a[4*i] = Math.random()-0.5; a[4*i+1] = Math.random()-0.5; a[4*i+2] = Math.random()-0.5; } return a; };
  var eN = rnd(), eS = rnd();
  for (var i = 0; i < 4 * N3; i++) { eN[i] = 0.004 * eN[i] + ((i % 4) === 2 ? -0.02 : 0); eS[i] *= 0.004; }
  for (var j = 0; j < N3; j++) { eN[4*j+3] = 0; eS[4*j+3] = 0; }
  d.queue.writeBuffer(es.eps.n, 0, eN); d.queue.writeBuffer(es.eps.s, 0, eS);
  d.queue.writeBuffer(es.p.n, 0, rnd()); d.queue.writeBuffer(es.p.s, 0, rnd());
  var enc = d.createCommandEncoder(); s._sweepReturnMap(enc); d.queue.submit([enc.finish()]);
  /* legacy A p -> Ap, copy to snap; fast A p -> Ap */
  enc = d.createCommandEncoder(); s._applyA_nl(enc, es.p, es.Ap); es._copyPair(enc, es.Ap, { n: s.snap_n, s: s.snap_s }); d.queue.submit([enc.finish()]);
  var ref = await es._readbackPair({ n: s.snap_n, s: s.snap_s });
  enc = d.createCommandEncoder(); s._fApplyA(enc, 'p', 'Ap'); d.queue.submit([enc.finish()]);
  var got = await es._readbackPair(es.Ap);
  var num = 0, den = 0;
  for (var c = 0; c < 6; c++) for (var k = 0; k < N3; k++) { var df = got[c][k] - ref[c][k]; num += df * df; den += ref[c][k] * ref[c][k]; }
  var relA = Math.sqrt(num / den);
  var pv = await es._readbackPair(es.p), pn = 0;
  for (var c1 = 0; c1 < 6; c1++) for (var k1 = 0; k1 < N3; k1++) pn += pv[c1][k1] * pv[c1][k1];
  var relAv = Math.sqrt(num / pn);   /* error relative to ||v||: A = I + Gamma(C-C0) cancels strongly in the voids */
  /* residual operator: eps + Gamma:(sig - C0:eps) */
  enc = d.createCommandEncoder(); s._sweepReturnMap(enc); s._gammaApply(enc, es.sig, es.eps, es.r); es._copyPair(enc, es.r, { n: s.snap_n, s: s.snap_s }); d.queue.submit([enc.finish()]);
  var refR = await es._readbackPair({ n: s.snap_n, s: s.snap_s });
  enc = d.createCommandEncoder(); s._fSweepReturnMap(enc);
  var F = s._fast;
  nlPass(enc, [[F.pPackTau, s._fbg('packtau', F.pPackTau, [es.eps.n, es.eps.s, es.sig.n, es.sig.s, F.fft.bufA, es.elasticParamsBuf]), Math.ceil(N3 / 64)]]);
  s._fSpectral(enc, 'eps', 'r'); d.queue.submit([enc.finish()]);
  var gotR = await es._readbackPair(es.r);
  num = 0; den = 0;
  for (var c2 = 0; c2 < 6; c2++) for (var k2 = 0; k2 < N3; k2++) { var df2 = gotR[c2][k2] - refR[c2][k2]; num += df2 * df2; den += refR[c2][k2] * refR[c2][k2]; }
  var relR = Math.sqrt(num / den);
  s.destroy(); fft.destroy();
  var pass = relA < 1e-4 && relR < 1e-4;
  console.log('[16g-fast] packed operator vs legacy: A_nl rel ' + relA.toExponential(2) + ' (vs ||v||: ' + relAv.toExponential(2) + '), residual rel ' + relR.toExponential(2) + (pass ? '  PASS' : '  FAIL'));
  return { relA: relA, relAv: relAv, relR: relR, pass: pass };
}
if (typeof window !== 'undefined') window.runNonlinearFastOpTest = runNonlinearFastOpTest;
