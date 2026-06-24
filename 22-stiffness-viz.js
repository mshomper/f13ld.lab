/* ============================================================
   F13LD.lab · 22-stiffness-viz.js  (push 5)

   Directional Young's modulus surface E(n̂) renderer for the
   Stiffness ⊕ tab.  Per-design WebGL canvas displays the locus
   of vectors r(n̂) = E(n̂) · n̂ over the unit sphere, colored by
   E(n̂) / E_max via cividis.

   ── Math ────────────────────────────────────────────────
   For a Voigt 6×6 compliance tensor S (the inverse of the
   effective stiffness, derived from the full-Voigt FFT-CG
   solver in 16b-elastic-solver-full.js), the directional
   Young's modulus along unit vector n̂ is:

     1/E(n̂) = v^T · S · v
     where v = [n_x², n_y², n_z², n_y n_z, n_x n_z, n_x n_y]

   Our solver returns S in ENGINEERING-Voigt convention
   (S_44 = 1/G, verified against Schwarz P where C44 = G
   = 7.24 GPa in push 2 cross-validation).  With engineering
   S, the v vector takes NO factor of 2 on shear entries.

   The alternate "factor-2 on shear v" formula (Hill 1952,
   Ting 2005) is correct only for TENSOR-Voigt S (where
   S_44 = s_2323).  Using factor-2 v with engineering S
   produces 3-6× false anisotropy on every direction off
   the cube axes — this was push 5's original bug, fixed
   in push 5.2 after Matt caught the standard-gyroid
   anisotropy reading 3.29 instead of the expected ~1.05.

   Verified cubic [111] limit (Schwarz P, C11/C12/C44 =
   35.36/8.08/7.24):  E[100]=32.35, E[111]=19.04, E_max/E_min=1.70.

   ── Architecture ────────────────────────────────────────
   - Icosphere mesh with 3 subdivisions: 642 verts, 1280 tris.
     Generated once at module load, shared VBO across all
     designs.  Vertices are unit-length direction vectors.
   - Vertex shader: takes the 36 entries of S as uniform array,
     computes 1/E and E per vertex, scales position by E/E_max.
     ~36 multiplies + 30 adds per vertex; trivial GPU load.
   - Fragment shader: cividis colormap on E/E_max, with diffuse
     lighting using the radial direction as the normal approx.
   - Per-design state lives in LAB_SV_REGISTRY (parallel to
     LAB_RM_REGISTRY).  Same IntersectionObserver pattern as
     the raymarcher to pause off-screen tiles.

   ── Normalization modes ─────────────────────────────────
   - 'per'    — each design uses its own E_max.  Every surface
                fills its viewport at saturation; cross-design
                magnitude comparison via the absolute readout.
   - 'shared' — all designs use max(E_max) across designs.  The
                stiffest design fills its viewport; weaker ones
                appear proportionally smaller.  Same toggle UI
                as the stress-field tab (push 4b reused).

   ── External dependencies (resolved at call time) ───────
   - VIEW_STATE                  (30-view-tabs.js)
   - getStressNormMode           (30-view-tabs.js — shared toggle)
   - LAB_STATE                   (07-lab-state.js or similar)
   ============================================================ */


/* ════════════════════════════════════════════════════════════
   Icosphere generator — once at module load.
   Builds an icosahedron, subdivides 3 times, normalizes each
   midpoint onto the unit sphere.  Returns shared Float32Array
   positions and Uint16Array indices used by every StiffnessViz
   instance via the same VBO.
   ════════════════════════════════════════════════════════════ */
function _buildIcosphere(subdivisions) {
  var phi = (1 + Math.sqrt(5)) / 2;
  /* Base icosahedron: 12 verts as the corners of three mutually
     perpendicular golden rectangles. */
  var verts = [
    [-1,  phi,  0], [ 1,  phi,  0], [-1, -phi,  0], [ 1, -phi,  0],
    [ 0, -1,  phi], [ 0,  1,  phi], [ 0, -1, -phi], [ 0,  1, -phi],
    [ phi, 0, -1], [ phi, 0,  1], [-phi, 0, -1], [-phi, 0,  1]
  ];
  for (var i = 0; i < verts.length; i++) {
    var v = verts[i];
    var L = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    v[0] /= L; v[1] /= L; v[2] /= L;
  }
  var faces = [
    [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
    [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
    [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
    [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]
  ];

  var midCache = {};
  function midpoint(a, b) {
    var key = (a < b) ? (a + ',' + b) : (b + ',' + a);
    if (midCache[key] !== undefined) return midCache[key];
    var va = verts[a], vb = verts[b];
    var mx = (va[0] + vb[0]) * 0.5,
        my = (va[1] + vb[1]) * 0.5,
        mz = (va[2] + vb[2]) * 0.5;
    var L = Math.sqrt(mx*mx + my*my + mz*mz);
    verts.push([mx / L, my / L, mz / L]);
    var idx = verts.length - 1;
    midCache[key] = idx;
    return idx;
  }

  for (var s = 0; s < subdivisions; s++) {
    var newFaces = [];
    for (var f = 0; f < faces.length; f++) {
      var a = faces[f][0], b = faces[f][1], c = faces[f][2];
      var ab = midpoint(a, b);
      var bc = midpoint(b, c);
      var ca = midpoint(c, a);
      newFaces.push([a,  ab, ca]);
      newFaces.push([b,  bc, ab]);
      newFaces.push([c,  ca, bc]);
      newFaces.push([ab, bc, ca]);
    }
    faces = newFaces;
  }

  var positions = new Float32Array(verts.length * 3);
  for (var v = 0; v < verts.length; v++) {
    positions[v*3 + 0] = verts[v][0];
    positions[v*3 + 1] = verts[v][1];
    positions[v*3 + 2] = verts[v][2];
  }
  /* Uint16 is sufficient through ~6 subdivisions; subdivisions=3 → 642 verts. */
  var indices = new Uint16Array(faces.length * 3);
  for (var fi = 0; fi < faces.length; fi++) {
    indices[fi*3 + 0] = faces[fi][0];
    indices[fi*3 + 1] = faces[fi][1];
    indices[fi*3 + 2] = faces[fi][2];
  }
  return { positions: positions, indices: indices, nVerts: verts.length, nTris: faces.length };
}

var LAB_SV_MESH = _buildIcosphere(4);   /* 2562 verts, 5120 tris — subdivision bumped from 3 (642) so high-anisotropy lobes resolve smoothly instead of faceting */


/* ════════════════════════════════════════════════════════════
   Shaders — GLSL ES 3.00 for WebGL2.

   The vertex shader does the full E(n̂) computation per vertex,
   reading 36 floats of S from a uniform array.  The S matrix is
   stored row-major (S[i*6 + j]); since the solver returns a
   symmetric tensor, the upper and lower triangles are equal.

   uS:      row-major 6×6 compliance in MPa^-1
   uREmax:  divisor for radius (per-design E_max or shared global)
   uCmin:   color stretch low end (per-design E_min or shared global)
   uCmax:   color stretch high end (per-design E_max or shared global)
   uRot:    3×3 rotation matrix (auto-rotate + user drag)
   uZoom:   scalar size multiplier for the canvas display
   uAspect: width/height for non-square canvases
   ════════════════════════════════════════════════════════════ */
var LAB_SV_VS = [
  '#version 300 es',
  'precision highp float;',
  'in vec3 aPos;',                /* unit direction (icosphere vert) */
  'uniform float uS[36];',         /* row-major Voigt 6×6 compliance */
  /* Push 5.3 — radius and color now use independent normalizations.
     uREmax  — divisor for the radial scale (per-design or shared via
               the per/shared toggle; controls surface "size")
     uCmin   — low end of the color stretch (per-design E_min or
               shared global E_min across designs)
     uCmax   — high end of the color stretch (per-design E_max or
               shared global E_max across designs)
     Previously a single uEmax drove both — but for near-isotropic
     materials (Zener ≈ 1) the color input would compress to a
     0.97-1.00 sliver of cividis (yellow), hiding all structure.
     Splitting lets color always span the full cividis range. */
  'uniform float uREmax;',
  'uniform float uCmin;',
  'uniform float uCmax;',
  'uniform mat3 uRot;',
  'uniform float uZoom;',
  'uniform float uAspect;',
  'out float vColor;',             /* color stretch input — for cividis */
  'out vec3 vNormal;',             /* radial direction — diffuse approx */

  /* Directional inverse Young's modulus 1/E(n̂) = v^T S v (engineering Voigt). */
  'float invEdir(vec3 nd) {',
  '  float v0 = nd.x*nd.x;',
  '  float v1 = nd.y*nd.y;',
  '  float v2 = nd.z*nd.z;',
  '  float v3 = nd.y*nd.z;',
  '  float v4 = nd.x*nd.z;',
  '  float v5 = nd.x*nd.y;',
  '  float vv[6];',
  '  vv[0]=v0; vv[1]=v1; vv[2]=v2; vv[3]=v3; vv[4]=v4; vv[5]=v5;',
  '  float ie = 0.0;',
  '  for (int i = 0; i < 6; i++) {',
  '    for (int j = 0; j < 6; j++) {',
  '      ie += uS[i*6 + j] * vv[i] * vv[j];',
  '    }',
  '  }',
  '  return ie;',
  '}',
  /* Clamped radial scale r(n̂) = E/uREmax for the displaced vertex (shared by
     the vertex position and the tangent finite-differences that build the normal). */
  'float radiusFor(vec3 nd) {',
  '  float ie = invEdir(nd);',
  '  float E = (ie > 1e-30) ? (1.0 / ie) : 0.0;',
  '  return clamp(E / max(uREmax, 1e-30), 0.0, 1.0);',
  '}',
  'void main() {',
  /* Voigt v vector for ENGINEERING-VOIGT compliance.  S returned by the
     solver has S_44 = 1/G (engineering convention; verified against Schwarz P
     where C44 = G = 7.24 GPa in push 2 cross-validation).  With engineering S,
     the directional Young's-modulus formula is

       1/E(n̂) = v^T S v       where v = [n_x², n_y², n_z², n_yn_z, n_xn_z, n_xn_y]

     NOTE: the alternate "factor-2 on shear v" convention seen in some
     references (Hill 1952, Ting 2005) assumes TENSOR-Voigt S, where
     S_44 = s_2323 (no factor 4).  Using factor-2 v with engineering S
     inflates shear-shear contributions by 4×, producing 3-6× false
     anisotropy on every direction containing shear — i.e., everything
     off the cube axes.  Push 5.2 fix: drop the factor of 2.

     Verified on Schwarz P (C11/C12/C44 = 35.36/8.08/7.24):
       E[100] = 32.35 GPa,  E[111] = 19.04 GPa,  E_max/E_min = 1.70
     Verified on near-isotropic gyroid (Zener ≈ 0.96):
       E_max/E_min ≈ 1.05  (previously read 3.29 with the buggy v) */
  '  vec3 n = aPos;',              /* aPos is already unit-length from icosphere */
  '  float inv_E = invEdir(n);',
  '  float E = (inv_E > 1e-30) ? (1.0 / inv_E) : 0.0;',

  /* Push 5.3 — radius and color use independent normalizations:
       r      = E / uREmax            (clamped) — surface "size"
       vColor = (E - uCmin) / (uCmax - uCmin)   — directional structure
     In per-design mode both come from this design's own stats; in
     shared mode both come from global stats across all designs. */
  '  float r = clamp(E / max(uREmax, 1e-30), 0.0, 1.0);',
  '  float cspan = max(uCmax - uCmin, 1e-30);',
  '  vColor = clamp((E - uCmin) / cspan, 0.0, 1.0);',

  /* Position the vertex at r(n̂)·n̂ scaled by zoom.
     The icosphere is in local space; world transform is uRot · pos.
     aPos is the radial direction, so the displaced vertex is r·aPos. */
  '  vec3 pos = aPos * r;',
  '  vec3 world = uRot * pos;',
  /* Orthographic projection — no perspective for this small inline
     canvas; the radial-property visualization reads cleanest with
     a flat camera.  uAspect adjusts X to keep the surface circular. */
  '  gl_Position = vec4(world.x * uZoom / uAspect, world.y * uZoom, world.z * 0.5, 1.0);',

  /* Analytic surface normal of the displaced surface r(n̂)·n̂ via two
     tangent finite-differences.  Replaces the old radial approximation so
     anisotropic lobes shade as smooth surfaces rather than faceted spikes. */
  '  vec3 nn = normalize(aPos);',
  '  vec3 ref = (abs(nn.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);',
  '  vec3 t1 = normalize(cross(nn, ref));',
  '  vec3 t2 = cross(nn, t1);',
  '  float e = 0.035;',
  '  vec3 nA = normalize(nn + e * t1);',
  '  vec3 nB = normalize(nn + e * t2);',
  '  vec3 P0 = nn * r;',
  '  vec3 PA = nA * radiusFor(nA);',
  '  vec3 PB = nB * radiusFor(nB);',
  '  vec3 sn = cross(PA - P0, PB - P0);',
  '  if (dot(sn, nn) < 0.0) sn = -sn;',
  '  sn = (length(sn) > 1e-12) ? normalize(sn) : nn;',
  '  vNormal = uRot * sn;',
  '}'
].join('\n');


var LAB_SV_FS = [
  '#version 300 es',
  'precision highp float;',
  'in float vColor;',              /* push 5.3 — independent color stretch */
  'in vec3 vNormal;',
  'out vec4 fragColor;',

  /* Cividis colormap — same 8-stop piecewise-linear function used by
     21-raymarcher.js.  Duplicated here so the file can stand alone;
     the alternative (uniform LUT texture) trades clarity for one less
     line of duplication, not worth it. */
  'vec3 cividis(float x) {',
  '  x = clamp(x, 0.0, 1.0);',
  '  float xs = x * 7.0;',
  '  float seg = floor(xs);',
  '  float t   = xs - seg;',
  '  vec3 c0 = vec3(0.0000, 0.1255, 0.3020);',
  '  vec3 c1 = vec3(0.1098, 0.2431, 0.3961);',
  '  vec3 c2 = vec3(0.2353, 0.3451, 0.4706);',
  '  vec3 c3 = vec3(0.3569, 0.4471, 0.4863);',
  '  vec3 c4 = vec3(0.4980, 0.5373, 0.4588);',
  '  vec3 c5 = vec3(0.6667, 0.6353, 0.3882);',
  '  vec3 c6 = vec3(0.8471, 0.7569, 0.2980);',
  '  vec3 c7 = vec3(1.0000, 0.9176, 0.2745);',
  '  vec3 a = c0; vec3 b = c1;',
  '  if (seg >= 6.5)      { a = c6; b = c7; }',
  '  else if (seg >= 5.5) { a = c5; b = c6; }',
  '  else if (seg >= 4.5) { a = c4; b = c5; }',
  '  else if (seg >= 3.5) { a = c3; b = c4; }',
  '  else if (seg >= 2.5) { a = c2; b = c3; }',
  '  else if (seg >= 1.5) { a = c1; b = c2; }',
  '  else if (seg >= 0.5) { a = c0; b = c1; }',
  '  return mix(a, b, t);',
  '}',

  'void main() {',
  /* Diffuse-only lighting from a fixed key light direction — matches
     the raymarcher's "diff" formula at the lower bound (0.35 ambient
     + 0.75 forward + bounce) so the two views share visual language. */
  '  vec3 l1 = normalize(vec3(1.0, 1.8, 2.0));',
  '  vec3 l2 = normalize(vec3(-0.8, -0.3, 0.6));',
  '  vec3 n = normalize(vNormal);',
  '  float diff = 0.35 + max(dot(n, l1), 0.0) * 0.70 + max(dot(n, l2), 0.0) * 0.25;',
  '  vec3 col = cividis(vColor) * diff;',
  '  fragColor = vec4(col, 1.0);',
  '}'
].join('\n');


/* ════════════════════════════════════════════════════════════
   StiffnessViz class — one canvas per design.

   Lifecycle mirrors LabRaymarcher:
     - Constructor sets up canvas, GL context, compiled program,
       cached uniform locations, default state.
     - uploadDesign(S_mpa, rho) loads the 6×6 compliance, computes
       per-design E_max via 642-vertex CPU sample, computes
       E_min and anisotropy ratio for the readout.
     - setVizParams(REmax, Cmin, Cmax) sets radius normalization and
       color stretch (per-design or shared-normalization mode).
     - setActive(b) gates the animation loop (IntersectionObserver).
     - destroy() releases GL resources.
   ════════════════════════════════════════════════════════════ */
function StiffnessViz() {
  this.canvas = document.createElement('canvas');
  this.canvas.style.width = '100%';
  this.canvas.style.height = '100%';
  this.canvas.style.display = 'block';
  this.canvas.style.touchAction = 'none';
  /* Push 5.5 — CSS radial gradient background: darker sage (#6b6e64) base,
     lighter in center, darker at edges.  Three intermediate stops give a
     roughly squared falloff that visually matches the r*r mix() the
     raymarcher's shader uses, so the two viewport types feel consistent.
     The GL framebuffer is rendered transparent (clearColor alpha=0) so
     this CSS bg shows through where the surface doesn't cover. */
  this.canvas.style.background =
    'radial-gradient(circle at 50% 50%, ' +
      'rgb(119, 122, 112) 0%, ' +
      'rgb(115, 118, 108) 25%, ' +
      'rgb(107, 110, 100) 60%, ' +
      'rgb( 95,  98,  88) 100%)';

  /* Push 5.5 — alpha:true + premultipliedAlpha:false so the CSS background
     above shows through wherever the GL clear color (transparent black) is
     visible.  The surface fragment shader still outputs vec4(col, 1.0) so
     the surface itself is fully opaque against the CSS background. */
  this.gl = this.canvas.getContext('webgl2', {
    antialias: true,
    alpha: true,
    premultipliedAlpha: false
  });
  this.failed = !this.gl;
  if (this.failed) { return; }

  this._prog       = null;
  this._uloc       = {};
  this._vboPos     = null;
  this._iboTris    = null;
  this._meshUploaded = false;

  /* Per-design state */
  this._S        = new Float32Array(36);    /* row-major Voigt 6×6 compliance, MPa^-1 */
  this._stats    = { E_max: 0, E_min: 0, aniso: 1, hasData: false };
  /* Push 5.3 — split normalization: radius and color use independent
     scales so near-isotropic materials still show directional color
     structure even though their geometry is near-spherical. */
  this._REmax    = 1;                        /* radius divisor (per or shared) */
  this._Cmin     = 0;                        /* color stretch low end */
  this._Cmax     = 1;                        /* color stretch high end */

  /* Render state */
  this._active     = false;
  this._dirty      = true;
  this._rotY       = 0;
  this._rotX       = 0.3;                    /* slight tilt — same default as raymarcher */
  this._gimbal     = null;                   /* #5 — axis-gimbal overlay refs */
  this._gimbalLast = null;
  this._lastTickMs = 0;
  /* Push 5.3 — once the user has touched the canvas, auto-rotate stops
     permanently for this tile.  The initial auto-rotate stays so the
     surface is in motion when the tab first opens; the moment the user
     engages, they're driving. */
  this._userInteracted = false;
  this._u = {
    zoom:    0.8,                            /* opens framed with padding (was 1.6 — too tight) */
    aspect:  1.0                             /* updated per-frame from canvas size */
  };

  /* Pointer interaction state — same conventions as raymarcher */
  this._pointerDown   = false;
  this._lastPointerX  = 0;
  this._lastPointerY  = 0;

  this._setupGL();
  if (!this._compileShader())  { this.failed = true; return; }
  this._uploadMesh();
  this._attachInteractionHandlers();
}

StiffnessViz.prototype._setupGL = function() {
  var gl = this.gl;
  /* Push 5.5 — clearColor is transparent so the CSS radial-gradient
     background set in the constructor shows through wherever the surface
     doesn't cover.  The CSS bg is darker sage (#6b6e64) with a subtle
     center-light gradient.  See StiffnessViz constructor for the gradient
     definition. */
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.DEPTH_TEST);
  /* Push 5.3 — DO NOT cull back faces.  Stiffness surfaces are non-convex
     (e.g. saddle-topology lobes in design B), and back-face culling
     incorrectly hides front faces in concave regions where the implicit
     winding flips relative to the camera.  Symptom Matt caught: the
     background showed through the surface at certain orientations.
     1280 tris × 2 sides is still trivial GPU work. */
  gl.disable(gl.CULL_FACE);
  gl.frontFace(gl.CCW);
};

StiffnessViz.prototype._mkShader = function(type, src) {
  var gl = this.gl;
  var sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[StiffnessViz] shader compile failed:\n' + gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
};

StiffnessViz.prototype._compileShader = function() {
  var gl = this.gl;
  var vs = this._mkShader(gl.VERTEX_SHADER,   LAB_SV_VS);
  var fs = this._mkShader(gl.FRAGMENT_SHADER, LAB_SV_FS);
  if (!vs || !fs) return false;
  var prg = gl.createProgram();
  gl.attachShader(prg, vs);
  gl.attachShader(prg, fs);
  gl.linkProgram(prg);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prg, gl.LINK_STATUS)) {
    console.error('[StiffnessViz] program link failed:\n' + gl.getProgramInfoLog(prg));
    return false;
  }
  this._prog = prg;
  /* Cache uniform locations.  uS is an array — getUniformLocation('uS')
     returns the location of element 0; subsequent elements are at
     ['uS[1]', 'uS[2]', …].  We bind via uniform1fv with the whole array. */
  var L = {};
  ['uS[0]','uREmax','uCmin','uCmax','uRot','uZoom','uAspect'].forEach(function(name){
    L[name] = gl.getUniformLocation(prg, name);
  });
  this._uloc = L;
  return true;
};

StiffnessViz.prototype._uploadMesh = function() {
  var gl = this.gl;
  this._vboPos = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
  gl.bufferData(gl.ARRAY_BUFFER, LAB_SV_MESH.positions, gl.STATIC_DRAW);
  this._iboTris = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._iboTris);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, LAB_SV_MESH.indices, gl.STATIC_DRAW);
  /* Bind aPos attribute */
  gl.useProgram(this._prog);
  var posLoc = gl.getAttribLocation(this._prog, 'aPos');
  gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
  this._meshUploaded = true;
};


/* ════════════════════════════════════════════════════════════
   uploadDesign(S_mpa, rho)
     S_mpa : Float64Array(36) or Array(36) — row-major Voigt 6×6
             compliance in MPa^-1 from solveDesignElasticFull.
     rho   : volume fraction (unused for math; here for future
             metric overlays).
   Computes per-design E_max, E_min, and anisotropy ratio by
   evaluating E(n̂) at all 642 icosphere vertices.  Stores S
   coefficients and stats for the shader and readout.
   ════════════════════════════════════════════════════════════ */
StiffnessViz.prototype.uploadDesign = function(S_mpa /*, rho */) {
  if (this.failed) return;
  if (!S_mpa || S_mpa.length !== 36) {
    this._stats = { E_max: 0, E_min: 0, aniso: 1, hasData: false };
    this._dirty = true;
    return;
  }

  /* Convert to Float32Array for the GL uniform.  Even if input is
     already Float32, .set() handles it cleanly. */
  for (var k = 0; k < 36; k++) this._S[k] = S_mpa[k];

  /* Sample E(n̂) at every icosphere vertex to find E_max / E_min.
     Same math as the vertex shader, mirrored on the CPU.
     Push 5.2 — uses the corrected engineering-Voigt v vector with NO
     factor of 2 on shear entries.  See LAB_SV_VS header for the
     convention derivation. */
  var positions = LAB_SV_MESH.positions;
  var nV        = LAB_SV_MESH.nVerts;
  var Emax = -Infinity, Emin = Infinity;
  for (var vi = 0; vi < nV; vi++) {
    var nx = positions[vi*3 + 0];
    var ny = positions[vi*3 + 1];
    var nz = positions[vi*3 + 2];
    var v0 = nx*nx,  v1 = ny*ny,  v2 = nz*nz;
    var v3 = ny*nz,  v4 = nx*nz,  v5 = nx*ny;
    var vv = [v0, v1, v2, v3, v4, v5];
    var inv_E = 0;
    for (var i = 0; i < 6; i++) {
      for (var j = 0; j < 6; j++) {
        inv_E += S_mpa[i*6 + j] * vv[i] * vv[j];
      }
    }
    if (inv_E > 1e-30) {
      var E = 1.0 / inv_E;
      if (E > Emax) Emax = E;
      if (E < Emin) Emin = E;
    }
  }
  if (!isFinite(Emax) || Emax <= 0) {
    this._stats = { E_max: 0, E_min: 0, aniso: 1, hasData: false };
  } else {
    this._stats = {
      E_max: Emax,
      E_min: Emin,
      aniso: (Emin > 1e-30) ? (Emax / Emin) : Infinity,
      hasData: true
    };
  }
  /* Default to per-design normalization for both radius and color until
     setVizParams is called by the design-grid push loop. */
  this._REmax = this._stats.E_max || 1;
  this._Cmin  = this._stats.E_min || 0;
  this._Cmax  = this._stats.E_max || 1;
  this._dirty = true;
};


/* Push 5.3 — setVizParams(REmax, Cmin, Cmax)
   Push per-design or shared normalization values to the shader.
     REmax — radius divisor (E/REmax → vertex radial scale)
     Cmin  — color stretch low end
     Cmax  — color stretch high end
   Called from 40-design-grid.js after mount, using resolveStiffViz which
   honors the per/shared toggle.  In 'per' mode all three come from this
   design's own stats; in 'shared' mode all three come from the global
   E_min/E_max across all designs (so cross-design comparison shows
   weaker designs as both smaller AND darker). */
StiffnessViz.prototype.setVizParams = function(REmax, Cmin, Cmax) {
  if (this.failed) return;
  if (REmax != null && isFinite(REmax) && REmax > 0) this._REmax = REmax;
  else this._REmax = this._stats.E_max || 1;
  if (Cmin != null && isFinite(Cmin) && Cmin >= 0)   this._Cmin = Cmin;
  else this._Cmin = this._stats.E_min || 0;
  if (Cmax != null && isFinite(Cmax) && Cmax > 0)    this._Cmax = Cmax;
  else this._Cmax = this._stats.E_max || 1;
  this._dirty = true;
};

/* #5 — axis gimbal (shares the raymarcher's helpers; same rotation convention). */
StiffnessViz.prototype.setGimbal = function(el) {
  this._gimbal = (typeof labGimbalRefs === 'function') ? labGimbalRefs(el) : null;
  this._gimbalLast = null;
};
StiffnessViz.prototype._updateGimbal = function() {
  if (!this._gimbal || typeof labGimbalUpdate !== 'function') return;
  labGimbalUpdate(this._gimbal, this._rotX, this._rotY, this);
};

StiffnessViz.prototype.getStats = function() {
  /* Returns a copy so callers can't mutate internal state. */
  return {
    E_max:    this._stats.E_max,
    E_min:    this._stats.E_min,
    aniso:    this._stats.aniso,
    hasData:  this._stats.hasData
  };
};


/* ════════════════════════════════════════════════════════════
   Render loop — auto-rotate when no pointer interaction, render
   on-dirty otherwise.  Same pattern as LabRaymarcher.
   ════════════════════════════════════════════════════════════ */
StiffnessViz.prototype.setActive = function(b) {
  if (this.failed) return;
  if (b && !this._active) {
    this._active = true;
    this._lastTickMs = performance.now();
    var self = this;
    this._raf = requestAnimationFrame(function tick(ts){
      if (!self._active) return;
      self._tick(ts);
      self._raf = requestAnimationFrame(tick);
    });
  } else if (!b && this._active) {
    this._active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
};

StiffnessViz.prototype._tick = function(ts) {
  /* Slow auto-rotation — about half the speed of the raymarcher's geom
     mode so the lobes are readable.  Push 5.3 — stops permanently once
     the user has interacted with the tile (drag, pinch); the initial
     auto-rotate on tab open is the only animated phase, after that the
     user is in control. */
  if (!this._pointerDown && !this._userInteracted) {
    var dt = (ts - this._lastTickMs) * 0.001;
    if (dt > 0.1) dt = 0.1;
    this._rotY += dt * 0.25;
    this._dirty = true;
  }
  this._lastTickMs = ts;
  if (this._dirty) this._render();
};

StiffnessViz.prototype._render = function() {
  if (this.failed || !this._meshUploaded) return;
  var gl = this.gl;

  /* Resize backing-store to match CSS pixels × dpr, clamped */
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var w = Math.max(1, Math.floor(this.canvas.clientWidth  * dpr));
  var h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
  if (this.canvas.width !== w || this.canvas.height !== h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  /* Build rotation matrix: pitch (X) then yaw (Y) */
  var cy = Math.cos(this._rotY), sy = Math.sin(this._rotY);
  var cx = Math.cos(this._rotX), sx = Math.sin(this._rotX);
  /* Row-major equivalent of  R_x(rotX) · R_y(rotY) — applied as a
     column-major mat3 so the WebGL convention matches.  Using direct
     element layout to avoid pulling in a matrix lib. */
  var rot = new Float32Array([
     cy,         0,     -sy,
     sx * sy,    cx,     sx * cy,
     cx * sy,   -sx,     cx * cy
  ]);
  this._updateGimbal();   /* #5 — keep the axis triad in sync with the surface */

  gl.useProgram(this._prog);
  gl.uniform1fv(this._uloc['uS[0]'], this._S);
  gl.uniform1f (this._uloc.uREmax,   this._REmax);
  gl.uniform1f (this._uloc.uCmin,    this._Cmin);
  gl.uniform1f (this._uloc.uCmax,    this._Cmax);
  gl.uniformMatrix3fv(this._uloc.uRot, false, rot);
  gl.uniform1f (this._uloc.uZoom,    this._u.zoom);
  gl.uniform1f (this._uloc.uAspect,  w / h);

  /* Mesh attribs are already bound from _uploadMesh; rebind defensively
     in case another GL context (the raymarcher's) was just active. */
  gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
  var posLoc = gl.getAttribLocation(this._prog, 'aPos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._iboTris);

  gl.drawElements(gl.TRIANGLES, LAB_SV_MESH.nTris * 3, gl.UNSIGNED_SHORT, 0);
  this._dirty = false;
};

StiffnessViz.prototype.destroy = function() {
  if (this.failed) return;
  this.setActive(false);
  var gl = this.gl;
  if (this._vboPos)  { gl.deleteBuffer(this._vboPos);   this._vboPos = null; }
  if (this._iboTris) { gl.deleteBuffer(this._iboTris);  this._iboTris = null; }
  if (this._prog)    { gl.deleteProgram(this._prog);    this._prog = null; }
};


/* ════════════════════════════════════════════════════════════
   Pointer/wheel handlers — drag-rotate and wheel-zoom, same
   conventions as the raymarcher.
   ════════════════════════════════════════════════════════════ */
StiffnessViz.prototype._attachInteractionHandlers = function() {
  if (!this.canvas) return;
  var self = this;

  this.canvas.addEventListener('pointerdown', function(e) {
    self._pointerDown = true;
    self._userInteracted = true;     /* push 5.3 — disables auto-rotate permanently */
    self._lastPointerX = e.clientX;
    self._lastPointerY = e.clientY;
    self.canvas.setPointerCapture(e.pointerId);
    self.canvas.style.cursor = 'grabbing';
  });
  this.canvas.addEventListener('pointermove', function(e) {
    if (!self._pointerDown) return;
    var dx = e.clientX - self._lastPointerX;
    var dy = e.clientY - self._lastPointerY;
    self._lastPointerX = e.clientX;
    self._lastPointerY = e.clientY;
    /* Same touchscreen-style "grab the scene" convention as the raymarcher */
    self._rotY -= dx * 0.012;
    self._rotX -= dy * 0.012;
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
  this.canvas.addEventListener('pointerup',     onPointerUp);
  this.canvas.addEventListener('pointercancel', onPointerUp);

  /* Wheel zoom — push 5.4 — broadened from [0.8, 3.0] to [0.15, 50.0]
     to cover (a) zooming out on high-aniso surfaces that overflow the
     viewport at the default 1.6 zoom, and (b) zooming way in on small
     designs in shared mode (where a 45× weaker design renders at 2% of
     viewport).  Step proportional to current zoom for smooth UX across
     the wide range.  Push 5.3 — wheel also counts as user interaction,
     stopping auto-rotate. */
  this.canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    self._userInteracted = true;
    var z = self._u.zoom;
    var step = z * 0.001 * e.deltaY;
    z = z * (1.0 - step);
    if (z < 0.15) z = 0.15;
    if (z > 50.0) z = 50.0;
    self._u.zoom = z;
    self._dirty = true;
  }, { passive: false });
};


/* ════════════════════════════════════════════════════════════
   Per-design registry — parallel to LAB_RM_REGISTRY.  Same
   pattern: canvases live in a hidden cache div between grid
   re-renders so their GL contexts survive.
   ════════════════════════════════════════════════════════════ */
var LAB_SV_REGISTRY  = {};   /* designId → StiffnessViz */
var LAB_SV_CACHE_DIV = null;

function ensureSVCacheDiv() {
  if (LAB_SV_CACHE_DIV) return LAB_SV_CACHE_DIV;
  var d = document.createElement('div');
  d.id = 'sv-canvas-cache';
  d.style.display = 'none';
  d.style.position = 'absolute';
  d.style.width = '0';
  d.style.height = '0';
  document.body.appendChild(d);
  LAB_SV_CACHE_DIV = d;
  return d;
}

function getOrCreateStiffnessViz(designId) {
  var sv = LAB_SV_REGISTRY[designId];
  if (sv && !sv.failed) return sv;
  sv = new StiffnessViz();
  if (sv.failed) return null;
  LAB_SV_REGISTRY[designId] = sv;
  ensureSVCacheDiv().appendChild(sv.canvas);
  return sv;
}

function disposeStiffnessViz(designId) {
  var sv = LAB_SV_REGISTRY[designId];
  if (!sv) return;
  if (sv.canvas && sv.canvas.parentNode) sv.canvas.parentNode.removeChild(sv.canvas);
  sv.destroy();
  delete LAB_SV_REGISTRY[designId];
}

function pauseAllStiffnessViz() {
  for (var id in LAB_SV_REGISTRY) {
    if (LAB_SV_REGISTRY.hasOwnProperty(id)) LAB_SV_REGISTRY[id].setActive(false);
  }
}


/* ════════════════════════════════════════════════════════════
   IntersectionObserver for stiffness tiles — parallel to the
   raymarcher's.  Single shared observer; pauses when off-screen
   or tab not visible.
   ════════════════════════════════════════════════════════════ */
var LAB_SV_IO = null;

function ensureSVObserver() {
  if (LAB_SV_IO) return LAB_SV_IO;
  if (typeof IntersectionObserver === 'undefined') return null;
  LAB_SV_IO = new IntersectionObserver(function(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var id = e.target.getAttribute('data-design-id');
      if (!id) continue;
      var sv = LAB_SV_REGISTRY[id];
      if (!sv) continue;
      var shouldRun = e.isIntersecting && !document.hidden;
      sv.setActive(shouldRun);
    }
  }, { threshold: 0.01 });
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      pauseAllStiffnessViz();
    } else {
      for (var id in LAB_SV_REGISTRY) {
        if (!LAB_SV_REGISTRY.hasOwnProperty(id)) continue;
        var sv = LAB_SV_REGISTRY[id];
        var mount = document.querySelector('.sv-mount[data-design-id="' + id + '"]');
        if (!mount) continue;
        var r = mount.getBoundingClientRect();
        var visible = r.bottom > 0 && r.top < window.innerHeight;
        sv.setActive(visible);
      }
    }
  });
  return LAB_SV_IO;
}


/* ════════════════════════════════════════════════════════════
   mountStiffnessTiles — called by 40-design-grid.js after each
   grid render.  Walks all .sv-mount placeholders, attaches the
   matching canvas, registers IntersectionObserver.
   ════════════════════════════════════════════════════════════ */
function mountStiffnessTiles() {
  var io = ensureSVObserver();
  var mounts = document.querySelectorAll('.sv-mount');
  for (var i = 0; i < mounts.length; i++) {
    var mount = mounts[i];
    var id = mount.getAttribute('data-design-id');
    if (!id) continue;
    var sv = LAB_SV_REGISTRY[id];
    if (!sv) continue;
    if (sv.canvas && sv.canvas.parentNode !== mount) {
      mount.appendChild(sv.canvas);
    }
    /* #5 — wire the axis-gimbal overlay (sibling of the mount in the viewport). */
    if (sv.setGimbal) {
      var vp = mount.parentNode;
      sv.setGimbal(vp ? vp.querySelector('.vp-gimbal') : null);
    }
    if (io) io.observe(mount);
  }
}


/* ════════════════════════════════════════════════════════════
   computeGlobalStiffEmax — max E_max across all designs.  Used
   in 'shared' normalization mode so every surface renders on the
   same scale.  Returns 0 if no designs have stiffness data.
   ════════════════════════════════════════════════════════════ */
function computeGlobalStiffEmax(allDesigns) {
  if (!allDesigns || allDesigns.length === 0) return 0;
  var maxE = 0;
  for (var i = 0; i < allDesigns.length; i++) {
    var sv = LAB_SV_REGISTRY[allDesigns[i].id];
    if (sv && sv._stats && sv._stats.hasData) {
      if (sv._stats.E_max > maxE) maxE = sv._stats.E_max;
    }
  }
  return maxE;
}

/* Push 5.3 — companion to computeGlobalStiffEmax.  Returns the smallest
   E_min across all designs (the floor of the color stretch in shared
   mode).  Returns 0 if no designs have stiffness data. */
function computeGlobalStiffEmin(allDesigns) {
  if (!allDesigns || allDesigns.length === 0) return 0;
  var minE = Infinity;
  for (var i = 0; i < allDesigns.length; i++) {
    var sv = LAB_SV_REGISTRY[allDesigns[i].id];
    if (sv && sv._stats && sv._stats.hasData) {
      if (sv._stats.E_min < minE) minE = sv._stats.E_min;
    }
  }
  return isFinite(minE) ? minE : 0;
}


/* ════════════════════════════════════════════════════════════
   resolveStiffViz — pick the (REmax, Cmin, Cmax) triple for one
   design's render, based on the global normalization mode (shared
   with the stress tab via getStressNormMode()).

   Push 5.3 — color stretch and radius stretch both honor the toggle:

     'per' mode:
       REmax = this design's E_max
       Cmin  = this design's E_min   } color spans full cividis range
       Cmax  = this design's E_max   } for every design

     'shared' mode:
       REmax = global max(E_max) across designs
                 (strongest design fills viewport; weaker designs
                  shrink proportionally)
       Cmin  = global min(E_min) across designs
                 (weak designs render as mostly-dark; strong as
                  mostly-yellow; "same color = same E value" everywhere)
       Cmax  = global max(E_max) across designs

   Returns { REmax, Cmin, Cmax } all in MPa.
   ════════════════════════════════════════════════════════════ */
function resolveStiffViz(design, allDesigns) {
  var sv = LAB_SV_REGISTRY[design.id];
  var localStats = (sv && sv.getStats) ? sv.getStats() : null;
  if (!localStats || !localStats.hasData) {
    return { REmax: 1, Cmin: 0, Cmax: 1 };
  }
  var mode = (typeof getStressNormMode === 'function') ? getStressNormMode() : 'per';
  if (mode === 'shared') {
    var globalMax = computeGlobalStiffEmax(allDesigns);
    var globalMin = computeGlobalStiffEmin(allDesigns);
    return {
      REmax: globalMax > 0 ? globalMax : localStats.E_max,
      Cmin:  globalMin >= 0 ? globalMin : localStats.E_min,
      Cmax:  globalMax > 0 ? globalMax : localStats.E_max
    };
  }
  /* per-design */
  return {
    REmax: localStats.E_max,
    Cmin:  localStats.E_min,
    Cmax:  localStats.E_max
  };
}

/* Backward-compat shim — push 5.0/5.1 used resolveStiffEmax returning a
   single Emax.  Kept so any external caller (unlikely) doesn't break.
   The 40-design-grid.js call site migrates to resolveStiffViz. */
function resolveStiffEmax(design, allDesigns) {
  return resolveStiffViz(design, allDesigns).REmax;
}
