/* ============================================================
   F13LD.lab · 51-dock.js  (v0.22.0)
   Bottom dock + Configure drawer (replaces the v0.21 controls panel).

   The dock is one row: Configure · a tag per run setting (Model, Elastic,
   Buckling, Crush, Thermal κ) · designs / estimate / hardware · Run.
   Configure (or any tag) opens a drawer that slides up over the cards —
   it does not resize them, so the viewports never stretch or re-render.
   The drawer has a tab per physics mode with its on/off switch and only
   that mode's settings, each with the help text the old pills hid in
   hover tooltips.

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
  /* planned — fluids (LBM wall shear): streamlines around a strut */
  fluid:   '<circle cx="20" cy="20" r="5.5"' + LAB_ICON_SV + '/><path d="M3 12 C 12 12, 14 8.5, 20 8.5 S 29 12, 37 12 M3 28 C 12 28, 14 31.5, 20 31.5 S 29 28, 37 28 M3 20 H10 M30 20 H37"' + LAB_ICON_SV + ' stroke-width="2.2"/><circle class="acc" cx="25.5" cy="16" r="2.8"/>'
};
function labIconSvg(name){ return '<svg viewBox="0 0 40 40" aria-hidden="true">' + (LAB_ICONS[name] || '') + '</svg>'; }

/* Run-button markup the solver code paints through (50-controls.js). */
var DOCK_RUN_IDLE    = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z" fill="currentColor"/></svg>Run all';
var DOCK_RUN_RERUN   = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z" fill="currentColor"/></svg>Re-run';
var DOCK_RUN_CANCEL  = '<svg class="dock-spin" width="15" height="15" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L34 11 L34 29 L20 37 L6 29 L6 11 Z" fill="none" stroke="#2c4e30" stroke-width="2.5"/><g class="arcs"><path d="M20 5 A15 15 0 0 1 34 18" fill="none" stroke="#c8f542" stroke-width="3.5" stroke-linecap="round"/><path d="M20 35 A15 15 0 0 1 6 22" fill="none" stroke="#1D9E75" stroke-width="3.5" stroke-linecap="round"/></g><circle cx="20" cy="20" r="3.4" fill="#c8f542"/></svg>Cancel';
var DOCK_RUN_DONE    = '✓ Run complete';

var DOCK_MODES = [
  { key: 'elastic', name: 'Elastic' },
  { key: 'buckle',  name: 'Buckling' },
  { key: 'nonlin',  name: 'Crush' },
  { key: 'thermal', name: 'Thermal κ' }
];

/* Drawer open/tab — a per-viewer convenience only (try/catch). */
var DOCK_STATE = { open: false, tab: 'model' };
var DOCK_STORE_KEY = 'f13ld.lab.dock.v1';

/* ============================================================
   INIT
   ============================================================ */
function initDock(){
  try {
    var saved = JSON.parse(localStorage.getItem(DOCK_STORE_KEY) || 'null');
    if (saved && typeof saved === 'object'){
      DOCK_STATE.open = !!saved.open;
      if (document.querySelector('.dr-pane[data-pane="' + saved.tab + '"]')) DOCK_STATE.tab = saved.tab;
    }
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
  try { localStorage.setItem(DOCK_STORE_KEY, JSON.stringify({ open: DOCK_STATE.open, tab: DOCK_STATE.tab })); } catch (e) {}
}

/* ============================================================
   DRAWER
   ============================================================ */
function toggleDrawer(force){
  DOCK_STATE.open = (typeof force === 'boolean') ? force : !DOCK_STATE.open;
  closeDropdowns();
  saveDockState();
  paintDock();
}
function onDrawerTab(tab){
  DOCK_STATE.tab = tab;
  saveDockState();
  paintDock();
}
/* A dock tag opens the drawer at its tab; the same tag again closes it. */
function onDockTag(tab){
  if (DOCK_STATE.open && DOCK_STATE.tab === tab) DOCK_STATE.open = false;
  else { DOCK_STATE.tab = tab; DOCK_STATE.open = true; }
  closeDropdowns();
  saveDockState();
  paintDock();
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
    if (v === 'auto'){ GRID_STATE.mode = 'auto'; GRID_STATE.N = autoPickGrid(); }
    else { GRID_STATE.mode = 'manual'; GRID_STATE.N = +v; }
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
  }
  recomputeEstimate();
  paintDock();
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

function ddGroups(key){ return key === 'material' ? dockMaterialGroups() : DOCK_CONN_GROUPS; }
function ddValue(key){ return key === 'material' ? MATERIAL_STATE.id : GEOM_STATE.connectivity; }
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
          '<span class="tick">' + (on ? '✓' : '') + '</span><span>' + escHtml(it.name) + (it.sub ? '<small>' + escHtml(it.sub) + '</small>' : '') + '</span></button>';
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
  closeDropdowns();
  recomputeEstimate();
  paintDock();
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
function dockGridLabel(){ return GRID_STATE.mode === 'auto' ? 'Auto · ' + GRID_STATE.N + '³' : GRID_STATE.N + '³'; }
function dockSummary(key){
  if (key === 'elastic') return dockGridLabel();
  if (key === 'buckle')  return BUCKLE_STATE.N + '³';
  if (key === 'nonlin')  return NONLIN_STATE.N + '³ · ' + Math.round(NONLIN_STATE.cap * 100) + '% · ' + (NONLIN_STATE.axis === 'all' ? 'XYZ' : NONLIN_STATE.axis.toUpperCase());
  if (key === 'thermal') return thermalFillersOn().map(function(f){ return f.id; }).join(' · ') || 'no filler';
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
  var i, el, els;
  /* segmented controls */
  paintSegGroup('grid', GRID_STATE.mode === 'auto' ? 'auto' : GRID_STATE.N);
  paintSegGroup('buckleN', BUCKLE_STATE.N);
  paintSegGroup('nonlinN', NONLIN_STATE.N);
  paintSegGroup('cap', NONLIN_STATE.cap);
  paintSegGroup('axis', NONLIN_STATE.axis);
  paintSegGroup('pv', GEOM_STATE.partialVolume ? 'pv' : 'binary');
  el = document.getElementById('gridAutoVal');
  if (el) el.textContent = (typeof autoPickGrid === 'function' ? autoPickGrid() : GRID_STATE.N) + '³';
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
  el = document.getElementById('drModelVal');
  if (el) el.textContent = MATERIAL_STATE.id === F13LD_MATERIAL_RECIPE_ID ? 'per design' : dockMaterialShort().split(' (')[0];
  /* drawer */
  var dr = document.getElementById('cfgDrawer');
  if (dr) dr.classList.toggle('open', DOCK_STATE.open);
  el = document.getElementById('cfgBtn');
  if (el){ el.classList.toggle('open', DOCK_STATE.open); el.setAttribute('aria-expanded', DOCK_STATE.open); }
  els = document.querySelectorAll('.dr-tab');
  for (i = 0; i < els.length; i++) els[i].classList.toggle('on', els[i].getAttribute('data-tab') === DOCK_STATE.tab);
  els = document.querySelectorAll('.dr-pane');
  for (i = 0; i < els.length; i++) els[i].classList.toggle('on', els[i].getAttribute('data-pane') === DOCK_STATE.tab);
  /* dock tags */
  var tags = document.getElementById('dockTags');
  if (tags){
    var h = '<button type="button" class="dock-tag" onclick="onDockTag(\'model\')" title="Material and voxel prep"><span class="ico ico-sm mdl">' + labIconSvg('model') + '</span><b>' + escHtml(dockMaterialShort()) + '</b></button>';
    for (i = 0; i < DOCK_MODES.length; i++){
      var md = DOCK_MODES[i], mon = !!PHYS_STATE[md.key];
      h += '<button type="button" class="dock-tag' + (mon ? '' : ' off') + '" onclick="onDockTag(\'' + md.key + '\')" title="' + md.name + (mon ? ' — runs' : ' — off') + '">' +
        '<span class="ico ico-sm">' + labIconSvg(md.key) + '</span><b>' + md.name + '</b>' + (mon ? escHtml(dockSummary(md.key)) : 'off') + '</button>';
    }
    tags.innerHTML = h;
  }
}
