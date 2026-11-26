/* ============================================================================
   F13LD.lab · 65-help.js — the shared F13LD help system (field guide drawer, (i) buttons, "show").
   Engine: the modular drop-in used by wave / tpms / grain / noise / mesh (F13LD.mesh 59-help.js), CSS in help.css.
   Lab changes against that engine:
     - classic numbered script, config in this file;
     - cards, geometry row, thermal / flow row, crush header, sweep, atlas and import are rebuilt by innerHTML, so placement is
       repeatable: F13Help.refresh([ids]) places every (i) that is missing; 64-lab-widgets.js calls it after each render;
     - an anchor may list several selectors (the first that exists wins); `before` / `after` / `into` / `row` / `match`
       (a card metric row whose label matches, first design only);
     - a card line may be {src: selector}: the text of a hidden .hint.help-src kept from the stage-2 control pane.
   "Show" (the wire, F13UI.revealControl) reads F13UI.helpTargets below at call time; a control inside a closed fold opens it first.
   ============================================================================ */
(function(){
  "use strict";

  /* ============ PER-TOOL CONFIG ======================================== */
  var TUTORIAL_URL = 'https://tutorial.f13ld.app/lab';
  var TOOL_TITLE   = 'lab';
  var ROW_SEL      = '.sc-group';
  var INTRO = 'F13LD.lab solves up to three designs side by side: stiffness, buckling, crush, thermal conductivity and flow. Pick the material and the physics, press Run all, and compare the cards. Switching a view or a setting never re-solves; a setting that changes the solve needs a new run.';

  var SECTIONS = [
    { title:'Views', items:[
      { id:'views', label:'views · Geometry … Crush', anchor:{after:'#viewTabs'},
        what:'Geometry shows the designs. Stress, Stiffness, Thermal κ, Flow and Buckling show that solver’s fields on the same tiles. Crush shows the stress–strain curves of all designs on one plot.',
        see:'A tab fills after its physics has run. The controls under the tabs belong to the active tab.',
        why:'Compare the same quantity across designs at one glance.' },
      { id:'geomviews', label:'geometry views', anchor:{into:'#geomViewRow .lab-segl'},
        what:'Shaded, Curvature, Overhang, Wall thickness and Pore size. They are computed from the design’s field, not from a solve.',
        see:'Curvature, wall and pore views show a colour scale and a legend; the sliders set where the scale ends and what turns red.',
        why:'Check printability and feature size before spending time on a run.' },
      { id:'sigma', label:'σ scale · per / shared', anchor:{into:'#stressNormToggle .stress-norm-label'},
        what:'Per sets each tile’s colour scale from its own stress. Shared uses one scale across designs.',
        see:'On shared, the same colour means the same stress on every tile.',
        why:'Per shows where stress concentrates in one design. Shared compares designs.' },
      { id:'sat', label:'saturation · deformation',
        what:'Saturation scales the top of the stress colour range on one tile. Deformation sets how far the cell is drawn stretched under the chosen load axis.',
        see:'Shear load cases have no displacement field, so deformation is off for them.',
        why:'Saturation brings out low-stress detail. Deformation shows how the cell moves.' },
      { id:'thermalview', label:'pores filled with · view', anchor:{into:'#thermalFillerToggle .stress-norm-label'},
        what:'Which solved pore filler the Thermal κ tab shows. The row beside it picks temperature, deviation, flux or the κ surface, and the gradient axis.',
        see:'A filler shows after it has been solved. Fillers are chosen in Physics, Thermal κ.',
        why:'Compare air, water and tissue in the pores without a new solve.' },
      { id:'section', label:'section plane · X / Y / Z', anchor:{into:'#w-clip .clip-lbl'},
        what:'Cuts the view with a plane across X, Y or Z. Drag the plane’s handle on a tile to move it. Tap the active axis to remove it.',
        see:'Shows in the Thermal and Flow views, and Flow speed always cuts.',
        why:'A look inside the lattice at the flow or the temperature.' },
      { id:'particles', label:'particles', anchor:{into:'#flowAnimToggle .stress-norm-label'},
        what:'Play, speed, streak length, width and count of the tracer particles in the Flow view.',
        see:'Speed changes how fast particles move. Length sets how much flow time a streak covers.',
        why:'Display only. Nothing here re-solves.' },
      { id:'viewmenu', label:'◐ view', anchor:{after:'#f13ViewHost'},
        what:'Shading options for the tiles: shadows, occlusion, warm / cool light, cut faces and lime edges.',
        see:'The same menu in every F13LD tool. Reset puts it back to the defaults.',
        why:'Preview only.' },
      { id:'renderq', label:'render quality · automatic',
        what:'The tiles pick their own detail. There is no quality switch.',
        see:'The view draws only when something changes or moves.',
        why:'Keeps the GPU free for the solvers.' }
    ]},
    { title:'Model', items:[
      { id:'material', label:'material', anchor:{row:'#materialSel'},
        what:{ src:'#grp-material .help-src' },
        see:'Stiffness, strength and conductivity scale with the material. The run re-solves what depends on it.',
        why:'From design uses each design’s own material.' },
      { id:'conn', label:'connectivity', anchor:{row:'#connSel'},
        what:{ src:'#grp-conn .help-src' },
        see:'Floating islands are free bodies: they add no stiffness and are removed from every solve except as noted.',
        why:'Interwoven designs can have two networks; one may carry nothing.' },
      { id:'pv', label:'surface voxels', anchor:{row:'.seg[data-seg=pv]'},
        what:{ src:'#grp-pv .help-src' },
        see:'Partial volume is the default.',
        why:'0/1 cube reproduces older results.' }
    ]},
    { title:'Physics', items:[
      { id:'m-elastic', label:'elastic', anchor:{before:'#fold-elastic .f13w-tg-phys, #fold-elastic [data-phys-sw]'},
        what:'Linear homogenization: the full stiffness matrix, E, G, ν and directional stiffness.',
        see:'The toggle in the header turns the mode on for the next run. The summary shows its grid.',
        why:'The base for stress, stiffness, thermal and buckling comparisons.' },
      { id:'m-buckle', label:'buckling', anchor:{before:'#fold-buckle .f13w-tg-phys, #fold-buckle [data-phys-sw]'},
        what:'Linear eigenvalue buckling, free-sided (uniaxial-stress) loading.',
        see:'Critical load, mode shapes and the buckling-to-yield ratio.',
        why:'A lattice can buckle before it yields.' },
      { id:'m-nonlin', label:'crush', anchor:{before:'#fold-nonlin .f13w-tg-phys, #fold-nonlin [data-phys-sw]'},
        what:'Nonlinear J2 plasticity with Voce hardening, adaptive load steps on the GPU.',
        see:'Stress–strain curves, yield, crush modulus and the crushing cubes.',
        why:'Strength past the elastic range.' },
      { id:'m-thermal', label:'thermal κ', anchor:{before:'#fold-thermal .f13w-tg-phys, #fold-thermal [data-phys-sw]'},
        what:'Steady-state conduction: the effective conductivity tensor for each pore filler.',
        see:'Runs on the elastic grid. Each filler is a fast solve.',
        why:'Heat flow through the structure.' },
      { id:'m-flow', label:'flow', anchor:{before:'#fold-flow .f13w-tg-phys, #fold-flow [data-phys-sw]'},
        what:'Lattice Boltzmann creeping flow through the pores: permeability, tortuosity, open and sealed pores, wall shear.',
        see:'Readout settings below the grid change the display only.',
        why:'Perfusion and transport through a scaffold.' }
    ]},
    { title:'Physics · settings', items:[
      { id:'grid', label:'elastic grid', range:'32³ – 128³', anchor:{row:'.seg[data-seg=grid]'},
        what:{ row:true }, see:'The summary in the fold header follows.', why:'A finer grid is slower and uses more GPU memory.' },
      { id:'bgrid', label:'buckling grid', range:'16³ – 64³', anchor:{row:'.seg[data-seg=buckleN]'},
        what:{ row:true }, see:'A design that is under-resolved says so on its card.', why:'Thin struts need a finer grid.' },
      { id:'cgrid', label:'crush grid', range:'16³ – 64³', anchor:{row:'.seg[data-seg=nonlinN]'},
        what:{ row:true }, see:'The run cost grows with the grid and the strain cap.', why:'Crush is the slowest mode.' },
      { id:'cap', label:'strain cap', range:'2 – 10 %', anchor:{row:'.seg[data-seg=cap]'},
        what:{ row:true }, see:'A higher cap shows more of the curve.', why:'Set it past the strain you care about.' },
      { id:'caxis', label:'load axis', anchor:{row:'.seg[data-seg=axis]'},
        what:'The axis the crush runs along. All runs X, Y and Z in turn.',
        see:'All takes about three times as long. The cards then use the weakest axis.', why:'Anisotropic designs crush differently by axis.' },
      { id:'fillers', label:'pores filled with', range:'air · water · tissue', anchor:{row:'.chipset'},
        what:{ row:true }, see:'The last filler cannot be turned off.', why:'Conductivity depends on what is in the pores.' },
      { id:'fgrid', label:'flow grid', range:'32³ – 128³', anchor:{row:'.seg[data-seg=flowN]'},
        what:{ row:true }, see:'128³ needs a GPU that allows 160 MB in one buffer.', why:'Permeability is only as good as the narrowest pore is resolved.' },
      { id:'ftol', label:'flow tolerance', anchor:{row:'.seg[data-seg=flowTol]'},
        what:{ row:true }, see:'High takes longer.', why:'Standard is enough for most designs.' },
      { id:'fdir', label:'flow direction', anchor:{row:'.seg[data-seg=flowDir]'},
        what:{ row:true }, see:'The Flow tab’s direction row sets the particles and speed map.', why:'Display only.' },
      { id:'ffluid', label:'fluid', anchor:{row:'.seg[data-seg=flowFluid]'},
        what:{ row:true }, see:'Permeability does not depend on the fluid.', why:'Wall shear does.' },
      { id:'fmu', label:'viscosity', anchor:{row:'input[data-k=muCustom]'},
        what:{ row:true }, see:'Shown for Custom only.', why:'Your fluid’s data sheet value.' },
      { id:'ftarget', label:'shear target', anchor:{row:'#shearTargetSel'},
        what:{ row:true }, see:'The cards give the share of wall in range and the best speed.', why:'Wall shear drives cell behaviour in a perfusion bioreactor.' },
      { id:'ftlohi', label:'custom target', anchor:{row:'input[data-k=tLo]'},
        what:{ row:true }, see:'Shown for Custom target only.', why:'A range from your own protocol.' },
      { id:'funit', label:'speed units', anchor:{row:'.seg[data-seg=flowUnit]'},
        what:{ row:true }, see:'The number is the same in mPa and Pa.', why:'Match your pump.' },
      { id:'fchamber', label:'chamber diameter', range:'mm', anchor:{row:'input[data-k=chamberMm]'},
        what:{ row:true }, see:'The best speed shows as a flow rate.', why:'Sizes the pump.' }
    ]},
    { title:'Run', items:[
      { id:'runall', label:'run all · estimate', anchor:{into:'.dock-meta'},
        what:'Solves every mode that is switched on, for every design, one design at a time. The button shows the stage, the design and the time left; Cancel stops it.',
        see:'The estimate is sharpened by the times measured on this machine. A result that is already solved with the same settings is reused.',
        why:'One run fills every tab.' },
      { id:'clearing', label:'results and settings',
        what:'A card keeps its numbers until the next run. Changing the grid, the material, connectivity, surface voxels, strain cap or flow tolerance does not update them.',
        see:'Run all again to refresh. Readout settings (flow direction, fluid, units) never need a run.',
        why:'Check the settings before you trust the numbers.' }
    ]},
    { title:'Card metrics', items:[
      { id:'modulus', label:'modulus X / Y / Z', anchor:{match:/^Modulus/},
        what:'Effective Young’s modulus of the periodic cell along each axis, from the full stiffness matrix.', see:'In GPa or MPa for the chosen material.', why:'Stiffness of the lattice as a solid.' },
      { id:'aniso', label:'anisotropy', anchor:{match:/^Anisotropy/},
        what:'How far the cell is from direction-independent. 1 is isotropic.', see:'The Stiffness tab draws the directional surface.', why:'A bone-like scaffold is rarely isotropic.' },
      { id:'density', label:'relative density', anchor:{match:/^Relative Density/},
        what:'Solid volume as a share of the cell.', see:'Solved density follows the voxel grid.', why:'The first number to match when you compare designs.' },
      { id:'yield', label:'yield strength', anchor:{match:/^Yield/},
        what:'The stress at which the cell starts to yield, from the crush run.', see:'Needs Crush.', why:'The limit before permanent damage.' },
      { id:'buckling', label:'buckling strength', anchor:{match:/^(Buckling Strength|Critical)/},
        what:'The load at which the cell buckles, as a stress and a load factor.', see:'Needs Buckling.', why:'The limit for slender struts and thin sheets.' },
      { id:'b2y', label:'buckling-to-yield', anchor:{match:/^Buckling-to-Yield/},
        what:'Buckling stress divided by yield stress. Below 1 the cell buckles first.', see:'The card header names the governing limit.', why:'Tells you which failure comes first.' },
      { id:'loadcap', label:'load capacity', anchor:{match:/^Load Capacity/},
        what:'The force one cell carries at its governing strength.', see:'Needs yield or buckling data.', why:'A number you can set against a service load.' },
      { id:'kappa', label:'conductivity X / Y / Z', anchor:{match:/^Conductivity/},
        what:'Effective thermal conductivity along each axis for the filler shown, in W/m·K.', see:'Needs Thermal κ.', why:'Heat flow through the structure.' },
      { id:'surf', label:'surface area density', anchor:{match:/^Surface Area/},
        what:'Wall area per volume of cell.', see:'Per mm.', why:'Room for cell attachment or reaction.' },
      { id:'diffus', label:'diffusivity', anchor:{match:/^Diffusivity/},
        what:'Thermal diffusivity: how fast a temperature change spreads.', see:'Uses the filler’s heat capacity.', why:'Transient heat behaviour.' },
      { id:'therm', label:'thermal efficiency', anchor:{match:/^(Thermal Efficiency|Share of Solid)/},
        what:'Conductivity as a share of what the same solid fraction would conduct in the best case.', see:'Higher is better aligned to the heat path.', why:'Shows how well the shape uses its material.' },
      { id:'perm', label:'permeability', anchor:{match:/^Permeability/},
        what:'Darcy permeability along each axis, in 10⁻⁹ m². Trabecular bone spans 0.027–20 (Nauman, Fong & Keaveny 1999).', see:'Needs Flow. A scaffold below the bone range resists flow more than bone.', why:'How easily fluid moves through.' },
      { id:'tort', label:'tortuosity', anchor:{match:/^Tortuosity/},
        what:'How much longer the flow path is than a straight line.', see:'1 is straight.', why:'Winding pores slow transport.' },
      { id:'poros', label:'open porosity', anchor:{match:/^Open Porosity/},
        what:'Pore volume connected to the inlet and outlet, as a share of the cell.', see:'Sealed pores are reported separately.', why:'Only open pores carry flow.' },
      { id:'pore', label:'narrowest pore', anchor:{match:/^Narrowest/},
        what:'The smallest pore throat, in voxels and mm.', see:'About 8 voxels across is the flow grid’s rule; the card flags designs below it.', why:'Sets how far to trust permeability.' },
      { id:'wss', label:'wall shear', anchor:{match:/^(Shear per|At target)/},
        what:'Shear stress on the walls per unit flow speed, and the share of wall inside the shear target.', see:'Direction and fluid set the numbers. No re-run.', why:'The mechanical cue cells feel.' },
      { id:'speed', label:'best speed · usable range', anchor:{match:/^(Best flow|Usable)/},
        what:'The flow speed that puts the most wall in the target, and the range that keeps at least half.', see:'Needs a shear target. The chamber diameter turns it into a flow rate.', why:'Where to set the pump.' }
    ]},
    { title:'Sweep and import', items:[
      { id:'sweepbuild', label:'sweep · define runs', anchor:{before:'#swTabs'},
        what:'Builds a run matrix from a design’s parameters, or loads a CSV, and solves every run.',
        see:'Section 2 sets what each run solves; section 3 lists and runs them. The Atlas shows the results.',
        why:'A parameter study without repeating the setup.' },
      { id:'precision', label:'precision', anchor:{row:'#swPrec'},
        what:'Solver tolerance for the sweep runs.', see:'Tighter takes longer.', why:'Match the precision to the question.' },
      { id:'void', label:'void stiffness', anchor:{row:'#swSettings label[title^="Stiffness given"] select'},
        what:'Stiffness given to empty space, as a fraction of the solid. 1e-4 is the lab default.', see:'It inflates low-density lattices.', why:'A solver safeguard.' },
      { id:'refine', label:'second grid', anchor:{row:'#swSettings label[title^="Also solve"] select'},
        what:'Also solves each run on a second grid and extrapolates to an infinitely fine one.', see:'Doubles the time.', why:'Removes grid error from a comparison.' },
      { id:'impunits', label:'import · units', anchor:{row:'#impUnits'},
        what:'The unit of the STL file. One repeating unit cell, binary or ASCII.', see:'Fixed at import.', why:'Sets the cell size in mm.' },
      { id:'impcell', label:'import · cell size', anchor:{row:'#impCellMode'},
        what:'Fit uses the part’s bounding box. Set takes a size you type.', see:'Fixed at import.', why:'A cell cut larger than the part is padded.' },
      { id:'impoffset', label:'import · wall offset', range:'−1 – 1 mm', anchor:{into:'#impOffsetRow'},
        what:'Moves the imported walls in or out.', see:'The preview and the report update. Apply makes it the design.', why:'Thicken or thin a part without going back to CAD.' }
    ]}
  ];
  /* ============ END PER-TOOL CONFIG ==================================== */

  function el(tag, cls, html){ var n=document.createElement(tag); if(cls) n.className=cls; if(html!=null) n.innerHTML=html; return n; }

  var scrim, drawer, trigger;

  function line(tag, txt, kind){
    var l = el('div','f13h-line'+(kind?(' '+kind):''));
    l.appendChild(el('span','f13h-tag',tag));
    l.appendChild(el('span',null,txt));
    return l;
  }
  /* a card line is a string, or {src}: the text of a kept hint */
  function text(v, it){
    if(v && typeof v==='object'){
      var n = null;
      if(v.src) n = document.querySelector(v.src);
      else if(v.row && it && it.anchor && it.anchor.row){ var c = first(it.anchor.row); c = c && c.closest(ROW_SEL); n = c && c.querySelector('.help-src'); }
      return n ? n.textContent.trim() : '';
    }
    return v;
  }

  function build(){
    scrim = el('div','f13h-scrim');
    drawer = el('div','f13h-drawer');

    var head = el('div','f13h-head');
    head.appendChild(el('h2', null, 'F13LD.<b>'+TOOL_TITLE+'</b><span>field guide</span>'));
    var tut = document.createElement('a');
    tut.className='f13h-tut'; tut.href=TUTORIAL_URL; tut.target='_blank'; tut.rel='noopener';
    tut.innerHTML='Tutorial<svg class="ic sm" viewBox="0 0 16 16" aria-hidden="true" style="display:inline-block;vertical-align:-2px;margin-left:3px"><path d="M5 11l6-6M6 5h5v5"/></svg>';
    head.appendChild(tut);
    var close = el('button','f13h-close','×'); close.setAttribute('aria-label','Close');
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    drawer.appendChild(head);

    var body = el('div','f13h-body');
    body.appendChild(el('div','f13h-intro', INTRO));
    SECTIONS.forEach(function(sec){
      body.appendChild(el('div','f13h-section-t', sec.title));
      sec.items.forEach(function(it){
        var card = el('div','f13h-card'); card.id='f13h-card-'+it.id;
        var h = el('div','f13h-card-h');
        h.appendChild(el('span','f13h-name', it.label));
        if(it.range) h.appendChild(el('span','f13h-range', it.range));
        card.appendChild(h);
        var w = text(it.what, it);
        if(w)       card.appendChild(line('sets',  w));
        if(it.see)  card.appendChild(line('shows', it.see));
        if(it.why)  card.appendChild(line('means', it.why, 'means'));
        body.appendChild(card);
      });
    });
    drawer.appendChild(body);

    document.body.appendChild(scrim);
    document.body.appendChild(drawer);
    scrim.addEventListener('click', closeDrawer);
  }

  function alignDrawer(){
    if(!drawer) return;
    var h = document.querySelector('.f13ld-header');
    if(!h) return;
    var r = h.getBoundingClientRect();
    drawer.style.right = Math.max(0, Math.round(window.innerWidth - r.right)) + 'px';
  }

  function openDrawer(id){
    alignDrawer();
    scrim.classList.add('open');
    drawer.classList.add('open');
    if(trigger) trigger.classList.add('active');
    if(id){
      setTimeout(function(){
        var c = document.getElementById('f13h-card-'+id);
        if(!c) return;
        c.scrollIntoView({block:'center', behavior:'smooth'});
        c.classList.add('flash');
        setTimeout(function(){ c.classList.remove('flash'); }, 1500);
      }, 90);
    }
  }
  function closeDrawer(){
    scrim.classList.remove('open');
    drawer.classList.remove('open');
    if(trigger) trigger.classList.remove('active');
  }

  function makeI(id){
    var b = el('button','f13h-i','i'); b.type='button';
    b.setAttribute('aria-label','About this control');
    b.setAttribute('data-h', id);
    b.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); openDrawer(id); });
    return b;
  }

  function first(sel){
    var parts = sel.split(','), i, e;
    for(i=0;i<parts.length;i++){ e = document.querySelector(parts[i].trim()); if(e) return e; }
    return null;
  }
  function rowLabel(sel){
    var elx = first(sel); if(!elx) return null;
    var c = elx.closest(ROW_SEL);
    if(c){ var l = c.querySelector('label'); if(l) return l; }
    var lw = elx.closest('label'); if(lw) return lw;
    return null;
  }
  function placed(id){ return !!document.querySelector('button.f13h-i[data-h="'+id+'"]'); }

  function place(item){
    var a = item.anchor; if(!a || placed(item.id)) return;
    if(a.match){                                              /* first card, first row whose label matches */
      var rls = document.querySelectorAll('#compareGrid .dc-row .rl'), k;
      for(k=0;k<rls.length;k++){ if(a.match.test(rls[k].textContent.replace(/^\s+/,''))){ rls[k].appendChild(makeI(item.id)); return; } }
      return;
    }
    if(a.into){ var t = first(a.into); if(t) t.appendChild(makeI(item.id)); return; }
    if(a.before){ var bf = first(a.before); if(bf && bf.parentNode) bf.parentNode.insertBefore(makeI(item.id), bf); return; }
    if(a.after){ var x = first(a.after);
      if(x && x.parentNode) x.parentNode.insertBefore(makeI(item.id), x.nextSibling); return; }
    if(a.row){ var l = rowLabel(a.row); if(!l) return;
      if(l.id){ l.parentNode.insertBefore(makeI(item.id), l.nextSibling); }
      else { l.appendChild(makeI(item.id)); }
      return; }
  }

  function refresh(ids){
    SECTIONS.forEach(function(sec){ sec.items.forEach(function(it){
      if(ids && ids.indexOf(it.id) < 0) return;
      place(it);
    }); });
  }

  function init(){
    build();
    var fhRight = document.querySelector('.fh-right');
    if(fhRight){
      trigger = el('button','f13h-trigger','?');
      trigger.type='button';
      trigger.title='Help · control guide';
      trigger.setAttribute('aria-label','Help');
      trigger.addEventListener('click', function(){
        if(drawer.classList.contains('open')) closeDrawer(); else openDrawer(null);
      });
      fhRight.insertBefore(trigger, fhRight.firstChild);
    }
    refresh();
    alignDrawer();
    window.addEventListener('resize', alignDrawer);
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeDrawer(); });
  }

  window.F13Help = {
    refresh: refresh,
    open: function(id){ if(drawer) openDrawer(id||null); },
    close: function(){ if(drawer) closeDrawer(); },
    cards: function(){ var n=[]; SECTIONS.forEach(function(s){ s.items.forEach(function(i){ n.push(i.id); }); }); return n; },
    count: function(){ return document.querySelectorAll('button.f13h-i').length; }
  };

  /* ---- help "show": the wire (F13UI.revealControl) reads these at call time. id → selector, "a, b" (first drawn
     candidate), or {sel, note}. `note` is what a control that is not drawn right now says. ---- */
  var T = function(sel, note){ return note ? {sel:sel, note:note} : sel; };
  var UI = window.F13UI = window.F13UI || {};
  var NEED_STRESS = 'Saturation and deformation show on the Stress tab, after a run.';
  UI.helpTargets = {
    views:'.lab-vtabs, #viewTabs',
    geomviews:T('#geomViewRow.show .lab-segrow, #geomViewRow.show', 'The geometry views show on the Geometry tab.'),
    sigma:T('#stressNormToggle.show', 'The σ scale shows on the Stress tab.'),
    sat:T('.vp-stress-control .f13w-inline, .vp-stress-control', NEED_STRESS),
    thermalview:T('#thermalFillerToggle.show', 'Pores filled with shows on the Thermal κ tab.'),
    section:T('#w-clip:not([hidden])', 'The section plane shows in the Thermal and Flow views, after a run.'),
    particles:T('#flowAnimToggle.show', 'The particle controls show on the Flow tab, in the flow view, after a run.'),
    viewmenu:'#f13ViewHost .f13v>button',
    renderq:'#viewStrip',
    material:'#w-material, #grp-material',
    conn:'#w-conn, #grp-conn',
    pv:'#grp-pv',
    'm-elastic':'#fold-elastic .fold-h', 'm-buckle':'#fold-buckle .fold-h', 'm-nonlin':'#fold-nonlin .fold-h',
    'm-thermal':'#fold-thermal .fold-h', 'm-flow':'#fold-flow .fold-h',
    grid:'.seg[data-seg=grid]', bgrid:'.seg[data-seg=buckleN]', cgrid:'.seg[data-seg=nonlinN]', cap:'.seg[data-seg=cap]', caxis:'.seg[data-seg=axis]',
    fillers:'.chipset', fgrid:'.seg[data-seg=flowN]', ftol:'.seg[data-seg=flowTol]', fdir:'.seg[data-seg=flowDir]', ffluid:'.seg[data-seg=flowFluid]',
    fmu:T('#flowMuRow', 'Viscosity shows when the fluid is Custom.'),
    ftarget:'#w-shearTarget, #shearTargetSel',
    ftlohi:T('#flowTargetRow', 'The custom range shows when the shear target is Custom.'),
    funit:'.seg[data-seg=flowUnit]', fchamber:'input[data-k=chamberMm]',
    runall:'#w-run, #runBtn',
    clearing:'#ctrlFoot',
    modulus:T('#compareGrid .dc-row', 'Metrics show on the cards after a run.'),
    aniso:T('#compareGrid .dc-row', 'Metrics show on the cards after a run.'), density:T('#compareGrid .dc-row', 'Metrics show on the cards after a run.'),
    yield:T('#compareGrid .dc-row', 'Yield shows after a Crush run.'), buckling:T('#compareGrid .dc-row', 'Buckling shows after a Buckling run.'),
    b2y:T('#compareGrid .dc-row', 'Needs Buckling and Crush.'), loadcap:T('#compareGrid .dc-row', 'Needs a yield or buckling result.'),
    kappa:T('#compareGrid .dc-row', 'Conductivity shows on the Thermal κ tab after a run.'), surf:T('#compareGrid .dc-row', 'Shows on the Thermal κ tab after a run.'),
    diffus:T('#compareGrid .dc-row', 'Shows on the Thermal κ tab after a run.'), therm:T('#compareGrid .dc-row', 'Shows on the Thermal κ tab after a run.'),
    perm:T('#compareGrid .dc-row', 'Permeability shows on the Flow tab after a run.'), tort:T('#compareGrid .dc-row', 'Shows on the Flow tab after a run.'),
    poros:T('#compareGrid .dc-row', 'Shows on the Flow tab after a run.'), pore:T('#compareGrid .dc-row', 'Shows on the Flow tab after a run.'),
    wss:T('#compareGrid .dc-row', 'Shows on the Flow tab after a run.'), speed:T('#compareGrid .dc-row', 'Shows on the Flow tab with a shear target set.'),
    sweepbuild:T('#swTabs', 'Open Sweep from the header.'), precision:T('#swPrec', 'Open Sweep from the header.'),
    void:T('#swSettings', 'Open Sweep from the header.'), refine:T('#swSettings', 'Open Sweep from the header.'),
    impunits:T('#impUnits', 'Open Import STL from the header.'), impcell:T('#impCellMode', 'Open Import STL from the header.'),
    impoffset:T('#impOffsetRow', 'The wall offset shows in the Import STL dialog, after a build.')
  };

  /* ---- "show" for a control inside a closed fold: open the fold first (and remember it, as a tap on its header would) ---- */
  function installReveal(){
    var base = UI.revealControl;
    if(typeof base !== 'function'){ setTimeout(installReveal, 60); return; }
    if(base.labFold) return;
    UI.revealControl = function(sel, id){
      var t = (sel == null && id != null) ? UI.helpTargets[id] : sel, spec = t && typeof t === 'object' && !t.nodeType ? t.sel : t;
      var els = typeof spec === 'string' ? spec.split(',').map(function(s){ return document.querySelector(s.trim()); }).filter(Boolean) : (spec ? [spec] : []);
      els.forEach(function(e){
        for(var f = e.closest && e.closest('.fold:not(.open)'); f; f = f.parentElement && f.parentElement.closest('.fold:not(.open)')){
          if(typeof onFoldToggle === 'function') onFoldToggle(f.getAttribute('data-fold'), true);
        }
      });
      return base.call(this, sel, id);
    };
    UI.revealControl.f13wire = true; UI.revealControl.labFold = true;
  }
  if(window.F13UI && F13UI.ready) F13UI.ready(installReveal);

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
