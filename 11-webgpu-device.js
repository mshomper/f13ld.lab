/* ============================================================
   F13LD.lab · 11-webgpu-device.js
   WebGPU device initialization and lifecycle.

   The adapter is detected eagerly in 10-hardware.js. The device
   is created lazily here on first use — there's no point spinning
   up a GPU device on page load if the user never runs anything.

   ensureDevice() returns the cached device on subsequent calls,
   or the in-flight init promise if a request is already pending.

   Limits requested above default:
     maxStorageBuffersPerShaderStage : 16  (default 8) — needed by
        the elastic solver's tauCompute kernel (9 storage bindings)
        and any future kernel with similar fan-in.  Most modern
        hardware supports 16 or higher; we cap at 16 to keep the
        request honoured on integrated GPUs that don't go further.
     maxStorageBufferBindingSize    : adapter-max  — 64³ vec2<f32> = 2 MB,
        128³ = 16 MB, well under typical 128 MB cap.
     maxBufferSize                  : adapter-max
   ============================================================ */

var WGPU = {
  device: null,
  initialized: false,
  initializing: null,
  errors: []
};

async function ensureDevice(){
  if (WGPU.initialized) return WGPU.device;
  if (WGPU.initializing) return WGPU.initializing;

  WGPU.initializing = (async function(){
    if (!HW || !HW.webgpu_available || !HW.adapter){
      throw new Error('WebGPU not available · cannot initialize device');
    }

    try {
      var lim = HW.adapter.limits || {};

      /* Helper: cap our request at min(adapter-supported, our-target).
         Some integrated adapters don't go above 8 for storage buffers;
         requesting more than supported throws.  We probe and fall back. */
      function reqLim(name, target) {
        var supported = lim[name];
        if (supported == null) return target;
        return Math.min(supported, target);
      }

      var device = await HW.adapter.requestDevice({
        requiredFeatures: [],
        requiredLimits: {
          /* Storage buffers — elastic solver needs 9 in tauCompute */
          maxStorageBuffersPerShaderStage: reqLim('maxStorageBuffersPerShaderStage', 16),
          /* Buffer sizes — N=128 vec2<f32> is 16 MB, well under default 128 MB */
          maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize || 134217728,
          maxBufferSize:               lim.maxBufferSize               || 268435456,
          /* Workgroup limits — match Phase 2 reduction kernel's WG_SIZE=256 */
          maxComputeWorkgroupSizeX:    lim.maxComputeWorkgroupSizeX    || 256,
          maxComputeInvocationsPerWorkgroup: lim.maxComputeInvocationsPerWorkgroup || 256,
          maxComputeWorkgroupsPerDimension:  lim.maxComputeWorkgroupsPerDimension  || 65535
        }
      });

      device.lost.then(function(info){
        console.error('[webgpu] device lost · reason:', info.reason, '· msg:', info.message);
        WGPU.device = null;
        WGPU.initialized = false;
        WGPU.initializing = null;
        if (typeof paintHardwarePill === 'function'){
          paintHardwarePill('WebGPU device lost · reload', 'bad');
        }
      });

      device.addEventListener('uncapturederror', function(ev){
        console.error('[webgpu] uncaptured error:', ev.error && ev.error.message);
        WGPU.errors.push(ev.error && ev.error.message);
      });

      WGPU.device = device;
      WGPU.initialized = true;

      console.log(
        '%c WebGPU device ready ',
        'background:#1D9E75; color:#fff; font-weight:bold; padding:2px 8px; border-radius:3px;',
        HW.adapter_name || 'GPU',
        '· storage-bufs/stage:', device.limits.maxStorageBuffersPerShaderStage
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

/* Drain accumulated uncaptured errors. Self-tests call this BEFORE and
   AFTER their workload to detect silent pipeline / dispatch failures. */
function drainGpuErrors(){
  var errs = WGPU.errors.slice();
  WGPU.errors.length = 0;
  return errs;
}
