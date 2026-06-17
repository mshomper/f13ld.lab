/* ============================================================
   F13LD.lab · 16e-buckling-cpu-worker.js
   On-demand CPU buckling (16c oracle) on a Web Worker POOL.

   16c is a dense-validated REFERENCE solver, not interactive —
   each axis is a CPU eigenproblem of tens of seconds.  The three
   compression axes are independent, so they run as separate tasks
   across a pool of persistent workers; a single design parallelises
   over 3 cores, and a multi-design batch saturates the pool.

   Pool size = min(hardwareConcurrency - 1, 8), leaving a core for
   the UI / raymarcher.  Workers are spawned lazily up to that size
   and reused across computes (each importScripts the solver files
   once).  Each worker is a Blob that importScripts() the same-origin
   solver files (FFT, rasterizer, kernels, 16c) — no embedded source,
   so it always tracks the live files.

   GPU LOBPCG (16d) supersedes this for interactive full-res runs;
   16e stays as the reference path 16d is checked against, and as a
   no-WebGPU fallback.

   Public API (main thread):
     computeBucklingCPU(recipe, N, opts, onProgress) -> Promise<result>
     F13LD_buckleBench(recipe, N)                     -> console benchmark
     F13LD_bucklePoolInfo()                           -> { size, spawned, busy }

   result = {
     lambda_cr, pcr, critAxis, rho,
     perAxis: [ { axis, lambda, sBar, cgIters } ],
     modes:   { xx|yy|zz: { u_prime:[Float32,Float32,Float32],
                            sigma_vm:null, N, eps_bar:[x,y,z] } }
   }
   The modes fieldset matches LabRaymarcher.uploadFields, so a buckling
   mode shape reuses the Deformed-tab warp path directly.
   ============================================================ */

/* Reference-compute defaults: small block (only the critical mode
   matters), loose eigen / inner-CG tolerances (subspace iteration
   tolerates inexact solves), capped CG.  λ_cr lands within ~1% of the
   tight-tolerance value while running several times faster. */
var BUCKLE_CPU_DEFAULTS = {
  block:     4,
  eigIters:  30,
  eigTol:    1e-3,
  cgTol:     3e-3,
  cgMaxiter: 250
};

/* Solver files the worker loads, in dependency order:
   FFT (18) -> rasterizer/isoC/buildVoxels (14) -> kernels (13) -> 16c. */
var BUCKLE_WORKER_FILES = [
  '18-stokes-cpu-ref.js',
  '14-rasterizer.js',
  '13-kernels.js',
  '16c-buckling-cpu-ref.js'
];

/* Worker onmessage body (single-quote/concatenated string — no backticks
   or ${}, worker-source convention).  Solves ONE axis per task and echoes
   the task id so the pool can route the reply.  Ships the mode field as
   transferable Float32Arrays. */
var BUCKLE_WORKER_ONMESSAGE =
  'onmessage = function(e){\n' +
  '  var job = e.data, N = job.N, opts = job.opts || {};\n' +
  '  try {\n' +
  '    var one = homogenizeBucklingCPU(job.recipe, N, opts);\n' +
  '    var pa = one.perAxis[0];\n' +
  '    var mode = null, transfer = [];\n' +
  '    if (pa.mode){\n' +
  '      var N3 = N*N*N, ux = new Float32Array(N3), uy = new Float32Array(N3), uz = new Float32Array(N3);\n' +
  '      for (var i = 0; i < N3; i++){ ux[i] = pa.mode[i]; uy[i] = pa.mode[N3+i]; uz[i] = pa.mode[2*N3+i]; }\n' +
  '      var axisNames = ["xx","yy","zz"], ev = [0,0,0], ai = axisNames.indexOf(pa.axis); if (ai >= 0) ev[ai] = 1;\n' +
  '      mode = { u_prime:[ux,uy,uz], sigma_vm:null, N:N, eps_bar:[0,0,0] };\n' +
  '      transfer.push(ux.buffer, uy.buffer, uz.buffer);\n' +
  '    }\n' +
  '    postMessage({ id: job.id, type:"done", perAxis:{ axis:pa.axis, lambda:pa.lambda, sBar:pa.sBar, cgIters:pa.cgIters }, mode: mode, rho: one.rho }, transfer);\n' +
  '  } catch (err){ postMessage({ id: job.id, type:"error", message: (err && err.message) || String(err) }); }\n' +
  '};\n';

/* Build a Blob worker that importScripts the solver files by absolute,
   same-origin URL (a Blob worker's base URL is the blob: URL, so relative
   imports would not resolve). */
function makeBucklingWorker(){
  var base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : location.href;
  var urls = [];
  for (var i = 0; i < BUCKLE_WORKER_FILES.length; i++){
    urls.push(JSON.stringify(new URL(BUCKLE_WORKER_FILES[i], base).href));
  }
  var body = 'importScripts(' + urls.join(',') + ');\n' + BUCKLE_WORKER_ONMESSAGE;
  var blob = new Blob([body], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

/* ----------------------------------------------------------
   BucklingPool — persistent pool of single-axis workers.
   Workers spawn lazily up to `size` as tasks demand, and are
   reused.  pool.run(task) -> Promise resolving to the worker's
   reply message.  task = { recipe, N, opts } where opts.axes is a
   single axis.
   ---------------------------------------------------------- */
function BucklingPool(size){
  this.size = Math.max(1, size);
  this.workers = [];     /* { worker, busy, jobId } */
  this.queue   = [];     /* { id, task } */
  this.jobs    = {};     /* id -> { resolve, reject } */
  this._nextId = 1;
}

BucklingPool.prototype._spawn = function(){
  var rec = { worker: makeBucklingWorker(), busy: false, jobId: null };
  var self = this;
  rec.worker.onmessage = function(ev){ self._onMessage(rec, ev.data); };
  rec.worker.onerror   = function(e){ self._onError(rec, (e && e.message) || 'buckling worker error'); };
  this.workers.push(rec);
  return rec;
};

BucklingPool.prototype._freeWorker = function(){
  for (var i = 0; i < this.workers.length; i++){ if (!this.workers[i].busy) return this.workers[i]; }
  return null;
};

BucklingPool.prototype._dispatch = function(){
  while (this.queue.length){
    var rec = this._freeWorker();
    if (!rec){
      if (this.workers.length < this.size) rec = this._spawn();
      else break;
    }
    var item = this.queue.shift();
    rec.busy = true; rec.jobId = item.id;
    var t = item.task;
    rec.worker.postMessage({ id: item.id, recipe: t.recipe, N: t.N, opts: t.opts });
  }
};

BucklingPool.prototype._onMessage = function(rec, msg){
  rec.busy = false; rec.jobId = null;
  var job = this.jobs[msg.id];
  if (job){
    delete this.jobs[msg.id];
    if (msg.type === 'done') job.resolve(msg);
    else job.reject(new Error(msg.message || 'buckling task failed'));
  }
  this._dispatch();
};

BucklingPool.prototype._onError = function(rec, message){
  /* worker crashed mid-task: reject its job, drop and respawn on demand */
  var id = rec.jobId;
  if (id != null && this.jobs[id]){ this.jobs[id].reject(new Error(message)); delete this.jobs[id]; }
  var idx = this.workers.indexOf(rec);
  if (idx >= 0) this.workers.splice(idx, 1);
  try { rec.worker.terminate(); } catch (e) { /* ignore */ }
  this._dispatch();
};

BucklingPool.prototype.run = function(task){
  var self = this;
  return new Promise(function(resolve, reject){
    var id = self._nextId++;
    self.jobs[id] = { resolve: resolve, reject: reject };
    self.queue.push({ id: id, task: task });
    self._dispatch();
  });
};

/* Lazily-created module singleton pool. */
var _bucklePool = null;
function getBucklingPool(){
  if (_bucklePool) return _bucklePool;
  var hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
  var size = Math.max(1, Math.min(hw - 1, 8));
  _bucklePool = new BucklingPool(size);
  return _bucklePool;
}

function F13LD_bucklePoolInfo(){
  var p = _bucklePool;
  if (!p) return { size: getBucklingPool().size, spawned: 0, busy: 0 };
  var busy = 0; for (var i = 0; i < p.workers.length; i++) if (p.workers[i].busy) busy++;
  return { size: p.size, spawned: p.workers.length, busy: busy };
}

/* computeBucklingCPU — run the reference buckling solve for one recipe,
   parallelising the three axes across the pool.
     recipe      lab recipe (family/surface|field/geometry/material)
     N           grid resolution (8 fast / 16 accurate)
     opts        overrides BUCKLE_CPU_DEFAULTS; may set axes
     onProgress  optional fn({done,total,axis,lambda}) per axis completion
   Resolves with the aggregated result; rejects if any axis fails. */
function computeBucklingCPU(recipe, N, opts, onProgress){
  var merged = {}, k;
  for (k in BUCKLE_CPU_DEFAULTS){ if (BUCKLE_CPU_DEFAULTS.hasOwnProperty(k)) merged[k] = BUCKLE_CPU_DEFAULTS[k]; }
  if (opts){ for (k in opts){ if (opts.hasOwnProperty(k)) merged[k] = opts[k]; } }
  N = N || 8;
  var axes = merged.axes || [0, 1, 2];
  var pool = getBucklingPool();
  var done = 0;

  var tasks = [];
  for (var ai = 0; ai < axes.length; ai++){
    (function(axis){
      var taskOpts = {}, kk;
      for (kk in merged){ if (merged.hasOwnProperty(kk)) taskOpts[kk] = merged[kk]; }
      taskOpts.axes = [axis];
      tasks.push(pool.run({ recipe: recipe, N: N, opts: taskOpts }).then(function(msg){
        done++;
        if (onProgress) onProgress({ done: done, total: axes.length, axis: msg.perAxis.axis, lambda: msg.perAxis.lambda });
        return msg;
      }));
    })(axes[ai]);
  }

  return Promise.all(tasks).then(function(msgs){
    var perAxis = [], modes = {}, lambdaCr = Infinity, critAxis = null, critSbar = 0, rho = 0;
    for (var i = 0; i < msgs.length; i++){
      var m = msgs[i];
      rho = m.rho;
      perAxis.push(m.perAxis);
      if (m.mode){
        /* |phi| per voxel drives the relative-displacement colormap (reuses
           the stress R8 path).  Magnitude is qualitative; the tile caps at
           max|phi| so the contour normalizes to 0..1. */
        var mm = m.mode;
        if (mm.u_prime && mm.u_prime.length === 3){
          var nv = mm.N * mm.N * mm.N, mag = new Float32Array(nv);
          var px = mm.u_prime[0], py = mm.u_prime[1], pz = mm.u_prime[2];
          for (var iv = 0; iv < nv; iv++){
            var vax = px[iv], vay = py[iv], vaz = pz[iv];
            mag[iv] = Math.sqrt(vax*vax + vay*vay + vaz*vaz);
          }
          mm.sigma_vm = mag;
        }
        modes[m.perAxis.axis] = mm;
      }
      if (isFinite(m.perAxis.lambda) && m.perAxis.lambda < lambdaCr){
        lambdaCr = m.perAxis.lambda; critAxis = m.perAxis.axis; critSbar = m.perAxis.sBar;
      }
    }
    /* keep perAxis in xx,yy,zz order regardless of completion order */
    var order = { xx: 0, yy: 1, zz: 2 };
    perAxis.sort(function(a, b){ return (order[a.axis] || 0) - (order[b.axis] || 0); });
    var pcr = isFinite(lambdaCr) ? lambdaCr * Math.abs(critSbar) : Infinity;
    return { lambda_cr: lambdaCr, pcr: pcr, critAxis: critAxis, rho: rho, perAxis: perAxis, modes: modes };
  });
}

/* F13LD_buckleBench — console helper to measure this machine's real
   buckling timing (now pool-parallel across axes).
     F13LD_buckleBench()                     // Schwarz P demo, N=8
     F13LD_buckleBench(DEMO_SPINODOID, 16)   // any demo recipe, N=16 */
function F13LD_buckleBench(recipe, N){
  recipe = recipe || (typeof DEMO_SCHWARZ_P !== 'undefined' ? DEMO_SCHWARZ_P : null);
  N = N || 8;
  if (!recipe){ console.warn('[buckle bench] no recipe available'); return; }
  var info = F13LD_bucklePoolInfo();
  var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  function now(){ return (((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0) / 1000; }
  console.log('[buckle bench] ' + (recipe.name || recipe.family) + ' · N=' + N + ' · pool=' + info.size + ' · starting…');
  return computeBucklingCPU(recipe, N, {}, function(p){
    console.log('  axis ' + p.done + '/' + p.total + ' (' + p.axis + ')  \u03bb=' + p.lambda.toExponential(3) + '  @ ' + now().toFixed(1) + 's');
  }).then(function(r){
    console.log('[buckle bench] DONE @ ' + now().toFixed(1) + 's  \u03bb_cr=' + r.lambda_cr.toExponential(4) + '  crit=' + r.critAxis + '  p_cr=' + r.pcr.toFixed(2) + ' MPa  \u03c1=' + r.rho.toFixed(3));
    return r;
  }).catch(function(e){ console.error('[buckle bench] failed:', e); });
}
