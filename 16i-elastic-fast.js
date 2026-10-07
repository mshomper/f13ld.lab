/* ============================================================
   F13LD.lab · 16i-elastic-fast.js   (v0.15.0)
   Fast elastic homogenization for sweeps — same operator, same CG,
   same stopping test as ElasticSolverFull.homogenizeFull (16b), but:

     1. GPU-resident CG.  alpha, beta, r·r, p·Ap, the converged flag and
        the iteration count live in a small GPU buffer; the axpy kernels
        read their coefficient from it.  One command buffer per BLOCK of
        iterations and one 32-float readback per block (block grows
        1, 2, … 16), instead of 2 blocking readbacks and ~6 submits per
        iteration.  After convergence alpha = beta = 0, so the rest of a
        block is a no-op.
     2. Packed spectral operator.  τ = C(x):v − C₀:v is packed two real
        fields per complex slot (3 slots), so Γ̂:τ̂ costs ONE batch-3
        forward + inverse FFT instead of 12 single transforms.  Exact
        because Γ̂(k) is real, even and symmetric (checked once per Γ).
     3. Γ is built once per (grid, reference medium) and kept on the GPU,
        symmetric-packed (21 planes).  16b rebuilt the full 6×6 Γ on the
        CPU in float64 and re-uploaded it for every solve.
     4. Lean solver buffers: the fast path needs 6 field pairs, not the
        legacy 7 pairs + 24 complex scratch buffers + 36 Γ planes.

   The kernels are the nonlinear solver's validated fast-path kernels
   (16g, v0.8.1: NL_PACK_TAU / nlGammaPk / NL_DEACC_PK / NL_SCALAR /
   NL_CG_XR / NL_AXPY_S / NL_SUM_SLOT / NL_MEAN6 / NL_MEANSUM), used here
   with the linear elastic C(x) (16b's localStress) instead of the J2
   tangent.  Load order: after 16b and 16g.

   Used by solveDesignElasticFull for every solve (v0.19.0): sweeps (no
   per-voxel fields) and normal runs, which capture fields per load case
   from the converged strain and stress already on the GPU (same
   extractors as 16b).  window.LAB_FAST_ELASTIC = false → legacy path.
   Validation (browser console):  await runElasticFastTest(32)
   ============================================================ */

var ELASTIC_FAST_VERSION = 'ef-1';

/* ── Caches (per device): packed Γ by grid + reference medium, the
      batch-3 FFT plan and a lean solver by grid. ─────────────────── */
var _EF = { gamma: {}, gammaOrder: [], fft: {}, solver: {} };

function elasticFastEnabled() {
  if (typeof window !== 'undefined' && window.LAB_FAST_ELASTIC === false) return false;
  return typeof NL_PACK_TAU_WGSL !== 'undefined' && typeof nlGammaPkWGSL === 'function' && !!(WGPU && WGPU.device);
}

/* Free everything the fast path keeps on the GPU (e.g. before a big buckling run). */
function elasticFastRelease() {
  for (var k in _EF.gamma) { try { _EF.gamma[k].G.destroy(); } catch (e) {} }
  for (var n in _EF.fft) { try { _EF.fft[n].destroy(); } catch (e) {} }
  for (var s in _EF.solver) { try { _EF.solver[s].destroy(); } catch (e) {} }
  _EF.gamma = {}; _EF.gammaOrder = []; _EF.fft = {}; _EF.solver = {};
}

/* Packed Γ on the GPU for (N, μ₀, λ₀).  Returns null (→ legacy) when Γ
   is not real-even-symmetric or the buffer would exceed device limits.
   info.tGamma_ms reports the build time on a cache miss (0 on a hit). */
function elasticFastGamma(N, mu0, lam0, info) {
  var key = N + ':' + mu0 + ':' + lam0;
  if (_EF.gamma[key]) { if (info) info.tGamma_ms = 0; return _EF.gamma[key]; }
  var d = WGPU.device, N3 = N * N * N;
  var lim = d.limits || {};
  if (21 * N3 * 4 > (lim.maxStorageBufferBindingSize || 134217728) || 21 * N3 * 4 > (lim.maxBufferSize || 268435456)) return null;
  var t0 = performance.now();
  var Gamma = buildGammaFull(N, mu0, lam0);
  /* exactness checks for the packed operator (as 16g _fastInit) */
  var gMax = 0;
  for (var P0 = 0; P0 < 6; P0++) for (var Q0 = 0; Q0 < 6; Q0++) { var G0 = Gamma[P0][Q0]; for (var i0 = 0; i0 < N3; i0++) { var a0 = Math.abs(G0[i0]); if (a0 > gMax) gMax = a0; } }
  var gTol = 1e-10 * gMax;
  for (var P = 0; P < 6; P++) for (var Q = P + 1; Q < 6; Q++) {
    var A = Gamma[P][Q], B = Gamma[Q][P];
    for (var i = 0; i < N3; i++) if (Math.abs(A[i] - B[i]) > gTol) { console.warn('[elastic-fast] Γ not symmetric → legacy path'); return null; }
  }
  for (var P2 = 0; P2 < 6; P2++) for (var Q2 = P2; Q2 < 6; Q2++) {
    var G = Gamma[P2][Q2];
    for (var k = 0; k < N3; k++) {
      var x = k % N, y = ((k / N) | 0) % N, z = (k / (N * N)) | 0;
      var m = ((N - x) % N) + N * (((N - y) % N) + N * ((N - z) % N));
      if (Math.abs(G[k] - G[m]) > gTol) { console.warn('[elastic-fast] Γ not even → legacy path'); return null; }
    }
  }
  var buf = d.createBuffer({ size: 21 * N3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  var plane = new Float32Array(N3);
  for (var p = 0; p < 6; p++) for (var q = p; q < 6; q++) {
    var src = Gamma[p][q];
    for (var j = 0; j < N3; j++) plane[j] = src[j];
    d.queue.writeBuffer(buf, nlGammaSymIdx(p, q) * N3 * 4, plane);
  }
  var entry = { key: key, N: N, G: buf };
  _EF.gamma[key] = entry; _EF.gammaOrder.push(key);
  /* keep at most two (the 64 ↔ 128 pair); free the oldest */
  while (_EF.gammaOrder.length > 2) { var old = _EF.gammaOrder.shift(); try { _EF.gamma[old].G.destroy(); } catch (e) {} delete _EF.gamma[old]; }
  if (info) info.tGamma_ms = performance.now() - t0;
  return entry;
}

function elasticFastPlan(N) {
  if (!_EF.fft[N]) _EF.fft[N] = new FFTPlan(N, 3);
  return _EF.fft[N];
}

/* Lean ElasticSolverFull + fast-path resources, cached per grid. */
function elasticFastSolver(N) {
  if (_EF.solver[N]) return _EF.solver[N];
  /* keep at most two grids alive */
  var grids = Object.keys(_EF.solver);
  if (grids.length >= 2) { var g0 = grids[0]; try { _EF.solver[g0].destroy(); } catch (e) {} delete _EF.solver[g0]; }
  var s = new ElasticFastSolver(N, elasticFastPlan(N));
  _EF.solver[N] = s;
  return s;
}

/* ════════════════════════════════════════════════════════════ */
function ElasticFastSolver(N, fft3) {
  var d = WGPU.device, BU = GPUBufferUsage;
  this.N = N; this.N3 = N * N * N; this.device = d; this.fft = fft3;
  this.es = new ElasticSolverFull(N, fft3, { lean: true });
  var es = this.es, N3 = this.N3;
  this.inPlace = (fft3.fwdResultBuf === fft3.bufA);
  var pipe = function (code, entry) { return d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: code }), entryPoint: entry } }); };
  this.pPackTau = pipe(NL_PACK_TAU_WGSL, 'nl_pack_tau');
  this.pGamma = pipe(nlGammaPkWGSL(this.inPlace), 'nl_gamma_pk');
  this.pDeacc = pipe(NL_DEACC_PK_WGSL, 'nl_deacc_pk');
  this.pSum = pipe(NL_SUM_SLOT_WGSL, 'nl_sum_slot');
  this.pScalar = pipe(NL_SCALAR_WGSL, 'nl_scalar');
  this.pXR = pipe(NL_CG_XR_WGSL, 'nl_cg_xr');
  this.pAxpy = pipe(NL_AXPY_S_WGSL, 'nl_axpy_s');
  this.pMean6 = pipe(NL_MEAN6_WGSL, 'nl_mean6');
  this.pMeanSum = pipe(NL_MEANSUM_WGSL, 'nl_meansum');
  this.sclr = d.createBuffer({ size: NLS_COUNT * 4, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });
  this.part6 = d.createBuffer({ size: Math.max(es.partialCount * 32, 256), usage: BU.STORAGE });
  this.mean6 = d.createBuffer({ size: 32, usage: BU.STORAGE | BU.COPY_SRC });
  /* one readback: 32 scalars + 8 mean floats */
  this.rb = d.createBuffer({ size: NLS_COUNT * 4 + 32, usage: BU.COPY_DST | BU.MAP_READ });
  var u = function (arr) { var b = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST }); d.queue.writeBuffer(b, 0, new Uint32Array(arr)); return b; };
  this.uSize = u([N3, 0, 0, 0]);
  this.uGamma = u([N3, N, 0, 0]);
  this.uMean = u([es.partialCount, N3, 0, 0]);
  this.uOp = [u([0, 0, 0, 0]), u([1, 0, 0, 0]), u([2, 0, 0, 0])];
  this.uSum = {}; this.uAx = {}; this.bg = {};
  this.gammaKey = null;
}

ElasticFastSolver.prototype.destroy = function () {
  var self = this;
  ['sclr', 'part6', 'mean6', 'rb', 'uSize', 'uGamma', 'uMean'].forEach(function (k) { try { self[k].destroy(); } catch (e) {} });
  this.uOp.forEach(function (b) { try { b.destroy(); } catch (e) {} });
  [this.uSum, this.uAx].forEach(function (m) { for (var k in m) try { m[k].destroy(); } catch (e) {} });
  this.es.destroy();
};

ElasticFastSolver.prototype._bgc = function (key, pipeline, buffers) {
  if (!this.bg[key]) {
    var entries = [];
    for (var i = 0; i < buffers.length; i++) entries.push({ binding: i, resource: { buffer: buffers[i] } });
    this.bg[key] = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries });
  }
  return this.bg[key];
};
ElasticFastSolver.prototype._pair = function (name) {
  var es = this.es;
  switch (name) { case 'eps': return es.eps; case 'b': return es.b; case 'r': return es.r; case 'p': return es.p; case 'Ap': return es.Ap; case 'sig': return es.sig; }
  throw new Error('elastic-fast: ' + name);
};
ElasticFastSolver.prototype._sumU = function (slot) {
  if (!this.uSum[slot]) {
    this.uSum[slot] = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.uSum[slot], 0, new Uint32Array([this.es.partialCount, slot, 0, 0]));
  }
  return this.uSum[slot];
};

/* sig = C(x):v   (16b localStress) */
ElasticFastSolver.prototype._stress = function (enc, vName) {
  var es = this.es, v = this._pair(vName);
  nlPass(enc, [[es.lsPipeline, this._bgc('ls:' + vName, es.lsPipeline, [es.solidBuf, v.n, v.s, es.sig.n, es.sig.s, es.elasticParamsBuf]), Math.ceil(this.N3 / 64)]]);
};
/* out = v + Γ:(C(x):v − C₀:v) */
ElasticFastSolver.prototype._applyA = function (enc, vName, outName) {
  var es = this.es, v = this._pair(vName), O = this._pair(outName), F = this.fft, wg = Math.ceil(this.N3 / 64);
  this._stress(enc, vName);
  nlPass(enc, [[this.pPackTau, this._bgc('pt:' + vName, this.pPackTau, [v.n, v.s, es.sig.n, es.sig.s, F.bufA, es.elasticParamsBuf]), wg]]);
  F.forwardEncoded(enc);
  var gbg = this.inPlace ? this._bgc('gamma', this.pGamma, [this.G, F.bufA, this.uGamma])
                         : this._bgc('gamma', this.pGamma, [this.G, F.fwdResultBuf, F.bufA, this.uGamma]);
  nlPass(enc, [[this.pGamma, gbg, wg]]);
  F.inverseEncoded(enc);
  nlPass(enc, [[this.pDeacc, this._bgc('de:' + vName + '>' + outName, this.pDeacc, [F.invResultBuf, v.n, v.s, O.n, O.s, this.uSize]), wg]]);
};
ElasticFastSolver.prototype._dot = function (enc, aName, bName, slot) {
  var es = this.es, a = this._pair(aName), b = this._pair(bName);
  nlPass(enc, [
    [es.drPipeline, this._bgc('dot:' + aName + '.' + bName, es.drPipeline, [a.n, a.s, b.n, b.s, es.partialsBuf, es.sizeParamsBuf]), es.partialCount],
    [this.pSum, this._bgc('sum:' + slot, this.pSum, [es.partialsBuf, this.sclr, this._sumU(slot)]), 1]
  ]);
};
ElasticFastSolver.prototype._axpy = function (enc, xName, yName, slot, mode) {
  var key = slot + ':' + (mode || 0);
  if (!this.uAx[key]) {
    this.uAx[key] = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.uAx[key], 0, new Uint32Array([this.N3, slot, mode || 0, 0]));
  }
  var x = this._pair(xName), y = this._pair(yName);
  nlPass(enc, [[this.pAxpy, this._bgc('ax:' + xName + '>' + yName + ':' + key, this.pAxpy, [x.n, x.s, y.n, y.s, this.sclr, this.uAx[key]]), Math.ceil(this.N3 / 64)]]);
};
ElasticFastSolver.prototype._scalar = function (enc, op) {
  nlPass(enc, [[this.pScalar, this._bgc('op' + op, this.pScalar, [this.sclr, this.uOp[op]]), 1]]);
};
/* one CG iteration on A eps = b, entirely on the GPU */
ElasticFastSolver.prototype._iter = function (enc) {
  var es = this.es;
  this._applyA(enc, 'p', 'Ap');
  this._dot(enc, 'p', 'Ap', NLS_PAP);
  this._scalar(enc, 1);                                   /* alpha */
  nlPass(enc, [
    [this.pXR, this._bgc('xr', this.pXR, [es.p.n, es.p.s, es.Ap.n, es.Ap.s, es.eps.n, es.eps.s, es.r.n, es.r.s, this.sclr, es.partialsBuf, this.uSize]), es.partialCount],
    [this.pSum, this._bgc('sum:' + NLS_RRN, this.pSum, [es.partialsBuf, this.sclr, this._sumU(NLS_RRN)]), 1]
  ]);
  this._scalar(enc, 2);                                   /* beta, iteration count, convergence */
  this._axpy(enc, 'r', 'p', NLS_BETA, 1);                 /* p = r + beta p */
};
/* σ̄ = mean(C(x):eps) into mean6 (GPU), copied with the scalars into rb */
ElasticFastSolver.prototype._encodeReadback = function (enc, withMean) {
  var es = this.es;
  if (withMean) {
    this._stress(enc, 'eps');
    nlPass(enc, [
      [this.pMean6, this._bgc('mean6', this.pMean6, [es.sig.n, es.sig.s, this.part6, this.uSize]), es.partialCount],
      [this.pMeanSum, this._bgc('meansum', this.pMeanSum, [this.part6, this.mean6, this.uMean]), 1]
    ]);
    enc.copyBufferToBuffer(this.mean6, 0, this.rb, NLS_COUNT * 4, 32);
  }
  enc.copyBufferToBuffer(this.sclr, 0, this.rb, 0, NLS_COUNT * 4);
};
ElasticFastSolver.prototype._read = async function (enc) {
  this.device.queue.submit([enc.finish()]);
  await this.rb.mapAsync(GPUMapMode.READ);
  var v = new Float32Array(this.rb.getMappedRange().slice(0));
  this.rb.unmap();
  return v;
};

/* Upload a design (solid mask + materials) and bind the cached Γ. */
ElasticFastSolver.prototype.upload = function (solid, gammaEntry, C_s, C_v, C_0) {
  this.es.uploadDesign(solid, null, C_s, C_v, C_0);
  if (this.gammaKey !== gammaEntry.key) { this.G = gammaEntry.G; this.gammaKey = gammaEntry.key; delete this.bg.gamma; }
};

/* One load case: CG on A eps = b, eps0 = b = eps_bar (as 16b).
   capture = true → per-voxel fields from the converged state (v0.19.0). */
ElasticFastSolver.prototype.solveLoadCase = async function (eps_bar, tol, maxIt, capture) {
  var d = this.device, es = this.es, N3 = this.N3;
  var e1 = d.createCommandEncoder(); es._fillPair(e1, es.eps, eps_bar); d.queue.submit([e1.finish()]);
  var e2 = d.createCommandEncoder(); es._fillPair(e2, es.b, eps_bar); d.queue.submit([e2.finish()]);
  var b2 = 0; for (var c = 0; c < 6; c++) b2 += eps_bar[c] * eps_bar[c];
  b2 *= N3;                                               /* ||b||² exactly (uniform field) */
  var init = new Float32Array(NLS_COUNT); init[NLS_M1] = -1; init[NLS_TOL2] = tol * tol; init[NLS_B2] = b2;
  d.queue.writeBuffer(this.sclr, 0, init);
  var enc = d.createCommandEncoder();
  this._applyA(enc, 'eps', 'Ap');                         /* Ap = A eps0 */
  es._copyPair(enc, es.b, es.r);
  this._axpy(enc, 'Ap', 'r', NLS_M1, 0);                  /* r = b − A eps0 */
  es._copyPair(enc, es.r, es.p);                          /* p = r */
  this._dot(enc, 'r', 'r', NLS_RR);
  this._scalar(enc, 0);                                   /* threshold, done?, it = 0 */
  var encoded = 0, block = 1, reads = 0, v, checkMax = (typeof window !== 'undefined' && window.LAB_FAST_CHECK_MAX) || 16;
  while (true) {
    var nb = Math.min(block, maxIt - encoded);
    for (var k = 0; k < nb; k++) this._iter(enc);
    encoded += nb;
    var last = encoded >= maxIt;
    this._encodeReadback(enc, false);
    v = await this._read(enc); reads++;
    if (v[NLS_DONE] > 0.5 || last || !isFinite(v[NLS_RR])) break;
    block = Math.min(checkMax, Math.max(1, Math.floor(encoded / 4)));
    enc = d.createCommandEncoder();
  }
  var encF = d.createCommandEncoder();
  this._encodeReadback(encF, true);
  var w = await this._read(encF); reads++;
  var rr = Math.max(w[NLS_RR], 0), thr = w[NLS_THR];
  var converged = w[NLS_DONE] > 0.5 && rr <= thr * (1 + 1e-6);
  var o = NLS_COUNT;
  /* mean6 holds vec4(σxx,σyy,σzz,·), vec4(σyz,σxz,σxy,·) */
  var sigma = [w[o], w[o + 1], w[o + 2], w[o + 4], w[o + 5], w[o + 6]];
  /* v0.19.0 — fields.  The final readback ran _stress('eps'), so es.sig
     holds C(x):eps at the converged state and es.eps the converged strain:
     exactly what 16b's extractors read. */
  var fields = null;
  if (capture) {
    var sigArr = await es._readbackPair(es.sig);
    var isNormal = eps_bar[0] !== 0 || eps_bar[1] !== 0 || eps_bar[2] !== 0;
    fields = isNormal ? await es.extractFieldsForLCFull(eps_bar, sigArr) : await es.extractStressOnlyForLCFull(sigArr);
  }
  return {
    sigma: sigma, iters: w[NLS_IT] | 0, converged: converged, fields: fields,
    breakReason: converged ? 'converged' : (w[NLS_DONE] > 0.5 ? 'pAp_breakdown' : 'max_iter'),
    finalResidual: Math.sqrt(rr / Math.max(b2, 1e-60)), readbacks: reads
  };
};

/* Six load cases → the same result shape as ElasticSolverFull.homogenizeFull.
   captureLCs: solver LC indices (0..5) to capture fields for (v0.19.0). */
ElasticFastSolver.prototype.homogenize = async function (tol, maxIt, captureLCs) {
  var voigt = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  var C = new Float64Array(36), perLC = [], totalIters = 0, allConverged = true, reads = 0, fieldsByLC = {};
  for (var lc = 0; lc < 6; lc++) {
    var eb = [0, 0, 0, 0, 0, 0]; eb[lc] = 1;
    var res = await this.solveLoadCase(eb, tol, maxIt, !!captureLCs && captureLCs.indexOf(lc) >= 0);
    if (res.fields) fieldsByLC[lc] = res.fields;
    totalIters += res.iters; reads += res.readbacks;
    if (!res.converged) allConverged = false;
    for (var P = 0; P < 6; P++) C[P * 6 + lc] = res.sigma[P];
    perLC.push({ axis: voigt[lc], iters: res.iters, converged: res.converged, breakReason: res.breakReason, finalResidual: res.finalResidual });
  }
  return elasticConstantsFromC(C, perLC, totalIters, allConverged, reads, fieldsByLC);
};

/* Symmetrise + invert + engineering constants (as homogenizeFull). */
function elasticConstantsFromC(C_eff, perLC, totalIters, allConverged, readbacks, fieldsByLC) {
  fieldsByLC = fieldsByLC || {};
  for (var P2 = 0; P2 < 6; P2++) for (var Q2 = P2 + 1; Q2 < 6; Q2++) {
    var avg = 0.5 * (C_eff[P2 * 6 + Q2] + C_eff[Q2 * 6 + P2]); C_eff[P2 * 6 + Q2] = avg; C_eff[Q2 * 6 + P2] = avg;
  }
  var S = invert6x6(C_eff);
  if (S === null) return { valid: false, reject_reason: 'singular_C_eff', C_eff: C_eff, perLC: perLC, totalIters: totalIters, allConverged: allConverged, fieldsByLC: fieldsByLC, readbacks: readbacks };
  var C11 = C_eff[0], C12 = C_eff[1], C44 = C_eff[21];
  return {
    valid: true,
    Ex: 1 / S[0], Ey: 1 / S[7], Ez: 1 / S[14], Gyz: 1 / S[21], Gxz: 1 / S[28], Gxy: 1 / S[35],
    nu_xy: -S[1] / S[0], nu_xz: -S[2] / S[0], nu_yz: -S[8] / S[7],
    zenerA: (C11 - C12) > 1e-30 ? (2 * C44) / (C11 - C12) : NaN,
    C_eff: C_eff, S: S, perLC: perLC, totalIters: totalIters, allConverged: allConverged, fieldsByLC: fieldsByLC, readbacks: readbacks
  };
}

/* Entry used by solveDesignElasticFull.  Returns null → caller uses legacy.
   captureLCs: solver LC indices to capture per-voxel fields for. */
async function elasticFastHomogenize(N, solid, C_s, C_v, C_0, opts, info, captureLCs) {
  if (!elasticFastEnabled()) return null;
  var g = elasticFastGamma(N, C_0[21], C_0[1], info);
  if (!g) return null;
  var s = elasticFastSolver(N);
  s.upload(solid, g, C_s, C_v, C_0);
  return await s.homogenize(opts.cgTol || CG_TOL_FULL, opts.cgMaxiter || CG_MAXITER_FULL, captureLCs || []);
}

/* ════════════════════════════════════════════════════════════
   runElasticFastTest — fast vs legacy on the demo designs and a foam.
     await runElasticFastTest(32)          (browser console)
   Pass: every C_ij within 0.1 % of max|C| and the same convergence;
   v0.19.0 — with fields captured, von Mises and u′ within 1 % of their
   max on every axis, and the field run takes the fast path.
   ════════════════════════════════════════════════════════════ */
async function runElasticFastTest(N, extraRecipes) {
  N = N || 32;
  if (!WGPU.device) await ensureDevice();
  var recipes = [];
  ['schwarzP', 'spinodoid', 'beamBCC'].forEach(function (k) { if (typeof DEMO_RECIPES !== 'undefined' && DEMO_RECIPES[k]) recipes.push({ name: k, r: DEMO_RECIPES[k] }); });
  recipes.push({ name: 'foam open 18 %', r: { family: 'foam', seeds: { mode: 'lloyd', count: 27, regularity: 0.9, lloyd_iterations: 4, rng_seed: 1 },
    anisotropy: { enabled: true, stretch: [1, 1, 1] }, foam: { mode: 'open', thickness: 0.3641, normalize: true },
    geometry: { mode: 'solid', cellSizeMm: 5, cellMult: 1 }, material: { Es_MPa: 110000, nu: 0.3 } } });
  (extraRecipes || []).forEach(function (r, i) { recipes.push({ name: r.name || ('extra ' + i), r: r }); });
  var rows = [], allOk = true;
  for (var i = 0; i < recipes.length; i++) {
    var opt = { captureFieldsLCs: [], pruneLargest: true, connectivity: 'networks', voidRatio: 1e-6, cgTol: 1e-4, cgMaxiter: 1000, fastFallback: false };   /* v0.19.0 — test the fast path itself, no legacy safety net */
    window.LAB_FAST_ELASTIC = false;
    var t0 = performance.now(); var L = await solveDesignElasticFull(recipes[i].r, N, opt); var tL = performance.now() - t0;
    window.LAB_FAST_ELASTIC = true;
    var t1 = performance.now(); var Fz = await solveDesignElasticFull(recipes[i].r, N, opt); var tF = performance.now() - t1;
    var t2 = performance.now(); await solveDesignElasticFull(recipes[i].r, N, opt); var tF2 = performance.now() - t2;   /* Γ cached */
    if (!L.C_eff || !Fz.C_eff) { allOk = false; rows.push({ design: recipes[i].name, error: 'no stiffness matrix (' + (L.reject_reason || '') + ' / ' + (Fz.reject_reason || '') + ')' }); continue; }
    var cmax = 0, dmax = 0;
    for (var k = 0; k < 36; k++) { cmax = Math.max(cmax, Math.abs(L.C_eff[k])); dmax = Math.max(dmax, Math.abs(L.C_eff[k] - Fz.C_eff[k])); }
    var rel = dmax / cmax, ok = rel < 1e-3 && (!!L.converged === !!Fz.converged);
    /* v0.19.0 — per-voxel fields (normal runs): von Mises and u′ on every axis */
    var optF = Object.assign({}, opt, { captureFieldsLCs: [0, 1, 2, 3, 4, 5] });
    window.LAB_FAST_ELASTIC = false;
    var t3 = performance.now(); var LF = await solveDesignElasticFull(recipes[i].r, N, optF); var tLF = performance.now() - t3;
    window.LAB_FAST_ELASTIC = true;
    var t4 = performance.now(); var FF = await solveDesignElasticFull(recipes[i].r, N, optF); var tFF = performance.now() - t4;
    var fRel = 0, uRel = 0, fMissing = false;
    ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'].forEach(function (ax) {
      var a = LF.fieldsByAxis && LF.fieldsByAxis[ax], b = FF.fieldsByAxis && FF.fieldsByAxis[ax];
      if (!a || !b) { fMissing = true; return; }
      var m = 0, dm = 0;
      for (var q = 0; q < a.sigma_vm.length; q++) { m = Math.max(m, Math.abs(a.sigma_vm[q])); dm = Math.max(dm, Math.abs(a.sigma_vm[q] - b.sigma_vm[q])); }
      fRel = Math.max(fRel, dm / (m || 1));
      if (!!a.u_prime !== !!b.u_prime) { fMissing = true; return; }
      if (a.u_prime) for (var c3 = 0; c3 < 3; c3++) {
        var mu = 0, du = 0, ua = a.u_prime[c3], ub = b.u_prime[c3];
        for (var q2 = 0; q2 < ua.length; q2++) { mu = Math.max(mu, Math.abs(ua[q2])); du = Math.max(du, Math.abs(ua[q2] - ub[q2])); }
        uRel = Math.max(uRel, du / (mu || 1));
      }
    });
    var okF = !fMissing && fRel < 1e-2 && uRel < 1e-2 && FF.solverPath === 'fast';
    ok = ok && okF;
    if (!ok) allOk = false;
    rows.push({ design: recipes[i].name, rel_dC: rel.toExponential(2), iters_legacy: L.iters, iters_fast: Fz.iters, conv: L.converged + '/' + Fz.converged,
                t_legacy_s: (tL / 1000).toFixed(2), t_fast_s: (tF / 1000).toFixed(2), t_fast_cached_s: (tF2 / 1000).toFixed(2), path: Fz.solverPath,
                fields_dVM: fMissing ? 'missing' : fRel.toExponential(2), fields_du: fMissing ? '-' : uRel.toExponential(2),
                t_fields_legacy_s: (tLF / 1000).toFixed(2), t_fields_fast_s: (tFF / 1000).toFixed(2), ok: ok });
  }
  delete window.LAB_FAST_ELASTIC;
  console.table(rows);
  console.log('[elastic-fast] ' + (allOk ? 'ALL PASS' : 'FAIL'));
  return { ok: allOk, rows: rows };
}

/* ════════════════════════════════════════════════════════════
   runPartialVolumeCheck — v0.19.0 partial-volume voxels on the PI-TPMS
   paper's matched-feature trio (SWEEP.md §8: A4m PI, C4 sheet, D7 skeletal),
   same settings as the paper (ν 0.3, void 1e-6, tolerance 1e-5).
     await runPartialVolumeCheck()            (browser console, ~1–2 min)
     await runPartialVolumeCheck([32, 64])    (skip 128)
   For each design and grid: Ex and Ez ÷ E solid with the 0/1 cube and with
   partial volume, plus the reference — the 0/1 cube extrapolated from the
   two finest grids (order 1, as SWEEP.md §4: doubling the grid roughly
   halves the gap).  Pass: at 64 the reference lies between the cube (low)
   and partial volume (high) — the bracket docs/PARTIAL_VOLUME.md reports.
   ════════════════════════════════════════════════════════════ */
async function runPartialVolumeCheck(grids) {
  grids = grids || [32, 64, 128];
  if (!WGPU.device) await ensureDevice();
  var rows = [
    { run_id: 'A4m', surface: 'gyroid', mode: 'PI-TPMS round', wall_ratio: '0.1364', shift: '(0,1/8,1/2)', grid_N: '64' },
    { run_id: 'C4', surface: 'gyroid', mode: 'sheet', level_c: '0.6453', grid_N: '64' },
    { run_id: 'D7', surface: 'gyroid', mode: 'skeletal', level_c: '1.2786', grid_N: '64' }];
  var out = [], allOk = true;
  for (var i = 0; i < rows.length; i++) {
    var rec = sweepRunFromCsvRow(rows[i]).recipe;
    rec.material = { Es_MPa: 1, nu: 0.3 };
    var byN = {};
    for (var g = 0; g < grids.length; g++) {
      var N = grids[g], o = { captureFieldsLCs: [], pruneLargest: true, connectivity: 'networks', voidRatio: 1e-6, cgTol: 1e-5, cgMaxiter: 3000 };
      var t0 = performance.now(); var B = await solveDesignElasticFull(rec, N, Object.assign({}, o, { partialVolume: false })); var tB = performance.now() - t0;
      var t1 = performance.now(); var P = await solveDesignElasticFull(rec, N, Object.assign({}, o, { partialVolume: true })); var tP = performance.now() - t1;
      byN[N] = { B: B, P: P, tB: tB, tP: tP };
    }
    var nf = grids[grids.length - 1], nc = grids[grids.length - 2];
    var ref = {};
    ['Ex_MPa', 'Ez_MPa'].forEach(function (k) { ref[k] = 2 * byN[nf].B[k] - byN[nc].B[k]; });
    grids.forEach(function (N) {
      var e = byN[N], r = { design: rows[i].run_id, N: N };
      ['Ex_MPa', 'Ez_MPa'].forEach(function (k) {
        var a = k.slice(0, 2);
        r[a + '_cube'] = e.B[k] ? +e.B[k].toPrecision(4) : null;
        r[a + '_pv'] = e.P[k] ? +e.P[k].toPrecision(4) : null;
        r[a + '_cube_vs_ref_%'] = e.B[k] ? +((e.B[k] / ref[k] - 1) * 100).toFixed(1) : null;
        r[a + '_pv_vs_ref_%'] = e.P[k] ? +((e.P[k] / ref[k] - 1) * 100).toFixed(1) : null;
      });
      r.rho_cube = +(e.B.rho * 100).toFixed(2); r.rho_pv = +(e.P.rho * 100).toFixed(2);
      r.partial_voxels_pct = +((e.P.pvVoxelFrac || 0) * 100).toFixed(1);
      r.t_cube_s = +(e.tB / 1000).toFixed(1); r.t_pv_s = +(e.tP / 1000).toFixed(1); r.t_pv_raster_s = +((e.P.tPv_ms || 0) / 1000).toFixed(2);
      if (N === 64 && grids.length >= 3 && !(r['Ex_cube_vs_ref_%'] <= 0 && r['Ex_pv_vs_ref_%'] >= 0 && r['Ez_cube_vs_ref_%'] <= 0 && r['Ez_pv_vs_ref_%'] >= 0)) allOk = false;
      out.push(r);
    });
  }
  console.table(out);
  console.log('[partial-volume] reference = 0/1 cube extrapolated from N = ' + grids.slice(-2).join(' and ') + (grids.length >= 3 ? (allOk ? ' · PASS (at 64 the cube reads low and partial volume high)' : ' · CHECK: at 64 the reference is not between the cube and partial volume') : ''));
  return { ok: allOk, rows: out };
}
