/* ============================================================================
   F13LD UI template · f13ui-wire.js — mounts liquid widgets over a tool's native controls.
   Generalised from F13LD.tpms v1.4.0 (its #f13ui-wire is the tested reference).

   Pattern: the native inputs stay in the DOM, hidden ([data-native]), as the app's state source.
     widget → app : set the native value, dispatch 'input' / 'change' (or .click() a native button)
     app → widget : per-element `value` override (mirrorValue) calls widget.set(v,{silent:true}),
                    so every programmatic write (presets, restores, imports) reaches the widget
   Result: app logic and export JSON stay byte-identical.

   Only the CONFIG block changes per tool. Requires: liquid-ui bundle, layout.js (window.F13UI).
   No WebGL → nothing mounts, html.f13w is never set, the native controls remain.
   ========================================================================== */
(function F13Wire(afterDCL){
  'use strict';
  /* F13UI.ready(cb): runs cb(F13UI.w) at once if the wire has mounted, else right after it mounts (also fires the window event
     'f13ui-ready'). Defined synchronously, so a tool's add-on script placed after the wire script can call it at parse time.
     Tool extras that mount widgets (extra toggles, buttons) MUST use it: the wire itself waits for the DOM. Not run if the wire cannot mount (no WebGL). */
  {
    const U=window.F13UI=window.F13UI||{};
    if(!U.ready){
      const q=[];
      U.ready=function(cb){if(typeof cb!=='function')return;if(U.mounted){try{cb(U.w);}catch(e){console.error(e);}}else q.push(cb);};
      U.__flushReady=function(){U.mounted=true;q.splice(0).forEach(cb=>{try{cb(U.w);}catch(e){console.error(e);}});try{window.dispatchEvent(new Event('f13ui-ready'));}catch(e){}};
    }
  }
  /* F13UI.run: report the app's own progress on the run / export button (the app drives the run itself, e.g. a worker export):
       F13UI.run.progress(p)   p in 0..1 fills the bar; null = busy, no number (slosh)
       F13UI.run.label(text)   the button label while it runs ("Meshing · 12 s"); done() restores the native button's text
       F13UI.run.done(ok)      ok !== false: flood and pop; false (refusal, cancel, failure): drain, no pop
     No-ops until the wire has mounted a run button (and when it cannot mount), so tools may call them unguarded. */
  {
    const U=window.F13UI=window.F13UI||{};
    if(!U.run)U.run={progress(){},label(){},done(){}};
  }
  /* Init timing: wait for the DOM (and one task after DOMContentLoaded, so handlers the app registered
     later have run). readyState is 'interactive' while DEFERRED scripts run, i.e. BEFORE DOMContentLoaded fires,
     so it cannot be the test: use the navigation entry's domContentLoadedEventEnd (> 0 once the event has run),
     with readyState 'complete' as the fallback where the entry is missing. Tools no longer reorder their code;
     a view menu built later still gets mounted below. */
  const domReady=()=>{
    const n=window.performance&&performance.getEntriesByType&&performance.getEntriesByType('navigation')[0];
    return n?n.domContentLoadedEventEnd>0:document.readyState==='complete';
  };
  if(afterDCL!==true&&!domReady()){document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>F13Wire(true),0),{once:true});return;}
  if(typeof Liquid==='undefined'||!Liquid.ok||!Liquid.ui)return;
  if(window.F13UI&&window.F13UI.w&&window.F13UI.w.__wired)return;
  const $=id=>document.getElementById(id);
  const UI=window.F13UI=window.F13UI||{};
  const W=UI.w={};                                                   // mounted widgets (scripts/tests)
  Object.defineProperty(W,'__wired',{value:true});

  /* ============ PER-TOOL CONFIG ======================================== */
  /* F13LD.lab. Only this block is lab's. The rail and tab bar, the three model dropdowns, Run all and the section plane are mounted
     here. Everything the app rebuilds by innerHTML (cards, geometry row, thermal / flow row, crush header, sweep, atlas, import) and
     the static segmented rows, fold toggles, chips, particle sliders and the view menu are mounted by 64-lab-widgets.js with
     F13UI.mount.*. Lab's section icons are its own 40x40 marks: registered here as kit icons (scaled to the kit's 24 grid). */
  ['model','elastic','results'].forEach(k=>{
    if(typeof LAB_ICONS==='undefined'||!LAB_ICONS[k]||Liquid.ICONS['lab-'+k])return;
    Liquid.ICONS['lab-'+k]='<g transform="scale(.6)">'+LAB_ICONS[k].replace(/class="acc"/g,'fill="currentColor" stroke="none"')+'</g>';
  });
  const CONFIG={
    // Results is the phone's first tab: 64-lab-widgets.js rebuilds the desktop rail without it
    sections:[{id:'results',label:'Results',icon:'lab-results'},{id:'model',label:'Model',icon:'lab-model'},{id:'physics',label:'Physics',icon:'lab-elastic'}],
    analyzeSection:'results',          // the results badge (F13UI.onAnalyze) sits on the Results tab
    density:'compact',                 // Matt: compact liquid everywhere (dropdown / segmented / toggle xs, Run all 40 px), desktop and phone
    sliders:{},                        // no static slider rows: every lab slider is mounted by 64-lab-widgets.js
    segmented:[],                      // lab's choices are mounted by 64-lab-widgets.js (the buttons have no ids)
    selects:[
      {sel:'materialSel',id:'w-material',ariaLabel:'Material'},
      {sel:'connSel',id:'w-conn',ariaLabel:'Connectivity'},
      {sel:'shearTargetSel',id:'w-shearTarget',ariaLabel:'Shear target'}
    ],
    switches:[],                       // the five run toggles are mounted by 64-lab-widgets.js
    viewMenu:false,                    // the wire looks for '#cw .f13v-p'; lab's host is #f13ViewHost: 64-lab-widgets.js mounts the menu
    run:{btn:'runBtn',host:'w-run'},   // stage and time left from 64-lab-widgets.js (F13UI.run.*)
    // section plane radio in the viewer row (thermal and flow views); tapping the active axis clears it
    clip:{host:'w-clip',get:()=>(typeof LAB_CLIP!=='undefined'?LAB_CLIP.axis:0),set:n=>{if(typeof onLabClipPill==='function')onLabClipPill(n);}},
    recipe:null,                       // lab is not a design tool: no Recipe menu
    helpTargets:{}                     // set by 65-help.js (F13UI.helpTargets, read at call time)
  };
  /* ============ END PER-TOOL CONFIG ==================================== */

  // ---- theme from the page tokens: glass = --card → --panel, accent = --accent ----
  const css=getComputedStyle(document.documentElement);
  function tok(name,fb){
    const m=css.getPropertyValue(name).match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    return m?{L:+m[1],C:+m[2],h:+m[3]}:fb;
  }
  Liquid.setTheme({fillTop:tok('--card',{L:0.215,C:0.016,h:265}),fillBot:tok('--panel',{L:0.17,C:0.014,h:265})});
  const ACC=tok('--accent',Liquid.ACCENTS.lime);
  const DEN=CONFIG.density==='compact';                              // CONFIG.density:'compact': every F13UI.mount.* and CONFIG widget defaults to the compact sizes (dropdown / segmented / toggle 'xs', run button 'sm'); a per-widget size still wins
  const SZ={seg:DEN?'xs':undefined,dd:DEN?'xs':undefined,tg:DEN?'xs':'sm',run:DEN?'sm':undefined,bar:DEN?'xs':undefined,clip:DEN?'xs':'sm'};   // bar: phone tab bar 56 px (84 default); clip: radio options 32 px (44)
  F13UI.density=DEN?'compact':'default';
  if(DEN)document.documentElement.classList.add('f13w-dense');       // CSS hook: html.f13w-dense #w-clip is 36 px (44 default)
  document.documentElement.classList.add('f13w');

  // ---- bridge helpers ----
  // native.value (or .checked, prop='checked') written by the app → widget. Returns quiet(fn): writes inside fn do not echo back.
  function mirrorValue(el,proto,onWrite,prop){
    prop=prop||'value';
    const d=Object.getOwnPropertyDescriptor(proto,prop);let q=false;
    Object.defineProperty(el,prop,{configurable:true,enumerable:true,
      get(){return d.get.call(this);},
      set(v){d.set.call(this,v);if(!q)onWrite(d.get.call(this));}});
    return fn=>{q=true;try{fn();}finally{q=false;}};
  }
  const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));
  function hook(name,fn){const prev=UI[name];UI[name]=function(){if(prev)try{prev.apply(this,arguments);}catch(e){console.error(e);}fn.apply(this,arguments);};}
  const say=t=>setTimeout(()=>{if(UI.message)UI.message(t);},0);   // deferred: the triggering click must not dismiss it
  function watch(el,fn,attrs){if(!el)return null;const mo=new MutationObserver(fn);mo.observe(el,{childList:true,characterData:true,subtree:true,attributes:!!attrs,attributeFilter:attrs||undefined});return mo;}
  const decimals=s=>{const t=String(s);return t.indexOf('.')<0?0:t.split('.')[1].length;};
  // a switch button reports its state as aria-checked (role=switch) or aria-pressed (toggle button)
  const SW_ATTRS=['aria-checked','aria-pressed'];
  const swOn=b=>b.getAttribute('aria-checked')==='true'||b.getAttribute('aria-pressed')==='true';

  /* ============ F13UI.mount.* — the wire's own mount helpers, for controls the APP rebuilds ============
     A tool whose rows are rebuilt by innerHTML (term lists, editors) wraps its render function and calls these on the
     fresh rows; it does not copy the wire's code. Each mounts a widget over the native control (which stays as state,
     hidden) and returns {host, w, destroy()}: call destroy() when the row is rebuilt (the host leaves the DOM with it).
       mount.slider(input, {box, row, labelEl, label, hintEl, min,max,step, detents (array|fn(inp)), fmt (decimals),
                            format(v), parse(text), unit, frac, inline, push(v,commit,ctx)})
           box: element that receives the widget as first child (default: the input's parent); row: where the label's
           help (i) buttons are (default box); labelEl: the row's <label>, moved into the widget head; inline: one 36 px row.
       mount.select(select, {id, host, ariaLabel, compact, relabel, after(v)})
           host: an element to reuse; else an EMPTY #<id> already in the page is reused; else one is created after the select.
       mount.segmented(group, buttons, {on(btn), ariaLabel, host})
           over native buttons; clicking an option clicks its button. Disabled buttons show dimmed and ignore taps; no
           button on() = nothing selected. Kept in step by a MutationObserver on class / aria-* / disabled.
       mount.toggle(button, {label, ariaLabel, cls})     over a switch button (aria-checked OR aria-pressed)
       mount.mirror(el, proto, onWrite, prop='value')    the bridge itself: app writes to el.value/.checked reach onWrite;
           returns quiet(fn) for the widget's own writes. */
  const mount=UI.mount={mirror:mirrorValue};
  mount.slider=function(inp,o){
    o=o||{};
    const box=o.box||inp.parentElement,row=o.row||box,lab=o.labelEl||null,hintEl=o.hintEl||null;
    const hintOf=()=>hintEl?hintEl.textContent.trim().replace(/^\((.*)\)$/,'$1'):'';
    const host=document.createElement('div');host.className='f13w-slider'+(o.frac?' f13w-frac':'');box.insertBefore(host,box.firstChild);
    if(o.inline)box.classList.add('f13w-inline');
    const rng=()=>({min:o.min!=null?o.min:+inp.min,max:o.max!=null?o.max:+inp.max,step:o.step!=null?o.step:(+inp.step||0)});
    const det=()=>typeof o.detents==='function'?o.detents(inp):(o.detents||[]);   // array, or fn(input)→array (re-read when the range changes)
    const r0=rng(),dec=o.fmt!=null?o.fmt:decimals(inp.step||'0.01');
    let quiet=fn=>fn();
    const w=Liquid.ui.slider(host,{min:r0.min,max:r0.max,step:r0.step,value:+inp.value,
      label:lab?lab.textContent.trim():(o.label||''),accent:ACC,hint:hintOf(),unit:o.unit||'',
      format:o.format||(v=>(+v).toFixed(dec)),parse:o.parse,detents:det(),
      onInput:v=>push(v,false),onChange:v=>push(v,true)});
    function push(v,commit){
      if(o.push){quiet(()=>o.push(v,commit,{inp,w}));return;}
      quiet(()=>{inp.value=v;fire(inp,'input');if(commit)fire(inp,'change');});
      if(commit&&+inp.value!==w.get())w.set(+inp.value);              // show what the app accepted
    }
    quiet=mirrorValue(inp,HTMLInputElement.prototype,v=>w.set(+v));
    if(lab){                                                         // the row's own <label> becomes the widget label (help "i" stays beside it)
      const ks=host.querySelector('.lq-sl-label'),wrap=document.createElement('span');
      wrap.className='f13w-lab';
      if(lab.id){                                                    // the app / help engine address the label by id: keep it, point the widget's aria-labelledby at it
        host.querySelectorAll('[aria-labelledby~="'+ks.id+'"]').forEach(e=>e.setAttribute('aria-labelledby',e.getAttribute('aria-labelledby').split(/\s+/).map(t=>t===ks.id?lab.id:t).join(' ')));
      }else lab.id=ks.id;
      ks.removeAttribute('id');lab.removeAttribute('for');
      wrap.appendChild(lab);ks.replaceWith(wrap);
      // help buttons the engine put in the row before we mounted (direct children, after the <label>) would stay hidden with the native row: carry them beside the label
      [...row.children].forEach(c=>{if(c!==host&&c!==lab&&c.matches&&c.matches('button[class*="f13h-"]'))wrap.appendChild(c);});
    }
    const hmo=watch(hintEl,()=>w.setHint(hintOf()));
    // a tool re-ranging the native <input type=range> (setAttribute min/max/step) re-ranges the widget too
    const mo=new MutationObserver(()=>{
      w.setRange({...rng(),detents:det()});
      w.set(+inp.value);                                             // the browser already clamped the native value
    });
    mo.observe(inp,{attributes:true,attributeFilter:['min','max','step']});
    return {host,w,destroy(){mo.disconnect();if(hmo)hmo.disconnect();w.destroy();}};
  };

  // ---- sliders ----
  W.sliders={};
  document.querySelectorAll('.sc-group.sl[data-w-slider]').forEach(row=>{
    const id=row.dataset.wSlider,inp=$(id);if(!inp)return;
    const o=CONFIG.sliders[id]||{};
    W.sliders[id]=mount.slider(inp,{...o,box:row,row,labelEl:row.querySelector('label'),hintEl:row.querySelector('.mm-hint'),label:id}).w;
  });

  // ---- segmented (native buttons) ----
  CONFIG.segmented.forEach(s=>{
    const host=$(s.host);if(!host)return;host.classList.add('f13w-seg');
    const w=Liquid.ui.segmented(host,{options:s.options.map(x=>({value:x.value,label:x.label})),value:s.current(),
      accent:ACC,ariaLabel:s.ariaLabel,size:s.size||SZ.seg,onChange:v=>{const x=s.options.find(y=>y.value===v);if(x&&$(x.btn))$(x.btn).click();}});
    s.options.forEach(x=>{const b=$(x.btn);if(b)new MutationObserver(()=>w.set(s.current())).observe(b,{attributes:true,attributeFilter:s.syncOn||['class','aria-checked','aria-pressed']});});
    W[s.host]=w;
  });

  // ---- native selects → liquid dropdowns ----
  function selectGroups(sel,relabel){
    const out=[];let loose=null;
    [...sel.children].forEach(c=>{
      const opt=o=>({value:o.value,label:(relabel&&relabel[o.value]&&relabel[o.value].label)||o.textContent,disabled:o.disabled});   // <option disabled> (or in a disabled optgroup)
      if(c.tagName==='OPTGROUP'){loose=null;out.push({label:c.label,options:[...c.querySelectorAll('option')].map(opt)});}
      else if(c.tagName==='OPTION'){
        const g=relabel&&relabel[c.value]&&relabel[c.value].group;
        if(g!=null){loose=null;out.push({label:g,options:[opt(c)]});}
        else{if(!loose){loose={label:'',options:[]};out.push(loose);}loose.options.push(opt(c));}
      }});
    return out;
  }
  function faceWidth(labels){                                         // fits the longest label on the button face
    const c=faceWidth.c||(faceWidth.c=document.createElement('canvas').getContext('2d'));
    c.font='650 '+(DEN?12:15)+'px '+(css.getPropertyValue('--lq-font').trim()||'system-ui');
    return Math.ceil(Math.max(...labels.map(l=>c.measureText(l).width)))+(DEN?14+10+8+16+4:18+14+8+18+4);
  }
  mount.select=function(sel,o){
    o=o||{};
    // reuse a host the shell already has (an empty #w-… mount, or o.host) instead of adding a second element with the same id
    let host=o.host||(o.id&&$(o.id))||null,own=false;
    if(host&&host.hasChildNodes()&&!o.host)host=null;
    if(!host){host=document.createElement('div');if(o.id)host.id=o.id;own=true;sel.after(host);}
    host.classList.add('f13w-dd');if(o.compact)host.classList.add('f13w-dd-c');
    sel.setAttribute('data-native','select');
    const groups=selectGroups(sel,o.relabel);
    if(o.compact)host.style.width=faceWidth(groups.flatMap(g=>g.options.map(x=>x.label)))+'px';
    let quiet=fn=>fn();
    const w=Liquid.ui.dropdown(host,{groups,value:sel.value,accent:ACC,ariaLabel:o.ariaLabel,size:o.size||SZ.dd,minPanelWidth:o.compact?112:undefined,
      onChange:v=>{quiet(()=>{sel.value=v;});fire(sel,'change');if(o.after)o.after(v);}});
    quiet=mirrorValue(sel,HTMLSelectElement.prototype,v=>{w.set(v);if(o.after)o.after(v);});
    // the tool rebuilding the <select>'s options (or toggling option disabled) rebuilds the widget's list
    let seen=JSON.stringify(groups);
    const mo=watch(sel,()=>{
      const gs=selectGroups(sel,o.relabel),k=JSON.stringify(gs);if(k===seen)return;seen=k;
      if(o.compact)host.style.width=faceWidth(gs.flatMap(g=>g.options.map(x=>x.label)))+'px';
      w.setOptions(gs,{value:sel.value});
    },['disabled','label','value']);
    return {host,w,destroy(){mo.disconnect();w.destroy();if(own)host.remove();}};
  };
  CONFIG.selects.forEach(s=>{const sel=$(s.sel);if(sel)W[s.id]=mount.select(sel,s).w;});

  // ---- native button group → segmented (clicks the native button, so the app's handler runs) ----
  mount.segmented=function(group,btns,o){
    o=o||{};
    const host=o.host||document.createElement('div');host.classList.add('f13w-seg');
    if(!o.host&&group)group.before(host);
    if(group)group.setAttribute('data-native','seg');
    const on=o.on||(b=>b.classList.contains('on')||b.getAttribute('aria-pressed')==='true'||b.getAttribute('aria-checked')==='true'||b.getAttribute('aria-selected')==='true');
    const idx=()=>btns.findIndex(on);
    const w=Liquid.ui.segmented(host,{options:btns.map((b,i)=>({value:i,label:(b.textContent||'').trim()||b.getAttribute('aria-label')||String(i),disabled:!!b.disabled})),
      value:idx()>=0?idx():null,none:true,accent:ACC,ariaLabel:o.ariaLabel||'',size:o.size||SZ.seg,
      onChange:v=>{const b=btns[v];if(b&&!b.disabled)b.click();setTimeout(sync,0);}});   // a disabled option: the pill stays on the real choice
    function sync(){
      if(!host.isConnected)return;
      const i=idx();w.set(i>=0?i:null);                                // nothing on: no pill
      btns.forEach((b,j)=>w.setOptionDisabled(j,b.disabled));
    }
    const mos=btns.map(b=>watch(b,sync,['class','aria-pressed','aria-checked','aria-selected','disabled']));
    return {host,w,destroy(){mos.forEach(m=>m&&m.disconnect());w.destroy();if(!o.host)host.remove();}};
  };

  // ---- switches (role=switch / aria-pressed buttons) → toggles ----
  const TG={size:SZ.tg,accent:ACC};
  function tgHost(cls,id){const h=document.createElement('div');h.className='f13w-tg '+cls;if(id)h.id=id;return h;}
  mount.toggle=function(nat,o){
    o=o||{};
    const host=o.host||tgHost('f13w-tg-sw'+(o.cls?' '+o.cls:''),o.id);
    if(!o.host)nat.before(host);nat.setAttribute('data-native','toggle');
    const w=Liquid.ui.toggle(host,{...TG,size:o.size||TG.size,checked:swOn(nat),label:o.label||nat.textContent.trim(),ariaLabel:o.ariaLabel||nat.getAttribute('aria-label')||undefined,
      onChange:v=>{if(swOn(nat)!==v)nat.click();}});
    const mo=watch(nat,()=>w.set(swOn(nat)),SW_ATTRS);
    return {host,w,destroy(){mo.disconnect();w.destroy();if(!o.host)host.remove();}};
  };
  CONFIG.switches.forEach(s=>{
    const nat=$(s.btn);if(!nat)return;
    W[s.id||s.btn]=mount.toggle(nat,{id:s.id,label:s.label}).w;
  });
  // shared view menu: checkbox rows → label-first toggles; its reset sets .checked silently, so resync after it
  W.view=[];
  function mountView(){                                              // true once the menu exists and is mounted
    const vp=document.querySelector('#cw .f13v-p');if(!vp)return false;
    const cbs=[...vp.querySelectorAll('input[type=checkbox]')].filter(cb=>!cb.closest('[data-native]'));if(!cbs.length)return false;
    cbs.forEach(cb=>{
      const row=cb.closest('label')||cb,host=tgHost('f13w-tg-menu');
      row.before(host);row.setAttribute('data-native','toggle');
      W.view.push({cb,w:Liquid.ui.toggle(host,{...TG,checked:cb.checked,label:row.textContent.trim(),labelFirst:true,
        onChange:v=>{cb.checked=v;fire(cb,'change');}})});
    });
    const r=vp.querySelector('.f13v-r');if(r)r.addEventListener('click',()=>W.view.forEach(({cb,w})=>w.set(cb.checked)));
    return true;
  }
  if(CONFIG.viewMenu&&!mountView()){                                 // the menu may be built after us (the shared script, or the app's own handler): watch briefly
    const mo=new MutationObserver(()=>{if(mountView())stop();});
    const stop=()=>{mo.disconnect();clearTimeout(tm);window.removeEventListener('load',onLoad);};
    const onLoad=()=>{if(mountView())stop();};
    const tm=setTimeout(stop,5000);
    mo.observe(document.documentElement,{childList:true,subtree:true});
    window.addEventListener('load',onLoad);
  }

  // ---- run → progress button (synchronous solvers: busy slosh, then flood when results land) ----
  let running=false;
  if(CONFIG.run&&$(CONFIG.run.btn)&&$(CONFIG.run.host)){
    const rb=$(CONFIG.run.btn);rb.setAttribute('data-native','run');
    W.run=Liquid.ui.progressButton($(CONFIG.run.host),{label:rb.textContent.trim(),accent:ACC,size:CONFIG.run.size||SZ.run,onClick(){
      running=true;W.run.setBusy(true);W.run.setLabel('Running…');
      requestAnimationFrame(()=>requestAnimationFrame(()=>rb.click()));   // let the slosh paint before the solver blocks
    }});
    let labelSet=null;                                               // F13UI.run.label(text) in force (the native text does not override it)
    watch(rb,()=>{
      if(labelSet==null)W.run.setLabel(rb.textContent.trim());
      if(!rb.disabled&&running){running=false;W.run.setBusy(false);}   // ended without results
      W.run.setDisabled(rb.disabled&&!running);
    },['disabled']);
    // the app reports its own progress / refusal / cancel (no native button state involved)
    const R=UI.run;
    R.progress=p=>{
      running=true;
      if(p==null){W.run.setBusy(true);W.run.setProgress(null);}
      else W.run.setProgress(p);
    };
    R.label=t=>{labelSet=t==null?null:String(t);W.run.setLabel(labelSet==null?rb.textContent.trim():labelSet);};
    R.done=ok=>{
      running=false;labelSet=null;
      W.run.setProgress(ok===false?null:1);                          // 1: flood and pop. null: drain
      W.run.setBusy(false);                                          // a busy slosh with no progress yet ends too
      W.run.setLabel(rb.textContent.trim());
      W.run.setDisabled(rb.disabled);
    };
  }

  // ---- clip radio (axis accents; tap the active axis to release) ----
  if(CONFIG.clip&&$(CONFIG.clip.host)){
    const c=CONFIG.clip,host=$(c.host);
    const lbl=host.querySelector('.clip-lbl')||document.querySelector('#clipOverlay .clip-lbl')||Object.assign(document.createElement('span'),{className:'clip-lbl',textContent:'clip'});
    host.textContent='';host.append(lbl,document.createElement('div'));   // an existing label (and its styling) is reused
    document.documentElement.classList.add('f13w-clip');                  // hides the native #clipOverlay pills
    const AX=['x','y','z'];
    W.clip=Liquid.ui.radio(host.lastChild,{options:AX.map((a,i)=>({value:i+1,label:a.toUpperCase(),accent:Liquid.ACCENTS['axis'+a.toUpperCase()]})),
      value:c.get()||null,allowNone:true,orientation:'horizontal',size:c.size||SZ.clip,ariaLabel:'Clip plane',
      onChange:v=>c.set(v||0)});
    hook('onClipChange',n=>W.clip.set(n||null));
  }

  // ---- Recipe menu: Open recipe… / Export JSON / Queue / Mesh / Lab ----
  if(CONFIG.recipe&&$(CONFIG.recipe.host)){
    const R=CONFIG.recipe,I=Liquid.ICONS;
    I.recipe=I.recipe||'<path d="M14 3.5H7.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V7z"/><path d="M14 3.5V7h3.5"/><path d="M10 17.5v-6M8 13.3l2-2 2 2"/><path d="M14 11v6.2M12 15.2l2 2 2-2"/>';
    I.open=I.open||'<path d="M12 15.5V4.6M7.2 9.2 12 4.4l4.8 4.8"/><path d="M5 19.5h14"/>';
    const qMain=()=>document.querySelector('.fh-right .f13ldq-main'),qCaret=()=>document.querySelector('.fh-right .f13ldq-caret');
    // R.exportBtn: a native button id, or a function returning the active one (tools with modes, e.g. beam
    // Library / Builder). R.extra: more exports [{id,label,icon,btn,done}], btn an id or a function like exportBtn.
    // R.natives: every native export button id to hide (defaults to exportBtn when it's an id).
    const nat=x=>typeof x==='function'?x():$(x);
    const modal=typeof R.exportBtn==='function';
    const natives=R.natives||(modal?[]:[R.exportBtn]);
    natives.forEach(id=>{const n=$(id);if(n)n.setAttribute('data-native','export');});
    (R.extra||[]).forEach(x=>{if(typeof x.btn!=='function'){const n=$(x.btn);if(n)n.setAttribute('data-native','export');}});
    const exportBtn=nat(R.exportBtn);
    const ACTIONS={
      open(){if(window.F13Recipe)F13Recipe.open();},
      json(){const b=nat(R.exportBtn);if(b)b.click();},
      queue(){const m=qMain();if(m)m.click();else say('Queue is still loading — try again in a moment.');},
      choose(){const c=qCaret();if(c)c.click();},
      mesh(){R.mesh();},lab(){R.lab();}
    };
    (R.extra||[]).forEach(x=>{ACTIONS[x.id]=()=>{const b=nat(x.btn);if(b)b.click();};});
    const jsonLabel=()=>(exportBtn&&!modal)?exportBtn.textContent.trim().replace(/^Copied.*$/,'Export JSON'):'Export JSON';
    function items(){
      const real=!!qMain(),choose=real&&!!qCaret(),offline=!real&&!!$('f13ldq-fallback');
      const it=[];
      if(window.F13Recipe)it.push({id:'open',label:'Open recipe…',icon:'open'});
      if(exportBtn)it.push({id:'json',label:jsonLabel(),icon:'download'});
      (R.extra||[]).forEach(x=>it.push({id:x.id,label:x.label,icon:x.icon||'download'}));
      it.push({id:'queue',label:offline?'Queue (offline)':'Queue',icon:'queue',disabled:offline});
      if(choose)it.push({id:'choose',label:'Choose queue…',icon:'folder'});
      if(R.mesh)it.push({id:'mesh',label:'Mesh',icon:'layers'});
      if(R.lab)it.push({id:'lab',label:'Lab',icon:'flask'});
      return {key:it.map(x=>x.id+(x.disabled?'-':'')).join(),items:it};
    }
    let key;{const r=items();key=r.key;
      W.recipe=Liquid.ui.send($(R.host),{label:'Recipe',icon:'recipe',accent:ACC,ariaLabel:'Recipe',items:r.items,onSelect:id=>ACTIONS[id]&&ACTIONS[id]()});}
    const sync=()=>{const r=items();if(r.key===key)return;key=r.key;W.recipe.setItems(r.items);};
    let qText='Queue';
    watch(document.querySelector('.fh-right'),()=>{                  // the queue client mounts later
      sync();const m=qMain(),t=m?m.textContent.trim():'Queue';
      if(t!==qText){qText=t;if(t&&t!=='Queue')say(t);}
    });
    // native export buttons flash 'Copied' / 'Saved' when an export ran: say it in the header message
    const watchDone=(n,done,relabel)=>{if(n)watch(n,()=>{const t=n.textContent.trim();if(/^(Copied|Saved)/.test(t))say(done);else if(relabel)W.recipe.setItemState(relabel,{label:t});});};
    if(modal)natives.forEach(id=>watchDone($(id),'Recipe JSON copied and downloaded.'));
    else watchDone(exportBtn,'Recipe JSON copied and downloaded.','json');
    (R.extra||[]).forEach(x=>{const ids=typeof x.btn==='function'?(x.natives||[]):[x.btn];ids.forEach(id=>watchDone($(id),x.done||(x.label+' saved.')));});
    // F13Recipe loads after this block: refresh once the document has parsed (and on load, for late scripts)
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',sync);else setTimeout(sync,0);
    window.addEventListener('load',sync);
    UI.refreshRecipe=sync;
  }

  // ---- sections: rail (desktop) + tab bar (phone), results badge ----
  function mk(parent,cls){const d=document.createElement('div');d.className=cls;parent.appendChild(d);return d;}
  CONFIG.sections.forEach(s=>{                                       // a section icon not in Liquid.ICONS: reuse the fallback tab's drawn svg
    const svg=document.querySelector('.sb-fallback [data-section="'+s.id+'"] svg,#sectionsBar [data-section="'+s.id+'"] svg');
    if(svg&&!Liquid.ICONS[s.icon])Liquid.ICONS[s.icon]=svg.innerHTML;
  });
  W.rail=Liquid.ui.sections(mk($('sectionsRail'),'f13w-rail'),{items:CONFIG.sections,value:UI.active,orientation:'vertical',
    accent:ACC,ariaLabel:'Sections',onChange:id=>UI.showSection(id)});
  W.bar=Liquid.ui.sections(mk($('sectionsBar'),'f13w-bar'),{items:CONFIG.sections,value:UI.active,orientation:'horizontal',size:SZ.bar,
    accent:ACC,ariaLabel:'Sections',onChange:id=>UI.showSection(id)});
  // per-section disabled: dimmed, still opens (the section shows its own note). CONFIG.sections[i].disabled for the initial state.
  UI.setSectionDisabled=(id,on)=>{W.rail.setItemState(id,{disabled:!!on});W.bar.setItemState(id,{disabled:!!on});};
  let badge=null;                                                   // 'running' | 'new' | 'stale' | null
  const A=CONFIG.analyzeSection;
  function setBadge(b){if(!A)return;badge=b;const v=b?'dot':null,o={accent:b==='stale'?'amber':'coral'};W.rail.setBadge(A,v,o);W.bar.setBadge(A,v,o);}
  const seen=()=>UI.active===A;
  hook('onSectionChange',id=>{W.rail.set(id);W.bar.set(id);if(badge&&badge!=='running'&&seen())setBadge(null);});
  hook('onAnalyze',s=>{
    if(s==='running'){setBadge('running');if(W.run&&!running){running=true;W.run.setBusy(true);}}
    else if(s==='new'){running=false;if(W.run)W.run.setProgress(1);setBadge(seen()?null:'new');}
    else if(s==='stale')setBadge(seen()?null:'stale');
  });

  // ---- help: each drawer card whose control lives in a section gets a "show" button ----
  // Targets: CONFIG.helpTargets and a tool's own F13UI.helpTargets (read at call time, wins): id → selector,
  // "a, b" (first drawn candidate), or {sel, note}. `note` is what a hidden control says ("Helicoid only").
  // revealControl(sel, id) COMPOSES with a revealControl a tool defined earlier: visible controls land on their
  // row / widget here; a control hidden by the current mode (its row not drawn) goes to the earlier function
  // (its own message path), else says its note (default text below). It never flashes a whole section.
  const prevReveal=typeof UI.revealControl==='function'&&!UI.revealControl.f13wire?UI.revealControl:null;
  const targets=()=>Object.assign({},CONFIG.helpTargets,UI.helpTargets);
  const vis=n=>!!(n&&n.getClientRects().length);
  function resolveEl(sel){
    if(sel&&typeof sel==='object'&&!sel.nodeType)sel=sel.sel;
    if(typeof sel!=='string')return sel||null;
    const cs=sel.split(',').map(s=>document.querySelector(s.trim())).filter(Boolean);
    return cs.find(vis)||cs[0]||null;
  }
  UI.revealControl=function(sel,id){
    const spec=sel==null&&id!=null?targets()[id]:sel;
    const el=resolveEl(spec);
    if(!el){                                                         // the target does not exist now (a closed editor, a part not loaded): say so, never nothing
      const t=id!=null?targets()[id]:null,note=(t&&typeof t==='object'&&t.note)||(spec&&typeof spec==='object'&&spec.note);
      say(note||'This control is not shown right now.');
      return false;
    }
    const sec=UI.sectionOf(el);if(sec)UI.showSection(sec);
    const inViewer=!!(el.closest&&el.closest('#viewPane'));
    // a control in the viewer (clip, view) lies under a full sheet: collapse to peek; sheet controls need the sheet full
    if(UI.isPhone()&&UI.setSheet)UI.setSheet(inViewer?'peek':'full');
    // natives are hidden ([data-native]): land on the visible row, else the widget mounted beside the native,
    // else (the native alone is hidden) its parent. A row hidden by the current mode lands nowhere.
    let row=el.closest('.sc-group')||el;
    if(!vis(row)){
      let top=el;while(top.parentElement&&!vis(top.parentElement))top=top.parentElement;
      const sib=top===el&&[el.nextElementSibling,el.previousElementSibling].find(n=>n&&/(^|\s)f13w-/.test(n.className)&&vis(n));
      const par=top===el?el.parentElement:null;
      row=sib||(par&&!par.matches('.sec,#ctrlScroll,#ctrlPane,#main,body,html')?par:null);
    }
    if(!row){
      if(prevReveal){try{return prevReveal.call(UI,(spec&&spec.sel)||spec,id);}catch(e){console.error(e);}}
      const t=id!=null?targets()[id]:null,note=(t&&typeof t==='object'&&t.note)||(sel&&typeof sel==='object'&&sel.note);
      say(note||'This control is hidden in the current mode.');
      return false;
    }
    if(!inViewer)row.scrollIntoView({block:'center',behavior:Liquid.state.reduce?'auto':'smooth'});
    row.classList.remove('f13w-flash');void row.offsetWidth;row.classList.add('f13w-flash');
    setTimeout(()=>row.classList.remove('f13w-flash'),1400);
    return true;
  };
  UI.revealControl.f13wire=true;
  const SHOW_ICON='<svg class="ic sm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4"/></svg>';
  function addShowButtons(){
    Object.keys(targets()).forEach(id=>{
      const h=document.querySelector('#f13h-card-'+id+' .f13h-card-h');if(!h||h.querySelector('.f13w-show'))return;
      const b=document.createElement('button');b.type='button';b.className='f13w-show';b.innerHTML=SHOW_ICON+'<span>show</span>';
      b.setAttribute('aria-label','Show this control');
      b.addEventListener('click',e=>{e.stopPropagation();const s=document.querySelector('.f13h-scrim.open');if(s)s.click();UI.revealControl(targets()[id],id);});
      h.appendChild(b);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(addShowButtons,0));else setTimeout(addShowButtons,0);
  window.addEventListener('load',addShowButtons);                    // a tool setting F13UI.helpTargets / the help block later
  UI.__flushReady();                                                 // everything above is mounted: release F13UI.ready callbacks
})();
