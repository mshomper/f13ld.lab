# F13LD.lab ↔ F13LD.vault round trip — scope

**Status:** scoped 2026-10-10 (end of the F13LD.sweep Wave session); questions answered the same evening (see the update below) — Lab's part (Phase 4) not started. Matt will start it in a fresh session. Propose the plan and get his answers to the open questions below before building.

## Update 2026-10-10 (evening) — answered, and what now exists

Matt answered the open questions in the direct-push session (F13LD.ingest `docs/SESSION_RECAP_2026-10-10.md`, plan `docs/F13LD_VAULT_PUSH_PLAN.md`). **Phases 1–3 are done; this repo's part is Phase 4.**

**Answers**
- A Lab solve **attaches to the Vault design** as a verified result (newest solve shown by default) — stored in a side table, not by editing the Vault row.
- Push is a **button** (per design, plus push-all), through the shared push window.
- **Elastic, thermal, buckling and crush** (yield and its metrics) all go to Vault when run.
- Lab **can push designs that are not in Vault**: Lab runs **Sweep's own pipeline** on each such design so its Vault row is complete — load F13LD.sweep's `estimateHomogenization(recipe, opts)` (`54-estimate.js` and what it needs) from Sweep's site in a worker, Fast settings; Sweep's version goes in provenance. If Sweep's site can't be reached, solving still works and only the push waits.
- **Stretched cells are held back** until Lab solves them (listed in the push window as held back).
- Provenance marks Lab pushes (`provenance_kind = 'lab'` on new design rows; `source_tool = 'f13ld.lab'` on solves).
- The CC0 tick is required at least once per browser session (the push window handles it).
- Browse-from-Vault picker in Lab: not decided — later.

**What exists now**
- Database: table `f13ld_lab_results` — one row per solve, insert-only, `content_hash` → `f13ld_designs` (on delete cascade; the design row must exist first), `solve_hash` unique, `created_at` set by the database. Columns: settings (`grid_n`, `partial_volume`, `void_ratio`, `cg_tol`, `converged`, `cube_solved`), material (`material` jsonb, `material_key`, `e_solid_gpa`, `sigma_y_solid_mpa`, `cell_size_mm`), elastic (`ex/ey/ez_norm`, `gyz/gxz/gxy_norm`, `nu_xy/xz/yz`, `c_tensor` jsonb — stiffness divided by the solid modulus), buckling (`lambda_cr`, `buckling_axis`, `buckling_per_axis` jsonb, `pcr_py`), crush (`sigma_y_x/y/z_mpa`, `sigma_peak_mpa`, `crush_e0_norm`, `failure_mode`, `yield_is_bound`), thermal (`thermal` jsonb per filler, `k_rel_water`), geometry (`porosity`, `surface_area_density_m2m3`, `hydraulic_diameter_mm`, `open_axes`), provenance, `results_extended` jsonb for anything else. SQL: F13LD.ingest `docs/sql/2026-10-10_2_migration.sql`.
- Shared push file: `https://mshomper.github.io/f13ld.ingest/f13ld-vault-push.js` → `window.F13LDVault`. For Lab: build a **Sweep-shape export** (`{ meta, context, designs: [{ id, browser, design }] }`, with `browser` from Sweep's pipeline) plus `labResults: [{ designIndex, result: { lab_version, grid_n, ex_norm, … } }]`, then `F13LDVault.openPushDialog({ json, source: 'F13LD.lab vX', provenanceKind: 'lab', labResults, heldBack: [{ label, reason }], accent: '#E06A6F' })`. It validates, inserts design rows first (designs already in Vault are skipped), then the solves tied to their hash; unknown result fields go to `results_extended`; `solve_hash` is computed. Dry run: `dryRun: true`. Demo: `push-demo.html` in F13LD.ingest ("As F13LD.lab").
- Window classes use the prefix `f13vp-` (`.f13v` is the shared F13LD-VIEW block — don't reuse it).

**Phase 4 work in this repo**
1. Vault's *Open in Lab* adds the row hash (`#r=…&v=<hash>`, F13LD.vault `70-handoff.js`); Lab keeps `d.vault_hash` and an untouched copy of Vault's recipe. An edited design is a new design (rehash with `F13LDVault.contentHash` after stripping Lab's own additions such as `cell_size_mm` and the title).
2. For designs without a Vault hash: run Sweep's pipeline (worker) to get the `browser` block.
3. Map Lab results to the columns above (normalise stiffness by the material's E).
4. Push to Vault button per design and for the whole grid; stretched cells → `heldBack`.
5. Tests in the style of F13LD.sweep `tests/vault-push.js` (headless, database mocked).

Phase 5 (F13LD.vault) then reads `f13ld_lab_results` by named columns, shows the newest solve per hash, a Lab-verified chip and colour, and the Sweep vs Lab gap.

## Where things stand
- **Vault → Lab works.** Vault's *Open in Lab* sends the recipe as `#r=<recipe JSON>` (`f13ld.vault/70-handoff.js`). Lab reads it in `ingestUrlParam` → `ingestHandoffJson` (`60-add-design.js`). The handoff adds `cell_size_mm` (and Lab adds a title), so the recipe Lab holds is not byte-identical to the Vault row's.
- **Lab → Vault does not exist.**
  - Lab exports a PDF report, the sweep CSV (`62-sweep.js`) and the imported-cell JSON (`61-import-stl.js`).
  - F13LD.ingest only reads F13LD.sweep's results export (`meta` + `designs[]` with a `browser` metrics block; `validateDesign` requires Sweep v0.13+ fields such as `linear_cap_active`, `stiffness_density_norm`, `H_mean_abs`, `throat_ratio`, `tortuosity_x`).
  - Lab's *Browse the vault* button is a placeholder (`onBrowseVaultClick`, "Phase 10"), and `?r=<vault id>` is stubbed.
- **Row identity.** Ingest keys rows by `content_hash` = SHA-256 of the canonicalized design recipe (`contentHash`, sorted keys). The database is Supabase table `f13ld_designs` with an RLS `WITH CHECK` insert policy (mirrored in Ingest's `policyCheckRow`); whether updates are allowed is not yet checked.
- **Stretched cells.** Lab solves every cell as a cube (v0.26.1 tags them). A Lab result for a stretched TPMS / beam / wave design is not like-for-like with Sweep's stretched solve until Lab has a stretched-cell solver (reference: F13LD.sweep `solver/sweep-gpu-kernels.js`).

## What the round trip needs
1. **Carry the Vault identity into Lab.** Vault's handoff adds the row's `content_hash` (e.g. `#r=…&v=<hash>`); Lab stores it on the design (`d.vault_hash`) and keeps the untouched recipe beside its own copy. Designs added from a file can still be matched by hashing the recipe with Ingest's `canonicalize` + SHA-256.
2. **A Lab results export** — per design:
   - the recipe and the Vault hash
   - Lab version, solver settings (grid N, partial volume, void ratio, CG tolerance / iterations, converged) and material
   - the results: full elastic tensor (E, G, ν per axis), thermal κ (per filler), and where run, buckling (λ_cr) and crush (σ_y, σ_peak, failure mode)
   - a provenance stamp
   
   Either reuse Sweep's export shape (so Ingest needs few changes; the Lab values go under a new block) or a small `f13ld.lab/v1` schema.
3. **Ingest accepts it.** It recognizes the Lab export; for a design whose hash is already in the Vault, it writes the Lab result to that row; otherwise it inserts a new row marked as Lab-solved. It also mirrors any policy change in `policyCheckRow`. **Matt runs the SQL** (new columns or a jsonb `lab_results` field; an update policy, or a separate `f13ld_lab_results` table keyed by hash) in the Supabase dashboard; the session writes the exact statement.
4. **Vault shows it.**
   - a "Lab-verified" filter chip and colour
   - Lab values in the inspector next to Sweep's
   - a **Sweep vs Lab gap** metric: where the fast estimate drifts, by family and grid
   - Compare shows both
5. **Optional: Browse from Vault in Lab.** Replace the Phase 10 stub with a Vault picker (read-only, named columns only, never `contributor_contact` — Vault's privacy rule) or `?r=<hash>` fetch.

## Open questions for Matt
- Should a Lab solve attach to the existing Vault design as a verified result, or be stored as a separate row? Attaching fits "Lab verifies Sweep", but needs updates allowed in the database (or a side table).
- Should Lab push results only when you press a button per design, or after every run?
- Which Lab results belong in the Vault: elastic and thermal only, or buckling and crush too when they were run?
- Is the Browse-from-Vault picker in Lab part of this, or later?
- Should stretched-cell designs be allowed through before Lab solves stretched cells, tagged as cube-solved, or held back?
- Order relative to the Vault re-seed and Bundle (Sweep v0.30.0)? Doing the database change before the re-seed avoids migrating rows twice.

## Repos touched
F13LD.lab (identity, export, optional picker), F13LD.ingest (Lab export, policy mirror), F13LD.vault (handoff hash, display, filter, gap metric), Supabase (SQL run by Matt). F13LD.sweep is unaffected unless the export reuses its shape.
