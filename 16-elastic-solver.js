/* ============================================================
   F13LD.lab · 16-elastic-solver.js
   GPU-resident linear elastic FFT-CG homogenization.

   Mirrors F13LD.sweep's cgSolveNormal architecture, ported to
   WGSL.  Three normal load cases (xx, yy, zz) → 3×3 normal
   stiffness block → invert for Ex, Ey, Ez.  Reuses FFTPlan
   from Phase 2 via the encoded API (forwardEncoded /
   inverseEncoded / loadFromBuffer / storeToBuffer).

   CG iteration per load case:
     init: eps = b = uniform macroscopic strain
     loop:
       Ap = applyA(p)       — 6 FFTs + small kernels per call
       pAp = dot(p, Ap)     — reduction
       alpha = rr / pAp
       eps += alpha * p
       r   -= alpha * Ap
       rrNew = dot(r, r)
       if sqrt(rrNew)/bNorm < CG_TOL: break
       beta = rrNew / rr
       p = r + beta * p
       rr = rrNew
   ============================================================ */


/* ══ Solver constants — matched to F13LD.sweep v0.16.0 rigorous mode ══
   A.1.8 (2026-05) — relaxed from 1e-5/100 to match sweep's rigorous-mode
   parameters after the A.1.7 buildGamma textbook fix made the Γ operator
   stiffer-conditioned (correct physics, but harder to invert at the
   1e-4 contrast we use between solid Es and void Es·1e-4).

   Sweep production tolerances:
     · "fast"     mode: tol = 1e-3
     · "rigorous" mode: tol = 1e-4   ← Lab matches this
   Lab uses rigorous-mode tolerance by default since it solves only 3
   designs per run (vs sweep's thousands), so the precision/time
   tradeoff favors rigor.

   Iter cap of 300 buffers comfortably above the typical converged-iter
   count (~100-200 per LC for stiff-contrast TPMS at the textbook Γ).
   ════════════════════════════════════════════════════════════════════ */
var CG_TOL     = 1e-4;
var CG_MAXITER = 300;


/* ════════════════════════════════════════════════════════════
   Inline CPU FFT helpers — used by extractFieldsForLC to
   reconstruct u'(x) from the GPU-converged ε(x).  Operates on
   interleaved Float64 complex arrays [re, im, re, im, ...].
   Self-contained (duplicates 18-stokes-cpu-ref.js's fft routines)
   to keep this push free of cross-file load-order dependencies.
   ════════════════════════════════════════════════════════════ */

function _es_fft1d(x, inverse) {
  var n = x.length >> 1;
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      var t = x[2*i]; x[2*i] = x[2*j]; x[2*j] = t;
      t = x[2*i+1]; x[2*i+1] = x[2*j+1]; x[2*j+1] = t;
    }
  }
  var sign = inverse ? 1 : -1;
  for (var len = 2; len <= n; len <<= 1) {
    var ang = sign * 2 * Math.PI / len;
    var wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (var i2 = 0; i2 < n; i2 += len) {
      var curRe = 1, curIm = 0;
      var halfLen = len >> 1;
      for (var jj = 0; jj < halfLen; jj++) {
        var uRe = x[2*(i2+jj)],         uIm = x[2*(i2+jj)+1];
        var vRe = x[2*(i2+jj+halfLen)], vIm = x[2*(i2+jj+halfLen)+1];
        var tvRe = curRe*vRe - curIm*vIm;
        var tvIm = curRe*vIm + curIm*vRe;
        x[2*(i2+jj)]           = uRe + tvRe;
        x[2*(i2+jj)+1]         = uIm + tvIm;
        x[2*(i2+jj+halfLen)]   = uRe - tvRe;
        x[2*(i2+jj+halfLen)+1] = uIm - tvIm;
        var newRe = curRe*wRe - curIm*wIm;
        curIm = curRe*wIm + curIm*wRe;
        curRe = newRe;
      }
    }
  }
  if (inverse) for (var k = 0; k < x.length; k++) x[k] /= n;
}

/* In-place 3D FFT for the (i,j,k) layout used by the elastic solver:
   idx = i*N² + j*N + k with (i,j,k) = (x,y,z).  Sweeps along each
   axis using the supplied lineBuf scratch buffer. */
function _es_fft3d(data, N, inverse, lineBuf) {
  var buf = lineBuf || new Float64Array(2 * N);
  var i, j, k;
  /* axis i (slowest in storage) */
  for (j = 0; j < N; j++) for (k = 0; k < N; k++) {
    for (i = 0; i < N; i++) { buf[2*i] = data[2*(i*N*N+j*N+k)]; buf[2*i+1] = data[2*(i*N*N+j*N+k)+1]; }
    _es_fft1d(buf, inverse);
    for (i = 0; i < N; i++) { data[2*(i*N*N+j*N+k)] = buf[2*i]; data[2*(i*N*N+j*N+k)+1] = buf[2*i+1]; }
  }
  /* axis j */
  for (i = 0; i < N; i++) for (k = 0; k < N; k++) {
    for (j = 0; j < N; j++) { buf[2*j] = data[2*(i*N*N+j*N+k)]; buf[2*j+1] = data[2*(i*N*N+j*N+k)+1]; }
    _es_fft1d(buf, inverse);
    for (j = 0; j < N; j++) { data[2*(i*N*N+j*N+k)] = buf[2*j]; data[2*(i*N*N+j*N+k)+1] = buf[2*j+1]; }
  }
  /* axis k (fastest in storage) */
  for (i = 0; i < N; i++) for (j = 0; j < N; j++) {
    for (k = 0; k < N; k++) { buf[2*k] = data[2*(i*N*N+j*N+k)]; buf[2*k+1] = data[2*(i*N*N+j*N+k)+1]; }
    _es_fft1d(buf, inverse);
    for (k = 0; k < N; k++) { data[2*(i*N*N+j*N+k)] = buf[2*k]; data[2*(i*N*N+j*N+k)+1] = buf[2*k+1]; }
  }
}


/* ════════════════════════════════════════════════════════════
   WGSL kernels
   ════════════════════════════════════════════════════════════ */

/* Common uniform layout for the elastic kernels.  vec4 rows so
   each entry is 16-byte aligned (WGSL uniform struct rules).
     C_*_row{0,1,2}   — 3×3 normal blocks of solid / void / reference stiffness
     total            — N³ (loop guard)
     bNorm            — uniform macroscopic strain RMS (used in convergence calc)
   For storage simplicity all three tensors live in one struct.
   178 bytes raw → padded to 192. */
var ELASTIC_PARAMS_WGSL =
'struct ElasticParams {\n' +
'  C_s_row0: vec4<f32>, C_s_row1: vec4<f32>, C_s_row2: vec4<f32>,\n' +
'  C_v_row0: vec4<f32>, C_v_row1: vec4<f32>, C_v_row2: vec4<f32>,\n' +
'  C_0_row0: vec4<f32>, C_0_row1: vec4<f32>, C_0_row2: vec4<f32>,\n' +
'  total: u32, _pad0: u32, _pad1: u32, _pad2: u32,\n' +
'}\n';

/* localStress: per voxel pick C from solid mask, multiply 3-strain by C-normal-block.
   sig[p] = Σ_q C_pq * eps[q]  for p,q ∈ {xx, yy, zz} */
var LOCAL_STRESS_WGSL = ELASTIC_PARAMS_WGSL +
'@group(0) @binding(0) var<storage, read>       solid:  array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       eps_xx: array<f32>;\n' +
'@group(0) @binding(2) var<storage, read>       eps_yy: array<f32>;\n' +
'@group(0) @binding(3) var<storage, read>       eps_zz: array<f32>;\n' +
'@group(0) @binding(4) var<storage, read_write> sig_xx: array<f32>;\n' +
'@group(0) @binding(5) var<storage, read_write> sig_yy: array<f32>;\n' +
'@group(0) @binding(6) var<storage, read_write> sig_zz: array<f32>;\n' +
'@group(0) @binding(7) var<uniform>             P: ElasticParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn local_stress(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let isSolid = solid[i] > 0.5;\n' +
'  let r0 = select(P.C_v_row0.xyz, P.C_s_row0.xyz, isSolid);\n' +
'  let r1 = select(P.C_v_row1.xyz, P.C_s_row1.xyz, isSolid);\n' +
'  let r2 = select(P.C_v_row2.xyz, P.C_s_row2.xyz, isSolid);\n' +
'  let e  = vec3<f32>(eps_xx[i], eps_yy[i], eps_zz[i]);\n' +
'  sig_xx[i] = dot(r0, e);\n' +
'  sig_yy[i] = dot(r1, e);\n' +
'  sig_zz[i] = dot(r2, e);\n' +
'}\n';

/* tauCompute: tau = sig − C0:eps  (polarization stress) */
var TAU_COMPUTE_WGSL = ELASTIC_PARAMS_WGSL +
'@group(0) @binding(0) var<storage, read>       eps_xx: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       eps_yy: array<f32>;\n' +
'@group(0) @binding(2) var<storage, read>       eps_zz: array<f32>;\n' +
'@group(0) @binding(3) var<storage, read>       sig_xx: array<f32>;\n' +
'@group(0) @binding(4) var<storage, read>       sig_yy: array<f32>;\n' +
'@group(0) @binding(5) var<storage, read>       sig_zz: array<f32>;\n' +
'@group(0) @binding(6) var<storage, read_write> tau_xx: array<f32>;\n' +
'@group(0) @binding(7) var<storage, read_write> tau_yy: array<f32>;\n' +
'@group(0) @binding(8) var<storage, read_write> tau_zz: array<f32>;\n' +
'@group(0) @binding(9) var<uniform>             P: ElasticParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn tau_compute(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let e = vec3<f32>(eps_xx[i], eps_yy[i], eps_zz[i]);\n' +
'  tau_xx[i] = sig_xx[i] - dot(P.C_0_row0.xyz, e);\n' +
'  tau_yy[i] = sig_yy[i] - dot(P.C_0_row1.xyz, e);\n' +
'  tau_zz[i] = sig_zz[i] - dot(P.C_0_row2.xyz, e);\n' +
'}\n';

/* packComplex: real → complex with im=0, written into FFTPlan's bufA via
   storeToBuffer in the orchestration layer.  We pack into a separate complex
   scratch buffer so the FFT can copy from there. */
var PACK_COMPLEX_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       in_real:  array<f32>;\n' +
'@group(0) @binding(1) var<storage, read_write> out_cmpx: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn pack_complex(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  out_cmpx[i] = vec2<f32>(in_real[i], 0.0);\n' +
'}\n';

/* gammaAccum: out_hat[p] = Σ_q Γ[p][q] * tau_hat[q]  for one row p of Γ.
   Three bind groups (one per p), each pointing to a different Γ row triple. */
var GAMMA_ACCUM_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       th_xx: array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       th_yy: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       th_zz: array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       g0:    array<f32>;\n' +
'@group(0) @binding(4) var<storage, read>       g1:    array<f32>;\n' +
'@group(0) @binding(5) var<storage, read>       g2:    array<f32>;\n' +
'@group(0) @binding(6) var<storage, read_write> out_h: array<vec2<f32>>;\n' +
'@group(0) @binding(7) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn gamma_accum(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  out_h[i] = g0[i] * th_xx[i] + g1[i] * th_yy[i] + g2[i] * th_zz[i];\n' +
'}\n';

/* deAccum: out = eps + Re(deps_complex)  (final assembly of A:p result) */
var DEACCUM_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       eps_in:  array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       deps_c:  array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> eps_out: array<f32>;\n' +
'@group(0) @binding(3) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn de_accum(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  eps_out[i] = eps_in[i] + deps_c[i].x;\n' +
'}\n';

/* axpy: y += alpha * x   (alpha in uniform; sign handled by caller) */
var AXPY_WGSL =
'struct AxpyParams { alpha: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read_write> y: array<f32>;\n' +
'@group(0) @binding(2) var<uniform>             P: AxpyParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn axpy(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y[i] = P.alpha * x[i] + y[i];\n' +
'}\n';

/* xbpy: y = x + beta * y   (CG search-direction update p = r + β·p) */
var XBPY_WGSL =
'struct XbpyParams { beta: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       x: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read_write> y: array<f32>;\n' +
'@group(0) @binding(2) var<uniform>             P: XbpyParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn xbpy(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y[i] = x[i] + P.beta * y[i];\n' +
'}\n';

/* fillScalar: in-place fill with a uniform scalar (used for eps = b init) */
var FILL_WGSL =
'struct FillParams { value: f32, total: u32, _p0: u32, _p1: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> y: array<f32>;\n' +
'@group(0) @binding(1) var<uniform>             P: FillParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn fill(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  y[i] = P.value;\n' +
'}\n';

/* dotReduce: tree reduction of  Σ_i (a_xx·b_xx + a_yy·b_yy + a_zz·b_zz)[i]
   into per-workgroup partial sums.  CPU sums the partials (small). */
var DOT_REDUCE_WGSL =
'struct ReduceParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       a_xx: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       a_yy: array<f32>;\n' +
'@group(0) @binding(2) var<storage, read>       a_zz: array<f32>;\n' +
'@group(0) @binding(3) var<storage, read>       b_xx: array<f32>;\n' +
'@group(0) @binding(4) var<storage, read>       b_yy: array<f32>;\n' +
'@group(0) @binding(5) var<storage, read>       b_zz: array<f32>;\n' +
'@group(0) @binding(6) var<storage, read_write> partials: array<f32>;\n' +
'@group(0) @binding(7) var<uniform>             P: ReduceParams;\n' +
'\n' +
'var<workgroup> shared_buf: array<f32, 256>;\n' +
'\n' +
'@compute @workgroup_size(256)\n' +
'fn reduce(@builtin(global_invocation_id) gid: vec3<u32>,\n' +
'          @builtin(local_invocation_id) lid: vec3<u32>,\n' +
'          @builtin(workgroup_id) wgid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  var v: f32 = 0.0;\n' +
'  if (i < P.total) {\n' +
'    v = a_xx[i]*b_xx[i] + a_yy[i]*b_yy[i] + a_zz[i]*b_zz[i];\n' +
'  }\n' +
'  shared_buf[lid.x] = v;\n' +
'  workgroupBarrier();\n' +
'\n' +
'  var stride: u32 = 128u;\n' +
'  loop {\n' +
'    if (stride == 0u) { break; }\n' +
'    if (lid.x < stride) {\n' +
'      shared_buf[lid.x] = shared_buf[lid.x] + shared_buf[lid.x + stride];\n' +
'    }\n' +
'    workgroupBarrier();\n' +
'    stride = stride >> 1u;\n' +
'  }\n' +
'\n' +
'  if (lid.x == 0u) {\n' +
'    partials[wgid.x] = shared_buf[0];\n' +
'  }\n' +
'}\n';


/* ════════════════════════════════════════════════════════════
   ElasticSolver
   ════════════════════════════════════════════════════════════ */

function ElasticSolver(N, fftPlan){
  this.N = N;
  this.N3 = N * N * N;
  this.realSize = 4 * this.N3;          /* Float32 buffer size */
  this.cmplxSize = 8 * this.N3;         /* vec2<f32> buffer size */
  this.fft = fftPlan;
  this.device = WGPU.device;
  if (!this.device) throw new Error('ElasticSolver: WebGPU device not initialized');
  if (this.fft.N !== N) throw new Error('ElasticSolver: FFT plan size mismatch');

  /* Reduction layout: 256 threads per workgroup */
  this.WG_SIZE_REDUCE = 256;
  this.partialCount   = Math.ceil(this.N3 / this.WG_SIZE_REDUCE);

  this._buildPipelines();
  this._allocateBuffers();
  this._allocateUniforms();
  this._allocateBindGroupCaches();
}


/* ── Pipeline construction ───────────────────────────────────────── */
ElasticSolver.prototype._buildPipelines = function(){
  var d = this.device;
  function ro(b)   { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }; }
  function rw(b)   { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }; }
  function uni(b)  { return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }; }

  /* localStress: 7 storage bindings + 1 uniform */
  this.lsLayout = d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), ro(3), rw(4), rw(5), rw(6), uni(7)] });
  this.lsPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.lsLayout] }),
    compute: { module: d.createShaderModule({ code: LOCAL_STRESS_WGSL }), entryPoint: 'local_stress' }
  });

  /* tauCompute: 9 storage + 1 uniform */
  this.tcLayout = d.createBindGroupLayout({ entries: [ro(0),ro(1),ro(2),ro(3),ro(4),ro(5),rw(6),rw(7),rw(8),uni(9)] });
  this.tcPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.tcLayout] }),
    compute: { module: d.createShaderModule({ code: TAU_COMPUTE_WGSL }), entryPoint: 'tau_compute' }
  });

  /* packComplex: 1 ro + 1 rw + 1 uni */
  this.pcLayout = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.pcPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.pcLayout] }),
    compute: { module: d.createShaderModule({ code: PACK_COMPLEX_WGSL }), entryPoint: 'pack_complex' }
  });

  /* gammaAccum: 6 ro + 1 rw + 1 uni */
  this.gaLayout = d.createBindGroupLayout({ entries: [ro(0),ro(1),ro(2),ro(3),ro(4),ro(5),rw(6),uni(7)] });
  this.gaPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.gaLayout] }),
    compute: { module: d.createShaderModule({ code: GAMMA_ACCUM_WGSL }), entryPoint: 'gamma_accum' }
  });

  /* deAccum: 2 ro + 1 rw + 1 uni */
  this.daLayout = d.createBindGroupLayout({ entries: [ro(0), ro(1), rw(2), uni(3)] });
  this.daPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.daLayout] }),
    compute: { module: d.createShaderModule({ code: DEACCUM_WGSL }), entryPoint: 'de_accum' }
  });

  /* axpy / xbpy: 1 ro + 1 rw + 1 uni  (same layout) */
  this.axLayout = d.createBindGroupLayout({ entries: [ro(0), rw(1), uni(2)] });
  this.axPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.axLayout] }),
    compute: { module: d.createShaderModule({ code: AXPY_WGSL }), entryPoint: 'axpy' }
  });
  this.xbpyPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.axLayout] }),
    compute: { module: d.createShaderModule({ code: XBPY_WGSL }), entryPoint: 'xbpy' }
  });

  /* fill: 1 rw + 1 uni */
  this.fillLayout = d.createBindGroupLayout({ entries: [rw(0), uni(1)] });
  this.fillPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.fillLayout] }),
    compute: { module: d.createShaderModule({ code: FILL_WGSL }), entryPoint: 'fill' }
  });

  /* dotReduce: 6 ro + 1 rw + 1 uni */
  this.drLayout = d.createBindGroupLayout({ entries: [ro(0),ro(1),ro(2),ro(3),ro(4),ro(5),rw(6),uni(7)] });
  this.drPipeline = d.createComputePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [this.drLayout] }),
    compute: { module: d.createShaderModule({ code: DOT_REDUCE_WGSL }), entryPoint: 'reduce' }
  });
};


/* ── Buffer allocation ──────────────────────────────────────────── */
ElasticSolver.prototype._allocateBuffers = function(){
  var d = this.device;
  var BU = GPUBufferUsage;
  var R = this.realSize, C = this.cmplxSize;

  function rbuf() { return d.createBuffer({ size: R, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function cbuf() { return d.createBuffer({ size: C, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }

  /* Solid mask (uploaded per design) */
  this.solidBuf = rbuf();

  /* Per-component triples — eps, b, r, p, Ap state buffers */
  this.eps = [rbuf(), rbuf(), rbuf()];
  this.b   = [rbuf(), rbuf(), rbuf()];
  this.r   = [rbuf(), rbuf(), rbuf()];
  this.p   = [rbuf(), rbuf(), rbuf()];
  this.Ap  = [rbuf(), rbuf(), rbuf()];

  /* applyA scratch */
  this.sig    = [rbuf(), rbuf(), rbuf()];
  this.tau    = [rbuf(), rbuf(), rbuf()];
  this.tauCmplx = [cbuf(), cbuf(), cbuf()];     /* real-packed tau, before FFT */
  this.tauHat = [cbuf(), cbuf(), cbuf()];       /* freq-space tau (after forward FFT) */
  this.depsHat = [cbuf(), cbuf(), cbuf()];      /* freq-space accumulated Γ:tau, per output p */
  this.depsC   = [cbuf(), cbuf(), cbuf()];      /* real-space deps (after IFFT) */

  /* Γ buffers: 9 real-space (one per (p,q) pair) — uploaded per design */
  this.gamma = [
    [rbuf(), rbuf(), rbuf()],
    [rbuf(), rbuf(), rbuf()],
    [rbuf(), rbuf(), rbuf()]
  ];

  /* Reduction partials + readback staging */
  this.partialsBuf = d.createBuffer({
    size:  Math.max(this.partialCount * 4, 256),
    usage: BU.STORAGE | BU.COPY_SRC
  });
  this.readbackBuf = d.createBuffer({
    size:  Math.max(this.partialCount * 4, 256),
    usage: BU.COPY_DST | BU.MAP_READ
  });
};


/* ── Uniform buffers + parameter writing ────────────────────────── */
ElasticSolver.prototype._allocateUniforms = function(){
  var d = this.device;
  var BU = GPUBufferUsage;

  /* ElasticParams — 192 bytes (12 vec4 + 4 u32 padded) */
  this.elasticParamsBuf = d.createBuffer({ size: 192, usage: BU.UNIFORM | BU.COPY_DST });

  /* SizeParams (16 bytes) — shared by packComplex, gammaAccum, deAccum, dotReduce */
  this.sizeParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  d.queue.writeBuffer(this.sizeParamsBuf, 0, new Uint32Array([this.N3, 0, 0, 0]));

  /* AXPY / XBPY uniforms — alpha (or beta) varies per CG iter */
  this.axpyParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  this.xbpyParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* Fill — used to seed eps = uniform strain */
  this.fillParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
};

/* Write the elastic-params uniform (C_s, C_v, C_0).  Called once per design. */
ElasticSolver.prototype._writeElasticParams = function(C_s, C_v, C_0){
  /* Lay out as 9 vec4<f32> (rows of 3 stiffness tensors) + 4 u32 trailer */
  var buf = new ArrayBuffer(192);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf, 144, 4);
  /* C_s rows (normal block: indices 0,1,2 / 6,7,8 / 12,13,14 in Voigt 6×6 row-major) */
  function row(C, p) { return [C[p*6+0], C[p*6+1], C[p*6+2], 0]; }
  var src = [].concat(
    row(C_s, 0), row(C_s, 1), row(C_s, 2),
    row(C_v, 0), row(C_v, 1), row(C_v, 2),
    row(C_0, 0), row(C_0, 1), row(C_0, 2)
  );
  for (var i = 0; i < 36; i++) f[i] = src[i];
  u[0] = this.N3; u[1] = 0; u[2] = 0; u[3] = 0;
  this.device.queue.writeBuffer(this.elasticParamsBuf, 0, buf);
};

ElasticSolver.prototype._writeAxpy = function(alpha){
  var buf = new ArrayBuffer(16);
  new Float32Array(buf, 0, 1)[0] = alpha;
  new Uint32Array(buf, 4, 3)[0]  = this.N3;
  this.device.queue.writeBuffer(this.axpyParamsBuf, 0, buf);
};
ElasticSolver.prototype._writeXbpy = function(beta){
  var buf = new ArrayBuffer(16);
  new Float32Array(buf, 0, 1)[0] = beta;
  new Uint32Array(buf, 4, 3)[0]  = this.N3;
  this.device.queue.writeBuffer(this.xbpyParamsBuf, 0, buf);
};
ElasticSolver.prototype._writeFill = function(value){
  var buf = new ArrayBuffer(16);
  new Float32Array(buf, 0, 1)[0] = value;
  new Uint32Array(buf, 4, 3)[0]  = this.N3;
  this.device.queue.writeBuffer(this.fillParamsBuf, 0, buf);
};


/* ── Bind group caches — built once on construction.
       The CG loop swaps in/out the eps/r/p/Ap triples by index, so we
       cache one bind group per (kernel × triple-permutation) we need. */
ElasticSolver.prototype._allocateBindGroupCaches = function(){
  /* These get built lazily during CG iteration.  They're cheap to create
     (no new GPU memory; just metadata) so caching to nothing keeps the
     elastic solver simpler.  If profiling shows bind group creation as
     a bottleneck we can pre-bake here. */
};


/* ── Per-design upload: solid mask, stiffness params, Γ buffers ─── */
ElasticSolver.prototype.uploadDesign = function(solid_f32, gammaArr, C_s, C_v, C_0){
  var d = this.device;
  /* Solid mask */
  d.queue.writeBuffer(this.solidBuf, 0, solid_f32);
  /* Γ (9 buffers) — gammaArr is [[Γ00,Γ01,Γ02],[...],[...]] of Float64 */
  for (var p = 0; p < 3; p++) {
    for (var q = 0; q < 3; q++) {
      /* Convert to Float32 for GPU storage */
      var src = gammaArr[p][q];
      var f32 = new Float32Array(src.length);
      for (var k = 0; k < src.length; k++) f32[k] = src[k];
      d.queue.writeBuffer(this.gamma[p][q], 0, f32);
    }
  }
  /* Stiffness uniform */
  this._writeElasticParams(C_s, C_v, C_0);
};


/* ── Encoded operations — append a kernel dispatch to an encoder ── */
ElasticSolver.prototype._dispatchEncoded = function(enc, pipeline, bg, threadCount, wgSize){
  var pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(threadCount / wgSize), 1, 1);
  pass.end();
};


/* ── applyA: out_xx,yy,zz = epsIn + Γ:(C(x):epsIn − C0:epsIn)
       Inputs and outputs are 3-tuples of GPU Float32 buffers.
       All operations append to `enc`; caller submits. */
ElasticSolver.prototype._applyA = function(enc, epsIn, out){
  var d = this.device;
  /* 1. localStress — sig = C(x):eps */
  var lsBg = d.createBindGroup({
    layout: this.lsLayout,
    entries: [
      { binding: 0, resource: { buffer: this.solidBuf } },
      { binding: 1, resource: { buffer: epsIn[0] } },
      { binding: 2, resource: { buffer: epsIn[1] } },
      { binding: 3, resource: { buffer: epsIn[2] } },
      { binding: 4, resource: { buffer: this.sig[0] } },
      { binding: 5, resource: { buffer: this.sig[1] } },
      { binding: 6, resource: { buffer: this.sig[2] } },
      { binding: 7, resource: { buffer: this.elasticParamsBuf } }
    ]
  });
  this._dispatchEncoded(enc, this.lsPipeline, lsBg, this.N3, 64);

  /* 2. tauCompute — tau = sig − C0:eps */
  var tcBg = d.createBindGroup({
    layout: this.tcLayout,
    entries: [
      { binding: 0, resource: { buffer: epsIn[0] } },
      { binding: 1, resource: { buffer: epsIn[1] } },
      { binding: 2, resource: { buffer: epsIn[2] } },
      { binding: 3, resource: { buffer: this.sig[0] } },
      { binding: 4, resource: { buffer: this.sig[1] } },
      { binding: 5, resource: { buffer: this.sig[2] } },
      { binding: 6, resource: { buffer: this.tau[0] } },
      { binding: 7, resource: { buffer: this.tau[1] } },
      { binding: 8, resource: { buffer: this.tau[2] } },
      { binding: 9, resource: { buffer: this.elasticParamsBuf } }
    ]
  });
  this._dispatchEncoded(enc, this.tcPipeline, tcBg, this.N3, 64);

  /* 3. Pack each tau component as complex, FFT it, store the result.
        After this loop the three tauHat[q] buffers hold forward-FFT(tau[q]). */
  for (var q = 0; q < 3; q++) {
    var pcBg = d.createBindGroup({
      layout: this.pcLayout,
      entries: [
        { binding: 0, resource: { buffer: this.tau[q] } },
        { binding: 1, resource: { buffer: this.tauCmplx[q] } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.pcPipeline, pcBg, this.N3, 64);

    /* Stage into FFTPlan.bufA, run forward, stage out into tauHat[q] */
    this.fft.loadFromBuffer(enc, this.tauCmplx[q]);
    this.fft.forwardEncoded(enc);
    this.fft.storeToBuffer(enc, this.tauHat[q]);
  }

  /* 4. For each output strain component p:
          gammaAccum to depsHat[p], then IFFT, then deAccum: out[p] = epsIn[p] + Re(deps) */
  for (var pp = 0; pp < 3; pp++) {
    var gaBg = d.createBindGroup({
      layout: this.gaLayout,
      entries: [
        { binding: 0, resource: { buffer: this.tauHat[0] } },
        { binding: 1, resource: { buffer: this.tauHat[1] } },
        { binding: 2, resource: { buffer: this.tauHat[2] } },
        { binding: 3, resource: { buffer: this.gamma[pp][0] } },
        { binding: 4, resource: { buffer: this.gamma[pp][1] } },
        { binding: 5, resource: { buffer: this.gamma[pp][2] } },
        { binding: 6, resource: { buffer: this.depsHat[pp] } },
        { binding: 7, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.gaPipeline, gaBg, this.N3, 64);

    this.fft.loadFromBuffer(enc, this.depsHat[pp]);
    this.fft.inverseEncoded(enc);
    this.fft.storeToBuffer(enc, this.depsC[pp]);

    var daBg = d.createBindGroup({
      layout: this.daLayout,
      entries: [
        { binding: 0, resource: { buffer: epsIn[pp] } },
        { binding: 1, resource: { buffer: this.depsC[pp] } },
        { binding: 2, resource: { buffer: out[pp] } },
        { binding: 3, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.daPipeline, daBg, this.N3, 64);
  }
};


/* ── Encoded AXPY: y[*] += alpha · x[*]  for all three components ─
       CRITICAL: never call this twice on the same encoder with different
       alphas.  Each call does one writeBuffer to axpyParamsBuf followed
       by 3 dispatches; sequential writes coalesce (only the last value
       persists), so two back-to-back calls would have both sets of
       dispatches read the second alpha.  Submit between calls. */
ElasticSolver.prototype._axpyTriple = function(enc, alpha, xs, ys){
  this._writeAxpy(alpha);
  for (var c = 0; c < 3; c++){
    var bg = this.device.createBindGroup({
      layout: this.axLayout,
      entries: [
        { binding: 0, resource: { buffer: xs[c] } },
        { binding: 1, resource: { buffer: ys[c] } },
        { binding: 2, resource: { buffer: this.axpyParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.axPipeline, bg, this.N3, 64);
  }
};

/* ── Encoded XBPY: y[*] = x[*] + beta · y[*]  for all three components ──
       Same writeBuffer-coalescing rule as _axpyTriple — one call per encoder. */
ElasticSolver.prototype._xbpyTriple = function(enc, beta, xs, ys){
  this._writeXbpy(beta);
  for (var c = 0; c < 3; c++){
    var bg = this.device.createBindGroup({
      layout: this.axLayout,
      entries: [
        { binding: 0, resource: { buffer: xs[c] } },
        { binding: 1, resource: { buffer: ys[c] } },
        { binding: 2, resource: { buffer: this.xbpyParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.xbpyPipeline, bg, this.N3, 64);
  }
};

/* ── Encoded fill: set all three components of `triple` to `value` ──
       Same writeBuffer-coalescing rule — one call per encoder. */
ElasticSolver.prototype._fillTriple = function(enc, triple, value){
  this._writeFill(value);
  for (var c = 0; c < 3; c++){
    var bg = this.device.createBindGroup({
      layout: this.fillLayout,
      entries: [
        { binding: 0, resource: { buffer: triple[c] } },
        { binding: 1, resource: { buffer: this.fillParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.fillPipeline, bg, this.N3, 256);
  }
};

/* ── Dot product of two triples — async (returns Promise<scalar>) ─ */
ElasticSolver.prototype._dotTriple = async function(a, b){
  var d = this.device;
  var enc = d.createCommandEncoder();
  var bg = d.createBindGroup({
    layout: this.drLayout,
    entries: [
      { binding: 0, resource: { buffer: a[0] } },
      { binding: 1, resource: { buffer: a[1] } },
      { binding: 2, resource: { buffer: a[2] } },
      { binding: 3, resource: { buffer: b[0] } },
      { binding: 4, resource: { buffer: b[1] } },
      { binding: 5, resource: { buffer: b[2] } },
      { binding: 6, resource: { buffer: this.partialsBuf } },
      { binding: 7, resource: { buffer: this.sizeParamsBuf } }
    ]
  });
  var pass = enc.beginComputePass();
  pass.setPipeline(this.drPipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(this.partialCount, 1, 1);
  pass.end();
  enc.copyBufferToBuffer(this.partialsBuf, 0, this.readbackBuf, 0, this.partialCount * 4);
  d.queue.submit([enc.finish()]);

  await this.readbackBuf.mapAsync(GPUMapMode.READ);
  var view = new Float32Array(this.readbackBuf.getMappedRange().slice(0));
  this.readbackBuf.unmap();

  var s = 0;
  for (var i = 0; i < this.partialCount; i++) s += view[i];
  return s;
};


/* ── Read back per-voxel stress and average for the macroscopic response.
       Used after CG converges to compute volume-averaged stress. */
ElasticSolver.prototype._readbackTriple = async function(triple){
  var d = this.device;
  var rb0 = d.createBuffer({ size: this.realSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var rb1 = d.createBuffer({ size: this.realSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var rb2 = d.createBuffer({ size: this.realSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(triple[0], 0, rb0, 0, this.realSize);
  enc.copyBufferToBuffer(triple[1], 0, rb1, 0, this.realSize);
  enc.copyBufferToBuffer(triple[2], 0, rb2, 0, this.realSize);
  d.queue.submit([enc.finish()]);
  await Promise.all([rb0.mapAsync(GPUMapMode.READ), rb1.mapAsync(GPUMapMode.READ), rb2.mapAsync(GPUMapMode.READ)]);
  var a = new Float32Array(rb0.getMappedRange().slice(0));
  var b = new Float32Array(rb1.getMappedRange().slice(0));
  var c = new Float32Array(rb2.getMappedRange().slice(0));
  rb0.unmap(); rb1.unmap(); rb2.unmap();
  rb0.destroy(); rb1.destroy(); rb2.destroy();
  return [a, b, c];
};


/* ════════════════════════════════════════════════════════════
   solveLoadCase — one CG run for a single macroscopic strain.
   eps_bar: [exx, eyy, ezz] (unit vector typically: [1,0,0] etc.)
   opts (optional):
     { captureFields: true } — after CG converges, also extract
        per-voxel u'(x) and σ_VM(x) for this LC by calling
        extractFieldsForLC.  Adds ~30 ms at N=32 (CPU FFT round-trip).
   Returns Promise<{ sigma, iters, converged, breakReason, fields }>
     breakReason: 'converged' | 'max_iter' | 'pAp_zero' | 'pAp_negative'
     fields: null unless opts.captureFields, then
             { u_prime: [Fx,Fy,Fz], sigma_vm: F, N, eps_bar }
   ════════════════════════════════════════════════════════════ */
ElasticSolver.prototype.solveLoadCase = async function(eps_bar, opts){
  var d = this.device;

  /* 1. Initialize eps = b = uniform macroscopic strain.
        IMPORTANT — writeBuffer coalescing: WebGPU's queue executes ops
        in submission order, but multiple writeBuffer calls to the same
        buffer BEFORE a submit get coalesced (only the last value
        persists by dispatch time).  We submit after each writeFill so
        the dispatch sees the correct per-component value. */
  for (var c = 0; c < 3; c++) {
    this._writeFill(eps_bar[c]);
    var encInit = d.createCommandEncoder();
    var bgEps = d.createBindGroup({
      layout: this.fillLayout,
      entries: [{ binding: 0, resource: { buffer: this.eps[c] } }, { binding: 1, resource: { buffer: this.fillParamsBuf } }]
    });
    var bgB = d.createBindGroup({
      layout: this.fillLayout,
      entries: [{ binding: 0, resource: { buffer: this.b[c] } }, { binding: 1, resource: { buffer: this.fillParamsBuf } }]
    });
    var pass1 = encInit.beginComputePass();
    pass1.setPipeline(this.fillPipeline);
    pass1.setBindGroup(0, bgEps);
    pass1.dispatchWorkgroups(Math.ceil(this.N3 / 64), 1, 1);
    pass1.end();
    var pass2 = encInit.beginComputePass();
    pass2.setPipeline(this.fillPipeline);
    pass2.setBindGroup(0, bgB);
    pass2.dispatchWorkgroups(Math.ceil(this.N3 / 64), 1, 1);
    pass2.end();
    d.queue.submit([encInit.finish()]);
  }

  /* bNorm = sqrt(dot(b, b)) — needed for relative residual */
  var bNorm = Math.sqrt(await this._dotTriple(this.b, this.b)) + 1e-30;

  /* 2. r = b - A·eps, then p = r */
  var enc = d.createCommandEncoder();
  this._applyA(enc, this.eps, this.Ap);             /* Ap holds A·eps */
  /* r = b; r -= 1·Ap */
  for (var c2 = 0; c2 < 3; c2++) enc.copyBufferToBuffer(this.b[c2], 0, this.r[c2], 0, this.realSize);
  this._axpyTriple(enc, -1.0, this.Ap, this.r);
  /* p = r */
  for (var c3 = 0; c3 < 3; c3++) enc.copyBufferToBuffer(this.r[c3], 0, this.p[c3], 0, this.realSize);
  d.queue.submit([enc.finish()]);

  var rr = await this._dotTriple(this.r, this.r);
  var iters = 0;
  var converged = false;
  var breakReason = 'max_iter';

  /* 3. CG loop */
  for (var it = 0; it < CG_MAXITER; it++) {
    iters = it + 1;

    /* Ap = A·p */
    var encA = d.createCommandEncoder();
    this._applyA(encA, this.p, this.Ap);
    d.queue.submit([encA.finish()]);

    var pAp = await this._dotTriple(this.p, this.Ap);
    if (Math.abs(pAp) < 1e-30) {
      breakReason = (pAp < 0) ? 'pAp_negative' : 'pAp_zero';
      break;
    }
    var alpha = rr / pAp;

    /* eps += alpha·p,  r -= alpha·Ap
       Two separate submits: each axpy writes alpha to the SAME uniform
       buffer, and we need its dispatches to read the correct value
       before the next write changes it.  See solveLoadCase init for
       the same pattern explanation. */
    var encE = d.createCommandEncoder();
    this._axpyTriple(encE, alpha, this.p, this.eps);
    d.queue.submit([encE.finish()]);

    var encR = d.createCommandEncoder();
    this._axpyTriple(encR, -alpha, this.Ap, this.r);
    d.queue.submit([encR.finish()]);

    var rrNew = await this._dotTriple(this.r, this.r);
    var relRes = Math.sqrt(rrNew) / bNorm;
    if (relRes < CG_TOL) {
      converged = true;
      breakReason = 'converged';
      break;
    }

    var beta = rrNew / rr;
    /* p = r + beta·p */
    var encP = d.createCommandEncoder();
    this._xbpyTriple(encP, beta, this.r, this.p);
    d.queue.submit([encP.finish()]);

    rr = rrNew;
  }

  /* 4. Volume-averaged stress = mean(localStress(eps)) */
  var encS = d.createCommandEncoder();
  /* Reuse applyA's localStress kernel via direct dispatch */
  var lsBg = d.createBindGroup({
    layout: this.lsLayout,
    entries: [
      { binding: 0, resource: { buffer: this.solidBuf } },
      { binding: 1, resource: { buffer: this.eps[0] } },
      { binding: 2, resource: { buffer: this.eps[1] } },
      { binding: 3, resource: { buffer: this.eps[2] } },
      { binding: 4, resource: { buffer: this.sig[0] } },
      { binding: 5, resource: { buffer: this.sig[1] } },
      { binding: 6, resource: { buffer: this.sig[2] } },
      { binding: 7, resource: { buffer: this.elasticParamsBuf } }
    ]
  });
  this._dispatchEncoded(encS, this.lsPipeline, lsBg, this.N3, 64);
  d.queue.submit([encS.finish()]);

  var sigArr = await this._readbackTriple(this.sig);
  var s0 = 0, s1 = 0, s2 = 0;
  for (var i = 0; i < this.N3; i++) { s0 += sigArr[0][i]; s1 += sigArr[1][i]; s2 += sigArr[2][i]; }

  /* Optional per-voxel field extraction.  Done here, before any subsequent
     LC overwrites the eps buffer.  sigArr is already on CPU; pass it in
     so extractFieldsForLC doesn't read the stress buffer twice. */
  var fields = null;
  if (opts && opts.captureFields) {
    fields = await this.extractFieldsForLC(eps_bar, sigArr);
  }

  return {
    sigma: [s0 / this.N3, s1 / this.N3, s2 / this.N3],
    iters: iters,
    converged: converged,
    breakReason: breakReason,
    fields: fields
  };
};


/* ════════════════════════════════════════════════════════════
   homogenize — full 3-load-case run, returns Ex/Ey/Ez + diagnostics.

   opts (optional):
     { captureFieldsLCs: [0, 2] } — array of LC indices (solver-internal,
        0=x, 1=y, 2=z) to capture per-voxel u'(x) and σ_VM(x) for.  Default
        [] (no capture).  Each captured LC adds ~30 ms at N=32 for the
        spectral-inversion field extraction.

     Legacy { captureFieldsLC: 2 } — single int, converted to [2]
        (or [] if int < 0).  Maintained for older test paths.

   ════════════════════════════════════════════════════════════ */
ElasticSolver.prototype.homogenize = async function(opts){
  opts = opts || {};
  /* Normalize captureFieldsLCs to an array of non-negative ints */
  var captureLCs = opts.captureFieldsLCs;
  if (captureLCs == null) {
    if (opts.captureFieldsLC != null) {
      captureLCs = (opts.captureFieldsLC >= 0) ? [opts.captureFieldsLC] : [];
    } else {
      captureLCs = [];
    }
  }
  if (typeof captureLCs === 'number') captureLCs = (captureLCs >= 0) ? [captureLCs] : [];

  var C_eff = [[0,0,0],[0,0,0],[0,0,0]];
  var totalIters = 0;
  var allConverged = true;
  var perLC = [];
  var capturedByLC = {};   /* solver-LC-index → fields */

  for (var lc = 0; lc < 3; lc++) {
    var eps_bar = [lc===0?1:0, lc===1?1:0, lc===2?1:0];
    var lcOpts = (captureLCs.indexOf(lc) >= 0) ? { captureFields: true } : null;
    var res = await this.solveLoadCase(eps_bar, lcOpts);
    if (res.fields) capturedByLC[lc] = res.fields;
    totalIters += res.iters;
    if (!res.converged) allConverged = false;
    for (var p = 0; p < 3; p++) C_eff[p][lc] = res.sigma[p];
    perLC.push({ axis: ['x','y','z'][lc], iters: res.iters, converged: res.converged, breakReason: res.breakReason });
  }
  /* Symmetrise */
  for (var pp = 0; pp < 3; pp++) for (var qq = 0; qq < 3; qq++)
    C_eff[pp][qq] = 0.5 * (C_eff[pp][qq] + C_eff[qq][pp]);

  /* Invert 3×3 normal block → S → diagonal entries → Young's moduli */
  var C = C_eff;
  var det = C[0][0]*(C[1][1]*C[2][2]-C[1][2]*C[2][1])
          - C[0][1]*(C[1][0]*C[2][2]-C[1][2]*C[2][0])
          + C[0][2]*(C[1][0]*C[2][1]-C[1][1]*C[2][0]);
  if (Math.abs(det) < 1e-30) {
    return { Ex: 0, Ey: 0, Ez: 0, C_eff: C_eff, totalIters: totalIters, allConverged: allConverged, valid: false, perLC: perLC, fieldsByLC: capturedByLC };
  }
  var invDet = 1 / det;
  var S00 = (C[1][1]*C[2][2] - C[1][2]*C[2][1]) * invDet;
  var S11 = (C[0][0]*C[2][2] - C[0][2]*C[2][0]) * invDet;
  var S22 = (C[0][0]*C[1][1] - C[0][1]*C[1][0]) * invDet;

  return {
    Ex: 1 / S00, Ey: 1 / S11, Ez: 1 / S22,
    C_eff: C_eff,
    totalIters: totalIters,
    allConverged: allConverged,
    valid: true,
    perLC: perLC,
    fieldsByLC: capturedByLC
  };
};

/* ════════════════════════════════════════════════════════════
   extractFieldsForLC — per-voxel u'(x) and σ_VM(x) for one LC.

   ── AXIS LABELING WARNING ──────────────────────────────────
   This method returns fields in SOLVER-INTERNAL coordinates,
   which differ from the rasterizer's physical-axis labeling
   by an X↔Z swap.  See solveDesignElastic's docstring for the
   full explanation.  Callers that want physical-axis labels
   (Ex along physical X, etc.) should use solveDesignElastic
   which applies the boundary fix; do NOT call this directly
   if you care about physical-axis correspondence.
   ───────────────────────────────────────────────────────────

   Called after solveLoadCase converges, before the next LC
   overwrites the eps/sig buffers.  Reads back ε, computes σ_VM
   from the supplied sigArr (already on CPU after the LC's volume
   average), and reconstructs the displacement fluctuation u' via
   spectral inversion of the strain-displacement relation:

     u'_i(ξ) = ε̂'_ii(ξ) / (i·ξ_i)            (no sum over i)

   ε' = ε - ε̄ subtracts the macroscopic strain.  The ξ_i=0 mode of
   the divisor axis (rigid-body translation, fixed by ⟨u'⟩=0) and
   all Nyquist bins (per Stokes Step 1 lessons — keeps the real-
   valued IFFT well-defined) are zeroed.  Lab cells are 2π in
   solver coordinates so integer wavenumbers map directly.

   σ_VM(x) = √(½)·√[(σxx-σyy)² + (σyy-σzz)² + (σzz-σxx)²]
   Normal-only formulation has zero shear stress, so the standard
   von Mises invariant collapses to this diagonal-only form.

   Cost: 6 N=32³ CPU FFTs ≈ 30 ms.  At N=64 ≈ 240 ms.

   Returns Promise<{ u_prime: [Fx,Fy,Fz], sigma_vm: F, N, eps_bar }>.
   All arrays are Float32Array(N³) in the lab's i*N²+j*N+k storage
   order with (i,j,k) = (x,y,z) in SOLVER coordinates (= z,y,x
   in physical coordinates per the swap noted above).
   ════════════════════════════════════════════════════════════ */
ElasticSolver.prototype.extractFieldsForLC = async function(eps_bar, sigArr){
  var N  = this.N;
  var N3 = this.N3;

  /* 1. Read back per-voxel strain ε for this LC. */
  var epsArr = await this._readbackTriple(this.eps);

  /* 2. σ_VM from sigArr (already CPU-side). */
  var sigma_vm = new Float32Array(N3);
  for (var i = 0; i < N3; i++) {
    var s0 = sigArr[0][i], s1 = sigArr[1][i], s2 = sigArr[2][i];
    var d01 = s0 - s1, d12 = s1 - s2, d20 = s2 - s0;
    sigma_vm[i] = Math.sqrt(0.5 * (d01*d01 + d12*d12 + d20*d20));
  }

  /* 3. u'(x) per component via spectral inversion. */
  var u_prime = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
  var lineBuf = new Float64Array(2 * N);
  var halfN = N >> 1;

  for (var c = 0; c < 3; c++) {
    var ebar = eps_bar[c];
    var src  = epsArr[c];

    /* Pack ε'_cc as complex (real input, imag=0). */
    var work = new Float64Array(2 * N3);
    for (var p = 0; p < N3; p++) {
      work[2*p]     = src[p] - ebar;
      work[2*p + 1] = 0;
    }

    _es_fft3d(work, N, false, lineBuf);

    /* Spectral divide by 1/(i·ξ_c).
       (re + i·im) / (i·ξ) = (im - i·re) / ξ  for real ξ. */
    for (var iX = 0; iX < N; iX++) {
      var kx   = (iX < halfN) ? iX : iX - N;
      var nyqX = (iX === halfN);
      for (var iY = 0; iY < N; iY++) {
        var ky   = (iY < halfN) ? iY : iY - N;
        var nyqY = (iY === halfN);
        for (var iZ = 0; iZ < N; iZ++) {
          var kz   = (iZ < halfN) ? iZ : iZ - N;
          var nyqZ = (iZ === halfN);

          var idx = (iX*N + iY)*N + iZ;
          var ti  = 2 * idx;

          var k_d = (c === 0) ? kx : (c === 1 ? ky : kz);

          if (k_d === 0 || nyqX || nyqY || nyqZ) {
            work[ti] = 0; work[ti+1] = 0;
          } else {
            var re = work[ti], im = work[ti+1];
            var inv = 1 / k_d;
            work[ti]   =  im * inv;
            work[ti+1] = -re * inv;
          }
        }
      }
    }

    _es_fft3d(work, N, true, lineBuf);

    /* Pack real part into output. */
    var dst = u_prime[c];
    for (var q = 0; q < N3; q++) dst[q] = work[2*q];
  }

  return {
    u_prime:  u_prime,
    sigma_vm: sigma_vm,
    N:        N,
    eps_bar:  eps_bar.slice()
  };
};


ElasticSolver.prototype.destroy = function(){
  this.solidBuf.destroy();
  for (var c = 0; c < 3; c++) {
    this.eps[c].destroy(); this.b[c].destroy(); this.r[c].destroy();
    this.p[c].destroy();   this.Ap[c].destroy();
    this.sig[c].destroy(); this.tau[c].destroy();
    this.tauCmplx[c].destroy(); this.tauHat[c].destroy();
    this.depsHat[c].destroy();  this.depsC[c].destroy();
  }
  for (var p = 0; p < 3; p++) for (var q = 0; q < 3; q++) this.gamma[p][q].destroy();
  this.partialsBuf.destroy(); this.readbackBuf.destroy();
  this.elasticParamsBuf.destroy(); this.sizeParamsBuf.destroy();
  this.axpyParamsBuf.destroy(); this.xbpyParamsBuf.destroy();
  this.fillParamsBuf.destroy();
};


/* ════════════════════════════════════════════════════════════
   solveDesignElastic — top-level: take a recipe, return Ex/Ey/Ez
   plus per-voxel u'(x) and σ_VM(x) for one or more chosen LCs.

   ── AXIS LABELING (A.1.5 fix) ──────────────────────────────
   This wrapper applies an X↔Z relabeling at the public-API
   boundary to correct a hidden inconsistency between the
   rasterizer's storage convention and buildGamma's wavenumber
   labeling.  See the A.1.5 docstring block (still in effect)
   for the full physics/coordinate explanation.  Practically:
   solver-internal LC 0 (eps_bar=[1,0,0]) is physical Z loading,
   solver LC 2 is physical X loading, and LC 1 is unchanged.

   ── A.2.2 (2026-05) — multi-axis field capture ─────────────
   captureFieldsLCs was promoted from single int → array of
   physical axes ∈ {0=X, 1=Y, 2=Z}.  Default captures all three
   so the lab raymarcher can toggle load direction without
   re-running the solver.  Cost: ~90 ms added to a ~5 s solve
   (spectral inversion is 3× the per-LC ~30 ms, vs ~1500 ms
   per LC of CG work that runs regardless).

   Legacy { captureFieldsLC: 2 } (single int) still accepted.
   ───────────────────────────────────────────────────────────

   opts (optional):
     { captureFieldsLCs: [0, 1, 2] }  — physical axes to capture
        (default = all three).  Pass [] to skip field extraction
        for solver-only workflows.
     { captureFieldsLC: 2 }            — legacy single-int form.
   ════════════════════════════════════════════════════════════ */
async function solveDesignElastic(recipe, N, opts) {
  if (!WGPU.device) throw new Error('solveDesignElastic: ensureDevice() first');
  opts = opts || {};

  /* Normalize captureFieldsLCs to an array of physical-axis indices. */
  var captureLCs_phys = opts.captureFieldsLCs;
  if (captureLCs_phys == null) {
    if (opts.captureFieldsLC != null) {
      captureLCs_phys = (opts.captureFieldsLC >= 0) ? [opts.captureFieldsLC] : [];
    } else {
      captureLCs_phys = [0, 1, 2];   /* default: capture all three physical axes */
    }
  }
  if (typeof captureLCs_phys === 'number') captureLCs_phys = (captureLCs_phys >= 0) ? [captureLCs_phys] : [];

  /* Translate physical-axis indices to solver-internal LC indices
     via the X↔Z swap (phys 0 = solver 2; phys 2 = solver 0). */
  var captureLCs_solver = captureLCs_phys.map(function(p) { return 2 - p; });

  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);

  var t0 = performance.now();
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt,
                          args.nWeights, args.pipeR, args.phaseShift);
  var tRast = performance.now() - t0;

  /* Volume fraction */
  var inside = 0;
  for (var v = 0; v < solid.length; v++) inside += solid[v];
  var rho = inside / solid.length;

  /* Material */
  var mat = recipe.material || { Es_MPa: 110000, nu: 0.34 };
  var Es = mat.Es_MPa, nu = mat.nu;
  var C_s = isoC(Es, nu);
  var C_v = isoC(Es * 1e-4, nu);   /* small but nonzero void stiffness — same as sweep */
  var C_0 = isoC(Es, nu);          /* solid reference (NOT Voigt-avg — see sweep getElasticGamma rationale) */

  /* Build Γ on CPU (cached lazily by N+Es+nu, rebuilt only if changed) */
  var t1 = performance.now();
  var Gamma = buildGamma(N, C_0[21], C_0[1]);
  var tGamma = performance.now() - t1;

  /* GPU solver — created fresh per design (cheap; reuses FFTPlan device) */
  var fft;
  if (window.__sharedFFT && window.__sharedFFT.N === N) {
    fft = window.__sharedFFT;
  } else {
    if (window.__sharedFFT) window.__sharedFFT.destroy();
    fft = new FFTPlan(N);
    window.__sharedFFT = fft;
  }
  var solver = new ElasticSolver(N, fft);
  solver.uploadDesign(solid, Gamma, C_s, C_v, C_0);

  var t2 = performance.now();
  var hom = await solver.homogenize({ captureFieldsLCs: captureLCs_solver });
  var tCG = performance.now() - t2;

  solver.destroy();   /* keep FFTPlan alive (cached) */

  /* ── A.1.5 + A.2.2 boundary swap on captured fields ──
     Solver returned fieldsByLC keyed by solver-internal LC index.
     Map back to physical-axis labels and apply the X↔Z component
     swap inside each fieldset's u_prime and eps_bar arrays so
     downstream consumers see physical-axis data. */
  var fieldsByAxis = { x: null, y: null, z: null };
  var axisName = ['x', 'y', 'z'];
  if (hom.fieldsByLC) {
    for (var phys = 0; phys < 3; phys++) {
      var solverIdx = 2 - phys;          /* X↔Z swap */
      var f = hom.fieldsByLC[solverIdx];
      if (!f) continue;
      /* Swap u_prime[0] ↔ u_prime[2] and eps_bar[0] ↔ eps_bar[2]
         so the returned fieldset is in physical-axis coordinates. */
      var tmpU = f.u_prime[0];
      f.u_prime[0] = f.u_prime[2];
      f.u_prime[2] = tmpU;
      var tmpE = f.eps_bar[0];
      f.eps_bar[0] = f.eps_bar[2];
      f.eps_bar[2] = tmpE;
      fieldsByAxis[axisName[phys]] = f;
    }
  }

  return {
    name:     recipe.name,
    family:   family,
    mode:     args.mode,
    rho:      rho,
    Ex_MPa:   hom.Ez,           /* X↔Z swap: physical Ex = solver Ez */
    Ey_MPa:   hom.Ey,
    Ez_MPa:   hom.Ex,           /* X↔Z swap: physical Ez = solver Ex */
    Es_MPa:   Es,
    nu:       nu,
    iters:    hom.totalIters,
    converged: hom.allConverged,
    valid:    hom.valid,
    perLC:    hom.perLC,         /* note: perLC labels remain solver-internal — diagnostic only */
    fieldsByAxis: fieldsByAxis,  /* { x, y, z } — each is { u_prime, sigma_vm, N, eps_bar } in PHYSICAL coords, or null */
    tRast_ms: tRast,
    tGamma_ms: tGamma,
    tCG_ms:   tCG
  };
}


/* ════════════════════════════════════════════════════════════
   testFieldsExtraction — console-callable smoke test.
   Runs solveDesignElastic on Schwarz P at N=32 (or whatever N
   you pass), then prints magnitude statistics of the captured
   u' and σ_VM fields and verifies the A.1.5 axis swap is
   correctly applied at the public-API boundary.

   A.2.2 — solveDesignElastic now captures all three physical
   axes by default.  This test inspects the Z fieldset for
   detailed magnitudes/sanity, and confirms X and Y also came
   back with sensible eps_bar (cubic symmetry on Schwarz P
   means magnitudes should match Z to within FP32 precision).

   From the dev console:
     await testFieldsExtraction()       // default N=32, Schwarz P
     await testFieldsExtraction(64)     // higher resolution

   Sanity bands at default Ti-6Al-4V (Es=110 GPa, ν=0.34, ε̄_zz=1)
   AFTER the A.1.7 buildGamma fix:
     Mean |u'|              ~  0.6–1.0   (solver units; cell extent = 2π)
     Max  |u'|              ~  1.0–2.0
     Mean σ_VM              ~  20–60 GPa  (volume includes void)
     Max  σ_VM              ~  150–300 GPa  (stress concentration)
   ════════════════════════════════════════════════════════════ */
async function testFieldsExtraction(N) {
  N = N || 32;
  if (typeof DEMO_RECIPES === 'undefined' || !DEMO_RECIPES.schwarzP) {
    console.error('[fields-test] DEMO_RECIPES.schwarzP not loaded');
    return null;
  }
  if (typeof ensureDevice === 'function') {
    var ok = await ensureDevice();
    if (!ok) { console.error('[fields-test] WebGPU unavailable'); return null; }
  }

  console.log('[fields-test] solving Schwarz P at N=' + N + ' with all-three-axis field capture…');
  var t0 = performance.now();
  var R = await solveDesignElastic(DEMO_RECIPES.schwarzP, N);   /* default = all three */
  var tTotal = performance.now() - t0;

  if (!R.valid) { console.error('[fields-test] solver returned invalid result'); return R; }
  if (!R.fieldsByAxis) { console.error('[fields-test] no fieldsByAxis on result'); return R; }
  if (!R.fieldsByAxis.z) { console.error('[fields-test] Z fields missing'); return R; }

  var f = R.fieldsByAxis.z, N3 = N*N*N;
  var ux = f.u_prime[0], uy = f.u_prime[1], uz = f.u_prime[2], sv = f.sigma_vm;

  /* |u'| stats */
  var sumMag = 0, maxMag = 0, nNonZero = 0;
  var sumX = 0, sumY = 0, sumZ = 0;
  for (var i = 0; i < N3; i++) {
    var ax = Math.abs(ux[i]), ay = Math.abs(uy[i]), az = Math.abs(uz[i]);
    sumX += ax; sumY += ay; sumZ += az;
    var m = Math.sqrt(ux[i]*ux[i] + uy[i]*uy[i] + uz[i]*uz[i]);
    sumMag += m;
    if (m > maxMag) maxMag = m;
    if (m > 1e-12) nNonZero++;
  }
  var meanMag = sumMag / N3;
  var meanX = sumX / N3, meanY = sumY / N3, meanZ = sumZ / N3;

  /* σ_VM stats */
  var svSum = 0, svMax = 0;
  for (var j = 0; j < N3; j++) {
    var s = sv[j];
    svSum += s;
    if (s > svMax) svMax = s;
  }
  var svMean = svSum / N3;

  /* Mean of u' across the cell — should be ≈ 0 by the periodic
     ⟨u'⟩=0 condition we enforce via the ξ=0 spectral zero. */
  var muX = 0, muY = 0, muZ = 0;
  for (var k = 0; k < N3; k++) { muX += ux[k]; muY += uy[k]; muZ += uz[k]; }
  muX /= N3; muY /= N3; muZ /= N3;

  console.group('[fields-test] Schwarz P · N=' + N + ' · physical Z-axis (ε̄=[0,0,1]) · ' + tTotal.toFixed(0) + ' ms');
  console.log('Solver:    Ex=' + (R.Ex_MPa/1000).toFixed(2) + ' GPa  Ey=' + (R.Ey_MPa/1000).toFixed(2) +
              ' GPa  Ez=' + (R.Ez_MPa/1000).toFixed(2) + ' GPa  ρ=' + R.rho.toFixed(3) +
              '  iters=' + R.iters);
  console.log('|u\'|:      mean=' + meanMag.toExponential(3) +
              '  max=' + maxMag.toExponential(3) +
              '  cell extent=2π≈6.283  (max/cell=' + (maxMag/(2*Math.PI)*100).toFixed(2) + '%)');
  console.log('Per-axis:  ⟨|u\'_x|⟩=' + meanX.toExponential(2) +
              '  ⟨|u\'_y|⟩=' + meanY.toExponential(2) +
              '  ⟨|u\'_z|⟩=' + meanZ.toExponential(2));
  console.log('eps_bar:   [' + f.eps_bar[0] + ', ' + f.eps_bar[1] + ', ' + f.eps_bar[2] +
              ']  (should be [0,0,1] for the physical-Z fieldset)');
  console.log('⟨u\'⟩:      [' + muX.toExponential(2) + ', ' + muY.toExponential(2) + ', ' + muZ.toExponential(2) +
              ']  (should be ~1e-11 if ξ=0 zeroed correctly)');
  console.log('σ_VM:      mean=' + (svMean/1000).toFixed(1) + ' GPa  max=' + (svMax/1000).toFixed(1) +
              ' GPa  Es=' + (R.Es_MPa/1000) + ' GPa  (max/Es=' + (svMax/R.Es_MPa).toFixed(2) + '×)');
  console.log('Non-zero |u\'|: ' + nNonZero + ' / ' + N3 + ' voxels (' + (100*nNonZero/N3).toFixed(1) + '%)');

  /* A.2.2 — confirm all three axes captured + correct eps_bar labeling */
  var axisOK = true, axisNotes = [];
  var expected = { x: [1,0,0], y: [0,1,0], z: [0,0,1] };
  ['x','y','z'].forEach(function(ax){
    var fa = R.fieldsByAxis[ax];
    if (!fa) { axisOK = false; axisNotes.push(ax + ': missing'); return; }
    var e = fa.eps_bar, exp = expected[ax];
    if (e[0] !== exp[0] || e[1] !== exp[1] || e[2] !== exp[2]) {
      axisOK = false;
      axisNotes.push(ax + ': eps_bar=[' + e.join(',') + '] expected [' + exp.join(',') + ']');
    }
  });
  console.log('Multi-axis:  ' + (axisOK ? '✓ all three captured with correct eps_bar' : '✗ ' + axisNotes.join(', ')));

  /* Quick pass/fail flags */
  var pass = axisOK, notes = axisOK ? [] : axisNotes.slice();
  if (maxMag < 1e-6)            { pass = false; notes.push('|u\'|_max ≈ 0 — fields not populated'); }
  if (maxMag > 2*Math.PI)       { pass = false; notes.push('|u\'|_max exceeds cell extent — implausible'); }
  if (Math.abs(muX) > 1e-6 || Math.abs(muY) > 1e-6 || Math.abs(muZ) > 1e-6)
                                { pass = false; notes.push('⟨u\'⟩ ≠ 0 — periodic mean not zeroed'); }
  if (svMax < 1)                { pass = false; notes.push('σ_VM,max ≈ 0 — stress field empty'); }
  if (svMax > 100 * R.Es_MPa)   { pass = false; notes.push('σ_VM,max > 100·Es — implausible'); }

  if (pass) console.log('%cPASS', 'color:#4ade80;font-weight:bold');
  else      console.warn('FAIL: ' + notes.join('; '));
  console.groupEnd();

  return R;
}
window.testFieldsExtraction = testFieldsExtraction;
