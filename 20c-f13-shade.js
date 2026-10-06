/* ============================================================
   F13LD.lab · 20c-f13-shade.js
   Shared F13LD viewer shading (GLSL block used by 21-raymarcher.js)
   and the shared "◐ view" menu. Both blocks are byte-identical
   copies of the ones in every F13LD tool — edit them everywhere
   at once, never here alone.
   ============================================================ */

// ==== F13LD-SHADE v1 · shared viewer shading (GLSL). Keep this block byte-identical in every F13LD tool. ====
// The shader using it must define  float f13Map(vec3 p)  (distance to the visible
// surface, clipped to the visible domain) BEFORE inserting F13_SHADE_GLSL.
// Works in GLSL ES 1.00 and 3.00. f13Shade() returns a tone-mapped sRGB color.
const F13_SHADE_GLSL = `
uniform float uF13Shadow;uniform float uF13AO;uniform float uF13WarmCool;uniform float uF13Cut;uniform float uF13Lime;uniform float uF13Interact;
vec3 f13Lin(vec3 c){return pow(max(c,vec3(0.0)),vec3(2.2));}
vec3 f13Tone(vec3 c){c=(c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14);return pow(clamp(c,0.0,1.0),vec3(1.0/2.2));}
vec3 f13KeyDir(mat3 R){return normalize(-0.55*R[0]+0.75*R[1]+0.55*R[2]);}
vec3 f13FillDir(mat3 R){return normalize(0.7*R[0]-0.35*R[1]+0.25*R[2]);}
float f13AO(vec3 p,vec3 n,float cell,float eps){
  float occ=0.0;float w=1.0;
  for(int i=0;i<5;i++){float h=cell*(0.04+0.04*float(i))+2.0*eps;float d=f13Map(p+n*h);occ+=max(h-d,0.0)*w;w*=0.8;}
  return clamp(1.0-occ*(3.2/cell),0.0,1.0);
}
float f13Shadow(vec3 ro,vec3 ld,float eps,float tMax){
  float res=1.0;float t=4.0*eps;
  for(int i=0;i<48;i++){float h=f13Map(ro+ld*t);res=min(res,8.0*h/t);t+=clamp(h,0.75*eps,tMax*0.05);if(res<0.02||t>tMax)break;}
  return clamp(res,0.0,1.0);
}
vec3 f13Shade(vec3 base,vec3 p,vec3 n,vec3 rd,mat3 R,bool isCut,float cell,float eps,float tMax){
  vec3 alb=f13Lin(base);
  if(uF13Cut>0.5&&isCut){float lum=dot(alb,vec3(0.2126,0.7152,0.0722));alb=mix(alb,vec3(lum),0.3)*0.9;}
  bool wc=uF13WarmCool>0.5;
  vec3 kD=f13KeyDir(R);vec3 fD=f13FillDir(R);
  vec3 kC=wc?vec3(1.0,0.93,0.82)*1.35:vec3(1.3);
  vec3 fC=wc?vec3(0.30,0.42,0.62)*0.75:vec3(0.5);
  float kd=max(dot(n,kD),0.0);
  float sh=1.0;if(uF13Shadow>0.5&&uF13Interact<0.5&&kd>0.0)sh=f13Shadow(p+n*3.0*eps,kD,eps,tMax);
  float ao=1.0;if(uF13AO>0.5)ao=f13AO(p,n,cell,eps);
  float hemi=0.5+0.5*dot(n,R[1]);
  vec3 amb=mix(vec3(0.10,0.09,0.08),wc?vec3(0.20,0.23,0.30):vec3(0.24),hemi);
  float vf=max(dot(n,-rd),0.0);
  vec3 col=alb*(kC*kd*sh+fC*max(dot(n,fD),0.0)*mix(0.4,1.0,ao)+vec3(0.30)*vf*ao+amb*ao);
  col+=vec3(0.35)*pow(max(dot(n,normalize(kD-rd)),0.0),48.0)*sh;
  float fr=pow(1.0-vf,3.0);
  if(uF13Lime>0.5)col+=f13Lin(vec3(0.784,0.961,0.259))*0.9*fr*ao;else col+=(alb*0.6+vec3(0.06))*fr*ao*0.5;
  return f13Tone(col);
}
vec3 f13ShadeData(vec3 dataCol,vec3 p,vec3 n,vec3 rd,mat3 R,float cell,float eps,float tMax){
  vec3 kD=f13KeyDir(R);float kd=max(dot(n,kD),0.0);
  float sh=1.0;if(uF13Shadow>0.5&&uF13Interact<0.5&&kd>0.0)sh=f13Shadow(p+n*3.0*eps,kD,eps,tMax);
  float ao=1.0;if(uF13AO>0.5)ao=f13AO(p,n,cell,eps);
  float lit=(0.42+0.58*kd*sh)*mix(0.65,1.0,ao)+0.12*max(dot(n,-rd),0.0);
  return clamp(dataCol*lit+vec3(0.18)*pow(max(dot(n,normalize(kD-rd)),0.0),48.0)*sh,0.0,1.0);
}
`;
// ==== /F13LD-SHADE ====
// ==== F13LD-VIEW v1 · shared viewer "view" menu (JS). Keep this block byte-identical in every F13LD tool. ====
// f13ViewInit({tool, host, canvas, redraw, moving, css}) adds a "◐ view" menu to
// host (a position:relative viewport box) and returns {opts, apply(gl,prog)}.
// apply() sets the F13_SHADE_GLSL uniforms. Soft shadows pause while the user
// orbits/zooms the canvas, drags a slider, or while moving() returns true.
function f13ViewInit(cfg){
  var DEF={shadows:true,occlusion:true,warmCool:true,cutFaces:true,limeEdges:false};
  var LBL={shadows:'Shadows',occlusion:'Occlusion',warmCool:'Warm / cool light',cutFaces:'Shade cut faces',limeEdges:'Lime edges'};
  var key='f13ld.'+cfg.tool+'.view',o={},k;
  for(k in DEF)o[k]=DEF[k];
  try{var j=JSON.parse(localStorage.getItem(key)||'null');if(j&&typeof j==='object'){for(k in DEF){if(typeof j[k]==='boolean')o[k]=j[k];}}}catch(e){}
  var st={opts:o,interacting:false};
  function save(){try{localStorage.setItem(key,JSON.stringify(o));}catch(e){}}
  function redraw(){if(cfg.redraw)cfg.redraw();}
  if(!document.getElementById('f13vStyle')){
    var s=document.createElement('style');s.id='f13vStyle';
    s.textContent='.f13v{position:absolute;top:10px;left:10px;z-index:20;font:10px "IBM Plex Mono",ui-monospace,monospace}'+
      '.f13v>button{font:inherit;color:#8a8aa0;background:rgba(6,8,15,.85);border:.5px solid #2a2a3a;border-radius:5px;padding:3px 8px;cursor:pointer}'+
      '.f13v>button:hover,.f13v>button[aria-expanded=true]{color:#e0e0ff;border-color:#888}'+
      '.f13v-p{margin-top:4px;display:flex;flex-direction:column;gap:2px;background:rgba(6,8,15,.92);border:.5px solid #2a2a3a;border-radius:6px;padding:6px 10px 6px 8px;min-width:150px}'+
      '.f13v-p[hidden]{display:none}'+
      '.f13v-p label{display:flex;align-items:center;gap:7px;color:#e0e0ff;font-size:11px;cursor:pointer;user-select:none;min-height:24px;white-space:nowrap}'+
      '.f13v-p input{width:13px;height:13px;margin:0;accent-color:#22d3ee;cursor:pointer}'+
      '.f13v-p .f13v-r{align-self:flex-start;margin-top:3px;font:inherit;color:#8a8aa0;background:none;border:.5px solid #2a2a3a;border-radius:4px;padding:1px 7px;cursor:pointer}';
    document.head.appendChild(s);
  }
  if(cfg.host){
    var w=document.createElement('div');w.className='f13v';if(cfg.css)w.style.cssText=cfg.css;
    var b=document.createElement('button');b.type='button';b.textContent='◐ view';b.title='Viewer shading options';b.setAttribute('aria-expanded','false');
    var p=document.createElement('div');p.className='f13v-p';p.hidden=true;
    var boxes={};
    for(k in DEF){(function(k){var l=document.createElement('label'),c=document.createElement('input');c.type='checkbox';c.checked=o[k];
      c.addEventListener('change',function(){o[k]=c.checked;save();redraw();});boxes[k]=c;l.appendChild(c);l.appendChild(document.createTextNode(LBL[k]));p.appendChild(l);})(k);}
    var r=document.createElement('button');r.type='button';r.className='f13v-r';r.textContent='reset';
    r.addEventListener('click',function(){for(var q in DEF){o[q]=DEF[q];boxes[q].checked=DEF[q];}save();redraw();});p.appendChild(r);
    function setOpen(v){p.hidden=!v;b.setAttribute('aria-expanded',v?'true':'false');}
    b.addEventListener('click',function(e){e.stopPropagation();setOpen(p.hidden);});
    p.addEventListener('click',function(e){e.stopPropagation();});
    ['mousedown','touchstart','pointerdown','wheel'].forEach(function(ev){w.addEventListener(ev,function(e){e.stopPropagation();},{passive:true});});
    document.addEventListener('click',function(){if(!p.hidden)setOpen(false);});
    w.appendChild(b);w.appendChild(p);cfg.host.appendChild(w);
  }
  var tmr=null;
  function begin(){st.interacting=true;}
  function end(){if(st.interacting){st.interacting=false;redraw();}}
  function endSoon(){begin();clearTimeout(tmr);tmr=setTimeout(end,200);}
  if(cfg.canvas){
    cfg.canvas.addEventListener('mousedown',begin);
    cfg.canvas.addEventListener('touchstart',begin,{passive:true});
    cfg.canvas.addEventListener('wheel',endSoon,{passive:true});
  }
  window.addEventListener('mouseup',end);
  window.addEventListener('touchend',function(e){if(!e.touches||!e.touches.length)end();});
  document.addEventListener('input',function(e){var t=e.target;if(t&&t.type==='range')endSoon();},true);
  var locs=typeof WeakMap!=='undefined'?new WeakMap():null;
  st.apply=function(gl,prog){
    if(!gl||!prog)return;
    var L=locs&&locs.get(prog);
    if(!L){L={};['uF13Shadow','uF13AO','uF13WarmCool','uF13Cut','uF13Lime','uF13Interact'].forEach(function(n){L[n]=gl.getUniformLocation(prog,n);});if(locs)locs.set(prog,L);}
    var mv=st.interacting||(cfg.moving?!!cfg.moving():false);
    if(L.uF13Shadow)gl.uniform1f(L.uF13Shadow,o.shadows?1:0);
    if(L.uF13AO)gl.uniform1f(L.uF13AO,o.occlusion?1:0);
    if(L.uF13WarmCool)gl.uniform1f(L.uF13WarmCool,o.warmCool?1:0);
    if(L.uF13Cut)gl.uniform1f(L.uF13Cut,o.cutFaces?1:0);
    if(L.uF13Lime)gl.uniform1f(L.uF13Lime,o.limeEdges?1:0);
    if(L.uF13Interact)gl.uniform1f(L.uF13Interact,mv?1:0);
  };
  return st;
}
// ==== /F13LD-VIEW ====

/* Body color per family for the geometry/deformed views — the same family
   colors F13LD.mesh uses, so a design looks the same in its tool, in Mesh
   and here. */
var LAB_FAMILY_COLOR = {
  tpms:  '#5ecaa5',
  noise: '#ea7050',
  grain: '#a8a59a',
  foam:  '#E8D4A2',
  wave:  '#D97706',
  beam:  '#b8cf50',
  bundle:'#7B4F9E',
  'import': '#b4b8bf'
};

/* One shared view menu for every design card, docked in the VIEW strip. */
var f13View = null;
(function(){
  var strip = document.querySelector('.view-strip');
  if (!strip) return;
  var host = document.createElement('div');
  host.id = 'f13ViewHost';
  host.style.cssText = 'position:relative;margin-left:auto;width:74px;height:22px;flex-shrink:0';
  strip.appendChild(host);
  f13View = f13ViewInit({
    tool: 'lab',
    host: host,
    canvas: document.getElementById('compareGrid'),
    css: 'top:0;left:0',
    redraw: function(){
      if (typeof LAB_RM_REGISTRY === 'undefined') return;
      for (var k in LAB_RM_REGISTRY) { var r = LAB_RM_REGISTRY[k]; if (r) { r._dirty = true; if (r._nlPaused) r._nlDrawOnce = true; } }
    }
  });
})();
