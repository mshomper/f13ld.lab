/* ============================================================
   F13LD.lab · 21-raymarcher.js
   Per-design-card geometry preview using a WebGL2 raymarcher.

   Ported from F13LD.grain's Raymarcher with extensions for the
   five lab topology modes (sheet/half/solid/pi-tpms/shell).

   Key architectural facts
   -----------------------
   • One <canvas> + WebGL2 context per design card.  GL contexts
     are bounded by the browser (Chrome ≈16); we keep the canvas
     element alive across grid re-renders by stashing it in a
     hidden cache div, and the design grid moves it into the
     active tile via appendChild.

   • The 3D field texture (R8, REPEAT-wrapped) holds the raw
     scalar field f(x,y,z) BEFORE topology is applied.  The
     fragment shader applies isoLevel/thickness/halfInvert/pipeR
     via uniforms — switching topology never requires a re-bake.

   • Coordinate domain is [-π, π]³, matching what the lab
     kernels (TpmsKernel, GrainKernel, NoiseKernel) consume.

   Topology mapping (lab mode → uTopoMode)
   ---------------------------------------
     'solid'         (TPMS default)  → 1 (half, halfInvert=1, isoLevel=offset)
     'shell'                         → 0 (sheet, isoLevel=offset, thickness=wt)
     'noise-sheet'   'grain-sheet'   → 0 (sheet, isoLevel/halfWidth)
     'noise-half'    'grain-half'    → 1 (half,  isoLevel/halfInvert)
     'noise-solid'   'grain-solid'   → 2 (anti-sheet, isoLevel/halfWidth)
     'pi-tpms'                       → 3 (max(|a|,|b|) < pipeR)

   Public API
   ----------
     var rm = new LabRaymarcher();   // creates rm.canvas internally
     rm.canvas                       // <canvas> to insert in DOM
     rm.setRecipe(recipe)            // bakes raw field, kicks render
     rm.setActive(bool)              // start/stop animation loop
     rm.destroy()                    // release GL resources
   ============================================================ */


/* ════════════════════════════════════════════════════════════
   Shader source — radix-2 raymarcher with iridescent lighting
   borrowed line-for-line from F13LD.grain.  Topology branches
   extended to cover all five lab modes.
   ════════════════════════════════════════════════════════════ */
var LAB_RM_VS = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';

function buildLabRaymarcherFS(stepCount) {
  var STEPS = String(stepCount || 192);
  return [
    '#version 300 es',
    'precision highp float; precision highp sampler3D;',
    'out vec4 fragColor;',
    'uniform vec2 res; uniform mat3 rot; uniform float zoom;',
    'uniform float thickness; uniform float isoLevel; uniform float uTopoMode;',
    'uniform float uHalfInvert; uniform float uPipeR;',
    'uniform vec3  uPipeOffset;',
    'uniform float uLipschitz;',
    'uniform highp sampler3D uField;',
    'uniform float uFieldMin; uniform float uFieldMax; uniform float uTile;',
    'uniform float uNrmStep;',
    /* A.2 — Deformed-view warp: uViewMode {0=geom,1=deform,2=stress} gates
       the displacement sample.  When uViewMode > 0.5 and uDispUploaded > 0.5,
       implicit() evaluates the SDF at the backward-warped position
       p_eval = p - uDeformAmp * u'(p).  u' is decoded from a per-design
       RGBA8 3D texture (uDisp) via per-component scale/offset uniforms.
       A.2.1 — uEpsBar carries the macroscopic load direction (ε̄) from
       the solver's captured fields.  Used to expand the AABB and apply
       the full displacement u(x) = ε̄·x + u'(x) rather than just u'(x).
       A.3 — uStress is an R8 3D texture of σ_VM(x) normalized to [0,1]
       via uStressMin/uStressMax.  In stress mode (uViewMode == 2), the
       surface shading replaces the iridescent palette with viridis(σ_VM)
       evaluated at the hit point. */
    'uniform float uViewMode; uniform float uDispUploaded; uniform float uDeformAmp;',
    'uniform highp sampler3D uDisp;',
    'uniform vec3 uDispOffset; uniform vec3 uDispScale;',
    'uniform vec3 uEpsBar;',
    'uniform float uStressUploaded;',
    'uniform highp sampler3D uStress;',
    'uniform float uStressMin; uniform float uStressMax;',

    'const float H = 3.141593;',

    /* sampleF: uvw is fract-tiled (REPEAT wrap is set on the texture
       too, but explicit fract here lets us scale via uTile) */
    'float sampleF(vec3 p) {',
    '  vec3 uvw = uTile > 1.0 ? fract(p/(2.0*H)*uTile + 0.5) : fract(p/(2.0*H) + 0.5);',
    '  float t = texture(uField, uvw).r;',
    '  return t * (uFieldMax - uFieldMin) + uFieldMin;',
    '}',

    /* sampleDisp: returns u\'(p) decoded from the RGBA8 3D texture, or
       vec3(0) if no displacement data is uploaded.  Used by implicit()
       for backward-warp in deformed view. */
    'vec3 sampleDisp(vec3 p) {',
    '  if (uDispUploaded < 0.5) return vec3(0.0);',
    '  vec3 uvw = fract(p/(2.0*H) + 0.5);',
    '  vec3 raw = texture(uDisp, uvw).rgb;',
    '  return raw * uDispScale + uDispOffset;',
    '}',

    /* sampleStress: returns σ_VM(p) normalized to [0,1] from the R8 3D
       texture, or 0.0 if no stress data is uploaded.  Used by main() in
       stress view mode to drive the viridis colormap. */
    'float sampleStress(vec3 p) {',
    '  if (uStressUploaded < 0.5) return 0.0;',
    '  vec3 uvw = fract(p/(2.0*H) + 0.5);',
    '  return texture(uStress, uvw).r;',
    '}',

    /* Viridis colormap — Iñigo Quílez quintic polynomial approximation
       of matplotlib viridis.  Perceptually uniform, colorblind-friendly,
       the de facto standard for scientific stress/data visualization.
       Input clamped to [0,1]; no LUT texture needed. */
    'vec3 viridis(float x) {',
    '  x = clamp(x, 0.0, 1.0);',
    '  vec4 x1 = vec4(1.0, x, x*x, x*x*x);',
    '  vec4 x2 = x1 * x1.w * x;',
    '  return vec3(',
    '    dot(x1, vec4( 0.280268003, -0.143510503,  2.225793877, -14.815088879)) + dot(x2.xy, vec2( 25.212752309, -11.772589584)),',
    '    dot(x1, vec4(-0.002117546,  1.617109353, -1.909305070,   2.701152864)) + dot(x2.xy, vec2( -1.685288385,   0.178738871)),',
    '    dot(x1, vec4( 0.300805501,  2.614906601, -12.019139090, 28.933312018)) + dot(x2.xy, vec2(-33.491294770,  13.762053843))',
    '  );',
    '}',

    /* getExtent: world-space half-extent of the bounding box per axis.
       In geom mode, the cube is the un-stretched lab cell [-π, π]³.
       In deform AND stress modes, the cube stretches under the
       macroscopic strain ε̄ — extent grows by (1 + amp · |ε̄|) along
       each axis.  Stress mode uses the same warp as deform so the
       colormap reads on the deformed shape (FEA viz convention). */
    'vec3 getExtent() {',
    '  if (uViewMode > 0.5 && uViewMode < 2.5) {',
    '    return vec3(H,H,H) * (vec3(1.0) + uDeformAmp * abs(uEpsBar));',
    '  }',
    '  return vec3(H,H,H);',
    '}',

    /* implicit: SDF combining raw field and topology uniforms.
       Tested branches: 0=sheet, 1=half, 2=anti-sheet (solid via
       inverted sheet), 3=pi-tpms (dual-sample).
       A.2.1 — deformed-view warp uses a coordinate transform:
         p_unstretched = p / (1 + amp · ε̄)           (inverse macro stretch)
         p_eval        = p_unstretched - amp · u\'(p_unstretched)
       A.3 — stress mode (uViewMode == 2) also applies the warp so
       the colormap reads on the deformed shape.  Surface shading
       (colormap vs iridescent) is selected in main() based on mode. */
    'float implicit(vec3 p) {',
    '  vec3 p_eval = p;',
    '  if (uViewMode > 0.5 && uViewMode < 2.5) {',
    '    vec3 p_unstretched = p / (vec3(1.0) + uDeformAmp * uEpsBar);',
    '    p_eval = p_unstretched - uDeformAmp * sampleDisp(p_unstretched);',
    '  }',
    '  if (uTopoMode > 2.5) {',
    /* mode 3: pi-tpms — max(|a|, |b|) < pipeR is solid */
    '    float a = sampleF(p_eval) - isoLevel;',
    '    float b = sampleF(p_eval + uPipeOffset) - isoLevel;',
    '    return max(abs(a), abs(b)) - uPipeR;',
    '  }',
    '  float raw = sampleF(p_eval);',
    '  float adj = raw - isoLevel;',
    '  if (uTopoMode < 0.5) return abs(adj) - thickness;',                      /* sheet */
    '  if (uTopoMode < 1.5) return uHalfInvert < 0.5 ? -adj : adj;',            /* half */
    '  return -(abs(adj) - thickness);',                                        /* anti-sheet */
    '}',

    /* boxNormal — used for near-cap shading when the ray enters
       the unit-cell box already inside the solid.  A.2.1: extent
       is per-axis (cube stretches in deform mode), so abs(pos) is
       normalized by getExtent() per axis. */
    'vec3 boxNormal(vec3 pos) {',
    '  vec3 extent = getExtent();',
    '  vec3 ap = abs(pos) / extent;',
    '  if (ap.x > ap.y && ap.x > ap.z) return vec3(sign(pos.x), 0.0, 0.0);',
    '  if (ap.y > ap.z)                return vec3(0.0, sign(pos.y), 0.0);',
    '  return                                vec3(0.0, 0.0, sign(pos.z));',
    '}',

    'vec3 nrmField(vec3 p) {',
    '  float e = uNrmStep;',
    '  return normalize(vec3(',
    '    implicit(p+vec3(e,0,0)) - implicit(p-vec3(e,0,0)),',
    '    implicit(p+vec3(0,e,0)) - implicit(p-vec3(0,e,0)),',
    '    implicit(p+vec3(0,0,e)) - implicit(p-vec3(0,0,e))));',
    '}',

    /* Iridescent palette — same coefficients as F13LD.grain */
    'vec3 palette(float t) {',
    '  vec3 a = vec3(0.55,0.57,0.42), b = vec3(0.43,0.42,0.30),',
    '       c = vec3(1.0,1.0,1.0),    d = vec3(0.02,0.0,0.05);',
    '  return clamp(a + b*cos(6.28318*(c*t + d)), 0.0, 1.0);',
    '}',

    'void main() {',
    '  vec2 uv = (gl_FragCoord.xy - res*0.5) / min(res.x, res.y);',
    '  vec3 ro = rot * vec3(0.0, 0.0, zoom);',
    '  vec3 rd = normalize(rot * vec3(uv.x, uv.y, -1.6));',
    '  float r = clamp(length(uv) * 1.1, 0.0, 1.0);',
    '  vec3 bgCol = mix(vec3(0.07,0.07,0.07), vec3(0.03,0.03,0.03), r*r);',

    /* AABB intersect [-extent, +extent]³.  Extent is constant (π) in
       geom/stress modes; stretches per-axis with the macro strain in
       deform mode (see getExtent above). */
    '  vec3 extent = getExtent();',
    '  vec3 iv = vec3(1.0) / rd;',
    '  vec3 tb = (-extent - ro) * iv;',
    '  vec3 tt = ( extent - ro) * iv;',
    '  vec3 tmi = min(tb, tt), tma = max(tb, tt);',
    '  float tEn = max(max(tmi.x, tmi.y), tmi.z);',
    '  float tEx = min(min(tma.x, tma.y), tma.z);',
    '  if (tEn > tEx || tEx < 0.0) { fragColor = vec4(bgCol, 1.0); return; }',

    '  float t = max(tEn, 0.001);',
    '  bool hit = false; bool nearCap = false;',
    '  float thresh = max(-(thickness*0.08), -0.008);',
    '  float maxStep = H / 14.0;',

    '  if (implicit(ro + rd*t) < thresh) nearCap = true;',
    '  if (!nearCap) {',
    '    for (int i = 0; i < ' + STEPS + '; i++) {',
    '      if (t > tEx) break;',
    '      vec3 p = ro + rd*t;',
    '      float d = implicit(p);',
    '      if (d < thresh) { hit = true; break; }',
    '      t += clamp(d / uLipschitz * 0.85, abs(thresh)*0.5, maxStep);',
    '    }',
    '  }',

    '  vec3 pos; vec3 n;',
    '  if (nearCap) { pos = ro + rd*tEn; n = boxNormal(pos); if (dot(n,-rd) < 0.0) n = -n; t = tEn; }',
    '  else if (hit) { pos = ro + rd*t; n = nrmField(pos); if (dot(n,-rd) < 0.0) n = -n; }',
    '  else {',
    '    if (implicit(ro + rd*tEx) < thresh) {',
    '      pos = ro + rd*tEx; n = boxNormal(pos);',
    '      if (dot(n,-rd) < 0.0) n = -n; t = tEx;',
    '    } else { fragColor = vec4(bgCol, 1.0); return; }',
    '  }',

    /* Lighting — common diffuse contribution shared by both shading paths */
    '  vec3 l1 = normalize(vec3(1.0,1.8,2.0));',
    '  vec3 l2 = normalize(vec3(-0.8,-0.3,0.6));',
    '  float l3fill = max(dot(n, normalize(vec3(-0.5,-1.0,-1.5))), 0.0) * 0.3;',
    '  float diff = 0.35 + max(dot(n, l1), 0.0)*0.7 + max(dot(n, l2), 0.0)*0.25 + l3fill;',

    /* A.3 — Surface shading: stress mode applies viridis(σ_VM) with
       diffuse-only lighting (no specular/rim) so the colormap reads
       clearly.  Other modes (geom, deform) keep the iridescent palette
       and full lighting.  σ_VM is sampled at the un-warped position
       (pos itself in stress mode IS the warped world coord; the texture
       was baked from the un-deformed mesh, so we sample using the same
       un-stretch coordinate transform applied to the warp). */
    '  vec3 col;',
    '  if (uViewMode > 1.5 && uViewMode < 2.5 && uStressUploaded > 0.5) {',
    '    vec3 pos_unstretched = pos / (vec3(1.0) + uDeformAmp * uEpsBar);',
    '    float sv = sampleStress(pos_unstretched);',
    '    col = viridis(sv) * diff;',
    '  } else {',
    '    float dy = dot(n, vec3(0.0,1.0,0.0));',
    '    float dz = dot(n, vec3(0.0,0.0,1.0));',
    '    float hue = dy*dy*0.33 + dz*dz*0.67;',
    '    vec3 iridBase = palette(hue);',
    '    float spec1 = pow(max(dot(reflect(-l1, n), -rd), 0.0), 120.0) * 0.7;',
    '    float spec2 = pow(max(dot(reflect(-l1, n), -rd), 0.0),  20.0) * 0.2;',
    '    float rim   = pow(1.0 - max(dot(n, -rd), 0.0), 2.5) * 0.8;',
    '    vec3 green = vec3(0.784, 0.961, 0.259);',
    '    col = iridBase*diff + vec3(1.0)*spec1 + green*spec2*0.6 + green*rim*0.45;',
    '  }',
    '  col = mix(bgCol, col, exp(-t * 0.010));',
    '  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');
}


/* ════════════════════════════════════════════════════════════
   LabRaymarcher class
   ════════════════════════════════════════════════════════════ */
function LabRaymarcher() {
  this.canvas = document.createElement('canvas');
  this.canvas.width  = 400;
  this.canvas.height = 320;
  this.canvas.style.width  = '100%';
  this.canvas.style.height = '100%';
  this.canvas.style.display = 'block';

  this.gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false });
  if (!this.gl) {
    /* WebGL2 not available — caller falls back to SVG mock */
    this.failed = true;
    return;
  }

  this._setupGL();
  if (!this._compileShader()) {
    this.failed = true;
    return;
  }

  this._dirty = true;
  this._running = false;
  this._rafId = null;
  this._rotY = 0.7;
  this._rotX = -0.4;
  this._lastFrame = 0;
  this._fieldUploaded = false;
  this._dispUploaded = false;     /* A.2 — set by uploadFields() */
  this._stressUploaded = false;   /* A.3 — set by uploadFields() */
  this._viewMode = 'geom';         /* A.2 — 'geom' | 'deform' | 'stress'; set by setViewMode() */
  this._recipe = null;

  /* Default uniform values; overwritten by setRecipe → _refreshTopologyUniforms */
  this._u = {
    thickness: 0.3, isoLevel: 0.0, topoMode: 0, halfInvert: 0,
    pipeR: 0.1, pipeOffset: [0, 0, 0],
    fieldMin: -1, fieldMax: 1, lipschitz: 1.0, tile: 1.0,
    nrmStep: 0.004, zoom: 20.0,   /* ~15% margin from viewport edges; F13LD.grain default is 16 (closer) */
    /* A.2 — deformed/stress view */
    viewMode: 0,                  /* 0=geom, 1=deform, 2=stress (effective; gated by _dispUploaded) */
    dispUploaded: 0,              /* float mirror of _dispUploaded for shader */
    deformAmp: 0.5,                /* direct multiplier on natural u\'(x) */
    dispOffset: [0, 0, 0],         /* per-component (min) for RGBA8 → signed decode */
    dispScale:  [1, 1, 1],         /* per-component (max-min) */
    /* A.2.1 — macroscopic strain direction (physical-axis labels post-A.1.5).
       Populated by uploadFields from fieldsObj.eps_bar.  Defaults to zero
       so the macro-stretch term has no effect until fields are uploaded. */
    epsBar: [0, 0, 0],
    /* A.3 — stress field for viridis colormap in stress view mode.
       stressUploaded float-mirror gates the shader's colormap branch.
       stressMin pinned to 0 (colormap convention).  stressMax is in MPa;
       design-grid passes the per-design (across-axis) max into uploadFields
       for shared-per-design normalization. */
    stressUploaded: 0,
    stressMin: 0,
    stressMax: 1
  };

  /* A.2 — pointer/wheel state for user-controlled rotation in deform/stress modes */
  this._pointerDown = false;
  this._lastPointerX = 0;
  this._lastPointerY = 0;
  this._attachInteractionHandlers();
}

LabRaymarcher.prototype._setupGL = function() {
  var gl = this.gl;
  this._quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
};

LabRaymarcher.prototype._mkShader = function(type, src) {
  var gl = this.gl;
  var sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[LabRaymarcher] shader compile failed:\n' + gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
};

LabRaymarcher.prototype._compileShader = function() {
  var gl = this.gl;
  var vs = this._mkShader(gl.VERTEX_SHADER,   LAB_RM_VS);
  var fs = this._mkShader(gl.FRAGMENT_SHADER, buildLabRaymarcherFS(192));
  if (!vs || !fs) return false;
  var prg = gl.createProgram();
  gl.attachShader(prg, vs);
  gl.attachShader(prg, fs);
  gl.linkProgram(prg);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prg, gl.LINK_STATUS)) {
    console.error('[LabRaymarcher] program link failed:\n' + gl.getProgramInfoLog(prg));
    return false;
  }
  this._prog = prg;
  gl.useProgram(prg);
  /* Bind quad attribute */
  gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
  var loc = gl.getAttribLocation(prg, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  /* Cache uniform locations */
  var L = {};
  ['res','rot','zoom','thickness','isoLevel','uTopoMode','uHalfInvert','uPipeR','uPipeOffset',
   'uLipschitz','uField','uFieldMin','uFieldMax','uTile','uNrmStep',
   /* A.2 — Deformed/Stress view uniforms */
   'uViewMode','uDispUploaded','uDeformAmp','uDisp','uDispOffset','uDispScale',
   /* A.2.1 — macroscopic strain direction */
   'uEpsBar',
   /* A.3 — Stress colormap uniforms */
   'uStress','uStressMin','uStressMax','uStressUploaded'].forEach(function(name){
    L[name] = gl.getUniformLocation(prg, name);
  });
  this._uloc = L;
  return true;
};


/* ─── Topology uniform translation ─────────────────────────── */

/* Map a lab recipe to the shader's (uTopoMode + auxiliary) uniforms.
   Returns an object that can be merged into this._u verbatim. */
function labModeToUniforms(family, params, args) {
  var mode = args.mode || 'solid';
  var u = {
    thickness: 0.3, isoLevel: 0, topoMode: 0, halfInvert: 0,
    pipeR: 0.1, pipeOffset: [0, 0, 0]
  };

  if (mode === 'pi-tpms') {
    var ps = args.phaseShift || { x: 0, y: 0, z: 0 };
    var TWO_PI = 2 * Math.PI;
    u.topoMode  = 3;
    u.isoLevel  = args.offset || 0;
    u.pipeR     = args.pipeR  || 0.1;
    u.pipeOffset = [(ps.x||0) * TWO_PI, (ps.y||0) * TWO_PI, (ps.z||0) * TWO_PI];
    return u;
  }

  if (mode === 'shell') {
    u.topoMode  = 0;
    u.isoLevel  = args.offset || 0;
    u.thickness = args.wt || 0.3;
    return u;
  }

  if (mode === 'noise-sheet' || mode === 'grain-sheet') {
    u.topoMode  = 0;
    u.isoLevel  = params.isoLevel != null ? params.isoLevel : 0;
    u.thickness = params.halfWidth != null ? params.halfWidth : 0.3;
    return u;
  }

  if (mode === 'noise-half' || mode === 'grain-half') {
    u.topoMode   = 1;
    u.isoLevel   = params.isoLevel != null ? params.isoLevel : 0;
    u.halfInvert = params.halfInvert ? 1 : 0;
    return u;
  }

  if (mode === 'noise-solid' || mode === 'grain-solid') {
    u.topoMode  = 2;
    u.isoLevel  = params.isoLevel != null ? params.isoLevel : 0;
    u.thickness = params.halfWidth != null ? params.halfWidth : 0.3;
    return u;
  }

  /* Default: TPMS solid — solid where raw < offset → half mode with invert */
  u.topoMode   = 1;
  u.isoLevel   = args.offset || 0;
  u.halfInvert = 1;
  return u;
}


/* ─── Recipe loading & field bake ──────────────────────────── */

LabRaymarcher.prototype.setRecipe = function(recipe) {
  if (this.failed) return;
  if (!recipe || !KERNELS[recipe.family]) {
    console.warn('[LabRaymarcher] unknown family in recipe:', recipe && recipe.family);
    return;
  }
  this._recipe = recipe;
  this._bakeAndUpload();
};

LabRaymarcher.prototype._bakeAndUpload = function() {
  var gl = this.gl;
  var recipe = this._recipe;
  if (!recipe) return;

  var family = recipe.family;
  var params = KERNELS[family].parseRecipe(recipe);
  var args   = resolveBuildArgs(recipe);

  /* N=48 is a good balance: ~30-400ms bake, 110KB texture, sharp visuals */
  var N = 48;

  var t0 = performance.now();
  var fr = buildRawField(family, params, N);
  var tBake = performance.now() - t0;

  /* Lipschitz from gradient sweep over interior — same logic as F13LD.grain */
  var step = 2 * Math.PI / N;
  var maxG = 0;
  for (var iz = 1; iz < N - 1; iz++) {
    for (var iy = 1; iy < N - 1; iy++) {
      for (var ix = 1; ix < N - 1; ix++) {
        var idx = ix + iy*N + iz*N*N;
        var gx = (fr.data[idx + 1]   - fr.data[idx - 1])   / (2*step);
        var gy = (fr.data[idx + N]   - fr.data[idx - N])   / (2*step);
        var gz = (fr.data[idx + N*N] - fr.data[idx - N*N]) / (2*step);
        var g  = Math.sqrt(gx*gx + gy*gy + gz*gz);
        if (g > maxG) maxG = g;
      }
    }
  }
  this._u.lipschitz = Math.max(maxG * 1.1, 0.05);
  this._u.fieldMin  = fr.fieldMin;
  this._u.fieldMax  = fr.fieldMax;
  this._u.nrmStep   = step * 0.5;

  /* Apply topology uniforms */
  var topoU = labModeToUniforms(family, params, args);
  this._u.thickness  = topoU.thickness;
  this._u.isoLevel   = topoU.isoLevel;
  this._u.topoMode   = topoU.topoMode;
  this._u.halfInvert = topoU.halfInvert;
  this._u.pipeR      = topoU.pipeR;
  this._u.pipeOffset = topoU.pipeOffset;
  this._u.tile       = 1.0;

  /* Upload texture */
  var range = Math.max(fr.fieldMax - fr.fieldMin, 1e-6);
  var bytes = new Uint8Array(N*N*N);
  for (var i = 0; i < fr.data.length; i++) {
    bytes[i] = Math.round(Math.max(0, Math.min(1, (fr.data[i] - fr.fieldMin) / range)) * 255);
  }
  if (!this._fieldTex) this._fieldTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, this._fieldTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, N, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_3D, null);

  this._fieldUploaded = true;
  this._dirty = true;
  this._tBakeMs = tBake;
};


/* ════════════════════════════════════════════════════════════
   A.2 — Per-design displacement / stress field upload.
   ════════════════════════════════════════════════════════════ */

/* uploadFields(fieldsObj) — encode u\'(x) into the per-design RGBA8
   3D texture used by sampleDisp() in the shader.

   fieldsObj layout (from solveDesignElastic):
     { u_prime: [Float32Array, Float32Array, Float32Array],  // per-component (xyz)
       sigma_vm: Float32Array,                                // not yet used in A.2
       N: int,                                                // cube side length
       eps_bar: [0,0,1] }                                     // load direction (physical)

   Encoding: per-component min/max → linear remap to [0, 255].
   Decoded in shader as `raw * uDispScale + uDispOffset`.
   Quantization step at typical |u\'|_max=0.8 is 0.0031 — invisible
   under the warp visualization at any practical amp setting.

   Storage: voxel idx = (iz*N + iy)*N + ix matches buildVoxels and
   the geometry field texture, so the same UV samples align.

   σ_VM is captured here but not consumed yet — A.3 wires it into
   the stress-view colormap. */
/* uploadFields(fieldsObj, stressMaxOverride) — encode u\'(x) and σ_VM(x)
   into per-design 3D textures used by sampleDisp()/sampleStress() in
   the shader.

   fieldsObj layout (from solveDesignElastic):
     { u_prime: [Float32Array, Float32Array, Float32Array],  // per-component (xyz)
       sigma_vm: Float32Array,
       N: int,
       eps_bar: [0,0,1] }

   stressMaxOverride (optional): caller-supplied σ_VM cap for
   normalization.  Used by the design-grid to share a max across the
   three axes of one design (so toggling X/Y/Z reveals "Z loads X to
   2× the stress" rather than each axis renormalizing to its own peak).
   When omitted, uses the fieldset's own max.

   Encodings:
     u\'   → RGBA8 with per-component min/max → linear remap to [0,255].
              Decoded via raw * uDispScale + uDispOffset.
     σ_VM → R8 with min=0 (pinned), max=stressMaxOverride or own max.
              Decoded as already-normalized [0,1] sample.

   σ_VM units: MPa (same as solver's stress output and material Es).
   The design-grid uses the same stressMaxOverride for the colorbar
   label so the colorbar legend and the shader colors agree.

   Storage: voxel idx = (iz*N + iy)*N + ix matches buildVoxels and
   the geometry field texture, so the same UV samples align.  */
LabRaymarcher.prototype.uploadFields = function(fieldsObj, stressMaxOverride) {
  if (this.failed || !fieldsObj) return;
  var gl = this.gl;
  var N  = fieldsObj.N;
  var N3 = N*N*N;
  var uP = fieldsObj.u_prime;
  if (!uP || uP.length !== 3 || uP[0].length !== N3) {
    console.warn('[LabRaymarcher] uploadFields: malformed fieldsObj');
    return;
  }

  /* ── u\' (RGBA8) ── */
  /* Per-component min/max for scale/offset */
  var minV = [ Infinity,  Infinity,  Infinity];
  var maxV = [-Infinity, -Infinity, -Infinity];
  for (var c = 0; c < 3; c++) {
    var arr = uP[c];
    var mn =  Infinity, mx = -Infinity;
    for (var i = 0; i < N3; i++) {
      var v = arr[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    minV[c] = mn;
    maxV[c] = mx;
  }
  /* Guard against degenerate range (constant field). */
  var epsR = 1e-12;
  var scl = [
    Math.max(maxV[0] - minV[0], epsR),
    Math.max(maxV[1] - minV[1], epsR),
    Math.max(maxV[2] - minV[2], epsR)
  ];

  /* Encode u\' to RGBA8 — R=u\'_x, G=u\'_y, B=u\'_z, A=255 (unused). */
  var bytes = new Uint8Array(N3 * 4);
  for (var i2 = 0; i2 < N3; i2++) {
    bytes[i2*4 + 0] = Math.round(Math.max(0, Math.min(1, (uP[0][i2] - minV[0]) / scl[0])) * 255);
    bytes[i2*4 + 1] = Math.round(Math.max(0, Math.min(1, (uP[1][i2] - minV[1]) / scl[1])) * 255);
    bytes[i2*4 + 2] = Math.round(Math.max(0, Math.min(1, (uP[2][i2] - minV[2]) / scl[2])) * 255);
    bytes[i2*4 + 3] = 255;
  }

  if (!this._dispTex) this._dispTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, this._dispTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_3D, null);

  this._dispUploaded = true;
  this._u.dispUploaded = 1.0;
  this._u.dispOffset = [minV[0], minV[1], minV[2]];
  this._u.dispScale  = [scl[0],  scl[1],  scl[2]];

  if (fieldsObj.eps_bar && fieldsObj.eps_bar.length === 3) {
    this._u.epsBar = [fieldsObj.eps_bar[0], fieldsObj.eps_bar[1], fieldsObj.eps_bar[2]];
  } else {
    this._u.epsBar = [0, 0, 0];
  }

  /* ── σ_VM (R8) ── */
  var svArr = fieldsObj.sigma_vm;
  if (svArr && svArr.length === N3) {
    var svMin = 0;   /* pinned to zero — colormap convention */
    var svMax = (stressMaxOverride != null && stressMaxOverride > 0)
              ? stressMaxOverride
              : 0;
    if (svMax === 0) {
      for (var k = 0; k < N3; k++) {
        if (svArr[k] > svMax) svMax = svArr[k];
      }
    }
    svMax = Math.max(svMax, epsR);

    var svBytes = new Uint8Array(N3);
    var svScale255 = 255 / (svMax - svMin);
    for (var k2 = 0; k2 < N3; k2++) {
      svBytes[k2] = Math.round(Math.max(0, Math.min(255, (svArr[k2] - svMin) * svScale255)));
    }

    if (!this._stressTex) this._stressTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this._stressTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, N, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, svBytes);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_3D, null);

    this._stressUploaded = true;
    this._u.stressUploaded = 1.0;
    this._u.stressMin = svMin;
    this._u.stressMax = svMax;
  }

  this._dirty = true;
};

/* setViewMode('geom'|'deform'|'stress') — selects shader behavior.
   Effective uViewMode is gated by uploaded data: deform requires
   _dispUploaded, stress requires _stressUploaded.  If the required
   data isn't uploaded yet, falls back to geom mode regardless of
   requested mode. */
LabRaymarcher.prototype.setViewMode = function(mode) {
  if (this.failed) return;
  this._viewMode = mode;
  var effective = 0;
  if (mode === 'deform' && this._dispUploaded) effective = 1;
  else if (mode === 'stress' && this._stressUploaded) effective = 2;
  this._u.viewMode = effective;
  this._dirty = true;
};

/* setDeformAmp(v) — pushes the amp slider value (0..1) directly to
   the shader uniform without triggering a grid re-render.  Called
   by the design-grid slider input handler on every input event. */
LabRaymarcher.prototype.setDeformAmp = function(v) {
  if (this.failed) return;
  this._u.deformAmp = v;
  this._dirty = true;
};


/* ════════════════════════════════════════════════════════════
   A.2 — Pointer/wheel handlers for user-controlled rotation
   in deform/stress modes.  Geom mode keeps auto-rotation.
   ════════════════════════════════════════════════════════════ */
LabRaymarcher.prototype._attachInteractionHandlers = function() {
  if (!this.canvas) return;
  var self = this;

  /* Pointer drag — rotate _rotY (horizontal drag) and _rotX (vertical
     drag).  Active only in deform/stress modes; geom mode auto-rotates. */
  this.canvas.addEventListener('pointerdown', function(e) {
    if (self._viewMode === 'geom') return;
    self._pointerDown = true;
    self._lastPointerX = e.clientX;
    self._lastPointerY = e.clientY;
    self.canvas.setPointerCapture(e.pointerId);
    self.canvas.style.cursor = 'grabbing';
  });
  this.canvas.addEventListener('pointermove', function(e) {
    if (!self._pointerDown || self._viewMode === 'geom') return;
    var dx = e.clientX - self._lastPointerX;
    var dy = e.clientY - self._lastPointerY;
    self._lastPointerX = e.clientX;
    self._lastPointerY = e.clientY;
    /* Sensitivity: ~6 rad full canvas-width sweep at 400px → 0.015 rad/px.
       A.2.1 — Both axes flipped per Matt's testing: drag-right spins scene
       right-to-left, drag-down tilts scene up-to-down (touchscreen-style
       "grab the scene" convention, not CAD orbit-camera). */
    self._rotY -= dx * 0.012;
    self._rotX -= dy * 0.012;
    /* Clamp pitch to avoid flipping through the poles */
    var lim = Math.PI * 0.49;
    if (self._rotX >  lim) self._rotX =  lim;
    if (self._rotX < -lim) self._rotX = -lim;
    self._dirty = true;
  });
  var onPointerUp = function(e) {
    if (!self._pointerDown) return;
    self._pointerDown = false;
    try { self.canvas.releasePointerCapture(e.pointerId); } catch (_e) { /* fine */ }
    self.canvas.style.cursor = '';
  };
  this.canvas.addEventListener('pointerup', onPointerUp);
  this.canvas.addEventListener('pointercancel', onPointerUp);

  /* Wheel zoom — active only in deform/stress.  Clamp [8, 40]. */
  this.canvas.addEventListener('wheel', function(e) {
    if (self._viewMode === 'geom') return;
    e.preventDefault();
    var z = self._u.zoom;
    /* Scroll up (negative deltaY) → zoom in (smaller z) */
    z *= (e.deltaY > 0) ? 1.08 : 0.92;
    if (z < 8)  z = 8;
    if (z > 40) z = 40;
    self._u.zoom = z;
    self._dirty = true;
  }, { passive: false });
};


/* ─── Render loop ─────────────────────────────────────────── */

LabRaymarcher.prototype._render = function(t) {
  if (!this._running) return;
  this._rafId = requestAnimationFrame(this._render.bind(this));

  var gl = this.gl;
  if (!this._fieldUploaded || !this._prog) return;

  /* Auto-rotate only in geom mode; deform/stress are user-controlled. */
  if (this._lastFrame === 0) this._lastFrame = t;
  var dt = (t - this._lastFrame) * 0.001;
  this._lastFrame = t;
  if (this._viewMode === 'geom') {
    this._rotY += dt * 0.30;
  }

  /* Build rotation matrix (Y then X) */
  var cy = Math.cos(this._rotY), sy = Math.sin(this._rotY);
  var cx = Math.cos(this._rotX), sx = Math.sin(this._rotX);
  /* mat3, column-major:  Rx · Ry */
  var rot = new Float32Array([
    cy,        0,    -sy,
    sx*sy,    cx,    sx*cy,
    cx*sy,   -sx,    cx*cy
  ]);

  /* Resize viewport to canvas backbuffer if needed */
  var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  var cssW = this.canvas.clientWidth || 400;
  var cssH = this.canvas.clientHeight || 320;
  var w = Math.max(1, Math.floor(cssW * dpr));
  var h = Math.max(1, Math.floor(cssH * dpr));
  if (this.canvas.width !== w || this.canvas.height !== h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }
  gl.viewport(0, 0, w, h);

  /* Draw */
  gl.useProgram(this._prog);
  var u = this._uloc, S = this._u;
  gl.uniform2f(u.res, w, h);
  gl.uniformMatrix3fv(u.rot, false, rot);
  gl.uniform1f(u.zoom,        S.zoom);
  gl.uniform1f(u.thickness,   S.thickness);
  gl.uniform1f(u.isoLevel,    S.isoLevel);
  gl.uniform1f(u.uTopoMode,   S.topoMode);
  gl.uniform1f(u.uHalfInvert, S.halfInvert);
  gl.uniform1f(u.uPipeR,      S.pipeR);
  gl.uniform3f(u.uPipeOffset, S.pipeOffset[0], S.pipeOffset[1], S.pipeOffset[2]);
  gl.uniform1f(u.uLipschitz,  S.lipschitz);
  gl.uniform1f(u.uFieldMin,   S.fieldMin);
  gl.uniform1f(u.uFieldMax,   S.fieldMax);
  gl.uniform1f(u.uTile,       S.tile);
  gl.uniform1f(u.uNrmStep,    S.nrmStep);
  /* A.2 — view-mode and displacement uniforms */
  gl.uniform1f(u.uViewMode,    S.viewMode);
  gl.uniform1f(u.uDispUploaded, S.dispUploaded);
  gl.uniform1f(u.uDeformAmp,   S.deformAmp);
  gl.uniform3f(u.uDispOffset,  S.dispOffset[0], S.dispOffset[1], S.dispOffset[2]);
  gl.uniform3f(u.uDispScale,   S.dispScale[0],  S.dispScale[1],  S.dispScale[2]);
  /* A.2.1 — macroscopic strain direction (for cube stretch in deform mode) */
  gl.uniform3f(u.uEpsBar,      S.epsBar[0],     S.epsBar[1],     S.epsBar[2]);
  /* A.3 — stress colormap uniforms.  uStress sampler bound on TEXTURE2
     below; the shader gates on uStressUploaded so an unbound sampler is
     harmless when no stress data has been provided. */
  gl.uniform1f(u.uStressUploaded, S.stressUploaded);
  gl.uniform1f(u.uStressMin,      S.stressMin);
  gl.uniform1f(u.uStressMax,      S.stressMax);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, this._fieldTex);
  gl.uniform1i(u.uField, 0);
  /* A.2 — displacement texture on TEXTURE1.  When not uploaded, the
     shader gates on uDispUploaded so sampling is skipped — no need to
     bind a placeholder. */
  if (this._dispTex) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this._dispTex);
    gl.uniform1i(u.uDisp, 1);
  }
  /* A.3 — stress texture on TEXTURE2.  Same gating pattern as uDisp. */
  if (this._stressTex) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this._stressTex);
    gl.uniform1i(u.uStress, 2);
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};


/* ─── Lifecycle ─────────────────────────────────────────── */

LabRaymarcher.prototype.setActive = function(active) {
  if (this.failed) return;
  if (active && !this._running) {
    this._running = true;
    this._lastFrame = 0;
    this._rafId = requestAnimationFrame(this._render.bind(this));
  } else if (!active && this._running) {
    this._running = false;
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }
};

LabRaymarcher.prototype.destroy = function() {
  if (this.failed) return;
  this.setActive(false);
  var gl = this.gl;
  if (this._fieldTex)  gl.deleteTexture(this._fieldTex);
  if (this._dispTex)   gl.deleteTexture(this._dispTex);    /* A.2 — displacement texture */
  if (this._stressTex) gl.deleteTexture(this._stressTex);  /* A.3 — stress texture */
  if (this._prog)      gl.deleteProgram(this._prog);
  if (this._quadBuf)   gl.deleteBuffer(this._quadBuf);
  /* Force-lose context to free GPU memory immediately */
  var ext = gl.getExtension('WEBGL_lose_context');
  if (ext) ext.loseContext();
  this.gl = null;
  this._prog = null;
  this._fieldTex = null;
  this._dispTex = null;     /* A.2 */
  this._stressTex = null;   /* A.3 */
  this._quadBuf = null;
  this.canvas = null;
  this.failed = true;
};


/* ════════════════════════════════════════════════════════════
   Recipe lookup for designs.  Three sources, in priority order:
     1. design.recipe — populated by 60-add-design.js when the
        imported JSON is a recognized lab recipe shape (preferred).
     2. Demo lookup — maps mock-design entries (without imported
        recipes) to DEMO_RECIPES by family/variant.  Only fires
        for in-app mock designs (those without raw_json).
     3. null — design has no usable recipe (RD, unknown family,
        invalid imported JSON).  Card falls back to SVG mock.

   Imports that didn't produce a recipe (e.g. Fischer-Koch S
   raw_preset) skip the demo lookup and go straight to SVG —
   showing the demo's Schwarz P would mislead the user into
   thinking their import succeeded.
   ════════════════════════════════════════════════════════════ */
function recipeForDesign(design) {
  if (!design) return null;
  /* Imported recipe takes priority — the user explicitly loaded this */
  if (design.recipe) return design.recipe;

  /* Imports without a recipe go straight to SVG fallback (don't
     mislead the user with a demo recipe pretending to be their import). */
  if (design.raw_json) return null;

  /* Mock-design variant lookup (the three pre-loaded demos) */
  if (design.family === 'tpms') {
    /* All TPMS variants → schwarzP demo for now */
    return DEMO_RECIPES.schwarzP;
  }
  if (design.family === 'grain') {
    if (design.variant === 'spinodoid')   return DEMO_RECIPES.spinodoid;
    if (design.variant === 'hyperuniform') return DEMO_RECIPES.hyperuniform;
    /* reaction_diffusion has no lab kernel — fall back to SVG */
    return null;
  }
  return null;
}


/* ════════════════════════════════════════════════════════════
   Per-design registry — keep LabRaymarcher instances alive
   across grid re-renders.  Canvases are stashed in a hidden
   cache div between renders so their GL contexts persist.
   ════════════════════════════════════════════════════════════ */
var LAB_RM_REGISTRY = {};   /* designId → LabRaymarcher */
var LAB_RM_CACHE_DIV = null;

function ensureRMCacheDiv() {
  if (LAB_RM_CACHE_DIV) return LAB_RM_CACHE_DIV;
  var d = document.createElement('div');
  d.id = 'rm-canvas-cache';
  d.style.display = 'none';
  d.style.position = 'absolute';
  d.style.width = '0';
  d.style.height = '0';
  document.body.appendChild(d);
  LAB_RM_CACHE_DIV = d;
  return d;
}

function getOrCreateRaymarcher(designId, recipe) {
  var rm = LAB_RM_REGISTRY[designId];
  if (rm && !rm.failed) return rm;
  rm = new LabRaymarcher();
  if (rm.failed) return null;
  rm.setRecipe(recipe);
  LAB_RM_REGISTRY[designId] = rm;
  /* Park canvas in cache div until the grid mounts it */
  ensureRMCacheDiv().appendChild(rm.canvas);
  return rm;
}

function disposeRaymarcher(designId) {
  var rm = LAB_RM_REGISTRY[designId];
  if (!rm) return;
  if (rm.canvas && rm.canvas.parentNode) rm.canvas.parentNode.removeChild(rm.canvas);
  rm.destroy();
  delete LAB_RM_REGISTRY[designId];
}

function pauseAllRaymarchers() {
  for (var id in LAB_RM_REGISTRY) {
    if (LAB_RM_REGISTRY.hasOwnProperty(id)) LAB_RM_REGISTRY[id].setActive(false);
  }
}


/* ════════════════════════════════════════════════════════════
   IntersectionObserver — pauses raymarchers for off-screen
   cards.  Single shared observer for the whole grid.
   ════════════════════════════════════════════════════════════ */
var LAB_RM_IO = null;

function ensureRMObserver() {
  if (LAB_RM_IO) return LAB_RM_IO;
  if (typeof IntersectionObserver === 'undefined') return null;
  LAB_RM_IO = new IntersectionObserver(function(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var id = e.target.getAttribute('data-design-id');
      if (!id) continue;
      var rm = LAB_RM_REGISTRY[id];
      if (!rm) continue;
      /* Only run when intersecting AND the document is visible */
      var shouldRun = e.isIntersecting && !document.hidden;
      rm.setActive(shouldRun);
    }
  }, { threshold: 0.01 });
  /* Tab-visibility pause — saves GPU when user is in another tab */
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      pauseAllRaymarchers();
    } else {
      /* Reapply observer states by triggering a re-scan: not directly
         possible, but the IO will refire when scroll / resize happens.
         For immediate resume, mark all observed cards visible if their
         bounding rect intersects viewport. */
      for (var id in LAB_RM_REGISTRY) {
        if (!LAB_RM_REGISTRY.hasOwnProperty(id)) continue;
        var rm = LAB_RM_REGISTRY[id];
        var mount = document.querySelector('[data-design-id="' + id + '"]');
        if (!mount) continue;
        var r = mount.getBoundingClientRect();
        var visible = r.bottom > 0 && r.top < window.innerHeight;
        rm.setActive(visible);
      }
    }
  });
  return LAB_RM_IO;
}


/* ════════════════════════════════════════════════════════════
   mountRaymarcherTiles — called by 40-design-grid.js after each
   grid render.  Walks all .rm-mount placeholders, attaches the
   matching canvas, registers IntersectionObserver.
   ════════════════════════════════════════════════════════════ */
function mountRaymarcherTiles() {
  var io = ensureRMObserver();
  var mounts = document.querySelectorAll('.rm-mount');
  for (var i = 0; i < mounts.length; i++) {
    var mount = mounts[i];
    var id = mount.getAttribute('data-design-id');
    if (!id) continue;
    var rm = LAB_RM_REGISTRY[id];
    if (!rm) continue;
    /* Move canvas into the mount tile */
    if (rm.canvas && rm.canvas.parentNode !== mount) {
      mount.appendChild(rm.canvas);
    }
    if (io) io.observe(mount);
  }
}

/* Pause all when grid loses geom/deform/stress view (e.g. user clicks Buckle tab) */
function pauseRaymarcherTilesForViewMode(mode) {
  if (mode !== 'geom' && mode !== 'deform' && mode !== 'stress') {
    pauseAllRaymarchers();
  }
}
