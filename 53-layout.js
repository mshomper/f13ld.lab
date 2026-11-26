/* ============================================================================
   F13LD UI template · layout.js — sections (one at a time) + phone bottom sheet.
   Extracted from F13LD.tpms v1.4.0. Generic: sections come from .sec[data-section] in DOM order.
   window.F13UI is the hook surface the wiring and the widgets use:
     F13UI.sections / active / isPhone() / showSection(id) / scrollToSection(id) (alias)
     F13UI.sectionOf(el) / setSheet('peek'|'full')
     F13UI.onSectionChange(id)  set by f13ui-wire.js
   Optional options, set on window.F13UI BEFORE this script (all have defaults, so a tool needs no edit here):
     F13UI.headerSelector   the header element (default .f13ld-header, #hdr, header); --hdr-h follows its height
     F13UI.onResize()       the viewer's redraw, called when the layout changes (also the 'f13ui-resize' event)
     F13UI.viewMenuSelector the button that opens the viewer's view menu (default '#cw .f13v>button')
   Run it after the markup exists (end of body, or in the app script after the DOM is built).
   ========================================================================== */
/* F13LD.lab: everything below this block is the template layout.js, unchanged. Lab's options (set before the template code reads them):
   the viewer redraw (tiles only, never a grid rebuild: renderDesignGrid is not called per sheet change) and the ◐ view opener. */
window.F13UI=window.F13UI||{};
window.F13UI.headerSelector='.f13ld-header';
window.F13UI.onResize=function(){
  if(typeof LAB_RM_REGISTRY!=='undefined')for(var k in LAB_RM_REGISTRY){var r=LAB_RM_REGISTRY[k];if(r)r._dirty=true;}   // the tiles changed size: redraw
  if(typeof labShellResized==='function')labShellResized();                                                              // 53b: Results table, Plotly, design switch
};
window.F13UI.viewMenuSelector='#f13ViewHost .f13v>button';

(function(){
  const UI=window.F13UI=window.F13UI||{};
  const SECS=[...document.querySelectorAll('.sec[data-section]')].map(s=>s.dataset.section);   // order = DOM order
  const mq=window.matchMedia('(max-width:899px)');
  const scroller=document.getElementById('ctrlScroll');
  const pane=document.getElementById('ctrlPane');
  const secEl=id=>document.getElementById('sec-'+id);
  UI.sections=SECS.slice();
  UI.active=SECS[0];
  UI.isPhone=()=>mq.matches;
  function setActive(id){
    if(!SECS.includes(id)||id===UI.active)return;
    UI.active=id;
    // open dropdown / Recipe overlays are fixed-position and would outlive the section they were opened from
    try{window.dispatchEvent(new Event('f13ui-section'));}catch(e){}
    document.querySelectorAll('.sb-fallback [data-section]').forEach(b=>b.classList.toggle('on',b.dataset.section===id));
    if(UI.onSectionChange)try{UI.onSectionChange(id);}catch(e){console.error(e);}
  }
  function applySections(){
    SECS.forEach(s=>secEl(s).classList.toggle('on',s===UI.active));
    updateFades();
  }
  UI.showSection=function(id){
    if(!SECS.includes(id))return;
    const changed=id!==UI.active;
    setActive(id);applySections();
    if(changed)scroller.scrollTop=0;
  };
  UI.scrollToSection=UI.showSection;
  UI.sectionOf=function(el){const s=el&&el.closest&&el.closest('.sec[data-section]');return s?s.dataset.section:null;};
  // the column scrolls only when the active section is taller than it; fade only the edges that hide content
  function updateFades(){
    const y=scroller.scrollTop,max=scroller.scrollHeight-scroller.clientHeight;
    scroller.classList.toggle('ft',y>1);
    scroller.classList.toggle('fb',max-y>1);
  }
  scroller.addEventListener('scroll',updateFades,{passive:true});
  if(window.ResizeObserver){const ro=new ResizeObserver(updateFades);ro.observe(scroller);SECS.forEach(s=>ro.observe(secEl(s)));}
  document.querySelectorAll('.sb-fallback [data-section]').forEach(b=>b.addEventListener('click',()=>UI.showSection(b.dataset.section)));

  // header height drives the phone viewer height (the header wraps on phones)
  // The header is F13UI.headerSelector (set before this script), else .f13ld-header, #hdr, or the first <header>; none: skipped.
  const hdr=(UI.headerSelector&&document.querySelector(UI.headerSelector))||document.querySelector('.f13ld-header')||document.getElementById('hdr')||document.querySelector('header');
  function setHdr(){document.documentElement.style.setProperty('--hdr-h',hdr.offsetHeight+'px');}
  if(hdr){setHdr();if(window.ResizeObserver)new ResizeObserver(setHdr).observe(hdr);}

  // phone bottom sheet: drag the handle between peek (~45dvh) and full (~88dvh)
  const handle=document.getElementById('sheetHandle');
  let sheetState='peek';
  const vh=()=>window.innerHeight;
  const snapH=s=>Math.round(vh()*(s==='full'?0.88:0.45));
  function setSheet(s,animate){
    sheetState=s;
    if(!animate)pane.classList.add('dragging');
    pane.style.setProperty('--sheet-h',snapH(s)+'px');
    if(!animate)requestAnimationFrame(()=>pane.classList.remove('dragging'));
  }
  UI.setSheet=s=>{if(s==='peek'||s==='full')setSheet(s,true);};
  // viewer overlays (clip, view menu) lie under a full sheet: anything that targets the viewer collapses it to peek first
  UI.peekForViewer=()=>{if(mq.matches&&sheetState==='full')setSheet('peek',true);};
  UI.sheetState=()=>sheetState;
  // the shared view menu (F13LD-VIEW) is not edited: opening it from the button also brings the viewer into view
  // (the opener is F13UI.viewMenuSelector, default '#cw .f13v>button'; read at click time)
  document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest(UI.viewMenuSelector||'#cw .f13v>button'))UI.peekForViewer();},true);
  let dragY=null,startH=0,lastY=0,lastT=0,vel=0,moved=false;
  handle.addEventListener('pointerdown',e=>{
    if(!mq.matches)return;
    dragY=e.clientY;lastY=e.clientY;lastT=performance.now();vel=0;moved=false;
    startH=pane.getBoundingClientRect().height;
    pane.classList.add('dragging');handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove',e=>{
    if(dragY===null)return;
    const dy=e.clientY-dragY;if(Math.abs(dy)>4)moved=true;
    const h=Math.max(snapH('peek')*0.6,Math.min(snapH('full'),startH-dy));
    pane.style.setProperty('--sheet-h',h+'px');
    const t=performance.now();vel=(e.clientY-lastY)/Math.max(1,t-lastT);lastY=e.clientY;lastT=t;
  });
  function endDrag(){
    if(dragY===null)return;
    dragY=null;pane.classList.remove('dragging');
    if(!moved){setSheet(sheetState==='peek'?'full':'peek',true);return;}
    const h=pane.getBoundingClientRect().height,mid=(snapH('peek')+snapH('full'))/2;
    setSheet(vel<-0.4?'full':vel>0.4?'peek':(h>mid?'full':'peek'),true);
  }
  handle.addEventListener('pointerup',endDrag);
  handle.addEventListener('pointercancel',endDrag);
  handle.addEventListener('click',e=>{if(e.detail===0&&mq.matches)setSheet(sheetState==='peek'?'full':'peek',true);});   // keyboard

  function applyLayout(){
    applySections();
    if(mq.matches)setSheet(sheetState,false);
    else pane.style.removeProperty('--sheet-h');
    // the viewer changed size: redraw. Hooks (all optional, read now): F13UI.onResize() (a tool sets it, e.g. rm._dirty=true),
    // a 'f13ui-resize' window event, and a global requestRender() (the original template's hook)
    if(typeof UI.onResize==='function')try{UI.onResize();}catch(e){console.error(e);}
    try{window.dispatchEvent(new Event('f13ui-resize'));}catch(e){}
    if(typeof requestRender==='function')requestRender();
  }
  mq.addEventListener?mq.addEventListener('change',applyLayout):mq.addListener(applyLayout);
  window.addEventListener('resize',()=>{if(mq.matches)setSheet(sheetState,false);});
  applyLayout();
})();
