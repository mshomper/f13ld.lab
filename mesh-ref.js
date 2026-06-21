/* mesh reference math — extracted verbatim from index_-_mesh.html for cross-validation */
function buildBeamSDF(json, pruneCtx){
  const beams=json.beams||[];
  const geom=json.geometry||{};

  // ── Schema detection: scale_xyz OR cell_scale_x/y/z + cell ⇒ new schema.
  // v0.5.0-rc25: sweep v0.15.0 emits cell_scale_x/y/z (per-axis mm cell sizes
  // for beam family — distinct from TPMS convention where cell_scale_x is a
  // unitless frequency multiplier). Same field name, different semantics
  // across families; the disambiguator is the presence of geom.cell (mm),
  // which beam recipes have and TPMS recipes never do. We do not enter this
  // code path for TPMS anyway (buildTPMSSDF handles those), so the
  // field-name collision is safe to ignore here.
  let sxyz=null;
  if(Array.isArray(geom.scale_xyz)&&geom.scale_xyz.length===3
     &&isFinite(geom.scale_xyz[0])&&isFinite(geom.scale_xyz[1])&&isFinite(geom.scale_xyz[2])
     &&geom.scale_xyz[0]>0&&geom.scale_xyz[1]>0&&geom.scale_xyz[2]>0){
    sxyz=geom.scale_xyz;
  } else if(typeof geom.cell_scale_x==='number'&&geom.cell_scale_x>0
         && typeof geom.cell_scale_y==='number'&&geom.cell_scale_y>0
         && typeof geom.cell_scale_z==='number'&&geom.cell_scale_z>0){
    sxyz=[geom.cell_scale_x, geom.cell_scale_y, geom.cell_scale_z];
  }
  const cellMm=geom.cell;
  const hasScaleXYZ = sxyz!==null;
  const hasCell=(typeof cellMm==='number')&&isFinite(cellMm)&&cellMm>0;
  const isNew=hasScaleXYZ&&hasCell;

  // Per-axis cellScale (mesh's convention: cells per world-span [-5,+5]).
  // New schema: derived from cell/scale_xyz. Old schema: scalar cell_scale.
  let cellScaleX, cellScaleY, cellScaleZ;
  if(isNew){
    cellScaleX = cellMm / sxyz[0];
    cellScaleY = cellMm / sxyz[1];
    cellScaleZ = cellMm / sxyz[2];
  } else {
    const cs=(typeof geom.cell_scale==='number'&&geom.cell_scale>0)?geom.cell_scale:1;
    cellScaleX = cellScaleY = cellScaleZ = cs;
  }

  // Per-axis cell-local radii.
  // New schema: radius_x/y/z (mm) converted via 2·radius/scale_xyz.
  // Falls through field-by-field (radius_y/z optional, fall back to radius_x).
  // Old schema: scalar radius (already cell-local).
  let rLocX, rLocY, rLocZ;
  if(isNew && typeof geom.radius_x==='number' && geom.radius_x>=0){
    const rx=geom.radius_x;
    const ry=(typeof geom.radius_y==='number'&&geom.radius_y>=0)?geom.radius_y:rx;
    const rz=(typeof geom.radius_z==='number'&&geom.radius_z>=0)?geom.radius_z:rx;
    rLocX = 2*rx / sxyz[0];
    rLocY = 2*ry / sxyz[1];
    rLocZ = 2*rz / sxyz[2];
  } else {
    const r=(typeof geom.radius==='number'&&geom.radius>=0)?geom.radius:0.1;
    rLocX = rLocY = rLocZ = r;
  }

  // Node smoothing / ball radii (cell-local, isotropic, normalized by cell).
  // Both default to 0 when missing or zero → behavior reduces to legacy hard-min
  // union with no node decorations. Only consulted when isNew (mm-units required).
  const sminLocal = (isNew && typeof geom.node_smoothing_k==='number' && geom.node_smoothing_k>0)
    ? (2*geom.node_smoothing_k / cellMm) : 0;
  const ballLocal = (isNew && typeof geom.node_ball_radius==='number' && geom.node_ball_radius>0)
    ? (2*geom.node_ball_radius / cellMm) : 0;
  const useSmin = sminLocal > 0;
  const useBalls = ballLocal > 0;

  // Per-axis world ↔ cell-local conversions.
  const W2Lx=cellScaleX/5, W2Ly=cellScaleY/5, W2Lz=cellScaleZ/5;
  const L2Wx=5/cellScaleX, L2Wy=5/cellScaleY, L2Wz=5/cellScaleZ;
  // Geometric-mean cell-local→world scale for the SDF return value.
  // Equals 5 exactly when geomean(cellScale)=1 (always true under new schema
  // by construction; equals 5/cellScale for legacy isotropic recipes).
  const L2Wgeo = Math.cbrt(L2Wx*L2Wy*L2Wz);

  // Pre-extract beam endpoints into typed arrays for tight inner loop.
  // beams[i][6] (sharing factor) is left unread — informational only.
  const N=beams.length;
  const ax=new Float64Array(N), ay=new Float64Array(N), az=new Float64Array(N);
  const bx=new Float64Array(N), by=new Float64Array(N), bz=new Float64Array(N);
  const rStrut=new Float64Array(N);  // per-strut effective radius (cell-local)
  let maxR=0;
  for(let i=0;i<N;i++){
    const b=beams[i];
    ax[i]=b[0]; ay[i]=b[1]; az[i]=b[2];
    bx[i]=b[3]; by[i]=b[4]; bz[i]=b[5];
    // Direction-weighted RMS radius. Unit direction (ux,uy,uz) in cell-local.
    const ex=b[3]-b[0], ey=b[4]-b[1], ez=b[5]-b[2];
    const elen=Math.sqrt(ex*ex+ey*ey+ez*ez);
    if(elen>1e-12){
      const ux=ex/elen, uy=ey/elen, uz=ez/elen;
      rStrut[i]=Math.sqrt(rLocX*rLocX*ux*ux + rLocY*rLocY*uy*uy + rLocZ*rLocZ*uz*uz);
    } else {
      // Zero-length strut — degenerate; fall back to RMS of axis radii.
      rStrut[i]=Math.sqrt((rLocX*rLocX + rLocY*rLocY + rLocZ*rLocZ)/3);
    }
    if(rStrut[i]>maxR) maxR=rStrut[i];
  }

  // Pre-compute unique node positions (deduplicated endpoints) for node-ball
  // union. Rounded to a small tolerance to handle FP artifacts. Only built
  // when useBalls so the empty-case has zero memory cost.
  let nodeX=null, nodeY=null, nodeZ=null;
  let nodeCount=0;
  if(useBalls){
    const TOL=1e-5, INV_TOL=1/TOL;
    const seen=new Map();
    const tmpX=[], tmpY=[], tmpZ=[];
    for(let i=0;i<N;i++){
      // endpoint A
      const kxA=Math.round(ax[i]*INV_TOL), kyA=Math.round(ay[i]*INV_TOL), kzA=Math.round(az[i]*INV_TOL);
      const keyA=kxA+','+kyA+','+kzA;
      if(!seen.has(keyA)){ seen.set(keyA,true); tmpX.push(ax[i]); tmpY.push(ay[i]); tmpZ.push(az[i]); }
      // endpoint B
      const kxB=Math.round(bx[i]*INV_TOL), kyB=Math.round(by[i]*INV_TOL), kzB=Math.round(bz[i]*INV_TOL);
      const keyB=kxB+','+kyB+','+kzB;
      if(!seen.has(keyB)){ seen.set(keyB,true); tmpX.push(bx[i]); tmpY.push(by[i]); tmpZ.push(bz[i]); }
    }
    nodeX=new Float64Array(tmpX);
    nodeY=new Float64Array(tmpY);
    nodeZ=new Float64Array(tmpZ);
    nodeCount=tmpX.length;
  }

  // Halo for boundary-tile evaluation. Use the LARGEST per-strut radius
  // so we never miss a contributing capsule near a face. Smin blend radius
  // and node ball radius both extend the influence zone — add both.
  const halo = maxR + sminLocal + ballLocal + 0.02;

  // Polynomial smooth-min (Inigo Quilez). Matches F13LD.bundle's smin_k.
  // k=0 ⇒ degenerates to hard min (no allocation, no blend).
  function smin(a, b, k){
    if(k <= 0) return a < b ? a : b;
    const diff = a > b ? a-b : b-a;
    const h = (k - diff) > 0 ? (k - diff)/k : 0;
    return (a < b ? a : b) - h*h*h*k*(1/6);
  }

  // Capsule SDF — distance from q to each strut(a,b) minus per-strut radius.
  // q,a,b are all in cell-local [-1,+1] units. Optional smin between unions
  // and optional node sphere union (both gated by closure-bound flags).
  function capsuleUnion(qx,qy,qz){
    let d=1e6;
    for(let i=0;i<N;i++){
      const dx=qx-ax[i], dy=qy-ay[i], dz=qz-az[i];
      const ex=bx[i]-ax[i], ey=by[i]-ay[i], ez=bz[i]-az[i];
      const ll=ex*ex+ey*ey+ez*ez;
      let h=ll>1e-12?(dx*ex+dy*ey+dz*ez)/ll:0;
      if(h<0)h=0; else if(h>1)h=1;
      const px=dx-ex*h, py=dy-ey*h, pz=dz-ez*h;
      const di=Math.sqrt(px*px+py*py+pz*pz)-rStrut[i];
      d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
    }
    if(useBalls){
      for(let n=0;n<nodeCount;n++){
        const dx=qx-nodeX[n], dy=qy-nodeY[n], dz=qz-nodeZ[n];
        const di=Math.sqrt(dx*dx+dy*dy+dz*dz)-ballLocal;
        d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
      }
    }
    return d;
  }

  // Mask-gated capsule union: same union math as capsuleUnion but skips
  // struts whose mask byte is 0 for the given tile. Returns 1e6 when tile
  // is out of mask range (treated as "no struts here"). Node balls are not
  // masked — they belong to the lattice as designed, not per-trimmed-strut.
  function capsuleUnionMasked(qx,qy,qz,tileBase,mask){
    if(tileBase<0) return 1e6;
    let d=1e6;
    for(let i=0;i<N;i++){
      if(!mask[tileBase+i]) continue;
      const dx=qx-ax[i], dy=qy-ay[i], dz=qz-az[i];
      const ex=bx[i]-ax[i], ey=by[i]-ay[i], ez=bz[i]-az[i];
      const ll=ex*ex+ey*ey+ez*ez;
      let h=ll>1e-12?(dx*ex+dy*ey+dz*ez)/ll:0;
      if(h<0)h=0; else if(h>1)h=1;
      const px=dx-ex*h, py=dy-ey*h, pz=dz-ez*h;
      const di=Math.sqrt(px*px+py*py+pz*pz)-rStrut[i];
      d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
    }
    if(useBalls){
      for(let n=0;n<nodeCount;n++){
        const dx=qx-nodeX[n], dy=qy-nodeY[n], dz=qz-nodeZ[n];
        const di=Math.sqrt(dx*dx+dy*dy+dz*dz)-ballLocal;
        d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
      }
    }
    return d;
  }

  // ── Un-pruned path (preview, cube-mode export, or shape-mode without trim)
  if(!pruneCtx){
    return p=>{
      // Map world point to cell-local q in [-1,+1] (per-axis under new schema)
      const lx=p[0]*W2Lx, ly=p[1]*W2Ly, lz=p[2]*W2Lz;
      // Wrap to single cell.
      const qx=((lx+1)-2*Math.floor((lx+1)/2))-1;
      const qy=((ly+1)-2*Math.floor((ly+1)/2))-1;
      const qz=((lz+1)-2*Math.floor((lz+1)/2))-1;

      let d=capsuleUnion(qx,qy,qz);

      const nx_=qx>1-halo, px_=qx<-1+halo;
      const ny_=qy>1-halo, py_=qy<-1+halo;
      const nz_=qz>1-halo, pz_=qz<-1+halo;

      if(nx_||px_||ny_||py_||nz_||pz_){
        if(nx_) d=Math.min(d,capsuleUnion(qx-2,qy,qz));
        if(px_) d=Math.min(d,capsuleUnion(qx+2,qy,qz));
        if(ny_) d=Math.min(d,capsuleUnion(qx,qy-2,qz));
        if(py_) d=Math.min(d,capsuleUnion(qx,qy+2,qz));
        if(nz_) d=Math.min(d,capsuleUnion(qx,qy,qz-2));
        if(pz_) d=Math.min(d,capsuleUnion(qx,qy,qz+2));
        if(nx_&&ny_) d=Math.min(d,capsuleUnion(qx-2,qy-2,qz));
        if(nx_&&py_) d=Math.min(d,capsuleUnion(qx-2,qy+2,qz));
        if(px_&&ny_) d=Math.min(d,capsuleUnion(qx+2,qy-2,qz));
        if(px_&&py_) d=Math.min(d,capsuleUnion(qx+2,qy+2,qz));
        if(nx_&&nz_) d=Math.min(d,capsuleUnion(qx-2,qy,qz-2));
        if(nx_&&pz_) d=Math.min(d,capsuleUnion(qx-2,qy,qz+2));
        if(px_&&nz_) d=Math.min(d,capsuleUnion(qx+2,qy,qz-2));
        if(px_&&pz_) d=Math.min(d,capsuleUnion(qx+2,qy,qz+2));
        if(ny_&&nz_) d=Math.min(d,capsuleUnion(qx,qy-2,qz-2));
        if(ny_&&pz_) d=Math.min(d,capsuleUnion(qx,qy-2,qz+2));
        if(py_&&nz_) d=Math.min(d,capsuleUnion(qx,qy+2,qz-2));
        if(py_&&pz_) d=Math.min(d,capsuleUnion(qx,qy+2,qz+2));
        if(nx_&&ny_&&nz_) d=Math.min(d,capsuleUnion(qx-2,qy-2,qz-2));
        if(nx_&&ny_&&pz_) d=Math.min(d,capsuleUnion(qx-2,qy-2,qz+2));
        if(nx_&&py_&&nz_) d=Math.min(d,capsuleUnion(qx-2,qy+2,qz-2));
        if(nx_&&py_&&pz_) d=Math.min(d,capsuleUnion(qx-2,qy+2,qz+2));
        if(px_&&ny_&&nz_) d=Math.min(d,capsuleUnion(qx+2,qy-2,qz-2));
        if(px_&&ny_&&pz_) d=Math.min(d,capsuleUnion(qx+2,qy-2,qz+2));
        if(px_&&py_&&nz_) d=Math.min(d,capsuleUnion(qx+2,qy+2,qz-2));
        if(px_&&py_&&pz_) d=Math.min(d,capsuleUnion(qx+2,qy+2,qz+2));
      }

      return d*L2Wgeo;
    };
  }

  // ── Pruned path (shape-mode export with trim-to-nodes) ─────────────────
  // Same neighbor-halo logic, but each capsuleUnion call consults the
  // appropriate tile's mask. Tile index for the current p_world matches
  // the wrap math: tile_x = floor((lx+1)/2) where lx = p_world*W2Lx (per axis).
  const {mask, tXMin, tYMin, tZMin, NX, NY, NZ}=pruneCtx;
  const NXY=NX*NY;
  // Compute mask base offset (in bytes) for tile (tx,ty,tz). Returns -1 if
  // out of precomputed range.
  function tileBaseOf(tx,ty,tz){
    const ix=tx-tXMin, iy=ty-tYMin, iz=tz-tZMin;
    if(ix<0||ix>=NX||iy<0||iy>=NY||iz<0||iz>=NZ) return -1;
    return ((iz*NY+iy)*NX+ix)*N;
  }
  return p=>{
    const lx=p[0]*W2Lx, ly=p[1]*W2Ly, lz=p[2]*W2Lz;
    const qx=((lx+1)-2*Math.floor((lx+1)/2))-1;
    const qy=((ly+1)-2*Math.floor((ly+1)/2))-1;
    const qz=((lz+1)-2*Math.floor((lz+1)/2))-1;
    // Tile index from world coords (matches the wrap math above)
    const tx=Math.floor((lx+1)/2);
    const ty=Math.floor((ly+1)/2);
    const tz=Math.floor((lz+1)/2);

    let d=capsuleUnionMasked(qx,qy,qz,tileBaseOf(tx,ty,tz),mask);

    const nx_=qx>1-halo, px_=qx<-1+halo;
    const ny_=qy>1-halo, py_=qy<-1+halo;
    const nz_=qz>1-halo, pz_=qz<-1+halo;

    if(nx_||px_||ny_||py_||nz_||pz_){
      // For each neighbor offset, look up that neighbor tile's mask.
      // qx-2 corresponds to neighbor at tx-1 (we crossed the boundary into
      // the previous tile's frame); qx+2 → tx+1.
      if(nx_) d=Math.min(d,capsuleUnionMasked(qx-2,qy,qz,tileBaseOf(tx-1,ty,tz),mask));
      if(px_) d=Math.min(d,capsuleUnionMasked(qx+2,qy,qz,tileBaseOf(tx+1,ty,tz),mask));
      if(ny_) d=Math.min(d,capsuleUnionMasked(qx,qy-2,qz,tileBaseOf(tx,ty-1,tz),mask));
      if(py_) d=Math.min(d,capsuleUnionMasked(qx,qy+2,qz,tileBaseOf(tx,ty+1,tz),mask));
      if(nz_) d=Math.min(d,capsuleUnionMasked(qx,qy,qz-2,tileBaseOf(tx,ty,tz-1),mask));
      if(pz_) d=Math.min(d,capsuleUnionMasked(qx,qy,qz+2,tileBaseOf(tx,ty,tz+1),mask));
      if(nx_&&ny_) d=Math.min(d,capsuleUnionMasked(qx-2,qy-2,qz,tileBaseOf(tx-1,ty-1,tz),mask));
      if(nx_&&py_) d=Math.min(d,capsuleUnionMasked(qx-2,qy+2,qz,tileBaseOf(tx-1,ty+1,tz),mask));
      if(px_&&ny_) d=Math.min(d,capsuleUnionMasked(qx+2,qy-2,qz,tileBaseOf(tx+1,ty-1,tz),mask));
      if(px_&&py_) d=Math.min(d,capsuleUnionMasked(qx+2,qy+2,qz,tileBaseOf(tx+1,ty+1,tz),mask));
      if(nx_&&nz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy,qz-2,tileBaseOf(tx-1,ty,tz-1),mask));
      if(nx_&&pz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy,qz+2,tileBaseOf(tx-1,ty,tz+1),mask));
      if(px_&&nz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy,qz-2,tileBaseOf(tx+1,ty,tz-1),mask));
      if(px_&&pz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy,qz+2,tileBaseOf(tx+1,ty,tz+1),mask));
      if(ny_&&nz_) d=Math.min(d,capsuleUnionMasked(qx,qy-2,qz-2,tileBaseOf(tx,ty-1,tz-1),mask));
      if(ny_&&pz_) d=Math.min(d,capsuleUnionMasked(qx,qy-2,qz+2,tileBaseOf(tx,ty-1,tz+1),mask));
      if(py_&&nz_) d=Math.min(d,capsuleUnionMasked(qx,qy+2,qz-2,tileBaseOf(tx,ty+1,tz-1),mask));
      if(py_&&pz_) d=Math.min(d,capsuleUnionMasked(qx,qy+2,qz+2,tileBaseOf(tx,ty+1,tz+1),mask));
      if(nx_&&ny_&&nz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy-2,qz-2,tileBaseOf(tx-1,ty-1,tz-1),mask));
      if(nx_&&ny_&&pz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy-2,qz+2,tileBaseOf(tx-1,ty-1,tz+1),mask));
      if(nx_&&py_&&nz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy+2,qz-2,tileBaseOf(tx-1,ty+1,tz-1),mask));
      if(nx_&&py_&&pz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy+2,qz+2,tileBaseOf(tx-1,ty+1,tz+1),mask));
      if(px_&&ny_&&nz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy-2,qz-2,tileBaseOf(tx+1,ty-1,tz-1),mask));
      if(px_&&ny_&&pz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy-2,qz+2,tileBaseOf(tx+1,ty-1,tz+1),mask));
      if(px_&&py_&&nz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy+2,qz-2,tileBaseOf(tx+1,ty+1,tz-1),mask));
      if(px_&&py_&&pz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy+2,qz+2,tileBaseOf(tx+1,ty+1,tz+1),mask));
    }

    return d*L2Wgeo;
  };
}
// ── HU domain-spanning helpers (shape mode) ──────────────────────────────────
function buildHUKernelsMM(params,bbox,cellSizeMm){
  // Build the design-cell kernels in [-π,π]³ — same seed, same N, same RNG
  // sequence as cube-mode preview. This guarantees the field pattern tiles.
  var designK=buildHUKernels(params);
  var TP=2*Math.PI,scale=cellSizeMm/TP;
  var aspect=params.huAspect||4,bw=params.huWidth||.04;
  // Scale kernel Gaussian widths from design-cell→mm
  var a_mm=designK.length>0?designK[0].a*scale:(bw*aspect*.5*cellSizeMm);
  var b1_mm=designK.length>0?designK[0].b1*scale:(bw*.5/Math.sqrt(params.huEll||1)*cellSizeMm);
  var b2_mm=designK.length>0?designK[0].b2*scale:(bw*.5*Math.sqrt(params.huEll||1)*cellSizeMm);
  var p_=designK.cross||2,m_=designK.sharp||1,Rc_=Math.pow(12.25,1/m_),reach=Math.max(a_mm*Math.sqrt(Rc_),b1_mm*Math.pow(Rc_,1/p_),b2_mm*Math.pow(Rc_,1/p_));
  // Tile grid: how many cells span the bbox, +1 cell padding per side
  // for Gaussian bleed across cell boundaries
  var ddx=bbox.mxx-bbox.mnx,ddy=bbox.mxy-bbox.mny,ddz=bbox.mxz-bbox.mnz;
  var nTx=Math.ceil(ddx/cellSizeMm),nTy=Math.ceil(ddy/cellSizeMm),nTz=Math.ceil(ddz/cellSizeMm);
  // Padding: 2 cell minimum for Gaussian bleed across periodic cell boundaries
  // (preview) and export margin; more if kernel reach exceeds cell size
  var pad=Math.max(2,Math.ceil(reach/cellSizeMm));
  var kernels=[];
  for(var tz=-pad;tz<nTz+pad;tz++){
    for(var ty=-pad;ty<nTy+pad;ty++){
      for(var tx=-pad;tx<nTx+pad;tx++){
        for(var ki=0;ki<designK.length;ki++){
          var dk=designK[ki];
          // Map kernel position from [-π,π] → [0,cellSizeMm] then offset by tile
          kernels.push({
            px:bbox.mnx+(dk.px+Math.PI)/TP*cellSizeMm+tx*cellSizeMm,
            py:bbox.mny+(dk.py+Math.PI)/TP*cellSizeMm+ty*cellSizeMm,
            pz:bbox.mnz+(dk.pz+Math.PI)/TP*cellSizeMm+tz*cellSizeMm,
            tx:dk.tx,ty:dk.ty,tz:dk.tz,
            n1x:dk.n1x,n1y:dk.n1y,n1z:dk.n1z,
            n2x:dk.n2x,n2y:dk.n2y,n2z:dk.n2z,
            a:a_mm,b1:b1_mm,b2:b2_mm});
        }
      }
    }
  }
  // ── Spatial hash for O(1) kernel queries ────────────────────────────────
  var cutoff=reach;
  var cs=Math.max(cutoff,1e-6);
  var hmnx=bbox.mnx-pad*cellSizeMm,hmny=bbox.mny-pad*cellSizeMm,hmnz=bbox.mnz-pad*cellSizeMm;
  var hmxx=bbox.mnx+(nTx+pad)*cellSizeMm,hmxy=bbox.mny+(nTy+pad)*cellSizeMm,hmxz=bbox.mnz+(nTz+pad)*cellSizeMm;
  var hddx=hmxx-hmnx,hddy=hmxy-hmny,hddz=hmxz-hmnz;
  var nx=Math.max(1,Math.ceil(hddx/cs)),ny=Math.max(1,Math.ceil(hddy/cs)),nz=Math.max(1,Math.ceil(hddz/cs));
  var buckets=new Array(nx*ny*nz);
  for(var bi=0;bi<buckets.length;bi++)buckets[bi]=null;
  for(var ki2=0;ki2<kernels.length;ki2++){
    var kk=kernels[ki2];
    var hx=Math.max(0,Math.min(nx-1,Math.floor((kk.px-hmnx)/cs)));
    var hy=Math.max(0,Math.min(ny-1,Math.floor((kk.py-hmny)/cs)));
    var hz=Math.max(0,Math.min(nz-1,Math.floor((kk.pz-hmnz)/cs)));
    var bIdx=hx+hy*nx+hz*nx*ny;
    if(buckets[bIdx]===null)buckets[bIdx]=[];
    buckets[bIdx].push(ki2);
  }
  kernels.cross=designK.cross;kernels.sharp=designK.sharp;kernels.blend=designK.blend;kernels.hash={buckets:buckets,nx:nx,ny:ny,nz:nz,mnx:hmnx,mny:hmny,mnz:hmnz,cs:cs};
  return kernels;
}

var BSDF={
  PI:Math.PI,TWO_PI:Math.PI*2,
  smax:function(a,b,k){if(k<0.0001)return Math.max(a,b);var h=Math.max(k-Math.abs(a-b),0)/k;return Math.max(a,b)+h*h*k*0.25;},
  smin:function(a,b,k){if(k<0.0001)return Math.min(a,b);var h=Math.max(k-Math.abs(a-b),0)/k;return Math.min(a,b)-h*h*k*0.25;},
  ckSign:function(bi,bj){return(((bi+bj)%2)+2)%2===0?1:-1;},
  beamSDF:function(dx,dy,r,n){
    if(n>=14)return r-Math.max(Math.abs(dx),Math.abs(dy));
    if(n<=2.1)return r-Math.sqrt(dx*dx+dy*dy);
    return r-Math.pow(Math.pow(Math.abs(dx),n)+Math.pow(Math.abs(dy),n),1/n);
  },
  bundleRaw:function(lx,ly,p){
    var W=p.nx*p.d,hp=W*0.5,result=-1e6;
    for(var j=0;j<p.ny;j++)for(var i=0;i<p.nx;i++){
      var x0=(i-(p.nx-1)*0.5)*p.d,y0=(j-(p.ny-1)*0.5)*p.d;
      if(Math.abs(x0)+p.r<=hp&&Math.abs(y0)+p.r<=hp)
        result=BSDF.smax(result,BSDF.beamSDF(lx-x0,ly-y0,p.r,p.n),p.blend);
    }
    return result;
  },
  applyWarp:function(xm,ym,z,p){
    if(p.warpMode===0)return[xm,ym];
    var A=p.warpAmp,w=p.warpFreq;
    if(p.warpMode===1){var cx=A*Math.sin(w*z),dC=A*w*Math.cos(w*z),L=Math.sqrt(1+dC*dC);return[(xm-cx)/L,ym];}
    var cx=A*Math.sin(w*z),cy=A*Math.cos(w*z),L=Math.sqrt(1+A*A*w*w);
    return[-(xm-cx)*Math.sin(w*z)-(ym-cy)*Math.cos(w*z),((xm-cx)*Math.cos(w*z)-(ym-cy)*Math.sin(w*z))/L];
  },
  bundleCell:function(xm,ym,pz,cs,p){
    var ts=p.twistMode===0?1:cs;
    var th=ts*p.twist*pz,cosT=Math.cos(th),sinT=Math.sin(th);
    var lx,ly,w;
    if(p.warpFrame===0){w=BSDF.applyWarp(xm,ym,pz,p);lx=w[0]*cosT-w[1]*sinT;ly=w[0]*sinT+w[1]*cosT;}
    else{var tx=xm*cosT-ym*sinT,ty=xm*sinT+ym*cosT;w=BSDF.applyWarp(tx,ty,pz,p);lx=w[0];ly=w[1];}
    return -BSDF.bundleRaw(lx,ly,p);
  },
  bundle:function(px,py,pz_in,p){
    var period=Math.max(p.nx*p.d+p.gap,0.01);
    var hp=period*0.5,SH=Math.PI;
    var xBase=((px+SH)%period+period)%period-hp;
    var yBase=((py+SH)%period+period)%period-hp;
    var biBase=Math.floor((px+SH)/period);
    var bjBase=Math.floor((py+SH)/period);
    var result=1e6;
    for(var di=-1;di<=1;di++)for(var dj=-1;dj<=1;dj++){
      var xm=xBase-di*period,ym=yBase-dj*period;
      var bi=biBase+di,bj=bjBase+dj;
      var cs=BSDF.ckSign(bi,bj);
      var pz=pz_in+bi*p.zRampX+bj*p.zRampY+cs*p.zChkStep;
      result=BSDF.smin(result,BSDF.bundleCell(xm,ym,pz,cs,p),p.blend);
    }
    return result;
  },
  helicoidCell:function(xm,ym,pz,cs,p){
    var omega=p.hPitch;
    if(p.hColHand&&cs<0)omega=-omega;
    // Alternating: reverse twist every other period via a smooth (C0/C1) oscillation
    // of the accumulated twist angle, Lambda = 4*pi/|omega| (= two base periods).
    var twAng,twRate;
    if(p.hZHand){var hk=Math.abs(omega)*0.5;twRate=omega*Math.cos(hk*pz);twAng=(hk>1e-6?omega/hk:omega*pz)*Math.sin(hk*pz);}
    else{twAng=omega*pz;twRate=omega;}
    var rxy=Math.sqrt(xm*xm+ym*ym);
    var rMask=Math.min(rxy-p.hInner,p.hOuter-rxy);
    var phi=p.hStarts*Math.atan2(ym,xm)-twAng;
    phi-=BSDF.TWO_PI*Math.round(phi/BSDF.TWO_PI);
    var rSafe=Math.max(rxy,1e-4);
    var gradMag=Math.sqrt(p.hStarts*p.hStarts/(rSafe*rSafe)+twRate*twRate);
    var dSheet=Math.abs(phi)/gradMag-p.hThick;
    return Math.max(dSheet,-rMask);
  },
  helicoid:function(px,py,pz_in,p){
    var period=Math.max(2*p.hOuter+p.hGap,0.01);
    var hp=period*0.5,SH=Math.PI;
    var xBase=((px+SH)%period+period)%period-hp;
    var yBase=((py+SH)%period+period)%period-hp;
    var biBase=Math.floor((px+SH)/period);
    var bjBase=Math.floor((py+SH)/period);
    var result=1e6;
    for(var di=-1;di<=1;di++)for(var dj=-1;dj<=1;dj++){
      var xm=xBase-di*period,ym=yBase-dj*period;
      var bi=biBase+di,bj=bjBase+dj;
      var cs=BSDF.ckSign(bi,bj);
      var pz=pz_in+bi*p.zRampX+bj*p.zRampY+cs*p.zChkStep;
      result=BSDF.smin(result,BSDF.helicoidCell(xm,ym,pz,cs,p),p.hBlend);
    }
    return result;
  },
  braidCell:function(xm,ym,pz,cs,p){
    var omega=p.bPitch;
    if(p.bColHand&&cs<0)omega=-omega;
    var dA2=p.bRadius*p.bRadius*omega*omega+1;
    var result=-1e6;
    for(var k=0;k<p.bN;k++){
      var phase=BSDF.TWO_PI*k/p.bN,tt=pz;
      for(var iter=0;iter<5;iter++){
        var phi=omega*tt+phase;
        var Ckx=p.bRadius*Math.cos(phi),Cky=p.bRadius*Math.sin(phi);
        var dCkx=-p.bRadius*omega*Math.sin(phi),dCky=p.bRadius*omega*Math.cos(phi);
        var ddCkx=-p.bRadius*omega*omega*Math.cos(phi),ddCky=-p.bRadius*omega*omega*Math.sin(phi);
        var dx=xm-Ckx,dy=ym-Cky,dz=pz-tt;
        var f=-(dx*dCkx+dy*dCky+dz);
        var fp=dA2-(dx*ddCkx+dy*ddCky);
        tt-=f/(Math.abs(fp)>1e-6?fp:1e-6);
      }
      var phi2=omega*tt+phase;
      var dist=Math.sqrt((xm-p.bRadius*Math.cos(phi2))*(xm-p.bRadius*Math.cos(phi2))+(ym-p.bRadius*Math.sin(phi2))*(ym-p.bRadius*Math.sin(phi2))+(pz-tt)*(pz-tt));
      result=BSDF.smax(result,p.bFiber-dist,p.bBlend);
    }
    return -result;
  },
  braid:function(px,py,pz_in,p){
    var period=Math.max(2*(p.bRadius+p.bFiber)+p.bGap,0.01);
    var hp=period*0.5,SH=Math.PI;
    var xBase=((px+SH)%period+period)%period-hp;
    var yBase=((py+SH)%period+period)%period-hp;
    var biBase=Math.floor((px+SH)/period);
    var bjBase=Math.floor((py+SH)/period);
    var result=1e6;
    for(var di=-1;di<=1;di++)for(var dj=-1;dj<=1;dj++){
      var xm=xBase-di*period,ym=yBase-dj*period;
      var bi=biBase+di,bj=bjBase+dj;
      var cs=BSDF.ckSign(bi,bj);
      var pz=pz_in+bi*p.zRampX+bj*p.zRampY+cs*p.zChkStep;
      result=BSDF.smin(result,BSDF.braidCell(xm,ym,pz,cs,p),p.bBlend);
    }
    return result;
  },
  weave:function(px,py,pz,p){
    var period=Math.max(p.wvP,0.01),hp=period*0.5;
    var zPeriod=Math.max(2*(p.wvA+p.wvR)+p.wvZGap,0.01),zHalfP=zPeriod*0.5;
    var zmBase=((pz+zHalfP)%zPeriod+zPeriod)%zPeriod-zHalfP;
    var xBase=((px+hp)%period+period)%period-hp;
    var biBase=Math.floor((px+hp)/period);
    var yBase=((py+hp)%period+period)%period-hp;
    var bjBase=Math.floor((py+hp)/period);
    var result=1e6;
    for(var dzi=-1;dzi<=1;dzi++){
      var zm=zmBase-dzi*zPeriod;
      var warpD=1e6;
      for(var di=-1;di<=1;di++){
        var xm=xBase-di*period;
        var bi=biBase+di;
        var cs=(((bi%2)+2)%2===0)?1:-1;
        var zc=cs*p.wvA*Math.cos(Math.PI*py/period);
        warpD=Math.min(warpD,Math.sqrt(xm*xm+(zm-zc)*(zm-zc))-p.wvR);
      }
      var weftD=1e6;
      for(var dj=-1;dj<=1;dj++){
        var ym=yBase-dj*period;
        var bj=bjBase+dj;
        var cs2=(((bj%2)+2)%2===0)?1:-1;
        var zc2=-cs2*p.wvA*Math.cos(Math.PI*px/period);
        weftD=Math.min(weftD,Math.sqrt(ym*ym+(zm-zc2)*(zm-zc2))-p.wvR);
      }
      result=BSDF.smin(result,BSDF.smin(warpD,weftD,p.wvBlend),p.wvBlend);
    }
    return result;
  },
  raw:function(px,py,pz,p){
    if(p.structure===0)return BSDF.bundle(px,py,pz,p);
    if(p.structure===1)return BSDF.helicoid(px,py,pz,p);
    if(p.structure===2)return BSDF.braid(px,py,pz,p);
    return BSDF.weave(px,py,pz,p);
  },
  scene:function(px,py,pz,p){
    var raw=BSDF.raw(px,py,pz,p)-p.iso;
    if(p.topoMode===0)return p.flip?-raw:raw;
    return Math.abs(raw)-p.sheetW;
  }
};
function bundleParamsFromJSON(json){
  var surf=json.surface||{}, g=json.geometry||{};
  function num(v,d){return (typeof v==='number'&&isFinite(v))?v:d;}
  function int(v,d){return (typeof v==='number'&&isFinite(v))?Math.round(v):d;}
  var structNames=['bundle','helicoid','braid','weave'];
  var sName=surf.structure||(json.meta&&json.meta.preset)||'bundle';
  var structure=structNames.indexOf(sName); if(structure<0)structure=0;
  function shapeToN(sn){return sn==='square'?16:sn==='rounded'?4:2;}
  var topoMode=(surf.topology==='sheet')?1:0;
  var flip=(surf.topology==='void')?1:0;
  return {
    structure:structure,
    r:num(g.beam_radius,0.09), n:shapeToN(g.beam_shape||'circle'),
    nx:int(g.beams_per_side,2), ny:int(g.beams_per_side,2),
    d:num(g.beam_spacing,0.28), gap:num(g.column_gap,0.20),
    blend:num(g.blend_k,0.01), twist:num(g.twist_rate,1.20),
    twistMode:int(g.twist_mode,0),
    warpMode:int(g.warp_mode,0), warpAmp:num(g.warp_amp,0.15),
    warpFreq:num(g.warp_freq,1.50), warpFrame:int(g.warp_frame,0),
    hPitch:num(g.pitch,1.5), hThick:num(g.thickness,0.05),
    hInner:num(g.inner_radius,0.0), hOuter:num(g.outer_radius,0.4),
    hStarts:int(g.starts,1), hBlend:num(g.helicoid_blend,0.01),
    hGap:num(g.column_gap,0.20), hColHand:int(g.col_handed,0), hZHand:int(g.z_handed,0),
    bN:int(g.strand_count,3), bRadius:num(g.braid_radius,0.12),
    bPitch:num(g.pitch,1.20), bFiber:num(g.fiber_radius,0.06),
    bBlend:num(g.blend_k,0.01), bGap:num(g.column_gap,0.20),
    bColHand:int(g.braid_col_handed,0),
    wvP:num(g.weave_pitch,0.5), wvA:num(g.weave_amplitude,0.1),
    wvR:num(g.fiber_radius,0.06), wvZGap:num(g.weave_layer_gap,0.0),
    wvBlend:num(g.blend_k,0.01),
    iso:num(surf.iso_offset,0.0), sheetW:num(surf.sheet_width,0.025),
    topoMode:topoMode, flip:flip,
    zRampX:num(g.z_ramp_x,0.0), zRampY:num(g.z_ramp_y,0.0), zChkStep:num(g.z_checker_step,0.0)
  };
}
function bundleXYPeriod(p){
  if(p.structure===0)return Math.max(p.nx*p.d+p.gap,0.01);
  if(p.structure===1)return Math.max(2*p.hOuter+p.hGap,0.01);
  if(p.structure===2)return Math.max(2*(p.bRadius+p.bFiber)+p.bGap,0.01);
  return Math.max(p.wvP,0.01);
}
function buildBundleSDF(json){
  var p=bundleParamsFromJSON(json);
  var S=bundleXYPeriod(p)/10;
  var invS=1/S; // bundle-domain distance -> world units (one cell = 10 world units); analogous to beam's L2Wgeo
  return function(q){ return BSDF.scene(q[0]*S,q[1]*S,q[2]*S,p)*invS; };
}

// -- F13LD.wave: cymatic standing-wave SDF (negative-inside) --------------
// Sum of cosine modes under one of five symmetry operators, transcribed
// verbatim from F13LD.wave's f13ldWaveEvalRaw. The mesh world cube [-5,5]
// maps to exactly one wave cell via q = p * worldScale (pi/5): q spans
// [-pi,pi] (cos period 2pi = one cell), giving seamless cubic tiling.
// cellScale is a PHYSICAL size in wave (domain.size mm), intentionally NOT
// a frequency multiplier here -- the mesh cell-size input owns physical
// scale, exactly as on the analytic TPMS path.
function buildWaveSDF(json){
  const f=json.field||{};
  const modes=Array.isArray(f.modes)?f.modes:[];
  const SYM={pure:0,anti:1,antisym:1,chladni:1,cubic:2,chiral:3,schoen:4};
  let sym=(typeof f.symmetryId==='number')?f.symmetryId
         :(typeof f.symmetry==='string'?(SYM[f.symmetry.toLowerCase()]??0):0);
  const iso=(typeof f.iso==='number')?f.iso:0;
  const sheet=(f.mode==='sheet');
  const thickness=(typeof f.thickness==='number')?f.thickness:0.2;
  const signFlip=!!f.signFlip;
  const t=(typeof f.phaseTime==='number')?f.phaseTime:0;
  const WS=(json.coordinate&&typeof json.coordinate.worldScale==='number')?json.coordinate.worldScale:(Math.PI/5.0);
  function evalRaw(qx,qy,qz){
    let acc=0;
    for(let i=0;i<modes.length;i++){
      const mm=modes[i];
      const n=mm.n,m=mm.m,pp=mm.p,A=(mm.A!=null?mm.A:1);
      const cphi=Math.cos((mm.phi||0)+t);
      const cnX=Math.cos(n*qx),cmX=Math.cos(m*qx),cpX=Math.cos(pp*qx);
      const cnY=Math.cos(n*qy),cmY=Math.cos(m*qy),cpY=Math.cos(pp*qy);
      const cnZ=Math.cos(n*qz),cmZ=Math.cos(m*qz),cpZ=Math.cos(pp*qz);
      let v;
      if(sym===1){v=cnX*cmY*cpZ+cnY*cmZ*cpX+cnZ*cmX*cpY-cnY*cmX*cpZ-cnX*cmZ*cpY-cnZ*cmY*cpX;}
      else if(sym===2){v=cnX*cmY*cpZ+cnY*cmZ*cpX+cnZ*cmX*cpY+cnY*cmX*cpZ+cnX*cmZ*cpY+cnZ*cmY*cpX;}
      else if(sym===3){v=cnX*cmY*cpZ+cnY*cmZ*cpX+cnZ*cmX*cpY;}
      else if(sym===4){const snX=Math.sin(n*qx),snY=Math.sin(n*qy),snZ=Math.sin(n*qz);v=snX*cmY*cpZ+snY*cmZ*cpX+snZ*cmX*cpY;}
      else{v=cnX*cmY*cpZ;}
      acc+=A*v*cphi;
    }
    return acc;
  }
  return p=>{
    const qx=p[0]*WS,qy=p[1]*WS,qz=p[2]*WS;
    const fr=evalRaw(qx,qy,qz);
    let cym=sheet?(Math.abs(iso-fr)-thickness):(iso-fr);
    if(signFlip)cym=-cym;
    return cym;   // negative-inside (mesh canonical convention)
  };
}

module.exports = { buildBeamSDF, buildBundleSDF, buildWaveSDF, bundleParamsFromJSON, BSDF };
