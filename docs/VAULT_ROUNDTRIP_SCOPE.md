# F13LD.lab ↔ F13LD.vault round trip — scope

**Status:** scoped 2026-10-10 (end of the F13LD.sweep Wave session); not started. Matt will start it in a fresh session. Propose the plan and get his answers to the open questions below before building.

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
