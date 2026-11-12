/* F13LD.lab v0.35.1 — Geometry views, browser-console check (Matt's GPU).
   1. Open Lab, add a PI-TPMS design and a normalized-shell design (plus any others), open the Geometry tab.
   2. Press F12 and paste this one line into the Console, then press Enter (takes about 20 s):
        fetch('proto/geom-views/console_check.js').then(r => r.text()).then(eval)
   Prints: the curvature bake time per design, then for every view, each tile's shader result and
   gl.getError after drawing (Direct3D can link a shader and still fail at the first draw).
   All rows should read ok / NO_ERROR.  Your view choice is put back at the end. */
(async function () {
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var tiles = [];
  for (var id in LAB_RM_REGISTRY) { var r = LAB_RM_REGISTRY[id]; if (r && !r.failed && r._geomData) tiles.push([id, r]); }
  if (!tiles.length) { console.warn('No Geometry tiles yet — open the Geometry tab first.'); return; }
  var isComp = function (S) { return !(S.topoMode < 2.5 && !(S.topoMode < 0.5 && S.normMode > 0.5 && S.normMode < 1.5)); };
  var nameOf = function (id) { var d = (LAB_STATE.designs || []).filter(function (x) { return String(x.id) === String(id); })[0]; return d ? (d.name || d.title || id) : id; };

  /* 1 — bake time (runs once per design, the first time Curvature is shown) */
  var bake = tiles.map(function (t) {
    var r = t[1], S = r._u, comp = isComp(S), t0 = performance.now();
    if (comp) labBakeCompCurvature(r._geomData, r._geomDataB, r._geomN, S); else labBakeCurvature(r._geomData, r._geomN);
    return { design: nameOf(t[0]), kind: S.topoMode > 2.5 ? (S.normMode > 1.5 ? 'PI normalized' : 'PI plain') : (comp ? 'normalized shell' : 'level set'), grid: r._geomN + '³', bake_ms: +(performance.now() - t0).toFixed(1) };
  });
  console.log('Curvature bake time per design:'); console.table(bake);

  /* 2 — draw every view, then read gl.getError on each tile */
  var g = VIEW_STATE.geom, keepView = g.view, keepKind = g.kind, rows = [];
  var steps = [['shaded'], ['curvature', 'mean'], ['curvature', 'gauss'], ['curvature', 'tightest'], ['overhang'], ['wall'], ['pore']];
  for (var s = 0; s < steps.length; s++) {
    tiles.forEach(function (t) { t[1].gl.getError(); });   /* clear old errors */
    if (steps[s][1]) VIEW_STATE.geom.kind = steps[s][1];
    onGeomViewPick(steps[s][0]);
    await wait(2500);   /* first compile 0.1–2.5 s, then a few frames */
    tiles.forEach(function (t) {
      var r = t[1], gl = r.gl, e = gl.getError(), sets = r._geomSets || {}, failed = Object.keys(sets).filter(function (k) { return sets[k].failed; });
      rows.push({ view: steps[s].join(' / '), design: nameOf(t[0]), shader: failed.length ? 'FAILED ' + failed.join(',') : (r._viewWaiting ? 'still waiting' : 'ok'), glError: e === gl.NO_ERROR ? 'NO_ERROR' : '0x' + e.toString(16) });
    });
  }
  VIEW_STATE.geom.kind = keepKind; onGeomViewPick(keepView);
  console.log('Draw check per view:'); console.table(rows);
  var bad = rows.filter(function (x) { return x.shader !== 'ok' || x.glError !== 'NO_ERROR'; });
  console.log(bad.length ? bad.length + ' problem row(s) — send me the table' : 'All views drew cleanly.');
})();
