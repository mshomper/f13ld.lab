/* ============================================================
   F13LD.lab · 24-flow-charts.js   (v0.31.0 — fluids Phase 3)
   Flow tab, "charts" view: every design (up to three) on one plot, in the
   merged area the crush comparison uses (#mergedView → #flowCharts).

   1. Wall at the shear target against flow speed (log speed axis), one line
      per design in its colour, a dot at its best speed.  Needs a target.
   2. Shear distribution: share of wall per log bin.  With a target, at each
      design's best speed (mPa) with the target band shaded; without one,
      per unit speed (mPa per mm/s, or Pa per m/s).

   Everything follows the cards: each design's direction (Flow settings) and
   best speed (19h flowShearStats via 40 flowCardPick).  Plotly is the
   vendored basic bundle (20b ensurePlotly).
   ============================================================ */

var FLOW_CHARTS = { gds: [] };

function flowChartsRelease() {
  if (typeof Plotly === 'undefined') { FLOW_CHARTS.gds = []; return; }
  FLOW_CHARTS.gds.forEach(function (gd) { try { Plotly.purge(gd); } catch (e) {} });
  FLOW_CHARTS.gds = [];
}

function _fcDesigns() {
  var out = [], ds = (typeof LAB_STATE !== 'undefined') ? LAB_STATE.designs : [];
  for (var i = 0; i < ds.length && i < 3; i++) {
    var d = ds[i], cp = flowCardPick(d);
    out.push({ d: d, cp: cp, letter: (typeof dletter === 'function') ? dletter(d, i) : String.fromCharCode(65 + i), color: d.color || '#aaaaaa' });
  }
  return out;
}

function _fcSwitch() {
  var v = VIEW_STATE.flowView;
  function vb(id, txt) { return '<button class="th-btn' + (v === id ? ' active' : '') + '" onclick="onFlowViewPick(\'' + id + '\')">' + txt + '</button>'; }
  return '<div class="th-toggle">' + vb('particles', 'flow') + vb('speed', 'speed') + vb('shear', 'shear') + vb('surface', 'K(n)') + vb('orient', 'orient') + vb('charts', 'charts') + '</div>';
}

function _fcLayout(xTitle, yTitle, extra) {
  var mono = (typeof CURVE_MONO !== 'undefined') ? CURVE_MONO : "'JetBrains Mono', monospace", grid = 'rgba(120,120,170,0.08)';
  var L = {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(6,8,15,0.35)', autosize: true,
    margin: { l: 56, r: 14, t: 10, b: 44 }, showlegend: false, hovermode: 'x unified',
    font: { family: mono, size: 11, color: '#8a8aa6' },
    hoverlabel: { bgcolor: 'rgba(14,14,26,0.96)', bordercolor: '#3a3a52', font: { family: mono, size: 11, color: '#e0e0ff' } },
    xaxis: { type: 'log', title: { text: xTitle, standoff: 6 }, gridcolor: grid, linecolor: '#2a2a3a', zeroline: false, exponentformat: 'none', tickformat: '~g' },
    yaxis: { title: { text: yTitle, standoff: 6 }, gridcolor: grid, linecolor: '#2a2a3a', zeroline: false, rangemode: 'tozero' }
  };
  if (extra) for (var k in extra) L[k] = extra[k];
  return L;
}
var FLOW_CHART_CONFIG = { responsive: true, displaylogo: false, scrollZoom: false,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'],
  toImageButtonOptions: { format: 'png', filename: 'f13ld-flow', scale: 3 } };

function renderFlowCharts() {
  var host = document.getElementById('flowCharts');
  if (!host) return;
  flowChartsRelease();
  var rows = _fcDesigns(), ok = rows.filter(function (r) { return r.cp.st; });
  var unit = (typeof FLOW_STATE !== 'undefined' && FLOW_STATE.speedUnit === 'm') ? 'm' : 'mm';
  var cfg0 = ok.length ? ok[0].cp.cfg : (typeof flowShearConfig === 'function' ? flowShearConfig(rows.length ? rows[0].d : null) : null);
  var tg = cfg0 && cfg0.targetInfo, fl = (typeof flowFluid === 'function') ? flowFluid() : null;
  var dirTxt = (typeof FLOW_STATE !== 'undefined' && FLOW_STATE.dir !== 'all') ? 'flow along ' + FLOW_STATE.dir.charAt(0).toUpperCase() : 'each design along its best direction';
  var sub = dirTxt + ' · ' + (fl ? fl.name.toLowerCase() : '') + ' · ' + (tg ? 'target ' + tg.label : 'no shear target');
  var h = '<div class="fc-head"><div class="fc-title">Flow · comparison<small>' + sub + '</small></div>' + _fcSwitch() + '</div>';
  if (!ok.length) {
    var why = rows.length ? (rows[0].cp.why || 'No wall shear data') : 'No designs loaded';
    host.innerHTML = h + '<div class="fc-empty">' + why + '</div>';
    return;
  }
  h += '<div class="fc-legend">' + ok.map(function (r) {
    return '<span><i style="background:' + r.color + '"></i>' + r.letter + ' · ' + (r.d.title || r.d.label || r.d.id) + ' · along ' + 'XYZ'[r.cp.pick.axis] + '</span>';
  }).join('') + '</div>';
  h += '<div class="fc-cap">Wall at the shear target against flow speed</div>';
  h += tg ? '<div class="fc-plot" id="fcCover"></div>' : '<div class="fc-empty">Set a shear target in Flow settings to see how much wall each design keeps in it at every flow speed.</div>';
  h += '<div class="fc-cap">' + (tg ? 'Shear distribution at each design’s best speed' : 'Shear distribution per unit flow speed') + '</div>';
  h += '<div class="fc-plot" id="fcDist"></div>';
  host.innerHTML = h;
  var draw = function () {
    if (typeof VIEW_STATE === 'undefined' || VIEW_STATE.mode !== 'flow' || VIEW_STATE.flowView !== 'charts') return;
    if (typeof Plotly === 'undefined') { var e = document.getElementById('fcDist'); if (e) e.innerHTML = '<div class="fc-empty">The plotting library did not load</div>'; return; }
    if (tg) _fcCoverPlot(document.getElementById('fcCover'), ok, unit);
    _fcDistPlot(document.getElementById('fcDist'), ok, unit, tg);
  };
  if (typeof Plotly !== 'undefined') draw();
  else if (typeof ensurePlotly === 'function') ensurePlotly(function () { draw(); });
  else draw();
}

/* 1 — wall share in the target vs superficial speed */
function _fcCoverPlot(el, rows, unit) {
  if (!el) return;
  var lo = Infinity, hi = 0;
  rows.forEach(function (r) {
    var st = r.cp.st;
    if (!(st.bestU > 0)) return;
    lo = Math.min(lo, (st.rangeLo || st.bestU) / 6); hi = Math.max(hi, (st.rangeHi || st.bestU) * 6);
  });
  if (!(hi > lo)) { el.innerHTML = '<div class="fc-empty">No flow speed puts wall in the target</div>'; return; }
  var sc = unit === 'm' ? 1 : 1000, traces = [], n = 180;
  rows.forEach(function (r) {
    var st = r.cp.st, t = r.cp.cfg.target;
    if (!(st.bestU > 0)) return;
    var x = [], y = [];
    for (var i = 0; i <= n; i++) {
      var u = lo * Math.pow(hi / lo, i / n);
      x.push(u * sc); y.push(100 * flowShareIn(st, t[0] / u, t[1] / u));
    }
    traces.push({ x: x, y: y, mode: 'lines', line: { color: r.color, width: 2.6, shape: 'spline', smoothing: 0.6 }, name: r.letter,
      hovertemplate: '<b>' + r.letter + '</b> %{y:.0f}% of wall<extra></extra>' });
    traces.push({ x: [st.bestU * sc], y: [100 * st.inTarget], mode: 'markers', marker: { color: r.color, size: 9, line: { color: '#0b0c14', width: 2 } },
      hovertemplate: '<b>' + r.letter + '</b> best %{x:.3~g} ' + flowSpeedUnit(unit) + ' · %{y:.0f}%<extra></extra>' });
  });
  Plotly.newPlot(el, traces, _fcLayout('superficial speed (' + flowSpeedUnit(unit) + ')', 'wall at target (%)',
    { yaxis: { title: { text: 'wall at target (%)', standoff: 6 }, range: [0, 100], gridcolor: 'rgba(120,120,170,0.08)', linecolor: '#2a2a3a', zeroline: false } }), FLOW_CHART_CONFIG);
  FLOW_CHARTS.gds.push(el);
}

/* 2 — area-weighted shear distribution on log bins */
function _fcDistPlot(el, rows, unit, tg) {
  if (!el) return;
  function q(st, f) { for (var i = 0; i < st.S.length; i++) if (st.C[i + 1] >= f) return st.S[i]; return st.S[st.S.length - 1]; }
  /* x per design: shear at best speed in mPa (target) or shear per unit speed (Pa per m/s = mPa per mm/s) */
  function xs(r) { return tg && r.cp.st.bestU > 0 ? r.cp.st.bestU * 1000 : 1; }
  var lo = Infinity, hi = 0;
  rows.forEach(function (r) { var k = xs(r); lo = Math.min(lo, q(r.cp.st, 0.005) * k); hi = Math.max(hi, q(r.cp.st, 0.995) * k); });
  if (tg) { lo = Math.min(lo, tg.lo / 3); hi = Math.max(hi, tg.hi * 3); }
  lo = Math.max(lo, hi * 1e-5);
  if (!(hi > lo)) { el.innerHTML = '<div class="fc-empty">No shear data</div>'; return; }
  var nb = 48, L0 = Math.log(lo), dL = (Math.log(hi) - L0) / nb, traces = [];
  rows.forEach(function (r) {
    var st = r.cp.st, k = xs(r), bins = new Float64Array(nb);
    for (var i = 0; i < st.S.length; i++) {
      var v = st.S[i] * k; if (!(v > 0)) continue;
      var b = Math.floor((Math.log(v) - L0) / dL);
      if (b < 0) b = 0; if (b >= nb) b = nb - 1;
      bins[b] += st.C[i + 1] - st.C[i];
    }
    var x = [], y = [];
    for (var b2 = 0; b2 < nb; b2++) { x.push(Math.exp(L0 + (b2 + 0.5) * dL)); y.push(100 * bins[b2]); }
    traces.push({ x: x, y: y, mode: 'lines', line: { color: r.color, width: 2.2, shape: 'spline', smoothing: 0.5 }, fill: 'tozeroy', fillcolor: _fcRgba(r.color, 0.10),
      hovertemplate: '<b>' + r.letter + '</b> %{y:.1f}% of wall<extra></extra>' });
  });
  var xt = tg ? 'wall shear at best speed (mPa)' : 'wall shear per ' + flowSpeedUnit(unit) + ' (' + flowShearUnit(unit) + ')';
  var extra = {};
  if (tg) extra.shapes = [{ type: 'rect', xref: 'x', yref: 'paper', x0: tg.lo, x1: tg.hi, y0: 0, y1: 1, fillcolor: 'rgba(29,158,117,0.10)', line: { width: 0 } }];
  Plotly.newPlot(el, traces, _fcLayout(xt, 'share of wall (%)', extra), FLOW_CHART_CONFIG);
  FLOW_CHARTS.gds.push(el);
}
function _fcRgba(hex, a) {
  var n = parseInt(String(hex || '#aaaaaa').slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
