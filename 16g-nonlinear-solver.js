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
   row3: total (u32), pad, pad, pad */
var J2_PARAMS_WGSL = [
'struct J2Params {',
'  mu_s: f32, lam_s: f32, K_s: f32, sigY0: f32,',
'  mu_v: f32, lam_v: f32, K_v: f32, useVoce: f32,',
'  H: f32, sigSat: f32, delta: f32, Hlin: f32,',
'  total: u32, _p0: u32, _p1: u32, _p2: u32,',
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
'  let theta    = 1.0 - twomudg*inv;',
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

var NL_VOID_CONTRAST = 1e-3;   /* void stiffness = this * solid; ~+2% modulus for ~5x faster CG */
var NL_NEWTON_TOL    = 1e-3;   /* f32-appropriate outer tol (inner CG floor ~1e-4) */
var NL_NEWTON_ACCEPT = 5e-3;   /* accept a stalled field solve below this (f32-floor guard) */
var NL_NEWTON_MAX    = 12;   /* cap failed-attempt cost; successful solves use ~3 */
var NL_CG_TOL        = 1e-3;   /* matched to the Newton target — inexact-Newton inner tol */
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
  this.snap_n = sb(); this.snap_s = sb();   /* strain snapshot for load-step cutback */
  this.snapEpp_n = sb(); this.snapEpp_s = sb(); /* committed-history baseline for macro-Newton */
  this.j2ParamsBuf = d.createBuffer({ size: 64, usage: BU.UNIFORM | BU.COPY_DST });

  this.newtonTol = NL_NEWTON_TOL; this.newtonMax = NL_NEWTON_MAX;
  this.cgTol = NL_CG_TOL; this.cgMax = NL_CG_MAX;
  this.acceptRel = NL_NEWTON_ACCEPT;
}

NonlinearSolverFull.prototype.setMaterial = function (m) {
  var Ev = m.E * NL_VOID_CONTRAST;
  var mu_v = Ev / (2 * (1 + m.nu));
  var lam_v = Ev * m.nu / ((1 + m.nu) * (1 - 2 * m.nu));
  var K_v = lam_v + 2 * mu_v / 3;
  var useVoce = m.voce ? 1 : 0;
  var buf = new ArrayBuffer(64), f = new Float32Array(buf), u = new Uint32Array(buf);
  f[0]=m.mu; f[1]=m.lam; f[2]=m.K; f[3]=m.sigY0;
  f[4]=mu_v; f[5]=lam_v; f[6]=K_v; f[7]=useVoce;
  f[8]=m.H; f[9]=m.voce?m.voce.sigSat_MPa:0; f[10]=m.voce?m.voce.delta:0; f[11]=m.voce?(m.voce.Hlin_MPa||0):0;
  u[12]=this.N3;
  this.device.queue.writeBuffer(this.j2ParamsBuf, 0, buf);
};

/* rasterize + Gamma + upload (mirrors solveDesignElasticFull setup) */
NonlinearSolverFull.prototype.upload = function (recipe) {
  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args = resolveBuildArgs(recipe);
  var solid = buildVoxels(family, params, args.offset, this.N, args.mode, args.wt, args.nWeights, args.pipeR, args.phaseShift);
  var inside = 0; for (var v = 0; v < solid.length; v++) inside += solid[v];
  this.rho = inside / solid.length;
  var mat = recipe.material || NL_MAT_DEFAULT;
  var m = nlMakeMaterial(mat);
  this.material = m;
  var C_s = isoC(m.E, m.nu), C_v = isoC(m.E * NL_VOID_CONTRAST, m.nu), C_0 = isoC(m.E, m.nu);
  var Gamma = buildGammaFull(this.N, C_0[21], C_0[1]);
  this.es.uploadDesign(solid, Gamma, C_s, C_v, C_0);
  this.setMaterial(m);
  this.resetHistory();
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

    /* CG: solve A_nl * deps = R (= es.r), x0 = 0; then eps -= deps */
    var encZ = d.createCommandEncoder();
    es._fillPair(encZ, { n: this.deps_n, s: this.deps_s }, [0,0,0,0,0,0]);
    es._copyPair(encZ, es.r, es.p);
    d.queue.submit([encZ.finish()]);
    var rrcg = await es._dotPair(es.r, es.r);
    var bnorm = Math.sqrt(rrcg) + 1e-30;
    var dpair = { n: this.deps_n, s: this.deps_s };

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
  return { sigma_bar: sBar, converged: converged, newtonIters: nit, totalCgIters: totalCg, relRes: lastRel };
};

/* Uniaxial-STRAIN crush along solver-frame axis (0/1/2). Push 2b adds stress. */
NonlinearSolverFull.prototype.crushStrain = async function (axis, opts) {
  opts = opts || {};
  var epsTarget = opts.epsTarget != null ? opts.epsTarget : 0.02;
  var nSteps = opts.nSteps != null ? opts.nSteps : 16;
  var cutbackMax = opts.cutbackMax != null ? opts.cutbackMax : 4;
  var es = this.es, d = es.device;
  var curve = [], dStep = epsTarget / nSteps, eAxis = 0, step = 0, E0 = null;
  var eb = [0,0,0,0,0,0];

  while (step < nSteps) {
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

NonlinearSolverFull.prototype.destroy = function () { this.es.destroy(); };


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

  var c = nonlinearCrushCPU(recipe, N, axis, { control: 'strain', epsTarget: 0.02, nSteps: 10 });
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
  var relax = opts.macroRelax != null ? opts.macroRelax : 0.85;
  var es = this.es, d = es.device;

  var C = await this._ensureElasticMacro();
  var freeIdx = []; for (var i = 0; i < 6; i++) if (i !== axis) freeIdx.push(i);
  var nf = freeIdx.length;
  var Kff = new Float64Array(nf * nf);
  for (var a = 0; a < nf; a++) for (var b = 0; b < nf; b++) Kff[a * nf + b] = C[freeIdx[a] * 6 + freeIdx[b]];
  var Sff = invertSmall(Kff, nf);
  var Cfa = new Float64Array(nf);
  for (var ci = 0; ci < nf; ci++) Cfa[ci] = C[freeIdx[ci] * 6 + axis];
  var S6 = invert6x6(C);
  var E0 = S6 ? 1 / S6[axis * 6 + axis] : null;

  var curve = [], dStep = epsTarget / nSteps, eAxis = 0, step = 0;
  var eb = [0, 0, 0, 0, 0, 0];

  while (step < nSteps) {
    /* snapshot strain + committed history for cutback and macro-loop baseline */
    var encS = d.createCommandEncoder();
    es._copyPair(encS, es.eps, { n: this.snap_n, s: this.snap_s });
    es._copyPair(encS, { n: this.epp_n, s: this.epp_s }, { n: this.snapEpp_n, s: this.snapEpp_s });
    d.queue.submit([encS.finish()]);

    var trial = eAxis + dStep, ok = false, res = null, cut = 0;
    while (cut <= cutbackMax) {
      eb[axis] = trial;
      /* warm-start: keep the previous step's converged free lateral strains
         (carried in eb across steps and cutbacks) — mirrors the 16f oracle.
         No elastic reseed: in deep plasticity the elastic guess is wrong
         (near-incompressible flow) and destabilizes the field Newton. */
      var fieldDiverged = false;
      for (var mit = 0; mit < macroMax; mit++) {
        /* hold committed history at the previous load step through the macro loop */
        var encB = d.createCommandEncoder();
        es._copyPair(encB, { n: this.snapEpp_n, s: this.snapEpp_s }, { n: this.epp_n, s: this.epp_s });
        d.queue.submit([encB.finish()]);
        res = await this.newtonSolve(eb);
        if (!res.converged) { fieldDiverged = true; break; }
        var sn = 0, sref = Math.max(Math.abs(res.sigma_bar[axis]), 1e-6);
        for (var f = 0; f < nf; f++) { var sv = res.sigma_bar[freeIdx[f]]; sn += sv * sv; }
        if (Math.sqrt(sn) / sref < macroTol) break;   /* lateral stress ~ 0: macro converged */
        for (var r = 0; r < nf; r++) {
          var dd = 0; for (var c = 0; c < nf; c++) dd += Sff[r * nf + c] * res.sigma_bar[freeIdx[c]];
          eb[freeIdx[r]] -= dd;
        }
      }
      /* Accept whenever the FIELD Newton converged. A macro-tolerance miss is
         benign (lateral stress is already small; f32 + low axial stress can keep
         it above a tight relative tol). Cut back ONLY on field divergence —
         matches the 16f oracle. */
      if (!fieldDiverged) { ok = true; break; }
      var encR = d.createCommandEncoder();
      es._copyPair(encR, { n: this.snap_n, s: this.snap_s }, es.eps);
      es._copyPair(encR, { n: this.snapEpp_n, s: this.snapEpp_s }, { n: this.epp_n, s: this.epp_s });
      d.queue.submit([encR.finish()]);
      dStep *= 0.5; trial = eAxis + dStep; cut++;
    }
    if (!ok) {
      console.warn('[crush] field Newton diverged @ step ' + (step + 1) + ' eAxis=' + eAxis.toFixed(5) + ' trial=' + trial.toFixed(5) +
                   ' relRes=' + (res ? res.relRes.toExponential(2) : 'n/a') + ' newt=' + (res ? res.newtonIters : 0) + ' cg=' + (res ? res.totalCgIters : 0));
      /* salvage: if the curve already passed the 0.2% offset knee, the yield is
         determined — return it rather than discarding a usable result. */
      var sySalv = nlOffsetYield(curve, E0, 0.002);
      var pastKnee = (sySalv != null && curve.length >= 2 && eAxis > 0.002 + sySalv / Math.max(E0, 1));
      if (pastKnee) {
        console.warn('[crush] salvaged sigma_y_eff=' + sySalv.toFixed(1) + ' MPa from ' + curve.length + ' steps (truncated at eps=' + eAxis.toFixed(4) + ')');
        return { rho: this.rho, axis: axis, control: 'stress', curve: curve, sigma_y_eff: sySalv, E0: E0, N: this.N, truncated: true, atStep: step + 1, eAxisMax: eAxis };
      }
      return { error: 'newton_diverged', rho: this.rho, curve: curve, axis: axis, atStep: step + 1, eAxis: eAxis, lastRelRes: res ? res.relRes : null };
    }
    eAxis = trial;
    curve.push({ eps: eAxis, sigma: res.sigma_bar[axis] });
    if (verbose) console.log('[crush] step ' + (step + 1) + '/' + nSteps + '  eps=' + eAxis.toFixed(5) + '  sig=' + res.sigma_bar[axis].toFixed(1) +
                             ' MPa  macro=' + (mit + 1) + '  newt=' + res.newtonIters + '  cg=' + res.totalCgIters + '  relRes=' + res.relRes.toExponential(2));
    step++;
  }
  var sigmaY = nlOffsetYield(curve, E0, 0.002);
  return { rho: this.rho, axis: axis, control: 'stress', curve: curve, sigma_y_eff: sigmaY, E0: E0, N: this.N };
};


/* Public crush entry — physical axis (0=xx,1=yy,2=zz). Maps to the
   solver-internal frame via SWAP=[2,1,0,5,4,3] (matches 16b). */
NonlinearSolverFull.prototype.crush = async function (physicalAxis, opts) {
  opts = opts || {};
  var SWAP = [2, 1, 0, 5, 4, 3];
  var axInternal = SWAP[physicalAxis];
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
