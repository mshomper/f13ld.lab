/* Dense null-space count of K on a UNIFORM solid at N=8: 16c spectral Willot vs H8R (1-pt hex) vs H8 (full). Dumps matrices for numpy. */
var N=8, N3=N*N*N, n=3*N3, fs=require('fs'), C=isoC(110000,0.34), solid=new Float32Array(N3).fill(1);
var ws=getBucklingWorkspaceCPU(N); ws.scheme='willot';
var uf=[0,1,2].map(function(){return new Float64Array(N3)}), of=[0,1,2].map(function(){return new Float64Array(N3)});
function dump(name, apply){ var M=new Float64Array(n*n), e=new Float64Array(n), y=new Float64Array(n);
  for(var j=0;j<n;j++){ e.fill(0); e[j]=1; apply(e,y); for(var i=0;i<n;i++) M[i*n+j]=y[i]; }
  fs.writeFileSync(FEDIR+'/logs/K_'+name+'_N8.bin', Buffer.from(M.buffer)); }
dump('spectral16c', function(x,out){ bk_flatToField(x,N3,uf); applyKcpu(uf,of,solid,C,C,N,ws); bk_fieldToFlat(of,N3,out); });
['H8R','H8'].forEach(function(tp){ var ed=fe_elementData(110000,0.34,tp), mesh=fe_mesh(solid,N), ops=fe_makeOps(mesh,ed);
  /* FE layout is component-major over nodes (all active) = same as 16c flat layout */
  dump(tp, function(x,out){ ops.applyK(x,out); }); });
