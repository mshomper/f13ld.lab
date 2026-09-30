/* Spectral (existing Willot/void) cross-check using the speed-study fast kit (operators match 16c to 1e-15).
   Void ratio applied CONSISTENTLY to prestress and eigen operators.  CASES="design:N:void,..." ; design 'plate4' = t=4 laminate. */
var cases=(process.env.CASES||'plate4:32:1e-2').split(',');
cases.forEach(function(cs){
  var p=cs.split(':'), nm=p[0], N=+p[1], ev=+p[2], N3=N*N*N, d;
  if (nm.indexOf('plate')===0){ var t=+nm.slice(5), s=new Float32Array(N3), i0=(N>>1)-(t>>1); for(var i=i0;i<i0+t;i++) for(var j=0;j<N*N;j++) s[i*N*N+j]=1; d={solid:s,C_s:isoC(110000,0.34),rho:t/N}; }
  else d=mkDesign(nm,N);
  var Cv=isoC(110000*ev,0.34), kit=makeKit(N,'f64',d.C_s,Cv,d.solid), t0=performance.now();
  var pre=prestressFast(kit,d.solid,d.C_s,Cv,N,{cgTol:1e-4,cgMaxiter:600}); var ax=2;
  kit.setSig0(pre.byAxis[ax].sigma0);
  var pr=lobpcgFast(kit,4,{iters:+(process.env.IT||300),tol:1e-4,nConv:1,nStable:2,resTol:0.05,seed:12345});
  var q=pr[0], eps=[0,1,2,3,4,5].map(function(){return new Float64Array(N3)}); kit.strainOf(q.vec,eps);
  var sig=[0,1,2,3,4,5].map(function(){return new Float64Array(N3)}); bk_localStress(eps,d.solid,d.C_s,Cv,N3,sig);
  var Es=0,Ev=0; for(var i2=0;i2<N3;i2++){var e=0; for(var P=0;P<6;P++) e+=eps[P][i2]*sig[P][i2]; if(d.solid[i2])Es+=e; else Ev+=e;}
  var lam=1/q.theta, Ea=pre.byAxis[ax].Eaxis;
  console.log(JSON.stringify({code:'spectral Willot (16c ops)',design:nm,N:N,voidRatio:ev,rho:+d.rho.toFixed(4),Ea:+Ea.toFixed(0),lambda:+lam.toExponential(4),pcr_MPa:+(lam*Ea).toFixed(1),
    plateStress_MPa: nm.indexOf('plate')===0 ? +(lam*Ea/d.rho).toFixed(1) : undefined, solidEnergyFrac:+(Es/(Es+Ev)).toFixed(4),mWave:+bk_modeLocalization(q.vec,d.solid,N).toFixed(2),iters:pr._iters,conv:pr._converged,t_s:+((performance.now()-t0)/1000).toFixed(1)}));
});
