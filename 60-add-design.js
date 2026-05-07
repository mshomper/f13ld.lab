/* ============================================================
   F13LD.lab · 60-add-design.js
   Add Design flow: file picker (JSON), ?r= URL param ingest,
   vault stub. Plus action button state for Export PDF and
   F13LD.mesh handoff (both gated on completed run).
   ============================================================ */

/* ----------------------------------------------------------
   Add Design click handler. Two paths:
     1. Click the button alone → file picker (.json)
     2. Hold Shift while clicking → paste-JSON prompt
   Both end up in the same ingest path.  Phase 10 will replace
   this with a proper modal that combines both options.
   ---------------------------------------------------------- */
function onAddDesignClick(){
  if (LAB_STATE.designs.length >= 3){
    alert('Maximum 3 designs in comparison. Remove one first.');
    return;
  }

  /* Shift-click → paste path.  Bypasses the file picker for
     workflows where the recipe lives in a clipboard buffer
     (copy from F13LD.mesh, paste here). */
  var ev = window.event;
  if (ev && ev.shiftKey){
    var raw = prompt('Paste F13LD recipe JSON:');
    if (!raw) return;
    try {
      var json = JSON.parse(raw);
      var design = normalizeDesignJson(json, json.name || 'pasted.json');
      LAB_STATE.designs.push(design);
      LAB_STATE.runHasCompleted = false;
      LAB_STATE.winningId = null;
      updateLoadedPill();
      updateActionButtons();
      recomputeEstimate();
      renderDesignGrid();
    } catch (err){
      console.error('[add-design] paste parse failed:', err);
      alert('Could not parse pasted text as JSON.\n\n' + err.message);
    }
    return;
  }

  // Default: file picker
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.onchange = function(e){
    if (e.target.files && e.target.files[0]){
      ingestDesignFile(e.target.files[0]);
    }
    document.body.removeChild(input);
  };
  document.body.appendChild(input);
  input.click();
}

/* ----------------------------------------------------------
   Parse a F13LD design JSON file and add it to the comparison.
   Phase 1 supports a permissive shape — F13LD.mesh handoff
   format and F13LD.Grain export both accepted.
   ---------------------------------------------------------- */
function ingestDesignFile(file){
  var reader = new FileReader();
  reader.onload = function(ev){
    try {
      var json = JSON.parse(ev.target.result);
      var design = normalizeDesignJson(json, file.name);
      LAB_STATE.designs.push(design);
      // New design loaded — clear any prior run results
      LAB_STATE.runHasCompleted = false;
      LAB_STATE.winningId = null;
      updateLoadedPill();
      updateActionButtons();
      recomputeEstimate();
      renderDesignGrid();
    } catch (err){
      console.error('[add-design] parse failed:', err);
      alert('Could not parse this file as a F13LD design JSON.\n\n' + err.message);
    }
  };
  reader.readAsText(file);
}

/* ----------------------------------------------------------
   Normalize incoming JSON to the LAB_STATE design shape.
   Permissive — accepts mesh handoff format, Grain export,
   raw param dumps. Real solver values come from a future run.

   Two outputs share the design:
     - The grid metadata (label/title/source/family/topology/etc.)
       used by the design-card header and SVG-mock fallback.
     - A `recipe` field — the full lab recipe shape that the
       raymarcher and CPU solvers consume directly.  This is set
       when the JSON is recognized as a valid lab recipe (has a
       `family` field that maps into KERNELS); otherwise it's null
       and the card falls back to SVG mock.
   ---------------------------------------------------------- */
function normalizeDesignJson(json, filename){
  var letter = String.fromCharCode(65 + LAB_STATE.designs.length);
  var palette = ['#22d3ee','#fbbf24','#fb7185'];

  var family = json.family || json.tool || 'unknown';
  var variant = json.variant || json.field || json.fieldType || 'custom';
  var topology = json.topology || (json.geometry && json.geometry.mode) || 'sheet';
  var rho = json.rho_rel || json.density || json.relative_density || 0.40;
  var cell = json.cell_mm || json.cellSize || (json.geometry && json.geometry.cellSizeMm) || 4.0;

  // Try to derive a reasonable title
  var title = json.title || json.name;
  if (!title){
    if (family === 'tpms') title = (json.tpms_type || 'TPMS') + ' · ' + topology;
    else if (variant === 'spinodoid') title = 'Spinodoid · VMF';
    else if (variant === 'reaction_diffusion' || variant === 'reactiondiffusion') title = 'Trabecular · GS';
    else if (variant) title = variant.charAt(0).toUpperCase() + variant.slice(1);
    else title = 'Custom design';
  }

  /* Derive a renderable recipe from the JSON.  A "valid lab recipe"
     has a recognized `family` and the kernel-specific block needed
     for that family (surface for tpms, field for grain/noise).
     If anything is missing, recipe stays null and the design falls
     back to the SVG mock; we surface a console note so the user can
     fix the JSON. */
  var recipe = null;
  var recipeNote = '';
  if (typeof KERNELS !== 'undefined' && KERNELS[family]){
    /* Already-shaped lab recipe? — accept verbatim */
    if (json.geometry && (json.surface || json.field)){
      recipe = json;
      recipeNote = 'recognized as full lab recipe';
    } else if (family === 'tpms' && json.surface){
      /* TPMS recipe missing geometry block — synthesize defaults */
      recipe = {
        family: 'tpms',
        name: title,
        surface: json.surface,
        geometry: {
          mode: topology || 'solid',
          offset: (json.geometry && json.geometry.offset) || 0,
          cellSizeMm: cell,
          cellMult: 1.0
        },
        material: json.material || (typeof MATERIAL_TI64_BONE !== 'undefined' ? MATERIAL_TI64_BONE : { Es_MPa: 110000, nu: 0.34, ks_WmK: 6.7, muFluid_PaS: 0.001 })
      };
      recipeNote = 'TPMS recipe synthesized with default geometry';
    } else if ((family === 'grain' || family === 'noise') && json.field){
      recipe = {
        family: family,
        name: title,
        field: json.field,
        geometry: json.geometry || {
          mode: family === 'grain' ? 'grain-sheet' : 'noise-sheet',
          cellSizeMm: cell,
          cellMult: 1.0
        },
        material: json.material || (typeof MATERIAL_TI64_BONE !== 'undefined' ? MATERIAL_TI64_BONE : { Es_MPa: 110000, nu: 0.34, ks_WmK: 6.7, muFluid_PaS: 0.001 })
      };
      recipeNote = (family === 'grain' ? 'Grain' : 'Noise') + ' recipe synthesized with default geometry';
    } else {
      recipeNote = 'family "' + family + '" recognized but kernel block (surface/field) missing — falling back to SVG mock';
    }
  } else {
    recipeNote = 'family "' + family + '" not in KERNELS — falling back to SVG mock';
  }
  if (recipeNote){
    console.log('[add-design] ' + filename + ': ' + recipeNote);
  }

  var id = json.id || ('user-' + Date.now().toString(36));
  return {
    id: id,
    label: 'DESIGN · ' + letter,
    title: title,
    source: 'imported · ' + filename,
    family: family === 'unknown' ? 'tpms' : family,   // fallback for SVG
    variant: variant,
    topology: topology,
    rho_rel: rho,
    cell_mm: cell,
    mat_es_gpa: json.mat_es_gpa || json.E_s || 110,
    mat_nu: json.mat_nu || json.nu || 0.30,
    color: palette[LAB_STATE.designs.length] || '#aaa',
    results: null,    // populated by run; stays null until then
    raw_json: json,   // preserved for handoff to F13LD.mesh
    recipe: recipe    // populated when JSON is a valid lab recipe; null otherwise
  };
}

/* ----------------------------------------------------------
   Handle ?r= URL param on page load. Phase 10 will route this
   to vault entry IDs; Phase 1 only handles direct JSON URLs
   for backward compatibility with the existing handoff scheme.
   ---------------------------------------------------------- */
function ingestUrlParam(){
  var params = new URLSearchParams(window.location.search);
  var r = params.get('r');
  if (!r) return;

  // If it looks like a vault entry ID (no protocol), stub it
  if (!r.startsWith('http://') && !r.startsWith('https://')){
    console.log('[add-design] vault entry ID detected (?r=' + r + ') — vault fetch is Phase 10');
    return;
  }

  // Direct JSON URL fetch
  fetch(r).then(function(res){
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function(json){
    if (LAB_STATE.designs.length >= 3) return;
    var design = normalizeDesignJson(json, r.split('/').pop() || 'remote.json');
    // Replace demo set with the imported one
    LAB_STATE.designs = [design];
    LAB_STATE.runHasCompleted = false;
    LAB_STATE.winningId = null;
    LAB_STATE.baselineId = design.id;
    updateLoadedPill();
    updateActionButtons();
    recomputeEstimate();
    renderDesignGrid();
  }).catch(function(err){
    console.warn('[add-design] ?r= fetch failed:', err);
  });
}

/* ============================================================
   ACTION BUTTONS — Export PDF, F13LD.mesh handoff
   ============================================================ */
function onExportPdfClick(){
  if (!LAB_STATE.runHasCompleted){
    alert('Run a comparison first to generate a report.');
    return;
  }
  // Phase 9 wires the real jsPDF generator — Phase 1 stub.
  alert('PDF export — coming in Phase 9.\n\nThe report will be a multi-page document with cover, per-design detail, comparison, and methodology sections (per the approved mockup).');
}

function onMeshHandoffClick(){
  if (!LAB_STATE.runHasCompleted || !LAB_STATE.winningId){
    alert('Run a comparison first. The winning design will be sent to F13LD.mesh.');
    return;
  }
  var winner = LAB_STATE.designs.find(function(d){ return d.id === LAB_STATE.winningId; });
  if (!winner) return;

  // Build the mesh URL — Phase 10 will use proper vault references;
  // Phase 1 either passes raw JSON via URL param or just opens mesh.
  var meshUrl = 'https://mshomper.github.io/f13ld.mesh/';
  if (winner.raw_json){
    // Encode the design JSON so mesh can pick it up via ?r=
    try {
      var encoded = encodeURIComponent(JSON.stringify(winner.raw_json));
      meshUrl += '?r=data:application/json,' + encoded;
    } catch (err){
      // Too large or other issue — fall back to plain open
    }
  }
  window.open(meshUrl, '_blank');
}

function onBrowseVaultClick(){
  alert('F13LD.vault browser — coming in Phase 10.\n\nFor Phase 1 use "+ Add Design" to import a JSON exported from any F13LD design tool.');
}

/* ----------------------------------------------------------
   Update action button enabled/disabled state based on the
   current LAB_STATE. Called whenever run state or design
   list changes.
   ---------------------------------------------------------- */
function updateActionButtons(){
  var pdfBtn = document.getElementById('exportPdfBtn');
  var meshBtn = document.getElementById('meshHandoffBtn');
  if (pdfBtn) pdfBtn.disabled = !LAB_STATE.runHasCompleted;
  if (meshBtn){
    meshBtn.disabled = !(LAB_STATE.runHasCompleted && LAB_STATE.winningId);
    if (LAB_STATE.runHasCompleted && LAB_STATE.winningId){
      var w = LAB_STATE.designs.find(function(d){ return d.id === LAB_STATE.winningId; });
      meshBtn.title = w ? 'Open winning design (' + w.title + ') in F13LD.mesh' : '';
    } else {
      meshBtn.title = 'Run a comparison first';
    }
  }
}

function updateLoadedPill(){
  var pill = document.getElementById('loadedPill');
  if (!pill) return;
  var n = LAB_STATE.designs.length;
  pill.textContent = n + ' of 3 design' + (n === 1 ? '' : 's') + ' loaded';
}
