/* ============================================================
   F13LD.lab · 11-webgpu-device.js
   WebGPU device initialization and lifecycle.

   The adapter is detected eagerly in 10-hardware.js. The device
   is created lazily here on first use — there's no point spinning
   up a GPU device on page load if the user never runs anything.

   ensureDevice() returns the cached device on subsequent calls,
   or the in-flight init promise if a request is already pending.
   ============================================================ */

var WGPU = {
  device: null,
  initialized: false,
  initializing: null,    // Promise during init
  errors: []
};

/* ----------------------------------------------------------
   Lazy device init. Returns a Promise that resolves to the
   device, or rejects if WebGPU is unavailable or device
   creation fails.
   ---------------------------------------------------------- */
async function ensureDevice(){
  if (WGPU.initialized) return WGPU.device;
  if (WGPU.initializing) return WGPU.initializing;

  WGPU.initializing = (async function(){
    if (!HW || !HW.webgpu_available || !HW.adapter){
      throw new Error('WebGPU not available · cannot initialize device');
    }

    try {
      var lim = HW.adapter.limits || {};
      var device = await HW.adapter.requestDevice({
        requiredFeatures: [],
        // Pull every limit up to the adapter's ceiling so 64³ and 128³ FFTs work
        requiredLimits: {
          maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize || 134217728,
          maxBufferSize:               lim.maxBufferSize               || 268435456,
          maxComputeWorkgroupSizeX:    lim.maxComputeWorkgroupSizeX    || 256,
          maxComputeInvocationsPerWorkgroup: lim.maxComputeInvocationsPerWorkgroup || 256,
          maxComputeWorkgroupsPerDimension:  lim.maxComputeWorkgroupsPerDimension  || 65535
        }
      });

      // Surface device-lost events. We don't try to recover here —
      // user gets a visible "device lost" indicator and reload is the path.
      device.lost.then(function(info){
        console.error('[webgpu] device lost · reason:', info.reason, '· msg:', info.message);
        WGPU.device = null;
        WGPU.initialized = false;
        WGPU.initializing = null;
        if (typeof paintHardwarePill === 'function'){
          paintHardwarePill('WebGPU device lost · reload', 'bad');
        }
      });

      // Capture validation errors so we can surface them in the self-test
      device.addEventListener('uncapturederror', function(ev){
        console.error('[webgpu] uncaptured error:', ev.error && ev.error.message);
        WGPU.errors.push(ev.error && ev.error.message);
      });

      WGPU.device = device;
      WGPU.initialized = true;

      console.log(
        '%c WebGPU device ready ',
        'background:#1D9E75; color:#fff; font-weight:bold; padding:2px 8px; border-radius:3px;',
        HW.adapter_name || 'GPU'
      );
      return device;

    } catch (err){
      console.error('[webgpu] requestDevice failed:', err);
      WGPU.initializing = null;
      throw err;
    }
  })();

  try {
    return await WGPU.initializing;
  } catch (err){
    WGPU.initializing = null;
    throw err;
  }
}

/* ----------------------------------------------------------
   Drain any uncaptured errors accumulated since last call.
   Used by the self-test to verify a clean run.
   ---------------------------------------------------------- */
function drainGpuErrors(){
  var errs = WGPU.errors.slice();
  WGPU.errors.length = 0;
  return errs;
}
