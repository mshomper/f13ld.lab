/* ============================================================
   F13LD.lab · 51-dock.js  (v0.22.0)
   Run settings: the control pane's Model and Physics sections and the
   footer (designs / estimate / hardware, Run all).

   UI refresh stage 2: the Configure drawer and the dock tags are gone.
   The pane is docked on the right (sheet on a phone). Physics has one fold
   per mode (Elastic, Buckling, Crush, Thermal κ, Flow): the run toggle and
   a one-line summary in the header, that mode's settings in the body.
   (Before: a drawer that slid up over the cards, a tab per mode, a tag
   per mode in the dock.)

   State lives where it always did (PHYS_STATE, GRID_STATE, BUCKLE_STATE,
   NONLIN_STATE, THERMAL_STATE, GEOM_STATE, MATERIAL_STATE in 50-controls.js);
   this file only paints it and routes clicks to the existing handlers.
   Element ids the solver code writes to are unchanged: runBtn, progRow,
   progStatus, progFill, progEta, estTimeVal, designCountVal, hardwarePill,
   hardwarePillVal.

   Mobile rules (brand guidelines): onclick attributes, function
   declarations, var — no arrow functions, classes or modules.
   ============================================================ */

/* Physics icons — brand icon style: 40×40 grid, round caps, a neon accent
   node (.acc).  Filled red tile = the mode runs; empty outlined tile = off. */
var LAB_ICON_SV = ' fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
var LAB_ICONS = {
  model:   '<path d="M20 4 L34 12 V28 L20 36 L6 28 V12 Z"' + LAB_ICON_SV + '/><path d="M6 12 L20 20 L34 12 M20 20 V36"' + LAB_ICON_SV + ' opacity=".7"/><circle class="acc" cx="20" cy="20" r="3.4"/>',
  elastic: '<path d="M9 5 H31 M9 35 H31"' + LAB_ICON_SV + '/><path d="M20 5 V9 L29 12.5 L11 17 L29 21.5 L11 26 L29 29.5 L20 31 V35"' + LAB_ICON_SV + ' stroke-width="2.3"/><circle class="acc" cx="20" cy="19.3" r="3"/>',
  buckle:  '<path d="M10 5 H30 M10 35 H30"' + LAB_ICON_SV + '/><path d="M20 5 C 32 13, 32 27, 20 35"' + LAB_ICON_SV + '/><path d="M20 9 V31"' + LAB_ICON_SV + ' stroke-width="1.6" stroke-dasharray="0.1 4.2" opacity=".6"/><circle class="acc" cx="29" cy="20" r="3.2"/>',
  nonlin:  '<path d="M5 4 V35 H37"' + LAB_ICON_SV + ' opacity=".7"/><path d="M5 35 L13 15 C 16 10, 21 10.5, 36 11.5"' + LAB_ICON_SV + '/><circle class="acc" cx="13.5" cy="14" r="3.2"/>',
  thermal: '<path d="M16.5 25 V8.5 a3.5 3.5 0 0 1 7 0 V25 a6.5 6.5 0 1 1 -7 0 Z"' + LAB_ICON_SV + '/><path d="M20 15 V27"' + LAB_ICON_SV + ' stroke-width="3"/><circle class="acc" cx="20" cy="29.5" r="3.3"/><path d="M28.5 10 H33 M28.5 15.5 H33 M28.5 21 H31"' + LAB_ICON_SV + ' stroke-width="2.2" opacity=".75"/>',
  /* v0.25.0 — VIEW tabs: stress (contour rings around a hot spot), stiffness (directional surface rosette) */
  stress:  '<path d="M20 5 C 31 5, 36 12, 35 21 C 34 31, 26 36, 18 35 C 9 34, 4 27, 5 18 C 6 10, 12 5, 20 5 Z"' + LAB_ICON_SV + ' opacity=".55"/><path d="M21 11 C 28 11, 30 17, 29 22 C 28 28, 23 30, 18 29 C 12 28, 10 23, 11 18 C 12 13, 16 11, 21 11 Z"' + LAB_ICON_SV + ' opacity=".8"/><circle class="acc" cx="20" cy="20" r="3.6"/>',
  stiff:   '<path d="M20 3 V37 M3 20 H37"' + LAB_ICON_SV + ' stroke-width="1.4" opacity=".45"/><path d="M20 6 C 24 14, 26 16, 34 20 C 26 24, 24 26, 20 34 C 16 26, 14 24, 6 20 C 14 16, 16 14, 20 6 Z"' + LAB_ICON_SV + '/><circle class="acc" cx="34" cy="20" r="3.2"/>',
  /* v0.28.0 — Flow (lattice Boltzmann): streamlines around a strut */
  fluid:   '<circle cx="20" cy="20" r="5.5"' + LAB_ICON_SV + '/><path d="M3 12 C 12 12, 14 8.5, 20 8.5 S 29 12, 37 12 M3 28 C 12 28, 14 31.5, 20 31.5 S 29 28, 37 28 M3 20 H10 M30 20 H37"' + LAB_ICON_SV + ' stroke-width="2.2"/><circle class="acc" cx="25.5" cy="16" r="2.8"/>'
};
LAB_ICONS.flow = LAB_ICONS.fluid;   /* v0.28.0 — the Flow mode key */
/* v0.34.0 — header and Atlas icons (Matt, 2026-10-15: the Atlas mark is the response surface) */
LAB_ICONS.atlas = '<path d="M5 27 C 11 22, 15 13, 20 14 S 28 22, 35 18"' + LAB_ICON_SV + '/><path d="M9 33 C 15 28, 19 20, 24 21 S 31 27, 37 24"' + LAB_ICON_SV + ' opacity=".65"/><path d="M5 27 L9 33 M35 18 L37 24 M20 14 L24 21"' + LAB_ICON_SV + ' stroke-width="1.8" opacity=".55"/><circle class="acc" cx="18.5" cy="12" r="3.2"/>';
LAB_ICONS.sweep = '<path d="M31 14 A 12.5 12.5 0 0 0 9.5 13"' + LAB_ICON_SV + '/><path d="M9 26 A 12.5 12.5 0 0 0 30.5 27"' + LAB_ICON_SV + '/><path d="M31 7 V14 H24 M9 33 V26 H16"' + LAB_ICON_SV + '/><circle class="acc" cx="20" cy="20" r="3.2"/>';
LAB_ICONS.plus = '<path d="M20 8 V32 M8 20 H32"' + LAB_ICON_SV + ' stroke-width="3.2"/>';
LAB_ICONS.importCell = '<path d="M8 24 V33 H32 V24"' + LAB_ICON_SV + '/><path d="M20 5 V22 M13 15 L20 22 L27 15"' + LAB_ICON_SV + '/>';
LAB_ICONS.exportDoc = '<path d="M11 5 H24 L30 11 V35 H11 Z"' + LAB_ICON_SV + '/><path d="M24 5 V11 H30"' + LAB_ICON_SV + ' stroke-width="2" opacity=".7"/><path d="M20.5 15 V28 M15.5 23 L20.5 28 L25.5 23"' + LAB_ICON_SV + '/>';
LAB_ICONS.front = '<path d="M6 5 V34 H36"' + LAB_ICON_SV + ' opacity=".7"/><path d="M10 9 C 14 17, 20 24, 33 29"' + LAB_ICON_SV + ' stroke-width="2" opacity=".75"/><circle cx="14" cy="26" r="1.9" fill="currentColor"/><circle cx="21" cy="30" r="1.9" fill="currentColor"/><circle cx="27" cy="25" r="1.9" fill="currentColor" opacity=".7"/><circle cx="12" cy="18" r="1.9" fill="currentColor" opacity=".7"/><circle class="acc" cx="18" cy="19.5" r="3.2"/>';
LAB_ICONS.slider = '<path d="M5 20 H35"' + LAB_ICON_SV + '/><path d="M5 12 V28 M35 12 V28"' + LAB_ICON_SV + ' stroke-width="2" opacity=".5"/><circle class="acc" cx="22" cy="20" r="4.2"/>';
LAB_ICONS.help = '<circle cx="20" cy="20" r="15"' + LAB_ICON_SV + '/><path d="M15.2 15.5 C 15.2 12.2, 17.5 10.8, 20 10.8 C 22.8 10.8, 24.8 12.6, 24.8 15.1 C 24.8 18.4, 20 18.7, 20 22.5"' + LAB_ICON_SV + '/><circle cx="20" cy="28.6" r="1.9" fill="currentColor"/>';
/* UI refresh stage 2 — Results tab (phone): a table of metrics by design */
LAB_ICONS.results = '<path d="M6 7 H34 V33 H6 Z"' + LAB_ICON_SV + '/><path d="M6 15 H34 M16 15 V33"' + LAB_ICON_SV + ' stroke-width="2.2" opacity=".75"/><circle class="acc" cx="25" cy="24" r="3"/>';
function labIconSvg(name){ return '<svg viewBox="0 0 40 40" aria-hidden="true">' + (LAB_ICONS[name] || '') + '</svg>'; }

/* Run-button markup the solver code paints through (50-controls.js). */
var DOCK_RUN_IDLE    = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z" fill="currentColor"/></svg>Run all';
var DOCK_RUN_RERUN   = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z" fill="currentColor"/></svg>Re-run';
var DOCK_RUN_CANCEL  = '<svg class="dock-spin" width="15" height="15" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L34 11 L34 29 L20 37 L6 29 L6 11 Z" fill="none" stroke="#2c4e30" stroke-width="2.5"/><g class="arcs"><path d="M20 5 A15 15 0 0 1 34 18" fill="none" stroke="#c8f542" stroke-width="3.5" stroke-linecap="round"/><path d="M20 35 A15 15 0 0 1 6 22" fill="none" stroke="#1D9E75" stroke-width="3.5" stroke-linecap="round"/></g><circle cx="20" cy="20" r="3.4" fill="#c8f542"/></svg>Cancel';
var DOCK_TICK        = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3 L5 8.8 L9.5 3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var DOCK_RUN_DONE    = DOCK_TICK + 'Run complete';

var DOCK_MODES = [
  { key: 'elastic', name: 'Elastic' },
  { key: 'buckle',  name: 'Buckling' },
  { key: 'nonlin',  name: 'Crush' },
  { key: 'thermal', name: 'Thermal κ' },
  { key: 'flow',    name: 'Flow' }
];

/* UI refresh stage 2 — which folds of the control pane are open (the five physics folds, the Flow readout fold, the Model
   defaults fold). A per-viewer convenience only (try/catch). */
var DOCK_STATE = { open: { elastic: false, buckle: false, nonlin: false, thermal: false, flow: false, flowReadout: false, defaults: false } };
var DOCK_STORE_KEY = 'f13ld.lab.physOpen';

/* ============================================================
   INIT
   ============================================================ */
/* ── v0.24.0 — run settings remembered per browser ─────────────────
   Everything in the Configure drawer (modes, grids, strain cap, load axis,
   fillers, connectivity, surface voxels).  The material keeps its own key
   (MATERIAL_STORE_KEY, 50-controls).  Nothing saved (new browser, cleared
   data) → the defaults in 50-controls. */
var LAB_SETTINGS_KEY = 'f13ld.lab.settings.v1';
var LAB_SETTINGS_LOADED = false;
var LAB_SETTINGS_DEFAULTS = null;
function labSnapshotSettings(){
  return { phys: { elastic: !!PHYS_STATE.elastic, buckle: !!PHYS_STATE.buckle, nonlin: !!PHYS_STATE.nonlin, thermal: !!PHYS_STATE.thermal, flow: !!PHYS_STATE.flow },
           flowN: FLOW_STATE.N, flowTol: FLOW_STATE.tol,
           flowDir: FLOW_STATE.dir, flowFluid: FLOW_STATE.fluid, flowMu: FLOW_STATE.muCustom, flowTarget: FLOW_STATE.target,
           flowTLo: FLOW_STATE.tLo, flowTHi: FLOW_STATE.tHi, flowUnit: FLOW_STATE.speedUnit, flowChamber: FLOW_STATE.chamberMm,
           gridN: GRID_STATE.N, buckleN: BUCKLE_STATE.N, nonlinN: NONLIN_STATE.N, cap: NONLIN_STATE.cap, axis: NONLIN_STATE.axis,
           fillers: { air: !!THERMAL_STATE.fillers.air, water: !!THERMAL_STATE.fillers.water, tissue: !!THERMAL_STATE.fillers.tissue },
           conn: GEOM_STATE.connectivity, pv: !!GEOM_STATE.partialVolume };
}
function labApplySettings(s){
  if (!s || typeof s !== 'object') return;
  var k;
  if (s.phys) for (k in PHYS_STATE) if (typeof s.phys[k] === 'boolean') PHYS_STATE[k] = s.phys[k];
  if ([32, 64, 128].indexOf(s.gridN) >= 0) { GRID_STATE.mode = 'manual'; GRID_STATE.N = s.gridN; }
  if ([16, 32, 64].indexOf(s.buckleN) >= 0) BUCKLE_STATE.N = s.buckleN;
  if ([32, 64, 128].indexOf(s.flowN) >= 0) FLOW_STATE.N = s.flowN;          /* v0.28.0 */
  if ([1e-6, 1e-7].indexOf(s.flowTol) >= 0) FLOW_STATE.tol = s.flowTol;
  /* v0.30.0 — wall shear settings */
  if (['zz', 'xx', 'yy', 'all'].indexOf(s.flowDir) >= 0) FLOW_STATE.dir = s.flowDir;
  if (['water', 'medium', 'custom'].indexOf(s.flowFluid) >= 0) FLOW_STATE.fluid = s.flowFluid;
  if (s.flowMu > 0) FLOW_STATE.muCustom = s.flowMu;
  if (typeof FLOW_SHEAR_TARGETS !== 'undefined' && FLOW_SHEAR_TARGETS.some(function(t){ return t.id === s.flowTarget; })) FLOW_STATE.target = s.flowTarget;
  if (s.flowTLo > 0) FLOW_STATE.tLo = s.flowTLo;
  if (s.flowTHi > 0) FLOW_STATE.tHi = s.flowTHi;
  if (s.flowUnit === 'mm' || s.flowUnit === 'm') FLOW_STATE.speedUnit = s.flowUnit;
  if (s.flowChamber > 0) FLOW_STATE.chamberMm = s.flowChamber;
  if ([16, 32, 64].indexOf(s.nonlinN) >= 0) NONLIN_STATE.N = s.nonlinN;
  if ([0.02, 0.05, 0.1].indexOf(s.cap) >= 0) NONLIN_STATE.cap = s.cap;
  if (['xx', 'yy', 'zz', 'all'].indexOf(s.axis) >= 0) { NONLIN_STATE.axis = s.axis; if (s.axis !== 'all') NONLIN_STATE.view = s.axis; }
  if (s.fillers) {
    var any = false;
    for (k in THERMAL_STATE.fillers) if (s.fillers[k] === true) any = true;
    if (any) for (k in THERMAL_STATE.fillers) THERMAL_STATE.fillers[k] = s.fillers[k] === true;
  }
  if (['networks', 'largest', 'off'].indexOf(s.conn) >= 0) onConnectivityChange(s.conn);
  if (typeof s.pv === 'boolean') GEOM_STATE.partialVolume = s.pv;
  /* the Thermal κ tab shows a filler that was solved */
  if (typeof VIEW_STATE !== 'undefined' && !THERMAL_STATE.fillers[VIEW_STATE.thermalFiller]) {
    var first = ['water', 'air', 'tissue'].filter(function(f){ return THERMAL_STATE.fillers[f]; })[0];
    if (first && typeof onThermalFillerView === 'function') onThermalFillerView(first);
  }
}
function labLoadSettings(){
  if (!LAB_SETTINGS_DEFAULTS) LAB_SETTINGS_DEFAULTS = JSON.parse(JSON.stringify(labSnapshotSettings()));
  try { labApplySettings(JSON.parse(localStorage.getItem(LAB_SETTINGS_KEY) || 'null')); } catch (e) {}
  LAB_SETTINGS_LOADED = true;
}
function labSaveSettings(){
  if (!LAB_SETTINGS_LOADED) return;
  try { localStorage.setItem(LAB_SETTINGS_KEY, JSON.stringify(labSnapshotSettings())); } catch (e) {}
}
function labResetSettings(){
  try { localStorage.removeItem(LAB_SETTINGS_KEY); localStorage.removeItem(MATERIAL_STORE_KEY); } catch (e) {}
  if (LAB_SETTINGS_DEFAULTS) labApplySettings(JSON.parse(JSON.stringify(LAB_SETTINGS_DEFAULTS)));
  if (typeof LAB_DEFAULT_MATERIAL !== 'undefined' && typeof findMaterial === 'function' && findMaterial(LAB_DEFAULT_MATERIAL)) MATERIAL_STATE.id = LAB_DEFAULT_MATERIAL;
  recomputeEstimate();
  paintDock();
}

function initDock(){
  labLoadSettings();   /* v0.24.0 — before the first paint */
  try {
    var saved = JSON.parse(localStorage.getItem(DOCK_STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') for (var fk in DOCK_STATE.open) if (typeof saved[fk] === 'boolean') DOCK_STATE.open[fk] = saved[fk];
  } catch (e) {}
  var icons = document.querySelectorAll('[data-ico]');
  for (var i = 0; i < icons.length; i++) icons[i].innerHTML = labIconSvg(icons[i].getAttribute('data-ico'));
  var run = document.getElementById('runBtn');
  if (run && !RUN_STATE.running) run.innerHTML = DOCK_RUN_IDLE;
  document.addEventListener('click', onDockDocClick);
  document.addEventListener('keydown', onDockKey);
  paintDock();
}

function saveDockState(){
  try { localStorage.setItem(DOCK_STORE_KEY, JSON.stringify(DOCK_STATE.open)); } catch (e) {}
}

/* ============================================================
   FOLDS (control pane, UI refresh stage 2)
   The Configure drawer is the control pane now: always there, nothing to open. A fold's header holds the run
   toggle and a one-line summary; the body opens on a tap and is remembered.
   ============================================================ */
function toggleDrawer(){ /* v0.36 — shim: the Configure button is gone; kept so old callers do nothing */ }
function onFoldToggle(key, force){
  if (!DOCK_STATE.open.hasOwnProperty(key)) return;
  DOCK_STATE.open[key] = (typeof force === 'boolean') ? force : !DOCK_STATE.open[key];
  closeDropdowns();
  saveDockState();
  paintFolds();
}
function paintFolds(){
  var els = document.querySelectorAll('.fold[data-fold]'), i;
  for (i = 0; i < els.length; i++){
    var k = els[i].getAttribute('data-fold'), on = !!DOCK_STATE.open[k];
    els[i].classList.toggle('open', on);
    var b = els[i].querySelector('.fold-btn'), body = els[i].querySelector('.fold-b');
    if (b) b.setAttribute('aria-expanded', on);
    if (body) body.hidden = !on;
  }
}

/* ============================================================
   CONTROL ROUTING → existing state + handlers (50-controls.js)
   ============================================================ */
function onPhysSwitch(ev, key){
  if (ev) ev.stopPropagation();
  if (!PHYS_STATE.hasOwnProperty(key)) return;
  PHYS_STATE[key] = !PHYS_STATE[key];
  recomputeEstimate();
  paintDock();
}

function onSegClick(btn){
  var group = btn.parentNode.getAttribute('data-seg'), v = btn.getAttribute('data-v');
  if (group === 'grid'){
    GRID_STATE.mode = 'manual'; GRID_STATE.N = +v;
  } else if (group === 'buckleN'){
    BUCKLE_STATE.N = +v;
  } else if (group === 'nonlinN'){
    NONLIN_STATE.N = +v;
  } else if (group === 'cap'){
    NONLIN_STATE.cap = +v;
  } else if (group === 'axis'){
    onNonlinAxisChange(v);
  } else if (group === 'pv'){
    onSurfaceVoxelChange(v);
  } else if (group === 'flowN'){        /* v0.28.0 */
    FLOW_STATE.N = +v;
  } else if (group === 'flowTol'){
    FLOW_STATE.tol = v === 'high' ? 1e-7 : 1e-6;
  } else if (group === 'flowDir' || group === 'flowFluid' || group === 'flowUnit'){   /* v0.30.0 — display only, no re-solve */
    if (group === 'flowDir') FLOW_STATE.dir = v;
    else if (group === 'flowFluid') FLOW_STATE.fluid = v;
    else FLOW_STATE.speedUnit = v;
    paintDock();
    if (typeof renderDesignGrid === 'function') renderDesignGrid();
    return;
  }
  recomputeEstimate();
  paintDock();
}

/* v0.30.0 — Flow number fields (custom viscosity, custom target, chamber).
   Applied on change (Enter or leaving the field); bad entries snap back. */
function onFlowNum(el){
  var k = el.getAttribute('data-k'), v = parseFloat(String(el.value).replace(',', '.'));
  if (!(v > 0) || !isFinite(v)) { paintDock(); return; }
  if (k === 'tLo' && v >= FLOW_STATE.tHi) { paintDock(); return; }
  if (k === 'tHi' && v <= FLOW_STATE.tLo) { paintDock(); return; }
  if (k === 'muCustom' || k === 'tLo' || k === 'tHi' || k === 'chamberMm') FLOW_STATE[k] = v;
  paintDock();
  if (typeof renderDesignGrid === 'function') renderDesignGrid();
}

/* A run needs at least one pore filler, so the last one cannot be unticked. */
function onFillerChip(btn){
  var id = btn.getAttribute('data-filler');
  var on = !THERMAL_STATE.fillers[id];
  if (!on && thermalFillersOn().length <= 1) return;
  onThermalFillerToggle(id, on);
  paintDock();
}

/* ============================================================
   DROP-DOWNS (material, connectivity)
   ============================================================ */
function dockMaterialGroups(){
  var groups = [{ label: null, items: [{ v: F13LD_MATERIAL_RECIPE_ID, name: 'From design', sub: 'Each design keeps its own material (default Ti-6Al-4V)' }] }];
  if (typeof F13LD_MATERIALS === 'undefined') return groups;
  var cur = null;
  for (var i = 0; i < F13LD_MATERIALS.length; i++){
    var m = F13LD_MATERIALS[i];
    if (!cur || cur.label !== m.family){ cur = { label: m.family, items: [] }; groups.push(cur); }
    cur.items.push({ v: m.id, name: m.name, sub: m.condition + ' · ' + m.process + (m.crushSupported ? '' : ' · no crush') });
  }
  return groups;
}
var DOCK_CONN_GROUPS = [{ label: null, items: [
  { v: 'networks', name: 'All networks', sub: 'Every network running through the tiled cell kept; floating islands removed' },
  { v: 'largest',  name: 'Largest network only', sub: 'One side of an interwoven weave only' },
  { v: 'off',      name: 'Keep everything', sub: 'No removal (buckling still drops floating islands — they are free bodies)' }
]}];

/* v0.30.0 — shear target (19h FLOW_SHEAR_TARGETS) */
function dockShearTargetGroups(){
  var items = (typeof FLOW_SHEAR_TARGETS !== 'undefined') ? FLOW_SHEAR_TARGETS.map(function(t){ return { v: t.id, name: t.name, sub: t.sub }; }) : [];
  return [{ label: null, items: items }];
}
function ddGroups(key){ return key === 'material' ? dockMaterialGroups() : key === 'shearTarget' ? dockShearTargetGroups() : DOCK_CONN_GROUPS; }
function ddValue(key){ return key === 'material' ? MATERIAL_STATE.id : key === 'shearTarget' ? FLOW_STATE.target : GEOM_STATE.connectivity; }
function ddFind(key, v){
  var g = ddGroups(key);
  for (var i = 0; i < g.length; i++) for (var j = 0; j < g[i].items.length; j++) if (g[i].items[j].v === v) return g[i].items[j];
  return null;
}
function escHtml(s){ return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function renderDropdown(key){
  var host = document.getElementById(key + 'Dd');
  if (!host) return;
  var cur = ddFind(key, ddValue(key)) || { name: '—', sub: '' };
  var open = host.classList.contains('open');
  var label = escHtml(cur.name) + (key === 'material' && ddValue(key) !== F13LD_MATERIAL_RECIPE_ID ? '<em>' + escHtml(cur.sub.split(' · ')[0]) + '</em>' : '');
  if (key === 'shearTarget' && typeof flowShearTarget === 'function'){
    var tg = flowShearTarget(null);
    if (tg) label = escHtml(cur.name) + '<em>' + escHtml(tg.label) + '</em>';
  }
  var html = '<button type="button" class="dd-btn" onclick="toggleDropdown(\'' + key + '\', event)" aria-haspopup="listbox" aria-expanded="' + open + '" title="' + escHtml(cur.name + (cur.sub ? ' — ' + cur.sub : '')) + '">' +
    '<span class="val">' + label + '</span>' +
    '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  if (open){
    html += '<div class="dd-menu" role="listbox">';
    var groups = ddGroups(key), v = ddValue(key);
    for (var i = 0; i < groups.length; i++){
      if (groups[i].label) html += '<div class="dd-grp">' + escHtml(groups[i].label) + '</div>';
      for (var j = 0; j < groups[i].items.length; j++){
        var it = groups[i].items[j], on = it.v === v;
        html += '<button type="button" role="option" aria-selected="' + on + '" class="dd-opt' + (on ? ' on' : '') + '" onclick="pickDropdown(\'' + key + '\', \'' + it.v + '\', event)">' +
          '<span class="tick">' + (on ? DOCK_TICK : '') + '</span><span>' + escHtml(it.name) + (it.sub ? '<small>' + escHtml(it.sub) + '</small>' : '') + '</span></button>';
      }
    }
    html += '</div>';
  }
  host.innerHTML = html;
}

function toggleDropdown(key, ev){
  if (ev) ev.stopPropagation();
  var host = document.getElementById(key + 'Dd');
  var was = host && host.classList.contains('open');
  closeDropdowns();
  if (host && !was){
    host.classList.add('open');
    renderDropdown(key);
    var on = host.querySelector('.dd-opt.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
}
function pickDropdown(key, v, ev){
  if (ev) ev.stopPropagation();
  if (key === 'material') onMaterialChange(v);
  else if (key === 'conn') onConnectivityChange(v);
  else if (key === 'shearTarget'){   /* v0.30.0 — display only */
    FLOW_STATE.target = v;
    closeDropdowns(); paintDock();
    if (typeof renderDesignGrid === 'function') renderDesignGrid();
    return;
  }
  closeDropdowns();
  recomputeEstimate();
  paintDock();
  if (key === 'material' && FLOW_STATE.target === 'material' && typeof renderDesignGrid === 'function') renderDesignGrid();
}
function closeDropdowns(){
  var open = document.querySelectorAll('.dd.open');
  for (var i = 0; i < open.length; i++){
    open[i].classList.remove('open');
    renderDropdown(open[i].id.replace(/Dd$/, ''));
  }
}
function onDockDocClick(e){
  if (!e.target.closest || !e.target.closest('.dd')) closeDropdowns();
}
function onDockKey(e){
  if (e.key === 'Escape' && document.querySelector('.dd.open')) closeDropdowns();
}

/* ============================================================
   PAINT — state → every dock + drawer control
   ============================================================ */
function dockGridLabel(){ return GRID_STATE.N + '³'; }
function dockSummary(key){
  if (key === 'elastic') return dockGridLabel();
  if (key === 'buckle')  return BUCKLE_STATE.N + '³';
  if (key === 'nonlin')  return NONLIN_STATE.N + '³ · ' + Math.round(NONLIN_STATE.cap * 100) + '% · ' + (NONLIN_STATE.axis === 'all' ? 'XYZ' : NONLIN_STATE.axis.toUpperCase());
  if (key === 'thermal') return thermalFillersOn().map(function(f){ return f.id; }).join(', ') || 'no filler';
  if (key === 'flow')    return FLOW_STATE.N + '³ · ' + (FLOW_STATE.tol < 1e-6 ? 'high' : 'standard');
  if (key === 'flowReadout'){   /* the Readout fold: direction · fluid · target · units · chamber */
    var fl = FLOW_STATE.fluid === 'water' ? 'water 37 °C' : (FLOW_STATE.fluid === 'medium' ? 'medium' : FLOW_STATE.muCustom + ' mPa·s');
    var tg = 'no target', t = (typeof FLOW_SHEAR_TARGETS !== 'undefined') ? FLOW_SHEAR_TARGETS.filter(function(x){ return x.id === FLOW_STATE.target; })[0] : null;
    if (t && t.id !== 'none') tg = t.id === 'custom' ? (FLOW_STATE.tLo + '–' + FLOW_STATE.tHi + ' mPa') : t.name.toLowerCase();
    return (FLOW_STATE.dir === 'all' ? 'All' : FLOW_STATE.dir.charAt(0).toUpperCase()) + ' · ' + fl + ' · ' + tg + ' · ' + (FLOW_STATE.speedUnit === 'm' ? 'm/s' : 'mm/s') + ' · ' + FLOW_STATE.chamberMm + ' mm';
  }
  return '';
}
function dockMaterialShort(){
  if (MATERIAL_STATE.id === F13LD_MATERIAL_RECIPE_ID) return 'From design';
  var m = (typeof findMaterial === 'function') ? findMaterial(MATERIAL_STATE.id) : null;
  return m ? m.name : 'From design';
}

function paintSegGroup(group, value){
  var g = document.querySelector('.seg[data-seg="' + group + '"]');
  if (!g) return;
  var bs = g.querySelectorAll('button');
  for (var i = 0; i < bs.length; i++){
    var on = bs[i].getAttribute('data-v') === String(value);
    bs[i].classList.toggle('on', on);
    bs[i].setAttribute('aria-pressed', on);
  }
}

function paintDock(){
  if (!document.getElementById('dock')) return;
  labSaveSettings();   /* v0.24.0 — every change goes through here */
  var i, el, els;
  /* segmented controls */
  paintSegGroup('grid', GRID_STATE.N);
  paintSegGroup('buckleN', BUCKLE_STATE.N);
  paintSegGroup('nonlinN', NONLIN_STATE.N);
  paintSegGroup('cap', NONLIN_STATE.cap);
  paintSegGroup('axis', NONLIN_STATE.axis);
  paintSegGroup('pv', GEOM_STATE.partialVolume ? 'pv' : 'binary');
  paintSegGroup('flowN', FLOW_STATE.N);
  paintSegGroup('flowTol', FLOW_STATE.tol < 1e-6 ? 'high' : 'std');
  /* v0.30.0 — wall shear settings */
  paintSegGroup('flowDir', FLOW_STATE.dir);
  paintSegGroup('flowFluid', FLOW_STATE.fluid);
  paintSegGroup('flowUnit', FLOW_STATE.speedUnit);
  els = document.querySelectorAll('input[data-k]');
  for (i = 0; i < els.length; i++){
    if (els[i] === document.activeElement) continue;
    var fk = els[i].getAttribute('data-k');
    if (FLOW_STATE[fk] != null) els[i].value = +(+FLOW_STATE[fk]).toPrecision(4);
  }
  el = document.getElementById('flowMuRow');     if (el) el.style.display = FLOW_STATE.fluid === 'custom' ? '' : 'none';
  el = document.getElementById('flowTargetRow'); if (el) el.style.display = FLOW_STATE.target === 'custom' ? '' : 'none';
  renderDropdown('shearTarget');
  /* switches + on/off styling (tabs, panes) */
  els = document.querySelectorAll('[data-phys-sw]');
  for (i = 0; i < els.length; i++){
    var on = !!PHYS_STATE[els[i].getAttribute('data-phys-sw')];
    els[i].classList.toggle('on', on);
    els[i].setAttribute('aria-checked', on);
  }
  els = document.querySelectorAll('[data-phys-state]');
  for (i = 0; i < els.length; i++) els[i].classList.toggle('off', !PHYS_STATE[els[i].getAttribute('data-phys-state')]);
  /* filler chips */
  els = document.querySelectorAll('.chip[data-filler]');
  for (i = 0; i < els.length; i++){
    var fon = !!THERMAL_STATE.fillers[els[i].getAttribute('data-filler')];
    els[i].classList.toggle('on', fon);
    els[i].setAttribute('aria-pressed', fon);
  }
  /* drop-downs */
  renderDropdown('material');
  renderDropdown('conn');
  /* folds: one-line summary in every header ("off" when the mode does not run), open state */
  for (i = 0; i < DOCK_MODES.length; i++){
    var md = DOCK_MODES[i];
    el = document.querySelector('[data-fold-sum="' + md.key + '"]');
    if (el) el.textContent = PHYS_STATE[md.key] ? dockSummary(md.key) : 'off';
  }
  el = document.querySelector('[data-fold-sum="flowReadout"]');
  if (el) el.textContent = dockSummary('flowReadout');
  paintFolds();
}
