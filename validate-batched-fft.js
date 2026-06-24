/* ============================================================
   F13LD.lab · validate-batched-fft.js
   Standalone, browser-side validation for the batched FFTPlan
   (12-fft-plan.js, optional `batch` arg).  Independent of the
   elastic solver — this is the Step-1 parity checkpoint that must
   pass before the batched FFT is wired into 16b's applyA.

   Run from the browser console once the lab page has loaded:

       await F13LD_batchedFFTValidate();      // parity gates
       await F13LD_batchedFFTBench(16, 108);   // dispatch-collapse timing

   What it proves:
     1. round-trip   — forward∘inverse == identity, per slot (≤1e-4)
     2. per-slot      — every batched slot equals the trusted single-
                        transform FFTPlan(N,1) of that same signal (≤1e-4)
     3. determinism   — two identical input slots give identical output
                        (no slot bleed / wrong offset)
     4. batch=1 parity— the batched plan at batch=1 matches the legacy
                        single-transform output bit-for-tol

   None of this touches the elastic path; if a gate fails the bug is in
   the FFT primitive alone.
   ============================================================ */

/* mulberry32 — tiny deterministic PRNG so inputs are reproducible. */
function _bf_rng(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Build a batched, interleaved (re,im) complex array of length 2·batch·N³.
   Imag parts are zero (real input fields, as the solver uses). Each slot is
   seeded distinctly EXCEPT the optional `twinSlots` pair, which is made
   identical to test cross-slot determinism. */
function _bf_makeInput(N, batch, seedBase, twinSlots){
  var N3 = N * N * N;
  var arr = new Float32Array(2 * batch * N3);
  for (var s = 0; s < batch; s++){
    var seedSlot = (twinSlots && s === twinSlots[1]) ? twinSlots[0] : s;
    var rnd = _bf_rng(seedBase + 1013 * seedSlot);
    var base = s * 2 * N3;
    for (var e = 0; e < N3; e++){
      arr[base + 2 * e]     = rnd() * 2 - 1;  /* re */
      arr[base + 2 * e + 1] = 0;              /* im */
    }
  }
  return arr;
}

/* Extract slot s (interleaved complex, length 2·N³) from a batched array. */
function _bf_slice(arr, N, s){
  var N3 = N * N * N;
  return arr.subarray(s * 2 * N3, (s + 1) * 2 * N3);
}

/* Max abs difference between two equal-length interleaved complex arrays. */
function _bf_maxAbsDiff(a, b){
  var m = 0;
  for (var i = 0; i < a.length; i++){
    var d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/* Max magnitude of an interleaved complex array (for relative scaling). */
function _bf_maxMag(a){
  var m = 0;
  for (var i = 0; i < a.length; i += 2){
    var mag = Math.hypot(a[i], a[i + 1]);
    if (mag > m) m = mag;
  }
  return m;
}

async function F13LD_batchedFFTValidate(opts){
  opts = opts || {};
  if (typeof ensureDevice === 'function') { await ensureDevice(); }
  if (!WGPU.device) { console.error('[batched-fft] no WebGPU device'); return { ok: false }; }

  var N        = opts.N || 16;
  var batches  = opts.batches || [1, 6, 18, 108];
  var rtTol    = opts.rtTol || 1e-4;   /* round-trip abs tol (fields are O(1)) */
  var slotTol  = opts.slotTol || 1e-4; /* per-slot relative tol vs single plan */
  var N3       = N * N * N;

  console.log('%c[batched-fft] validation · N=' + N, 'font-weight:bold');
  var allOk = true;
  var rows = [];

  /* A single-transform reference plan, reused across batches. */
  var refPlan = new FFTPlan(N, 1);

  for (var bi = 0; bi < batches.length; bi++){
    var B = batches[bi];
    var twin = (B >= 2) ? [0, 1] : null;   /* force slot 1 == slot 0 when possible */
    var input = _bf_makeInput(N, B, 12345, twin);

    var plan = new FFTPlan(N, B);
    if (plan.batch !== B) { console.error('[batched-fft] batch mismatch', plan.batch, B); }

    /* ---- forward (batched) ---- */
    plan.upload(input);
    var fwdBuf = plan.forward();
    var fwd = await plan.readback(fwdBuf);

    /* ---- per-slot parity vs single-transform plan ---- */
    var worstSlotRel = 0;
    for (var s = 0; s < B; s++){
      var slotSignal = _bf_slice(input, N, s).slice(0); /* copy (upload reads length) */
      refPlan.upload(slotSignal);
      var refBuf = refPlan.forward();
      var ref = await refPlan.readback(refBuf);
      var diff = _bf_maxAbsDiff(_bf_slice(fwd, N, s), ref);
      var scale = Math.max(_bf_maxMag(ref), 1e-12);
      var rel = diff / scale;
      if (rel > worstSlotRel) worstSlotRel = rel;
    }

    /* ---- determinism: twin slots must match exactly (to fp tol) ---- */
    var twinDiff = 0;
    if (twin){
      twinDiff = _bf_maxAbsDiff(_bf_slice(fwd, N, twin[0]), _bf_slice(fwd, N, twin[1]));
    }

    /* ---- round-trip: inverse(forward(x)) == x per slot ---- */
    /* Re-upload the forward result and invert. */
    plan.upload(fwd);
    var invBuf = plan.inverse();
    var inv = await plan.readback(invBuf);
    var worstRt = 0;
    for (var s2 = 0; s2 < B; s2++){
      var rt = _bf_maxAbsDiff(_bf_slice(inv, N, s2), _bf_slice(input, N, s2));
      if (rt > worstRt) worstRt = rt;
    }

    var ok = (worstSlotRel <= slotTol) && (worstRt <= rtTol) && (twinDiff <= 1e-5);
    allOk = allOk && ok;
    rows.push({
      batch: B,
      'slot-rel-err': worstSlotRel.toExponential(2),
      'roundtrip-err': worstRt.toExponential(2),
      'twin-Δ': twinDiff.toExponential(2),
      pass: ok ? '✓' : '✗'
    });

    plan.destroy();
  }

  refPlan.destroy();

  if (console.table) console.table(rows);
  console.log('%c[batched-fft] ' + (allOk ? '✓ ALL GATES PASS' : '✗ FAILURES — do not wire into 16b yet'),
              'font-weight:bold;color:' + (allOk ? '#1D9E75' : '#cc3333'));
  return { ok: allOk, rows: rows };
}

/* F13LD_batchedFFTBench — wall-time of one batched forward over `batch` slots
   vs the same `batch` transforms done serially on a single-transform plan.
   Shows the dispatch-collapse (one stage-set vs `batch` stage-sets). */
async function F13LD_batchedFFTBench(N, batch){
  N = N || 16; batch = batch || 108;
  if (typeof ensureDevice === 'function') { await ensureDevice(); }
  if (!WGPU.device) { console.error('[batched-fft] no WebGPU device'); return; }

  var iters = 20, d = WGPU.device;
  var input = _bf_makeInput(N, batch, 999, null);

  var batched = new FFTPlan(N, batch);
  batched.upload(input);
  /* warm */ batched.forward(); await d.queue.onSubmittedWorkDone();
  var t0 = performance.now();
  for (var i = 0; i < iters; i++){ batched.forward(); }
  await d.queue.onSubmittedWorkDone();
  var tBatched = (performance.now() - t0) / iters;
  batched.destroy();

  var single = new FFTPlan(N, 1);
  var slot0 = _bf_slice(input, N, 0).slice(0);
  single.upload(slot0); single.forward(); await d.queue.onSubmittedWorkDone();
  var t1 = performance.now();
  for (var j = 0; j < iters; j++){
    for (var s = 0; s < batch; s++){ single.upload(slot0); single.forward(); }
  }
  await d.queue.onSubmittedWorkDone();
  var tSerial = (performance.now() - t1) / iters;
  single.destroy();

  console.log('%c[batched-fft] bench N=' + N + ' batch=' + batch, 'font-weight:bold');
  console.log('  batched (1 dispatch-set) : ' + tBatched.toFixed(3) + ' ms/forward');
  console.log('  serial  (' + batch + ' dispatch-sets): ' + tSerial.toFixed(3) + ' ms/forward');
  console.log('  speedup : ' + (tSerial / tBatched).toFixed(1) + '×');
  return { tBatched: tBatched, tSerial: tSerial, speedup: tSerial / tBatched };
}

if (typeof window !== 'undefined'){
  window.F13LD_batchedFFTValidate = F13LD_batchedFFTValidate;
  window.F13LD_batchedFFTBench    = F13LD_batchedFFTBench;
}
