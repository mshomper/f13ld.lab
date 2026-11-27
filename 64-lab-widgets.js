/* ============================================================================
   F13LD.lab · 64-lab-widgets.js — UI refresh stage 3: the liquid widgets the wire (54-f13ui-wire.js CONFIG) does not
   mount by itself, and the one-bar run. Pattern: the template README, "Controls the app rebuilds" (F13LD.mesh 59-mesh-widgets.js).

   Every widget drives the app through its NATIVE control (set the value and dispatch input / change, or click the native
   button), so the app's own handlers run. The app reaches the widget through a value / checked override on the native
   element (mirror) or a MutationObserver on the native button. The mounts are the kit wire's F13UI.mount.*.

   Rows the app rebuilds by innerHTML (cards, geometry row, thermal / flow row, crush header and scrubber, sweep, atlas, import)
   are not wrapped one render function at a time: one MutationObserver (a microtask, so before the next paint) scans what was
   added, places the help (i) buttons first (65-help.js refresh), then mounts widgets on the fresh natives. A widget whose host
   left the DOM is destroyed on the next scan, so the page keeps one set of live widgets (the kit shares one WebGL context).

   The wire mounts: rail and tab bar (Results is rebuilt out of the desktop rail here), the three model dropdowns, Run all
   (progress from here), the section plane radio.  Mounted here (UI.ready): view tabs, stress scale, pores filled with, the
   particle toggle and sliders, the five run toggles, grid / cap / axis / flow segmented rows, filler chips, the view menu.
   No UI code goes in the worker or solver files (13-17c).
   ============================================================================ */
(function(){
  'use strict';
  var UI = window.F13UI = window.F13UI || {};

  /* ── drawn icons used by the app's own markup (40 / 61 / 62 call them at render time) ── */
  var SV = ' viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  if (typeof LAB_CARD_ICONS !== 'undefined'){
    LAB_CARD_ICONS.reset = '<svg' + SV + '><path d="M13 8.2 A5 5 0 1 1 11.3 4.4"/><path d="M11.8 1.8 V4.8 H8.8"/></svg>';
    LAB_CARD_ICONS.edit  = '<svg' + SV + '><path d="M10.6 2.6 L13.4 5.4 L5.6 13.2 H2.8 V10.4 Z"/><path d="M9 4.2 L11.8 7"/></svg>';
    LAB_CARD_ICONS.play  = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z" fill="currentColor"/></svg>';
    LAB_CARD_ICONS.pause = '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.8" y="1" width="2.4" height="8" rx=".6" fill="currentColor"/><rect x="5.8" y="1" width="2.4" height="8" rx=".6" fill="currentColor"/></svg>';
    LAB_CARD_ICONS.sliders = '<svg' + SV + '><path d="M2.5 5 H13.5 M2.5 11 H13.5"/><circle cx="6" cy="5" r="1.8"/><circle cx="10.5" cy="11" r="1.8"/></svg>';
  }

  /* the wire's own message path (a hidden control, a note): a short note over the viewer */
  var noteTimer = 0;
  UI.message = function(t){
    var n = document.getElementById('labNote');
    if (!n){ n = document.createElement('div'); n.id = 'labNote'; n.className = 'lab-note'; n.setAttribute('role', 'status'); document.body.appendChild(n); }
    n.textContent = t; n.classList.add('on');
    clearTimeout(noteTimer); noteTimer = setTimeout(function(){ n.classList.remove('on'); }, 4200);
  };
  /* a tap on a card warning's flag shows its text (touch cannot read a title) */
  document.addEventListener('click', function(e){
    var f = e.target.closest && e.target.closest('.cp-flag');
    if (f && f.title) UI.message(f.title);
  });

  /* ── the model dropdowns: the native <select>s are the widgets' state; the app paints the .dd menus and the state is
        copied across after each paint (51 renderDropdown). ── */
  (function(){
    var sel = document.getElementById('shearTargetSel');
    if (sel && typeof FLOW_SHEAR_TARGETS !== 'undefined' && !sel.options.length)
      sel.innerHTML = FLOW_SHEAR_TARGETS.map(function(t){ return '<option value="' + t.id + '">' + t.name + '</option>'; }).join('');
    function sync(key){
      var s = document.getElementById(key + 'Sel');
      if (s && typeof ddValue === 'function'){ var v = String(ddValue(key)); if (s.value !== v) s.value = v; }
    }
    if (typeof renderDropdown === 'function'){
      var rd = renderDropdown;
      window.renderDropdown = function(key){ var r = rd.apply(this, arguments); try { sync(key); } catch (e) {} return r; };
    }
  })();

  /* ── one bar per run (Matt, mesh click test): the stage and the time left sit on the Run all button, Cancel beside it.
        The progress row, the chip's bar and the button spinner are hidden under html.f13w (f13ui.css) and stay as the fallback. ── */
  var RUNUI = { active: false, mode: '', letter: '', p: 0 };
  function runLabel(){
    if (!RUNUI.active) return;
    var left = (RUN_STATE.estTotalSec > 0 && RUNUI.p < 1) ? formatClock(RUN_STATE.estTotalSec * (1 - RUNUI.p)) + ' left' : '';
    UI.run.label([RUNUI.mode, RUNUI.letter, left].filter(Boolean).join(' · ') || 'Running');
  }
  function cancelBtn(on){
    var b = document.getElementById('cancelBtn');
    if (b){ b.hidden = !on; b.classList.toggle('on', !!on); }
  }
  function wrapGlobal(name, after, before){
    var f = window[name]; if (typeof f !== 'function') return;
    window[name] = function(){
      var ctx = before ? before() : null, r = f.apply(this, arguments);
      try { after(ctx, arguments); } catch (e) { console.error('[lab-widgets]', e); }
      return r;
    };
  }
  wrapGlobal('paintRunStatus', function(_, a){
    if (!RUNUI.active) return;
    var t = String(a[0] || '').replace(/<[^>]*>/g, ''), m = t.match(/^(Elastic|Nonlinear|Buckling|Thermal|Flow)/), d = t.match(/Design ([A-Z])/);
    if (m){ RUNUI.mode = m[1] === 'Nonlinear' ? 'Crush' : m[1]; RUNUI.letter = d ? d[1] : ''; }
    runLabel();
  });
  wrapGlobal('paintRunProgress', function(_, a){
    RUNUI.p = +a[0] || 0;
    if (RUNUI.active){ UI.run.progress(RUNUI.p); runLabel(); }
  });
  window.labStatusProgress = function(){};           /* the chip keeps its state text; its bar and "solving · 33 %" are the duplicates */
  wrapGlobal('startRun', function(){
    RUNUI.active = true; RUNUI.mode = ''; RUNUI.letter = ''; RUNUI.p = 0;
    cancelBtn(true);
    UI.run.progress(null); UI.run.label('Running');
    if (UI.onAnalyze) UI.onAnalyze('running');
  });
  function runEnded(ok){
    if (!RUNUI.active) return;
    RUNUI.active = false; cancelBtn(false);
    UI.run.done(ok);
    if (ok && UI.onAnalyze) UI.onAnalyze('new');
  }
  wrapGlobal('finishRun', function(){ if (!RUN_STATE.running) runEnded(true); });
  wrapGlobal('cancelRun', function(){ runEnded(false); });
  wrapGlobal('finishRunFailed', function(){ runEnded(false); });

  /* ── the lab section plane: the app tells the radio when the axis changes ── */
  ['labUpdateClipPills', 'flowEnsureClip'].forEach(function(n){
    wrapGlobal(n, function(){ if (UI.onClipChange && typeof LAB_CLIP !== 'undefined') UI.onClipChange(LAB_CLIP.axis); });
  });

  /* ── what the app rebuilds by innerHTML: one observer on the page (a microtask, so before the next paint). The help (i)
        buttons follow every rebuild, also without WebGL; the widgets mount once the wire has (scanFn, set below). ── */
  var scanFn = null;
  var OVERLAYS = '#compareGrid, #viewToolsDyn, #geomViewRow, #mergedView, #swOverlay, #atOverlay, .imp-overlay, #resTable';
  function helpRefresh(){ if (window.F13Help) try { window.F13Help.refresh(); } catch (e) { console.error(e); } }
  new MutationObserver(function(recs){
    var roots = [];
    recs.forEach(function(r){
      if (!r.addedNodes.length) return;
      for (var i = 0; i < r.addedNodes.length; i++){
        var n = r.addedNodes[i];
        if (n.nodeType !== 1 || n.tagName === 'CANVAS' || (n.closest && n.closest('[class*="lq-"],.f13w-seg,.f13w-dd,.f13w-slider,.f13w-tg,.f13w-rail,.f13w-bar,.lab-segrow,.sw-pb'))) continue;
        if ((n.closest && n.closest(OVERLAYS)) || (n.matches && n.matches(OVERLAYS)) || (n.querySelector && n.querySelector(OVERLAYS))) roots.push(n);
      }
    });
    if (!roots.length) return;
    helpRefresh();
    if (scanFn) scanFn(roots);
  }).observe(document.body, { childList: true, subtree: true });

  /* ============================================================================ the widgets, once the wire has mounted */
  UI.ready(function(W){
    var M = UI.mount, $ = function(id){ return document.getElementById(id); }, html = document.documentElement;
    var css = getComputedStyle(html);
    function tok(name, fb){ var m = css.getPropertyValue(name).match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/); return m ? { L: +m[1], C: +m[2], h: +m[3] } : fb; }
    var ACC = tok('--accent', Liquid.ACCENTS.lime);
    var fire = function(el, type){ el.dispatchEvent(new Event(type, { bubbles: true })); };
    var isOn = function(b){ return b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true'; };
    var isActive = function(b){ return b.classList.contains('active'); };
    var txt = function(el){ return (el && el.textContent || '').replace(/\s+/g, ' ').trim(); };

    /* ---- live widgets: destroyed once their host leaves the DOM (a rebuild removes it) ---- */
    var live = new Set();
    function reg(m){ if (m) live.add(m); return m; }
    function sweepLive(){
      live.forEach(function(m){
        if (!m.host.isConnected){ live.delete(m); try { m.destroy(); } catch (e) {} }
      });
    }
    W.labLive = function(){ return live.size; };

    /* ---- segmented over native buttons ---- */
    function segW(btns){                              /* equal segments: width from the longest label */
      var mx = 0; btns.forEach(function(b){ mx = Math.max(mx, txt(b).length); });
      return Math.max(46, Math.round(mx * 7.6 + 24)) * btns.length + 10;
    }
    /* o: group (hidden when every child is an option), btns, label (shown beside the widget), on, width, labelKeep (group stays: its label does) */
    function seg(o){
      var btns = [].slice.call(o.btns); if (btns.length < 2) return null;
      var wrap = null, host = document.createElement('div'), anchor = o.group || btns[0];
      if (o.label && o.showLabel){
        wrap = document.createElement('div'); wrap.className = 'lab-segrow';
        var s = document.createElement('span'); s.className = 'lab-segl'; s.textContent = o.label;
        wrap.append(s, host); (o.group || btns[0]).before(wrap);
      } else (o.group || btns[0]).before(host);
      if (o.width) { host.style.width = segW(btns) + 'px'; host.style.maxWidth = '100%'; host.style.flex = '0 1 auto'; }
      var m = M.segmented(o.group || null, btns, { host: host, on: o.on, ariaLabel: o.label || '' });
      if (!o.group) btns.forEach(function(b){ b.setAttribute('data-native', 'seg'); });
      var root = wrap || host;
      return { host: root, w: m.w, destroy: function(){ m.destroy(); if (wrap) wrap.remove(); else host.remove(); } };
    }
    /* a switch (aria-checked / aria-pressed button) */
    function tog(nat, label, cls){
      var m = M.toggle(nat, { label: label, ariaLabel: nat.getAttribute('aria-label') || label, cls: cls || '' });
      m.host.addEventListener('click', function(){ setTimeout(function(){ try { m.w.set(nat.getAttribute('aria-checked') === 'true' || nat.getAttribute('aria-pressed') === 'true'); } catch (e) {} }, 40); });   /* the app may refuse (the last filler) */
      return m;
    }
    /* a native range */
    function rng(inp, c){
      c = c || {};
      var box = c.box || inp.parentElement;
      var m = M.slider(inp, { box: box, row: box, label: c.label || inp.getAttribute('aria-label') || '', fmt: c.fmt, format: c.format, detents: c.detents, inline: c.inline, push: c.push });
      if (c.inline && c.il) box.style.setProperty('--f13w-il', c.il + 'px');
      if (inp.disabled) m.w.setDisabled(true);
      var mo = new MutationObserver(function(){ m.w.setDisabled(inp.disabled); });
      mo.observe(inp, { attributes: true, attributeFilter: ['disabled'] });
      return { host: m.host, w: m.w, destroy: function(){ mo.disconnect(); m.destroy(); } };
    }
    /* a native select (sweep, atlas, import) */
    function dd(sel, compact){
      return M.select(sel, { compact: compact, ariaLabel: sel.getAttribute('aria-label') || txt(sel.closest('label') || sel.closest('.at-ctl')).replace(txt(sel.options[sel.selectedIndex]), '').trim() });
    }

    /* ---- the mount rules: selector → mount ---- */
    var GSHORT = { 'Wall thickness': 'Wall', 'Pore size': 'Pore', 'Curvature': 'Curve', 'Tightest radius': 'Tightest' };
    var vwl = function(g){ var p = g.previousElementSibling; return p && /(^|\s)vw-l(\s|$)/.test(p.className) ? txt(p) : ''; };
    var RULES = [
      /* control pane: grid, strain cap, axis, flow rows, surface voxels */
      { sel: '.seg[data-seg]', fn: function(g){ var r = g.closest('.sc-group'), l = r && r.querySelector(':scope>label'); return seg({ group: g, btns: g.querySelectorAll('button'), label: txt(l) }); } },
      /* tile overlays: stress / buckling axis */
      { sel: '.load-axis-toggle', fn: function(g){ return seg({ group: g, btns: g.querySelectorAll('.load-axis-btn'), label: 'Load axis', on: isActive }); } },
      /* thermal / flow row (rebuilt by labViewToolsBuild) */
      { sel: '.th-toggle', fn: function(g){ return seg({ group: g, btns: g.querySelectorAll('.th-btn'), label: vwl(g), on: isActive, width: true }); } },
      /* geometry row and crush header: label + buttons, drawn as one row */
      { sel: '.cp-seg', fn: function(g){
          var turn = g.querySelector('.geom-turn');                       /* Turn again sits after the segmented, not inside it */
          var btns = [].filter.call(g.querySelectorAll(':scope>button'), function(b){ return b !== turn; });
          var l = g.querySelector(':scope>.lbl'), w = !!g.closest('#geomViewRow');
          if (w && UI.isPhone && UI.isPhone()) btns.forEach(function(b){ var s = GSHORT[txt(b)]; if (s) b.textContent = s; });   /* five options in 358 px */
          var m = seg({ group: g, btns: btns, label: txt(l), showLabel: true, on: isOn, width: w });
          if (turn && m) m.host.after(turn);
          return m;
        } },
      { sel: '.nl-axis-sw', fn: function(g){ return seg({ group: g, btns: g.querySelectorAll('.nl-axis-btn'), label: 'Crush axis', on: isActive }); } },
      /* sweep / atlas: groups of aria-pressed buttons are segmented, a lone one is a toggle */
      { sel: '.at-seg, #swTabs', fn: function(g){
          var all = [].slice.call(g.querySelectorAll(':scope>button')), pr = all.filter(function(b){ return b.hasAttribute('aria-pressed'); });
          if (!pr.length) return null;
          var out = [];
          if (g.closest('.sw-phys') || pr.length === 1 || pr.some(function(b){ return b.classList.contains('at-link'); })){
            pr.forEach(function(b){ out.push(tog(b, b.classList.contains('at-link') ? 'Linked' : txt(b), 'f13w-tg-at')); });
          } else out.push(seg({ group: all.length === pr.length ? g : null, btns: pr, label: '', on: isOn, width: !!g.closest('.at-ctl, .at-panel, .at-phead, #swTabs') }));
          return { host: out[0] ? out[0].host : g, destroy: function(){ out.forEach(function(m){ m && m.destroy(); }); },
                   hosts: out };
        } },
      /* ranges */
      { sel: '.sat-slider', fn: function(i){
          return rng(i, { box: i.parentNode, label: 'sat', il: 30, inline: true, detents: [1], format: function(v){ return '×' + (+v).toFixed(2); },
            push: function(v, commit, ctx){
              var inp = ctx.inp;
              window.LAB_SAT_DRAG = !commit;
              try { inp.value = v; fire(inp, 'input'); } finally { window.LAB_SAT_DRAG = false; }
              if (commit) setTimeout(function(){ fire(inp, 'input'); }, 0);   /* one rebuild, after the drag */
            } });
        } },
      { sel: '.amp-slider', fn: function(i){
          var deform = !!i.closest('.vp-stress-control');
          return rng(i, { box: i.parentNode, label: deform ? 'deform' : 'amp', il: deform ? 54 : 34, inline: true, format: function(v){ return (v * 20).toFixed(1) + '%'; } });
        } },
      { sel: '.buckle-exag-slider', fn: function(i){ return rng(i, { box: i.parentNode, label: 'exag', il: 36, inline: true, format: function(v){ return Math.round(v) + '%'; } }); } },
      { sel: '.fa-sl input[type=range]', fn: function(i){
          var box = i.closest('.fa-sl'), l = txt(box.querySelector('.fa-l')), al = i.getAttribute('aria-label') || '', f;
          if (i.dataset.fmt) f = function(v){ return geomFmt(i.dataset.fmt, +v); };
          else if (/width/i.test(al)) f = function(v){ return (+v).toFixed(1) + '×'; };
          else if (/count/i.test(al)) f = function(v){ return String(Math.round(v)); };
          else f = function(v){ return (+v).toFixed(2) + '×'; };
          return rng(i, { box: box, label: l, il: 66, inline: true, format: f });
        } },
      { sel: '#nlScrub', fn: function(i){                                /* the ticks row stays under it: the widget gets its own box */
          var wrap = i.closest('.nl-track-wrap'), box = document.createElement('div'); box.className = 'lab-scrub'; wrap.insertBefore(box, wrap.firstChild);
          var m = rng(i, { box: box, label: 'time', il: 44, inline: true, format: function(v){ return Math.round(v / 10) + '%'; } });
          return { host: box, w: m.w, destroy: function(){ m.destroy(); box.remove(); } };
        } },
      { sel: '#impOffset', fn: function(i){ return rng(i, { box: i.closest('.imp-offset'), label: 'Wall offset', detents: [0], format: function(v){ return (+v).toFixed(3) + ' mm'; } }); } },
      { sel: '.at-slider input[type=range]', fn: function(i){ return rng(i, { box: i.closest('.at-slider'), label: '', format: function(v){ return String(Math.round(v) + 1); } }); } },
      /* selects in the overlays (the three model selects are the wire's) */
      { sel: '.imp-overlay select:not(.st-sel), #atOverlay select, .at-overlay select', fn: function(s){
          var wide = /^(swb_p1|swb_p2|swb_design)$/.test(s.id) || !!s.closest('.at-ctl');
          return dd(s, !wide);
        } },
      /* toggles */
      { sel: '.cp-chip', fn: function(b){ return tog(b, txt(b), 'f13w-tg-chip'); } },
      { sel: '.chip[data-filler]', fn: function(b){ var sm = b.querySelector('small'); return tog(b, b.dataset.filler + (sm ? ' ' + txt(sm) : ''), 'f13w-tg-chip'); } },
      { sel: '[data-phys-sw]', fn: function(b){ return tog(b, '', 'f13w-tg-phys'); } },
      { sel: '#nlPlayBtn', fn: function(b){ return tog(b, 'Play', 'f13w-tg-chip'); } }
    ];
    function mountIn(root){
      if (!root || root.nodeType !== 1) return;
      RULES.forEach(function(r){
        var list = root.matches && root.matches(r.sel) ? [root] : [];
        list = list.concat([].slice.call(root.querySelectorAll(r.sel)));
        list.forEach(function(el){
          if (el.__lw || el.closest('[data-native]')) return;
          el.__lw = 1;
          try { reg(r.fn(el)); } catch (e) { console.error('[lab-widgets]', r.sel, e); }
        });
      });
    }

    /* ---- the static controls ---- */
    var shortTabs = null;                              /* the view tabs: long labels on a wide bar, short ones on a narrow one */
    var SHORT = { geom: 'Geom', stress: 'Stress', stiff: 'Stiff', thermal: 'Thermal', flow: 'Flow', buckle: 'Buckle', curve: 'Crush' };
    var tabsM = null;
    function viewTabs(){
      var g = $('viewTabs'), strip = $('viewStrip'); if (!g || !strip) return;
      var narrow = strip.clientWidth < 880 || (UI.isPhone && UI.isPhone());
      if (tabsM && narrow === shortTabs) return;
      if (tabsM){ tabsM.destroy(); live.delete(tabsM); g.removeAttribute('data-native'); tabsM = null; }
      shortTabs = narrow;
      var btns = [].slice.call(g.querySelectorAll('.view-tab'));
      btns.forEach(function(b){ var t = b.querySelector('.vt-t'); if (!b.dataset.long) b.dataset.long = txt(t); if (t) t.textContent = narrow ? SHORT[b.dataset.mode] : b.dataset.long; });
      var m = seg({ group: g, btns: btns, label: 'View', on: isActive, width: true });
      if (m){ m.host.classList.add('lab-vtabs'); tabsM = reg(m); }
    }
    function staticMounts(){
      viewTabs();
      /* stress scale and pores filled with: the group (label, show / hide) stays, its buttons become one widget */
      ['stressNormToggle', 'thermalFillerToggle'].forEach(function(id){
        var g = $(id); if (!g || g.__lw) return; g.__lw = 1;
        var btns = [].slice.call(g.querySelectorAll('.stress-norm-btn')), l = txt(g.querySelector('.stress-norm-label'));
        var on = id === 'thermalFillerToggle' ? function(b){ return b.dataset.filler === VIEW_STATE.thermalFiller; } : function(b){ return b.dataset.norm === getStressNormMode(); };
        reg(seg({ btns: btns, label: l, on: on, width: true }));
      });
      /* particles: play toggle (aria-pressed follows the app) and four inline sliders */
      var play = document.querySelector('#flowAnimToggle .flow-play');
      if (play){
        var ap = function(){ play.setAttribute('aria-pressed', String(!!VIEW_STATE.flowPlay)); };
        ap(); wrapGlobal('onFlowPlayToggle', ap); wrapGlobal('flowAnimToggleSync', ap);
        play.__lw = 1; reg(tog(play, 'Play', 'f13w-tg-chip'));
      }
      /* the view menu (shared F13LD-VIEW block, #f13ViewHost): five checkboxes → toggles. Its reset sets .checked. */
      var vp = document.querySelector('#f13ViewHost .f13v-p');
      if (vp){
        var cbs = [].slice.call(vp.querySelectorAll('input[type=checkbox]')).filter(function(c){ return !c.closest('[data-native]'); });
        cbs.forEach(function(cb){
          var row = cb.closest('label') || cb, host = document.createElement('div'); host.className = 'f13w-tg f13w-tg-menu';
          row.before(host); row.setAttribute('data-native', 'toggle');
          var quiet = function(fn){ fn(); }, w = Liquid.ui.toggle(host, { size: 'xs', accent: ACC, checked: cb.checked, label: txt(row), labelFirst: true,
            onChange: function(v){ quiet(function(){ cb.checked = v; }); fire(cb, 'change'); } });
          quiet = M.mirror(cb, HTMLInputElement.prototype, function(v){ w.set(!!v); }, 'checked');
        });
      }
      /* the desktop rail has no Results item (the phone's first tab) */
      var rail = document.querySelector('#sectionsRail .f13w-rail');
      if (rail && W.rail){
        try { W.rail.destroy(); } catch (e) {}
        rail.remove();
        var nr = document.createElement('div'); nr.className = 'f13w-rail'; $('sectionsRail').appendChild(nr);
        W.rail = Liquid.ui.sections(nr, { items: [{ id: 'model', label: 'Model', icon: 'lab-model' }, { id: 'physics', label: 'Physics', icon: 'lab-elastic' }], value: UI.active === 'results' ? 'model' : UI.active,
          orientation: 'vertical', accent: ACC, ariaLabel: 'Sections', onChange: function(id){ UI.showSection(id); } });
      }
    }

    /* ---- the card and the viewer-row extras ---- */
    function stressFold(root){
      root.querySelectorAll('.vp-stress-control:not([data-fold])').forEach(function(c){
        c.setAttribute('data-fold', '1');
        c.classList.toggle('open', !!window.LAB_STRESS_OPEN);
        var b = document.createElement('button'); b.type = 'button'; b.className = 'vp-fold'; b.setAttribute('aria-label', 'Saturation and deformation'); b.title = 'Saturation and deformation';
        b.setAttribute('aria-expanded', String(!!window.LAB_STRESS_OPEN)); b.innerHTML = LAB_CARD_ICONS.sliders;
        b.addEventListener('click', function(){
          window.LAB_STRESS_OPEN = !window.LAB_STRESS_OPEN;
          document.querySelectorAll('.vp-stress-control').forEach(function(x){ x.classList.toggle('open', window.LAB_STRESS_OPEN); var f = x.querySelector('.vp-fold'); if (f) f.setAttribute('aria-expanded', String(window.LAB_STRESS_OPEN)); });
        });
        c.appendChild(b);
      });
    }
    /* the thermal / flow row: the section plane is the one radio in the bar, not a native group */
    function clipHost(){
      var host = $('w-clip'); if (!host) return;
      var dyn = $('viewToolsDyn'), g = dyn && dyn.querySelector('.lab-clip');
      var want = !!g;
      if (g){ var grp = g.closest('.vw-grp'); (grp || g).remove(); }
      host.hidden = !want;
      if (want && UI.onClipChange && typeof LAB_CLIP !== 'undefined') UI.onClipChange(LAB_CLIP.axis);
    }

    /* ---- the one scan: help first (the slider mount moves (i) buttons found in its row), then the widgets ---- */
    function scan(root){
      sweepLive();
      mountIn(root);
      stressFold(root);
    }
    var timer = 0;
    var clipHostSoon = function(){ if (document.getElementById('viewToolsDyn')) clipHost(); };
    scanFn = function(roots){ roots.forEach(scan); clipHostSoon(); sweepBarSoon(); };   /* the page-level observer (above) calls it */

    /* ---- sweep: Run sweep is the second long job (progress button, Stop beside it) ---- */
    var PB = null, SW = { running: false, i: 0, n: 0 };
    wrapGlobal('sweepPaintHeaderBtn', function(_, a){ SW.i = a[0] || 0; SW.n = a[1] || 0; });
    function sweepBar(){
      var bar = $('swBar'); if (!bar) { if (PB && !PB.host.isConnected){ PB.w.destroy(); PB = null; } return; }
      var acts = bar.querySelector('.sw-actions'); if (!acts) return;
      var running = !!(typeof SWEEP_STATE !== 'undefined' && SWEEP_STATE.running);
      if (!PB || !PB.host.isConnected){
        if (PB) try { PB.w.destroy(); } catch (e) {}
        var host = document.createElement('div'); host.className = 'sw-pb';
        PB = { host: host, w: Liquid.ui.progressButton(host, { label: 'Run', accent: ACC, size: 'sm', onClick: function(){
          var n = $('swBar').querySelector('[onclick^="sweepStart"]'); if (n && !n.disabled) n.click();
        } }), running: false };
      }
      var nat = running ? acts.querySelector('[onclick*="stopRequested"]') : acts.querySelector('[onclick^="sweepStart"]');
      var info = running ? [].slice.call(acts.querySelectorAll(':scope>.imp-sub')).filter(function(s){ return /Running/.test(s.textContent); })[0] : null;
      if (info) info.setAttribute('data-native', 'info');
      if (nat && PB.host.nextElementSibling !== nat) nat.before(PB.host);
      if (!nat && !PB.host.parentNode) acts.appendChild(PB.host);
      if (running){
        var left = info ? (info.textContent.match(/~\s*(.+?)\s+left/) || [])[1] : '';
        var p = SW.n ? SW.i / SW.n : 0;
        if (!PB.running){ PB.running = true; PB.w.setDisabled(false); PB.w.setBusy(true); }
        PB.w.setProgress(Math.max(0.02, p));
        PB.w.setLabel('Run ' + ((SW.i || 0) + 1) + ' / ' + (SW.n || '?') + (left ? ' · ' + left + ' left' : ''));
      } else {
        if (PB.running){ PB.running = false; PB.w.setProgress(SWEEP_STATE.stopRequested ? null : 1); PB.w.setBusy(false); }
        if (nat){ PB.w.setLabel(txt(nat)); PB.w.setDisabled(nat.disabled); nat.setAttribute('data-native', 'run'); }
        else PB.host.remove();
      }
      if (running && nat) nat.classList.add('sw-stop');
    }
    var sweepBarSoon = function(){ if ($('swBar')) sweepBar(); };

    /* the Run all lock while a sweep runs (62 labPaintRunLock: aria-disabled + title on the native button) */
    (function(){
      var rb = $('runBtn'), host = $('w-run'); if (!rb || !host || !W.run) return;
      var sync = function(){ W.run.setDisabled(rb.getAttribute('aria-disabled') === 'true' || (rb.disabled && !RUNUI.active)); host.title = rb.title || ''; };
      new MutationObserver(sync).observe(rb, { attributes: true, attributeFilter: ['aria-disabled', 'title'] });
      sync();
    })();

    /* ---- first pass: whatever exists now (the cards 99-init drew before the wire mounted) ---- */
    helpRefresh();
    staticMounts();
    helpRefresh();
    mountIn(document.body);
    stressFold(document.body);
    clipHostSoon();
    window.addEventListener('f13ui-resize', function(){ viewTabs(); });
    window.addEventListener('resize', function(){ clearTimeout(timer); timer = setTimeout(viewTabs, 200); });
    html.classList.add('lab-w');
  });
})();
