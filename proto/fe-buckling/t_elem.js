/* element sanity: Ke null space, bending check, full-solid patch test, operator symmetry */
['H8','H8I'].forEach(function(tp){
  var ed=fe_elementData(1,0.3,tp);
  var ev=bk_jacobiSym(ed.Ke,24,200,1e-15).values; var s=Array.from(ev).sort(function(a,b){return a-b});
  console.log(tp,'Ke eig smallest 8:',s.slice(0,8).map(function(v){return v.toExponential(2)}).join(' '));
  /* pure bending of a single cube: u_x = -? use u_z = x*z (curvature) ; energy ratio vs exact */
  var u=new Float64Array(24); for(var a=0;a<8;a++){var X=(a>>2)&1,Z=a&1, x=X-0.5,z=Z-0.5; u[3*a+2]= x*z; u[3*a]=-0.0; }
  var Ku=fe_mm(ed.Ke,u,24,24,1), e=0.5*fe_dot(u,Ku);
  /* exact pure bending energy: displacement uz=x z (not pure bending exactly); report ratio vs a 'parasitic shear free' ref from H8I */
  console.log(tp,'energy of u_z=x*z mode:',e.toFixed(5));
});
/* full solid N=4: macroRHS must vanish (patch test) and C̄ = C */
var N=4, solid=new Float32Array(64).fill(1);
['H8','H8I'].forEach(function(tp){
  var ed=fe_elementData(110000,0.34,tp), mesh=fe_mesh(solid,N), ops=fe_makeOps(mesh,ed);
  var f=ops.macroRHS([0,0,1,0,0.5,0]); console.log(tp,'patch rhs max',Math.max.apply(null,Array.from(f).map(Math.abs)).toExponential(2));
  var sb=ops.avgStress(new Float64Array(ops.n),[0,0,1,0,0,0]); console.log(tp,'sBar(e_zz)',sb.map(function(v){return v.toFixed(1)}).join(' '),' C33=',ed.C[14].toFixed(1),'C13=',ed.C[2].toFixed(1));
  /* symmetry of K and Kg on a random solid */
  var s2=new Float32Array(512); for(var i=0;i<512;i++) s2[i]=Math.random()<0.6?1:0;
  var m2=fe_mesh(s2,8), o2=fe_makeOps(m2,ed); var x=new Float64Array(o2.n).map(Math.random), y=new Float64Array(o2.n).map(Math.random);
  var Kx=new Float64Array(o2.n),Ky=new Float64Array(o2.n); o2.applyK(x,Kx); o2.applyK(y,Ky);
  var u0=new Float64Array(o2.n).map(function(){return Math.random()-0.5}); o2.setPrestress(u0,[0.1,0,-1,0,0,0.2],false);
  var Ax=new Float64Array(o2.n),Ay=new Float64Array(o2.n),Bx=new Float64Array(o2.n),By=new Float64Array(o2.n); o2.applyAB1(x,Ax,Bx); o2.applyAB1(y,Ay,By);
  console.log(tp,'K sym',Math.abs(fe_dot(y,Kx)-fe_dot(x,Ky))/Math.abs(fe_dot(y,Kx)),'Kg sym',Math.abs(fe_dot(y,Ax)-fe_dot(x,Ay))/Math.abs(fe_dot(y,Ax)),'B==K',Math.abs(fe_dot(y,Bx)-fe_dot(y,Kx))/Math.abs(fe_dot(y,Kx)));
});
