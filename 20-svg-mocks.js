/* ============================================================
   F13LD.lab · 20-svg-mocks.js
   Stylized SVG generators for each view mode. These are
   PHASE 1 PLACEHOLDERS — they convey what each viewport will
   show without requiring the real solvers/raymarchers built
   in Phases 3–8.
   ============================================================ */

/* ----------------------------------------------------------
   svgGeom — geometry (or deformed geometry when amp > 0).
   Each design family draws a stylized 2D representative of
   its 3D structure. Phase 7 replaces these with real raymarched
   output, including a domain-warp shader for the deformed mode.
   ---------------------------------------------------------- */
function svgGeom(family, deformed, amplitude){
  amplitude = amplitude || 0;
  var shear  = deformed ? amplitude * 12 : 0;
  var squash = deformed ? amplitude * 0.18 : 0;
  var i, j, x, y;
  var out = '';

  if (family === 'tpms' || family === 'schwarz_p'){
    // sinusoidal grid pattern
    for (i = 0; i < 6; i++){
      y = 60 + i * 40 - squash * i * 8;
      out += '<path d="M40,'+y+' Q'+(100+shear*0.5)+','+(y-15)+' '+(160+shear)+','+y+' T'+(280+shear*1.5)+','+y+' T'+(400+shear*2)+','+y+'" fill="none" stroke="#1D9E75" stroke-width="'+(2 - i*0.1)+'" opacity="'+(0.85 - i*0.08)+'"/>';
    }
    for (j = 0; j < 5; j++){
      x = 80 + j * 70 + shear * (1 - j/5);
      out += '<path d="M'+x+',40 Q'+(x+8)+','+(100-squash*8)+' '+(x+shear*0.3)+','+(160-squash*16)+' T'+(x+shear*0.6)+','+(280-squash*32)+'" fill="none" stroke="#c8f542" stroke-width="1" opacity="0.55"/>';
    }
    return out;
  }

  if (family === 'grain' || family === 'spinodoid'){
    // irregular blobs — spinodoid
    var blobs = [[90,80,28],[200,90,32],[120,170,30],[220,180,26],[300,110,24],[300,200,28],[160,250,22],[260,260,30],[80,230,22]];
    for (i = 0; i < blobs.length; i++){
      var b = blobs[i];
      var dx = shear * (b[1]-160) / 200;
      var dy = -squash * (b[1]-160) * 0.3;
      out += '<ellipse cx="'+(b[0]+dx)+'" cy="'+(b[1]+dy)+'" rx="'+b[2]+'" ry="'+(b[2]*(1-squash*0.5))+'" fill="none" stroke="#1D9E75" stroke-width="1.5" opacity="0.7"/>';
      out += '<ellipse cx="'+(b[0]+dx)+'" cy="'+(b[1]+dy)+'" rx="'+(b[2]*0.7)+'" ry="'+(b[2]*0.7*(1-squash*0.5))+'" fill="none" stroke="#c8f542" stroke-width="0.8" opacity="0.5"/>';
    }
    return out;
  }

  // default: trabecular network
  var nodes = [[80,70],[160,55],[240,75],[320,60],[100,140],[180,130],[260,150],[330,135],[70,210],[160,225],[240,210],[320,220],[120,280],[210,275],[290,285]];
  var edges = [[0,1],[1,2],[2,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,6],[3,7],[4,5],[5,6],[6,7],[4,8],[5,9],[5,10],[6,10],[7,11],[8,9],[9,10],[10,11],[8,12],[9,12],[9,13],[10,13],[10,14],[11,14],[12,13],[13,14]];
  for (i = 0; i < edges.length; i++){
    var a = nodes[edges[i][0]];
    var bb = nodes[edges[i][1]];
    var dxA = shear * (a[1]-160)/200;
    var dxB = shear * (bb[1]-160)/200;
    var dyA = -squash * (a[1]-160) * 0.3;
    var dyB = -squash * (bb[1]-160) * 0.3;
    out += '<line x1="'+(a[0]+dxA)+'" y1="'+(a[1]+dyA)+'" x2="'+(bb[0]+dxB)+'" y2="'+(bb[1]+dyB)+'" stroke="#1D9E75" stroke-width="2" opacity="0.7"/>';
  }
  for (i = 0; i < nodes.length; i++){
    var n = nodes[i];
    var dxn = shear * (n[1]-160)/200;
    var dyn = -squash * (n[1]-160) * 0.3;
    out += '<circle cx="'+(n[0]+dxn)+'" cy="'+(n[1]+dyn)+'" r="3" fill="#c8f542" opacity="0.85"/>';
  }
  return out;
}

/* ----------------------------------------------------------
   svgStress — geometry + von Mises stress field heatmap.
   Phase 7 replaces with an SDF-surface color sample.
   ---------------------------------------------------------- */
function svgStress(family, idSeed){
  var base = svgGeom(family, false, 0);
  var id = 'hot' + (idSeed || 0);
  return '<defs>' +
    '<radialGradient id="'+id+'a" cx="50%" cy="40%" r="50%">' +
      '<stop offset="0%" stop-color="#ff5252" stop-opacity="0.55"/>' +
      '<stop offset="40%" stop-color="#fbbf24" stop-opacity="0.35"/>' +
      '<stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<radialGradient id="'+id+'b" cx="30%" cy="75%" r="35%">' +
      '<stop offset="0%" stop-color="#ff5252" stop-opacity="0.45"/>' +
      '<stop offset="50%" stop-color="#fbbf24" stop-opacity="0.25"/>' +
      '<stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/>' +
    '</radialGradient>' +
    '</defs>' +
    base +
    '<rect x="0" y="0" width="400" height="320" fill="url(#'+id+'a)"/>' +
    '<rect x="0" y="0" width="400" height="320" fill="url(#'+id+'b)"/>';
}

/* ----------------------------------------------------------
   svgStiffness — directional Young's modulus surface (radial).
   Phase 4 replaces with the orthotropic-tensor extension of
   Grain's existing `buildStiffFrag` shader.
   ---------------------------------------------------------- */
function svgStiffness(zener, color, idSeed){
  var cx = 200, cy = 160;
  // anisotropy signature derived from Zener ratio
  var diag = zener;                 // weight for diagonal directions
  var axial = 2 - zener;            // axial bias inverse-correlates
  var k = 1.05;
  var pts = [];
  var N = 64;
  for (var i = 0; i <= N; i++){
    var a = (i/N) * Math.PI * 2;
    var cosT = Math.cos(a), sinT = Math.sin(a);
    var w = (cosT*cosT*sinT*sinT) * 4;             // peaks at diagonals
    var ax = (Math.pow(Math.abs(cosT),3) + Math.pow(Math.abs(sinT),3));
    var r = 90 * k * (1 + (diag-1)*w*0.5 + (axial-1)*ax*0.3);
    pts.push([cx + r*cosT, cy + r*sinT]);
  }
  var d = 'M' + pts.map(function(p){ return p[0].toFixed(1)+','+p[1].toFixed(1); }).join(' L') + ' Z';
  var id = 'surf' + (idSeed || 0);
  return '<defs>' +
    '<radialGradient id="'+id+'" cx="50%" cy="40%" r="60%">' +
      '<stop offset="0%" stop-color="'+color+'" stop-opacity="0.85"/>' +
      '<stop offset="60%" stop-color="'+color+'" stop-opacity="0.35"/>' +
      '<stop offset="100%" stop-color="'+color+'" stop-opacity="0.08"/>' +
    '</radialGradient>' +
    '</defs>' +
    '<line x1="'+cx+'" y1="40" x2="'+cx+'" y2="280" stroke="#2a2a3a" stroke-width="0.5" stroke-dasharray="2,3"/>' +
    '<line x1="60" y1="'+cy+'" x2="340" y2="'+cy+'" stroke="#2a2a3a" stroke-width="0.5" stroke-dasharray="2,3"/>' +
    '<text x="'+(cx+4)+'" y="48" font-family="JetBrains Mono,monospace" font-size="9" fill="#555" letter-spacing="1">+Y</text>' +
    '<text x="332" y="'+(cy-4)+'" font-family="JetBrains Mono,monospace" font-size="9" fill="#555" letter-spacing="1">+X</text>' +
    '<path d="'+d+'" fill="url(#'+id+')" stroke="'+color+'" stroke-width="1.4" opacity="0.95"/>' +
    '<circle cx="'+cx+'" cy="'+cy+'" r="'+(90*k)+'" fill="none" stroke="'+color+'" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.4"/>';
}

/* ----------------------------------------------------------
   svgThermal — directional thermal conductivity surface.
   ---------------------------------------------------------- */
function svgThermal(zener, idSeed){
  var cx = 200, cy = 160;
  var diag = 1 + (zener - 1) * 0.3;
  var axial = 1 + (1 - zener) * 0.3;
  var k = 0.88;
  var color = '#34d399';
  var pts = [];
  var N = 48;
  for (var i = 0; i <= N; i++){
    var a = (i/N) * Math.PI * 2;
    var cosT = Math.cos(a), sinT = Math.sin(a);
    var w = (cosT*cosT*sinT*sinT) * 4;
    var ax = (Math.pow(Math.abs(cosT),3) + Math.pow(Math.abs(sinT),3));
    var r = 80 * k * (1 + (diag-1)*w*0.5 + (axial-1)*ax*0.3);
    pts.push([cx + r*cosT, cy + r*sinT]);
  }
  var d = 'M' + pts.map(function(p){ return p[0].toFixed(1)+','+p[1].toFixed(1); }).join(' L') + ' Z';
  var id = 'therm' + (idSeed || 0);
  return '<defs>' +
    '<radialGradient id="'+id+'" cx="50%" cy="40%" r="60%">' +
      '<stop offset="0%" stop-color="'+color+'" stop-opacity="0.7"/>' +
      '<stop offset="60%" stop-color="'+color+'" stop-opacity="0.25"/>' +
      '<stop offset="100%" stop-color="'+color+'" stop-opacity="0.05"/>' +
    '</radialGradient>' +
    '</defs>' +
    '<line x1="'+cx+'" y1="50" x2="'+cx+'" y2="270" stroke="#2a2a3a" stroke-width="0.5" stroke-dasharray="2,3"/>' +
    '<line x1="80" y1="'+cy+'" x2="320" y2="'+cy+'" stroke="#2a2a3a" stroke-width="0.5" stroke-dasharray="2,3"/>' +
    '<path d="'+d+'" fill="url(#'+id+')" stroke="'+color+'" stroke-width="1.2" opacity="0.95"/>' +
    '<circle cx="'+cx+'" cy="'+cy+'" r="'+(80*k)+'" fill="none" stroke="'+color+'" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.4"/>';
}

/* ----------------------------------------------------------
   svgBuckle — buckled column-shape mock for mode 1.
   ---------------------------------------------------------- */
function svgBuckle(lambda_cr, color){
  var baseY = 280, topY = 60;
  // amplitude scales inversely with margin — closer to 1.0 means more dramatic buckle
  var margin = Math.max(0.3, lambda_cr);
  var A = 24 / margin;
  if (A < 8) A = 8;
  if (A > 30) A = 30;
  var pts = [];
  for (var y = baseY; y >= topY; y -= 4){
    var t = (baseY - y) / (baseY - topY);
    var x = 200 + A * Math.sin(t * Math.PI) * (1 + t*0.3);
    pts.push([x, y]);
  }
  var left = pts.map(function(p){ return [p[0]-30, p[1]]; });
  var right = pts.slice().reverse().map(function(p){ return [p[0]+30, p[1]]; });
  var outline = left.concat(right);
  var d = 'M' + outline.map(function(p){ return p[0].toFixed(1)+','+p[1].toFixed(1); }).join(' L') + ' Z';
  var center = pts.map(function(p){ return p[0].toFixed(1)+','+p[1].toFixed(1); }).join(' L');
  var orig = '<rect x="170" y="'+topY+'" width="60" height="'+(baseY-topY)+'" fill="none" stroke="#3a3a5a" stroke-width="0.5" stroke-dasharray="3,4" opacity="0.5"/>';
  return orig +
    '<path d="'+d+'" fill="'+color+'" fill-opacity="0.12" stroke="'+color+'" stroke-width="1.5"/>' +
    '<path d="M'+center+'" fill="none" stroke="'+color+'" stroke-width="1" stroke-dasharray="2,2" opacity="0.7"/>' +
    '<text x="200" y="40" text-anchor="middle" font-family="JetBrains Mono,monospace" font-size="11" fill="'+color+'" letter-spacing="1">MODE 1 · λ='+lambda_cr.toFixed(2)+'</text>' +
    '<text x="200" y="304" text-anchor="middle" font-family="JetBrains Mono,monospace" font-size="9" fill="#555" letter-spacing="1">amp ×100</text>';
}

/* ----------------------------------------------------------
   svgEmptyViewport — when no data is available for a mode.
   ---------------------------------------------------------- */
function svgEmptyViewport(message){
  return '<text x="200" y="160" text-anchor="middle" font-family="JetBrains Mono,monospace" font-size="11" fill="#555" letter-spacing="2">'+message+'</text>';
}

/* ----------------------------------------------------------
   buildMergedCurvePlot — σ–ε comparison (Nonlinear tab), v0.8.0 redesign.
   · Y axis fits the CURVES, not the buckling lines.  A buckling strength
     far above the curves is reported as an off-scale tag at the top
     ("σ_cr 5952 MPa · 24× yield ▲") instead of squashing every curve flat.
   · Curves start at the origin (the solver records its first load step,
     not ε = 0), so the elastic rise, the yield knee and the hardening read
     like a stress–strain curve.
   · 0.2 %-offset construction line + yield dot per design (where it yields).
   · "MPa" / "÷ own yield" toggle: normalized mode divides each curve by its
     own yield, so a 12 MPa design and a 250 MPa design can be compared in
     shape on one axis (buckling then reads directly as ×yield).
   · Native hover tooltips on every solved point; SVG drawn at the panel's
     own aspect so text is never stretched.
   ---------------------------------------------------------- */
var CURVE_STATE = { scale: 'abs' };   /* 'abs' (MPa) | 'norm' (σ / own σ_y) */

/* Two-pass render: draw, measure the real canvas (legend rows wrap, header
   wraps on narrow panels), then redraw at exactly that size so the SVG fills
   the space at 1:1 and text is never scaled or stretched. */
/* v0.17.0 — SVG fallback; renderMergedCurvePlot (20b-curve-plotly.js) uses Plotly when it loads. */
function renderMergedCurvePlotSVG(host){
  host.innerHTML = buildMergedCurvePlot();
  var cv = host.querySelector('.mp-canvas'), svg = cv && cv.querySelector('svg');
  if (!cv || !svg) return;
  var w = cv.clientWidth, h = cv.clientHeight, vb = svg.viewBox && svg.viewBox.baseVal;
  if (w > 50 && h > 50 && vb && (Math.abs(vb.width - w) > 0.06 * w || Math.abs(vb.height - h) > 0.06 * h))
    host.innerHTML = buildMergedCurvePlot({ W: w, H: h });
}

function onCurveScaleToggle(mode){
  if (mode !== 'abs' && mode !== 'norm') return;
  CURVE_STATE.scale = mode;
  var mPlot = document.getElementById('mergedPlot');
  if (mPlot) renderMergedCurvePlot(mPlot);   /* plot only — the α cubes keep running */
}

function _mpNiceStep(span, target){
  if (!(span > 0)) return 1;
  var raw = span / (target || 5), pw = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / pw;
  var nm = (m <= 1) ? 1 : (m <= 2) ? 2 : (m <= 2.5) ? 2.5 : (m <= 5) ? 5 : 10;
  return nm * pw;
}
function _mpFmt(v, step){
  var dp = step >= 1 ? 0 : (step >= 0.1 ? 1 : 2);
  if (step === 2.5 || step === 0.25) dp = Math.max(dp, step === 0.25 ? 2 : 1);
  return v.toFixed(dp);
}

/* Collision-aware label placement for the σ–ε plot.  Monospace width is
   estimated (0.62 em per glyph).  Higher-priority labels are placed first;
   each tries its own spot, then steps up/down in line-height increments;
   labels marked drop are omitted if no clear spot exists, others take the
   least-overlapping candidate.  fixed labels (the off-scale strip) never move. */
function _mpPlaceLabels(labels, dots, B){
  var placed = dots.slice(), out = '';
  function box(L, y){
    var w = L.t.length * L.size * 0.62, x0 = L.anchor === 'end' ? L.x - w : (L.anchor === 'middle' ? L.x - w / 2 : L.x);
    return { x0: x0 - 2, x1: x0 + w + 2, y0: y - L.size, y1: y + 3 };
  }
  function hits(bx){ var n = 0; for (var i = 0; i < placed.length; i++){ var q = placed[i]; if (bx.x0 < q.x1 && bx.x1 > q.x0 && bx.y0 < q.y1 && bx.y1 > q.y0) n++; } return n; }
  var order = labels.slice().sort(function(a, b){ return b.pri - a.pri; });
  for (var k = 0; k < order.length; k++){
    var L = order[k], best = null, bestHits = 1e9, bestY = L.y, bestX = L.x;
    var steps = L.fixed ? [0] : [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5];
    for (var s2 = 0; s2 < steps.length; s2++){
      var y = L.y + steps[s2] * (L.size + 4), x = L.x, bx = box(L, y);
      if (!L.fixed){
        if (bx.x1 > B.W - 2){ x -= bx.x1 - (B.W - 2); bx = box({ t: L.t, size: L.size, anchor: L.anchor, x: x }, y); }
        if (bx.x0 < B.X0 + 2){ x += (B.X0 + 2) - bx.x0; bx = box({ t: L.t, size: L.size, anchor: L.anchor, x: x }, y); }
        if (bx.y0 < B.Y0 - 2 || bx.y1 > B.Y1 - 2) continue;   /* stay inside the plot area */
      }
      var h = hits(bx);
      if (h < bestHits){ bestHits = h; best = bx; bestY = y; bestX = x; if (h === 0) break; }
    }
    if (!best || (bestHits > 0 && L.drop)) continue;
    placed.push(best);
    out += '<text x="' + bestX.toFixed(1) + '" y="' + bestY.toFixed(1) + '"' + (L.anchor !== 'start' ? ' text-anchor="' + L.anchor + '"' : '') +
           ' font-family="' + B.font + '" font-size="' + L.size + '"' + (L.w8 !== 400 ? ' font-weight="' + L.w8 + '"' : '') + ' fill="' + L.col + '">' + L.t + '</text>';
  }
  return out;
}

/* v0.16.0 — one curve per (design, crushed axis).  Colour = design, line
   style = axis (X solid · Y dashed · Z dotted); the preview axis
   (NONLIN_STATE.view) is drawn bold with its 0.2% offset line, yield label and
   buckling line, the other axes thin and quieter so up to nine curves stay
   readable. */
var MP_AXIS_DASH = { xx: '', yy: '9,5', zz: '1,4.5' };
function _mpAxisCurves(d){
  var out = [];
  var axes = (typeof nlAvailableAxes === 'function') ? nlAvailableAxes(d.id) : [];
  for (var i = 0; i < axes.length; i++){
    var e = nlAxisEntry(d.id, axes[i]);
    if (e && e.curve && e.curve.length > 1) out.push(e);
  }
  if (!out.length){
    var nl = (typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[d.id] : null;
    if (nl && !nl.error && nl.curve && nl.curve.length > 1) out.push(nl);
  }
  return out;
}
function _mpAxisPcr(bk, axis){
  if (!bk || bk.error || bk.skip_reason || !bk.perAxis) return null;
  for (var i = 0; i < bk.perAxis.length; i++){
    var q = bk.perAxis[i];
    if (q && q.axis === axis && isFinite(q.lambda) && isFinite(q.sBar)) return q.lambda * Math.abs(q.sBar);
  }
  return null;
}

function buildMergedCurvePlot(size){
  var entries = [], perDesign = [], multi = false, axesSeen = {};
  var viewAx = (typeof NONLIN_STATE !== 'undefined' && NONLIN_STATE.view) ? NONLIN_STATE.view : 'zz';
  for (var i = 0; i < LAB_STATE.designs.length && i < 3; i++){
    var d = LAB_STATE.designs[i];
    var curves = _mpAxisCurves(d);
    if (!curves.length) continue;
    if (curves.length > 1) multi = true;
    var bk = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
    /* the bold (preview) curve: the viewed axis, else the governing one */
    var gov = (typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[d.id] : null, vIdx = -1;
    for (var c = 0; c < curves.length; c++) if (curves[c].axis === viewAx) vIdx = c;
    if (vIdx < 0) for (var c2 = 0; c2 < curves.length; c2++) if (curves[c2] === gov) vIdx = c2;
    if (vIdx < 0) vIdx = 0;
    var group = [];
    for (var c3 = 0; c3 < curves.length; c3++){
      var nl = curves[c3], ax = nl.axis || 'zz';
      axesSeen[ax] = 1;
      /* buckling on the curve's own axis when available */
      var pcr = _mpAxisPcr(bk, ax);
      if (pcr == null && curves.length === 1 && bk && !bk.error && !bk.skip_reason)
        pcr = isFinite(bk.pcr_ratio_ref) ? bk.pcr_ratio_ref : (isFinite(bk.pcr) ? bk.pcr : null);
      var en = { design: d, nl: nl, axis: ax, isView: c3 === vIdx, pcr: pcr };
      entries.push(en); group.push(en);
    }
    perDesign.push({ design: d, view: group[vIdx], all: group });
  }
  if (!entries.length){
    var msg = LAB_STATE.runHasCompleted
      ? 'Enable Nonlinear and Run a comparison to see σ–ε curves'
      : 'Run a comparison to see σ–ε curves';
    return '<div class="mp-empty"><div class="icon">∿</div><div class="msg">' + msg + '</div></div>';
  }

  var norm = CURVE_STATE.scale === 'norm';
  /* per-curve scale: MPa, or divide by own yield (by the curve's top when it never yields) */
  for (var e0 = 0; e0 < entries.length; e0++){
    var en0 = entries[e0], cv0 = en0.nl.curve, top = 0;
    for (var t0 = 0; t0 < cv0.length; t0++) if (cv0[t0].sigma > top) top = cv0[t0].sigma;
    en0.div = !norm ? 1 : ((en0.nl.yielded && isFinite(en0.nl.sigma_y_eff) && en0.nl.sigma_y_eff > 0) ? en0.nl.sigma_y_eff : (top || 1));
  }

  /* axes fit the curves; a buckling line (preview curves only) is kept on-scale
     only if it sits within 1.6× its own curve's top, otherwise it becomes an
     off-scale tag — so it never floats over another design's curve */
  var epsMax = 0, curveMax = 0;
  for (var e = 0; e < entries.length; e++){
    var cv = entries[e].nl.curve;
    for (var k = 0; k < cv.length; k++){
      if (cv[k].eps > epsMax) epsMax = cv[k].eps;
      if (cv[k].sigma / entries[e].div > curveMax) curveMax = cv[k].sigma / entries[e].div;
    }
  }
  var yTop = curveMax * 1.12;
  for (var e2 = 0; e2 < entries.length; e2++){
    var own = 0, cvo = entries[e2].nl.curve;
    for (var o2 = 0; o2 < cvo.length; o2++) if (cvo[o2].sigma > own) own = cvo[o2].sigma;
    entries[e2].ownTop = own / entries[e2].div;
    var pv = (entries[e2].isView && entries[e2].pcr != null) ? entries[e2].pcr / entries[e2].div : null;
    entries[e2].pcrPlot = pv;
    entries[e2].pcrOnScale = (pv != null && pv <= entries[e2].ownTop * 1.6);
    if (entries[e2].pcrOnScale && pv * 1.08 > yTop) yTop = pv * 1.08;
  }
  var yStep = _mpNiceStep(yTop, 5), yCap = Math.ceil(yTop / yStep) * yStep;
  var epsPct = epsMax * 100, xStep = _mpNiceStep(epsPct * 1.02, 6), xCap = Math.ceil(epsPct * 1.02 / xStep) * xStep;

  /* draw at the panel's own aspect so text is not stretched */
  var host = document.getElementById('mergedPlot');
  var W = 800, H = 360;
  if (size && size.W > 0 && size.H > 0){ W = Math.max(420, size.W); H = Math.max(220, size.H); }   /* 2nd pass: measured canvas */
  else if (host && host.clientWidth > 200 && host.clientHeight > 200){
    W = Math.max(520, host.clientWidth - 44);
    H = Math.max(240, host.clientHeight - 36 - 30 - 64);
  }
  /* off-scale buckling tags live in a strip ABOVE the plot area (one row each) */
  var nOff = 0;
  for (var eo = 0; eo < entries.length; eo++) if (entries[eo].pcrPlot != null && !(entries[eo].pcrOnScale && entries[eo].pcrPlot <= yCap)) nOff++;
  var X0 = 64, X1 = W - 24, Y0 = 22 + 15 * Math.max(nOff, 1), Y1 = H - 40;
  function px(ep){ return X0 + (X1 - X0) * (ep / xCap); }
  function py(sv){ return Y1 - (Y1 - Y0) * (sv / yCap); }
  var MONO = 'JetBrains Mono,monospace';

  var axList = [];
  for (var ak = 0; ak < 3; ak++){ var akk = ['xx', 'yy', 'zz'][ak]; if (axesSeen[akk]) axList.push(akk.charAt(0).toUpperCase()); }
  var axisLabel = axList.join(' · ');
  var capPct = Math.round((entries[0].nl.epsCap || 0.05) * 100);
  /* v0.16.0 — void used (scaled per design and axis) */
  var vMin = Infinity, vMax = 0;
  for (var vi = 0; vi < entries.length; vi++){ var vc = entries[vi].nl.voidContrast; if (vc > 0){ if (vc < vMin) vMin = vc; if (vc > vMax) vMax = vc; } }
  var voidTxt = (vMax > 0) ? (' · void ' + vMin.toExponential(0) + (vMax > vMin * 1.0001 ? '–' + vMax.toExponential(0) : '')) : '';
  var html = '<div class="mp-head">' +
    '<div class="mp-title">Stress–Strain · Comparison</div>' +
    '<div class="mp-head-right">' +
      '<span class="mp-sub">UNIAXIAL · ' + axisLabel + ' · J2 plasticity (small strain) · N=' + entries[0].nl.N + ' · ε≤' + capPct + '%' + voidTxt + '</span>' +
      '<span class="mp-scale">' +
        '<button class="mp-scale-btn' + (!norm ? ' active' : '') + '" onclick="onCurveScaleToggle(\'abs\')" title="Stress in MPa">MPa</button>' +
        '<button class="mp-scale-btn' + (norm ? ' active' : '') + '" onclick="onCurveScaleToggle(\'norm\')" title="Each curve divided by its own yield strength — compares curve shape across designs of very different strength">÷ own yield</button>' +
      '</span>' +
    '</div>' +
    '</div>' +
    '<div class="mp-canvas"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';

  /* grid + ticks */
  html += '<g stroke="#23233a" stroke-width="1">';
  for (var yv = 0; yv <= yCap + 1e-9; yv += yStep){ var yy = py(yv).toFixed(1); html += '<line x1="' + X0 + '" y1="' + yy + '" x2="' + X1 + '" y2="' + yy + '"' + (yv === 0 ? '' : ' stroke-dasharray="2,5"') + '/>'; }
  for (var xv = 0; xv <= xCap + 1e-9; xv += xStep){ var xx = px(xv).toFixed(1); html += '<line x1="' + xx + '" y1="' + Y0 + '" x2="' + xx + '" y2="' + Y1 + '"' + (xv === 0 ? '' : ' stroke-dasharray="2,5"') + '/>'; }
  html += '</g><g font-family="' + MONO + '" font-size="11" fill="#7a7a92">';
  for (var yl = 0; yl <= yCap + 1e-9; yl += yStep) html += '<text x="' + (X0 - 10) + '" y="' + (py(yl) + 4).toFixed(1) + '" text-anchor="end">' + _mpFmt(yl, yStep) + '</text>';
  for (var xl = 0; xl <= xCap + 1e-9; xl += xStep) html += '<text x="' + px(xl).toFixed(1) + '" y="' + (Y1 + 18) + '" text-anchor="middle">' + _mpFmt(xl, xStep) + '</text>';
  var yName = norm ? 'σ / own σ_y' : 'σ (MPa)';
  html += '<text x="16" y="' + ((Y0 + Y1) / 2).toFixed(0) + '" text-anchor="middle" transform="rotate(-90, 16, ' + ((Y0 + Y1) / 2).toFixed(0) + ')" letter-spacing="1">' + yName + '</text>';
  html += '<text x="' + ((X0 + X1) / 2).toFixed(0) + '" y="' + (H - 6) + '" text-anchor="middle" letter-spacing="1">ε (%)</text>';
  html += '</g>';
  /* every annotation goes through a small collision-aware placer (below) so
     labels never overprint each other, the dots, or the plot edges */
  var labels = [], dots = [];
  function lab(x, y, txt, o){ o = o || {}; labels.push({ x: x, y: y, t: txt, anchor: o.anchor || 'start', size: o.size || 10.5, col: o.col || '#b8b8d0', w8: o.bold ? 600 : 400, pri: o.pri || 50, drop: !!o.drop, fixed: !!o.fixed }); }
  if (norm) lab(X0 + 6, py(1) - 5, 'yield = 1', { size: 10, col: '#7a7a92', pri: 40, drop: true });

  /* quiet (non-preview) curves first so the bold ones sit on top */
  var order = [];
  for (var oq = 0; oq < entries.length; oq++) if (!entries[oq].isView) order.push(entries[oq]);
  for (var oq2 = 0; oq2 < entries.length; oq2++) if (entries[oq2].isView) order.push(entries[oq2]);

  var offTags = [], anyBuckLimited = false, squashedList = [];
  for (var ci = 0; ci < order.length; ci++){
    var en2 = order[ci], dd = en2.design, nlc = en2.nl, cvv = nlc.curve, dv = en2.div, col = dd.color, bold = en2.isView;
    var yielded = !!(nlc.yielded && isFinite(nlc.sigma_y_eff));
    var letter = dd.label.split('·').pop().trim();
    var axU = en2.axis.charAt(0).toUpperCase();
    var tag = multi ? (letter + '·' + axU) : letter;
    var dash = multi ? MP_AXIS_DASH[en2.axis] : '';

    /* 0.2 %-offset construction line (textbook), up to the yield point — preview curve only */
    if (bold && yielded && isFinite(nlc.E0) && nlc.E0 > 0){
      var epsY = nlc.sigma_y_eff / nlc.E0 + 0.002;
      html += '<line x1="' + px(0.2).toFixed(1) + '" y1="' + py(0).toFixed(1) + '" x2="' + px(epsY * 100).toFixed(1) + '" y2="' + py(nlc.sigma_y_eff / dv).toFixed(1) + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="3,4" opacity="0.45"/>';
    }
    /* curve from the origin */
    var path = 'M' + px(0).toFixed(1) + ',' + py(0).toFixed(1);
    for (var pi = 0; pi < cvv.length; pi++) path += ' L' + px(cvv[pi].eps * 100).toFixed(1) + ',' + py(cvv[pi].sigma / dv).toFixed(1);
    html += '<path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="' + (bold ? 2.4 : 1.5) + '"' +
            (dash ? ' stroke-dasharray="' + dash + '"' : '') + (bold ? '' : ' opacity="0.6"') +
            ' stroke-linejoin="round" stroke-linecap="round"/>';
    /* the curve is an obstacle for labels: sample it every ~6 px */
    var pxPrev = px(0), pyPrev = py(0);
    for (var ob = 0; ob < cvv.length; ob++){
      var pxN = px(cvv[ob].eps * 100), pyN = py(cvv[ob].sigma / dv), segL = Math.sqrt((pxN - pxPrev) * (pxN - pxPrev) + (pyN - pyPrev) * (pyN - pyPrev)), nS = Math.max(1, Math.ceil(segL / 6));
      for (var sI = 0; sI <= nS; sI++){ var fx = pxPrev + (pxN - pxPrev) * sI / nS, fy = pyPrev + (pyN - pyPrev) * sI / nS; dots.push({ x0: fx - 2, x1: fx + 2, y0: fy - 2, y1: fy + 2 }); }
      pxPrev = pxN; pyPrev = pyN;
    }
    /* direct label at the curve end; flag curves squashed by a stronger design */
    var lastP = cvv[cvv.length - 1], lx2 = px(lastP.eps * 100), ly2 = py(lastP.sigma / dv);
    if (bold && !norm && en2.ownTop < 0.12 * yCap) squashedList.push(letter);
    lab(lx2 + 8, ly2 + 4, tag, bold ? { size: 11, col: col, bold: true, pri: 80 } : { size: 10, col: col, pri: 55, drop: true });
    /* hover targets on every solved point */
    html += '<g fill="transparent">';
    for (var hi = 0; hi < cvv.length; hi++){
      html += '<circle cx="' + px(cvv[hi].eps * 100).toFixed(1) + '" cy="' + py(cvv[hi].sigma / dv).toFixed(1) + '" r="7"><title>Design ' + letter + ' · ' + axU + ' crush · ε = ' + (cvv[hi].eps * 100).toFixed(2) + ' % · σ = ' + cvv[hi].sigma.toFixed(1) + ' MPa' + (norm ? ' (' + (cvv[hi].sigma / dv).toFixed(2) + '× yield)' : '') + '</title></circle>';
    }
    html += '</g>';
    /* yield dot (+ label on the preview curve) */
    if (yielded){
      var ex = isFinite(nlc.E0) && nlc.E0 > 0 ? (nlc.sigma_y_eff / nlc.E0 + 0.002) * 100 : null;
      if (ex == null){ for (var qi = 0; qi < cvv.length; qi++) if (cvv[qi].sigma >= nlc.sigma_y_eff){ ex = cvv[qi].eps * 100; break; } }
      if (ex != null){
        var cxv = px(ex), cyv = py(nlc.sigma_y_eff / dv), rD = bold ? 4.5 : 3;
        html += '<circle cx="' + cxv.toFixed(1) + '" cy="' + cyv.toFixed(1) + '" r="' + rD + '" fill="' + col + '" stroke="#0a0a12" stroke-width="1.5"' + (bold ? '' : ' opacity="0.75"') + '><title>Design ' + letter + ' · ' + axU + ' crush · 0.2% offset yield: ' + nlc.sigma_y_eff.toFixed(1) + ' MPa at ε = ' + ex.toFixed(2) + ' %</title></circle>';
        dots.push({ x0: cxv - rD - 1, x1: cxv + rD + 1, y0: cyv - rD - 1, y1: cyv + rD + 1 });
        if (bold) lab(cxv + 9, cyv + 16, tag + ' σ_y ' + nlc.sigma_y_eff.toFixed(nlc.sigma_y_eff >= 100 ? 0 : 1) + ' MPa', { col: col, pri: 70 });
      }
    }
    /* buckling reference (preview curve, same axis) */
    if (en2.pcrPlot != null){
      var ratio = yielded ? en2.pcr / nlc.sigma_y_eff : null;
      anyBuckLimited = anyBuckLimited || (yielded && en2.pcr < nlc.sigma_y_eff);
      var bTxt = (multi ? axU + ' ' : '') + 'σ_cr ' + (en2.pcr >= 100 ? en2.pcr.toFixed(0) : en2.pcr.toFixed(1)) + ' MPa' + (ratio != null ? ' · ' + (ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)) + '× yield' : '');
      if (en2.pcrOnScale && en2.pcrPlot <= yCap){
        var yb = py(en2.pcrPlot).toFixed(1);
        html += '<line x1="' + X0 + '" y1="' + yb + '" x2="' + X1 + '" y2="' + yb + '" stroke="' + col + '" stroke-width="1.4" stroke-dasharray="14,4,2,4" opacity="0.7"/>';
        dots.push({ x0: X0, x1: X1, y0: parseFloat(yb) - 1.5, y1: parseFloat(yb) + 1.5 });
        lab(X1 - 4, parseFloat(yb) - 6, 'buckles · ' + bTxt, { anchor: 'end', col: col, pri: 60, drop: true });   /* value also in the legend */
      } else offTags.push({ col: col, txt: bTxt, letter: letter });
    }
  }
  /* off-scale buckling tags, stacked top-right */
  for (var ot = 0; ot < offTags.length; ot++){
    var tg = offTags[ot];
    var tagLong = '▲ Design ' + tg.letter + ' buckles at ' + tg.txt + ' — above its curve, not drawn', tagShort = '▲ ' + tg.letter + ' buckles at ' + tg.txt;
    lab(X1, 16 + ot * 15, (tagLong.length * 10.5 * 0.62 <= X1 - 8) ? tagLong : tagShort, { anchor: 'end', col: tg.col, pri: 90, fixed: true });
  }
  /* the buckling-limited warning lives in the legend row (never collides with the plot) */
  html += _mpPlaceLabels(labels, dots, { X0: X0, X1: X1, Y0: Y0, Y1: Y1, W: W, font: MONO });
  html += '</svg></div>';

  /* legend — one row per design, numbers for its preview axis */
  html += '<div class="mp-legend">';
  for (var li = 0; li < perDesign.length; li++){
    var ld = perDesign[li].design, lv = perDesign[li].view, lnl = lv.nl;
    var lletter = ld.label.split('·').pop().trim();
    var yieldTxt = (lnl.yielded && isFinite(lnl.sigma_y_eff))
      ? ('σ_y ' + lnl.sigma_y_eff.toFixed(1) + ' MPa' + (isFinite(lnl.E0) ? ' · E ' + (lnl.E0 >= 1000 ? (lnl.E0 / 1000).toFixed(2) + ' GPa' : lnl.E0.toFixed(0) + ' MPa') : '') + (lnl.truncated ? ' (partial)' : ''))
      : (lnl.truncReason === 'step-budget' && isFinite(lnl.eAxisMax))
        ? ('stopped at ε=' + (lnl.eAxisMax * 100).toFixed(2) + '% (step budget) — no yield in range reached')
        : ('no yield ≤ ' + Math.round((lnl.epsCap || 0.05) * 100) + '%' + (isFinite(lnl.sigmaCap) ? (' (σ_y > ' + lnl.sigmaCap.toFixed(0) + ' MPa)') : ''));
    var lpcr = lv.pcr, lbTxt = '';
    if (lpcr != null){
      var lrat = (lnl.yielded && isFinite(lnl.sigma_y_eff)) ? lpcr / lnl.sigma_y_eff : null;
      lbTxt = ' · σ_cr ' + (lpcr >= 100 ? lpcr.toFixed(0) : lpcr.toFixed(1)) + ' MPa' + (lrat != null ? ' (' + (lrat >= 10 ? lrat.toFixed(0) : lrat.toFixed(1)) + '× yield)' : '');
    }
    html += '<div class="mp-legend-item">' +
      '<div class="swatch" style="background:' + ld.color + '"></div>' +
      '<strong style="color:' + ld.color + '">Design ' + lletter + '</strong> ' + ld.title +
      '<span class="marker">' + (multi ? lv.axis.charAt(0).toUpperCase() + ': ' : '') + yieldTxt + lbTxt +
        ((lnl.lateralFloor > (typeof NL_LATERAL_FLAG !== 'undefined' ? NL_LATERAL_FLAG : 0.05)) ? ' · <span style="color:var(--warn)" title="Side stress resolved only to about ' + Math.round(lnl.lateralFloor * 100) + '% of axial at the solver\'s tolerance">post-yield approximate</span>' : '') + '</span>' +
      '</div>';
  }
  if (squashedList.length) html += '<div class="mp-legend-item mp-legend-hint">Design' + (squashedList.length > 1 ? 's ' : ' ') + squashedList.join(', ') + (squashedList.length > 1 ? ' are' : ' is') + ' small at this scale — switch to <button class="mp-scale-btn" onclick="onCurveScaleToggle(\'norm\')">÷ own yield</button> to compare curve shapes</div>';
  if (anyBuckLimited) html += '<div class="mp-legend-item mp-legend-warn">⚠ buckling-limited — collapses at σ_cr before it yields; the curve above that line is not reached</div>';
  var axKey = '';
  if (multi){
    axKey = 'axis: ';
    for (var ka = 0; ka < 3; ka++){
      var kk = ['xx', 'yy', 'zz'][ka];
      if (!axesSeen[kk]) continue;
      axKey += '<svg width="26" height="6"><line x1="1" y1="3" x2="25" y2="3" stroke="#b8b8d0" stroke-width="2" stroke-linecap="round"' + (MP_AXIS_DASH[kk] ? ' stroke-dasharray="' + MP_AXIS_DASH[kk] + '"' : '') + '/></svg>' + kk.charAt(0).toUpperCase() + ' ';
    }
    axKey += '· bold = preview axis (' + viewAx.charAt(0).toUpperCase() + ') · ';
  }
  html += '<div class="mp-legend-item mp-legend-key">' + axKey + '<svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#8a8aa2" stroke-width="1" stroke-dasharray="3,4"/></svg>0.2% offset · <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#8a8aa2" stroke-width="1.4" stroke-dasharray="14,4,2,4"/></svg>buckling strength</div>';
  html += '</div>';
  return html;
}
