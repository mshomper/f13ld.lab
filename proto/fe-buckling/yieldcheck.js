/* First-yield estimate from the SAME FE prestress: macro uniaxial stress at which the von Mises stress
   first reaches sigY0 = 950 MPa (NL_MAT_DEFAULT) at the p-th percentile of solid element-average VM.
   Voxel stair-step corners give singular peaks, so report p100 / p99 / p95.  Compare with p_cr. */
global.NO_RUN=1; (0,eval)(require('fs').readFileSync(FEDIR+'/run_design.js','utf8'));
var sy=950, cases=(process.env.CASES||'schwarzP:32').split(',');
cases.forEach(function(cs){ var p=cs.split(':'), D=p[0], N=+p[1];
  var s=pruneToLargestComponent(mkSolid(D,N),N), ed=fe_elementData(110000,0.34,'H8I'), mesh=fe_mesh(s,N), ops=fe_makeOps(mesh,ed), mg=fe_makeMG(ops,mesh,ed,{nu:1});
  var pre=fe_prestress(ops,mg.apply,{cgTol:1e-8,cgMaxiter:2000}), U=pre.uni(2);
  var um=ops.macroLocal(U.eb), C=ed.C, vm=new Float64Array(mesh.nel), ue=new Float64Array(24);
  var nA=mesh.nA; for(var e=0;e<mesh.nel;e++){ for(var a=0;a<8;a++){var nd=mesh.en[e*8+a]; ue[3*a]=U.u[nd]+um[3*a]; ue[3*a+1]=U.u[nA+nd]+um[3*a+1]; ue[3*a+2]=U.u[2*nA+nd]+um[3*a+2];}
    var sg=[0,0,0,0,0,0]; for(var g=0;g<8;g++){var B=ed.Beff[g]; var ep=[0,0,0,0,0,0]; for(var P=0;P<6;P++){var t=0; for(var c=0;c<24;c++) t+=B[P*24+c]*ue[c]; ep[P]=t;} for(var P2=0;P2<6;P2++){var t2=0; for(var Q=0;Q<6;Q++) t2+=C[P2*6+Q]*ep[Q]; sg[P2]+=t2/8;}}
    vm[e]=Math.sqrt(0.5*((sg[0]-sg[1])*(sg[0]-sg[1])+(sg[1]-sg[2])*(sg[1]-sg[2])+(sg[2]-sg[0])*(sg[2]-sg[0]))+3*(sg[3]*sg[3]+sg[4]*sg[4]+sg[5]*sg[5])); }
  /* prestress = unit axial strain ⇒ macro stress = Ea.  VM per unit macro stress = vm/Ea */
  var srt=Array.from(vm).sort(function(a,b){return a-b}), q=function(f){return srt[Math.min(srt.length-1,Math.floor(f*srt.length))]};
  var out={design:D,N:N,rho:+(mesh.nel/mesh.N3).toFixed(4),Ea:+U.Ea.toFixed(0)};
  [['p100',1],['p99',0.99],['p95',0.95]].forEach(function(k){ out['firstYield_'+k[0]+'_MPa']=+(sy*U.Ea/q(k[1])).toFixed(1); });
  console.log(JSON.stringify(out));
});
