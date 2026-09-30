/* Design runner: D=schwarzP|pshell|gyroidSheet, N, TYPES, AXES, PREC.  Needs speed/designs.js-like builder (inlined). */
function mkSolid(name,N){
  var r;
  if (name==='schwarzP') r = DEMO_SCHWARZ_P;
  else if (name==='pshell') { r = JSON.parse(JSON.stringify(DEMO_SCHWARZ_P)); r.geometry.mode='shell'; r.geometry.wallThickness=+(process.env.WT||0.25); }
  else if (name==='gyroidSheet') { r = JSON.parse(JSON.stringify(DEMO_SCHWARZ_P)); r.surface.terms=[
      {on:true,coef:1,factors:[{trig:'sin(x)',fx:1,fy:1,fz:1},{trig:'cos(y)',fx:1,fy:1,fz:1}]},
      {on:true,coef:1,factors:[{trig:'sin(y)',fx:1,fy:1,fz:1},{trig:'cos(z)',fx:1,fy:1,fz:1}]},
      {on:true,coef:1,factors:[{trig:'sin(z)',fx:1,fy:1,fz:1},{trig:'cos(x)',fx:1,fy:1,fz:1}]}];
    r.geometry.mode='shell'; r.geometry.wallThickness=+(process.env.WT||0.2); }
  var params = KERNELS[r.family].parseRecipe(r), a = resolveBuildArgs(r);
  return buildVoxels(r.family, params, a.offset, N, a.mode, a.wt, a.nWeights, a.pipeR, a.phaseShift);
}
global.mkSolid=mkSolid;
if (!global.NO_RUN) {
var D=process.env.D||'schwarzP', Ns=(process.env.NS||'16').split(',').map(Number), types=(process.env.TYPES||'H8,H8I').split(','), axes=(process.env.AXES||'2').split(',').map(Number);
Ns.forEach(function(N){ types.forEach(function(tp){
  var s=mkSolid(D,N);
  var conn=checkVoxelConnectivity(s,N);
  var r=fe_buckle(s,N,{type:tp,axes:axes,block:+(process.env.M||4),eigTol:+(process.env.ETOL||1e-6),resTol:+(process.env.RTOL||1e-2),eigIters:+(process.env.IT||800),precond:process.env.PREC||'jacobi',stressAvg:process.env.AVG==='1',seed:+(process.env.SEED||12345),mg:{levels:+(process.env.LEV||0)||undefined,nu:+(process.env.NUS||0)||undefined}});
  var rec={design:D,avgStress:process.env.AVG==='1',wt:process.env.WT||null,N:N,type:tp,precond:r.precond,rho:+r.rho.toFixed(4),ncomp:conn.numComponents,nel:r.nel,nA:r.nA,nDof:r.nDof,
    Ceff_diag:[0,7,14,21,28,35].map(function(q){return +r.pre.C6[q].toFixed(0)}),pcgIters:r.pre.iters,tPre:+r.tPre.toFixed(2),tSetup:+r.tSetup.toFixed(2),axes:[]};
  r.perAxis.forEach(function(b){ rec.axes.push({axis:b.axis,Ea:+b.Ea.toFixed(0),lambda:+b.lambda.toExponential(5),pcr_MPa:+b.pcr.toFixed(1),lams:b.lams.map(function(v){return +v.toExponential(4)}),mWave:+b.mWave.toFixed(2),eigIters:b.iters,conv:b.conv,res:+b.resLead.toExponential(2),nAB:b.nAB,tEig:+b.tEig.toFixed(2)}); });
  rec.tTotal=+r.tTotal.toFixed(2);
  console.log(JSON.stringify(rec));
  if (process.env.SAVEMODE) { var b0=r.best; require('fs').writeFileSync(process.env.SAVEMODE+'_'+tp+'_N'+N+'.json', JSON.stringify({N:N,type:tp,design:D,solid:Array.from(r.solid),mode:Array.from(r.ops.toVoxelField(b0.mode)),axis:b0.axis,pcr:b0.pcr})); }
  global.LAST=r; console.log(JSON.stringify({peakRSS_MB:+(process.resourceUsage().maxRSS/1024).toFixed(0)}));
});});
}
