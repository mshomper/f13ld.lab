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

function onCurveScaleToggle(mode){
  if (mode !== 'abs' && mode !== 'norm') return;
  CURVE_STATE.scale = mode;
  var mPlot = document.getElementById('mergedPlot');
  if (mPlot) mPlot.innerHTML = buildMergedCurvePlot();   /* plot only — the α cubes keep running */
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

function buildMergedCurvePlot(){
  var entries = [];
  for (var i = 0; i < LAB_STATE.designs.length && i < 3; i++){
    var d = LAB_STATE.designs[i];
    var nl = (typeof NONLIN_BY_DESIGN !== 'undefined') ? NONLIN_BY_DESIGN[d.id] : null;
    if (nl && !nl.error && nl.curve && nl.curve.length > 1){
      var bk = (typeof BUCKLE_BY_DESIGN !== 'undefined') ? BUCKLE_BY_DESIGN[d.id] : null;
      /* buckling on the crush axis when available (same axis as the curve) */
      var pcr = null;
      if (bk && !bk.error && !bk.skip_reason){
        pcr = isFinite(bk.pcr_ratio_ref) ? bk.pcr_ratio_ref : (isFinite(bk.pcr) ? bk.pcr : null);
      }
      entries.push({ design: d, nl: nl, pcr: pcr, pcrAxis: bk && bk.ratioAxis });
    }
  }
  if (!entries.length){
    var msg = LAB_STATE.runHasCompleted
      ? 'Enable Nonlinear and Run a comparison to see σ–ε curves'
      : 'Run a comparison to see σ–ε curves';
    return '<div class="mp-empty"><div class="icon">∿</div><div class="msg">' + msg + '</div></div>';
  }

  var norm = CURVE_STATE.scale === 'norm';
  /* per-design scale: MPa, or divide by own yield (by the curve's top when it never yields) */
  for (var e0 = 0; e0 < entries.length; e0++){
    var en = entries[e0], cv0 = en.nl.curve, top = 0;
    for (var t0 = 0; t0 < cv0.length; t0++) if (cv0[t0].sigma > top) top = cv0[t0].sigma;
    en.div = !norm ? 1 : ((en.nl.yielded && isFinite(en.nl.sigma_y_eff) && en.nl.sigma_y_eff > 0) ? en.nl.sigma_y_eff : (top || 1));
  }

  /* axes fit the curves; a buckling line is kept on-scale only if it sits
     within 1.6× the highest curve, otherwise it becomes an off-scale tag */
  var epsMax = 0, curveMax = 0;
  for (var e = 0; e < entries.length; e++){
    var cv = entries[e].nl.curve;
    for (var k = 0; k < cv.length; k++){
      if (cv[k].eps > epsMax) epsMax = cv[k].eps;
      if (cv[k].sigma / entries[e].div > curveMax) curveMax = cv[k].sigma / entries[e].div;
    }
  }
  /* a design's buckling line is drawn only when it sits near its OWN curve
     (≤ 1.6× that curve's top) — otherwise it would float over another
     design's curve and read as belonging to it; it becomes a tag instead */
  var yTop = curveMax * 1.12;
  for (var e2 = 0; e2 < entries.length; e2++){
    var own = 0, cvo = entries[e2].nl.curve;
    for (var o2 = 0; o2 < cvo.length; o2++) if (cvo[o2].sigma > own) own = cvo[o2].sigma;
    entries[e2].ownTop = own / entries[e2].div;
    var pv = entries[e2].pcr != null ? entries[e2].pcr / entries[e2].div : null;
    entries[e2].pcrPlot = pv;
    entries[e2].pcrOnScale = (pv != null && pv <= entries[e2].ownTop * 1.6);
    if (entries[e2].pcrOnScale && pv * 1.08 > yTop) yTop = pv * 1.08;
  }
  var yStep = _mpNiceStep(yTop, 5), yCap = Math.ceil(yTop / yStep) * yStep;
  var epsPct = epsMax * 100, xStep = _mpNiceStep(epsPct * 1.02, 6), xCap = Math.ceil(epsPct * 1.02 / xStep) * xStep;

  /* draw at the panel's own aspect so text is not stretched */
  var host = document.getElementById('mergedPlot');
  var W = 800, H = 360;
  if (host && host.clientWidth > 200 && host.clientHeight > 200){
    W = Math.max(520, host.clientWidth - 44);
    H = Math.max(240, host.clientHeight - 36 - 30 - 64);
  }
  var X0 = 64, X1 = W - 24, Y0 = 34, Y1 = H - 40;
  function px(ep){ return X0 + (X1 - X0) * (ep / xCap); }
  function py(sv){ return Y1 - (Y1 - Y0) * (sv / yCap); }
  var MONO = 'JetBrains Mono,monospace';

  var axisLabel = (entries[0].nl.axis || 'zz').toUpperCase();
  var capPct = Math.round((entries[0].nl.epsCap || 0.05) * 100);
  var html = '<div class="mp-head">' +
    '<div class="mp-title">Stress–Strain · Comparison</div>' +
    '<div class="mp-head-right">' +
      '<span class="mp-sub">UNIAXIAL · ' + axisLabel + ' · J2 plasticity (small strain) · N=' + entries[0].nl.N + ' · ε≤' + capPct + '%</span>' +
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
  if (norm){ var y1 = py(1).toFixed(1); html += '<text x="' + (X0 + 6) + '" y="' + (parseFloat(y1) - 5).toFixed(1) + '" font-family="' + MONO + '" font-size="10" fill="#7a7a92">yield = 1</text>'; }

  var offTags = [], anyBuckLimited = false;
  for (var ci = 0; ci < entries.length; ci++){
    var en2 = entries[ci], dd = en2.design, nlc = en2.nl, cvv = nlc.curve, dv = en2.div, col = dd.color;
    var yielded = !!(nlc.yielded && isFinite(nlc.sigma_y_eff));

    /* 0.2 %-offset construction line (textbook), up to the yield point */
    if (yielded && isFinite(nlc.E0) && nlc.E0 > 0){
      var epsY = nlc.sigma_y_eff / nlc.E0 + 0.002;
      html += '<line x1="' + px(0.2).toFixed(1) + '" y1="' + py(0).toFixed(1) + '" x2="' + px(epsY * 100).toFixed(1) + '" y2="' + py(nlc.sigma_y_eff / dv).toFixed(1) + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="3,4" opacity="0.45"/>';
    }
    /* curve from the origin */
    var path = 'M' + px(0).toFixed(1) + ',' + py(0).toFixed(1);
    for (var pi = 0; pi < cvv.length; pi++) path += ' L' + px(cvv[pi].eps * 100).toFixed(1) + ',' + py(cvv[pi].sigma / dv).toFixed(1);
    html += '<path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
    /* direct label at the curve end; flag curves squashed by a stronger design */
    var lastP = cvv[cvv.length - 1], lx2 = px(lastP.eps * 100), ly2 = py(lastP.sigma / dv);
    var squashed = !norm && en2.ownTop < 0.12 * yCap;
    html += '<text x="' + (lx2 + 8).toFixed(1) + '" y="' + (ly2 + 4).toFixed(1) + '" font-family="' + MONO + '" font-size="11" font-weight="600" fill="' + col + '">' + dd.label.split('·').pop().trim() + '</text>';
    if (squashed) html += '<text x="' + (lx2 - 4).toFixed(1) + '" y="' + (ly2 - 10).toFixed(1) + '" text-anchor="end" font-family="' + MONO + '" font-size="10" fill="#7a7a92">Design ' + dd.label.split('·').pop().trim() + ' is small at this scale — try ÷ own yield</text>';
    /* hover targets on every solved point */
    var letter = dd.label.split('·').pop().trim();
    html += '<g fill="transparent">';
    for (var hi = 0; hi < cvv.length; hi++){
      html += '<circle cx="' + px(cvv[hi].eps * 100).toFixed(1) + '" cy="' + py(cvv[hi].sigma / dv).toFixed(1) + '" r="7"><title>Design ' + letter + ' · ε = ' + (cvv[hi].eps * 100).toFixed(2) + ' % · σ = ' + cvv[hi].sigma.toFixed(1) + ' MPa' + (norm ? ' (' + (cvv[hi].sigma / dv).toFixed(2) + '× yield)' : '') + '</title></circle>';
    }
    html += '</g>';
    /* yield dot + label */
    if (yielded){
      var ex = isFinite(nlc.E0) && nlc.E0 > 0 ? (nlc.sigma_y_eff / nlc.E0 + 0.002) * 100 : null;
      if (ex == null){ for (var qi = 0; qi < cvv.length; qi++) if (cvv[qi].sigma >= nlc.sigma_y_eff){ ex = cvv[qi].eps * 100; break; } }
      if (ex != null){
        var cxv = px(ex), cyv = py(nlc.sigma_y_eff / dv);
        html += '<circle cx="' + cxv.toFixed(1) + '" cy="' + cyv.toFixed(1) + '" r="4.5" fill="' + col + '" stroke="#0a0a12" stroke-width="1.5"><title>Design ' + letter + ' 0.2% offset yield: ' + nlc.sigma_y_eff.toFixed(1) + ' MPa at ε = ' + ex.toFixed(2) + ' %</title></circle>';
        /* stagger labels so designs yielding at the same point (normalized view) stay legible */
        var lyv = cyv + 16 + ci * 14;
        if (lyv > Y1 - 22) lyv = cyv - 10 - ci * 14;     /* near the axis → label above the dot */
        html += '<text x="' + (cxv + 8).toFixed(1) + '" y="' + lyv.toFixed(1) + '" font-family="' + MONO + '" font-size="10.5" fill="' + col + '">' + letter + ' σ_y ' + nlc.sigma_y_eff.toFixed(nlc.sigma_y_eff >= 100 ? 0 : 1) + ' MPa</text>';
      }
    }
    /* buckling reference */
    if (en2.pcrPlot != null){
      var ratio = yielded ? en2.pcr / nlc.sigma_y_eff : null;
      if (!yielded || (isFinite(nlc.sigma_y_eff) && en2.pcr < nlc.sigma_y_eff)) anyBuckLimited = anyBuckLimited || (yielded && en2.pcr < nlc.sigma_y_eff);
      var bTxt = 'σ_cr ' + (en2.pcr >= 100 ? en2.pcr.toFixed(0) : en2.pcr.toFixed(1)) + ' MPa' + (ratio != null ? ' · ' + (ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)) + '× yield' : '');
      if (en2.pcrOnScale && en2.pcrPlot <= yCap){
        var yb = py(en2.pcrPlot).toFixed(1);
        html += '<line x1="' + X0 + '" y1="' + yb + '" x2="' + X1 + '" y2="' + yb + '" stroke="' + col + '" stroke-width="1.4" stroke-dasharray="7,5" opacity="0.7"/>';
        html += '<text x="' + (X1 - 4) + '" y="' + (parseFloat(yb) - 6).toFixed(1) + '" text-anchor="end" font-family="' + MONO + '" font-size="10.5" fill="' + col + '">buckles · ' + bTxt + '</text>';
      } else offTags.push({ col: col, txt: bTxt, letter: letter });
    }
  }
  /* off-scale buckling tags, stacked top-right */
  for (var ot = 0; ot < offTags.length; ot++){
    var tg = offTags[ot], ty = Y0 - 16 + ot * 14;
    html += '<text x="' + X1 + '" y="' + ty + '" text-anchor="end" font-family="' + MONO + '" font-size="10.5" fill="' + tg.col + '">▲ Design ' + tg.letter + ' buckles at ' + tg.txt + ' — above its curve, not drawn</text>';
  }
  if (anyBuckLimited){
    html += '<text x="' + (X0 + 8) + '" y="' + (Y0 + 14) + '" font-family="' + MONO + '" font-size="11" fill="#e0b020">⚠ buckling-limited — collapses at σ_cr before it yields; the curve above that line is not reached</text>';
  }
  html += '</svg></div>';

  /* legend */
  html += '<div class="mp-legend">';
  for (var li = 0; li < entries.length; li++){
    var ld = entries[li].design, lnl = entries[li].nl;
    var lletter = ld.label.split('·').pop().trim();
    var yieldTxt = (lnl.yielded && isFinite(lnl.sigma_y_eff))
      ? ('σ_y ' + lnl.sigma_y_eff.toFixed(1) + ' MPa' + (isFinite(lnl.E0) ? ' · E ' + (lnl.E0 >= 1000 ? (lnl.E0 / 1000).toFixed(2) + ' GPa' : lnl.E0.toFixed(0) + ' MPa') : '') + (lnl.truncated ? ' (partial)' : ''))
      : (lnl.truncReason === 'step-budget' && isFinite(lnl.eAxisMax))
        ? ('stopped at ε=' + (lnl.eAxisMax * 100).toFixed(2) + '% (step budget) — no yield in range reached')
        : ('no yield ≤ ' + Math.round((lnl.epsCap || 0.05) * 100) + '%' + (isFinite(lnl.sigmaCap) ? (' (σ_y > ' + lnl.sigmaCap.toFixed(0) + ' MPa)') : ''));
    html += '<div class="mp-legend-item">' +
      '<div class="swatch" style="background:' + ld.color + '"></div>' +
      '<strong style="color:' + ld.color + '">Design ' + lletter + '</strong> ' + ld.title +
      '<span class="marker">' + yieldTxt + '</span>' +
      '</div>';
  }
  html += '<div class="mp-legend-item mp-legend-key"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#8a8aa2" stroke-width="1" stroke-dasharray="3,4"/></svg>0.2% offset · <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#8a8aa2" stroke-width="1.4" stroke-dasharray="7,5"/></svg>buckling strength</div>';
  html += '</div>';
  return html;
}
