/* liquid-ui (mshomper/liquid-ui @ 0258a0c) — core + widgets bundle. Do not edit here; edit the kit and rebuild. */
/* ============================================================================
   Liquid UI core — SDF-shaded "liquid" controls for the web.
   One shared WebGL context renders every component into its own 2D canvas.
   Components supply GLSL for two signed distance fields:
     float bodySDF(vec2 p)    neutral glass surface (track, bar, panel). Return 1e5 if none.
     float accentSDF(vec2 p)  lit liquid accent (bead, knob, droplet). Return 1e5 if none.
   Optional:  #define HAS_FLOOD + float floodSDF(vec2 p)  accent-tinted liquid INSIDE the body.
              #define BULGE 14.0   apparent thickness of the accent blob (px) for lighting.
              #define SHADOW_DY 12.0 / SHADOW_A 0.5 / SHADOW_R 18.0   body drop shadow offset, opacity, falloff (px).
              #define HAS_ACCENT_AT + void accentAt(vec2 p, inout vec3 A, inout vec3 AD)  per-pixel accent
                (several accent colours on one surface; A/AD arrive as uAccent/uAccentDeep).
              #define BODY_LIT (+ BODY_BULGE 28.0)  thick glass body: shaded from its SDF, fresnel rim, specular
                from the surface light (surf.setLight). Without it the body is the flat glass panel.
              #define BODY_SPEC vec2(48., 0.5)  body specular power and strength (lower power = broader, softer sheen).
              #define HAS_INTERIOR + vec4 interiorAt(vec2 p, float d)  premultiplied colour painted inside
                the body, over the glass fill (d = body distance, negative inside).
              #define HAS_UNDER + vec4 underAt(vec2 p)   premultiplied colour painted first (floor, backdrop glow).
              #define HAS_OVER  + vec4 overAt(vec2 p)    premultiplied colour painted last (sparks, highlights).
              #define GLOW_R 11.0 / GLOW_A 0.33 / GLOW_FADE vec2(r0, r1)   accent glow falloff, strength, fade-out.
              #define ACCENT_EMIT 0.0   accent emits light (0..1): lifts its shadowed side toward the accent colour.
   p is in CSS px, origin top-left of the component canvas, y down.
   Rules: exact SDFs only (no "mix the radius" shortcuts); snap springs at rest;
   text/icons are DOM on top; shapes live in the shader.
   ========================================================================== */
const Liquid = (() => {
  'use strict';

  // ---------- global state ----------
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const state = { melt: 16, spring: 1, timeScale: 1, field: false, get reduce() { return reduceMQ.matches; } };

  // ---------- OKLCH -> gamma sRGB [0..1] ----------
  function oklch(L, C, h) {
    const r_ = h * Math.PI / 180, a = C * Math.cos(r_), b = C * Math.sin(r_);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
    return lin.map(x => { x = Math.min(1, Math.max(0, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; });
  }
  // accent palette: near-even lightness, similar chroma
  const ACCENTS = {
    lime:   { L: 0.88, C: 0.19, h: 125 },
    aqua:   { L: 0.84, C: 0.14, h: 200 },
    violet: { L: 0.80, C: 0.15, h: 290 },
    amber:  { L: 0.84, C: 0.16, h: 75 },
    coral:  { L: 0.72, C: 0.17, h: 22 },
    // axis hues (X / Y / Z), even lightness for 3D tools
    axisX:  { L: 0.80, C: 0.13, h: 215 },
    axisY:  { L: 0.76, C: 0.19, h: 330 },
    axisZ:  { L: 0.86, C: 0.16, h: 95 }
  };
  function mixAccent(A, B, u) {
    let dh = B.h - A.h; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
    return { L: A.L + (B.L - A.L) * u, C: A.C + (B.C - A.C) * u, h: (A.h + dh * u + 360) % 360 };
  }
  // glass theme: set per app with Liquid.setTheme({ fillTop:{L,C,h}, fillBot:{L,C,h} })
  let FILL_TOP = oklch(0.215, 0.028, 288), FILL_BOT = oklch(0.165, 0.024, 286);
  function setTheme({ fillTop, fillBot } = {}) {
    if (fillTop) FILL_TOP = oklch(fillTop.L, fillTop.C, fillTop.h);
    if (fillBot) FILL_BOT = oklch(fillBot.L, fillBot.C, fillBot.h);
    redrawAll();
  }

  // ---------- shared GL ----------
  const glc = document.createElement('canvas');
  glc.width = 2; glc.height = 2;
  const gl = glc.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
  const ok = !!gl;

  const VS = 'attribute vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }';

  const HEADER = `
precision highp float;
uniform vec2 uRes; uniform float uDpr, uField, uK, uTime;
uniform vec3 uAccent, uAccentDeep, uFillTop, uFillBot;
uniform float uAccentA, uBleed;   // accent layer opacity (0..1), set via surf.setAccentOpacity()
uniform float uGlowA;             // accent glow + spill strength (0..1), set via surf.setGlow()
uniform vec3 uLight;              // light direction (x right, y down, z toward viewer), set via surf.setLight()
`;

  // exact distance primitives + smooth booleans
  const LIB = `
float sdCircle(vec2 p, float r){ return length(p) - r; }
float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d,0.)) + min(max(d.x,d.y),0.); }
float sdRoundBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q,0.)) + min(max(q.x,q.y),0.) - r; }
float sdSegment(vec2 p, vec2 a, vec2 b){ vec2 pa = p-a, ba = b-a; float h = clamp(dot(pa,ba)/max(dot(ba,ba),1e-6), 0., 1.); return length(pa - ba*h); }
float sdCapsule(vec2 p, vec2 a, vec2 b, float r){ return sdSegment(p,a,b) - r; }
float sdEllipseApprox(vec2 p, vec2 r){ float k0 = length(p/r), k1 = length(p/(r*r)); return k0*(k0-1.)/max(k1,1e-6); }
// exact tapered capsule: radius ra at a, rb at b (after I. Quilez). Continuous everywhere.
float sdTaper(vec2 p, vec2 a, vec2 b, float ra, float rb){
  p -= a; b -= a;
  float h = dot(b,b), r = ra - rb;
  if (h <= r*r + 1e-3) return min(length(p) - ra, length(p - b) - rb);
  vec2 q = vec2(dot(p, vec2(b.y, -b.x)), dot(p, b)) / h;
  q.x = abs(q.x);
  vec2 c = vec2(sqrt(h - r*r), r);
  float k = c.x*q.y - c.y*q.x;
  if (k < 0.)  return sqrt(h*dot(q,q)) - ra;
  if (k > c.x) return sqrt(h*(dot(q,q) + 1. - 2.*q.y)) - rb;
  return dot(c,q) - ra;
}
// polynomial smooth min / max (k = blend width in px; k<=0 -> hard)
float smin(float a, float b, float k){ if (k <= 0.) return min(a,b); float h = max(k-abs(a-b),0.)/k; return min(a,b) - h*h*k*0.25; }
float smax(float a, float b, float k){ if (k <= 0.) return max(a,b); float h = max(k-abs(a-b),0.)/k; return max(a,b) + h*h*k*0.25; }
float ssub(float a, float b, float k){ return smax(a, -b, k); }   // a minus b, filleted
// compositing (available to component code, e.g. in underAt / overAt)
void over(inout vec4 acc, vec3 c, float a){ acc.rgb = c*a + acc.rgb*(1.-a); acc.a = a + acc.a*(1.-a); }
void overP(inout vec4 acc, vec4 c){ acc.rgb = c.rgb + acc.rgb*(1.-c.a); acc.a = c.a + acc.a*(1.-c.a); }   // premultiplied
`;

  // generic shading: glass body + flood + lit accent liquid
  const SHADE = `
#ifndef BULGE
#define BULGE 14.0
#endif
#ifndef SHADOW_DY
#define SHADOW_DY 12.0
#endif
#ifndef SHADOW_A
#define SHADOW_A 0.5
#endif
#ifndef SHADOW_R
#define SHADOW_R 18.0
#endif
#ifndef GLOW_R
#define GLOW_R 11.0
#define GLOW_FADE vec2(13.5, 29.)
#endif
#ifndef GLOW_FADE
#define GLOW_FADE vec2(GLOW_R*1.23, GLOW_R*2.64)
#endif
#ifndef GLOW_A
#define GLOW_A 0.33
#endif
#ifndef BODY_BULGE
#define BODY_BULGE 28.0
#endif
#ifndef BODY_SPEC
#define BODY_SPEC vec2(48., 0.5)
#endif
vec3 litLiquid(float a, vec2 g, float flatness, vec3 A, vec3 AD){
  float depth = clamp(-a / BULGE, 0., 1.);
  float z = sqrt(1. - (1.-depth)*(1.-depth));
  vec3 N = normalize(vec3(g*(1.-depth)*(1.-flatness), max(z, 0.05)));
  vec3 L = normalize(uLight);
  float dif = clamp(dot(N,L), 0., 1.);
  vec3 col = mix(AD, A, 0.3 + 0.7*dif);
#ifdef ACCENT_EMIT
  col = mix(col, A*1.08, ACCENT_EMIT*(1.-flatness));
#endif
  float spec = pow(clamp(dot(reflect(-L,N), vec3(0.,0.,1.)), 0., 1.), 28.) * 0.32 * (1.-flatness);
  return col + spec;
}
void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr - vec2(uBleed);   // host-local px
  float aa = 1.0 / uDpr;
  float d  = bodySDF(p);
  float a  = accentSDF(p);
#ifdef HAS_FLOOD
  float fl = floodSDF(p);
#else
  float fl = 1e5;
#endif
  vec4 acc = vec4(0.);
  vec3 A = uAccent, AD = uAccentDeep;
#ifdef HAS_UNDER
  if (uField < 0.5) overP(acc, underAt(p));
#endif
#ifdef HAS_ACCENT_AT
  accentAt(p, A, AD);
#endif

  if (uField > 0.5) {
    float f = min(d, a);
    vec3 inC = vec3(0.30,0.55,1.0), outC = vec3(1.0,0.62,0.28);
    float band = 0.55 + 0.45*cos(d*0.785);
    over(acc, (d < 0. ? inC : outC) * band * exp(-abs(d)/90.), d > 9e4 ? 0. : 0.85*exp(-max(d,0.)/120.)*(1. - smoothstep(30., 60., d)));
    over(acc, vec3(1.), clamp(1.2 - abs(d)/aa*0.6, 0., 1.));
    float abnd = 0.5 + 0.5*cos(a*0.785);
    over(acc, A * abnd, a < 0. ? 0.55 : 0.);
    over(acc, A, clamp(1. - abs(a)/aa, 0., 1.));
    over(acc, mix(A, vec3(1.), .5), clamp(1. - abs(fl)/aa, 0., 1.) * 0.8);
    gl_FragColor = acc; return;
  }

  float t = clamp((p.y + uBleed) * uDpr / uRes.y, 0., 1.);
  float fillA = clamp(0.5 - d/aa, 0., 1.);
  vec2 gd = vec2(bodySDF(p + vec2(0.5,0.)) - d, bodySDF(p + vec2(0.,0.5)) - d);
  gd = gd / max(length(gd), 1e-5);

  // drop shadow under body
  float dS = bodySDF(p - vec2(0., SHADOW_DY));
  over(acc, vec3(0.), SHADOW_A * exp(-max(dS,0.)/SHADOW_R) * (1. - smoothstep(SHADOW_R*0.55, SHADOW_R*1.67, dS)) * (1. - fillA));

  // glass fill, faint top rim light, accent light spilling in
  float spill = exp(-max(a, 0.)/19.) * uAccentA * uGlowA;
  vec3 fill = mix(uFillTop, uFillBot, t);
  fill += vec3(0.04) * (1. - smoothstep(0., 9., -d)) * clamp(-gd.y, 0., 1.);
  fill = mix(fill, A*0.35 + fill*0.65, spill * 0.2 * (1. - smoothstep(0., 30., -d)));
#ifdef BODY_LIT
  {
    float dep = clamp(-d / BODY_BULGE, 0., 1.);
    vec3 Nb = normalize(vec3(gd*(1.-dep), max(sqrt(1. - (1.-dep)*(1.-dep)), 0.05)));
    vec3 Lb = normalize(uLight);
    float fres = pow(1. - Nb.z, 3.);
    float sp = pow(clamp(dot(reflect(-Lb, Nb), vec3(0., 0., 1.)), 0., 1.), BODY_SPEC.x);
    fill = fill*(0.72 + 0.4*clamp(dot(Nb, Lb), 0., 1.)) + vec3(0.92, 1., 0.96)*sp*BODY_SPEC.y + mix(vec3(1.), A, clamp(0.4 + spill, 0., 1.))*fres*0.2;
  }
#endif
  over(acc, fill, fillA);
#ifdef HAS_INTERIOR
  if (fillA > 0.) { vec4 ic = interiorAt(p, d); overP(acc, ic*fillA); }
#endif

  // flood: accent liquid held inside the body
#ifdef HAS_FLOOD
  float flA = clamp(0.5 - fl/aa, 0., 1.);
  if (flA > 0.) {
    vec2 gf = vec2(floodSDF(p + vec2(0.5,0.)) - fl, floodSDF(p + vec2(0.,0.5)) - fl);
    gf = gf / max(length(gf), 1e-5);
    over(acc, litLiquid(fl, gf, 0.55, A, AD) * 0.92, flA * 0.94);
  }
#endif

  // accent contact shadow on the body
  float aS = accentSDF(p - vec2(0., 6.));
  over(acc, vec3(0.), 0.42 * exp(-max(aS,0.)/7.) * fillA * clamp(a/2., 0., 1.) * uAccentA);

  // hairline outline of the body: translucent ink, warmer near accent
  float lineA = clamp((0.55 - abs(d)) / aa + 0.5, 0., 1.);
  float inkA  = mix(0.12, 0.30, clamp(-gd.y*0.5 + 0.5, 0., 1.)) + 0.28*spill;
  over(acc, mix(vec3(1.), A, clamp(spill*0.72, 0., 1.)), lineA * clamp(inkA, 0., 0.85));

  // accent glow + lit body
  over(acc, A, GLOW_A * exp(-max(a,0.)/GLOW_R) * (1. - smoothstep(GLOW_FADE.x, GLOW_FADE.y, a)) * clamp(a, 0., 1.) * uAccentA * uGlowA);
  float aA = clamp(0.5 - a/aa, 0., 1.);
  if (aA > 0.) {
    vec2 ga = vec2(accentSDF(p + vec2(0.5,0.)) - a, accentSDF(p + vec2(0.,0.5)) - a);
    ga = ga / max(length(ga), 1e-5);
    over(acc, litLiquid(a, ga, 0., A, AD), aA * uAccentA);
  }
#ifdef HAS_OVER
  overP(acc, overAt(p));
#endif
  gl_FragColor = acc;
}
`;

  let quad = null;
  const programCache = new Map();   // GLSL -> { glsl, pr, loc }; Surfaces hold the entry, so a rebuilt program reaches them
  const lost = () => gl.isContextLost();
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      if (lost() || !log) { gl.deleteShader(s); return null; }   // lost, or a failure with no log (a GPU process that isn't ready yet): retry
      console.error('[Liquid] shader error:\n' + log + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
      throw new Error(log);
    }
    return s;
  }
  function build(entry) {   // (re)link entry.pr from entry.glsl; stays null while the context is lost
    entry.pr = null; entry.loc.clear();
    if (lost()) return entry;
    const vs = compile(gl.VERTEX_SHADER, VS), fs = vs && compile(gl.FRAGMENT_SHADER, HEADER + LIB + entry.glsl + SHADE);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (!lost() && (entry.tries = (entry.tries || 0) + 1) < 8) setTimeout(() => { if (!entry.pr) { build(entry); redrawAll(); } }, 120 * entry.tries);
      return entry;
    }
    const pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs);
    gl.bindAttribLocation(pr, 0, 'a');
    gl.linkProgram(pr);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { if (lost()) return entry; throw new Error(gl.getProgramInfoLog(pr)); }
    entry.pr = pr;
    return entry;
  }
  function program(glsl) {
    if (programCache.has(glsl)) return programCache.get(glsl);
    const entry = { glsl, pr: null, loc: new Map() };
    programCache.set(glsl, entry);
    return build(entry);
  }
  function ensureQuad() {
    if (quad || lost()) return;
    quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.SCISSOR_TEST);
  }

  // GPU reset / driver hiccup: keep the canvases' last frames, rebuild everything on restore, redraw.
  if (ok) {
    glc.addEventListener('webglcontextlost', e => { e.preventDefault(); quad = null; }, false);
    glc.addEventListener('webglcontextrestored', () => {
      quad = null; ensureQuad();
      for (const entry of programCache.values()) { try { build(entry); } catch (err) { console.error('[Liquid] rebuild failed', err); } }
      redrawAll();
    }, false);
  }

  // ---------- Surface: one component's canvas ----------
  const surfaces = new Set();
  class Surface {
    constructor(host, { glsl, onResize, bleed = 24, res = 1 } = {}) {
      this.host = host; this.bleed = bleed; this.onResize = onResize || (() => {});   // bleed: canvas extends past host so shadow/glow are not clipped
      this.res = res;   // extra resolution for hosts inside a CSS-scaled parent
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'lq-canvas';
      Object.assign(this.canvas.style, { position: 'absolute', left: -bleed + 'px', top: -bleed + 'px', width: `calc(100% + ${2 * bleed}px)`, height: `calc(100% + ${2 * bleed}px)`, display: 'block', pointerEvents: 'none' });
      host.prepend(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.uniforms = new Map();
      this.w = 0; this.h = 0; this.dpr = 1;
      this.accentA = 1; this.glowA = 1; this.light = [-0.45, -0.6, 0.66];
      this.setAccent(ACCENTS.lime);
      if (ok) { ensureQuad(); this.prog = program(glsl); }   // prog.pr is null while the context is lost; rebuilt on restore
      else host.insertAdjacentHTML('beforeend', '<div style="position:absolute;inset:0;display:grid;place-items:center;font-size:12px;opacity:.6">WebGL unavailable</div>');
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
      surfaces.add(this);
      queueMicrotask(() => this.resize());   // deferred so component code can finish wiring first
    }
    resize() {
      const w = this.host.clientWidth, h = this.host.clientHeight;
      if (!w || !h) return;
      this.dpr = Math.min(Math.min(window.devicePixelRatio || 1, 2) * this.res, 3);
      this.w = w; this.h = h;
      this.canvas.width = Math.round((w + 2 * this.bleed) * this.dpr); this.canvas.height = Math.round((h + 2 * this.bleed) * this.dpr);
      this.onResize(w, h);
      this.draw();
    }
    set(name, ...v) { this.uniforms.set(name, v); return this; }
    setAccent(A) {
      this.accent = A;
      const c = accentColors(A); this.accentRGB = c.rgb; this.accentDeepRGB = c.deep;
      const s = this.host.style;
      s.setProperty('--al', A.L.toFixed(4)); s.setProperty('--ac', A.C.toFixed(4)); s.setProperty('--ah', A.h.toFixed(2));
      return this;
    }
    setAccentOpacity(a) { this.accentA = a; return this; }
    setGlow(a) { this.glowA = a; return this; }
    setFill(top, bot) { this.fill = top && bot ? [oklch(top.L, top.C, top.h), oklch(bot.L, bot.C, bot.h)] : null; return this; }   // per-surface glass; null = theme
    setRes(r) { if (Math.abs(r - this.res) > 0.01) { this.res = r; this.resize(); } return this; }
    setLight(x, y, z) { this.light = [x, y, z]; return this; }   // direction; default (-0.45, -0.6, 0.66), top left
    destroy() { this.ro.disconnect(); surfaces.delete(this); this.canvas.remove(); this.w = 0; }
    draw() {
      if (!ok || !this.w || !this.prog || !this.prog.pr || lost()) return;
      // a non-finite uniform would flood the whole canvas (NaN reads as inside): keep the last frame instead
      for (const [n, v] of this.uniforms) {
        for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) {
          if (!this.warned) { this.warned = true; console.warn(`[Liquid] skipped draw: ${n} = ${v.join(', ')}`, this.host); }
          return;
        }
      }
      if (!Number.isFinite(this.accentA) || !Number.isFinite(this.glowA)) return;
      ensureQuad();
      const W = this.canvas.width, H = this.canvas.height;
      if (glc.width < W || glc.height < H) { glc.width = Math.max(glc.width, W); glc.height = Math.max(glc.height, H); }
      const { pr, loc } = this.prog;
      gl.useProgram(pr);
      const L = n => { if (!loc.has(n)) loc.set(n, gl.getUniformLocation(pr, n)); return loc.get(n); };
      gl.viewport(0, 0, W, H); gl.scissor(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(L('uRes'), W, H); gl.uniform1f(L('uDpr'), this.dpr);
      gl.uniform1f(L('uField'), state.field ? 1 : 0); gl.uniform1f(L('uK'), state.melt);
      gl.uniform1f(L('uTime'), performance.now() / 1000);
      gl.uniform3fv(L('uAccent'), this.accentRGB); gl.uniform3fv(L('uAccentDeep'), this.accentDeepRGB);
      gl.uniform1f(L('uAccentA'), this.accentA); gl.uniform1f(L('uGlowA'), this.glowA); gl.uniform1f(L('uBleed'), this.bleed); gl.uniform3fv(L('uLight'), this.light); gl.uniform3fv(L('uFillTop'), this.fill ? this.fill[0] : FILL_TOP); gl.uniform3fv(L('uFillBot'), this.fill ? this.fill[1] : FILL_BOT);
      for (const [n, v] of this.uniforms) {
        const l = L(n); if (!l) continue;
        if (v.length === 1) gl.uniform1f(l, v[0]); else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
        else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]); else gl.uniform4f(l, v[0], v[1], v[2], v[3]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.ctx.clearRect(0, 0, W, H);
      this.ctx.drawImage(glc, 0, glc.height - H, W, H, 0, 0, W, H);
    }
  }

  // ---------- springs ----------
  class Spring {
    constructor(x = 0, { k = 300, zeta = 0.8, fixed = false } = {}) { this.x = x; this.v = 0; this.target = x; this.k = k; this.zeta = zeta; this.fixed = fixed; }
    step(h) {
      let k = this.fixed ? this.k : this.k * state.spring, z = this.zeta;
      if (state.reduce) { k = Math.max(k, 900); z = 1; }
      const c = 2 * z * Math.sqrt(k);
      this.v += (k * (this.target - this.x) - c * this.v) * h; this.x += this.v * h;
      if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) { if (Number.isFinite(this.target)) this.x = this.target; this.v = 0; }
    }
    settled(eps = 0.25) { return Math.abs(this.v) < eps * 6 && Math.abs(this.target - this.x) < eps; }
    snap() { this.x = this.target; this.v = 0; }
    set(x) { this.x = this.target = x; this.v = 0; }
  }

  // ---------- animation loop: animators step until they report settled ----------
  // dt guard: a rAF timestamp is the frame's start time, so it can come out EARLIER than a performance.now()
  // read in an input handler of the same frame, or after a long stall (handler blocked 1 s -> dt = -1 s).
  // Integrating a negative or huge dt blows springs up (a bead scale of -1e6 floods the whole canvas).
  // So the first tick after a wake, any non-positive gap, and any gap over 100 ms step one 1/60 s frame.
  const active = new Set(); let raf = 0, last = -1;
  function tick(now) {
    raf = 0;
    const ms = now - last;
    const dt = (last < 0 || !(ms > 0) || ms > 100 ? 1 / 60 : Math.min(ms / 1000, 1 / 30)) * state.timeScale;
    last = now;
    for (const a of [...active]) {
      let more = false;
      try { more = a.fn(dt); } catch (err) { console.error('[Liquid] animator error', err); }
      if (!more) active.delete(a);
    }
    if (active.size) raf = requestAnimationFrame(tick);
  }
  // fn(dt) -> true while still moving. Do substeps + draw inside fn.
  function animator(fn) {
    const a = { fn, wake() { active.add(a); if (!raf) { last = -1; raf = requestAnimationFrame(tick); } } };
    return a;
  }
  // step a list of springs with substeps
  function stepSprings(springs, dt, n = 4) { const h = dt / n; for (let i = 0; i < n; i++) for (const s of springs) s.step(h); }

  // ---------- pointer helper (local CSS px) ----------
  function pointer(el, { down, move, up, tapSlop = 6 } = {}) {
    el.style.touchAction = 'none';
    let st = null;
    const loc = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    el.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const [x, y] = loc(e); el.setPointerCapture(e.pointerId);
      st = { x0: x, y0: y, moved: false, data: down ? down(x, y, e) : null };
    });
    el.addEventListener('pointermove', e => {
      if (!st) return; const [x, y] = loc(e);
      if (!st.moved && Math.hypot(x - st.x0, y - st.y0) > tapSlop) st.moved = true;
      if (move) move(x, y, st, e);
    });
    const end = e => { if (!st) return; const [x, y] = loc(e); if (up) up(x, y, st, e); st = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }

  // CSS transitions follow Liquid.state.timeScale (slow motion keeps DOM fades in step with shapes)
  document.addEventListener('transitionrun', e => {
    if (state.timeScale === 1 || !e.target.getAnimations) return;
    for (const an of e.target.getAnimations()) if (an.transitionProperty === e.propertyName) an.playbackRate = state.timeScale;
  }, true);

  function haptic() { if (navigator.vibrate) navigator.vibrate(6); }

  // ---------- icons (drawn, stroke = currentColor) ----------
  const ICONS = {
    home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
    chat: '<path d="M12 4a8 8 0 0 0-7 11.9L4 20l4.2-1.1A8 8 0 1 0 12 4z"/>',
    camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.3"/>',
    tune: '<path d="M4 8h7.8M16.2 8H20M4 16h2.8M11.2 16H20"/><circle cx="14" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 4 4 2-2 3 3"/>',
    mic: '<rect x="9" y="4" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3"/>',
    refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/>',
    folder: '<path d="M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
    star: '<path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'
  };
  const icon = (k, cls = '') => `<svg class="lq-i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ''}</svg>`;

  // ---------- registry (gallery) ----------
  const registry = [];
  function register(def) { registry.push(def); }
  function redrawAll() { for (const s of surfaces) s.draw(); }
  // accent -> { rgb, deep } shader colours (what Surface.setAccent uses), for HAS_ACCENT_AT uniforms
  const accentColors = A => ({ rgb: oklch(A.L, A.C, A.h), deep: oklch(A.L - 0.11, A.C + 0.01, A.h) });

  return { gl: ok ? gl : null, state, oklch, ACCENTS, mixAccent, accentColors, setTheme, Surface, Spring, animator, stepSprings, pointer, haptic, ICONS, icon, register, registry, redrawAll, ok };
})();

/* ---- widgets/dropdown.js ---- */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
/* Oozing dropdown widget.
   At rest the host draws only the glass button. Opening, an overlay (fixed, on document.body) takes over
   drawing the button and adds a neck capsule and the panel in one smooth union: the panel drips out of
   the button's edge (down, or up when there is no room), then springs open in height and width. The
   selection pill is an accent capsule whose head and tail are separate springs, so it stretches as it
   slides; it is clipped to the scroll viewport and swallowed by a retracting panel. */
(() => {
  const acc = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || Liquid.ACCENTS.lime;
  const INK = 'var(--lq-ink, var(--ink, oklch(0.97 0.01 290)))', DIM = 'var(--lq-ink-dim, var(--ink-dim, oklch(0.78 0.02 290)))',
    FAINT = 'var(--lq-ink-faint, var(--ink-faint, oklch(0.62 0.02 290)))';
  const css = `
.lq-wd{ position:relative; height:44px; font-family:var(--lq-font, inherit); }
.lq-wd-btn{ position:absolute; inset:0; border:0; padding:0 14px 0 18px; background:none; border-radius:22px; cursor:pointer; font:inherit;
  color:${DIM}; -webkit-tap-highlight-color:transparent; }
.lq-wd-btn:disabled{ cursor:default; opacity:.45; }
.lq-wd-btn:focus-visible{ outline:none; box-shadow:0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .45); }
.lq-wd-face{ position:absolute; inset:0; display:flex; align-items:center; gap:8px; padding:0 14px 0 18px; pointer-events:none;
  font-size:15px; font-weight:550; color:${DIM}; white-space:nowrap; }
.lq-wd-face .t{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; text-align:left; }
.lq-wd-face b{ color:${INK}; font-weight:650; }
.lq-wd-chev{ width:18px; height:18px; flex:none; transition: transform 220ms cubic-bezier(.3,1.4,.5,1); }
.lq-wd-chev .lq-i{ stroke-width:2; }
.lq-wd-open .lq-wd-chev{ transform:rotate(180deg); }
.lq-wd-ov{ position:fixed; left:0; top:0; z-index:var(--lq-z, 1000); pointer-events:none; display:none; font-family:var(--lq-font, inherit); }
.lq-wd-ov .lq-wd-face{ inset:auto; }
.lq-wd-scroll{ position:absolute; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; scrollbar-width:none; pointer-events:none;
  --ft:0px; --fb:0px;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ft), #000 calc(100% - var(--fb)), transparent 100%);
          mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ft), #000 calc(100% - var(--fb)), transparent 100%); }
.lq-wd-scroll::-webkit-scrollbar{ display:none; }
.lq-wd-scroll.ft{ --ft:22px; } .lq-wd-scroll.fb{ --fb:22px; }
.lq-wd-open .lq-wd-scroll{ pointer-events:auto; }
.lq-wd-hdr{ height:30px; display:flex; align-items:flex-end; padding:0 0 6px 36px; font-size:11px; font-weight:650; letter-spacing:.08em;
  text-transform:uppercase; color:${FAINT}; white-space:nowrap; opacity:0; transition: opacity 90ms ease-out; }
.lq-wd-opt{ position:relative; height:44px; display:flex; align-items:center; padding:0 12px 0 36px; border-radius:12px; font-size:15px; font-weight:550;
  color:${DIM}; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  opacity:0; transform:translateY(calc(-6px * var(--dir, 1))); filter:blur(3px);
  transition: opacity 90ms ease-out, transform 90ms ease-out, filter 90ms ease-out, color 150ms ease-out, background 150ms ease-out; }
.lq-wd-opt:hover{ color:${INK}; background:oklch(1 0 0 / .04); }
.lq-wd-opt[aria-selected=true]{ color:${INK}; font-weight:650; }
.lq-wd-opt:focus-visible{ outline:none; box-shadow: inset 0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .4); }
.lq-wd-opt:focus{ outline:none; }
.lq-wd-opt[aria-disabled=true], .lq-wd-opt[aria-disabled=true]:hover{ color:${FAINT}; background:none; cursor:default; }
.lq-wd-open .lq-wd-opt, .lq-wd-open .lq-wd-hdr{ opacity:1; transform:none; filter:none;
  transition: opacity 170ms ease-out var(--d), transform 200ms cubic-bezier(.3,1.3,.5,1) var(--d), filter 170ms ease-out var(--d), color 150ms ease-out, background 150ms ease-out; }
@media (hover:none){ .lq-wd-opt:hover{ background:none; } }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  if (!document.getElementById('lq-i-base')) {   // icon base style (zero specificity) so widgets work outside the demo page
    const b = document.createElement('style'); b.id = 'lq-i-base';
    b.textContent = ':where(.lq-i){fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block;width:100%;height:100%}';
    document.head.prepend(b);
  }
  let uid = 0;

  Liquid.ui.dropdown = function (host, opts = {}) {
    const flat = [];
    let N = 0;
    const loadGroups = gs => {
      flat.length = 0;
      gs.forEach(g => g.options.forEach(o => flat.push(typeof o === 'object' ? o : { value: o, label: String(o) })));
      N = flat.length;
    };
    loadGroups(opts.groups || [{ label: '', options: opts.options || [] }]);
    const prefix = opts.prefix || '';
    const A = acc(opts.accent);
    const idx = v => flat.findIndex(o => o.value === v);
    let sel = idx(opts.value), customLabel = sel < 0 && opts.value != null ? (opts.valueLabel || String(opts.value)) : '';
    let value = opts.value ?? null, disabled = false, open = false, active = false, ready = false, destroyed = false;
    const id = 'lq-wd' + (++uid);

    host.classList.add('lq-wd');
    const faceHTML = () => `<span class="t">${prefix ? `<span class="p"></span>` : ''}<b></b></span><span class="lq-wd-chev">${Liquid.icon('chevron')}</span>`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'lq-wd-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', id + '-l');
    if (opts.ariaLabel) btn.setAttribute('aria-label', opts.ariaLabel);
    btn.innerHTML = `<span class="lq-wd-face">${faceHTML()}</span>`;
    host.appendChild(btn);

    // overlay: face clone + panel list
    const ov = document.createElement('div'); ov.className = 'lq-wd-ov';
    const face2 = document.createElement('div'); face2.className = 'lq-wd-face'; face2.setAttribute('aria-hidden', 'true'); face2.innerHTML = faceHTML();
    const scroller = document.createElement('div'); scroller.className = 'lq-wd-scroll';
    scroller.id = id + '-l'; scroller.setAttribute('role', 'listbox');
    scroller.setAttribute('aria-label', opts.ariaLabel || prefix.replace(/[:\s]+$/, '') || 'Options');
    ov.append(face2, scroller);
    const optEls = []; const rowTop = [];
    let contentH = 0, hdrEls = [];
    function build(groups) {   // (re)builds the option rows from `flat`, which loadGroups filled in the same order
      scroller.textContent = ''; optEls.length = 0; rowTop.length = 0;
      let y = 0;
      groups.forEach((g, gi) => {
        const wrap = document.createElement('div'); wrap.setAttribute('role', 'group');
        if (g.label) {
          const h = document.createElement('div'); h.className = 'lq-wd-hdr'; h.id = `${id}-g${gi}`; h.textContent = g.label;
          h.setAttribute('role', 'presentation'); wrap.setAttribute('aria-labelledby', h.id); wrap.appendChild(h); y += 30;
        }
        g.options.forEach(() => {
          const i = optEls.length, o = flat[i];
          const el = document.createElement('div'); el.className = 'lq-wd-opt'; el.setAttribute('role', 'option'); el.tabIndex = -1;
          el.id = `${id}-o${i}`; el.textContent = o.label;
          if (o.disabled) el.setAttribute('aria-disabled', 'true');
          el.addEventListener('click', () => choose(i, true));
          wrap.appendChild(el); optEls.push(el); rowTop.push(y); y += 44;
        });
        scroller.appendChild(wrap);
      });
      contentH = y;
      hdrEls = [...scroller.querySelectorAll('.lq-wd-hdr')];
    }
    build(opts.groups || [{ label: '', options: opts.options || [] }]);

    function paintFace() {
      const lab = sel >= 0 ? flat[sel].label : customLabel;
      for (const f of [btn.firstChild, face2]) { const p = f.querySelector('.p'); if (p) p.textContent = prefix; f.querySelector('b').textContent = lab; }
      if (!opts.ariaLabel) btn.setAttribute('aria-label', (prefix || '') + lab);
      else btn.setAttribute('aria-label', `${opts.ariaLabel}: ${lab}`);
      optEls.forEach((el, j) => el.setAttribute('aria-selected', j === sel));
    }
    paintFace();

    // ---- springs ----
    const desc = new Liquid.Spring(0, { k: 420, zeta: 0.78 });
    const ph = new Liquid.Spring(0, { k: 260, zeta: 0.68 });
    const pw = new Liquid.Spring(40, { k: 200, zeta: 0.74 });
    const press = new Liquid.Spring(0, { k: 700, zeta: 0.45, fixed: true });
    const head = new Liquid.Spring(0, { k: 560, zeta: 0.7 });
    const tail = new Liquid.Spring(0, { k: 340, zeta: 0.9 });
    const vis = new Liquid.Spring(0, { k: 520, zeta: 0.75 });
    let clock = 0, pending = null, closeAt = -1;
    const W0 = 40, GAP = 22, PAD = 6, BH = 44, INSET = 8;

    // ---- host surface: the button alone ----
    const hostGlsl = `
uniform vec4 uBtn;
float bodySDF(vec2 p){ return sdRoundBox(p - uBtn.xy, uBtn.zw, min(uBtn.z, uBtn.w)); }
float accentSDF(vec2 p){ return 1e5; }`;
    const hs = new Liquid.Surface(host, { glsl: hostGlsl, onResize() { ready = true; write(); } });
    hs.setAccent(A);

    // ---- overlay surface ----
    const ovGlsl = `
uniform vec4 uBtn, uPan, uNeck, uPill, uClip;
uniform float uPk, uPr;
float bodySDF(vec2 p){
  float b = sdRoundBox(p - uBtn.xy, uBtn.zw, min(uBtn.z, uBtn.w));
  float q = sdRoundBox(p - uPan.xy, uPan.zw, min(uPr, min(uPan.z, uPan.w)));
  float n = sdCapsule(p, vec2(uNeck.x, uNeck.y), vec2(uNeck.x, uNeck.z), uNeck.w);
  return smin(smin(b, n, uPk), smin(n, q, uPk), uPk * 0.4);
}
float accentSDF(vec2 p){
  if (uPill.w <= 0.) return 1e5;
  float s = uPill.w;
  float y0 = min(uPill.y, uPill.z) - 8.*s, y1 = max(uPill.y, uPill.z) + 8.*s;
  float a = sdCapsule(p, vec2(uPill.x, y0), vec2(uPill.x, y1), 3.5*s) + (1. - s)*56.;
  a = smax(a, sdBox(p - uClip.xy, uClip.zw), 3.);
  return smax(a, bodySDF(p) + 6., 4.);
}`;
    let os = null;   // created lazily on first open
    const Lo = { ovL: 0, ovT: 0, ovW: 0, ovH: 0, bx: 0, by: 0, bw: 0, px: 0, PW: 0, PH: 0, PT: 0, dir: 1, nx: 0, sx: 0, sy: 0, sw: 0, sh: 0, rx: 0, ry: 0 };

    function themeOverlay() {
      const cs = getComputedStyle(host);
      for (const v of ['--lq-ink', '--lq-ink-dim', '--lq-ink-faint', '--lq-font', '--lq-mono', '--ink', '--ink-dim', '--ink-faint', '--lq-z']) {
        const val = cs.getPropertyValue(v); if (val) ov.style.setProperty(v, val.trim());
      }
      ov.style.fontFamily = cs.fontFamily;
    }
    function layoutOverlay() {
      const r = host.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = window.innerHeight, M = 8;
      const PW = Math.min(Math.max(r.width - 2 * INSET, opts.minPanelWidth || 220), vw - 2 * M);   // slightly inset: reads as a second body
      const px = Math.min(Math.max(r.left + (r.width - PW) / 2, M), vw - M - PW);
      const want = Math.min(contentH + 2 * PAD, Math.round(vh * 0.6));
      const below = vh - r.bottom - GAP - M, above = r.top - GAP - M;
      const dir = below >= Math.min(want, 220) || below >= above ? 1 : -1;
      const PH = Math.max(Math.min(want, dir > 0 ? below : above), Math.min(want, 132));
      const ovL = Math.min(r.left, px), ovR = Math.max(r.right, px + PW);
      const ovT = dir > 0 ? r.top : r.top - GAP - PH;
      Object.assign(Lo, { ovL, ovT, ovW: ovR - ovL, ovH: BH + GAP + PH, bx: r.left - ovL, by: r.top - ovT, bw: r.width, px: px - ovL, PW, PH, dir, rx: r.left, ry: r.top });
      Lo.PT = dir > 0 ? Lo.by + BH + GAP : Lo.by - GAP;                    // panel edge nearest the button
      const ptop = dir > 0 ? Lo.PT : Lo.PT - PH;
      Lo.nx = Math.min(Math.max(Lo.bx + Lo.bw / 2, Lo.px + 30), Lo.px + PW - 30);
      Object.assign(Lo, { sx: Lo.px + 4, sy: ptop + PAD, sw: PW - 8, sh: PH - 2 * PAD });
      Object.assign(ov.style, { left: ovL + 'px', top: ovT + 'px', width: Lo.ovW + 'px', height: Lo.ovH + 'px' });
      Object.assign(face2.style, { left: Lo.bx + 'px', top: Lo.by + 'px', width: Lo.bw + 'px', height: BH + 'px' });
      Object.assign(scroller.style, { left: Lo.sx + 'px', top: Lo.sy + 'px', width: Lo.sw + 'px', height: Lo.sh + 'px' });
      ov.style.setProperty('--dir', dir);
    }
    function reposition() {
      if (!active) return;
      const r = host.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { if (open) setOpen(false); }
      const dx = r.left - Lo.rx, dy = r.top - Lo.ry;
      if (!dx && !dy) return;
      Lo.rx = r.left; Lo.ry = r.top; Lo.ovL += dx; Lo.ovT += dy;
      ov.style.left = Lo.ovL + 'px'; ov.style.top = Lo.ovT + 'px';
    }
    const onScroll = e => { if (e.target !== scroller) reposition(); };
    const onResizeWin = () => { if (open) setOpen(false); };

    const rowY = i => rowTop[i] + 22;   // content coords
    function fades() {
      const t = scroller.scrollTop, max = scroller.scrollHeight - scroller.clientHeight;
      scroller.classList.toggle('ft', t > 1); scroller.classList.toggle('fb', t < max - 1);
    }
    scroller.addEventListener('scroll', () => { fades(); write(); }, { passive: true });

    function write() {
      if (!ready || destroyed) return;
      const sq = press.x > -1.5 ? Math.min(press.x, 1.5) : -1.5;   // bounded press squash (NaN -> -1.5)
      const ovOn = active && os && os.w;
      hs.canvas.style.visibility = ovOn ? 'hidden' : '';
      if (!ovOn) {
        hs.set('uBtn', hs.w / 2, BH / 2, hs.w / 2 + 3 * sq, BH / 2 - 2 * sq);
        hs.draw();
        return;
      }
      const d = Lo.dir, bcy = Lo.by + BH / 2, bcx = Lo.bx + Lo.bw / 2;
      const ny = bcy + (Lo.PT - bcy) * desc.x;                                 // near edge of panel
      const h = Math.max(ph.x, 0), hw = Math.max(pw.x, 0) / 2;
      const openness = Math.min(Math.max(h / Lo.PH, 0), 1);
      const wu = Math.min(Math.max((pw.x - W0) / (Lo.PW - W0), 0), 1);
      const pcx = Lo.nx + (Lo.px + Lo.PW / 2 - Lo.nx) * wu;
      const pcy = ny + d * h / 2;
      const along = d * (ny - bcy);
      os.set('uBtn', bcx, bcy, Lo.bw / 2 + 3 * sq, BH / 2 - 2 * sq)
        .set('uPan', pcx, pcy, hw, h / 2).set('uPr', 18)
        .set('uNeck', Lo.nx, bcy + d * (BH / 2 - 8), bcy + d * Math.max(along + 8, 0), 9)
        .set('uPk', Liquid.state.melt * 1.25 * Math.min(openness * 8, 1));
      const st = scroller.scrollTop;
      os.set('uPill', Lo.sx + 18, Lo.sy + head.x - st, Lo.sy + tail.x - st, Math.max(vis.x, 0))
        .set('uClip', Lo.sx + Lo.sw / 2, Lo.sy + Lo.sh / 2, Lo.sw / 2, Lo.sh / 2 - 4);
      os.draw();
      // clip the list to the panel's current extent while it grows/shrinks
      const pt = pcy - h / 2, pb = pcy + h / 2, pl = pcx - hw, pr = pcx + hw;
      const ct = Math.max(0, pt - Lo.sy), cb = Math.max(0, Lo.sy + Lo.sh - pb), cl = Math.max(0, pl - Lo.sx), cr = Math.max(0, Lo.sx + Lo.sw - pr);
      scroller.style.clipPath = openness >= 0.999 && wu >= 0.999 ? '' : `inset(${ct}px ${cr}px ${cb}px ${cl}px round 12px)`;
    }

    const anim = Liquid.animator(dt => {
      if (destroyed) return false;
      clock += dt;
      if (pending && clock >= pending.at) { vis.target = pending.t; pending = null; }
      if (closeAt >= 0 && clock >= closeAt) { closeAt = -1; setOpen(false); }
      tail.target = head.x;
      const all = [desc, ph, pw, press, head, tail, vis];
      Liquid.stepSprings(all, dt);
      if (Liquid.state.reduce) tail.set(head.x);
      const done = !pending && closeAt < 0 && desc.settled(0.002) && ph.settled() && pw.settled() && press.settled(0.002) &&
        head.settled() && tail.settled() && Math.abs(tail.x - head.x) < 0.25 && vis.settled(0.002);
      if (done) {
        all.forEach(s => s.snap()); tail.set(head.x);
        if (!open && active) { active = false; ov.style.display = 'none'; detachWin(); }
      }
      write();
      return !done;
    });

    function attachWin() { window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onResizeWin); }
    function detachWin() { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onResizeWin); }

    // Close bookkeeping: a failsafe timer completes the close if the animator is starved (busy machine), and
    // Esc / a section change (window event 'f13ui-section') dismiss even when focus is not in the widget.
    let closeTimer = 0;
    function finishClose() {   // snap shut: overlay hidden, springs at rest
      clearTimeout(closeTimer); closeTimer = 0;
      if (open || !active) return;
      [desc, ph, pw, press, head, tail, vis].forEach(s => s.snap()); tail.set(head.x);
      pending = null; closeAt = -1;
      active = false; ov.style.display = 'none'; detachWin(); write();
    }
    const onEsc = e => { if (e.key === 'Escape' && open) setOpen(false); };
    const onSection = () => { if (open || active) { setOpen(false); finishClose(); } };
    document.addEventListener('keydown', onEsc, true);
    window.addEventListener('f13ui-section', onSection);
    function setOpen(v, focusSel) {
      closeAt = -1;
      if (v === open || (v && disabled)) return;
      clearTimeout(closeTimer); closeTimer = 0;
      open = v;
      btn.setAttribute('aria-expanded', v);
      host.classList.toggle('lq-wd-open', v); ov.classList.toggle('lq-wd-open', v);
      if (v) {
        if (!ov.parentNode) document.body.appendChild(ov);
        themeOverlay();
        ov.style.display = 'block';
        layoutOverlay();
        if (!os) { os = new Liquid.Surface(ov, { glsl: ovGlsl, bleed: 32, onResize() { write(); } }); }
        os.setAccent(A);
        if (!active) { attachWin(); desc.set(0); ph.set(0); pw.set(W0); vis.set(0); }
        active = true;
        // put the selection in view (centred), stagger the reveal from the near edge
        const sh = Lo.sh;
        scroller.scrollTop = sel >= 0 ? Math.max(0, rowY(sel) - sh / 2) : 0;
        fades();
        const top = scroller.scrollTop;
        for (const el of [...optEls, ...hdrEls]) {
          const off = el.offsetTop - top, dd = Lo.dir > 0 ? off : sh - off - 44;
          el.style.setProperty('--d', (90 + Math.max(0, Math.min(10, Math.round(dd / 44))) * 22) + 'ms');
        }
        desc.target = 1; ph.target = Lo.PH; pw.target = Lo.PW;
        if (sel >= 0) { head.set(rowY(sel)); tail.set(rowY(sel)); }
        pending = sel >= 0 ? { at: clock + (Liquid.state.reduce ? 0 : 0.12), t: 1 } : null;
        if (!Liquid.state.reduce) press.v += 1.6;
        if (focusSel) (optEls[sel] || optEls[0] || btn).focus({ preventScroll: true });
      } else {
        vis.target = 0; pending = null;
        desc.target = 0; ph.target = 0; pw.target = W0;
        if (!Liquid.state.reduce) press.v -= 1.2;
        if (ov.contains(document.activeElement)) btn.focus({ preventScroll: true });
        closeTimer = setTimeout(finishClose, 480);
      }
      anim.wake();
    }
    function choose(i, user) {
      if (!flat[i] || flat[i].disabled) return;
      const moved = i !== sel;
      const wasHidden = sel < 0;
      sel = i; value = flat[i].value; customLabel = '';
      paintFace();
      if (moved && !wasHidden) head.target = rowY(i);
      else if (moved) { head.set(rowY(i)); tail.set(rowY(i)); vis.target = 1; }
      if (user) { Liquid.haptic(); if (moved && opts.onChange) opts.onChange(value); }
      btn.focus({ preventScroll: true });
      if (moved && !Liquid.state.reduce && open) { closeAt = clock + 0.22; anim.wake(); } else setOpen(false);
    }

    btn.addEventListener('click', e => setOpen(!open, e.detail === 0));
    btn.addEventListener('keydown', e => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { setOpen(true, true); e.preventDefault(); }
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) { (optEls[sel] || optEls[0] || btn).focus({ preventScroll: true }); ensureVisible(Math.max(sel, 0)); e.preventDefault(); }
      else if (e.key === 'Escape' && open) { setOpen(false); e.preventDefault(); }
    });
    function ensureVisible(i) {
      const t = rowTop[i], top = scroller.scrollTop, h = scroller.clientHeight, pad = 26;
      if (t < top + pad) scroller.scrollTop = Math.max(0, t - pad - (i === 0 ? 30 : 0));
      else if (t + 44 > top + h - pad) scroller.scrollTop = t + 44 - h + pad;
    }
    let ta = '', taT = 0;
    scroller.addEventListener('keydown', e => {
      const i = optEls.indexOf(document.activeElement);
      const go = (j, d) => {   // d: search direction past disabled rows
        d = d || Math.sign(j - i) || 1; j = Math.max(0, Math.min(N - 1, j));
        while (j >= 0 && j < N && flat[j].disabled) j += d;
        e.preventDefault();
        if (j < 0 || j >= N) return;
        optEls[j].focus({ preventScroll: true }); ensureVisible(j);
      };
      if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i - 1);
      else if (e.key === 'Home') go(0, 1);
      else if (e.key === 'End') go(N - 1, -1);
      else if (e.key === 'PageDown') go(i + 6);
      else if (e.key === 'PageUp') go(i - 6);
      else if (e.key === 'Enter' || e.key === ' ') { if (i >= 0) choose(i, true); e.preventDefault(); }
      else if (e.key === 'Escape') { setOpen(false); btn.focus({ preventScroll: true }); e.preventDefault(); }
      else if (e.key === 'Tab') { setOpen(false); btn.focus({ preventScroll: true }); }
      else if (e.key.length === 1 && /\S/.test(e.key)) {
        const now = performance.now(); ta = (now - taT < 700 ? ta : '') + e.key.toLowerCase(); taT = now;
        const order = [...flat.keys()].map(k => (k + Math.max(i, 0) + (ta.length === 1 ? 1 : 0)) % N);
        const j = order.find(k => !flat[k].disabled && flat[k].label.toLowerCase().startsWith(ta));
        if (j != null) go(j, 1);
      }
    });
    const outside = e => { if (open && !host.contains(e.target) && !ov.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);

    return {
      get: () => value,
      set(v, { silent = true, instant = false, label } = {}) {
        const i = idx(v);
        const changed = v !== value;
        value = v ?? null;
        if (i >= 0) {
          if (i !== sel) {
            const vis0 = sel >= 0; sel = i; customLabel = '';
            if (open && vis0 && !instant) head.target = rowY(i); else { head.set(rowY(i)); tail.set(rowY(i)); if (open) vis.target = 1; }
          }
        } else {
          sel = -1; customLabel = label != null ? label : (v == null ? (opts.placeholder || '') : String(v));
          vis.target = 0; if (instant) vis.set(0);
        }
        paintFace(); anim.wake();
        if (changed && !silent && opts.onChange) opts.onChange(value);
      },
      // Replace the options after mount: groups as in opts (options may carry `disabled`). An open panel
      // closes at once. `value` (optional) selects; a value missing from the new list keeps the current face label.
      setOptions(gs, { value: next } = {}) {
        gs = gs || []; if (open) setOpen(false);
        const lab = sel >= 0 && flat[sel] ? flat[sel].label : customLabel;
        loadGroups(gs); build(gs);
        if (next !== undefined) value = next ?? null;
        sel = idx(value);
        if (sel >= 0) { customLabel = ''; head.set(rowY(sel)); tail.set(rowY(sel)); } else { customLabel = lab; vis.set(0); vis.target = 0; }
        paintFace(); anim.wake();
      },
      setDisabled(b) { disabled = !!b; btn.disabled = disabled; if (disabled && open) setOpen(false); },
      open() { setOpen(true); }, close(immediate) { setOpen(false); if (immediate) finishClose(); },
      redraw: write,
      destroy() {
        destroyed = true; detachWin(); clearTimeout(closeTimer);
        document.removeEventListener('keydown', onEsc, true); window.removeEventListener('f13ui-section', onSection); document.removeEventListener('pointerdown', outside, true);
        for (const s of [hs, os]) if (s) { s.ro.disconnect(); s.draw = () => {}; }
        ov.remove(); host.innerHTML = ''; host.classList.remove('lq-wd', 'lq-wd-open');
      }
    };
  };

  // ---- demo ----
  Liquid.uiDemo.push({
    id: 'dropdown', title: 'Dropdown',
    note: 'TPMS preset picker: grouped, scrolls inside, opens upward near the bottom.',
    mount(host) {
      const G = [
        { label: 'Cubic symmetry', options: ['Gyroid', 'Schwarz P', 'Schwarz D', 'Neovius', 'Lidinoid', 'I-WP', 'F-RD', 'Fischer-Koch S', 'Split P'] },
        { label: 'Threefold symmetry', options: ['Schwarz H', 'Schwarz CLP', 'Schoen G′', 'Double gyroid'] }]
        .map(g => ({ label: g.label, options: g.options.map(o => ({ value: o.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: o })) }));
      host.innerHTML = `
<div class="d1"></div>
<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">
  <button class="toggle" data-a="custom">Edit terms</button>
  <button class="toggle" data-a="reset">Gyroid</button>
  <button class="toggle" data-a="swap">Swap options</button>
</div>
<p class="out" style="margin-top:10px;font-size:13px;color:var(--ink-faint)">surface: gyroid</p>
<div style="height:120px"></div>
<div class="d2"></div>`;
      const out = host.querySelector('.out');
      const d1 = Liquid.ui.dropdown(host.querySelector('.d1'), { groups: G, value: 'gyroid', prefix: 'Surface: ', ariaLabel: 'Surface', onChange(v) { out.textContent = 'surface: ' + v; } });
      const d2 = Liquid.ui.dropdown(host.querySelector('.d2'), { groups: G, value: 'schwarz-d', ariaLabel: 'Second surface', accent: 'aqua' });
      host.querySelector('[data-a=custom]').addEventListener('click', () => { d1.set('custom', { label: 'custom' }); out.textContent = 'surface: custom'; });
      host.querySelector('[data-a=reset]').addEventListener('click', () => { d1.set('gyroid'); out.textContent = 'surface: gyroid'; });
      let alt = false;
      host.querySelector('[data-a=swap]').addEventListener('click', () => {
        alt = !alt;
        d1.setOptions(alt ? [{ label: 'Reaction-diffusion', options: [{ value: 'gyroid', label: 'Gyroid' }, { value: 'spots', label: 'Spots' }, { value: 'maze', label: 'Maze (desktop only)', disabled: true }] }] : G, { value: 'gyroid' });
        out.textContent = 'surface: gyroid';
      });
      return { redraw() { d1.redraw(); d2.redraw(); }, d1, d2 };
    }
  });
})();

/* ---- widgets/progress.js ---- */
/* Liquid progress button. A glass pill; progress floods it left to right with accent liquid.
   The flood starts as a drop budding at the left cap, grows to full height, then runs as a
   capsule (exact SDF, clipped to the body inset). Busy without a number: a slug of liquid sloshes
   back and forth (edge springs lag, so it stretches and thins). At 1: the pill pops, holds
   ~400 ms, then the liquid drains out through the right cap. */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
(() => {
  'use strict';
  const INK = 'var(--lq-ink, var(--ink, oklch(0.97 0.01 290)))';
  const DIM = 'var(--lq-ink-dim, var(--ink-dim, oklch(0.78 0.02 290)))';
  const CSS = `
.lq-pb{ position:relative; height:44px; overflow-x:clip; user-select:none; -webkit-user-select:none; font-family:var(--lq-font, inherit); }
.lq-pb-btn{ position:absolute; inset:0; margin:0; padding:0 18px; border:0; background:none; border-radius:999px; font:inherit; color:${INK};
  cursor:pointer; outline:none; touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
.lq-pb-btn:focus-visible{ box-shadow:0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .5); }
.lq-pb-lab, .lq-pb-ink{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:8px; padding:0 18px;
  font-size:15px; font-weight:620; letter-spacing:-.01em; white-space:nowrap; pointer-events:none; transition:opacity 160ms ease-out, filter 160ms ease-out; }
.lq-pb-lab > span, .lq-pb-ink > span{ overflow:hidden; text-overflow:ellipsis; }
.lq-pb-ink{ color:oklch(0.24 0.06 var(--ah)); }
.lq-pb .lq-i{ flex:none; width:18px; height:18px; stroke-width:2; }
.lq-pb-lab.swap, .lq-pb-ink.swap{ opacity:0; filter:blur(4px); }
.lq-pb-sr{ position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.lq-pb.busy .lq-pb-btn, .lq-pb.dis .lq-pb-btn{ cursor:default; }
.lq-pb.dis{ opacity:.45; }
.lq-pb.busy .lq-pb-lab{ color:${DIM}; }`;
  function injectCSS() {
    if (document.getElementById('lq-ui-pb-css')) return;
    const s = document.createElement('style'); s.id = 'lq-ui-pb-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  // The host clips overflow-x (a widget must never cause horizontal scroll). So glow and shadow are
  // faded out toward the side edges, except inside a stadium around the control, which stays crisp.
  // cx: cap centre inset from the host edge, cy: centre y, rc: cap radius (all host px).
  function edgeMask(canvas, B, cx, cy, rc) {
    const y0 = B + cy - rc, y1 = B + cy + rc, f = 1.5, s = canvas.style;
    const img = [
      `linear-gradient(90deg, transparent ${B}px, #000 ${B + 20}px, #000 calc(100% - ${B + 20}px), transparent calc(100% - ${B}px))`,
      `linear-gradient(180deg, transparent ${y0 - f}px, #000 ${y0 + f}px, #000 ${y1 - f}px, transparent ${y1 + f}px)`,
      `radial-gradient(circle at ${B + cx}px ${B + cy}px, #000 ${rc - f}px, transparent ${rc + f}px)`,
      `radial-gradient(circle at calc(100% - ${B + cx}px) ${B + cy}px, #000 ${rc - f}px, transparent ${rc + f}px)`].join(',');
    const size = `100% 100%, calc(100% - ${2 * (B + cx)}px) 100%, 100% 100%, 100% 100%`;
    s.webkitMaskImage = s.maskImage = img;
    s.webkitMaskSize = s.maskSize = size;
    s.webkitMaskPosition = s.maskPosition = 'center';
    s.webkitMaskRepeat = s.maskRepeat = 'no-repeat';
  }
  const GLSL = `
#define BULGE 10.0
#define SHADOW_DY 7.0
uniform vec4 uBody;     // centre x, centre y, half width, half height (scaled)
uniform vec3 uFlood;    // back x, front x, visible
uniform float uInset;
float bodySDF(vec2 p){ return sdRoundBox(p - uBody.xy, uBody.zw, uBody.w); }
float accentSDF(vec2 p){ return 1e5; }
#define HAS_FLOOD
float floodSDF(vec2 p){
  if (uFlood.z < 0.5) return 1e5;
  float rr = min(uBody.w - uInset, (uFlood.y - uFlood.x)*0.5);   // a drop until it fills the height, then a capsule
  vec2 A = vec2(uFlood.x + rr, uBody.y), B = vec2(max(uFlood.y - rr, uFlood.x + rr), uBody.y);
  return max(sdCapsule(p, A, B, rr), bodySDF(p) + uInset);
}`;
  const resolveAccent = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || Liquid.ACCENTS.lime;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  Liquid.ui.progressButton = function progressButton(host, opts = {}) {
    injectCSS();
    const o = { label: '', icon: null, accent: Liquid.ACCENTS.lime, onClick: null, onDone: null, ariaLabel: '', ...opts };
    host.classList.add('lq-pb');
    host.style.height = '44px';
    host.innerHTML = `<button type="button" class="lq-pb-btn"><span class="lq-pb-lab"></span><span class="lq-pb-ink" aria-hidden="true"></span><span class="lq-pb-sr" aria-live="polite"></span></button>`;
    const btn = host.firstChild, lab = btn.children[0], inkEl = btn.children[1], sr = btn.children[2];

    const G = { cx: 0, cy: 22, hw: 0, hh: 22, inset: 3.5, xl: 0, xr: 0, w: 0 };
    const back = new Liquid.Spring(0, { k: 240, zeta: 0.9 });
    const front = new Liquid.Spring(0, { k: 240, zeta: 0.85 });
    const scale = new Liquid.Spring(1, { k: 520, zeta: 0.42, fixed: true });
    let mode = 'idle', prog = null, busy = false, disabled = false, pressed = false, hold = 0, phase = 0, ready = false, dead = false;
    let label = o.label;

    const surf = new Liquid.Surface(host, {
      glsl: GLSL, onResize(w) {
        G.w = w; G.cx = w / 2; G.hw = w / 2 - 1; G.xl = 1 + G.inset; G.xr = w - 1 - G.inset;
        ready = true;
        if (mode === 'idle') { back.set(G.xl); front.set(G.xl); }
        write();
      }
    });
    surf.setAccent(resolveAccent(o.accent));
    edgeMask(surf.canvas, surf.bleed, 1 + 22, 22, 23.5);

    function renderLabel() {
      const html = (o.icon ? Liquid.icon(o.icon) : '') + `<span>${esc(label)}</span>`;
      lab.innerHTML = html; inkEl.innerHTML = html;
      if (o.ariaLabel) btn.setAttribute('aria-label', o.ariaLabel);
    }
    function sync() {
      const off = busy || disabled || mode !== 'idle';
      btn.setAttribute('aria-disabled', off);
      btn.setAttribute('aria-busy', busy || mode === 'progress' || mode === 'slosh');
      host.classList.toggle('busy', busy || mode === 'progress' || mode === 'slosh');
      host.classList.toggle('dis', disabled);
    }

    function write() {
      if (!ready || dead) return;
      const s = scale.x > 0.7 ? Math.min(scale.x, 1.3) : 0.7, sy = Liquid.state.reduce ? 1 : 1 + (s - 1) * 0.6;
      const hw = G.hw * s, hh = G.hh * sy;
      let xb = Math.max(back.x, G.xl), xf = Math.min(front.x, G.xr);
      const vis = xf - xb > 0.6 ? 1 : 0;
      xb = G.cx + (xb - G.cx) * s; xf = G.cx + (xf - G.cx) * s;
      surf.set('uBody', G.cx, G.cy, hw, hh).set('uFlood', xb, xf, vis).set('uInset', G.inset * sy);
      surf.draw();
      // dark label copy clipped to the liquid
      if (vis) {
        const rr = Math.min(hh - G.inset * sy, (xf - xb) / 2), t = G.cy - rr, b = 44 - (G.cy + rr);
        inkEl.style.clipPath = `inset(${t.toFixed(2)}px ${(G.w - xf).toFixed(2)}px ${b.toFixed(2)}px ${xb.toFixed(2)}px round ${Math.max(rr, 0).toFixed(2)}px)`;
        lab.style.webkitMaskImage = lab.style.maskImage = `linear-gradient(90deg,#000 ${xb.toFixed(2)}px,transparent ${xb.toFixed(2)}px,transparent ${xf.toFixed(2)}px,#000 ${xf.toFixed(2)}px)`;
      } else { inkEl.style.clipPath = 'inset(50%)'; lab.style.webkitMaskImage = lab.style.maskImage = 'none'; }
    }

    const anim = Liquid.animator(dt => {
      if (dead || !ready) return false;
      const red = Liquid.state.reduce, span = G.xr - G.xl;
      if (mode === 'progress') {
        back.target = G.xl; front.target = G.xl + span * prog;
        back.k = 240; front.k = 240; front.zeta = 0.85;
        if (prog >= 1 && front.x > G.xr - 0.8) { mode = 'full'; busy = false; hold = 0.4; if (!red) scale.v += 1.5; Liquid.haptic(); sync(); }
      } else if (mode === 'full') {
        back.target = G.xl; front.target = G.xr;
        hold -= dt;
        if (hold <= 0) { mode = 'drain'; sync(); }
      } else if (mode === 'slosh') {
        phase += dt;
        const wid = Math.min(Math.max(span * 0.28, 2 * G.hh), span), c = G.xl + wid / 2 + (span - wid) * (0.5 - 0.5 * Math.cos(phase * 2.4));
        const dirR = Math.sin(phase * 2.4) >= 0;   // leading edge stiff, trailing edge lags: stretch and thin
        front.k = dirR ? 420 : 150; back.k = dirR ? 150 : 420; front.zeta = back.zeta = 0.9;
        front.target = c + wid / 2; back.target = c - wid / 2;
      }
      if (mode === 'drain') {
        back.k = 200; back.zeta = 0.95; front.target = G.xr; back.target = G.xr + 1;
        if (back.x >= G.xr - 0.5) { mode = 'idle'; prog = null; back.set(G.xl); front.set(G.xl); sync(); updateSr(); o.onDone && o.onDone(); }
      } else if (mode === 'idle') { back.target = G.xl; front.target = G.xl; }
      scale.target = pressed ? 0.965 : 1;
      Liquid.stepSprings([back, front, scale], dt);
      if (red) { back.snap(); front.snap(); }
      const done = mode === 'idle' && !pressed && scale.settled(0.002) && back.settled() && front.settled();
      if (done) { scale.snap(); back.set(G.xl); front.set(G.xl); }
      write();
      return !done;
    });

    function updateSr() { sr.textContent = prog == null ? '' : Math.round(prog * 100) + '%'; }

    btn.addEventListener('pointerdown', e => { if (busy || disabled || mode !== 'idle' || (e.pointerType === 'mouse' && e.button !== 0)) return; pressed = true; anim.wake(); });
    const unpress = () => { if (!pressed) return; pressed = false; scale.v += 0.6; anim.wake(); };
    btn.addEventListener('pointerup', unpress); btn.addEventListener('pointercancel', unpress); btn.addEventListener('pointerleave', unpress);
    btn.addEventListener('click', () => {
      if (busy || disabled || mode !== 'idle') return;
      if (!pressed && !Liquid.state.reduce) { scale.v -= 0.8; anim.wake(); }   // keyboard press: a small dip
      Liquid.haptic();
      o.onClick && o.onClick();
    });

    renderLabel(); sync();

    const api = {
      get: () => prog,
      set(p, opts2) { return api.setProgress(p, opts2); },
      setProgress(p) {
        if (p == null) {
          prog = null; updateSr();
          if (mode === 'progress' || mode === 'full') mode = busy ? 'slosh' : 'drain';
        } else {
          p = Math.min(Math.max(+p || 0, 0), 1);
          if (mode === 'drain' || mode === 'full') return api;   // finishing: ignore late updates
          if (mode === 'idle' || mode === 'slosh') { if (mode === 'idle') { back.set(G.xl); front.set(G.xl); } mode = 'progress'; }
          prog = p; updateSr();
        }
        sync(); anim.wake(); return api;
      },
      setLabel(s) {
        if (s === label) return api;
        label = s;
        if (Liquid.state.reduce || !ready) { renderLabel(); return api; }
        lab.classList.add('swap'); inkEl.classList.add('swap');   // blur-fade out, swap, blur in
        clearTimeout(api._t); api._t = setTimeout(() => { renderLabel(); lab.classList.remove('swap'); inkEl.classList.remove('swap'); }, 150);
        return api;
      },
      setBusy(b) {
        busy = !!b;
        if (busy && mode === 'idle') { mode = 'slosh'; phase = 0; back.set(G.xl); front.set(G.xl); }
        else if (!busy && mode === 'slosh') mode = 'drain';
        sync(); anim.wake(); return api;
      },
      setDisabled(b) { disabled = !!b; sync(); return api; },
      redraw() { write(); return api; },
      focus() { btn.focus(); return api; },
      destroy() {
        dead = true; clearTimeout(api._t); surf.ro.disconnect(); surf.w = 0; surf.canvas.remove();
        host.innerHTML = ''; host.classList.remove('lq-pb', 'busy', 'dis'); host.style.height = '';
      }
    };
    return api;
  };

  // ---------- demo ----------
  Liquid.uiDemo.push({
    id: 'progress', title: 'Progress button',
    note: 'Progress floods the pill; at 100% it pops, then drains out the far end.',
    mount(host) {
      host.style.display = 'grid'; host.style.rowGap = '14px'; host.style.padding = '4px 0';
      const a = document.createElement('div'), b = document.createElement('div');
      host.append(a, b);
      const run = Liquid.ui.progressButton(a, {
        label: 'Run homogenization', accent: 'aqua',
        onClick() {
          run.setLabel('Homogenizing'); run.setProgress(0);
          const t0 = performance.now(), T = 2000;
          const tick = () => {
            const u = Math.min((performance.now() - t0) / T, 1);
            const p = Math.min(1, Math.floor((u * u * (3 - 2 * u)) * 20) / 20 + (u >= 1 ? 1 : 0));   // stepped, like real solver reports
            run.setProgress(p);
            if (u < 1) setTimeout(tick, 90); else run.setLabel('Done');
          };
          setTimeout(tick, 90);
        },
        onDone() { run.setLabel('Run homogenization'); }
      });
      const exp = Liquid.ui.progressButton(b, {
        label: 'Export STL', icon: 'folder', accent: 'violet',
        onClick() { exp.setBusy(true); exp.setLabel('Exporting'); setTimeout(() => { exp.setBusy(false); exp.setLabel('Export STL'); }, 1800); }
      });
      return { redraw() { run.redraw(); exp.redraw(); } };
    }
  });
})();

/* ---- widgets/radio.js ---- */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
/* Droplet radio widget.
   Glass track with hairline socket grooves; the selected dot is an accent droplet. Changing value, the
   head races to the new socket while the tail lags; an exact tapered neck joins them, thins, pinches,
   and re-merges. The track parts around the drop (a moat), so a channel opens between sockets while it
   pours. allowNone: tapping the active option drains the drop (a growing offset, so the field stays
   continuous); choosing from none wells a drop up in place. Per-option accents interpolate in transit. */
(() => {
  const acc = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || Liquid.ACCENTS.lime;
  const css = `
.lq-wr{ position:relative; touch-action:manipulation; }
.lq-wr[aria-disabled=true]{ opacity:.45; pointer-events:none; }
.lq-wr-opt{ position:absolute; display:block; background:none; border:0; padding:0; margin:0; font:inherit; cursor:pointer;
  color:var(--lq-ink-dim, var(--ink-dim, oklch(0.78 0.02 290))); border-radius:12px; -webkit-tap-highlight-color:transparent; }
.lq-wr-opt:focus-visible{ outline:none; box-shadow: inset 0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .5); }
.lq-wr-lab{ position:absolute; top:50%; white-space:nowrap; font-family:var(--lq-font, inherit); font-weight:650; letter-spacing:-.01em;
  pointer-events:none; transition: color 140ms ease-out; }
.lq-wr-lab.in{ transform:translate(-50%,-50%); }
.lq-wr-lab.side{ transform:translateY(-50%); }
.lq-wr-opt.lit .lq-wr-lab.in{ color:oklch(0.24 0.06 var(--oh, 120)); }
.lq-wr-opt.lit .lq-wr-lab.side, .lq-wr-opt[aria-checked=true] .lq-wr-lab.side{ color:var(--lq-ink, var(--ink, oklch(0.97 0.01 290))); }
.lq-wr-opt:not(.lit):hover .lq-wr-lab{ color:var(--lq-ink, var(--ink, oklch(0.97 0.01 290))); }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  if (!document.getElementById('lq-i-base')) {   // icon base style (zero specificity) so widgets work outside the demo page
    const b = document.createElement('style'); b.id = 'lq-i-base';
    b.textContent = ':where(.lq-i){fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block;width:100%;height:100%}';
    document.head.prepend(b);
  }

  Liquid.ui.radio = function (host, opts = {}) {
    const O = (opts.options || []).map(o => (typeof o === 'object' ? o : { value: o, label: String(o) }));
    const N = O.length;
    const horiz = opts.orientation !== 'vertical';
    const md = opts.size === 'md';
    const allowNone = opts.allowNone !== false;
    const base = acc(opts.accent);
    const accOf = i => (O[i] && O[i].accent ? acc(O[i].accent) : base);
    const inside = opts.labels ? opts.labels === 'inside' : O.every(o => String(o.label).length <= 2);
    const G = md ? { RR: 14.5, TH: 0.7, gap: 2, trackH: 44, slot: 48, fs: 15 } : { RR: 12, TH: 0.7, gap: 2, trackH: 36, slot: 44, fs: 13 };
    G.R0 = G.RR - G.gap - G.TH;
    const idx = v => (v == null ? -1 : O.findIndex(o => o.value === v));
    let sel = idx(opts.value), disabled = false, ready = false;

    host.classList.add('lq-wr');
    host.setAttribute('role', 'radiogroup');
    if (opts.ariaLabel) host.setAttribute('aria-label', opts.ariaLabel);
    if (!horiz) host.setAttribute('aria-orientation', 'vertical');

    const els = O.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lq-wr-opt'; b.setAttribute('role', 'radio');
      b.innerHTML = `<span class="lq-wr-lab ${inside ? 'in' : 'side'}" style="font-size:${G.fs}px"></span>`;
      b.firstChild.textContent = o.label;
      if (o.ariaLabel) b.setAttribute('aria-label', o.ariaLabel);
      b.style.setProperty('--oh', accOf(i).h.toFixed(1));
      b.addEventListener('click', () => pick(i, true));
      host.appendChild(b); return b;
    });

    // ---- layout (intrinsic both ways: the widget sizes its host) ----
    const L = { cs: [], track: [0, 0, 0, 0], W: 0, H: 0 };
    function layout() {
      const pad = G.trackH / 2 - G.RR;                 // ring concentric with the track's end cap
      const lw = els.map(b => b.firstChild.offsetWidth);
      if (horiz) {
        let x = 0; L.H = Math.max(44, G.trackH);
        const cy = L.H / 2;
        L.cs = O.map((_, i) => {
          let cx, w;
          if (inside) { w = G.slot; cx = x + w / 2; }
          else { cx = x + pad + G.RR; w = pad + 2 * G.RR + 8 + lw[i] + 14; }
          Object.assign(els[i].style, { left: x + 'px', top: 0, width: w + 'px', height: L.H + 'px' });
          const lab = els[i].firstChild;
          lab.style.left = inside ? (cx - x) + 'px' : (cx - x + G.RR + 8) + 'px';
          x += w; return [cx, cy];
        });
        L.W = x; L.track = [L.W / 2, cy, L.W / 2, G.trackH / 2];
      } else {
        const rowH = G.slot;
        L.W = inside ? G.trackH : pad + 2 * G.RR + 8 + Math.max(...lw) + 16;
        L.H = rowH * N;
        const cx = G.trackH / 2;
        L.cs = O.map((_, i) => {
          Object.assign(els[i].style, { left: 0, top: (rowH * i) + 'px', width: L.W + 'px', height: rowH + 'px' });
          els[i].firstChild.style.left = inside ? cx + 'px' : (cx + G.RR + 8) + 'px';
          return [cx, rowH * (i + 0.5)];
        });
        L.track = [L.W / 2, L.H / 2, L.W / 2, L.H / 2 - (rowH - G.trackH) / 2];
      }
      host.style.width = L.W + 'px'; host.style.height = L.H + 'px';
    }
    layout();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout(); if (ready) write(); });

    const ax = horiz ? 0 : 1;                           // travel axis
    const posOf = i => L.cs[Math.max(i, 0)][ax];
    const glsl = `
uniform vec2 uC[${N}];
uniform vec4 uTrack; uniform float uTr, uRR, uTh, uGap;
uniform vec2 uH, uT, uSq;
uniform vec4 uRad;                  // head r, tail r, neck shrink, drain offset
float accentSDF(vec2 p){
  float head = (length((p - uH)/uSq) - uRad.x) * min(uSq.x, uSq.y);
  float tail = length(p - uT) - uRad.y;
  float neck = sdTaper(p, uH, uT, uRad.x*0.62, uRad.y*0.62) + uRad.z;
  return smin(smin(head, tail, 8.0), neck, 5.0) + uRad.w;
}
float bodySDF(vec2 p){
  float d = sdRoundBox(p - uTrack.xy, uTrack.zw, uTr);
  float g = 1e5;
  for (int i = 0; i < ${N}; i++) g = min(g, abs(length(p - uC[i]) - uRR) - uTh);
  d = ssub(d, g, 1.2);
  return ssub(d, accentSDF(p) - uGap, min(uK, 6.0));
}
#define BULGE 8.0
#define SHADOW_DY 5.0`;

    const head = new Liquid.Spring(0, { k: 440, zeta: 0.7 });
    const tail = new Liquid.Spring(0, { k: 200, zeta: 0.92 });
    const sq = new Liquid.Spring(0, { k: 650, zeta: 0.4, fixed: true });
    const fill = new Liquid.Spring(sel >= 0 ? 1 : 0, { k: 300, zeta: 0.85 });

    const surf = new Liquid.Surface(host, {
      glsl, onResize() {
        if (!ready) { const p = posOf(sel); head.set(p); tail.set(p); }
        ready = true; write();
      }
    });
    surf.setAccent(accOf(Math.max(sel, 0)));
    let lit = -2;

    const clampN = (x, a, b) => (x > a ? (x < b ? x : b) : a);   // NaN -> a
    function write() {
      if (!ready) return;
      const sc = G.R0 / 7.6;                              // tuned at R0 7.6: scale distances with size
      const sep = Math.abs(head.x - tail.x) / sc, s = Math.min(sep / 70, 1);
      const reduce = Liquid.state.reduce;
      const rh = G.R0 * (1 - 0.14 * s), rt = G.R0 * (0.82 - 0.22 * s);
      const pinch = Math.max(0, sep - 30) * 0.26 * sc;
      const stt = reduce ? 0 : clampN(Math.min(Math.abs(head.v) / (2400 * sc), 0.28) + sq.x, -0.3, 0.6);   // 1 + stt stays > 0
      const k = 1 + stt, sqv = horiz ? [k, 1 / k] : [1 / k, k];
      const cross = L.cs[0][1 - ax];
      const P = v => (horiz ? [v, cross] : [cross, v]);
      const off = (1 - Math.min(Math.max(fill.x, 0), 1.2)) * (G.R0 + 14);
      L.cs.forEach((c, i) => surf.set(`uC[${i}]`, c[0], c[1]));
      surf.set('uTrack', ...L.track).set('uTr', G.trackH / 2).set('uRR', G.RR).set('uTh', G.TH).set('uGap', G.gap)
        .set('uH', ...P(head.x)).set('uT', ...P(tail.x)).set('uSq', ...sqv).set('uRad', rh, rt, pinch, off);
      // accent follows the drop between neighbouring options
      let i0 = 0;
      while (i0 < N - 2 && head.x > posOf(i0 + 1)) i0++;
      const a = posOf(i0), b = posOf(Math.min(i0 + 1, N - 1));
      const f = b === a ? 0 : Math.min(Math.max((head.x - a) / (b - a), 0), 1);
      surf.setAccent(Liquid.mixAccent(accOf(i0), accOf(Math.min(i0 + 1, N - 1)), f));
      surf.setAccentOpacity(Math.min(Math.max(fill.x * 2.5, 0), 1));   // no glow left behind once drained
      surf.draw();
      // label under the drop flips to dark ink once the drop has arrived
      let L2 = -1;
      if (fill.x > 0.55) for (let i = 0; i < N; i++) if (Math.abs(head.x - posOf(i)) < G.R0 * 0.8) L2 = i;
      if (L2 !== lit) { lit = L2; els.forEach((el, j) => el.classList.toggle('lit', j === L2)); }
    }

    const anim = Liquid.animator(dt => {
      if (!ready) return false;
      if (sel >= 0) { head.target = tail.target = posOf(sel); }
      sq.target = 0;
      Liquid.stepSprings([head, tail, sq, fill], dt);
      if (Liquid.state.reduce) { tail.set(head.x); sq.set(0); }
      const done = head.settled() && tail.settled() && sq.settled(0.002) && fill.settled(0.003);
      if (done) { head.snap(); tail.snap(); sq.snap(); fill.snap(); }
      write();
      return !done;
    });

    function mark() {
      els.forEach((el, j) => { el.setAttribute('aria-checked', j === sel); el.tabIndex = j === (sel >= 0 ? sel : 0) ? 0 : -1; });
    }
    // move the state to index i (or -1). anim=false snaps.
    function go(i, animate) {
      if (i === sel) return false;
      const from = sel; sel = i; mark();
      if (i < 0) { fill.target = 0; if (!Liquid.state.reduce) sq.v += 0.8; }
      else if (from < 0 || fill.x < 0.35) {
        // well up in place
        const p = posOf(i); head.set(p); tail.set(p); fill.target = 1; if (!Liquid.state.reduce) sq.v -= 0.6;
      } else { fill.target = 1; if (!Liquid.state.reduce) sq.v -= 1.2; }   // anticipation squat, then pour
      if (!animate) { const p = posOf(Math.max(i, 0)); if (i >= 0) { head.set(p); tail.set(p); } sq.set(0); fill.set(i >= 0 ? 1 : 0); write(); }
      else anim.wake();
      return true;
    }
    function pick(i, toggle) {
      if (disabled) return;
      const nxt = toggle && i === sel && allowNone ? -1 : i;
      if (go(nxt, true)) { Liquid.haptic(); opts.onChange && opts.onChange(nxt < 0 ? null : O[nxt].value); }
    }
    mark();

    host.addEventListener('keydown', e => {
      const fwd = horiz ? ['ArrowRight', 'ArrowDown'] : ['ArrowDown', 'ArrowRight'];
      const back = horiz ? ['ArrowLeft', 'ArrowUp'] : ['ArrowUp', 'ArrowLeft'];
      const cur = els.indexOf(document.activeElement);
      let n = null;
      if (fwd.includes(e.key)) n = ((cur < 0 ? sel : cur) + 1 + N) % N;
      else if (back.includes(e.key)) n = ((cur < 0 ? Math.max(sel, 0) : cur) - 1 + N) % N;
      else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = N - 1;
      if (n === null) return;
      e.preventDefault(); els[n].focus(); pick(n, false);
    });

    return {
      get: () => (sel < 0 ? null : O[sel].value),
      set(v, { silent = true, instant = false } = {}) {
        const i = idx(v);
        if (go(i, !instant && ready) && !silent && opts.onChange) opts.onChange(i < 0 ? null : O[i].value);
      },
      setDisabled(b) {
        disabled = !!b; host.setAttribute('aria-disabled', disabled);
        els.forEach(el => { el.disabled = disabled; });
      },
      redraw: write,
      destroy() { surf.ro.disconnect(); surf.draw = () => {}; host.innerHTML = ''; host.classList.remove('lq-wr'); host.removeAttribute('role'); }
    };
  };

  // ---- demo ----
  Liquid.uiDemo.push({
    id: 'radio', title: 'Radio',
    note: 'Clip plane over a viewer: tap the active axis to release it.',
    mount(host) {
      host.innerHTML = `
<div class="lq-wrd-view" style="position:relative;height:180px;border-radius:16px;overflow:hidden;
  background:radial-gradient(90% 80% at 60% 55%, oklch(0.32 0.03 250), oklch(0.13 0.015 260) 75%);box-shadow:inset 0 0 0 1px oklch(1 0 0 / .08)">
  <div style="position:absolute;left:50%;top:56%;width:96px;height:96px;margin:-48px 0 0 -48px;border-radius:24px;transform:rotate(45deg) skew(-8deg,-8deg);
    background:linear-gradient(135deg, oklch(0.55 0.04 250), oklch(0.28 0.03 255));opacity:.75"></div>
  <div style="position:absolute;left:12px;top:12px;display:flex;align-items:center;gap:10px">
    <span style="font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint)">Clip</span>
    <div class="r1"></div>
  </div>
  <div class="out" style="position:absolute;right:14px;bottom:12px;font:13px var(--lq-mono, ui-monospace, monospace);color:var(--ink-dim)">clip: x</div>
</div>
<div style="display:flex;gap:18px;align-items:flex-start;margin-top:16px">
  <div class="r2"></div>
  <div class="r3" style="margin-top:2px"></div>
</div>`;
      const out = host.querySelector('.out');
      const r1 = Liquid.ui.radio(host.querySelector('.r1'), {
        options: [{ value: 'x', label: 'X', accent: 'axisX' }, { value: 'y', label: 'Y', accent: 'axisY' }, { value: 'z', label: 'Z', accent: 'axisZ' }],
        value: 'x', allowNone: true, size: 'sm', ariaLabel: 'Clip plane',
        onChange(v) { out.textContent = 'clip: ' + (v || 'off'); }
      });
      const r2 = Liquid.ui.radio(host.querySelector('.r2'), {
        options: [{ value: 'lo', label: 'Draft' }, { value: 'mid', label: 'Normal' }, { value: 'hi', label: 'Fine' }],
        value: 'mid', allowNone: false, orientation: 'vertical', size: 'md', accent: 'violet', ariaLabel: 'Resolution'
      });
      const r3 = Liquid.ui.radio(host.querySelector('.r3'), {
        options: [{ value: 'mm', label: 'mm' }, { value: 'in', label: 'in' }],
        value: 'mm', allowNone: false, size: 'sm', accent: 'amber', labels: 'beside', ariaLabel: 'Units'
      });
      return { redraw() { r1.redraw(); r2.redraw(); r3.redraw(); }, r1, r2, r3 };
    }
  });
})();

/* ---- widgets/sections.js ---- */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
/* Section switcher widget.
   horizontal: meniscus tab bar. The bead rides the bar's top edge in a filleted dip (smooth subtraction of
   an exact tapered capsule); the dip's tail lags the head, so it stretches into a trough and pinches back.
   vertical: the same bar on its side (rail), bead on the right edge.
   Badges live on a second surface with their own accent: a bead buds out of a source circle near the item
   (the source drains, so the neck thins and pinches) and is reabsorbed on clear. A badge rides onto the
   main bead when its item is selected, so it is never hidden under the bead. */
(() => {
  const acc = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || Liquid.ACCENTS.lime;
  const I = Liquid.ICONS;
  I.surface = I.surface || '<path d="M3.5 9.5c2.8-3 5.7 3 8.5 0s5.7-3 8.5 0"/><path d="M3.5 15c2.8-3 5.7 3 8.5 0s5.7-3 8.5 0"/>';
  I.volume = I.volume || '<path d="M12 3.8 19.2 7.8v8.4L12 20.2 4.8 16.2V7.8z"/><path d="M4.8 7.8 12 11.8l7.2-4M12 11.8v8.4"/>';
  I.cell = I.cell || '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><path d="M12 4.5v15M4.5 12h15"/>';
  I.analyze = I.analyze || '<path d="M4.5 19.5h15"/><path d="M7.5 16v-4M12 16V7.5M16.5 16v-6"/>';

  const INK = 'var(--lq-ink, var(--ink, oklch(0.97 0.01 290)))', DIM = 'var(--lq-ink-dim, var(--ink-dim, oklch(0.78 0.02 290)))';
  const css = `
.lq-ws{ position:relative; font-family:var(--lq-font, inherit); }
.lq-ws[aria-disabled=true]{ opacity:.45; pointer-events:none; }
.lq-ws-tab{ position:absolute; background:none; border:0; padding:0; margin:0; color:${DIM}; pointer-events:none; border-radius:16px; font:inherit; }
.lq-ws-tab:focus-visible{ outline:none; box-shadow: inset 0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .5); }
.lq-ws-ic{ position:absolute; width:22px; height:22px; margin:-11px 0 0 -11px;
  transition: opacity 160ms ease-out, filter 160ms ease-out, transform 160ms ease-out, color 160ms ease-out; }
.lq-ws-lab{ position:absolute; left:50%; transform:translate(-50%,-50%); font-size:11px; font-weight:650; letter-spacing:.01em; white-space:nowrap;
  transition: color 160ms ease-out; }
.lq-ws-tab.dis .lq-ws-ic, .lq-ws-tab.dis .lq-ws-lab{ opacity:.5; }   /* disabled item: dimmed, still opens */
.lq-ws-tab.near .lq-ws-ic{ color:${INK}; }
.lq-ws-tab.lifted .lq-ws-lab{ color:oklch(var(--al) var(--ac) var(--ah)); }
.lq-ws.h .lq-ws-tab.lifted .lq-ws-ic{ opacity:0; filter:blur(4px); transform:translateY(-12px) scale(.7); }
.lq-ws.v .lq-ws-tab.lifted .lq-ws-ic{ opacity:0; filter:blur(4px); transform:translateX(10px) scale(.7); }
.lq-ws-bead{ position:absolute; left:0; top:0; width:22px; height:22px; margin:-11px 0 0 -11px; pointer-events:none; color:oklch(0.25 0.06 var(--ah)); }
.lq-ws.v .lq-ws-bead{ width:18px; height:18px; margin:-9px 0 0 -9px; }
.lq-ws-bead span{ position:absolute; inset:0; opacity:0; filter:blur(5px); transform:scale(.6);
  transition: opacity 150ms ease-out, filter 150ms ease-out, transform 150ms cubic-bezier(.3,1.6,.5,1); }
.lq-ws-bead span.on{ opacity:1; filter:none; transform:scale(1); }
.lq-ws-bead .lq-i{ stroke-width:2.1; }
.lq-ws-stage{ position:absolute; inset:0; pointer-events:none; }
.lq-ws-cnt{ position:absolute; left:0; top:0; width:28px; height:16px; margin:-8px 0 0 -14px; pointer-events:none; }
.lq-ws-cnt span{ position:absolute; inset:0; display:grid; place-items:center; font-size:11px; font-weight:750; letter-spacing:-.02em;
  font-family:var(--lq-font, inherit); font-variant-numeric:tabular-nums; color:oklch(0.24 0.07 var(--bh));
  transition: opacity 150ms ease-out, filter 150ms ease-out, transform 150ms ease-out; }
.lq-ws-cnt span.pre{ opacity:0; filter:blur(4px); transform:translateY(4px) scale(.8); }
.lq-ws-cnt span.out{ opacity:0; filter:blur(4px); transform:translateY(-4px) scale(.8); }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  if (!document.getElementById('lq-i-base')) {   // icon base style (zero specificity) so widgets work outside the demo page
    const b = document.createElement('style'); b.id = 'lq-i-base';
    b.textContent = ':where(.lq-i){fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block;width:100%;height:100%}';
    document.head.prepend(b);
  }

  Liquid.ui.sections = function (host, opts = {}) {
    const T = opts.items || [];
    const N = T.length;
    const horiz = opts.orientation !== 'vertical';
    const base = acc(opts.accent);
    const accOf = i => (T[i] && T[i].accent ? acc(T[i].accent) : base);
    let badgeAcc = acc(opts.badgeAccent || 'coral');
    if (!opts.badgeAccent && Math.abs(base.h - badgeAcc.h) < 30) badgeAcc = Liquid.ACCENTS.amber;
    const idx = id => T.findIndex(t => t.id === id);
    let target = Math.max(0, idx(opts.value)), disabled = false, ready = false;
    const dis = T.map(t => !!t.disabled);   // per-item disabled: dimmed (tab and bead), aria-disabled, but still selectable

    const G = horiz
      ? { M: 2, R: 22, gap: 5, barT: 24, barH: 58, corner: 22, iconOff: 21, labOff: 43, H: 84 }
      : { bw: 44, R: 14, gap: 4, slot: 52, pad: 6, corner: 18, iconX: 20, W: 58 };
    G.cs = []; G.slotW = 0;
    host.classList.add('lq-ws', horiz ? 'h' : 'v');
    if (horiz) host.style.height = G.H + 'px';
    else { host.style.width = G.W + 'px'; host.style.height = (N * G.slot + 2 * G.pad) + 'px'; }

    const list = document.createElement('div');
    list.setAttribute('role', 'tablist'); list.setAttribute('aria-orientation', horiz ? 'horizontal' : 'vertical');
    if (opts.ariaLabel) list.setAttribute('aria-label', opts.ariaLabel);
    host.appendChild(list);
    const els = T.map((t, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lq-ws-tab'; b.setAttribute('role', 'tab'); b.id = t.tabId || '';
      if (t.controls) b.setAttribute('aria-controls', t.controls);
      b.innerHTML = Liquid.icon(t.icon, 'lq-ws-ic') + (horiz ? `<span class="lq-ws-lab"></span>` : '');
      if (horiz) b.querySelector('.lq-ws-lab').textContent = t.label; else b.title = t.label;
      b.addEventListener('click', e => { if (e.detail === 0) select(i, true, true); });   // keyboard; pointer handled on host
      list.appendChild(b); return b;
    });
    const bead = document.createElement('div'); bead.className = 'lq-ws-bead';
    bead.innerHTML = T.map(t => `<span>${Liquid.icon(t.icon)}</span>`).join('');
    host.appendChild(bead);
    const beadLayers = [...bead.children];

    // ---- main bar ----
    const glsl = `
uniform vec4 uBar; uniform float uCorner, uRn, uR;
uniform vec2 uHead, uTail, uSquash; uniform float uScale;
float bodySDF(vec2 p){
  float box = sdRoundBox(p - (uBar.xy + uBar.zw*.5), uBar.zw*.5, uCorner);
  return ssub(box, sdTaper(p, uHead, uTail, uRn, uRn*0.9), uK);
}
float accentSDF(vec2 p){
  vec2 s = uSquash * uScale;
  return (length((p - uHead)/s) - uR) * min(s.x, s.y);
}`;
    const head = new Liquid.Spring(0, { k: 520, zeta: 0.62 });
    const tail = new Liquid.Spring(0, { k: 170, zeta: 0.9 });
    const scale = new Liquid.Spring(1, { k: 700, zeta: 0.38, fixed: true });
    let dragging = false, dragP = 0, lifted = -1, near = -1;

    const surf = new Liquid.Surface(host, {
      glsl, onResize(w, h) {
        if (horiz) {
          G.barW = w - 2 * G.M;
          const pad = Math.max(G.barW * 0.06, 12);
          G.slotW = (G.barW - 2 * pad) / N;
          G.cs = T.map((_, i) => G.M + pad + G.slotW * (i + 0.5));
          const hw = Math.max(G.slotW, 44);
          els.forEach((el, i) => {
            Object.assign(el.style, { left: (G.cs[i] - hw / 2) + 'px', width: hw + 'px', top: G.barT + 'px', height: G.barH + 'px' });
            Object.assign(el.firstChild.style, { left: (hw / 2) + 'px', top: G.iconOff + 'px' });
            el.lastChild.style.top = G.labOff + 'px';
          });
        } else {
          G.bh = h; G.slotW = G.slot;
          G.cs = T.map((_, i) => G.pad + G.slot * (i + 0.5));
          els.forEach((el, i) => {
            Object.assign(el.style, { left: 0, width: G.W + 'px', top: (G.cs[i] - G.slot / 2) + 'px', height: G.slot + 'px' });
            Object.assign(el.firstChild.style, { left: G.iconX + 'px', top: (G.slot / 2) + 'px' });
          });
        }
        if (!ready || !dragging) { head.set(G.cs[target]); tail.set(G.cs[target]); }
        ready = true;
        write();
      }
    });

    // ---- badges: own surface + accent ----
    const stage = document.createElement('div'); stage.className = 'lq-ws-stage';
    host.appendChild(stage);
    const bglsl = `
#define BULGE 6.0
#define SHADOW_DY 3.0
uniform vec4 uB[${N}];   // x, y, r, half length
uniform vec3 uS[${N}];   // source x, y, r
uniform vec3 uBA[${N}], uBD[${N}];   // per-badge accent (lit, deep)
float beadSD(vec2 p, vec4 B){ if (B.z < 0.05) return 1e5; vec2 q = p - B.xy; return sdSegment(q, vec2(-B.w, 0.), vec2(B.w, 0.)) - B.z; }
float budSD(vec2 p, vec4 B, vec3 S){
  float s = S.z < 0.05 ? 1e5 : sdCircle(p - S.xy, S.z);
  return smin(beadSD(p, B), s, 7. * clamp(min(S.z, B.z)/3., 0., 1.));
}
float bodySDF(vec2 p){ return 1e5; }
float accentSDF(vec2 p){
  float d = 1e5;
  for (int i = 0; i < ${N}; i++) d = min(d, budSD(p, uB[i], uS[i]));
  return d;
}
#define HAS_ACCENT_AT
void accentAt(vec2 p, inout vec3 A, inout vec3 AD){   // each pixel takes the colour of the nearest badge
  float best = 1e9;
  for (int i = 0; i < ${N}; i++) { float d = budSD(p, uB[i], uS[i]); if (d < best) { best = d; A = uBA[i]; AD = uBD[i]; } }
}`;
    const BR = 8, DOT = 4.5;
    const B = T.map(() => ({
      val: null, shown: '',
      m: new Liquid.Spring(0, { k: 240, zeta: 0.6 }),
      r: new Liquid.Spring(0, { k: 380, zeta: 0.62 }),
      s: new Liquid.Spring(0, { k: 260, zeta: 0.9, fixed: true }),
      L: new Liquid.Spring(0, { k: 420, zeta: 0.8 }),
      cnt: null, well: false, acc: null, col: null
    }));
    function badgeColour(b, a) {
      b.acc = a; b.col = Liquid.accentColors(a);
      if (b.cnt) b.cnt.style.setProperty('--bh', a.h.toFixed(1));
    }
    B.forEach(b => { b.cnt = document.createElement('div'); b.cnt.className = 'lq-ws-cnt'; b.cnt.setAttribute('aria-hidden', 'true'); host.appendChild(b.cnt); badgeColour(b, badgeAcc); });
    const bsurf = new Liquid.Surface(stage, { glsl: bglsl, onResize() { write(); } });
    bsurf.setAccent(badgeAcc);
    host.style.setProperty('--bh', badgeAcc.h.toFixed(1));

    function nearest(v) { let bi = 0; G.cs.forEach((c, i) => { if (Math.abs(c - v) < Math.abs(G.cs[bi] - v)) bi = i; }); return bi; }
    function rubber(v) { const lo = G.cs[0], hi = G.cs[N - 1]; if (v < lo) return lo - (lo - v) * 0.3 / (1 + (lo - v) / 120); if (v > hi) return hi + (v - hi) * 0.3 / (1 + (v - hi) / 120); return v; }

    function write() {
      if (!ready) return;
      const sp = Math.abs(head.v), stv = Liquid.state.reduce ? 0 : Math.min(sp / 2600, 0.22);
      const dip = Liquid.state.reduce ? 0 : Math.min(sp * 0.003, horiz ? 6 : 4);
      let bx, by;
      if (horiz) {
        bx = head.x; by = G.barT + dip;
        surf.set('uBar', G.M, G.barT, G.barW, G.barH).set('uHead', bx, by).set('uTail', tail.x, G.barT + dip * 0.5).set('uSquash', 1 + stv, 1 / (1 + stv));
      } else {
        bx = G.bw - dip; by = head.x;
        surf.set('uBar', 0, 0, G.bw, G.bh).set('uHead', bx, by).set('uTail', G.bw - dip * 0.5, tail.x).set('uSquash', 1 / (1 + stv), 1 + stv);
      }
      const sc = scale.x > 0.5 ? Math.min(scale.x, 1.6) : 0.5;   // bounded bead scale (<= 0 would flip the field)
      surf.set('uCorner', G.corner).set('uRn', G.R + G.gap).set('uR', G.R).set('uScale', sc);
      const f = Math.min(Math.max((head.x - G.cs[0]) / G.slotW, 0), N - 1), i0 = Math.floor(f), i1 = Math.min(i0 + 1, N - 1);
      surf.setAccent(Liquid.mixAccent(accOf(i0), accOf(i1), f - i0));
      const dm = (dis[i0] ? 0.5 : 1) * (1 - (f - i0)) + (dis[i1] ? 0.5 : 1) * (f - i0);   // bead dims as it rides over a disabled item
      surf.setAccentOpacity(dm); bead.style.opacity = dm;
      surf.draw();
      bead.style.transform = `translate(${bx}px, ${by}px) scale(${sc})`;
      const n = nearest(head.x);
      if (n !== near) { near = n; els.forEach((el, j) => el.classList.toggle('near', j === n)); }
      const Lf = !dragging && Math.abs(head.x - G.cs[target]) < 4 && sp < 120 ? target : -1;
      if (Lf !== lifted) { lifted = Lf; els.forEach((el, j) => el.classList.toggle('lifted', j === Lf)); beadLayers.forEach((l, j) => l.classList.toggle('on', j === Lf)); }
      writeBadges(bx, by, sc);
    }

    function writeBadges(bx, by, sc) {
      const d = Math.SQRT1_2, red = Liquid.state.reduce;
      const bc = [bx + (G.R * sc) * 0.72, by - (G.R * sc) * 0.72];
      B.forEach((b, i) => {
        const ic = horiz ? [G.cs[i] + 11, G.barT + G.iconOff - 10] : [G.iconX + 10, G.cs[i] - 10];
        // a badge rides onto the bead as the bead arrives over its item
        let u = Math.min(Math.max(1 - Math.abs(head.x - G.cs[i]) / (0.5 * G.slotW), 0), 1);
        u = u * u * (3 - 2 * u);
        const rest = [ic[0] + (bc[0] - ic[0]) * u, ic[1] + (bc[1] - ic[1]) * u];
        const src = [rest[0] - 7 * d, rest[1] + 7 * d];
        const m = b.m.x, x = src[0] + (rest[0] - src[0]) * m, y = src[1] + (rest[1] - src[1]) * m;
        const r = Math.max(b.r.x, 0), L = Math.max(b.L.x, 0);
        bsurf.set(`uB[${i}]`, x, y, r, L).set(`uS[${i}]`, src[0], src[1], Math.max(b.s.x, 0))
          .set(`uBA[${i}]`, ...b.col.rgb).set(`uBD[${i}]`, ...b.col.deep);
        b.cnt.style.transform = `translate(${x}px, ${y}px) scale(${Math.min(Math.max(r / BR, 0), 1.3)})`;
        const want = typeof b.val === 'number' && b.val > 0 ? (b.val > 99 ? '99+' : String(b.val)) : '';
        if (want !== b.shown) swapCount(b, want);
      });
      bsurf.draw();
    }
    function swapCount(b, txt) {
      b.shown = txt;
      for (const old of b.cnt.querySelectorAll('span:not(.out)')) { old.classList.add('out'); setTimeout(() => old.remove(), 180); }
      if (!txt) return;
      const sp = document.createElement('span'); sp.className = 'pre'; sp.textContent = txt;
      b.cnt.appendChild(sp);
      requestAnimationFrame(() => requestAnimationFrame(() => sp.classList.remove('pre')));
    }

    const anim = Liquid.animator(dt => {
      if (!ready) return false;
      head.target = dragging ? dragP : G.cs[target];
      if (dragging) { head.k = 2400; head.zeta = 1; head.fixed = true; } else { head.k = 520; head.zeta = 0.62; head.fixed = false; }
      tail.target = head.x;
      scale.target = dragging ? 0.9 : 1;
      const bs = []; B.forEach(b => bs.push(b.m, b.r, b.s, b.L));
      Liquid.stepSprings([head, tail, scale, ...bs], dt);
      for (const b of B) if (b.well && b.m.x < 0.6) { b.well = false; b.s.v += 150; }
      if (Liquid.state.reduce) tail.set(head.x);
      let moving = dragging;
      if (!dragging && head.settled() && tail.settled() && scale.settled(0.003) && Math.abs(tail.x - head.x) < 0.25) { head.snap(); tail.set(head.x); scale.snap(); }
      else moving = true;
      for (const s of bs) { if (s.settled(0.004)) { if (s.x !== s.target || s.v) s.snap(); } else moving = true; }
      write();
      return moving;
    });

    function mark() {
      els.forEach((el, j) => { el.setAttribute('aria-selected', j === target); el.tabIndex = j === target ? 0 : -1; });
    }
    function select(i, focus, user) {
      i = Math.max(0, Math.min(N - 1, i));
      if (focus) els[i].focus();
      if (i === target) return;
      target = i; mark();
      if (!Liquid.state.reduce) scale.v -= user ? 1.6 : 0.8;   // programmatic (scroll-spy) moves are quieter
      if (user) { Liquid.haptic(); opts.onChange && opts.onChange(T[i].id); }
      anim.wake();
    }
    mark();

    Liquid.pointer(host, {
      down(x, y) {
        if (disabled || !ready) return {};
        const along = horiz ? x : y;
        const onBead = horiz ? Math.hypot(x - head.x, y - G.barT) < G.R + 14 : Math.hypot(x - G.bw, y - head.x) < G.R + 12;
        if (onBead) { dragging = true; dragP = rubber(along); anim.wake(); }
        return { ok: true };
      },
      move(x, y, st) {
        if (!st.data || !st.data.ok) return;
        if (!dragging && st.moved) dragging = true;
        if (dragging) { dragP = rubber(horiz ? x : y); anim.wake(); }
      },
      up(x, y, st) {
        if (!st.data || !st.data.ok) return;
        if (dragging) {
          dragging = false;
          const i = nearest(head.x + head.v * 0.08);
          scale.v += Liquid.state.reduce ? 0 : 2.2;
          if (i !== target) { target = i; mark(); Liquid.haptic(); opts.onChange && opts.onChange(T[i].id); }
          anim.wake();
        } else if (!st.moved && (horiz ? y > G.barT - G.R - 8 : true)) select(nearest(horiz ? x : y), false, true);
      }
    });
    list.addEventListener('keydown', e => {
      const k = e.key, f = horiz ? 'ArrowRight' : 'ArrowDown', b = horiz ? 'ArrowLeft' : 'ArrowUp';
      if (k === f) select(target + 1, true, true);
      else if (k === b) select(target - 1, true, true);
      else if (k === 'Home') select(0, true, true);
      else if (k === 'End') select(N - 1, true, true);
      else return;
      e.preventDefault();
    });

    function label(i) {
      const v = B[i].val, t = T[i].label;
      els[i].setAttribute('aria-label', v === 'dot' ? `${t}, new` : (typeof v === 'number' && v > 0) ? `${t}, ${v}` : t);
    }
    T.forEach((_, i) => label(i));
    function markDis(i) { els[i].classList.toggle('dis', dis[i]); if (dis[i]) els[i].setAttribute('aria-disabled', 'true'); else els[i].removeAttribute('aria-disabled'); }
    T.forEach((_, i) => markDis(i));
    // setItemState(id, { disabled }): dim / restore one item. It stays focusable and selectable (the app shows a note).
    function setItemState(id, { disabled: d } = {}) {
      const i = idx(id); if (i < 0 || d === undefined || dis[i] === !!d) return;
      dis[i] = !!d; markDis(i); anim.wake(); write();
    }

    // setBadge(id, value, { accent }): value = number | 'dot' | null; accent (per call) defaults to the badge accent
    function setBadge(id, v, { accent } = {}) {
      const i = idx(id); if (i < 0) return;
      const b = B[i];
      if (typeof v === 'number' && v <= 0) v = null;
      if (v != null) { const a = accent ? acc(accent) : badgeAcc; if (a !== b.acc) badgeColour(b, a); }
      const was = b.val != null;
      b.val = v == null ? null : v;
      label(i);
      const r = v === 'dot' ? DOT : BR;
      const Lt = typeof v === 'number' ? (v > 99 ? 7 : v > 9 ? 3.5 : 0) : 0;
      if (v == null) {
        if (!was) return;
        b.m.target = 0; b.r.target = 0; b.L.target = 0; b.s.target = 0; b.well = true;
        b.r.k = 150; b.r.zeta = 1;        // shrinks slower than it travels: visibly slides back in
      } else if (!was || b.m.target === 0) {
        b.m.set(Math.min(b.m.x, 0.05)); b.r.x = Math.max(b.r.x, 2.5); b.s.set(6.5); b.well = false;
        b.m.target = 1; b.r.target = r; b.L.target = Lt; b.s.target = 0; b.r.k = 380; b.r.zeta = 0.62;
      } else {
        b.r.target = r; b.L.target = Lt;
        if (!Liquid.state.reduce) b.r.v += 45;    // already out: pulse
      }
      anim.wake();
    }

    return {
      get: () => T[target].id,
      set(id, { silent = true, instant = false } = {}) {
        const i = idx(id); if (i < 0 || i === target) return;
        if (instant || !ready) {
          target = i; mark();
          if (ready) { head.set(G.cs[i]); tail.set(G.cs[i]); scale.set(1); write(); }
        } else select(i, false, false);
        if (!silent && opts.onChange) opts.onChange(T[i].id);
      },
      setBadge, setItemState,
      setDisabled(b) { disabled = !!b; host.setAttribute('aria-disabled', disabled); els.forEach(el => { el.disabled = disabled; }); },
      redraw: write,
      destroy() {
        for (const s of [surf, bsurf]) { s.ro.disconnect(); s.draw = () => {}; }
        host.innerHTML = ''; host.classList.remove('lq-ws', 'h', 'v');
      }
    };
  };

  // ---- demo ----
  Liquid.uiDemo.push({
    id: 'sections', title: 'Sections', wide: true,
    note: 'Bottom-sheet tab bar and desktop rail, kept in sync. Badges bud off the item.',
    mount(host) {
      const ITEMS = [
        { id: 'surface', label: 'Surface', icon: 'surface' }, { id: 'volume', label: 'Volume', icon: 'volume' },
        { id: 'cell', label: 'Cell', icon: 'cell' }, { id: 'analyze', label: 'Analyze', icon: 'analyze' }];
      host.innerHTML = `
<div style="display:flex;gap:20px;align-items:flex-start">
  <div class="sv"></div>
  <div style="flex:1;min-width:0">
    <div class="sh"></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">
      <button class="toggle bb" data-a="add">Badge +1</button>
      <button class="toggle bb" data-a="dot">Dot</button>
      <button class="toggle bb" data-a="stale">Stale (amber)</button>
      <button class="toggle bb" data-a="clear">Clear</button>
      <button class="toggle bb" data-a="spy">Scroll-spy step</button>
    </div>
    <p class="out" style="margin-top:10px;font-size:13px;color:var(--ink-faint)">section: surface</p>
  </div>
</div>`;
      const out = host.querySelector('.out');
      let a, b;
      const onChange = src => id => { out.textContent = 'section: ' + id; (src === 'h' ? b : a).set(id); };
      a = Liquid.ui.sections(host.querySelector('.sh'), { items: ITEMS, value: 'surface', orientation: 'horizontal', ariaLabel: 'Sections', onChange: onChange('h') });
      b = Liquid.ui.sections(host.querySelector('.sv'), { items: ITEMS, value: 'surface', orientation: 'vertical', accent: 'aqua', ariaLabel: 'Sections', onChange: onChange('v') });
      let n = 0;
      host.querySelectorAll('.bb').forEach(btn => btn.addEventListener('click', () => {
        const act = btn.dataset.a;
        if (act === 'add') { n++; a.setBadge('analyze', n); b.setBadge('analyze', n); }
        if (act === 'dot') { a.setBadge('cell', 'dot'); b.setBadge('cell', 'dot'); }
        if (act === 'stale') { for (const w of [a, b]) w.setBadge('volume', 'dot', { accent: 'amber' }); }
        if (act === 'clear') { n = 0; for (const w of [a, b]) { w.setBadge('analyze', null); w.setBadge('cell', null); w.setBadge('volume', null); } }
        if (act === 'spy') { const i = (ITEMS.findIndex(t => t.id === a.get()) + 1) % ITEMS.length; a.set(ITEMS[i].id); b.set(ITEMS[i].id); out.textContent = 'section: ' + ITEMS[i].id; }
      }));
      return { redraw() { a.redraw(); b.redraw(); }, a, b };
    }
  });
})();

/* ---- widgets/segmented.js ---- */
/* Liquid segmented widget. The selection is a capsule whose two edges are separate springs:
   the leading edge snaps over, the trailing edge catches up, so the pill stretches and thins
   toward the new segment, then contracts. It sits in a hairline groove cut from the body.
   Per-option accents: the pill tint interpolates by position while it travels.
   Dark label copy is clipped exactly to the pill. */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
(() => {
  'use strict';
  const DIM = 'var(--lq-ink-dim, var(--ink-dim, oklch(0.78 0.02 290)))';
  const CSS = `
.lq-seg{ position:relative; overflow-x:clip; touch-action:pan-y; user-select:none; -webkit-user-select:none; -webkit-tap-highlight-color:transparent;
  font-family:var(--lq-font, inherit); }
.lq-seg-list{ position:absolute; inset:0; }
.lq-seg-opt{ position:absolute; top:0; height:100%; background:none; border:0; padding:0; margin:0; font:inherit; color:${DIM};
  border-radius:999px; cursor:pointer; outline:none; -webkit-tap-highlight-color:transparent; }
.lq-seg-opt::after{ content:''; position:absolute; left:3px; right:3px; top:50%; height:var(--lq-seg-ph); transform:translateY(-50%);
  border-radius:999px; opacity:0; box-shadow:inset 0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .56); transition:opacity 140ms ease-out; }
.lq-seg-opt:focus-visible::after{ opacity:1; }
.lq-seg-lab, .lq-seg-ink span{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:0 8px;
  font-size:13px; font-weight:620; letter-spacing:-.005em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lq-seg-ink{ position:absolute; inset:0; pointer-events:none; }
.lq-seg-ink span{ color:oklch(0.24 0.06 var(--ah)); }
.lq-seg.dis{ opacity:.45; }
.lq-seg.dis .lq-seg-opt{ cursor:default; }
.lq-seg-opt[data-off]{ opacity:.4; cursor:default; }
.lq-seg.none{ opacity:.6; }`;
  function injectCSS() {
    if (document.getElementById('lq-ui-seg-css')) return;
    const s = document.createElement('style'); s.id = 'lq-ui-seg-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  // The host clips overflow-x (a widget must never cause horizontal scroll). So glow and shadow are
  // faded out toward the side edges, except inside a stadium around the control, which stays crisp.
  // cx: cap centre inset from the host edge, cy: centre y, rc: cap radius (all host px).
  function edgeMask(canvas, B, cx, cy, rc) {
    const y0 = B + cy - rc, y1 = B + cy + rc, f = 1.5, s = canvas.style;
    const img = [
      `linear-gradient(90deg, transparent ${B}px, #000 ${B + 20}px, #000 calc(100% - ${B + 20}px), transparent calc(100% - ${B}px))`,
      `linear-gradient(180deg, transparent ${y0 - f}px, #000 ${y0 + f}px, #000 ${y1 - f}px, transparent ${y1 + f}px)`,
      `radial-gradient(circle at ${B + cx}px ${B + cy}px, #000 ${rc - f}px, transparent ${rc + f}px)`,
      `radial-gradient(circle at calc(100% - ${B + cx}px) ${B + cy}px, #000 ${rc - f}px, transparent ${rc + f}px)`].join(',');
    const size = `100% 100%, calc(100% - ${2 * (B + cx)}px) 100%, 100% 100%, 100% 100%`;
    s.webkitMaskImage = s.maskImage = img;
    s.webkitMaskSize = s.maskSize = size;
    s.webkitMaskPosition = s.maskPosition = 'center';
    s.webkitMaskRepeat = s.maskRepeat = 'no-repeat';
  }
  const GLSL = `
#define BULGE 9.0
#define SHADOW_DY 8.0
uniform vec4 uBody; uniform float uBodyR;
uniform vec4 uPill;   // left edge x, right edge x, centre y, half height
uniform float uGroove, uGK;
float pillSDF(vec2 p){
  float hw = max((uPill.y - uPill.x)*.5, uPill.w);
  return sdRoundBox(p - vec2((uPill.x + uPill.y)*.5, uPill.z), vec2(hw, uPill.w), uPill.w);
}
float bodySDF(vec2 p){
  float box = sdRoundBox(p - (uBody.xy + uBody.zw*.5), uBody.zw*.5, uBodyR);
  return ssub(box, pillSDF(p) - uGroove, uGK);
}
float accentSDF(vec2 p){ return pillSDF(p); }`;
  const resolveAccent = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  Liquid.ui.segmented = function segmented(host, opts = {}) {
    injectCSS();
    const o = { options: [], value: undefined, onChange: null, size: 'md', ariaLabel: '', role: 'radiogroup', accent: Liquid.ACCENTS.lime, ...opts };
    const OPTS = o.options.map(x => (typeof x === 'object' ? { ...x } : { value: x, label: String(x) }));
    const N = Math.max(OPTS.length, 1);
    const tabs = o.role === 'tablist';
    const S = o.size === 'sm' ? { H: 44, bh: 38, pad: 3 } : { H: 48, bh: 48, pad: 4 };
    host.classList.add('lq-seg');
    host.style.height = S.H + 'px';
    host.style.setProperty('--lq-seg-ph', (S.bh - 2 * S.pad + 4) + 'px');
    host.innerHTML = `<div class="lq-seg-list" role="${tabs ? 'tablist' : 'radiogroup'}"></div><div class="lq-seg-ink" aria-hidden="true"></div>`;
    const list = host.firstChild, ink = host.lastChild;
    if (o.ariaLabel) list.setAttribute('aria-label', o.ariaLabel);
    const btns = OPTS.map((op, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lq-seg-opt'; b.setAttribute('role', tabs ? 'tab' : 'radio');
      b.innerHTML = `<span class="lq-seg-lab">${esc(op.label)}</span>`;
      if (op.disabled) { b.setAttribute('data-off', ''); b.setAttribute('aria-disabled', 'true'); }
      b.addEventListener('click', e => { if (e.detail === 0) select(i, { user: true }); });   // keyboard; pointer handled on host
      list.appendChild(b); return b;
    });
    ink.innerHTML = OPTS.map(op => `<span>${esc(op.label)}</span>`).join('');
    const inkSpans = [...ink.children], labs = btns.map(b => b.firstChild);
    const base = resolveAccent(o.accent) || Liquid.ACCENTS.lime;
    const accs = OPTS.map(op => resolveAccent(op.accent) || base);

    const G = { bx: 0, by: 0, bw: 0, bh: S.bh, pad: S.pad, seg: 0, cs: [], hh0: 0, hw0: 0, groove: 1.5, w: 0 };
    const SP = { lead: { k: 640, zeta: 0.66 }, trail: { k: 190, zeta: 0.86 } };
    const L = new Liquid.Spring(0, SP.trail), R = new Liquid.Spring(0, SP.lead);
    // target -1 = nothing selected (value null / unknown with opts.none, or api.clear()): no pill, no tab stop on a choice
    let target = o.value == null && o.none ? -1 : Math.max(0, OPTS.findIndex(op => op.value === o.value));
    let dragging = false, dragC = 0, grabOff = 0, dir = 1, ready = false, dead = false, disabled = false;

    const surf = new Liquid.Surface(host, {
      glsl: GLSL, onResize(w) {
        G.w = w; G.bx = 1; G.bw = w - 2; G.by = (S.H - S.bh) / 2;
        G.seg = (G.bw - 2 * G.pad) / N;
        G.cs = OPTS.map((_, i) => G.bx + G.pad + G.seg * (i + 0.5));
        G.hh0 = G.bh / 2 - G.pad; G.hw0 = G.seg / 2;
        btns.forEach((el, i) => Object.assign(el.style, { left: (G.cs[i] - G.seg / 2) + 'px', width: G.seg + 'px' }));
        inkSpans.forEach((el, i) => Object.assign(el.style, { left: (G.cs[i] - G.seg / 2) + 'px', width: G.seg + 'px', right: 'auto' }));
        ready = true;
        if (!dragging) { const t = Math.max(target, 0); L.set(G.cs[t] - G.hw0); R.set(G.cs[t] + G.hw0); }
        write();
      }
    });
    edgeMask(surf.canvas, surf.bleed, 1 + S.bh / 2, S.H / 2, S.bh / 2 + 1.5);

    const centre = () => (L.x + R.x) / 2;
    function nearest(x) { let bi = 0; G.cs.forEach((c, i) => { if (Math.abs(c - x) < Math.abs(G.cs[bi] - x)) bi = i; }); return bi; }
    function rubber(c) { const lo = G.cs[0], hi = G.cs[N - 1]; if (c < lo) return lo - (lo - c) * 0.3 / (1 + (lo - c) / 90); if (c > hi) return hi + (c - hi) * 0.3 / (1 + (c - hi) / 90); return c; }
    function accentAt(c) {
      if (N < 2) return accs[0] || base;
      const f = Math.min(Math.max((c - G.cs[0]) / G.seg, 0), N - 1), i = Math.min(Math.floor(f), N - 2);
      return Liquid.mixAccent(accs[i], accs[i + 1], f - i);
    }

    function write() {
      if (!ready || dead) return;
      if (target < 0) {   // nothing selected: the pill is parked out of sight, labels all show
        surf.set('uBody', G.bx, G.by, G.bw, G.bh).set('uBodyR', G.bh / 2)
          .set('uPill', -4000, -3900, G.by + G.bh / 2, G.hh0).set('uGroove', G.groove).set('uGK', 0);
        surf.draw();
        labs.forEach(el => { el.style.webkitMaskImage = el.style.maskImage = 'none'; });
        ink.style.clipPath = 'inset(50%)';
        return;
      }
      const wl = G.bx + G.pad, wr = G.bx + G.bw - G.pad;
      let l = Math.max(L.x, wl), r = Math.min(R.x, wr);
      const width = r - l, base2 = 2 * G.hw0;
      const s = Liquid.state.reduce ? 1 : Math.max(width / base2, 1);
      const hh = G.hh0 / Math.min(Math.pow(s, 0.3), 1.2);
      if (r - l < 2 * hh) { const c = (l + r) / 2; l = c - hh; r = c + hh; }
      const cy = G.by + G.bh / 2;
      surf.setAccent(accentAt((l + r) / 2));
      surf.set('uBody', G.bx, G.by, G.bw, G.bh).set('uBodyR', G.bh / 2)
        .set('uPill', l, r, cy, hh).set('uGroove', G.groove).set('uGK', Math.min(Liquid.state.melt * 0.12, 2.5));
      surf.draw();
      labs.forEach((el, i) => {   // hide the dim label under the pill (dark copy shows there)
        const x0 = G.cs[i] - G.seg / 2, a = (l - x0).toFixed(2), z = (r - x0).toFixed(2);
        el.style.webkitMaskImage = el.style.maskImage = `linear-gradient(90deg,#000 ${a}px,transparent ${a}px,transparent ${z}px,#000 ${z}px)`;
      });
      ink.style.clipPath = `inset(${(cy - hh).toFixed(2)}px ${(G.w - r).toFixed(2)}px ${(S.H - cy - hh).toFixed(2)}px ${l.toFixed(2)}px round ${hh.toFixed(2)}px)`;
    }

    function setSprings() {
      const lead = dragging ? { k: 1500, zeta: 0.9 } : SP.lead, trail = dragging ? { k: 520, zeta: 0.95 } : SP.trail;
      const a = dir > 0 ? R : L, b = dir > 0 ? L : R;
      a.k = lead.k; a.zeta = lead.zeta; b.k = trail.k; b.zeta = trail.zeta;
      if (Liquid.state.reduce) { L.k = R.k = 900; L.zeta = R.zeta = 1; }
    }
    const anim = Liquid.animator(dt => {
      if (dead || !ready) return false;
      if (target < 0) { write(); return false; }
      const c = dragging ? dragC : G.cs[target];
      L.target = c - G.hw0; R.target = c + G.hw0;
      setSprings();
      Liquid.stepSprings([L, R], dt);
      const done = !dragging && L.settled() && R.settled();
      if (done) { L.snap(); R.snap(); }
      write();
      return !done;
    });

    function mark() {
      const stop = target >= 0 ? target : Math.max(0, OPTS.findIndex(op => !op.disabled));   // nothing chosen: the first enabled option is the tab stop
      host.classList.toggle('none', target < 0);
      btns.forEach((el, i) => {
        el.setAttribute(tabs ? 'aria-selected' : 'aria-checked', i === target);
        el.tabIndex = disabled ? -1 : (i === stop ? 0 : -1);
      });
    }
    function select(i, { user = false, focus = false, instant = false } = {}) {
      i = Math.max(0, Math.min(N - 1, i));
      if (user && OPTS[i].disabled) { anim.wake(); return; }   // a disabled option ignores taps (the pill returns to the real choice)
      if (focus) btns[i].focus();
      if (i === target) return;
      if (target < 0) instant = true;                          // from nothing selected: appear in place
      if (ready && target >= 0) dir = Math.sign(G.cs[i] - centre()) || 1;
      target = i; mark();
      if (instant && ready) { L.set(G.cs[i] - G.hw0); R.set(G.cs[i] + G.hw0); write(); } else anim.wake();
      if (user) { Liquid.haptic(); o.onChange && o.onChange(OPTS[i].value, OPTS[i]); }
    }
    mark();

    // ---------- pointer: tap selects; dragging the pill needs horizontal intent on touch ----------
    let ptr = null;
    const loc = e => { const r = host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const onPill = (x, y) => target >= 0 && x > L.x - 4 && x < R.x + 4 && Math.abs(y - S.H / 2) < S.H / 2 + 4;
    function startDrag(x, e) {
      try { host.setPointerCapture(e.pointerId); } catch (_) {}
      dragging = true; grabOff = x - centre(); dragC = centre(); anim.wake();
    }
    host.addEventListener('pointerdown', e => {
      if (disabled || ptr || !ready || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const [x, y] = loc(e);
      ptr = { id: e.pointerId, touch: e.pointerType === 'touch', x0: x, y0: y, pill: onPill(x, y), moved: false };
      if (!ptr.touch && ptr.pill) startDrag(x, e);
    });
    host.addEventListener('pointermove', e => {
      if (!ptr || e.pointerId !== ptr.id) return;
      const [x, y] = loc(e), dx = x - ptr.x0, dy = y - ptr.y0;
      if (!ptr.moved) {
        if (ptr.touch && Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { ptr = null; return; }   // vertical: page scrolls
        if (Math.hypot(dx, dy) < 6) return;
        ptr.moved = true;
        if (ptr.touch && ptr.pill && Math.abs(dx) > Math.abs(dy)) startDrag(ptr.x0, e);
      }
      if (!dragging) return;
      const c = rubber(x - grabOff);
      if (Math.abs(c - dragC) > 0.3) dir = Math.sign(c - dragC);
      dragC = c; anim.wake();
    });
    const end = (e, cancel) => {
      if (!ptr || e.pointerId !== ptr.id) return;
      const p = ptr; ptr = null;
      const [x] = loc(e);
      if (dragging) {
        dragging = false;
        const v = (L.v + R.v) / 2, i = nearest(dragC + v * 0.06);
        dir = Math.sign(G.cs[i] - centre()) || dir;
        if (i !== target) select(i, { user: true }); else anim.wake();
        if (p.moved) return;
      }
      if (!cancel && !p.moved && x > G.bx - 8 && x < G.bx + G.bw + 8) select(nearest(x), { user: true });
    };
    host.addEventListener('pointerup', e => end(e, false));
    host.addEventListener('pointercancel', e => end(e, true));

    list.addEventListener('keydown', e => {
      if (disabled) return;
      const k = e.key;
      let i = null;
      const step = d => { let j = target < 0 ? (d > 0 ? -1 : N) : target; for (let n = 0; n < N; n++) { j = (j + d + N) % N; if (!OPTS[j].disabled) return j; } return null; };
      if (k === 'ArrowRight' || k === 'ArrowDown') i = step(1);
      else if (k === 'ArrowLeft' || k === 'ArrowUp') i = step(-1);
      else if (k === 'Home') i = OPTS.findIndex(op => !op.disabled);
      else if (k === 'End') i = N - 1 - [...OPTS].reverse().findIndex(op => !op.disabled);
      if (i === null || i < 0 || i >= N) return;
      e.preventDefault();
      select(i, { user: true, focus: true });
    });

    const api = {
      get: () => OPTS[target] ? OPTS[target].value : undefined,
      set(v, { silent = true, instant = false } = {}) {
        if (v == null) return api.clear();
        const i = OPTS.findIndex(op => op.value === v);
        if (i >= 0) select(i, { user: !silent, instant });
        return api;
      },
      // nothing selected: no pill, every label shown; the next set() / tap brings it back
      clear() {
        if (target < 0) return api;
        target = -1; mark(); anim.wake(); return api;
      },
      // per-option disabled: dimmed, ignores taps and keys (set() from the app still works)
      setOptionDisabled(v, b) {
        const i = typeof v === 'number' ? v : OPTS.findIndex(op => op.value === v);
        if (!OPTS[i]) return api;
        OPTS[i].disabled = !!b;
        btns[i].toggleAttribute('data-off', !!b); btns[i].setAttribute('aria-disabled', !!b);
        mark(); return api;
      },
      setDisabled(b) {
        disabled = !!b; host.classList.toggle('dis', disabled);
        list.setAttribute('aria-disabled', disabled); btns.forEach(x => { x.disabled = disabled; }); mark();
        return api;
      },
      redraw() { write(); return api; },
      focus() { btns[target] && btns[target].focus(); return api; },
      destroy() {
        dead = true; surf.ro.disconnect(); surf.w = 0; surf.canvas.remove();
        host.innerHTML = ''; host.classList.remove('lq-seg', 'dis'); host.style.height = ''; host.style.removeProperty('--lq-seg-ph');
      }
    };
    return api;
  };

  // ---------- demo ----------
  Liquid.uiDemo.push({
    id: 'segmented', title: 'Segmented',
    note: 'Leading edge snaps over, trailing edge catches up; the tint travels with the pill.',
    mount(host) {
      host.style.display = 'grid'; host.style.rowGap = '14px';
      const a = document.createElement('div'), b = document.createElement('div');
      host.append(a, b);
      const MODES = [{ value: 'solid', label: 'solid', accent: 'aqua' }, { value: 'thin', label: 'thin wall', accent: 'amber' }, { value: 'pi', label: 'PI-TPMS', accent: 'violet' }];
      const w1 = Liquid.ui.segmented(a, { options: MODES, value: 'solid', ariaLabel: 'Lattice mode' });
      const w2 = Liquid.ui.segmented(b, { options: ['X', 'Y', 'Z', 'All'].map((v, i) => ({ value: v, label: v, accent: ['axisX', 'axisY', 'axisZ', 'lime'][i] })),
        value: 'All', size: 'sm', role: 'tablist', ariaLabel: 'Axis' });
      return { redraw() { w1.redraw(); w2.redraw(); } };
    }
  });
})();

/* ---- widgets/send.js ---- */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
/* Mitosis send button (compact header control).
   At rest the host draws a 36 px accent pill. Opening, an overlay (fixed, on document.body) draws the pill
   plus one accent droplet per item in a single smooth union: droplets bud out of the pill's end cap,
   farthest first, stretch along their path, neck, and pinch off into a column. Each droplet then grows a
   glass label chip out from behind it. Disabled items bud as glass beads instead of accent. */
(() => {
  const acc = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || Liquid.ACCENTS.lime;
  const I = Liquid.ICONS;
  I.send = I.send || '<path d="M20 4 3.8 10.4l6.6 3.2 3.2 6.6z"/><path d="m20 4-9.6 9.6"/>';
  I.layers = I.layers || '<path d="m12 4.5 8 4-8 4-8-4z"/><path d="m4 12.5 8 4 8-4"/><path d="m4 16.5 8 4 8-4"/>';
  I.flask = I.flask || '<path d="M9.5 4h5M10.3 4v5.6L5.2 17.9a1.5 1.5 0 0 0 1.3 2.3h11a1.5 1.5 0 0 0 1.3-2.3l-5.1-8.3V4"/><path d="M7.6 14.5h8.8"/>';
  I.download = I.download || '<path d="M12 4v11M7.2 10.6 12 15.4l4.8-4.8"/><path d="M5 19.5h14"/>';
  I.queue = I.queue || '<path d="M4.5 6.5h11M4.5 11.5h11M4.5 16.5h6"/><path d="M17.5 13.5v6M14.5 16.5h6"/>';

  const INK = 'var(--lq-ink, var(--ink, oklch(0.97 0.01 290)))', FAINT = 'var(--lq-ink-faint, var(--ink-faint, oklch(0.62 0.02 290)))';
  const css = `
.lq-wsd{ position:relative; height:44px; font-family:var(--lq-font, inherit); }
.lq-wsd-main{ position:absolute; inset:0; border:0; padding:0; background:none; cursor:pointer; border-radius:18px; font:inherit;
  -webkit-tap-highlight-color:transparent; }
.lq-wsd-main:disabled{ cursor:default; opacity:.45; }
.lq-wsd-main:focus-visible{ outline:none; box-shadow:0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .45); }
.lq-wsd-face{ position:absolute; display:flex; align-items:center; justify-content:center; gap:6px; pointer-events:none;
  color:oklch(0.24 0.06 var(--ah)); font-size:13px; font-weight:700; letter-spacing:-.005em; white-space:nowrap; }
.lq-wsd-main .lq-wsd-face{ inset:0; }
.lq-wsd-face .ic{ position:relative; width:18px; height:18px; flex:none; }
.lq-wsd-face .ic span{ position:absolute; inset:0; transition: opacity 160ms ease-out, filter 160ms ease-out, transform 220ms cubic-bezier(.3,1.5,.5,1); }
.lq-wsd-face .ic .lq-i{ stroke-width:2.1; }
.lq-wsd-face .ic .x{ opacity:0; filter:blur(4px); transform:rotate(-45deg) scale(.6); }
.lq-wsd-open .lq-wsd-face .ic .a{ opacity:0; filter:blur(4px); transform:rotate(45deg) scale(.6); }
.lq-wsd-open .lq-wsd-face .ic .x{ opacity:1; filter:none; transform:none; }
.lq-wsd-ov{ position:fixed; left:0; top:0; z-index:var(--lq-z, 1000); pointer-events:none; display:none; font-family:var(--lq-font, inherit); }
.lq-wsd-kid{ position:absolute; height:44px; margin:0; padding:0; border:0; background:none; cursor:pointer; font:inherit; border-radius:16px;
  pointer-events:none; opacity:0; -webkit-tap-highlight-color:transparent; }
.lq-wsd-open .lq-wsd-kid:not(:disabled){ pointer-events:auto; }
.lq-wsd-kid:disabled{ cursor:default; }
.lq-wsd-kid:focus-visible{ outline:none; box-shadow: inset 0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .5); }
.lq-wsd-kid:focus{ outline:none; }
.lq-wsd-kic{ position:absolute; top:50%; width:18px; height:18px; margin:-9px 0 0 -9px; color:oklch(0.24 0.06 var(--ah)); }
.lq-wsd-kic .lq-i{ stroke-width:2.1; }
.lq-wsd-kid:disabled .lq-wsd-kic{ color:${FAINT}; }
.lq-wsd-lab{ position:absolute; top:50%; transform:translateY(-50%); font-size:13px; font-weight:600; color:${INK}; white-space:nowrap;
  transition: opacity 120ms ease-out, filter 120ms ease-out; }
.lq-wsd-kid:disabled .lq-wsd-lab{ color:${FAINT}; }
.lq-wsd-kid:not(:disabled):hover .lq-wsd-lab{ text-decoration:underline; text-decoration-color:oklch(1 0 0 / .25); text-underline-offset:3px; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  if (!document.getElementById('lq-i-base')) {   // icon base style (zero specificity) so widgets work outside the demo page
    const b = document.createElement('style'); b.id = 'lq-i-base';
    b.textContent = ':where(.lq-i){fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block;width:100%;height:100%}';
    document.head.prepend(b);
  }
  let uid = 0;

  Liquid.ui.send = function (host, opts = {}) {
    let items = [], N = 1, kids = [], s = [];   // rebuilt by setItems()
    const A = acc(opts.accent);
    const label = opts.label != null ? opts.label : 'Send';
    const icon = opts.icon || 'send';
    const id = 'lq-wsd' + (++uid);
    const PH = 36, KR = 17, SP = 46, CH = 32, FIRST = 56;   // pill height, droplet radius, item spacing, chip height, pill-centre to first droplet
    let open = false, active = false, ready = false, disabled = false, destroyed = false, clock = 0, pending = [];

    host.classList.add('lq-wsd');
    const faceHTML = `<span class="ic"><span class="a">${Liquid.icon(icon)}</span><span class="x">${Liquid.icon('close')}</span></span>${label ? `<span class="t"></span>` : ''}`;
    const main = document.createElement('button');
    main.type = 'button'; main.className = 'lq-wsd-main';
    main.setAttribute('aria-haspopup', 'menu'); main.setAttribute('aria-expanded', 'false'); main.setAttribute('aria-controls', id + '-m');
    main.innerHTML = `<span class="lq-wsd-face">${faceHTML}</span>`;
    if (label) main.querySelector('.t').textContent = label; else main.setAttribute('aria-label', opts.ariaLabel || 'Send');
    host.appendChild(main);
    // intrinsic width
    const tw = () => (label ? main.querySelector('.t').offsetWidth : 0);
    let W = 0;
    function size() { W = label ? Math.round(14 + 18 + 6 + tw() + 16) : 44; host.style.width = W + 'px'; }
    size();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { size(); });

    // overlay
    const ov = document.createElement('div'); ov.className = 'lq-wsd-ov';
    const face2 = document.createElement('div'); face2.className = 'lq-wsd-face'; face2.setAttribute('aria-hidden', 'true'); face2.innerHTML = faceHTML;
    if (label) face2.querySelector('.t').textContent = label;
    const menu = document.createElement('div'); menu.id = id + '-m'; menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', opts.ariaLabel || label || 'Send');
    ov.append(face2, menu);
    function buildItems(list) {
      items = (list || []).map(it => ({ ...it, disabled: !!it.disabled }));
      N = Math.max(items.length, 1);
      menu.textContent = '';
      kids = items.map((it, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'lq-wsd-kid'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
        b.innerHTML = `<span class="lq-wsd-kic">${Liquid.icon(it.icon)}</span><span class="lq-wsd-lab"></span>`;
        b.querySelector('.lq-wsd-lab').textContent = it.label;
        b.disabled = it.disabled;
        b.addEventListener('click', () => pick(i));
        menu.appendChild(b); return b;
      });
      s = items.map(() => new Liquid.Spring(0, { k: 300, zeta: 0.6 }));   // one per droplet
    }
    buildItems(opts.items);
    const sc = new Liquid.Spring(1, { k: 650, zeta: 0.4, fixed: true });

    // host surface: pill only
    const hostGlsl = `
uniform vec4 uMain;
float bodySDF(vec2 p){ return 1e5; }
float accentSDF(vec2 p){ return sdRoundBox(p - uMain.xy, uMain.zw, min(uMain.z, uMain.w)); }
#define BULGE 9.0`;
    const hs = new Liquid.Surface(host, { glsl: hostGlsl, onResize() { ready = true; write(); } });
    hs.setAccent(A);

    const ovGlsl = N => `
#define BULGE 10.0
#define SHADOW_DY 6.0
uniform vec4 uMain;
uniform vec4 uC[${N}];      // droplet x, y, r, stretch
uniform vec4 uCh[${N}];     // chip centre, half size
uniform float uOff[${N}];   // chip vanish offset
uniform float uDis[${N}];
uniform float uKm;
float kid(vec2 p, vec4 c){
  vec2 q = p - c.xy;
  vec2 s = vec2(1. / (1. + c.w), 1. + c.w);           // area-preserving stretch along the (vertical) path
  return (length(q / s) - c.z) * min(s.x, s.y);
}
float accentSDF(vec2 p){
  // droplets blend wide with the pill (budding neck) but narrowly with each other, so the column pinches apart
  float m = 1e5;
  for (int i = 0; i < ${N}; i++) if (uDis[i] < 0.5) m = smin(m, kid(p, uC[i]), 6.);
  return smin(sdRoundBox(p - uMain.xy, uMain.zw, min(uMain.z, uMain.w)), m, uKm);
}
float bodySDF(vec2 p){
  float d = 1e5;
  for (int i = 0; i < ${N}; i++) {
    float ch = sdRoundBox(p - uCh[i].xy, uCh[i].zw, uCh[i].w) + uOff[i];
    if (uDis[i] > 0.5) ch = smin(ch, kid(p, uC[i]), 8.);
    d = min(d, ch);
  }
  return d;
}`;
    let os = null;
    const Lo = { ovL: 0, ovT: 0, rx: 0, ry: 0, pcx: 0, pcy: 0, cx: 0, dy: 1, dx: -1, ys: [], cw: [] };

    function themeOverlay() {
      const cs = getComputedStyle(host);
      for (const v of ['--lq-ink', '--lq-ink-dim', '--lq-ink-faint', '--lq-font', '--lq-mono', '--ink', '--ink-dim', '--ink-faint', '--lq-z']) {
        const val = cs.getPropertyValue(v); if (val) ov.style.setProperty(v, val.trim());
      }
      ov.style.fontFamily = cs.fontFamily;
    }
    function layoutOverlay() {
      const r = host.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = window.innerHeight, M = 8;
      const labs = kids.map(k => k.querySelector('.lq-wsd-lab').offsetWidth);
      const cw = labs.map(w => KR + 10 + w + 14);              // chip length from droplet centre
      const maxC = Math.max(0, ...cw);
      const cx = r.right - PH / 2;                              // column under the pill's end cap
      const dx = cx - maxC >= M ? -1 : 1;                       // chips to the left unless no room
      const need = FIRST + (items.length - 1) * SP + KR + M;
      const pcyV = r.top + 22;
      const dy = vh - pcyV >= need || vh - pcyV >= pcyV ? 1 : -1;
      const ysV = items.map((_, i) => pcyV + dy * (FIRST + i * SP));
      const minX = Math.min(r.left, dx < 0 ? cx - maxC : cx - KR) - 4, maxX = Math.max(r.right, dx > 0 ? cx + maxC : cx + KR) + 4;
      const minY = Math.min(r.top, ...ysV.map(y => y - 22)) - 4, maxY = Math.max(r.bottom, ...ysV.map(y => y + 22)) + 4;
      Object.assign(Lo, { ovL: minX, ovT: minY, rx: r.left, ry: r.top, dx, dy, cw });
      Lo.pcx = r.left + W / 2 - minX; Lo.pcy = pcyV - minY; Lo.cx = cx - minX; Lo.ys = ysV.map(y => y - minY); Lo.bl = r.left - minX; Lo.bt = r.top - minY;
      Object.assign(ov.style, { left: minX + 'px', top: minY + 'px', width: (maxX - minX) + 'px', height: (maxY - minY) + 'px' });
      Object.assign(face2.style, { left: Lo.bl + 'px', top: Lo.bt + 'px', width: W + 'px', height: '44px' });
      kids.forEach((k, i) => {
        const w = cw[i] + KR + 2, left = dx < 0 ? Lo.cx - cw[i] : Lo.cx - KR - 2;
        Object.assign(k.style, { left: left + 'px', top: (Lo.ys[i] - 22) + 'px', width: w + 'px' });
        const ic = k.firstChild, lab = k.lastChild;
        ic.style.left = (Lo.cx - left) + 'px';
        lab.style.left = dx < 0 ? '14px' : (KR + 2 + KR + 10) + 'px';
      });
    }
    function reposition() {
      if (!active) return;
      const r = host.getBoundingClientRect();
      const ddx = r.left - Lo.rx, ddy = r.top - Lo.ry;
      if (!ddx && !ddy) return;
      Lo.rx = r.left; Lo.ry = r.top; Lo.ovL += ddx; Lo.ovT += ddy;
      ov.style.left = Lo.ovL + 'px'; ov.style.top = Lo.ovT + 'px';
      if (open && (r.bottom < 0 || r.top > window.innerHeight)) setOpen(false);
    }
    const onScroll = () => reposition();
    const onResizeWin = () => { if (open) setOpen(false); };

    function write() {
      if (!ready || destroyed) return;
      const ovOn = active && os && os.w;
      hs.canvas.style.visibility = ovOn ? 'hidden' : '';
      const k = sc.x > 0.5 ? Math.min(sc.x, 1.6) : 0.5;   // bounded squeeze (NaN -> 0.5)
      if (!ovOn) {
        hs.set('uMain', W / 2, 22, (W / 2) * (0.92 + 0.08 * k), (PH / 2) * k);
        hs.draw(); return;
      }
      const red = Liquid.state.reduce;
      os.set('uMain', Lo.pcx, Lo.pcy, (W / 2) * (0.92 + 0.08 * k), (PH / 2) * k).set('uKm', Math.min(Liquid.state.melt * 1.2, 17));
      s.forEach((sp, i) => {
        const u = Math.max(sp.x, 0), y0 = Lo.pcy, y1 = Lo.ys[i];
        const y = y0 + (y1 - y0) * u, r = KR * (0.55 + 0.45 * Math.min(u, 1));
        const stv = red ? 0 : Math.max(-0.12, Math.min(0.3, sp.v * Math.abs(y1 - y0) / 4200));
        os.set(`uC[${i}]`, Lo.cx, y, r, stv).set(`uDis[${i}]`, items[i].disabled ? 1 : 0);
        // chip grows out from behind the droplet once it has pinched free
        const g = Math.min(Math.max((u - 0.62) / 0.38, 0), 1.08);
        // chip spans from the droplet centre out to its full length; a capsule, hidden behind the drop at first
        const len = Math.max(Lo.cw[i] * g, 2 * (CH / 2)), hw = len / 2;
        os.set(`uCh[${i}]`, Lo.cx + Lo.dx * hw, y, hw, CH / 2).set(`uOff[${i}]`, (1 - Math.min(g * 4, 1)) * (CH / 2 + 2));
        const kb = kids[i];
        kb.style.opacity = Math.min(Math.max((u - 0.5) / 0.4, 0), 1);
        kb.firstChild.style.transform = `translateY(${y - y1}px)`;
        kb.lastChild.style.transform = `translateY(calc(-50% + ${y - y1}px))`;
        kb.lastChild.style.opacity = Math.min(Math.max((g - 0.7) / 0.3, 0), 1);
        kb.lastChild.style.filter = g < 1 ? `blur(${(1 - Math.min(g, 1)) * 4}px)` : '';
      });
      os.draw();
    }

    const anim = Liquid.animator(dt => {
      if (destroyed) return false;
      clock += dt;
      pending = pending.filter(p => { if (p.at > clock) return true; s[p.i].target = p.t; s[p.i].zeta = p.t ? 0.6 : 0.85; return false; });
      Liquid.stepSprings([...s, sc], dt);
      const done = !pending.length && s.every(sp => sp.settled(0.002)) && sc.settled(0.002);
      if (done) {
        s.forEach(sp => sp.snap()); sc.snap();
        if (!open && active) { active = false; ov.style.display = 'none'; detachWin(); }
      }
      write();
      return !done;
    });
    function attachWin() { window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onResizeWin); }
    function detachWin() { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onResizeWin); }

    function setOpen(v, focusFirst) {
      if (v === open || (v && (disabled || !items.length))) return;
      open = v;
      main.setAttribute('aria-expanded', v);
      host.classList.toggle('lq-wsd-open', v); ov.classList.toggle('lq-wsd-open', v);
      const n = items.length, gap = Liquid.state.reduce ? 0 : 0.045;
      if (v) {
        if (!ov.parentNode) document.body.appendChild(ov);
        themeOverlay(); ov.style.display = 'block'; layoutOverlay();
        if (!os) os = new Liquid.Surface(ov, { glsl: ovGlsl(N), bleed: 32, onResize() { write(); } });
        os.setAccent(A);
        if (!active) { attachWin(); s.forEach(sp => sp.set(0)); }
        active = true;
        // farthest buds first so later droplets never pass through settled ones
        const order = [...Array(n).keys()].reverse();
        pending = order.map((i, k) => ({ i, t: 1, at: clock + k * gap }));
        if (focusFirst) { const f = kids.findIndex(k => !k.disabled); if (f >= 0) kids[f].focus({ preventScroll: true }); }
      } else {
        const order = [...Array(n).keys()];
        pending = order.map((i, k) => ({ i, t: 0, at: clock + k * gap * 0.7 }));
        if (ov.contains(document.activeElement)) main.focus({ preventScroll: true });
      }
      if (!Liquid.state.reduce) sc.v -= v ? 2.0 : 1.3;      // anticipation squeeze, then follow-through
      kids.forEach(k => { k.tabIndex = -1; });
      anim.wake();
    }
    function pick(i) {
      if (items[i].disabled) return;
      Liquid.haptic();
      setOpen(false); main.focus({ preventScroll: true });
      opts.onSelect && opts.onSelect(items[i].id);
    }

    main.addEventListener('click', e => { Liquid.haptic(); setOpen(!open, e.detail === 0); });
    main.addEventListener('keydown', e => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !disabled) {
        e.preventDefault();
        if (!open) setOpen(true, true);
        else { const f = kids.findIndex(k => !k.disabled); if (f >= 0) kids[f].focus({ preventScroll: true }); }
      } else if (e.key === 'Escape' && open) { setOpen(false); e.preventDefault(); }
    });
    menu.addEventListener('keydown', e => {
      const en = kids.filter(k => !k.disabled), i = en.indexOf(document.activeElement);
      const go = j => { if (!en.length) return; en[(j + en.length) % en.length].focus({ preventScroll: true }); e.preventDefault(); };
      const fwd = Lo.dy > 0 ? 'ArrowDown' : 'ArrowUp', back = Lo.dy > 0 ? 'ArrowUp' : 'ArrowDown';
      if (e.key === fwd) go(i + 1);
      else if (e.key === back) go(i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(en.length - 1);
      else if (e.key === 'Escape') { setOpen(false); main.focus({ preventScroll: true }); e.preventDefault(); }
      else if (e.key === 'Tab') { setOpen(false); main.focus({ preventScroll: true }); }
    });
    const outside = e => { if (open && !host.contains(e.target) && !ov.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    const onSection = () => {   // section change: dismiss at once
      if (!open && !active) return;
      setOpen(false); pending = [];
      s.forEach(sp => { sp.target = 0; sp.snap(); }); sc.snap();
      active = false; ov.style.display = 'none'; detachWin(); write();
    };
    window.addEventListener('f13ui-section', onSection);

    return {
      get: () => open,
      set(v) { setOpen(!!v); },
      open() { setOpen(true); }, close() { setOpen(false); },
      setItemState(itemId, st = {}) {
        const i = items.findIndex(it => it.id === itemId); if (i < 0) return;
        if ('disabled' in st) { items[i].disabled = !!st.disabled; kids[i].disabled = items[i].disabled; }
        if ('label' in st) { items[i].label = st.label; kids[i].querySelector('.lq-wsd-lab').textContent = st.label; if (active) layoutOverlay(); }
        write();
      },
      // replace the targets in place (no destroy/recreate). An open menu stays open and rebuilds with the new
      // items (settled, no re-bud); one that is still closing finishes closing at once.
      setItems(list) {
        if (open) {
          const fi = kids.indexOf(document.activeElement);
          if (os) { os.destroy(); os = null; }   // the overlay shader is sized by item count
          buildItems(list);
          s.forEach(sp => sp.set(1));
          pending = [];
          layoutOverlay();
          if (items.length) {
            os = new Liquid.Surface(ov, { glsl: ovGlsl(N), bleed: 32, onResize() { write(); } });
            os.setAccent(A);
          } else setOpen(false);
          if (fi >= 0 && kids.length) kids[Math.min(fi, kids.length - 1)].focus({ preventScroll: true });
          write(); anim.wake();
          return;
        }
        if (active) {
          const refocus = ov.contains(document.activeElement);
          open = false; active = false; pending = [];
          main.setAttribute('aria-expanded', 'false');
          host.classList.remove('lq-wsd-open'); ov.classList.remove('lq-wsd-open');
          ov.style.display = 'none'; detachWin();
          if (refocus) main.focus({ preventScroll: true });
        }
        if (os) { os.destroy(); os = null; }   // the overlay shader is sized by item count
        buildItems(list);
        write();
      },
      setDisabled(b) { disabled = !!b; main.disabled = disabled; if (disabled && open) setOpen(false); },
      redraw: write,
      destroy() {
        destroyed = true; detachWin(); document.removeEventListener('pointerdown', outside, true);
        window.removeEventListener('f13ui-section', onSection);
        for (const x of [hs, os]) if (x) x.destroy();
        ov.remove(); host.innerHTML = ''; host.classList.remove('lq-wsd', 'lq-wsd-open'); host.style.width = '';
      }
    };
  };

  // ---- demo ----
  Liquid.uiDemo.push({
    id: 'send', title: 'Send',
    note: 'Header action: targets bud out of the button, each with a label chip.',
    mount(host) {
      host.innerHTML = `
<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0 6px 4px;border-bottom:1px solid var(--hair)">
  <b style="font-size:15px;font-weight:650;color:var(--ink)">Gyroid lattice</b>
  <div class="s1"></div>
</div>
<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">
  <button class="toggle" data-a="lab" aria-pressed="false">Lab busy</button>
  <button class="toggle" data-a="more" aria-pressed="false">Choose queue</button>
</div>
<p class="out" style="margin-top:10px;font-size:13px;color:var(--ink-faint)">sent: none</p>`;
      const out = host.querySelector('.out');
      const s1 = Liquid.ui.send(host.querySelector('.s1'), {
        label: 'Send', icon: 'send', accent: 'lime', ariaLabel: 'Send to',
        items: [{ id: 'queue', label: 'Queue', icon: 'queue' }, { id: 'mesh', label: 'Mesh', icon: 'layers' },
          { id: 'lab', label: 'Lab', icon: 'flask' }, { id: 'json', label: 'Export JSON', icon: 'download' }],
        onSelect(id) { out.textContent = 'sent: ' + id; }
      });
      const tb = host.querySelector('[data-a=lab]');
      tb.addEventListener('click', () => {
        const on = tb.getAttribute('aria-pressed') !== 'true'; tb.setAttribute('aria-pressed', on);
        s1.setItemState('lab', { disabled: on, label: on ? 'Lab (busy)' : 'Lab' });
      });
      const BASE = [{ id: 'queue', label: 'Queue', icon: 'queue' }, { id: 'mesh', label: 'Mesh', icon: 'layers' },
        { id: 'lab', label: 'Lab', icon: 'flask' }, { id: 'json', label: 'Export JSON', icon: 'download' }];
      const mb = host.querySelector('[data-a=more]');
      mb.addEventListener('click', () => {
        const on = mb.getAttribute('aria-pressed') !== 'true'; mb.setAttribute('aria-pressed', on);
        const list = BASE.slice(); if (on) list.splice(1, 0, { id: 'choose', label: 'Choose queue…', icon: 'folder' });
        s1.setItems(list); tb.setAttribute('aria-pressed', 'false');
      });
      return { redraw() { s1.redraw(); }, s1 };
    }
  });
})();

/* ---- widgets/slider.js ---- */
/* Liquid slider widget (meniscus slider with detents).
   Bead rides in a filleted dip cut through a slim track; flood liquid fills the track up to the
   bead and smooth-unions into it. Detents are small notch pairs carved into the track edges
   (the flood pinches through them). Released within snapPx of a detent, a drop forms in the
   socket, the bead necks toward it and flows in (magnetic liquid snap). Typed values never snap. */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
(() => {
  'use strict';
  const INK = 'var(--lq-ink, var(--ink, oklch(0.97 0.01 290)))';
  const DIM = 'var(--lq-ink-dim, var(--ink-dim, oklch(0.78 0.02 290)))';
  const FAINT = 'var(--lq-ink-faint, var(--ink-faint, oklch(0.62 0.02 290)))';
  const MONO = 'var(--lq-mono, ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace)';
  const ACC = 'oklch(var(--al) var(--ac) var(--ah))';
  const CSS = `
.lq-sl{ position:relative; height:52px; overflow-x:clip; user-select:none; -webkit-user-select:none; -webkit-tap-highlight-color:transparent;
  font-family:var(--lq-font, inherit); }
.lq-sl-track{ position:absolute; left:0; right:0; top:12px; bottom:-4px; touch-action:pan-y; cursor:pointer; outline:none; }
.lq-sl-ring{ position:absolute; pointer-events:none; border-radius:999px; opacity:0; transition:opacity 140ms ease-out;
  box-shadow:0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .45); }
.lq-sl-track:focus-visible .lq-sl-ring{ opacity:1; }
.lq-sl-head{ position:absolute; left:0; right:0; top:0; height:18px; display:flex; align-items:center; gap:6px; pointer-events:none; }
.lq-sl-label{ flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:13px; font-weight:550; line-height:18px; color:${DIM}; }
.lq-sl-val{ position:relative; flex:none; pointer-events:auto; background:none; border:0; margin:0; padding:0 2px; border-radius:5px;
  font:inherit; font-family:${MONO}; font-size:13px; line-height:18px; font-variant-numeric:tabular-nums; color:${INK};
  cursor:text; white-space:nowrap; transition:color 140ms ease-out; }
.lq-sl-val::before{ content:''; position:absolute; right:-8px; width:max(calc(100% + 22px), 52px); top:-4px; bottom:-7px; }   /* hit area 44 wide even for 1-char values, 29 tall: it stops above the track bar so it never covers the thumb (the value sits at the host's right edge, which clips the 8 px; it grows leftwards) */
.lq-sl-val:focus-visible{ outline:none; box-shadow:0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .45); }
.lq-sl-unit{ margin-left:.35em; color:${DIM}; }
.lq-sl.grab .lq-sl-num{ color:${ACC}; }
.lq-sl-hint{ flex:none; font-family:${MONO}; font-size:11px; line-height:18px; color:${FAINT}; white-space:nowrap; }
.lq-sl-hint:empty{ display:none; }
.lq-sl-input{ flex:none; pointer-events:auto; width:9ch; height:22px; margin:-2px 0; padding:0 6px; border:0; border-radius:6px;
  background:oklch(1 0 0 / .07); box-shadow:inset 0 0 0 1px oklch(var(--al) var(--ac) var(--ah) / .6); outline:none;
  font-family:${MONO}; font-size:13px; text-align:right; color:${INK}; caret-color:${ACC}; }
.lq-sl-input.bad{ box-shadow:inset 0 0 0 1px oklch(0.7 0.17 22 / .9); animation:lq-sl-shake 220ms ease-in-out; }
@keyframes lq-sl-shake{ 25%{ transform:translateX(-3px) } 75%{ transform:translateX(3px) } }
.lq-sl.dis{ opacity:.45; }
.lq-sl.dis .lq-sl-track, .lq-sl.dis .lq-sl-val{ cursor:default; }
@media (prefers-reduced-motion: reduce){ .lq-sl-input.bad{ animation:none; } }`;
  function injectCSS() {
    if (document.getElementById('lq-ui-slider-css')) return;
    const s = document.createElement('style'); s.id = 'lq-ui-slider-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  // The host clips overflow-x (a widget must never cause horizontal scroll). So glow and shadow are
  // faded out toward the side edges, except inside a stadium around the control, which stays crisp.
  // cx: cap centre inset from the host edge, cy: centre y, rc: cap radius (all host px).
  function edgeMask(canvas, B, cx, cy, rc) {
    const y0 = B + cy - rc, y1 = B + cy + rc, f = 1.5, s = canvas.style;
    const img = [
      `linear-gradient(90deg, transparent ${B}px, #000 ${B + 20}px, #000 calc(100% - ${B + 20}px), transparent calc(100% - ${B}px))`,
      `linear-gradient(180deg, transparent ${y0 - f}px, #000 ${y0 + f}px, #000 ${y1 - f}px, transparent ${y1 + f}px)`,
      `radial-gradient(circle at ${B + cx}px ${B + cy}px, #000 ${rc - f}px, transparent ${rc + f}px)`,
      `radial-gradient(circle at calc(100% - ${B + cx}px) ${B + cy}px, #000 ${rc - f}px, transparent ${rc + f}px)`].join(',');
    const size = `100% 100%, calc(100% - ${2 * (B + cx)}px) 100%, 100% 100%, 100% 100%`;
    s.webkitMaskImage = s.maskImage = img;
    s.webkitMaskSize = s.maskSize = size;
    s.webkitMaskPosition = s.maskPosition = 'center';
    s.webkitMaskRepeat = s.maskRepeat = 'no-repeat';
  }
  const NDET = 24;
  const GLSL = `
#define BULGE 8.0
#define SHADOW_DY 5.0
uniform vec4 uTrack;          // x0, cy, x1, half height
uniform vec2 uHead, uTail;
uniform vec3 uBead;           // radius, scale x, scale y
uniform float uRn, uDipK;
uniform vec3 uMag;            // socket x, drop radius, strength 0..1
uniform vec2 uNotch;          // notch radius, notch centre offset past the track edge
uniform float uDet[${NDET}];  // detent x (px); < -9000 ends the list
float beadSD(vec2 p){ vec2 s = uBead.yz; return (length((p - uHead)/s) - uBead.x)*min(s.x, s.y); }
float trackSD(vec2 p){
  vec2 c = vec2((uTrack.x + uTrack.z)*.5, uTrack.y);
  return sdRoundBox(p - c, vec2((uTrack.z - uTrack.x)*.5, uTrack.w), uTrack.w);
}
float notchSD(vec2 p){
  float d = 1e5, ay = abs(p.y - uTrack.y), oy = uTrack.w + uNotch.y;
  for (int i = 0; i < ${NDET}; i++){
    float x = uDet[i];
    if (x < -9000.) break;
    d = min(d, length(vec2(p.x - x, ay - oy)) - uNotch.x);
  }
  return d;
}
float railSD(vec2 p){ return ssub(trackSD(p), notchSD(p), 1.0); }
float bodySDF(vec2 p){ return ssub(railSD(p), sdTaper(p, uHead, uTail, uRn, uRn*0.9), uDipK); }
float accentSDF(vec2 p){
  float R = uBead.x;
  float b = beadSD(p);
  // trailing neck: a fast jump drags a thinning tail behind the bead
  b = smin(b, smin(sdTaper(p, uHead, uTail, R*0.5, R*0.28), length(p - uTail) - R*0.36, 4.), 5.);
  // magnetic snap: a drop forms in the socket and a neck pulls the bead into it
  if (uMag.z > 0.002) {
    vec2 D = vec2(uMag.x, uTrack.y);
    float g = smin(sdTaper(p, uHead, D, R*0.42, uMag.y*0.75), length(p - D) - uMag.y, 3.) + (1. - uMag.z)*7.;
    b = smin(b, g, 5.);
  }
  return b;
}
#define HAS_FLOOD
float floodSDF(vec2 p){
  float r = uTrack.w - 2.0;
  vec2 a = vec2(uTrack.x + uTrack.w, uTrack.y), e = vec2(max(uHead.x, a.x), uTrack.y);
  return smin(max(sdCapsule(p, a, e, r), railSD(p) + 1.5), beadSD(p) + 1., 6.);
}`;

  // ---------- number parsing: "0.25", "-1.5", "1/8", "1 1/2", "⅜", "1⅛", "0,5", "2 mm" ----------
  const VULGAR = { '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8, '⅓': 1 / 3, '⅔': 2 / 3,
    '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5, '⅙': 1 / 6, '⅚': 5 / 6 };
  function parseNumber(str) {
    let s = String(str).trim().replace(/[−‒–—]/g, '-').replace(/⁄/g, '/');
    s = s.replace(/\s*[a-zA-Zµμ%°]+\.?$/, '').trim();      // trailing unit
    if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(',', '.');                 // decimal comma
    let m = s.match(/^([+-]?)\s*(\d*)\s*([¼½¾⅛⅜⅝⅞⅓⅔⅕⅖⅗⅘⅙⅚])$/);
    if (m) return (m[1] === '-' ? -1 : 1) * ((m[2] ? +m[2] : 0) + VULGAR[m[3]]);
    m = s.match(/^([+-]?)\s*(?:(\d+)\s+)?(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/);
    if (m) { const den = +m[4]; if (!den) return NaN; return (m[1] === '-' ? -1 : 1) * ((m[2] ? +m[2] : 0) + (+m[3]) / den); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return +s;
    return NaN;
  }
  const decimals = x => { const s = String(x); if (/e-/i.test(s)) return Math.min(10, +s.split(/e-/i)[1]); return (s.split('.')[1] || '').length; };
  const resolveAccent = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || Liquid.ACCENTS.lime;
  const clampN = (x, a, b) => (x > a ? (x < b ? x : b) : a);   // NaN -> a
  let uid = 0;

  Liquid.ui.slider = function slider(host, opts = {}) {
    injectCSS();
    const o = {
      min: 0, max: 1, step: 0.01, value: undefined, label: '', unit: '', format: null, parse: null, hint: '',
      detents: [], snapPx: 10, onInput: null, onChange: null, accent: Liquid.ACCENTS.lime, ariaLabel: '', ...opts
    };
    const id = 'lq-sl-' + (++uid);
    host.classList.add('lq-sl');
    host.style.height = '52px';
    host.innerHTML = `
<div class="lq-sl-track" role="slider" tabindex="0" aria-orientation="horizontal"><div class="lq-sl-ring"></div></div>
<div class="lq-sl-head"><span class="lq-sl-label" id="${id}-l"></span><button type="button" class="lq-sl-val" tabindex="-1"><span class="lq-sl-num"></span><span class="lq-sl-unit"></span></button><span class="lq-sl-hint" aria-hidden="true"></span></div>`;
    const track = host.querySelector('.lq-sl-track'), ring = host.querySelector('.lq-sl-ring');
    const labelEl = host.querySelector('.lq-sl-label'), valBtn = host.querySelector('.lq-sl-val');
    const numEl = host.querySelector('.lq-sl-num'), unitEl = host.querySelector('.lq-sl-unit'), hintEl = host.querySelector('.lq-sl-hint');
    track.setAttribute('aria-labelledby', id + '-l');

    // geometry (CSS px in host space). At either end the bead edge sits 1.5px inside the host edge.
    const G = { cy: 36, hh: 6.5, R: 9.5, gap: 2.5, x0: 0, x1: 0, lo: 0, hi: 1, w: 0 };
    const head = new Liquid.Spring(0, { k: 520, zeta: 0.7 });
    const tail = new Liquid.Spring(0, { k: 230, zeta: 0.9 });
    const scale = new Liquid.Spring(1, { k: 700, zeta: 0.45, fixed: true });
    const squash = new Liquid.Spring(0, { k: 650, zeta: 0.42, fixed: true });
    const mag = new Liquid.Spring(0, { k: 1800, zeta: 0.85, fixed: true });
    let value = 0, dets = [], ready = false, dead = false, disabled = false, editing = null;
    let dragging = false, dragX = 0, rawX = 0, grabOff = 0, magX = 0, snapX = null, snapHold = 0;

    const surf = new Liquid.Surface(host, {
      glsl: GLSL, onResize(w) {
        G.w = w; G.x0 = G.R - G.hh + 1.5; G.x1 = w - G.x0; G.lo = G.x0 + G.hh; G.hi = Math.max(G.x1 - G.hh, G.lo + 1);
        Object.assign(ring.style, { left: (G.x0 - 3) + 'px', top: (G.cy - 12 - G.hh - 3) + 'px', width: (G.x1 - G.x0 + 6) + 'px', height: (2 * G.hh + 6) + 'px' });
        ready = true;
        if (!dragging) { head.set(xOf(value)); tail.set(head.x); }
        write();
      }
    });
    edgeMask(surf.canvas, surf.bleed, G.R - G.hh + 1.5 + G.hh, G.cy, G.R + 3);

    const clampV = v => Math.min(Math.max(v, o.min), o.max);
    const tidy = v => +(+v).toFixed(10);
    const quantize = v => { const s = o.step > 0 ? o.step : 0; return tidy(clampV(s ? o.min + Math.round((v - o.min) / s) * s : v)); };
    const span = () => (o.max - o.min) || 1;
    const xOf = v => G.lo + (G.hi - G.lo) * (clampV(v) - o.min) / span();
    const vOf = x => o.min + Math.min(Math.max((x - G.lo) / (G.hi - G.lo), 0), 1) * span();
    function fmt(v) {
      if (o.format) return String(o.format(v));
      const d = Math.min(decimals(o.step), 8);
      let s = v.toFixed(d);
      if (Math.abs(+s - v) > 1e-9) s = String(+v.toFixed(Math.min(d + 3, 10)));   // typed off-grid value: show it
      return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
    }
    const parse = s => { const n = o.parse ? o.parse(s) : parseNumber(s); return typeof n === 'number' ? n : NaN; };

    function applyOptions() {
      surf.setAccent(resolveAccent(o.accent));
      labelEl.textContent = o.label;
      if (o.ariaLabel) track.setAttribute('aria-label', o.ariaLabel); else track.removeAttribute('aria-label');
      valBtn.setAttribute('aria-label', 'Edit ' + (o.label || o.ariaLabel || 'value'));
      unitEl.textContent = o.unit || '';
      track.setAttribute('aria-valuemin', o.min); track.setAttribute('aria-valuemax', o.max);
      dets = [...new Set((o.detents || []).map(Number).filter(d => isFinite(d) && d >= o.min - 1e-12 && d <= o.max + 1e-12))].sort((a, b) => a - b);
    }
    function render() {
      const t = fmt(value);
      numEl.textContent = t;
      const h = typeof o.hint === 'function' ? o.hint(value) : o.hint;
      hintEl.textContent = h == null ? '' : String(h);
      track.setAttribute('aria-valuenow', value);
      track.setAttribute('aria-valuetext', t + (o.unit ? ' ' + o.unit : '') + (hintEl.textContent ? ', ' + hintEl.textContent : ''));
    }

    function nearestDetent(x) {
      let best = null;
      for (const d of dets) { const dist = Math.abs(xOf(d) - x); if (!best || dist < best.dist) best = { v: d, x: xOf(d), dist }; }
      return best;
    }
    function rubber(x) {   // short overdrag: the bead presses into the end and squashes
      if (x < G.lo) return G.lo - 2 * (1 - Math.exp((x - G.lo) / 30));
      if (x > G.hi) return G.hi + 2 * (1 - Math.exp((G.hi - x) / 30));
      return x;
    }

    function write() {
      if (!ready || dead) return;
      const red = Liquid.state.reduce;
      const sq = red ? 0 : squash.x;
      const st = red ? 0 : Math.min(Math.abs(head.v) / 3200, 0.16);
      // bead scales stay in a sane band: a scale <= 0 flips the field's sign and floods the canvas
      const sx = clampN((1 - sq) * (1 + st) * scale.x, 0.5, 1.6), sy = clampN((1 + sq * 0.6) / (1 + st) * scale.x, 0.5, 1.6);
      const hx = clampN(head.x, G.x0 - G.R, G.x1 + G.R), tx = clampN(tail.x, G.x0 - G.R, G.x1 + G.R);
      surf.set('uTrack', G.x0, G.cy, G.x1, G.hh).set('uRn', G.R + G.gap).set('uDipK', Math.min(Math.max(Liquid.state.melt * 0.35, 1.5), 5))
        .set('uHead', hx, G.cy).set('uTail', tx, G.cy).set('uBead', G.R, sx, sy)
        .set('uMag', clampN(magX, G.x0, G.x1), 4.2, clampN(mag.x, 0, 1.2)).set('uNotch', 3.1, 0.7);
      const dx = dets.map(xOf).filter(x => x > G.lo + 1 && x < G.hi - 1);   // end stops need no notch
      for (let i = 0; i < NDET; i++) surf.set(`uDet[${i}]`, i < dx.length ? dx[i] : -1e4);
      surf.draw();
    }

    const anim = Liquid.animator(dt => {
      if (dead) return false;
      if (!ready) return false;
      dt = clampN(dt, 0, 1 / 30);   // never integrate backwards or across a stall (core also guards this)
      const red = Liquid.state.reduce;
      let magT = 0;
      if (dragging) {
        head.target = dragX; head.k = 2200; head.zeta = 1; head.fixed = true;
        const nd = nearestDetent(Math.min(Math.max(rawX, G.lo), G.hi));
        if (nd && nd.dist < o.snapPx) {
          if (Math.abs(nd.x - magX) > 0.5 && mag.x > 0.04) magT = 0;   // let the old drop drain before moving sockets
          else { magX = nd.x; magT = 0.7 * (1 - nd.dist / o.snapPx); }
        }
      } else if (snapX !== null) {
        magX = snapX; magT = 1;
        snapHold -= dt;
        head.k = 900; head.zeta = 0.5; head.fixed = false;
        if (snapHold <= 0) head.target = snapX;
        if (Math.abs(head.x - snapX) < 1.2 && snapHold <= 0) { snapX = null; squash.v -= 4; Liquid.haptic(); }   // drops in: brief flatten
      } else { head.target = xOf(value); head.k = 520; head.zeta = 0.7; head.fixed = false; }
      tail.target = head.x;
      scale.target = dragging ? 1.05 : 1;
      const over = Math.max(G.lo - rawX, rawX - G.hi, 0);
      squash.target = dragging ? 0.2 * (1 - Math.exp(-over / 60)) : 0;
      mag.target = red ? 0 : magT;
      Liquid.stepSprings([head, tail, scale, squash, mag], dt);
      // hard limits: head/tail stay on the track (± a bead), velocities stay physical, scales stay positive
      const lo = G.x0 - G.R, hi = G.x1 + G.R;
      for (const s of [head, tail]) { if (!(s.x >= lo && s.x <= hi)) { s.x = clampN(s.x, lo, hi); s.v = 0; } s.v = clampN(s.v, -9000, 9000); }
      scale.x = clampN(scale.x, 0.6, 1.4); scale.v = clampN(scale.v, -12, 12);
      squash.x = clampN(squash.x, -0.3, 0.35); squash.v = clampN(squash.v, -12, 12);
      mag.x = clampN(mag.x, -0.2, 1.2); mag.v = clampN(mag.v, -40, 40);
      if (red) tail.set(head.x);
      const lag = tail.x - head.x, maxLag = G.R * 1.8;   // keep the trailing neck short: a drop, not a comet
      if (Math.abs(lag) > maxLag) { tail.x = head.x + Math.sign(lag) * maxLag; tail.v = head.v; }
      const done = !dragging && snapX === null && head.settled() && tail.settled() && scale.settled(0.003) &&
        squash.settled(0.003) && mag.settled(0.003) && Math.abs(tail.x - head.x) < 0.25;
      if (done) { head.snap(); tail.set(head.x); scale.snap(); squash.snap(); mag.set(0); }
      write();
      return !done;
    });

    let lastEmit = null;
    const emitInput = v => { if (v !== lastEmit) { lastEmit = v; o.onInput && o.onInput(v); } };
    function commit(v, { snap = false } = {}) {
      const prev = value;
      value = v; render();
      emitInput(v);
      o.onChange && o.onChange(v);
      const far = Math.abs(head.x - xOf(v));
      if (snap && !Liquid.state.reduce && far > 1 && far <= o.snapPx + G.R * 0.5) { snapX = xOf(v); snapHold = 0.06; }
      if (prev !== v) Liquid.haptic();
      anim.wake();
    }

    // ---------- pointer: mouse/pen drag at once; touch waits for horizontal intent (page can still scroll) ----------
    let ptr = null;
    const loc = e => { const r = host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function begin(x, e) {
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      if (editing) editing.finish(true);
      dragging = true; host.classList.add('grab'); snapX = null;
      grabOff = Math.abs(x - head.x) < G.R + 10 ? head.x - x : 0;   // grab the bead where it is; elsewhere jump there
      moveTo(x);
    }
    function moveTo(x) {
      rawX = x + grabOff; dragX = rubber(rawX);
      value = quantize(vOf(rawX)); render(); emitInput(value);
      anim.wake();
    }
    function release() {
      dragging = false; host.classList.remove('grab');
      const x = Math.min(Math.max(rawX, G.lo), G.hi);
      let v = quantize(vOf(x)), snap = false;
      const nd = nearestDetent(x);
      if (nd && nd.dist <= o.snapPx) { v = nd.v; snap = true; }
      rawX = x; scale.v -= 1.2;
      commit(v, { snap });
    }
    track.addEventListener('pointerdown', e => {
      if (disabled || ptr || (e.pointerType === 'mouse' && e.button !== 0) || !ready) return;
      const [x, y] = loc(e);
      ptr = { id: e.pointerId, touch: e.pointerType === 'touch', x0: x, y0: y, active: false };
      if (!ptr.touch) { ptr.active = true; begin(x, e); }   // mousedown focuses the track natively (no focus ring)
    });
    track.addEventListener('pointermove', e => {
      if (!ptr || e.pointerId !== ptr.id) return;
      if (ptr.active && e.pointerType === 'mouse' && e.buttons === 0) { endPtr(e, false); return; }   // missed pointerup (stall, release off-window)
      const [x, y] = loc(e);
      if (!ptr.active) {
        const dx = x - ptr.x0, dy = y - ptr.y0;
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { ptr = null; return; }          // vertical: page scrolls
        if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) { ptr.active = true; begin(ptr.x0, e); }
        else return;
      }
      moveTo(x);
    });
    const endPtr = (e, cancel) => {
      if (!ptr || e.pointerId !== ptr.id) return;
      const p = ptr; ptr = null;
      if (p.active) release();
      else if (!cancel && p.touch) { begin(p.x0, e); release(); }   // touch tap: jump there
    };
    track.addEventListener('pointerup', e => endPtr(e, false));
    track.addEventListener('pointercancel', e => endPtr(e, true));
    track.addEventListener('lostpointercapture', e => { if (ptr && ptr.active && e.pointerId === ptr.id) endPtr(e, false); });
    const onBlur = () => { if (ptr && ptr.active) { ptr = null; release(); } };   // window lost focus mid-drag: commit where it is
    window.addEventListener('blur', onBlur);

    // value button hit zone overlaps the top of the track (it reaches y = 40 for a 44 px target):
    // a tap there edits the value, a horizontal drag hands over to the track.
    let valPtr = null, valDragged = false;
    valBtn.addEventListener('pointerdown', e => {
      if (disabled || ptr || (e.pointerType === 'mouse' && e.button !== 0) || !ready) return;
      const [x, y] = loc(e);
      valPtr = { id: e.pointerId, x0: x, y0: y, touch: e.pointerType === 'touch' }; valDragged = false;
      try { valBtn.setPointerCapture(e.pointerId); } catch (_) {}
    });
    valBtn.addEventListener('pointermove', e => {
      if (!valPtr || e.pointerId !== valPtr.id) return;
      const [x, y] = loc(e), dx = x - valPtr.x0, dy = y - valPtr.y0;
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { valPtr = null; return; }
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        const v = valPtr; valPtr = null; valDragged = true;
        ptr = { id: v.id, touch: v.touch, x0: v.x0, y0: v.y0, active: true };
        begin(v.x0, e); moveTo(x);
      }
    });
    const valEnd = e => { if (valPtr && e.pointerId === valPtr.id) valPtr = null; };
    valBtn.addEventListener('pointerup', valEnd); valBtn.addEventListener('pointercancel', valEnd);

    // ---------- keyboard ----------
    track.addEventListener('keydown', e => {
      if (disabled) return;
      const k = e.key, step = (o.step > 0 ? o.step : span() / 100) * (e.shiftKey ? 10 : 1);
      let v = null;
      if (k === 'ArrowRight' || k === 'ArrowUp') v = value + step;
      else if (k === 'ArrowLeft' || k === 'ArrowDown') v = value - step;
      else if (k === 'PageUp' || k === 'PageDown') {
        const up = k === 'PageUp', eps = span() * 1e-9;
        if (dets.length) { const n = up ? dets.find(d => d > value + eps) : [...dets].reverse().find(d => d < value - eps); v = n === undefined ? (up ? o.max : o.min) : n; }
        else v = value + (up ? 1 : -1) * span() / 10;
        v = clampV(v);
      }
      else if (k === 'Home') v = o.min;
      else if (k === 'End') v = o.max;
      else if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(); return; }
      if (v === null) return;
      e.preventDefault();
      if (k.startsWith('Arrow')) v = quantize(v);
      v = tidy(clampV(v));
      if (v === value) return;
      scale.v += 0.5;
      commit(v);
    });

    // ---------- typed entry ----------
    function startEdit() {
      if (editing || disabled) return;
      const inp = document.createElement('input');
      inp.className = 'lq-sl-input'; inp.type = 'text'; inp.value = fmt(value);
      inp.spellcheck = false; inp.autocomplete = 'off'; inp.setAttribute('enterkeyhint', 'done');
      inp.setAttribute('aria-label', (o.label || o.ariaLabel || 'Value') + (o.unit ? ` (${o.unit})` : ''));
      valBtn.hidden = true; valBtn.after(inp);
      inp.focus(); inp.select();
      const ed = editing = {
        finish(ok, refocus) {
          if (editing !== ed) return;
          let n = NaN;
          if (ok) n = parse(inp.value);
          editing = null; inp.remove(); valBtn.hidden = false;
          if (ok && isFinite(n)) {
            const v = tidy(clampV(n));   // typed values: clamped, never snapped or stepped
            if (v !== value) commit(v); else render();
          }
          if (refocus) track.focus({ preventScroll: true });
        }
      };
      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!isFinite(parse(inp.value))) { inp.classList.remove('bad'); void inp.offsetWidth; inp.classList.add('bad'); return; }
          ed.finish(true, true);
        } else if (e.key === 'Escape') { e.preventDefault(); ed.finish(false, true); }
      });
      inp.addEventListener('input', () => inp.classList.remove('bad'));
      inp.addEventListener('blur', () => ed.finish(isFinite(parse(inp.value)), false));
    }
    valBtn.addEventListener('click', e => { if (valDragged) { valDragged = false; e.preventDefault(); return; } startEdit(); });

    applyOptions();
    value = quantize(o.value === undefined ? o.min : o.value);
    if (o.value !== undefined && isFinite(+o.value)) value = tidy(clampV(+o.value));
    lastEmit = value;
    render();

    const api = {
      get: () => value,
      set(v, { silent = true, instant = false } = {}) {
        v = tidy(clampV(+v)); if (!isFinite(v)) return api;
        const changed = v !== value;
        value = v; render(); snapX = null;
        if (instant && ready && !dragging) { head.set(xOf(v)); tail.set(head.x); write(); } else anim.wake();
        if (!silent && changed) { emitInput(v); o.onChange && o.onChange(v); } else lastEmit = v;
        return api;
      },
      configure(next = {}) {   // change label, unit, range, step, detents, format, hint, accent
        Object.assign(o, next); applyOptions();
        value = tidy(clampV(value)); render();
        if (ready && !dragging) { head.set(xOf(value)); tail.set(head.x); write(); }
        return api;
      },
      // Change min / max / step / detents after mount. The value is clamped (silently, no callbacks) and the
      // bead jumps to its new position without animation; a drag in progress is left alone.
      setRange({ min = o.min, max = o.max, step = o.step, detents = o.detents } = {}) {
        min = +min; max = +max; step = +step;
        if (!isFinite(min) || !isFinite(max) || max <= min) return api;
        if (editing) editing.finish(false);
        o.min = min; o.max = max; o.step = isFinite(step) && step > 0 ? step : 0; o.detents = detents || [];
        applyOptions();
        value = tidy(clampV(value)); render();
        if (!dragging) { snapX = null; mag.set(0); head.set(xOf(value)); tail.set(head.x); write(); }
        lastEmit = value;
        return api;
      },
      setHint(h) { o.hint = h; render(); return api; },
      setDisabled(b) {
        disabled = !!b; host.classList.toggle('dis', disabled);
        track.setAttribute('aria-disabled', disabled); track.tabIndex = disabled ? -1 : 0; valBtn.disabled = disabled;
        if (disabled && editing) editing.finish(false);
        return api;
      },
      redraw() { write(); return api; },
      focus() { track.focus(); return api; },
      destroy() {
        dead = true; if (editing) editing.finish(false);
        window.removeEventListener('blur', onBlur);
        surf.destroy();
        host.innerHTML = ''; host.classList.remove('lq-sl', 'grab', 'dis'); host.style.height = '';
      }
    };
    return api;
  };
  Liquid.ui.slider.parse = parseNumber;

  // ---------- demo ----------
  const EIGHTHS = ['0', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞', '1'];
  const eighth = v => { const k = Math.round(v * 8); return Math.abs(v * 8 - k) < 1e-6 && k >= 0 && k <= 8 ? EIGHTHS[k] : v.toFixed(2); };
  Liquid.uiDemo.push({
    id: 'slider', title: 'Slider',
    note: 'Release near a detent and the bead necks into its socket. Tap the value to type (1/8 works).',
    mount(host) {
      host.style.display = 'grid'; host.style.rowGap = '16px'; host.style.paddingTop = '6px';
      const mk = () => { const d = document.createElement('div'); host.appendChild(d); return d; };
      const log = document.createElement('div');
      Object.assign(log.style, { font: `11px/16px ${MONO}`, color: FAINT, minHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      const say = (name, kind) => v => { log.textContent = `${kind} ${name} = ${v}`; };
      const ws = [
        Liquid.ui.slider(mk(), { label: 'Cell size', min: 2, max: 12, step: 0.1, value: 5, unit: 'mm', accent: 'aqua',
          onInput: say('cell', 'input'), onChange: say('cell', 'change') }),
        Liquid.ui.slider(mk(), { label: 'Phase shift', min: 0, max: 1, step: 0.01, value: 0.375, accent: 'violet',
          detents: EIGHTHS.map((_, i) => i / 8), format: eighth, onInput: say('phase', 'input'), onChange: say('phase', 'change') }),
        Liquid.ui.slider(mk(), { label: 'Offset', min: -2, max: 2, step: 0.01, value: 0, accent: 'amber', detents: [-2, -1, 0, 1, 2],
          hint: v => (0.115 + 0.04 * v).toFixed(3) + ' mm', onInput: say('offset', 'input'), onChange: say('offset', 'change') })
      ];
      const rr = document.createElement('button'); rr.className = 'toggle'; rr.textContent = 'Re-range cell size'; rr.dataset.a = 'rerange';
      let wide = true;
      rr.addEventListener('click', () => { wide = !wide; ws[0].setRange(wide ? { min: 2, max: 12, step: 0.1 } : { min: 0.5, max: 4, step: 0.05 }); log.textContent = 'range ' + (wide ? '2..12' : '0.5..4') + ' value ' + ws[0].get(); });
      host.appendChild(rr);
      host.appendChild(log);
      host.lqWidgets = ws;
      return { redraw() { ws.forEach(w => w.redraw()); } };
    }
  });
})();

/* ---- widgets/toggle.js ---- */
/* Liquid toggle widget (compact switch for term rows and view menus).
   The knob sits in a filleted dip carved from a pill track (track minus knob-plus-gap). Flipping, the
   head springs across while a tapered tail lags behind it (stretch, neck, merge); ON floods the track
   with accent liquid that pours in behind the knob. Off, the knob is a neutral bead; its tint follows
   the flood. One small Surface per toggle (switch box + 16 px bleed); it only draws while moving. */
Liquid.ui = Liquid.ui || {}; Liquid.uiDemo = Liquid.uiDemo || [];
(() => {
  'use strict';
  const INK = 'var(--lq-ink, var(--ink, oklch(0.97 0.01 290)))';
  const DIM = 'var(--lq-ink-dim, var(--ink-dim, oklch(0.78 0.02 290)))';
  const CSS = `
.lq-tg{ position:relative; height:44px; font-family:var(--lq-font, inherit); -webkit-tap-highlight-color:transparent; }
.lq-tg-btn{ position:relative; display:inline-flex; align-items:center; gap:8px; height:44px; max-width:100%; margin:0; padding:0 8px 0 0; border:0;
  background:none; font:inherit; color:${DIM}; cursor:pointer; text-align:left; border-radius:12px; outline:none; user-select:none; -webkit-user-select:none; }
.lq-tg-btn.nolab{ padding:0; }
.lq-tg.first .lq-tg-btn{ display:flex; width:100%; padding:0 0 0 2px; justify-content:space-between; }
.lq-tg.first .lq-tg-sw{ order:2; }
.lq-tg-sw{ position:relative; flex:none; height:44px; touch-action:pan-y; }
.lq-tg-ring{ position:absolute; pointer-events:none; border-radius:999px; opacity:0; transition:opacity 140ms ease-out;
  box-shadow:0 0 0 2px oklch(var(--al) var(--ac) var(--ah) / .45); }
.lq-tg-btn:focus-visible .lq-tg-ring{ opacity:1; }
.lq-tg-lab{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:550; line-height:18px;
  transition:color 140ms ease-out; }
.lq-tg-btn[aria-checked=true] .lq-tg-lab{ color:${INK}; }
.lq-tg-btn:disabled{ cursor:default; opacity:.45; }`;
  function injectCSS() {
    if (document.getElementById('lq-ui-toggle-css')) return;
    const s = document.createElement('style'); s.id = 'lq-ui-toggle-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  const GLSL = `
#define BULGE 7.0
#define SHADOW_DY 2.5
#define SHADOW_A 0.34
#define SHADOW_R 7.0
uniform vec4 uT;    // track left, centre y, length, half height
uniform vec4 uKb;   // head x, tail x, flood x, stretch
uniform vec3 uKn;   // knob radius, gap, fillet
float knobHead(vec2 p){ vec2 s = vec2(uKb.w, 1. / uKb.w); return (length((p - vec2(uKb.x, uT.y)) / s) - uKn.x) * min(s.x, s.y); }
float trackSD(vec2 p){ return sdRoundBox(p - vec2(uT.x + uT.z * .5, uT.y), vec2(uT.z * .5, uT.w), uT.w); }
float bodySDF(vec2 p){ return ssub(trackSD(p), knobHead(p) - uKn.y, uKn.z); }
float accentSDF(vec2 p){
  vec2 H = vec2(uKb.x, uT.y), T = vec2(uKb.y, uT.y);
  float R = uKn.x;
  return smin(knobHead(p), smin(sdTaper(p, H, T, R * .5, R * .26), length(p - T) - R * .42, R * .35), R * .45);
}
#define HAS_FLOOD
float floodSDF(vec2 p){
  vec2 a = vec2(uT.x + uT.w, uT.y), e = vec2(max(uKb.z, a.x), uT.y);
  return max(sdCapsule(p, a, e, uT.w - 2.5), bodySDF(p) + 2.);
}`;
  const SIZES = { sm: { TW: 34, HH: 8, R: 8.6, gap: 1.6 }, md: { TW: 46, HH: 11, R: 11.8, gap: 2 } };   // knob just overhangs the track
  const resolveAccent = a => (typeof a === 'string' ? Liquid.ACCENTS[a] : a) || Liquid.ACCENTS.lime;
  const clampN = (x, a, b) => (x > a ? (x < b ? x : b) : a);

  Liquid.ui.toggle = function toggle(host, opts = {}) {
    injectCSS();
    const o = { checked: false, label: '', size: 'sm', labelFirst: false, onChange: null, ariaLabel: '', accent: Liquid.ACCENTS.lime, ...opts };
    const S = SIZES[o.size] || SIZES.sm;
    const pad = Math.max((44 - S.TW) / 2, S.R - S.HH + 4);
    const G = { ...S, L: pad, cy: 22, W: S.TW + 2 * pad, x0: pad + S.HH, x1: pad + S.TW - S.HH };
    let on = !!o.checked, disabled = false, dead = false, ready = false;
    let accent = resolveAccent(o.accent);
    const neutral = () => ({ L: 0.8, C: 0.015, h: accent.h });

    host.classList.add('lq-tg'); host.classList.toggle('first', !!o.labelFirst);
    host.style.height = '44px';
    host.innerHTML = `<button type="button" class="lq-tg-btn" role="switch"><span class="lq-tg-sw"><span class="lq-tg-ring"></span></span><span class="lq-tg-lab"></span></button>`;
    const btn = host.firstChild, sw = btn.firstChild, ring = sw.firstChild, lab = btn.lastChild;
    sw.style.width = G.W + 'px';
    Object.assign(ring.style, { left: (G.L - 3) + 'px', top: (G.cy - G.HH - 3) + 'px', width: (G.TW + 6) + 'px', height: (2 * G.HH + 6) + 'px' });
    function applyLabel() {
      lab.textContent = o.label || ''; lab.hidden = !o.label; btn.classList.toggle('nolab', !o.label);
      if (o.ariaLabel || !o.label) btn.setAttribute('aria-label', o.ariaLabel || 'Toggle'); else btn.removeAttribute('aria-label');
    }
    applyLabel();

    const head = new Liquid.Spring(on ? G.x1 : G.x0, { k: 620, zeta: 0.66 });
    const tail = new Liquid.Spring(head.x, { k: 240, zeta: 0.9 });
    const flood = new Liquid.Spring(head.x, { k: 170, zeta: 0.86 });
    let drag = null;   // { id, x0, h0, moved }

    const surf = new Liquid.Surface(sw, { glsl: GLSL, bleed: 16, onResize() { ready = true; write(); } });

    function write() {
      if (!ready || dead) return;
      const red = Liquid.state.reduce;
      const st = red ? 1 : 1 + Math.min(Math.abs(head.v) / 1400, 0.22);
      const lo = G.x0 - G.R, hi = G.x1 + G.R;
      const hx = clampN(head.x, lo, hi), tx = clampN(tail.x, lo, hi), fx = clampN(flood.x, G.x0, G.x1);
      surf.set('uT', G.L, G.cy, G.TW, G.HH).set('uKb', hx, tx, fx, st)
        .set('uKn', G.R, G.gap, clampN(Liquid.state.melt * 0.2, 1, 3));
      const u = clampN((fx - G.x0) / (G.x1 - G.x0), 0, 1);
      surf.setAccent(Liquid.mixAccent(neutral(), accent, u)).setGlow(0.12 + 0.88 * u);   // off: no light
      surf.draw();
    }

    const anim = Liquid.animator(dt => {
      if (dead || !ready) return false;
      dt = clampN(dt, 0, 1 / 30);
      const dragging = !!(drag && drag.moved);
      if (dragging) { head.k = 2400; head.zeta = 1; head.fixed = true; } else { head.target = on ? G.x1 : G.x0; head.k = 620; head.zeta = 0.66; head.fixed = false; }
      tail.target = head.x;
      flood.target = dragging ? Math.max(G.x0, head.x) : (on ? G.x1 : G.x0);   // pours in behind the knob, drains when off
      Liquid.stepSprings([head, tail, flood], dt);
      for (const s of [head, tail, flood]) { s.x = clampN(s.x, G.x0 - G.R, G.x1 + G.R); s.v = clampN(s.v, -4000, 4000); }
      if (Liquid.state.reduce) tail.set(head.x);
      const done = !dragging && head.settled() && tail.settled() && flood.settled() && Math.abs(tail.x - head.x) < 0.25;
      if (done) { head.snap(); tail.set(head.x); flood.snap(); }
      write();
      return !done;
    });

    function mark() { btn.setAttribute('aria-checked', on); }
    function flip(v, user) {
      v = !!v; if (v === on) { anim.wake(); return; }
      on = v; mark();
      if (user) { Liquid.haptic(); o.onChange && o.onChange(on); }
      anim.wake();
    }
    mark();

    // click (pointer tap, label tap, Space/Enter) toggles; a horizontal drag on the switch slides the knob
    let swallow = false;
    btn.addEventListener('click', () => { if (swallow) { swallow = false; return; } if (!disabled) flip(!on, true); });
    const lx = e => e.clientX - sw.getBoundingClientRect().left;
    const rub = x => (x < G.x0 ? G.x0 - (G.x0 - x) * 0.25 / (1 + (G.x0 - x) / 40) : x > G.x1 ? G.x1 + (x - G.x1) * 0.25 / (1 + (x - G.x1) / 40) : x);
    sw.addEventListener('pointerdown', e => {
      if (disabled || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = { id: e.pointerId, x0: lx(e), y0: e.clientY, h0: head.x, moved: false };
    });
    sw.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = lx(e) - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.moved) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // vertical: let the page scroll
        if (Math.abs(dx) < 5) return;
        drag.moved = true; try { sw.setPointerCapture(e.pointerId); } catch (_) {}
      }
      head.target = rub(drag.h0 + dx); anim.wake();
    });
    const end = (e, cancel) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (!d.moved) return;                         // a tap: the click handler flips
      swallow = true; setTimeout(() => { swallow = false; }, 0);
      if (!cancel) flip(head.x + head.v * 0.06 > (G.x0 + G.x1) / 2, true);
      anim.wake();
    };
    sw.addEventListener('pointerup', e => end(e, false));
    sw.addEventListener('pointercancel', e => end(e, true));
    sw.addEventListener('lostpointercapture', e => end(e, false));

    const api = {
      get: () => on,
      set(v, { silent = true, instant = false } = {}) {
        v = !!v; const changed = v !== on;
        on = v; mark();
        if (instant && ready && !drag) { const x = on ? G.x1 : G.x0; head.set(x); tail.set(x); flood.set(x); write(); } else anim.wake();
        if (!silent && changed && o.onChange) o.onChange(on);
        return api;
      },
      setLabel(t) { o.label = t; applyLabel(); return api; },
      setAccent(a) { accent = resolveAccent(a); write(); return api; },
      setDisabled(b) { disabled = !!b; btn.disabled = disabled; if (disabled) drag = null; return api; },
      redraw() { write(); return api; },
      focus() { btn.focus(); return api; },
      destroy() {
        dead = true; surf.destroy();
        host.innerHTML = ''; host.classList.remove('lq-tg', 'first'); host.style.height = '';
      }
    };
    return api;
  };

  // ---------- demo ----------
  Liquid.uiDemo.push({
    id: 'toggle', title: 'Toggle',
    note: 'Compact switches for term rows and view menus. Flip: the knob stretches across, the track floods.',
    mount(host) {
      host.innerHTML = `
<div class="tg-row" style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px"></div>
<div class="tg-menu" style="margin-top:8px;padding:4px 12px;border-radius:14px;background:oklch(1 0 0 / .03);box-shadow:inset 0 0 0 1px var(--hair)"></div>
<p class="out" style="margin-top:8px;font-size:13px;color:var(--ink-faint)">changed: none</p>`;
      const out = host.querySelector('.out'), row = host.querySelector('.tg-row'), menu = host.querySelector('.tg-menu');
      const mk = p => { const d = document.createElement('div'); p.appendChild(d); return d; };
      const say = n => v => { out.textContent = `changed: ${n} = ${v}`; };
      const ws = [];
      [['sin x', true], ['cos y', false], ['sin z', true], ['xyz', false]].forEach(([t, c]) =>
        ws.push(Liquid.ui.toggle(mk(row), { label: t, checked: c, size: 'sm', onChange: say(t) })));
      [['Bounding box', true, 'aqua'], ['Clip cap', false, 'aqua'], ['Axes', true, 'aqua']].forEach(([t, c, a]) =>
        ws.push(Liquid.ui.toggle(mk(menu), { label: t, checked: c, size: 'sm', labelFirst: true, accent: a, onChange: say(t) })));
      const big = mk(host); big.style.marginTop = '6px';
      ws.push(Liquid.ui.toggle(big, { label: 'Auto-run', checked: false, size: 'md', accent: 'violet', onChange: say('auto-run') }));
      host.lqWidgets = ws;
      return { redraw() { ws.forEach(w => w.redraw()); } };
    }
  });
})();
