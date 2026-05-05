/* ============================================================
   F13LD.lab · 70-selftest.js
   Validates the FFT pipeline end-to-end with three tests:
     (1) Roundtrip impulse — δ → FFT → IFFT → δ
     (2) Roundtrip Gaussian — smooth signal preserves shape
     (3) Cosine spike — known-frequency input gives correct
         spectral peaks at (1,0,0) and (N-1,0,0)
   Plus a lightweight forward-FFT timing measurement.

   FP32 noise floor is ~1e-6 to 1e-5 for these sizes. Roundtrip
   tests pass under 1e-4 (~10× headroom). The cosine test is
   normalized by the expected peak so it's also unitless ~1e-5.
   ============================================================ */

var SELFTEST = {
  state: 'idle',     // 'idle' | 'running' | 'pass' | 'fail'
  lastResult: null   // populated after a run
};

/* ============================================================
   Public entry point — wired to the link in the controls panel.
   ============================================================ */
async function runSelfTest(){
  var link = document.getElementById('selftestLink');

  if (!HW.webgpu_available){
    paintSelftestLink('fail', '✗ WebGPU not available · run requires a WebGPU browser');
    return;
  }

  paintSelftestLink('running', '⟳ Initializing device...');

  try {
    await ensureDevice();

    paintSelftestLink('running', '⟳ Building FFT plan...');
    var plan = new FFTPlan(64);

    paintSelftestLink('running', '⟳ Roundtrip · impulse...');
    var impulseErr = await testRoundtripImpulse(plan);

    paintSelftestLink('running', '⟳ Roundtrip · Gaussian...');
    var gaussErr = await testRoundtripGaussian(plan);

    paintSelftestLink('running', '⟳ Cosine spike...');
    var cosErr = await testCosineSpike(plan);

    paintSelftestLink('running', '⟳ Timing forward FFT...');
    var forwardMs = await timeForward(plan, 8);

    plan.destroy();

    var maxErr = Math.max(impulseErr, gaussErr, cosErr);
    var threshold = 1e-3;   // generous — FP32 floor ~1e-5

    SELFTEST.lastResult = {
      impulse: impulseErr, gaussian: gaussErr, cosine: cosErr,
      forwardMs: forwardMs, passed: maxErr < threshold
    };

    if (maxErr < threshold){
      paintSelftestLink('pass',
        '✓ FFT 64³ · err ' + maxErr.toExponential(1) +
        ' · forward ' + forwardMs.toFixed(1) + ' ms');
      console.log('%c Self-test passed ', 'background:#34d399; color:#06080f; font-weight:bold; padding:2px 8px; border-radius:3px;',
        '\n impulse round-trip:  ' + impulseErr.toExponential(2) +
        '\n Gaussian round-trip: ' + gaussErr.toExponential(2) +
        '\n cosine spike:        ' + cosErr.toExponential(2) +
        '\n forward FFT (avg of 8): ' + forwardMs.toFixed(2) + ' ms');
    } else {
      paintSelftestLink('fail',
        '✗ FFT err ' + maxErr.toExponential(1) + ' · check console');
      console.warn('Self-test failed:', SELFTEST.lastResult);
    }

  } catch (err){
    console.error('[selftest] error:', err);
    paintSelftestLink('fail', '✗ ' + (err.message || 'unknown error') + ' · check console');
  }
}

function paintSelftestLink(state, text){
  var link = document.getElementById('selftestLink');
  if (!link) return;
  SELFTEST.state = state;
  link.classList.remove('running','pass','fail');
  if (state !== 'idle') link.classList.add(state);
  link.textContent = text;
}

/* ============================================================
   Test 1 · Roundtrip impulse
   x[0,0,0] = 1, all else 0 → forward → inverse → recover x
   ============================================================ */
async function testRoundtripImpulse(plan){
  var N = plan.N;
  var total = N * N * N;
  var input = new Float32Array(2 * total);
  input[0] = 1;          // δ at origin

  plan.upload(input);
  plan.forward();
  plan.inverse();

  var result = await plan.readback(plan.lastResultBuffer);

  var maxErr = 0;
  for (var i = 0; i < 2 * total; i++){
    var e = Math.abs(result[i] - input[i]);
    if (e > maxErr) maxErr = e;
  }
  return maxErr;
}

/* ============================================================
   Test 2 · Roundtrip Gaussian
   Smooth signal with no aliasing — round-trip should be
   essentially perfect at FP32 (smooth = small dynamic range).
   ============================================================ */
async function testRoundtripGaussian(plan){
  var N = plan.N;
  var total = N * N * N;
  var input = new Float32Array(2 * total);

  var sigma = N / 8;
  var sig2  = 2 * sigma * sigma;
  var cx = N / 2, cy = N / 2, cz = N / 2;

  for (var k = 0; k < N; k++){
    for (var j = 0; j < N; j++){
      for (var i = 0; i < N; i++){
        var dx = i - cx, dy = j - cy, dz = k - cz;
        var idx = (i + N * (j + N * k)) * 2;
        input[idx] = Math.exp(-(dx*dx + dy*dy + dz*dz) / sig2);
        // imag part stays 0
      }
    }
  }

  plan.upload(input);
  plan.forward();
  plan.inverse();

  var result = await plan.readback(plan.lastResultBuffer);

  // Relative error vs peak magnitude (~1.0)
  var maxAbs = 0, maxErr = 0;
  for (var n = 0; n < 2 * total; n++){
    var v = Math.abs(input[n]);
    if (v > maxAbs) maxAbs = v;
    var e = Math.abs(result[n] - input[n]);
    if (e > maxErr) maxErr = e;
  }
  return maxErr / Math.max(maxAbs, 1e-30);
}

/* ============================================================
   Test 3 · Cosine spike
   x[i,j,k] = cos(2π · i / N) → forward FFT
   Expected: real spike of N³/2 at (1,0,0) and (N-1,0,0),
             zero elsewhere.
   ============================================================ */
async function testCosineSpike(plan){
  var N = plan.N;
  var total = N * N * N;
  var input = new Float32Array(2 * total);

  for (var k = 0; k < N; k++){
    for (var j = 0; j < N; j++){
      for (var i = 0; i < N; i++){
        var idx = (i + N * (j + N * k)) * 2;
        input[idx] = Math.cos(2 * Math.PI * i / N);
      }
    }
  }

  plan.upload(input);
  plan.forward();

  var result = await plan.readback(plan.lastResultBuffer);

  var expectedPeak = total / 2;     // N³ / 2

  // The spike should land at flat indices 1 and N-1 (i.e. (i=1, j=0, k=0) etc.)
  var idx1   = 1 * 2;
  var idxNm1 = (N - 1) * 2;

  var err = 0;
  err = Math.max(err, Math.abs(result[idx1]     - expectedPeak));   // real at (1,0,0)
  err = Math.max(err, Math.abs(result[idx1 + 1]));                  // imag at (1,0,0)
  err = Math.max(err, Math.abs(result[idxNm1]   - expectedPeak));   // real at (N-1,0,0)
  err = Math.max(err, Math.abs(result[idxNm1 + 1]));                // imag at (N-1,0,0)

  // Sanity-check: a few bins that should be zero
  err = Math.max(err, Math.abs(result[0]));            // (0,0,0) DC
  err = Math.max(err, Math.abs(result[2 * 2]));        // (2,0,0)
  err = Math.max(err, Math.abs(result[N * 2]));        // (0,1,0)
  err = Math.max(err, Math.abs(result[N * N * 2]));    // (0,0,1)

  return err / expectedPeak;
}

/* ============================================================
   Timing — average forward FFT time over `iters` runs.
   Uses queue.onSubmittedWorkDone for accurate GPU sync.
   ============================================================ */
async function timeForward(plan, iters){
  var N = plan.N;
  var total = N * N * N;
  var input = new Float32Array(2 * total);
  for (var i = 0; i < input.length; i++) input[i] = Math.random() * 2 - 1;

  plan.upload(input);

  // Warmup — first run includes pipeline cache misses
  plan.forward();
  await WGPU.device.queue.onSubmittedWorkDone();

  var t0 = performance.now();
  for (var k = 0; k < iters; k++){
    plan.upload(input);
    plan.forward();
  }
  await WGPU.device.queue.onSubmittedWorkDone();
  var elapsed = performance.now() - t0;
  return elapsed / iters;
}
