/* ============================================================
   F13LD.lab · 31-geom-views.js
   v0.35.0 — Geometry tab views: Shaded, Curvature, Overhang, Wall
   thickness, Pore size.  No solver: the viewer reads them off its
   own field (21-raymarcher.js geomColor).  One picker row under the
   view strip; every tile shares the view, the scale and, in the
   data views, the pose.  Accuracy: proto/geom-views/curvature_check.js.
   ============================================================ */

var GEOM_VIEWS = [
  { id: 'shaded',    label: 'Shaded',         tip: 'The shaded view; turns until you grab it' },
  { id: 'curvature', label: 'Curvature',      tip: 'How the surface bends' },
  { id: 'overhang',  label: 'Overhang',       tip: 'Faces that need support for a build direction' },
  { id: 'wall',      label: 'Wall thickness', tip: 'Thickness through the solid, measured along the surface normal' },
  { id: 'pore',      label: 'Pore size',      tip: 'Gap across the pore, measured along the surface normal. Good for finding tight gaps; not a true pore diameter' }
];
var GEOM_KINDS = [
  { id: 'mean',     label: 'Mean',            tip: 'Average bending; close to zero on a minimal surface' },
  { id: 'gauss',    label: 'Gaussian',        tip: 'Dome (positive) or saddle (negative)' },
  { id: 'tightest', label: 'Tightest radius', tip: 'Smallest bend radius at each point' }
];

/* Settings a user would keep (limits, scales) persist per browser; the view itself starts Shaded. */
var GEOM_DEFAULTS = { kind: 'mean', build: 'z', curvRange: 1.5, tightest: 3, overhang: 45, wallMin: 0.4, wallScale: 2, poreMin: 0.5, poreScale: 4 };
var GEOM_KEY = 'f13ld.lab.geomViews.v1';
VIEW_STATE.geom = (function(){
  var g = { view: 'shaded' }, k;
  for (k in GEOM_DEFAULTS) g[k] = GEOM_DEFAULTS[k];
  try {
    var j = JSON.parse(localStorage.getItem(GEOM_KEY) || 'null');
    if (j && typeof j === 'object') for (k in GEOM_DEFAULTS) if (typeof j[k] === typeof GEOM_DEFAULTS[k]) g[k] = j[k];
  } catch (e) {}
  return g;
})();
function geomViewSave(){
  var o = {}, g = VIEW_STATE.geom;
  for (var k in GEOM_DEFAULTS) o[k] = g[k];
  try { localStorage.setItem(GEOM_KEY, JSON.stringify(o)); } catch (e) {}
}

function geomViewIndex(){
  for (var i = 0; i < GEOM_VIEWS.length; i++) if (GEOM_VIEWS[i].id === VIEW_STATE.geom.view) return i;
  return 0;
}
function geomViewRange(){
  var g = VIEW_STATE.geom;
  if (g.view === 'curvature') return g.kind === 'tightest' ? g.tightest : g.curvRange;
  if (g.view === 'wall') return g.wallScale;
  if (g.view === 'pore') return g.poreScale;
  return 1;
}
function geomViewLimit(){
  var g = VIEW_STATE.geom;
  if (g.view === 'overhang') return g.overhang;
  if (g.view === 'wall') return g.wallMin;
  if (g.view === 'pore') return g.poreMin;
  return 0;
}

/* Push the settings to every tile.  Called from renderDesignGrid and on any change here;
   no grid re-render, so a slider stays smooth.  mm per world unit comes from each design's
   own cell, on the one shared scale. */
function geomViewApply(){
  if (typeof LAB_RM_REGISTRY === 'undefined' || !LAB_STATE || !LAB_STATE.designs) return;
  var g = VIEW_STATE.geom, view = geomViewIndex(), first = null;
  var kind = g.kind === 'gauss' ? 1 : (g.kind === 'tightest' ? 2 : 0);
  var build = g.build === 'x' ? [1, 0, 0] : (g.build === 'y' ? [0, 1, 0] : [0, 0, 1]);
  for (var i = 0; i < LAB_STATE.designs.length; i++){
    var d = LAB_STATE.designs[i], rm = LAB_RM_REGISTRY[d.id];
    if (!rm || rm.failed || !rm.setGeomView) continue;
    var cell = (isFinite(d.cell_mm) && d.cell_mm > 0) ? d.cell_mm : 5;
    rm.setGeomView({ view: view, kind: kind, range: geomViewRange(), limit: geomViewLimit(), mm: cell / (2 * Math.PI), build: build });
    if (!first) first = rm;
  }
  if ((view || LAB_GEOM_HELD) && first && typeof labGeomLinkPose === 'function') labGeomLinkPose(first);   /* tiles line up on entering a data view, or when a design joins */
  geomNumsRequest();   /* v0.36.0 */
  geomNumsPaint();
}

/* ── v0.36.0 — one number per design on each tile (decision 0010) ─────────
   Wall thickness → thinnest wall, Pore size → tightest gap, Curvature → tightest radius.
   Wall and gap: the sweep's thinnest-feature measure (largest ball that fits, 5th percentile, 14d)
   on a 96³ grid, after the island trim the solvers use.  Radius: 5th percentile of the tightest bend
   over the drawn surface, from the tile's own field (14f).  Both run in the background on the
   geometry pool (17c, low priority) the first time a design shows on the Geometry tab; the chip
   appears when its number arrives, with no waiting note.  Lab's tile chip (.vp-buckle-chip). */
var GEOM_NUM_N = 96;
var GEOM_NUMS = {};   /* design id → { wgKey, wgBusy, wall, gap, rKey, rBusy, r5, rN } */
function geomNumsRequest(){
  if (VIEW_STATE.mode !== 'geom' || typeof LAB_RM_REGISTRY === 'undefined' || !LAB_STATE || !LAB_STATE.designs) return;
  if (typeof labGeomWallGapAsync !== 'function') return;
  var conn = (typeof connOpts === 'function') ? connOpts() : { connectivity: 'networks', pruneLargest: true };
  LAB_STATE.designs.forEach(function (d){
    var rm = LAB_RM_REGISTRY[d.id];
    if (!rm || rm.failed || !rm._recipe) return;
    var recipe = rm._recipe;
    if (rm._numFpOf !== recipe){   /* fingerprint once per recipe, not on every slider tick */
      rm._numFpOf = recipe; rm._numFp = (typeof recipeFingerprint === 'function') ? recipeFingerprint(recipe) : JSON.stringify(recipe);
    }
    var fp = rm._numFp;
    var e = GEOM_NUMS[d.id] || (GEOM_NUMS[d.id] = {});
    var wgKey = fp + '|' + GEOM_NUM_N + '|' + (conn.connectivity || 'networks');
    if (e.wgKey !== wgKey && e.wgBusy !== wgKey){
      e.wgBusy = wgKey;
      labGeomWallGapAsync(recipe, GEOM_NUM_N, conn).then(function (r){
        if (e.wgBusy !== wgKey) return;
        e.wgBusy = null; e.wgKey = wgKey; e.wall = r ? r.wallVox : null; e.gap = r ? r.gapVox : null;
        geomNumsPaint();
      }).catch(function (err){
        if (e.wgBusy !== wgKey) return;
        e.wgBusy = null; e.wgKey = wgKey; e.wall = e.gap = null;
        console.warn('[geometry numbers] wall / gap failed:', err && err.message);
      });
    }
    if (!rm._geomData || rm._baking) return;   /* radius waits for the tile's field */
    var rKey = fp + '|' + rm._geomN;
    if (e.rKey !== rKey && e.rBusy !== rKey){
      e.rBusy = rKey;
      var rN = rm._geomN;
      labGeomRadiusAsync(rm._geomData, rm._geomDataB, rN, rm._u).then(function (r){
        if (e.rBusy !== rKey) return;
        e.rBusy = null; e.rKey = rKey; e.r5 = r ? r.r5 : null; e.rN = rN;
        geomNumsPaint();
      }).catch(function (err){
        if (e.rBusy !== rKey) return;
        e.rBusy = null; e.rKey = rKey; e.r5 = null;
        console.warn('[geometry numbers] radius failed:', err && err.message);
      });
    }
  });
}
function geomNumsPoke(){ geomNumsRequest(); geomNumsPaint(); }   /* 21 — a tile's field arrived */
function geomNumFmt(mm){ return mm < 10 ? mm.toFixed(2) : mm.toFixed(1); }
/* { cls, lbl, val, tip } for a design in the current view, or null */
function geomNumChip(d){
  var g = VIEW_STATE.geom, e = GEOM_NUMS[d.id];
  if (!e) return null;
  var cell = (isFinite(d.cell_mm) && d.cell_mm > 0) ? d.cell_mm : 5;
  if (g.view === 'wall' || g.view === 'pore'){
    var wall = g.view === 'wall', vox = wall ? e.wall : e.gap;
    if (vox == null || e.wgKey == null) return null;
    var mm = vox / GEOM_NUM_N * cell, lim = wall ? g.wallMin : g.poreMin;
    return { cls: mm < lim ? 'geom-low' : 'geom-ok', lbl: wall ? 'thinnest wall' : 'tightest gap', val: geomNumFmt(mm) + ' mm',
      tip: wall
        ? 'Thinnest wall: 95 % of the walls are thicker than this. Measured as the largest ball that fits inside the solid on a 96³ grid, the same measure as the sweep’s thinnest feature, so it can read a little thicker than the colours, which measure straight through. Red when under the minimum.'
        : 'Tightest gap: 95 % of the pore space is wider than this. Measured as the largest ball that fits in the pore on a 96³ grid, the same measure the sweep uses for walls. Red when under the minimum.' };
  }
  if (g.view === 'curvature'){
    if (e.rKey == null || e.r5 == null) return null;
    var step = cell / (e.rN || 48);
    var val = isFinite(e.r5) ? 'r ' + geomNumFmt(e.r5 * cell / (2 * Math.PI)) + ' mm' : 'flat';
    return { cls: '', lbl: 'tightest radius', val: val,
      tip: 'Tightest bend radius: 95 % of the surface bends more gently than this. Read from the same curvature the colours show; radii under one grid step (' + geomNumFmt(step) + ' mm here) read as about one step.' };
  }
  return null;
}
function geomNumsPaint(){
  if (typeof document === 'undefined' || !LAB_STATE || !LAB_STATE.designs) return;
  var on = VIEW_STATE.mode === 'geom', byId = {};
  LAB_STATE.designs.forEach(function (d){ byId[d.id] = d; });
  var mounts = document.querySelectorAll('.rm-mount[data-design-id]');
  for (var i = 0; i < mounts.length; i++){
    var vp = mounts[i].parentNode, d = byId[mounts[i].getAttribute('data-design-id')];
    if (!vp) continue;
    var chip = vp.querySelector('.geom-num'), c = (on && d) ? geomNumChip(d) : null;
    if (!c){ if (chip) chip.parentNode.removeChild(chip); continue; }
    if (!chip){ chip = document.createElement('div'); vp.appendChild(chip); }
    chip.className = 'vp-buckle-chip geom-num' + (c.cls ? ' ' + c.cls : '');
    chip.title = c.tip;
    chip.innerHTML = '<span class="lbl">' + c.lbl + '</span><span class="val">' + c.val + '</span>';
  }
}

function geomSlider(key, label, min, max, step, fmt, tip){
  return '<span class="fa-sl geom-sl" title="' + tip + '"><span class="fa-l">' + label + '</span>' +
    '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + VIEW_STATE.geom[key] + '"' +
    ' data-key="' + key + '" data-fmt="' + fmt + '" oninput="onGeomSlider(this)">' +
    '<span class="fa-v">' + geomFmt(fmt, VIEW_STATE.geom[key]) + '</span></span>';
}
function geomFmt(fmt, v){
  if (fmt === 'mm') return v.toFixed(2) + ' mm';
  if (fmt === 'mm1') return v.toFixed(1) + ' mm';
  if (fmt === 'deg') return Math.round(v) + '°';
  if (fmt === 'r') return 'r ' + (1 / v).toFixed(2) + ' mm';
  if (fmt === 'curv') return '±' + v.toFixed(1) + (VIEW_STATE.geom.kind === 'gauss' ? ' /mm²' : ' /mm');
  return String(v);
}
function geomPickBtns(label, items, cur, fn){
  var h = '<div class="cp-seg" role="group" aria-label="' + label + '"><span class="lbl">' + label + '</span>';
  for (var i = 0; i < items.length; i++){
    var on = items[i].id === cur;
    h += '<button type="button"' + (on ? ' class="on"' : '') + ' aria-pressed="' + on + '" title="' + (items[i].tip || '') + '" onclick="' + fn + '(\'' + items[i].id + '\')">' + items[i].label + '</button>';
  }
  return h + '</div>';
}

/* v0.35.1 — Turn again: Shaded stops turning once a tile is grabbed (v0.35.0); this starts it again.
   Shown on Shaded only, and only once the tiles hold still.  Lab's icon style (40×40, round caps,
   neon accent node). */
var GEOM_TURN_ICON = '<svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M33 21 A 13 13 0 1 1 29.5 11.5"/><path d="M30.5 4.5 V12 H23"/>' +
  '<path d="M20 13.5 L26 17 V23.5 L20 27 L14 23.5 V17 Z" stroke-width="2" opacity=".75"/><circle class="acc" cx="20" cy="20.3" r="2.8"/></svg>';
function geomTurnBtn(){
  return '<button type="button" class="geom-turn" title="Turn again" aria-label="Turn again" onclick="onGeomTurnAgain()">' + GEOM_TURN_ICON + '</button>';
}
function onGeomTurnAgain(){
  LAB_GEOM_HELD = false;   /* 21 — every Geometry tile turns again until the next grab */
  for (var id in LAB_RM_REGISTRY) if (LAB_RM_REGISTRY[id]) LAB_RM_REGISTRY[id]._dirty = true;
  geomViewRowBuild();
}

function geomViewRowBuild(){
  var row = document.getElementById('geomViewRow');
  if (!row) return;
  var g = VIEW_STATE.geom, h = geomPickBtns('View', GEOM_VIEWS, g.view, 'onGeomViewPick');
  if (g.view === 'shaded' && typeof LAB_GEOM_HELD !== 'undefined' && LAB_GEOM_HELD){
    var cut = h.indexOf('</button>') + 9;   /* right after Shaded, inside the same group */
    h = h.slice(0, cut) + geomTurnBtn() + h.slice(cut);
  }
  if (g.view === 'curvature'){
    h += geomPickBtns('Measure', GEOM_KINDS, g.kind, 'onGeomKindPick');
    h += g.kind === 'tightest'
      ? geomSlider('tightest', 'tightest', 1, 8, 0.1, 'r', 'The radius at the top of the colour scale')
      : geomSlider('curvRange', 'range', 0.5, 6, 0.1, 'curv', 'The value at each end of the colour scale');
  } else if (g.view === 'overhang'){
    h += geomPickBtns('Build', [{ id: 'x', label: 'X', tip: 'Build direction X' }, { id: 'y', label: 'Y', tip: 'Build direction Y' }, { id: 'z', label: 'Z', tip: 'Build direction Z' }], g.build, 'onGeomBuildPick');
    h += geomSlider('overhang', 'limit', 30, 60, 1, 'deg', 'Steepest self-supporting face, measured from the build plate');
  } else if (g.view === 'wall'){
    h += geomSlider('wallMin', 'minimum', 0.1, 1.5, 0.05, 'mm', 'Thinner walls turn red') + geomSlider('wallScale', 'scale', 1, 5, 0.1, 'mm1', 'The thickness at the top of the colour scale');
  } else if (g.view === 'pore'){
    h += geomSlider('poreMin', 'minimum', 0.1, 2, 0.05, 'mm', 'Tighter gaps turn red') + geomSlider('poreScale', 'scale', 1, 6, 0.1, 'mm1', 'The gap at the top of the colour scale');
  }
  row.innerHTML = h + '<span class="geom-legend" id="geomLegend"></span>';
  geomLegendPaint();
}

var GEOM_RAMPS = {
  coolwarm: [[0.2298,0.2987,0.7537],[0.5543,0.6901,0.9955],[0.8654,0.8654,0.8654],[0.9567,0.5980,0.4773],[0.7057,0.0156,0.1502]],
  turbo: [[0.14,0.15,0.5],[0.15,0.4,0.95],[0.1,0.7,0.9],[0.15,0.9,0.55],[0.55,0.98,0.25],[0.95,0.85,0.15],[0.97,0.5,0.15],[0.88,0.13,0.08]],
  cividis: [[0,0.1255,0.302],[0.1098,0.2431,0.3961],[0.2353,0.3451,0.4706],[0.3569,0.4471,0.4863],[0.498,0.5373,0.4588],[0.6667,0.6353,0.3882],[0.8471,0.7569,0.298],[1,0.9176,0.2745]]
};
function geomRampCss(name, limitFrac){
  var s = GEOM_RAMPS[name], stops = [];
  if (limitFrac != null) stops.push('#d94040 0', '#d94040 ' + (limitFrac * 100).toFixed(1) + '%');
  var from = limitFrac != null ? limitFrac : 0;
  for (var i = 0; i < 12; i++){
    var f = i / 11, x = f * (s.length - 1), k = Math.min(Math.floor(x), s.length - 2), t = x - k, c = [];
    for (var j = 0; j < 3; j++) c.push(Math.round(255 * (s[k][j] + (s[k + 1][j] - s[k][j]) * t)));
    if (f < from) continue;
    stops.push('rgb(' + c.join(',') + ') ' + (f * 100).toFixed(1) + '%');
  }
  return 'linear-gradient(90deg,' + stops.join(',') + ')';
}
function geomLegendPaint(){
  var el = document.getElementById('geomLegend');
  if (!el) return;
  var g = VIEW_STATE.geom, h = '';
  function bar(css, lo, hi, note){
    return '<span class="gl-v">' + lo + '</span><span class="gl-bar" style="background:' + css + '"></span><span class="gl-v">' + hi + '</span>' + (note ? '<span class="gl-n">' + note + '</span>' : '');
  }
  function swatch(col, txt){ return '<span class="gl-sw" style="background:' + col + '"></span><span class="gl-n">' + txt + '</span>'; }
  if (g.view === 'curvature' && g.kind === 'tightest'){
    h = bar(geomRampCss('turbo'), 'flat', 'r ≤ ' + (1 / g.tightest).toFixed(2) + ' mm', 'tightest radius');
  } else if (g.view === 'curvature'){
    var v = g.kind === 'gauss' ? (g.curvRange * g.curvRange).toFixed(1) + ' /mm²' : g.curvRange.toFixed(1) + ' /mm';
    h = bar(geomRampCss('coolwarm'), '−' + v, '+' + v, g.kind === 'gauss' ? 'red dome · blue saddle' : 'red convex solid · blue concave fillet');
  } else if (g.view === 'overhang'){
    h = swatch('#d94040', 'needs support') + swatch('#e0a33a', 'within 10°') + swatch('#1d9e75', 'self-supporting');
  } else if (g.view === 'wall' || g.view === 'pore'){
    var mx = geomViewRange(), lim = geomViewLimit();
    h = bar(geomRampCss('cividis', Math.min(lim / mx, 1)), '0', '≥ ' + mx.toFixed(1) + ' mm', 'red below ' + lim.toFixed(2) + ' mm');
  }
  /* Stretched cells are drawn and solved as cubes (v0.26.1), so a value in mm would mislead */
  if (g.view !== 'shaded' && g.view !== 'overhang' && typeof labCellStretch === 'function' && LAB_STATE && LAB_STATE.designs){
    for (var i = 0; i < LAB_STATE.designs.length; i++){
      if (labCellStretch(LAB_STATE.designs[i].raw_json)){ h += '<span class="gl-n">stretched cells: drawn as cubes, mm values approximate</span>'; break; }
    }
  }
  el.innerHTML = h;
}

function geomViewRowSync(){
  var row = document.getElementById('geomViewRow');
  if (!row) return;
  var on = (VIEW_STATE.mode === 'geom');
  row.classList.toggle('show', on);
  if (on && !row.firstChild) geomViewRowBuild();
}
function geomViewChanged(rebuild){
  if (rebuild) geomViewRowBuild(); else geomLegendPaint();
  geomViewSave();
  geomViewApply();   /* also repaints the tile numbers (red under a moved minimum) */
}
function onGeomViewPick(v){ VIEW_STATE.geom.view = v; geomViewChanged(true); }
function onGeomKindPick(k){ VIEW_STATE.geom.kind = k; geomViewChanged(true); }
function onGeomBuildPick(a){ VIEW_STATE.geom.build = a; geomViewChanged(true); }
function onGeomSlider(el){
  VIEW_STATE.geom[el.dataset.key] = +el.value;
  var o = el.parentNode.querySelector('.fa-v');
  if (o) o.textContent = geomFmt(el.dataset.fmt, +el.value);
  geomViewChanged(false);
}
