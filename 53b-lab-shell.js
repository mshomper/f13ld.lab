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
      var none = /^\s*(—|–|-)\s*$/.test(String(c.val == null ? '' : c.val).replace(/<[^>]*>/g, ''));   /* nothing computed yet: just the dash, one line */
      var dtxt = (!none && c.delta && c.delta[0] && !(c.delta[1] === 'warn')) ?'<span class="rd ' + (c.delta[1] || 'neut') + '">' + c.delta[0] + '</span>' : '';
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

/* ── Phone chrome budget (Matt, click test): header 40 px, VIEW tabs 32 px, one sub-control row 32 px ──
   Phone (< 900 px): the existing elements MOVE (ids and handlers kept), each leaving a comment marker so the desktop layout comes back:
     · import / sweep / atlas / PDF / Mesh go into one ⋯ overflow menu (#hdrMore, #hdrMenu) in the header,
     · the A / B / C switch (#designSw) and the status chip (#labStatus, drawn as a dot) sit in the header's left group. */
var LAB_CHROME = { phone: null, marks: [], menuIds: ['importStlBtn', 'sweepBtn', 'atlasBtn', 'exportPdfBtn', 'meshHandoffBtn'] };
var LAB_CHROME_PEEK = 0.34;   // the 56 px tab bar (was 84) gives the sheet 28 px back, so the peek can be shorter
function labChromeBuildMenu(){
  var right = document.querySelector('.f13ld-header .fh-right');
  if (!right || document.getElementById('hdrMore')) return;
  var more = document.createElement('button');
  more.type = 'button'; more.id = 'hdrMore'; more.className = 'fh-action-btn ghost fh-more';
  more.setAttribute('aria-label', 'More actions'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.title = 'More actions';
  more.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><circle cx="3.2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.8" cy="8" r="1.4"/></svg>';
  var menu = document.createElement('div');
  menu.id = 'hdrMenu'; menu.className = 'hdr-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
  right.appendChild(more);
  document.querySelector('.f13ld-header').appendChild(menu);
  function close(){ menu.hidden = true; more.setAttribute('aria-expanded', 'false'); }
  more.addEventListener('click', function(e){ e.stopPropagation(); menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); });
  menu.addEventListener('click', function(e){ if (e.target.closest && e.target.closest('button')) setTimeout(close, 0); });
  document.addEventListener('click', function(e){ if (!menu.hidden && !menu.contains(e.target)) close(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !menu.hidden){ close(); more.focus(); } });
  window.labHdrMenuClose = close;
}
function labChromeMove(id, target){
  var el = document.getElementById(id);
  if (!el || !target) return;
  var mk = document.createComment(id);
  el.before(mk);
  LAB_CHROME.marks.push({ id: id, mk: mk });
  target.appendChild(el);
}
function labChromeSync(){
  var phone = labShellPhone() || window.innerWidth < 900;
  if (phone === LAB_CHROME.phone) return;
  LAB_CHROME.phone = phone;
  labChromeBuildMenu();
  var menu = document.getElementById('hdrMenu'), left = document.querySelector('.f13ld-header .fh-left');
  if (phone){
    LAB_CHROME.menuIds.forEach(function(id){ labChromeMove(id, menu); });
    labChromeMove('labStatus', left);
    labChromeMove('designSw', left);
  } else {
    LAB_CHROME.marks.forEach(function(m){ var el = document.getElementById(m.id); if (el && m.mk.parentNode) m.mk.replaceWith(el); });
    LAB_CHROME.marks = [];
    if (menu) menu.hidden = true;
  }
  document.documentElement.classList.toggle('lab-phone', phone);
  if (window.F13UI){
    F13UI.peekRatio = phone ? LAB_CHROME_PEEK : 0.45;
    if (phone && F13UI.setSheet && F13UI.sheetState && F13UI.sheetState() === 'peek') F13UI.setSheet('peek');   /* layout.js already set its --sheet-h from 0.45 */
  }
  /* the status chip's words live on its title (the dot has no text) */
  labChromeStatusTitle();
}
function labChromeStatusTitle(){
  var s = document.getElementById('labStatus'), t = document.getElementById('solverPill');
  if (s && t) s.title = t.textContent;
}
(function(){
  var t = document.getElementById('solverPill');
  if (t && window.MutationObserver) new MutationObserver(labChromeStatusTitle).observe(t, { childList: true, characterData: true, subtree: true });
  /* a running sweep or an Atlas ready count shows on the ⋯ button, since their own buttons are in the menu */
  function badge(){
    var more = document.getElementById('hdrMore'); if (!more) return;
    var sw = document.getElementById('sweepBtn');
    more.classList.toggle('busy', !!(sw && (sw.classList.contains('sw-running'))));
  }
  var sw = document.getElementById('sweepBtn');
  if (sw && window.MutationObserver) new MutationObserver(badge).observe(sw, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', labChromeSync);
  labChromeSync();
  /* html.sheet-full while the phone sheet is open wide: the Results table shows its delta lines there, one line per row in the peek */
  var pane = document.getElementById('ctrlPane');
  function sheetClass(){
    var full = !!(window.F13UI && F13UI.sheetState && F13UI.sheetState() === 'full');
    document.documentElement.classList.toggle('sheet-full', full);
  }
  if (pane && window.MutationObserver){ new MutationObserver(sheetClass).observe(pane, { attributes: true, attributeFilter: ['style'] }); }
  sheetClass();
})();

/* start on Model (Results is the phone's first tab but has nothing before a run) */
if (window.F13UI && F13UI.showSection) F13UI.showSection('model');
