/* ============================================================
   F13LD.lab · 13c-import-kernel.js
   'import' family — a user unit cell imported from STL.

   The STL is turned (by 14c-stl-import.js) into a periodic signed-
   distance grid once, at import.  This kernel samples that grid, so
   buildVoxels, every solver, connectivity and the viewer run on an
   imported cell exactly as on a native recipe.

   Sign convention (matches the lab's solid mode, "solid where the
   field is below the offset"): the stored value is the signed
   distance to the surface, NEGATIVE INSIDE the solid, in field units
   (one cell = 2π).  So geometry.offset is the wall offset: +0.1 grows
   every wall by 0.1 field units on each side.

   The grid never rides inside the recipe — the recipe carries only
   recipe.import.hash.  The grid lives in IMPORT_GRIDS (this page or
   worker), filled from IndexedDB on load, from the importer, or from
   the job message for buckling workers.

   Storage form (single source of truth, so a session import and a
   reload give bit-identical voxels):
     n     : grid side (128)
     R     : clamp range, field units (|d| > R stored as ±R)
     bytes : Uint8Array(n³), index i*n² + j*n + k, i = x (slowest)
             d = (q − 127.5) / 127.5 · R
   Worker-safe: no DOM access.
   ============================================================ */

var IMPORT_GRIDS = {};   /* hash → { hash, n, R, bytes, data:Float32Array } */

/* Decode and register a stored grid.  Idempotent per hash. */
function registerImportGrid(rec) {
  if (!rec || !rec.hash || !rec.bytes) throw new Error('registerImportGrid: missing hash or bytes');
  var have = IMPORT_GRIDS[rec.hash];
  if (have) return have;
  var n = rec.n | 0, R = +rec.R, bytes = rec.bytes;
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length !== n * n * n) throw new Error('registerImportGrid: expected ' + (n * n * n) + ' bytes, got ' + bytes.length);
  var data = new Float32Array(bytes.length), s = R / 127.5;
  for (var i = 0; i < bytes.length; i++) data[i] = (bytes[i] - 127.5) * s;
  var g = { hash: rec.hash, n: n, R: R, bytes: bytes, data: data };
  IMPORT_GRIDS[rec.hash] = g;
  return g;
}

function importGridReady(recipe) {
  return !!(recipe && recipe.import && IMPORT_GRIDS[recipe.import.hash]);
}

/* What a worker needs to rebuild voxels for an import recipe (structured-
   clone copy; the page keeps its own). */
function importGridMessage(recipe) {
  if (!recipe || recipe.family !== 'import' || !recipe.import) return null;
  var g = IMPORT_GRIDS[recipe.import.hash];
  return g ? { hash: g.hash, n: g.n, R: g.R, bytes: g.bytes } : null;
}

/* Periodic trilinear sample of a grid at solver coords in [-π, π]³.
   Sample positions are voxel centers, matching buildVoxels. */
function sampleImportGrid(data, n, x, y, z) {
  var s = n / (2 * Math.PI);
  var u = (x + Math.PI) * s - 0.5, v = (y + Math.PI) * s - 0.5, w = (z + Math.PI) * s - 0.5;
  var i0 = Math.floor(u), j0 = Math.floor(v), k0 = Math.floor(w);
  var fu = u - i0, fv = v - j0, fw = w - k0;
  i0 = ((i0 % n) + n) % n; j0 = ((j0 % n) + n) % n; k0 = ((k0 % n) + n) % n;
  var i1 = (i0 + 1) % n, j1 = (j0 + 1) % n, k1 = (k0 + 1) % n;
  var nn = n * n;
  var a0 = i0 * nn, a1 = i1 * nn, b0 = j0 * n, b1 = j1 * n;
  var c000 = data[a0 + b0 + k0], c001 = data[a0 + b0 + k1];
  var c010 = data[a0 + b1 + k0], c011 = data[a0 + b1 + k1];
  var c100 = data[a1 + b0 + k0], c101 = data[a1 + b0 + k1];
  var c110 = data[a1 + b1 + k0], c111 = data[a1 + b1 + k1];
  var c00 = c000 + (c001 - c000) * fw, c01 = c010 + (c011 - c010) * fw;
  var c10 = c100 + (c101 - c100) * fw, c11 = c110 + (c111 - c110) * fw;
  var c0 = c00 + (c01 - c00) * fv, c1 = c10 + (c11 - c10) * fv;
  return c0 + (c1 - c0) * fu;
}

var ImportKernel = {
  family: 'import',

  parseRecipe: function (recipe) {
    var imp = recipe && recipe.import;
    if (!imp || !imp.hash) throw new Error('ImportKernel: recipe has no import.hash');
    var g = IMPORT_GRIDS[imp.hash];
    if (!g) throw new Error('Imported geometry "' + (imp.name || imp.hash) +
                            '" is not loaded — re-import the STL or its saved JSON');
    return { data: g.data, n: g.n };
  },

  evaluate: function (params, x, y, z) {
    return sampleImportGrid(params.data, params.n, x, y, z);
  }
};

if (typeof KERNELS !== 'undefined') KERNELS['import'] = ImportKernel;

/* node/test harness export (browser ignores this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IMPORT_GRIDS: IMPORT_GRIDS, registerImportGrid: registerImportGrid,
    importGridReady: importGridReady, importGridMessage: importGridMessage,
    sampleImportGrid: sampleImportGrid, ImportKernel: ImportKernel
  };
}
