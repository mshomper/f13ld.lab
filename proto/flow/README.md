# Fluids Phase 0 checks

Float64 lattice Boltzmann reference (`19f-flow-cpu-ref.js`) against exact and published answers, on geometry built through `14e-link-field.js` `buildFlowLinksFromFn`. Results and what they settle: `docs/FLUIDS_LBM_SCOPE.md` §12.

    node proto/flow/run_checks.js            # all (about 15 min on 2 cores; F6 and F7 are the long ones)
    node proto/flow/run_checks.js F1 F2 F3   # a subset

- `harness.js` loads 14e and 19f into node and builds links from an analytic margin in lattice coordinates, for boxes of any NX × NY × NZ (thin boxes keep the 1-D and 2-D checks fast).
- `results-F*.jsonl` hold the rows of the last run.
- The GPU benchmark and GPU-vs-CPU check live in `proto/lbm-bench/index.html` (open it from the branch link; GPU timing is run on Matt's machine).
