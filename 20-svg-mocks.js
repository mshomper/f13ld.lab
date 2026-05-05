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
   buildMergedCurvePlot — generates the σ–ε comparison plot
   when curve mode is active. Reads from LAB_STATE.designs.
   ---------------------------------------------------------- */
function buildMergedCurvePlot(){
  if (!LAB_STATE.runHasCompleted){
    return '<div class="mp-empty">' +
      '<div class="icon">∿</div>' +
      '<div class="msg">Run a comparison to see σ–ε curves</div>' +
      '</div>';
  }
  var html = '<div class="mp-head">' +
    '<div class="mp-title">Stress–Strain · Comparison</div>' +
    '<div class="mp-sub">UNIAXIAL · Z · 15 increments · J2 plasticity + geometric NL</div>' +
    '</div>' +
    '<div class="mp-canvas">' +
    '<svg viewBox="0 0 800 360" preserveAspectRatio="none">' +
    '<g stroke="#1a1a2a" stroke-width="0.5">' +
      '<line x1="60" y1="20"  x2="60"  y2="320"/>' +
      '<line x1="60" y1="320" x2="780" y2="320"/>' +
      '<line x1="60" y1="260" x2="780" y2="260" stroke-dasharray="2,4"/>' +
      '<line x1="60" y1="200" x2="780" y2="200" stroke-dasharray="2,4"/>' +
      '<line x1="60" y1="140" x2="780" y2="140" stroke-dasharray="2,4"/>' +
      '<line x1="60" y1="80"  x2="780" y2="80"  stroke-dasharray="2,4"/>' +
      '<line x1="204" y1="20"  x2="204" y2="320" stroke-dasharray="2,4"/>' +
      '<line x1="348" y1="20"  x2="348" y2="320" stroke-dasharray="2,4"/>' +
      '<line x1="492" y1="20"  x2="492" y2="320" stroke-dasharray="2,4"/>' +
      '<line x1="636" y1="20"  x2="636" y2="320" stroke-dasharray="2,4"/>' +
    '</g>' +
    '<g font-family="JetBrains Mono,monospace" font-size="10" fill="#555">' +
      '<text x="40" y="324" text-anchor="end">0</text>' +
      '<text x="40" y="264" text-anchor="end">15</text>' +
      '<text x="40" y="204" text-anchor="end">30</text>' +
      '<text x="40" y="144" text-anchor="end">45</text>' +
      '<text x="40" y="84"  text-anchor="end">60</text>' +
      '<text x="60"  y="338" text-anchor="middle">0</text>' +
      '<text x="204" y="338" text-anchor="middle">0.5</text>' +
      '<text x="348" y="338" text-anchor="middle">1.0</text>' +
      '<text x="492" y="338" text-anchor="middle">1.5</text>' +
      '<text x="636" y="338" text-anchor="middle">2.0</text>' +
      '<text x="780" y="338" text-anchor="middle">2.5</text>' +
      '<text x="20" y="170" text-anchor="middle" transform="rotate(-90, 20, 170)" letter-spacing="1.5">σ (MPa)</text>' +
      '<text x="420" y="354" text-anchor="middle" letter-spacing="1.5">ε (%)</text>' +
    '</g>';

  // mock curve paths — Phase 6 replaces with real solver data
  var curves = [
    { d:'M60,320 L120,260 L180,200 L240,140 L290,108 L340,90 L400,82 L470,78 L540,76 L620,75 L720,74',  yieldX:290, yieldY:108 },
    { d:'M60,320 L130,278 L210,236 L290,196 L360,170 L430,156 L510,148 L590,144 L680,142 L760,141',     yieldX:290, yieldY:196 },
    { d:'M60,320 L150,272 L240,224 L330,182 L410,160 L490,156 L570,160 L650,168 L730,180',              yieldX:410, yieldY:160 }
  ];
  for (var i = 0; i < LAB_STATE.designs.length && i < 3; i++){
    var d = LAB_STATE.designs[i];
    var c = curves[i];
    html += '<path d="'+c.d+'" fill="none" stroke="'+d.color+'" stroke-width="2"/>';
    html += '<circle cx="'+c.yieldX+'" cy="'+c.yieldY+'" r="3" fill="'+d.color+'"/>';
  }
  html += '</svg></div>';

  // legend
  html += '<div class="mp-legend">';
  for (var j = 0; j < LAB_STATE.designs.length; j++){
    var dd = LAB_STATE.designs[j];
    var letter = dd.label.split('·').pop().trim();
    html += '<div class="mp-legend-item">' +
      '<div class="swatch" style="background:'+dd.color+'"></div>' +
      '<strong style="color:'+dd.color+'">Design '+letter+'</strong> '+dd.title+
      '<span class="marker">σ_y = '+dd.results.sigma_y_z.toFixed(1)+' MPa</span>' +
      '</div>';
  }
  html += '</div>';
  return html;
}
