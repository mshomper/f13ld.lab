/* ============================================================
   F13LD.lab · 53b-lab-shell.js  (UI refresh stage 2)
   Lab's glue for the new shell (53-layout.js is the template, unchanged):
     · wraps renderDesignGrid so every render also
         - marks the selected card (phone: one design at a time) and builds the A / B / C switch,
         - fills the Results table (phone sheet),
         - builds the thermal / flow view row once (labViewToolsBuild),
     · labShellResized() — the layout changed size (F13UI.onResize),
     · starts on the Model section.
   No UI work here touches the solver or worker files (13–17c).
   Mobile rules (brand guidelines): function declarations, var — no arrow functions, classes or modules.
   ============================================================ */

var LAB_SHELL = { sel: 0, resKey: '' };

function labShellPhone(){ return !!(window.F13UI && F13UI.isPhone && F13UI.isPhone()); }
function labShellEsc(s){ return (typeof _dcEsc === 'function') ? _dcEsc(s) : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

/* ── Phone: one design at a time ───────────────────────────── */
function labShellDesigns(){ return (typeof LAB_STATE !== 'undefined' && LAB_STATE.designs) ? LAB_STATE.designs.slice(0, 3) : []; }

function labShellDesignSwitch(){
  var host = document.getElementById('designSw');
  if (!host) return;
  var ds = labShellDesigns(), h = '', i;
  if (LAB_SHELL.sel >= ds.length) LAB_SHELL.sel = Math.max(0, ds.length - 1);
  for (i = 0; i < ds.length; i++){
    var on = i === LAB_SHELL.sel, L = (typeof dletter === 'function') ? dletter(ds[i], i) : String.fromCharCode(65 + i);
    h += '<button type="button" class="vw-dbtn' + (on ? ' on' : '') + '" aria-pressed="' + on + '" aria-label="Design ' + L + '" title="' + labShellEsc(ds[i].title) + '" onclick="labShellPickDesign(' + i + ')">' + L + '</button>';
  }
  host.innerHTML = h;
  host.hidden = !(ds.length > 1);   /* CSS shows it on phones only */
}
function labShellMarkCards(){
  var grid = document.getElementById('compareGrid');
  if (!grid) return;
  var cards = grid.children, i;
  for (i = 0; i < cards.length; i++) cards[i].classList.toggle('vsel', i === LAB_SHELL.sel);
}
function labShellPickDesign(i){
  LAB_SHELL.sel = i;
  labShellDesignSwitch();
  labShellMarkCards();
  /* the newly shown tile has a size now: redraw the tiles (no grid rebuild) */
  if (typeof LAB_RM_REGISTRY !== 'undefined') for (var k in LAB_RM_REGISTRY){ var r = LAB_RM_REGISTRY[k]; if (r) r._dirty = true; }
}

/* ── Results table (phone): metric | A | B | C ──────────────── */
function labResultsHtml(){
  var ds = labShellDesigns();
  if (!ds.length) return '<p class="res-empty">No designs loaded.</p>';
  if (typeof statsForDesign !== 'function') return '';
  var mode = VIEW_STATE.mode === 'deform' ? 'stress' : VIEW_STATE.mode;
  var rows = [], idx = {}, ci, si;
  for (ci = 0; ci < ds.length; ci++){
    var st = [];
    try { st = statsForDesign(ds[ci], mode) || []; } catch (e) { st = []; }
    var g = '';
    for (si = 0; si < st.length; si++){
      var s = st[si];
      if (s.group){ g = s.group; continue; }
      var key = g + '\u0001' + s.lbl;
      if (!(key in idx)){ idx[key] = rows.length; rows.push({ lbl: s.lbl, grp: g, tip: s.tip, cells: [] }); }
      rows[idx[key]].cells[ci] = s;
    }
  }
  if (!rows.length) return '<p class="res-empty">Nothing to show on this tab yet. Run to fill it.</p>';
  var h = '<table class="res-tab"><thead><tr><th scope="col">Metric</th>', lastG = null, ri, cj;
  for (ci = 0; ci < ds.length; ci++) h += '<th scope="col" title="' + labShellEsc(ds[ci].title) + '">' + ((typeof dletter === 'function') ? dletter(ds[ci], ci) : String.fromCharCode(65 + ci)) + '</th>';
  h += '</tr></thead><tbody>';
  for (ri = 0; ri < rows.length; ri++){
    var row = rows[ri];
    if (row.grp !== lastG){ lastG = row.grp; if (row.grp) h += '<tr class="res-grp"><th colspan="' + (ds.length + 1) + '" scope="colgroup">' + labShellEsc(row.grp) + '</th></tr>'; }
    h += '<tr><th scope="row"' + (row.tip ? ' title="' + labShellEsc(row.tip) + '"' : '') + '>' + row.lbl + '</th>';
    for (cj = 0; cj < ds.length; cj++){
      var c = row.cells[cj];
      if (!c){ h += '<td class="na">—</td>'; continue; }
      var wraw = c.warn || ((c.delta && c.delta[1] === 'warn') ? c.delta[0] : ''), wtxt = wraw ? String(wraw).replace(/<[^>]*>/g, '').replace(/"/g, '&quot;') : '';
      var dtxt = (c.delta && c.delta[0] && !(c.delta[1] === 'warn')) ? '<span class="rd ' + (c.delta[1] || 'neut') + '">' + c.delta[0] + '</span>' : '';
      h += '<td><span class="rv' + (c.valcls ? ' ' + c.valcls : '') + '">' + c.val + '</span>' +
        (wtxt ? '<button type="button" class="rwm" aria-label="Warning: ' + wtxt + '" title="' + wtxt + '" onclick="this.closest(\'td\').classList.toggle(\'show-warn\')">' + (typeof LAB_WARN_ICON !== 'undefined' ? LAB_WARN_ICON : '!') + '</button>' : '') +
        dtxt + (wtxt ? '<span class="rd warn rwt">' + wtxt + '</span>' : '') + '</td>';
    }
    h += '</tr>';
  }
  return h + '</tbody></table>';
}
function labResultsPaint(){
  var host = document.getElementById('resTable');
  if (!host || !labShellPhone()) return;   /* desktop keeps the numbers on the cards */
  host.innerHTML = labResultsHtml();
}

/* ── Shared view tools (thermal / flow): once, in the viewer row ── */
function labAnyData(map){
  if (typeof map === 'undefined' || !map) return false;
  var ds = labShellDesigns();
  for (var i = 0; i < ds.length; i++){ var r = map[ds[i].id]; if (r && !r.error) return true; }
  return false;
}
function labViewToolsBuild(){
  var host = document.getElementById('viewToolsDyn');
  if (!host) return;
  var mode = VIEW_STATE.mode, h = '';
  if (mode === 'thermal' && labAnyData(typeof THERMAL_BY_DESIGN !== 'undefined' ? THERMAL_BY_DESIGN : null) && typeof buildThermalControl === 'function'){
    h = buildThermalControl();
    if (VIEW_STATE.thermalView !== 'kappa' && typeof buildClipPills === 'function') h += '<div class="vw-grp"><span class="vw-l">section</span>' + buildClipPills() + '</div>';
  } else if (mode === 'flow' && labAnyData(typeof FLOW_BY_DESIGN !== 'undefined' ? FLOW_BY_DESIGN : null) && typeof buildFlowControl === 'function'){
    h = buildFlowControl();
    var fv = VIEW_STATE.flowView;
    if ((fv === 'particles' || fv === 'speed' || fv === 'shear') && typeof buildClipPills === 'function') h += '<div class="vw-grp"><span class="vw-l">section</span>' + buildClipPills() + '</div>';
  }
  host.innerHTML = h;
  host.classList.toggle('show', !!h);
  if (h && typeof labUpdateClipPills === 'function') labUpdateClipPills();
}

/* ── After every grid render ─────────────────────────────── */
function labShellAfterGrid(){
  labShellDesignSwitch();
  labShellMarkCards();
  labViewToolsBuild();
  labResultsPaint();
}
(function(){
  if (typeof renderDesignGrid !== 'function') return;
  var orig = renderDesignGrid;
  renderDesignGrid = function(){
    var r = orig.apply(this, arguments);
    try { labShellAfterGrid(); } catch (e) { console.error('[shell]', e); }
    return r;
  };
})();

/* ── The layout changed (breakpoint, sheet) ──────────────── */
function labShellResized(){
  var UI = window.F13UI, phone = labShellPhone();
  /* Results exists on the phone only; leaving it on a wide screen goes back to Model */
  if (!phone && UI && UI.active === 'results' && UI.showSection) UI.showSection('model');
  labShellDesignSwitch();
  if (phone) labResultsPaint();
  /* Plotly plots (Crush, Flow charts) take their size from the viewer */
  if (window.Plotly && Plotly.Plots && Plotly.Plots.resize){
    var gds = document.querySelectorAll('#mergedView .js-plotly-plot');
    for (var i = 0; i < gds.length; i++) { try { Plotly.Plots.resize(gds[i]); } catch (e) {} }
  }
}

/* start on Model (Results is the phone's first tab but has nothing before a run) */
if (window.F13UI && F13UI.showSection) F13UI.showSection('model');
