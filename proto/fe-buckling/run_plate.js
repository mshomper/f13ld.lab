/* Plate-laminate benchmark: solid where x-index in [i0, i0+t); compress along z (axis 2). */
var ref=JSON.parse(require('fs').readFileSync(FEDIR+'/logs/plate_ref.json','utf8'));
var Ns=(process.env.NS||'32').split(',').map(Number), Ts=(process.env.TS||'2,3,4,6,8').split(',').map(Number), types=(process.env.TYPES||'H8,H8I').split(',');
var E=110000, nu=0.34;
Ns.forEach(function(N){ Ts.forEach(function(t){ types.forEach(function(tp){
  var N3=N*N*N, s=new Float32Array(N3), i0=(N>>1)-(t>>1);
  for(var i=i0;i<i0+t;i++) for(var j=0;j<N;j++) for(var k=0;k<N;k++) s[i*N*N+j*N+k]=1;
  var r=fe_buckle(s,N,{type:tp,E:E,nu:nu,axes:[2],block:+(process.env.M||4),stressAvg:process.env.AVG==='1',eigTol:1e-7,resTol:1e-3,eigIters:600,precond:process.env.PREC||'jacobi'});
  var b=r.perAxis[0], rho=t/N;
  var sigPlate=b.pcr/rho;                 /* macro stress / area fraction = plate stress */
  var kir=4*Math.PI*Math.PI*E*t*t/(12*(1-nu*nu)*N*N), ex=ref[t+'/'+N]?ref[t+'/'+N].exact3D*E:NaN;
  console.log(JSON.stringify({bench:'plate',N:N,t:t,type:tp,avgStress:process.env.AVG==='1',rho:rho,Ea_over_rhoE:+(b.Ea/(rho*E)).toFixed(6),
    sigma_cr_MPa:+sigPlate.toFixed(2),kirchhoff_MPa:+kir.toFixed(2),exact3D_MPa:+ex.toFixed(2),FE_over_kirchhoff:+(sigPlate/kir).toFixed(4),FE_over_exact3D:+(sigPlate/ex).toFixed(4),
    lams:b.lams.map(function(v){return +v.toExponential(5)}),mWave:+b.mWave.toFixed(2),eigIters:b.iters,conv:b.conv,pcgIters:r.pre.iters,live:r.pre.live,tPre:+r.tPre.toFixed(2),tEig:+b.tEig.toFixed(2)}));
});});});
