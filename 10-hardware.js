/* ============================================================
   F13LD.lab · 10-hardware.js
   WebGPU adapter detection + hardware tier classification.
   Populates the Hardware pill in the controls panel and the
   Solver pill in the view strip.
   ============================================================ */

var HW = {
  webgpu_available: false,
  adapter_name: null,
  adapter: null,
  device: null,
  is_discrete: null,
  vram_estimate_mb: null,
  tier: 'unknown'   // 'low' | 'medium' | 'high' | 'cpu_fallback' | 'unknown'
};

/* ----------------------------------------------------------
   Detect WebGPU and the underlying adapter. Phase 1 only
   reads the adapter info — no device created yet. Device
   init lives in Phase 2.
   ---------------------------------------------------------- */
async function detectHardware(){
  // Branch 1: WebGPU not in the browser at all
  if (!('gpu' in navigator)){
    HW.webgpu_available = false;
    HW.tier = 'cpu_fallback';
    paintHardwarePill('WebGPU unavailable', 'bad');
    paintSolverPill('CPU fallback only', 'warn');
    return HW;
  }

  // Branch 2: WebGPU present but adapter request fails
  try {
    var adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter){
      HW.webgpu_available = false;
      HW.tier = 'cpu_fallback';
      paintHardwarePill('No GPU adapter', 'bad');
      paintSolverPill('CPU fallback only', 'warn');
      return HW;
    }

    HW.webgpu_available = true;
    HW.adapter = adapter;

    // adapter.info exists in Chromium 119+, may be undefined in older builds
    var info = adapter.info || {};
    var vendor = (info.vendor || '').toLowerCase();
    var arch   = info.architecture || info.device || '';
    var desc   = info.description || arch || vendor || 'GPU';

    // Best-effort name reconstruction
    var name = '';
    if (vendor.indexOf('nvidia') !== -1) name = 'NVIDIA';
    else if (vendor.indexOf('amd') !== -1 || vendor.indexOf('ati') !== -1) name = 'AMD';
    else if (vendor.indexOf('intel') !== -1) name = 'Intel';
    else if (vendor.indexOf('apple') !== -1) name = 'Apple';
    else if (desc) name = (desc.charAt(0).toUpperCase() + desc.slice(1)).split(' ').slice(0,2).join(' ');
    else name = 'WebGPU device';

    if (arch && name && desc.toLowerCase().indexOf(arch.toLowerCase()) === -1){
      name = name + ' · ' + arch;
    }

    HW.adapter_name = name;

    // Classify tier from limits — proxy for VRAM / compute capability
    var lims = adapter.limits || {};
    var maxBuf = lims.maxStorageBufferBindingSize || 0;
    HW.is_discrete = maxBuf > 1e9;   // >1 GB single buffer suggests discrete

    if (maxBuf >= 2e9){
      HW.tier = 'high';
      HW.vram_estimate_mb = 8192;
    } else if (maxBuf >= 1e9){
      HW.tier = 'medium';
      HW.vram_estimate_mb = 4096;
    } else if (maxBuf > 0){
      HW.tier = 'low';
      HW.vram_estimate_mb = 1024;
    } else {
      HW.tier = 'unknown';
    }

    paintHardwarePill('WebGPU · ' + name, HW.tier === 'high' ? 'green' : (HW.tier === 'low' ? 'warn' : ''));
    paintSolverPill('solver ready', 'live');
    return HW;
  } catch (err){
    console.warn('[hardware] adapter request failed:', err);
    HW.webgpu_available = false;
    HW.tier = 'cpu_fallback';
    paintHardwarePill('WebGPU error', 'bad');
    paintSolverPill('CPU fallback only', 'warn');
    return HW;
  }
}

/* ----------------------------------------------------------
   Auto-pick grid resolution based on hardware tier.
   Returns one of: 32, 64, 128. Used by 50-controls.js to
   populate the Grid pill before the user overrides.
   ---------------------------------------------------------- */
function autoPickGrid(){
  if (!HW.webgpu_available) return 32;     // CPU fallback can't handle 64 in reasonable time
  if (HW.tier === 'high') return 128;      // discrete GPU, can run high-fi
  if (HW.tier === 'medium') return 64;     // mid-range, default tier
  if (HW.tier === 'low') return 64;        // integrated, still OK for default
  return 64;                                // unknown — assume default
}

/* ----------------------------------------------------------
   Paint helpers. Touch DOM directly because controls are
   rendered server-side in index.html.
   ---------------------------------------------------------- */
function paintHardwarePill(text, classMod){
  var pill = document.getElementById('hardwarePill');
  var val  = document.getElementById('hardwarePillVal');
  if (!pill || !val) return;
  pill.classList.remove('green','warn','bad');
  if (classMod) pill.classList.add(classMod);
  val.textContent = text;
}

function paintSolverPill(text, classMod){
  var pill = document.getElementById('solverPill');
  if (!pill) return;
  pill.classList.remove('live','warn','bad');
  if (classMod) pill.classList.add(classMod);
  pill.textContent = text;
}
