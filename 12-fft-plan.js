/* ============================================================
   F13LD.lab · 12-fft-plan.js  (v0.3.0 — encoded mode added)
   3D FFT via Stockham 1D passes along each axis.
   FP32 complex (vec2<f32>), pre-baked stage params, ping-pong
   buffers. Forward and inverse share kernels (twiddle sign flip).

   v0.3.0 additions for the elastic solver:
     forwardEncoded(encoder), inverseEncoded(encoder)
        — append FFT compute passes to an EXTERNAL command encoder
          without submitting. Lets the elastic CG iteration batch
          6 FFTs + a dozen small kernels into one submit.
     loadFromBuffer(encoder, srcBuffer)
     storeToBuffer (encoder, dstBuffer)
        — GPU-side copies between FFTPlan's internal scratch (bufA)
          and external buffers held by the elastic solver.

   Memory layout: index = i + N*j + N²*k, with i innermost.
   ============================================================ */

/* WGSL: one Stockham butterfly pass over a single axis ----- */
var FFT_WGSL = [
'struct FftParams {',
'  N: u32, log_N: u32, stage: u32, sign_neg: u32,',
'  axis: u32, batch: u32, wg_x: u32, pad2: u32,',
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
'  let per_slot = half_N * N * N;',
'  let total = params.batch * per_slot;',
'  let tid = gid.x + gid.y * params.wg_x * 64u;',
'  if (tid >= total) { return; }',
'',
'  let slot         = tid / per_slot;',
'  let local        = tid % per_slot;',
'  let butterfly_id = local % half_N;',
'  let rest         = local / half_N;',
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
'  let src_lo_pos = b_block * L + p;',
'  let src_hi_pos = (b_block + M) * L + p;',
'  let dst_lo_pos = b_block * (2u * L) + p;',
'  let dst_hi_pos = dst_lo_pos + L;',
'',
'  let sign  = select(1.0, -1.0, params.sign_neg == 1u);',
'  let theta = sign * 6.283185307179586 * f32(p) / f32(2u * L);',
'  let twid  = vec2<f32>(cos(theta), sin(theta));',
'',
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
'  let slot_off = slot * N * N * N;',
'  s_lo = s_lo + slot_off;',
'  s_hi = s_hi + slot_off;',
'  d_lo = d_lo + slot_off;',
'  d_hi = d_hi + slot_off;',
'',
'  let a     = src[s_lo];',
'  let b_raw = src[s_hi];',
'',
'  let b = vec2<f32>(',
'    b_raw.x * twid.x - b_raw.y * twid.y,',
'    b_raw.x * twid.y + b_raw.y * twid.x',
'  );',
'',
'  dst[d_lo] = a + b;',
'  dst[d_hi] = a - b;',
'}'
].join('\n');

/* WGSL: in-place 1/N³ scale, used after inverse FFT --------- */
var NORM_WGSL = [
'struct NormParams {',
'  total: u32, scale: f32, wg_x: u32, pad1: u32,',
'}',
'',
'@group(0) @binding(0) var<storage, read_write> data: array<vec2<f32>>;',
'@group(0) @binding(1) var<uniform>             params: NormParams;',
'',
'@compute @workgroup_size(64)',
'fn normalize(@builtin(global_invocation_id) gid: vec3<u32>) {',
'  let idx = gid.x + gid.y * params.wg_x * 64u;',
'  if (idx >= params.total) { return; }',
'  data[idx] = data[idx] * params.scale;',
'}'
].join('\n');


/* ============================================================
   FFTPlan — encapsulates buffers + pipelines + bind groups
   ============================================================ */
function FFTPlan(N, batch){
  this.N = N;
  this.batch = (batch && batch > 0) ? (batch | 0) : 1;
  this.logN = Math.log2(N);
  if (this.logN !== Math.floor(this.logN)){
    throw new Error('FFT size must be a power of 2 — got ' + N);
  }
  this.slotElements  = N * N * N;                       /* complex elements in one N³ transform */
  this.totalElements = this.slotElements * this.batch;  /* across every batched slot */
  this.bufferSize    = this.totalElements * 8;          /* vec2<f32> = 8 bytes/element */
  this.totalStages   = 3 * this.logN;

  this.device = WGPU.device;
  if (!this.device){
    throw new Error('FFTPlan requires WebGPU device — call ensureDevice() first');
  }

  this._computeDispatchDims();
  this._buildPipelines();
  this._allocateBuffers();
  this._prebakeStageParams();

  this.lastResultBuffer = this.bufA;
}

/* _computeDispatchDims — batch×N³ threads can exceed the 1D workgroup cap, so
   both the FFT stages and the norm pass dispatch on a 2D grid (wg_x × wg_y) and
   the kernels linearize tid = gid.x + gid.y·wg_x·64.  wg_x is constant for the
   plan's lifetime, so it is baked into the prebaked params.  For batch = 1 this
   reduces to wg_x = wgCount, wg_y = 1, gid.y = 0 → identical to the 1D path. */
FFTPlan.prototype._computeDispatchDims = function(){
  var maxWG = (this.device.limits && this.device.limits.maxComputeWorkgroupsPerDimension) || 65535;

  var fftThreads = this.batch * (this.N / 2) * this.N * this.N;
  var fftWg      = Math.ceil(fftThreads / 64);
  this._fftWgX   = Math.min(fftWg, maxWG);
  this._fftWgY   = Math.ceil(fftWg / this._fftWgX);
  if (this._fftWgY > maxWG){
    throw new Error('FFTPlan: batch ' + this.batch + ' at N=' + this.N +
                    ' exceeds the 2D workgroup grid — tile the batch into smaller groups.');
  }

  var normWg    = Math.ceil(this.totalElements / 64);
  this._normWgX = Math.min(normWg, maxWG);
  this._normWgY = Math.ceil(normWg / this._normWgX);
};

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

  var npBuf = new ArrayBuffer(16);
  new Uint32Array(npBuf, 0, 1)[0]  = this.totalElements;        /* normalize every slot's elements */
  new Float32Array(npBuf, 4, 1)[0] = 1.0 / this.slotElements;   /* per-slot 1/N³ — NOT divided by batch */
  new Uint32Array(npBuf, 8, 1)[0]  = this._normWgX;             /* 2D linearization stride */
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

FFTPlan.prototype._prebakeStageParams = function(){
  var d = this.device;
  var BU = GPUBufferUsage;
  var N = this.N, logN = this.logN;

  this.stages = [];

  for (var axis = 0; axis < 3; axis++){
    for (var stage = 0; stage < logN; stage++){
      var stageIdx = axis * logN + stage;
      var isEven   = (stageIdx % 2) === 0;
      var srcBuf   = isEven ? this.bufA : this.bufB;
      var dstBuf   = isEven ? this.bufB : this.bufA;

      var fwdParamsBuf = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
      var invParamsBuf = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });

      d.queue.writeBuffer(fwdParamsBuf, 0, new Uint32Array([N, logN, stage, 1, axis, this.batch, this._fftWgX, 0]));
      d.queue.writeBuffer(invParamsBuf, 0, new Uint32Array([N, logN, stage, 0, axis, this.batch, this._fftWgX, 0]));

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

  /* Result parity: stage 0 writes A→B. After K stages, result is
     in B if K is odd, A if K is even. */
  this.fwdResultBuf = (this.totalStages % 2 === 0) ? this.bufA : this.bufB;
  this.invResultBuf = this.fwdResultBuf;
};


/* ============================================================
   Public API
   ============================================================ */

/* upload(complexArray) — Float32Array of length 2*N³, interleaved (re, im, re, im, ...).
   Writes to bufA via queue.writeBuffer (CPU → GPU). */
FFTPlan.prototype.upload = function(complexArray){
  if (complexArray.length !== 2 * this.totalElements){
    throw new Error('Array length mismatch — expected ' + (2 * this.totalElements) + ', got ' + complexArray.length);
  }
  this.device.queue.writeBuffer(this.bufA, 0, complexArray);
  this.lastResultBuffer = this.bufA;
};

/* loadFromBuffer(encoder, srcBuffer) — GPU-side copy of an external complex
   buffer into bufA, encoded into the given command encoder.  Use this when the
   FFT input lives on the GPU already (elastic solver hot path). */
FFTPlan.prototype.loadFromBuffer = function(encoder, srcBuffer){
  encoder.copyBufferToBuffer(srcBuffer, 0, this.bufA, 0, this.bufferSize);
  this.lastResultBuffer = this.bufA;
};

/* storeToBuffer(encoder, dstBuffer) — GPU-side copy of the most recent FFT
   result (lastResultBuffer) into an external buffer, encoded. */
FFTPlan.prototype.storeToBuffer = function(encoder, dstBuffer){
  encoder.copyBufferToBuffer(this.lastResultBuffer, 0, dstBuffer, 0, this.bufferSize);
};

/* loadFromBuffers(encoder, srcBuffers) — gather an array of per-slot complex
   buffers (each slotElements·8 bytes) into the batched bufA: slot s lands at
   byte offset s·slotElements·8.  A single forwardEncoded/inverseEncoded then
   transforms all slots in one set of stage dispatches.  copyBufferToBuffer
   offsets are multiples of 8 here, satisfying the 4-byte copy alignment. */
FFTPlan.prototype.loadFromBuffers = function(encoder, srcBuffers){
  if (srcBuffers.length > this.batch){
    throw new Error('loadFromBuffers: ' + srcBuffers.length + ' buffers exceed batch ' + this.batch);
  }
  var slotBytes = this.slotElements * 8;
  for (var s = 0; s < srcBuffers.length; s++){
    encoder.copyBufferToBuffer(srcBuffers[s], 0, this.bufA, s * slotBytes, slotBytes);
  }
  this.lastResultBuffer = this.bufA;
};

/* storeToBuffers(encoder, dstBuffers) — scatter the most recent batched FFT
   result back out, slot s → dstBuffers[s].  Mirror of loadFromBuffers. */
FFTPlan.prototype.storeToBuffers = function(encoder, dstBuffers){
  if (dstBuffers.length > this.batch){
    throw new Error('storeToBuffers: ' + dstBuffers.length + ' buffers exceed batch ' + this.batch);
  }
  var slotBytes = this.slotElements * 8;
  for (var s = 0; s < dstBuffers.length; s++){
    encoder.copyBufferToBuffer(this.lastResultBuffer, s * slotBytes, dstBuffers[s], 0, slotBytes);
  }
};

/* forward() / inverse() — standalone variants that submit their own encoder.
   Used by the FFT self-test and other one-shot consumers. */
FFTPlan.prototype.forward = function(){
  var enc = this.device.createCommandEncoder();
  this._encodeFFT(enc, true);
  this.device.queue.submit([enc.finish()]);
  return this.lastResultBuffer;
};
FFTPlan.prototype.inverse = function(){
  var enc = this.device.createCommandEncoder();
  this._encodeFFT(enc, false);
  this.device.queue.submit([enc.finish()]);
  return this.lastResultBuffer;
};

/* forwardEncoded(encoder) / inverseEncoded(encoder) — append FFT compute
   passes to an existing encoder.  Caller submits.  This is the hot path
   for the elastic CG iteration. */
FFTPlan.prototype.forwardEncoded = function(encoder){ this._encodeFFT(encoder, true);  return this.lastResultBuffer; };
FFTPlan.prototype.inverseEncoded = function(encoder){ this._encodeFFT(encoder, false); return this.lastResultBuffer; };

/* _encodeFFT — adds passes for one full 3D FFT to the given encoder.  No submit. */
FFTPlan.prototype._encodeFFT = function(encoder, forward){
  var pass = encoder.beginComputePass();
  pass.setPipeline(this.fftPipeline);

  for (var i = 0; i < this.stages.length; i++){
    pass.setBindGroup(0, forward ? this.stages[i].fwdBg : this.stages[i].invBg);
    pass.dispatchWorkgroups(this._fftWgX, this._fftWgY, 1);
  }
  pass.end();

  if (!forward){
    pass = encoder.beginComputePass();
    pass.setPipeline(this.normPipeline);
    var resultBuf = this.invResultBuf;
    pass.setBindGroup(0, (resultBuf === this.bufA) ? this.normBgA : this.normBgB);
    pass.dispatchWorkgroups(this._normWgX, this._normWgY, 1);
    pass.end();
  }

  this.lastResultBuffer = forward ? this.fwdResultBuf : this.invResultBuf;
};

/* readback(buffer) — Promise<Float32Array> of complex values (re/im interleaved). */
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
