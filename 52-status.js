/* ============================================================
   F13LD.lab · 52-status.js  (v0.24.0)
   Startup splash hand-off and the status chip in the VIEW row.

   Splash ("Resolve", index.html inline): the wordmark resolves from
   scrambled glyphs while the viewers compile their shaders and bake their
   fields on the geometry worker pool.  labSplashWatch() (called from
   99-init after the first render) hides it once every viewer is ready
   (labViewersPending() = 0) and the wordmark has finished resolving, or
   after LAB_SPLASH_MAX_MS whatever happens.

   Status chip ("Field"): the F13LD mark's two neon waves ripple and the
   centre node pulses while a run is solving; the mark holds still
   otherwise.  The chip replaces the designs-loaded pill, the spinner and
   the solver pill.  10-hardware paintSolverPill and 50-controls
   setSolverSpinner / paintRunProgress drive it:
     state  idle | solving | done | warn | error   (class on #labStatus)
   The brand mark keeps its colours and shape; only the wave phase and
   the node radius move (Matt, 2026-10-08).

   Mobile rules: function declarations, var, no modules.
   ============================================================ */

var LAB_SPLASH_MIN_MS = 1900;    /* the Resolve animation needs about this long */
var LAB_SPLASH_MAX_MS = 15000;   /* never hold the page longer than this */
var LAB_STATUS = { state: 'idle', spinning: false, raf: 0, t0: 0, svg: null, reduce: false };

/* ── Status chip ─────────────────────────────────────────────── */
function labMarkSVG() {
  var c = 'lsClip';
  return '<svg viewBox="0 0 100 100" width="20" height="20" aria-hidden="true"><defs><clipPath id="' + c + '"><path d="M50,5 C91,5 95,9 95,50 C95,91 91,95 50,95 C9,95 5,91 5,50 C5,9 9,5 50,5Z"/></clipPath></defs>' +
    '<path d="M50,5 C91,5 95,9 95,50 C95,91 91,95 50,95 C9,95 5,91 5,50 C5,9 9,5 50,5Z" fill="#111e13" stroke="#1D9E75" stroke-width="5"/>' +
    '<g clip-path="url(#' + c + ')" fill="none">' +
      '<path class="s1" d="M0,31 Q25,21 50,31 Q75,41 100,31" stroke="#2c4e30" stroke-width="3"/>' +
      '<path class="s2" d="M0,69 Q25,59 50,69 Q75,79 100,69" stroke="#2c4e30" stroke-width="3"/>' +
      '<path class="s3" d="M31,0 Q21,25 31,50 Q41,75 31,100" stroke="#2c4e30" stroke-width="3"/>' +
      '<path class="s4" d="M69,0 Q59,25 69,50 Q79,75 69,100" stroke="#2c4e30" stroke-width="3"/>' +
      '<path class="h" d="M0,50 Q25,40 50,50 Q75,60 100,50" stroke="#c8f542" stroke-width="6"/>' +
      '<path class="v" d="M50,0 Q40,25 50,50 Q60,75 50,100" stroke="#c8f542" stroke-width="6"/>' +
      '<circle class="node" cx="50" cy="50" r="7" fill="#c8f542"/>' +
    '</g><path d="M50,5 C91,5 95,9 95,50 C95,91 91,95 50,95 C9,95 5,91 5,50 C5,9 9,5 50,5Z" fill="none" stroke="#1D9E75" stroke-width="5"/></svg>';
}
/* Ripple: the brand curves are quadratics with control-point offset 10;
   t moves that offset as cos(t) (t = 0 is the brand mark exactly). */
function labRippleMark(svg, t) {
  if (!svg) return;
  var a = 10 * Math.cos(t), b = 10 * Math.cos(t + 1.3), s = 10 * Math.cos(t * 0.6 + 0.7);
  if (t === 0) { a = 10; b = 10; s = 10; }
  function hz(y, amp) { return 'M0,' + y + ' Q25,' + (y - amp) + ' 50,' + y + ' Q75,' + (y + amp) + ' 100,' + y; }
  function vt(x, amp) { return 'M' + x + ',0 Q' + (x - amp) + ',25 ' + x + ',50 Q' + (x + amp) + ',75 ' + x + ',100'; }
  var q = function (sel) { return svg.querySelector(sel); };
  q('.h').setAttribute('d', hz(50, a));
  q('.v').setAttribute('d', vt(50, b));
  q('.s1').setAttribute('d', hz(31, s)); q('.s2').setAttribute('d', hz(69, s));
  q('.s3').setAttribute('d', vt(31, s)); q('.s4').setAttribute('d', vt(69, s));
  q('.node').setAttribute('r', t === 0 ? '7' : (7 + 1.6 * Math.sin(t * 2)).toFixed(2));
}
function labStatusInit() {
  var host = document.getElementById('labStatusMark');
  if (!host) return;
  host.innerHTML = labMarkSVG();
  LAB_STATUS.svg = host.querySelector('svg');
  LAB_STATUS.reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function labStatusLoop(ts) {
  if (!LAB_STATUS.spinning) { LAB_STATUS.raf = 0; labRippleMark(LAB_STATUS.svg, 0); return; }
  if (!LAB_STATUS.t0) LAB_STATUS.t0 = ts;
  labRippleMark(LAB_STATUS.svg, (ts - LAB_STATUS.t0) / 520);
  LAB_STATUS.raf = requestAnimationFrame(labStatusLoop);
}
/* on = a run is solving: ripple the mark */
function labStatusSpin(on) {
  LAB_STATUS.spinning = !!on && !LAB_STATUS.reduce;
  if (LAB_STATUS.spinning && !LAB_STATUS.raf) { LAB_STATUS.t0 = 0; LAB_STATUS.raf = requestAnimationFrame(labStatusLoop); }
  if (!on) {
    labRippleMark(LAB_STATUS.svg, 0);
    var bar = document.getElementById('labStatusBar');
    if (bar) bar.style.width = '0%';
  }
}
/* text + state; classMod as paintSolverPill used it: 'live' | 'warn' | 'bad' | '' */
function labStatusSet(text, classMod) {
  var chip = document.getElementById('labStatus'), txt = document.getElementById('solverPill');
  if (!chip || !txt) return false;
  var t = String(text || '');
  var state = 'idle';
  if (classMod === 'bad') state = 'error';
  else if (/^solving/.test(t)) state = 'solving';
  else if (/complete/.test(t)) state = 'done';
  else if (classMod === 'warn') state = 'warn';
  LAB_STATUS.state = state;
  chip.className = 'lab-status ' + state;
  txt.textContent = state === 'done' ? '✓ ' + t : (state === 'error' ? '✕ ' + t : t);
  return true;
}
/* run progress 0…1 (50-controls paintRunProgress) */
function labStatusProgress(p) {
  if (LAB_STATUS.state !== 'solving') return;
  var bar = document.getElementById('labStatusBar'), txt = document.getElementById('solverPill');
  var pct = Math.max(0, Math.min(100, Math.floor(p * 100)));
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = 'solving · ' + pct + '%';
}

/* ── Splash ──────────────────────────────────────────────────── */
function labSplashHide() {
  var sp = document.getElementById('labSplash');
  if (!sp || sp.classList.contains('out')) return;
  sp.classList.add('out');
  setTimeout(function () { if (sp.parentNode) sp.parentNode.removeChild(sp); }, 600);
}
function labSplashWatch() {
  var sp = document.getElementById('labSplash');
  if (!sp) return;
  var t0 = window.LAB_SPLASH_T0 || Date.now(), sub = document.getElementById('labSplashSub');
  function poll() {
    var el = Date.now() - t0;
    var pend = (typeof labViewersPending === 'function') ? labViewersPending() : 0;
    if (sub) sub.textContent = pend ? 'preparing viewers · ' + pend + ' to go' : 'ready';
    if ((pend === 0 && el >= LAB_SPLASH_MIN_MS) || el >= LAB_SPLASH_MAX_MS) { labSplashHide(); return; }
    setTimeout(poll, 120);
  }
  poll();
}

labStatusInit();
