global.NO_RUN=1; (0,eval)(require('fs').readFileSync(FEDIR+'/run_design.js','utf8'));
var D=process.env.D||'schwarzP', N=+(process.env.N||32), tp=process.env.TYPE||'H8I';
var s=pruneToLargestComponent(mkSolid(D,N),N);
var t0=performance.now(); var ed=fe_elementData(110000,0.34,tp), mesh=fe_mesh(s,N), ops=fe_makeOps(mesh,ed); var tMesh=performance.now()-t0;
t0=performance.now(); var mg=fe_makeMG(ops,mesh,ed,{nu:+(process.env.NUS||1)}); var tMG=performance.now()-t0;
var n=ops.n, x=new Float64Array(n).map(function(){return Math.random()-0.5}), y=new Float64Array(n), z=new Float64Array(n);
ops.setPrestress(x,[0,0,-1,0,0,0],false);
function tm(f,k){ f(); var t=performance.now(); for(var i=0;i<k;i++) f(); return (performance.now()-t)/k; }
var tK=tm(function(){ops.applyK(x,y)},10), tAB=tm(function(){ops.applyAB1(x,y,z)},10), tA=tm(function(){ops.applyA1(x,y)},10), tV=tm(function(){mg.apply(x,y)},5);
var mem={ vecMB:+(n*8/1e6).toFixed(2), connMB:+(mesh.en.byteLength/1e6).toFixed(2), MgPerElemMB:+(ops.mgBytes()/1e6).toFixed(2), sigAvgMB:+(mesh.nel*6*8/1e6).toFixed(2), sigGPMB:+(mesh.nel*48*8/1e6).toFixed(2), mgLevelsMB:+(mg.memBytes/1e6).toFixed(2), lobpcgBlockMB_est:+(4*3*3*3*n*8/1e6).toFixed(1) };
console.log(JSON.stringify({design:D,N:N,type:tp,rho:+(mesh.nel/mesh.N3).toFixed(3),nel:mesh.nel,nDof:n,ms_applyK:+tK.toFixed(1),ms_applyA:+tA.toFixed(1),ms_applyAB_fused:+tAB.toFixed(1),ms_MG_vcycle:+tV.toFixed(1),ms_mesh:+tMesh.toFixed(0),ms_MGsetup:+tMG.toFixed(0),mgLevels:mg.levels,mem:mem, rss_MB:+(process.memoryUsage().rss/1e6).toFixed(0)}));
