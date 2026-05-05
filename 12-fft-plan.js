/* ============================================================
   F13LD.lab · 12-fft-plan.js
   3D FFT via Stockham 1D passes along each axis.
   FP32 complex (vec2<f32>), pre-baked stage params, ping-pong
   buffers. Forward and inverse share kernels (twiddle sign flip).

   Memory layout: index = i + N*j + N²*k, with i innermost.
   Axis convention: 0 = i (innermost), 1 = j, 2 = k.

   Buffer roles: bufA holds the user-provided input on upload(),
   forward()/inverse() ping-pong A↔B internally and return the
   buffer holding the final result.
   ============================================================ */

/* WGSL: one Stockham butterfly pass over a single axis ----- */
var FFT_WGSL = [
'struct FftParams {',
'  N: u32, log_N: u32, stage: u32, sign_neg: u32,',
'  axis: u32, pad0: u32, pad1: u32, pad2: u32,',
'}',
'',
'@group(0) @binding(0) var<storage, read>       src: array<vec2<f32>>;',
'@group(0) @binding(1) var<storage, read_write> dst: array<vec2<f32>>;',
'@group(0) @binding(2) var<uniform>             params: FftParams;',
'',
'fn buf_index(i: u32, j: u32, k: u32, N: u32) -> u32 {',
'  return i + N * (j + N * k);',
'}',
'',
'@compute @workgroup_size(64)',
'fn fft_pass(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let N = params.N;',
'  let half_N = N >> 1u;',
'  let total = half_N * N * N;',
'  let tid = gid.x;',
'  if (tid >= total) { return; }',
'',
'  // Decode (butterfly_id, pencil_a, pencil_b) from a flat 1D dispatch',
'  let butterfly_id = tid % half_N;',
'  let rest         = tid / half_N;',
'  let pencil_a     = rest % N;',
'  let pencil_b     = rest / N;',
'',
'  let stage = params.stage;',
'  let L = 1u << stage;',
'  let M = N / (2u * L);',
'',
'  let b_block = butterfly_id / L;',
'  let p       = butterfly_id % L;',
'',
'  // Stockham positions (within the 1D pencil being transformed)',
'  let src_lo_pos = b_block * L + p;',
'  let src_hi_pos = (b_block + M) * L + p;',
'  let dst_lo_pos = b_block * (2u * L) + p;',
'  let dst_hi_pos = dst_lo_pos + L;',
'',
'  // Twiddle: forward sign = -, inverse sign = +',
'  let sign  = select(1.0, -1.0, params.sign_neg == 1u);',
'  let theta = sign * 6.283185307179586 * f32(p) / f32(2u * L);',
'  let twid  = vec2<f32>(cos(theta), sin(theta));',
'',
'  // Map pencil-relative positions to actual buffer indices, by axis',
'  var s_lo: u32; var s_hi: u32; var d_lo: u32; var d_hi: u32;',
'  if (params.axis == 0u) {',
'    s_lo = buf_index(src_lo_pos, pencil_a, pencil_b, N);',
'    s_hi = buf_index(src_hi_pos, pencil_a, pencil_b, N);',
'    d_lo = buf_index(dst_lo_pos, pencil_a, pencil_b, N);',
'    d_hi = buf_index(dst_hi_pos, pencil_a, pencil_b, N);',
'  } else if (params.axis == 1u) {',
'    s_lo = buf_index(pencil_a, src_lo_pos, pencil_b, N);',
'    s_hi = buf_index(pencil_a, src_hi_pos, pencil_b, N);',
'    d_lo = buf_index(pencil_a, dst_lo_pos, pencil_b, N);',
'    d_hi = buf_index(pencil_a, dst_hi_pos, pencil_b, N);',
'  } else {',
'    s_lo = buf_index(pencil_a, pencil_b, src_lo_pos, N);',
'    s_hi = buf_index(pencil_a, pencil_b, src_hi_pos, N);',
'    d_lo = buf_index(pencil_a, pencil_b, dst_lo_pos, N);',
'    d_hi = buf_index(pencil_a, pencil_b, dst_hi_pos, N);',
'  }',
'',
'  let a     = src[s_lo];',
'  let b_raw = src[s_hi];',
'',
'  // Complex multiply: b = b_raw * twid',
'  let b = vec2<f32>(',
'    b_raw.x * twid.x - b_raw.y * twid.y,',
'    b_raw.x * twid.y + b_raw.y * twid.x',
'  );',
'',
'  // Butterfly',
'  dst[d_lo] = a + b;',
'  dst[d_hi] = a - b;',
'}'
].join('\n');

/* WGSL: in-place 1/N³ scale, used after inverse FFT --------- */
var NORM_WGSL = [
'struct NormParams {',
'  total: u32, scale: f32, pad0: u32, pad1: u32,',
'}',
'',
'@group(0) @binding(0) var<storage, read_write> data: array<vec2<f32>>;',
'@group(0) @binding(1) var<uniform>             params: NormParams;',
'',
'@compute @workgroup_size(64)',
'fn normalize(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let idx = gid.x;',
'  if (idx >= params.total) { return; }',
'  data[idx] = data[idx] * params.scale;',
'}'
].join('\n');

/* ============================================================
   FFTPlan — encapsulates buffers + pipelines + bind groups
   for a fixed-size 3D FFT. Cheap to instantiate and reuse;
   creating one per N (64 or 128) and reusing across solves.
   ============================================================ */
function FFTPlan(N){
  this.N = N;
  this.logN = Math.log2(N);
  if (this.logN !== Math.floor(this.logN)){
    throw new Error('FFT size must be a power of 2 — got ' + N);
  }
  this.totalElements = N * N * N;
  this.bufferSize    = this.totalElements * 8;     // vec2<f32> = 8 bytes
  this.totalStages   = 3 * this.logN;              // 3 axes × logN stages

  this.device = WGPU.device;
  if (!this.device){
    throw new Error('FFTPlan requires WebGPU device — call ensureDevice() first');
  }

  this._buildPipelines();
  this._allocateBuffers();
  this._prebakeStageParams();

  this.lastResultBuffer = this.bufA;
}

FFTPlan.prototype._buildPipelines = function(){
  var d = this.device;

  this.fftLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.fftPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.fftLayout] }),
    compute: { module: d.createShaderModule({ code: FFT_WGSL }), entryPoint: 'fft_pass' }
  });

  this.normLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  this.normPipeline = d.createComputePipeline({
    layout:  d.createPipelineLayout({ bindGroupLayouts: [this.normLayout] }),
    compute: { module: d.createShaderModule({ code: NORM_WGSL }), entryPoint: 'normalize' }
  });
};

FFTPlan.prototype._allocateBuffers = function(){
  var d = this.device;
  var BU = GPUBufferUsage;

  this.bufA = d.createBuffer({ size: this.bufferSize, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });
  this.bufB = d.createBuffer({ size: this.bufferSize, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });

  this.normParamsBuffer = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  // Pre-write normalize params (1/N³ scale, total elements)
  var npBuf = new ArrayBuffer(16);
  new Uint32Array(npBuf, 0, 1)[0]  = this.totalElements;
  new Float32Array(npBuf, 4, 1)[0] = 1.0 / this.totalElements;
  d.queue.writeBuffer(this.normParamsBuffer, 0, npBuf);

  this.normBgA = d.createBindGroup({
    layout:  this.normLayout,
    entries: [
      { binding: 0, resource: { buffer: this.bufA } },
      { binding: 1, resource: { buffer: this.normParamsBuffer } }
    ]
  });
  this.normBgB = d.createBindGroup({
    layout:  this.normLayout,
    entries: [
      { binding: 0, resource: { buffer: this.bufB } },
      { binding: 1, resource: { buffer: this.normParamsBuffer } }
    ]
  });
};

/* ----------------------------------------------------------
   Pre-bake per-stage uniform buffers and bind groups.

   This avoids the writeBuffer-then-multiple-dispatches pitfall
   (where only the LAST writeBuffer's value is observed by all
   subsequent dispatches in a single submit).

   Memory is trivial — for N=128, 6×7=42 stages × 32 bytes =
   1.3 KB of uniform buffer total.
   ---------------------------------------------------------- */
FFTPlan.prototype._prebakeStageParams = function(){
  var d = this.device;
  var BU = GPUBufferUsage;
  var N = this.N, logN = this.logN;

  this.stages = [];   // entry per stage: { fwdBg, invBg, srcBuf, dstBuf }

  for (var axis = 0; axis < 3; axis++){
    for (var stage = 0; stage < logN; stage++){
      var stageIdx = axis * logN + stage;
      var isEven   = (stageIdx % 2) === 0;
      var srcBuf   = isEven ? this.bufA : this.bufB;
      var dstBuf   = isEven ? this.bufB : this.bufA;

      // Two uniform buffers per stage — forward (sign_neg=1) and inverse (sign_neg=0)
      var fwdParamsBuf = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
      var invParamsBuf = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });

      d.queue.writeBuffer(fwdParamsBuf, 0, new Uint32Array([N, logN, stage, 1, axis, 0, 0, 0]));
      d.queue.writeBuffer(invParamsBuf, 0, new Uint32Array([N, logN, stage, 0, axis, 0, 0, 0]));

      var fwdBg = d.createBindGroup({
        layout:  this.fftLayout,
        entries: [
          { binding: 0, resource: { buffer: srcBuf } },
          { binding: 1, resource: { buffer: dstBuf } },
          { binding: 2, resource: { buffer: fwdParamsBuf } }
        ]
      });
      var invBg = d.createBindGroup({
        layout:  this.fftLayout,
        entries: [
          { binding: 0, resource: { buffer: srcBuf } },
          { binding: 1, resource: { buffer: dstBuf } },
          { binding: 2, resource: { buffer: invParamsBuf } }
        ]
      });

      this.stages.push({
        fwdBg: fwdBg, invBg: invBg,
        srcBuf: srcBuf, dstBuf: dstBuf,
        fwdParamsBuf: fwdParamsBuf, invParamsBuf: invParamsBuf
      });
    }
  }

  // After all stages, where does the result live?
  // After totalStages alternations starting at A:
  //   even count of stages → final dst = B (because the LAST stage writes to B)
  // Wait: stage 0 writes A→B. After 1 stage, result in B. After 2, result in A.
  // So result buf after K stages is B if K is odd, A if K is even.
  this.fwdResultBuf = (this.totalStages % 2 === 0) ? this.bufA : this.bufB;
  this.invResultBuf = this.fwdResultBuf;
};

/* ============================================================
   Public API
   ============================================================ */

/* upload(complexInterleaved) — Float32Array of length 2 * N³,
   interleaved (re, im, re, im, ...). Writes into bufA. */
FFTPlan.prototype.upload = function(complexArray){
  if (complexArray.length !== 2 * this.totalElements){
    throw new Error('Array length mismatch — expected ' + (2 * this.totalElements) + ', got ' + complexArray.length);
  }
  this.device.queue.writeBuffer(this.bufA, 0, complexArray);
  this.lastResultBuffer = this.bufA;
};

/* forward() — returns the GPUBuffer holding the FFT result. */
FFTPlan.prototype.forward = function(){ return this._runFFT(true); };

/* inverse() — returns the GPUBuffer holding the IFFT result, normalized by 1/N³. */
FFTPlan.prototype.inverse = function(){ return this._runFFT(false); };

FFTPlan.prototype._runFFT = function(forward){
  var d = this.device;
  var encoder = d.createCommandEncoder();
  var pass = encoder.beginComputePass();
  pass.setPipeline(this.fftPipeline);

  var totalThreads = (this.N / 2) * this.N * this.N;
  var wgCount      = Math.ceil(totalThreads / 64);

  for (var i = 0; i < this.stages.length; i++){
    pass.setBindGroup(0, forward ? this.stages[i].fwdBg : this.stages[i].invBg);
    pass.dispatchWorkgroups(wgCount, 1, 1);
  }
  pass.end();

  // Inverse needs 1/N³ scaling
  if (!forward){
    pass = encoder.beginComputePass();
    pass.setPipeline(this.normPipeline);
    var resultBuf = this.invResultBuf;
    pass.setBindGroup(0, (resultBuf === this.bufA) ? this.normBgA : this.normBgB);
    var normWg = Math.ceil(this.totalElements / 64);
    pass.dispatchWorkgroups(normWg, 1, 1);
    pass.end();
  }

  d.queue.submit([encoder.finish()]);
  this.lastResultBuffer = forward ? this.fwdResultBuf : this.invResultBuf;
  return this.lastResultBuffer;
};

/* readback(buffer) — Promise<Float32Array> of complex values. */
FFTPlan.prototype.readback = async function(buffer){
  var d = this.device;
  var rb = d.createBuffer({
    size:  this.bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  var enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(buffer, 0, rb, 0, this.bufferSize);
  d.queue.submit([enc.finish()]);

  await rb.mapAsync(GPUMapMode.READ);
  var copy = new Float32Array(rb.getMappedRange().slice(0));
  rb.unmap();
  rb.destroy();
  return copy;
};

/* destroy() — release GPU resources. */
FFTPlan.prototype.destroy = function(){
  this.bufA.destroy();
  this.bufB.destroy();
  this.normParamsBuffer.destroy();
  for (var i = 0; i < this.stages.length; i++){
    this.stages[i].fwdParamsBuf.destroy();
    this.stages[i].invParamsBuf.destroy();
  }
  this.stages.length = 0;
};
