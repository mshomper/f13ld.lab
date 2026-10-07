/* ============================================================
   F13LD.lab · 63-sweep-atlas.js  (v0.12.0)
   Sweep Atlas — an in-lab explorer for parameter-sweep results.

   Opens from the Sweep panel over the current sweep and refreshes as
   runs finish.  Linked views of one selected run:
     · cell geometry (the lab's ray-marcher, 1 cell or 2×2×2)
     · directional Young's modulus surface (the lab's stiffness viz)
     · readout, connectivity class, checks and the 6×6 stiffness matrix
     · parameter map (builder sweeps) / run list (CSV sweeps)
     · stiffness vs solid fraction for the selected series
     · design space — every run; click to select
     · 3-D stiffness surface over two swept parameters (v0.12)
     · data check generated from the runs
   v0.12: CAD tumble on every 3-D view (linkable geometry ↔ stiffness), smooth run slider.
   Charts are lab-native SVG (hover readouts, log axes, click to select).
   F13LD brand colors on the lab's dark theme.
   ============================================================ */

/* v0.19.0 — axis value suffix and label note for builder axes stepped by
   solid fraction (%) or by thinnest feature (mm). */
function atlasAxSuffix(ax) { return ax && ax.byVf ? '%' : (ax && ax.byFeat ? ' mm' : ''); }
function atlasAxNote(ax) { return ax && ax.byVf ? ' (target solid %)' : (ax && ax.byFeat ? ' (target thinnest feature, mm)' : ''); }

var ATLAS_COL = {
  bg: '#06080f', panel: '#111118', panel2: '#0e0e1a', line: '#2a2a3a', lineSoft: '#1a1a2a',
  ink: '#e0e0ff', ink2: '#b8b8d0', mute: '#888', dim: '#555', head: '#7c8aaa',
  green: '#1D9E75', neon: '#c8f542', lab: '#fbbf24', cyan: '#22d3ee', rose: '#fb7185',
  ax: ['#fb7185', '#c8f542', '#22d3ee'],                    /* x, y, z */
  cls: ['#7c8aaa', '#fbbf24', '#1D9E75']                    /* strands, partial, connected */
};
var ATLAS_CLASS = ['Strands only', 'Partially connected', 'Connected 3-D lattice'];
var ATLAS_CLASS_TIP = [
  'One stiff direction: separate strands or fibres, no stiffness across them and no shear.',
  'Connected in some directions but not others: some stretch or shear modes carry almost no load.',
  'Connected in 3-D: every stretch and shear mode carries load.'];
var ATLAS_SHAPES = ['circle', 'diamond', 'square', 'triangle', 'cross'];

var ATLAS = { open: false, sel: null, series: null, metric: 'max', mapMetric: 'class', mode: 'grid', units: 'norm', tiles: 1, rm: null, sv: null,
              link: true, camGeo: null, camSurf: null, s3: { metric: 'max', log: true, color: 'value', cam: null } };

/* ── Data ─────────────────────────────────────────────────── */
function atlasJacobiEig(A) {
  var n = 6, a = A.slice(), i, j;
  for (var sweep = 0; sweep < 60; sweep++) {
    var off = 0;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
    if (off < 1e-30) break;
    for (var p = 0; p < n; p++) for (var q = p + 1; q < n; q++) {
      var apq = a[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      var th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      var t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      var c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (var k = 0; k < n; k++) {
        var akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (var k2 = 0; k2 < n; k2++) {
        var apk = a[p * n + k2], aqk = a[q * n + k2];
        a[p * n + k2] = c * apk - s * aqk; a[q * n + k2] = s * apk + c * aqk;
      }
    }
  }
  var out = []; for (i = 0; i < n; i++) out.push(a[i * n + i]);
  return out.sort(function (x, y) { return y - x; });
}
function atlasFull(Cu) {
  var C = new Array(36);
  for (var i = 0; i < 6; i++) for (var j = i; j < 6; j++) { var v = Cu['C' + (i + 1) + (j + 1)]; C[i * 6 + j] = C[j * 6 + i] = v; }
  return C;
}
/* Directional modulus E(n) from a (regularized) compliance. */
function atlasEdir(S, n) {
  var v = [n[0] * n[0], n[1] * n[1], n[2] * n[2], n[1] * n[2], n[0] * n[2], n[0] * n[1]], q = 0;
  for (var i = 0; i < 6; i++) for (var j = 0; j < 6; j++) q += v[i] * S[i * 6 + j] * v[j];
  return q > 0 ? 1 / q : 0;
}
function atlasCompliance(C) {
  var d = 0; for (var i = 0; i < 6; i++) d = Math.max(d, C[i * 7]);
  var R = C.slice(); for (var k = 0; k < 6; k++) R[k * 7] += 1e-6 * d;   /* disconnected directions read near zero, not infinite */
  return invert6x6(R);
}

/* One record per finished run, in the chosen value mode. */
function atlasRows() {
  var rows = [], useExt = ATLAS.mode === 'ext';
  SWEEP_STATE.runs.forEach(function (run, idx) {
    var r = SWEEP_STATE.results[run.id];
    if (!r || r.error) return;
    var src = (useExt && r.ext && r.ext.Ex != null) ? r.ext : r;
    var Cu = src.C || r.C, C = atlasFull(Cu), eig = atlasJacobiEig(C);
    var emax = eig[0], cnt = eig.filter(function (e) { return e > 0.01 * emax; }).length;
    var cls = cnt >= 6 ? 2 : (cnt <= 1 ? 0 : 1);
    rows.push({ run: run, res: r, idx: idx, vf: (r.vf_partial != null ? r.vf_partial : r.vf_solved) / 100, C: C, eig: eig, cls: cls, ext: src !== r,
      Ex: src.Ex, Ey: src.Ey, Ez: src.Ez, Gyz: src.Gyz, Gxz: src.Gxz, Gxy: src.Gxy });
  });
  return rows;
}
function atlasSeriesKey(run) {
  if (SWEEP_STATE.axes && SWEEP_STATE.axes.length > 1 && run.grid) return 'j' + run.grid[1];
  if (SWEEP_STATE.axes) return 'all';
  return run.set || 'all';
}
function atlasSeriesLabel(key) {
  if (key === 'all') return SWEEP_STATE.axes ? SWEEP_STATE.axes[0].label + ' sweep' : 'All runs';
  if (key.charAt(0) === 'j' && SWEEP_STATE.axes && SWEEP_STATE.axes[1]) {
    var ax = SWEEP_STATE.axes[1], v = ax.values[+key.slice(1)];
    return ax.label + ' = ' + sweepFmtVal(v) + (ax.unit ? ' ' + ax.unit : '');
  }
  return key;
}
function atlasSeries(rows) {
  var m = {}, order = [];
  rows.forEach(function (r) { var k = atlasSeriesKey(r.run); if (!m[k]) { m[k] = []; order.push(k); } m[k].push(r); });
  order.forEach(function (k) {
    m[k].sort(function (a, b) {
      if (a.run.grid && b.run.grid) return a.run.grid[0] - b.run.grid[0];
      return a.vf - b.vf;
    });
  });
  if (SWEEP_STATE.axes && SWEEP_STATE.axes.length > 1) order.sort(function (a, b) { return +a.slice(1) - +b.slice(1); });
  return { map: m, order: order };
}

/* ── CAD tumble (v0.12) ──────────────────────────────────────
   One controller per Atlas view.  Orientation Q (row-major 3×3) maps model → view
   (x right, y up, z toward the viewer).  Left-drag tumbles about the screen axes, so
   the part follows the cursor and can roll over the top; right-, middle- or
   shift-drag pans; the wheel zooms toward the cursor; double-click goes home.
   Pan is in screen units (short side of the view = 1), zoom is a factor (1 = home). */
function atlasM3mul(A, B) {
  var C = new Array(9);
  for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}
function atlasRotX(a) { var c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
function atlasRotY(a) { var c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
function atlasOrtho(Q) {   /* re-orthonormalize (Gram–Schmidt on rows) so repeated drags don't drift */
  var r0 = Q.slice(0, 3), r1 = Q.slice(3, 6), n = Math.hypot(r0[0], r0[1], r0[2]);
  r0 = r0.map(function (v) { return v / n; });
  var d = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2];
  r1 = r1.map(function (v, i) { return v - d * r0[i]; }); n = Math.hypot(r1[0], r1[1], r1[2]); r1 = r1.map(function (v) { return v / n; });
  var r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]];
  return r0.concat(r1, r2);
}
/* Isometric home: the (+x, +y, +z) corner faces the viewer, +y up. */
var ATLAS_HOME_ISO = atlasM3mul(atlasRotX(Math.atan(1 / Math.SQRT2)), atlasRotY(-Math.PI / 4));

function AtlasCam(el, home, onChange) {
  this.el = el; this.home = home.slice(); this.onChange = onChange;
  this.Q = home.slice(); this.zoom = 1; this.panX = 0; this.panY = 0;
  this.peer = null;
  var self = this, drag = null;
  el.style.touchAction = 'none';
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  el.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('button,select,input')) return;
    var pan = e.button === 1 || e.button === 2 || e.shiftKey;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: pan, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.classList.add(pan ? 'at-panning' : 'at-tumbling');
    e.preventDefault();
  });
  el.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y, m = Math.max(1, Math.min(el.clientWidth, el.clientHeight));
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) { self.panX += dx / m; self.panY -= dy / m; self.changed(false); }
    else {
      var k = Math.PI / m;   /* half a turn across the short side of the view */
      self.Q = atlasOrtho(atlasM3mul(atlasM3mul(atlasRotY(dx * k), atlasRotX(dy * k)), self.Q));
      self.changed(true);
    }
  });
  var up = function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    el.classList.remove('at-panning', 'at-tumbling');
    self.lastDragMoved = drag.moved; drag = null;
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = el.getBoundingClientRect(), m = Math.max(1, Math.min(r.width, r.height));
    var cx = (e.clientX - r.left - r.width / 2) / m, cy = -(e.clientY - r.top - r.height / 2) / m;
    var z2 = Math.min(40, Math.max(0.1, self.zoom * Math.exp(-e.deltaY * 0.0015))), f = z2 / self.zoom;
    self.panX = cx - (cx - self.panX) * f; self.panY = cy - (cy - self.panY) * f; self.zoom = z2;
    self.changed(false);
  }, { passive: false });
  el.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest('button,select,input')) return;
    self.reset();
  });
}
AtlasCam.prototype.changed = function (rotated) {
  if (rotated && this.peer && ATLAS.link) { this.peer.Q = this.Q.slice(); this.peer.onChange(); }
  this.onChange();
};
AtlasCam.prototype.reset = function () {
  this.Q = this.home.slice(); this.zoom = 1; this.panX = 0; this.panY = 0;
  this.changed(true);
};
/* Small x/y/z triad in the corner of a view, drawn from Q. */
function atlasTriad(svg, Q) {
  if (!svg) return;
  var L = 17, c = 24, h = '';
  var ax = [0, 1, 2].map(function (i) { return { i: i, x: Q[i], y: Q[3 + i], z: Q[6 + i] }; }).sort(function (a, b) { return a.z - b.z; });
  ax.forEach(function (a) {
    var x2 = c + a.x * L, y2 = c - a.y * L, col = ATLAS_COL.ax[a.i], op = a.z < -0.2 ? 0.45 : 1;
    h += '<line x1="' + c + '" y1="' + c + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + col + '" stroke-width="2" stroke-linecap="round" opacity="' + op + '"/>' +
         '<text x="' + (c + a.x * (L + 7)).toFixed(1) + '" y="' + (c - a.y * (L + 7) + 3.5).toFixed(1) + '" fill="' + col + '" opacity="' + op + '" text-anchor="middle">' + 'xyz'[a.i] + '</text>';
  });
  svg.innerHTML = h;
}

/* ── Units ────────────────────────────────────────────────── */
/* Material for "show in MPa": the one picked in the run controls, or else the
   swept design's own recipe material. */
function atlasMaterial() {
  var m = (typeof materialForSolver === 'function' && typeof MATERIAL_STATE !== 'undefined') ? materialForSolver(MATERIAL_STATE.id) : null;
  if (m && m.Es_MPa > 0) return m;
  var run = SWEEP_STATE.runs[0], rec = null;
  try { rec = run ? sweepRecipeForRun(run) : null; } catch (e) { rec = null; }
  var rm = rec && rec.material;
  if (rm && rm.Es_MPa > 0) return { name: rm.name || ('MPa · E solid ' + (rm.Es_MPa >= 1000 ? +(rm.Es_MPa / 1000).toPrecision(3) + ' GPa' : +rm.Es_MPa.toPrecision(3) + ' MPa')), Es_MPa: rm.Es_MPa };
  return null;
}
function atlasEs() { return ATLAS.units === 'norm' ? null : atlasMaterial(); }
function atlasFmtE(v) {
  if (v == null || !isFinite(v)) return '—';
  var m = atlasEs();
  if (m) return fmtEngMPa(v * m.Es_MPa);
  if (v === 0) return '0';
  return Math.abs(v) < 1e-3 ? v.toExponential(2) : v.toPrecision(3);
}
function atlasFmt4(v) { if (!isFinite(v)) return '—'; if (v === 0) return '0'; var a = Math.abs(v); return a < 1e-3 ? v.toExponential(2) : v.toPrecision(3); }

/* ── Panel shell ─────────────────────────────────────────── */
function openSweepAtlas() {
  if (ATLAS.open) { atlasUpdate(); return; }
  var rows = atlasRows();
  if (!rows.length) { alert('No finished runs yet. Run part of the sweep first; the Atlas fills in as runs finish.'); return; }
  ATLAS.open = true;
  if (!ATLAS.sel || !rows.some(function (r) { return r.run.id === ATLAS.sel; })) ATLAS.sel = rows[0].run.id;
  var ov = document.createElement('div');
  ov.id = 'atOverlay'; ov.className = 'imp-overlay at-overlay';
  ov.innerHTML =
    '<div class="at-page" role="dialog" aria-label="Sweep Atlas">' +
      '<header class="at-top"><div><div class="at-title">Sweep Atlas <span class="at-ver">' + swEsc(typeof sweepTitle === 'function' ? sweepTitle() : (SWEEP_STATE.name || '')) + '</span></div>' +
        '<div class="at-meta" id="atMeta"></div></div>' +
        '<button class="dc-icon-btn" title="Close" onclick="closeSweepAtlas()">×</button></header>' +
      '<div class="at-controls" id="atControls"></div>' +
      '<div class="at-grid2">' +
        '<section class="at-panel"><div class="at-phead"><h3>Cell geometry</h3><div class="at-hbtns"><div class="at-seg" id="atTiles"></div>' + atlasViewBtns('Geo') + '</div></div>' +
          '<div class="at-view" id="atGeo"><svg class="at-triad" id="atTriadGeo" width="48" height="48"></svg></div><div class="at-sub" id="atGeoInfo"></div></section>' +
        '<section class="at-panel"><div class="at-phead"><h3>Directional Young’s modulus</h3><div class="at-hbtns">' + atlasViewBtns('Surf') + '</div></div>' +
          '<div class="at-view" id="atSurf"><svg class="at-triad" id="atTriadSurf" width="48" height="48"></svg></div><div class="at-sub" id="atSurfInfo"></div></section>' +
      '</div>' +
      '<div class="at-hint">Drag to tumble · right-drag or shift-drag to pan · scroll to zoom · double-click for the home view</div>' +
      '<div class="at-grid2">' +
        '<section class="at-panel"><div id="atStatus" class="at-status"></div><div id="atReadout" class="at-readout"></div>' +
          '<div class="at-phead"><h3>Stiffness matrix</h3><span class="at-sub"><span class="at-divramp"></span> − · 0 · +</span></div>' +
          '<div class="at-mwrap"><table class="at-mat" id="atMat"></table></div><div class="at-sub" id="atSolve"></div></section>' +
        '<section class="at-panel"><div class="at-phead"><h3 id="atMapTitle">Parameter map</h3><div id="atMapCtl"></div></div><div id="atMap"></div><div class="at-legend" id="atMapLegend"></div></section>' +
      '</div>' +
      '<section class="at-panel" id="atS3Panel" hidden><div class="at-phead"><h3>Stiffness surface</h3><div class="at-hbtns" id="atS3Ctl"></div></div>' +
        '<div class="at-sub" id="atS3Sub"></div><div class="at-s3" id="atS3"><canvas id="atS3c"></canvas></div></section>' +
      '<section class="at-panel"><div class="at-phead"><h3>Stiffness vs solid fraction</h3><span class="at-sub" id="atLineSub"></span></div><div id="atLine" class="at-chart"></div></section>' +
      '<section class="at-panel"><div class="at-phead"><h3>Design space</h3><div id="atScatterCtl"></div></div>' +
        '<div class="at-sub">Every finished run. Color is connectivity, shape is series. The dashed line is the Voigt bound (E ≤ solid fraction × E solid). Click a point to select it.</div>' +
        '<div id="atScatter" class="at-chart"></div></section>' +
      '<details class="at-panel at-checks" id="atChecks"></details>' +
      '<div class="at-tip" id="atTip" hidden></div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeSweepAtlas(); });
  atlasMountViews();
  atlasUpdate();
  window.addEventListener('resize', atlasOnResize);
}
function closeSweepAtlas() {
  ATLAS.open = false;
  if (ATLAS.rm) { try { ATLAS.rm.destroy(); } catch (e) {} ATLAS.rm = null; }
  if (ATLAS.sv) { try { ATLAS.sv.destroy(); } catch (e) {} ATLAS.sv = null; }
  ATLAS.camGeo = ATLAS.camSurf = ATLAS.s3.cam = null; ATLAS._ctlSig = null; ATLAS._lastGeo = null; ATLAS._s3Sig = null; ATLAS._s3 = null; ATLAS._s3Hot = null;
  clearTimeout(ATLAS._geoT); ATLAS._geoT = null;
  var ov = swEl('atOverlay'); if (ov) ov.parentNode.removeChild(ov);
  window.removeEventListener('resize', atlasOnResize);
}
var _atRs = 0;
function atlasOnResize() { clearTimeout(_atRs); _atRs = setTimeout(function () { if (ATLAS.open) { ATLAS._ctlSig = null; atlasUpdate(); atlasApplySurfCam(); } }, 150); }

function atlasMountViews() {
  if (typeof LabRaymarcher === 'function') {
    var rm = new LabRaymarcher();
    if (!rm.failed) { ATLAS.rm = rm; rm._extControl = true; swEl('atGeo').appendChild(rm.canvas); rm.setActive(true); ATLAS.rmBaseZoom = rm._u.zoom; }
  }
  if (!ATLAS.rm) swEl('atGeo').insertAdjacentHTML('beforeend', '<div class="at-msg">The geometry viewer needs WebGL2.</div>');
  if (typeof StiffnessViz === 'function') {
    var sv = new StiffnessViz();
    if (!sv.failed) { ATLAS.sv = sv; sv._extControl = true; sv._userInteracted = true; sv.canvas.style.background = 'transparent'; swEl('atSurf').appendChild(sv.canvas); sv.setActive(true); ATLAS.svBaseZoom = sv._u.zoom; }
  }
  if (!ATLAS.sv) swEl('atSurf').insertAdjacentHTML('beforeend', '<div class="at-msg">The stiffness surface needs WebGL2.</div>');
  ATLAS.camGeo = new AtlasCam(swEl('atGeo'), ATLAS_HOME_ISO, atlasApplyGeoCam);
  ATLAS.camSurf = new AtlasCam(swEl('atSurf'), ATLAS_HOME_ISO, atlasApplySurfCam);
  ATLAS.camGeo.peer = ATLAS.camSurf; ATLAS.camSurf.peer = ATLAS.camGeo;
  atlasApplyGeoCam(); atlasApplySurfCam(); atlasPaintLink();
}
/* Geometry: the ray-marcher takes a camera-to-model matrix (Qᵀ), column-major = Q row-major. */
function atlasApplyGeoCam() {
  var c = ATLAS.camGeo; if (!c) return;
  atlasTriad(swEl('atTriadGeo'), c.Q);
  var rm = ATLAS.rm; if (!rm) return;
  var dist = (ATLAS.rmBaseZoom || 20) / c.zoom;
  rm._rotM = new Float32Array(c.Q);
  rm._u.zoom = dist; rm._u.panX = -c.panX * dist / 1.6; rm._u.panY = -c.panY * dist / 1.6;
  rm._dirty = true;
}
/* Stiffness surface: model → view, with z mirrored to suit its depth convention (nearer = smaller z). */
function atlasApplySurfCam() {
  var c = ATLAS.camSurf; if (!c) return;
  atlasTriad(swEl('atTriadSurf'), c.Q);
  var sv = ATLAS.sv; if (!sv) return;
  var Q = c.Q, M = [Q[0], Q[1], Q[2], Q[3], Q[4], Q[5], -Q[6], -Q[7], -Q[8]], cm = new Float32Array(9);
  for (var r = 0; r < 3; r++) for (var k = 0; k < 3; k++) cm[k * 3 + r] = M[r * 3 + k];
  sv._rotM = cm;
  sv._u.zoom = (ATLAS.svBaseZoom || 0.8) * c.zoom;
  var w = sv.canvas.clientWidth || 1, h = sv.canvas.clientHeight || 1, m = Math.min(w, h);
  sv._u.panX = 2 * c.panX * m / w; sv._u.panY = 2 * c.panY * m / h;
  sv._dirty = true;
}
function atlasViewBtns(which) {
  return '<div class="at-seg"><button class="at-link" aria-pressed="true" onclick="atlasToggleLink()" title="Turn the geometry and the stiffness surface together">⛓ linked</button>' +
    '<button onclick="ATLAS.cam' + which + ' && ATLAS.cam' + which + '.reset()" title="Home view (double-click the view)">⌂</button></div>';
}
function atlasToggleLink() {
  ATLAS.link = !ATLAS.link;
  if (ATLAS.link && ATLAS.camGeo && ATLAS.camSurf) { ATLAS.camSurf.Q = ATLAS.camGeo.Q.slice(); atlasApplySurfCam(); }
  atlasPaintLink();
}
function atlasPaintLink() {
  document.querySelectorAll('#atOverlay .at-link').forEach(function (b) {
    b.setAttribute('aria-pressed', String(ATLAS.link)); b.textContent = ATLAS.link ? '⛓ linked' : '⛓ unlinked';
  });
}

/* Called by the sweep loop after each run. */
function atlasOnResult() { if (ATLAS.open) atlasUpdate(true); }

/* Selection changes are coalesced to one update per frame, so dragging the run slider stays smooth. */
function atlasSelect(id) {
  ATLAS.sel = id;
  if (ATLAS._raf) return;
  ATLAS._raf = requestAnimationFrame(function () { ATLAS._raf = 0; atlasUpdate(); });
}
function atlasSet(k, v) { ATLAS[k] = v; atlasUpdate(); }

/* ── Update everything ───────────────────────────────────── */
function atlasUpdate(fromRun) {
  if (!ATLAS.open) return;
  var rows = atlasRows();
  if (!rows.length) return;
  var S = atlasSeries(rows);
  var cur = rows.filter(function (r) { return r.run.id === ATLAS.sel; })[0] || rows[0];
  ATLAS.sel = cur.run.id;
  ATLAS.series = atlasSeriesKey(cur.run);
  var series = S.map[ATLAS.series] || [];
  atlasMeta(rows);
  atlasControls(rows, S, series, cur);
  if (ATLAS._lastGeo !== cur.run.id) atlasGeometrySoon(cur);
  atlasSurface(cur);
  atlasReadout(cur);
  atlasMap(rows, cur);
  atlasLine(series, cur);
  atlasScatter(rows, S, cur);
  atlasS3(rows, cur);
  atlasChecks(rows, S);
}
/* Rebuilding the voxel field for the ray-marcher is the slow part of a selection change:
   do it once the selection has settled (slider released or paused). */
function atlasGeometrySoon(cur) {
  var first = ATLAS._lastGeo == null;
  ATLAS._lastGeo = cur.run.id;
  clearTimeout(ATLAS._geoT);
  if (swEl('atGeoInfo')) swEl('atGeoInfo').textContent = (cur.vf * 100).toFixed(1) + ' % solid' + (first ? '' : ' · updating…');
  ATLAS._geoT = setTimeout(function () { ATLAS._geoT = null; if (ATLAS.open) atlasGeometry(cur); }, first ? 0 : 220);
}

function atlasMeta(rows) {
  var res = rows.map(function (r) { return r.res; });
  var grids = {}, voids = {}, tol = {};
  res.forEach(function (r) { grids[r.N] = 1; if (r.companion) grids[r.companion.N] = 1; voids[r.voidRatio != null ? r.voidRatio : 1e-4] = 1; tol[r.tol] = 1; });
  var total = SWEEP_STATE.runs.length;
  swEl('atMeta').textContent = rows.length + ' of ' + total + ' runs solved · grid ' + Object.keys(grids).join(' / ') +
    ' · void ' + Object.keys(voids).map(function (v) { return (+v).toExponential(0); }).join(' / ') +
    ' · CG ' + Object.keys(tol).map(function (v) { return (+v).toExponential(0); }).join(' / ') +
    ' · islands ' + (res[0] && res[0].connectivity || 'networks');
}

function atlasControls(rows, S, series, cur) {
  var el = swEl('atControls');
  var hasExt = rows.some(function (r) { return r.res.ext; });
  if (!hasExt && ATLAS.mode === 'ext') ATLAS.mode = 'grid';
  var pos = series.indexOf(cur);
  var m = atlasMaterial();
  if (!m && ATLAS.units === 'mat') ATLAS.units = 'norm';
  var label = function (r) {
    if (r.run.params) return r.run.params.map(function (p) { return p.name + ' ' + sweepFmtVal(p.value); }).join(' · ');
    return r.run.id + (r.run.param ? ' · ' + r.run.param.name + ' ' + sweepFmtVal(r.run.param.value) : '');
  };
  ATLAS._series = S; ATLAS._rows = rows;
  var sig = [S.order.join('|'), ATLAS.series, series.length, hasExt, ATLAS.mode, ATLAS.units, m ? m.name : ''].join('#');
  var outTxt = cur.run.id + ' · ' + label(cur);
  if (sig === ATLAS._ctlSig) {
    /* same layout: move the slider and its label in place (rebuilding would end a drag in progress) */
    var sl = el.querySelector('input[type=range]'), out = el.querySelector('.at-slider output');
    if (sl && +sl.value !== Math.max(0, pos)) sl.value = Math.max(0, pos);
    if (out) out.textContent = outTxt;
    return;
  }
  ATLAS._ctlSig = sig;
  var h = '<div class="at-ctl"><span class="at-lab">Series</span><select onchange="atlasPickSeries(this.value)">' +
    S.order.map(function (k) { return '<option value="' + swEsc(k) + '"' + (k === ATLAS.series ? ' selected' : '') + '>' + swEsc(atlasSeriesLabel(k)) + ' (' + S.map[k].length + ')</option>'; }).join('') + '</select></div>';
  h += '<div class="at-ctl at-grow"><span class="at-lab">Run in series</span><div class="at-slider"><input type="range" min="0" max="' + Math.max(0, series.length - 1) + '" value="' + Math.max(0, pos) +
    '" oninput="atlasPickIndex(+this.value)"><output>' + swEsc(outTxt) + '</output></div></div>';
  if (hasExt) h += '<div class="at-ctl"><span class="at-lab">Values</span><div class="at-seg">' +
    '<button aria-pressed="' + (ATLAS.mode === 'grid') + '" onclick="atlasSet(\'mode\',\'grid\')">run grid</button>' +
    '<button aria-pressed="' + (ATLAS.mode === 'ext') + '" onclick="atlasSet(\'mode\',\'ext\')">extrapolated</button></div></div>';
  h += '<div class="at-ctl"><span class="at-lab">Stiffness as</span><div class="at-seg">' +
    '<button aria-pressed="' + (ATLAS.units === 'norm') + '" onclick="atlasSet(\'units\',\'norm\')">÷ E solid</button>' +
    (m ? '<button aria-pressed="' + (ATLAS.units === 'mat') + '" onclick="atlasSet(\'units\',\'mat\')" title="The material picked in the run controls, or the design’s own material">' + swEsc(m.name) + '</button>' : '') + '</div></div>';
  el.innerHTML = h;
}
function atlasPickSeries(key) {
  var S = ATLAS._series, cur = (ATLAS._rows || []).filter(function (r) { return r.run.id === ATLAS.sel; })[0];
  var list = S.map[key] || [];
  if (!list.length) return;
  /* keep the same position along parameter 1 when switching series */
  var pick = list[0];
  if (cur && cur.run.grid) list.forEach(function (r) { if (r.run.grid && r.run.grid[0] === cur.run.grid[0]) pick = r; });
  atlasSelect(pick.run.id);
}
function atlasPickIndex(i) {
  var S = ATLAS._series, list = S && S.map[ATLAS.series];
  if (list && list[i]) atlasSelect(list[i].run.id);
}

/* ── Geometry + surface ──────────────────────────────────── */
function atlasGeometry(cur) {
  var tiles = swEl('atTiles');
  tiles.innerHTML = '<button aria-pressed="' + (ATLAS.tiles === 1) + '" onclick="atlasTiles(1)">1 cell</button><button aria-pressed="' + (ATLAS.tiles === 2) + '" onclick="atlasTiles(2)">2×2×2</button>';
  if (!ATLAS.rm) return;
  try {
    ATLAS.rm.setRecipe(sweepRecipeForRun(cur.run));
    ATLAS.rm._u.tile = ATLAS.tiles; atlasApplyGeoCam();
    swEl('atGeoInfo').textContent = (cur.vf * 100).toFixed(1) + ' % solid · ' + cur.run.id;
  } catch (e) { swEl('atGeoInfo').textContent = 'Geometry unavailable: ' + e.message; }
}
function atlasTiles(n) {
  ATLAS.tiles = n;
  if (ATLAS.rm) { ATLAS.rm._u.tile = n; ATLAS.rm._dirty = true; }
  var b = swEl('atTiles'); if (b) [].forEach.call(b.children, function (x, i) { x.setAttribute('aria-pressed', String(i + 1 === n || (n === 2 && i === 1))); });
}
function atlasSurface(cur) {
  var S = atlasCompliance(cur.C), info = swEl('atSurfInfo');
  if (!S) { info.textContent = 'Stiffness matrix is singular.'; return; }
  if (ATLAS.sv) ATLAS.sv.uploadDesign(S);
  /* needle lobes: probe axes, diagonals and a dense Fibonacci sphere for the true peak */
  var pk = 0, pn = null, NF = 4000, wide = 0, probes = [];
  [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1], [1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]].forEach(function (v) {
    var m = Math.hypot(v[0], v[1], v[2]); probes.push([v[0] / m, v[1] / m, v[2] / m]); });
  for (var i = 0; i < NF; i++) { var z = 1 - (i + 0.5) / NF, r = Math.sqrt(1 - z * z), ph = i * 2.399963229728653; probes.push([r * Math.cos(ph), r * Math.sin(ph), z]); }
  probes.forEach(function (n) { var E = atlasEdir(S, n); if (E > pk) { pk = E; pn = n; } });
  for (var k = 13; k < probes.length; k++) if (atlasEdir(S, probes[k]) > 0.2 * pk) wide++;
  var st = ATLAS.sv ? ATLAS.sv.getStats() : null;
  var txt = 'E max ' + atlasFmtE(pk) + ' along [' + pn.map(function (v) { return v.toFixed(2); }).join(', ') + ']';
  if (st && st.E_min > 0) txt += ' · E min ' + atlasFmtE(st.E_min) + ' · max / min ' + (pk / st.E_min).toFixed(1);
  if (wide / NF < 0.02) txt += ' · strand-like: stiff only in a narrow cone around that axis';
  info.textContent = txt;
}

/* ── Readout + matrix ────────────────────────────────────── */
function atlasReadout(cur) {
  var r = cur.res, run = cur.run, st = SWEEP_STATE.preview[run.id];
  var flags = (typeof sweepFlags === 'function' && st) ? sweepFlags(run, st) : [];
  var h = '<span class="at-pill" title="' + swEsc(ATLAS_CLASS_TIP[cur.cls]) + '"><span class="at-dot" style="background:' + ATLAS_COL.cls[cur.cls] + '"></span>' + ATLAS_CLASS[cur.cls] + '</span>';
  h += '<span class="at-sub">' + swEsc(run.id) + ' · ' + swEsc(run.purpose || '') + '</span>';
  flags.forEach(function (f) { if (f.level !== 'info') h += '<span class="at-pill warn" title="' + swEsc(f.text) + '">! ' + swEsc(f.short) + '</span>'; });
  if (cur.ext) h += '<span class="at-pill" title="Extrapolated from N = ' + r.ext.coarseN + ' and ' + r.ext.fineN + ' (order ' + r.ext.order + ')">extrapolated</span>';
  if (!r.converged) h += '<span class="at-pill warn">! not converged</span>';
  if (r.noLoad) h += '<span class="at-pill warn" title="These axes read zero within solver noise (' + swEsc(r.noLoad.map(function (b) { return 'E' + b.axis + ' = ' + b.E.toExponential(1); }).join(', ')) + ' ÷ E solid). The solver alone would have rejected the run.">! no load on ' + r.noLoad.map(function (b) { return b.axis; }).join(', ') + '</span>';
  var negG = ['44', '55', '66'].filter(function (k) { return r.C && r.C['C' + k] < 0; });
  if (negG.length) h += '<span class="at-pill warn" title="Negative shear stiffness is not physical; rerun at high precision to see whether it is the solver tolerance.">! negative ' + negG.map(function (k) { return 'C' + k; }).join(', ') + '</span>';
  swEl('atStatus').innerHTML = h;
  var cell = function (k, v, col) { return '<div class="at-ro"><span class="k">' + (col ? '<span class="at-sw" style="background:' + col + '"></span>' : '') + k + '</span><span class="v">' + v + '</span></div>'; };
  swEl('atReadout').innerHTML = cell('Solid', (cur.vf * 100).toFixed(1) + ' %') +
    cell('Ex', atlasFmtE(cur.Ex), ATLAS_COL.ax[0]) + cell('Ey', atlasFmtE(cur.Ey), ATLAS_COL.ax[1]) + cell('Ez', atlasFmtE(cur.Ez), ATLAS_COL.ax[2]) +
    cell('Gyz', atlasFmtE(cur.Gyz)) + cell('Gxz', atlasFmtE(cur.Gxz)) + cell('Gxy', atlasFmtE(cur.Gxy)) +
    cell('max / min E', (Math.max(cur.Ex, cur.Ey, cur.Ez) / Math.max(Math.min(cur.Ex, cur.Ey, cur.Ez), 1e-12)).toFixed(1));
  /* matrix heatmap */
  var C = cur.C, amax = 0; C.forEach(function (v) { amax = Math.max(amax, Math.abs(v)); });
  var lab = ['11', '22', '33', '23', '13', '12'], m = atlasEs();
  var th = '<tr><th></th>' + lab.map(function (l) { return '<th>' + l + '</th>'; }).join('') + '</tr>';
  for (var i = 0; i < 6; i++) {
    th += '<tr><th>' + lab[i] + '</th>';
    for (var j = 0; j < 6; j++) {
      var v = C[i * 6 + j], t = amax ? v / amax : 0, bg = atlasDiv(t), dark = Math.abs(t) < 0.55;
      var tiny = Math.abs(v) < 1e-6 * amax;
      var disp = tiny ? '0' : m ? fmtEngMPa(v * m.Es_MPa).replace(' ', ' ') : atlasFmt4(v);
      th += '<td class="' + (j < i ? 'lo' : '') + '" style="background:' + bg + ';color:' + (dark ? ATLAS_COL.ink : '#06080f') + '" title="C' + lab[i] + lab[j] + ' = ' + v.toExponential(3) + ' × E solid">' + disp + '</td>';
    }
    th += '</tr>';
  }
  swEl('atMat').innerHTML = th;
  swEl('atSolve').textContent = 'N = ' + r.N + (r.companion ? ' (+ N = ' + r.companion.N + ')' : '') + ' · ' + r.iters + ' CG iterations · residual ' +
    (r.residual != null ? r.residual.toExponential(1) : '—') + ' · void ' + (r.voidRatio != null ? r.voidRatio : 1e-4).toExponential(0) + ' · ' + sweepFmtDur(r.wall_s) +
    ' · ' + (m ? 'matrix in MPa / GPa (' + m.name + ')' : 'matrix in units of E solid');
}
function atlasDiv(t) {
  /* rose ← panel → green → neon */
  var neg = [251, 113, 133], mid = [26, 26, 42], pos1 = [29, 158, 117], pos2 = [200, 245, 66];
  var u = Math.min(1, Math.abs(t)), a, b, f;
  if (t < 0) { a = mid; b = neg; f = u; }
  else if (u < 0.5) { a = mid; b = pos1; f = u / 0.5; } else { a = pos1; b = pos2; f = (u - 0.5) / 0.5; }
  return 'rgb(' + a.map(function (x, i) { return Math.round(x + (b[i] - x) * f); }).join(',') + ')';
}

/* ── Parameter map ───────────────────────────────────────── */
function atlasMapValue(r) {
  var e = [r.Ex, r.Ey, r.Ez];
  switch (ATLAS.mapMetric) {
    case 'vf': return r.vf;
    case 'max': return Math.max.apply(null, e);
    case 'min': return Math.min.apply(null, e);
    case 'z': return r.Ez;
    default: return r.cls;
  }
}
function atlasMap(rows, cur) {
  var el = swEl('atMap'), ctl = swEl('atMapCtl'), leg = swEl('atMapLegend'), title = swEl('atMapTitle');
  var axes = SWEEP_STATE.axes;
  if (!axes) {
    /* CSV sweep: the current series as a clickable table */
    title.textContent = 'Runs in this series'; ctl.innerHTML = ''; leg.innerHTML = '';
    var list = (ATLAS._series.map[ATLAS.series] || []);
    var hasP = list.some(function (r) { return r.run.param; });
    el.innerHTML = '<div class="at-rtwrap"><table class="at-rtab"><tr><th></th><th>Run</th>' + (hasP ? '<th>Parameter</th>' : '') + '<th>Solid</th>' +
      '<th><span class="at-sw" style="background:' + ATLAS_COL.ax[0] + '"></span>Ex</th><th><span class="at-sw" style="background:' + ATLAS_COL.ax[1] + '"></span>Ey</th><th><span class="at-sw" style="background:' + ATLAS_COL.ax[2] + '"></span>Ez</th><th>Purpose</th></tr>' +
      list.map(function (r) {
        return '<tr class="' + (r.run.id === cur.run.id ? 'cur' : '') + '" onclick="atlasSelect(\'' + r.run.id + '\')" title="' + swEsc(ATLAS_CLASS[r.cls]) + '">' +
          '<td><span class="at-dot" style="background:' + ATLAS_COL.cls[r.cls] + '"></span></td><td>' + swEsc(r.run.id) + '</td>' +
          (hasP ? '<td>' + (r.run.param ? swEsc(r.run.param.name + ' ' + sweepFmtVal(r.run.param.value)) : '') + '</td>' : '') +
          '<td>' + (r.vf * 100).toFixed(1) + ' %</td><td>' + atlasFmtE(r.Ex) + '</td><td>' + atlasFmtE(r.Ey) + '</td><td>' + atlasFmtE(r.Ez) + '</td>' +
          '<td class="pu">' + swEsc(r.run.purpose || '') + '</td></tr>';
      }).join('') + '</table></div>';
    leg.innerHTML = ATLAS_CLASS.map(function (n, k) { return '<span class="at-lk"><span class="at-dot" style="background:' + ATLAS_COL.cls[k] + '"></span>' + n + '</span>'; }).join('');
    return;
  }
  title.textContent = 'Parameter map';
  ctl.innerHTML = '<select onchange="atlasSet(\'mapMetric\', this.value)">' + [['class', 'Connectivity'], ['vf', 'Solid fraction'], ['max', 'Stiffest axis'], ['min', 'Softest axis'], ['z', 'Ez']].map(function (o) {
    return '<option value="' + o[0] + '"' + (ATLAS.mapMetric === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
  var a1 = axes[0], a2 = axes[1], n1 = a1.values.length, n2 = a2 ? a2.values.length : 1;
  var byIJ = {}; rows.forEach(function (r) { if (r.run.grid) byIJ[r.run.grid[0] + ',' + r.run.grid[1]] = r; });
  var vals = rows.map(atlasMapValue), isCls = ATLAS.mapMetric === 'class', isVf = ATLAS.mapMetric === 'vf';
  var lo = Infinity, hi = -Infinity;
  if (!isCls) vals.forEach(function (v) { if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
  var W = Math.max(280, swEl('atMap').clientWidth || 480), cw = Math.max(8, Math.min(64, Math.floor((W - 90) / n1))), ch = Math.max(10, Math.min(40, Math.floor(300 / n2)));
  var h = '<table class="at-mtab"><tr><th class="ax">' + swEsc(a2 ? a2.label : '') + '</th>';
  var every = Math.ceil(n1 / Math.max(1, Math.floor((W - 90) / 46)));
  for (var i = 0; i < n1; i++) h += '<th style="width:' + cw + 'px">' + (i % every === 0 ? swEsc(sweepFmtVal(a1.values[i]) + atlasAxSuffix(a1)) : '') + '</th>';
  h += '</tr>';
  for (var j = 0; j < n2; j++) {
    h += '<tr><th>' + (a2 ? swEsc(sweepFmtVal(a2.values[j])) : '') + '</th>';
    for (var i2 = 0; i2 < n1; i2++) {
      var r = byIJ[i2 + ',' + j], bg = 'transparent', tip = '', cls = 'empty';
      if (r) {
        var v = atlasMapValue(r); cls = r.run.id === cur.run.id ? 'cur' : '';
        bg = isCls ? ATLAS_COL.cls[v] : (isVf ? sweepSeqColor(v) : atlasSeqLog(v, lo, hi));
        tip = r.run.id + ' · ' + ATLAS_CLASS[r.cls] + ' · ' + (r.vf * 100).toFixed(1) + ' % · Ex ' + atlasFmtE(r.Ex) + ' Ey ' + atlasFmtE(r.Ey) + ' Ez ' + atlasFmtE(r.Ez);
      } else {
        var run = SWEEP_STATE.runs.filter(function (x) { return x.grid && x.grid[0] === i2 && x.grid[1] === j; })[0];
        tip = run ? (SWEEP_STATE.selected[run.id] === false ? run.id + ' · skipped' : run.id + ' · not solved yet') : 'not in sweep';
        if (run && SWEEP_STATE.selected[run.id] === false) cls = 'skip';
      }
      h += '<td class="' + cls + '" style="background:' + bg + ';height:' + ch + 'px" title="' + swEsc(tip) + '"' + (r ? ' onclick="atlasSelect(\'' + r.run.id + '\')"' : '') + '></td>';
    }
    h += '</tr>';
  }
  el.innerHTML = '<div class="at-sub">' + swEsc(a1.label) + atlasAxNote(a1) + ' →</div>' + h + '</table>';
  leg.innerHTML = isCls
    ? ATLAS_CLASS.map(function (n, k) { return '<span class="at-lk"><span class="at-sw sq" style="background:' + ATLAS_COL.cls[k] + '"></span>' + n + '</span>'; }).join('') + '<span class="at-lk"><span class="at-sw sq cur"></span>current</span>'
    : '<span class="at-lk"><span class="at-ramp ' + (isVf ? 'vf' : 'log') + '"></span>' + (isVf ? '0 → 60 %+' : atlasFmtE(lo) + ' → ' + atlasFmtE(hi) + ' (log)') + '</span><span class="at-lk"><span class="at-sw sq cur"></span>current</span>';
}
function atlasSeqLog(v, lo, hi) {
  if (!(v > 0) || !(hi > lo)) return '#1a1a2a';
  var f = (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return sweepSeqColor(f * 0.6);
}

/* ── SVG chart helper ────────────────────────────────────── */
/* opts: { el, w, h, x:{min,max,log,title,fmt}, y:{...}, lines:[{pts:[[x,y]], color, dash, width}],
           marks:[{x,y,color,shape,size,stroke,id,tip,hollow}], labels:[{x,y,text,color}], onClick } */
function atlasChart(opts) {
  var W = opts.w, H = opts.h, m = { l: 62, r: 18, t: 14, b: 44 };
  var iw = W - m.l - m.r, ih = H - m.t - m.b;
  function sc(ax, len, flip) {
    var lo = ax.log ? Math.log10(ax.min) : ax.min, hi = ax.log ? Math.log10(ax.max) : ax.max;
    return function (v) { var t = ((ax.log ? Math.log10(Math.max(v, 1e-30)) : v) - lo) / ((hi - lo) || 1); return flip ? ih - t * ih : t * iw; };
  }
  var X = sc(opts.x, iw, false), Y = sc(opts.y, ih, true);
  var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" class="at-svg"><g transform="translate(' + m.l + ',' + m.t + ')">';
  function ticks(ax) {
    var out = [];
    if (ax.log) { for (var e = Math.floor(Math.log10(ax.min)); e <= Math.ceil(Math.log10(ax.max)); e++) { var v = Math.pow(10, e); if (v >= ax.min * 0.999 && v <= ax.max * 1.001) out.push(v); } }
    else { var span = ax.max - ax.min, st = Math.pow(10, Math.floor(Math.log10(span / 5 || 1))); if (span / st > 10) st *= 2; if (span / st > 10) st *= 2.5;
      for (var t = Math.ceil(ax.min / st) * st; t <= ax.max + 1e-12; t += st) out.push(+t.toPrecision(12)); }
    return out;
  }
  ticks(opts.x).forEach(function (t) { var px = X(t); s += '<line x1="' + px + '" y1="0" x2="' + px + '" y2="' + ih + '" class="g"/><text x="' + px + '" y="' + (ih + 16) + '" class="tk" text-anchor="middle">' + (opts.x.fmt ? opts.x.fmt(t) : t) + '</text>'; });
  ticks(opts.y).forEach(function (t) { var py = Y(t); s += '<line x1="0" y1="' + py + '" x2="' + iw + '" y2="' + py + '" class="g"/><text x="-8" y="' + (py + 4) + '" class="tk" text-anchor="end">' + (opts.y.fmt ? opts.y.fmt(t) : t) + '</text>'; });
  s += '<rect x="0" y="0" width="' + iw + '" height="' + ih + '" class="fr"/>';
  s += '<text x="' + (iw / 2) + '" y="' + (ih + 36) + '" class="at" text-anchor="middle">' + swEsc(opts.x.title || '') + '</text>';
  s += '<text transform="translate(-48,' + (ih / 2) + ') rotate(-90)" class="at" text-anchor="middle">' + swEsc(opts.y.title || '') + '</text>';
  s += '<defs><clipPath id="atClip' + opts.el.id + '"><rect x="0" y="0" width="' + iw + '" height="' + ih + '"/></clipPath></defs><g clip-path="url(#atClip' + opts.el.id + ')">';
  (opts.lines || []).forEach(function (L) {
    var d = L.pts.filter(function (p) { return isFinite(p[0]) && isFinite(p[1]) && (!opts.y.log || p[1] > 0); }).map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join('');
    if (d) s += '<path d="' + d + '" fill="none" stroke="' + L.color + '" stroke-width="' + (L.width || 2) + '"' + (L.dash ? ' stroke-dasharray="' + L.dash + '"' : '') + (L.opacity ? ' opacity="' + L.opacity + '"' : '') + '/>';
  });
  (opts.marks || []).forEach(function (k, i) {
    if (!isFinite(k.x) || !isFinite(k.y) || (opts.y.log && !(k.y > 0))) return;
    var px = X(k.x), py = Y(k.y), r = k.size || 4, fill = k.hollow ? 'none' : k.color, stroke = k.stroke || (k.hollow ? k.color : ATLAS_COL.bg);
    var attr = ' fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + (k.sw || 1.5) + '" data-i="' + i + '" class="mk' + (k.id ? ' ck' : '') + '"';
    if (k.shape === 'diamond') s += '<path d="M' + px + ',' + (py - r * 1.3) + 'L' + (px + r * 1.3) + ',' + py + 'L' + px + ',' + (py + r * 1.3) + 'L' + (px - r * 1.3) + ',' + py + 'Z"' + attr + '/>';
    else if (k.shape === 'square') s += '<rect x="' + (px - r) + '" y="' + (py - r) + '" width="' + 2 * r + '" height="' + 2 * r + '"' + attr + '/>';
    else if (k.shape === 'triangle') s += '<path d="M' + px + ',' + (py - r * 1.3) + 'L' + (px + r * 1.2) + ',' + (py + r) + 'L' + (px - r * 1.2) + ',' + (py + r) + 'Z"' + attr + '/>';
    else if (k.shape === 'cross') s += '<path d="M' + (px - r) + ',' + (py - r) + 'L' + (px + r) + ',' + (py + r) + 'M' + (px + r) + ',' + (py - r) + 'L' + (px - r) + ',' + (py + r) + '" fill="none" stroke="' + k.color + '" stroke-width="2" data-i="' + i + '" class="mk' + (k.id ? ' ck' : '') + '"/>';
    else s += '<circle cx="' + px + '" cy="' + py + '" r="' + r + '"' + attr + '/>';
  });
  s += '</g>';
  (opts.labels || []).forEach(function (L) {
    if (!(L.y > 0) && opts.y.log) return;
    s += '<text x="' + (X(L.x) + 8) + '" y="' + (Y(L.y) + 4) + '" class="lb" fill="' + L.color + '">' + swEsc(L.text) + '</text>';
  });
  s += '</g></svg>';
  opts.el.innerHTML = s;
  var svg = opts.el.querySelector('svg'), tip = swEl('atTip');
  svg.addEventListener('mousemove', function (e) {
    var t = e.target, i = t.getAttribute && t.getAttribute('data-i');
    if (i == null) { tip.hidden = true; return; }
    var k = opts.marks[+i]; if (!k || !k.tip) { tip.hidden = true; return; }
    tip.innerHTML = k.tip; tip.hidden = false;
    var pr = tip.parentNode.getBoundingClientRect(), tw = tip.offsetWidth || 200;
    var lx = e.clientX - pr.left + 14; if (lx + tw > pr.width - 8) lx = e.clientX - pr.left - tw - 14;
    tip.style.left = lx + 'px'; tip.style.top = (e.clientY - pr.top + 14) + 'px';
  });
  svg.addEventListener('mouseleave', function () { tip.hidden = true; });
  svg.addEventListener('click', function (e) {
    var i = e.target.getAttribute && e.target.getAttribute('data-i');
    if (i != null && opts.onClick && opts.marks[+i].id) opts.onClick(opts.marks[+i].id);
  });
}
function atlasVoigt(xmax) {
  var pts = []; for (var i = 0; i <= 80; i++) { var x = 0.002 + (xmax - 0.002) * i / 80; pts.push([x, x]); }
  return { pts: pts, color: ATLAS_COL.mute, dash: '5 5', width: 1.2, opacity: 0.8 };
}
function atlasPct(v) { return (v * 100 >= 10 ? Math.round(v * 100) : +(v * 100).toPrecision(2)) + '%'; }
function atlasExpFmt(v) {
  var m = atlasEs();
  if (m) { var mpa = v * m.Es_MPa; return mpa >= 1000 ? +(mpa / 1000).toPrecision(2) + ' GPa' : (mpa >= 1 ? +mpa.toPrecision(2) + ' MPa' : mpa.toExponential(0) + ' MPa'); }
  var e = Math.round(Math.log10(v)); return e === 0 ? '1' : '10' + String(e).replace(/-/g, '⁻').replace(/\d/g, function (d) { return '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]; });
}

/* ── Stiffness vs solid fraction (selected series) ───────── */
function atlasLine(series, cur) {
  var el = swEl('atLine'), W = Math.max(320, el.clientWidth || 800);
  var keys = ['Ex', 'Ey', 'Ez'], dash = ['', '6 4', '2 4'], lines = [], marks = [], labels = [], ymin = Infinity, xmax = 0;
  series.forEach(function (r) { keys.forEach(function (k) { if (r[k] > 0) ymin = Math.min(ymin, r[k]); }); xmax = Math.max(xmax, r.vf); });
  if (!isFinite(ymin)) ymin = 1e-6;
  var showOther = series.some(function (r) { return r.res.companion; });
  keys.forEach(function (k, a) {
    lines.push({ pts: series.map(function (r) { return [r.vf, r[k]]; }), color: ATLAS_COL.ax[a], dash: dash[a], width: 2 });
    series.forEach(function (r) {
      var isCur = r.run.id === cur.run.id;
      marks.push({ x: r.vf, y: r[k], color: ATLAS_COL.ax[a], size: isCur ? 7 : 3.5, sw: isCur ? 2.5 : 1.2, stroke: isCur ? ATLAS_COL.ink : ATLAS_COL.bg, id: r.run.id,
        tip: '<b>' + k + ' = ' + atlasFmtE(r[k]) + '</b>' + (r.ext ? ' (extrapolated)' : '') + '<br>' + swEsc(r.run.id) + ' · ' + (r.vf * 100).toFixed(1) + ' % solid<br>' + swEsc(r.run.purpose || '') });
      if (showOther && r.res.companion) {
        var other = ATLAS.mode === 'ext' ? r.res : r.res.companion, oN = ATLAS.mode === 'ext' ? r.res.N : r.res.companion.N;
        if (other[k] > 0) { ymin = Math.min(ymin, other[k]); marks.push({ x: r.vf, y: other[k], color: ATLAS_COL.ax[a], size: 3, hollow: true, sw: 1,
          tip: k + ' at N = ' + oN + ': ' + atlasFmtE(other[k]) + '<br>' + swEsc(r.run.id) }); }
      }
    });
    var last = series[series.length - 1];
    if (last) labels.push({ x: last.vf, y: last[k], text: k, color: ATLAS_COL.ax[a] });
  });
  for (var li = labels.length - 1; li > 0; li--) for (var lj = 0; lj < li; lj++) {
    if (labels[lj].y > 0 && Math.abs(Math.log10(labels[li].y / labels[lj].y)) < 0.04) { labels[lj].text += ' = ' + labels[li].text; labels.splice(li, 1); break; }
  }
  var xm = Math.min(1, Math.max(0.05, xmax * 1.12));
  lines.unshift(atlasVoigt(xm));
  swEl('atLineSub').textContent = atlasSeriesLabel(ATLAS.series) + ' · ' + series.length + ' runs' + (showOther ? ' · hollow points: ' + (ATLAS.mode === 'ext' ? 'run grid' : 'second grid') : '') + ' · dashed grey: Voigt bound';
  atlasChart({ el: el, w: W, h: 340, x: { min: 0, max: xm, title: 'Solid fraction', fmt: atlasPct },
    y: { min: Math.pow(10, Math.floor(Math.log10(ymin * 0.7))), max: Math.min(1, Math.pow(10, Math.ceil(Math.log10(Math.max(xm, 1e-6))))), log: true, title: atlasEs() ? 'E (log)' : 'E / E solid (log)', fmt: atlasExpFmt },
    lines: lines, marks: marks, labels: labels, onClick: atlasSelect });
}

/* ── Design space scatter ────────────────────────────────── */
function atlasScatter(rows, S, cur) {
  var el = swEl('atScatter'), W = Math.max(320, el.clientWidth || 800);
  swEl('atScatterCtl').innerHTML = '<select onchange="atlasSet(\'metric\', this.value)">' + [['max', 'Stiffest axis'], ['min', 'Softest axis'], ['z', 'z axis (Ez)'], ['mean', 'Mean of Ex, Ey, Ez']].map(function (o) {
    return '<option value="' + o[0] + '"' + (ATLAS.metric === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
  function val(r) { var e = [r.Ex, r.Ey, r.Ez]; return ATLAS.metric === 'max' ? Math.max.apply(null, e) : ATLAS.metric === 'min' ? Math.min.apply(null, e) : ATLAS.metric === 'z' ? r.Ez : (e[0] + e[1] + e[2]) / 3; }
  var sIdx = {}; S.order.forEach(function (k, i) { sIdx[k] = i; });
  var marks = [], ymin = Infinity;
  rows.forEach(function (r) {
    var v = Math.max(val(r), 1e-9); ymin = Math.min(ymin, v);
    marks.push({ x: r.vf, y: v, color: ATLAS_COL.cls[r.cls], shape: ATLAS_SHAPES[sIdx[atlasSeriesKey(r.run)] % ATLAS_SHAPES.length], size: 4.5, stroke: 'none', sw: 0, id: r.run.id,
      tip: '<b>' + swEsc(r.run.id) + '</b> · ' + ATLAS_CLASS[r.cls] + '<br>' + swEsc(atlasSeriesLabel(atlasSeriesKey(r.run))) + '<br>' + (r.vf * 100).toFixed(1) + ' % solid · E ' + atlasFmtE(v) });
  });
  marks.push({ x: cur.vf, y: Math.max(val(cur), 1e-9), color: 'none', hollow: true, stroke: ATLAS_COL.ink, size: 9, sw: 2 });
  var xm = Math.min(1, Math.max(0.05, Math.max.apply(null, rows.map(function (r) { return r.vf; })) * 1.12));
  atlasChart({ el: el, w: W, h: 420, x: { min: 0, max: xm, title: 'Solid fraction', fmt: atlasPct },
    y: { min: Math.pow(10, Math.floor(Math.log10(ymin * 0.7))), max: Math.min(1, Math.pow(10, Math.ceil(Math.log10(xm)))), log: true, title: atlasEs() ? 'E (log)' : 'E / E solid (log)', fmt: atlasExpFmt },
    lines: [atlasVoigt(xm)],
    marks: marks, onClick: atlasSelect });
}

/* ── 3-D stiffness surface (v0.12) ───────────────────────────
   Two-parameter builder sweeps only: parameter 1 across, parameter 2 in depth,
   stiffness up (log by default).  Lab-native canvas 2-D (painter's algorithm), so it
   needs no extra WebGL context.  Same CAD tumble as the other views. */
var ATLAS_S3_METRICS = [['max', 'Stiffest axis'], ['min', 'Softest axis'], ['Ex', 'Ex'], ['Ey', 'Ey'], ['Ez', 'Ez'], ['xyz', 'Ex, Ey, Ez together'],
  ['mean', 'Mean of Ex, Ey, Ez'], ['Gyz', 'Gyz'], ['Gxz', 'Gxz'], ['Gxy', 'Gxy'], ['vf', 'Solid fraction']];
var ATLAS_S3_HOME = atlasM3mul(atlasRotX(0.42), atlasRotY(-0.62));
var ATLAS_S3_EXT = [1, 0.7, 1];   /* half-extents of the plot box: parameter 1, value, parameter 2 */

function atlasS3Val(r, k) {
  var e = [r.Ex, r.Ey, r.Ez];
  switch (k) {
    case 'max': return Math.max.apply(null, e);
    case 'min': return Math.min.apply(null, e);
    case 'mean': return (e[0] + e[1] + e[2]) / 3;
    case 'vf': return r.vf;
    default: return r[k];
  }
}
function atlasRamp(t) {
  var st = [[0, [32, 56, 86]], [0.35, [29, 158, 117]], [0.72, [140, 214, 84]], [1, [200, 245, 66]]];
  t = Math.max(0, Math.min(1, t));
  for (var i = 1; i < st.length; i++) if (t <= st[i][0]) {
    var a = st[i - 1], b = st[i], f = (t - a[0]) / (b[0] - a[0]);
    return a[1].map(function (x, k) { return x + (b[1][k] - x) * f; });
  }
  return st[st.length - 1][1];
}
function atlasHexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function atlasNiceTicks(lo, hi, n) {
  var span = hi - lo; if (!(span > 0)) return [lo];
  var st = Math.pow(10, Math.floor(Math.log10(span / (n || 5))));
  [1, 2, 2.5, 5, 10].some(function (m) { if (span / (st * m) <= (n || 5)) { st *= m; return true; } return false; });
  var out = []; for (var t = Math.ceil(lo / st - 1e-9) * st; t <= hi + st * 1e-9; t += st) out.push(+t.toPrecision(12));
  return out;
}

function atlasS3(rows, cur) {
  var panel = swEl('atS3Panel'), axes = SWEEP_STATE.axes;
  var ok = !!(axes && axes.length > 1 && axes[0].values.length > 1 && axes[1].values.length > 1);
  if (!panel) return;
  panel.hidden = !ok;
  if (!ok) return;
  var S3 = ATLAS.s3, isVf = S3.metric === 'vf';
  var sig = [S3.metric, S3.log, S3.color, ATLAS.units].join('#');
  if (ATLAS._s3Sig !== sig) {
    ATLAS._s3Sig = sig;
    swEl('atS3Ctl').innerHTML = '<select onchange="atlasS3Set(\'metric\', this.value)">' + ATLAS_S3_METRICS.map(function (o) {
        return '<option value="' + o[0] + '"' + (S3.metric === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      (isVf ? '' : '<div class="at-seg"><button aria-pressed="' + S3.log + '" onclick="atlasS3Set(\'log\', true)">log</button><button aria-pressed="' + !S3.log + '" onclick="atlasS3Set(\'log\', false)">linear</button></div>') +
      (S3.metric === 'xyz' ? '' : '<div class="at-seg"><button aria-pressed="' + (S3.color === 'value') + '" onclick="atlasS3Set(\'color\', \'value\')">color by value</button><button aria-pressed="' + (S3.color === 'class') + '" onclick="atlasS3Set(\'color\', \'class\')">by connectivity</button></div>') +
      '<div class="at-seg"><button onclick="ATLAS.s3.cam && ATLAS.s3.cam.reset()" title="Home view (double-click the plot)">⌂</button></div>';
  }
  if (!S3.cam) {
    var box = swEl('atS3');
    S3.cam = new AtlasCam(box, ATLAS_S3_HOME, atlasS3Queue);
    box.addEventListener('pointermove', atlasS3Hover);
    box.addEventListener('pointerleave', function () { var t = swEl('atTip'); if (t) t.hidden = true; ATLAS._s3Hot = null; atlasS3Queue(); });
    box.addEventListener('click', function () { if (!S3.cam.lastDragMoved && ATLAS._s3Hot) atlasSelect(ATLAS._s3Hot.id); });
  }
  /* data on the regular parameter grid */
  var a1 = axes[0], a2 = axes[1], n1 = a1.values.length, n2 = a2.values.length;
  function norm(vals) {
    var v = vals.map(Number), lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    var okv = v.every(isFinite) && hi > lo;
    return v.map(function (x, i) { return okv ? -1 + 2 * (x - lo) / (hi - lo) : -1 + 2 * i / (v.length - 1); });
  }
  var xs = norm(a1.values), zs = norm(a2.values), cell = [];
  for (var i = 0; i < n1; i++) { cell.push([]); for (var j = 0; j < n2; j++) cell[i].push(null); }
  rows.forEach(function (r) { if (r.run.grid && r.run.grid[0] < n1 && r.run.grid[1] < n2) cell[r.run.grid[0]][r.run.grid[1]] = r; });
  var keys = S3.metric === 'xyz' ? ['Ex', 'Ey', 'Ez'] : [S3.metric], useLog = S3.log && !isVf;
  var lo = Infinity, hi = -Infinity, raw = [];
  keys.forEach(function (k) { rows.forEach(function (r) { if (!r.run.grid) return; var v = atlasS3Val(r, k); if (useLog ? v > 0 : isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
  if (!isFinite(lo)) { lo = useLog ? 1e-6 : 0; hi = useLog ? 1 : 1; }
  var tlo, thi, ticks;
  if (useLog) {
    tlo = Math.floor(Math.log10(lo)); thi = Math.ceil(Math.log10(hi)); if (thi === tlo) thi++;
    var stp = thi - tlo > 6 ? 2 : 1; ticks = []; for (var e = tlo; e <= thi; e += stp) ticks.push(e);
  } else {
    var l0 = Math.min(0, lo); ticks = atlasNiceTicks(l0, hi, 5); tlo = l0; thi = Math.max(hi, ticks[ticks.length - 1]);
  }
  function tf(v) { if (useLog) return v > 0 ? Math.log10(v) : tlo; return isFinite(v) ? v : null; }
  function Y(t) { return -ATLAS_S3_EXT[1] + 2 * ATLAS_S3_EXT[1] * (t - tlo) / ((thi - tlo) || 1); }
  var surfaces = keys.map(function (k, si) {
    var g = [];
    for (var i = 0; i < n1; i++) { g.push([]); for (var j = 0; j < n2; j++) { var r = cell[i][j], t = r ? tf(atlasS3Val(r, k)) : null; g[i].push(t == null ? null : Y(Math.max(tlo, Math.min(thi, t)))); } }
    return { key: k, y: g, color: keys.length > 1 ? atlasHexRgb(ATLAS_COL.ax[si]) : null };
  });
  ATLAS._s3 = { n1: n1, n2: n2, xs: xs, zs: zs, cell: cell, surfaces: surfaces, ticks: ticks, useLog: useLog, isVf: isVf, Y: Y, tlo: tlo, thi: thi,
                a1: a1, a2: a2, cur: cur, metricLabel: (ATLAS_S3_METRICS.filter(function (o) { return o[0] === S3.metric; })[0] || ['', ''])[1] };
  var missing = 0; cell.forEach(function (c) { c.forEach(function (r) { if (!r) missing++; }); });
  swEl('atS3Sub').textContent = n1 + ' × ' + n2 + ' runs · ' + ATLAS._s3.metricLabel + (useLog ? ' (log)' : '') +
    (missing ? ' · ' + missing + ' not solved or skipped (holes)' : '') + ' · hover for values, click to select';
  atlasS3Draw();
}
function atlasS3Set(k, v) { ATLAS.s3[k] = v; atlasUpdate(); }
function atlasS3Queue() { if (ATLAS._s3raf) return; ATLAS._s3raf = requestAnimationFrame(function () { ATLAS._s3raf = 0; atlasS3Draw(); }); }

function atlasS3Draw() {
  var D = ATLAS._s3, cv = swEl('atS3c'), cam = ATLAS.s3.cam;
  if (!D || !cv || !cam) return;
  var W = cv.clientWidth || 600, H = cv.clientHeight || 460, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  var Q = cam.Q, m = Math.min(W, H), R = 0.29 * m * cam.zoom, EX = ATLAS_S3_EXT;
  function P(x, y, z) {
    var vx = Q[0] * x + Q[1] * y + Q[2] * z, vy = Q[3] * x + Q[4] * y + Q[5] * z, vz = Q[6] * x + Q[7] * y + Q[8] * z, f = 4.5 / (4.5 - vz);
    return [W / 2 + vx * f * R + cam.panX * m, H / 2 - vy * f * R - cam.panY * m, vz];
  }
  function poly(pts, fill, stroke, lw) {
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (var k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
  }
  function line(a, b, col, lw, dash) { g.beginPath(); g.setLineDash(dash || []); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.strokeStyle = col; g.lineWidth = lw || 1; g.stroke(); g.setLineDash([]); }
  /* tick positions in box coordinates */
  function axTicks(ax, xsN) {
    var vals = ax.values.map(Number), n = vals.length;
    if (n <= 9) return vals.map(function (v, i) { return { p: xsN[i], t: sweepFmtVal(ax.values[i]) + atlasAxSuffix(ax) }; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    return atlasNiceTicks(lo, hi, 6).map(function (v) { return { p: -1 + 2 * (v - lo) / (hi - lo), t: sweepFmtVal(v) + atlasAxSuffix(ax) }; });
  }
  var tx = axTicks(D.a1, D.xs), tz = axTicks(D.a2, D.zs);
  var ty = D.ticks.map(function (t) { return { p: D.Y(t), t: D.useLog ? atlasExpFmt(Math.pow(10, t)) : (D.isVf ? atlasPct(t) : (atlasEs() ? atlasFmtE(t) : String(+t.toPrecision(3)))) }; });
  /* back walls with grid lines */
  var gridCol = 'rgba(124,138,170,0.16)', wallCol = 'rgba(17,17,24,0.55)', edgeCol = 'rgba(124,138,170,0.35)';
  var floorIsBack = false;
  [0, 1, 2].forEach(function (a) {
    var sgn = Q[6 + a] > 0 ? -1 : 1;   /* the side whose outward normal points away from the viewer */
    if (a === 1 && sgn === -1) floorIsBack = true;
    var b = (a + 1) % 3, c = (a + 2) % 3;
    function pt(u, v) { var q = [0, 0, 0]; q[a] = sgn * EX[a]; q[b] = u; q[c] = v; return P(q[0], q[1], q[2]); }
    poly([pt(-EX[b], -EX[c]), pt(EX[b], -EX[c]), pt(EX[b], EX[c]), pt(-EX[b], EX[c])], wallCol, edgeCol, 1);
    var tb = b === 0 ? tx : b === 1 ? ty : tz, tc = c === 0 ? tx : c === 1 ? ty : tz;
    tb.forEach(function (t) { line(pt(t.p, -EX[c]), pt(t.p, EX[c]), gridCol, 1); });
    tc.forEach(function (t) { line(pt(-EX[b], t.p), pt(EX[b], t.p), gridCol, 1); });
  });
  /* contour lines on the floor (single surface) */
  var S0 = D.surfaces[0];
  if (floorIsBack && D.surfaces.length === 1) {
    var levels = D.useLog ? D.ticks.concat(D.ticks.map(function (t) { return t + Math.log10(3); })) : D.ticks;
    levels.forEach(function (lv) {
      var yl = D.Y(lv); if (!(yl > -EX[1] + 1e-6 && yl < EX[1] - 1e-6)) return;
      var col = 'rgba(' + atlasRamp((yl + EX[1]) / (2 * EX[1])).map(Math.round).join(',') + ',0.6)';
      for (var i = 0; i < D.n1 - 1; i++) for (var j = 0; j < D.n2 - 1; j++) {
        var c4 = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]], v4 = c4.map(function (c) { return S0.y[c[0]][c[1]]; });
        if (v4.some(function (v) { return v == null; })) continue;
        var cr = [];
        for (var k = 0; k < 4; k++) {
          var a = v4[k], b = v4[(k + 1) % 4];
          if ((a - yl) * (b - yl) < 0) { var f = (yl - a) / (b - a), p0 = c4[k], p1 = c4[(k + 1) % 4];
            cr.push(P(D.xs[p0[0]] + (D.xs[p1[0]] - D.xs[p0[0]]) * f, -EX[1], D.zs[p0[1]] + (D.zs[p1[1]] - D.zs[p0[1]]) * f)); }
        }
        if (cr.length >= 2) line(cr[0], cr[1], col, 1.2);
        if (cr.length === 4) line(cr[2], cr[3], col, 1.2);
      }
    });
  }
  /* surface quads, far to near */
  var quads = [], L = [-0.35, 0.62, 0.7], Ln = Math.hypot(L[0], L[1], L[2]); L = L.map(function (v) { return v / Ln; });
  var byClass = ATLAS.s3.color === 'class' && D.surfaces.length === 1;
  D.surfaces.forEach(function (S) {
    for (var i = 0; i < D.n1 - 1; i++) for (var j = 0; j < D.n2 - 1; j++) {
      var c4 = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      if (c4.some(function (c) { return S.y[c[0]][c[1]] == null; })) continue;
      var M = c4.map(function (c) { return [D.xs[c[0]], S.y[c[0]][c[1]], D.zs[c[1]]]; });
      var pts = M.map(function (q) { return P(q[0], q[1], q[2]); });
      var u = [M[2][0] - M[0][0], M[2][1] - M[0][1], M[2][2] - M[0][2]], w = [M[3][0] - M[1][0], M[3][1] - M[1][1], M[3][2] - M[1][2]];
      var nm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      var nv = [Q[0] * nm[0] + Q[1] * nm[1] + Q[2] * nm[2], Q[3] * nm[0] + Q[4] * nm[1] + Q[5] * nm[2], Q[6] * nm[0] + Q[7] * nm[1] + Q[8] * nm[2]];
      var nl = Math.hypot(nv[0], nv[1], nv[2]) || 1, lam = Math.abs((nv[0] * L[0] + nv[1] * L[1] + nv[2] * L[2]) / nl);
      var base;
      if (S.color) base = S.color;
      else if (byClass) {
        var cnt = [0, 0, 0]; c4.forEach(function (c) { var r = D.cell[c[0]][c[1]]; if (r) cnt[r.cls]++; });
        base = atlasHexRgb(ATLAS_COL.cls[cnt.indexOf(Math.max.apply(null, cnt))]);
      } else base = atlasRamp(((M[0][1] + M[1][1] + M[2][1] + M[3][1]) / 4 + EX[1]) / (2 * EX[1]));
      var k = 0.5 + 0.55 * lam, rgb = base.map(function (v) { return Math.min(255, Math.round(v * k)); });
      quads.push({ z: (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4, pts: pts, fill: 'rgba(' + rgb.join(',') + ',' + (S.color ? 0.66 : 0.97) + ')' });
    }
  });
  quads.sort(function (a, b) { return a.z - b.z; });
  quads.forEach(function (q) { poly(q.pts, q.fill, 'rgba(6,8,15,0.32)', 0.6); });
  /* selected run and hover */
  var hot = [], cur = D.cur, ci = cur && cur.run.grid;
  D.surfaces.forEach(function (S) {
    for (var i = 0; i < D.n1; i++) for (var j = 0; j < D.n2; j++) if (S.y[i][j] != null) {
      var p = P(D.xs[i], S.y[i][j], D.zs[j]); hot.push({ x: p[0], y: p[1], i: i, j: j, k: S.key, id: D.cell[i][j].run.id });
    }
  });
  ATLAS._s3HotList = hot;
  if (ci) D.surfaces.forEach(function (S) {
    var yv = S.y[ci[0]] && S.y[ci[0]][ci[1]]; if (yv == null) return;
    var top = P(D.xs[ci[0]], yv, D.zs[ci[1]]), bot = P(D.xs[ci[0]], -EX[1], D.zs[ci[1]]);
    line(bot, top, 'rgba(224,224,255,0.7)', 1.2, [4, 3]);
    g.beginPath(); g.arc(top[0], top[1], 5.5, 0, 6.2832); g.fillStyle = S.color ? 'rgb(' + S.color.join(',') + ')' : '#e0e0ff'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#06080f'; g.stroke();
  });
  if (ATLAS._s3Hot) { var h = ATLAS._s3Hot; g.beginPath(); g.arc(h.x, h.y, 6, 0, 6.2832); g.lineWidth = 2; g.strokeStyle = '#e0e0ff'; g.stroke(); }
  /* axes: labels on the floor edges nearest the viewer, value axis on the leftmost vertical edge */
  g.font = '10px "JetBrains Mono", monospace'; g.fillStyle = '#888';
  var ctr = P(0, 0, 0);
  function edgeLabels(fixedAxis, run, ticks, title) {
    var best = null;
    [-1, 1].forEach(function (sv) {
      var q0 = [0, -EX[1], 0], q1 = [0, -EX[1], 0]; q0[fixedAxis] = q1[fixedAxis] = sv * EX[fixedAxis]; q0[run] = -EX[run]; q1[run] = EX[run];
      var a = P(q0[0], q0[1], q0[2]), b = P(q1[0], q1[1], q1[2]), my = (a[1] + b[1]) / 2;
      if (!best || my > best.my) best = { sv: sv, my: my };
    });
    var mid = [0, -EX[1], 0]; mid[fixedAxis] = best.sv * EX[fixedAxis];
    var pm = P(mid[0], mid[1], mid[2]), dx = pm[0] - ctr[0], dy = pm[1] - ctr[1], dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    g.textAlign = dx > 0.3 ? 'left' : dx < -0.3 ? 'right' : 'center'; g.fillStyle = '#888';
    ticks.forEach(function (t) { var q = mid.slice(); q[run] = t.p; var p = P(q[0], q[1], q[2]); g.fillText(t.t, p[0] + dx * 12, p[1] + dy * 12 + 3); });
    g.fillStyle = '#7c8aaa'; g.font = '11px "JetBrains Mono", monospace';
    var tm = mid.slice(); tm[run] = 0; var pt = P(tm[0], tm[1], tm[2]); g.fillText(title, pt[0] + dx * 34, pt[1] + dy * 34 + 4);
    g.font = '10px "JetBrains Mono", monospace';
  }
  edgeLabels(2, 0, tx, D.a1.label + atlasAxNote(D.a1));
  edgeLabels(0, 2, tz, D.a2.label);
  var bestV = null;
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (c) { var p = P(c[0] * EX[0], 0, c[1] * EX[2]); if (!bestV || p[0] < bestV.x) bestV = { x: p[0], c: c }; });
  g.textAlign = 'right'; g.fillStyle = '#888';
  ty.forEach(function (t) { var p = P(bestV.c[0] * EX[0], t.p, bestV.c[1] * EX[2]); g.fillText(t.t, p[0] - 8, p[1] + 3); });
  var ptop = P(bestV.c[0] * EX[0], EX[1], bestV.c[1] * EX[2]);
  g.fillStyle = '#7c8aaa'; g.font = '11px "JetBrains Mono", monospace'; g.textAlign = 'center';
  g.fillText((D.isVf ? 'Solid fraction' : (atlasEs() ? 'E' : 'E / E solid')) + (D.useLog ? ' (log)' : ''), ptop[0], ptop[1] - 12);
}
function atlasS3Hover(e) {
  var list = ATLAS._s3HotList, cv = swEl('atS3c'), tip = swEl('atTip');
  if (!list || !cv || e.buttons) return;
  var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, best = null, bd = 14 * 14;
  list.forEach(function (h) { var d = (h.x - x) * (h.x - x) + (h.y - y) * (h.y - y); if (d < bd) { bd = d; best = h; } });
  var prev = ATLAS._s3Hot; ATLAS._s3Hot = best;
  if (!best) { tip.hidden = true; if (prev) atlasS3Queue(); return; }
  var D = ATLAS._s3, row = D.cell[best.i][best.j];
  var v = atlasS3Val(row, best.k);
  tip.innerHTML = '<b>' + swEsc(row.run.id) + '</b> · ' + ATLAS_CLASS[row.cls] + '<br>' + swEsc(D.a1.label) + ' = ' + swEsc(sweepFmtVal(D.a1.values[best.i])) + atlasAxSuffix(D.a1) +
    '<br>' + swEsc(D.a2.label) + ' = ' + swEsc(sweepFmtVal(D.a2.values[best.j])) + '<br>' + (best.k === 'vf' ? 'Solid ' + (v * 100).toFixed(1) + ' %' :
    (D.surfaces.length > 1 ? best.k : ATLAS._s3.metricLabel) + ' = ' + atlasFmtE(v) + ' · ' + (row.vf * 100).toFixed(1) + ' % solid');
  tip.hidden = false;
  var pr = tip.parentNode.getBoundingClientRect(), tw = tip.offsetWidth || 200, lx = e.clientX - pr.left + 14;
  if (lx + tw > pr.width - 8) lx = e.clientX - pr.left - tw - 14;
  tip.style.left = lx + 'px'; tip.style.top = (e.clientY - pr.top + 14) + 'px';
  if (!prev || prev.id !== best.id || prev.k !== best.k) atlasS3Queue();
}

/* ── Data check ──────────────────────────────────────────── */
function atlasChecks(rows, S) {
  var el = swEl('atChecks'), wasOpen = el.open, items = [];
  function add(kind, t, d) { items.push({ kind: kind, t: t, d: d }); }
  var total = SWEEP_STATE.runs.length, errs = 0;
  for (var id in SWEEP_STATE.results) if (SWEEP_STATE.results[id] && SWEEP_STATE.results[id].error) errs++;
  add(rows.length === total ? 'pass' : 'note', 'Runs solved', rows.length + ' of ' + total + ' runs have results' + (errs ? '; ' + errs + ' failed' : '') + '.');
  var nc = rows.filter(function (r) { return !r.res.converged; }).length;
  add(nc ? 'flag' : 'pass', 'Solver convergence', nc ? nc + ' runs hit the iteration cap before reaching the tolerance.' : 'Every run converged to its tolerance on every load case.');
  var npd = rows.filter(function (r) { return r.eig[5] < -1e-6 * r.eig[0]; });
  add(npd.length ? 'flag' : 'pass', 'Physically admissible', npd.length ? npd.length + ' matrices have a negative eigenvalue beyond noise (' + npd.slice(0, 5).map(function (r) { return r.run.id; }).join(', ') + ').' :
    'Every stiffness matrix is positive semi-definite (worst eigenvalue ' + Math.min.apply(null, rows.map(function (r) { return r.eig[5] / r.eig[0]; })).toExponential(1) + ' of its largest).');
  var negS = rows.filter(function (r) { return r.C[21] < 0 || r.C[28] < 0 || r.C[35] < 0; });
  add(negS.length ? 'flag' : 'pass', 'Shear stiffness', negS.length ? negS.length + ' run' + (negS.length > 1 ? 's have' : ' has') + ' a negative shear term (' + negS.slice(0, 6).map(function (r) {
      return r.run.id + ' ' + ['C44', 'C55', 'C66'].filter(function (k, i) { return r.C[21 + 7 * i] < 0; }).join('/'); }).join(', ') + '). Not physical; rerun at high precision to see whether it is the solver tolerance.' :
    'C44, C55 and C66 are positive on every run.');
  var nl = rows.filter(function (r) { return r.res.noLoad; });
  if (nl.length) add('note', 'Axes with no load', nl.length + ' run' + (nl.length > 1 ? 's' : '') + ' (' + nl.slice(0, 6).map(function (r) { return r.run.id + ' ' + r.res.noLoad.map(function (b) { return b.axis; }).join(''); }).join(', ') +
    ') read zero on some axes within solver noise, sometimes a hair below zero. Kept with a warning; the solver alone rejects them.');
  var over = rows.filter(function (r) { return Math.max(r.Ex, r.Ey, r.Ez) > r.vf * 1.01; });
  add(over.length ? 'flag' : 'pass', 'Voigt bound', over.length ? over.length + ' runs exceed E ≤ solid fraction × E solid (' + over.slice(0, 5).map(function (r) { return r.run.id; }).join(', ') + ').' : 'No run exceeds E ≤ solid fraction × E solid.');
  var dips = [];
  S.order.forEach(function (k) {
    var list = S.map[k].slice().sort(function (a, b) { return a.vf - b.vf; });
    for (var i = 1; i < list.length; i++) ['Ex', 'Ey', 'Ez'].forEach(function (q) {
      if (list[i].vf > list[i - 1].vf + 1e-4 && list[i][q] < list[i - 1][q] * 0.97 && list[i - 1][q] > 1e-4) dips.push(list[i].run.id + ' ' + q);
    });
  });
  add(dips.length ? 'note' : 'pass', 'Stiffness rises with solid fraction', dips.length ? dips.length + ' places where stiffness drops by more than 3 % as solid increases within a series (' + dips.slice(0, 6).join(', ') + '). Expected where topology changes (shifts, contacts forming).' : 'Within every series, each axis stiffens as solid fraction rises.');
  var counts = [0, 0, 0]; rows.forEach(function (r) { counts[r.cls]++; });
  add('note', 'Connectivity', counts[2] + ' connected 3-D lattices, ' + counts[1] + ' partially connected, ' + counts[0] + ' strands only. Counted from eigenvalues of the stiffness matrix above 1 % of the largest: 6 = connected, 1 = strands.');
  var thin = 0, trim = 0;
  rows.forEach(function (r) { var st = SWEEP_STATE.preview[r.run.id]; if (st && st.thinVox != null && st.thinVox < SWEEP_THIN_VOX) thin++; if (r.res.trim_removed_pct > 0.005) trim++; });
  if (thin) add('flag', 'Resolution', thin + ' runs have features thinner than ' + SWEEP_THIN_VOX + ' voxels at their grid; their stiffness reads low. A finer grid or the second-grid extrapolation helps.');
  if (trim) add('note', 'Island trim', trim + ' runs had floating pieces removed before solving.');
  var voids = {}; rows.forEach(function (r) { voids[r.res.voidRatio != null ? r.res.voidRatio : 1e-4] = 1; });
  if (voids['0.0001']) add('flag', 'Void stiffness 1e-4', 'Some runs used the lab’s default void stiffness (1e-4 of the solid), which adds about 1e-4 to every direction — significant under ~20 % solid. Sweeps default to 1e-6.');
  var pass = items.filter(function (x) { return x.kind === 'pass'; }).length, flag = items.filter(function (x) { return x.kind === 'flag'; }).length, note = items.length - pass - flag;
  el.innerHTML = '<summary><span class="at-dct">Data check</span><span class="at-chip pass">✓ ' + pass + ' pass</span>' + (flag ? '<span class="at-chip flag">! ' + flag + ' flag' + (flag > 1 ? 's' : '') + '</span>' : '') +
    (note ? '<span class="at-chip note">i ' + note + ' note' + (note > 1 ? 's' : '') + '</span>' : '') + '</summary><div class="at-checkgrid">' +
    items.map(function (x) { return '<div class="at-check"><span class="at-chip ' + x.kind + '">' + (x.kind === 'pass' ? '✓ Pass' : x.kind === 'flag' ? '! Flag' : 'i Note') + '</span><div><div class="t">' + swEsc(x.t) + '</div><div class="d">' + swEsc(x.d) + '</div></div></div>'; }).join('') + '</div>';
  el.open = wasOpen;
}
