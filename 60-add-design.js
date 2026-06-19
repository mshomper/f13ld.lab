/* ============================================================
   F13LD.lab · 60-add-design.js
   Add Design flow: file picker (JSON), ?r= URL param ingest,
   vault stub. Plus action button state for Export PDF and
   F13LD.mesh handoff (both gated on completed run).
   ============================================================ */

/* ----------------------------------------------------------
   F13LD.tpms raw_preset expansion table.
   F13LD.tpms exports 9 named TPMS surfaces as `surface.type =
   'raw_preset'` with just a preset key, because the source tool
   stores them as JS function expressions rather than the
   multiplicative-trig terms array used by lab's TpmsKernel.
   This table maps each preset name to an equivalent terms array
   plus an additive constant (extracted to geometry.offset
   because lab's "solid where F < offset" convention places
   constants there rather than in the surface).

   Each expansion has been verified bit-exact (within FP64
   roundoff) against the source JS function in F13LD.tpms.
   See preset-test.js for the verification harness.

   Source: index_-_TPMS.html PRESETS table (lines 393-416).
   ---------------------------------------------------------- */
function _tpmsTpmsF(trig, fx, fy, fz){
  return { trig: trig, fx: fx != null ? fx : 1, fy: fy != null ? fy : 1, fz: fz != null ? fz : 1 };
}
function _tpmsTerm(coef){
  var factors = Array.prototype.slice.call(arguments, 1);
  return { on: true, coef: coef, factors: factors };
}

var TPMS_RAW_PRESET_TABLE = {
  fks: {
    label: 'Fischer-Koch S',
    constant: 0,
    terms: [
      _tpmsTerm(1, _tpmsTpmsF('cos(x)', 2, 1, 1), _tpmsTpmsF('sin(y)'), _tpmsTpmsF('cos(z)')),
      _tpmsTerm(1, _tpmsTpmsF('cos(y)', 1, 2, 1), _tpmsTpmsF('sin(z)'), _tpmsTpmsF('cos(x)')),
      _tpmsTerm(1, _tpmsTpmsF('cos(z)', 1, 1, 2), _tpmsTpmsF('sin(x)'), _tpmsTpmsF('cos(y)'))
    ]
  },
  splitP: {
    label: 'split-P',
    constant: -0.3,
    terms: [
      _tpmsTerm(1, _tpmsTpmsF('sin(x)'), _tpmsTpmsF('sin(y)'), _tpmsTpmsF('cos(z)')),
      _tpmsTerm(1, _tpmsTpmsF('sin(y)'), _tpmsTpmsF('sin(z)'), _tpmsTpmsF('cos(x)')),
      _tpmsTerm(1, _tpmsTpmsF('sin(z)'), _tpmsTpmsF('sin(x)'), _tpmsTpmsF('cos(y)'))
    ]
  },
  frd: {
    label: 'F-RD',
    constant: 0.3,
    terms: [
      _tpmsTerm(1,  _tpmsTpmsF('sin(x)', 2, 1, 1), _tpmsTpmsF('cos(y)'), _tpmsTpmsF('sin(z)')),
      _tpmsTerm(1,  _tpmsTpmsF('sin(x)'), _tpmsTpmsF('sin(y)', 1, 2, 1), _tpmsTpmsF('cos(z)')),
      _tpmsTerm(1,  _tpmsTpmsF('cos(x)'), _tpmsTpmsF('sin(y)'), _tpmsTpmsF('sin(z)', 1, 1, 2)),
      _tpmsTerm(-1, _tpmsTpmsF('cos(x)', 2, 1, 1), _tpmsTpmsF('cos(y)', 1, 2, 1)),
      _tpmsTerm(-1, _tpmsTpmsF('cos(y)', 1, 2, 1), _tpmsTpmsF('cos(z)', 1, 1, 2)),
      _tpmsTerm(-1, _tpmsTpmsF('cos(z)', 1, 1, 2), _tpmsTpmsF('cos(x)', 2, 1, 1))
    ]
  },
  gyroidHarmonic: {
    label: 'gyroid-harmonic',
    constant: 0,
    terms: [
      _tpmsTerm(1,   _tpmsTpmsF('sin(x)'), _tpmsTpmsF('cos(y)')),
      _tpmsTerm(1,   _tpmsTpmsF('sin(y)'), _tpmsTpmsF('cos(z)')),
      _tpmsTerm(1,   _tpmsTpmsF('sin(z)'), _tpmsTpmsF('cos(x)')),
      _tpmsTerm(0.3, _tpmsTpmsF('sin(x)', 2, 1, 1), _tpmsTpmsF('cos(y)', 1, 2, 1)),
      _tpmsTerm(0.3, _tpmsTpmsF('sin(y)', 1, 2, 1), _tpmsTpmsF('cos(z)', 1, 1, 2)),
      _tpmsTerm(0.3, _tpmsTpmsF('sin(z)', 1, 1, 2), _tpmsTpmsF('cos(x)', 2, 1, 1))
    ]
  },
  primitiveC: {
    label: 'primitive-C (G6)',
    constant: 0,
    terms: [
      _tpmsTerm(2,  _tpmsTpmsF('cos(x)')),
      _tpmsTerm(2,  _tpmsTpmsF('cos(y)')),
      _tpmsTerm(2,  _tpmsTpmsF('cos(z)')),
      _tpmsTerm(-1, _tpmsTpmsF('cos(x)', 2, 1, 1)),
      _tpmsTerm(-1, _tpmsTpmsF('cos(y)', 1, 2, 1)),
      _tpmsTerm(-1, _tpmsTpmsF('cos(z)', 1, 1, 2))
    ]
  },
  octo: {
    label: 'octo (G8)',
    constant: 0,
    terms: [
      _tpmsTerm(1,    _tpmsTpmsF('cos(x)')),
      _tpmsTerm(1,    _tpmsTpmsF('cos(y)')),
      _tpmsTerm(1,    _tpmsTpmsF('cos(z)')),
      _tpmsTerm(-0.5, _tpmsTpmsF('cos(x)', 2, 1, 1), _tpmsTpmsF('cos(y)', 1, 2, 1)),
      _tpmsTerm(-0.5, _tpmsTpmsF('cos(y)', 1, 2, 1), _tpmsTpmsF('cos(z)', 1, 1, 2)),
      _tpmsTerm(-0.5, _tpmsTpmsF('cos(z)', 1, 1, 2), _tpmsTpmsF('cos(x)', 2, 1, 1))
    ]
  },
  pHarmonic: {
    label: 'P-harmonic',
    constant: 0,
    terms: [
      _tpmsTerm(1,    _tpmsTpmsF('cos(x)')),
      _tpmsTerm(1,    _tpmsTpmsF('cos(y)')),
      _tpmsTerm(1,    _tpmsTpmsF('cos(z)')),
      _tpmsTerm(0.25, _tpmsTpmsF('cos(x)', 2, 1, 1)),
      _tpmsTerm(0.25, _tpmsTpmsF('cos(y)', 1, 2, 1)),
      _tpmsTerm(0.25, _tpmsTpmsF('cos(z)', 1, 1, 2))
    ]
  },
  lidinoid: {
    label: 'lidinoid',
    constant: 0,
    terms: [
      _tpmsTerm(1.1,  _tpmsTpmsF('sin(x)', 2, 1, 1), _tpmsTpmsF('cos(y)'), _tpmsTpmsF('sin(z)')),
      _tpmsTerm(1.1,  _tpmsTpmsF('sin(x)'), _tpmsTpmsF('sin(y)', 1, 2, 1), _tpmsTpmsF('cos(z)')),
      _tpmsTerm(1.1,  _tpmsTpmsF('cos(x)'), _tpmsTpmsF('sin(y)'), _tpmsTpmsF('sin(z)', 1, 1, 2)),
      _tpmsTerm(-0.2, _tpmsTpmsF('cos(x)', 2, 1, 1), _tpmsTpmsF('cos(y)', 1, 2, 1)),
      _tpmsTerm(-0.2, _tpmsTpmsF('cos(y)', 1, 2, 1), _tpmsTpmsF('cos(z)', 1, 1, 2)),
      _tpmsTerm(-0.2, _tpmsTpmsF('cos(z)', 1, 1, 2), _tpmsTpmsF('cos(x)', 2, 1, 1)),
      _tpmsTerm(-0.4, _tpmsTpmsF('cos(x)', 2, 1, 1)),
      _tpmsTerm(-0.4, _tpmsTpmsF('cos(y)', 1, 2, 1)),
      _tpmsTerm(-0.4, _tpmsTpmsF('cos(z)', 1, 1, 2))
    ]
  }
};

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
      if (typeof reconcileDesignSlots === 'function') reconcileDesignSlots();
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
      if (typeof reconcileDesignSlots === 'function') reconcileDesignSlots();
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

   Two outputs share the design:
     - The grid metadata (label/title/source/family/topology/etc.)
       used by the design-card header and SVG-mock fallback.
     - A `recipe` field — the full lab recipe shape that the
       raymarcher and CPU solvers consume directly.  This is set
       when the JSON is recognized as a valid lab recipe shape;
       otherwise it's null and the card falls back to SVG mock.

   Supports two input dialects:

     A) LAB-INTERNAL shape (15-demo-recipes.js):
        - Top-level `family` key
        - camelCase geometry: cellSizeMm, wallThickness, pipeR, phaseShift
        - Family-prefixed modes: 'noise-sheet', 'grain-half', etc.
        - Material as `material: { Es_MPa, nu, ks_WmK, muFluid_PaS }`

     B) EXTERNAL F13LD tools (TPMS/Noise/Grain export):
        - No top-level `family` (inferred from meta.tool, surface.type, field presence)
        - snake_case geometry: cell_scale, wall_thickness, pipe_radius, phase_shift
        - Bare mode strings: 'half', 'sheet' (need family prefix added)
        - Material absent (uses `homogenization.E_solid_GPa, poisson` instead)
        - Noise has its surface in a `surface` block with type='noise'
        - TPMS surface.type can be 'terms' (full) or 'raw_preset' (preset name only)
   ---------------------------------------------------------- */
function normalizeDesignJson(json, filename){
  /* Slot/letter/color are assigned by reconcileDesignSlots() AFTER insertion
     (slot-stable identity); here we only stamp a placeholder + unassigned slot. */

  /* ── 1. Family inference ─────────────────────────────────── */
  var family = json.family || json.tool || null;
  if (!family){
    if (json.meta && json.meta.tool === 'grain') family = 'grain';
    else if (json.meta && json.meta.tool === 'noise-scaffold-explorer') family = 'noise';
    else if (json.field && typeof json.field === 'object') family = 'grain';
    else if (json.surface && json.surface.type === 'noise') family = 'noise';
    else if (json.surface && (json.surface.type === 'terms' || json.surface.type === 'raw_preset')) family = 'tpms';
    else family = 'unknown';
  }

  /* ── 2. Variant (short string label, never an object) ────── */
  var variant = 'custom';
  if (typeof json.variant === 'string') variant = json.variant;
  else if (typeof json.fieldType === 'string') variant = json.fieldType;
  else if (json.field && typeof json.field.type === 'string') variant = json.field.type;
  else if (json.surface && typeof json.surface.type === 'string') variant = json.surface.type;
  else if (json.meta && typeof json.meta.preset === 'string') variant = json.meta.preset;

  /* ── 3. Topology / mode (external uses bare strings) ─────── */
  /* TPMS and Noise put the mode under `geometry.mode`.
     Grain puts it under `geometry.topology` instead.
     Some old recipes also have a top-level `topology` key.
     Probe all three so all three families work. */
  var rawMode = (json.geometry && (json.geometry.mode || json.geometry.topology)) ||
                json.topology || null;
  /* Add family prefix where lab requires it.  TPMS modes (solid/shell/pi-tpms)
     don't take a prefix; Noise/Grain bare 'half'/'sheet'/'solid' need one. */
  var topology = rawMode || 'sheet';
  var labMode = rawMode;
  if (rawMode && (family === 'noise' || family === 'grain')){
    if (rawMode === 'half')  labMode = family + '-half';
    else if (rawMode === 'sheet') labMode = family + '-sheet';
    else if (rawMode === 'solid') labMode = family + '-solid';
    /* else: rawMode is already prefixed or is something else (e.g. 'shell' for noise) */
  }

  /* ── 4. Cell size — external uses dimensionless cell_scale, lab uses cellSizeMm.
        For visualization the kernel works in [-π, π] regardless, so cell size only
        matters for permeability calc.  Use cellSizeMm if given (lab dialect),
        otherwise default to 5 mm.  cell_scale from external recipes is preserved
        in the geometry block but not consumed by lab solvers. */
  var cellSizeMm = (json.geometry && (json.geometry.cellSizeMm || json.geometry.cell_size_mm)) || 5.0;

  var rho = json.rho_rel || json.density || json.relative_density ||
            (json.homogenization && json.homogenization.volume_fraction != null
              ? json.homogenization.volume_fraction / 100  /* external uses percentage */
              : 0.40);

  /* ── 5. Title derivation ─────────────────────────────────── */
  var presetLabel = (json.meta && json.meta.preset) || (json.surface && json.surface.label);
  var title = json.title || json.name;
  if (!title){
    if (presetLabel){
      title = presetLabel;
      if (family === 'tpms' && rawMode) title += ' · ' + rawMode;
    } else if (family === 'tpms') {
      title = (json.tpms_type || 'TPMS') + (rawMode ? ' · ' + rawMode : '');
    } else if (variant === 'spinodoid') {
      title = 'Spinodoid · VMF';
    } else if (variant === 'reaction_diffusion' || variant === 'reactiondiffusion') {
      title = 'Trabecular · GS';
    } else if (typeof variant === 'string' && variant !== 'custom'){
      title = variant.charAt(0).toUpperCase() + variant.slice(1);
    } else {
      title = 'Custom design';
    }
  }

  /* ── 6. Build a renderable lab recipe ─────────────────────── */
  var recipe = null;
  var recipeNote = '';
  var DEFAULT_MATERIAL = (typeof MATERIAL_TI64_BONE !== 'undefined') ? MATERIAL_TI64_BONE
    : { Es_MPa: 110000, nu: 0.34, ks_WmK: 6.7, muFluid_PaS: 0.001 };

  /* Translate external geometry → lab geometry */
  function buildLabGeometry(extG, defaultMode){
    extG = extG || {};
    var labG = {
      mode:       labMode || defaultMode,
      cellSizeMm: cellSizeMm,
      cellMult:   1.0
    };
    /* offset (TPMS, noise iso threshold).  null means lab uses 0. */
    if (extG.offset != null) labG.offset = extG.offset;
    /* Wall thickness — snake_case → camelCase */
    var wt = extG.wall_thickness != null ? extG.wall_thickness : extG.wallThickness;
    if (wt != null) labG.wallThickness = wt;
    /* Pipe radius — snake_case → camelCase */
    var pr = extG.pipe_radius != null ? extG.pipe_radius : extG.pipeR;
    if (pr != null) labG.pipeR = pr;
    /* Phase shift — snake_case → camelCase */
    var ps = extG.phase_shift != null ? extG.phase_shift : extG.phaseShift;
    if (ps != null) labG.phaseShift = ps;
    /* half_invert — already matches */
    if (extG.half_invert != null) labG.half_invert = extG.half_invert;
    /* center / half_width — used by NoiseKernel.parseRecipe via surface block,
       but Grain reads from geometry.  Pass through verbatim. */
    if (extG.center != null) labG.center = extG.center;
    if (extG.half_width != null) labG.half_width = extG.half_width;
    if (extG.smoothing != null) labG.smoothing = extG.smoothing;
    return labG;
  }

  if (typeof KERNELS !== 'undefined' && KERNELS[family]){
    if (family === 'tpms'){
      if (json.surface && json.surface.type === 'terms' && Array.isArray(json.surface.terms)){
        recipe = {
          family: 'tpms',
          name: title,
          surface: json.surface,
          geometry: buildLabGeometry(json.geometry, 'solid'),
          material: json.material || DEFAULT_MATERIAL
        };
        recipeNote = 'TPMS recipe (terms surface) accepted';
      } else if (json.surface && json.surface.type === 'raw_preset'){
        /* Expand named preset to lab terms via the embedded preset table.
           Most presets have a built-in additive constant (e.g. split-P's −0.3)
           which shifts the iso level — we extract that into geometry.offset
           because lab's "solid where F < offset" convention places constants
           there rather than in the surface. */
        var presetKey = json.surface.preset;
        var preset = TPMS_RAW_PRESET_TABLE[presetKey];
        if (preset){
          var baseGeom = buildLabGeometry(json.geometry, 'solid');
          /* Shift offset by -constant so that (F_terms < offset_lab) matches
             (F_terms + constant < offset_external).  Lab's resolved offset
             default is 0, external recipes typically have offset=0 too. */
          baseGeom.offset = (baseGeom.offset != null ? baseGeom.offset : 0) - preset.constant;
          recipe = {
            family: 'tpms',
            name: title,
            surface: {
              type: 'terms',
              preset: presetKey,
              terms: preset.terms
            },
            geometry: baseGeom,
            material: json.material || DEFAULT_MATERIAL
          };
          recipeNote = 'TPMS preset "' + (preset.label || presetKey) + '" expanded to terms';
        } else {
          recipeNote = 'TPMS preset "' + (json.surface.label || presetKey) +
                       '" not in expansion table — falling back to SVG mock';
        }
      } else {
        recipeNote = 'TPMS recipe missing surface.terms — falling back to SVG mock';
      }
    } else if (family === 'noise'){
      /* Lab NoiseKernel.parseRecipe expects the surface block (with type='noise')
         and reads geometry.half_invert.  External recipes match this shape, just
         need our remapped geometry. */
      if (json.surface && json.surface.type === 'noise'){
        recipe = {
          family: 'noise',
          name: title,
          surface: json.surface,
          geometry: buildLabGeometry(json.geometry, 'noise-sheet'),
          material: json.material || DEFAULT_MATERIAL
        };
        recipeNote = 'Noise recipe accepted';
      } else {
        recipeNote = 'Noise recipe missing surface block (type="noise") — falling back to SVG mock';
      }
    } else if (family === 'grain'){
      /* Lab GrainKernel.parseRecipe reads from field block; external matches. */
      if (json.field && typeof json.field === 'object'){
        recipe = {
          family: 'grain',
          name: title,
          field: json.field,
          geometry: buildLabGeometry(json.geometry, 'grain-sheet'),
          material: json.material || DEFAULT_MATERIAL
        };
        recipeNote = 'Grain recipe accepted';
      } else {
        recipeNote = 'Grain recipe missing field block — falling back to SVG mock';
      }
    }
  } else if (family === 'unknown'){
    recipeNote = 'family could not be inferred from JSON — falling back to SVG mock';
  } else {
    recipeNote = 'family "' + family + '" not in KERNELS — falling back to SVG mock';
  }
  console.log('[add-design] ' + filename + ': ' + recipeNote);

  /* ── 7. Pack the design entry ────────────────────────────── */
  var id = json.id || ('user-' + Date.now().toString(36));
  return {
    id: id,
    label: 'DESIGN · ?',
    slot: -1,
    title: title,
    source: 'imported · ' + filename,
    family: (family === 'unknown' ? 'tpms' : family),   /* fallback for SVG */
    variant: variant,
    topology: topology,
    rho_rel: rho,
    cell_mm: cellSizeMm,
    mat_es_gpa: json.mat_es_gpa || json.E_s ||
                (json.homogenization && json.homogenization.E_solid_GPa) || 110,
    mat_nu: json.mat_nu || json.nu ||
            (json.homogenization && json.homogenization.poisson) || 0.30,
    color: '#aaa',
    results: null,
    raw_json: json,
    recipe: recipe
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
    if (typeof reconcileDesignSlots === 'function') reconcileDesignSlots();
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
