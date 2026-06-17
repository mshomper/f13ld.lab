/* ============================================================
   F13LD.lab · 16e-buckling-cpu-worker.js
   On-demand CPU buckling (16c oracle) in a Web Worker.

   16c is a dense-validated REFERENCE solver, not an interactive
   one — even at N=8 a 3-axis solve is tens of seconds, and the
   inner K-solves are CPU CG.  Running it in a worker keeps the UI
   responsive while the eigenproblem grinds; results stream back
   per axis so the design grid can show progress.

   The worker is a small Blob that importScripts() the same-origin
   solver files (FFT, rasterizer, kernels, 16c) and runs
   homogenizeBucklingCPU per axis.  No bundler, no embedded source
   — just URL imports — so it always tracks the live solver files.

   GPU LOBPCG (16d) supersedes this for interactive full-res runs;
   16e remains as the reference path the GPU solver is checked
   against, and as a no-WebGPU fallback.

   Public API (main thread):
     computeBucklingCPU(recipe, N, opts, onProgress) → Promise<result>
     F13LD_buckleBench(recipe, N)                     → console benchmark

   result = {
     lambda_cr, pcr, critAxis, rho,
     perAxis: [ { axis, lambda, sBar, cgIters } ],
     modes:   { xx|yy|zz: { u_prime:[Float32,Float32,Float32],
                            sigma_vm:null, N, eps_bar:[x,y,z] } }
   }
   The modes fieldset matches LabRaymarcher.uploadFields, so a
   buckling mode shape reuses the Deformed-tab warp path directly.
   ============================================================ */

/* Default reference-compute parameters.  Tuned for a usable on-demand
   estimate: small block (only the critical mode matters), loose eigen
   and inner-CG tolerances (subspace iteration tolerates inexact solves),
   capped CG.  λ_cr lands within ~1% of the tight-tolerance value while
   running ~5× faster.  N is the caller's choice (8 = fast coarse
   estimate; 16 = slower, more accurate). */
var BUCKLE_CPU_DEFAULTS = {
  block:     4,
  eigIters:  30,
  eigTol:    1e-3,
  cgTol:     3e-3,
  cgMaxiter: 250
};

/* Solver files the worker must load, in dependency order:
   FFT (18) → rasterizer/isoC/buildVoxels (14) → kernels (13) → 16c. */
var BUCKLE_WORKER_FILES = [
  '18-stokes-cpu-ref.js',
  '14-rasterizer.js',
  '13-kernels.js',
  '16c-buckling-cpu-ref.js'
];

/* Worker onmessage body, authored as a single-quoted/concatenated string
   (no backticks or ${} — worker-source convention).  Loops the requested
   axes one at a time so progress can be posted between them, aggregates
   the critical (minimum positive) λ, and ships each axis's mode field as
   transferable Float32Arrays. */
var BUCKLE_WORKER_ONMESSAGE =
  'onmessage = function(e){\n' +
  '  var job = e.data, N = job.N, opts = job.opts || {};\n' +
  '  var axisNames = ["xx","yy","zz"];\n' +
  '  var axes = opts.axes || [0,1,2];\n' +
  '  try {\n' +
  '    var modes = {}, transfer = [], perAxis = [];\n' +
  '    var lambdaCr = Infinity, critAxis = null, critSbar = 0, rho = 0;\n' +
  '    for (var ax = 0; ax < axes.length; ax++){\n' +
  '      var one = homogenizeBucklingCPU(job.recipe, N, Object.assign({}, opts, { axes:[axes[ax]] }));\n' +
  '      rho = one.rho;\n' +
  '      var pa = one.perAxis[0];\n' +
  '      perAxis.push({ axis: pa.axis, lambda: pa.lambda, sBar: pa.sBar, cgIters: pa.cgIters });\n' +
  '      if (pa.mode){\n' +
  '        var N3 = N*N*N, ux = new Float32Array(N3), uy = new Float32Array(N3), uz = new Float32Array(N3);\n' +
  '        for (var i = 0; i < N3; i++){ ux[i] = pa.mode[i]; uy[i] = pa.mode[N3+i]; uz[i] = pa.mode[2*N3+i]; }\n' +
  '        var ev = [0,0,0], ai = axisNames.indexOf(pa.axis); if (ai >= 0) ev[ai] = 1;\n' +
  '        modes[pa.axis] = { u_prime:[ux,uy,uz], sigma_vm:null, N:N, eps_bar:ev };\n' +
  '        transfer.push(ux.buffer, uy.buffer, uz.buffer);\n' +
  '      }\n' +
  '      if (isFinite(pa.lambda) && pa.lambda < lambdaCr){ lambdaCr = pa.lambda; critAxis = pa.axis; critSbar = pa.sBar; }\n' +
  '      postMessage({ type:"progress", done: ax+1, total: axes.length, axis: pa.axis, lambda: pa.lambda });\n' +
  '    }\n' +
  '    var pcr = isFinite(lambdaCr) ? lambdaCr * Math.abs(critSbar) : Infinity;\n' +
  '    postMessage({ type:"done", result:{ lambda_cr: lambdaCr, pcr: pcr, critAxis: critAxis, rho: rho, perAxis: perAxis, modes: modes } }, transfer);\n' +
  '  } catch (err){ postMessage({ type:"error", message: (err && err.message) || String(err) }); }\n' +
  '};\n';

/* Resolve the solver files to absolute, same-origin URLs and build a Blob
   worker that imports them.  Absolute URLs are required because a Blob
   worker's base URL is the blob: URL, not the page. */
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

/* computeBucklingCPU — run the reference buckling solve off-thread.
     recipe      lab recipe (family/surface|field/geometry/material)
     N           grid resolution (8 fast / 16 accurate)
     opts        overrides BUCKLE_CPU_DEFAULTS; may set axes
     onProgress  optional fn({done,total,axis,lambda}) per axis
   Resolves with the result object; rejects on worker/solver error.
   The worker is created per call and terminated on completion. */
function computeBucklingCPU(recipe, N, opts, onProgress){
  var merged = {};
  var k;
  for (k in BUCKLE_CPU_DEFAULTS){ if (BUCKLE_CPU_DEFAULTS.hasOwnProperty(k)) merged[k] = BUCKLE_CPU_DEFAULTS[k]; }
  if (opts){ for (k in opts){ if (opts.hasOwnProperty(k)) merged[k] = opts[k]; } }

  return new Promise(function(resolve, reject){
    var w;
    try { w = makeBucklingWorker(); }
    catch (e){ reject(e); return; }

    w.onmessage = function(ev){
      var m = ev.data;
      if (m.type === 'progress'){ if (onProgress) onProgress(m); }
      else if (m.type === 'done'){ w.terminate(); resolve(m.result); }
      else if (m.type === 'error'){ w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = function(e){ w.terminate(); reject(new Error((e && e.message) || 'buckling worker error')); };

    w.postMessage({ recipe: recipe, N: (N || 8), opts: merged });
  });
}

/* F13LD_buckleBench — console helper to measure this machine's real
   buckling timing.  Usage from the browser console:
     F13LD_buckleBench()                     // Schwarz P demo, N=8
     F13LD_buckleBench(DEMO_SPINODOID, 16)   // any demo recipe, N=16
   Logs per-axis progress + wall time so the UI's default N can be set
   from real numbers rather than sandbox estimates. */
function F13LD_buckleBench(recipe, N){
  recipe = recipe || (typeof DEMO_SCHWARZ_P !== 'undefined' ? DEMO_SCHWARZ_P : null);
  N = N || 8;
  if (!recipe){ console.warn('[buckle bench] no recipe available'); return; }
  var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  function now(){ return (((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0) / 1000; }
  console.log('[buckle bench] ' + (recipe.name || recipe.family) + ' · N=' + N + ' · starting…');
  return computeBucklingCPU(recipe, N, {}, function(p){
    console.log('  axis ' + p.done + '/' + p.total + ' (' + p.axis + ')  \u03bb=' + p.lambda.toExponential(3) + '  @ ' + now().toFixed(1) + 's');
  }).then(function(r){
    console.log('[buckle bench] DONE @ ' + now().toFixed(1) + 's  \u03bb_cr=' + r.lambda_cr.toExponential(4) + '  crit=' + r.critAxis + '  p_cr=' + r.pcr.toFixed(2) + ' MPa  \u03c1=' + r.rho.toFixed(3));
    return r;
  }).catch(function(e){ console.error('[buckle bench] failed:', e); });
}
