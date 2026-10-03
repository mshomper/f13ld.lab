# F13LD.foam stiffness fit

Generated 2026-10-03 13:56 from `foam_calibration_runs_results_20261003.csv`, `foam_plateau_runs_results.csv` (67 runs).

- **Open (and plateau):** E/Es = 0.724 ρ^1.930 over ρ 8 %–35 % (rms 3.3 %); ν = 0.433 − 0.468 ρ
- **Closed:** E/Es = 0.304 ρ + 0.456 ρ² over ρ 12 %–35 % (rms 0.9 %); ν ≈ 0.294
- **Shear:** G = E / 2(1 + ν)
- **Resolution:** open p = 2.11, closed p = 2.01 (64³ → 128³ error ∝ width^−p)
- **Poisson ÷ Lloyd seeds:** open 0.956, closed 0.985
- **Stretch:** Ez/Exy = s^2.49 open, s^1.63 closed
- **Plateau ÷ open at equal ρ (128³):** P-c27-5-k0.1 1.06, P-c27-5-k0.2 1.08, P-c27-5-k0.3 1.1, P-c50-5-k0.05 1.05, P-c50-5-k0.1 1.08, P-c50-5-k0.2 1.1, P-c50-8-k0.05 1.04, P-c50-8-k0.1 1.07, P-c50-8-k0.2 1.1, P-c50-8-k0.3 1.12, P-c50-5-k0.2-r2 1.12, P-c50-8-k0.2-r2 1.1
- **Cell count (open 12 %, E ÷ law):** 16 cells 0.963, 27 cells 1, 50 cells 1.07

| run | topology | seeds | cells | ρ % | E/Es | source | ÷ law | ν |
|---|---|---|---|---|---|---|---|---|
| A-closed-12-r1 | closed | lloyd | 16 | 12.00 | 0.0436 | 128 + model | 1.01 | 0.299 |
| A-closed-12-r2 | closed | lloyd | 16 | 12.00 | 0.043 | 128 + model | 0.998 | 0.303 |
| A-closed-18-r1 | closed | lloyd | 16 | 18.00 | 0.0701 | 128 + model | 1.01 | 0.314 |
| A-closed-18-r2 | closed | lloyd | 16 | 18.00 | 0.0689 | 128 + model | 0.991 | 0.315 |
| A-closed-25-r1 | closed | lloyd | 16 | 25.00 | 0.105 | ext (64↔128) | 1.01 | 0.296 |
| A-closed-25-r2 | closed | lloyd | 16 | 25.00 | 0.103 | ext (64↔128) | 0.988 | 0.3 |
| A-closed-35-r1 | closed | lloyd | 16 | 35.00 | 0.164 | ext (64↔128) | 1.01 | 0.288 |
| A-closed-35-r2 | closed | lloyd | 16 | 35.00 | 0.161 | ext (64↔128) | 0.993 | 0.292 |
| A-open-12-r1 | open | lloyd | 27 | 12.00 | 0.0126 | ext (64↔128) | 1.04 | 0.363 |
| A-open-12-r2 | open | lloyd | 27 | 12.00 | 0.0116 | ext (64↔128) | 0.96 | 0.386 |
| A-open-18-r1 | open | lloyd | 27 | 17.99 | 0.0273 | ext (64↔128) | 1.03 | 0.331 |
| A-open-18-r2 | open | lloyd | 27 | 17.99 | 0.0256 | ext (64↔128) | 0.967 | 0.348 |
| A-open-25-r1 | open | lloyd | 27 | 24.99 | 0.051 | ext (64↔128) | 1.02 | 0.302 |
| A-open-25-r2 | open | lloyd | 27 | 24.98 | 0.0484 | ext (64↔128) | 0.972 | 0.315 |
| A-open-35-r1 | open | lloyd | 27 | 34.99 | 0.0973 | ext (64↔128) | 1.02 | 0.274 |
| A-open-35-r2 | open | lloyd | 27 | 34.98 | 0.0939 | ext (64↔128) | 0.985 | 0.282 |
| A-open-8-r1 | open | lloyd | 27 | 8.00 | 5.8e-3 | ext (64↔128) | 1.04 | 0.393 |
| A-open-8-r2 | open | lloyd | 27 | 8.00 | 5.3e-3 | ext (64↔128) | 0.961 | 0.419 |
| A-plateau-12-r1 | plateau k 0.05 | lloyd | 27 | 12.00 | 0.0126 | ext (64↔128) | 1.04 | 0.363 |
| A-plateau-12-r2 | plateau k 0.05 | lloyd | 27 | 12.00 | 0.0116 | ext (64↔128) | 0.96 | 0.386 |
| A-plateau-18-r1 | plateau k 0.05 | lloyd | 27 | 17.99 | 0.0273 | ext (64↔128) | 1.03 | 0.331 |
| A-plateau-18-r2 | plateau k 0.05 | lloyd | 27 | 17.99 | 0.0256 | ext (64↔128) | 0.967 | 0.348 |
| A-plateau-25-r1 | plateau k 0.05 | lloyd | 27 | 24.99 | 0.051 | ext (64↔128) | 1.02 | 0.302 |
| A-plateau-25-r2 | plateau k 0.05 | lloyd | 27 | 24.98 | 0.0484 | ext (64↔128) | 0.972 | 0.315 |
| A-plateau-35-r1 | plateau k 0.05 | lloyd | 27 | 34.99 | 0.0973 | ext (64↔128) | 1.02 | 0.274 |
| A-plateau-35-r2 | plateau k 0.05 | lloyd | 27 | 34.98 | 0.0939 | ext (64↔128) | 0.985 | 0.282 |
| A-plateau-8-r1 | plateau k 0.05 | lloyd | 27 | 8.00 | 5.8e-3 | ext (64↔128) | 1.05 | 0.392 |
| A-plateau-8-r2 | plateau k 0.05 | lloyd | 27 | 8.00 | 5.4e-3 | ext (64↔128) | 0.97 | 0.419 |
| B-closed-18 | closed | poisson | 16 | 18.00 | 0.0689 | 128 + model | 0.992 | 0.308 |
| B-closed-35 | closed | poisson | 16 | 35.00 | 0.159 | ext (64↔128) | 0.979 | 0.282 |
| B-open-18 | open | poisson | 27 | 17.97 | 0.0253 | ext (64↔128) | 0.959 | 0.329 |
| B-open-35 | open | poisson | 27 | 34.96 | 0.0902 | ext (64↔128) | 0.947 | 0.273 |
| B-open-8 | open | poisson | 27 | 7.99 | 5.3e-3 | ext (64↔128) | 0.96 | 0.389 |
| B-plateau-18 | plateau k 0.05 | poisson | 27 | 17.97 | 0.0253 | ext (64↔128) | 0.959 | 0.329 |
| C-K-closed-12 | closed | kelvin | 16 | 13.48 | 0.0431 | not calibrated | 0.875 | 0.337 |
| C-K-closed-25 | closed | kelvin | 16 | 25.10 | 0.123 | not calibrated | 1.17 | 0.313 |
| C-K-open-12 | open | kelvin | 16 | 12.01 | 0.0317 | not calibrated | 2.62 | 0.324 |
| C-K-open-25 | open | kelvin | 16 | 25.05 | 0.0787 | not calibrated | 1.57 | 0.26 |
| C-WP-closed-12 | closed | weairePhelan | 8 | 12.40 | 0.0387 | not calibrated | 0.866 | 0.302 |
| C-WP-closed-25 | closed | weairePhelan | 8 | 24.82 | 0.0992 | not calibrated | 0.959 | 0.298 |
| C-WP-open-12 | open | weairePhelan | 8 | 12.01 | 0.0185 | not calibrated | 1.53 | 0.354 |
| C-WP-open-25 | open | weairePhelan | 8 | 25.01 | 0.0643 | not calibrated | 1.29 | 0.279 |
| D-closed-sz1.25 | closed | lloyd | 16 | 18.00 | 0.0691 | 128 + model | 0.995 | 0.28 |
| D-closed-sz1.5 | closed | lloyd | 16 | 18.00 | 0.0687 | 128 + model | 0.989 | 0.268 |
| D-closed-sz2 | closed | lloyd | 16 | 18.00 | 0.0688 | 128 + model | 0.99 | 0.26 |
| D-open-sz1.25 | open | lloyd | 27 | 17.99 | 0.0261 | ext (64↔128) | 0.987 | 0.291 |
| D-open-sz1.5 | open | lloyd | 27 | 17.98 | 0.0255 | ext (64↔128) | 0.966 | 0.264 |
| D-open-sz2 | open | lloyd | 27 | 17.92 | 0.0276 | ext (64↔128) | 1.05 | 0.237 |
| N-c16-open-12 | open | lloyd | 16 | 12.01 | 0.0117 | ext (64↔128) | 0.963 | 0.376 |
| N-c50-open-12 | open | lloyd | 50 | 11.97 | 0.0129 | ext (64↔128) | 1.07 | 0.365 |
| P-c27-5-k0.1 | plateau k 0.1 | lloyd | 27 | 5.02 | 2.5e-3 | 128 + model | 1.1 | 0.416 |
| P-c27-5-k0.2 | plateau k 0.2 | lloyd | 27 | 5.02 | 2.6e-3 | 128 + model | 1.14 | 0.415 |
| P-c27-5-k0.3 | plateau k 0.3 | lloyd | 27 | 5.01 | 2.7e-3 | 128 + model | 1.19 | 0.414 |
| P-c27-5-open | open | lloyd | 27 | 5.02 | 2.3e-3 | 128 + model | 1.02 | 0.418 |
| P-c50-5-k0.05 | plateau k 0.05 | lloyd | 50 | 4.97 | 2.6e-3 | 128 + model | 1.16 | 0.429 |
| P-c50-5-k0.1 | plateau k 0.1 | lloyd | 50 | 4.98 | 2.9e-3 | 128 + model | 1.3 | 0.428 |
| P-c50-5-k0.2 | plateau k 0.2 | lloyd | 50 | 4.97 | 4.4e-3 | 128 + model | 1.98 | 0.426 |
| P-c50-5-k0.2-r2 | plateau k 0.2 | lloyd | 50 | 5.00 | 3.7e-3 | 128 + model | 1.65 | 0.471 |
| P-c50-5-open | open | lloyd | 50 | 4.97 | 2.3e-3 | 128 + model | 1.05 | 0.431 |
| P-c50-5-open-r2 | open | lloyd | 50 | 5.00 | 2.0e-3 | 128 + model | 0.878 | 0.479 |
| P-c50-8-k0.05 | plateau k 0.05 | lloyd | 50 | 8.05 | 6.2e-3 | 128 + model | 1.11 | 0.397 |
| P-c50-8-k0.1 | plateau k 0.1 | lloyd | 50 | 8.08 | 6.5e-3 | 128 + model | 1.15 | 0.396 |
| P-c50-8-k0.2 | plateau k 0.2 | lloyd | 50 | 8.07 | 6.7e-3 | 128 + model | 1.19 | 0.395 |
| P-c50-8-k0.2-r2 | plateau k 0.2 | lloyd | 50 | 7.99 | 5.7e-3 | 128 + model | 1.04 | 0.438 |
| P-c50-8-k0.3 | plateau k 0.3 | lloyd | 50 | 8.05 | 6.9e-3 | 128 + model | 1.23 | 0.394 |
| P-c50-8-open | open | lloyd | 50 | 8.03 | 6.0e-3 | 128 + model | 1.07 | 0.4 |
| P-c50-8-open-r2 | open | lloyd | 50 | 7.96 | 5.1e-3 | 128 + model | 0.931 | 0.443 |
