/* ============================================================
   F13LD.lab · 20b-curve-plotly.js  (v0.17.0)
   Interactive stress–strain comparison (Nonlinear tab) on Plotly.

   - Plotly's basic bundle is vendored (vendor/plotly-basic-2.35.2.min.js,
     MIT) and loaded only when the Nonlinear tab first draws a curve; until
     it arrives — or if it fails — the SVG plot (20-svg-mocks.js) is shown.
   - One trace per (design, crushed axis): colour = design, dash = axis.
     The focus axis (NONLIN_STATE.view, or All) is bold with a glow, a soft
     gradient fill, its 0.2% offset line, a yield callout and its buckling
     line; the other axes are thin.  Lines are spline-smoothed through the
     solver's points (hover reads the solver points).
   - Stress scale: MPa / log / ÷ own yield.  Opens on ÷ own yield when the
     designs' strengths differ more than CURVE_AUTO_NORM_RATIO, until the
     user picks a scale.
   - Linked to the crush scrubber: hovering the plot scrubs the cubes to that
     strain (click pins it), and an amber strain cursor follows the scrubber
     and the auto-play (curvePlotCursor, called from nlvizApply).
   ============================================================ */

var CURVE_PLOTLY = { src: 'vendor/plotly-basic-2.35.2.min.js', loading: false, failed: false, waiters: [], gd: null };
var CURVE_AUTO_NORM_RATIO = 20;
var CURVE_AXES = ['xx', 'yy', 'zz'];
var CURVE_AXL = { xx: 'X', yy: 'Y', zz: 'Z' };
var CURVE_DASH = { xx: 'solid', yy: 'dash', zz: 'dot' };
var CURVE_MONO = 'JetBrains Mono, monospace', CURVE_EXO = 'Exo 2, system-ui, sans-serif';

/* extra view state on top of CURVE_STATE (20-svg-mocks.js) */
CURVE_STATE.scaleAuto = true;
CURVE_STATE.all = false;
CURVE_STATE.offset = true;
CURVE_STATE.buckle = true;
CURVE_STATE.labels = true;
CURVE_STATE.hidden = {};

function ensurePlotly(cb){
  if (window.Plotly) { cb(true); return; }
  if (CURVE_PLOTLY.failed) { cb(false); return; }
  CURVE_PLOTLY.waiters.push(cb);
  if (CURVE_PLOTLY.loading) return;
  CURVE_PLOTLY.loading = true;
  var s = document.createElement('script'), done = false;
  function finish(ok){
    if (done) return; done = true;
    CURVE_PLOTLY.loading = false;
    if (!ok) CURVE_PLOTLY.failed = true;
    var w = CURVE_PLOTLY.waiters; CURVE_PLOTLY.waiters = [];
    for (var i = 0; i < w.length; i++) { try { w[i](ok && !!window.Plotly); } catch (e) { console.error(e); } }
  }
  s.src = CURVE_PLOTLY.src;
  s.onload = function(){ finish(true); };
  s.onerror = function(){ console.warn('[curve] Plotly failed to load — keeping the SVG plot'); finish(false); };
  setTimeout(function(){ if (!window.Plotly) { console.warn('[curve] Plotly load timed out — keeping the SVG plot'); finish(false); } }, 15000);
  document.head.appendChild(s);
}

function _cpRgba(hex, a){
  var n = parseInt(String(hex || '#aaaaaa').slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function _cpFmt(v){ return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(2); }
function _cpLetter(d){ return String(d.label || d.id).split('·').pop().trim(); }

/* Collect every design's crushed axes (up to 3 designs, as the SVG plot). */
function curvePlotData(){
  var out = [];
  for (var i = 0; i < LAB_STATE.designs.length && out.length < 3; i++){
    var d = LAB_STATE.designs[i];
    var curves = (typeof _mpAxisCurves === 'function') ? _mpAxisCurves(d) : [];
    if (!curves.length) continue;
    var bk = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
    var gov = (typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[d.id] : null;
    var axes = {};
    for (var c = 0; c < curves.length; c++){
      var nl = curves[c], ax = nl.axis || 'zz', top = 0;
      for (var k = 0; k < nl.curve.length; k++) if (nl.curve[k].sigma > top) top = nl.curve[k].sigma;
      var yielded = !!(nl.yielded && isFinite(nl.sigma_y_eff) && nl.sigma_y_eff > 0);
      var yEps = (yielded && isFinite(nl.E0) && nl.E0 > 0) ? nl.sigma_y_eff / nl.E0 + 0.002 : null;
      var pcr = (typeof _mpAxisPcr === 'function') ? _mpAxisPcr(bk, ax) : null;
      if (pcr == null && curves.length === 1 && bk && !bk.error && !bk.skip_reason)
        pcr = isFinite(bk.pcr_ratio_ref) ? bk.pcr_ratio_ref : (isFinite(bk.pcr) ? bk.pcr : null);
      axes[ax] = { nl: nl, top: top, yielded: yielded, sy: yielded ? nl.sigma_y_eff : null, yEps: yEps, pcr: pcr,
                   div: yielded ? nl.sigma_y_eff : (top || 1) };
    }
    out.push({ design: d, letter: _cpLetter(d), color: d.color || '#aaa', axes: axes, gov: gov });
  }
  return out;
}

function _cpFocusAxis(){ return (typeof NONLIN_STATE !== 'undefined' && NONLIN_STATE.view) ? NONLIN_STATE.view : 'zz'; }
function _cpIsFocus(dd, ax){
  if (CURVE_STATE.all) return true;
  var f = _cpFocusAxis();
  if (dd.axes[f]) return ax === f;
  return dd.gov && dd.gov.axis ? ax === dd.gov.axis : ax === Object.keys(dd.axes)[0];   /* design without the focus axis: its governing one */
}
function _cpShown(dd, ax){ return !CURVE_STATE.hidden[dd.design.id + ax]; }
function _cpDiv(dd, ax){ return CURVE_STATE.scale === 'norm' ? dd.axes[ax].div : 1; }

function _cpAutoScale(data){
  if (!CURVE_STATE.scaleAuto) return '';
  var tops = data.map(function(dd){ var t = 0; for (var a in dd.axes) t = Math.max(t, dd.axes[a].top); return t; }).filter(function(t){ return t > 0; });
  var r = tops.length > 1 ? Math.max.apply(null, tops) / Math.min.apply(null, tops) : 1;
  CURVE_STATE.scale = (r > CURVE_AUTO_NORM_RATIO) ? 'norm' : 'abs';
  return (r > CURVE_AUTO_NORM_RATIO) ? ('auto: strengths differ ' + Math.round(r) + '× between designs, so each curve is divided by its own yield — pick MPa or log any time') : '';
}

function _cpXmax(data){
  var m = 0;
  data.forEach(function(dd){ for (var a in dd.axes) dd.axes[a].nl.curve.forEach(function(p){ if (p.eps > m) m = p.eps; }); });
  return Math.max(m * 100 * 1.02, 0.1);
}
function _cpYrange(data){
  var top = 0, low = Infinity;
  data.forEach(function(dd){ for (var a in dd.axes){ if (!_cpShown(dd, a)) continue; var k = _cpDiv(dd, a);
    dd.axes[a].nl.curve.forEach(function(p){ var v = p.sigma / k; if (v > top) top = v; if (v > 0 && v < low) low = v; }); } });
  if (!(top > 0)) top = 1;
  if (!(low < Infinity)) low = top / 100;
  if (CURVE_STATE.scale === 'log') return [Math.log10(low * 0.7), Math.log10(top * 1.8)];
  if (CURVE_STATE.scale === 'norm') return [0, Math.max(top, 1) * 1.12];
  return [0, top * 1.1];
}

function curvePlotTraces(data){
  var tr = [], log = CURVE_STATE.scale === 'log', allMode = CURVE_STATE.all;
  data.forEach(function(dd){
    CURVE_AXES.forEach(function(a){
      var A = dd.axes[a]; if (!A || !_cpShown(dd, a)) return;
      var f = _cpIsFocus(dd, a), k = _cpDiv(dd, a), c = A.nl.curve, o = log ? [] : [0];
      var x = o.concat(c.map(function(p){ return p.eps * 100; }));
      var y = o.concat(c.map(function(p){ return p.sigma / k; }));
      var cd = o.map(function(){ return [0, 0]; }).concat(c.map(function(p){ return [p.sigma, A.sy ? p.sigma / A.sy : null]; }));
      var smooth = { shape: 'spline', smoothing: 0.6 };
      if (f) tr.push({ x: x, y: y, mode: 'lines', line: { color: _cpRgba(dd.color, 0.16), width: 11, shape: smooth.shape, smoothing: smooth.smoothing },
                       hoverinfo: 'skip', showlegend: false });
      tr.push({
        x: x, y: y, mode: 'lines', name: dd.letter + '·' + CURVE_AXL[a], showlegend: false,
        line: { color: f ? dd.color : _cpRgba(dd.color, 0.55), width: f ? 3 : 1.6, dash: CURVE_DASH[a], shape: smooth.shape, smoothing: smooth.smoothing },
        fill: (f && !allMode && !log) ? 'tozeroy' : 'none',
        fillgradient: { type: 'vertical', colorscale: [[0, _cpRgba(dd.color, 0)], [1, _cpRgba(dd.color, 0.13)]] },
        customdata: cd,
        hovertemplate: '<span style="color:' + dd.color + '">●</span> <b>' + dd.letter + '·' + CURVE_AXL[a] + '</b>  σ %{customdata[0]:.3~g} MPa' +
                       (A.sy ? '  <span style="color:#8a8aa6">(%{customdata[1]:.2f}× σ<sub>y</sub>)</span>' : '') + '<extra></extra>'
      });
    });
  });
  data.forEach(function(dd){
    CURVE_AXES.forEach(function(a){
      var A = dd.axes[a]; if (!A || !A.yielded || A.yEps == null || !_cpShown(dd, a)) return;
      var f = _cpIsFocus(dd, a), k = _cpDiv(dd, a);
      if (CURVE_STATE.offset && f && !log)
        tr.push({ x: [0.2, A.yEps * 100], y: [0, A.sy / k], mode: 'lines', line: { color: _cpRgba(dd.color, 0.55), width: 1, dash: '2px,4px' }, hoverinfo: 'skip', showlegend: false });
      if (f) tr.push({ x: [A.yEps * 100], y: [A.sy / k], mode: 'markers', marker: { size: 22, color: _cpRgba(dd.color, 0.18) }, hoverinfo: 'skip', showlegend: false });
      tr.push({ x: [A.yEps * 100], y: [A.sy / k], mode: 'markers', showlegend: false,
        marker: { size: f ? 10 : 6, color: f ? dd.color : _cpRgba(dd.color, 0.6), line: { color: '#0a0a12', width: 2 } },
        hovertemplate: '<b>' + dd.letter + '·' + CURVE_AXL[a] + ' yield</b>  σ<sub>y</sub> ' + _cpFmt(A.sy) + ' MPa at ε ' + (A.yEps * 100).toFixed(2) + '%<extra></extra>' });
    });
  });
  return tr;
}

function curvePlotLayout(data){
  var yr = _cpYrange(data), log = CURVE_STATE.scale === 'log', xMax = _cpXmax(data);
  var shapes = [], ann = [], bLabels = [], offTags = 0;
  function frac(v){ return log ? (Math.log10(v) - yr[0]) / (yr[1] - yr[0]) : (v - yr[0]) / (yr[1] - yr[0]); }
  function yv(v){ return log ? Math.log10(v) : v; }

  data.forEach(function(dd, di){
    /* buckling: each design's focus axis (or its weakest when All) */
    var bAx = null;
    if (CURVE_STATE.all){ var best = Infinity; for (var a0 in dd.axes) if (dd.axes[a0].pcr != null && dd.axes[a0].sy && dd.axes[a0].pcr / dd.axes[a0].sy < best){ best = dd.axes[a0].pcr / dd.axes[a0].sy; bAx = a0; } }
    else { for (var a1 in dd.axes) if (_cpIsFocus(dd, a1)) bAx = a1; }
    var B = bAx ? dd.axes[bAx] : null;
    if (CURVE_STATE.buckle && B && B.pcr != null && _cpShown(dd, bAx)){
      var k = _cpDiv(dd, bAx), yb = B.pcr / k, own = B.top / k;
      var ratio = B.sy ? B.pcr / B.sy : null;
      var txt = dd.letter + '·' + CURVE_AXL[bAx] + ' buckles · σ<sub>cr</sub> ' + _cpFmt(B.pcr) + ' MPa' + (ratio ? ' · ' + (ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)) + '× σ<sub>y</sub>' : '');
      var onScale = log ? (yb < Math.pow(10, yr[1]) && yb > Math.pow(10, yr[0])) : (yb <= own * 1.6 && yb <= yr[1]);
      if (onScale){
        shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: yb, y1: yb, line: { color: _cpRgba(dd.color, 0.75), width: 1.4, dash: '12px,4px,2px,4px' } });
        bLabels.push({ y: yb, text: txt, color: dd.color });
      } else {
        ann.push({ xref: 'paper', yref: 'paper', x: 0, y: 1, yshift: 8 + 24 * offTags, xanchor: 'left', yanchor: 'bottom', showarrow: false,   /* left: the modebar sits top-right */
          text: '▲ ' + txt + ' — above its curve', font: { family: CURVE_MONO, size: 10.5, color: dd.color },
          bgcolor: 'rgba(10,12,20,0.88)', bordercolor: _cpRgba(dd.color, 0.5), borderwidth: 1, borderpad: 4 });
        offTags++;
      }
    }
    /* yield callouts: focus axes; with All only each design's weakest axis */
    if (CURVE_STATE.labels){
      var axs = [];
      if (CURVE_STATE.all){ var wk = null; for (var a2 in dd.axes) if (dd.axes[a2].sy && (!wk || dd.axes[a2].sy < dd.axes[wk].sy)) wk = a2; if (wk) axs.push(wk); }
      else for (var a3 in dd.axes) if (_cpIsFocus(dd, a3)) axs.push(a3);
      axs.forEach(function(ax, i){
        var A = dd.axes[ax]; if (!A.yielded || A.yEps == null || !_cpShown(dd, ax)) return;
        var v = A.sy / _cpDiv(dd, ax), fy = frac(v), fx = A.yEps * 100 / xMax;
        var below = fy > 0.62, right = below || fx < 0.18;
        ann.push({ x: A.yEps * 100, y: yv(v), ax: (right ? 1 : -1) * (58 + 10 * i), ay: (below ? 1 : -1) * (32 + 24 * di + 18 * i),
          showarrow: true, arrowhead: 0, arrowwidth: 1, arrowcolor: _cpRgba(dd.color, 0.7),
          text: '<b>' + dd.letter + '·' + CURVE_AXL[ax] + '</b>  σ<sub>y</sub> ' + _cpFmt(A.sy) + ' MPa' + (CURVE_STATE.all ? ' (weakest)' : ''),
          font: { family: CURVE_MONO, size: 10.5, color: '#e0e0ff' }, bgcolor: 'rgba(14,14,26,0.92)', bordercolor: _cpRgba(dd.color, 0.8), borderwidth: 1, borderpad: 5 });
      });
    }
  });
  bLabels.sort(function(p, q){ return p.y - q.y; });
  var lastF = -1, shift = 0;
  bLabels.forEach(function(b){
    var f = frac(b.y); shift = (f - lastF < 0.045) ? shift + 15 : 0; lastF = f;
    ann.push({ xref: 'paper', x: 0.995, y: yv(b.y), xanchor: 'right', yanchor: 'bottom', yshift: 3 + shift, showarrow: false,
      text: b.text, font: { family: CURVE_MONO, size: 10.5, color: b.color }, bgcolor: 'rgba(10,12,20,0.75)', borderpad: 2 });
  });
  if (CURVE_STATE.scale === 'norm'){
    shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 1, y1: 1, line: { color: 'rgba(200,245,66,0.35)', width: 1, dash: 'dot' } });
    ann.push({ xref: 'paper', x: 0.005, y: 1, xanchor: 'left', yanchor: 'bottom', showarrow: false, text: 'yield = 1', font: { family: CURVE_MONO, size: 10, color: 'rgba(200,245,66,0.7)' } });
  }
  var grid = 'rgba(120,120,170,0.08)';
  return {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(6,8,15,0.35)',
    margin: { l: 64, r: 18, t: 14 + 24 * offTags, b: 8 }, autosize: true,
    font: { family: CURVE_MONO, size: 11, color: '#8a8aa6' },
    hovermode: 'x unified', hoverdistance: 40, showlegend: false,
    hoverlabel: { bgcolor: 'rgba(14,14,26,0.96)', bordercolor: '#3a3a52', font: { family: CURVE_MONO, size: 11.5, color: '#e0e0ff' } },
    xaxis: { title: { text: 'ε  (%)', font: { family: CURVE_MONO, size: 11, color: '#8a8aa6' }, standoff: 8 },
      range: [0, xMax], autorange: false, gridcolor: grid, zeroline: false, linecolor: '#2a2a3a', ticks: 'outside', ticklen: 5, tickcolor: '#2a2a3a',
      showspikes: true, spikemode: 'across', spikethickness: 1, spikecolor: 'rgba(251,191,36,0.55)', spikedash: 'solid', spikesnap: 'cursor',
      rangeslider: { visible: true, range: [0, xMax], thickness: 0.07, bgcolor: 'rgba(10,12,20,0.8)', bordercolor: '#2a2a3a', borderwidth: 1 },
      hoverformat: '.2f' },
    yaxis: { title: { text: CURVE_STATE.scale === 'norm' ? 'σ / own σ<sub>y</sub>' : 'σ  (MPa)', font: { family: CURVE_MONO, size: 11, color: '#8a8aa6' }, standoff: 10 },
      type: log ? 'log' : 'linear', range: yr, autorange: false, gridcolor: grid, zeroline: !log, zerolinecolor: '#2a2a3a',
      linecolor: '#2a2a3a', ticks: 'outside', ticklen: 5, tickcolor: '#2a2a3a', exponentformat: 'none', tickformat: log ? '~g' : '' },
    shapes: shapes, annotations: ann
    /* no layout.transition: Plotly 2.35 throws in fillgradient under a transition (gradient on a d3 transition selection) */
  };
}

var CURVE_CONFIG = {
  responsive: true, displaylogo: false, scrollZoom: false,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'],
  toImageButtonOptions: { format: 'png', filename: 'f13ld-stress-strain', scale: 3 }
};

function _cpHeadHtml(data){
  var axSeen = {};
  data.forEach(function(dd){ for (var a in dd.axes) axSeen[a] = 1; });
  var nAx = Object.keys(axSeen).length, foc = CURVE_STATE.all ? 'all' : _cpFocusAxis();
  var first = data[0] && data[0].axes[Object.keys(data[0].axes)[0]].nl;
  var capPct = first ? Math.round((first.epsCap || 0.05) * 100) : 5;
  var vMin = Infinity, vMax = 0;
  data.forEach(function(dd){ for (var a in dd.axes){ var vc = dd.axes[a].nl.voidContrast; if (vc > 0){ vMin = Math.min(vMin, vc); vMax = Math.max(vMax, vc); } } });
  var sub = 'UNIAXIAL CRUSH · J2 PLASTICITY (SMALL STRAIN) · N=' + (first ? first.N : '—') + ' · ε ≤ ' + capPct + '%' +
            (vMax > 0 ? ' · VOID ' + vMin.toExponential(0) + (vMax > vMin * 1.0001 ? '–' + vMax.toExponential(0) : '') : '') +
            ' · AXES ' + CURVE_AXES.filter(function(a){ return axSeen[a]; }).map(function(a){ return CURVE_AXL[a]; }).join(' · ');
  var sc = CURVE_STATE.scale;
  var h = '<div class="cp-head"><div class="cp-title">Stress–Strain · Comparison<small>' + sub + '</small></div><div class="cp-controls">' +
    '<div class="cp-seg" data-k="scale"><span class="lbl">Stress</span>' +
      '<button data-v="abs" class="' + (sc === 'abs' ? 'on' : '') + '">MPa</button>' +
      '<button data-v="log" class="' + (sc === 'log' ? 'on' : '') + '">log</button>' +
      '<button data-v="norm" class="' + (sc === 'norm' ? 'on' : '') + '" title="Each curve divided by its own yield strength">÷ own σ<sub>y</sub></button></div>';
  if (nAx > 1){
    h += '<div class="cp-seg" data-k="focus"><span class="lbl">Focus</span>';
    CURVE_AXES.forEach(function(a){ h += '<button data-v="' + a + '" class="' + (foc === a ? 'on' : '') + '"' + (axSeen[a] ? '' : ' disabled') + '>' + CURVE_AXL[a] + '</button>'; });
    h += '<button data-v="all" class="' + (foc === 'all' ? 'on' : '') + '">All</button></div>';
  }
  h += '<span class="cp-chip' + (CURVE_STATE.offset ? ' on' : '') + '" data-c="offset">0.2% offset</span>' +
       '<span class="cp-chip' + (CURVE_STATE.buckle ? ' on' : '') + '" data-c="buckle">buckling</span>' +
       '<span class="cp-chip' + (CURVE_STATE.labels ? ' on' : '') + '" data-c="labels">labels</span></div></div>';
  return h;
}

function _cpLegendHtml(data){
  var h = '';
  data.forEach(function(dd){
    var keys = CURVE_AXES.filter(function(a){ return dd.axes[a]; });
    var allOff = keys.every(function(a){ return !_cpShown(dd, a); });
    var flags = [];
    keys.forEach(function(a){
      var nl = dd.axes[a].nl;
      if (nl.lateralFloor > (typeof NL_LATERAL_FLAG !== 'undefined' ? NL_LATERAL_FLAG : 0.05)) flags.push(CURVE_AXL[a] + ': post-yield approximate (side stress ±' + Math.round(nl.lateralFloor * 100) + '%)');
      if (nl.truncated) flags.push(CURVE_AXL[a] + ': partial curve' + (nl.truncReason ? ' (' + nl.truncReason + ')' : ''));
      if (!dd.axes[a].yielded) flags.push(CURVE_AXL[a] + ': no yield up to the cap');
    });
    h += '<div class="cp-lg' + (allOff ? ' off' : '') + '" style="--c:' + dd.color + '"><span class="dn" data-d="' + dd.design.id + '" title="Show / hide this design">' +
         '<i></i><b>Design ' + dd.letter + '</b><span>' + (dd.design.title || '') + '</span></span>';
    if (keys.length) {
      h += '<span class="ax">';
      keys.forEach(function(a){
        var dash = a === 'xx' ? '' : a === 'yy' ? ' stroke-dasharray="5,3"' : ' stroke-dasharray="1.5,3"';
        h += '<button class="' + (_cpShown(dd, a) ? '' : 'off') + '" data-d="' + dd.design.id + '" data-a="' + a + '" title="Show / hide ' + CURVE_AXL[a] + '">' +
             '<svg width="18" height="6"><line x1="1" y1="3" x2="17" y2="3" stroke="' + dd.color + '" stroke-width="2" stroke-linecap="round"' + dash + '/></svg>' + CURVE_AXL[a] + '</button>';
      });
      h += '</span>';
    }
    if (flags.length) h += '<span class="cp-flag" title="' + flags.join('\n').replace(/"/g, '&quot;') + '">⚠</span>';
    h += '</div>';
  });
  return h;
}

/* Draw (or update) the Plotly plot into the merged-plot host. */
function renderMergedCurvePlotly(host, data){
  var note = _cpAutoScale(data);
  var skeleton = host.dataset.mode === 'plotly' && host.querySelector('.cp-plot');
  if (!skeleton){
    if (CURVE_PLOTLY.gd) { try { Plotly.purge(CURVE_PLOTLY.gd); } catch (e) {} }
    host.innerHTML = '<div class="cp-headwrap"></div><div class="cp-legend"></div><div class="cp-note"></div>' +
                     '<div class="cp-plot"><div class="cp-gd"></div><div class="cp-cursor"><span></span></div></div>';
    host.dataset.mode = 'plotly';
    _cpWire(host);
  }
  host.querySelector('.cp-headwrap').innerHTML = _cpHeadHtml(data);
  host.querySelector('.cp-legend').innerHTML = _cpLegendHtml(data);
  host.querySelector('.cp-note').textContent = note;
  var gd = host.querySelector('.cp-gd');
  var fresh = !gd.data;
  var drawn = (fresh ? Plotly.newPlot : Plotly.react)(gd, curvePlotTraces(data), curvePlotLayout(data), CURVE_CONFIG);
  CURVE_STATE._typeChanged = false;
  /* drawn while hidden (tab switch) or the panel resized: fit the container once drawn */
  Promise.resolve(drawn).then(function(){
    if (gd._fullLayout && (Math.abs((gd._fullLayout.width || 0) - gd.clientWidth) > 4 || Math.abs((gd._fullLayout.height || 0) - gd.clientHeight) > 4) && gd.clientWidth > 0)
      requestAnimationFrame(function(){ try { Plotly.Plots.resize(gd).then(function(){ curvePlotCursor(CURVE_PLOTLY.cursorPct); }); } catch (e) {} });
  }).catch(function(e){ console.error('[curve] plot draw failed', e); });
  if (fresh){
    gd.on('plotly_hover', function(ev){
      var x = (ev && ev.xvals && ev.xvals.length) ? ev.xvals[0] : (ev && ev.points && ev.points[0] ? ev.points[0].x : null);
      if (x != null && typeof nlvizScrubToEps === 'function') nlvizScrubToEps(x / 100, 'hover');
    });
    gd.on('plotly_unhover', function(){ if (typeof nlvizScrubRelease === 'function') nlvizScrubRelease(); });
    gd.on('plotly_click', function(ev){
      var x = (ev && ev.points && ev.points[0]) ? ev.points[0].x : null;
      if (x != null && typeof nlvizScrubToEps === 'function') nlvizScrubToEps(x / 100, 'pin');
    });
    gd.on('plotly_relayout', function(){ curvePlotCursor(CURVE_PLOTLY.cursorPct); });
  }
  CURVE_PLOTLY.gd = gd;
  curvePlotCursor(CURVE_PLOTLY.cursorPct);
}

function _cpWire(host){
  host.addEventListener('click', function(e){
    var segBtn = e.target.closest('.cp-seg button');
    if (segBtn && !segBtn.disabled){
      var k = segBtn.parentNode.dataset.k, v = segBtn.dataset.v;
      if (k === 'scale'){
        CURVE_STATE._typeChanged = (CURVE_STATE.scale === 'log') !== (v === 'log');
        CURVE_STATE.scale = v; CURVE_STATE.scaleAuto = false;
        renderMergedCurvePlot(host);
      } else if (k === 'focus'){
        if (v === 'all'){ CURVE_STATE.all = true; renderMergedCurvePlot(host); }
        else { CURVE_STATE.all = false; if (typeof onNonlinViewAxis === 'function') onNonlinViewAxis(v); else renderMergedCurvePlot(host); }
      }
      return;
    }
    var chip = e.target.closest('.cp-chip');
    if (chip){ var c = chip.dataset.c; CURVE_STATE[c] = !CURVE_STATE[c]; renderMergedCurvePlot(host); return; }
    var axBtn = e.target.closest('.cp-lg .ax button');
    if (axBtn){ var key = axBtn.dataset.d + axBtn.dataset.a; CURVE_STATE.hidden[key] = !CURVE_STATE.hidden[key]; renderMergedCurvePlot(host); return; }
    var dn = e.target.closest('.cp-lg .dn');
    if (dn){
      var id = dn.dataset.d, any = CURVE_AXES.some(function(a){ return !CURVE_STATE.hidden[id + a]; });
      CURVE_AXES.forEach(function(a){ CURVE_STATE.hidden[id + a] = any; });
      renderMergedCurvePlot(host);
    }
  });
}

/* Amber strain cursor that follows the crush scrubber (eps in %). */
function curvePlotCursor(epsPct){
  CURVE_PLOTLY.cursorPct = epsPct;
  var gd = CURVE_PLOTLY.gd;
  if (!gd || !gd._fullLayout || !gd._fullLayout.xaxis || !document.body.contains(gd)) return;
  var cur = gd.parentNode.querySelector('.cp-cursor');
  if (!cur) return;
  var xa = gd._fullLayout.xaxis, sz = gd._fullLayout._size;
  if (epsPct == null || !isFinite(epsPct) || epsPct < xa.range[0] || epsPct > xa.range[1]) { cur.style.display = 'none'; return; }
  cur.style.display = 'block';
  cur.style.left = (sz.l + xa.l2p(epsPct)) + 'px';
  cur.style.top = sz.t + 'px';
  cur.style.height = sz.h + 'px';
  var lab = cur.firstChild; if (lab) lab.textContent = 'ε ' + epsPct.toFixed(2) + '%';
}

/* Entry point (replaces the SVG-only renderer): SVG now, Plotly when ready. */
function renderMergedCurvePlot(host){
  var data = curvePlotData();
  if (!data.length || CURVE_PLOTLY.failed){
    if (host.dataset.mode === 'plotly' && CURVE_PLOTLY.gd){ try { Plotly.purge(CURVE_PLOTLY.gd); } catch (e) {} CURVE_PLOTLY.gd = null; }
    host.dataset.mode = 'svg';
    renderMergedCurvePlotSVG(host);
    return;
  }
  if (window.Plotly){ renderMergedCurvePlotly(host, data); return; }
  if (host.dataset.mode !== 'svg-wait'){ host.dataset.mode = 'svg-wait'; }
  renderMergedCurvePlotSVG(host);
  host.dataset.mode = 'svg-wait';
  ensurePlotly(function(ok){
    if (!ok) return;
    if (typeof VIEW_STATE !== 'undefined' && VIEW_STATE.mode !== 'curve') return;
    renderMergedCurvePlot(host);
  });
}
