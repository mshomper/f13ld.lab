# Phase 2 — WebGPU Foundation & WGSL FFT

**Status:** complete · v0.2.0-fft
**Duration:** 3 working days
**Outcome:** Production-quality WebGPU 3D FFT (FP32 complex), validated to FP32 noise floor on real hardware. Foundation for every solver in Phase 3+.

---

## Objective

Stand up the WebGPU compute infrastructure: lazy device init, a 3D FFT plan reusable across solvers, and a self-test that validates round-trip accuracy against analytic references. No physics yet — Phase 2 ships when "the FFT works correctly."

## Architecture decisions

### Library vs custom WGSL FFT

**Decision: write our own.** Rationale:
- WebGPU FFT library landscape (early 2026) is thin. Available community projects are mostly 1D/2D, often unmaintained, not optimized for FP32 real-to-complex 3D at fixed sizes.
- Lab's case is narrow: power-of-two cube sizes (64, 128), FP32, 3D. ~400-600 lines of WGSL is a tractable in-house implementation.
- We need tight integration with the FFT-CG iteration loop, where buffer layouts and submit batching matter for performance. A library API would force contortions.
- Avoids dependency risk on a project that might not be maintained.

### FFT method: Stockham radix-2

Decimation-in-time bit-reversal would force a separate permutation pass. Stockham trades that for a ping-pong buffer pattern (`A → B → A → B …`), which is cleaner on GPU because every stage is a uniform read-write pattern.

Total stages: `3 × log2(N)` (3 axes × log2(N) butterfly stages per axis). For N=64 that's 18 stages; for N=128 it's 21.

### Buffer parity bookkeeping

Stage 0 reads bufA, writes bufB. Stage 1 reads bufB, writes bufA. After K stages the result lives in bufB if K is odd, bufA if K is even.

For N=64: 18 stages → result in bufA.
For N=128: 21 stages → result in bufB.

Tracked via `fwdResultBuf` / `invResultBuf` set during plan construction.

### writeBuffer-multi-dispatch trap (avoided)

WebGPU's queue executes in submit order, but multiple `queue.writeBuffer` calls to the same buffer BEFORE a submit get coalesced — only the last write persists by the time dispatches read it. **Implication:** if you write a uniform once and then dispatch multiple times reading from it, the dispatches all see the SAME (final) value of the uniform, not the per-iteration values you intended.

**Solution in FFTPlan:** pre-bake one uniform buffer per (stage, direction) combination at plan-construction time. For N=64 that's 18 stages × 2 directions = 36 uniform buffers, each 32 bytes — about 1.2 KB total memory cost, in exchange for never having to write a uniform between dispatches.

This is a fundamental WebGPU pattern that we got right here in Phase 2 and got wrong in Phase 3 Push 2's elastic solver — see `PHASE_3.md` "writeBuffer coalescing bug" for the bite. Lesson generalized in Phase 3: any time you'd want to write a uniform and dispatch back-to-back without a submit, either pre-bake the uniform variants or submit between writes.

### FP32 complex layout

`vec2<f32>` per element. Array indexing: `i + N*j + N²*k` with i innermost, k outermost. This convention is held throughout — Phase 3 elastic solver depends on it for tau packing and gamma application.

For N=64: buffer size = 64³ × 8 bytes = **2 MB per complex array**. Lives comfortably in any modern GPU's VRAM.

For N=128: buffer size = 128³ × 8 bytes = **16 MB per complex array**. The high-fidelity tier still fits in 4 GB cards with margin.

### Workgroup size: 64

WebGPU's `maxComputeInvocationsPerWorkgroup` defaults to 256. 64 was chosen for the FFT butterfly because each thread does one butterfly (independent reads of two complex pairs, two complex writes), and the butterfly has no inter-thread communication, so larger workgroups don't help. 256 is used for the reduction kernel (Phase 3) where shared memory matters.

## File inventory at end of phase

Three new:
```
11-webgpu-device.js   — lazy device init, lifecycle handling, error capture
12-fft-plan.js        — WGSL FFT shaders + JS-side FFTPlan class (~350 lines)
70-selftest.js        — 3 validation tests + forward FFT timing
```

Updated:
- `index.html` — adds the 3 script tags + the self-test link in controls
- `lab.css` — adds `.selftest-link` styles (idle/running/pass/fail color states)

## Validation

`runSelfTest()` runs three end-to-end tests at N=64:

1. **Impulse round-trip.** δ at origin → forward → inverse → recover δ. Expected error: bit-perfect (0.00e+0).
2. **Gaussian round-trip.** Smooth Gaussian → forward → inverse → recover. Expected error: at FP32 noise floor (~1e-7 to 1e-6).
3. **Cosine spike.** `cos(2π·i/N)` → forward FFT. Expected: real spike of `N³/2` at flat indices 1 and N-1; zero elsewhere.

Plus forward-FFT timing (8 iterations, averaged after warmup).

### Pass thresholds

- Max error across all 3 tests < `1e-3` (generous; FP32 floor is ~1e-5 at this size).

### Hardware verification (Matt's NVIDIA desktop, Windows)

```
impulse round-trip:  0.00e+0     (bit-perfect)
Gaussian round-trip: 7.15e-7     (at FP32 floor)
cosine spike:        1.96e-7     (at FP32 floor)
forward FFT (avg):   1.0–4.5 ms  (initial run faster; subsequent throttled)
```

Pass with >100× headroom on the threshold.

### Timing variance note

First forward-FFT timing was 1.00 ms; subsequent calls bounced between 2.5 and 4.5 ms. Diagnosed as NVIDIA driver power management — the GPU stays at low clocks unless under sustained load, and the timing test's single-FFT warmup isn't enough to get it fully clocked up. Sustained workloads (real solves) keep the GPU busy and stay at higher clocks. Confirmed in Phase 3 Push 2 where 50-iter CG runs land closer to 1 ms per FFT consistently.

## Pitfalls encountered

- **Stockham buffer parity off-by-one.** First implementation had `fwdResultBuf` flipped — was reporting result in the wrong buffer for N=128 (odd stage count). Caught by the impulse round-trip test before any solver depended on it.
- **No others.** Phase 2 went unusually cleanly. The key insight that paid off was pre-baking stage uniforms; everything else was straightforward Stockham implementation against the standard reference (Pippig 2013, Govindaraju 2008 for the GPU-side patterns).

## Performance characteristics

| Operation | N=64 | N=128 |
| --- | --- | --- |
| Forward FFT | ~1 ms (sustained) | ~6 ms (estimated, untested) |
| Inverse FFT (with 1/N³ norm) | ~1 ms | ~6 ms |
| Plan construction | <50 ms | <150 ms |
| Memory per plan | 4 MB (2 buffers × 2 MB) | 32 MB |

## Handoff state

- Public API: `ensureDevice()`, `new FFTPlan(N)`, `plan.upload(arr)`, `plan.forward()`, `plan.inverse()`, `plan.readback(buf)`, `plan.destroy()`.
- Phase 3 Push 2 added: `plan.forwardEncoded(enc)`, `plan.inverseEncoded(enc)`, `plan.loadFromBuffer(enc, src)`, `plan.storeToBuffer(enc, dst)` for batched encoder use.
- `WGPU.device` global accessible to any solver after `ensureDevice()` resolves.
- `drainGpuErrors()` returns and clears any uncaptured GPU errors since last call. Phase 3 elastic test uses this to detect silent pipeline failures.

## What Phase 3 inherits

- A working, validated FFT — the only solver primitive Phase 3 needs from the GPU side. Everything else in Phase 3 is built on top: elastic uses 6 FFTs per CG iteration; Stokes will use roughly the same.
- The pattern of pre-baked stage uniforms — re-applied (after some pain) to the elastic solver's per-stage parameters in Push 2 fix.
