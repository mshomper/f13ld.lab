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
   v0.33.0: Stiffness | Thermal | Flow switch in the header; every panel but the cell
   geometry follows it (directional κ(n) / K(n), tensors, mode-filtered metric lists,
   conductivity vs solid fraction with Hashin–Shtrikman bounds, permeability vs
   porosity with a trabecular-bone band, cross-physics design space, fitted value axes).
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
  green: '#1D9E75', neon: '#c8f542', lab: '#E06A6F', cyan: '#22d3ee', rose: '#fb7185',
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
              link: true, camGeo: null, camSurf: null, s3: { metric: 'max', scale: 'auto', color: 'value', cam: null },
              /* v0.33.0 — physics mode, focused pore filler, bone band, and each panel's metric per mode */
              phys: 'stiffness', focus: null, bone: false, mapBy: {}, s3By: {}, scBy: {} };

/* ── v0.33.0 — physics modes (Stiffness | Thermal | Flow) ─────
   One switch in the header picks which results the Atlas shows.  Cell
   geometry, the series, the run selection and the parameter grid are
   shared; every other panel follows the mode.  Metrics are described by
   data (atlasMetricDefs) so the map, the 3-D surface and the design space
   offer the same, mode-filtered lists. */
var ATLAS_PHYS = [
  { id: 'stiffness', label: 'Stiffness', icon: 'elastic' },
  { id: 'thermal', label: 'Thermal', icon: 'thermal' },
  { id: 'flow', label: 'Flow', icon: 'flow' }
];
/* pore fillers: line colour and dash, the same in every chart */
var ATLAS_FILLER_STYLE = { air: { col: '#9fb4ff', dash: '2 4' }, water: { col: '#22d3ee', dash: '' }, tissue: { col: '#f4a6c8', dash: '7 4' } };
var ATLAS_BONE_K = [0.027, 20];   /* trabecular bone permeability, ×10⁻⁹ m² (Nauman, Fong & Keaveny 1999) */
var ATLAS_SC_DEFAULT = { stiffness: ['vf', 'max'], thermal: ['max', 'k_*'], flow: ['max', 'perm'] };
function atlasFillerIds() { return (typeof THERMAL_FILLERS !== 'undefined' ? THERMAL_FILLERS : [{ id: 'air' }, { id: 'water' }, { id: 'tissue' }]).map(function (f) { return f.id; }); }
function atlasFillerLabel(id) { var f = (typeof thermalFillerById === 'function') ? thermalFillerById(id) : null; return f ? f.label : id.charAt(0).toUpperCase() + id.slice(1); }
function atlasFillerSw(id, w) {
  var st = ATLAS_FILLER_STYLE[id] || { col: ATLAS_COL.ink2, dash: '' }; w = w || 18;
  return '<svg class="at-fsw" width="' + w + '" height="6" aria-hidden="true"><line x1="1" y1="3" x2="' + (w - 1) + '" y2="3" stroke="' + st.col + '" stroke-width="2" stroke-dasharray="' + st.dash + '"/></svg>';
}
/* which modes have results, and the fillers solved */
function atlasAvail(rows) {
  var fill = {}, th = 0, fl = 0;
  rows.forEach(function (r) {
    var T = r.res.thermal; if (T && T.byFiller) { th++; for (var f in T.byFiller) fill[f] = 1; }
    if (r.res.flow && !r.res.flow.error) fl++;
  });
  return { stiffness: rows.length, thermal: th, flow: fl, fillers: atlasFillerIds().filter(function (f) { return fill[f]; }) };
}
function atlasFocusFiller(av) {
  if (!av.fillers.length) return null;
  if (av.fillers.indexOf(ATLAS.focus) < 0) ATLAS.focus = av.fillers.indexOf('water') >= 0 ? 'water' : av.fillers[0];
  return ATLAS.focus;
}
function atlasSetPhys(p) { ATLAS.phys = p; ATLAS._ctlSig = null; ATLAS._s3Sig = null; atlasUpdate(); }
function atlasSetFocus(f) { ATLAS.focus = f; ATLAS._ctlSig = null; ATLAS._s3Sig = null; atlasUpdate(); }
function atlasModes(av) {
  var el = swEl('atModes'); if (!el) return;
  if (!av[ATLAS.phys]) ATLAS.phys = 'stiffness';
  var sig = ATLAS.phys + '#' + av.thermal + '#' + av.flow + '#' + av.stiffness;
  if (el._sig === sig) return;
  el._sig = sig;
  el.innerHTML = ATLAS_PHYS.map(function (m) {
    var n = av[m.id], tip = n ? m.label + ' results for ' + n + ' run' + (n > 1 ? 's' : '') : 'No run in this sweep has ' + m.label.toLowerCase() + ' results — turn ' + m.label.toLowerCase() + ' on in the sweep’s run settings';
    return '<button role="tab" aria-pressed="' + (ATLAS.phys === m.id) + '"' + (n ? '' : ' disabled') + ' title="' + swEsc(tip) + '" onclick="atlasSetPhys(\'' + m.id + '\')">' +
      '<span class="ico">' + (typeof labIconSvg === 'function' ? labIconSvg(m.icon) : '') + '</span><span class="lbl">' + m.label + '</span><span class="cnt">' + n + '</span></button>';
  }).join('');
}

/* metric catalogue: { k, label, unit, phys: stiffness | thermal | flow | geo, stiff } */
function atlasMetricDefs() {
  var out = [
    { k: 'class', label: 'Connectivity', phys: 'stiffness', only: 'map' },
    { k: 'max', label: 'Stiffest axis', phys: 'stiffness', stiff: 1 }, { k: 'min', label: 'Softest axis', phys: 'stiffness', stiff: 1 },
    { k: 'mean', label: 'Mean of Ex, Ey, Ez', phys: 'stiffness', stiff: 1 },
    { k: 'Ex', label: 'Ex', phys: 'stiffness', stiff: 1 }, { k: 'Ey', label: 'Ey', phys: 'stiffness', stiff: 1 }, { k: 'Ez', label: 'Ez', phys: 'stiffness', stiff: 1 },
    { k: 'xyz', label: 'Ex, Ey, Ez together', phys: 'stiffness', stiff: 1, only: 's3' },
    { k: 'Gyz', label: 'Gyz', phys: 'stiffness', stiff: 1 }, { k: 'Gxz', label: 'Gxz', phys: 'stiffness', stiff: 1 }, { k: 'Gxy', label: 'Gxy', phys: 'stiffness', stiff: 1 }
  ];
  atlasFillerIds().forEach(function (f) { out.push({ k: 'k_' + f, label: 'Conductivity · ' + atlasFillerLabel(f).toLowerCase(), unit: 'W/m·K', phys: 'thermal', filler: f }); });
  atlasFillerIds().forEach(function (f) { out.push({ k: 'eff_' + f, label: 'Thermal efficiency · ' + atlasFillerLabel(f).toLowerCase(), unit: 'of HS upper', phys: 'thermal', filler: f }); });
  atlasFillerIds().forEach(function (f) { out.push({ k: 'alpha_' + f, label: 'Diffusivity · ' + atlasFillerLabel(f).toLowerCase(), unit: 'mm²/s', phys: 'thermal', filler: f }); });
  out.push(
    { k: 'perm', label: 'Permeability · mean of open axes', unit: '×10⁻⁹ m²', phys: 'flow' },
    { k: 'perm_x', label: 'Permeability X', unit: '×10⁻⁹ m²', phys: 'flow' }, { k: 'perm_y', label: 'Permeability Y', unit: '×10⁻⁹ m²', phys: 'flow' },
    { k: 'perm_z', label: 'Permeability Z', unit: '×10⁻⁹ m²', phys: 'flow' },
    { k: 'kL2', label: 'Permeability ÷ cell²', unit: 'k/L²', phys: 'flow' }, { k: 'tort', label: 'Tortuosity · mean', unit: '', phys: 'flow' },
    { k: 'wss_med', label: 'Median wall shear', unit: 'mPa per mm/s', phys: 'flow' }, { k: 'wall_target', label: 'Wall at shear target', unit: '%', phys: 'flow' },
    { k: 'vf', label: 'Solid fraction', unit: '%', phys: 'geo', pct: 1 }, { k: 'porosity', label: 'Porosity', unit: '%', phys: 'geo', pct: 1 },
    { k: 'sad', label: 'Surface area density', unit: 'm²/m³', phys: 'geo' }, { k: 'dh', label: 'Hydraulic diameter', unit: 'mm', phys: 'geo' });
  return out;
}
var _ATLAS_DEFS = null;
function atlasDef(k) {
  if (!_ATLAS_DEFS) { _ATLAS_DEFS = {}; atlasMetricDefs().forEach(function (d) { _ATLAS_DEFS[d.k] = d; }); }
  return _ATLAS_DEFS[k] || { k: k, label: k, unit: '', phys: 'geo' };
}
function atlasMetricVal(r, k) {
  switch (k) {
    case 'max': return Math.max(r.Ex, r.Ey, r.Ez);
    case 'min': return Math.min(r.Ex, r.Ey, r.Ez);
    case 'mean': return (r.Ex + r.Ey + r.Ez) / 3;
    case 'z': return r.Ez;
    case 'class': return r.cls;
    default: return r[k];
  }
}
function atlasUnit(k) { var d = atlasDef(k); return d.stiff ? (atlasEs() ? 'MPa' : '÷ E solid') : (d.unit || ''); }
function atlasFmtMetric(k, v) {
  var d = atlasDef(k);
  if (v == null || !isFinite(v)) return '—';
  if (d.stiff) return atlasFmtE(v);
  if (d.pct) return atlasPct(v);
  return atlasFmt4(v);
}
/* axis tick labels: no trailing zeros (2, 0.5, 75 — not 2.00, 0.500, 75.0) */
function atlasFmtTick(k, v) {
  var d = atlasDef(k);
  if (v == null || !isFinite(v)) return '';
  if (d.stiff && atlasEs()) return atlasFmtE(v);
  if (d.pct) return atlasPct(v);
  var a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(1) : String(+v.toPrecision(3));
}
/* the metric list a panel offers in the current mode; non-stiffness metrics only when some run has them */
function atlasMetricList(purpose, rows) {
  var p = ATLAS.phys, defs = atlasMetricDefs();
  return defs.filter(function (d) {
    if (d.only && d.only !== purpose) return false;
    if (purpose === 'sc') { if (!(d.phys === p || d.phys === 'geo' || (d.stiff && d.k !== 'xyz'))) return false; }
    else if (!(d.phys === p || d.phys === 'geo')) return false;
    if (d.stiff || d.k === 'class' || d.k === 'vf') return true;
    return rows.some(function (r) { var v = atlasMetricVal(r, d.k); return v != null && isFinite(v); });
  });
}
function atlasPickKey(store, list, def) {
  var have = function (k) { return list.some(function (d) { return d.k === k; }); };
  var k = ATLAS[store][ATLAS.phys];
  if (k && have(k)) return k;
  k = (def || '').replace('*', ATLAS.focus || 'water');
  if (!have(k)) k = list.length ? list[0].k : 'max';
  ATLAS[store][ATLAS.phys] = k;
  return k;
}

/* fitted value axis: the data range padded; log when asked, or (auto) when
   the data spans more than about a decade.  Ticks in transformed space. */
function atlasFitAxis(vals, scale, n) {
  var v = vals.filter(function (x) { return x != null && isFinite(x); });
  if (!v.length) v = [0, 1];
  var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), pos = v.filter(function (x) { return x > 0; });
  var useLog = (scale === 'log' || (scale === 'auto' && lo > 0 && hi / lo > 12)) && pos.length > 0;
  if (useLog) {
    var plo = Math.min.apply(null, pos), l0 = Math.log10(plo), l1 = Math.log10(hi);
    if (!(l1 > l0)) { l0 -= 0.15; l1 += 0.15; }
    var pad = Math.max(0.03, (l1 - l0) * 0.06); l0 -= pad; l1 += pad;
    var ticks = [];
    for (var d = Math.floor(l0); d <= Math.ceil(l1); d++) [1, 2, 5].forEach(function (m) { var t = d + Math.log10(m); if (t >= l0 - 1e-9 && t <= l1 + 1e-9) ticks.push(t); });
    if (ticks.length > 8) ticks = ticks.filter(function (t) { return Math.abs(t - Math.round(t)) < 1e-9; });
    if (ticks.length < 2) ticks = atlasNiceTicks(Math.pow(10, l0), Math.pow(10, l1), 4).filter(function (x) { return x > 0; }).map(function (x) { return Math.log10(x); });
    return { log: true, lo: l0, hi: l1, ticks: ticks, t: function (x) { return x > 0 ? Math.log10(x) : l0; } };
  }
  var span = (hi - lo) || Math.abs(hi) || 1, a = lo - span * 0.08, b = hi + span * 0.08;
  if (lo >= 0 && a < 0) a = 0;
  var tk = atlasNiceTicks(a, b, n || 5);
  return { log: false, lo: a, hi: b, ticks: tk, t: function (x) { return x; } };
}
/* run-level tensors for the directional views (3×3 row-major) */
function atlasThermalOf(r, f) { var T = r.res.thermal; return (T && T.byFiller && T.byFiller[f]) || null; }
function atlasThermalBounds(r, f) {
  var g = atlasThermalOf(r, f), T = r.res.thermal;
  if (!g) return null;
  if (g.hsUp != null && g.hsLo != null) return [g.hsLo, g.hsUp];
  var fl = (typeof thermalFillerById === 'function') ? thermalFillerById(f) : null;
  if (!fl || !(T.kS > 0) || typeof thermalHSUpper !== 'function') return null;
  var phi = T.rhoPhi != null ? T.rhoPhi : r.vf;
  return [thermalHSLower(phi, T.kS, fl.k), thermalHSUpper(phi, T.kS, fl.k)];
}
function atlasTensor(r) {
  if (ATLAS.phys === 'thermal') {
    var g = atlasThermalOf(r, ATLAS.focus);
    if (!g) return null;
    return { K: g.K && g.K.length === 9 ? Array.prototype.slice.call(g.K) : [g.kx, 0, 0, 0, g.ky, 0, 0, 0, g.kz], unit: 'W/m·K', full: !!(g.K && g.K.length === 9) };
  }
  if (ATLAS.phys === 'flow') {
    var F = r.res.flow;
    if (!F || F.error) return null;
    var cell = sweepCellMm(sweepRecipeForRun(r.run)), s = cell * cell * 1e-6 * 1e9, open = F.open || [];
    var K = F.Kl2 && F.Kl2.length === 9 ? F.Kl2.map(function (v) { return v * s; }) : [F.kL2[0] * s, 0, 0, 0, F.kL2[1] * s, 0, 0, 0, F.kL2[2] * s];
    return { K: K, unit: '×10⁻⁹ m²', full: !!F.Kl2, allOpen: open[0] && open[1] && open[2] };
  }
  return null;
}
/* n·K·n over a dense sphere: largest and smallest, and the direction of the largest */
function atlasTensorRange(K) {
  var NF = 2000, mx = -Infinity, mn = Infinity, dir = null;
  for (var i = 0; i < NF; i++) {
    var z = 1 - (i + 0.5) / NF, rr = Math.sqrt(1 - z * z), ph = i * 2.399963229728653, n = [rr * Math.cos(ph), rr * Math.sin(ph), z], v = 0;
    for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) v += n[a] * K[a * 3 + b] * n[b];
    if (v > mx) { mx = v; dir = n; } if (v < mn) mn = v;
  }
  return { max: mx, min: mn, dir: dir };
}
function atlasAxisName(n) {
  var a = n.map(Math.abs), i = a.indexOf(Math.max.apply(null, a));
  return a[i] > 0.9 ? 'XYZ'[i] : '[' + n.map(function (v) { return v.toFixed(2); }).join(', ') + ']';
}
/* drawn icons for the Atlas buttons and checks (no glyphs) */
var ATLAS_ICON = {
  close: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  link: '<svg viewBox="0 0 16 10" width="15" height="10" aria-hidden="true"><rect x="1" y="2" width="7" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="8" y="2" width="7" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  unlink: '<svg viewBox="0 0 16 10" width="15" height="10" aria-hidden="true"><rect x="0.8" y="2" width="6" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9.2" y="2" width="6" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  home: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1.5 6 L6 2 L10.5 6 M3 5 V10 H9 V5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  pass: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 6.3 L5 8.6 L9.6 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flag: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 2.2 V6.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="6" cy="9.4" r="1" fill="currentColor"/></svg>',
  note: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><circle cx="6" cy="2.9" r="1" fill="currentColor"/><path d="M6 5.4 V9.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
};


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
    /* v0.23.0 — geometry and thermal metrics (missing values leave holes) */
    var row = rows[rows.length - 1], G = r.geom, T = r.thermal;
    if (G) { row.porosity = G.porosity; row.sad = G.sad_m2m3; row.dh = G.dh_mm; }
    if (T && T.byFiller) for (var tf in T.byFiller) {
      row['k_' + tf] = T.byFiller[tf].kMean; row['eff_' + tf] = T.byFiller[tf].eff;
      if (T.byFiller[tf].alpha != null) row['alpha_' + tf] = T.byFiller[tf].alpha * 1e6;   /* v0.33.0 — mm²/s */
    }
    /* v0.32.0 — flow metrics (Configure flow grid); shear under the current Flow settings */
    var F = r.flow;
    if (!(row.porosity != null)) row.porosity = 1 - row.vf;
    if (F && !F.error) {
      var cell = sweepCellMm(sweepRecipeForRun(run)), L2 = cell * cell * 1e-6, op = [0, 1, 2].filter(function (a) { return F.open[a] && F.kL2[a] > 0; });
      var kxyz = [0, 1, 2].map(function (a) { return F.open[a] ? F.kL2[a] : 0; });
      row.perm_x = kxyz[0] * L2 * 1e9; row.perm_y = kxyz[1] * L2 * 1e9; row.perm_z = kxyz[2] * L2 * 1e9;
      row.perm = op.length ? op.reduce(function (s0, a) { return s0 + kxyz[a]; }, 0) / op.length * L2 * 1e9 : 0;
      row.kL2 = op.length ? op.reduce(function (s0, a) { return s0 + kxyz[a]; }, 0) / op.length : 0;
      var tt = op.map(function (a) { return F.tort[a]; }).filter(isFinite);
      row.tort = tt.length ? tt.reduce(function (s0, v) { return s0 + v; }, 0) / tt.length : null;
      var sh = (typeof sweepFlowShear === 'function') ? sweepFlowShear(run, F) : null;
      if (sh && sh.pick) {
        var stA = sh.byAxis[sh.pick.axis];
        if (stA) row.wss_med = stA.median;            /* Pa per m/s = mPa per mm/s */
        if (sh.cfg.target && sh.pick.stats) row.wall_target = (sh.pick.stats.inTarget || 0) * 100;
      }
    }
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
      '<header class="at-top"><div class="at-tblk"><div class="at-title">Sweep Atlas <span class="at-ver">' + swEsc(typeof sweepTitle === 'function' ? sweepTitle() : (SWEEP_STATE.name || '')) + '</span></div>' +
        '<div class="at-meta" id="atMeta"></div></div>' +
        '<div class="at-modes" id="atModes" role="tablist" aria-label="Physics"></div>' +
        '<button class="dc-icon-btn at-close" title="Close" onclick="closeSweepAtlas()">' + ATLAS_ICON.close + '</button></header>' +
      '<div class="at-controls" id="atControls"></div>' +
      '<div class="at-grid2">' +
        '<section class="at-panel"><div class="at-phead"><h3>Cell geometry</h3><div class="at-hbtns"><div class="at-seg" id="atTiles"></div>' + atlasViewBtns('Geo') + '</div></div>' +
          '<div class="at-view" id="atGeo"><svg class="at-triad" id="atTriadGeo" width="48" height="48"></svg></div><div class="at-sub" id="atGeoInfo"></div></section>' +
        '<section class="at-panel"><div class="at-phead"><h3 id="atSurfTitle">Directional Young’s modulus</h3><div class="at-hbtns">' + atlasViewBtns('Surf') + '</div></div>' +
          '<div class="at-view" id="atSurf"><svg class="at-triad" id="atTriadSurf" width="48" height="48"></svg></div><div class="at-sub" id="atSurfInfo"></div></section>' +
      '</div>' +
      '<div class="at-hint">Drag to tumble · right-drag or shift-drag to pan · scroll to zoom · double-click for the home view</div>' +
      '<div class="at-grid2">' +
        '<section class="at-panel"><div id="atStatus" class="at-status"></div><div id="atReadout" class="at-readout"></div>' +
          '<div class="at-phead"><h3 id="atMatTitle">Stiffness matrix</h3><span class="at-sub" id="atMatSub"></span></div>' +
          '<div class="at-mwrap" id="atMatWrap"></div><div class="at-sub" id="atSolve"></div></section>' +
        '<section class="at-panel"><div class="at-phead"><h3 id="atMapTitle">Parameter map</h3><div id="atMapCtl"></div></div><div id="atMap"></div><div class="at-legend" id="atMapLegend"></div></section>' +
      '</div>' +
      '<section class="at-panel" id="atS3Panel" hidden><div class="at-phead"><h3 id="atS3Title">Stiffness surface</h3><div class="at-hbtns" id="atS3Ctl"></div></div>' +
        '<div class="at-sub" id="atS3Sub"></div><div class="at-s3" id="atS3"><canvas id="atS3c"></canvas></div></section>' +
      '<section class="at-panel"><div class="at-phead"><h3 id="atLineTitle">Stiffness vs solid fraction</h3><div class="at-hbtns" id="atLineCtl"></div></div>' +
        '<div class="at-sub" id="atLineSub"></div><div id="atLine" class="at-chart"></div><div class="at-legend" id="atLineLegend"></div></section>' +
      '<section class="at-panel"><div class="at-phead"><h3>Design space</h3><div class="at-hbtns" id="atScatterCtl"></div></div>' +
        '<div class="at-sub" id="atScatterSub"></div>' +
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
  return '<div class="at-seg"><button class="at-link" aria-pressed="true" onclick="atlasToggleLink()" title="Turn the geometry and the directional surface together">' + ATLAS_ICON.link + '<span>linked</span></button>' +
    '<button onclick="ATLAS.cam' + which + ' && ATLAS.cam' + which + '.reset()" title="Home view (double-click the view)" aria-label="Home view">' + ATLAS_ICON.home + '</button></div>';
}
function atlasToggleLink() {
  ATLAS.link = !ATLAS.link;
  if (ATLAS.link && ATLAS.camGeo && ATLAS.camSurf) { ATLAS.camSurf.Q = ATLAS.camGeo.Q.slice(); atlasApplySurfCam(); }
  atlasPaintLink();
}
function atlasPaintLink() {
  document.querySelectorAll('#atOverlay .at-link').forEach(function (b) {
    b.setAttribute('aria-pressed', String(ATLAS.link)); b.innerHTML = (ATLAS.link ? ATLAS_ICON.link : ATLAS_ICON.unlink) + '<span>' + (ATLAS.link ? 'linked' : 'unlinked') + '</span>';
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
  var av = atlasAvail(rows); ATLAS._av = av;
  atlasFocusFiller(av);
  atlasModes(av);   /* v0.33.0 — falls back to Stiffness when the mode has no results */
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
  var res = rows.map(function (r) { return r.res; }), total = SWEEP_STATE.runs.length, av = ATLAS._av || atlasAvail(rows), txt;
  if (ATLAS.phys === 'thermal') {
    var T0 = null; res.some(function (r) { if (r.thermal && r.thermal.byFiller) { T0 = r.thermal; return true; } return false; });
    txt = rows.length + ' of ' + total + ' runs solved · thermal on ' + av.thermal + ' · fillers ' + av.fillers.map(atlasFillerLabel).join(', ').toLowerCase() +
      (T0 ? ' · ' + T0.material + ' · k solid ' + atlasFmt4(T0.kS) + ' W/m·K' + (T0.basis ? ' (' + T0.basis + ')' : '') : '');
  } else if (ATLAS.phys === 'flow') {
    var fg = {}; res.forEach(function (r) { if (r.flow && !r.flow.error) fg[r.flow.N] = 1; });
    var cfg = (typeof flowShearConfig === 'function') ? flowShearConfig(null) : null, fl = (typeof flowFluid === 'function') ? flowFluid() : null;
    txt = rows.length + ' of ' + total + ' runs solved · flow on ' + av.flow + ' · flow grid ' + Object.keys(fg).map(function (n) { return n + '³'; }).join(' / ') +
      (fl ? ' · ' + fl.name : '') + (cfg && cfg.targetInfo ? ' · shear target ' + cfg.targetInfo.label : ' · no shear target');
  } else {
    var grids = {}, voids = {}, tol = {};
    res.forEach(function (r) { grids[r.N] = 1; if (r.companion) grids[r.companion.N] = 1; voids[r.voidRatio != null ? r.voidRatio : 1e-4] = 1; tol[r.tol] = 1; });
    txt = rows.length + ' of ' + total + ' runs solved · grid ' + Object.keys(grids).join(' / ') +
      ' · void ' + Object.keys(voids).map(function (v) { return (+v).toExponential(0); }).join(' / ') +
      ' · CG ' + Object.keys(tol).map(function (v) { return (+v).toExponential(0); }).join(' / ') +
      ' · islands ' + (res[0] && res[0].connectivity || 'networks');
  }
  swEl('atMeta').textContent = txt;
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
  var av = ATLAS._av || atlasAvail(rows);
  var sig = [S.order.join('|'), ATLAS.series, series.length, hasExt, ATLAS.mode, ATLAS.units, m ? m.name : '', ATLAS.phys, ATLAS.focus, av.fillers.join(',')].join('#');
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
  if (ATLAS.phys === 'stiffness') {
    if (hasExt) h += '<div class="at-ctl"><span class="at-lab">Values</span><div class="at-seg">' +
      '<button aria-pressed="' + (ATLAS.mode === 'grid') + '" onclick="atlasSet(\'mode\',\'grid\')">run grid</button>' +
      '<button aria-pressed="' + (ATLAS.mode === 'ext') + '" onclick="atlasSet(\'mode\',\'ext\')">extrapolated</button></div></div>';
    h += '<div class="at-ctl"><span class="at-lab">Stiffness as</span><div class="at-seg">' +
      '<button aria-pressed="' + (ATLAS.units === 'norm') + '" onclick="atlasSet(\'units\',\'norm\')">÷ E solid</button>' +
      (m ? '<button aria-pressed="' + (ATLAS.units === 'mat') + '" onclick="atlasSet(\'units\',\'mat\')" title="The material picked in the run controls, or the design’s own material">' + swEsc(m.name) + '</button>' : '') + '</div></div>';
  } else if (ATLAS.phys === 'thermal') {
    /* v0.33.0 — every filler is drawn; the focused one gets its bounds, tensor and directional view */
    h += '<div class="at-ctl"><span class="at-lab">Pore filler</span><div class="at-seg">' + av.fillers.map(function (fid) {
      return '<button aria-pressed="' + (ATLAS.focus === fid) + '" onclick="atlasSetFocus(\'' + fid + '\')" title="All fillers are drawn; the focused one also gets its bounds, tensor and directional view">' + atlasFillerSw(fid) + atlasFillerLabel(fid) + '</button>';
    }).join('') + '</div></div>';
  } else {
    var cfg = (typeof flowShearConfig === 'function') ? flowShearConfig(null) : null, fl = (typeof flowFluid === 'function') ? flowFluid() : null;
    h += '<div class="at-ctl"><span class="at-lab">Flow settings</span><span class="at-sub" title="Set in Configure → Flow. Changing them updates the Atlas and the export without a re-solve.">' +
      swEsc((fl ? fl.name : 'fluid') + ' · ' + (cfg && cfg.targetInfo ? 'shear target ' + cfg.targetInfo.label + ' (' + cfg.targetInfo.note + ')' : 'no shear target') +
      ' · direction ' + (cfg ? ({ all: 'best', xx: 'X', yy: 'Y', zz: 'Z' }[cfg.dir] || cfg.dir) : 'best')) + '</span></div>';
  }
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
  var info = swEl('atSurfInfo'), title = swEl('atSurfTitle');
  if (ATLAS.phys !== 'stiffness') {   /* v0.33.0 — κ(n) / K(n) = n · K · n, drawn by the same viewer as on the cards */
    var th = ATLAS.phys === 'thermal';
    if (title) title.innerHTML = th ? 'Directional conductivity κ(n) <span class="at-tag">' + swEsc(atlasFillerLabel(ATLAS.focus).toLowerCase()) + '</span>' : 'Directional permeability K(n)';
    var T = atlasTensor(cur);
    if (!T) { if (ATLAS.sv) ATLAS.sv.uploadDesign(null); info.textContent = th ? 'No thermal result for this run.' : 'No flow result for this run.'; return; }
    if (!th && !T.allOpen) {
      if (ATLAS.sv) ATLAS.sv.uploadDesign(null);
      var F = cur.res.flow, closed = [0, 1, 2].filter(function (a) { return !F.open[a]; }).map(function (a) { return 'XYZ'[a]; });
      info.textContent = 'K(n) needs flow along all three axes; this run has no open pore path along ' + closed.join(', ') + '.';
      return;
    }
    if (ATLAS.sv) ATLAS.sv.uploadDesign(typeof kappaAsCompliance === 'function' ? kappaAsCompliance(T.K) : null);
    var rg = atlasTensorRange(T.K);
    info.textContent = (th ? 'κ' : 'K') + ' max ' + atlasFmt4(rg.max) + ' along ' + atlasAxisName(rg.dir) + ' · min ' + atlasFmt4(rg.min) + ' ' + T.unit +
      ' · max / min ' + (rg.min > 0 ? (rg.max / rg.min).toFixed(2) : '—') + (T.full ? '' : ' · from X / Y / Z only (re-run the sweep for the full tensor)');
    return;
  }
  if (title) title.textContent = 'Directional Young’s modulus';
  var S = atlasCompliance(cur.C);
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
  if (ATLAS.phys === 'thermal') return atlasReadoutThermal(cur);
  if (ATLAS.phys === 'flow') return atlasReadoutFlow(cur);
  swEl('atMatTitle').textContent = 'Stiffness matrix';
  swEl('atMatSub').innerHTML = '<span class="at-divramp"></span> − · 0 · +';
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
  swEl('atMatWrap').innerHTML = '<table class="at-mat">' + th + '</table>';
  swEl('atSolve').textContent = 'N = ' + r.N + (r.companion ? ' (+ N = ' + r.companion.N + ')' : '') + ' · ' + r.iters + ' CG iterations · residual ' +
    (r.residual != null ? r.residual.toExponential(1) : '—') + ' · void ' + (r.voidRatio != null ? r.voidRatio : 1e-4).toExponential(0) + ' · ' + sweepFmtDur(r.wall_s) +
    ' · ' + (m ? 'matrix in MPa / GPa (' + m.name + ')' : 'matrix in units of E solid');
}
/* v0.33.0 — readouts for the thermal and flow modes */
function atlasRoCell(k, v, col, unit) {
  return '<div class="at-ro"><span class="k">' + (col ? '<span class="at-sw" style="background:' + col + '"></span>' : '') + k + '</span><span class="v">' + v + (unit ? '<span class="u">' + unit + '</span>' : '') + '</span></div>';
}
function atlasTensorTable(K, labs) {
  var amax = 0; K.forEach(function (v) { amax = Math.max(amax, Math.abs(v)); });
  var h = '<table class="at-mat at-mat3"><tr><th></th>' + labs.map(function (l) { return '<th>' + l + '</th>'; }).join('') + '</tr>';
  for (var i = 0; i < 3; i++) {
    h += '<tr><th>' + labs[i] + '</th>';
    for (var j = 0; j < 3; j++) {
      var v = K[i * 3 + j], t = amax ? v / amax : 0, tiny = Math.abs(v) < 1e-6 * amax;
      h += '<td class="' + (j < i ? 'lo' : '') + '" style="background:' + atlasDiv(t) + ';color:' + (Math.abs(t) < 0.55 ? ATLAS_COL.ink : '#06080f') + '" title="' + v.toExponential(3) + '">' + (tiny ? '0' : atlasFmt4(v)) + '</td>';
    }
    h += '</tr>';
  }
  return h + '</table>';
}
function atlasReadoutThermal(cur) {
  var r = cur.res, T = r.thermal, f = ATLAS.focus, g = atlasThermalOf(cur, f), av = ATLAS._av || { fillers: [] };
  var h = '<span class="at-pill">' + atlasFillerSw(f) + 'pores filled with ' + swEsc(atlasFillerLabel(f).toLowerCase()) + '</span><span class="at-sub">' + swEsc(cur.run.id) + ' · ' + swEsc(cur.run.purpose || '') + '</span>';
  swEl('atMatTitle').innerHTML = 'Conductivity tensor <span class="at-tag">' + swEsc(atlasFillerLabel(f).toLowerCase()) + '</span>';
  swEl('atMatSub').textContent = 'W/m·K';
  if (!g) {
    swEl('atStatus').innerHTML = h + (T && T.error ? '<span class="at-pill warn" title="' + swEsc(T.error) + '">thermal not computed</span>' : '');
    swEl('atReadout').innerHTML = ''; swEl('atMatWrap').innerHTML = '<div class="at-sub">No thermal result for this run.</div>'; swEl('atSolve').textContent = ''; return;
  }
  if (T.underResolved) h += '<span class="at-pill warn" title="More than 5 % of the solid sits in fragments under 3³ voxels, which the island trim drops — raise the grid">under-resolved</span>';
  if (!g.converged) h += '<span class="at-pill warn">not converged</span>';
  swEl('atStatus').innerHTML = h;
  swEl('atReadout').innerHTML = atlasRoCell('κx', atlasFmt4(g.kx), ATLAS_COL.ax[0], 'W/m·K') + atlasRoCell('κy', atlasFmt4(g.ky), ATLAS_COL.ax[1], 'W/m·K') + atlasRoCell('κz', atlasFmt4(g.kz), ATLAS_COL.ax[2], 'W/m·K') +
    atlasRoCell('κ mean', atlasFmt4(g.kMean), null, 'W/m·K') + atlasRoCell('κ ÷ κ solid', atlasFmt4(g.kRel)) + atlasRoCell('Efficiency', atlasFmt4(g.eff), null, 'of HS upper') +
    atlasRoCell('ρc', g.rhoc != null ? atlasFmt4(g.rhoc / 1e6) : '—', null, 'MJ/m³·K') + atlasRoCell('Diffusivity', g.alpha != null ? atlasFmt4(g.alpha * 1e6) : '—', null, 'mm²/s');
  var Tt = atlasTensor(cur), tab = '<table class="at-tab"><tr><th>Filler</th><th>κ mean</th><th>κ ÷ κ solid</th><th>Efficiency</th><th>ρc MJ/m³·K</th><th>α mm²/s</th></tr>';
  av.fillers.forEach(function (fid) {
    var q = atlasThermalOf(cur, fid); if (!q) return;
    tab += '<tr class="' + (fid === f ? 'on' : '') + '" onclick="atlasSetFocus(\'' + fid + '\')"><td>' + atlasFillerSw(fid, 16) + atlasFillerLabel(fid) + '</td><td>' + atlasFmt4(q.kMean) + '</td><td>' + atlasFmt4(q.kRel) + '</td><td>' + atlasFmt4(q.eff) +
      '</td><td>' + (q.rhoc != null ? atlasFmt4(q.rhoc / 1e6) : '—') + '</td><td>' + (q.alpha != null ? atlasFmt4(q.alpha * 1e6) : '—') + '</td></tr>';
  });
  swEl('atMatWrap').innerHTML = atlasTensorTable(Tt.K, ['x', 'y', 'z']) + tab + '</table>';
  swEl('atSolve').textContent = 'N = ' + r.N + ' · ' + (T.material || '') + ' · k solid ' + atlasFmt4(T.kS) + ' W/m·K' + (T.basis ? ' (' + T.basis + ')' : '') +
    ' · iterations ' + g.iters + ' · ' + sweepFmtDur(T.wall_s || 0) + (Tt.full ? '' : ' · tensor from X / Y / Z only');
}
function atlasReadoutFlow(cur) {
  var r = cur.res, F = r.flow, h = '<span class="at-sub">' + swEsc(cur.run.id) + ' · ' + swEsc(cur.run.purpose || '') + '</span>';
  swEl('atMatTitle').textContent = 'Permeability tensor';
  if (!F || F.error) {
    swEl('atStatus').innerHTML = h + (F && F.error ? '<span class="at-pill warn" title="' + swEsc(F.error) + '">flow not computed</span>' : '');
    swEl('atMatSub').textContent = ''; swEl('atReadout').innerHTML = ''; swEl('atMatWrap').innerHTML = '<div class="at-sub">No flow result for this run.</div>'; swEl('atSolve').textContent = ''; return;
  }
  var cell = sweepCellMm(sweepRecipeForRun(cur.run)), permMin = (typeof FLOW_THROAT_PERM !== 'undefined') ? FLOW_THROAT_PERM : 8, wssMin = (typeof FLOW_THROAT_WSS !== 'undefined') ? FLOW_THROAT_WSS : 15;
  var closed = [0, 1, 2].filter(function (a) { return !F.open[a]; }), unc = [0, 1, 2].filter(function (a) { return F.open[a] && !F.converged[a]; });
  var fw = (typeof FLOW_FORCE_WARN !== 'undefined') ? FLOW_FORCE_WARN : 0.05, fb = [0, 1, 2].filter(function (a) { return F.residual && F.residual[a] != null && Math.abs(F.residual[a]) > fw; });
  if (F.throatVox != null && F.throatVox < permMin) h += '<span class="at-pill warn" title="Narrowest pore ' + F.throatVox.toFixed(1) + ' voxels at ' + F.N + '³; permeability wants ' + permMin + '+">coarse for permeability</span>';
  else if (F.throatVox != null && F.throatVox < wssMin) h += '<span class="at-pill warn" title="Narrowest pore ' + F.throatVox.toFixed(1) + ' voxels at ' + F.N + '³; wall shear wants ' + wssMin + '+">coarse for wall shear</span>';
  if (closed.length) h += '<span class="at-pill warn">no flow along ' + closed.map(function (a) { return 'XYZ'[a]; }).join(', ') + '</span>';
  if (unc.length) h += '<span class="at-pill warn">not converged along ' + unc.map(function (a) { return 'XYZ'[a]; }).join(', ') + '</span>';
  if (fb.length) h += '<span class="at-pill warn" title="Wall force against the driving force; wall shear is approximate">force balance off along ' + fb.map(function (a) { return 'XYZ'[a]; }).join(', ') + '</span>';
  swEl('atStatus').innerHTML = h;
  var Tt = atlasTensor(cur), K = Tt.K, op = [0, 1, 2].filter(function (a) { return F.open[a]; });
  var kl = op.length ? op.reduce(function (s, a) { return s + F.kL2[a]; }, 0) / op.length : 0;
  var tt = op.map(function (a) { return F.tort[a]; }).filter(isFinite), tm = tt.length ? tt.reduce(function (s, v) { return s + v; }, 0) / tt.length : null;
  swEl('atMatSub').textContent = '×10⁻⁹ m² at the ' + sweepFmtVal(cell) + ' mm cell · k/L² ' + atlasFmt4(kl);
  swEl('atReadout').innerHTML = atlasRoCell('Kx', atlasFmt4(K[0]), ATLAS_COL.ax[0], '×10⁻⁹ m²') + atlasRoCell('Ky', atlasFmt4(K[4]), ATLAS_COL.ax[1], '×10⁻⁹ m²') + atlasRoCell('Kz', atlasFmt4(K[8]), ATLAS_COL.ax[2], '×10⁻⁹ m²') +
    atlasRoCell('Tortuosity', tm != null ? tm.toFixed(2) : '—', null, 'mean') + atlasRoCell('Open porosity', atlasPct(F.openPorosity)) +
    atlasRoCell('Sealed pores', atlasPct(F.sealedPorosity || 0)) +
    atlasRoCell('Narrowest pore', F.throatVox != null ? Math.round(F.throatVox / F.N * cell * 1000).toLocaleString('en-US') : '—', null, 'µm') +
    atlasRoCell('Median pore', F.medPoreVox != null ? Math.round(F.medPoreVox / F.N * cell * 1000).toLocaleString('en-US') : '—', null, 'µm');
  var sh = (typeof sweepFlowShear === 'function') ? sweepFlowShear(cur.run, F) : null, tab = '';
  if (sh) {
    var cellV = function (st, k) { return st ? atlasFmt4(st[k]) : '—'; };
    tab = '<table class="at-tab"><tr><th>Wall shear (mPa per mm/s)</th><th>X</th><th>Y</th><th>Z</th></tr>' +
      '<tr><td>Median</td><td>' + cellV(sh.byAxis[0], 'median') + '</td><td>' + cellV(sh.byAxis[1], 'median') + '</td><td>' + cellV(sh.byAxis[2], 'median') + '</td></tr>' +
      '<tr><td>95th percentile</td><td>' + cellV(sh.byAxis[0], 'p95') + '</td><td>' + cellV(sh.byAxis[1], 'p95') + '</td><td>' + cellV(sh.byAxis[2], 'p95') + '</td></tr>';
    if (sh.cfg.targetInfo && sh.pick && sh.pick.stats) {
      var ps = sh.pick.stats;
      tab += '<tr class="on"><td>At target · ' + 'XYZ'[sh.pick.axis] + (sh.pick.best ? ' (best)' : '') + '</td><td colspan="3">' +
        (ps.inTarget > 0 ? atlasFmt4(ps.inTarget * 100) + ' % of wall at ' + atlasFmt4(ps.bestU * 1000) + ' mm/s · usable ' + atlasFmt4(ps.rangeLo * 1000) + '–' + atlasFmt4(ps.rangeHi * 1000) + ' mm/s' : 'no speed puts wall in ' + sh.cfg.targetInfo.label) + '</td></tr>';
    }
    tab += '</table>';
  }
  swEl('atMatWrap').innerHTML = (Tt.allOpen || op.length ? atlasTensorTable(K, ['x', 'y', 'z']) : '') + tab;
  swEl('atSolve').textContent = 'flow ' + F.N + '³ · steps ' + F.steps.map(function (v) { return v == null ? '—' : v.toLocaleString('en-US'); }).join(' / ') +
    (F.residual ? ' · force balance ' + F.residual.map(function (v) { return v == null ? '—' : (v * 100).toFixed(1) + ' %'; }).join(' / ') : '') + ' · ' + sweepFmtDur(F.wall_s || 0) +
    (Tt.full ? '' : ' · tensor from X / Y / Z only');
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
function atlasMapValue(r) { return atlasMetricVal(r, ATLAS._mapKey || 'class'); }
function atlasSetBy(store, v) { ATLAS[store][ATLAS.phys] = v; ATLAS._s3Sig = null; atlasUpdate(); }
/* v0.33.0 — the three columns a CSV-sweep run list shows in each mode */
function atlasRunCols() {
  if (ATLAS.phys === 'thermal') return ['x', 'y', 'z'].map(function (a, i) { return { h: 'κ' + a, col: ATLAS_COL.ax[i], v: function (r) { var g = atlasThermalOf(r, ATLAS.focus); return g ? atlasFmt4(g['k' + a]) : '—'; } }; });
  if (ATLAS.phys === 'flow') return ['x', 'y', 'z'].map(function (a, i) { return { h: 'K' + a, col: ATLAS_COL.ax[i], v: function (r) { return r['perm_' + a] != null ? atlasFmt4(r['perm_' + a]) : '—'; } }; });
  return ['Ex', 'Ey', 'Ez'].map(function (k, i) { return { h: k, col: ATLAS_COL.ax[i], v: function (r) { return atlasFmtE(r[k]); } }; });
}
function atlasMap(rows, cur) {
  var el = swEl('atMap'), ctl = swEl('atMapCtl'), leg = swEl('atMapLegend'), title = swEl('atMapTitle');
  var axes = SWEEP_STATE.axes;
  if (!axes) {
    /* CSV sweep: the current series as a clickable table */
    title.textContent = 'Runs in this series'; ctl.innerHTML = ''; leg.innerHTML = '';
    var list = (ATLAS._series.map[ATLAS.series] || []), rc = atlasRunCols();
    var hasP = list.some(function (r) { return r.run.param; });
    el.innerHTML = '<div class="at-rtwrap"><table class="at-rtab"><tr><th></th><th>Run</th>' + (hasP ? '<th>Parameter</th>' : '') + '<th>Solid</th>' +
      rc.map(function (c) { return '<th><span class="at-sw" style="background:' + c.col + '"></span>' + c.h + '</th>'; }).join('') + '<th>Purpose</th></tr>' +
      list.map(function (r) {
        return '<tr class="' + (r.run.id === cur.run.id ? 'cur' : '') + '" onclick="atlasSelect(\'' + r.run.id + '\')" title="' + swEsc(ATLAS_CLASS[r.cls]) + '">' +
          '<td><span class="at-dot" style="background:' + ATLAS_COL.cls[r.cls] + '"></span></td><td>' + swEsc(r.run.id) + '</td>' +
          (hasP ? '<td>' + (r.run.param ? swEsc(r.run.param.name + ' ' + sweepFmtVal(r.run.param.value)) : '') + '</td>' : '') +
          '<td>' + (r.vf * 100).toFixed(1) + ' %</td>' + rc.map(function (c) { return '<td>' + c.v(r) + '</td>'; }).join('') +
          '<td class="pu">' + swEsc(r.run.purpose || '') + '</td></tr>';
      }).join('') + '</table></div>';
    leg.innerHTML = ATLAS_CLASS.map(function (n, k) { return '<span class="at-lk"><span class="at-dot" style="background:' + ATLAS_COL.cls[k] + '"></span>' + n + '</span>'; }).join('');
    return;
  }
  title.textContent = 'Parameter map';
  var mlist = atlasMetricList('map', rows), key = atlasPickKey('mapBy', mlist, ATLAS.phys === 'stiffness' ? 'class' : ATLAS.phys === 'thermal' ? 'k_*' : 'perm');
  ATLAS._mapKey = key;
  ctl.innerHTML = '<select onchange="atlasSetBy(\'mapBy\', this.value)">' + mlist.map(function (o) {
    return '<option value="' + o.k + '"' + (key === o.k ? ' selected' : '') + '>' + swEsc(o.label) + (o.phys === 'geo' ? ' (geometry)' : '') + '</option>'; }).join('') + '</select>';
  var a1 = axes[0], a2 = axes[1], n1 = a1.values.length, n2 = a2 ? a2.values.length : 1;
  var byIJ = {}; rows.forEach(function (r) { if (r.run.grid) byIJ[r.run.grid[0] + ',' + r.run.grid[1]] = r; });
  var isCls = key === 'class', vals = rows.map(atlasMapValue).filter(function (v) { return v != null && isFinite(v); });
  var fit = isCls ? null : atlasFitAxis(vals, 'auto');
  function colOf(v) { if (v == null || !isFinite(v) || (fit.log && !(v > 0))) return '#1a1a2a'; return sweepSeqColor(0.6 * Math.max(0, Math.min(1, (fit.t(v) - fit.lo) / ((fit.hi - fit.lo) || 1)))); }
  var W = Math.max(280, swEl('atMap').clientWidth || 480), cw = Math.max(8, Math.min(64, Math.floor((W - 90) / n1))), ch = Math.max(10, Math.min(40, Math.floor(300 / n2)));
  var h = '<table class="at-mtab"><tr><th class="ax">' + swEsc(a2 ? a2.label : '') + '</th>';
  var every = Math.ceil(n1 / Math.max(1, Math.floor((W - 90) / 46)));
  for (var i = 0; i < n1; i++) h += '<th style="width:' + cw + 'px">' + (i % every === 0 ? swEsc(sweepFmtVal(a1.values[i]) + atlasAxSuffix(a1)) : '') + '</th>';
  h += '</tr>';
  var dk = atlasDef(key);
  for (var j = 0; j < n2; j++) {
    h += '<tr><th>' + (a2 ? swEsc(sweepFmtVal(a2.values[j])) : '') + '</th>';
    for (var i2 = 0; i2 < n1; i2++) {
      var r = byIJ[i2 + ',' + j], bg = 'transparent', tip = '', cls = 'empty';
      if (r) {
        var v = atlasMapValue(r); cls = r.run.id === cur.run.id ? 'cur' : '';
        bg = isCls ? ATLAS_COL.cls[v] : colOf(v);
        tip = r.run.id + ' · ' + ATLAS_CLASS[r.cls] + ' · ' + (r.vf * 100).toFixed(1) + ' % solid';
        if (!isCls) tip += ' · ' + dk.label + ' ' + atlasFmtMetric(key, v) + (atlasUnit(key) && !dk.pct ? ' ' + atlasUnit(key) : '');
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
  var lo = vals.length ? Math.min.apply(null, vals) : 0, hi = vals.length ? Math.max.apply(null, vals) : 0;
  leg.innerHTML = isCls
    ? ATLAS_CLASS.map(function (n, k) { return '<span class="at-lk"><span class="at-sw sq" style="background:' + ATLAS_COL.cls[k] + '"></span>' + n + '</span>'; }).join('') + '<span class="at-lk"><span class="at-sw sq cur"></span>current</span>'
    : '<span class="at-lk"><span class="at-ramp log"></span>' + atlasFmtMetric(key, lo) + ' → ' + atlasFmtMetric(key, hi) + (atlasUnit(key) && !dk.pct ? ' ' + swEsc(atlasUnit(key)) : '') + (fit.log ? ' (log)' : '') + '</span><span class="at-lk"><span class="at-sw sq cur"></span>current</span>';
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
    if (ax.log) {
      /* v0.33.0 — 1-2-5 ticks when the axis spans under ~2.5 decades */
      var fine = Math.log10(ax.max / ax.min) < 2.5;
      for (var e = Math.floor(Math.log10(ax.min)); e <= Math.ceil(Math.log10(ax.max)); e++) (fine ? [1, 2, 5] : [1]).forEach(function (mm) { var v = mm * Math.pow(10, e); if (v >= ax.min * 0.999 && v <= ax.max * 1.001) out.push(v); });
    }
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
  /* v0.33.0 — horizontal reference bands (y range), e.g. trabecular bone permeability */
  (opts.bands || []).forEach(function (b) {
    var y0 = Y(Math.max(b.lo, opts.y.min)), y1 = Y(Math.min(b.hi, opts.y.max));
    if (!(y0 > y1)) return;
    s += '<rect x="0" y="' + y1.toFixed(1) + '" width="' + iw + '" height="' + (y0 - y1).toFixed(1) + '" fill="' + b.color + '" opacity="0.11"/>' +
         '<line x1="0" x2="' + iw + '" y1="' + y1.toFixed(1) + '" y2="' + y1.toFixed(1) + '" stroke="' + b.color + '" stroke-opacity="0.35" stroke-dasharray="3 4"/>' +
         '<line x1="0" x2="' + iw + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '" stroke="' + b.color + '" stroke-opacity="0.35" stroke-dasharray="3 4"/>' +
         '<text x="' + (iw - 6) + '" y="' + (y1 + 13).toFixed(1) + '" text-anchor="end" fill="' + b.color + '" fill-opacity="0.85" font-size="10">' + swEsc(b.label) + '</text>';
  });
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
  if (ATLAS.phys === 'thermal') return atlasLineThermal(series, cur);
  if (ATLAS.phys === 'flow') return atlasLineFlow(series, cur);
  swEl('atLineTitle').textContent = 'Stiffness vs solid fraction'; swEl('atLineCtl').innerHTML = ''; swEl('atLineLegend').innerHTML = '';
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

/* v0.33.0 — conductivity vs solid fraction: every filler (style = filler), the
   focused filler's Hashin–Shtrikman bounds dotted, X / Y / Z spread as whiskers */
function atlasMarkTip(head, r, extra) { return '<b>' + head + '</b>' + (extra ? '<br>' + extra : '') + '<br>' + swEsc(r.run.id) + ' · ' + (r.vf * 100).toFixed(1) + ' % solid<br>' + swEsc(r.run.purpose || ''); }
function atlasLineThermal(series, cur) {
  var el = swEl('atLine'), W = Math.max(320, el.clientWidth || 800), av = ATLAS._av, f0 = ATLAS.focus;
  swEl('atLineTitle').textContent = 'Conductivity vs solid fraction'; swEl('atLineCtl').innerHTML = '';
  var lines = [], marks = [], all = [], xmax = 0, focusMarks = [];
  av.fillers.forEach(function (fid) {
    var st = ATLAS_FILLER_STYLE[fid] || { col: ATLAS_COL.ink2, dash: '' }, foc = fid === f0, pts = [], up = [], lw = [];
    series.forEach(function (r) {
      var g = atlasThermalOf(r, fid); if (!g) return;
      xmax = Math.max(xmax, r.vf); pts.push([r.vf, g.kMean]); all.push(g.kMean);
      var lo = Math.min(g.kx, g.ky, g.kz), hi = Math.max(g.kx, g.ky, g.kz);
      if (hi > lo * 1.005) lines.push({ pts: [[r.vf, lo], [r.vf, hi]], color: st.col, width: 1, opacity: foc ? 0.75 : 0.3 });
      if (foc) { var b = atlasThermalBounds(r, fid); if (b) { up.push([r.vf, b[1]]); lw.push([r.vf, b[0]]); all.push(b[0], b[1]); } }
      var isCur = r.run.id === cur.run.id;
      (foc ? focusMarks : marks).push({ x: r.vf, y: g.kMean, color: st.col, size: isCur ? 6.5 : (foc ? 3.8 : 3), sw: isCur ? 2.5 : 1.2, stroke: isCur ? ATLAS_COL.ink : ATLAS_COL.bg, id: r.run.id,
        tip: atlasMarkTip(atlasFillerLabel(fid) + ' · κ ' + atlasFmt4(g.kMean) + ' W/m·K', r, 'X ' + atlasFmt4(g.kx) + ' · Y ' + atlasFmt4(g.ky) + ' · Z ' + atlasFmt4(g.kz) + ' · efficiency ' + atlasFmt4(g.eff)) });
    });
    if (up.length) { lines.push({ pts: up, color: st.col, dash: '1 3', width: 1.3, opacity: 0.8 }); lines.push({ pts: lw, color: st.col, dash: '1 3', width: 1.3, opacity: 0.8 }); }
    lines.push({ pts: pts, color: st.col, dash: st.dash, width: foc ? 2.4 : 1.6, opacity: foc ? 1 : 0.6 });
  });
  marks = marks.concat(focusMarks);
  var fy = atlasFitAxis(all.filter(function (v) { return v > 0; }), 'log'), xm = Math.min(1, Math.max(0.05, xmax * 1.12));
  swEl('atLineSub').textContent = atlasSeriesLabel(ATLAS.series) + ' · ' + series.length + ' runs · mean κ per filler (line style = filler), whiskers X / Y / Z spread, dotted: Hashin–Shtrikman bounds of ' + atlasFillerLabel(f0).toLowerCase();
  atlasChart({ el: el, w: W, h: 340, x: { min: 0, max: xm, title: 'Solid fraction', fmt: atlasPct },
    y: { min: Math.pow(10, fy.lo), max: Math.pow(10, fy.hi), log: true, title: 'Conductivity (W/m·K, log)', fmt: function (v) { return atlasFmtTick('k_water', v); } },
    lines: lines, marks: marks, onClick: atlasSelect });
  swEl('atLineLegend').innerHTML = av.fillers.map(function (fid) {
    return '<button class="at-lk at-lkb' + (fid === f0 ? ' on' : '') + '" onclick="atlasSetFocus(\'' + fid + '\')" title="Focus this filler">' + atlasFillerSw(fid, 22) + atlasFillerLabel(fid) + '</button>'; }).join('') +
    '<span class="at-lk"><svg width="22" height="6" aria-hidden="true"><line x1="1" y1="3" x2="21" y2="3" stroke="' + ATLAS_COL.ink2 + '" stroke-width="1.3" stroke-dasharray="1 3"/></svg>Hashin–Shtrikman bounds (focused filler)</span>';
}
/* v0.33.0 — permeability vs porosity, X / Y / Z, with an optional trabecular bone band */
function atlasLineFlow(series, cur) {
  var el = swEl('atLine'), W = Math.max(320, el.clientWidth || 800);
  swEl('atLineTitle').textContent = 'Permeability vs porosity';
  swEl('atLineCtl').innerHTML = '<div class="at-seg"><button aria-pressed="' + !!ATLAS.bone + '" onclick="atlasSet(\'bone\', ' + !ATLAS.bone + ')" title="Trabecular bone: 0.027–20 ×10⁻⁹ m² (Nauman, Fong &amp; Keaveny 1999)">' +
    '<svg width="12" height="10" aria-hidden="true"><rect x="1" y="1" width="10" height="8" rx="1.5" fill="#f4a6c8" opacity="' + (ATLAS.bone ? 0.7 : 0.3) + '"/></svg><span>Trabecular bone range</span></button></div>';
  var keys = [['perm_x', 'Kx'], ['perm_y', 'Ky'], ['perm_z', 'Kz']], dash = ['', '6 4', '2 4'], lines = [], marks = [], all = [], px = [];
  keys.forEach(function (k, a) {
    var pts = [];
    series.forEach(function (r) {
      var v = r[k[0]]; if (!(v > 0) || r.porosity == null) return;
      pts.push([r.porosity, v]); all.push(v); px.push(r.porosity);
      var isCur = r.run.id === cur.run.id;
      marks.push({ x: r.porosity, y: v, color: ATLAS_COL.ax[a], size: isCur ? 7 : 3.5, sw: isCur ? 2.5 : 1.2, stroke: isCur ? ATLAS_COL.ink : ATLAS_COL.bg, id: r.run.id,
        tip: '<b>' + k[1] + ' = ' + atlasFmt4(v) + ' ×10⁻⁹ m²</b><br>' + swEsc(r.run.id) + ' · ' + atlasPct(r.porosity) + ' porosity' + (r.tort != null ? ' · tortuosity ' + r.tort.toFixed(2) : '') + '<br>' + swEsc(r.run.purpose || '') });
    });
    lines.push({ pts: pts, color: ATLAS_COL.ax[a], dash: dash[a], width: 2 });
  });
  if (!all.length) { el.innerHTML = '<div class="at-sub">No flow results in this series.</div>'; swEl('atLineLegend').innerHTML = ''; swEl('atLineSub').textContent = ''; return; }
  var yv = all.slice(); if (ATLAS.bone) yv.push(ATLAS_BONE_K[0], ATLAS_BONE_K[1]);
  var fy = atlasFitAxis(yv, 'log'), x0 = Math.min.apply(null, px), x1 = Math.max.apply(null, px), xp = Math.max(0.02, (x1 - x0) * 0.1);
  swEl('atLineSub').textContent = atlasSeriesLabel(ATLAS.series) + ' · ' + series.length + ' runs · X / Y / Z at each run’s cell size' + (ATLAS.bone ? ' · shaded: trabecular bone' : '');
  atlasChart({ el: el, w: W, h: 340, x: { min: Math.max(0, x0 - xp), max: Math.min(1, x1 + xp), title: 'Porosity', fmt: atlasPct },
    y: { min: Math.pow(10, fy.lo), max: Math.pow(10, fy.hi), log: true, title: 'Permeability (×10⁻⁹ m², log)', fmt: function (v) { return atlasFmtTick('perm', v); } },
    bands: ATLAS.bone ? [{ lo: ATLAS_BONE_K[0], hi: ATLAS_BONE_K[1], color: '#f4a6c8', label: 'trabecular bone 0.027–20' }] : [],
    lines: lines, marks: marks, onClick: atlasSelect });
  swEl('atLineLegend').innerHTML = keys.map(function (k, a) {
    return '<span class="at-lk"><svg width="20" height="6" aria-hidden="true"><line x1="1" y1="3" x2="19" y2="3" stroke="' + ATLAS_COL.ax[a] + '" stroke-width="2" stroke-dasharray="' + dash[a] + '"/></svg>' + k[1] + '</span>'; }).join('');
}

/* ── Design space scatter ────────────────────────────────── */
function atlasScatter(rows, S, cur) {
  /* v0.33.0 — any metric of the mode, stiffness or geometry on either axis; a default pair per mode */
  var el = swEl('atScatter'), W = Math.max(320, el.clientWidth || 800), p = ATLAS.phys;
  var list = atlasMetricList('sc', rows), has = function (k) { return list.some(function (d) { return d.k === k; }); };
  var def = ATLAS_SC_DEFAULT[p].map(function (k) { return k.replace('*', ATLAS.focus || 'water'); });
  var pair = ATLAS.scBy[p] || def.slice();
  pair = pair.map(function (k, i) { return has(k) ? k : (has(def[i]) ? def[i] : list[i] ? list[i].k : 'max'); });
  ATLAS.scBy[p] = pair;
  var kx = pair[0], ky = pair[1];
  function sel(i) {
    return '<select onchange="atlasScatterSet(' + i + ', this.value)">' + list.map(function (d) {
      return '<option value="' + d.k + '"' + (d.k === pair[i] ? ' selected' : '') + '>' + swEsc(d.label) + (d.phys === 'geo' ? ' (geometry)' : '') + '</option>'; }).join('') + '</select>';
  }
  swEl('atScatterCtl').innerHTML = '<span class="at-lab">X</span>' + sel(0) + '<span class="at-lab">Y</span>' + sel(1) +
    '<div class="at-seg"><button onclick="atlasScatterReset()" title="Back to this mode’s default pair">reset</button></div>';
  var voigt = kx === 'vf' && atlasDef(ky).stiff;
  var note = { stiffness: 'Default: stiffness against solid fraction.', thermal: 'Default: conductivity against stiffness — which cells are stiff and conduct.',
    flow: 'Default: permeability against stiffness — the stiff-but-permeable trade-off.' }[p];
  swEl('atScatterSub').textContent = note + ' Color is connectivity, shape is series.' + (voigt ? ' The dashed line is the Voigt bound (E ≤ solid fraction × E solid).' : '') + ' Click a point to select it.';
  var sIdx = {}; S.order.forEach(function (k, i) { sIdx[k] = i; });
  var marks = [], xs = [], ys = [];
  rows.forEach(function (r) {
    var x = atlasMetricVal(r, kx), y = atlasMetricVal(r, ky);
    if (x == null || y == null || !isFinite(x) || !isFinite(y)) return;
    xs.push(x); ys.push(y);
    marks.push({ x: x, y: y, color: ATLAS_COL.cls[r.cls], shape: ATLAS_SHAPES[sIdx[atlasSeriesKey(r.run)] % ATLAS_SHAPES.length], size: 4.5, stroke: 'none', sw: 0, id: r.run.id,
      tip: '<b>' + swEsc(r.run.id) + '</b> · ' + ATLAS_CLASS[r.cls] + '<br>' + swEsc(atlasSeriesLabel(atlasSeriesKey(r.run))) + '<br>' +
        swEsc(atlasDef(kx).label) + ' ' + atlasFmtMetric(kx, x) + '<br>' + swEsc(atlasDef(ky).label) + ' ' + atlasFmtMetric(ky, y) });
  });
  if (!marks.length) { el.innerHTML = '<div class="at-sub">No run has both of these values.</div>'; return; }
  var cx = atlasMetricVal(cur, kx), cy = atlasMetricVal(cur, ky);
  if (isFinite(cx) && isFinite(cy)) marks.push({ x: cx, y: cy, color: 'none', hollow: true, stroke: ATLAS_COL.ink, size: 9, sw: 2 });
  function ax(k, vals) {
    var fa = atlasFitAxis(vals, voigt && k === ky ? 'log' : 'auto', 6), d = atlasDef(k), u = atlasUnit(k);
    return { min: fa.log ? Math.pow(10, fa.lo) : fa.lo, max: fa.log ? Math.pow(10, fa.hi) : fa.hi, log: fa.log,
             title: d.label + (u && !d.pct ? ' (' + u + (fa.log ? ', log' : '') + ')' : (fa.log ? ' (log)' : '')), fmt: function (v) { return atlasFmtTick(k, v); } };
  }
  var X = ax(kx, xs), Y = ax(ky, ys);
  atlasChart({ el: el, w: W, h: 420, x: X, y: Y, lines: voigt ? [atlasVoigt(X.max)] : [], marks: marks, onClick: atlasSelect });
}
function atlasScatterSet(i, k) { var p = ATLAS.phys, pr = (ATLAS.scBy[p] || ATLAS_SC_DEFAULT[p]).slice(); pr[i] = k; ATLAS.scBy[p] = pr; atlasUpdate(); }
function atlasScatterReset() { ATLAS.scBy[ATLAS.phys] = null; atlasUpdate(); }

/* ── 3-D stiffness surface (v0.12) ───────────────────────────
   Two-parameter builder sweeps only: parameter 1 across, parameter 2 in depth,
   stiffness up (log by default).  Lab-native canvas 2-D (painter's algorithm), so it
   needs no extra WebGL context.  Same CAD tumble as the other views. */
/* v0.33.0 — metric lists come from atlasMetricDefs (mode-filtered); the v0.23–v0.32 lists are retired */
var ATLAS_S3_HOME = atlasM3mul(atlasRotX(0.42), atlasRotY(-0.62));
var ATLAS_S3_EXT = [1, 0.7, 1];   /* half-extents of the plot box: parameter 1, value, parameter 2 */

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
  /* v0.33.0 — metric list and title follow the mode; conductivity / efficiency /
     diffusivity draw every filler (the focused one solid); the value axis is fitted */
  var S3 = ATLAS.s3, av = ATLAS._av || atlasAvail(rows);
  var s3List = atlasMetricList('s3', rows), key = atlasPickKey('s3By', s3List, ATLAS.phys === 'stiffness' ? 'max' : ATLAS.phys === 'thermal' ? 'k_*' : 'perm');
  S3.metric = key;
  var dk = atlasDef(key), isVf = !!dk.pct;
  var fm = /^(k|eff|alpha)_/.exec(key), stack = !!(fm && av.fillers.length > 1);
  swEl('atS3Title').innerHTML = { stiffness: 'Stiffness surface', thermal: 'Conductivity surface', flow: 'Permeability surface' }[ATLAS.phys] + (stack ? ' <span class="at-tag">all fillers</span>' : '');
  var sig = [ATLAS.phys, key, S3.scale, S3.color, ATLAS.units, s3List.length, ATLAS.focus].join('#');
  if (ATLAS._s3Sig !== sig) {
    ATLAS._s3Sig = sig;
    swEl('atS3Ctl').innerHTML = '<select onchange="atlasSetBy(\'s3By\', this.value)">' + s3List.map(function (o) {
        return '<option value="' + o.k + '"' + (key === o.k ? ' selected' : '') + '>' + swEsc(o.label) + (o.phys === 'geo' ? ' (geometry)' : '') + '</option>'; }).join('') + '</select>' +
      '<div class="at-seg">' + [['auto', 'auto'], ['linear', 'linear'], ['log', 'log']].map(function (o) {
        return '<button aria-pressed="' + (S3.scale === o[0]) + '" onclick="atlasS3Set(\'scale\', \'' + o[0] + '\')" title="' + (o[0] === 'auto' ? 'Log when the values span more than about a decade, else linear' : o[1] + ' value axis') + '">' + o[1] + '</button>'; }).join('') + '</div>' +
      (key === 'xyz' || stack ? '' : '<div class="at-seg"><button aria-pressed="' + (S3.color === 'value') + '" onclick="atlasS3Set(\'color\', \'value\')">color by value</button><button aria-pressed="' + (S3.color === 'class') + '" onclick="atlasS3Set(\'color\', \'class\')">by connectivity</button></div>') +
      '<div class="at-seg"><button onclick="ATLAS.s3.cam && ATLAS.s3.cam.reset()" title="Home view (double-click the plot)" aria-label="Home view">' + ATLAS_ICON.home + '</button></div>';
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
  var keys = key === 'xyz' ? ['Ex', 'Ey', 'Ez'] : stack ? av.fillers.map(function (fid) { return fm[1] + '_' + fid; }) : [key];
  var vals = [];
  keys.forEach(function (k) { rows.forEach(function (r) { if (!r.run.grid) return; var v = atlasMetricVal(r, k); if (v != null && isFinite(v)) vals.push(v); }); });
  var fit = atlasFitAxis(vals, S3.scale, 5), useLog = fit.log, tlo = fit.lo, thi = fit.hi, ticks = fit.ticks;
  function tf(v) { if (v == null || !isFinite(v)) return null; if (useLog) return v > 0 ? Math.log10(v) : null; return v; }
  function Y(t) { return -ATLAS_S3_EXT[1] + 2 * ATLAS_S3_EXT[1] * (t - tlo) / ((thi - tlo) || 1); }
  var surfaces = keys.map(function (k, si) {
    var g = [];
    for (var i = 0; i < n1; i++) { g.push([]); for (var j = 0; j < n2; j++) { var r = cell[i][j], t = r ? tf(atlasMetricVal(r, k)) : null; g[i].push(t == null ? null : Y(Math.max(tlo, Math.min(thi, t)))); } }
    var fid = stack ? k.slice(fm[1].length + 1) : null, foc = !stack || fid === ATLAS.focus;
    return { key: k, y: g, focus: foc,
             color: stack ? atlasHexRgb((ATLAS_FILLER_STYLE[fid] || { col: '#b8b8d0' }).col) : keys.length > 1 ? atlasHexRgb(ATLAS_COL.ax[si]) : null,
             alpha: stack ? (foc ? 0.95 : 0.26) : null };
  });
  if (stack) surfaces.sort(function (a, b) { return (a.focus ? 1 : 0) - (b.focus ? 1 : 0); });
  var unit = atlasUnit(key === 'xyz' ? 'Ex' : key);
  ATLAS._s3 = { n1: n1, n2: n2, xs: xs, zs: zs, cell: cell, surfaces: surfaces, ticks: ticks, useLog: useLog, isVf: isVf, Y: Y, tlo: tlo, thi: thi,
                a1: a1, a2: a2, cur: cur, metricKey: key === 'xyz' ? 'Ex' : keys[0], metricLabel: dk.label,
                yTitle: (stack ? dk.label.replace(/ · .*$/, '') : dk.label) + (unit && !isVf ? ' · ' + unit : '') + (useLog ? ' (log)' : '') };
  var missing = 0; cell.forEach(function (c) { c.forEach(function (r) { if (!r) missing++; }); });
  var lo = vals.length ? Math.min.apply(null, vals) : null, hi = vals.length ? Math.max.apply(null, vals) : null;
  swEl('atS3Sub').textContent = n1 + ' × ' + n2 + ' runs · ' + dk.label + (unit && !isVf ? ' (' + unit + ')' : '') + ' · ' + (useLog ? 'log' : 'linear') +
    (lo != null ? ' · axis fitted to the data (' + atlasFmtMetric(ATLAS._s3.metricKey, lo) + ' – ' + atlasFmtMetric(ATLAS._s3.metricKey, hi) + ')' : '') +
    (stack ? ' · every filler, ' + atlasFillerLabel(ATLAS.focus).toLowerCase() + ' solid' : '') +
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
  var ty = D.ticks.map(function (t) { return { p: D.Y(t), t: atlasFmtTick(D.metricKey, D.useLog ? Math.pow(10, t) : t) }; });
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
    var levels = D.ticks;
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
      quads.push({ z: (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4, pts: pts, fill: 'rgba(' + rgb.join(',') + ',' + (S.alpha != null ? S.alpha : (S.color ? 0.66 : 0.97)) + ')' });
    }
  });
  quads.sort(function (a, b) { return a.z - b.z; });
  quads.forEach(function (q) { poly(q.pts, q.fill, 'rgba(6,8,15,0.32)', 0.6); });
  /* selected run and hover */
  var hot = [], cur = D.cur, ci = cur && cur.run.grid;
  D.surfaces.forEach(function (S) {
    if (S.focus === false) return;   /* v0.33.0 — faded filler surfaces don't take hover */
    for (var i = 0; i < D.n1; i++) for (var j = 0; j < D.n2; j++) if (S.y[i][j] != null) {
      var p = P(D.xs[i], S.y[i][j], D.zs[j]); hot.push({ x: p[0], y: p[1], i: i, j: j, k: S.key, id: D.cell[i][j].run.id });
    }
  });
  ATLAS._s3HotList = hot;
  if (ci) D.surfaces.forEach(function (S) {
    var yv = S.y[ci[0]] && S.y[ci[0]][ci[1]]; if (yv == null || S.focus === false) return;
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
  var tw = g.measureText(D.yTitle).width;   /* v0.33.0 — a plate so the surface never covers the title */
  g.fillStyle = 'rgba(7,8,14,0.78)'; g.fillRect(ptop[0] - tw / 2 - 5, ptop[1] - 24, tw + 10, 16);
  g.fillStyle = '#7c8aaa'; g.fillText(D.yTitle, ptop[0], ptop[1] - 12);
}
function atlasS3Hover(e) {
  var list = ATLAS._s3HotList, cv = swEl('atS3c'), tip = swEl('atTip');
  if (!list || !cv || e.buttons) return;
  var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, best = null, bd = 14 * 14;
  list.forEach(function (h) { var d = (h.x - x) * (h.x - x) + (h.y - y) * (h.y - y); if (d < bd) { bd = d; best = h; } });
  var prev = ATLAS._s3Hot; ATLAS._s3Hot = best;
  if (!best) { tip.hidden = true; if (prev) atlasS3Queue(); return; }
  var D = ATLAS._s3, row = D.cell[best.i][best.j];
  var v = atlasMetricVal(row, best.k);
  tip.innerHTML = '<b>' + swEsc(row.run.id) + '</b> · ' + ATLAS_CLASS[row.cls] + '<br>' + swEsc(D.a1.label) + ' = ' + swEsc(sweepFmtVal(D.a1.values[best.i])) + atlasAxSuffix(D.a1) +
    '<br>' + swEsc(D.a2.label) + ' = ' + swEsc(sweepFmtVal(D.a2.values[best.j])) + '<br>' + (best.k === 'vf' ? 'Solid ' + (v * 100).toFixed(1) + ' %' :
    swEsc(atlasDef(best.k).label) + ' = ' + atlasFmtMetric(best.k, v) + (atlasUnit(best.k) && !atlasDef(best.k).pct ? ' ' + swEsc(atlasUnit(best.k)) : '') + ' · ' + (row.vf * 100).toFixed(1) + ' % solid');
  tip.hidden = false;
  var pr = tip.parentNode.getBoundingClientRect(), tw = tip.offsetWidth || 200, lx = e.clientX - pr.left + 14;
  if (lx + tw > pr.width - 8) lx = e.clientX - pr.left - tw - 14;
  tip.style.left = lx + 'px'; tip.style.top = (e.clientY - pr.top + 14) + 'px';
  if (!prev || prev.id !== best.id || prev.k !== best.k) atlasS3Queue();
}

/* ── Data check ──────────────────────────────────────────── */
function atlasChecks(rows, S) {
  if (ATLAS.phys === 'thermal') return atlasChecksRender(atlasChecksThermal(rows, S), 'thermal');
  if (ATLAS.phys === 'flow') return atlasChecksRender(atlasChecksFlow(rows, S), 'flow');
  var items = [];
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
  atlasChecksRender(items, 'stiffness');
}
/* v0.33.0 — one renderer for every mode; drawn icons on the chips */
function atlasChecksRender(items, label) {
  var el = swEl('atChecks'), wasOpen = el.open;
  var pass = items.filter(function (x) { return x.kind === 'pass'; }).length, flag = items.filter(function (x) { return x.kind === 'flag'; }).length, note = items.length - pass - flag;
  el.innerHTML = '<summary><span class="at-dct">Data check · ' + label + '</span><span class="at-chip pass">' + ATLAS_ICON.pass + pass + ' pass</span>' + (flag ? '<span class="at-chip flag">' + ATLAS_ICON.flag + flag + ' flag' + (flag > 1 ? 's' : '') + '</span>' : '') +
    (note ? '<span class="at-chip note">' + ATLAS_ICON.note + note + ' note' + (note > 1 ? 's' : '') + '</span>' : '') + '</summary><div class="at-checkgrid">' +
    items.map(function (x) { return '<div class="at-check"><span class="at-chip ' + x.kind + '">' + ATLAS_ICON[x.kind] + (x.kind === 'pass' ? 'Pass' : x.kind === 'flag' ? 'Flag' : 'Note') + '</span><div><div class="t">' + swEsc(x.t) + '</div><div class="d">' + swEsc(x.d) + '</div></div></div>'; }).join('') + '</div>';
  el.open = wasOpen;
}
function atlasIdList(list, n) { return list.slice(0, n || 6).map(function (r) { return r.run ? r.run.id : r; }).join(', ') + (list.length > (n || 6) ? ', …' : ''); }
function atlasChecksThermal(rows, S) {
  var items = [], av = ATLAS._av || atlasAvail(rows);
  function add(kind, t, d) { items.push({ kind: kind, t: t, d: d }); }
  var withT = rows.filter(function (r) { return r.res.thermal && r.res.thermal.byFiller; }), err = rows.filter(function (r) { return r.res.thermal && r.res.thermal.error; });
  add(withT.length === rows.length ? 'pass' : 'note', 'Runs with thermal', withT.length + ' of ' + rows.length + ' solved runs have thermal results' + (err.length ? '; ' + err.length + ' failed (' + atlasIdList(err) + ')' : '') + '. Fillers: ' + av.fillers.map(atlasFillerLabel).join(', ').toLowerCase() + '.');
  var nc = withT.filter(function (r) { var B = r.res.thermal.byFiller; return Object.keys(B).some(function (f) { return !B[f].converged; }); });
  add(nc.length ? 'flag' : 'pass', 'Solver convergence', nc.length ? nc.length + ' runs did not converge on every filler (' + atlasIdList(nc) + ').' : 'Every run converged on every filler.');
  var ur = withT.filter(function (r) { return r.res.thermal.underResolved; });
  add(ur.length ? 'flag' : 'pass', 'Resolution', ur.length ? ur.length + ' runs have more than 5 % of the solid in fragments under 3³ voxels, which the island trim drops (' + atlasIdList(ur) + '). Raise the grid.' : 'No run loses more than 5 % of its solid to sub-voxel fragments.');
  var out = [];
  withT.forEach(function (r) { av.fillers.forEach(function (f) { var g = atlasThermalOf(r, f), b = atlasThermalBounds(r, f); if (g && b && (g.kMean > b[1] * 1.01 || g.kMean < b[0] * 0.99)) out.push(r.run.id + ' ' + f); }); });
  add(out.length ? 'flag' : 'pass', 'Hashin–Shtrikman bounds', out.length ? out.length + ' results fall outside the bounds for their solid fraction (' + out.slice(0, 6).join(', ') + ').' : 'Every conductivity sits between the Hashin–Shtrikman bounds for its solid fraction.');
  var dips = [];
  S.order.forEach(function (k) {
    var list = S.map[k].filter(function (r) { return atlasThermalOf(r, ATLAS.focus); }).sort(function (a, b) { return a.vf - b.vf; });
    for (var i = 1; i < list.length; i++) if (list[i].vf > list[i - 1].vf + 1e-4 && atlasThermalOf(list[i], ATLAS.focus).kMean < atlasThermalOf(list[i - 1], ATLAS.focus).kMean * 0.97) dips.push(list[i].run.id);
  });
  add(dips.length ? 'note' : 'pass', 'Conductivity rises with solid fraction', dips.length ? dips.length + ' places where ' + atlasFillerLabel(ATLAS.focus).toLowerCase() + '-filled conductivity drops by more than 3 % as solid increases within a series (' + dips.slice(0, 6).join(', ') + ').' :
    'Within every series, ' + atlasFillerLabel(ATLAS.focus).toLowerCase() + '-filled conductivity rises with solid fraction.');
  var diag = withT.filter(function (r) { var g = atlasThermalOf(r, ATLAS.focus); return g && !(g.K && g.K.length === 9); });
  if (diag.length) add('note', 'Tensor', diag.length + ' runs were solved before v0.33.0 and keep only κx, κy, κz; κ(n) is drawn from those. Re-run them for the full tensor.');
  return items;
}
function atlasChecksFlow(rows, S) {
  var items = [];
  function add(kind, t, d) { items.push({ kind: kind, t: t, d: d }); }
  var withF = rows.filter(function (r) { return r.res.flow && !r.res.flow.error; }), err = rows.filter(function (r) { return r.res.flow && r.res.flow.error; });
  add(withF.length === rows.length ? 'pass' : 'note', 'Runs with flow', withF.length + ' of ' + rows.length + ' solved runs have flow results' + (err.length ? '; ' + err.length + ' failed (' + atlasIdList(err) + ')' : '') + '.');
  var shut = withF.filter(function (r) { var o = r.res.flow.open; return !(o[0] || o[1] || o[2]); }), part = withF.filter(function (r) { var o = r.res.flow.open; return (o[0] || o[1] || o[2]) && !(o[0] && o[1] && o[2]); });
  add(shut.length ? 'flag' : part.length ? 'note' : 'pass', 'Open pore paths', shut.length ? shut.length + ' runs have no open pore path at all (' + atlasIdList(shut) + ').' : part.length ? part.length + ' runs are open along some axes only (' + atlasIdList(part) + '); K(n) needs all three.' : 'Every run is open along X, Y and Z.');
  var nc = withF.filter(function (r) { var F = r.res.flow; return [0, 1, 2].some(function (a) { return F.open[a] && !F.converged[a]; }); });
  add(nc.length ? 'flag' : 'pass', 'Solver convergence', nc.length ? nc.length + ' runs did not converge on every open axis (' + atlasIdList(nc) + ').' : 'Permeability converged on every open axis.');
  var pm = (typeof FLOW_THROAT_PERM !== 'undefined') ? FLOW_THROAT_PERM : 8, wm = (typeof FLOW_THROAT_WSS !== 'undefined') ? FLOW_THROAT_WSS : 15;
  var cp = withF.filter(function (r) { return r.res.flow.throatVox != null && r.res.flow.throatVox < pm; }), cw = withF.filter(function (r) { var t = r.res.flow.throatVox; return t != null && t >= pm && t < wm; });
  add(cp.length ? 'flag' : 'pass', 'Grid for permeability', cp.length ? cp.length + ' runs have a narrowest pore under ' + pm + ' voxels on the flow grid (' + atlasIdList(cp) + '); permeability reads off. Raise the flow grid.' : 'Every narrowest pore spans at least ' + pm + ' voxels.');
  if (cw.length) add('note', 'Grid for wall shear', cw.length + ' runs have a narrowest pore of ' + pm + '–' + wm + ' voxels (' + atlasIdList(cw) + '): permeability is fine, wall shear approximate.');
  var fw = (typeof FLOW_FORCE_WARN !== 'undefined') ? FLOW_FORCE_WARN : 0.05;
  var fb = withF.filter(function (r) { var R = r.res.flow.residual || []; return R.some(function (v) { return v != null && Math.abs(v) > fw; }); });
  add(fb.length ? 'flag' : 'pass', 'Wall force balance', fb.length ? fb.length + ' runs have a wall force more than ' + Math.round(fw * 100) + ' % off the driving force (' + atlasIdList(fb) + '); their wall shear is approximate.' : 'Wall force matches the driving force within ' + Math.round(fw * 100) + ' % on every run.');
  var sealed = withF.filter(function (r) { return (r.res.flow.sealedPorosity || 0) > 0.005; });
  if (sealed.length) add('note', 'Sealed pores', sealed.length + ' runs have more than 0.5 % of the cell in pores no flow reaches (' + atlasIdList(sealed) + ').');
  var dips = [];
  S.order.forEach(function (k) {
    var list = S.map[k].filter(function (r) { return r.perm > 0; }).sort(function (a, b) { return a.porosity - b.porosity; });
    for (var i = 1; i < list.length; i++) if (list[i].porosity > list[i - 1].porosity + 1e-4 && list[i].perm < list[i - 1].perm * 0.97) dips.push(list[i].run.id);
  });
  add(dips.length ? 'note' : 'pass', 'Permeability rises with porosity', dips.length ? dips.length + ' places where mean permeability drops by more than 3 % as porosity rises within a series (' + dips.slice(0, 6).join(', ') + '). Expected where pores pinch or close.' : 'Within every series, mean permeability rises with porosity.');
  return items;
}
