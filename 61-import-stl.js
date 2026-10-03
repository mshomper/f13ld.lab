/* ============================================================
   F13LD.lab · 61-import-stl.js
   STL unit-cell import — dialog, report card, grid store, export.

   Flow
     + Import STL (or an .stl dropped on the page / picked in Add Design)
       → dialog: units, cell size, Build
       → worker (14c) voxelizes the STL into a periodic signed-distance
         grid and measures it
       → report card + live preview; wall offset slider
       → Add to lab: grid saved to IndexedDB under its content hash; the
         design's recipe carries only that hash (13c-import-kernel.js)
   Card buttons on an imported design: ⚙ adjust (wall offset), ⤓ save
   as JSON with the grid embedded (reloads anywhere through Add Design).

   Storage
     IndexedDB 'f13ld.lab.imports' / store 'grids', key = hash.
     localStorage keeps only the small design record (00-mock-data.js).
   ============================================================ */

var IMPORT_UI_VERSION = 'imp-2';          /* cache-bust for the import worker */
var IMPORT_FACE_GREEN = 0.95, IMPORT_FACE_AMBER = 0.80;   /* the card's "not periodic" tag is red only (< amber) */
var IMPORT_OFFSET_FRAC = 0.5;             /* slider range ±0.5 field units (of the 0.8 stored) */

/* ── Grid store (IndexedDB) ───────────────────────────────── */
var _importDbPromise = null;
function importDb() {
  if (_importDbPromise) return _importDbPromise;
  _importDbPromise = new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    var req = indexedDB.open('f13ld.lab.imports', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('grids', { keyPath: 'hash' }); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
  });
  _importDbPromise.catch(function () { _importDbPromise = null; });
  return _importDbPromise;
}
function importDbPut(rec) {
  return importDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('grids', 'readwrite');
      tx.objectStore('grids').put({ hash: rec.hash, n: rec.n, R: rec.R, bytes: rec.bytes, name: rec.name || '', saved: Date.now() });
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function importDbGet(hash) {
  return importDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction('grids', 'readonly').objectStore('grids').get(hash);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

/* Load the grids of restored imported designs before they render.  Designs
   whose grid is gone (site data cleared) are flagged; their cards say so. */
function hydrateImportGrids() {
  var need = LAB_STATE.designs.filter(function (d) {
    return d.recipe && d.recipe.family === 'import' && !importGridReady(d.recipe);
  });
  if (!need.length) return Promise.resolve(false);
  return Promise.all(need.map(function (d) {
    return importDbGet(d.recipe.import.hash).then(function (rec) {
      if (rec) { registerImportGrid(rec); d._importMissing = false; }
      else d._importMissing = true;
    }).catch(function () { d._importMissing = true; });
  })).then(function () { return true; });
}

/* ── Hash / encode ────────────────────────────────────────── */
function importGridHash(bytes, n, R) {
  var head = new TextEncoder().encode('f13ld-import|' + n + '|' + R + '|');
  var all = new Uint8Array(head.length + bytes.length);
  all.set(head, 0); all.set(bytes, head.length);
  if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
    return crypto.subtle.digest('SHA-256', all).then(function (buf) {
      var a = new Uint8Array(buf), s = '';
      for (var i = 0; i < 10; i++) s += ('0' + a[i].toString(16)).slice(-2);
      return 'g' + s;
    });
  }
  /* fallback: two FNV-1a passes (non-secure contexts) */
  var h1 = 0x811c9dc5, h2 = 0x01000193 ^ all.length;
  for (var j = 0; j < all.length; j++) { h1 = Math.imul(h1 ^ all[j], 16777619) >>> 0; h2 = Math.imul(h2 ^ all[j], 16777619) >>> 0; }
  return Promise.resolve('f' + ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8));
}

function bytesToBase64(bytes) {
  var s = '', CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function base64ToBytes(b64) {
  var s = atob(b64), out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function gzipBytes(bytes) {
  if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
  var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
}
function gunzipBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser cannot unpack compressed geometry'));
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
}

/* ── Unit helpers ─────────────────────────────────────────── */
function impFieldPerMm(cellMm) { return 2 * Math.PI / cellMm; }
function impFmtMm(v) { return (v == null || !isFinite(v)) ? '—' : (Math.abs(v) < 0.1 ? v.toFixed(3) : v.toFixed(2)) + ' mm'; }
function impFaceClass(f) { return f >= IMPORT_FACE_GREEN ? 'good' : (f >= IMPORT_FACE_AMBER ? 'warn' : 'bad'); }
function impEsc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/* Density at a wall offset, straight from the stored grid (≈ voxels at N = n). */
function importDensityAt(grid, offsetField) {
  var d = grid.data, c = 0;
  for (var i = 0; i < d.length; i++) if (d[i] < offsetField) c++;
  return c / d.length;
}

/* Spanning and networks at N = 64, through the same voxelizer and
   connectivity code the solvers use. */
function importSpanning(hash, offsetField) {
  var N = 64;
  var params = ImportKernel.parseRecipe({ import: { hash: hash } });
  var solid = buildVoxels('import', params, offsetField, N, 'solid');
  var pc = periodicComponents(solid, N), bits = 0, networks = 0, islands = 0;
  for (var c = 1; c <= pc.count; c++) {
    if (pc.wraps[c]) { networks++; bits |= pc.wraps[c]; } else islands++;
  }
  return { x: !!(bits & 1), y: !!(bits & 2), z: !!(bits & 4), networks: networks, islands: islands };
}

/* Thinnest wall in voxels at the lab grids; recommend the smallest grid that
   puts ≥ 2 voxels across it. */
function importGridAdvice(thinMm, cellMm) {
  var out = { perN: {}, recommend: 128, ok: false };
  [32, 64, 128].forEach(function (N) { out.perN[N] = thinMm / (cellMm / N); });
  for (var i = 0, Ns = [32, 64, 128]; i < Ns.length; i++) {
    if (out.perN[Ns[i]] >= 2) { out.recommend = Ns[i]; out.ok = true; break; }
  }
  return out;
}

/* ── Worker ───────────────────────────────────────────────── */
function makeStlImportWorker() {
  var base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : location.href;
  var u = new URL('14c-stl-import.js', base);
  u.search = '?v=' + IMPORT_UI_VERSION;
  var body = 'importScripts(' + JSON.stringify(u.href) + ');\n' + STL_IMPORT_WORKER_ONMESSAGE;
  return new Worker(URL.createObjectURL(new Blob([body], { type: 'application/javascript' })));
}

/* Build in a worker (page stays responsive); falls back to the page. */
function runStlBuild(buffer, settings, onProgress) {
  return new Promise(function (resolve, reject) {
    var w = null;
    try { w = makeStlImportWorker(); } catch (e) { w = null; }
    if (!w) {
      setTimeout(function () {
        try { resolve(buildImportGridFromStl(buffer.slice(0), settings, onProgress)); } catch (err) { reject(err); }
      }, 30);
      return;
    }
    IMPORT_STATE.worker = w;
    w.onmessage = function (ev) {
      var m = ev.data;
      if (m.type === 'progress') { if (onProgress) onProgress(m.stage, m.frac); return; }
      w.terminate(); if (IMPORT_STATE.worker === w) IMPORT_STATE.worker = null;
      if (m.type === 'done') resolve(m.result); else reject(new Error(m.message || 'import failed'));
    };
    w.onerror = function (e) {
      w.terminate(); if (IMPORT_STATE.worker === w) IMPORT_STATE.worker = null;
      reject(new Error((e && e.message) || 'import worker failed'));
    };
    var copy = buffer.slice(0);
    w.postMessage({ buffer: copy, settings: settings }, [copy]);
  });
}

/* ── Dialog state ─────────────────────────────────────────── */
var IMPORT_STATE = {
  open: false, mode: 'new', designId: null,
  fileName: null, buffer: null,
  settings: { units: 'mm', cellMode: 'fit', cellMm: null },
  builtSettings: null,
  result: null, hash: null, grid: null,
  offsetMm: 0, spans: null,
  rm: null, worker: null, busy: false, error: null
};

function impEl(id) { return document.getElementById(id); }

function openImportDialog(file) {
  if (LAB_STATE.designs.length >= 3) { alert('Maximum 3 designs in comparison. Remove one first.'); return; }
  closeImportDialog();
  IMPORT_STATE.mode = 'new'; IMPORT_STATE.designId = null;
  IMPORT_STATE.fileName = null; IMPORT_STATE.buffer = null;
  IMPORT_STATE.settings = { units: 'mm', cellMode: 'fit', cellMm: null };
  IMPORT_STATE.result = null; IMPORT_STATE.hash = null; IMPORT_STATE.grid = null;
  IMPORT_STATE.offsetMm = 0; IMPORT_STATE.spans = null; IMPORT_STATE.error = null; IMPORT_STATE.faceView = null;
  impMountDialog();
  if (file) impLoadFile(file);
}

/* Adjust an imported design already in the lab (wall offset; the STL itself
   isn't kept, so units and cell size need a re-import). */
function openImportDialogForDesign(designId) {
  var d = LAB_STATE.designs.find(function (x) { return x.id === designId; });
  if (!d || !d.recipe || d.recipe.family !== 'import') return;
  if (!importGridReady(d.recipe)) { alert('This design’s geometry is not loaded. Re-import its STL or saved JSON.'); return; }
  closeImportDialog();
  var rep = d.import_report || {};
  IMPORT_STATE.mode = 'edit'; IMPORT_STATE.designId = designId;
  IMPORT_STATE.fileName = (d.recipe.import && d.recipe.import.name) || d.title;
  IMPORT_STATE.buffer = null;
  IMPORT_STATE.hash = d.recipe.import.hash;
  IMPORT_STATE.grid = IMPORT_GRIDS[IMPORT_STATE.hash];
  IMPORT_STATE.result = { ok: true, cellMm: d.cell_mm, report: rep, n: IMPORT_STATE.grid.n, R: IMPORT_STATE.grid.R };
  IMPORT_STATE.offsetMm = (d.recipe.geometry && d.recipe.geometry.wallOffsetMm) || 0;
  IMPORT_STATE.error = null;
  impMountDialog();
  impShowResult();
}

function closeImportDialog() {
  if (IMPORT_STATE.worker) { try { IMPORT_STATE.worker.terminate(); } catch (e) {} IMPORT_STATE.worker = null; }
  if (IMPORT_STATE.rm) { try { IMPORT_STATE.rm.destroy(); } catch (e) {} IMPORT_STATE.rm = null; }
  var ov = impEl('impOverlay');
  if (ov) ov.parentNode.removeChild(ov);
  IMPORT_STATE.open = false; IMPORT_STATE.busy = false;
}

function impMountDialog() {
  var edit = IMPORT_STATE.mode === 'edit';
  var ov = document.createElement('div');
  ov.id = 'impOverlay'; ov.className = 'imp-overlay';
  ov.innerHTML =
    '<div class="imp-dialog" role="dialog" aria-label="Import STL unit cell">' +
      '<div class="imp-head">' +
        '<div class="imp-title">' + (edit ? 'Adjust imported cell' : 'Import STL unit cell') + '</div>' +
        '<button class="dc-icon-btn" title="Close" onclick="closeImportDialog()">×</button>' +
      '</div>' +
      (edit ? '<div class="imp-note">Units and cell size are fixed at import. To change them, import the STL again.</div>' :
      '<div class="imp-drop" id="impDrop">' +
        '<div id="impDropText">Drop an STL here, or <a href="#" onclick="impPickFile();return false;">choose a file</a>. One repeating unit cell, binary or ASCII.</div>' +
      '</div>' +
      '<div class="imp-settings">' +
        '<label>Units <select id="impUnits" onchange="impSettingChanged()"><option value="mm">mm</option><option value="in">inch</option></select></label>' +
        '<label>Cell size <select id="impCellMode" onchange="impSettingChanged()"><option value="fit">fit to part</option><option value="set">set:</option></select></label>' +
        '<label class="imp-cellmm"><input id="impCellMm" type="number" min="0.01" step="0.01" placeholder="mm" oninput="impSettingChanged()" disabled> mm</label>' +
        '<button class="fh-action-btn ghost" id="impBuildBtn" onclick="impBuild()" disabled>Build</button>' +
      '</div>') +
      '<div class="imp-progress" id="impProgress"><div class="imp-bar"><div id="impBarFill"></div></div><span id="impStage"></span></div>' +
      '<div class="imp-error" id="impError"></div>' +
      '<div class="imp-body" id="impBody">' +
        '<div class="imp-preview" id="impPreview"></div>' +
        '<div class="imp-report" id="impReport"></div>' +
      '</div>' +
      '<div class="imp-offset" id="impOffsetRow">' +
        '<label for="impOffset">Wall offset</label>' +
        '<input id="impOffset" type="range" min="-1" max="1" step="0.001" value="0" oninput="impOffsetChanged(this.value)">' +
        '<span id="impOffsetVal">0.000 mm</span>' +
        '<button class="dc-icon-btn" title="Reset to the imported walls" onclick="impOffsetReset()">↺</button>' +
      '</div>' +
      '<div class="imp-foot">' +
        '<button class="fh-action-btn ghost" onclick="closeImportDialog()">Cancel</button>' +
        '<button class="fh-action-btn" id="impAddBtn" onclick="impCommit()" disabled>' + (edit ? 'Apply' : 'Add to lab') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  IMPORT_STATE.open = true;
  ov.addEventListener('mousedown', function (e) { if (e.target === ov && !IMPORT_STATE.busy) closeImportDialog(); });
  var drop = impEl('impDrop');
  if (drop) {
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) impLoadFile(e.dataTransfer.files[0]);
    });
  }
  impSyncSettingsUI();
}

function impPickFile() {
  var input = document.createElement('input');
  input.type = 'file'; input.accept = '.stl,model/stl,application/sla'; input.style.display = 'none';
  input.onchange = function (e) {
    if (e.target.files && e.target.files[0]) impLoadFile(e.target.files[0]);
    document.body.removeChild(input);
  };
  document.body.appendChild(input); input.click();
}

function impLoadFile(file) {
  if (!/\.stl$/i.test(file.name)) { impSetError('That isn’t an .stl file.'); return; }
  var reader = new FileReader();
  reader.onload = function (ev) {
    IMPORT_STATE.fileName = file.name;
    IMPORT_STATE.buffer = ev.target.result;
    var t = impEl('impDropText');
    if (t) t.innerHTML = '<b>' + impEsc(file.name) + '</b> · ' + (file.size / 1048576).toFixed(1) + ' MB · <a href="#" onclick="impPickFile();return false;">change</a>';
    impBuild();
  };
  reader.onerror = function () { impSetError('Could not read the file.'); };
  reader.readAsArrayBuffer(file);
}

function impSyncSettingsUI() {
  var s = IMPORT_STATE.settings;
  var u = impEl('impUnits'), cm = impEl('impCellMode'), mm = impEl('impCellMm'), b = impEl('impBuildBtn');
  if (u) u.value = s.units;
  if (cm) cm.value = s.cellMode;
  if (mm) { mm.disabled = s.cellMode !== 'set'; if (s.cellMm != null && document.activeElement !== mm) mm.value = s.cellMm; }
  if (b) {
    var dirty = !IMPORT_STATE.builtSettings || JSON.stringify(IMPORT_STATE.builtSettings) !== JSON.stringify(s);
    b.disabled = !IMPORT_STATE.buffer || IMPORT_STATE.busy || !dirty;
    b.textContent = IMPORT_STATE.result ? 'Rebuild' : 'Build';
  }
}

function impSettingChanged() {
  var s = IMPORT_STATE.settings;
  s.units = impEl('impUnits').value;
  s.cellMode = impEl('impCellMode').value;
  var v = parseFloat(impEl('impCellMm').value);
  s.cellMm = isFinite(v) && v > 0 ? v : null;
  if (s.cellMode === 'set' && s.cellMm == null && IMPORT_STATE.result && IMPORT_STATE.result.cellMm) {
    s.cellMm = +IMPORT_STATE.result.cellMm.toFixed(3);
  }
  impSyncSettingsUI();
}

function impSetError(msg) {
  IMPORT_STATE.error = msg;
  var e = impEl('impError');
  if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }
}

function impProgress(stage, frac) {
  var p = impEl('impProgress');
  if (!p) return;
  p.style.display = stage ? 'flex' : 'none';
  impEl('impStage').textContent = stage || '';
  impEl('impBarFill').style.width = Math.round((frac || 0) * 100) + '%';
}

function impBuild() {
  if (!IMPORT_STATE.buffer || IMPORT_STATE.busy) return;
  var s = IMPORT_STATE.settings;
  if (s.cellMode === 'set' && !(s.cellMm > 0)) { impSetError('Enter a cell size in mm, or choose “fit to part.”'); return; }
  impSetError(null);
  IMPORT_STATE.busy = true;
  IMPORT_STATE.builtSettings = JSON.parse(JSON.stringify(s));
  impSyncSettingsUI();
  impEl('impAddBtn').disabled = true;
  impProgress('Starting', 0);
  var settings = { units: s.units, cellMode: s.cellMode, cellMm: s.cellMm };
  runStlBuild(IMPORT_STATE.buffer, settings, impProgress).then(function (r) {
    if (!IMPORT_STATE.open) return;
    if (!r.ok) {
      IMPORT_STATE.busy = false; impProgress(null);
      impSetError(r.message || 'Import failed.');
      if (r.error === 'notCubic') {   /* offer the set-size path, prefilled with the longest side */
        IMPORT_STATE.settings.cellMode = 'set';
        if (r.sides) IMPORT_STATE.settings.cellMm = +Math.max.apply(null, r.sides).toFixed(3);
        IMPORT_STATE.builtSettings = null;
      }
      impSyncSettingsUI();
      return;
    }
    return importGridHash(r.bytes, r.n, r.R).then(function (hash) {
      IMPORT_STATE.busy = false; impProgress(null);
      registerImportGrid({ hash: hash, n: r.n, R: r.R, bytes: r.bytes });
      IMPORT_STATE.result = r; IMPORT_STATE.hash = hash; IMPORT_STATE.grid = IMPORT_GRIDS[hash];
      if (IMPORT_STATE.settings.cellMode === 'fit') IMPORT_STATE.settings.cellMm = +r.cellMm.toFixed(3);
      IMPORT_STATE.builtSettings = JSON.parse(JSON.stringify(IMPORT_STATE.settings));
      IMPORT_STATE.offsetMm = 0; IMPORT_STATE.faceView = null;
      impSyncSettingsUI();
      impShowResult();
    });
  }).catch(function (err) {
    IMPORT_STATE.busy = false; impProgress(null);
    impSetError('Import failed: ' + ((err && err.message) || err));
    impSyncSettingsUI();
  });
}

/* ── Report + preview ─────────────────────────────────────── */
function impPreviewRecipe() {
  var cell = IMPORT_STATE.result.cellMm;
  return { family: 'import', name: 'preview', import: { hash: IMPORT_STATE.hash },
           geometry: { mode: 'solid', offset: IMPORT_STATE.offsetMm * impFieldPerMm(cell), cellSizeMm: cell } };
}

function impShowResult() {
  var body = impEl('impBody'), row = impEl('impOffsetRow');
  if (!body) return;
  body.style.display = 'grid'; row.style.display = 'flex';
  var r = IMPORT_STATE.result, cell = r.cellMm;
  var maxMm = IMPORT_OFFSET_FRAC / impFieldPerMm(cell);
  var sl = impEl('impOffset');
  sl.min = (-maxMm).toFixed(4); sl.max = maxMm.toFixed(4);
  sl.step = String(Math.pow(10, Math.floor(Math.log10(maxMm / 200))));   /* 0.001 mm on a 5 mm cell */
  sl.value = IMPORT_STATE.offsetMm;
  /* preview */
  var pv = impEl('impPreview');
  if (!IMPORT_STATE.rm && typeof LabRaymarcher === 'function') {
    var rm = new LabRaymarcher();
    if (!rm.failed) { IMPORT_STATE.rm = rm; pv.innerHTML = ''; pv.appendChild(rm.canvas); }
    else pv.innerHTML = '<div class="imp-nopreview">Preview needs WebGL2</div>';
  }
  if (IMPORT_STATE.rm) { IMPORT_STATE.rm.setRecipe(impPreviewRecipe()); IMPORT_STATE.rm.setActive(true); }
  impUpdateLive(true);
  impEl('impAddBtn').disabled = false;
}

var _impSpanTimer = null;
function impUpdateLive(now) {
  var r = IMPORT_STATE.result, cell = r.cellMm, offF = IMPORT_STATE.offsetMm * impFieldPerMm(cell);
  IMPORT_STATE.density = importDensityAt(IMPORT_STATE.grid, offF);
  impEl('impOffsetVal').textContent = (IMPORT_STATE.offsetMm >= 0 ? '+' : '−') + Math.abs(IMPORT_STATE.offsetMm).toFixed(3) + ' mm';
  clearTimeout(_impSpanTimer);
  var go = function () {
    try { IMPORT_STATE.spans = importSpanning(IMPORT_STATE.hash, offF); } catch (e) { IMPORT_STATE.spans = null; }
    impRenderReport();
  };
  if (now) go(); else { impRenderReport(); _impSpanTimer = setTimeout(go, 180); }
}

function impOffsetChanged(v) {
  IMPORT_STATE.offsetMm = parseFloat(v) || 0;
  if (IMPORT_STATE.rm) IMPORT_STATE.rm.setRecipe(impPreviewRecipe());
  impUpdateLive(false);
}
function impOffsetReset() { impEl('impOffset').value = 0; impOffsetChanged(0); }

function impRenderReport() {
  var el = impEl('impReport');
  if (!el) return;
  var r = IMPORT_STATE.result, rep = r.report || {}, cell = r.cellMm, sp = IMPORT_STATE.spans;
  var thin = rep.thinnestWallMm != null ? Math.max(0, rep.thinnestWallMm + 2 * IMPORT_STATE.offsetMm) : null;
  var adv = thin != null ? importGridAdvice(thin, cell) : null;
  var h = rep.health || {};
  function row(k, v, cls) { return '<div class="imp-row"><span class="k">' + k + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + v + '</span></div>'; }
  var html = '';
  html += row('File', impEsc(IMPORT_STATE.fileName || ''));
  html += row('Cell', cell.toFixed(3) + ' mm' + (rep.units === 'in' ? ' (from inches)' : '') +
              (rep.cellMode !== 'set' && rep.facesFromPlanes ? ' · faces found from the trim planes' : '') +
              (rep.overhangMm > 0.0005 ? ' · geometry up to ' + rep.overhangMm.toFixed(3) + ' mm past the faces, wrapped to the opposite side' : '') +
              (rep.stretched && rep.mismatch > 0.0005 ? ' · sides stretched up to ' + (rep.mismatch * 100).toFixed(1) + ' % to fill' : '') +
              (rep.cellMode === 'set' ? ' · set by you, part centered' : ''));
  html += row('Density', (IMPORT_STATE.density * 100).toFixed(1) + ' %');
  if (rep.faceMatch) {
    var canView = !!r.faceMaps;
    html += row('Face match', rep.faceMatch.map(function (f, i) {
      return '<span class="imp-chip ' + impFaceClass(f) + (canView ? ' click' + (IMPORT_STATE.faceView === i ? ' on' : '') : '') + '"' +
             (canView ? ' title="Show the two opposite faces overlaid" onclick="impToggleFaceView(' + i + ')"' : '') + '>' +
             'xyz'[i] + ' ' + (f * 100).toFixed(1) + '%</span>';
    }).join(' ') + (canView ? ' <span class="imp-sub">click to see the faces</span>' : ''));
    if (canView && IMPORT_STATE.faceView != null) {
      var fa = IMPORT_STATE.faceView, ax = 'xyz'[fa], rowsAx = fa === 0 ? 'y' : 'x', colsAx = fa === 2 ? 'y' : 'z';
      html += '<div class="imp-faceview"><canvas id="impFaceCanvas" width="' + r.fineM + '" height="' + r.fineM + '"></canvas>' +
        '<div class="imp-sub"><span class="imp-key a"></span>solid only at the ' + ax + '− face<br><span class="imp-key b"></span>solid only at the ' + ax + '+ face<br>' +
        '<span class="imp-key ab"></span>solid at both<br><br>Up: ' + rowsAx + ' · right: ' + colsAx + '. Thin colored edges are walls meeting the face at an angle; ' +
        'a periodic cell shows no large one-color patches.</div></div>';
    }
  }
  if (sp) {
    html += row('Spans the cell', ['x', 'y', 'z'].map(function (a) {
      return '<span class="imp-chip ' + (sp[a] ? 'good' : 'bad') + '">' + a + ' ' + (sp[a] ? 'yes' : 'no') + '</span>';
    }).join(' ') + ' <span class="imp-sub">' + sp.networks + ' network' + (sp.networks === 1 ? '' : 's') +
      (sp.islands ? ' · ' + sp.islands + ' floating piece' + (sp.islands === 1 ? '' : 's') + ' (removed when solving)' : '') + '</span>');
  }
  if (thin != null) {
    var cls = adv.ok ? (adv.recommend <= 64 ? 'good' : 'warn') : 'bad';
    html += row('Thinnest wall', impFmtMm(thin) + ' <span class="imp-sub">≈ ' + adv.perN[32].toFixed(1) + ' / ' +
      adv.perN[64].toFixed(1) + ' / ' + adv.perN[128].toFixed(1) + ' voxels at N = 32 / 64 / 128</span>');
    html += row('Recommended grid', adv.ok ? 'N = ' + adv.recommend : 'N = 128 (walls under 2 voxels even there)', cls);
  }
  var meshCls = h.watertight ? 'good' : 'warn';
  html += row('Mesh', (h.triangles || 0).toLocaleString() + ' triangles · ' +
    (h.watertight ? 'watertight' : (h.openEdges + ' open edges' + (h.nonManifoldEdges ? ', ' + h.nonManifoldEdges + ' non-manifold' : ''))) +
    (rep.fillAgreement != null && rep.fillAgreement < 0.999 ? ' · fill agreement ' + (rep.fillAgreement * 100).toFixed(1) + ' %' : ''), meshCls);
  var warns = [];
  if (rep.faceMatch && rep.faceMatch.some(function (f) { return f < IMPORT_FACE_AMBER; }))
    warns.push('Opposite faces don’t line up on every axis — this may not be one full repeating period. The design will be tagged “not periodic.”');
  else if (rep.faceMatch && rep.faceMatch.some(function (f) { return f < IMPORT_FACE_GREEN; }))
    warns.push('Opposite faces mostly line up, with some differences at the seam. Click a face-match chip to see where.');
  if (sp && !(sp.x && sp.y && sp.z)) warns.push('The solid doesn’t connect across the cell on every axis, so the lattice carries no load along ' +
    ['x', 'y', 'z'].filter(function (a) { return !sp[a]; }).join(', ') + '.');
  if (!h.watertight) warns.push('The mesh has gaps; the three-direction fill vote repaired what it could. Check the preview.');
  if (warns.length) html += '<div class="imp-warn">' + warns.map(impEsc).join('<br>') + '</div>';
  el.innerHTML = html;
  if (r.faceMaps && IMPORT_STATE.faceView != null) impDrawFaceView(IMPORT_STATE.faceView);
}

/* Face view: the boundary slices of one axis overlaid (teal = only face −,
   violet = only face +, light = both).  Row axis drawn upward. */
function impToggleFaceView(a) {
  IMPORT_STATE.faceView = IMPORT_STATE.faceView === a ? null : a;
  impRenderReport();
}
function impDrawFaceView(a) {
  var cv = impEl('impFaceCanvas'), r = IMPORT_STATE.result;
  if (!cv || !r.faceMaps) return;
  var M = r.fineM, MM = M * M, ctx = cv.getContext('2d'), img = ctx.createImageData(M, M), px = img.data;
  var COL = [[12, 12, 18], [29, 158, 117], [127, 119, 221], [225, 225, 235]];
  for (var p = 0; p < M; p++) for (var q = 0; q < M; q++) {
    var c = COL[r.faceMaps[a * MM + p * M + q]], o = ((M - 1 - p) * M + q) * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/* ── Commit ───────────────────────────────────────────────── */
function impReportSummary() {
  var rep = IMPORT_STATE.result.report || {}, h = rep.health || {};
  return {
    units: rep.units, cellMode: rep.cellMode, mismatch: rep.mismatch,
    facesFromPlanes: rep.facesFromPlanes, overhangMm: rep.overhangMm,
    faceMatch: rep.faceMatch, thinnestWallMm: rep.thinnestWallMm, medianWallMm: rep.medianWallMm,
    density0: rep.density, fillAgreement: rep.fillAgreement,
    health: { triangles: h.triangles, openEdges: h.openEdges, nonManifoldEdges: h.nonManifoldEdges, watertight: h.watertight }
  };
}

function impCommit() {
  if (!IMPORT_STATE.result || !IMPORT_STATE.hash) return;
  var cell = IMPORT_STATE.result.cellMm;
  var offMm = +IMPORT_STATE.offsetMm.toFixed(4), offF = offMm * impFieldPerMm(cell);
  var rho = importDensityAt(IMPORT_STATE.grid, offF);

  if (IMPORT_STATE.mode === 'edit') {
    var d = LAB_STATE.designs.find(function (x) { return x.id === IMPORT_STATE.designId; });
    if (d) {
      if (typeof RUN_STATE !== 'undefined' && RUN_STATE.running && typeof cancelRun === 'function') cancelRun();
      d.recipe.geometry.offset = offF; d.recipe.geometry.wallOffsetMm = offMm;
      d.rho_rel = rho; d.results = null;
      if (IMPORT_STATE.spans) d.import_spans = IMPORT_STATE.spans;
      if (typeof BUCKLE_BY_DESIGN !== 'undefined') delete BUCKLE_BY_DESIGN[d.id];
      if (typeof NONLIN_BY_DESIGN !== 'undefined') delete NONLIN_BY_DESIGN[d.id];
      if (typeof NONLIN_AXES !== 'undefined') delete NONLIN_AXES[d.id];
      if (typeof disposeRaymarcher === 'function') disposeRaymarcher(d.id);
      LAB_STATE.runHasCompleted = false; LAB_STATE.winningId = null;
    }
    closeImportDialog();
    impAfterChange();
    return;
  }

  if (LAB_STATE.designs.length >= 3) { alert('Maximum 3 designs in comparison. Remove one first.'); return; }
  var name = (IMPORT_STATE.fileName || 'cell.stl').replace(/\.stl$/i, '');
  var g = IMPORT_STATE.grid;
  importDbPut({ hash: g.hash, n: g.n, R: g.R, bytes: g.bytes, name: name }).catch(function (e) {
    console.warn('[import] grid not saved to IndexedDB — the design won’t survive a reload:', e);
  });
  var design = makeImportDesign({
    name: name, fileName: IMPORT_STATE.fileName, hash: g.hash, cellMm: cell,
    offsetField: offF, offsetMm: offMm, rho: rho, report: impReportSummary(), spans: IMPORT_STATE.spans
  });
  LAB_STATE.designs.push(design);
  closeImportDialog();
  impAfterChange();
}

function makeImportDesign(o) {
  var mat = (typeof MATERIAL_TI64_BONE !== 'undefined') ? MATERIAL_TI64_BONE : { Es_MPa: 110000, nu: 0.34 };
  var recipe = {
    family: 'import', name: o.name,
    import: { hash: o.hash, name: o.fileName || o.name },
    geometry: { mode: 'solid', offset: o.offsetField, wallOffsetMm: o.offsetMm, cellSizeMm: o.cellMm },
    material: mat
  };
  return {
    id: uniqueDesignId('import-' + o.hash.slice(1, 9)),
    label: 'DESIGN · ?', slot: -1,
    title: o.name,
    source: 'imported STL · ' + (o.fileName || o.name),
    family: 'import', variant: 'stl', topology: 'solid',
    rho_rel: o.rho, cell_mm: o.cellMm,
    mat_es_gpa: mat.Es_MPa / 1000, mat_nu: mat.nu,
    color: '#aaa', results: null,
    raw_json: { family: 'import', name: o.name },   /* small on purpose — gates the nominal density */
    import_report: o.report, import_spans: o.spans || null,
    recipe: recipe
  };
}

function impAfterChange() {
  if (typeof reconcileDesignSlots === 'function') reconcileDesignSlots();
  LAB_STATE.runHasCompleted = false; LAB_STATE.winningId = null;
  updateLoadedPill(); updateActionButtons(); recomputeEstimate(); renderDesignGrid();
}

/* ── Card hooks (40-design-grid.js) ───────────────────────── */
function importCardPills(d) {
  if (!d || d.family !== 'import') return '';
  var out = '';
  if (d.recipe && !importGridReady(d.recipe)) {
    out += ' <span class="dc-predict-pill prone" title="The geometry for this design isn’t in this browser (site data cleared?). Re-import the STL or its saved JSON.">' +
           (d._importMissing ? 'geometry missing' : 'loading geometry') + '</span>';
  }
  var fm = d.import_report && d.import_report.faceMatch;
  if (fm && fm.some(function (f) { return f < IMPORT_FACE_AMBER; })) {
    out += ' <span class="dc-predict-pill prone" title="Face match ' + fm.map(function (f, i) { return 'xyz'[i] + ' ' + (f * 100).toFixed(1) + '%'; }).join(', ') +
           ' — opposite faces don’t line up, so this may not be one full repeating period.">not periodic</span>';
  }
  var g = d.recipe && d.recipe.geometry;
  if (g && g.wallOffsetMm) out += ' <span class="dc-predict-pill" title="Wall offset applied on import">walls ' + (g.wallOffsetMm > 0 ? '+' : '−') + Math.abs(g.wallOffsetMm).toFixed(3) + ' mm</span>';
  return out;
}

function importCardButtons(d) {
  if (!d || d.family !== 'import') return '';
  return '<button class="dc-icon-btn" title="Adjust wall offset" onclick="openImportDialogForDesign(\'' + d.id + '\')">⚙</button>' +
         '<button class="dc-icon-btn" title="Save as JSON with the geometry inside (reload it with + Add Design)" onclick="exportImportDesign(\'' + d.id + '\')">⤓</button>';
}

/* ── Export / re-import with the grid embedded ────────────── */
function exportImportDesign(designId) {
  var d = LAB_STATE.designs.find(function (x) { return x.id === designId; });
  if (!d || !d.recipe || d.recipe.family !== 'import') return;
  var g = IMPORT_GRIDS[d.recipe.import.hash];
  if (!g) { alert('This design’s geometry is not loaded, so it can’t be saved.'); return; }
  gzipBytes(g.bytes).then(function (gz) {
    var out = {
      format: 'f13ld.lab.import.v1',
      family: 'import',
      name: d.recipe.name,
      import: { hash: g.hash, name: d.recipe.import.name },
      geometry: d.recipe.geometry,
      import_report: d.import_report || null,
      grid: { n: g.n, R: g.R, encoding: gz ? 'u8+gzip+base64' : 'u8+base64', data: bytesToBase64(gz || g.bytes) }
    };
    var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (d.recipe.name || 'imported-cell').replace(/[^\w.-]+/g, '_') + '.f13ld-import.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 1000);
  }).catch(function (e) { alert('Could not save: ' + e.message); });
}

function isImportDesignJson(json) {
  return !!(json && json.family === 'import' && json.grid && json.grid.data);
}

/* Add Design path for a saved import JSON. */
function ingestImportDesignJson(json, filename) {
  var gr = json.grid, raw = base64ToBytes(gr.data);
  var unpack = /gzip/.test(gr.encoding || '') ? gunzipBytes(raw) : Promise.resolve(raw);
  return unpack.then(function (bytes) {
    return importGridHash(bytes, gr.n, gr.R).then(function (hash) {
      if (json.import && json.import.hash && json.import.hash !== hash && hash.charAt(0) === json.import.hash.charAt(0)) {
        throw new Error('the geometry in this file is damaged (content check failed)');
      }
      registerImportGrid({ hash: hash, n: gr.n, R: gr.R, bytes: bytes });
      importDbPut({ hash: hash, n: gr.n, R: gr.R, bytes: bytes, name: json.name || '' }).catch(function () {});
      var geo = json.geometry || {}, cell = geo.cellSizeMm || 5;
      var offMm = geo.wallOffsetMm || 0;
      var offF = geo.offset != null ? geo.offset : offMm * impFieldPerMm(cell);
      var spans = null;
      try { spans = importSpanning(hash, offF); } catch (e) {}
      var design = makeImportDesign({
        name: json.name || filename.replace(/\.json$/i, ''), fileName: (json.import && json.import.name) || filename,
        hash: hash, cellMm: cell, offsetField: offF, offsetMm: offMm,
        rho: importDensityAt(IMPORT_GRIDS[hash], offF), report: json.import_report || null, spans: spans
      });
      if (LAB_STATE.designs.length >= 3) { alert('Maximum 3 designs in comparison. Remove one first.'); return; }
      LAB_STATE.designs.push(design);
      impAfterChange();
    });
  }).catch(function (err) {
    console.error('[import] saved JSON failed:', err);
    alert('Could not load this imported design.\n\n' + err.message);
  });
}

/* ── Page-level drop of an .stl ───────────────────────────── */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.addEventListener('dragover', function (e) {
    if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.items || [], function (it) { return it.kind === 'file'; })) e.preventDefault();
  });
  window.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !/\.stl$/i.test(f.name)) return;
    e.preventDefault();
    if (IMPORT_STATE.open && IMPORT_STATE.mode === 'new') impLoadFile(f); else openImportDialog(f);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && IMPORT_STATE.open && !IMPORT_STATE.busy) closeImportDialog();
  });
})();
