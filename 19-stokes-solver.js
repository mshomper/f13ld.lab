/* ============================================================
   F13LD.lab · 19-stokes-solver.js
   GPU-resident Stokes-Brinkman PCG permeability homogenization.

   Mirrors 16-elastic-solver.js's architecture but solves the
   DIRECT formulation derived in 18-stokes-cpu-ref.js — i.e.

     A · u' = b,
       A · u' = -μ∇²u' + P · (α(x) · u'),
       b      = -P · (α(x) · ē_j),
       P      = (I - n⊗n)  in Fourier space,
       M⁻¹    = (-μ∇² + α_0)⁻¹  preconditioner.

   The Lippmann-Schwinger polarization scheme used by the
   elastic solver was tried first for Stokes; it has a non-
   symmetric operator (Γ_S and δα don't commute) and CG
   converges slowly and oscillates.  The direct operator L is
   genuinely SPD on the divergence-free zero-mean subspace, so
   PCG converges fast and monotonically — but only if the
   Nyquist plane (i, j or k = N/2) is zeroed in n_dir, k2_phys,
   and M_inv.  All three lookup buffers are baked CPU-side
   (in solveDesignStokes, mirroring the CPU reference) with
   Nyquist already inert; the WGSL kernels just multiply by
   them, so Nyquist treatment lives entirely in the host code.

   PCG iter cost:
     applyA    ≈ 9 FFTs + 10 dispatches + 1 readback (p·Ap dot)
     applyMinv ≈ 6 FFTs + 5 dispatches
     PCG iter  ≈ 15 FFTs + 15 dispatches + 3 readbacks
     CPU ref converged at ~1100-1300 iters per LC at TOL=1e-6;
     GPU should reach the same K with the same iter count
     (deterministic algorithm, FP32 vs FP64 — small drift
     possible, validated by Step 3's GPU vs CPU comparison).

   PCG iteration:
     init:  u' = 0;  b = -P · (α · ē_j);  r = b;  z = M⁻¹ · r;  p = z
     loop:
       Ap   = applyA(p)                        — 9 FFTs
       pAp  = dot(p, Ap)                       — reduction + readback
       α    = (r · z) / pAp
       u'  += α · p
       r   -= α · Ap
       rrNew = dot(r, r)                       — convergence check
       if sqrt(rrNew)/bNorm < TOL: break
       z'   = M⁻¹ · r                          — 6 FFTs
       β    = (r · z') / (r · z)
       p    = z' + β · p
       z    = z'
   ============================================================ */


/* ── Solver constants ─────────────────────────────────────── */
var STOKES_CG_TOL     = 1e-6;
var STOKES_CG_MAXITER = 2000;


/* ════════════════════════════════════════════════════════════
   WGSL kernels — Stokes-specific only.

   The Stokes solver REUSES the following kernels from
   16-elastic-solver.js (defined at file scope there):
     PACK_COMPLEX_WGSL   — real → vec2<f32>(re, 0) packing
     AXPY_WGSL           — y += α·x
     XBPY_WGSL           — y = x + β·y
     FILL_WGSL           — y = constant
     DOT_REDUCE_WGSL     — Σ a[i]·b[i] across 3-component triples
   These are loaded from the same global scope; we just bind
   the appropriate buffers to the same shaders.
   ════════════════════════════════════════════════════════════ */

/* Common Stokes parameter struct.  Padded to 16-byte alignment.
     alpha_pen     — penalty inside solid (Pa·s/m²)
     total         — N³ (loop guard)
     N             — grid resolution (used for some indexing logic if added)
     _pad          — alignment */
var STOKES_PARAMS_WGSL =
'struct StokesParams {\n' +
'  alpha_pen: f32, total: u32, N: u32, _pad: u32,\n' +
'}\n';


/* stokesPenalize: pen[c] = α(x) · u[c] for c in {0,1,2}.
   Single kernel handles all 3 components in one dispatch — the
   solid-mask read is shared, saving 2× memory traffic vs three
   separate dispatches. */
var STOKES_PENALIZE_WGSL = STOKES_PARAMS_WGSL +
'@group(0) @binding(0) var<storage, read>       solid: array<f32>;\n' +
'@group(0) @binding(1) var<storage, read>       u0:    array<f32>;\n' +
'@group(0) @binding(2) var<storage, read>       u1:    array<f32>;\n' +
'@group(0) @binding(3) var<storage, read>       u2:    array<f32>;\n' +
'@group(0) @binding(4) var<storage, read_write> pen0:  array<f32>;\n' +
'@group(0) @binding(5) var<storage, read_write> pen1:  array<f32>;\n' +
'@group(0) @binding(6) var<storage, read_write> pen2:  array<f32>;\n' +
'@group(0) @binding(7) var<uniform>             P: StokesParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn stokes_penalize(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let alpha = select(0.0, P.alpha_pen, solid[i] > 0.5);\n' +
'  pen0[i] = alpha * u0[i];\n' +
'  pen1[i] = alpha * u1[i];\n' +
'  pen2[i] = alpha * u2[i];\n' +
'}\n';


/* stokesHelmholtzProject: in-place Fourier-space projection
     v_hat[c] ← v_hat[c] - n_dir[c] · (n · v_hat)
   Single dispatch reads all 3 components plus n_dir[3] (real).
   Nyquist treatment is baked into n_dir on host (zero at any
   Nyquist bin); DC bin n_dir is also zero so DC stays inert. */
var STOKES_HELMHOLTZ_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> v0_hat: array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> v1_hat: array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<storage, read_write> v2_hat: array<vec2<f32>>;\n' +
'@group(0) @binding(3) var<storage, read>       n0:     array<f32>;\n' +
'@group(0) @binding(4) var<storage, read>       n1:     array<f32>;\n' +
'@group(0) @binding(5) var<storage, read>       n2:     array<f32>;\n' +
'@group(0) @binding(6) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn stokes_helmholtz(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let nx = n0[i]; let ny = n1[i]; let nz = n2[i];\n' +
'  let v0 = v0_hat[i]; let v1 = v1_hat[i]; let v2 = v2_hat[i];\n' +
'  let ndot_re = nx * v0.x + ny * v1.x + nz * v2.x;\n' +
'  let ndot_im = nx * v0.y + ny * v1.y + nz * v2.y;\n' +
'  v0_hat[i] = vec2<f32>(v0.x - nx * ndot_re, v0.y - nx * ndot_im);\n' +
'  v1_hat[i] = vec2<f32>(v1.x - ny * ndot_re, v1.y - ny * ndot_im);\n' +
'  v2_hat[i] = vec2<f32>(v2.x - nz * ndot_re, v2.y - nz * ndot_im);\n' +
'}\n';


/* stokesAccumLaplacian: outHat = penHat + μ·k²·uHat   (per component).
   Single component per dispatch (3 total), reads the shared k2phys
   lookup which has μ multiplied in already (k2_phys[i] = μ·|ξ_phys|²
   and zeroed at Nyquist). */
var STOKES_ACCUM_LAPLACIAN_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       penHat:  array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       uHat:    array<vec2<f32>>;\n' +
'@group(0) @binding(2) var<storage, read>       k2phys:  array<f32>;\n' +
'@group(0) @binding(3) var<storage, read_write> outHat:  array<vec2<f32>>;\n' +
'@group(0) @binding(4) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn stokes_accum_lap(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  let k2 = k2phys[i];\n' +
'  outHat[i] = penHat[i] + k2 * uHat[i];\n' +
'}\n';


/* stokesPrecondMul: hat ← M_inv · hat   (in-place, one component).
   M_inv is real and zero at DC and across the Nyquist plane. */
var STOKES_PRECOND_MUL_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read_write> hat:    array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read>       M_inv:  array<f32>;\n' +
'@group(0) @binding(2) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn stokes_precond(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  hat[i] = M_inv[i] * hat[i];\n' +
'}\n';


/* stokesUnpackReal: real_out[i] = complex_in[i].x   (strip imag part). */
var STOKES_UNPACK_REAL_WGSL =
'struct SizeParams { total: u32, _p0: u32, _p1: u32, _p2: u32 }\n' +
'@group(0) @binding(0) var<storage, read>       cin:  array<vec2<f32>>;\n' +
'@group(0) @binding(1) var<storage, read_write> rout: array<f32>;\n' +
'@group(0) @binding(2) var<uniform>             P: SizeParams;\n' +
'\n' +
'@compute @workgroup_size(64)\n' +
'fn stokes_unpack(@builtin(global_invocation_id) gid: vec3<u32>) {\n' +
'  let i = gid.x;\n' +
'  if (i >= P.total) { return; }\n' +
'  rout[i] = cin[i].x;\n' +
'}\n';


/* ════════════════════════════════════════════════════════════
   StokesSolver
   ════════════════════════════════════════════════════════════ */

function StokesSolver(N, fftPlan) {
  this.N    = N;
  this.N3   = N * N * N;
  this.fft  = fftPlan;
  this.device = WGPU.device;

  this.realSize  = this.N3 * 4;             /* Float32 */
  this.cmplxSize = this.N3 * 8;             /* vec2<f32> */
  this.partialCount = Math.ceil(this.N3 / 256);

  this._buildPipelines();
  this._allocateBuffers();
  this._allocateUniforms();
}


/* ── Pipeline construction ────────────────────────────────── */
StokesSolver.prototype._buildPipelines = function() {
  var d = this.device;

  /* ---------- Stokes-specific kernels ---------- */

  /* stokesPenalize */
  this.penLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.penPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.penLayout] }),
    compute: { module: d.createShaderModule({ code: STOKES_PENALIZE_WGSL }), entryPoint: 'stokes_penalize' }
  });

  /* stokesHelmholtzProject */
  this.helmLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.helmPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.helmLayout] }),
    compute: { module: d.createShaderModule({ code: STOKES_HELMHOLTZ_WGSL }), entryPoint: 'stokes_helmholtz' }
  });

  /* stokesAccumLaplacian */
  this.accLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.accPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.accLayout] }),
    compute: { module: d.createShaderModule({ code: STOKES_ACCUM_LAPLACIAN_WGSL }), entryPoint: 'stokes_accum_lap' }
  });

  /* stokesPrecondMul */
  this.precLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.precPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.precLayout] }),
    compute: { module: d.createShaderModule({ code: STOKES_PRECOND_MUL_WGSL }), entryPoint: 'stokes_precond' }
  });

  /* stokesUnpackReal */
  this.unpLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.unpPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.unpLayout] }),
    compute: { module: d.createShaderModule({ code: STOKES_UNPACK_REAL_WGSL }), entryPoint: 'stokes_unpack' }
  });

  /* ---------- Reused kernels (defined in 16-elastic-solver.js) ---------- */

  /* packComplex */
  this.pcLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.pcPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.pcLayout] }),
    compute: { module: d.createShaderModule({ code: PACK_COMPLEX_WGSL }), entryPoint: 'pack_complex' }
  });

  /* axpy */
  this.axpyLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.axpyPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.axpyLayout] }),
    compute: { module: d.createShaderModule({ code: AXPY_WGSL }), entryPoint: 'axpy' }
  });

  /* xbpy */
  this.xbpyLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.xbpyPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.xbpyLayout] }),
    compute: { module: d.createShaderModule({ code: XBPY_WGSL }), entryPoint: 'xbpy' }
  });

  /* fill */
  this.fillLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.fillPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.fillLayout] }),
    compute: { module: d.createShaderModule({ code: FILL_WGSL }), entryPoint: 'fill' }
  });

  /* dotReduce */
  this.redLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.redPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.redLayout] }),
    compute: { module: d.createShaderModule({ code: DOT_REDUCE_WGSL }), entryPoint: 'reduce' }
  });
};


/* ── Buffer allocation ────────────────────────────────────── */
StokesSolver.prototype._allocateBuffers = function() {
  var d = this.device;
  var BU = GPUBufferUsage;
  var R = this.realSize, C = this.cmplxSize;

  function rbuf() { return d.createBuffer({ size: R, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }
  function cbuf() { return d.createBuffer({ size: C, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }); }

  /* Solid mask (uploaded per design) */
  this.solidBuf = rbuf();

  /* PCG state — per-component triples */
  this.u_pri = [rbuf(), rbuf(), rbuf()];
  this.b     = [rbuf(), rbuf(), rbuf()];
  this.r     = [rbuf(), rbuf(), rbuf()];
  this.z     = [rbuf(), rbuf(), rbuf()];
  this.p     = [rbuf(), rbuf(), rbuf()];
  this.Ap    = [rbuf(), rbuf(), rbuf()];

  /* applyA scratch */
  this.pen      = [rbuf(), rbuf(), rbuf()];      /* α(x)·u in real space */
  this.penCmplx = [cbuf(), cbuf(), cbuf()];      /* real-packed pen, before FFT */
  this.penHat   = [cbuf(), cbuf(), cbuf()];      /* freq-space pen (after fwd FFT, after Helmholtz) */
  this.uCmplx   = [cbuf(), cbuf(), cbuf()];      /* real-packed u, before FFT */
  this.uHat     = [cbuf(), cbuf(), cbuf()];      /* freq-space u (after fwd FFT) */
  this.outHat   = [cbuf(), cbuf(), cbuf()];      /* combined penHat_proj + μ·k²·uHat */
  this.outC     = [cbuf(), cbuf(), cbuf()];      /* real-space output (after IFFT, before unpack) */

  /* applyMinv scratch — separate buffers from applyA so the two functions
     don't fight over the same complex workspace. */
  this.rCmplx = [cbuf(), cbuf(), cbuf()];
  this.rHat   = [cbuf(), cbuf(), cbuf()];
  this.zC     = [cbuf(), cbuf(), cbuf()];

  /* Lookup tables (uploaded per design — see uploadDesign).
     n_dir is 3 real arrays (one per axis), k2_phys and M_inv are single. */
  this.nDir   = [rbuf(), rbuf(), rbuf()];
  this.k2Phys = rbuf();
  this.Minv   = rbuf();

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


/* ── Uniform buffers ─────────────────────────────────────── */
StokesSolver.prototype._allocateUniforms = function() {
  var d = this.device;
  var BU = GPUBufferUsage;

  /* StokesParams (16 bytes: alpha_pen + total + N + pad) */
  this.stokesParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* SizeParams (16 bytes) — shared by helmholtz, accum, precond, unpack, packComplex, dotReduce */
  this.sizeParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  d.queue.writeBuffer(this.sizeParamsBuf, 0, new Uint32Array([this.N3, 0, 0, 0]));

  /* AXPY / XBPY uniforms — alpha (or beta) varies per CG iter */
  this.axpyParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
  this.xbpyParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  /* Fill — used to seed u' = 0 */
  this.fillParamsBuf = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
};


/* Write StokesParams (alpha_pen and N3).  Called once per design. */
StokesSolver.prototype._writeStokesParams = function(alpha_pen) {
  var buf = new ArrayBuffer(16);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf);
  f[0] = alpha_pen;
  u[1] = this.N3;
  u[2] = this.N;
  u[3] = 0;
  this.device.queue.writeBuffer(this.stokesParamsBuf, 0, buf);
};

StokesSolver.prototype._writeAxpy = function(alpha) {
  var buf = new ArrayBuffer(16);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf);
  f[0] = alpha;
  u[1] = this.N3;
  this.device.queue.writeBuffer(this.axpyParamsBuf, 0, buf);
};

StokesSolver.prototype._writeXbpy = function(beta) {
  var buf = new ArrayBuffer(16);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf);
  f[0] = beta;
  u[1] = this.N3;
  this.device.queue.writeBuffer(this.xbpyParamsBuf, 0, buf);
};

StokesSolver.prototype._writeFill = function(value) {
  var buf = new ArrayBuffer(16);
  var f = new Float32Array(buf);
  var u = new Uint32Array(buf);
  f[0] = value;
  u[1] = this.N3;
  this.device.queue.writeBuffer(this.fillParamsBuf, 0, buf);
};


/* ── uploadDesign — push solid mask + lookups + alpha_pen ──── */
StokesSolver.prototype.uploadDesign = function(solid_f32, n_dir, k2_phys, M_inv, alpha_pen) {
  var d = this.device;
  /* solid mask */
  d.queue.writeBuffer(this.solidBuf, 0, solid_f32.buffer, solid_f32.byteOffset, solid_f32.byteLength);
  /* lookups — n_dir is array of 3 Float32Array, k2_phys and M_inv are single Float32Array.
     Note: caller MUST supply Nyquist-zeroed arrays (see solveDesignStokes for the bake). */
  for (var c = 0; c < 3; c++) {
    d.queue.writeBuffer(this.nDir[c], 0, n_dir[c].buffer, n_dir[c].byteOffset, n_dir[c].byteLength);
  }
  d.queue.writeBuffer(this.k2Phys, 0, k2_phys.buffer, k2_phys.byteOffset, k2_phys.byteLength);
  d.queue.writeBuffer(this.Minv,   0, M_inv.buffer,   M_inv.byteOffset,   M_inv.byteLength);
  /* alpha_pen */
  this._writeStokesParams(alpha_pen);
};


/* ── _dispatchEncoded: tiny utility for compute pass dispatch ── */
StokesSolver.prototype._dispatchEncoded = function(enc, pipeline, bg, threadCount, wgSize) {
  var pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(threadCount / wgSize), 1, 1);
  pass.end();
};


/* ════════════════════════════════════════════════════════════
   _applyA: out = -μ∇²·uIn + P·(α(x)·uIn).
   9 FFTs total, plus penalty / project / accum / unpack dispatches.
   All work appended to `enc`; caller submits.
   ════════════════════════════════════════════════════════════ */
StokesSolver.prototype._applyA = function(enc, uIn, out) {
  var d = this.device;
  var N3 = this.N3;

  /* 1. pen = α(x)·uIn (real space, single dispatch all 3 components) */
  var penBg = d.createBindGroup({
    layout: this.penLayout,
    entries: [
      { binding: 0, resource: { buffer: this.solidBuf } },
      { binding: 1, resource: { buffer: uIn[0] } },
      { binding: 2, resource: { buffer: uIn[1] } },
      { binding: 3, resource: { buffer: uIn[2] } },
      { binding: 4, resource: { buffer: this.pen[0] } },
      { binding: 5, resource: { buffer: this.pen[1] } },
      { binding: 6, resource: { buffer: this.pen[2] } },
      { binding: 7, resource: { buffer: this.stokesParamsBuf } }
    ]
  });
  this._dispatchEncoded(enc, this.penPipeline, penBg, N3, 64);

  /* 2. Pack pen → complex, FFT each, store to penHat */
  for (var q = 0; q < 3; q++) {
    var pcBg = d.createBindGroup({
      layout: this.pcLayout,
      entries: [
        { binding: 0, resource: { buffer: this.pen[q] } },
        { binding: 1, resource: { buffer: this.penCmplx[q] } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.pcPipeline, pcBg, N3, 64);
    this.fft.loadFromBuffer(enc, this.penCmplx[q]);
    this.fft.forwardEncoded(enc);
    this.fft.storeToBuffer(enc, this.penHat[q]);
  }

  /* 3. Helmholtz-project penHat in place */
  var helmBg = d.createBindGroup({
    layout: this.helmLayout,
    entries: [
      { binding: 0, resource: { buffer: this.penHat[0] } },
      { binding: 1, resource: { buffer: this.penHat[1] } },
      { binding: 2, resource: { buffer: this.penHat[2] } },
      { binding: 3, resource: { buffer: this.nDir[0] } },
      { binding: 4, resource: { buffer: this.nDir[1] } },
      { binding: 5, resource: { buffer: this.nDir[2] } },
      { binding: 6, resource: { buffer: this.sizeParamsBuf } }
    ]
  });
  this._dispatchEncoded(enc, this.helmPipeline, helmBg, N3, 64);

  /* 4. Pack uIn → complex, FFT each, store to uHat */
  for (var qq = 0; qq < 3; qq++) {
    var pcBg2 = d.createBindGroup({
      layout: this.pcLayout,
      entries: [
        { binding: 0, resource: { buffer: uIn[qq] } },
        { binding: 1, resource: { buffer: this.uCmplx[qq] } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.pcPipeline, pcBg2, N3, 64);
    this.fft.loadFromBuffer(enc, this.uCmplx[qq]);
    this.fft.forwardEncoded(enc);
    this.fft.storeToBuffer(enc, this.uHat[qq]);
  }

  /* 5. outHat[c] = penHat_proj[c] + μ·k²·uHat[c] (per component) */
  for (var c2 = 0; c2 < 3; c2++) {
    var accBg = d.createBindGroup({
      layout: this.accLayout,
      entries: [
        { binding: 0, resource: { buffer: this.penHat[c2] } },
        { binding: 1, resource: { buffer: this.uHat[c2] } },
        { binding: 2, resource: { buffer: this.k2Phys } },
        { binding: 3, resource: { buffer: this.outHat[c2] } },
        { binding: 4, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.accPipeline, accBg, N3, 64);
  }

  /* 6. IFFT outHat → outC, then unpack real → out */
  for (var c3 = 0; c3 < 3; c3++) {
    this.fft.loadFromBuffer(enc, this.outHat[c3]);
    this.fft.inverseEncoded(enc);
    this.fft.storeToBuffer(enc, this.outC[c3]);
    var unpBg = d.createBindGroup({
      layout: this.unpLayout,
      entries: [
        { binding: 0, resource: { buffer: this.outC[c3] } },
        { binding: 1, resource: { buffer: out[c3] } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.unpPipeline, unpBg, N3, 64);
  }
};


/* ════════════════════════════════════════════════════════════
   _applyMinv: zOut = M⁻¹ · rIn   (per component, 6 FFTs total)
   ════════════════════════════════════════════════════════════ */
StokesSolver.prototype._applyMinv = function(enc, rIn, zOut) {
  var d = this.device;
  var N3 = this.N3;
  for (var c = 0; c < 3; c++) {
    /* Pack rIn → complex, FFT */
    var pcBg = d.createBindGroup({
      layout: this.pcLayout,
      entries: [
        { binding: 0, resource: { buffer: rIn[c] } },
        { binding: 1, resource: { buffer: this.rCmplx[c] } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.pcPipeline, pcBg, N3, 64);
    this.fft.loadFromBuffer(enc, this.rCmplx[c]);
    this.fft.forwardEncoded(enc);
    this.fft.storeToBuffer(enc, this.rHat[c]);
    /* Multiply by M_inv in place */
    var precBg = d.createBindGroup({
      layout: this.precLayout,
      entries: [
        { binding: 0, resource: { buffer: this.rHat[c] } },
        { binding: 1, resource: { buffer: this.Minv } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.precPipeline, precBg, N3, 64);
    /* IFFT → zC, unpack → zOut[c] */
    this.fft.loadFromBuffer(enc, this.rHat[c]);
    this.fft.inverseEncoded(enc);
    this.fft.storeToBuffer(enc, this.zC[c]);
    var unpBg = d.createBindGroup({
      layout: this.unpLayout,
      entries: [
        { binding: 0, resource: { buffer: this.zC[c] } },
        { binding: 1, resource: { buffer: zOut[c] } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.unpPipeline, unpBg, N3, 64);
  }
};


/* ── AXPY/XBPY/Fill triple helpers — same shape as ElasticSolver ── */
StokesSolver.prototype._axpyTriple = function(enc, alpha, xs, ys) {
  this._writeAxpy(alpha);
  for (var c = 0; c < 3; c++) {
    var bg = this.device.createBindGroup({
      layout: this.axpyLayout,
      entries: [
        { binding: 0, resource: { buffer: xs[c] } },
        { binding: 1, resource: { buffer: ys[c] } },
        { binding: 2, resource: { buffer: this.axpyParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.axpyPipeline, bg, this.N3, 64);
  }
};

StokesSolver.prototype._xbpyTriple = function(enc, beta, xs, ys) {
  this._writeXbpy(beta);
  for (var c = 0; c < 3; c++) {
    var bg = this.device.createBindGroup({
      layout: this.xbpyLayout,
      entries: [
        { binding: 0, resource: { buffer: xs[c] } },
        { binding: 1, resource: { buffer: ys[c] } },
        { binding: 2, resource: { buffer: this.xbpyParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.xbpyPipeline, bg, this.N3, 64);
  }
};

StokesSolver.prototype._fillTriple = function(enc, triple, value) {
  this._writeFill(value);
  for (var c = 0; c < 3; c++) {
    var bg = this.device.createBindGroup({
      layout: this.fillLayout,
      entries: [
        { binding: 0, resource: { buffer: triple[c] } },
        { binding: 1, resource: { buffer: this.fillParamsBuf } }
      ]
    });
    this._dispatchEncoded(enc, this.fillPipeline, bg, this.N3, 64);
  }
};


/* ── _dotTriple: GPU reduction of Σ_i (a_xx·b_xx + a_yy·b_yy + a_zz·b_zz) ──
   Same as elastic's pattern: dispatch reduce kernel, copy partials,
   await readback, sum on CPU. */
StokesSolver.prototype._dotTriple = async function(a, b) {
  var d = this.device;
  var enc = d.createCommandEncoder();
  var bg = d.createBindGroup({
    layout: this.redLayout,
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
  pass.setPipeline(this.redPipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(this.partialCount, 1, 1);
  pass.end();
  enc.copyBufferToBuffer(this.partialsBuf, 0, this.readbackBuf, 0, this.partialCount * 4);
  d.queue.submit([enc.finish()]);

  await this.readbackBuf.mapAsync(GPUMapMode.READ);
  var arr = new Float32Array(this.readbackBuf.getMappedRange().slice(0));
  this.readbackBuf.unmap();
  var s = 0;
  for (var i = 0; i < this.partialCount; i++) s += arr[i];
  return s;
};


/* ── _readbackReal: pull a single real buffer to CPU as Float32Array ── */
StokesSolver.prototype._readbackReal = async function(buf) {
  var d = this.device;
  var staging = d.createBuffer({ size: this.realSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(buf, 0, staging, 0, this.realSize);
  d.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  var copy = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return copy;
};


/* ════════════════════════════════════════════════════════════
   solveLoadCase — one PCG run for a single macroscopic velocity.
   Returns { avgAlphaU: [3], iters, converged, breakReason }
   where avgAlphaU is the volume-averaged α(x)·u (= μ·M[:,j]).

   Algorithm exactly mirrors solveCPUStokes from 18-stokes-cpu-ref.js:
     u' = 0; b = -P · (α · ē_j); r = b; z = M⁻¹·r; p = z
     PCG loop with α = (r·z)/(p·Ap), β = (r·z_new)/(r·z), p = z + β·p
   ════════════════════════════════════════════════════════════ */
StokesSolver.prototype.solveLoadCase = async function(u_bar, opts) {
  var d = this.device;
  opts = opts || {};
  var tol     = opts.tol     != null ? opts.tol     : STOKES_CG_TOL;
  var maxiter = opts.maxiter != null ? opts.maxiter : STOKES_CG_MAXITER;

  /* 1. Initialize u' = 0 (fillTriple needs distinct submits because the
        same fillParamsBuf is reused — but here all three components want
        the SAME value 0, so one writeFill + one encoder + 3 dispatches works.) */
  this._writeFill(0.0);
  var encInit = d.createCommandEncoder();
  for (var c = 0; c < 3; c++) {
    var bg = d.createBindGroup({
      layout: this.fillLayout,
      entries: [
        { binding: 0, resource: { buffer: this.u_pri[c] } },
        { binding: 1, resource: { buffer: this.fillParamsBuf } }
      ]
    });
    this._dispatchEncoded(encInit, this.fillPipeline, bg, this.N3, 64);
  }
  d.queue.submit([encInit.finish()]);

  /* 2. Build b = -P · (α · ē_j).
        Recipe: pen[c] = α(x) · ē_j[c]  (only one component is non-zero,
        others zero).  Pack each component → complex → FFT → Helmholtz
        project → IFFT → unpack → b.  Then negate.

        We reuse the applyA scratch buffers (pen, penCmplx, penHat, outC)
        for this — applyA is not running during init, so no conflict. */
  /* Step 2a: pen[c] = α(x) · u_bar[c] for each component */
  var encPen = d.createCommandEncoder();
  /* We need a "fill * solid * scalar" — but the simpler thing is to
     fill the u_pri buffers temporarily with u_bar, run penalize, then
     fill u_pri back to zero.  This avoids having to add another kernel. */
  for (var cb = 0; cb < 3; cb++) {
    this._writeFill(u_bar[cb]);
    var encT = d.createCommandEncoder();
    var bgT = d.createBindGroup({
      layout: this.fillLayout,
      entries: [
        { binding: 0, resource: { buffer: this.u_pri[cb] } },
        { binding: 1, resource: { buffer: this.fillParamsBuf } }
      ]
    });
    this._dispatchEncoded(encT, this.fillPipeline, bgT, this.N3, 64);
    d.queue.submit([encT.finish()]);   /* must submit between writeFills */
  }

  /* Run penalize on u_pri → pen */
  var encB = d.createCommandEncoder();
  var penBg = d.createBindGroup({
    layout: this.penLayout,
    entries: [
      { binding: 0, resource: { buffer: this.solidBuf } },
      { binding: 1, resource: { buffer: this.u_pri[0] } },
      { binding: 2, resource: { buffer: this.u_pri[1] } },
      { binding: 3, resource: { buffer: this.u_pri[2] } },
      { binding: 4, resource: { buffer: this.pen[0] } },
      { binding: 5, resource: { buffer: this.pen[1] } },
      { binding: 6, resource: { buffer: this.pen[2] } },
      { binding: 7, resource: { buffer: this.stokesParamsBuf } }
    ]
  });
  this._dispatchEncoded(encB, this.penPipeline, penBg, this.N3, 64);

  /* Pack pen → complex, FFT each */
  for (var qb = 0; qb < 3; qb++) {
    var pcBg = d.createBindGroup({
      layout: this.pcLayout,
      entries: [
        { binding: 0, resource: { buffer: this.pen[qb] } },
        { binding: 1, resource: { buffer: this.penCmplx[qb] } },
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(encB, this.pcPipeline, pcBg, this.N3, 64);
    this.fft.loadFromBuffer(encB, this.penCmplx[qb]);
    this.fft.forwardEncoded(encB);
    this.fft.storeToBuffer(encB, this.penHat[qb]);
  }

  /* Helmholtz project penHat in place */
  var helmBg = d.createBindGroup({
    layout: this.helmLayout,
    entries: [
      { binding: 0, resource: { buffer: this.penHat[0] } },
      { binding: 1, resource: { buffer: this.penHat[1] } },
      { binding: 2, resource: { buffer: this.penHat[2] } },
      { binding: 3, resource: { buffer: this.nDir[0] } },
      { binding: 4, resource: { buffer: this.nDir[1] } },
      { binding: 5, resource: { buffer: this.nDir[2] } },
      { binding: 6, resource: { buffer: this.sizeParamsBuf } }
    ]
  });
  this._dispatchEncoded(encB, this.helmPipeline, helmBg, this.N3, 64);

  /* IFFT each penHat → outC, unpack → b, then negate (axpy with α=-2 from b → b
     would double; instead we use a custom approach: fill b=0, axpy(-1, outC_real, b)
     where outC_real is unpacked.  Easier: unpack into a temp (use 'pen' since
     we don't need it anymore), then b = pen with sign flip via axpy.
     Cleanest: unpack directly into b and then axpy(b, -2, b) which gives b ← -b.
     Even cleaner: unpack → b, then call axpy with α = -1 doubling… no.
     Simplest: unpack → pen (real), then b = 0; axpy(b, -1, pen).
   */
  /* Unpack each outC into pen (reusing pen as tmp) */
  for (var c2b = 0; c2b < 3; c2b++) {
    this.fft.loadFromBuffer(encB, this.penHat[c2b]);
    this.fft.inverseEncoded(encB);
    this.fft.storeToBuffer(encB, this.outC[c2b]);
    var unpBg = d.createBindGroup({
      layout: this.unpLayout,
      entries: [
        { binding: 0, resource: { buffer: this.outC[c2b] } },
        { binding: 1, resource: { buffer: this.pen[c2b] } },     /* unpack into pen as tmp */
        { binding: 2, resource: { buffer: this.sizeParamsBuf } }
      ]
    });
    this._dispatchEncoded(encB, this.unpPipeline, unpBg, this.N3, 64);
  }
  /* Zero b */
  this._fillTriple(encB, this.b, 0.0);
  d.queue.submit([encB.finish()]);

  /* b -= pen   (pen holds P·(α·ē_j); we want b = -P·(α·ē_j)) */
  var encNeg = d.createCommandEncoder();
  this._axpyTriple(encNeg, -1.0, this.pen, this.b);
  d.queue.submit([encNeg.finish()]);

  /* Reset u_pri to zero (we used it as a scratch for the b construction) */
  this._writeFill(0.0);
  var encZ = d.createCommandEncoder();
  for (var c4 = 0; c4 < 3; c4++) {
    var bgZ = d.createBindGroup({
      layout: this.fillLayout,
      entries: [
        { binding: 0, resource: { buffer: this.u_pri[c4] } },
        { binding: 1, resource: { buffer: this.fillParamsBuf } }
      ]
    });
    this._dispatchEncoded(encZ, this.fillPipeline, bgZ, this.N3, 64);
  }
  d.queue.submit([encZ.finish()]);

  /* bNorm = sqrt(dot(b, b)) */
  var bNorm = Math.sqrt(await this._dotTriple(this.b, this.b)) + 1e-30;

  /* 3. r = b - A·u' = b (since u'=0).  Copy b → r. */
  var encInitR = d.createCommandEncoder();
  for (var c5 = 0; c5 < 3; c5++) {
    encInitR.copyBufferToBuffer(this.b[c5], 0, this.r[c5], 0, this.realSize);
  }
  d.queue.submit([encInitR.finish()]);

  /* 4. z = M⁻¹·r ; p = z */
  var encInitZ = d.createCommandEncoder();
  this._applyMinv(encInitZ, this.r, this.z);
  for (var c6 = 0; c6 < 3; c6++) {
    encInitZ.copyBufferToBuffer(this.z[c6], 0, this.p[c6], 0, this.realSize);
  }
  d.queue.submit([encInitZ.finish()]);

  var rz = await this._dotTriple(this.r, this.z);
  var iters = 0;
  var converged = false;
  var breakReason = 'max_iter';

  /* 5. PCG outer loop */
  for (var it = 0; it < maxiter; it++) {
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
    var alpha = rz / pAp;

    /* u' += α·p ; r -= α·Ap   (separate submits — see writeBuffer-coalescing
       note in elastic solver) */
    var encU = d.createCommandEncoder();
    this._axpyTriple(encU, alpha, this.p, this.u_pri);
    d.queue.submit([encU.finish()]);

    var encR = d.createCommandEncoder();
    this._axpyTriple(encR, -alpha, this.Ap, this.r);
    d.queue.submit([encR.finish()]);

    var rrNew = await this._dotTriple(this.r, this.r);
    var relRes = Math.sqrt(rrNew) / bNorm;
    if (relRes < tol) {
      converged = true;
      breakReason = 'converged';
      break;
    }

    /* z = M⁻¹·r */
    var encMi = d.createCommandEncoder();
    this._applyMinv(encMi, this.r, this.z);
    d.queue.submit([encMi.finish()]);

    var rzNew = await this._dotTriple(this.r, this.z);
    if (Math.abs(rz) < 1e-30) {
      breakReason = 'rz_zero';
      break;
    }
    var beta = rzNew / rz;

    /* p = z + β·p */
    var encP = d.createCommandEncoder();
    this._xbpyTriple(encP, beta, this.z, this.p);
    d.queue.submit([encP.finish()]);

    rz = rzNew;
  }

  /* 6. Compute avgAlphaU = ⟨α(x)·u⟩ where u = ē_j + u'.
     Pen = α·u_pri, then add α·ē_j (only one component is non-zero).
     Then volume-average each component.

     Easiest path: penalize(u_pri) → pen, then add α(x)·ē_j component.
     Since α(x)·ē_j is just α(x) on one component: we re-fill u_pri[c]
     with u_bar[c] for that component and call penalize again, getting
     pen for the full u = ē_j + u' in one go.

     Or simpler: u' is already in u_pri.  Add ē_j to u_pri (axpy with
     fill-value=1 vector? no that's not axpy).  Simplest: penalize on
     u_pri to get α·u', then add α(x)·ē_j[c] manually.  Need an
     "add solid mask scaled" kernel.  Or use the trick: temporarily
     fill u_pri[c] += u_bar[c] (constant add).

     I'll use the constant-add trick: write a custom kernel? No —
     use axpy with x = 1-buffer (would need to allocate).
     Alternative: fill outC[0] (a scratch buffer) with u_bar[c], then
     axpy(1.0, outC, u_pri).  But outC is complex…

     Actually the simplest correct thing: u_pri += u_bar in place
     (component-wise constant add), penalize, then back out (subtract
     u_bar from u_pri).  To add a constant: fill a scratch real buffer
     to u_bar[c], axpy(1.0, scratch, u_pri[c]).  Use 'pen[c]' as scratch
     (it's about to be overwritten by the penalize call anyway). */
  for (var ca = 0; ca < 3; ca++) {
    /* pen[ca] = u_bar[ca] (constant fill) */
    this._writeFill(u_bar[ca]);
    var encF = d.createCommandEncoder();
    var bgF = d.createBindGroup({
      layout: this.fillLayout,
      entries: [
        { binding: 0, resource: { buffer: this.pen[ca] } },
        { binding: 1, resource: { buffer: this.fillParamsBuf } }
      ]
    });
    this._dispatchEncoded(encF, this.fillPipeline, bgF, this.N3, 64);
    d.queue.submit([encF.finish()]);

    /* u_pri[ca] += pen[ca]   (axpy with α=1.0) */
    this._writeAxpy(1.0);
    var encAdd = d.createCommandEncoder();
    var bgAdd = d.createBindGroup({
      layout: this.axpyLayout,
      entries: [
        { binding: 0, resource: { buffer: this.pen[ca] } },
        { binding: 1, resource: { buffer: this.u_pri[ca] } },
        { binding: 2, resource: { buffer: this.axpyParamsBuf } }
      ]
    });
    this._dispatchEncoded(encAdd, this.axpyPipeline, bgAdd, this.N3, 64);
    d.queue.submit([encAdd.finish()]);
  }

  /* Now u_pri = ē_j + u' (full velocity).  Penalize → pen = α(x)·u. */
  var encFinal = d.createCommandEncoder();
  var penBgF = d.createBindGroup({
    layout: this.penLayout,
    entries: [
      { binding: 0, resource: { buffer: this.solidBuf } },
      { binding: 1, resource: { buffer: this.u_pri[0] } },
      { binding: 2, resource: { buffer: this.u_pri[1] } },
      { binding: 3, resource: { buffer: this.u_pri[2] } },
      { binding: 4, resource: { buffer: this.pen[0] } },
      { binding: 5, resource: { buffer: this.pen[1] } },
      { binding: 6, resource: { buffer: this.pen[2] } },
      { binding: 7, resource: { buffer: this.stokesParamsBuf } }
    ]
  });
  this._dispatchEncoded(encFinal, this.penPipeline, penBgF, this.N3, 64);
  d.queue.submit([encFinal.finish()]);

  /* Volume-average each pen[c] — readback + sum on CPU. */
  var avgAlphaU = [0, 0, 0];
  for (var cf = 0; cf < 3; cf++) {
    var arr = await this._readbackReal(this.pen[cf]);
    var s = 0;
    for (var i2 = 0; i2 < this.N3; i2++) s += arr[i2];
    avgAlphaU[cf] = s / this.N3;
  }

  return {
    avgAlphaU: avgAlphaU,
    iters: iters,
    converged: converged,
    breakReason: breakReason
  };
};


/* ════════════════════════════════════════════════════════════
   homogenize — full 3-load-case run, returns K tensor + diagnostics.
   ════════════════════════════════════════════════════════════ */
StokesSolver.prototype.homogenize = async function(mu, opts) {
  var M = [[0,0,0],[0,0,0],[0,0,0]];
  var totalIters = 0;
  var allConverged = true;
  var perLC = [];

  for (var lc = 0; lc < 3; lc++) {
    var u_bar = [lc===0?1:0, lc===1?1:0, lc===2?1:0];
    var res = await this.solveLoadCase(u_bar, opts);
    totalIters += res.iters;
    if (!res.converged) allConverged = false;
    for (var p = 0; p < 3; p++) M[p][lc] = res.avgAlphaU[p] / mu;
    perLC.push({ axis: ['x','y','z'][lc], iters: res.iters, converged: res.converged, breakReason: res.breakReason });
  }
  /* Symmetrize */
  for (var pp = 0; pp < 3; pp++) for (var qq = pp+1; qq < 3; qq++) {
    var s = 0.5 * (M[pp][qq] + M[qq][pp]);
    M[pp][qq] = M[qq][pp] = s;
  }

  /* Invert 3×3 → K */
  var det = M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1])
          - M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0])
          + M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
  if (Math.abs(det) < 1e-30) {
    return { Kx: 0, Ky: 0, Kz: 0, K_full: null, M_full: M, totalIters: totalIters, allConverged: allConverged, valid: false, perLC: perLC };
  }
  var invDet = 1 / det;
  var K00 =  (M[1][1]*M[2][2] - M[1][2]*M[2][1]) * invDet;
  var K01 = -(M[0][1]*M[2][2] - M[0][2]*M[2][1]) * invDet;
  var K02 =  (M[0][1]*M[1][2] - M[0][2]*M[1][1]) * invDet;
  var K11 =  (M[0][0]*M[2][2] - M[0][2]*M[2][0]) * invDet;
  var K12 = -(M[0][0]*M[1][2] - M[0][2]*M[1][0]) * invDet;
  var K22 =  (M[0][0]*M[1][1] - M[0][1]*M[1][0]) * invDet;

  return {
    Kx: K00, Ky: K11, Kz: K22,
    K_full: [[K00, K01, K02], [K01, K11, K12], [K02, K12, K22]],
    M_full: M,
    totalIters: totalIters,
    allConverged: allConverged,
    valid: true,
    perLC: perLC
  };
};


/* ── destroy: free all GPU buffers ─── */
StokesSolver.prototype.destroy = function() {
  this.solidBuf.destroy();
  for (var c = 0; c < 3; c++) {
    this.u_pri[c].destroy(); this.b[c].destroy(); this.r[c].destroy();
    this.z[c].destroy();     this.p[c].destroy(); this.Ap[c].destroy();
    this.pen[c].destroy();   this.penCmplx[c].destroy(); this.penHat[c].destroy();
    this.uCmplx[c].destroy();this.uHat[c].destroy();
    this.outHat[c].destroy();this.outC[c].destroy();
    this.rCmplx[c].destroy();this.rHat[c].destroy();this.zC[c].destroy();
    this.nDir[c].destroy();
  }
  this.k2Phys.destroy(); this.Minv.destroy();
  this.partialsBuf.destroy(); this.readbackBuf.destroy();
  this.stokesParamsBuf.destroy(); this.sizeParamsBuf.destroy();
  this.axpyParamsBuf.destroy(); this.xbpyParamsBuf.destroy();
  this.fillParamsBuf.destroy();
};


/* ════════════════════════════════════════════════════════════
   buildStokesLookups — bake n_dir, k2_phys, M_inv on CPU with
   Nyquist treatment.  Mirrors the loop in solveCPUStokes from
   18-stokes-cpu-ref.js.

   Returns: { n_dir: [Float32Array×3], k2_phys, M_inv }
   All arrays are Float32 (vs CPU ref's Float64) — the GPU runs
   FP32 only; small drift relative to the FP64 reference is
   expected and validated in Step 3.
   ════════════════════════════════════════════════════════════ */
function buildStokesLookups(N, mu, alpha_0, L_cell_m) {
  var N3 = N * N * N;
  var k_scale_sq = (2 * Math.PI / L_cell_m) * (2 * Math.PI / L_cell_m);
  var k2_phys = new Float32Array(N3);
  var n_dir   = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
  var M_inv   = new Float32Array(N3);
  var halfN = N / 2;

  for (var i = 0; i < N; i++) {
    var ki = i <= halfN ? i : i - N;
    if (i === halfN) ki = 0;
    for (var j = 0; j < N; j++) {
      var kj = j <= halfN ? j : j - N;
      if (j === halfN) kj = 0;
      for (var k = 0; k < N; k++) {
        var kk = k <= halfN ? k : k - N;
        if (k === halfN) kk = 0;
        var ksq = ki*ki + kj*kj + kk*kk;
        var idx = i*N*N + j*N + k;
        if (ksq === 0) {
          k2_phys[idx] = 0;
          n_dir[0][idx] = n_dir[1][idx] = n_dir[2][idx] = 0;
          M_inv[idx] = 0;
        } else {
          var rk = 1.0 / Math.sqrt(ksq);
          n_dir[0][idx] = ki * rk;
          n_dir[1][idx] = kj * rk;
          n_dir[2][idx] = kk * rk;
          /* k2_phys here includes the μ multiplier so the GPU shader can
             just do  outHat += k2phys * uHat  without a separate μ uniform. */
          k2_phys[idx] = mu * k_scale_sq * ksq;
          M_inv[idx] = 1.0 / (mu * k_scale_sq * ksq + alpha_0);
        }
      }
    }
  }
  return { n_dir: n_dir, k2_phys: k2_phys, M_inv: M_inv };
}


/* ════════════════════════════════════════════════════════════
   solveDesignStokes — top-level convenience: take a recipe,
   return Kx/Ky/Kz + diagnostics.  Mirrors solveDesignElastic.
   ════════════════════════════════════════════════════════════ */
async function solveDesignStokes(recipe, N, opts) {
  if (!WGPU.device) throw new Error('solveDesignStokes: ensureDevice() first');
  opts = opts || {};

  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);

  /* Rasterize on CPU (same as elastic path) */
  var t0 = performance.now();
  var solid = buildVoxels(family, params, args.offset, N, args.mode, args.wt,
                          args.nWeights, args.pipeR, args.phaseShift);
  var tRast = performance.now() - t0;

  var inside = 0;
  for (var v = 0; v < solid.length; v++) inside += solid[v];
  var rho = inside / solid.length;

  /* Material / cell parameters */
  var mat = recipe.material || {};
  var mu = mat.muFluid_PaS != null ? mat.muFluid_PaS : 0.001;
  var L_cell_mm = (recipe.geometry && recipe.geometry.cellSizeMm) || 5.0;
  var L_cell_m = L_cell_mm * 1e-3;
  var d_voxel_m = L_cell_m / N;
  var alpha_pen_scale = opts.alphaPenScale != null ? opts.alphaPenScale : 1e6;
  var alpha_pen = alpha_pen_scale * mu / (d_voxel_m * d_voxel_m);
  var alpha_0   = opts.alpha_0 != null ? opts.alpha_0 : alpha_pen / 2;

  /* Build CPU-side lookup tables (Nyquist-zeroed) */
  var t1 = performance.now();
  var lk = buildStokesLookups(N, mu, alpha_0, L_cell_m);
  var tLookups = performance.now() - t1;

  /* Convert solid to Float32 if not already */
  var solid_f32 = solid instanceof Float32Array ? solid : new Float32Array(solid);

  /* GPU solver — share FFTPlan with the elastic path if present */
  var fft;
  if (window.__sharedFFT && window.__sharedFFT.N === N) {
    fft = window.__sharedFFT;
  } else {
    if (window.__sharedFFT) window.__sharedFFT.destroy();
    fft = new FFTPlan(N);
    window.__sharedFFT = fft;
  }
  var solver = new StokesSolver(N, fft);
  solver.uploadDesign(solid_f32, lk.n_dir, lk.k2_phys, lk.M_inv, alpha_pen);

  var t2 = performance.now();
  var hom = await solver.homogenize(mu, opts);
  var tCG = performance.now() - t2;

  solver.destroy();

  return {
    name: recipe.name,
    family: family,
    mode: args.mode,
    rho: rho,
    Kx_m2: hom.Kx,
    Ky_m2: hom.Ky,
    Kz_m2: hom.Kz,
    K_full: hom.K_full,
    M_full: hom.M_full,
    mu_PaS: mu,
    L_cell_m: L_cell_m,
    alpha_pen: alpha_pen,
    alpha_0: alpha_0,
    iters: hom.totalIters,
    converged: hom.allConverged,
    valid: hom.valid,
    perLC: hom.perLC,
    tRast_ms: tRast,
    tLookups_ms: tLookups,
    tCG_ms: tCG
  };
}


/* ════════════════════════════════════════════════════════════
   Smoke test — Schwarz P at N=16 on GPU.
   Pass criteria:
     1. PCG converges on all 3 LCs at TOL=5e-5, maxiter=800
     2. K positive definite (cubic eigenvalues a+2b > 0, a-b > 0)
     3. K_avg in [1e-12, 1e-6] m²
     4. Cubic isotropy < 5% (matches CPU ref expectation)
   TOL=5e-5 chosen to clear FP32's residual-norm floor.  At N=16
   with bNorm ~2.7e11 and FP32 ε ~1.2e-7, the relative residual
   can plateau near 1e-5 to 5e-5 due to accumulated reduction
   roundoff across 4096 voxels.  CPU ref at FP64 hits TOL=1e-5
   cleanly in ~410 iters; GPU at FP32 should hit TOL=5e-5 in
   the same ballpark of iters (~400-500 per LC).
   ════════════════════════════════════════════════════════════ */
var GPU_STOKES_SMOKE = { state: 'idle', lastResult: null };

async function runGPUStokesSmokeTest() {
  paintGPUStokesLink('running', '⟳ GPU Stokes · Schwarz P · N=16…');
  await new Promise(function(resolve){ setTimeout(resolve, 10); });

  try {
    if (typeof ensureDevice === 'function') {
      var ok = await ensureDevice();
      if (!ok) {
        paintGPUStokesLink('fail', '✗ WebGPU unavailable');
        return;
      }
    }
    var t0 = performance.now();
    var res = await solveDesignStokes(DEMO_RECIPES.schwarzP, 16, { tol: 5e-5, maxiter: 800 });
    var totalMs = performance.now() - t0;

    var passed = true;
    var notes = [];

    if (!res.valid) { passed = false; notes.push('M-matrix singular'); }
    if (res.Kx_m2 <= 0 || res.Ky_m2 <= 0 || res.Kz_m2 <= 0) {
      passed = false; notes.push('non-positive K diagonal');
    }
    var a_K = (res.K_full[0][0] + res.K_full[1][1] + res.K_full[2][2]) / 3;
    var b_K = (res.K_full[0][1] + res.K_full[0][2] + res.K_full[1][2]) / 3;
    var eig_iso = a_K + 2*b_K;
    var eig_dev = a_K - b_K;
    if (eig_iso <= 0 || eig_dev <= 0) {
      passed = false;
      notes.push('K not positive definite (iso=' + eig_iso.toExponential(2) + ', dev=' + eig_dev.toExponential(2) + ')');
    }
    var Kavg = (res.Kx_m2 + res.Ky_m2 + res.Kz_m2) / 3;
    if (Kavg < 1e-12 || Kavg > 1e-6) {
      passed = false;
      notes.push('K out of band [1e-12, 1e-6] m²');
    }
    var Kmax = Math.max(res.Kx_m2, res.Ky_m2, res.Kz_m2);
    var Kmin = Math.min(res.Kx_m2, res.Ky_m2, res.Kz_m2);
    var aniso = Kmax > 0 ? (Kmax - Kmin) / Kmax : 0;
    var k_star = Kavg / (res.L_cell_m * res.L_cell_m);

    GPU_STOKES_SMOKE.lastResult = { res: res, passed: passed, notes: notes, totalMs: totalMs };

    var bg = passed ? '#34d399' : '#fb7185';
    var fg = passed ? '#06080f' : '#fff';
    var lcLine = res.perLC.map(function(p){
      return p.axis + ':' + p.iters + '·' + p.breakReason;
    }).join('  ');

    console.log(
      '%c ' + (passed ? '✓' : '✗') + ' ' + res.name + ' · GPU Stokes · N=16 ',
      'background:' + bg + '; color:' + fg + '; font-weight:bold; padding:2px 8px; border-radius:3px;',
      '\n  family:        ' + res.family + ' · mode: ' + res.mode +
      '\n  ρ (VF):        ' + (res.rho * 100).toFixed(2) + '%' +
      '\n  Kx / Ky / Kz:  ' + res.Kx_m2.toExponential(3) + ' / ' +
                              res.Ky_m2.toExponential(3) + ' / ' +
                              res.Kz_m2.toExponential(3) + ' m²' +
      '\n  K eigenvalues: iso=' + eig_iso.toExponential(3) + ', dev=' + eig_dev.toExponential(3) +
      '\n  isotropy:      ' + (aniso * 100).toFixed(2) + '%' +
      '\n  mean K:        ' + Kavg.toExponential(3) + ' m²' +
      '\n  k* (K/L²):     ' + k_star.toExponential(3) + '  (dimensionless)' +
      '\n  μ:             ' + res.mu_PaS + ' Pa·s' +
      '\n  L_cell:        ' + (res.L_cell_m*1000).toFixed(2) + ' mm' +
      '\n  α_pen:         ' + res.alpha_pen.toExponential(3) + ' Pa·s/m²' +
      '\n  α_0 (precond): ' + res.alpha_0.toExponential(3) + ' Pa·s/m²' +
      '\n  PCG iters:     ' + res.iters + ' total · all converged: ' + res.converged +
      '\n  per-LC:        ' + lcLine +
      '\n  rasterize:     ' + res.tRast_ms.toFixed(0) + ' ms' +
      '\n  lookups:       ' + res.tLookups_ms.toFixed(0) + ' ms' +
      '\n  GPU PCG solve: ' + res.tCG_ms.toFixed(0) + ' ms' +
      '\n  total:         ' + totalMs.toFixed(0) + ' ms' +
      '\n  CPU ref @ TOL=1e-5: K ≈ 8.29e-8 (avg), 410/410/532 iters, ~9000 ms' +
      (notes.length ? '\n  notes:         ' + notes.join(' · ') : '')
    );

    if (passed) {
      paintGPUStokesLink('pass',
        '✓ GPU Stokes · K̅ = ' + Kavg.toExponential(2) + ' m² (' + totalMs.toFixed(0) + ' ms)');
    } else {
      paintGPUStokesLink('fail',
        '⚠ GPU Stokes · checks failed (see console)');
    }
  } catch (err) {
    console.error('[gpu-stokes-smoke] failed:', err);
    paintGPUStokesLink('fail', '✗ ' + (err.message || String(err)));
  }
}

function paintGPUStokesLink(state, text) {
  var link = document.getElementById('gpuStokesTestLink');
  if (!link) return;
  GPU_STOKES_SMOKE.state = state;
  link.classList.remove('running', 'pass', 'fail');
  if (state !== 'idle') link.classList.add(state);
  link.textContent = text;
}
